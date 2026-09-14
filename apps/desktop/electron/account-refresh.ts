/**
 * Automatic OAuth Credential Renewal Service (OPC-48)
 *
 * Implements safe, bounded, deduplicated OAuth credential renewal for
 * Google Antigravity, OpenAI Codex, and Claude Code.
 *
 * Security & Concurrency Invariants:
 * - Network token requests strictly execute OUTSIDE the manager mutation lock.
 * - Global concurrency semaphore (max 3 active requests) across manual and scheduled refreshes.
 * - Outbound HTTP requests restricted to official production token endpoints with 15s timeout.
 * - Response sizes capped at 1 MiB with streaming abort and redirect: 'error'.
 * - Safe error categorization: sanitized enum reasons only, zero raw errors or tokens exposed.
 * - In-flight deduplication per account ID.
 * - Exponential backoff on transient errors; terminal invalid-grant requires re-authentication.
 * - Force bypasses expiration threshold only; NEVER bypasses terminal failures or active backoff for same credential.
 * - Post-network failure checks credential fingerprint before tagging failure to avoid race poisoning.
 * - Native shared-token hazard detection: reads native credentials BEFORE token endpoint call;
 *   shared native grants fail closed before network to protect host CLI credentials.
 * - Durable forward recovery: persisted pending-sync record written under store root (mode 0600)
 *   BEFORE store update or native writes; resumes on ensureFresh / refreshDueAccounts.
 * - Commit-time native reread: conflicts yield blocked pending forward sync; fresh tokens are always retained in store.
 * - Still-valid tokens remain usable when early refresh transiently fails.
 * - Store updates committed atomically under mutation lock; invalidates quota and notifies on transitions.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  type AccountMetadata,
  type AccountRefreshState,
  type AccountRefreshStatus,
  type AccountTool,
  type StoredAccountRecord,
  validateAccountId,
  AccountError,
  ACCOUNT_TOOLS,
} from '../../../packages/workflow-model/src/accounts.ts'
import {
  inspectAntigravityCredential,
  inspectClaudeCredential,
} from './account-credential-format.ts'
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_TOKEN_URL,
  CLAUDE_CLIENT_ID,
  CLAUDE_TOKEN_URL,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
} from './account-oauth-providers.ts'
import type { AccountStore } from './account-store.ts'
import type { AccountQuotaService } from './account-quota.ts'
import type { AccountAdapter, AccountProjection } from './account-adapters.ts'

export type AccountRefreshReason = NonNullable<AccountRefreshState['reason']>
export type { AccountRefreshState, AccountRefreshStatus }

export const REFRESH_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes
export const HTTP_TIMEOUT_MS = 15_000 // 15 seconds
export const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
export const MAX_CONCURRENT_REFRESH = 3

export const KNOWN_SLOTS: Record<AccountTool, readonly string[]> = {
  codex: ['auth', 'mode'],
  'claude-code': ['oauth'],
  antigravity: ['oauth'],
}

// Error classification
export class NetworkError extends Error {
  constructor() {
    super('Network failure or timeout')
    this.name = 'NetworkError'
  }
}

export class RateLimitedError extends Error {
  constructor() {
    super('Rate limited')
    this.name = 'RateLimitedError'
  }
}

export class InvalidGrantError extends Error {
  constructor() {
    super('Invalid grant or client')
    this.name = 'InvalidGrantError'
  }
}

export class MissingRefreshTokenError extends Error {
  constructor() {
    super('Missing refresh token')
    this.name = 'MissingRefreshTokenError'
  }
}

export class UnknownClientError extends Error {
  constructor() {
    super('Unknown client')
    this.name = 'UnknownClientError'
  }
}

export class InvalidResponseError extends Error {
  constructor() {
    super('Invalid response')
    this.name = 'InvalidResponseError'
  }
}

export function calculateBackoffMs(attempt: number): number {
  const baseMs = 30_000 // 30s
  const backoff = baseMs * Math.pow(2, Math.max(0, attempt - 1))
  return Math.min(backoff, 600_000) // max 10 minutes
}

function safeTokenString(val: unknown): string {
  if (typeof val !== 'string') throw new InvalidResponseError()
  const trimmed = val.trim()
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 5 * 1024 * 1024) {
    throw new InvalidResponseError()
  }
  return trimmed
}

function parseJwtClaims(jwtToken: string): Record<string, unknown> | undefined {
  if (typeof jwtToken !== 'string') return undefined
  const parts = jwtToken.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const jsonStr = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(jsonStr)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return undefined
}

interface BoundedRequestOptions {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
  fetchFn?: typeof globalThis.fetch
  httpTimeoutMs?: number
}

export async function executeBoundedTokenRequest(
  url: string,
  options: BoundedRequestOptions
): Promise<any> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new NetworkError()
  }

  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let response: Response | undefined
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
  const timer = setTimeout(abort, options.httpTimeoutMs ?? HTTP_TIMEOUT_MS)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (options.signal?.aborted) throw new NetworkError()
    response = await fetchImpl(url, { method: options.method, headers: options.headers, body: options.body, signal: controller.signal, redirect: 'error' })
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new InvalidResponseError()
    let raw: string
    if (response.body) {
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (controller.signal.aborted) throw new NetworkError()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BODY_BYTES) throw new InvalidResponseError()
        chunks.push(value)
      }
      raw = Buffer.concat(chunks).toString('utf8')
    } else {
      raw = await response.text()
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new InvalidResponseError()
    }
    if (controller.signal.aborted) throw new NetworkError()
    let parsed: any
    try { parsed = JSON.parse(raw) } catch {}
    if (response.status === 429) throw new RateLimitedError()
    if (parsed?.error === 'invalid_grant' || parsed?.error === 'invalid_client' || response.status === 401) throw new InvalidGrantError()
    if (!response.ok) {
      if (response.status === 400) throw new InvalidResponseError()
      throw new NetworkError()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidResponseError()
    return parsed
  } catch (error) {
    if (error instanceof InvalidGrantError || error instanceof InvalidResponseError || error instanceof RateLimitedError) throw error
    throw new NetworkError()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    abort()
    if (!reader) void response?.body?.cancel().catch(() => {})
  }
}

export interface RefreshedCredentialResult {
  credential: string
  email?: string
  accountId?: string
  expiresAt?: number
}

export async function refreshCodexToken(
  storedCredential: string,
  fetchFn?: typeof globalThis.fetch,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
  httpTimeoutMs?: number
): Promise<RefreshedCredentialResult> {
  let parsed: any
  try {
    parsed = JSON.parse(storedCredential)
  } catch {
    throw new InvalidResponseError()
  }

  const explicitClient = parsed?.client_id ?? parsed?.oauth_client_id ?? parsed?.oauthClientId
  if (explicitClient && explicitClient !== CODEX_CLIENT_ID) {
    throw new UnknownClientError()
  }

  const oldRefreshToken = parsed?.tokens?.refresh_token
  if (!oldRefreshToken || typeof oldRefreshToken !== 'string' || !oldRefreshToken.trim()) {
    throw new MissingRefreshTokenError()
  }

  const bodyData = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: oldRefreshToken.trim(),
  }).toString()

  const tokenData = await executeBoundedTokenRequest(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: bodyData,
    signal,
    fetchFn,
    httpTimeoutMs,
  })

  if (tokenData.token_type !== undefined && (typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer')) throw new InvalidResponseError()
  const newAccessToken = safeTokenString(tokenData.access_token)

  let newRefreshToken = oldRefreshToken
  if ('refresh_token' in tokenData && tokenData.refresh_token !== undefined) {
    newRefreshToken = safeTokenString(tokenData.refresh_token)
  }

  let newIdToken = parsed.tokens.id_token
  if ('id_token' in tokenData && tokenData.id_token !== undefined) {
    newIdToken = safeTokenString(tokenData.id_token)
    const oldClaims = parseJwtClaims(parsed.tokens.id_token)
    const returnedClaims = parseJwtClaims(newIdToken)
    if (typeof returnedClaims?.sub !== 'string' || !returnedClaims.sub || (oldClaims?.sub && oldClaims.sub !== returnedClaims.sub)) throw new InvalidResponseError()
  }

  let idClaims: Record<string, unknown> | undefined
  if (newIdToken) {
    idClaims = parseJwtClaims(newIdToken)
  }

  const currentNow = now()
  let computedExpiresAt: number | undefined

  if ('expires_in' in tokenData && tokenData.expires_in !== undefined) {
    const expiresIn = tokenData.expires_in
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 1e9) {
      throw new InvalidResponseError()
    }
    computedExpiresAt = currentNow + expiresIn * 1000
  } else {
    const accessClaims = parseJwtClaims(newAccessToken)
    if (accessClaims && typeof accessClaims.exp === 'number' && Number.isFinite(accessClaims.exp)) {
      const expMs = accessClaims.exp * 1000
      if (expMs <= currentNow) {
        throw new InvalidResponseError()
      }
      computedExpiresAt = expMs
    }
  }

  if (computedExpiresAt === undefined || computedExpiresAt <= currentNow) {
    throw new InvalidResponseError()
  }

  const accessClaims = parseJwtClaims(newAccessToken)
  if (accessClaims?.exp !== undefined) {
    const expires = accessClaims.exp
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires * 1000 <= currentNow || expires * 1000 > 8.64e15) throw new InvalidResponseError()
    computedExpiresAt = Math.min(computedExpiresAt, expires * 1000)
  }
  const oldSubject = parseJwtClaims(parsed.tokens.id_token)?.sub
  if (accessClaims?.sub && oldSubject && accessClaims.sub !== oldSubject) throw new InvalidResponseError()
  const oldAccountId = parsed.tokens.account_id
  const oldEmail = parsed.email

  if (idClaims) {
    const authClaim = idClaims['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const tokenAccountId = authClaim?.chatgpt_account_id
    if (oldAccountId && tokenAccountId && tokenAccountId !== oldAccountId) {
      throw new InvalidResponseError()
    }
    if (oldEmail && idClaims.email && idClaims.email !== oldEmail) {
      throw new InvalidResponseError()
    }
  }

  const updatedParsed = {
    ...parsed,
    tokens: {
      ...parsed.tokens,
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      id_token: newIdToken,
    },
    last_refresh: new Date(currentNow).toISOString(),
  }

  return {
    credential: JSON.stringify(updatedParsed, null, 2),
    email: (idClaims?.email as string | undefined) ?? oldEmail,
    accountId: oldAccountId,
    expiresAt: computedExpiresAt,
  }
}

export async function refreshClaudeToken(
  storedCredential: string,
  fetchFn?: typeof globalThis.fetch,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
  httpTimeoutMs?: number
): Promise<RefreshedCredentialResult> {
  const inspected = inspectClaudeCredential(storedCredential)

  let rawParsed: Record<string, any> | undefined
  if (typeof storedCredential === 'string' && storedCredential.trim().startsWith('{')) {
    try {
      rawParsed = JSON.parse(storedCredential)
    } catch {}
  }
  const rawClient = rawParsed?.oauthClientId ?? rawParsed?.oauth_client_id ?? rawParsed?.clientId
  if (rawClient && rawClient !== CLAUDE_CLIENT_ID) {
    throw new UnknownClientError()
  }

  const oldRefreshToken = inspected.refresh
  if (!oldRefreshToken) {
    throw new MissingRefreshTokenError()
  }

  const clientId = inspected.normalized?.oauthClientId || CLAUDE_CLIENT_ID
  if (clientId !== CLAUDE_CLIENT_ID) {
    throw new UnknownClientError()
  }

  const bodyData = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: CLAUDE_CLIENT_ID,
    refresh_token: oldRefreshToken,
  })

  const tokenData = await executeBoundedTokenRequest(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: bodyData,
    signal,
    fetchFn,
    httpTimeoutMs,
  })

  if (tokenData.token_type !== undefined && (typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer')) throw new InvalidResponseError()
  const newAccessToken = safeTokenString(tokenData.access_token)
  if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/.test(newAccessToken)) {
    throw new InvalidResponseError()
  }

  let expiresIn = tokenData.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 1e9) {
    throw new InvalidResponseError()
  }

  let newRefreshToken = oldRefreshToken
  if ('refresh_token' in tokenData && tokenData.refresh_token !== undefined) {
    newRefreshToken = safeTokenString(tokenData.refresh_token)
  }

  const currentNow = now()
  const expiresAt = currentNow + expiresIn * 1000

  const oldOrganization = inspected.normalized?.oauthAccount?.organizationUuid
  if (tokenData.account?.uuid && inspected.accountId && tokenData.account.uuid !== inspected.accountId) throw new InvalidResponseError()
  if (tokenData.organization?.uuid && oldOrganization && tokenData.organization.uuid !== oldOrganization) throw new InvalidResponseError()
  const updatedNormalized = {
    ...inspected.normalized,
    claudeAiOauth: {
      ...inspected.normalized?.claudeAiOauth,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      scopes: inspected.normalized?.claudeAiOauth.scopes,
    },
    oauthClientId: CLAUDE_CLIENT_ID,
  }

  const reinspected = inspectClaudeCredential(JSON.stringify(updatedNormalized, null, 2))
  return {
    credential: reinspected.credential,
    email: reinspected.email,
    accountId: reinspected.accountId,
    expiresAt: reinspected.expiresAt,
  }
}

export async function refreshAntigravityToken(
  storedCredential: string,
  fetchFn?: typeof globalThis.fetch,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
  httpTimeoutMs?: number
): Promise<RefreshedCredentialResult> {
  const inspected = inspectAntigravityCredential(storedCredential)

  if (inspected.normalized.oauth_client_id !== ANTIGRAVITY_CLIENT_ID) {
    throw new UnknownClientError()
  }

  const oldRefreshToken = inspected.refresh
  if (!oldRefreshToken) {
    throw new MissingRefreshTokenError()
  }

  const form = new URLSearchParams()
  form.set('grant_type', 'refresh_token')
  form.set('client_id', ANTIGRAVITY_CLIENT_ID)
  form.set('client_secret', ANTIGRAVITY_CLIENT_SECRET)
  form.set('refresh_token', oldRefreshToken)

  const tokenData = await executeBoundedTokenRequest(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    signal,
    fetchFn,
    httpTimeoutMs,
  })

  if (typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer') {
    throw new InvalidResponseError()
  }

  if (tokenData.token_type !== undefined && (typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer')) throw new InvalidResponseError()
  const newAccessToken = safeTokenString(tokenData.access_token)
  let expiresIn = tokenData.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 1e9) {
    throw new InvalidResponseError()
  }

  let newRefreshToken = oldRefreshToken
  if ('refresh_token' in tokenData && tokenData.refresh_token !== undefined) {
    newRefreshToken = safeTokenString(tokenData.refresh_token)
  }

  if ('id_token' in tokenData && tokenData.id_token !== undefined) {
    const claims = parseJwtClaims(safeTokenString(tokenData.id_token))
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
      throw new InvalidResponseError()
    }
    if (inspected.accountId && claims.sub !== inspected.accountId) {
      throw new InvalidResponseError()
    }
    if (claims.email && inspected.email && claims.email !== inspected.email) {
      throw new InvalidResponseError()
    }
  }

  const currentNow = now()
  const expiryStr = new Date(currentNow + expiresIn * 1000).toISOString()

  const updatedNormalized = {
    ...inspected.normalized,
    token: {
      access_token: newAccessToken,
      token_type: 'Bearer',
      refresh_token: newRefreshToken,
      expiry: expiryStr,
    },
    oauth_client_id: ANTIGRAVITY_CLIENT_ID,
  }

  const reinspected = inspectAntigravityCredential(JSON.stringify(updatedNormalized, null, 2))
  return {
    credential: reinspected.credential,
    email: reinspected.email,
    accountId: reinspected.accountId,
    expiresAt: reinspected.expiresAt,
  }
}

/**
 * Returns true if savedCredential and nativeCredential share the same active grant tokens.
 * Throws InvalidResponseError if nativeCredential exists but cannot be safely parsed.
 */
export function checkSameGrant(
  tool: AccountTool,
  savedCredential: string,
  nativeCredential: string
): boolean {
  if (tool === 'antigravity') {
    const s = inspectAntigravityCredential(savedCredential)
    const n = inspectAntigravityCredential(nativeCredential)
    return (
      (Boolean(s.refresh) && Boolean(n.refresh) && s.refresh === n.refresh) ||
      (Boolean(s.access) && Boolean(n.access) && s.access === n.access)
    )
  }
  if (tool === 'claude-code') {
    const s = inspectClaudeCredential(savedCredential)
    const n = inspectClaudeCredential(nativeCredential)
    return (
      (Boolean(s.refresh) && Boolean(n.refresh) && s.refresh === n.refresh) ||
      (Boolean(s.access) && Boolean(n.access) && s.access === n.access)
    )
  }
  if (tool === 'codex') {
    let s: any
    let n: any
    try {
      s = JSON.parse(savedCredential)
      n = JSON.parse(nativeCredential)
    } catch {
      throw new InvalidResponseError()
    }
    const sTokens = s?.tokens
    const nTokens = n?.tokens
    if (!nTokens || typeof nTokens.access_token !== 'string') throw new InvalidResponseError()
    return (
      (Boolean(sTokens?.refresh_token) && Boolean(nTokens?.refresh_token) && sTokens.refresh_token === nTokens.refresh_token) ||
      (Boolean(sTokens?.access_token) && Boolean(nTokens?.access_token) && sTokens.access_token === nTokens.access_token)
    )
  }
  return false
}

export interface AccountPendingSyncRecord {
  version: 1
  accountId: string
  tool: AccountTool
  newCredentialHash: string
  oldCredentialHash: string
  originalCredential: string
  result: RefreshedCredentialResult
  nativeStoreKey: string
  nativeSync: 'none' | 'required' | 'check'
  before: AccountProjection
  desired: AccountProjection
  createdAt: number
  reason?: AccountRefreshReason
}

interface CachedRefreshEntry {
  state: AccountRefreshState
  credentialFingerprint: string
  attempts: number
}

export interface AccountRefreshServiceOptions {
  store: AccountStore
  adapters: Record<AccountTool, AccountAdapter>
  quotas: AccountQuotaService
  notifyChanged: () => void
  withMutationLock: <T>(action: () => Promise<T> | T) => Promise<T>
  readJournalSafely?: (tool: AccountTool) => {
    journal?: { phase: string }
    corrupted: boolean
    error?: string
  }
  fetch?: typeof globalThis.fetch
  now?: () => number
  httpTimeoutMs?: number
}

export class AccountRefreshService {
  private readonly store: AccountStore
  private readonly adapters: Record<AccountTool, AccountAdapter>
  private readonly quotas: AccountQuotaService
  private readonly notifyChanged: () => void
  private readonly withMutationLock: <T>(action: () => Promise<T> | T) => Promise<T>
  private readonly fetchFn?: typeof globalThis.fetch
  private readonly now: () => number
  private readonly httpTimeoutMs?: number
  private readonly pendingSyncDir: string
  private readonly readJournalSafely: NonNullable<AccountRefreshServiceOptions['readJournalSafely']>

  private readonly states = new Map<string, CachedRefreshEntry>()
  private readonly inFlight = new Map<string, Promise<AccountRefreshState>>()
  private isDisposed = false
  private readonly abortController = new AbortController()

  // Global concurrency semaphore (max 3 concurrent active requests across all manual & scheduled callers)
  private activeRefreshCount = 0
  private readonly refreshQueue: Array<() => void> = []

  constructor(options: AccountRefreshServiceOptions) {
    this.store = options.store
    this.adapters = options.adapters
    this.quotas = options.quotas
    this.notifyChanged = options.notifyChanged
    this.withMutationLock = options.withMutationLock
    this.fetchFn = options.fetch
    this.now = options.now ?? (() => Date.now())
    this.httpTimeoutMs = options.httpTimeoutMs
    this.readJournalSafely = options.readJournalSafely ?? (() => ({ corrupted: false }))
    this.pendingSyncDir = path.join(this.store.traceHome, 'pending-sync')
  }

  hasActiveRefreshes(): boolean { return this.inFlight.size > 0 }

  dispose(): void {
    this.isDisposed = true
    this.abortController.abort()
    this.inFlight.clear()
    for (const resolve of this.refreshQueue.splice(0)) resolve()
  }

  clearState(accountId: string): void {
    this.states.delete(accountId)
  }

  // =========================================================================
  // Persisted Pending Sync Journal Management (OPC-48 Forward Recovery)
  // =========================================================================

  private assertJournalPath(target: string): void {
    const relative = path.relative(this.store.homeDir, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new AccountError('Invalid renewal storage path.')
    let current = this.store.homeDir
    const parts = relative.split(path.sep)
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i])
      try {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new AccountError('Unsafe renewal storage path.')
      } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    }
  }

  private journalFile(accountId: string): string {
    const file = path.join(this.pendingSyncDir, `${validateAccountId(accountId)}.json`)
    this.assertJournalPath(file)
    return file
  }

  private validatePendingSync(value: any, accountId: string): AccountPendingSyncRecord {
    const fail = () => { throw new AccountError('Renewal recovery data is corrupted.') }
    if (!value || value.version !== 1 || value.accountId !== accountId || !ACCOUNT_TOOLS.includes(value.tool) ||
        !['none', 'required', 'check'].includes(value.nativeSync) || typeof value.nativeStoreKey !== 'string' ||
        !Number.isFinite(value.createdAt) || typeof value.originalCredential !== 'string' ||
        typeof value.result?.credential !== 'string' || typeof value.oldCredentialHash !== 'string' || typeof value.newCredentialHash !== 'string') fail()
    if (createHash('sha256').update(value.originalCredential).digest('hex') !== value.oldCredentialHash ||
        createHash('sha256').update(value.result.credential).digest('hex') !== value.newCredentialHash) fail()
    if (value.reason !== undefined && !['network', 'rate-limited', 'invalid-grant', 'missing-refresh-token', 'unknown-client', 'credential-conflict', 'native-access', 'runtime-active', 'storage', 'invalid-response'].includes(value.reason)) fail()
    const slots = KNOWN_SLOTS[value.tool as AccountTool]
    for (const projection of [value.before, value.desired]) {
      if (!projection || Object.keys(projection).length !== slots.length || slots.some(slot => !(slot in projection) || (projection[slot] !== null && typeof projection[slot] !== 'string'))) fail()
    }
    if (value.result.expiresAt !== undefined && (!Number.isFinite(value.result.expiresAt) || value.result.expiresAt <= 0)) fail()
    // Identity and projection integrity are checked again against the stored record before writes.
    return value as AccountPendingSyncRecord
  }

  private writePendingSync(record: AccountPendingSyncRecord): void {
    this.validatePendingSync(record, record.accountId)
    this.assertJournalPath(this.pendingSyncDir)
    mkdirSync(this.pendingSyncDir, { mode: 0o700, recursive: true })
    chmodSync(this.pendingSyncDir, 0o700)
    const target = this.journalFile(record.accountId)
    const temp = path.join(this.pendingSyncDir, `.pending-${randomUUID()}.tmp`)
    const content = JSON.stringify(record)
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new AccountError('Renewal recovery data is too large.')
    try {
      writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
      renameSync(temp, target)
    } finally { rmSync(temp, { force: true }) }
  }

  readPendingSync(accountId: string): AccountPendingSyncRecord | null {
    const file = this.journalFile(accountId)
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new AccountError('Renewal recovery data is corrupted.')
      return this.validatePendingSync(JSON.parse(readFileSync(file, 'utf8')), accountId)
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw new AccountError('Cannot read renewal recovery data.')
    }
  }

  removePendingSync(accountId: string): void { rmSync(this.journalFile(accountId), { force: true }) }
  listPendingSyncs(): AccountPendingSyncRecord[] {
    this.assertJournalPath(this.pendingSyncDir)
    let files: string[]
    try { files = readdirSync(this.pendingSyncDir) } catch (error: any) { if (error?.code === 'ENOENT') return []; throw error }
    return files.filter(file => file.endsWith('.json')).map(file => this.readPendingSync(file.slice(0, -5))).filter((value): value is AccountPendingSyncRecord => value !== null)
  }
  hasPendingSyncForTool(tool: AccountTool): boolean { return this.listPendingSyncs().some(record => record.tool === tool) }
  hasPendingSyncForAccount(accountId: string): boolean { return this.readPendingSync(accountId) !== null }
  clearPendingSync(accountId: string): void { this.removePendingSync(accountId) }

  /** Forward recovery only. The fresh grant is journaled before either local store or native writes. */
  async executeForwardSync(record: AccountPendingSyncRecord): Promise<{ success: boolean; reason?: AccountRefreshReason }> {
    if (this.isDisposed) return { success: false, reason: 'storage' }
    let stored: StoredAccountRecord
    try { stored = await this.store.get(record.accountId) } catch {
      try {
        if (!(await this.store.list()).some(account => account.id === record.accountId)) this.removePendingSync(record.accountId)
      } catch {}
      return { success: false, reason: 'storage' }
    }
    const hash = createHash('sha256').update(stored.credential).digest('hex')
    if (hash !== record.newCredentialHash && hash !== record.oldCredentialHash) {
      this.removePendingSync(record.accountId)
      return { success: false, reason: 'credential-conflict' }
    }
    const adapter = this.adapters[record.tool]
    if (stored.metadata.tool !== record.tool || !adapter) return { success: false, reason: 'storage' }
    if ((adapter.journalKey ?? record.tool) !== record.nativeStoreKey) return { success: false, reason: 'native-access' }
    const inspected = adapter.inspect(record.result.credential)
    const original = adapter.inspect(record.originalCredential)
    if (original.accountId && inspected.identityKey !== original.identityKey) return { success: false, reason: 'credential-conflict' }
    const desired = adapter.desired(record.result.credential)
    const slots = KNOWN_SLOTS[record.tool]
    if (slots.some(slot => desired[slot] !== record.desired[slot])) return { success: false, reason: 'storage' }
    if (hash === record.oldCredentialHash) {
      try {
        await this.store.updateCredential(record.accountId, { credential: record.result.credential, email: inspected.email ?? stored.metadata.email, accountId: inspected.accountId ?? stored.metadata.accountId, expiresAt: record.result.expiresAt })
        this.quotas.invalidate(record.accountId)
      } catch { return { success: false, reason: 'storage' } }
    }
    if (record.nativeSync === 'check') {
      try {
        const projection = adapter.read()
        const current = adapter.credentialFrom(projection)
        record.nativeSync = current && checkSameGrant(record.tool, record.originalCredential, current) ? 'required' : 'none'
        record.before = projection
        this.writePendingSync(record)
      } catch { return { success: false, reason: 'native-access' } }
    }
    if (record.nativeSync === 'required') {
      if (record.tool !== 'antigravity') return { success: false, reason: 'runtime-active' }
      const journal = this.readJournalSafely(record.tool)
      if (journal.corrupted || journal.journal?.phase === 'pending') return { success: false, reason: 'storage' }
      try { (adapter.assertCanRefresh ?? adapter.assertCanWrite)?.call(adapter) } catch { return { success: false, reason: 'runtime-active' } }
      try {
        for (const slot of slots) {
          const current = adapter.read()
          if (slots.some(s => current[s] !== record.before[s] && current[s] !== record.desired[s])) return { success: false, reason: 'credential-conflict' }
          if (current[slot] !== record.desired[slot]) adapter.writeSlot(slot, record.desired[slot])
        }
        const verified = adapter.read()
        if (slots.some(slot => verified[slot] !== record.desired[slot])) return { success: false, reason: 'native-access' }
      } catch { return { success: false, reason: 'native-access' } }
    }
    this.removePendingSync(record.accountId)
    return { success: true }
  }

  // =========================================================================
  // State Reporting & Cached Transitions
  // =========================================================================

  getRefreshStates(accounts?: AccountMetadata[]): AccountRefreshState[] {
    const result: AccountRefreshState[] = []
    const validIds = accounts ? new Set(accounts.map((a) => a.id)) : undefined

    const reportedIds = new Set<string>()
    for (const [id, entry] of this.states.entries()) {
      if (validIds && !validIds.has(id)) continue
      reportedIds.add(id)
      result.push({ ...entry.state })
    }

    // Always inspect on-disk pending sync records:
    // Guarantees overview state shows blocked until recovered, even across restarts
    const pendingList = this.listPendingSyncs()
    for (const pending of pendingList) {
      if (validIds && !validIds.has(pending.accountId)) continue
      const existingIdx = result.findIndex((r) => r.accountId === pending.accountId)
      const blockedState: AccountRefreshState = {
        accountId: pending.accountId,
        status: 'blocked',
        reason: pending.reason ?? 'runtime-active',
        attemptedAt: pending.createdAt,
      }
      if (existingIdx >= 0) {
        result[existingIdx] = blockedState
      } else {
        result.push(blockedState)
      }
    }

    return result
  }

  getRefreshState(accountId: string): AccountRefreshState | undefined {
    const pending = this.readPendingSync(accountId)
    if (pending) {
      return {
        accountId,
        status: 'blocked',
        reason: pending.reason ?? 'runtime-active',
        attemptedAt: pending.createdAt,
      }
    }
    const entry = this.states.get(accountId)
    return entry ? { ...entry.state } : undefined
  }

  private setCachedState(
    accountId: string,
    state: AccountRefreshState,
    credentialFingerprint: string,
    attemptsDelta?: number
  ): void {
    const current = this.states.get(accountId)
    const prevStatus = current?.state.status
    const prevReason = current?.state.reason

    let attempts = current?.attempts ?? 0
    if (attemptsDelta === 0) {
      attempts = 0
    } else if (attemptsDelta !== undefined) {
      attempts += attemptsDelta
    }

    this.states.set(accountId, {
      state,
      credentialFingerprint,
      attempts,
    })

    // Notify listeners strictly on state transitions (status or reason changed), including 'refreshing'
    if (prevStatus !== state.status || prevReason !== state.reason) {
      this.notifyChanged()
    }
  }

  private async acquireRefreshSlot(): Promise<() => void> {
    if (this.activeRefreshCount < MAX_CONCURRENT_REFRESH) {
      this.activeRefreshCount++
      let released = false
      return () => {
        if (released) return
        released = true
        this.activeRefreshCount--
        const next = this.refreshQueue.shift()
        if (next) next()
      }
    }
    return new Promise<() => void>((resolve) => {
      this.refreshQueue.push(() => {
        this.activeRefreshCount++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.activeRefreshCount--
          const next = this.refreshQueue.shift()
          if (next) next()
        })
      })
    })
  }

  // =========================================================================
  // Primary Refresh Execution
  // =========================================================================

  async ensureFresh(
    accountId: string,
    options?: { force?: boolean }
  ): Promise<AccountRefreshState> {
    const validId = validateAccountId(accountId)
    if (this.isDisposed) {
      return { accountId: validId, status: 'blocked', reason: 'storage' }
    }

    // Dedup in-flight requests per account
    const existingInFlight = this.inFlight.get(validId)
    if (existingInFlight) {
      return await existingInFlight
    }

    const refreshPromise = this.executeEnsureFresh(validId, options).catch(() => {
      const state: AccountRefreshState = { accountId: validId, status: 'blocked', reason: 'storage' }
      this.setCachedState(validId, state, '')
      return state
    })
    this.inFlight.set(validId, refreshPromise)
    try {
      return await refreshPromise
    } finally {
      this.inFlight.delete(validId)
    }
  }

  private async executeEnsureFresh(
    accountId: string,
    options?: { force?: boolean }
  ): Promise<AccountRefreshState> {
    const currentTime = this.now()

    // 1. Resume pending sync if present on disk, even when expiry not due
    const pending = this.readPendingSync(accountId)
    if (pending) {
      const forwardResult = await this.withMutationLock(async () => {
        return await this.executeForwardSync(pending)
      })
      if (forwardResult.success) {
        const readyState: AccountRefreshState = {
          accountId,
          status: 'ready',
          refreshedAt: this.now(),
        }
        this.setCachedState(accountId, readyState, pending.newCredentialHash, 0)
        return readyState
      } else {
        if (this.readPendingSync(accountId)) { pending.reason = forwardResult.reason; this.writePendingSync(pending) }
        const blockedState: AccountRefreshState = {
          accountId,
          status: 'blocked',
          reason: forwardResult.reason ?? 'runtime-active',
          attemptedAt: currentTime,
        }
        this.setCachedState(accountId, blockedState, pending.newCredentialHash)
        return blockedState
      }
    }

    let record: StoredAccountRecord
    try {
      record = await this.store.get(accountId)
    } catch {
      this.clearState(accountId)
      return { accountId, status: 'blocked', reason: 'storage' }
    }

    const fingerprint = createHash('sha256').update(record.credential).digest('hex')
    const cachedEntry = this.states.get(accountId)

    // Clear stale failure if credential was re-authenticated or changed
    if (cachedEntry && cachedEntry.credentialFingerprint !== fingerprint) {
      this.states.delete(accountId)
    } else if (cachedEntry) {
      const { state } = cachedEntry
      // Force bypasses expiry threshold ONLY; NEVER bypass terminal failure states for same credential
      if (state.status === 'reauth-required' || state.status === 'unsupported') {
        return state
      }
      // Force bypasses expiry threshold ONLY; NEVER bypass active retryAt backoff for same credential
      if (state.status === 'retrying' && typeof state.retryAt === 'number' && currentTime < state.retryAt) {
        return state
      }
      if (state.status === 'ready' && !options?.force) {
        const exp = record.metadata.expiresAt
        const isDue = typeof exp === 'number' && exp - currentTime <= REFRESH_THRESHOLD_MS
        if (!isDue) {
          return state
        }
      }
    }

    // If not forced, check if actually due; unknown expiry leaves fresh until 401 or forced
    if (!options?.force) {
      const exp = record.metadata.expiresAt
      if (exp === undefined) {
        return { accountId, status: 'ready' }
      }
      const isDue = exp - currentTime <= REFRESH_THRESHOLD_MS
      if (!isDue && exp > currentTime) {
        const readyState: AccountRefreshState = { accountId, status: 'ready' }
        this.setCachedState(accountId, readyState, fingerprint)
        return readyState
      }
    }

    const tool = record.metadata.tool
    const adapter = this.adapters[tool]

    // Pre-flight validation: check client association and refresh token before network
    if (tool === 'antigravity') {
      try {
        const inspected = inspectAntigravityCredential(record.credential)
        if (inspected.normalized.oauth_client_id !== ANTIGRAVITY_CLIENT_ID) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'unknown-client',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }
        if (!inspected.refresh) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'missing-refresh-token',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }
      } catch {
        const invalidState: AccountRefreshState = {
          accountId,
          status: 'retrying',
          reason: 'invalid-response',
          attemptedAt: currentTime,
        }
        this.setCachedState(accountId, invalidState, fingerprint, 1)
        return invalidState
      }
    } else if (tool === 'claude-code') {
      try {
        let rawParsed: Record<string, any> | undefined
        if (typeof record.credential === 'string' && record.credential.trim().startsWith('{')) {
          try {
            rawParsed = JSON.parse(record.credential)
          } catch {}
        }
        const rawClient = rawParsed?.oauthClientId ?? rawParsed?.oauth_client_id ?? rawParsed?.clientId
        if (rawClient && rawClient !== CLAUDE_CLIENT_ID) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'unknown-client',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }

        const inspected = inspectClaudeCredential(record.credential)
        if (!inspected.refresh) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'missing-refresh-token',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }
        if (inspected.normalized?.oauthClientId && inspected.normalized.oauthClientId !== CLAUDE_CLIENT_ID) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'unknown-client',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }
      } catch {
        const invalidState: AccountRefreshState = {
          accountId,
          status: 'retrying',
          reason: 'invalid-response',
          attemptedAt: currentTime,
        }
        this.setCachedState(accountId, invalidState, fingerprint, 1)
        return invalidState
      }
    } else if (tool === 'codex') {
      try {
        const parsed = JSON.parse(record.credential)
        const explicitClient = parsed?.client_id ?? parsed?.oauth_client_id ?? parsed?.oauthClientId
        if (explicitClient && explicitClient !== CODEX_CLIENT_ID) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'unknown-client',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }
        if (!parsed?.tokens?.refresh_token) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'missing-refresh-token',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint)
          return unsupportedState
        }
      } catch {
        const invalidState: AccountRefreshState = {
          accountId,
          status: 'retrying',
          reason: 'invalid-response',
          attemptedAt: currentTime,
        }
        this.setCachedState(accountId, invalidState, fingerprint, 1)
        return invalidState
      }
    }

    let originalProjection: AccountProjection = {}
    let originallyShared = false
    // Native shared-token hazard detection BEFORE calling token endpoint
    if (adapter) {
      let nativeCred: string | null = null
      let nativeReadError = false
      try {
        const ext = adapter as any
        if (typeof ext.readCurrentCredential === 'function') {
          nativeCred = ext.readCurrentCredential()
        } else {
          nativeCred = adapter.credentialFrom(adapter.read())
        }
      } catch {
        nativeReadError = true
      }

      if (nativeReadError) {
        // Cannot establish isolation -> fail closed before network
        const blockedState: AccountRefreshState = {
          accountId,
          status: 'blocked',
          reason: 'native-access',
          attemptedAt: currentTime,
        }
        this.setCachedState(accountId, blockedState, fingerprint)
        return blockedState
      }

      originalProjection = adapter.read()
      if (nativeCred) {
        let matches = false
        try {
          matches = checkSameGrant(tool, record.credential, nativeCred)
        } catch {
          // Native credential exists but is corrupt -> fail closed before network
          const blockedState: AccountRefreshState = {
            accountId,
            status: 'blocked',
            reason: 'native-access',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, blockedState, fingerprint)
          return blockedState
        }

        if (matches) {
          originallyShared = true
          const journal = this.readJournalSafely(tool)
          if (journal.corrupted || journal.journal?.phase === 'pending') return { accountId, status: 'blocked', reason: 'storage' }
          // Shared active native grant:
          // Codex and Claude lack atomic runtime locks -> block BEFORE network to protect host CLI
          if (tool !== 'antigravity') {
            const blockedState: AccountRefreshState = {
              accountId,
              status: 'blocked',
              reason: 'runtime-active',
              attemptedAt: currentTime,
            }
            this.setCachedState(accountId, blockedState, fingerprint)
            return blockedState
          }

          // For Antigravity, verify runtime is stopped before network
          try {
            (adapter.assertCanRefresh ?? adapter.assertCanWrite)?.call(adapter)
          } catch {
            const blockedState: AccountRefreshState = {
              accountId,
              status: 'blocked',
              reason: 'runtime-active',
              attemptedAt: currentTime,
            }
            this.setCachedState(accountId, blockedState, fingerprint)
            return blockedState
          }
        }
      }
    }

    if (this.isDisposed) {
      return { accountId, status: 'blocked', reason: 'storage' }
    }

    // Acquire slot under global concurrency semaphore (max 3 concurrent network requests across all callers)
    const releaseSlot = await this.acquireRefreshSlot()
    try {
      if (this.isDisposed) {
        return { accountId, status: 'blocked', reason: 'storage' }
      }

      const queuedRecord = await this.store.get(accountId)
      if (createHash('sha256').update(queuedRecord.credential).digest('hex') !== fingerprint) return { accountId, status: 'blocked', reason: 'credential-conflict' }
      try {
        const latestProjection = adapter.read()
        if (KNOWN_SLOTS[tool].some(slot => latestProjection[slot] !== originalProjection[slot])) {
          const state: AccountRefreshState = { accountId, status: 'blocked', reason: 'credential-conflict' }
          this.setCachedState(accountId, state, fingerprint)
          return state
        }
        if (originallyShared) (adapter.assertCanRefresh ?? adapter.assertCanWrite)?.call(adapter)
      } catch {
        const state: AccountRefreshState = { accountId, status: 'blocked', reason: 'native-access' }
        this.setCachedState(accountId, state, fingerprint)
        return state
      }

      // Set transient 'refreshing' status in cache (notifies listeners on transition)
      this.setCachedState(
        accountId,
        { accountId, status: 'refreshing', attemptedAt: currentTime },
        fingerprint
      )

      // Execute token network request OUTSIDE mutation lock
      let refreshResult: RefreshedCredentialResult
      try {
        if (this.isDisposed) {
          return { accountId, status: 'blocked', reason: 'storage' }
        }

        if (tool === 'antigravity') {
          refreshResult = await refreshAntigravityToken(
            record.credential,
            this.fetchFn,
            this.now,
            this.abortController.signal,
            this.httpTimeoutMs
          )
        } else if (tool === 'claude-code') {
          refreshResult = await refreshClaudeToken(
            record.credential,
            this.fetchFn,
            this.now,
            this.abortController.signal,
            this.httpTimeoutMs
          )
        } else {
          refreshResult = await refreshCodexToken(
            record.credential,
            this.fetchFn,
            this.now,
            this.abortController.signal,
            this.httpTimeoutMs
          )
        }
      } catch (err) {
        if (this.isDisposed) {
          return { accountId, status: 'blocked', reason: 'storage' }
        }

        // Re-check record fingerprint: if modified/reauthed during flight, do not poison with old failure
        let latestRecord: StoredAccountRecord | null = null
        try {
          latestRecord = await this.store.get(accountId)
        } catch {}

        const latestFingerprint = latestRecord
          ? createHash('sha256').update(latestRecord.credential).digest('hex')
          : null

        if (!latestRecord || latestFingerprint !== fingerprint) {
          return { accountId, status: 'blocked', reason: 'credential-conflict', attemptedAt: currentTime }
        }

        const currentAttempts = (this.states.get(accountId)?.attempts ?? 0) + 1
        const retryAt = this.now() + calculateBackoffMs(currentAttempts)

        if (err instanceof InvalidGrantError) {
          const terminalState: AccountRefreshState = {
            accountId,
            status: 'reauth-required',
            reason: 'invalid-grant',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, terminalState, fingerprint, 0)
          return terminalState
        }

        if (err instanceof RateLimitedError) {
          const retryingState: AccountRefreshState = {
            accountId,
            status: 'retrying',
            reason: 'rate-limited',
            attemptedAt: currentTime,
            retryAt,
          }
          this.setCachedState(accountId, retryingState, fingerprint, 1)
          return retryingState
        }

        if (err instanceof MissingRefreshTokenError) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'missing-refresh-token',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint, 0)
          return unsupportedState
        }

        if (err instanceof UnknownClientError) {
          const unsupportedState: AccountRefreshState = {
            accountId,
            status: 'unsupported',
            reason: 'unknown-client',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, unsupportedState, fingerprint, 0)
          return unsupportedState
        }

        if (err instanceof InvalidResponseError) {
          const retryingState: AccountRefreshState = {
            accountId,
            status: 'retrying',
            reason: 'invalid-response',
            attemptedAt: currentTime,
            retryAt,
          }
          this.setCachedState(accountId, retryingState, fingerprint, 1)
          return retryingState
        }

        // Default NetworkError
        const retryingState: AccountRefreshState = {
          accountId,
          status: 'retrying',
          reason: 'network',
          attemptedAt: currentTime,
          retryAt,
        }
        this.setCachedState(accountId, retryingState, fingerprint, 1)
        return retryingState
      }

      if (this.isDisposed) {
        return { accountId, status: 'blocked', reason: 'storage' }
      }

      // Commit changes under store mutation lock
      return await this.withMutationLock(async () => {
        if (this.isDisposed) {
          return { accountId, status: 'blocked', reason: 'storage' }
        }

        let freshRecord: StoredAccountRecord
        try {
          freshRecord = await this.store.get(accountId)
        } catch {
          this.clearState(accountId)
          return { accountId, status: 'blocked', reason: 'storage' }
        }

        const freshFingerprint = createHash('sha256').update(freshRecord.credential).digest('hex')
        if (freshFingerprint !== fingerprint) {
          const conflictState: AccountRefreshState = {
            accountId,
            status: 'blocked',
            reason: 'credential-conflict',
            attemptedAt: currentTime,
          }
          this.setCachedState(accountId, conflictState, freshFingerprint)
          return conflictState
        }

        const newCredentialHash = createHash('sha256').update(refreshResult.credential).digest('hex')

        // Re-read native state at commit time to detect if grant became current during flight
        let currentNativeCredNow: string | null = null
        let nativeAccessConflict = false
        let beforeProjection: AccountProjection = {}

        if (adapter) {
          try {
            const ext = adapter as any
            if (typeof ext.readCurrentCredential === 'function') {
              currentNativeCredNow = ext.readCurrentCredential()
            } else {
              currentNativeCredNow = adapter.credentialFrom(adapter.read())
            }
            beforeProjection = adapter.read()
          } catch {
            nativeAccessConflict = true
          }
        }

        let isSharedNative = false
        if (currentNativeCredNow) {
          try {
            isSharedNative = checkSameGrant(tool, record.credential, currentNativeCredNow)
          } catch {
            nativeAccessConflict = true
          }
        }

        const pendingRecord: AccountPendingSyncRecord = {
          version: 1, accountId, tool, oldCredentialHash: fingerprint, newCredentialHash,
          originalCredential: record.credential, result: refreshResult,
          nativeStoreKey: adapter.journalKey ?? tool,
          nativeSync: originallyShared || isSharedNative ? 'required' : nativeAccessConflict ? 'check' : 'none',
          before: originallyShared ? originalProjection : nativeAccessConflict ? originalProjection : beforeProjection,
          desired: adapter.desired(refreshResult.credential), createdAt: currentTime,
          reason: nativeAccessConflict ? 'native-access' : 'runtime-active',
        }
        this.writePendingSync(pendingRecord)
        const forwardResult = await this.executeForwardSync(pendingRecord)
        if (!forwardResult.success) {
          pendingRecord.reason = forwardResult.reason
          this.writePendingSync(pendingRecord)
          const blockedState: AccountRefreshState = { accountId, status: 'blocked', reason: forwardResult.reason ?? 'storage', attemptedAt: currentTime }
          this.setCachedState(accountId, blockedState, newCredentialHash)
          return blockedState
        }

        const committedNow = this.now()
        const readyState: AccountRefreshState = {
          accountId,
          status: 'ready',
          attemptedAt: currentTime,
          refreshedAt: committedNow,
        }
        this.setCachedState(accountId, readyState, newCredentialHash, 0)
        return readyState
      })
    } finally {
      releaseSlot()
    }
  }

  async refreshDueAccounts(): Promise<void> {
    if (this.isDisposed) return
    const accounts = await this.store.list()
    const currentTime = this.now()

    const pendingList = this.listPendingSyncs()
    const pendingAccountIds = new Set(pendingList.map((p) => p.accountId))

    const dueAccounts: AccountMetadata[] = []
    for (const acc of accounts) {
      const cached = this.states.get(acc.id)
      const hasPending = pendingAccountIds.has(acc.id)

      // DO NOT pre-skip reauth-required or unsupported:
      // Let ensureFresh gate on fingerprint (re-imported / re-authenticated accounts will have fresh fingerprints)
      const isNearExpiry = typeof acc.expiresAt === 'number' && acc.expiresAt - currentTime <= REFRESH_THRESHOLD_MS
      const isRetryingDue = cached?.state.status === 'retrying' && typeof cached.state.retryAt === 'number' && currentTime >= cached.state.retryAt

      if (hasPending || isNearExpiry || isRetryingDue) {
        dueAccounts.push(acc)
      }
    }

    // Global semaphore caps concurrency at 3 across all callers
    await Promise.all(
      dueAccounts.map(async (acc) => {
        if (this.isDisposed) return
        try {
          await this.ensureFresh(acc.id, { force: this.states.get(acc.id)?.state.status === 'retrying' })
        } catch {}
      })
    )
  }
}
