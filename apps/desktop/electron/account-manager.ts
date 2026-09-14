/**
 * AI Tool Account Manager (OPC-48)
 *
 * Implements transaction-safe account capture, import, switching, rollback, and recovery
 * across AI developer tools (Google Antigravity, OpenAI Codex, Claude Code).
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  type AccountActionResult,
  type AccountDiscoveryResult,
  type AccountDiscoveryStatus,
  type AccountManagementAPI,
  type AccountMetadata,
  type AccountOAuthAPI,
  type AccountTool,
  type AccountToolCapability,
  type AccountToolState,
  type AccountRefreshState,
  type AccountRefreshStatus,
  type AccountsOverview,
  type StoredAccountRecord,
  ACCOUNT_TOOLS,
  AccountError,
  sanitizeErrorMessage,
  validateAccountId,
  validateAccountName,
  validateAccountTool,
} from '../../../packages/workflow-model/src/accounts.ts'
import { AccountStore, hasLegacyProfiles } from './account-store.ts'
import { AccountQuotaService } from './account-quota.ts'
import {
  AccountRefreshService,
  type AccountRefreshReason,
} from './account-refresh.ts'

export type {
  AccountRefreshState,
  AccountRefreshStatus,
  AccountRefreshReason,
}
import {
  type AccountAdapter,
  type AccountProjection,
  type InspectedCredential,
  createAccountAdapters,
} from './account-adapters.ts'

export const MAX_TRANSACTION_FILE_SIZE = 64 * 1024 * 1024 // 64 MiB

export const KNOWN_SLOTS: Record<AccountTool, readonly string[]> = {
  codex: ['auth', 'mode'],
  'claude-code': ['oauth'],
  antigravity: ['oauth'],
} as const

interface AccountAdapterWithMatching extends AccountAdapter {
  readCurrentCredential?(): string | null
  matchesIdentity?(leftCredential: string, rightCredential: string): boolean
  mergeCredential?(incomingCredential: string, storedCredential: string): string
}

function matchesAccountIdentity(
  adapter: AccountAdapter,
  leftCredential: string,
  rightCredential: string
): boolean {
  const ext = adapter as AccountAdapterWithMatching
  if (typeof ext.matchesIdentity === 'function') {
    return ext.matchesIdentity(leftCredential, rightCredential)
  }
  const leftInspected = adapter.inspect(leftCredential)
  const rightInspected = adapter.inspect(rightCredential)
  return leftInspected.identityKey === rightInspected.identityKey
}

const TOOL_DEFAULT_LABELS: Record<AccountTool, string> = {
  antigravity: 'Google Antigravity',
  codex: 'OpenAI Codex',
  'claude-code': 'Claude Code',
}

function deriveDefaultAccountName(tool: AccountTool, email?: string, accountId?: string): string {
  const candidate = email?.trim() || accountId?.trim()
  if (candidate) {
    let sanitized = candidate
      .replace(/[/\\:]/g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\.\./g, '__')
      .trim()
    if (sanitized.length > 100) {
      sanitized = sanitized.slice(0, 100).trim()
    }
    try {
      return validateAccountName(sanitized)
    } catch {
      // Fall through to stable tool label
    }
  }
  return TOOL_DEFAULT_LABELS[tool] || tool
}

export interface AccountTransactionJournal {
  version: 1
  tool: AccountTool
  phase: 'pending' | 'complete'
  before: AccountProjection
  after: AccountProjection
  previousAccountId?: string
  selectedAccountId?: string
  previousComplete?: AccountTransactionJournal
}

export interface AccountManagerOptions {
  homeDir?: string
  traceHome?: string
  codexHome?: string
  env?: NodeJS.ProcessEnv
  antigravityFileMode?: boolean
  adapters?: Record<AccountTool, AccountAdapter>
  onAccountsChanged?: () => void
  /** Override only for isolated quota verification; production uses the native fetch. */
  quotaFetch?: typeof globalThis.fetch
  beforeWrite?: (tool: AccountTool, slot: string, index: number) => void
  refreshFetch?: typeof globalThis.fetch
  now?: () => number
}

export class AccountManager implements Omit<AccountManagementAPI, keyof AccountOAuthAPI> {
  public readonly homeDir: string
  public readonly traceHome: string
  public readonly transactionsDir: string
  public readonly store: AccountStore
  public readonly adapters: Record<AccountTool, AccountAdapter>
  private readonly quotas: AccountQuotaService
  private readonly refreshService: AccountRefreshService
  private readonly onAccountsChangedOption?: () => void
  private readonly beforeWrite?: (tool: AccountTool, slot: string, index: number) => void
  private readonly changeListeners: Set<() => void> = new Set()
  private readonly now: () => number
  private mutationLock: Promise<void> = Promise.resolve()

  constructor(options?: AccountManagerOptions) {
    this.now = options?.now ?? Date.now
    this.homeDir = options?.homeDir ? path.resolve(options.homeDir) : os.homedir()
    this.traceHome = options?.traceHome ? path.resolve(options.traceHome) : path.join(this.homeDir, '.trace')

    if (path.relative(this.homeDir, this.traceHome).startsWith('..')) {
      throw new AccountError('Security violation: traceHome must be located within homeDir.')
    }
    this.assertSafePath(this.traceHome)

    this.transactionsDir = path.join(this.traceHome, 'account-transactions')
    this.store = new AccountStore({ homeDir: this.homeDir, traceHome: this.traceHome })
    this.onAccountsChangedOption = options?.onAccountsChanged
    this.beforeWrite = options?.beforeWrite
    this.quotas = new AccountQuotaService({
      store: this.store,
      fetch: options?.quotaFetch,
      onChanged: () => this.notifyChanged(),
    })

    this.adapters = options?.adapters ?? createAccountAdapters({
      homeDir: this.homeDir,
      env: options?.env,
      codexHome: options?.codexHome,
      antigravityFileMode: options?.antigravityFileMode,
    })

    this.refreshService = new AccountRefreshService({
      store: this.store,
      adapters: this.adapters,
      quotas: this.quotas,
      notifyChanged: () => this.notifyChanged(),
      withMutationLock: (action) => this.withMutationLock(action),
      readJournalSafely: (tool) => this.readJournalSafely(tool),
      fetch: options?.refreshFetch,
      now: options?.now,
    })
  }

  private assertSafePath(targetPath: string): void {
    const resolved = path.resolve(targetPath)
    const relHome = path.relative(this.homeDir, resolved)
    if (!relHome || relHome.startsWith('..') || path.isAbsolute(relHome)) {
      throw new AccountError('Security violation: path traversal outside home directory.')
    }

    let current = this.homeDir
    const segments = relHome.split(path.sep).filter(Boolean)
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i])
      let stat
      try {
        stat = lstatSync(current)
      } catch (err: any) {
        if (err?.code === 'ENOENT') continue
        throw err
      }
      if (stat.isSymbolicLink()) {
        throw new AccountError('Security violation: symbolic link detected in transaction path.')
      }
      if (i === segments.length - 1) {
        if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
          throw new AccountError('Security violation: non-regular file or hard link detected.')
        }
      } else if (!stat.isDirectory()) {
        throw new AccountError('Security violation: intermediate path is not a directory.')
      }
    }
  }

  private ensureTransactionsDir(): void {
    this.assertSafePath(this.traceHome)
    let current = this.homeDir
    for (const part of path.relative(this.homeDir, this.traceHome).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err
      }
    }
    chmodSync(this.traceHome, 0o700)

    this.assertSafePath(this.transactionsDir)
    if (!existsSync(this.transactionsDir)) {
      mkdirSync(this.transactionsDir, { mode: 0o700, recursive: true })
    }
    chmodSync(this.transactionsDir, 0o700)
  }

  private validateJournal(data: unknown, tool: AccountTool): AccountTransactionJournal {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AccountError('Transaction journal corrupted: not an object.')
    }
    const o = data as Record<string, unknown>
    if (o.version !== 1 || o.tool !== tool || (o.phase !== 'pending' && o.phase !== 'complete')) {
      throw new AccountError('Transaction journal corrupted: invalid version, tool, or phase.')
    }
    if (!o.before || typeof o.before !== 'object' || Array.isArray(o.before) ||
        !o.after || typeof o.after !== 'object' || Array.isArray(o.after)) {
      throw new AccountError('Transaction journal corrupted: invalid before/after projection.')
    }

    const expectedSlots = KNOWN_SLOTS[tool]
    const beforeKeys = Object.keys(o.before)
    const afterKeys = Object.keys(o.after)

    if (
      beforeKeys.length !== expectedSlots.length ||
      !expectedSlots.every((s) => s in (o.before as object)) ||
      afterKeys.length !== expectedSlots.length ||
      !expectedSlots.every((s) => s in (o.after as object))
    ) {
      throw new AccountError('Transaction journal corrupted: mismatched or unknown projection slot keys.')
    }

    const cleanBefore: AccountProjection = {}
    for (const slot of expectedSlots) {
      const v = (o.before as Record<string, unknown>)[slot]
      if (v !== null && typeof v !== 'string') {
        throw new AccountError('Transaction journal corrupted: slot value must be string or null.')
      }
      cleanBefore[slot] = v
    }

    const cleanAfter: AccountProjection = {}
    for (const slot of expectedSlots) {
      const v = (o.after as Record<string, unknown>)[slot]
      if (v !== null && typeof v !== 'string') {
        throw new AccountError('Transaction journal corrupted: slot value must be string or null.')
      }
      cleanAfter[slot] = v
    }

    let previousComplete: AccountTransactionJournal | undefined
    if (o.previousComplete !== undefined) {
      if (o.phase !== 'pending' || !o.previousComplete || typeof o.previousComplete !== 'object' || 'previousComplete' in o.previousComplete) {
        throw new AccountError('Transaction journal corrupted: invalid nested previous transaction.')
      }
      previousComplete = this.validateJournal(o.previousComplete, tool)
      if (previousComplete.phase !== 'complete') {
        throw new AccountError('Transaction journal corrupted: previousComplete must have complete phase.')
      }
    }

    return {
      version: 1,
      tool,
      phase: o.phase,
      before: cleanBefore,
      after: cleanAfter,
      previousAccountId: o.previousAccountId ? validateAccountId(o.previousAccountId) : undefined,
      selectedAccountId: o.selectedAccountId ? validateAccountId(o.selectedAccountId) : undefined,
      previousComplete,
    }
  }

  private journalPath(tool: AccountTool): string {
    // Never replay legacy CLI-file transactions into the native credential item.
    const key = tool === 'antigravity' && this.adapters[tool]?.journalKey === 'antigravity-native'
      ? 'antigravity-native' : tool
    return path.join(this.transactionsDir, `${key}.json`)
  }

  private readJournalSafely(tool: AccountTool): {
    journal?: AccountTransactionJournal
    corrupted: boolean
    error?: string
  } {
    const targetPath = this.journalPath(tool)
    try {
      this.assertSafePath(targetPath)
      const stat = lstatSync(targetPath)
      if (!stat.isFile() || stat.nlink !== 1) {
        return { corrupted: true, error: 'Transaction journal is not a regular file.' }
      }
      if (stat.size === 0 || stat.size > MAX_TRANSACTION_FILE_SIZE) {
        return { corrupted: true, error: 'Transaction journal file size is invalid.' }
      }
      const raw = readFileSync(targetPath, 'utf8')
      const parsed = JSON.parse(raw)
      return { journal: this.validateJournal(parsed, tool), corrupted: false }
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { corrupted: false }
      return { corrupted: true, error: sanitizeErrorMessage(err) }
    }
  }

  private atomicWrite(targetPath: string, data: unknown): void {
    this.ensureTransactionsDir()
    this.assertSafePath(targetPath)

    const content = JSON.stringify(data, null, 2)
    if (Buffer.byteLength(content) > MAX_TRANSACTION_FILE_SIZE) {
      throw new AccountError('Transaction journal exceeds maximum permitted size of 64 MiB.')
    }

    const tempPath = path.join(this.transactionsDir, `.trace-tx-${randomUUID()}.tmp`)
    try {
      writeFileSync(tempPath, content, { mode: 0o600, flag: 'wx' })
      this.assertSafePath(targetPath)
      renameSync(tempPath, targetPath)
    } finally {
      rmSync(tempPath, { force: true })
    }
  }

  private removeFileSafely(targetPath: string): void {
    try {
      this.assertSafePath(targetPath)
      rmSync(targetPath, { force: true })
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  private async withMutationLock<T>(action: () => Promise<T> | T): Promise<T> {
    const prev = this.mutationLock
    let release!: () => void
    const next = new Promise<void>((r) => { release = r })
    this.mutationLock = prev.then(() => next)
    await prev
    try {
      return await action()
    } finally {
      release()
    }
  }

  private notifyChanged(): void {
    try { this.onAccountsChangedOption?.() } catch {}
    for (const listener of this.changeListeners) {
      try { listener() } catch {}
    }
  }

  onAccountsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  async refreshDueAccounts(): Promise<void> {
    return this.refreshService.refreshDueAccounts()
  }

  hasActiveRefreshes(): boolean { return this.refreshService.hasActiveRefreshes() }

  dispose(): void {
    this.refreshService.dispose()
  }

  async ensureFreshCredential(
    id: string,
    options?: { force?: boolean }
  ): Promise<AccountRefreshState> {
    return this.refreshService.ensureFresh(id, options)
  }

  async authorizeAntigravityKeychain(): Promise<void> {
    return this.withMutationLock(() => {
      const adapter = this.adapters.antigravity
      if (!adapter.authorizeAccess) throw new AccountError('此环境不使用 Antigravity 原生钥匙串。')
      adapter.authorizeAccess()
      this.notifyChanged()
    })
  }

  async getOverview(): Promise<AccountsOverview> {
    const accounts = await this.store.list()
    const legacyProfilesPresent = hasLegacyProfiles(this.traceHome)
    const capabilities: AccountToolCapability[] = []
    const tools: AccountToolState[] = []

    for (const tool of ACCOUNT_TOOLS) {
      const adapter = this.adapters[tool]
      if (!adapter) {
        capabilities.push({ tool, available: false, reason: `Adapter for ${tool} not found.` })
        tools.push({ tool, canRollback: false, recoveryNeeded: false })
        continue
      }

      let cap: AccountToolCapability
      try {
        cap = adapter.capability()
      } catch (err) {
        cap = { tool, available: false, reason: sanitizeErrorMessage(err) }
      }
      capabilities.push(cap)

      const journalInfo = this.readJournalSafely(tool)
      const recoveryNeeded = journalInfo.corrupted || journalInfo.journal?.phase === 'pending'
      const canRollback =
        !journalInfo.corrupted &&
        journalInfo.journal?.phase === 'complete' &&
        !!journalInfo.journal.before &&
        Object.keys(journalInfo.journal.before).length > 0

      let error = journalInfo.error
      let activeAccountId: string | undefined
      let activeIdentity: string | undefined

      try {
        let currentCred: string | null = null

        if (cap.available) {
          try {
            const ext = adapter as AccountAdapterWithMatching
            if (typeof ext.readCurrentCredential === 'function') {
              currentCred = ext.readCurrentCredential()
            } else {
              currentCred = adapter.credentialFrom(adapter.read())
            }
          } catch (readError) {
            error ||= sanitizeErrorMessage(readError)
          }
        }

        if (currentCred) {
          let inspected = adapter.inspect(currentCred)

          let matchedAccount: AccountMetadata | undefined

          if (journalInfo.journal?.selectedAccountId) {
            try {
              const sel = await this.store.get(journalInfo.journal.selectedAccountId)
              if (matchesAccountIdentity(adapter, sel.credential, currentCred)) {
                matchedAccount = sel.metadata
              }
            } catch {}
          }

          if (!matchedAccount) {
            for (const acc of accounts) {
              if (acc.tool === tool) {
                try {
                  const rec = await this.store.get(acc.id)
                  if (matchesAccountIdentity(adapter, rec.credential, currentCred)) {
                    matchedAccount = rec.metadata
                    break
                  }
                } catch {}
              }
            }
          }

          // A separate OAuth grant for the same Google account has different tokens.
          // Resolve native identity only when direct credential matching was insufficient.
          if (!matchedAccount && adapter.enrichCredential) {
            currentCred = await adapter.enrichCredential(currentCred)
            inspected = adapter.inspect(currentCred)
            for (const acc of accounts) {
              if (acc.tool !== tool) continue
              try {
                const rec = await this.store.get(acc.id)
                if (matchesAccountIdentity(adapter, rec.credential, currentCred)) {
                  matchedAccount = rec.metadata
                  break
                }
              } catch {}
            }
          }

          if (matchedAccount) {
            activeAccountId = matchedAccount.id
            activeIdentity = matchedAccount.email || matchedAccount.name
          } else {
            activeAccountId = undefined
            activeIdentity = inspected.email || inspected.accountId
          }
        }
      } catch (err) {
        if (!error) error = sanitizeErrorMessage(err)
      }

      tools.push({
        tool,
        activeAccountId,
        activeIdentity,
        canRollback,
        recoveryNeeded,
        error,
      })
    }

    const refreshes = this.refreshService.getRefreshStates(accounts)
    return { accounts, quotas: this.quotas.getCached(accounts), tools, capabilities, legacyProfilesPresent, refreshes }
  }

  async refreshQuota(id: string) {
    const validId = validateAccountId(id)
    await this.ensureFreshCredential(validId)
    let snapshot = await this.quotas.refreshAccount(validId)
    if (snapshot.status === 'expired') {
      const refreshed = await this.ensureFreshCredential(validId, { force: true })
      if (refreshed.status === 'ready') {
        snapshot = await this.quotas.refreshAccount(validId)
      }
    }
    return snapshot
  }

  /**
   * Consolidated locked upsert logic for captureAccount, importAccount, and saveAuthenticatedAccount.
   * Clears suppression, matches existing accounts via matchesAccountIdentity,
   * merges via optional mergeCredential, preserves custom names, and updates atomically.
   */
  private async upsertAccountInternal(
    tool: AccountTool,
    incomingCredential: string,
    customName?: string,
    actionLabel = 'save'
  ): Promise<AccountMetadata> {
    const validTool = validateAccountTool(tool)
    if (typeof incomingCredential !== 'string' || incomingCredential.length === 0) {
      throw new AccountError('Credential payload must be a non-empty string.')
    }
    let validatedCustomName: string | undefined
    if (customName !== undefined) {
      validatedCustomName = validateAccountName(customName)
    }

    const adapter = this.adapters[validTool]
    if (!adapter) throw new AccountError(`Tool adapter not available for ${validTool}.`)

    const incomingInspected = adapter.inspect(incomingCredential)
    if (incomingInspected.expiresAt && incomingInspected.expiresAt <= this.now()) {
      throw new AccountError(`Cannot ${actionLabel} expired credential.`)
    }

    const fingerprint = createHash('sha256').update(incomingInspected.credential).digest('hex')
    await this.store.clearSuppression(validTool, fingerprint)

    let currentRaw: string | null = null
    try {
      const ext = adapter as AccountAdapterWithMatching
      if (typeof ext.readCurrentCredential === 'function') {
        currentRaw = ext.readCurrentCredential()
      } else {
        currentRaw = adapter.credentialFrom(adapter.read())
      }
    } catch {}

    if (currentRaw) {
      try {
        if (matchesAccountIdentity(adapter, currentRaw, incomingCredential)) {
          const currentInspected = adapter.inspect(currentRaw)
          const currentFingerprint = createHash('sha256').update(currentInspected.credential).digest('hex')
          if (currentFingerprint !== fingerprint) {
            await this.store.clearSuppression(validTool, currentFingerprint)
          }
        }
      } catch {}
    }

    const existingList = await this.store.list(validTool)
    let matchingAccount: StoredAccountRecord | null = null
    for (const meta of existingList) {
      const rec = await this.store.get(meta.id)
      try {
        adapter.inspect(rec.credential)
      } catch {
        throw new AccountError('Account corrupted: failed to inspect stored credential.')
      }
      let doesMatch = false
      try {
        doesMatch = matchesAccountIdentity(adapter, incomingCredential, rec.credential)
      } catch {
        throw new AccountError('Account corrupted: failed to inspect stored credential.')
      }
      if (doesMatch) {
        matchingAccount = rec
        break
      }
    }

    if (matchingAccount) {
      let effectiveCredential = incomingCredential
      const ext = adapter as AccountAdapterWithMatching
      if (typeof ext.mergeCredential === 'function') {
        try {
          effectiveCredential = ext.mergeCredential(incomingCredential, matchingAccount.credential)
        } catch (err) {
          throw new AccountError(sanitizeErrorMessage(err))
        }
      }

      let effectiveInspected: InspectedCredential
      try {
        effectiveInspected = adapter.inspect(effectiveCredential)
      } catch (err) {
        throw new AccountError(sanitizeErrorMessage(err))
      }

      if (effectiveInspected.expiresAt && effectiveInspected.expiresAt <= this.now()) {
        throw new AccountError(`Cannot ${actionLabel} expired credential.`)
      }

      if (matchingAccount.credential !== effectiveInspected.credential) {
        const updated = await this.store.updateCredential(matchingAccount.metadata.id, {
          credential: effectiveInspected.credential,
          email: effectiveInspected.email,
          accountId: effectiveInspected.accountId,
          expiresAt: effectiveInspected.expiresAt,
        })
        this.refreshService.clearState(matchingAccount.metadata.id)
        this.refreshService.clearPendingSync(matchingAccount.metadata.id)
        this.quotas.invalidate(matchingAccount.metadata.id)
        this.notifyChanged()
        return updated
      }
      // Unchanged does no write/notify
      return matchingAccount.metadata
    }

    const name = validatedCustomName ?? deriveDefaultAccountName(validTool, incomingInspected.email, incomingInspected.accountId)
    const saved = await this.store.save({
      tool: validTool,
      name,
      credential: incomingInspected.credential,
      email: incomingInspected.email,
      accountId: incomingInspected.accountId,
      expiresAt: incomingInspected.expiresAt,
    })
    this.notifyChanged()
    return saved
  }

  async captureAccount(input: { tool: AccountTool; name: string }): Promise<AccountMetadata> {
    if (!input || typeof input !== 'object') throw new AccountError('Invalid account input: must be an object.')
    const tool = validateAccountTool(input.tool)
    const name = validateAccountName(input.name)

    return await this.withMutationLock(async () => {
      const adapter = this.adapters[tool]
      if (!adapter) throw new AccountError(`Tool adapter not available for ${tool}.`)

      const cap = adapter.capability()
      if (!cap.available) throw new AccountError(cap.reason || `Credential capture is not supported for ${tool}.`)

      const rawCredential = adapter.credentialFrom(adapter.read())
      if (!rawCredential) {
        throw new AccountError(
          `Cannot capture credentials for ${tool}. If stored in Keychain or system vault, please import your credential directly or use a setup token.`
        )
      }

      return await this.upsertAccountInternal(tool, rawCredential, name, 'capture')
    })
  }

  async importAccount(input: { tool: AccountTool; name: string; credential: string }): Promise<AccountMetadata> {
    if (!input || typeof input !== 'object') throw new AccountError('Invalid account input: must be an object.')
    const tool = validateAccountTool(input.tool)
    const name = validateAccountName(input.name)
    if (typeof input.credential !== 'string' || input.credential.length === 0) {
      throw new AccountError('Credential payload must be a non-empty string.')
    }

    return await this.withMutationLock(async () => {
      return await this.upsertAccountInternal(tool, input.credential, name, 'import')
    })
  }

  /**
   * Internal manager method for supervisor OAuth callback.
   * Performs deduplication and upsert by adapter identityKey without writing official tool files.
   */
  async saveAuthenticatedAccount(input: {
    tool: AccountTool
    credential: string
    name?: string
  }): Promise<AccountMetadata> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AccountError('Invalid account input: must be an object.')
    }
    const tool = validateAccountTool(input.tool)
    if (typeof input.credential !== 'string' || input.credential.length === 0) {
      throw new AccountError('Credential payload must be a non-empty string.')
    }

    return await this.withMutationLock(async () => {
      return await this.upsertAccountInternal(tool, input.credential, input.name, 'save')
    })
  }

  /**
   * Scans each ACCOUNT_TOOLS independently under mutation lock to discover and sync active credentials.
   * Never writes to official tool credential/config files.
   * Returns per-tool AccountDiscoveryResult array.
   */
  async syncCurrentAccounts(): Promise<AccountDiscoveryResult[]> {
    return await this.withMutationLock(async () => {
      const results: AccountDiscoveryResult[] = []
      let hasActualChanges = false

      for (const tool of ACCOUNT_TOOLS) {
        try {
          const adapter = this.adapters[tool]
          if (!adapter) {
            results.push({ tool, status: 'unavailable', message: `Adapter for ${tool} not found.` })
            continue
          }

          let rawCredential: string | null = null
          try {
            const adapterWithMatching = adapter as AccountAdapterWithMatching
            if (typeof adapterWithMatching.readCurrentCredential === 'function') {
              rawCredential = adapterWithMatching.readCurrentCredential()
            } else {
              rawCredential = adapter.credentialFrom(adapter.read())
            }
          } catch (err) {
            results.push({ tool, status: 'error', message: sanitizeErrorMessage(err) })
            continue
          }

          if (!rawCredential) {
            results.push({ tool, status: 'not-found' })
            continue
          }

          let inspected: InspectedCredential
          try {
            inspected = adapter.inspect(rawCredential)
          } catch (err) {
            results.push({ tool, status: 'error', message: sanitizeErrorMessage(err) })
            continue
          }

          if (inspected.expiresAt && inspected.expiresAt <= this.now()) {
            results.push({ tool, status: 'expired', message: 'Current credential has expired.' })
            continue
          }

          if (adapter.enrichCredential) {
            rawCredential = await adapter.enrichCredential(rawCredential)
            inspected = adapter.inspect(rawCredential)
          }

          const fingerprint = createHash('sha256').update(inspected.credential).digest('hex')
          if (await this.store.isSuppressed(tool, fingerprint)) {
            results.push({ tool, status: 'dismissed' })
            continue
          }

          // Search existing accounts for matching identity
          const existingList = await this.store.list(tool)
          let matchingAccount: StoredAccountRecord | null = null
          for (const meta of existingList) {
            const rec = await this.store.get(meta.id)
            try {
              adapter.inspect(rec.credential)
            } catch {
              throw new AccountError('Account corrupted: failed to inspect stored credential.')
            }
            let doesMatch = false
            try {
              doesMatch = matchesAccountIdentity(adapter, rawCredential, rec.credential)
            } catch {
              throw new AccountError('Account corrupted: failed to inspect stored credential.')
            }
            if (doesMatch) {
              matchingAccount = rec
              break
            }
          }

          if (matchingAccount) {
            let effectiveCredential = rawCredential
            const ext = adapter as AccountAdapterWithMatching
            if (typeof ext.mergeCredential === 'function') {
              try {
                effectiveCredential = ext.mergeCredential(rawCredential, matchingAccount.credential)
              } catch (err) {
                throw new AccountError(sanitizeErrorMessage(err))
              }
            }

            let effectiveInspected: InspectedCredential
            try {
              effectiveInspected = adapter.inspect(effectiveCredential)
            } catch (err) {
              throw new AccountError(sanitizeErrorMessage(err))
            }

            if (effectiveInspected.expiresAt && effectiveInspected.expiresAt <= this.now()) {
              results.push({ tool, status: 'expired', message: 'Current credential has expired.' })
              continue
            }

            const existingInspected = adapter.inspect(matchingAccount.credential)
            const existingExpiresAt = existingInspected.expiresAt ?? matchingAccount.metadata.expiresAt
            const currentExpiresAt = effectiveInspected.expiresAt

            // Existing valid token should not be replaced by older token
            if (
              existingExpiresAt &&
              currentExpiresAt &&
              currentExpiresAt < existingExpiresAt &&
              existingExpiresAt > this.now()
            ) {
              results.push({ tool, status: 'unchanged', accountId: matchingAccount.metadata.id })
              continue
            }

            if (matchingAccount.credential === effectiveInspected.credential) {
              results.push({ tool, status: 'unchanged', accountId: matchingAccount.metadata.id })
              continue
            }

            // Same identity changed credential -> replace and invalidate quota
            const updated = await this.store.updateCredential(matchingAccount.metadata.id, {
              credential: effectiveInspected.credential,
              email: effectiveInspected.email,
              accountId: effectiveInspected.accountId,
              expiresAt: effectiveInspected.expiresAt,
            })
            this.refreshService.clearState(matchingAccount.metadata.id)
            this.quotas.invalidate(matchingAccount.metadata.id)
            hasActualChanges = true
            results.push({ tool, status: 'updated', accountId: updated.id })
          } else {
            const defaultName = deriveDefaultAccountName(tool, inspected.email, inspected.accountId)
            const saved = await this.store.save({
              tool,
              name: defaultName,
              credential: inspected.credential,
              email: inspected.email,
              accountId: inspected.accountId,
              expiresAt: inspected.expiresAt,
            })
            hasActualChanges = true
            results.push({ tool, status: 'imported', accountId: saved.id })
          }
        } catch (err) {
          results.push({ tool, status: 'error', message: sanitizeErrorMessage(err) })
        }
      }

      if (hasActualChanges) {
        this.notifyChanged()
      }

      return results
    })
  }

  async switchAccount(id: string): Promise<AccountActionResult> {
    const validId = validateAccountId(id)
    const renewal = await this.ensureFreshCredential(validId)
    if (renewal.status === 'reauth-required') throw new AccountError('Account authorization is no longer valid. Sign in again.')
    return await this.withMutationLock(async () => {
      const record = await this.store.get(validId)
      const tool = record.metadata.tool
      const adapter = this.adapters[tool]
      if (!adapter) throw new AccountError(`Tool adapter not available for ${tool}.`)

      if (this.refreshService.hasPendingSyncForTool(tool)) {
        throw new AccountError('Cannot switch account while pending credential synchronization is unresolved.')
      }

      const cap = adapter.capability()
      if (!cap.available) throw new AccountError(cap.reason || `Account switching is not supported for ${tool}.`)

      const inspected = adapter.inspect(record.credential)
      if (
        (inspected.expiresAt && inspected.expiresAt <= this.now()) ||
        (record.metadata.expiresAt && record.metadata.expiresAt <= this.now())
      ) {
        throw new AccountError('Account credential has expired.')
      }

      const journalInfo = this.readJournalSafely(tool)
      if (journalInfo.corrupted) throw new AccountError('Transaction journal corrupted.')
      if (journalInfo.journal?.phase === 'pending') {
        this.notifyChanged()
        return {
          success: false,
          error: 'A pending transaction exists for this tool. Recovery is needed.',
          recoveryNeeded: true,
        }
      }

      const priorCompleteJournal =
        journalInfo.journal?.phase === 'complete' ? journalInfo.journal : undefined

      adapter.assertCanWrite?.()
      const beforeState = adapter.read()
      const desiredState = adapter.desired(record.credential)
      const slotKeys = KNOWN_SLOTS[tool]

      const pendingJournal: AccountTransactionJournal = {
        version: 1,
        tool,
        phase: 'pending',
        before: beforeState,
        after: desiredState,
        previousAccountId: priorCompleteJournal?.selectedAccountId,
        selectedAccountId: validId,
        previousComplete: priorCompleteJournal,
      }
      this.atomicWrite(this.journalPath(tool), pendingJournal)

      let writeError: unknown = null

      try {
        for (let i = 0; i < slotKeys.length; i++) {
          const slot = slotKeys[i]

          this.beforeWrite?.(tool, slot, i)

          // CAS: Re-read all owned fields and compare expected progress before writing
          const current = adapter.read()
          for (let k = 0; k < slotKeys.length; k++) {
            const s = slotKeys[k]
            const expectedVal = k < i ? desiredState[s] : beforeState[s]
            if (current[s] !== expectedVal) {
              throw new AccountError(
                `External conflict detected on slot "${s}": configuration modified concurrently during switch.`
              )
            }
          }

          adapter.writeSlot(slot, desiredState[slot])
        }

        // Post-verification: ensure final projection equals desired state
        const finalState = adapter.read()
        for (const s of slotKeys) {
          if (finalState[s] !== desiredState[s]) {
            throw new AccountError(`Verification failed: final projection on slot "${s}" does not match desired state.`)
          }
        }

        const completeJournal: AccountTransactionJournal = {
          version: 1,
          tool,
          phase: 'complete',
          before: beforeState,
          after: desiredState,
          previousAccountId: priorCompleteJournal?.selectedAccountId,
          selectedAccountId: validId,
        }
        this.atomicWrite(this.journalPath(tool), completeJournal)
        this.notifyChanged()
        return { success: true }
      } catch (err) {
        writeError = err
      }

      // Failure compensation
      let compensationFailed = false
      try {
        for (const slot of slotKeys) {
          const cur = adapter.read()[slot]
          if (cur === beforeState[slot]) continue
          if (cur === desiredState[slot]) {
            try {
              adapter.writeSlot(slot, beforeState[slot])
            } catch {
              compensationFailed = true
            }
          } else {
            compensationFailed = true
          }
        }

        if (!compensationFailed) {
          const compState = adapter.read()
          for (const slot of slotKeys) {
            if (compState[slot] !== beforeState[slot]) {
              compensationFailed = true
              break
            }
          }
        }
      } catch {
        compensationFailed = true
      }

      if (compensationFailed) {
        this.notifyChanged()
        return {
          success: false,
          error: sanitizeErrorMessage(writeError),
          recoveryNeeded: true,
        }
      }

      if (priorCompleteJournal) {
        this.atomicWrite(this.journalPath(tool), priorCompleteJournal)
      } else {
        this.removeFileSafely(this.journalPath(tool))
      }

      this.notifyChanged()
      return {
        success: false,
        error: sanitizeErrorMessage(writeError),
        recoveryNeeded: false,
      }
    })
  }

  async rollbackAccount(tool: AccountTool): Promise<AccountActionResult> {
    validateAccountTool(tool)
    return await this.withMutationLock(async () => {
      const adapter = this.adapters[tool]
      if (!adapter) throw new AccountError(`Tool adapter not available for ${tool}.`)

      if (this.refreshService.hasPendingSyncForTool(tool)) {
        this.notifyChanged()
        return {
          success: false,
          error: 'Cannot rollback account while pending credential synchronization is unresolved.',
          recoveryNeeded: true,
        }
      }

      const journalInfo = this.readJournalSafely(tool)
      if (journalInfo.corrupted) {
        this.notifyChanged()
        return { success: false, error: 'Transaction journal corrupted.', recoveryNeeded: true }
      }
      if (!journalInfo.journal) {
        return { success: false, error: 'No transaction journal found for rollback.' }
      }
      if (journalInfo.journal.phase === 'pending') {
        this.notifyChanged()
        return { success: false, error: 'A pending transaction exists for this tool. Recovery is needed.', recoveryNeeded: true }
      }

      adapter.assertCanWrite?.()
      const journal = journalInfo.journal
      const slotKeys = KNOWN_SLOTS[tool]

      // Preflight conflict check
      const current = adapter.read()
      for (const slot of slotKeys) {
        if (current[slot] !== journal.after[slot]) {
          this.notifyChanged()
          return { success: false, error: 'External credential change detected. Rollback aborted to prevent overwriting.' }
        }
      }

      // Write pending journal BEFORE any mutation (preserves same before/after so recovery can complete it)
      const rollbackPending: AccountTransactionJournal = {
        ...journal,
        phase: 'pending',
      }
      this.atomicWrite(this.journalPath(tool), rollbackPending)

      try {
        for (let i = 0; i < slotKeys.length; i++) {
          const slot = slotKeys[i]

          this.beforeWrite?.(tool, slot, i)

          // CAS re-read before write
          const cur = adapter.read()
          for (let k = 0; k < slotKeys.length; k++) {
            const s = slotKeys[k]
            const expectedVal = k < i ? journal.before[s] : journal.after[s]
            if (cur[s] !== expectedVal) {
              throw new AccountError(`External conflict during rollback on slot "${s}".`)
            }
          }

          adapter.writeSlot(slot, journal.before[slot])
        }

        // Post-verify
        const finalState = adapter.read()
        for (const s of slotKeys) {
          if (finalState[s] !== journal.before[s]) {
            throw new AccountError(`Verification failed after rollback on slot "${s}".`)
          }
        }

        this.removeFileSafely(this.journalPath(tool))
        this.notifyChanged()
        return { success: true }
      } catch (err) {
        this.notifyChanged()
        return {
          success: false,
          error: sanitizeErrorMessage(err),
          recoveryNeeded: true,
        }
      }
    })
  }

  async recoverAccount(tool: AccountTool): Promise<AccountActionResult> {
    validateAccountTool(tool)
    return await this.withMutationLock(async () => {
      const adapter = this.adapters[tool]
      if (!adapter) throw new AccountError(`Tool adapter not available for ${tool}.`)

      if (this.refreshService.hasPendingSyncForTool(tool)) {
        this.notifyChanged()
        return {
          success: false,
          error: 'Cannot recover account while pending credential synchronization is unresolved.',
          recoveryNeeded: true,
        }
      }

      const journalInfo = this.readJournalSafely(tool)
      if (journalInfo.corrupted) {
        this.notifyChanged()
        return { success: false, error: 'Transaction journal corrupted.', recoveryNeeded: true }
      }
      if (!journalInfo.journal || journalInfo.journal.phase === 'complete') {
        return { success: true }
      }

      adapter.assertCanWrite?.()
      const journal = journalInfo.journal
      const slotKeys = KNOWN_SLOTS[tool]

      // Re-read and check foreign changes
      const current = adapter.read()
      for (const slot of slotKeys) {
        const cur = current[slot]
        if (cur !== journal.before[slot] && cur !== journal.after[slot]) {
          this.notifyChanged()
          return {
            success: false,
            error: `Foreign modification detected on slot "${slot}". Recovery refused.`,
            recoveryNeeded: true,
          }
        }
      }

      // Restore each slot re-reading dynamically
      for (const slot of slotKeys) {
        const cur = adapter.read()[slot]
        if (cur !== journal.before[slot]) {
          if (cur !== journal.after[slot]) {
            this.notifyChanged()
            return {
              success: false,
              error: `Foreign modification detected on slot "${slot}". Recovery refused.`,
              recoveryNeeded: true,
            }
          }
          adapter.writeSlot(slot, journal.before[slot])
        }
      }

      const finalState = adapter.read()
      for (const s of slotKeys) {
        if (finalState[s] !== journal.before[s]) {
          this.notifyChanged()
          return {
            success: false,
            error: `Verification failed during recovery on slot "${s}".`,
            recoveryNeeded: true,
          }
        }
      }

      if (journal.previousComplete) {
        this.atomicWrite(this.journalPath(tool), journal.previousComplete)
      } else {
        this.removeFileSafely(this.journalPath(tool))
      }

      this.notifyChanged()
      return { success: true }
    })
  }

  async renameAccount(id: string, name: string): Promise<AccountMetadata> {
    const validId = validateAccountId(id)
    const validName = validateAccountName(name)
    return await this.withMutationLock(async () => {
      const metadata = await this.store.rename(validId, validName)
      this.notifyChanged()
      return metadata
    })
  }

  async deleteAccount(id: string): Promise<void> {
    const validId = validateAccountId(id)
    this.refreshService.clearState(validId)
    await this.withMutationLock(async () => {
      let record: StoredAccountRecord | null = null
      try {
        record = await this.store.get(validId)
      } catch {
        // If record is not found or corrupted, proceed to store.delete
      }

      if (record) {
        const tool = record.metadata.tool
        const adapter = this.adapters[tool]
        if (adapter) {
          try {
            const inspected = adapter.inspect(record.credential)
            const fingerprint = createHash('sha256').update(inspected.credential).digest('hex')
            // Record suppression FIRST; avoid deleting record if recording suppression fails
            await this.store.recordSuppression(tool, fingerprint)

            // Additionally suppress current discovered credential fingerprint WHEN it matches same account
            let currentRaw: string | null = null
            try {
              const ext = adapter as AccountAdapterWithMatching
              if (typeof ext.readCurrentCredential === 'function') {
                currentRaw = ext.readCurrentCredential()
              } else {
                currentRaw = adapter.credentialFrom(adapter.read())
              }
            } catch {
              // Independent tool read errors do not block deletion
            }

            if (currentRaw) {
              let matches = false
              let currentFingerprint: string | undefined
              try {
                const currentInspected = adapter.inspect(currentRaw)
                currentFingerprint = createHash('sha256').update(currentInspected.credential).digest('hex')
                matches = matchesAccountIdentity(adapter, currentRaw, record.credential)
              } catch {
                // Tool inspect/match errors on external disk files do not block deletion
              }

              if (matches && currentFingerprint && currentFingerprint !== fingerprint) {
                await this.store.recordSuppression(tool, currentFingerprint)
              }
            }
          } catch (err) {
            if (err instanceof AccountError) throw err
            throw new AccountError('Failed to record account dismissal suppression.')
          }
        }
      }

      this.refreshService.clearPendingSync(validId)
      this.refreshService.clearState(validId)
      await this.store.delete(validId)
      this.quotas.invalidate(validId)
      this.notifyChanged()
    })
  }
}
