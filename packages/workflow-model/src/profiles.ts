/**
 * Profile Architecture Types & Security Protocols (OPC-48)
 *
 * Defines data structures and validation schemas for AI developer profile
 * management across Claude Code and OpenAI Codex.
 *
 * A Profile represents a coherent group containing:
 * 1. Credentials (macOS Keychain for Claude Code, auth.json for Codex)
 * 2. Model settings (settings.json for Claude Code, config.toml for Codex)
 * 3. MCP configuration (~/.claude.json mcpServers, config.toml MCP for Codex)
 *
 * All renderer-facing structures are strictly metadata-only. Raw secrets, tokens,
 * or unfiltered stderr/exception text are forbidden from crossing IPC boundaries.
 */

export type ProfileTool = 'claude-code' | 'codex'

export const PROFILE_SUPPORTED_TOOLS: readonly ProfileTool[] = [
  'claude-code',
  'codex',
] as const

export const PROFILE_SLOTS = [
  'claude_keychain',
  'claude_settings',
  'claude_mcp',
  'codex_auth',
  'codex_config',
  'mcp_disabled',
] as const

export type ProfileSlotName = (typeof PROFILE_SLOTS)[number]

/**
 * Fixed slot file names in ~/.trace/profiles/<id>/
 */
export const SLOT_FILE_NAMES: Readonly<Record<ProfileSlotName, string>> = Object.freeze({
  claude_keychain: 'claude_keychain.bin',
  claude_settings: 'claude_settings.json',
  claude_mcp: 'claude_mcp.json',
  codex_auth: 'codex_auth.json',
  codex_config: 'codex_config.toml',
  mcp_disabled: 'mcp_disabled.json',
})

export interface ProfileToolSummary {
  tool: ProfileTool
  hasCredentials: boolean
  hasModelSettings: boolean
  hasMcpConfig: boolean
}

/**
 * Renderer-safe metadata representing a saved profile.
 * Contains no credentials, keys, or raw configurations.
 */
export interface ProfileMetadata {
  id: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
  tools: ProfileToolSummary[]
}

/**
 * Input required to capture the active system state into a new profile.
 */
export interface ProfileCaptureInput {
  name: string
  description?: string
}

export interface ProfileManagementAPI {
  listProfiles(): Promise<ProfileMetadata[]>
  captureProfile(input: ProfileCaptureInput): Promise<ProfileMetadata>
  switchProfile(id: string): Promise<ProfileSwitchResult>
  rollbackProfile(): Promise<ProfileRollbackResult>
  getProfileRecoveryStatus(): Promise<ProfileRecoveryStatus>
  recoverProfile(): Promise<ProfileRollbackResult>
  onProfilesChanged?(listener: () => void): () => void
}

/**
 * Result of a profile switch operation.
 */
export interface ProfileSwitchResult {
  success: boolean
  profileId: string
  previousSnapshotId?: string
  switchedAt: number
  error?: string
  recoveryNeeded?: boolean
  recoveryDetails?: string
}

/**
 * Result of rolling back the last switch operation.
 */
export interface ProfileRollbackResult {
  success: boolean
  restoredSnapshotId?: string
  restoredAt: number
  error?: string
  recoveryNeeded?: boolean
  recoveryDetails?: string
}

/**
 * Detailed metadata for an individual configuration slot in storage.
 */
export interface ProfileSlotMetadata {
  slotName: ProfileSlotName
  present: boolean
  sha256?: string
  size?: number
  mode?: number
  keychainAccount?: string
}

/**
 * Persisted manifest schema for stored profiles in ~/.trace/profiles/<id>/manifest.json.
 */
export interface ProfileManifest {
  version: 1
  id: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
  slots: Record<ProfileSlotName, ProfileSlotMetadata>
}

/**
 * Status report on durable recovery journal.
 */
export interface ProfileRecoveryStatus {
  isRecoveryNeeded: boolean
  journalExists: boolean
  journalStatus?: 'in_progress' | 'completed' | 'rolled_back' | 'recovery_needed'
  interruptedOperation?: 'switch' | 'rollback'
  profileId?: string
  details?: string
}

// =========================================================================
// Validation & Security Helpers
// =========================================================================

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{4,64}$/
const SHA256_REGEX = /^[0-9a-f]{64}$/

/**
 * Validates profile name against path traversal, control chars, and excessive lengths.
 */
export function validateProfileName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Profile name must be a non-empty string.')
  }
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new Error('Profile name length must be between 1 and 100 characters.')
  }
  if (trimmed === '__proto__' || trimmed === 'constructor' || trimmed === 'prototype') {
    throw new Error('Profile name cannot use reserved object property names.')
  }
  if (/[/\\:\x00-\x1f\x7f]/.test(trimmed) || trimmed.includes('..')) {
    throw new Error('Profile name cannot contain path separators, control characters, or path traversal sequences.')
  }
}

/**
 * Validates backend-generated or referenced profile ID.
 * Strict alphanumeric, dashes, underscores only.
 */
export function validateProfileId(id: string): void {
  if (!id || typeof id !== 'string') {
    throw new Error('Profile ID must be a non-empty string.')
  }
  if (!SAFE_ID_REGEX.test(id) || id.includes('..')) {
    throw new Error('Invalid Profile ID. ID must be 4-64 alphanumeric characters, underscores, or hyphens.')
  }
}

/**
 * Checks whether a slot name belongs to the fixed allowlist.
 */
export function isSafeSlotName(slot: string): slot is ProfileSlotName {
  return (PROFILE_SLOTS as readonly string[]).includes(slot)
}

/**
 * Generates an opaque, path-safe, non-guessable profile ID.
 */
export function generateProfileId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `prof_${timestamp}_${random}`
}

/**
 * Validates full ProfileManifest integrity.
 * Strictly verifies schema version, ID, name, and exact presence of all 6 slots.
 */
export function validateProfileManifest(manifest: unknown, expectedId?: string): ProfileManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Profile corrupted: manifest must be an object.')
  }

  const m = manifest as Partial<ProfileManifest>
  if (m.version !== 1) {
    throw new Error('Profile corrupted: unsupported manifest version.')
  }

  if (!m.id || typeof m.id !== 'string') {
    throw new Error('Profile corrupted: manifest missing valid id.')
  }
  validateProfileId(m.id)

  if (expectedId && m.id !== expectedId) {
    throw new Error(`Profile corrupted: manifest ID "${m.id}" does not match expected ID "${expectedId}".`)
  }

  if (!m.name || typeof m.name !== 'string') {
    throw new Error('Profile corrupted: manifest missing valid name.')
  }
  validateProfileName(m.name)

  if (!m.slots || typeof m.slots !== 'object') {
    throw new Error('Profile corrupted: manifest missing slots object.')
  }

  // Enforce that ALL known slots exist in the manifest
  for (const slotName of PROFILE_SLOTS) {
    const slot = m.slots[slotName]
    if (!slot || typeof slot !== 'object') {
      throw new Error(`Profile corrupted: truncated manifest, missing slot definition for "${slotName}".`)
    }

    if (slot.slotName !== slotName) {
      throw new Error(`Profile corrupted: slot "${slotName}" has mismatched slotName "${slot.slotName}".`)
    }

    if (typeof slot.present !== 'boolean') {
      throw new Error(`Profile corrupted: slot "${slotName}" missing boolean present flag.`)
    }

    if (slot.present) {
      if (!slot.sha256 || typeof slot.sha256 !== 'string' || !SHA256_REGEX.test(slot.sha256)) {
        throw new Error(`Profile corrupted: slot "${slotName}" missing valid sha256 hash.`)
      }
      if (typeof slot.size !== 'number' || !Number.isInteger(slot.size) || slot.size < 0) {
        throw new Error(`Profile corrupted: slot "${slotName}" missing valid size.`)
      }
    }
  }

  // Ensure no unknown slot keys are present
  for (const key of Object.keys(m.slots)) {
    if (!isSafeSlotName(key)) {
      throw new Error(`Profile corrupted: unauthorized slot "${key}" in manifest.`)
    }
  }

  return m as ProfileManifest
}

const SAFE_ERROR_PREFIXES = [
  'Security violation:',
  'Invalid Profile',
  'Profile name',
  'Profile not found',
  'Profile corrupted:',
  'Conflict detected:',
  'Rollback conflict:',
  'A pending profile recovery journal exists',
  'Profile operation already in progress',
  'Cannot perform emergency recovery',
  'No previous profile switch found',
  'Backup manifest',
  'Previous switch backup',
  'Claude Code credentials require macOS Keychain',
  'Keychain authorization was canceled',
  'Keychain access denied or keychain is locked',
  'Injected failure:',
  'Failed to capture Claude settings: invalid JSON configuration.',
  'Failed to capture Claude MCP: invalid JSON configuration.',
  'Failed to capture Claude MCP: mcpServers must be an object.',
  'Failed to capture Codex auth: invalid JSON configuration.',
  'Failed to capture Codex config: invalid TOML configuration.',
  'Failed to capture disabled MCP registry: invalid JSON configuration.',
]

/**
 * Sanitizes error messages by using static safe prefixes or generic messages.
 * Never leaks raw credentials, filesystem errors, or unknown exception text.
 */
export function sanitizeErrorMessage(error: unknown, fallbackAction?: string): string {
  if (!error) return 'An unknown error occurred.'

  if (error instanceof Error && typeof error.message === 'string') {
    for (const prefix of SAFE_ERROR_PREFIXES) {
      if (error.message.startsWith(prefix)) {
        return error.message
      }
    }
  }

  const action = fallbackAction ? ` during ${fallbackAction}` : ''
  return `Operation failed${action}. System details redacted for security.`
}
