import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { createAntigravityKeychain, decodeAntigravityKeychainSecret, encodeAntigravityKeychainSecret, type AntigravityKeychain } from './antigravity-keychain.ts'
import { assertAntigravityStopped, assertAntigravityStoppedStrict, withAntigravityAccountSwitch, type AntigravitySwitchContext } from './antigravity-runtime.ts'
import { enrichAntigravityIdentity } from './account-oauth-providers.ts'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parseTOML } from 'toml-eslint-parser'
import { AccountError, type AccountTool, type AccountToolCapability, type AccountActionResult } from '../../../packages/workflow-model/src/accounts.ts'
import { inspectClaudeCredential, inspectAntigravityCredential, matchClaudeCredentials, mergeClaudeCredentials, matchAntigravityCredentials, mergeAntigravityCredentials } from './account-credential-format.ts'

export type AccountProjection = Record<string, string | null>
export interface InspectedCredential {
  credential: string
  email?: string
  accountId?: string
  expiresAt?: number
  identityKey: string
}

export interface AccountFileManager {
  read(file: string): string | null
  write(file: string, content: string | null): void
}

export function resolveAntigravityDesktopStoragePath(homeDir?: string): string {
  const base = homeDir || os.homedir()
  return path.join(base, 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
}

export function readAntigravityDesktopIdentity(
  storagePath?: string,
  files?: AccountFileManager
): string | null {
  const targetPath = storagePath || resolveAntigravityDesktopStoragePath()
  try {
    const content = files ? files.read(targetPath) : (existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null)
    if (!content) return null
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && typeof parsed['jetski.onboarding.lastLoginUsername'] === 'string') {
      const username = parsed['jetski.onboarding.lastLoginUsername'].trim()
      return username.length > 0 ? username : null
    }
    return null
  } catch {
    return null
  }
}

export interface AccountAdapter {
  tool: AccountTool
  journalKey?: 'antigravity-native'
  assertCanWrite?(): void
  assertCanRefresh?(): void
  withInteractiveSwitch?(
    operation: () => Promise<AccountActionResult>,
    context?: AntigravitySwitchContext
  ): Promise<AccountActionResult>
  getClientIdentity?(): Promise<string | null> | string | null
  authorizeAccess?(): void
  enrichCredential?(credential: string): Promise<string>
  capability(): AccountToolCapability
  inspect(credential: string): InspectedCredential
  read(): AccountProjection
  desired(credential: string): AccountProjection
  writeSlot(slot: string, value: string | null): void
  credentialFrom(state: AccountProjection): string | null
  /** Read-only discovery, independently of the ability to switch the native tool. */
  readCurrentCredential?(): string | null
  matchesIdentity?(left: string, right: string): boolean
  mergeCredential?(incoming: string, stored: string): string
}
export interface AccountAdapterOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  codexHome?: string
  /** Inject only in isolated tests after establishing a compatible file-mode environment. */
  antigravityFileMode?: boolean
  antigravityKeychain?: AntigravityKeychain
  antigravityAssertStopped?: () => void
  antigravityWithInteractiveSwitch?: AccountAdapter['withInteractiveSwitch']
  antigravityIdentityFetch?: typeof globalThis.fetch
  antigravityDesktopStoragePath?: string
  antigravityClientIdentity?: string | null
  antigravityProbeIdentity?: (bundlePath?: string) => Promise<string | null> | string | null
  antigravityWaitForReadiness?: (bundlePath?: string) => Promise<boolean> | boolean
  antigravityCheckDesktopStore?: (bundlePath?: string) => Promise<boolean> | boolean
}

const LIMIT = 5 * 1024 * 1024
const fail = (message: string): never => { throw new AccountError(message) }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function json(raw: string): Record<string, any> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMIT) fail('凭据或配置文件过大。')
  try { const parsed: unknown = JSON.parse(raw); if (object(parsed)) return parsed } catch { /* Never expose parser excerpts. */ }
  return fail('凭据或配置文件不是有效的 JSON 对象。')
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !value || /\s/.test(value) || value.length > LIMIT) fail('账号凭据缺少有效令牌。')
  return value as string
}
function claims(value: unknown): Record<string, any> {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return object(parsed) ? parsed : {}
  } catch { return {} }
}
function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined
}

/** Auth files are bounded, regular, private files; no links below the selected home. */
class AuthFiles {
  private home: string
  constructor(home: string) { this.home = home }
  guard(file: string): void {
    const relative = path.relative(this.home, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('认证路径必须位于当前用户目录内。')
    let current = this.home
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part)
      let stat
      try { stat = lstatSync(current) } catch (error: any) { if (error?.code === 'ENOENT') continue; throw error }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('认证路径包含链接或非普通文件，未作修改。')
      if (current !== file && !stat.isDirectory()) fail('认证目录无效。')
    }
  }
  read(file: string): string | null {
    this.guard(file)
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.size > LIMIT) fail('认证配置不是普通文件或超过大小限制。')
      return readFileSync(file, 'utf8')
    } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error }
  }
  write(file: string, content: string | null): void {
    this.guard(file)
    if (content === null) { rmSync(file, { force: true }); return }
    if (Buffer.byteLength(content) > LIMIT) fail('认证配置超过大小限制。')
    const dir = path.dirname(file)
    // Make each newly created directory private, without chmod of the user home.
    let current = this.home
    for (const part of path.relative(this.home, dir).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      try { mkdirSync(current, { mode: 0o700 }) } catch (error: any) { if (error?.code !== 'EEXIST') throw error }
    }
    if (dir !== this.home) chmodSync(dir, 0o700)
    const temp = path.join(dir, `.trace-account-${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
      this.guard(file)
      renameSync(temp, file)
    } finally { rmSync(temp, { force: true }) }
  }
}

const STORE_KEY = 'cli_auth_credentials_store'
function codexMode(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const value = parseToml(raw)[STORE_KEY]
    if (value === undefined) return null
    if (typeof value === 'string' && ['file', 'keyring', 'auto', 'ephemeral'].includes(value)) return value
  } catch { return fail('Codex config.toml 无法解析，未作修改。') }
  return fail('Codex 的凭据存储模式无效。')
}
/** Edit only the top-level auth value range; preserve comments, tables and model/MCP bytes. */
function patchCodexMode(raw: string | null, mode: string | null): string | null {
  if (mode !== null && !['file', 'keyring', 'auto', 'ephemeral'].includes(mode)) fail('不支持的 Codex 凭据存储模式。')
  const source = raw ?? ''
  codexMode(raw)
  let ast: ReturnType<typeof parseTOML>
  try { ast = parseTOML(source) } catch { return fail('Codex config.toml 无法解析，未作修改。') }
  const node = ast.body[0].body.find(n => n.type === 'TOMLKeyValue' && n.key.keys.length === 1 && ('name' in n.key.keys[0] ? n.key.keys[0].name : n.key.keys[0].value) === STORE_KEY)
  if (!node || node.type !== 'TOMLKeyValue') return mode === null ? raw : `${STORE_KEY} = ${JSON.stringify(mode)}\n${source}`
  if (mode !== null) return source.slice(0, node.value.range[0]) + JSON.stringify(mode) + source.slice(node.value.range[1])
  // Remove the complete assignment line only when its remainder is whitespace; retain comments.
  let end = node.range[1]
  if (/^[ \t]*\r?\n/.test(source.slice(end))) end += source.slice(end).match(/^[ \t]*\r?\n/)![0].length
  const result = source.slice(0, node.range[0]) + source.slice(end)
  return result.trim() ? result : null
}

export function createAccountAdapters(options: AccountAdapterOptions = {}): Record<AccountTool, AccountAdapter> {
  const home = path.resolve(options.homeDir ?? os.homedir())
  const env = options.env ?? process.env
  const files = new AuthFiles(home)
  const codexHome = path.resolve(options.codexHome ?? env.CODEX_HOME ?? path.join(home, '.codex'))
  const codexAuth = path.join(codexHome, 'auth.json')
  const codexConfig = path.join(codexHome, 'config.toml')
  const claudeSettings = path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude'), 'settings.json')
  const agyAuth = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const codexSettings = () => {
    try { return parseToml(files.read(codexConfig) ?? '') }
    catch (error) { if (error instanceof AccountError) throw error; return fail('Codex config.toml 无法解析，未作修改。') }
  }

  const codex: AccountAdapter = {
    tool: 'codex',
    capability: () => {
      const config = codexSettings()
      const conflict = config.forced_login_method === 'api' || (config.model_provider !== undefined && config.model_provider !== 'openai')
      return { tool: 'codex', available: !conflict, reasonCode: conflict ? 'codex-auth-conflict' : undefined, detailsCode: 'codex-file', reason: conflict ? 'Codex 当前限定 API 登录或使用其他模型提供商。请先在 Codex 中处理认证冲突；Trace 不修改模型配置。' : undefined, details: '使用 ChatGPT auth.json 和 file 存储模式。请重启 Codex，在新会话确认身份；项目配置或启动参数可能覆盖全局设置。' }
    },
    inspect(raw) {
      const value = json(raw)
      if ((value.auth_mode !== undefined && value.auth_mode !== 'chatgpt') || value.OPENAI_API_KEY || !object(value.tokens)) fail('仅支持 Codex ChatGPT 账号 auth.json，不支持 API Key。')
      const t = value.tokens
      const idToken = token(t.id_token)
      const c = claims(idToken)
      const accountId = label(t.account_id) ?? label(c['https://api.openai.com/auth']?.chatgpt_account_id)
      if (!accountId || !label(c.sub)) fail('Codex 凭据缺少可识别的 ChatGPT 账号信息。')
      const access = token(t.access_token)
      const clientId = value.client_id ?? value.oauth_client_id ?? value.oauthClientId ?? value.clientId
      if (clientId !== undefined && (typeof clientId !== 'string' || !clientId.trim())) fail('无效的 OAuth 客户端来源。')
      const normalized = { ...(clientId !== undefined ? { client_id: clientId } : {}), auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: access, refresh_token: token(t.refresh_token), account_id: accountId }, ...(typeof value.last_refresh === 'string' ? { last_refresh: value.last_refresh } : {}) }
      const expires = claims(access).exp
      return { credential: JSON.stringify(normalized, null, 2), email: label(c.email), accountId, identityKey: `codex:${accountId}:${c.sub}`, expiresAt: typeof expires === 'number' && Number.isFinite(expires) ? expires * 1000 : undefined }
    },
    read: () => ({ auth: files.read(codexAuth), mode: codexMode(files.read(codexConfig)) }),
    desired: credential => {
      const inspected = codex.inspect(credential)
      const forced = codexSettings().forced_chatgpt_workspace_id
      if (forced !== undefined && forced !== inspected.accountId) fail('目标账号不符合 Codex 已限定的 ChatGPT 工作区。')
      return { auth: inspected.credential, mode: 'file' }
    },
    writeSlot(slot, value) {
      if (slot === 'auth') files.write(codexAuth, value)
      else if (slot === 'mode') files.write(codexConfig, patchCodexMode(files.read(codexConfig), value))
      else fail('未知的 Codex 认证字段。')
    },
    credentialFrom: state => state.mode === 'file' || state.mode === null ? state.auth : null,
    readCurrentCredential() {
      if (!codex.capability().available) fail('Codex 当前存在认证优先级冲突，无法自动确认文件登录。请通过 OAuth 添加账号。')
      const current = codex.read()
      if (current.mode !== null && current.mode !== 'file') fail('Codex 当前未使用明确的文件登录模式，无法自动确认本地登录。请通过 OAuth 添加账号。')
      const forced = codexSettings().forced_chatgpt_workspace_id
      if (current.auth && forced !== undefined && forced !== codex.inspect(current.auth).accountId) fail('Codex 本地凭据与限定工作区不一致，无法自动确认文件登录。')
      return current.auth
    },
  }

  const claudeConflict = (): boolean => {
    const settings = json(files.read(claudeSettings) ?? '{}')
    if (settings.env !== undefined && !object(settings.env)) fail('Claude settings.json 的 env 格式无效。')
    const vars = { ...(settings.env ?? {}), ...env }
    return !!settings.apiKeyHelper || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(k => k === 'CLAUDE_CODE_OAUTH_TOKEN' ? !!env[k] : !!vars[k] && vars[k] !== '0')
  }
  const claude: AccountAdapter = {
    tool: 'claude-code',
    capability() {
      const conflict = claudeConflict()
      return { tool: 'claude-code', available: !conflict, reasonCode: conflict ? 'claude-auth-conflict' : undefined, detailsCode: 'claude-setup-token', reason: conflict ? '检测到环境令牌、API Key、认证辅助程序或其他提供商配置；请先在 Claude 中处理认证优先级冲突。' : undefined, details: '通过 OAuth 登录或导入订阅凭据保存账号；切换时将访问令牌写入 settings.json 的 CLAUDE_CODE_OAUTH_TOKEN。支持模型请求和本地 MCP；不支持 Remote Control 与 Claude.ai 连接器。新会话仍需验证身份；单独的 setup-token 无法离线确认邮箱或有效期。' }
    },
    inspect: inspectClaudeCredential,
    matchesIdentity: matchClaudeCredentials,
    mergeCredential: mergeClaudeCredentials,
    read() {
      const settings = json(files.read(claudeSettings) ?? '{}')
      if (settings.env !== undefined && !object(settings.env)) fail('Claude settings.json 的 env 格式无效。')
      const value = settings.env?.CLAUDE_CODE_OAUTH_TOKEN
      if (value !== undefined && typeof value !== 'string') fail('Claude 订阅令牌配置无效。')
      return { oauth: value ?? null }
    },
    desired: credential => ({ oauth: inspectClaudeCredential(credential).access }),
    writeSlot(slot, value) {
      if (slot !== 'oauth') fail('未知的 Claude 认证字段。')
      const settings = json(files.read(claudeSettings) ?? '{}')
      if (settings.env !== undefined && !object(settings.env)) fail('Claude settings.json 的 env 格式无效。')
      if (value === null) {
        if (settings.env) { delete settings.env.CLAUDE_CODE_OAUTH_TOKEN; if (!Object.keys(settings.env).length) delete settings.env }
      } else { settings.env = { ...(settings.env ?? {}), CLAUDE_CODE_OAUTH_TOKEN: value } }
      files.write(claudeSettings, Object.keys(settings).length ? `${JSON.stringify(settings, null, 2)}\n` : null)
    },
    credentialFrom: state => state.oauth,
    readCurrentCredential() {
      if (claudeConflict()) fail('Claude 当前存在认证优先级冲突，无法自动确认文件登录。请通过 OAuth 添加账号。')
      const configured = claude.read().oauth
      const configDir = path.dirname(claudeSettings)
      if (configured) inspectClaudeCredential(configured)
      try {
        const rawFile = files.read(path.join(configDir, '.credentials.json'))
        if (!rawFile) return configured
        const inspected = inspectClaudeCredential(rawFile)
        // Only enrich a configured access token using the exact same token.
        if (configured && configured !== inspected.access) return configured
        return inspected.credential
      } catch (error) {
        if (configured) return configured
        throw error
      }
    },
  }

  // Alternate homes are isolated file environments; never read the host Keychain for a fixture.
  const nativeHome = home === path.resolve(os.homedir())
  const fileMode = options.antigravityFileMode ?? !!(env.SSH_TTY || env.SSH_CLIENT || env.SSH_CONNECTION)
  const native = !fileMode && (options.antigravityKeychain !== undefined || (nativeHome && process.platform === 'darwin'))
  const keychain = options.antigravityKeychain ?? (native ? createAntigravityKeychain({ target: 'desktop' }) : undefined)
  const conflict = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.JETSKI_APP_DATA_DIR)
  const assertStopped = options.antigravityAssertStopped ?? assertAntigravityStopped
  const desktopStoragePath = options.antigravityDesktopStoragePath ?? resolveAntigravityDesktopStoragePath(home)
  const interactiveSwitch = options.antigravityWithInteractiveSwitch ??
    (nativeHome && !options.antigravityKeychain && !options.antigravityAssertStopped
      ? (operation: () => Promise<AccountActionResult>, context?: AntigravitySwitchContext) => {
          return withAntigravityAccountSwitch(
            operation,
            {
              checkDesktopStore: options.antigravityCheckDesktopStore ?? (() => {
                return existsSync(desktopStoragePath) || existsSync(path.dirname(desktopStoragePath))
              }),
              probeClientIdentity: options.antigravityProbeIdentity ?? (() => {
                return readAntigravityDesktopIdentity(desktopStoragePath, files)
              }),
              waitForReadiness: options.antigravityWaitForReadiness,
              expectedIdentity: context?.expectedIdentity,
              rollback: context?.rollback,
            },
            context
          )
        }
      : undefined)
  const available = () => !conflict && (native ? !!keychain?.available() : fileMode)
  const identityCache = new Map<string, string>()
  const antigravity: AccountAdapter = {
    tool: 'antigravity',
    ...(native ? { journalKey: 'antigravity-native' as const, authorizeAccess() { keychain!.read({ target: 'desktop', interactive: true }) } } : {}),
    capability: () => ({
      tool: 'antigravity', available: available(),
      reasonCode: conflict ? 'antigravity-auth-conflict' : available() ? undefined : native ? 'antigravity-helper-unavailable' : 'antigravity-file-mode-required',
      detailsCode: native ? 'antigravity-native-keychain' : 'antigravity-ssh-file',
      reason: conflict ? 'Antigravity 存在其他认证来源，无法确认原生账号。' : available() ? undefined : native ? 'Antigravity 原生认证助手未安装，请重新构建应用。' : '当前环境不支持 Antigravity 原生账号切换。',
      details: native ? 'Antigravity CLI 与客户端共享 macOS Keychain 原生认证项（service=gemini, account=antigravity）。切换时会正常退出并重新打开正在运行的客户端；仅当客户端会话经探测确认一致后才激活账号。现有 CLI 会话保留，新 CLI 会话使用所选账号。仅访问 Antigravity 认证项，账号库保存在本地文件。' : '仅支持真实 SSH 环境中的 Antigravity CLI 后备文件；不影响原生客户端。',
    }),
    ...(native || options.antigravityClientIdentity !== undefined ? {
      getClientIdentity() {
        if (options.antigravityClientIdentity !== undefined) {
          return options.antigravityClientIdentity
        }
        return readAntigravityDesktopIdentity(desktopStoragePath, files)
      },
    } : {}),
    assertCanWrite() {
      if (!available()) fail('Antigravity 当前认证环境不可切换。')
      if (native) assertStopped()
    },
    ...(native && interactiveSwitch ? { withInteractiveSwitch: interactiveSwitch } : {}),
    assertCanRefresh() {
      if (!available()) fail('Antigravity 当前认证环境不可续期。')
      if (native) (options.antigravityAssertStopped ?? assertAntigravityStoppedStrict)()
    },
    inspect: inspectAntigravityCredential,
    matchesIdentity: matchAntigravityCredentials,
    mergeCredential: mergeAntigravityCredentials,
    read: () => ({ oauth: native ? keychain!.read({ target: 'desktop' }) : files.read(agyAuth) }),
    desired: credential => {
      const { normalized } = inspectAntigravityCredential(credential)
      const payload = JSON.stringify({ auth_method: normalized.auth_method, token: normalized.token }, null, 2)
      return { oauth: native ? encodeAntigravityKeychainSecret(payload) : payload }
    },
    writeSlot(slot, value) {
      if (slot !== 'oauth') fail('未知的 Antigravity 认证字段。')
      antigravity.assertCanWrite!()
      if (native) keychain!.write(value, { target: 'desktop' })
      else files.write(agyAuth, value)
    },
    credentialFrom: state => native ? (state.oauth === null ? null : decodeAntigravityKeychainSecret(state.oauth)) : fileMode ? state.oauth : null,
    readCurrentCredential() {
      if (conflict) fail('Antigravity 当前使用其他认证来源，无法自动确认原生登录。')
      if (!native) return files.read(agyAuth)
      if (!available()) fail('Antigravity 原生认证不可用；请检查认证助手或使用 OAuth 添加账号。')
      return antigravity.credentialFrom(antigravity.read())
    },
    ...(native ? { async enrichCredential(raw: string) {
      const inspected = inspectAntigravityCredential(raw)
      if (inspected.accountId) return inspected.credential
      const fingerprint = hash(inspected.credential)
      const cached = identityCache.get(fingerprint)
      if (cached) return cached
      const enriched = await enrichAntigravityIdentity(raw, options.antigravityIdentityFetch)
      identityCache.clear()
      identityCache.set(fingerprint, enriched)
      return enriched
    } } : {}),
  }
  return { antigravity, codex, 'claude-code': claude }
}
