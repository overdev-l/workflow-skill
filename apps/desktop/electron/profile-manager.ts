/**
 * AI Developer Profile Manager (OPC-48)
 *
 * Manages atomic profile capture, multi-account switching, and one-click byte-exact rollback
 * for Claude Code and OpenAI Codex.
 *
 * Storage architecture:
 * - Stored at: ~/.trace/profiles/<id>/
 * - Directories: 0o700, Files: 0o600
 * - Fixed slot allowlist (path-safe, no arbitrary paths)
 * - Durable recovery journal at ~/.trace/profiles/.recovery/journal.json
 *
 * Invariants:
 * - Skill symlinks are NEVER modified or deleted
 * - Renderer responses are strictly metadata-only (zero secret leakage)
 * - Full transactional compensation if any step fails
 * - Pre-switch byte snapshot ensures 100% byte-exact rollback including absent files
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  type ProfileCaptureInput,
  type ProfileManifest,
  type ProfileMetadata,
  type ProfileRecoveryStatus,
  type ProfileRollbackResult,
  type ProfileSlotMetadata,
  type ProfileSlotName,
  type ProfileSwitchResult,
  type ProfileToolSummary,
  PROFILE_SLOTS,
  SLOT_FILE_NAMES,
  generateProfileId,
  isSafeSlotName,
  sanitizeErrorMessage,
  validateProfileId,
  validateProfileManifest,
  validateProfileName,
} from '@workflow-skill/workflow-model/profiles'
import {
  getDisabledRegistryPath,
  resolveMCPConfigPath,
} from './mcp-manager.ts'
import {
  DEFAULT_CLAUDE_KEYCHAIN_SERVICE,
  type KeychainAdapter,
  MacOSSecurityKeychainAdapter,
} from './profile-keychain.ts'

export interface ProfileFailureHooks {
  failBeforeKeychainWrite?: boolean
  failAfterKeychainWrite?: boolean
  failBeforeFileWrite?: (targetPath: string) => boolean
  failAfterFileWrite?: (targetPath: string) => boolean
  failDuringRollback?: boolean
  beforeSlotMutation?: (slotName: ProfileSlotName) => void
}

export interface ProfileManagerOptions {
  homeDir?: string
  traceHome?: string
  keychainAdapter?: KeychainAdapter
  claudeKeychainService?: string
  claudeKeychainAccount?: string
  failureHooks?: ProfileFailureHooks
  onProfileChanged?: () => void
}

interface BackupSlotInfo {
  slotName: ProfileSlotName
  targetPath?: string
  wasPresent: boolean
  sha256?: string
  mode?: number
  account?: string
  secret?: string
}

interface BackupManifest {
  version: 1
  id: string
  profileId: string
  createdAt: number
  slots: Record<string, BackupSlotInfo>
}

interface RecoveryJournal {
  version: 1
  status: 'in_progress' | 'completed' | 'rolled_back' | 'recovery_needed'
  operation: 'switch' | 'rollback'
  profileId: string
  targetProfileName?: string
  startedAt: number
  completedAt?: number
  backupDir: string
  ownWrittenHashes?: Record<string, string>
  postSwitchKeychain?: {
    account?: string
    sha256?: string
    wasPresent: boolean
  }
  postSwitchHashes?: Record<string, string | null>
  actionsApplied: Array<{
    step: 'keychain' | 'file'
    target: string
    timestamp: number
  }>
  error?: string
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

export class ProfileManager {
  private readonly homeDir: string
  private readonly traceHome: string
  private readonly profilesDir: string
  private readonly recoveryDir: string
  private readonly keychain: KeychainAdapter
  private readonly claudeKeychainService: string
  private readonly claudeKeychainAccount?: string
  private failureHooks: ProfileFailureHooks
  private readonly onProfileChanged?: () => void

  private isMutating = false
  private readonly trustedHome: string

  constructor(options?: ProfileManagerOptions) {
    this.homeDir = options?.homeDir || os.homedir()
    this.traceHome = options?.traceHome || path.join(this.homeDir, '.trace')
    this.profilesDir = path.join(this.traceHome, 'profiles')
    this.recoveryDir = path.join(this.profilesDir, '.recovery')
    this.keychain = options?.keychainAdapter || new MacOSSecurityKeychainAdapter()
    this.claudeKeychainService = options?.claudeKeychainService || DEFAULT_CLAUDE_KEYCHAIN_SERVICE
    this.claudeKeychainAccount = options?.claudeKeychainAccount
    this.failureHooks = options?.failureHooks || {}
    this.onProfileChanged = options?.onProfileChanged

    // Canonicalize trusted provided home root once
    try {
      this.trustedHome = existsSync(this.homeDir) ? realpathSync(this.homeDir) : path.resolve(this.homeDir)
    } catch {
      this.trustedHome = path.resolve(this.homeDir)
    }
  }

  setFailureHooks(hooks: ProfileFailureHooks): void {
    this.failureHooks = hooks
  }

  /**
   * Validates that path segments strictly BELOW trusted roots do not contain forbidden symlinks.
   * Tolerates OS-level symlinks in trusted root parents (e.g. /var -> /private/var on macOS).
   */
  private assertNoSymlinkBelowTrusted(targetPath: string): void {
    let base = this.trustedHome
    let target = path.resolve(targetPath)

    const relFromHome = path.relative(this.homeDir, targetPath)
    if (!relFromHome.startsWith('..') && !path.isAbsolute(relFromHome)) {
      target = path.join(this.trustedHome, relFromHome)
    }

    const relFromTrace = path.relative(this.traceHome, targetPath)
    if (!relFromTrace.startsWith('..') && !path.isAbsolute(relFromTrace)) {
      let trustedTraceBase: string
      try {
        if (existsSync(this.traceHome)) {
          const st = lstatSync(this.traceHome)
          if (st.isSymbolicLink()) {
            throw new Error(`Security violation: symbolic links are forbidden in profile storage: ${this.traceHome}`)
          }
          trustedTraceBase = realpathSync(this.traceHome)
        } else {
          const parent = path.dirname(this.traceHome)
          trustedTraceBase = existsSync(parent) ? realpathSync(parent) : parent
        }
      } catch (e: any) {
        if (e?.message?.startsWith('Security violation:')) throw e
        trustedTraceBase = this.traceHome
      }
      base = trustedTraceBase
      target = path.join(trustedTraceBase, relFromTrace)
    }

    const rel = path.relative(base, target)
    if (rel.startsWith('..')) {
      return
    }

    let current = base
    for (const part of rel.split(path.sep)) {
      if (!part || part === '.') continue
      current = path.join(current, part)
      try {
        const st = lstatSync(current)
        if (st.isSymbolicLink()) {
          throw new Error(`Security violation: symbolic links are forbidden in profile storage: ${current}`)
        }
      } catch (e: any) {
        if (e?.code === 'ENOENT') {
          break
        }
        throw e
      }
    }
  }

  enforcePermissions(targetPath: string): void {
    if (!existsSync(targetPath)) return
    this.assertNoSymlinkBelowTrusted(targetPath)

    const stat = lstatSync(targetPath)
    if (stat.isDirectory()) {
      try {
        chmodSync(targetPath, 0o700)
      } catch (e) {
        if (process.platform !== 'win32') throw e
      }
      const entries = readdirSync(targetPath)
      for (const entry of entries) {
        this.enforcePermissions(path.join(targetPath, entry))
      }
    } else if (stat.isFile()) {
      try {
        chmodSync(targetPath, 0o600)
      } catch (e) {
        if (process.platform !== 'win32') throw e
      }
    }
  }

  private ensureStorageStructure(): void {
    this.assertNoSymlinkBelowTrusted(this.traceHome)
    this.assertNoSymlinkBelowTrusted(this.profilesDir)
    this.assertNoSymlinkBelowTrusted(this.recoveryDir)

    if (!existsSync(this.traceHome)) {
      mkdirSync(this.traceHome, { recursive: true, mode: 0o700 })
    }
    if (!existsSync(this.profilesDir)) {
      mkdirSync(this.profilesDir, { recursive: true, mode: 0o700 })
    }
    if (!existsSync(this.recoveryDir)) {
      mkdirSync(this.recoveryDir, { recursive: true, mode: 0o700 })
    }

    try {
      chmodSync(this.traceHome, 0o700)
      chmodSync(this.profilesDir, 0o700)
      chmodSync(this.recoveryDir, 0o700)
    } catch (e) {
      if (process.platform !== 'win32') throw e
    }
  }

  private checkPendingRecovery(): void {
    const journalPath = path.join(this.recoveryDir, 'journal.json')
    if (existsSync(journalPath)) {
      try {
        const raw = readFileSync(journalPath, 'utf8')
        const journal: RecoveryJournal = JSON.parse(raw)
        if (journal.status === 'in_progress' || journal.status === 'recovery_needed') {
          throw new Error('A pending profile recovery journal exists. Cannot perform profile operations until emergency recovery is completed.')
        }
      } catch (e: any) {
        if (e?.message?.startsWith('A pending profile recovery journal exists')) {
          throw e
        }
        throw new Error('A pending profile recovery journal exists. Cannot perform profile operations until emergency recovery is completed.')
      }
    }
  }

  // =========================================================================
  // Target Configuration Paths
  // =========================================================================

  private getClaudeSettingsPath(): string {
    return path.join(this.homeDir, '.claude', 'settings.json')
  }

  private getClaudeMcpPath(): string {
    return resolveMCPConfigPath('claude-code', 'global', { homeDir: this.homeDir })
  }

  private getCodexAuthPath(): string {
    return path.join(this.homeDir, '.codex', 'auth.json')
  }

  private getCodexConfigPath(): string {
    return resolveMCPConfigPath('codex', 'global', { homeDir: this.homeDir })
  }

  private getTraceDisabledMcpPath(): string {
    return getDisabledRegistryPath({ traceHome: this.traceHome })
  }

  private getSlotLivePath(slot: ProfileSlotName): string {
    switch (slot) {
      case 'claude_settings':
        return this.getClaudeSettingsPath()
      case 'claude_mcp':
        return this.getClaudeMcpPath()
      case 'codex_auth':
        return this.getCodexAuthPath()
      case 'codex_config':
        return this.getCodexConfigPath()
      case 'mcp_disabled':
        return this.getTraceDisabledMcpPath()
      default:
        throw new Error(`Slot ${slot} has no file target path.`)
    }
  }

  private getTargetFileHash(slot: ProfileSlotName): string | null {
    const target = this.getSlotLivePath(slot)
    if (existsSync(target)) {
      this.assertNoSymlinkBelowTrusted(target)
      return sha256(readFileSync(target))
    }
    return null
  }

  // =========================================================================
  // Safe Atomic File Writing
  // =========================================================================

  private atomicWriteFile(filePath: string, content: Buffer | string, mode = 0o600): void {
    this.assertNoSymlinkBelowTrusted(filePath)
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        chmodSync(dir, 0o700)
      } catch (e) {
        if (process.platform !== 'win32') throw e
      }
    }

    const tmpPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    try {
      writeFileSync(tmpPath, content, { mode })
      try {
        chmodSync(tmpPath, mode)
      } catch (e) {
        if (process.platform !== 'win32') throw e
      }
      renameSync(tmpPath, filePath)
    } finally {
      if (existsSync(tmpPath)) {
        try {
          rmSync(tmpPath, { force: true })
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  // =========================================================================
  // Public Metadata Query APIs
  // =========================================================================

  async listProfiles(): Promise<ProfileMetadata[]> {
    this.ensureStorageStructure()
    this.enforcePermissions(this.profilesDir)

    const entries = readdirSync(this.profilesDir)
    const list: ProfileMetadata[] = []

    for (const entry of entries) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue
      const profileDirPath = path.join(this.profilesDir, entry)

      try {
        const stat = lstatSync(profileDirPath)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue

        validateProfileId(entry)
        const manifestPath = path.join(profileDirPath, 'manifest.json')
        if (!existsSync(manifestPath)) continue

        const manifestStat = lstatSync(manifestPath)
        if (manifestStat.isSymbolicLink()) continue

        const manifestContent = readFileSync(manifestPath, 'utf8')
        const rawManifest = JSON.parse(manifestContent)
        const manifest = validateProfileManifest(rawManifest, entry)

        list.push(this.manifestToMetadata(manifest))
      } catch {
        // Skip invalid profile entries without leaking
      }
    }

    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list
  }

  async getProfile(id: string): Promise<ProfileMetadata | null> {
    validateProfileId(id)
    this.ensureStorageStructure()

    const profileDirPath = path.join(this.profilesDir, id)
    if (!existsSync(profileDirPath)) return null

    const stat = lstatSync(profileDirPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Invalid Profile ID.')
    }

    const manifestPath = path.join(profileDirPath, 'manifest.json')
    if (!existsSync(manifestPath)) return null

    const manifestContent = readFileSync(manifestPath, 'utf8')
    const rawManifest = JSON.parse(manifestContent)
    const manifest = validateProfileManifest(rawManifest, id)
    return this.manifestToMetadata(manifest)
  }

  private manifestToMetadata(manifest: ProfileManifest): ProfileMetadata {
    const claudeHasCredentials = Boolean(manifest.slots.claude_keychain?.present)
    const claudeHasModel = Boolean(manifest.slots.claude_settings?.present)
    const claudeHasMcp = Boolean(manifest.slots.claude_mcp?.present)

    const codexHasCredentials = Boolean(manifest.slots.codex_auth?.present)
    const codexHasModel = Boolean(manifest.slots.codex_config?.present)
    const codexHasMcp = Boolean(manifest.slots.codex_config?.present)

    const tools: ProfileToolSummary[] = [
      {
        tool: 'claude-code',
        hasCredentials: claudeHasCredentials,
        hasModelSettings: claudeHasModel,
        hasMcpConfig: claudeHasMcp,
      },
      {
        tool: 'codex',
        hasCredentials: codexHasCredentials,
        hasModelSettings: codexHasModel,
        hasMcpConfig: codexHasMcp,
      },
    ]

    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      tools,
    }
  }

  // =========================================================================
  // Capture Current Profile
  // =========================================================================

  async captureCurrentProfile(input: ProfileCaptureInput): Promise<ProfileMetadata> {
    if (this.isMutating) {
      throw new Error('Profile operation already in progress.')
    }
    this.isMutating = true

    try {
      this.ensureStorageStructure()
      this.checkPendingRecovery()
      validateProfileName(input.name)

      const id = generateProfileId()
      const stagingDir = path.join(this.profilesDir, `.staging_${id}_${Date.now()}`)
      this.assertNoSymlinkBelowTrusted(stagingDir)
      mkdirSync(stagingDir, { recursive: true, mode: 0o700 })

      try {
        const now = Date.now()
        const slots: Record<ProfileSlotName, ProfileSlotMetadata> = {
          claude_keychain: { slotName: 'claude_keychain', present: false },
          claude_settings: { slotName: 'claude_settings', present: false },
          claude_mcp: { slotName: 'claude_mcp', present: false },
          codex_auth: { slotName: 'codex_auth', present: false },
          codex_config: { slotName: 'codex_config', present: false },
          mcp_disabled: { slotName: 'mcp_disabled', present: false },
        }

        // 1. Claude Keychain
        if (this.keychain.isSupported) {
          try {
            const secretItem = await this.keychain.readSecret(
              this.claudeKeychainService,
              this.claudeKeychainAccount
            )
            if (secretItem && typeof secretItem.secret === 'string') {
              const binPath = path.join(stagingDir, SLOT_FILE_NAMES.claude_keychain)
              const secretBuffer = Buffer.from(secretItem.secret, 'utf8')
              this.atomicWriteFile(binPath, secretBuffer, 0o600)
              slots.claude_keychain = {
                slotName: 'claude_keychain',
                present: true,
                sha256: sha256(secretBuffer),
                size: secretBuffer.byteLength,
                mode: 0o600,
                keychainAccount: secretItem.account,
              }
            }
          } catch (err) {
            throw new Error(sanitizeErrorMessage(err, 'keychain capture'))
          }
        }

        // 2. Claude Model Settings (~/.claude/settings.json)
        const claudeSettingsPath = this.getClaudeSettingsPath()
        if (existsSync(claudeSettingsPath)) {
          this.assertNoSymlinkBelowTrusted(claudeSettingsPath)
          const raw = readFileSync(claudeSettingsPath, 'utf8')
          try {
            const parsed = JSON.parse(raw)
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Parsed settings is not an object')
            }
          } catch {
            throw new Error('Failed to capture Claude settings: invalid JSON configuration.')
          }

          const target = path.join(stagingDir, SLOT_FILE_NAMES.claude_settings)
          const rawBuffer = Buffer.from(raw, 'utf8')
          this.atomicWriteFile(target, rawBuffer, 0o600)
          slots.claude_settings = {
            slotName: 'claude_settings',
            present: true,
            sha256: sha256(rawBuffer),
            size: rawBuffer.byteLength,
            mode: 0o600,
          }
        }

        // 3. Claude MCP (~/.claude.json)
        const claudeMcpPath = this.getClaudeMcpPath()
        if (existsSync(claudeMcpPath)) {
          this.assertNoSymlinkBelowTrusted(claudeMcpPath)
          const raw = readFileSync(claudeMcpPath, 'utf8')
          let parsed: any
          try {
            parsed = JSON.parse(raw)
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Parsed config is not an object')
            }
          } catch {
            throw new Error('Failed to capture Claude MCP: invalid JSON configuration.')
          }

          if (parsed.mcpServers && typeof parsed.mcpServers !== 'object') {
            throw new Error('Failed to capture Claude MCP: mcpServers must be an object.')
          }

          const mcpServers = parsed.mcpServers || {}
          const payload = JSON.stringify({ mcpServers }, null, 2) + '\n'
          const target = path.join(stagingDir, SLOT_FILE_NAMES.claude_mcp)
          this.atomicWriteFile(target, Buffer.from(payload, 'utf8'), 0o600)
          slots.claude_mcp = {
            slotName: 'claude_mcp',
            present: true,
            sha256: sha256(payload),
            size: Buffer.byteLength(payload),
            mode: 0o600,
          }
        }

        // 4. Codex Credentials (~/.codex/auth.json)
        const codexAuthPath = this.getCodexAuthPath()
        if (existsSync(codexAuthPath)) {
          this.assertNoSymlinkBelowTrusted(codexAuthPath)
          const raw = readFileSync(codexAuthPath, 'utf8')
          try {
            const parsed = JSON.parse(raw)
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Parsed auth is not an object')
            }
          } catch {
            throw new Error('Failed to capture Codex auth: invalid JSON configuration.')
          }

          const target = path.join(stagingDir, SLOT_FILE_NAMES.codex_auth)
          const rawBuffer = Buffer.from(raw, 'utf8')
          this.atomicWriteFile(target, rawBuffer, 0o600)
          slots.codex_auth = {
            slotName: 'codex_auth',
            present: true,
            sha256: sha256(rawBuffer),
            size: rawBuffer.byteLength,
            mode: 0o600,
          }
        }

        // 5. Codex Config (~/.codex/config.toml)
        const codexConfigPath = this.getCodexConfigPath()
        if (existsSync(codexConfigPath)) {
          this.assertNoSymlinkBelowTrusted(codexConfigPath)
          const raw = readFileSync(codexConfigPath, 'utf8')
          try {
            const parsed = parseToml(raw)
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Parsed config is not an object')
            }
          } catch {
            throw new Error('Failed to capture Codex config: invalid TOML configuration.')
          }

          const target = path.join(stagingDir, SLOT_FILE_NAMES.codex_config)
          const rawBuffer = Buffer.from(raw, 'utf8')
          this.atomicWriteFile(target, rawBuffer, 0o600)
          slots.codex_config = {
            slotName: 'codex_config',
            present: true,
            sha256: sha256(rawBuffer),
            size: rawBuffer.byteLength,
            mode: 0o600,
          }
        }

        // 6. Trace Disabled MCP Registry
        const disabledPath = this.getTraceDisabledMcpPath()
        if (existsSync(disabledPath)) {
          this.assertNoSymlinkBelowTrusted(disabledPath)
          const raw = readFileSync(disabledPath, 'utf8')
          let parsed: any
          try {
            parsed = JSON.parse(raw)
            if (!parsed || typeof parsed !== 'object') {
              throw new Error('Parsed disabled registry is not an object')
            }
          } catch {
            throw new Error('Failed to capture disabled MCP registry: invalid JSON configuration.')
          }

          const filteredEntries: Record<string, unknown> = {}
          if (parsed.entries && typeof parsed.entries === 'object') {
            for (const [k, v] of Object.entries(parsed.entries)) {
              const item = v as any
              if (
                item &&
                item.scope === 'global' &&
                (item.sourceTool === 'claude-code' || item.sourceTool === 'codex')
              ) {
                filteredEntries[k] = v
              }
            }
          }
          const payload = JSON.stringify({ version: 1, entries: filteredEntries }, null, 2) + '\n'
          const target = path.join(stagingDir, SLOT_FILE_NAMES.mcp_disabled)
          this.atomicWriteFile(target, Buffer.from(payload, 'utf8'), 0o600)
          slots.mcp_disabled = {
            slotName: 'mcp_disabled',
            present: true,
            sha256: sha256(payload),
            size: Buffer.byteLength(payload),
            mode: 0o600,
          }
        }

        // Create Manifest
        const manifest: ProfileManifest = {
          version: 1,
          id,
          name: input.name.trim(),
          description: input.description?.trim(),
          createdAt: now,
          updatedAt: now,
          slots,
        }

        const validManifest = validateProfileManifest(manifest, id)
        const manifestRaw = JSON.stringify(validManifest, null, 2) + '\n'
        this.atomicWriteFile(path.join(stagingDir, 'manifest.json'), manifestRaw, 0o600)

        this.enforcePermissions(stagingDir)

        const destinationDir = path.join(this.profilesDir, id)
        renameSync(stagingDir, destinationDir)
        this.enforcePermissions(destinationDir)

        this.onProfileChanged?.()
        return this.manifestToMetadata(validManifest)
      } catch (err) {
        if (existsSync(stagingDir)) {
          rmSync(stagingDir, { recursive: true, force: true })
        }
        throw new Error(sanitizeErrorMessage(err, 'profile capture'))
      }
    } finally {
      this.isMutating = false
    }
  }

  // =========================================================================
  // Switch Profile with Durable Journal and Compensation
  // =========================================================================

  async switchProfile(id: string): Promise<ProfileSwitchResult> {
    if (this.isMutating) {
      throw new Error('Profile operation already in progress.')
    }
    this.isMutating = true

    try {
      this.ensureStorageStructure()
      this.checkPendingRecovery()
      validateProfileId(id)

      const profileDir = path.join(this.profilesDir, id)
      this.assertNoSymlinkBelowTrusted(profileDir)

      if (!existsSync(profileDir)) {
        throw new Error(`Profile not found: ${id}`)
      }

      const manifestPath = path.join(profileDir, 'manifest.json')
      if (!existsSync(manifestPath)) {
        throw new Error(`Profile corrupted: missing manifest for ${id}`)
      }

      const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const manifest = validateProfileManifest(rawManifest, id)

      this.validateProfileIntegrity(profileDir, manifest)

      const switchTimestamp = Date.now()
      const backupDir = path.join(this.recoveryDir, `backup_${switchTimestamp}`)
      mkdirSync(backupDir, { recursive: true, mode: 0o700 })

      // Step 1: Pre-switch backup BEFORE any mutation
      const backupManifest: BackupManifest = {
        version: 1,
        id: `backup_${switchTimestamp}`,
        profileId: id,
        createdAt: switchTimestamp,
        slots: {},
      }

      // If backup read fails (e.g. Keychain read denial), throws immediately before any mutation
      await this.capturePreSwitchBackup(backupDir, backupManifest)

      const previousCredential = backupManifest.slots.claude_keychain
      if (previousCredential?.wasPresent && typeof previousCredential.secret === 'string') {
        this.keychain.validateWrite?.(this.claudeKeychainService,
          previousCredential.account || this.claudeKeychainAccount || 'default', previousCredential.secret)
      }
      if (manifest.slots.claude_keychain.present) {
        this.keychain.validateWrite?.(this.claudeKeychainService,
          manifest.slots.claude_keychain.keychainAccount || this.claudeKeychainAccount || 'default',
          readFileSync(path.join(profileDir, SLOT_FILE_NAMES.claude_keychain), 'utf8'))
      }

      const baselineHashes: Record<string, string | null> = {
        claude_settings: this.getTargetFileHash('claude_settings'),
        claude_mcp: this.getTargetFileHash('claude_mcp'),
        codex_auth: this.getTargetFileHash('codex_auth'),
        codex_config: this.getTargetFileHash('codex_config'),
        mcp_disabled: this.getTargetFileHash('mcp_disabled'),
      }

      // Step 2: Write durable recovery journal
      const journalPath = path.join(this.recoveryDir, 'journal.json')
      const journal: RecoveryJournal = {
        version: 1,
        status: 'in_progress',
        operation: 'switch',
        profileId: id,
        targetProfileName: manifest.name,
        startedAt: switchTimestamp,
        backupDir,
        ownWrittenHashes: {},
        actionsApplied: [],
      }
      this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

      try {
        // Step 3a: Claude Keychain
        this.failureHooks.beforeSlotMutation?.('claude_keychain')
        if (manifest.slots.claude_keychain?.present) {
          if (!this.keychain.isSupported) {
            throw new Error(
              `Claude Code credentials require macOS Keychain ("${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}").`
            )
          }

          if (this.failureHooks.failBeforeKeychainWrite) {
            throw new Error('Injected failure: before keychain write')
          }

          const binPath = path.join(profileDir, SLOT_FILE_NAMES.claude_keychain)
          const secret = readFileSync(binPath, 'utf8')
          const targetAccount =
            manifest.slots.claude_keychain.keychainAccount || this.claudeKeychainAccount || 'default'

          // Journal attempted write BEFORE awaiting writeSecret to capture side-effects
          journal.actionsApplied.push({
            step: 'keychain',
            target: `${this.claudeKeychainService}:::${targetAccount}`,
            timestamp: Date.now(),
          })
          this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

          await this.keychain.writeSecret(this.claudeKeychainService, targetAccount, secret)

          // Delete old item if different account to avoid stale duplicates
          const oldAccount = backupManifest.slots.claude_keychain?.account
          if (
            backupManifest.slots.claude_keychain?.wasPresent &&
            oldAccount &&
            oldAccount !== targetAccount
          ) {
            await this.keychain.deleteSecret(this.claudeKeychainService, oldAccount)
          }

          if (this.failureHooks.failAfterKeychainWrite) {
            throw new Error('Injected failure: after keychain write')
          }
        } else {
          if (this.keychain.isSupported && backupManifest.slots.claude_keychain?.wasPresent) {
            const oldAccount = backupManifest.slots.claude_keychain.account
            journal.actionsApplied.push({
              step: 'keychain',
              target: `${this.claudeKeychainService}:::${oldAccount}`,
              timestamp: Date.now(),
            })
            this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

            await this.keychain.deleteSecret(this.claudeKeychainService, oldAccount)
          }
        }

        // Step 3b: Claude Settings
        this.verifyBaselineConflict('claude_settings', baselineHashes)
        await this.applyFileSlot(
          'claude_settings',
          this.getClaudeSettingsPath(),
          profileDir,
          manifest,
          journal,
          journalPath
        )

        // Step 3c: Claude MCP
        this.verifyBaselineConflict('claude_mcp', baselineHashes)
        await this.applyClaudeMcpSlot(profileDir, manifest, journal, journalPath)

        // Step 3d: Codex Auth
        this.verifyBaselineConflict('codex_auth', baselineHashes)
        await this.applyFileSlot(
          'codex_auth',
          this.getCodexAuthPath(),
          profileDir,
          manifest,
          journal,
          journalPath
        )

        // Step 3e: Codex Config
        this.verifyBaselineConflict('codex_config', baselineHashes)
        await this.applyFileSlot(
          'codex_config',
          this.getCodexConfigPath(),
          profileDir,
          manifest,
          journal,
          journalPath
        )

        // Step 3f: Trace Disabled MCP Registry
        this.verifyBaselineConflict('mcp_disabled', baselineHashes)
        await this.applyDisabledMcpSlot(profileDir, manifest, journal, journalPath)

        // Record post-switch state for rollback preflight
        journal.postSwitchKeychain = {
          account: manifest.slots.claude_keychain?.present
            ? (manifest.slots.claude_keychain.keychainAccount || this.claudeKeychainAccount || 'default')
            : undefined,
          sha256: manifest.slots.claude_keychain?.present ? manifest.slots.claude_keychain.sha256 : undefined,
          wasPresent: Boolean(manifest.slots.claude_keychain?.present),
        }

        journal.postSwitchHashes = {
          claude_settings: this.getTargetFileHash('claude_settings'),
          claude_mcp: this.getTargetFileHash('claude_mcp'),
          codex_auth: this.getTargetFileHash('codex_auth'),
          codex_config: this.getTargetFileHash('codex_config'),
          mcp_disabled: this.getTargetFileHash('mcp_disabled'),
        }

        journal.status = 'completed'
        journal.completedAt = Date.now()
        this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

        const pointerPath = path.join(this.recoveryDir, 'last_switch.json')
        this.atomicWriteFile(
          pointerPath,
          JSON.stringify({ profileId: id, backupDir, timestamp: switchTimestamp }, null, 2) + '\n',
          0o600
        )

        this.onProfileChanged?.()

        return {
          success: true,
          profileId: id,
          previousSnapshotId: `backup_${switchTimestamp}`,
          switchedAt: switchTimestamp,
        }
      } catch (switchError) {
        const sanitizedError = sanitizeErrorMessage(switchError, 'profile switch')
        journal.error = sanitizedError

        try {
          if (this.failureHooks.failDuringRollback) {
            throw new Error('Injected failure: during compensation rollback')
          }

          // Compensation mode: strictly restores only transaction-owned applied actions
          await this.executeCompensation(backupDir, backupManifest, journal, 'compensation')

          journal.status = 'rolled_back'
          this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

          return {
            success: false,
            profileId: id,
            switchedAt: switchTimestamp,
            error: sanitizedError,
            recoveryNeeded: false,
          }
        } catch (compensationError) {
          const sanitizedCompError = sanitizeErrorMessage(compensationError, 'compensation')
          journal.status = 'recovery_needed'
          journal.error = `${sanitizedError}; Rollback failed: ${sanitizedCompError}`
          this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

          return {
            success: false,
            profileId: id,
            switchedAt: switchTimestamp,
            error: sanitizedError,
            recoveryNeeded: true,
            recoveryDetails: `Emergency recovery required. Details: ${sanitizedCompError}`,
          }
        }
      }
    } finally {
      this.isMutating = false
    }
  }

  // =========================================================================
  // Rollback Last Switch (One-Click Exact Byte Restoration)
  // =========================================================================

  async rollbackLastSwitch(): Promise<ProfileRollbackResult> {
    if (this.isMutating) {
      throw new Error('Profile operation already in progress.')
    }
    this.isMutating = true

    try {
      this.ensureStorageStructure()

      const pointerPath = path.join(this.recoveryDir, 'last_switch.json')
      if (!existsSync(pointerPath)) {
        throw new Error('No previous profile switch found to rollback.')
      }

      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
      const backupDir = pointer.backupDir
      this.validateBackupDir(backupDir)

      const backupManifestPath = path.join(backupDir, 'backup_manifest.json')
      if (!existsSync(backupManifestPath)) {
        throw new Error('Backup manifest not found in backup directory.')
      }

      const backupManifest: BackupManifest = JSON.parse(readFileSync(backupManifestPath, 'utf8'))
      const journalPath = path.join(this.recoveryDir, 'journal.json')
      let lastJournal: RecoveryJournal | undefined

      // Preflight against recorded post-switch state
      if (existsSync(journalPath)) {
        try {
          lastJournal = JSON.parse(readFileSync(journalPath, 'utf8')) as RecoveryJournal

          // 1. Files preflight
          if (lastJournal.postSwitchHashes) {
            for (const [slot, expectedHash] of Object.entries(lastJournal.postSwitchHashes)) {
              if (!isSafeSlotName(slot)) continue
              const currentHash = this.getTargetFileHash(slot as ProfileSlotName)
              if (currentHash !== expectedHash) {
                throw new Error(`Rollback conflict: external modifications detected in ${slot} since switch.`)
              }
            }
          }

          // 2. Keychain preflight
          if (this.keychain.isSupported && lastJournal.postSwitchKeychain) {
            const { account, sha256: expectedHash, wasPresent } = lastJournal.postSwitchKeychain
            const currentItem = await this.keychain.readSecret(this.claudeKeychainService, account)
            if (wasPresent) {
              if (!currentItem) {
                throw new Error('Rollback conflict: keychain credential was deleted since switch.')
              }
              if (sha256(currentItem.secret) !== expectedHash) {
                throw new Error('Rollback conflict: external modifications detected in keychain since switch.')
              }
            } else {
              if (currentItem) {
                throw new Error('Rollback conflict: unexpected keychain credential created since switch.')
              }
            }
          }
        } catch (e: any) {
          if (e?.message?.startsWith('Rollback conflict:')) throw e
          throw new Error('Rollback conflict: keychain is locked or access denied.')
        }
      }

      const rollbackTimestamp = Date.now()
      const journal: RecoveryJournal = {
        version: 1,
        status: 'in_progress',
        operation: 'rollback',
        profileId: pointer.profileId,
        startedAt: rollbackTimestamp,
        backupDir,
        actionsApplied: lastJournal?.actionsApplied || [],
        postSwitchKeychain: lastJournal?.postSwitchKeychain,
      }
      this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

      try {
        if (this.failureHooks.failDuringRollback) {
          throw new Error('Injected failure: during explicit rollback')
        }

        // Rollback mode: unconditionally restores entire committed backup snapshot
        await this.executeCompensation(backupDir, backupManifest, journal, 'rollback')

        journal.status = 'rolled_back'
        journal.completedAt = Date.now()
        this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

        rmSync(pointerPath, { force: true })
        this.onProfileChanged?.()

        return {
          success: true,
          restoredSnapshotId: backupManifest.id,
          restoredAt: rollbackTimestamp,
        }
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err, 'rollback')
        journal.status = 'recovery_needed'
        journal.error = sanitized
        this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

        return {
          success: false,
          restoredAt: rollbackTimestamp,
          error: sanitized,
          recoveryNeeded: true,
          recoveryDetails: `Manual recovery required from backup directory: ${backupDir}`,
        }
      }
    } finally {
      this.isMutating = false
    }
  }

  // =========================================================================
  // Recovery Status & Emergency Recovery
  // =========================================================================

  async getRecoveryStatus(): Promise<ProfileRecoveryStatus> {
    this.ensureStorageStructure()
    const journalPath = path.join(this.recoveryDir, 'journal.json')
    if (!existsSync(journalPath)) {
      return { isRecoveryNeeded: false, journalExists: false }
    }

    try {
      const journal: RecoveryJournal = JSON.parse(readFileSync(journalPath, 'utf8'))
      const isRecoveryNeeded =
        journal.status === 'recovery_needed' || journal.status === 'in_progress'

      return {
        isRecoveryNeeded,
        journalExists: true,
        journalStatus: journal.status,
        interruptedOperation: journal.operation,
        profileId: journal.profileId,
        details: journal.error,
      }
    } catch {
      return {
        isRecoveryNeeded: true,
        journalExists: true,
        details: 'Unparseable or corrupted recovery journal.',
      }
    }
  }

  async performEmergencyRecovery(): Promise<ProfileRollbackResult> {
    if (this.isMutating) {
      throw new Error('Profile operation already in progress.')
    }
    this.isMutating = true

    try {
      this.ensureStorageStructure()
      const journalPath = path.join(this.recoveryDir, 'journal.json')
      if (!existsSync(journalPath)) {
        throw new Error('No recovery journal found.')
      }

      const journal: RecoveryJournal = JSON.parse(readFileSync(journalPath, 'utf8'))
      const backupDir = journal.backupDir
      this.validateBackupDir(backupDir)

      const backupManifestPath = path.join(backupDir, 'backup_manifest.json')
      if (!existsSync(backupManifestPath)) {
        throw new Error('Backup manifest not found in backup directory.')
      }

      const backupManifest: BackupManifest = JSON.parse(readFileSync(backupManifestPath, 'utf8'))

      await this.executeCompensation(backupDir, backupManifest, journal, 'rollback')

      journal.status = 'rolled_back'
      journal.completedAt = Date.now()
      this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

      const pointerPath = path.join(this.recoveryDir, 'last_switch.json')
      if (existsSync(pointerPath)) {
        rmSync(pointerPath, { force: true })
      }

      this.onProfileChanged?.()

      return {
        success: true,
        restoredSnapshotId: backupManifest.id,
        restoredAt: Date.now(),
      }
    } finally {
      this.isMutating = false
    }
  }

  // =========================================================================
  // Rename and Delete APIs
  // =========================================================================

  async renameProfile(id: string, newName: string): Promise<ProfileMetadata> {
    if (this.isMutating) {
      throw new Error('Profile operation already in progress.')
    }
    this.isMutating = true

    try {
      this.ensureStorageStructure()
      this.checkPendingRecovery()
      validateProfileId(id)
      validateProfileName(newName)

      const profileDir = path.join(this.profilesDir, id)
      this.assertNoSymlinkBelowTrusted(profileDir)

      const manifestPath = path.join(profileDir, 'manifest.json')
      if (!existsSync(manifestPath)) {
        throw new Error(`Profile not found: ${id}`)
      }

      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const manifest = validateProfileManifest(raw, id)
      manifest.name = newName.trim()
      manifest.updatedAt = Date.now()

      this.atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 0o600)
      this.onProfileChanged?.()

      return this.manifestToMetadata(manifest)
    } finally {
      this.isMutating = false
    }
  }

  async deleteProfile(id: string): Promise<void> {
    if (this.isMutating) {
      throw new Error('Profile operation already in progress.')
    }
    this.isMutating = true

    try {
      this.ensureStorageStructure()
      this.checkPendingRecovery()
      validateProfileId(id)

      const profileDir = path.join(this.profilesDir, id)
      if (!existsSync(profileDir)) return

      this.assertNoSymlinkBelowTrusted(profileDir)
      rmSync(profileDir, { recursive: true, force: true })
      this.onProfileChanged?.()
    } finally {
      this.isMutating = false
    }
  }

  // =========================================================================
  // Internal Helpers: Pre-switch Backup & Compensation
  // =========================================================================

  private async capturePreSwitchBackup(
    backupDir: string,
    backupManifest: BackupManifest
  ): Promise<void> {
    // 1. Claude Keychain: if read fails (e.g. access denied), throws immediately
    if (this.keychain.isSupported) {
      const item = await this.keychain.readSecret(
        this.claudeKeychainService,
        this.claudeKeychainAccount
      )

      if (item !== null) {
        backupManifest.slots.claude_keychain = {
          slotName: 'claude_keychain',
          wasPresent: true,
          account: item.account,
          secret: item.secret,
          sha256: sha256(item.secret),
        }
      } else {
        backupManifest.slots.claude_keychain = {
          slotName: 'claude_keychain',
          wasPresent: false,
        }
      }
    }

    // 2. Claude Settings
    this.backupFileTarget('claude_settings', this.getClaudeSettingsPath(), backupDir, backupManifest)

    // 3. Claude MCP (entire ~/.claude.json byte snapshot)
    this.backupFileTarget('claude_mcp', this.getClaudeMcpPath(), backupDir, backupManifest)

    // 4. Codex Auth
    this.backupFileTarget('codex_auth', this.getCodexAuthPath(), backupDir, backupManifest)

    // 5. Codex Config
    this.backupFileTarget('codex_config', this.getCodexConfigPath(), backupDir, backupManifest)

    // 6. Trace Disabled Registry
    this.backupFileTarget('mcp_disabled', this.getTraceDisabledMcpPath(), backupDir, backupManifest)

    const backupManifestRaw = JSON.stringify(backupManifest, null, 2) + '\n'
    this.atomicWriteFile(path.join(backupDir, 'backup_manifest.json'), backupManifestRaw, 0o600)
    this.enforcePermissions(backupDir)
  }

  private backupFileTarget(
    slotName: ProfileSlotName,
    targetPath: string,
    backupDir: string,
    manifest: BackupManifest
  ): void {
    if (existsSync(targetPath)) {
      this.assertNoSymlinkBelowTrusted(targetPath)
      const stat = lstatSync(targetPath)
      const raw = readFileSync(targetPath)
      const fileName = `${slotName}.bak`
      this.atomicWriteFile(path.join(backupDir, fileName), raw, 0o600)

      manifest.slots[slotName] = {
        slotName,
        targetPath,
        wasPresent: true,
        sha256: sha256(raw),
        mode: stat.mode & 0o777,
      }
    } else {
      manifest.slots[slotName] = {
        slotName,
        targetPath,
        wasPresent: false,
      }
    }
  }

  private verifyBaselineConflict(slotName: ProfileSlotName, baselineHashes: Record<string, string | null>): void {
    this.failureHooks.beforeSlotMutation?.(slotName)
    const currentHash = this.getTargetFileHash(slotName)
    if (currentHash !== baselineHashes[slotName]) {
      throw new Error(`Conflict detected: external modification to ${slotName} before write.`)
    }
  }

  private async applyFileSlot(
    slotName: ProfileSlotName,
    targetPath: string,
    profileDir: string,
    manifest: ProfileManifest,
    journal: RecoveryJournal,
    journalPath: string
  ): Promise<void> {
    const slot = manifest.slots[slotName]
    if (!slot) return

    if (this.failureHooks.failBeforeFileWrite?.(targetPath)) {
      throw new Error(`Injected failure: before writing file ${path.basename(targetPath)}`)
    }

    if (slot.present) {
      const sourceFile = path.join(profileDir, SLOT_FILE_NAMES[slotName])
      const content = readFileSync(sourceFile)

      journal.actionsApplied.push({
        step: 'file',
        target: targetPath,
        timestamp: Date.now(),
      })
      journal.ownWrittenHashes = journal.ownWrittenHashes || {}
      journal.ownWrittenHashes[slotName] = sha256(content)
      this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

      this.atomicWriteFile(targetPath, content, slot.mode || 0o600)
    } else {
      if (existsSync(targetPath)) {
        journal.actionsApplied.push({
          step: 'file',
          target: targetPath,
          timestamp: Date.now(),
        })
        this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

        rmSync(targetPath, { force: true })
      }
    }

    if (this.failureHooks.failAfterFileWrite?.(targetPath)) {
      throw new Error(`Injected failure: after writing file ${path.basename(targetPath)}`)
    }
  }

  private async applyClaudeMcpSlot(
    profileDir: string,
    manifest: ProfileManifest,
    journal: RecoveryJournal,
    journalPath: string
  ): Promise<void> {
    const targetPath = this.getClaudeMcpPath()
    const slot = manifest.slots.claude_mcp

    if (this.failureHooks.failBeforeFileWrite?.(targetPath)) {
      throw new Error('Injected failure: before writing claude mcp')
    }

    if (slot?.present) {
      const profileMcpFile = path.join(profileDir, SLOT_FILE_NAMES.claude_mcp)
      const profileMcpData = JSON.parse(readFileSync(profileMcpFile, 'utf8'))
      const profileServers = profileMcpData.mcpServers || {}

      let liveJson: Record<string, unknown> = {}
      if (existsSync(targetPath)) {
        this.assertNoSymlinkBelowTrusted(targetPath)
        try {
          liveJson = JSON.parse(readFileSync(targetPath, 'utf8'))
        } catch {
          liveJson = {}
        }
      }

      if (Object.keys(profileServers).length > 0) {
        liveJson.mcpServers = profileServers
      } else {
        delete liveJson.mcpServers
      }

      const updatedRaw = JSON.stringify(liveJson, null, 2) + '\n'

      journal.actionsApplied.push({
        step: 'file',
        target: targetPath,
        timestamp: Date.now(),
      })
      journal.ownWrittenHashes = journal.ownWrittenHashes || {}
      journal.ownWrittenHashes.claude_mcp = sha256(updatedRaw)
      this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

      this.atomicWriteFile(targetPath, updatedRaw, 0o600)
    } else {
      if (existsSync(targetPath)) {
        this.assertNoSymlinkBelowTrusted(targetPath)
        try {
          const liveJson = JSON.parse(readFileSync(targetPath, 'utf8'))
          if (liveJson.mcpServers) {
            delete liveJson.mcpServers
            const updated = JSON.stringify(liveJson, null, 2) + '\n'

            journal.actionsApplied.push({
              step: 'file',
              target: targetPath,
              timestamp: Date.now(),
            })
            journal.ownWrittenHashes = journal.ownWrittenHashes || {}
            journal.ownWrittenHashes.claude_mcp = sha256(updated)
            this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

            this.atomicWriteFile(targetPath, updated, 0o600)
          }
        } catch {
          // ignore
        }
      }
    }

    if (this.failureHooks.failAfterFileWrite?.(targetPath)) {
      throw new Error('Injected failure: after writing claude mcp')
    }
  }

  private async applyDisabledMcpSlot(
    profileDir: string,
    manifest: ProfileManifest,
    journal: RecoveryJournal,
    journalPath: string
  ): Promise<void> {
    const targetPath = this.getTraceDisabledMcpPath()
    const slot = manifest.slots.mcp_disabled
    if (!slot?.present) return

    if (this.failureHooks.failBeforeFileWrite?.(targetPath)) {
      throw new Error('Injected failure: before writing mcp-disabled.json')
    }

    const profileFile = path.join(profileDir, SLOT_FILE_NAMES.mcp_disabled)
    const profileJson = JSON.parse(readFileSync(profileFile, 'utf8'))
    const profileEntries = profileJson.entries || {}

    let liveJson: { version: number; entries: Record<string, unknown> } = {
      version: 1,
      entries: {},
    }

    if (existsSync(targetPath)) {
      this.assertNoSymlinkBelowTrusted(targetPath)
      try {
        liveJson = JSON.parse(readFileSync(targetPath, 'utf8'))
      } catch {
        liveJson = { version: 1, entries: {} }
      }
    }

    const mergedEntries: Record<string, unknown> = {}
    if (liveJson.entries && typeof liveJson.entries === 'object') {
      for (const [k, v] of Object.entries(liveJson.entries)) {
        const item = v as any
        if (
          item &&
          item.scope === 'global' &&
          (item.sourceTool === 'claude-code' || item.sourceTool === 'codex')
        ) {
          // Replaced by profile entries
        } else {
          mergedEntries[k] = v
        }
      }
    }

    for (const [k, v] of Object.entries(profileEntries)) {
      mergedEntries[k] = v
    }

    liveJson.entries = mergedEntries
    const payload = JSON.stringify(liveJson, null, 2) + '\n'

    journal.actionsApplied.push({
      step: 'file',
      target: targetPath,
      timestamp: Date.now(),
    })
    journal.ownWrittenHashes = journal.ownWrittenHashes || {}
    journal.ownWrittenHashes.mcp_disabled = sha256(payload)
    this.atomicWriteFile(journalPath, JSON.stringify(journal, null, 2) + '\n', 0o600)

    this.atomicWriteFile(targetPath, payload, 0o600)

    if (this.failureHooks.failAfterFileWrite?.(targetPath)) {
      throw new Error('Injected failure: after writing mcp-disabled.json')
    }
  }

  private validateBackupDir(backupDir: string): void {
    if (!backupDir || !existsSync(backupDir)) {
      throw new Error(`Previous switch backup directory is missing: ${backupDir}`)
    }

    this.assertNoSymlinkBelowTrusted(backupDir)
    const resolvedBackup = realpathSync(backupDir)
    const resolvedRecovery = realpathSync(this.recoveryDir)

    if (!resolvedBackup.startsWith(resolvedRecovery + path.sep)) {
      throw new Error(`Security violation: backup directory outside recovery storage: ${backupDir}`)
    }
  }

  /**
   * Restores components back to pre-switch backup state.
   * - 'compensation' mode: only restores transaction-owned applied actions; empty applied set leaves everything untouched.
   * - 'rollback' mode: restores whole committed backup snapshot.
   */
  private async executeCompensation(
    backupDir: string,
    backupManifest: BackupManifest,
    journal: RecoveryJournal,
    mode: 'compensation' | 'rollback'
  ): Promise<void> {
    this.validateBackupDir(backupDir)

    const fileSlots: ProfileSlotName[] = [
      'claude_settings',
      'claude_mcp',
      'codex_auth',
      'codex_config',
      'mcp_disabled',
    ]

    // Pre-validate backup files before touching targets
    for (const slotName of fileSlots) {
      const slotInfo = backupManifest.slots[slotName]
      if (slotInfo && slotInfo.wasPresent) {
        const backupFile = path.join(backupDir, `${slotName}.bak`)
        if (!existsSync(backupFile)) {
          throw new Error(`Recovery failed: missing backup file for slot ${slotName}`)
        }
        this.assertNoSymlinkBelowTrusted(backupFile)
        const raw = readFileSync(backupFile)
        if (slotInfo.sha256 && sha256(raw) !== slotInfo.sha256) {
          throw new Error(`Recovery failed: hash mismatch in backup file for slot ${slotName}`)
        }
      }
    }

    // In compensation mode, if nothing was applied, do not touch anything
    if (mode === 'compensation' && journal.actionsApplied.length === 0) {
      return
    }

    const appliedTargets = new Set(journal.actionsApplied.map((a) => a.target))

    // 1. Restore Claude Keychain
    const keychainSlot = backupManifest.slots.claude_keychain
    if (keychainSlot && this.keychain.isSupported) {
      const shouldRestoreKeychain =
        mode === 'rollback' || journal.actionsApplied.some((a) => a.step === 'keychain')

      if (shouldRestoreKeychain) {
        if (keychainSlot.wasPresent && typeof keychainSlot.secret === 'string') {
          await this.keychain.writeSecret(
            this.claudeKeychainService,
            keychainSlot.account || this.claudeKeychainAccount || 'default',
            keychainSlot.secret
          )

          // Delete switched account item if different
          const switchedAccount = journal.postSwitchKeychain?.account
          if (switchedAccount && switchedAccount !== keychainSlot.account) {
            await this.keychain.deleteSecret(this.claudeKeychainService, switchedAccount)
          }
        } else {
          const switchedAccount = journal.postSwitchKeychain?.account || this.claudeKeychainAccount
          if (switchedAccount) {
            await this.keychain.deleteSecret(this.claudeKeychainService, switchedAccount)
          }
        }
      }
    }

    // 2. Restore File Targets
    for (const slotName of fileSlots) {
      const livePath = this.getSlotLivePath(slotName)

      if (mode === 'compensation') {
        if (!appliedTargets.has(livePath)) {
          continue
        }
        // Verify external edit hasn't occurred after our own write
        if (journal.ownWrittenHashes?.[slotName] && existsSync(livePath)) {
          const current = sha256(readFileSync(livePath))
          if (current !== journal.ownWrittenHashes[slotName]) {
            throw new Error(`Conflict detected: external modification to ${slotName} after write.`)
          }
        }
      }

      const slotInfo = backupManifest.slots[slotName]
      if (slotInfo && slotInfo.wasPresent) {
        const backupFile = path.join(backupDir, `${slotName}.bak`)
        const raw = readFileSync(backupFile)
        this.atomicWriteFile(livePath, raw, slotInfo.mode || 0o600)
      } else {
        if (existsSync(livePath)) {
          rmSync(livePath, { force: true })
        }
      }
    }
  }

  private validateProfileIntegrity(profileDir: string, manifest: ProfileManifest): void {
    this.assertNoSymlinkBelowTrusted(profileDir)

    for (const slotName of PROFILE_SLOTS) {
      const slot = manifest.slots[slotName]
      if (slot.present) {
        const filename = SLOT_FILE_NAMES[slotName]
        const filePath = path.join(profileDir, filename)

        if (!existsSync(filePath)) {
          throw new Error(`Profile corrupted: missing slot file ${filename}`)
        }

        this.assertNoSymlinkBelowTrusted(filePath)
        const stat = lstatSync(filePath)
        if (!stat.isFile()) {
          throw new Error(`Profile corrupted: slot ${filename} must be a regular file.`)
        }

        const raw = readFileSync(filePath)
        if (slot.sha256 && sha256(raw) !== slot.sha256) {
          throw new Error(`Profile corrupted: hash mismatch for slot file ${filename}`)
        }
        if (slot.size !== undefined && raw.byteLength !== slot.size) {
          throw new Error(`Profile corrupted: size mismatch for slot file ${filename}`)
        }

        if (filename.endsWith('.json')) {
          try {
            JSON.parse(raw.toString('utf8'))
          } catch {
            throw new Error(`Profile corrupted: invalid JSON content in ${filename}`)
          }
        } else if (filename.endsWith('.toml')) {
          try {
            parseToml(raw.toString('utf8'))
          } catch {
            throw new Error(`Profile corrupted: invalid TOML content in ${filename}`)
          }
        }
      }
    }
  }
}
