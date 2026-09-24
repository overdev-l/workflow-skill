import { spawnSync } from 'node:child_process'
import type { McpSecretRef } from '@workflow-skill/workflow-model'
import {
  isValidExecutable,
  KEYCHAIN_TIMEOUT_MS,
  MAX_KEYCHAIN_PAYLOAD_SIZE,
} from './antigravity-keychain.ts'

export const MCP_KEYCHAIN_SERVICE = 'trace-mcp'
const MACOS_SECURITY_PATH = '/usr/bin/security'

const CONTROL_CHAR_REGEX = /[\r\n\u0000-\u001f\u007f]/

/**
 * Validates that a Keychain identifier (account or service) does not contain
 * newlines, carriage returns, or other ASCII control characters (U+0000–U+001F, U+007F)
 * to prevent command injection into interactive security CLI sessions.
 */
export function validateKeychainIdentifier(value: string, name = 'identifier'): void {
  if (typeof value !== 'string' || CONTROL_CHAR_REGEX.test(value)) {
    throw new Error(`Invalid keychain ${name}: contains prohibited control characters or newlines`)
  }
}

export interface McpKeychainBackend {
  isAvailable(): boolean
  store(account: string, plaintext: string): void
  read(account: string): string | undefined
  delete(account: string): void
}

export type McpSpawnRunner = (
  command: string,
  args: string[],
  options: { input?: string; encoding?: string; timeout?: number; maxBuffer?: number }
) => {
  status: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: Error | null
}

let activeBackend: McpKeychainBackend | null = null
let activeSpawnRunner: McpSpawnRunner | null = null

/**
 * Injection point for tests to record or mock child process spawn calls without spawning real processes.
 */
export function setMcpSpawnRunner(runner: McpSpawnRunner | null): void {
  activeSpawnRunner = runner
}

export function getMcpSpawnRunner(): McpSpawnRunner | null {
  return activeSpawnRunner
}

/**
 * Injection point for tests or alternative backend providers.
 */
export function setMcpKeychainBackend(backend: McpKeychainBackend | null): void {
  activeBackend = backend
}

export function getMcpKeychainBackend(): McpKeychainBackend | null {
  return activeBackend
}

export const defaultBackend: McpKeychainBackend = {
  isAvailable(): boolean {
    if (activeSpawnRunner) return true
    if (process.platform !== 'darwin') return false
    return isValidExecutable(MACOS_SECURITY_PATH)
  },

  store(account: string, plaintext: string): void {
    validateKeychainIdentifier(account, 'account')
    validateKeychainIdentifier(MCP_KEYCHAIN_SERVICE, 'service')

    if (Buffer.byteLength(plaintext) > MAX_KEYCHAIN_PAYLOAD_SIZE) {
      throw new Error('Secret value exceeds maximum size limit.')
    }

    const runner = activeSpawnRunner ?? spawnSync
    // Encode plaintext secret as hexadecimal so it is completely safe against spaces, quotes,
    // and newlines when transmitted via stdin to security interactive mode.
    // The plaintext secret NEVER appears in child process argv.
    const hex = Buffer.from(plaintext, 'utf8').toString('hex')
    const safeAccount = account.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const safeService = MCP_KEYCHAIN_SERVICE.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const input = `add-generic-password -U -s "${safeService}" -a "${safeAccount}" -X ${hex}\n`

    const result = runner(
      MACOS_SECURITY_PATH,
      ['-i'],
      {
        input,
        encoding: 'utf8',
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: MAX_KEYCHAIN_PAYLOAD_SIZE,
      }
    )

    if (result.error) {
      throw new Error(`Keychain execution error: ${result.error.message}`)
    }
    if (result.status !== 0) {
      const errMsg = result.stderr?.toString().trim() || `exit code ${result.status}`
      throw new Error(`Failed to store secret in Keychain: ${errMsg}`)
    }
  },

  read(account: string): string | undefined {
    validateKeychainIdentifier(account, 'account')
    validateKeychainIdentifier(MCP_KEYCHAIN_SERVICE, 'service')

    const runner = activeSpawnRunner ?? spawnSync
    const result = runner(
      MACOS_SECURITY_PATH,
      [
        'find-generic-password',
        '-s',
        MCP_KEYCHAIN_SERVICE,
        '-a',
        account,
        '-w',
      ],
      {
        encoding: 'utf8',
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: MAX_KEYCHAIN_PAYLOAD_SIZE,
      }
    )

    if (result.status === 0 && result.stdout) {
      const out = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8')
      return out.replace(/\r?\n$/, '')
    }
    // status 44 is errSecItemNotFound in macOS security CLI
    return undefined
  },

  delete(account: string): void {
    validateKeychainIdentifier(account, 'account')
    validateKeychainIdentifier(MCP_KEYCHAIN_SERVICE, 'service')

    const runner = activeSpawnRunner ?? spawnSync
    runner(
      MACOS_SECURITY_PATH,
      [
        'delete-generic-password',
        '-s',
        MCP_KEYCHAIN_SERVICE,
        '-a',
        account,
      ],
      {
        encoding: 'utf8',
        timeout: KEYCHAIN_TIMEOUT_MS,
        maxBuffer: MAX_KEYCHAIN_PAYLOAD_SIZE,
      }
    )
  },
}

function getBackend(): McpKeychainBackend {
  return activeBackend ?? defaultBackend
}

/**
 * Checks if the macOS Keychain integration is available and functional.
 */
export function isKeychainAvailable(): boolean {
  return getBackend().isAvailable()
}

/**
 * Generates a unique, deterministically identifiable keychain account name
 * containing both serverId and fieldPath.
 */
export function formatMcpKeychainAccount(serverId: string, fieldPath: string): string {
  const account = `trace:mcp:${serverId}:${fieldPath}`
  validateKeychainIdentifier(account, 'account')
  return account
}

/**
 * Stores a secret in the macOS Keychain and returns an McpSecretRef.
 * Throws an explicit error if Keychain is unavailable or storage fails.
 * Never degrades silently to plaintext.
 */
export function storeMcpSecret(
  serverId: string,
  fieldPath: string,
  plaintext: string
): McpSecretRef {
  if (!isKeychainAvailable()) {
    throw new Error(
      `Cannot store MCP secret for "${serverId}" (${fieldPath}): macOS Keychain is not available on this system.`
    )
  }

  if (typeof plaintext !== 'string') {
    throw new Error(`Secret value for "${serverId}" (${fieldPath}) must be a string.`)
  }

  const keychainAccount = formatMcpKeychainAccount(serverId, fieldPath)
  getBackend().store(keychainAccount, plaintext)

  return {
    location: 'keychain',
    keychainAccount,
  }
}

/**
 * Reads a secret referenced by an McpSecretRef.
 * Returns the plaintext string, or undefined if not found or unavailable.
 */
export function readMcpSecret(ref: McpSecretRef): string | undefined {
  if (ref.location === 'plaintext') {
    return ref.value
  }

  if (ref.location === 'keychain') {
    if (!ref.keychainAccount) return undefined
    if (!isKeychainAvailable()) return undefined
    return getBackend().read(ref.keychainAccount)
  }

  return undefined
}

/**
 * Deletes a secret from the Keychain referenced by an McpSecretRef.
 */
export function deleteMcpSecret(ref: McpSecretRef): void {
  if (ref.location === 'keychain' && ref.keychainAccount) {
    if (isKeychainAvailable()) {
      try {
        getBackend().delete(ref.keychainAccount)
      } catch {
        // Idempotent delete: ignore failures
      }
    }
  }
}
