/**
 * AI Tool Account Manager (OPC-48)
 *
 * Implements transaction-safe account capture, import, switching, rollback, and recovery
 * across AI developer tools (Google Antigravity, OpenAI Codex, Claude Code).
 */

import { randomUUID } from 'node:crypto'
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
  type AccountManagementAPI,
  type AccountMetadata,
  type AccountTool,
  type AccountToolCapability,
  type AccountToolState,
  type AccountsOverview,
  ACCOUNT_TOOLS,
  AccountError,
  sanitizeErrorMessage,
  validateAccountId,
  validateAccountName,
  validateAccountTool,
} from '../../../packages/workflow-model/src/accounts.ts'
import { AccountStore, hasLegacyProfiles } from './account-store.ts'
import {
  type AccountAdapter,
  type AccountProjection,
  createAccountAdapters,
} from './account-adapters.ts'

export const MAX_TRANSACTION_FILE_SIZE = 64 * 1024 * 1024 // 64 MiB

export const KNOWN_SLOTS: Record<AccountTool, readonly string[]> = {
  codex: ['auth', 'mode'],
  'claude-code': ['oauth'],
  antigravity: ['oauth'],
} as const

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
  beforeWrite?: (tool: AccountTool, slot: string, index: number) => void
}

export class AccountManager implements AccountManagementAPI {
  public readonly homeDir: string
  public readonly traceHome: string
  public readonly transactionsDir: string
  public readonly store: AccountStore
  public readonly adapters: Record<AccountTool, AccountAdapter>
  private readonly onAccountsChangedOption?: () => void
  private readonly beforeWrite?: (tool: AccountTool, slot: string, index: number) => void
  private readonly changeListeners: Set<() => void> = new Set()
  private mutationLock: Promise<void> = Promise.resolve()

  constructor(options?: AccountManagerOptions) {
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

    this.adapters = options?.adapters ?? createAccountAdapters({
      homeDir: this.homeDir,
      env: options?.env,
      codexHome: options?.codexHome,
      antigravityFileMode: options?.antigravityFileMode,
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

  private readJournalSafely(tool: AccountTool): {
    journal?: AccountTransactionJournal
    corrupted: boolean
    error?: string
  } {
    const targetPath = path.join(this.transactionsDir, `${tool}.json`)
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
        const currentProj = adapter.read()
        const currentCred = adapter.credentialFrom(currentProj)
        if (currentCred) {
          const inspected = adapter.inspect(currentCred)

          let matchedAccount: AccountMetadata | undefined

          if (journalInfo.journal?.selectedAccountId) {
            try {
              const sel = await this.store.get(journalInfo.journal.selectedAccountId)
              if (adapter.inspect(sel.credential).identityKey === inspected.identityKey) {
                matchedAccount = sel.metadata
              }
            } catch {}
          }

          if (!matchedAccount) {
            for (const acc of accounts) {
              if (acc.tool === tool) {
                try {
                  const rec = await this.store.get(acc.id)
                  if (adapter.inspect(rec.credential).identityKey === inspected.identityKey) {
                    matchedAccount = rec.metadata
                    break
                  }
                } catch {}
              }
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

    return { accounts, tools, capabilities, legacyProfilesPresent }
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

      const inspected = adapter.inspect(rawCredential)
      if (inspected.expiresAt && inspected.expiresAt <= Date.now()) {
        throw new AccountError('Cannot capture expired credential.')
      }

      const metadata = await this.store.save({
        tool,
        name,
        credential: inspected.credential,
        email: inspected.email,
        accountId: inspected.accountId,
        expiresAt: inspected.expiresAt,
      })
      this.notifyChanged()
      return metadata
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
      const adapter = this.adapters[tool]
      if (!adapter) throw new AccountError(`Tool adapter not available for ${tool}.`)

      const inspected = adapter.inspect(input.credential)
      if (inspected.expiresAt && inspected.expiresAt <= Date.now()) {
        throw new AccountError('Cannot import expired credential.')
      }

      const metadata = await this.store.save({
        tool,
        name,
        credential: inspected.credential,
        email: inspected.email,
        accountId: inspected.accountId,
        expiresAt: inspected.expiresAt,
      })
      this.notifyChanged()
      return metadata
    })
  }

  async switchAccount(id: string): Promise<AccountActionResult> {
    const validId = validateAccountId(id)
    return await this.withMutationLock(async () => {
      const record = await this.store.get(validId)
      const tool = record.metadata.tool
      const adapter = this.adapters[tool]
      if (!adapter) throw new AccountError(`Tool adapter not available for ${tool}.`)

      const cap = adapter.capability()
      if (!cap.available) throw new AccountError(cap.reason || `Account switching is not supported for ${tool}.`)

      const inspected = adapter.inspect(record.credential)
      if (
        (inspected.expiresAt && inspected.expiresAt <= Date.now()) ||
        (record.metadata.expiresAt && record.metadata.expiresAt <= Date.now())
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
      this.atomicWrite(path.join(this.transactionsDir, `${tool}.json`), pendingJournal)

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
        this.atomicWrite(path.join(this.transactionsDir, `${tool}.json`), completeJournal)
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
        this.atomicWrite(path.join(this.transactionsDir, `${tool}.json`), priorCompleteJournal)
      } else {
        this.removeFileSafely(path.join(this.transactionsDir, `${tool}.json`))
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
      this.atomicWrite(path.join(this.transactionsDir, `${tool}.json`), rollbackPending)

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

        this.removeFileSafely(path.join(this.transactionsDir, `${tool}.json`))
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

      const journalInfo = this.readJournalSafely(tool)
      if (journalInfo.corrupted) {
        this.notifyChanged()
        return { success: false, error: 'Transaction journal corrupted.', recoveryNeeded: true }
      }
      if (!journalInfo.journal || journalInfo.journal.phase === 'complete') {
        return { success: true }
      }

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
        this.atomicWrite(path.join(this.transactionsDir, `${tool}.json`), journal.previousComplete)
      } else {
        this.removeFileSafely(path.join(this.transactionsDir, `${tool}.json`))
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
    await this.withMutationLock(async () => {
      await this.store.delete(validId)
      this.notifyChanged()
    })
  }
}
