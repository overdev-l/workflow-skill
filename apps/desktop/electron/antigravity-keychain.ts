import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccountError } from '../../../packages/workflow-model/src/accounts.ts'

export const MAX_KEYCHAIN_PAYLOAD_SIZE = 8 * 1024 * 1024 // 8 MiB
export const KEYCHAIN_TIMEOUT_MS = 10_000 // 10s
export const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'

export interface KeychainRunnerParams {
  helperPath: string
  args: string[]
  input: string
  timeout: number
  maxBuffer: number
}

export interface KeychainRunnerResult {
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  status?: number | null
  error?: Error | null
}

export type KeychainRunner = (
  params: KeychainRunnerParams
) => KeychainRunnerResult | string | Record<string, unknown>

export type AntigravityNativeTarget = 'cli' | 'desktop'

export interface AntigravityKeychainOptions {
  helperPath?: string
  runner?: KeychainRunner
  interactive?: boolean
  target?: AntigravityNativeTarget
}

export interface AntigravityKeychainReadOptions {
  interactive?: boolean
  target?: AntigravityNativeTarget
}

export interface AntigravityKeychainWriteOptions {
  interactive?: boolean
  target?: AntigravityNativeTarget
}

export interface AntigravityKeychain {
  read(options?: AntigravityKeychainReadOptions | boolean): string | null
  write(value: string | null, options?: AntigravityKeychainWriteOptions | boolean): void
  available(): boolean
}

/**
 * Validates that target path points to a regular, non-symlink executable file.
 */
function isValidExecutable(filePath: string): boolean {
  try {
    const lstat = lstatSync(filePath)
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return false
    }
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      return false
    }
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the trusted location of the native helper binary:
 * 1. Packaged Electron runtime: trusted process.resourcesPath
 * 2. Unpacked asar: process.resourcesPath/app.asar.unpacked/apps/desktop/native-bin
 * 3. Relative to current file directory (__dirname or import.meta.url) in dev and dist-electron
 *
 * Strictly avoids process.cwd() fallbacks to prevent untrusted workspaces from executing planted binaries.
 * Validates regular executable file; strictly rejects symlinks.
 */
export function resolveHelperPath(customPath?: string): string | null {
  if (customPath) {
    return isValidExecutable(customPath) ? customPath : null
  }

  const binaryName = 'trace-account-keychain'

  // 1. Packaged Electron runtime (trusted resourcesPath)
  if (typeof process !== 'undefined' && (process as any).resourcesPath) {
    const resPath = (process as any).resourcesPath as string
    const candidate1 = path.join(resPath, 'native-bin', binaryName)
    if (isValidExecutable(candidate1)) return candidate1
    const candidate2 = path.join(resPath, 'app.asar.unpacked', 'apps', 'desktop', 'native-bin', binaryName)
    if (isValidExecutable(candidate2)) return candidate2
  }

  // 2. Relative to current module directory (dev & dist-electron)
  let currentDir: string | null = null
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    currentDir = __dirname
  } else {
    try {
      if (typeof import.meta !== 'undefined' && import.meta.url) {
        currentDir = path.dirname(fileURLToPath(import.meta.url))
      }
    } catch {
      // Ignored
    }
  }

  if (currentDir) {
    const candidateDev = path.resolve(currentDir, '..', 'native-bin', binaryName)
    if (isValidExecutable(candidateDev)) return candidateDev

    const candidateSame = path.resolve(currentDir, 'native-bin', binaryName)
    if (isValidExecutable(candidateSame)) return candidateSame
  }

  // Strictly no process.cwd() lookup
  return null
}

function handleParsedResponse(parsed: Record<string, unknown>): Record<string, unknown> {
  if (parsed.ok === false) {
    const code = parsed.error
    if (code === 'locked') {
      throw new AccountError('Antigravity Keychain 已锁定，无法访问凭据。')
    }
    if (code === 'denied') {
      throw new AccountError('Antigravity Keychain 访问被拒绝。')
    }
    if (code === 'unavailable') {
      throw new AccountError('Antigravity Keychain 服务不可用。')
    }
    if (code === 'malformed') {
      throw new AccountError('Antigravity Keychain 请求或凭据格式无效。')
    }
    throw new AccountError('Antigravity Keychain 操作失败。')
  }

  if (parsed.ok !== true) {
    throw new AccountError('Antigravity Keychain 返回数据格式无效。')
  }

  return parsed
}

function executeRequest(
  helperPath: string,
  requestPayload: Record<string, unknown>,
  runner?: KeychainRunner
): Record<string, unknown> {
  const timeout = requestPayload.interactive === true ? 60_000 : KEYCHAIN_TIMEOUT_MS
  const inputStr = JSON.stringify(requestPayload)
  if (Buffer.byteLength(inputStr) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
    throw new AccountError('Antigravity Keychain 请求或凭据格式无效。')
  }

  let result: unknown

  if (runner) {
    try {
      result = runner({
        helperPath,
        args: [],
        input: inputStr,
        timeout,
        maxBuffer: MAX_KEYCHAIN_PAYLOAD_SIZE,
      })
    } catch {
      throw new AccountError('Antigravity Keychain 操作失败。')
    }
  } else {
    try {
      result = spawnSync(helperPath, [], {
        input: inputStr,
        timeout,
        maxBuffer: MAX_KEYCHAIN_PAYLOAD_SIZE,
        encoding: 'utf8',
      })
    } catch {
      throw new AccountError('Antigravity Keychain 操作失败。')
    }
  }

  // Normalize runner / spawn response to standard KeychainRunnerResult
  let runResult: KeychainRunnerResult
  if (typeof result === 'string') {
    runResult = { stdout: result, status: 0 }
  } else if (result && typeof result === 'object' && 'ok' in result) {
    runResult = { stdout: JSON.stringify(result), status: 0 }
  } else if (
    result &&
    typeof result === 'object' &&
    ('stdout' in result || 'error' in result || 'status' in result)
  ) {
    runResult = result as KeychainRunnerResult
  } else if (result && typeof result === 'object') {
    // Direct object from runner: serialize to stdout with status 0
    runResult = { stdout: JSON.stringify(result), status: 0 }
  } else {
    throw new AccountError('Antigravity Keychain 辅助程序异常退出。')
  }

  if (runResult.error) {
    const err = runResult.error as any
    if (err.code === 'ETIMEDOUT' || (typeof err.message === 'string' && err.message.includes('TIMEDOUT'))) {
      throw new AccountError('Antigravity Keychain 访问超时。')
    }
    if (err.code === 'ENOBUFS' || (typeof err.message === 'string' && err.message.includes('maxBuffer'))) {
      throw new AccountError('Antigravity Keychain 返回数据超过大小限制。')
    }
    throw new AccountError('Antigravity Keychain 操作失败。')
  }

  // MUST reject non-zero exit even if stdout claimed ok:true
  if (runResult.status !== 0) {
    throw new AccountError('Antigravity Keychain 辅助程序异常退出。')
  }

  const stdout = runResult.stdout
  if (stdout === null || stdout === undefined || stdout === '') {
    throw new AccountError('Antigravity Keychain 返回数据格式无效。')
  }

  const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf8')
  if (Buffer.byteLength(stdoutStr) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
    throw new AccountError('Antigravity Keychain 返回数据超过大小限制。')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdoutStr.trim())
  } catch {
    throw new AccountError('Antigravity Keychain 返回数据格式无效。')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AccountError('Antigravity Keychain 返回数据格式无效。')
  }

  return handleParsedResponse(parsed as Record<string, unknown>)
}

export function createAntigravityKeychain(options?: AntigravityKeychainOptions): AntigravityKeychain {
  const keychain: AntigravityKeychain = {
    available(): boolean {
      if (options?.runner) {
        return true
      }
      if (process.platform !== 'darwin') {
        return false
      }
      const helperPath = resolveHelperPath(options?.helperPath)
      return helperPath !== null
    },

    read(optionsOrInteractive?: AntigravityKeychainReadOptions | boolean): string | null {
      if (!keychain.available()) {
        throw new AccountError('Antigravity Keychain 辅助程序不可用。')
      }

      const helperPath = resolveHelperPath(options?.helperPath) ?? options?.helperPath ?? ''

      const interactive = typeof optionsOrInteractive === 'boolean'
        ? optionsOrInteractive
        : typeof optionsOrInteractive === 'object' && optionsOrInteractive !== null && typeof optionsOrInteractive.interactive === 'boolean'
          ? optionsOrInteractive.interactive
          : (options?.interactive ?? false)

      const target = typeof optionsOrInteractive === 'object' && optionsOrInteractive !== null && optionsOrInteractive.target
        ? optionsOrInteractive.target
        : (options?.target ?? 'cli')

      const response = executeRequest(
        helperPath,
        { action: 'read', interactive, target },
        options?.runner
      )

      // Missing 'data' property is strictly malformed (null explicitly means missing)
      if (!('data' in response)) {
        throw new AccountError('Antigravity Keychain 返回数据格式无效。')
      }

      if (response.data === null) {
        return null
      }

      if (typeof response.data !== 'string') {
        throw new AccountError('Antigravity Keychain 返回数据格式无效。')
      }

      // Ensure success data is bounded
      if (Buffer.byteLength(response.data) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
        throw new AccountError('Antigravity Keychain 返回数据超过大小限制。')
      }

      return response.data
    },

    write(value: string | null, optionsOrInteractive?: AntigravityKeychainWriteOptions | boolean): void {
      if (!keychain.available()) {
        throw new AccountError('Antigravity Keychain 辅助程序不可用。')
      }

      const helperPath = resolveHelperPath(options?.helperPath) ?? options?.helperPath ?? ''

      const interactive = typeof optionsOrInteractive === 'boolean'
        ? optionsOrInteractive
        : typeof optionsOrInteractive === 'object' && optionsOrInteractive !== null && typeof optionsOrInteractive.interactive === 'boolean'
          ? optionsOrInteractive.interactive
          : (options?.interactive ?? false)

      const target = typeof optionsOrInteractive === 'object' && optionsOrInteractive !== null && optionsOrInteractive.target
        ? optionsOrInteractive.target
        : (options?.target ?? 'cli')

      if (value === null) {
        executeRequest(
          helperPath,
          { action: 'delete', interactive, target },
          options?.runner
        )
        return
      }

      if (typeof value !== 'string') {
        throw new AccountError('Antigravity Keychain 请求或凭据格式无效。')
      }

      if (Buffer.byteLength(value) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
        throw new AccountError('Antigravity 凭据超过大小限制。')
      }

      executeRequest(
        helperPath,
        { action: 'write', secret: value, interactive, target },
        options?.runner
      )
    },
  }

  return keychain
}

const CANONICAL_BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decodes a raw Base64 string into UTF-8 plaintext with strict RFC 4648 canonical validation.
 */
export function decodeAntigravitySecret(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AccountError('Antigravity 凭据格式无效。')
  }
  if (Buffer.byteLength(raw) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
    throw new AccountError('Antigravity 凭据超过大小限制。')
  }
  if (/\s/.test(raw)) {
    throw new AccountError('Antigravity 凭据格式无效：包含非法空白字符。')
  }
  if (raw.length % 4 !== 0) {
    throw new AccountError('Antigravity 凭据格式无效：Base64 长度不符合规范。')
  }
  if (!CANONICAL_BASE64_REGEX.test(raw)) {
    throw new AccountError('Antigravity 凭据格式无效：包含非 Base64 字符。')
  }

  const buf = Buffer.from(raw, 'base64')
  if (buf.toString('base64') !== raw) {
    throw new AccountError('Antigravity 凭据格式无效：非规范 Base64 编码。')
  }

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return decoder.decode(buf)
  } catch {
    throw new AccountError('Antigravity 凭据格式无效：非有效 UTF-8 编码。')
  }
}

/**
 * Encodes a plaintext UTF-8 credential into canonical Base64.
 */
export function encodeAntigravitySecret(plain: string): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new AccountError('Antigravity 凭据不能为空。')
  }
  if (Buffer.byteLength(plain) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
    throw new AccountError('Antigravity 凭据超过大小限制。')
  }
  return Buffer.from(plain, 'utf8').toString('base64')
}

export const decodeGoKeyringBase64 = decodeAntigravitySecret
export const encodeGoKeyringBase64 = encodeAntigravitySecret

/**
 * Encodes a plaintext JSON credential into the full go-keyring Keychain secret format:
 * "go-keyring-base64:" + canonical Base64 string.
 */
export function encodeAntigravityKeychainSecret(plain: string): string {
  const base64 = encodeAntigravitySecret(plain)
  return `${GO_KEYRING_BASE64_PREFIX}${base64}`
}

/**
 * Decodes the raw Keychain secret string used by native Antigravity CLI:
 * 1. "go-keyring-base64:" + canonical Base64 string -> decoded UTF-8 JSON.
 * 2. Legacy plain JSON raw string -> validated through strict UTF-8 roundtrip and returned.
 * 3. All other formats (including bare Base64 without prefix) are strictly rejected.
 */
export function decodeAntigravityKeychainSecret(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AccountError('Antigravity 凭据格式无效。')
  }
  if (Buffer.byteLength(raw) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
    throw new AccountError('Antigravity 凭据超过大小限制。')
  }

  // 1. Wrapped secret with exact go-keyring-base64: prefix
  if (raw.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    const base64Part = raw.slice(GO_KEYRING_BASE64_PREFIX.length)
    return decodeAntigravitySecret(base64Part)
  }

  // 2. Legacy plain JSON: strictly validate UTF-8 roundtrip and JSON object structure
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    const buf = Buffer.from(raw, 'utf8')
    let text: string
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      text = decoder.decode(buf)
    } catch {
      throw new AccountError('Antigravity 凭据格式无效：非有效 UTF-8 编码。')
    }

    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AccountError('Antigravity 凭据格式无效。')
      }
    } catch (err) {
      if (err instanceof AccountError) throw err
      throw new AccountError('Antigravity 凭据格式无效。')
    }

    return text
  }

  // 3. Reject bare Base64 or any unrecognized format without exact prefix
  throw new AccountError('Antigravity Keychain 凭据格式无效：缺少 go-keyring-base64: 前缀。')
}
