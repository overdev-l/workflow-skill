/**
 * AI Tool Account Store (OPC-48)
 *
 * Provides strong, credential-agnostic local account persistence for Google Antigravity,
 * OpenAI Codex, and Claude Code.
 *
 * Storage Architecture:
 * - Root: ~/.trace/accounts/<id>/ (isolated from old profiles at ~/.trace/profiles)
 * - Permissions: Directories 0o700, Files 0o600
 * - Manifest: manifest.json (schema version 1, SHA256 integrity, UTF-8 payload length)
 * - Credential payload: credential.utf8 (opaque UTF-8 string, never returned over IPC)
 *
 * Security & Invariants:
 * - IDs generated via crypto.randomUUID(), validated against strict UUID regex
 * - Tool names strictly validated against ACCOUNT_TOOLS allowlist
 * - Account names trimmed 1..100 characters with prototype pollution guards
 * - Strict symlink and path traversal guards before every filesystem write or deletion
 * - Rejects any symlink at or below homeDir (including traceHome and accountsDir)
 * - Rejects non-regular files and hard-linked files (nlink > 1)
 * - Explicit corruption detection (SHA256 mismatch, length mismatch, malformed JSON)
 *   Corrupted accounts are rejected with descriptive AccountError and NEVER wiped or silently replaced.
 * - Atomic write lifecycle: staging in private temp directory followed by atomic rename
 * - Staging cleanup on any failure
 * - Serialized critical sections via async mutex queue (concurrent mutation guard)
 * - Payloads supported up to 5 MiB (no artificial 2 KB limitation)
 * - Independent of active tool configuration files (deletion never mutates active credentials)
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
import os from 'node:os'
import path from 'node:path'
import {
  type AccountCredentialInput,
  type AccountManifest,
  type AccountMetadata,
  type AccountTool,
  type StoredAccountRecord,
  AccountError,
  DEFAULT_ACCOUNT_ERROR_MESSAGE,
  MAX_CREDENTIAL_PAYLOAD_SIZE,
  MAX_MANIFEST_FILE_SIZE,
  validateAccountId,
  validateAccountManifest,
  validateAccountName,
  validateAccountTool,
} from '../../../packages/workflow-model/src/accounts.ts'

export interface AccountStoreOptions {
  homeDir?: string
  traceHome?: string
}

export interface AccountCredentialUpdateInput {
  credential: string
  email?: string
  accountId?: string
  expiresAt?: number
  name?: string
}

export const MAX_SUPPRESSION_FILE_SIZE = 64 * 1024 // 64 KiB
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i

export interface AccountSuppressionEntry {
  tool: AccountTool
  fingerprint: string
  suppressedAt: number
}

export interface AccountSuppressionFile {
  version: 1
  suppressions: AccountSuppressionEntry[]
}

function pathOrSymlinkExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

/**
 * Checks if legacy profile directories exist in ~/.trace/profiles without reading or modifying them.
 */
export function hasLegacyProfiles(traceHome: string): boolean {
  try {
    const profilesDir = path.join(traceHome, 'profiles')
    if (!existsSync(profilesDir)) return false
    const entries = readdirSync(profilesDir, { withFileTypes: true })
    return entries.some((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  } catch {
    return false
  }
}

export class AccountStore {
  public readonly homeDir: string
  public readonly traceHome: string
  public readonly accountsDir: string
  public readonly baseDirectory: string

  private mutationLock: Promise<void> = Promise.resolve()

  constructor(options?: AccountStoreOptions) {
    this.homeDir = options?.homeDir ? path.resolve(options.homeDir) : os.homedir()
    this.traceHome = options?.traceHome ? path.resolve(options.traceHome) : path.join(this.homeDir, '.trace')

    // traceHome must strictly reside inside homeDir
    const relTrace = path.relative(this.homeDir, this.traceHome)
    if (!relTrace || relTrace.startsWith('..') || path.isAbsolute(relTrace)) {
      throw new AccountError('Security violation: traceHome must be located within homeDir.')
    }

    this.accountsDir = path.join(this.traceHome, 'accounts')
    this.baseDirectory = this.accountsDir
  }

  /**
   * Asserts that targetPath is strictly located inside accountsDir and that NO segment
   * from homeDir down to targetPath is a symbolic link or non-regular file.
   */
  private assertSafePath(targetPath: string): void {
    const resolvedTarget = path.resolve(targetPath)

    const relFromAccounts = path.relative(this.accountsDir, resolvedTarget)
    if (resolvedTarget !== this.traceHome && (relFromAccounts.startsWith('..') || path.isAbsolute(relFromAccounts))) {
      throw new AccountError('Security violation: path traversal outside account storage.')
    }

    // Traverse all path segments starting from homeDir down to targetPath
    const relFromHome = path.relative(this.homeDir, resolvedTarget)
    const segments = relFromHome.split(path.sep).filter(Boolean)

    let current = this.homeDir
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i])
      if (pathOrSymlinkExists(current)) {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink()) {
          throw new AccountError('Security violation: symbolic link detected in account storage path.')
        }
        if (i < segments.length - 1 && !stat.isDirectory()) {
          throw new AccountError('Security violation: invalid account storage directory.')
        }
        // Leaf file check: must not be hard-linked or non-regular
        if (i === segments.length - 1 && !stat.isDirectory()) {
          if (!stat.isFile() || (typeof stat.nlink === 'number' && stat.nlink > 1)) {
            throw new AccountError('Security violation: non-regular file or hard link detected.')
          }
        }
      }
    }
  }

  /**
   * Ensures traceHome and accounts root directories exist with 0o700 permissions.
   */
  private ensureDirectories(): void {
    this.assertSafePath(this.traceHome)
    if (!existsSync(this.traceHome)) {
      mkdirSync(this.traceHome, { mode: 0o700, recursive: true })
    }
    try {
      chmodSync(this.traceHome, 0o700)
    } catch (err) {
      if (process.platform !== 'win32') throw err
    }

    this.assertSafePath(this.accountsDir)
    if (!existsSync(this.accountsDir)) {
      mkdirSync(this.accountsDir, { mode: 0o700, recursive: true })
    }
    try {
      chmodSync(this.accountsDir, 0o700)
    } catch (err) {
      if (process.platform !== 'win32') throw err
    }
  }

  /**
   * Executes a mutation inside a serialized critical section.
   */
  private async withMutationLock<T>(action: () => Promise<T> | T): Promise<T> {
    const previousLock = this.mutationLock
    let releaseLock!: () => void
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    this.mutationLock = previousLock.then(() => nextLock)
    await previousLock

    try {
      return await action()
    } finally {
      releaseLock()
    }
  }

  /**
   * Saves a new account credential payload atomically to disk.
   * Account ID is always generated via crypto.randomUUID().
   * Returns renderer-safe AccountMetadata (payload is never included).
   */
  async save(input: AccountCredentialInput): Promise<AccountMetadata> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AccountError('Invalid account input: must be an object.')
    }

    const tool = validateAccountTool(input.tool)
    const name = validateAccountName(input.name)

    if (typeof input.credential !== 'string' || input.credential.length === 0) {
      throw new AccountError('Credential payload must be a non-empty string.')
    }

    const payloadBuffer = Buffer.from(input.credential, 'utf8')
    if (payloadBuffer.length > MAX_CREDENTIAL_PAYLOAD_SIZE) {
      throw new AccountError('Credential payload exceeds maximum permitted size of 5 MiB.')
    }

    let email: string | undefined
    if (input.email !== undefined) {
      if (
        typeof input.email !== 'string' ||
        input.email.trim().length === 0 ||
        input.email.length > 255 ||
        /[\x00-\x1f\x7f]/.test(input.email)
      ) {
        throw new AccountError('Invalid account email: contains invalid characters or length.')
      }
      email = input.email.trim()
    }

    let accountId: string | undefined
    if (input.accountId !== undefined) {
      if (
        typeof input.accountId !== 'string' ||
        input.accountId.trim().length === 0 ||
        input.accountId.length > 255 ||
        /[\x00-\x1f\x7f]/.test(input.accountId)
      ) {
        throw new AccountError('Invalid account ID identifier: contains invalid characters or length.')
      }
      accountId = input.accountId.trim()
    }

    let expiresAt: number | undefined
    if (input.expiresAt !== undefined) {
      if (typeof input.expiresAt !== 'number' || !Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
        throw new AccountError('Invalid expiresAt timestamp: must be a positive integer.')
      }
      expiresAt = input.expiresAt
    }

    const id = randomUUID()

    return await this.withMutationLock(async () => {
      this.ensureDirectories()

      const targetDir = path.join(this.accountsDir, id)
      this.assertSafePath(targetDir)

      if (pathOrSymlinkExists(targetDir)) {
        throw new AccountError('Account already exists.')
      }

      const stagingDir = path.join(
        this.accountsDir,
        `.staging_${id}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
      )

      this.assertSafePath(stagingDir)

      try {
        mkdirSync(stagingDir, { mode: 0o700, recursive: true })
        try {
          chmodSync(stagingDir, 0o700)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        const payloadSha256 = createHash('sha256').update(payloadBuffer).digest('hex')
        const payloadLength = payloadBuffer.length

        const credentialPath = path.join(stagingDir, 'credential.utf8')
        writeFileSync(credentialPath, payloadBuffer, { mode: 0o600 })
        try {
          chmodSync(credentialPath, 0o600)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        const now = Date.now()
        const manifest: AccountManifest = {
          version: 1,
          id,
          tool,
          name,
          email,
          accountId,
          createdAt: now,
          updatedAt: now,
          expiresAt,
          credentialFile: 'credential.utf8',
          payloadSha256,
          payloadLength,
        }

        const manifestPath = path.join(stagingDir, 'manifest.json')
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
        try {
          chmodSync(manifestPath, 0o600)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        // Atomic rename from staging to target
        renameSync(stagingDir, targetDir)
        try {
          chmodSync(targetDir, 0o700)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        return {
          id,
          tool,
          name,
          email,
          accountId,
          createdAt: now,
          updatedAt: now,
          expiresAt,
        }
      } catch (err) {
        if (pathOrSymlinkExists(stagingDir)) {
          try {
            rmSync(stagingDir, { recursive: true, force: true })
          } catch {}
        }
        if (err instanceof AccountError) {
          throw err
        }
        throw new AccountError(DEFAULT_ACCOUNT_ERROR_MESSAGE)
      }
    })
  }

  /**
   * Internal retrieval of account metadata and raw credential payload.
   * Never exposed directly across IPC to the renderer.
   * Corrupted accounts throw AccountError and are NEVER wiped or replaced.
   */
  async get(id: string): Promise<StoredAccountRecord> {
    const validId = validateAccountId(id)
    const targetDir = path.join(this.accountsDir, validId)

    this.assertSafePath(targetDir)

    if (!pathOrSymlinkExists(targetDir)) {
      throw new AccountError('Account not found.')
    }

    const dirStat = lstatSync(targetDir)
    if (dirStat.isSymbolicLink()) {
      throw new AccountError('Security violation: symbolic link detected in account storage path.')
    }
    if (!dirStat.isDirectory()) {
      throw new AccountError('Account corrupted: target path is not a directory.')
    }

    const manifestPath = path.join(targetDir, 'manifest.json')
    this.assertSafePath(manifestPath)

    if (!pathOrSymlinkExists(manifestPath)) {
      throw new AccountError('Account corrupted: manifest.json is missing.')
    }

    const manifestStat = lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (typeof manifestStat.nlink === 'number' && manifestStat.nlink > 1)) {
      throw new AccountError('Security violation: non-regular file or hard link detected.')
    }
    if (manifestStat.size === 0 || manifestStat.size > MAX_MANIFEST_FILE_SIZE) {
      throw new AccountError('Account corrupted: manifest file size is invalid.')
    }

    let manifestRaw: string
    try {
      manifestRaw = readFileSync(manifestPath, 'utf8')
    } catch {
      throw new AccountError('Account corrupted: failed to read manifest file.')
    }

    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(manifestRaw)
    } catch {
      throw new AccountError('Account corrupted: invalid manifest JSON.')
    }

    const manifest = validateAccountManifest(manifestJson, validId)

    const credentialPath = path.join(targetDir, manifest.credentialFile)
    this.assertSafePath(credentialPath)

    if (!pathOrSymlinkExists(credentialPath)) {
      throw new AccountError('Account corrupted: credential payload file is missing.')
    }

    const credentialStat = lstatSync(credentialPath)
    if (!credentialStat.isFile() || credentialStat.isSymbolicLink() || (typeof credentialStat.nlink === 'number' && credentialStat.nlink > 1)) {
      throw new AccountError('Security violation: non-regular file or hard link detected.')
    }
    if (credentialStat.size > MAX_CREDENTIAL_PAYLOAD_SIZE) {
      throw new AccountError('Account corrupted: credential payload size exceeds limit.')
    }
    if (credentialStat.size !== manifest.payloadLength) {
      throw new AccountError('Account corrupted: credential payload length mismatch.')
    }

    let payloadBuffer: Buffer
    try {
      payloadBuffer = readFileSync(credentialPath)
    } catch {
      throw new AccountError('Account corrupted: failed to read credential payload.')
    }

    const actualSha256 = createHash('sha256').update(payloadBuffer).digest('hex')
    if (actualSha256.toLowerCase() !== manifest.payloadSha256.toLowerCase()) {
      throw new AccountError('Account corrupted: credential payload hash mismatch.')
    }

    const credential = payloadBuffer.toString('utf8')

    return {
      metadata: {
        id: manifest.id,
        tool: manifest.tool,
        name: manifest.name,
        email: manifest.email,
        accountId: manifest.accountId,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        expiresAt: manifest.expiresAt,
      },
      credential,
    }
  }

  /**
   * Lists renderer-safe AccountMetadata for all accounts, optionally filtered by tool.
   * Excludes all secret payloads. Validates payload integrity and checks for symlinks.
   * Corrupted accounts throw AccountError rather than silently wiping.
   */
  async list(tool?: AccountTool): Promise<AccountMetadata[]> {
    if (tool !== undefined) {
      validateAccountTool(tool)
    }

    if (!existsSync(this.accountsDir)) {
      return []
    }

    this.assertSafePath(this.accountsDir)
    const rootStat = lstatSync(this.accountsDir)
    if (rootStat.isSymbolicLink()) {
      throw new AccountError('Security violation: symbolic link detected in account storage path.')
    }

    const entries = readdirSync(this.accountsDir)
    const result: AccountMetadata[] = []

    for (const entryName of entries) {
      if (entryName.startsWith('.')) continue

      const entryPath = path.join(this.accountsDir, entryName)

      // Must detect symlinks before skipping non-directories
      this.assertSafePath(entryPath)

      const dirStat = lstatSync(entryPath)
      if (dirStat.isSymbolicLink()) {
        throw new AccountError('Security violation: symbolic link detected in account storage path.')
      }
      if (!dirStat.isDirectory()) continue

      let validId: string
      try {
        validId = validateAccountId(entryName)
      } catch {
        continue
      }

      // Verify full storage and payload integrity for the account
      const record = await this.get(validId)

      if (tool && record.metadata.tool !== tool) {
        continue
      }

      result.push(record.metadata)
    }

    return result.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Renames an existing account. Updates manifest.json atomically.
   */
  async rename(id: string, name: string): Promise<AccountMetadata> {
    const validId = validateAccountId(id)
    const validName = validateAccountName(name)

    return await this.withMutationLock(async () => {
      const targetDir = path.join(this.accountsDir, validId)
      this.assertSafePath(targetDir)

      if (!pathOrSymlinkExists(targetDir)) {
        throw new AccountError('Account not found.')
      }

      const dirStat = lstatSync(targetDir)
      if (dirStat.isSymbolicLink()) {
        throw new AccountError('Security violation: symbolic link detected in account storage path.')
      }

      const manifestPath = path.join(targetDir, 'manifest.json')
      this.assertSafePath(manifestPath)

      if (!pathOrSymlinkExists(manifestPath)) {
        throw new AccountError('Account corrupted: manifest.json is missing.')
      }

      const manifestStat = lstatSync(manifestPath)
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (typeof manifestStat.nlink === 'number' && manifestStat.nlink > 1)) {
        throw new AccountError('Security violation: non-regular file or hard link detected.')
      }
      if (manifestStat.size === 0 || manifestStat.size > MAX_MANIFEST_FILE_SIZE) {
        throw new AccountError('Account corrupted: manifest file size is invalid.')
      }

      let raw: string
      try {
        raw = readFileSync(manifestPath, 'utf8')
      } catch {
        throw new AccountError('Account corrupted: failed to read manifest file.')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new AccountError('Account corrupted: invalid manifest JSON.')
      }

      const manifest = validateAccountManifest(parsed, validId)

      const now = Date.now()
      const updatedManifest: AccountManifest = {
        ...manifest,
        name: validName,
        updatedAt: now,
      }

      const tempManifestPath = path.join(
        targetDir,
        `.manifest_tmp_${now}_${Math.random().toString(36).substring(2, 10)}.json`
      )

      this.assertSafePath(tempManifestPath)

      try {
        writeFileSync(tempManifestPath, JSON.stringify(updatedManifest, null, 2), { mode: 0o600 })
        try {
          chmodSync(tempManifestPath, 0o600)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        renameSync(tempManifestPath, manifestPath)

        return {
          id: manifest.id,
          tool: manifest.tool,
          name: validName,
          email: manifest.email,
          accountId: manifest.accountId,
          createdAt: manifest.createdAt,
          updatedAt: now,
          expiresAt: manifest.expiresAt,
        }
      } catch (err) {
        if (pathOrSymlinkExists(tempManifestPath)) {
          try {
            rmSync(tempManifestPath, { force: true })
          } catch {}
        }
        if (err instanceof AccountError) {
          throw err
        }
        throw new AccountError(DEFAULT_ACCOUNT_ERROR_MESSAGE)
      }
    })
  }

  /**
   * Deletes an account from ~/.trace/accounts/<id>.
   * Strictly isolated: detects symlinks and does NOT alter active tool auth files or Keychain.
   */
  async delete(id: string): Promise<void> {
    const validId = validateAccountId(id)

    await this.withMutationLock(async () => {
      const targetDir = path.join(this.accountsDir, validId)
      this.assertSafePath(targetDir)

      if (!pathOrSymlinkExists(targetDir)) {
        return
      }

      const stat = lstatSync(targetDir)
      if (stat.isSymbolicLink()) {
        throw new AccountError('Security violation: symbolic link detected in account storage path.')
      }

      // Check all nested children for symlinks before removal
      if (stat.isDirectory()) {
        const children = readdirSync(targetDir)
        for (const child of children) {
          const childPath = path.join(targetDir, child)
          const childStat = lstatSync(childPath)
          if (childStat.isSymbolicLink()) {
            throw new AccountError('Security violation: symbolic link detected in account storage path.')
          }
        }
      }

      rmSync(targetDir, { recursive: true, force: true })
    })
  }

  /**
   * Updates an existing account credential atomically.
   * Preserves id, name, and createdAt.
   * Writes new immutable generation credential file, atomically commits updated manifest pointer,
   * then removes old generation file only after successful manifest commit.
   * If any failure occurs before manifest commit, old record remains untouched and readable.
   */
  async updateCredential(id: string, input: AccountCredentialUpdateInput): Promise<AccountMetadata> {
    const validId = validateAccountId(id)
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AccountError('Invalid account input: must be an object.')
    }

    if (typeof input.credential !== 'string' || input.credential.length === 0) {
      throw new AccountError('Credential payload must be a non-empty string.')
    }

    const payloadBuffer = Buffer.from(input.credential, 'utf8')
    if (payloadBuffer.length > MAX_CREDENTIAL_PAYLOAD_SIZE) {
      throw new AccountError('Credential payload exceeds maximum permitted size of 5 MiB.')
    }

    let email: string | undefined
    if (input.email !== undefined) {
      if (
        typeof input.email !== 'string' ||
        input.email.trim().length === 0 ||
        input.email.length > 255 ||
        /[\x00-\x1f\x7f]/.test(input.email)
      ) {
        throw new AccountError('Invalid account email: contains invalid characters or length.')
      }
      email = input.email.trim()
    }

    let accountId: string | undefined
    if (input.accountId !== undefined) {
      if (
        typeof input.accountId !== 'string' ||
        input.accountId.trim().length === 0 ||
        input.accountId.length > 255 ||
        /[\x00-\x1f\x7f]/.test(input.accountId)
      ) {
        throw new AccountError('Invalid account ID identifier: contains invalid characters or length.')
      }
      accountId = input.accountId.trim()
    }

    let expiresAt: number | undefined
    if (input.expiresAt !== undefined) {
      if (typeof input.expiresAt !== 'number' || !Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
        throw new AccountError('Invalid expiresAt timestamp: must be a positive integer.')
      }
      expiresAt = input.expiresAt
    }

    return await this.withMutationLock(async () => {
      const targetDir = path.join(this.accountsDir, validId)
      this.assertSafePath(targetDir)

      if (!pathOrSymlinkExists(targetDir)) {
        throw new AccountError('Account not found.')
      }

      const dirStat = lstatSync(targetDir)
      if (dirStat.isSymbolicLink()) {
        throw new AccountError('Security violation: symbolic link detected in account storage path.')
      }
      if (!dirStat.isDirectory()) {
        throw new AccountError('Account corrupted: target path is not a directory.')
      }

      // Verify existing record is healthy; corrupted accounts throw AccountError and are NEVER overwritten
      await this.get(validId)

      const manifestPath = path.join(targetDir, 'manifest.json')
      this.assertSafePath(manifestPath)
      const currentManifestRaw = readFileSync(manifestPath, 'utf8')
      const currentManifest = validateAccountManifest(JSON.parse(currentManifestRaw), validId)
      const oldCredentialFile = currentManifest.credentialFile

      const genId = randomUUID()
      const newCredentialFilename = `credential.${genId}.utf8`
      const newCredentialPath = path.join(targetDir, newCredentialFilename)
      const tempCredPath = path.join(
        targetDir,
        `.credential_tmp_${genId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}.utf8`
      )
      const now = Date.now()
      const tempManifestPath = path.join(
        targetDir,
        `.manifest_tmp_${now}_${Math.random().toString(36).substring(2, 10)}.json`
      )

      this.assertSafePath(tempCredPath)
      this.assertSafePath(newCredentialPath)
      this.assertSafePath(tempManifestPath)

      const payloadSha256 = createHash('sha256').update(payloadBuffer).digest('hex')
      const payloadLength = payloadBuffer.length

      try {
        // 1. Write new generation credential payload to temp file
        writeFileSync(tempCredPath, payloadBuffer, { mode: 0o600 })
        try {
          chmodSync(tempCredPath, 0o600)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        // 2. Rename temp to immutable generation file
        renameSync(tempCredPath, newCredentialPath)
        try {
          chmodSync(newCredentialPath, 0o600)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        // Check new credential file safety
        this.assertSafePath(newCredentialPath)
        const credStat = lstatSync(newCredentialPath)
        if (!credStat.isFile() || credStat.isSymbolicLink() || (typeof credStat.nlink === 'number' && credStat.nlink > 1)) {
          throw new AccountError('Security violation: non-regular file or hard link detected.')
        }

        // 3. Prepare updated manifest with version 2, preserving name, id, createdAt, and tool
        const updatedManifest: AccountManifest = {
          version: 2,
          id: validId,
          tool: currentManifest.tool,
          name: currentManifest.name,
          email: email !== undefined ? email : currentManifest.email,
          accountId: accountId !== undefined ? accountId : currentManifest.accountId,
          createdAt: currentManifest.createdAt,
          updatedAt: now,
          expiresAt: expiresAt !== undefined ? expiresAt : currentManifest.expiresAt,
          credentialFile: newCredentialFilename,
          payloadSha256,
          payloadLength,
        }

        // 4. Write staging manifest
        writeFileSync(tempManifestPath, JSON.stringify(updatedManifest, null, 2), { mode: 0o600 })
        try {
          chmodSync(tempManifestPath, 0o600)
        } catch (err) {
          if (process.platform !== 'win32') throw err
        }

        // 5. Atomic pointer commit: rename staging manifest over manifest.json
        renameSync(tempManifestPath, manifestPath)

        // 6. Clean up old generation file ONLY after successful manifest commit
        if (oldCredentialFile && oldCredentialFile !== newCredentialFilename) {
          const oldCredPath = path.join(targetDir, oldCredentialFile)
          try {
            this.assertSafePath(oldCredPath)
            rmSync(oldCredPath, { force: true })
          } catch {}
        }

        return {
          id: validId,
          tool: updatedManifest.tool,
          name: updatedManifest.name,
          email: updatedManifest.email,
          accountId: updatedManifest.accountId,
          createdAt: updatedManifest.createdAt,
          updatedAt: now,
          expiresAt: updatedManifest.expiresAt,
        }
      } catch (err) {
        // On error, remove newly staged files so old record remains readable
        try {
          if (pathOrSymlinkExists(tempCredPath)) rmSync(tempCredPath, { force: true })
        } catch {}
        try {
          if (pathOrSymlinkExists(newCredentialPath)) rmSync(newCredentialPath, { force: true })
        } catch {}
        try {
          if (pathOrSymlinkExists(tempManifestPath)) rmSync(tempManifestPath, { force: true })
        } catch {}

        if (err instanceof AccountError) throw err
        throw new AccountError(DEFAULT_ACCOUNT_ERROR_MESSAGE)
      }
    })
  }

  private get suppressionPath(): string {
    return path.join(this.accountsDir, '.suppressions.json')
  }

  private readSuppressionFileSafely(): AccountSuppressionFile {
    const targetPath = this.suppressionPath
    if (!existsSync(this.accountsDir)) {
      return { version: 1, suppressions: [] }
    }
    this.assertSafePath(this.accountsDir)
    if (!pathOrSymlinkExists(targetPath)) {
      return { version: 1, suppressions: [] }
    }

    this.assertSafePath(targetPath)
    const stat = lstatSync(targetPath)
    if (stat.isSymbolicLink()) {
      throw new AccountError('Security violation: symbolic link detected in account storage path.')
    }
    if (!stat.isFile() || (typeof stat.nlink === 'number' && stat.nlink > 1)) {
      throw new AccountError('Suppression storage corrupted: non-regular file or hard link detected.')
    }
    if (stat.size > MAX_SUPPRESSION_FILE_SIZE) {
      throw new AccountError('Suppression storage corrupted: file size exceeds limit.')
    }

    let raw: string
    try {
      raw = readFileSync(targetPath, 'utf8')
    } catch {
      throw new AccountError('Suppression storage corrupted: failed to read file.')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AccountError('Suppression storage corrupted: invalid JSON.')
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AccountError('Suppression storage corrupted: must be an object.')
    }

    const obj = parsed as Record<string, unknown>
    if (obj.version !== 1) {
      throw new AccountError('Suppression storage corrupted: unsupported version.')
    }
    if (!Array.isArray(obj.suppressions)) {
      throw new AccountError('Suppression storage corrupted: suppressions must be an array.')
    }

    const validEntries: AccountSuppressionEntry[] = []
    for (const item of obj.suppressions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AccountError('Suppression storage corrupted: suppression entry must be an object.')
      }
      const entry = item as Record<string, unknown>
      const tool = validateAccountTool(entry.tool)
      if (typeof entry.fingerprint !== 'string' || !SHA256_HEX_REGEX.test(entry.fingerprint)) {
        throw new AccountError('Suppression storage corrupted: invalid fingerprint.')
      }
      if (typeof entry.suppressedAt !== 'number' || !Number.isInteger(entry.suppressedAt) || entry.suppressedAt <= 0) {
        throw new AccountError('Suppression storage corrupted: invalid suppressedAt timestamp.')
      }
      validEntries.push({
        tool,
        fingerprint: entry.fingerprint.toLowerCase(),
        suppressedAt: entry.suppressedAt,
      })
    }

    return {
      version: 1,
      suppressions: validEntries,
    }
  }

  private writeSuppressionFileSafely(data: AccountSuppressionFile): void {
    this.ensureDirectories()
    const targetPath = this.suppressionPath
    this.assertSafePath(this.accountsDir)

    // Limit size: keep at most 200 newest entries
    const sorted = [...data.suppressions].sort((a, b) => b.suppressedAt - a.suppressedAt)
    const pruned = sorted.slice(0, 200)

    const payload = JSON.stringify({ version: 1, suppressions: pruned }, null, 2)
    if (Buffer.byteLength(payload, 'utf8') > MAX_SUPPRESSION_FILE_SIZE) {
      throw new AccountError('Suppression storage exceeds size limit.')
    }

    const tempPath = path.join(
      this.accountsDir,
      `.suppressions_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 10)}.json`
    )
    this.assertSafePath(tempPath)

    try {
      writeFileSync(tempPath, payload, { mode: 0o600 })
      try {
        chmodSync(tempPath, 0o600)
      } catch (err) {
        if (process.platform !== 'win32') throw err
      }
      this.assertSafePath(targetPath)
      renameSync(tempPath, targetPath)
      try {
        chmodSync(targetPath, 0o600)
      } catch (err) {
        if (process.platform !== 'win32') throw err
      }
    } finally {
      if (pathOrSymlinkExists(tempPath)) {
        try {
          rmSync(tempPath, { force: true })
        } catch {}
      }
    }
  }

  async isSuppressed(tool: AccountTool, fingerprint: string): Promise<boolean> {
    validateAccountTool(tool)
    if (typeof fingerprint !== 'string' || !SHA256_HEX_REGEX.test(fingerprint)) {
      return false
    }
    const lowerFingerprint = fingerprint.toLowerCase()
    return await this.withMutationLock(async () => {
      const data = this.readSuppressionFileSafely()
      return data.suppressions.some((e) => e.tool === tool && e.fingerprint === lowerFingerprint)
    })
  }

  async recordSuppression(tool: AccountTool, fingerprint: string): Promise<void> {
    validateAccountTool(tool)
    if (typeof fingerprint !== 'string' || !SHA256_HEX_REGEX.test(fingerprint)) {
      throw new AccountError('Invalid suppression fingerprint.')
    }
    const lowerFingerprint = fingerprint.toLowerCase()

    await this.withMutationLock(async () => {
      const data = this.readSuppressionFileSafely()
      const remaining = data.suppressions.filter(
        (e) => !(e.tool === tool && e.fingerprint === lowerFingerprint)
      )
      remaining.push({
        tool,
        fingerprint: lowerFingerprint,
        suppressedAt: Date.now(),
      })
      this.writeSuppressionFileSafely({ version: 1, suppressions: remaining })
    })
  }

  async clearSuppression(tool: AccountTool, fingerprint: string): Promise<void> {
    validateAccountTool(tool)
    if (typeof fingerprint !== 'string' || !SHA256_HEX_REGEX.test(fingerprint)) {
      return
    }
    const lowerFingerprint = fingerprint.toLowerCase()

    await this.withMutationLock(async () => {
      if (!existsSync(this.accountsDir) || !pathOrSymlinkExists(this.suppressionPath)) {
        return
      }
      const data = this.readSuppressionFileSafely()
      const filtered = data.suppressions.filter(
        (e) => !(e.tool === tool && e.fingerprint === lowerFingerprint)
      )
      if (filtered.length !== data.suppressions.length) {
        this.writeSuppressionFileSafely({ version: 1, suppressions: filtered })
      }
    })
  }
}
