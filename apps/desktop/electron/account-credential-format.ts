import { createHash } from 'node:crypto'
import { AccountError } from '../../../packages/workflow-model/src/accounts.ts'

const LIMIT = 5 * 1024 * 1024
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => { throw new AccountError('账号 OAuth 凭据格式无效。') }

function parse(raw: string): Record<string, any> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMIT) return invalid()
  try { const result = JSON.parse(raw); if (object(result)) return result } catch { /* No parser excerpts. */ }
  return invalid()
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > LIMIT || /\s/.test(value)) return invalid()
  return value
}

function safeLabel(value: unknown, secrets: string[]): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 255 &&
    !/[\x00-\x1f\x7f]/.test(value) && !secrets.some(secret => value.includes(secret)) ? value.trim() : undefined
}

function expiry(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 8.64e15) return invalid()
  return value
}

export function inspectClaudeCredential(raw: string) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMIT) return invalid()
  const text = raw.trim()
  const data = text.startsWith('{') ? parse(text) : undefined
  const oauth = data?.claudeAiOauth
  if (data && !object(oauth)) return invalid()
  const access = token(data ? oauth.accessToken : text)
  if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/.test(access)) return invalid()
  const refresh = oauth?.refreshToken == null ? undefined : token(oauth.refreshToken)
  const secrets = [access, ...(refresh ? [refresh] : [])]
  const profile = object(data?.oauthAccount) ? data.oauthAccount : undefined
  const accountId = safeLabel(profile?.accountUuid, secrets)
  const organizationId = safeLabel(profile?.organizationUuid, secrets)
  const email = safeLabel(profile?.emailAddress, secrets)
  const displayName = safeLabel(profile?.displayName, secrets)
  const knownIdentity = accountId && organizationId ? `${accountId}:${organizationId}` : undefined
  const expiresAt = expiry(oauth?.expiresAt)
  let scopes: string[] | undefined
  if (oauth?.scopes !== undefined) {
    if (!Array.isArray(oauth.scopes) || oauth.scopes.length > 64 || oauth.scopes.some((scope: unknown) => typeof scope !== 'string' || !/^[a-zA-Z0-9:._/-]{1,128}$/.test(scope) || secrets.includes(scope))) return invalid()
    scopes = [...new Set<string>(oauth.scopes)]
  }
  const normalized = data ? {
    claudeAiOauth: {
      accessToken: access, ...(refresh ? { refreshToken: refresh } : {}),
      ...(expiresAt ? { expiresAt } : {}), ...(scopes ? { scopes } : {}),
      ...(safeLabel(oauth.subscriptionType, secrets) ? { subscriptionType: safeLabel(oauth.subscriptionType, secrets) } : {}),
      ...(safeLabel(oauth.rateLimitTier, secrets) ? { rateLimitTier: safeLabel(oauth.rateLimitTier, secrets) } : {}),
    },
    ...(knownIdentity ? { oauthAccount: { accountUuid: accountId, organizationUuid: organizationId, ...(email ? { emailAddress: email } : {}), ...(displayName ? { displayName } : {}) } } : {}),
    ...(safeLabel(data.oauthClientId ?? data.oauth_client_id ?? data.clientId, secrets) ? { oauthClientId: safeLabel(data.oauthClientId ?? data.oauth_client_id ?? data.clientId, secrets) } : {}),
  } : undefined
  return {
    credential: normalized ? JSON.stringify(normalized, null, 2) : access,
    identityKey: knownIdentity ? `claude-account:${knownIdentity}` : `claude:${digest(refresh ?? access)}`,
    email: knownIdentity ? email : undefined, accountId: knownIdentity ? accountId : undefined,
    expiresAt, access, refresh, knownIdentity, normalized,
    oauthClientId: safeLabel(data?.oauthClientId ?? data?.oauth_client_id ?? data?.clientId, secrets),
  }
}

export function matchClaudeCredentials(left: string, right: string): boolean {
  const a = inspectClaudeCredential(left), b = inspectClaudeCredential(right)
  if (a.knownIdentity && b.knownIdentity) return a.knownIdentity === b.knownIdentity
  return a.access === b.access || !!(a.refresh && b.refresh && a.refresh === b.refresh)
}

export function mergeClaudeCredentials(incoming: string, stored: string): string {
  const a = inspectClaudeCredential(incoming), b = inspectClaudeCredential(stored)
  if (!matchClaudeCredentials(incoming, stored)) return a.credential
  // A settings.json access-token projection cannot replace a complete OAuth record.
  if (!a.normalized && b.normalized && a.access === b.access) return b.credential
  if (a.normalized && b.normalized) {
    return inspectClaudeCredential(JSON.stringify({
      ...b.normalized, ...a.normalized,
      claudeAiOauth: { ...b.normalized.claudeAiOauth, ...a.normalized.claudeAiOauth },
      ...(a.normalized.oauthClientId || b.normalized.oauthClientId ? { oauthClientId: a.normalized.oauthClientId ?? b.normalized.oauthClientId } : {}),
    })).credential
  }
  return a.credential
}

export function inspectAntigravityCredential(raw: string) {
  const data = parse(raw)
  if (data.auth_method !== 'consumer' || !object(data.token)) return invalid()
  const access = token(data.token.access_token), refresh = token(data.token.refresh_token)
  if (data.token.token_type !== 'Bearer' || typeof data.token.expiry !== 'string') return invalid()
  const expiresAt = expiry(Date.parse(data.token.expiry))!
  const secrets = [access, refresh]
  const accountId = safeLabel(data.account?.id, secrets)
  const email = safeLabel(data.account?.email, secrets)
  const name = safeLabel(data.account?.name, secrets)
  const clientId = safeLabel(data.oauth_client_id, secrets)
  const normalized = {
    auth_method: 'consumer',
    token: { access_token: access, token_type: 'Bearer', refresh_token: refresh, expiry: new Date(expiresAt).toISOString() },
    ...(accountId ? { account: { id: accountId, ...(email ? { email } : {}), ...(name ? { name } : {}) } } : {}),
    ...(clientId ? { oauth_client_id: clientId } : {}),
  }
  return {
    credential: JSON.stringify(normalized, null, 2),
    identityKey: accountId ? `antigravity-account:${accountId}` : `antigravity:${digest(refresh)}`,
    accountId, email: accountId ? email : undefined, expiresAt,
    access, refresh, normalized,
  }
}

export function matchAntigravityCredentials(left: string, right: string): boolean {
  const a = inspectAntigravityCredential(left), b = inspectAntigravityCredential(right)
  if (a.accountId && b.accountId) return a.accountId === b.accountId
  return a.refresh === b.refresh
}

export function mergeAntigravityCredentials(incoming: string, stored: string): string {
  const a = inspectAntigravityCredential(incoming), b = inspectAntigravityCredential(stored)
  if (!matchAntigravityCredentials(incoming, stored)) return a.credential
  return inspectAntigravityCredential(JSON.stringify({
    ...a.normalized,
    ...(!a.accountId && b.normalized.account ? { account: b.normalized.account } : {}),
    ...(!a.normalized.oauth_client_id && a.refresh === b.refresh && b.normalized.oauth_client_id ? { oauth_client_id: b.normalized.oauth_client_id } : {}),
  })).credential
}
