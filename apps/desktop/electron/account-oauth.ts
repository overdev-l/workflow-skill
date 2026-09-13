/**
 * Isolated OAuth Session Engine (OPC-48)
 *
 * Provides a secure, independent Node HTTP loopback OAuth authorization and PKCE
 * session engine for AI developer tools (Google Antigravity, OpenAI Codex, Claude Code).
 *
 * Key Security & Architecture Invariants:
 * - Completely independent of Electron APIs (pure Node.js crypto, http, and net).
 * - Renderer snapshots are strictly metadata-only (AccountOAuthSession); secrets,
 *   PKCE verifiers, random states, raw authorization URLs, authorization codes,
 *   and credential payloads are never leaked across IPC or memory snapshots.
 * - Single active login globally; concurrent begin() calls atomically reject busy
 *   before any async listener binding or browser launch.
 * - Strict authorization HTTPS origin allowlist (auth.openai.com, claude.ai,
 *   platform.claude.com, console.anthropic.com, accounts.google.com) with no userinfo or hash.
 * - Bounded loopback HTTP listener bound exclusively to 127.0.0.1 with local socket check,
 *   strict Host validation, exact callback path matching, and length-safe timingSafeEqual state.
 * - Malformed, mismatched, or foreign requests never consume or corrupt a live waiting session.
 * - Explicit commit boundary: if user cancellation races while saveAccount is in-flight,
 *   the transition is serialized and reports succeeded if persistence completes.
 * - Hard deadlines (default 10 minutes) with zero raw exception reflections; all user-facing
 *   messages are trusted and static.
 */

import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  AccountError,
  type AccountMetadata,
  type AccountOAuthPhase,
  type AccountOAuthSession,
  type AccountTool,
  validateAccountId,
  validateAccountTool,
} from '../../../packages/workflow-model/src/accounts.ts'

export type { AccountMetadata, AccountTool, AccountOAuthPhase, AccountOAuthSession }
export type OAuthPhase = AccountOAuthPhase
export { AccountError }

export interface AccountOAuthProvider {
  port: number
  callbackPath: string
  redirectHost?: 'localhost' | '127.0.0.1'
  authorizationUrl(input: {
    state: string
    challenge: string
    redirectUri: string
  }): string
  exchange(input: {
    code: string
    verifier: string
    redirectUri: string
    state: string
    signal: AbortSignal
  }): Promise<string>
}

export interface AccountOAuthServiceOptions {
  providers: Partial<Record<AccountTool, AccountOAuthProvider>>
  openExternal: (url: string) => Promise<unknown>
  saveAccount: (input: { tool: AccountTool; credential: string }) => Promise<AccountMetadata>
  now?: () => number
  timeoutMs?: number
  onChanged?: () => void
}

export const ALLOWED_AUTHORIZATION_ORIGINS: ReadonlySet<string> = new Set([
  'https://auth.openai.com',
  'https://claude.ai',
  'https://claude.com',
  'https://platform.claude.com',
  'https://console.anthropic.com',
  'https://accounts.google.com',
])

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const MAX_TERMINAL_SESSIONS = 20
const MAX_TERMINAL_AGE_MS = 10 * 60 * 1000 // 10 minutes
const MAX_REQUEST_URL_LENGTH = 8192

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>授权成功 / Authorization Successful</title>
</head>
<body>
  <h2>授权成功 / Authorization Successful</h2>
  <p>账号已成功绑定，您可以关闭此页面返回应用。</p>
  <p>Account linked successfully. You may close this tab and return to the application.</p>
</body>
</html>`

const FAILURE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>授权失败 / Authorization Failed</title>
</head>
<body>
  <h2>授权失败 / Authorization Failed</h2>
  <p>授权未完成或发生错误，请返回应用重试。</p>
  <p>Authorization was not completed or an error occurred. Please return to the application and try again.</p>
</body>
</html>`

function safeTimingEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false
  }
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export function validateAuthorizationUrl(
  rawUrl: string,
  expected: {
    state: string
    challenge: string
    redirectUri: string
  }
): URL {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw new AccountError('OAuth 授权地址必须为非空字符串。')
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new AccountError('OAuth 授权地址格式无效。')
  }

  if (parsed.protocol !== 'https:') {
    throw new AccountError('OAuth 授权地址必须使用 HTTPS 协议。')
  }

  if (!ALLOWED_AUTHORIZATION_ORIGINS.has(parsed.origin)) {
    throw new AccountError('OAuth 授权域名不在受信任的提供商白名单中。')
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new AccountError('OAuth 授权地址不能包含用户信息凭据。')
  }

  if (parsed.hash !== '') {
    throw new AccountError('OAuth 授权地址不能包含哈希片段。')
  }

  const states = parsed.searchParams.getAll('state')
  if (states.length !== 1 || states[0] !== expected.state) {
    throw new AccountError('OAuth 授权地址 state 参数无效或存在重复。')
  }

  const challenges = parsed.searchParams.getAll('code_challenge')
  if (challenges.length !== 1 || challenges[0] !== expected.challenge) {
    throw new AccountError('OAuth 授权地址 code_challenge 参数无效或存在重复。')
  }

  const methods = parsed.searchParams.getAll('code_challenge_method')
  if (methods.length !== 1 || methods[0] !== 'S256') {
    throw new AccountError('OAuth 授权地址 code_challenge_method 必须唯一且为 S256。')
  }

  const redirectUris = parsed.searchParams.getAll('redirect_uri')
  if (redirectUris.length !== 1 || redirectUris[0] !== expected.redirectUri) {
    throw new AccountError('OAuth 授权地址 redirect_uri 参数无效或存在重复。')
  }

  return parsed
}

function sendHtmlResponse(res: http.ServerResponse, statusCode: number, html: string): void {
  try {
    if (res.headersSent || res.writableEnded) {
      return
    }
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Connection': 'close',
    })
    res.end(html, 'utf8')
    res.on('finish', () => {
      setImmediate(() => {
        try {
          res.socket?.destroy()
        } catch {
          // Ignore destruction errors
        }
      })
    })
  } catch {
    // Ignore socket write errors
  }
}

interface InternalSession {
  id: string
  tool: AccountTool
  phase: OAuthPhase
  expiresAt: number
  accountId?: string
  error?: string

  // Sensitive cryptographic credentials (cleared in terminal cleanup, never returned)
  state: string
  verifier: string
  authorizationUrl: string

  // Runtime lifecycle state
  abortController: AbortController
  server?: http.Server
  sockets: Set<Socket>
  timeoutTimer?: NodeJS.Timeout
  committing: boolean
  cancelRequested: boolean
  commitPromise?: Promise<AccountMetadata>
  terminalAt?: number
  clearSensitive(): void
}

export class AccountOAuthService {
  private readonly options: AccountOAuthServiceOptions
  private readonly sessions = new Map<string, InternalSession>()
  private activeSessionId: string | null = null
  private isDisposed = false

  constructor(options: AccountOAuthServiceOptions) {
    if (!options || typeof options !== 'object') {
      throw new AccountError('OAuth 服务配置必须为有效对象。')
    }
    if (typeof options.openExternal !== 'function') {
      throw new AccountError('必须提供 openExternal 回调函数。')
    }
    if (typeof options.saveAccount !== 'function') {
      throw new AccountError('必须提供 saveAccount 回调函数。')
    }
    if (options.timeoutMs !== undefined) {
      if (
        typeof options.timeoutMs !== 'number' ||
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0
      ) {
        throw new AccountError('OAuth 超时时间必须为有效的正有限数值。')
      }
    }
    this.options = options
  }

  private now(): number {
    return typeof this.options.now === 'function' ? this.options.now() : Date.now()
  }

  private notifyChanged(): void {
    try {
      this.options.onChanged?.()
    } catch {
      // Isolate onChanged listener errors from session flow
    }
  }

  private validateCallbackPath(callbackPath: unknown): string {
    if (
      typeof callbackPath !== 'string' ||
      !callbackPath.startsWith('/') ||
      callbackPath.includes('?') ||
      callbackPath.includes('#') ||
      callbackPath.includes('..')
    ) {
      throw new AccountError('OAuth 提供商回调路径格式无效。')
    }
    return callbackPath
  }

  private snapshot(session: InternalSession): AccountOAuthSession {
    const snap: AccountOAuthSession = {
      id: session.id,
      tool: session.tool,
      phase: session.phase,
      expiresAt: session.expiresAt,
    }
    if (session.accountId !== undefined) {
      snap.accountId = session.accountId
    }
    if (session.error !== undefined) {
      snap.error = session.error
    }
    return { ...snap }
  }

  private pruneTerminalSessions(): void {
    const currentNow = this.now()

    // 1. Evict terminal sessions older than max age
    for (const [id, session] of this.sessions.entries()) {
      if (session.phase !== 'waiting' && session.phase !== 'exchanging') {
        if (session.terminalAt !== undefined && currentNow - session.terminalAt > MAX_TERMINAL_AGE_MS) {
          this.sessions.delete(id)
        }
      }
    }

    // 2. Bound total terminal sessions count
    const terminalSessions: InternalSession[] = []
    for (const session of this.sessions.values()) {
      if (session.phase !== 'waiting' && session.phase !== 'exchanging') {
        terminalSessions.push(session)
      }
    }

    if (terminalSessions.length > MAX_TERMINAL_SESSIONS) {
      terminalSessions.sort((a, b) => (a.terminalAt ?? 0) - (b.terminalAt ?? 0))
      const toRemove = terminalSessions.slice(0, terminalSessions.length - MAX_TERMINAL_SESSIONS)
      for (const s of toRemove) {
        this.sessions.delete(s.id)
      }
    }
  }

  private cleanupSessionResources(session: InternalSession): void {
    if (session.timeoutTimer !== undefined) {
      clearTimeout(session.timeoutTimer)
      session.timeoutTimer = undefined
    }

    if (this.activeSessionId === session.id) {
      this.activeSessionId = null
    }

    if (session.terminalAt === undefined) {
      session.terminalAt = this.now()
    }

    session.clearSensitive()

    if (session.server) {
      const serverInstance = session.server
      session.server = undefined
      try {
        serverInstance.close()
      } catch {
        // Ignore server close error
      }
      // Allow the static callback response to flush, then bound all open sockets,
      // including clients that never finish sending their request headers.
      const sockets = [...session.sockets]
      setTimeout(() => {
        for (const socket of sockets) socket.destroy()
      }, 100).unref()
    }

    this.pruneTerminalSessions()
  }

  private handleTimeout(id: string): void {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }

    // Never overwrite already terminal states
    if (session.phase !== 'waiting' && session.phase !== 'exchanging') {
      return
    }

    if (session.committing) {
      // If within commit boundary, await commit outcome before finalizing phase
      session.commitPromise?.then(
        () => {
          // Persistence succeeded; do not resurrect or replace status with expired
        },
        () => {
          if (session.phase === 'exchanging') {
            session.phase = 'expired'
            session.error = 'OAuth 登录超时，请重试。'
            this.cleanupSessionResources(session)
            this.notifyChanged()
          }
        }
      )
      return
    }

    session.phase = 'expired'
    session.error = 'OAuth 登录超时，请重试。'
    session.abortController.abort()
    this.cleanupSessionResources(session)
    this.notifyChanged()
  }

  async begin(tool: AccountTool): Promise<AccountOAuthSession> {
    if (this.isDisposed) {
      throw new AccountError('OAuth 服务已释放。')
    }

    const validatedTool = validateAccountTool(tool)
    const provider = this.options.providers[validatedTool]
    if (!provider) {
      throw new AccountError(`未配置工具 ${validatedTool} 的 OAuth 提供者。`)
    }

    // Synchronous atomic check: only one active login globally
    if (this.activeSessionId !== null) {
      const existing = this.sessions.get(this.activeSessionId)
      if (existing && (existing.phase === 'waiting' || existing.phase === 'exchanging')) {
        throw new AccountError('当前已有正在进行的登录流程，请先完成或取消。')
      }
    }

    const callbackPath = this.validateCallbackPath(provider.callbackPath)
    const redirectHost = provider.redirectHost ?? '127.0.0.1'
    if (redirectHost !== '127.0.0.1' && redirectHost !== 'localhost') {
      throw new AccountError('重定向主机名必须为 127.0.0.1 或 localhost。')
    }

    if (
      typeof provider.port !== 'number' ||
      !Number.isInteger(provider.port) ||
      provider.port < 0 ||
      provider.port > 65535
    ) {
      throw new AccountError('OAuth 本地端口号无效。')
    }

    // Atomically reserve active slot synchronously before async operations
    const id = randomUUID()
    this.activeSessionId = id

    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const expiresAt = this.now() + timeoutMs

    const session: InternalSession = {
      id,
      tool: validatedTool,
      phase: 'waiting',
      expiresAt,
      state,
      verifier,
      authorizationUrl: '',
      abortController: new AbortController(),
      sockets: new Set<Socket>(),
      committing: false,
      cancelRequested: false,
      clearSensitive() {
        this.state = ''
        this.verifier = ''
        this.authorizationUrl = ''
      },
    }

    this.sessions.set(id, session)

    let server: http.Server
    let actualPort: number

    try {
      server = http.createServer((req, res) => {
        this.handleHttpRequest(session, provider, redirectHost, actualPort, req, res)
      })

      server.headersTimeout = 10_000
      server.requestTimeout = 15_000

      server.on('connection', (socket) => {
        session.sockets.add(socket)
        socket.once('close', () => {
          session.sockets.delete(socket)
        })
      })

      // Assign server ownership to session BEFORE await to eliminate begin/dispose race
      session.server = server

      if (this.isDisposed || session.phase !== 'waiting' || session.abortController.signal.aborted) {
        throw new AccountError('OAuth 服务已释放或会话已取消。')
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening)
          session.abortController.signal.removeEventListener('abort', onAbort)
          reject(err)
        }
        const onListening = () => {
          server.off('error', onError)
          session.abortController.signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          server.off('error', onError)
          server.off('listening', onListening)
          try {
            server.close()
          } catch {
            // Ignore close error
          }
          reject(new AccountError('OAuth 服务已释放或会话已取消。'))
        }
        server.once('error', onError)
        server.once('listening', onListening)
        session.abortController.signal.addEventListener('abort', onAbort, { once: true })
        server.listen(provider.port, '127.0.0.1')
      })

      if (this.isDisposed || session.phase !== 'waiting' || session.abortController.signal.aborted) {
        throw new AccountError('OAuth 服务已释放或会话已取消。')
      }

      const address = server.address() as AddressInfo | null
      if (!address || typeof address === 'string') {
        throw new AccountError('无法获取 OAuth 本地服务器端口。')
      }
      actualPort = address.port
    } catch (err) {
      this.cleanupSessionResources(session)
      this.sessions.delete(id)
      if (err instanceof AccountError) {
        throw err
      }
      throw new AccountError('OAuth 本地端口监听失败。')
    }

    const redirectUri = `http://${redirectHost}:${actualPort}${callbackPath}`
    let authUrl: string
    try {
      authUrl = provider.authorizationUrl({
        state,
        challenge,
        redirectUri,
      })
      validateAuthorizationUrl(authUrl, {
        state,
        challenge,
        redirectUri,
      })
    } catch (err) {
      this.cleanupSessionResources(session)
      this.sessions.delete(id)
      if (err instanceof AccountError) {
        throw err
      }
      throw new AccountError('OAuth 提供者授权地址无效。')
    }

    session.authorizationUrl = authUrl

    // Set expiration deadline timer
    session.timeoutTimer = setTimeout(() => {
      this.handleTimeout(id)
    }, timeoutMs)

    // Recheck disposed / session phase before opening browser
    if (this.isDisposed || session.phase !== 'waiting' || session.abortController.signal.aborted) {
      this.cleanupSessionResources(session)
      this.sessions.delete(id)
      throw new AccountError('OAuth 服务已释放或会话已取消。')
    }

    // Launch external browser window
    try {
      await this.options.openExternal(authUrl)
    } catch (err) {
      this.cleanupSessionResources(session)
      this.sessions.delete(id)
      throw new AccountError('打开浏览器授权页面失败。')
    }

    this.notifyChanged()
    return this.snapshot(session)
  }

  private handleHttpRequest(
    session: InternalSession,
    provider: AccountOAuthProvider,
    redirectHost: string,
    actualPort: number,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const rawUrl = req.url ?? ''
    if (rawUrl.length > MAX_REQUEST_URL_LENGTH) {
      sendHtmlResponse(res, 414, FAILURE_HTML)
      return
    }

    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    if (req.method !== 'GET') {
      sendHtmlResponse(res, 405, FAILURE_HTML)
      return
    }

    const remote = req.socket.remoteAddress
    const isLocal = remote === '127.0.0.1' || remote === '::ffff:127.0.0.1' || remote === '::1'
    if (!isLocal) {
      sendHtmlResponse(res, 403, FAILURE_HTML)
      return
    }

    const reqHost = req.headers.host
    const expectedHosts =
      redirectHost === 'localhost'
        ? [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`]
        : [`127.0.0.1:${actualPort}`]

    if (!reqHost || !expectedHosts.includes(reqHost)) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl, `http://127.0.0.1:${actualPort}`)
    } catch {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    if (parsedUrl.pathname !== provider.callbackPath) {
      sendHtmlResponse(res, 404, FAILURE_HTML)
      return
    }

    const stateParams = parsedUrl.searchParams.getAll('state')
    const codeParams = parsedUrl.searchParams.getAll('code')
    const errorParams = parsedUrl.searchParams.getAll('error')

    // Reject missing or duplicate state
    if (stateParams.length !== 1) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    // Reject mixed error and code
    if (codeParams.length > 0 && errorParams.length > 0) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    // Reject missing both code and error
    if (codeParams.length === 0 && errorParams.length === 0) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    // Reject duplicate code
    if (codeParams.length > 1) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    // Reject duplicate error
    if (errorParams.length > 1) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    // Verify state length-safe timingSafeEqual
    const receivedState = stateParams[0]
    if (!safeTimingEqual(receivedState, session.state)) {
      // Malformed or foreign state must not consume live waiting session
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }

    // If session is already non-waiting (cancelled, expired, exchanging, succeeded, error)
    if (session.phase !== 'waiting') {
      sendHtmlResponse(res, 409, FAILURE_HTML)
      return
    }

    // Provider error branch
    if (errorParams.length === 1) {
      session.phase = 'error'
      session.error = 'OAuth 授权被拒绝或失败。'
      this.cleanupSessionResources(session)
      this.notifyChanged()
      sendHtmlResponse(res, 200, FAILURE_HTML)
      return
    }

    // Code callback: synchronously change phase to exchanging
    const code = codeParams[0]
    if (!code) {
      sendHtmlResponse(res, 400, FAILURE_HTML)
      return
    }
    session.phase = 'exchanging'
    this.notifyChanged()

    const redirectUri = `http://${redirectHost}:${actualPort}${provider.callbackPath}`
    void this.performExchangeAndSave(session, provider, code, redirectUri, res)
  }

  private async performExchangeAndSave(
    session: InternalSession,
    provider: AccountOAuthProvider,
    code: string,
    redirectUri: string,
    res: http.ServerResponse
  ): Promise<void> {
    const verifier = session.verifier
    try {
      const credential = await provider.exchange({
        code,
        verifier,
        redirectUri,
        state: session.state,
        signal: session.abortController.signal,
      })

      // Check current session state after async boundary
      if (session.phase !== 'exchanging' || session.abortController.signal.aborted) {
        sendHtmlResponse(res, 409, FAILURE_HTML)
        this.cleanupSessionResources(session)
        return
      }

      // Explicit commit boundary
      session.committing = true
      let metadata: AccountMetadata
      try {
        const savePromise = this.options.saveAccount({
          tool: session.tool,
          credential,
        })
        session.commitPromise = savePromise
        metadata = await savePromise
      } catch (saveErr) {
        session.committing = false
        session.commitPromise = undefined

        if (session.cancelRequested) {
          session.phase = 'cancelled'
          session.error = 'OAuth 登录已取消。'
        } else {
          session.phase = 'error'
          session.error = '保存账号凭据失败。'
        }
        this.cleanupSessionResources(session)
        this.notifyChanged()
        sendHtmlResponse(res, 500, FAILURE_HTML)
        return
      }

      // Commit completed successfully
      session.committing = false
      session.commitPromise = undefined
      session.phase = 'succeeded'
      session.accountId = metadata.id
      session.error = undefined

      this.cleanupSessionResources(session)
      this.notifyChanged()
      sendHtmlResponse(res, 200, SUCCESS_HTML)
    } catch (exchangeErr) {
      session.committing = false
      session.commitPromise = undefined

      if (session.phase === 'cancelled') {
        sendHtmlResponse(res, 409, FAILURE_HTML)
      } else if (session.phase === 'expired') {
        sendHtmlResponse(res, 408, FAILURE_HTML)
      } else {
        session.phase = 'error'
        session.error = 'OAuth 令牌兑换失败，请重试。'
        sendHtmlResponse(res, 500, FAILURE_HTML)
      }
      this.cleanupSessionResources(session)
      this.notifyChanged()
    } finally {
      session.clearSensitive()
    }
  }

  get(id: string): AccountOAuthSession {
    const validId = validateAccountId(id)
    const session = this.sessions.get(validId)
    if (!session) {
      throw new AccountError('OAuth 会话不存在。')
    }

    if (session.phase === 'waiting' && this.now() >= session.expiresAt) {
      session.phase = 'expired'
      session.error = 'OAuth 登录超时，请重试。'
      session.abortController.abort()
      this.cleanupSessionResources(session)
      this.notifyChanged()
    }

    return this.snapshot(session)
  }

  async cancel(id: string): Promise<void> {
    const validId = validateAccountId(id)
    const session = this.sessions.get(validId)
    if (!session) {
      throw new AccountError('OAuth 会话不存在。')
    }

    if (session.phase !== 'waiting' && session.phase !== 'exchanging') {
      return
    }

    // Racing against persistence commit boundary: serialize terminal transition
    if (session.committing && session.commitPromise) {
      session.cancelRequested = true
      try {
        await session.commitPromise
        // Commit succeeded; do not report cancelled
        return
      } catch {
        // Commit failed; mark cancelled
        session.phase = 'cancelled'
        session.error = 'OAuth 登录已取消。'
        this.cleanupSessionResources(session)
        this.notifyChanged()
        return
      }
    }

    session.phase = 'cancelled'
    session.error = 'OAuth 登录已取消。'
    session.abortController.abort()
    this.cleanupSessionResources(session)
    this.notifyChanged()
  }

  async reopen(id: string): Promise<void> {
    const validId = validateAccountId(id)
    const session = this.sessions.get(validId)
    if (!session) {
      throw new AccountError('OAuth 会话不存在。')
    }

    if (session.phase !== 'waiting') {
      throw new AccountError('只有处于等待状态的 OAuth 会话才能重新打开。')
    }

    if (this.now() >= session.expiresAt) {
      throw new AccountError('OAuth 会话已过期。')
    }

    if (!session.authorizationUrl) {
      throw new AccountError('OAuth 授权地址不可用。')
    }

    try {
      await this.options.openExternal(session.authorizationUrl)
    } catch {
      throw new AccountError('重新打开浏览器授权页面失败。')
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true
    for (const session of this.sessions.values()) {
      if (session.phase === 'waiting' || session.phase === 'exchanging') {
        session.phase = 'cancelled'
        session.error = 'OAuth 服务已释放。'
        session.abortController.abort()
      }
      for (const socket of session.sockets) {
        try {
          socket.destroy()
        } catch {
          // Ignore
        }
      }
      session.sockets.clear()
      this.cleanupSessionResources(session)
    }
    this.sessions.clear()
    this.activeSessionId = null
  }
}
