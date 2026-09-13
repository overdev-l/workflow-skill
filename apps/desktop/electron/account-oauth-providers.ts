/**
 * Official Tool OAuth Provider Adapters (OPC-48)
 *
 * Implements fixed production OAuth and PKCE configurations for OpenAI Codex,
 * Claude Code, and Google Antigravity.
 *
 * Security & Design Invariants:
 * - Production endpoints are hardcoded; no custom or renderer-supplied URLs.
 * - Public desktop client identifiers and parameters verified against official
 *   installed binaries (Codex CLI, Claude Code 2.1.162, Antigravity CLI 1.2.2).
 * - Pure network/crypto protocol implementation; no Keychain, no filesystem writes,
 *   no CLI subprocesses, and no credential fallback chains.
 * - HTTP exchanges enforce 15s hard timeout (including stalled body streams), 1 MiB
 *   body cap, 'error' redirect policy, and zero error reflection (no raw bodies or tokens).
 * - Token normalization matches local adapters with strict identity schema validation.
 */

import { AccountError, type AccountTool } from '../../../packages/workflow-model/src/accounts.ts'
import { inspectAntigravityCredential } from './account-credential-format.ts'
import type { AccountOAuthProvider } from './account-oauth.ts'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_AUTH_URL = 'https://claude.com/cai/oauth/authorize'
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = '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'
export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_PROFILE_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB
const HTTP_TIMEOUT_MS = 15_000 // 15 seconds

export interface CreateAccountOAuthProvidersOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
  httpTimeoutMs?: number
}

function safeTokenString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AccountError('OAuth 提供商未返回有效的凭据令牌。')
  }
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 5 * 1024 * 1024) {
    throw new AccountError('OAuth 提供商返回的令牌格式无效。')
  }
  return trimmed
}

function safeMetadataString(value: unknown, maxLength = 255): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return undefined
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return undefined
  }
  // Disallow suspicious patterns that might accidentally leak credentials or tokens
  if (/^(sk-|GOCSPX-|eyJ|app_)/.test(trimmed)) {
    return undefined
  }
  return trimmed
}

/**
 * Parses JWT claims payload offline without claiming signature verification.
 */
function parseJwtPayload(jwtToken: string): Record<string, unknown> {
  const parts = jwtToken.split('.')
  if (parts.length !== 3 || !parts[1]) {
    throw new AccountError('ID 令牌不是有效的 JWT 结构。')
  }
  try {
    const jsonStr = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(jsonStr)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AccountError('ID 令牌 Payload 格式无效。')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new AccountError('ID 令牌 Payload 无法解析。')
  }
}

interface HttpRequestOptions {
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal: AbortSignal
  fetchFn?: typeof globalThis.fetch
  httpTimeoutMs?: number
}

async function executeBoundedRequest(
  url: string,
  options: HttpRequestOptions
): Promise<any> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new AccountError('运行环境不支持 fetch 请求。')
  }

  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const interrupted = () => new AccountError(options.signal.aborted
    ? 'OAuth 会话已取消或中断。' : 'OAuth 提供商网络请求失败或超时。')
  let rejectDeadline!: (error: AccountError) => void
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
  const abort = () => {
    rejectDeadline(interrupted())
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
  const timeoutDuration = options.httpTimeoutMs ?? HTTP_TIMEOUT_MS
  const timer = setTimeout(abort, timeoutDuration)
  options.signal.addEventListener('abort', abort, { once: true })
  // Attach a rejection consumer before handling an already cancelled request.
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline])
  if (options.signal.aborted) abort()
  try {
    const res = await bounded(Promise.resolve().then(() => {
      if (controller.signal.aborted) throw interrupted()
      return fetchImpl(url, {
        method: options.method, headers: options.headers, body: options.body,
        signal: controller.signal, redirect: 'error',
      })
    }))
    if (!res.ok) throw new AccountError('OAuth 提供商返回错误响应。')
    const contentLength = Number(res.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      void res.body?.cancel().catch(() => {})
      throw new AccountError('OAuth 提供商响应内容过大。')
    }
    let rawText: string
    if (res.body) {
      reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let totalBytes = 0
      while (true) {
        const { done, value } = await bounded(reader.read())
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > MAX_BODY_BYTES) throw new AccountError('OAuth 提供商响应内容过大。')
        chunks.push(value)
      }
      rawText = Buffer.concat(chunks).toString('utf8')
    } else {
      rawText = await bounded(res.text())
      if (Buffer.byteLength(rawText, 'utf8') > MAX_BODY_BYTES) throw new AccountError('OAuth 提供商响应内容过大。')
    }
    let parsed: unknown
    try { parsed = JSON.parse(rawText) }
    catch { throw new AccountError('OAuth 提供商返回的响应不是有效 JSON。') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AccountError('OAuth 提供商返回数据格式错误。')
    return parsed
  } catch (error) {
    if (error instanceof AccountError) throw error
    throw interrupted()
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    void reader?.cancel().catch(() => {})
    controller.abort()
  }
}

export function createAccountOAuthProviders(
  options: CreateAccountOAuthProvidersOptions = {}
): Record<AccountTool, AccountOAuthProvider> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  const httpTimeoutMs =
    typeof options.httpTimeoutMs === 'number' && Number.isFinite(options.httpTimeoutMs) && options.httpTimeoutMs > 0
      ? options.httpTimeoutMs
      : undefined

  const codexProvider: AccountOAuthProvider = {
    port: 1455,
    redirectHost: 'localhost',
    callbackPath: '/auth/callback',
    authorizationUrl(input) {
      const u = new URL(CODEX_AUTH_URL)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', CODEX_CLIENT_ID)
      u.searchParams.set('redirect_uri', input.redirectUri)
      u.searchParams.set('scope', 'openid profile email offline_access')
      u.searchParams.set('state', input.state)
      u.searchParams.set('code_challenge', input.challenge)
      u.searchParams.set('code_challenge_method', 'S256')
      u.searchParams.set('id_token_add_organizations', 'true')
      u.searchParams.set('codex_cli_simplified_flow', 'true')
      u.searchParams.set('originator', 'codex_cli_rs')
      return u.toString()
    },
    async exchange(input) {
      const form = new URLSearchParams()
      form.set('grant_type', 'authorization_code')
      form.set('code', input.code)
      form.set('client_id', CODEX_CLIENT_ID)
      form.set('redirect_uri', input.redirectUri)
      form.set('code_verifier', input.verifier)

      const tokenData = await executeBoundedRequest(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: form.toString(),
        signal: input.signal,
        fetchFn,
        httpTimeoutMs,
      })

      const accessToken = safeTokenString(tokenData.access_token)
      const idToken = safeTokenString(tokenData.id_token)
      const refreshToken = safeTokenString(tokenData.refresh_token)

      const claims = parseJwtPayload(idToken)
      const sub = safeMetadataString(claims.sub)
      if (!sub) {
        throw new AccountError('Codex ID 令牌缺少必需的账户标识。')
      }

      let chatgptAccountId: string | undefined
      if (typeof claims['https://api.openai.com/auth'] === 'object' && claims['https://api.openai.com/auth'] !== null) {
        chatgptAccountId = safeMetadataString((claims['https://api.openai.com/auth'] as any).chatgpt_account_id)
      }
      if (!chatgptAccountId) {
        chatgptAccountId = safeMetadataString(claims['https://api.openai.com/auth.chatgpt_account_id'])
      }
      if (!chatgptAccountId) {
        chatgptAccountId = safeMetadataString(claims.chatgpt_account_id)
      }

      if (!chatgptAccountId) {
        throw new AccountError('Codex ID 令牌缺少必需的 ChatGPT 账户标识。')
      }

      const currentNow = now()
      if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
        if (claims.exp * 1000 <= currentNow) {
          throw new AccountError('Codex 授权令牌已过期。')
        }
      }
      if (typeof tokenData.expires_in === 'number') {
        if (!Number.isFinite(tokenData.expires_in) || tokenData.expires_in <= 0 || tokenData.expires_in > 1e9) {
          throw new AccountError('Codex 令牌有效期无效。')
        }
      }

      const normalized = {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: accessToken,
          id_token: idToken,
          refresh_token: refreshToken,
          account_id: chatgptAccountId,
        },
        last_refresh: new Date(currentNow).toISOString(),
      }

      return JSON.stringify(normalized, null, 2)
    },
  }

  const claudeProvider: AccountOAuthProvider = {
    port: 0,
    redirectHost: 'localhost',
    callbackPath: '/callback',
    authorizationUrl(input) {
      const u = new URL(CLAUDE_AUTH_URL)
      u.searchParams.set('code', 'true')
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', CLAUDE_CLIENT_ID)
      u.searchParams.set('redirect_uri', input.redirectUri)
      u.searchParams.set('scope', 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload')
      u.searchParams.set('state', input.state)
      u.searchParams.set('code_challenge', input.challenge)
      u.searchParams.set('code_challenge_method', 'S256')
      return u.toString()
    },
    async exchange(input) {
      const payload = {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CLAUDE_CLIENT_ID,
        code_verifier: input.verifier,
        state: input.state,
      }

      const tokenData = await executeBoundedRequest(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: input.signal,
        fetchFn,
        httpTimeoutMs,
      })

      const accessToken = safeTokenString(tokenData.access_token)
      if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/.test(accessToken)) {
        throw new AccountError('Claude 订阅访问令牌格式无效。')
      }

      const refreshToken = safeTokenString(tokenData.refresh_token)

      if (
        typeof tokenData.expires_in !== 'number' ||
        !Number.isFinite(tokenData.expires_in) ||
        tokenData.expires_in <= 0 ||
        tokenData.expires_in > 1e9
      ) {
        throw new AccountError('Claude 令牌有效期无效。')
      }
      const expiresIn = tokenData.expires_in

      if (typeof tokenData.scope !== 'string') {
        throw new AccountError('Claude 令牌缺少有效的权限范围。')
      }
      const scopeStr = tokenData.scope
      if (!scopeStr.includes('user:profile') || !scopeStr.includes('user:inference')) {
        throw new AccountError('Claude 令牌缺少必需的账户或推理权限。')
      }

      const profileData = await executeBoundedRequest(CLAUDE_PROFILE_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
        signal: input.signal,
        fetchFn,
        httpTimeoutMs,
      })

      if (!profileData.account || typeof profileData.account !== 'object') {
        throw new AccountError('Claude 账户信息获取失败。')
      }
      if (!profileData.organization || typeof profileData.organization !== 'object') {
        throw new AccountError('Claude 组织信息获取失败。')
      }

      const accountUuid = safeMetadataString(profileData.account.uuid)
      const email = safeMetadataString(profileData.account.email)
      const orgUuid = safeMetadataString(profileData.organization.uuid)

      if (!accountUuid || !email || !orgUuid) {
        throw new AccountError('Claude 账户缺少必需的标识信息。')
      }

      if (tokenData.account && typeof tokenData.account === 'object') {
        const tokenAccountUuid = safeMetadataString((tokenData.account as any).uuid)
        if (tokenAccountUuid && tokenAccountUuid !== accountUuid) {
          throw new AccountError('Claude 令牌账户标识与个人资料不一致。')
        }
      }
      if (tokenData.organization && typeof tokenData.organization === 'object') {
        const tokenOrgUuid = safeMetadataString((tokenData.organization as any).uuid)
        if (tokenOrgUuid && tokenOrgUuid !== orgUuid) {
          throw new AccountError('Claude 令牌组织标识与个人资料不一致。')
        }
      }

      const currentNow = now()
      const expiresAt = currentNow + expiresIn * 1000
      const scopes = scopeStr.split(' ').filter(Boolean)
      const subscriptionType = safeMetadataString(profileData.organization.billing_type)
      const displayName = safeMetadataString(profileData.account.display_name)

      const normalized = {
        claudeAiOauth: {
          accessToken,
          refreshToken,
          expiresAt,
          scopes,
          ...(subscriptionType ? { subscriptionType } : {}),
        },
        oauthAccount: {
          accountUuid,
          emailAddress: email,
          organizationUuid: orgUuid,
          ...(displayName ? { displayName } : {}),
        },
        oauthClientId: CLAUDE_CLIENT_ID,
      }

      return JSON.stringify(normalized, null, 2)
    },
  }

  const antigravityProvider: AccountOAuthProvider = {
    port: 0,
    redirectHost: '127.0.0.1',
    callbackPath: '/oauth-callback',
    authorizationUrl(input) {
      const u = new URL(ANTIGRAVITY_AUTH_URL)
      u.searchParams.set('access_type', 'offline')
      u.searchParams.set('prompt', 'select_account consent')
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
      u.searchParams.set('redirect_uri', input.redirectUri)
      u.searchParams.set('scope', 'openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile')
      u.searchParams.set('state', input.state)
      u.searchParams.set('code_challenge', input.challenge)
      u.searchParams.set('code_challenge_method', 'S256')
      return u.toString()
    },
    async exchange(input) {
      const form = new URLSearchParams()
      form.set('grant_type', 'authorization_code')
      form.set('client_id', ANTIGRAVITY_CLIENT_ID)
      form.set('client_secret', ANTIGRAVITY_CLIENT_SECRET)
      form.set('code', input.code)
      form.set('redirect_uri', input.redirectUri)
      form.set('code_verifier', input.verifier)

      const tokenData = await executeBoundedRequest(ANTIGRAVITY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: form.toString(),
        signal: input.signal,
        fetchFn,
        httpTimeoutMs,
      })

      if (typeof tokenData.token_type !== 'string' || tokenData.token_type.toLowerCase() !== 'bearer') {
        throw new AccountError('Google OAuth 令牌类型无效。')
      }

      const accessToken = safeTokenString(tokenData.access_token)
      const refreshToken = safeTokenString(tokenData.refresh_token)

      if (
        typeof tokenData.expires_in !== 'number' ||
        !Number.isFinite(tokenData.expires_in) ||
        tokenData.expires_in <= 0 ||
        tokenData.expires_in > 1e9
      ) {
        throw new AccountError('Google 令牌有效期无效。')
      }
      const expiresIn = tokenData.expires_in

      if (tokenData.scope !== undefined) {
        if (typeof tokenData.scope !== 'string') {
          throw new AccountError('Google 令牌权限范围格式无效。')
        }
        const scopes = tokenData.scope.split(' ')
        const hasCloudPlatform = scopes.some((s: string) => s.includes('cloud-platform'))
        const hasIdentity = scopes.some((s: string) =>
          s.includes('userinfo.email') || s.includes('userinfo.profile') || s === 'openid' || s === 'email' || s === 'profile'
        )
        if (!hasCloudPlatform || !hasIdentity) {
          throw new AccountError('Google 令牌缺少必需的云平台或身份权限。')
        }
      }

      const profileData = await executeBoundedRequest(ANTIGRAVITY_PROFILE_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
        signal: input.signal,
        fetchFn,
        httpTimeoutMs,
      })

      const googleId = safeMetadataString(profileData.id)
      const email = safeMetadataString(profileData.email)

      if (!googleId || !email) {
        throw new AccountError('Google 用户身份信息无效或缺失。')
      }

      if (profileData.verified_email === false) {
        throw new AccountError('Google 账号邮箱未验证。')
      }

      const currentNow = now()
      const expiry = new Date(currentNow + expiresIn * 1000).toISOString()
      const name = safeMetadataString(profileData.name)

      const normalized = {
        auth_method: 'consumer',
        token: {
          access_token: accessToken,
          token_type: 'Bearer',
          refresh_token: refreshToken,
          expiry,
        },
        account: {
          id: googleId,
          email,
          ...(name ? { name } : {}),
        },
        oauth_client_id: ANTIGRAVITY_CLIENT_ID,
      }

      return JSON.stringify(normalized, null, 2)
    },
  }

  return {
    codex: codexProvider,
    'claude-code': claudeProvider,
    antigravity: antigravityProvider,
  }
}

/** Enrich only a discovered Antigravity credential; never refresh or modify the native login. */
export async function enrichAntigravityIdentity(raw: string, fetchFn?: typeof globalThis.fetch): Promise<string> {
  const inspected = inspectAntigravityCredential(raw)
  if (inspected.accountId) return inspected.credential
  const profile = await executeBoundedRequest(ANTIGRAVITY_PROFILE_URL, {
    method: 'GET', headers: { Authorization: `Bearer ${inspected.access}` },
    signal: new AbortController().signal, fetchFn,
  })
  const id = safeMetadataString(profile.id)
  const email = safeMetadataString(profile.email)
  const name = safeMetadataString(profile.name)
  if (!id || !email || profile.verified_email !== true) throw new AccountError('无法确认 Antigravity 当前账号身份，请重新登录。')
  const result = inspectAntigravityCredential(JSON.stringify({ ...inspected.normalized, account: { id, email, ...(name ? { name } : {}) } }))
  if (!result.accountId || !result.email) throw new AccountError('Antigravity 返回的账号身份无效。')
  return result.credential
}
