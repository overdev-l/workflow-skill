/**
 * Profile Keychain Adapter (OPC-48)
 *
 * Provides secure access to macOS Keychain for Claude Code credentials.
 * Service name: 'Claude Code-credentials'
 *
 * Security requirements:
 * - NO shell: true (prevent shell injection)
 * - NO secret values in process argv or emitted errors/logs
 * - Distinguish not-found (code 44) from permission denied / user canceled
 * - Use 'security -i' with '-X HEX' via stdin (clean EOF termination, no 'quit')
 * - keychainPath placed in add-generic-password command, not after -i
 * - Validated/escaped parameters against newlines, quotes, backslashes
 * - Confirm writes by reading back exact bytes
 * - Never emit raw stderr or command strings in errors
 * - Clean failure and descriptive errors on non-macOS platforms
 */

import { spawn } from 'node:child_process'
import os from 'node:os'

export const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

export interface KeychainSecretItem {
  service: string
  account: string
  secret: string
}

export interface KeychainAdapter {
  readonly isSupported: boolean
  validateWrite?(service: string, account: string, secret: string): void
  readSecret(service: string, account?: string): Promise<KeychainSecretItem | null>
  writeSecret(service: string, account: string, secret: string): Promise<void>
  deleteSecret(service: string, account?: string): Promise<boolean>
}

export interface MacOSSecurityOptions {
  securityBinaryPath?: string
  keychainPath?: string
  defaultAccount?: string
}

function validateKeychainParam(value: string, name: string): void {
  if (!value || typeof value !== 'string') {
    throw new Error(`Invalid ${name}: must be a non-empty string.`)
  }
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Security violation: ${name} cannot contain newline or null characters.`)
  }
}

function escapeForSecurityInteractive(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Production macOS Keychain Adapter using /usr/bin/security
 */
export class MacOSSecurityKeychainAdapter implements KeychainAdapter {
  private readonly securityBin: string
  private readonly keychainPath?: string
  private readonly defaultAccount?: string

  constructor(options?: MacOSSecurityOptions) {
    this.securityBin = options?.securityBinaryPath || '/usr/bin/security'
    this.keychainPath = options?.keychainPath
    this.defaultAccount = options?.defaultAccount
  }

  get isSupported(): boolean {
    return process.platform === 'darwin'
  }

  private ensureSupported(): void {
    if (!this.isSupported) {
      throw new Error(
        `Claude Code credentials require macOS Keychain ("${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}"). ` +
        `Keychain integration is unsupported on platform "${process.platform}".`
      )
    }
  }

  private getEffectiveAccount(account?: string): string {
    if (account && account.trim()) return account.trim()
    if (this.defaultAccount && this.defaultAccount.trim()) return this.defaultAccount.trim()
    try {
      const user = os.userInfo().username
      if (user) return user
    } catch {
      // ignore
    }
    return process.env.USER || process.env.LOGNAME || 'default'
  }

  /**
   * Reads generic password secret for the specified service and account.
   * If account is omitted, attempts to locate the account name from Keychain attributes first.
   */
  async readSecret(service: string, account?: string): Promise<KeychainSecretItem | null> {
    this.ensureSupported()
    validateKeychainParam(service, 'service')

    let resolvedAccount = account ? account.trim() : undefined
    if (resolvedAccount) {
      validateKeychainParam(resolvedAccount, 'account')
    }

    // If account was not specified, query attributes to discover the account
    if (!resolvedAccount) {
      const queryArgs = ['find-generic-password', '-s', service]
      if (this.keychainPath) {
        queryArgs.push(this.keychainPath)
      }

      const attrResult = await this.execSecurity(queryArgs)
      if (attrResult.exitCode === 44) {
        return null // Legitimate not-found
      }
      if (attrResult.exitCode !== 0) {
        this.handleSecurityError(attrResult.exitCode, 'read attributes')
      }

      // Extract account from attributes: "acct"<blob>="username"
      const match = attrResult.stdout.match(/"acct"<blob>="([^"]+)"/)
      if (match && match[1]) {
        resolvedAccount = match[1]
      } else {
        resolvedAccount = this.getEffectiveAccount()
      }
    }

    // Retrieve the password using -g (captured via stderr)
    const readArgs = ['find-generic-password', '-s', service, '-a', resolvedAccount]
    if (this.keychainPath) {
      readArgs.push(this.keychainPath)
    }
    readArgs.push('-g')

    const result = await this.execSecurity(readArgs)
    if (result.exitCode === 44) {
      return null // Legitimate not-found
    }
    if (result.exitCode !== 0) {
      this.handleSecurityError(result.exitCode, 'read password')
    }

    // Parse ONLY the password line from captured stderr (never expose raw stderr):
    // 1. Empty secret: "password: \n"
    // 2. Hex format (quotes, backslashes, unicode, newlines): "password: 0x666978...  human rep\n"
    // 3. Quoted string (simple ASCII): 'password: "deadbeef"\n'
    const stderrLines = result.stderr.split('\n')
    const passwordLine = stderrLines.find((l) => l.trimStart().startsWith('password:'))
    if (!passwordLine) {
      throw new Error('Keychain read failed: missing password attribute in security output.')
    }

    const trimmedLine = passwordLine.trimStart()
    let secret: string

    if (/^password:\s*$/.test(trimmedLine)) {
      secret = ''
    } else {
      const hexMatch = trimmedLine.match(/^password:\s*0x([0-9a-fA-F]+)/)
      if (hexMatch) {
        secret = Buffer.from(hexMatch[1], 'hex').toString('utf8')
      } else {
        const quoteMatch = trimmedLine.match(/^password:\s*"(.*)"\s*$/)
        if (quoteMatch) {
          secret = quoteMatch[1]
        } else {
          throw new Error('Keychain read failed: unrecognized password line format in security output.')
        }
      }
    }

    return {
      service,
      account: resolvedAccount,
      secret,
    }
  }

  /**
   * Writes generic password using 'security -i' and hexadecimal representation via stdin.
   * security -i exits cleanly on stdin EOF (no 'quit' command).
   * keychainPath is included inside the add-generic-password command.
   */
  async writeSecret(service: string, account: string, secret: string): Promise<void> {
    this.ensureSupported()
    validateKeychainParam(service, 'service')
    validateKeychainParam(account, 'account')

    const resolvedAccount = this.getEffectiveAccount(account)
    const hexData = Buffer.from(secret, 'utf8').toString('hex')

    const safeService = escapeForSecurityInteractive(service)
    const safeAccount = escapeForSecurityInteractive(resolvedAccount)

    let keychainTargetArg = ''
    if (this.keychainPath) {
      validateKeychainParam(this.keychainPath, 'keychainPath')
      keychainTargetArg = ` "${escapeForSecurityInteractive(this.keychainPath)}"`
    }

    // Subcommand line inside security -i:
    // add-generic-password -U -s "<service>" -a "<account>" -X "<hex>" [keychainPath]
    const command = `add-generic-password -U -s "${safeService}" -a "${safeAccount}" -X "${hexData}"${keychainTargetArg}\n`
    this.validateWrite(service, account, secret)

    await new Promise<void>((resolve, reject) => {
      let stderr = ''

      const child = spawn(this.securityBin, ['-i'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })

      child.on('error', () => {
        reject(new Error('Keychain write failed: unable to execute security process.'))
      })

      child.stdin.on('error', () => {
        reject(new Error('Keychain write failed: unable to send data to security process.'))
      })

      child.on('close', (code) => {
        // Filter out prompts if any
        const relevantErrors = stderr
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('security>'))

        if (code !== 0 || relevantErrors.length > 0) {
          try {
            this.handleSecurityError(code || 1, 'write')
          } catch (e) {
            return reject(e)
          }
        }

        resolve()
      })

      // Send command and close stdin to signal clean EOF
      child.stdin.end(command)
    })

    // Verify write by reading back exact bytes
    const verified = await this.readSecret(service, resolvedAccount)
    if (!verified || verified.secret !== secret) {
      throw new Error('Keychain write failed: verification readback did not match.')
    }
  }

  validateWrite(service: string, account: string, secret: string): void {
    validateKeychainParam(service, 'service')
    validateKeychainParam(account, 'account')
    const suffix = this.keychainPath ? ` "${escapeForSecurityInteractive(this.keychainPath)}"` : ''
    const command = `add-generic-password -U -s "${escapeForSecurityInteractive(service)}" -a "${escapeForSecurityInteractive(this.getEffectiveAccount(account))}" -X "${Buffer.from(secret, 'utf8').toString('hex')}"${suffix}\n`
    // macOS security's interactive parser truncates long command lines. Reject
    // before launching it so neither the active item nor its backup is truncated.
    if (Buffer.byteLength(command, 'utf8') > 4000) {
      throw new Error('Keychain write failed: credential exceeds the safe system command size; no changes were made.')
    }
  }

  /**
   * Deletes generic password item from Keychain.
   * Returns true if deleted, false if item was not found.
   */
  async deleteSecret(service: string, account?: string): Promise<boolean> {
    this.ensureSupported()
    validateKeychainParam(service, 'service')

    const args = ['delete-generic-password', '-s', service]
    if (account) {
      validateKeychainParam(account, 'account')
      args.push('-a', account.trim())
    }
    if (this.keychainPath) {
      args.push(this.keychainPath)
    }

    const result = await this.execSecurity(args)
    if (result.exitCode === 44) {
      return false // Item did not exist
    }
    if (result.exitCode !== 0) {
      this.handleSecurityError(result.exitCode, 'delete')
    }

    return true
  }

  private execSecurity(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      const child = spawn(this.securityBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })

      child.on('error', () => {
        reject(new Error('Keychain operation failed: unable to execute security process.'))
      })

      child.on('close', (exitCode) => {
        resolve({ exitCode, stdout, stderr })
      })
    })
  }

  private handleSecurityError(code: number | null, action: string): never {
    if (code === 128) {
      throw new Error('Keychain authorization was canceled by user.')
    }
    if (code === 36) {
      throw new Error('Keychain access denied or keychain is locked.')
    }

    // Return static safe error message without raw stderr
    throw new Error(`Keychain ${action} failed (code ${code}): security operation was not successful.`)
  }
}

/**
 * In-memory Keychain Adapter for tests and simulated environments.
 */
export class InMemoryKeychainAdapter implements KeychainAdapter {
  readonly isSupported = true
  private items = new Map<string, KeychainSecretItem>()

  private makeKey(service: string, account?: string): string {
    return `${service}:::${account || '*'}`
  }

  async readSecret(service: string, account?: string): Promise<KeychainSecretItem | null> {
    if (account) {
      const item = this.items.get(this.makeKey(service, account))
      return item ? { ...item } : null
    }

    for (const [key, item] of this.items.entries()) {
      if (key.startsWith(`${service}:::`)) {
        return { ...item }
      }
    }
    return null
  }

  async writeSecret(service: string, account: string, secret: string): Promise<void> {
    const key = this.makeKey(service, account)
    this.items.set(key, { service, account, secret })
  }

  async deleteSecret(service: string, account?: string): Promise<boolean> {
    if (account) {
      const key = this.makeKey(service, account)
      return this.items.delete(key)
    }

    let deleted = false
    for (const key of Array.from(this.items.keys())) {
      if (key.startsWith(`${service}:::`)) {
        this.items.delete(key)
        deleted = true
      }
    }
    return deleted
  }

  clear(): void {
    this.items.clear()
  }
}
