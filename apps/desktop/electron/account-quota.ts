/**
 * AI Tool Account Quota Service (OPC-48)
 *
 * Implements independent quota and rate-limit tracking for AI developer tools:
 * - OpenAI Codex (ChatGPT backend usage)
 * - Claude Code (Anthropic OAuth usage)
 * - Google Antigravity (Cloud Code CodeAssist, available models & quota summary)
 *
 * Security & Reliability Invariants:
 * - All outbound HTTP requests strictly allowlisted official HTTPS endpoints
 * - Enforces redirect: 'error' (no open/blind redirects)
 * - Requests bounded by timeout and 1 MiB response size limit
 * - Strict in-flight deduplication per account ID
 * - Bounded concurrent HTTP operations queue
 * - In-memory cache only; no disk persistence of quotas
 * - Zero raw credentials, secrets, or server error bodies exposed in snapshots or errors
 * - Re-reads store record before committing cache to avoid resurrection of deleted/mutated credentials
 * - Stale caching on failure: prior successful windows preserved with stale: true and failed status
 * - Renderer snapshots use epoch milliseconds for all timestamps
 * - Unknown percentages remain undefined, never falsified as 0
 */

import { createHash } from 'node:crypto'
import {
  type AccountMetadata,
  type AccountQuotaPeriod,
  type AccountQuotaSnapshot,
  type AccountQuotaStatus,
  type AccountQuotaWindow,
  type AccountTool,
  type StoredAccountRecord,
  AccountError,
  validateAccountId,
} from '../../../packages/workflow-model/src/accounts.ts'
import type { AccountStore } from './account-store.ts'
import { inspectClaudeCredential } from './account-credential-format.ts'

export const MAX_RESPONSE_BYTES = 1024 * 1024 // 1 MiB
export const HTTP_TIMEOUT_MS = 10_000 // 10 seconds
export const MAX_CONCURRENT_HTTP = 4
const MAX_PENDING_REFRESHES = 64
export const MAX_WINDOWS_PER_ACCOUNT = 40
const MAX_MODELS_PER_ACCOUNT = 20
export const MAX_LABEL_LENGTH = 100
export const MAX_PLAN_LENGTH = 50

const ALLOWED_QUOTA_URLS = new Set([
  'https://chatgpt.com/backend-api/wham/usage',
  'https://api.anthropic.com/api/oauth/usage',
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
])

const RESERVED_PROPERTY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/

export interface AccountQuotaServiceOptions {
  store: Pick<AccountStore, 'get'>
  onChanged?: () => void
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface CachedQuotaEntry {
  snapshot: AccountQuotaSnapshot
  accountUpdatedAt: number
  credentialHash: string
}

interface ProviderQueryResult {
  status: AccountQuotaStatus
  windows: AccountQuotaWindow[]
  plan?: string
  planReason?: 'restricted-age' | 'unavailable'
}

function sanitizeSafeString(str: unknown, maxLen = MAX_LABEL_LENGTH): string | undefined {
  if (typeof str !== 'string') return undefined
  const trimmed = str.trim()
  if (!trimmed || trimmed.length > maxLen) return undefined
  if (RESERVED_PROPERTY_NAMES.has(trimmed) || CONTROL_CHARS_REGEX.test(trimmed)) return undefined
  return trimmed
}

function formatSecondsDuration(seconds: number): string {
  if (seconds <= 0 || !Number.isFinite(seconds)) return ''
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

/**
 * Calculates remaining percentage safely.
 * Missing/NaN/out-of-range values return undefined (unknown, NEVER 0).
 */
function safeRemainingPercent(val: unknown, isUsedPercentage: boolean): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val)) return undefined
  if (isUsedPercentage) {
    if (val < 0 || val > 100) return undefined
    const remaining = 100 - val
    return Math.round(remaining * 1_000_000) / 1_000_000
  } else {
    // 0..1 fraction (e.g. Antigravity remainingFraction)
    if (val < 0 || val > 1) return undefined
    const percent = val * 100
    return Math.round(percent * 1_000_000) / 1_000_000
  }
}

function safeEpochMs(val: unknown, isUnixSeconds: boolean): number | undefined {
  if (isUnixSeconds) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      const ms = val * 1000
      return Number.isFinite(ms) && ms <= 8.64e15 ? Math.floor(ms) : undefined
    }
    return undefined
  }
  if (typeof val === 'string') {
    const ms = Date.parse(val)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 0 && val <= 8.64e15) {
    return Math.floor(val)
  }
  return undefined
}

type AntigravityModelFamily = 'gemini' | 'claude-gpt'

interface AntigravityQuotaBucket {
  period: AccountQuotaPeriod
  remainingPercent?: number
  resetsAt?: number
}

type AntigravityQuotaSummary = Map<AntigravityModelFamily, Map<AccountQuotaPeriod, AntigravityQuotaBucket>>

function normalizeQuotaText(values: unknown[]): string {
  return values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
}

function classifyAntigravityModelFamily(...values: unknown[]): AntigravityModelFamily | undefined {
  const text = normalizeQuotaText(values)
  if (!text) return undefined

  if (/(?:gemini|google\s+gemini)/.test(text)) return 'gemini'
  if (/(?:claude|gpt|anthropic|openai|3p)/.test(text)) return 'claude-gpt'
  return undefined
}

function classifyAntigravityQuotaPeriod(...values: unknown[]): AccountQuotaPeriod | undefined {
  const text = normalizeQuotaText(values)
  if (!text) return undefined

  if (
    /\b5\s*(?:h|hr|hrs|hour|hours)\b/.test(text) ||
    /\bfive\s+hours?\b/.test(text) ||
    text.includes('5h')
  ) {
    return 'five-hour'
  }
  if (
    /\b(?:weekly|week|7\s*(?:d|day|days)|seven\s+(?:day|days))\b/.test(text) ||
    text.includes('7d')
  ) {
    return 'weekly'
  }
  return undefined
}

function parseAntigravityQuotaBucket(rawBucket: unknown): AntigravityQuotaBucket | undefined {
  if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) return undefined
  const bucket = rawBucket as Record<string, any>
  const nestedRemaining = bucket.remaining && typeof bucket.remaining === 'object' && !Array.isArray(bucket.remaining)
    ? bucket.remaining.remainingFraction
    : undefined
  const nestedResetTime = bucket.remaining && typeof bucket.remaining === 'object' && !Array.isArray(bucket.remaining)
    ? bucket.remaining.resetTime
    : undefined
  const period = classifyAntigravityQuotaPeriod(bucket.bucketId, bucket.displayName, bucket.window, bucket.description)
  if (!period) return undefined

  const remainingPercent = safeRemainingPercent(bucket.remainingFraction ?? nestedRemaining, false)
  const resetsAt = safeEpochMs(bucket.resetTime ?? bucket.reset_time ?? nestedResetTime, false)
  return {
    period,
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

function parseAntigravityQuotaSummary(body: unknown): AntigravityQuotaSummary {
  const summary: AntigravityQuotaSummary = new Map()
  if (!body || typeof body !== 'object' || Array.isArray(body)) return summary

  const groups = (body as Record<string, any>).groups
  if (!Array.isArray(groups)) return summary

  for (const rawGroup of groups.slice(0, MAX_MODELS_PER_ACCOUNT)) {
    if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) continue
    const group = rawGroup as Record<string, any>
    const family = classifyAntigravityModelFamily(group.displayName, group.description, group.groupId, group.id)
    if (!family || !Array.isArray(group.buckets)) continue

    for (const rawBucket of group.buckets.slice(0, 10)) {
      const bucket = parseAntigravityQuotaBucket(rawBucket)
      if (!bucket) continue
      const familySummary = summary.get(family) ?? new Map<AccountQuotaPeriod, AntigravityQuotaBucket>()
      const existing = familySummary.get(bucket.period)
      // Prefer a bucket with an actual percentage when duplicate aliases are returned.
      if (!existing || (existing.remainingPercent === undefined && bucket.remainingPercent !== undefined)) {
        familySummary.set(bucket.period, bucket)
      }
      summary.set(family, familySummary)
    }
  }

  return summary
}

async function executeBoundedFetch(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<{ status: number; json: any; ok: boolean }> {
  if (!ALLOWED_QUOTA_URLS.has(url)) {
    throw new AccountError('Disallowed quota endpoint.')
  }

  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      void activeReader?.cancel().catch(() => {})
      reject(new AccountError('Network request timed out.'))
    }, timeoutMs)
  })

  try {
    const fetchPromise = (async () => {
      const response = await fetchFn(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      })

      // HTTP status is sufficient for errors; never parse provider error bodies.
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        return { status: response.status, json: null, ok: false }
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength) {
        const lengthNum = parseInt(contentLength, 10)
        if (Number.isFinite(lengthNum) && lengthNum > MAX_RESPONSE_BYTES) {
          controller.abort()
          throw new AccountError('Response body exceeded maximum size limit.')
        }
      }

      let text = ''
      if (response.body && typeof (response.body as any).getReader === 'function') {
        const reader = response.body.getReader()
        activeReader = reader
        const chunks: Uint8Array[] = []
        let receivedBytes = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              receivedBytes += value.byteLength
              if (receivedBytes > MAX_RESPONSE_BYTES) {
                await reader.cancel()
                controller.abort()
                throw new AccountError('Response body exceeded maximum size limit.')
              }
              chunks.push(value)
            }
          }
        } finally {
          reader.releaseLock?.()
          activeReader = undefined
        }
        text = Buffer.concat(chunks).toString('utf8')
      } else {
        const buf = await response.arrayBuffer()
        if (buf.byteLength > MAX_RESPONSE_BYTES) {
          throw new AccountError('Response body exceeded maximum size limit.')
        }
        text = Buffer.from(buf).toString('utf8')
      }

      let parsedJson: any = null
      if (text.trim().length > 0) {
        try {
          parsedJson = JSON.parse(text)
        } catch {
          parsedJson = null
        }
      }

      return {
        status: response.status,
        json: parsedJson,
        ok: response.ok,
      }
    })()

    return await Promise.race([fetchPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function queryCodexQuota(
  record: StoredAccountRecord,
  fetchFn: typeof globalThis.fetch,
  now: number
): Promise<ProviderQueryResult> {
  let parsedCred: any
  try {
    parsedCred = JSON.parse(record.credential)
  } catch {
    return { status: 'unavailable', windows: [] }
  }

  const tokens = parsedCred?.tokens
  const accessToken = tokens?.access_token
  const accountId = tokens?.account_id ?? record.metadata.accountId
  if (typeof accessToken !== 'string' || !accessToken.trim() || typeof accountId !== 'string' || !accountId.trim()) {
    return { status: 'unavailable', windows: [] }
  }

  // Check JWT expiration claim
  try {
    const parts = accessToken.split('.')
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) {
        return { status: 'expired', windows: [] }
      }
    }
  } catch {}

  if (record.metadata.expiresAt && record.metadata.expiresAt <= now) {
    return { status: 'expired', windows: [] }
  }

  const url = 'https://chatgpt.com/backend-api/wham/usage'
  let res: { status: number; json: any; ok: boolean }
  try {
    res = await executeBoundedFetch(fetchFn, url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken.trim()}`,
        'ChatGPT-Account-Id': accountId.trim(),
        'Accept': 'application/json',
        'User-Agent': 'codex-cli',
      },
    })
  } catch {
    return { status: 'error', windows: [] }
  }

  if (res.status === 401) return { status: 'expired', windows: [] }
  if (res.status === 403) return { status: 'forbidden', windows: [] }
  if (res.status === 429) return { status: 'rate-limited', windows: [] }
  if (res.status < 200 || res.status >= 300 || !res.json || typeof res.json !== 'object') {
    return { status: 'error', windows: [] }
  }

  const body = res.json
  const plan = sanitizeSafeString(body.plan_type, MAX_PLAN_LENGTH)
  const rateLimit = body.rate_limit
  const windows: AccountQuotaWindow[] = []

  if (rateLimit && typeof rateLimit === 'object') {
    if (rateLimit.primary_window && typeof rateLimit.primary_window === 'object') {
      const pw = rateLimit.primary_window
      const remainingPercent = safeRemainingPercent(pw.used_percent, true)
      const durationSeconds = typeof pw.limit_window_seconds === 'number' && Number.isFinite(pw.limit_window_seconds) && pw.limit_window_seconds > 0
        ? pw.limit_window_seconds : undefined
      const duration = durationSeconds !== undefined ? formatSecondsDuration(durationSeconds) : ''
      const label = duration || 'Primary'
      const resetsAt = safeEpochMs(pw.reset_at, true)
      windows.push({
        id: 'primary_window',
        label,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(remainingPercent !== undefined ? { remainingPercent } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })
    }

    if (rateLimit.secondary_window && typeof rateLimit.secondary_window === 'object') {
      const sw = rateLimit.secondary_window
      const remainingPercent = safeRemainingPercent(sw.used_percent, true)
      const durationSeconds = typeof sw.limit_window_seconds === 'number' && Number.isFinite(sw.limit_window_seconds) && sw.limit_window_seconds > 0
        ? sw.limit_window_seconds : undefined
      const duration = durationSeconds !== undefined ? formatSecondsDuration(durationSeconds) : ''
      const label = duration || 'Secondary'
      const resetsAt = safeEpochMs(sw.reset_at, true)
      windows.push({
        id: 'secondary_window',
        label,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(remainingPercent !== undefined ? { remainingPercent } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })
    }
  }

  if (!windows.some(window => window.remainingPercent !== undefined)) {
    return { status: 'unavailable', windows, ...(plan ? { plan } : {}) }
  }

  return { status: 'ready', windows, ...(plan ? { plan } : {}) }
}

async function queryClaudeQuota(
  record: StoredAccountRecord,
  fetchFn: typeof globalThis.fetch,
  now: number
): Promise<ProviderQueryResult> {
  let token: string
  try { token = inspectClaudeCredential(record.credential).access } catch {
    return { status: 'unavailable', windows: [] }
  }

  if (record.metadata.expiresAt && record.metadata.expiresAt <= now) {
    return { status: 'expired', windows: [] }
  }

  const url = 'https://api.anthropic.com/api/oauth/usage'
  let res: { status: number; json: any; ok: boolean }
  try {
    res = await executeBoundedFetch(fetchFn, url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
        'Accept': 'application/json',
      },
    })
  } catch {
    return { status: 'error', windows: [] }
  }

  if (res.status === 401) return { status: 'expired', windows: [] }
  if (res.status === 403) return { status: 'forbidden', windows: [] }
  if (res.status === 429) return { status: 'rate-limited', windows: [] }
  if (res.status < 200 || res.status >= 300 || !res.json || typeof res.json !== 'object') {
    return { status: 'error', windows: [] }
  }

  const body = res.json
  const windows: AccountQuotaWindow[] = []
  const knownWindows: Array<{ id: string; label: string; durationSeconds: number }> = [
    { id: 'five_hour', label: '5h', durationSeconds: 18000 },
    { id: 'seven_day', label: '7d', durationSeconds: 604800 },
    { id: 'seven_day_opus', label: '7d Opus', durationSeconds: 604800 },
    { id: 'seven_day_sonnet', label: '7d Sonnet', durationSeconds: 604800 },
  ]

  for (const kw of knownWindows) {
    const item = body[kw.id]
    if (item && typeof item === 'object') {
      const remainingPercent = safeRemainingPercent(item.utilization, true)
      const resetsAt = safeEpochMs(item.resets_at, false)
      windows.push({
        id: kw.id,
        label: kw.label,
        durationSeconds: kw.durationSeconds,
        ...(remainingPercent !== undefined ? { remainingPercent } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })
    }
  }

  const plan = sanitizeSafeString(body.plan ?? body.plan_type, MAX_PLAN_LENGTH)
  if (!windows.some(window => window.remainingPercent !== undefined)) {
    return { status: 'unavailable', windows, ...(plan ? { plan } : {}) }
  }

  return { status: 'ready', windows, ...(plan ? { plan } : {}) }
}

async function queryAntigravityQuota(
  record: StoredAccountRecord,
  fetchFn: typeof globalThis.fetch,
  now: number
): Promise<ProviderQueryResult> {
  let parsedCred: any
  try {
    parsedCred = JSON.parse(record.credential)
  } catch {
    return { status: 'unavailable', windows: [] }
  }

  if (parsedCred?.auth_method !== 'consumer' || !parsedCred?.token || typeof parsedCred.token !== 'object') {
    return { status: 'unavailable', windows: [] }
  }

  const tokenObj = parsedCred.token
  const accessToken = typeof tokenObj.access_token === 'string' ? tokenObj.access_token.trim() : ''
  if (!accessToken) {
    return { status: 'unavailable', windows: [] }
  }

  const expiryRaw = tokenObj.expiry
  const expiryMs = typeof expiryRaw === 'string' ? Date.parse(expiryRaw) : (typeof expiryRaw === 'number' ? expiryRaw : NaN)
  if (Number.isFinite(expiryMs) && expiryMs <= now) {
    return { status: 'expired', windows: [] }
  }
  if (record.metadata.expiresAt && record.metadata.expiresAt <= now) {
    return { status: 'expired', windows: [] }
  }

  let project: string | undefined
  let detectedPlan: string | undefined
  let planReason: 'restricted-age' | 'unavailable' = 'unavailable'
  const loadUrl = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

  try {
    const loadRes = await executeBoundedFetch(fetchFn, loadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity-cli',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    })

    if (loadRes.status === 401) return { status: 'expired', windows: [] }
    if (loadRes.status === 403) return { status: 'forbidden', windows: [] }

    if (loadRes.ok && loadRes.json && typeof loadRes.json === 'object') {
      const p = loadRes.json.cloudaicompanionProject
      if (typeof p === 'string' && p.trim()) {
        project = sanitizeSafeString(p, 150)
      }
      if (Array.isArray(loadRes.json.ineligibleTiers) && loadRes.json.ineligibleTiers.some((tier: any) => tier?.reasonCode === 'RESTRICTED_AGE')) planReason = 'restricted-age'
      const tierObj = loadRes.json.paidTier ?? loadRes.json.currentTier ?? loadRes.json.tier
      if (typeof tierObj === 'string') {
        detectedPlan = sanitizeSafeString(tierObj, MAX_PLAN_LENGTH)
      } else if (tierObj && typeof tierObj === 'object') {
        detectedPlan = sanitizeSafeString(tierObj.name ?? tierObj.id, MAX_PLAN_LENGTH)
      }
    }
  } catch {
    // Project lookup failure may still allow models request without project except auth errors
  }

  const entitlement = detectedPlan ? { plan: detectedPlan } : { planReason }
  const modelsUrl = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
  let modelsRes: { status: number; json: any; ok: boolean }

  try {
    modelsRes = await executeBoundedFetch(fetchFn, modelsUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity-cli',
        'Accept': 'application/json',
      },
      body: JSON.stringify(project ? { project } : {}),
    })

    // One 403-with-project retry without project acceptable
    if (modelsRes.status === 403 && project) {
      project = undefined
      modelsRes = await executeBoundedFetch(fetchFn, modelsUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity-cli',
          'Accept': 'application/json',
        },
        body: JSON.stringify({}),
      })
    }
  } catch {
    return { status: 'error', windows: [], ...entitlement }
  }

  if (modelsRes.status === 401) return { status: 'expired', windows: [], ...entitlement }
  if (modelsRes.status === 403) return { status: 'forbidden', windows: [], ...entitlement }
  if (modelsRes.status === 429) return { status: 'rate-limited', windows: [], ...entitlement }
  if (modelsRes.status < 200 || modelsRes.status >= 300 || !modelsRes.json || typeof modelsRes.json !== 'object') {
    return { status: 'error', windows: [], ...entitlement }
  }

  const body = modelsRes.json
  const rawModels = body.models
  if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) {
    return { status: 'unavailable', windows: [], ...(detectedPlan ? { plan: detectedPlan } : { planReason }) }
  }

  // fetchAvailableModels carries the per-model (5-hour) window. The weekly
  // window is account-family shared and comes from the quota summary endpoint.
  // A summary failure is intentionally best-effort: it must not hide a valid
  // per-model 5-hour result.
  let quotaSummary: AntigravityQuotaSummary | undefined
  try {
    const summaryRes = await executeBoundedFetch(fetchFn, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity-cli',
        'Accept': 'application/json',
      },
      body: JSON.stringify(project ? { project } : {}),
    })
    if (summaryRes.ok && summaryRes.json && typeof summaryRes.json === 'object') {
      quotaSummary = parseAntigravityQuotaSummary(summaryRes.json)
    }
  } catch {
    quotaSummary = undefined
  }

  const windows: AccountQuotaWindow[] = []
  const modelKeys = Object.keys(rawModels)
  let modelCount = 0

  for (const modelKey of modelKeys) {
    if (modelCount >= MAX_MODELS_PER_ACCOUNT || windows.length >= MAX_WINDOWS_PER_ACCOUNT) break
    if (RESERVED_PROPERTY_NAMES.has(modelKey) || CONTROL_CHARS_REGEX.test(modelKey) || modelKey.length > 100) continue

    const m = rawModels[modelKey]
    if (!m || typeof m !== 'object' || Array.isArray(m) || !m.quotaInfo || typeof m.quotaInfo !== 'object' || Array.isArray(m.quotaInfo)) continue
    modelCount++

    const safeDisplayName = sanitizeSafeString(m.displayName, MAX_LABEL_LENGTH)
    const label = safeDisplayName ?? modelKey
    const family = classifyAntigravityModelFamily(modelKey, m.displayName, m.apiProvider)

    let remainingPercent: number | undefined
    let resetsAt: number | undefined

    if (m.quotaInfo && typeof m.quotaInfo === 'object') {
      remainingPercent = safeRemainingPercent(m.quotaInfo.remainingFraction, false)
      resetsAt = safeEpochMs(m.quotaInfo.resetTime, false)
    }

    windows.push({
      id: modelKey,
      label,
      modelLabel: label,
      period: 'five-hour',
      durationSeconds: 18000,
      ...(remainingPercent !== undefined ? { remainingPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })

    if (family) {
      const weekly = quotaSummary?.get(family)?.get('weekly')
      windows.push({
        id: `${modelKey}:weekly`,
        label,
        modelLabel: label,
        period: 'weekly',
        durationSeconds: 604800,
        ...(weekly?.remainingPercent !== undefined ? { remainingPercent: weekly.remainingPercent } : {}),
        ...(weekly?.resetsAt !== undefined ? { resetsAt: weekly.resetsAt } : {}),
      })
    }
  }

  if (!windows.some(window => window.remainingPercent !== undefined)) {
    return { status: 'unavailable', windows, ...(detectedPlan ? { plan: detectedPlan } : { planReason }) }
  }

  return { status: 'ready', windows, ...(detectedPlan ? { plan: detectedPlan } : { planReason }) }
}

export class AccountQuotaService {
  private readonly store: Pick<AccountStore, 'get'>
  private readonly onChangedOption?: () => void
  private readonly fetchFn: typeof globalThis.fetch
  private readonly nowFn: () => number

  private readonly cache: Map<string, CachedQuotaEntry> = new Map()
  private readonly inFlight: Map<string, Promise<AccountQuotaSnapshot>> = new Map()
  private activeHttpCount = 0
  private readonly httpWaitQueue: Array<() => void> = []

  constructor(options: AccountQuotaServiceOptions) {
    if (!options || typeof options !== 'object' || !options.store || typeof options.store.get !== 'function') {
      throw new AccountError('Invalid AccountQuotaService options: store.get is required.')
    }
    this.store = options.store
    this.onChangedOption = options.onChanged
    this.fetchFn = options.fetch ?? globalThis.fetch
    this.nowFn = options.now ?? (() => Date.now())
  }

  private notifyChanged(): void {
    try {
      this.onChangedOption?.()
    } catch {
      // Callback failure shouldn't corrupt result or crash service
    }
  }

  private async acquireConcurrencySlot(): Promise<void> {
    if (this.activeHttpCount < MAX_CONCURRENT_HTTP) {
      this.activeHttpCount++
      return
    }
    return new Promise<void>((resolve) => {
      this.httpWaitQueue.push(() => {
        this.activeHttpCount++
        resolve()
      })
    })
  }

  private releaseConcurrencySlot(): void {
    this.activeHttpCount--
    if (this.httpWaitQueue.length > 0) {
      const next = this.httpWaitQueue.shift()!
      next()
    }
  }

  private async queryProvider(record: StoredAccountRecord, now: number): Promise<ProviderQueryResult> {
    switch (record.metadata.tool) {
      case 'codex':
        return await queryCodexQuota(record, this.fetchFn, now)
      case 'claude-code':
        return await queryClaudeQuota(record, this.fetchFn, now)
      case 'antigravity':
        return await queryAntigravityQuota(record, this.fetchFn, now)
      default:
        return { status: 'unavailable', windows: [] }
    }
  }

  /**
   * Retrieves cloned cached snapshots for the provided accounts without making network requests.
   * Evicts cache entries for accounts that no longer exist or whose updatedAt has changed.
   */
  getCached(accounts: AccountMetadata[]): AccountQuotaSnapshot[] {
    if (!Array.isArray(accounts)) return []

    const currentMap = new Map(accounts.map((a) => [a.id, a]))

    // Prune deleted accounts
    for (const id of Array.from(this.cache.keys())) {
      if (!currentMap.has(id)) {
        this.cache.delete(id)
      }
    }

    const results: AccountQuotaSnapshot[] = []
    for (const account of accounts) {
      const cached = this.cache.get(account.id)
      if (cached) {
        if (cached.accountUpdatedAt !== account.updatedAt) {
          // Account credentials/metadata were modified; prune stale cache entry
          this.cache.delete(account.id)
        } else {
          results.push(structuredClone(cached.snapshot))
        }
      }
    }

    return results
  }

  /**
   * Refreshes quota for a specific account with per-account in-flight deduplication
   * and bounded concurrency.
   */
  async refreshAccount(id: string): Promise<AccountQuotaSnapshot> {
    const validId = validateAccountId(id)

    const existingPromise = this.inFlight.get(validId)
    if (existingPromise) {
      return structuredClone(await existingPromise)
    }
    if (this.inFlight.size >= MAX_PENDING_REFRESHES) throw new AccountError('配额查询较多，请稍后重试。')

    const runPromise = this.executeRefresh(validId)
    this.inFlight.set(validId, runPromise)
    try {
      return await runPromise
    } finally {
      this.inFlight.delete(validId)
    }
  }

  private async executeRefresh(id: string): Promise<AccountQuotaSnapshot> {
    // Acquire before reading credentials so queued work does not retain token payloads.
    await this.acquireConcurrencySlot()
    let initialRecord: StoredAccountRecord
    try {
      initialRecord = await this.store.get(id)
    } catch (err) {
      this.releaseConcurrencySlot()
      this.cache.delete(id)
      throw err instanceof AccountError ? err : new AccountError('无法读取账号凭据。')
    }

    const attemptedAt = this.nowFn()
    const credentialHash = createHash('sha256').update(initialRecord.credential).digest('hex')
    let providerResult: ProviderQueryResult
    try {
      providerResult = await this.queryProvider(initialRecord, attemptedAt)
    } catch {
      providerResult = { status: 'error', windows: [] }
    } finally {
      this.releaseConcurrencySlot()
    }

    // Even a successful provider response may echo request values into labels.
    const secrets: string[] = [initialRecord.credential]
    try {
      const payload = JSON.parse(initialRecord.credential)
      for (const fields of [payload, payload?.tokens, payload?.token, payload?.claudeAiOauth]) {
        if (!fields || typeof fields !== 'object') continue
        for (const key of ['access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken']) {
          if (typeof fields[key] === 'string' && fields[key].length >= 4) secrets.push(fields[key])
        }
      }
    } catch { /* Raw Claude token is already included. */ }
    const containsSecret = (value: string) => secrets.some(secret => value.includes(secret))
    providerResult.windows = providerResult.windows.filter(window =>
      !containsSecret(window.id) &&
      !containsSecret(window.label) &&
      !(window.modelLabel && containsSecret(window.modelLabel))
    )
    if (providerResult.plan && containsSecret(providerResult.plan)) delete providerResult.plan
    if (providerResult.status === 'ready' && !providerResult.windows.some(window => window.remainingPercent !== undefined)) {
      providerResult.status = 'unavailable'
    }

    const newSnapshot: AccountQuotaSnapshot = {
      accountId: id,
      tool: initialRecord.metadata.tool,
      status: providerResult.status,
      windows: providerResult.windows,
      ...(providerResult.plan ? { plan: providerResult.plan } : {}),
      ...(providerResult.planReason ? { planReason: providerResult.planReason } : {}),
      ...(providerResult.status === 'ready' ? { fetchedAt: this.nowFn() } : {}),
      attemptedAt,
    }

    // Re-read record after network request before committing cache
    let postRecord: StoredAccountRecord | null = null
    try {
      postRecord = await this.store.get(id)
    } catch {
      postRecord = null
    }

    // If account was deleted while fetch was in flight, do not resurrect into cache
    if (!postRecord) {
      this.cache.delete(id)
      throw new AccountError('账号已移除，请刷新列表。')
    }

    // If account was modified while fetch was in flight, do not commit stale fetch to cache
    if (
      postRecord.metadata.updatedAt !== initialRecord.metadata.updatedAt ||
      postRecord.metadata.tool !== initialRecord.metadata.tool ||
      postRecord.credential !== initialRecord.credential
    ) {
      this.cache.delete(id)
      throw new AccountError('账号凭据已变更，请重新查询配额。')
    }

    let snapshotToCommit = newSnapshot

    // Keep prior successful windows on failed refresh only with stale: true and explicit failed status
    if (newSnapshot.status !== 'ready') {
      const cached = this.cache.get(id)
      const prior = cached?.snapshot
      if (prior?.fetchedAt && prior.windows.length > 0 && cached?.credentialHash === credentialHash && cached.accountUpdatedAt === initialRecord.metadata.updatedAt) {
        snapshotToCommit = {
          accountId: id,
          tool: initialRecord.metadata.tool,
          status: newSnapshot.status,
          windows: structuredClone(prior.windows),
          ...(newSnapshot.planReason ? { planReason: newSnapshot.planReason } : { plan: newSnapshot.plan ?? prior.plan, planReason: newSnapshot.plan ? undefined : prior.planReason }),
          fetchedAt: prior.fetchedAt,
          attemptedAt,
          stale: true,
        }
      }
    }

    this.cache.set(id, {
      snapshot: snapshotToCommit,
      accountUpdatedAt: postRecord.metadata.updatedAt,
      credentialHash,
    })

    this.notifyChanged()

    return structuredClone(snapshotToCommit)
  }

  /**
   * Invalidates cached quota snapshot for a specific account.
   */
  invalidate(id: string): void {
    try {
      const validId = validateAccountId(id)
      if (this.cache.delete(validId)) {
        this.notifyChanged()
      }
    } catch {
      // Ignore invalid UUID gracefully
    }
  }
}
