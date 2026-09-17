/**
 * Automatic Account Switching Service for Antigravity (OPC-80)
 *
 * Implements transaction-safe, bounded, quota-driven automatic account switching
 * for Google Antigravity when the currently active model's quota is exhausted.
 *
 * Product Rules & Safety Constraints:
 * 1. Antigravity only; Codex and Claude Code are excluded.
 * 2. Toggle defaults to disabled (false), persisted per tool under ~/.trace/accounts/.auto-switch.json.
 * 3. Does not run in background or execute switches when Trace exits.
 * 4. No tight polling loops. Uses existing 5-minute quota cache TTL and 1-minute failure cooldown.
 *    Active account is evaluated on renewal / window-focus cadences; candidates are ONLY queried
 *    on-demand after the active account's current model is confirmed exhausted.
 * 5. Current model is mapped to the 7 supported Antigravity models and tiered aliases.
 * 6. Model exhaustion requires verified 0% on 5-hour window or weekly window.
 *    Unknown, expired, rate-limited, error, or stale snapshots are NOT exhausted.
 * 7. Candidate accounts MUST have verified remainingPercent > 0 on the exact same model.
 *    Quota remaining on other models does NOT qualify an account.
 * 8. If current model cannot be read or recognized: evaluated against 7 supported models
 *    in active account's quota snapshot (in priority order). If any mapped model is confirmed exhausted (0%),
 *    switches to first suitable candidate account. If no mapped model is exhausted: no switch, no candidate queries, Chinese notice.
 * 9. Switching delegates to existing AccountManager.switchAccount transaction lifecycle
 *    (backup -> quit client -> write Keychain -> restart client). CLI sessions remain undisturbed.
 * 10. Concurrency mutex, 60s cooldown, mid-switch disable abort, recoveryNeeded abort, single account abort.
 * 11. Preserves identity matching from 6915e7e (Keychain matching as authority).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type AccountActionResult,
  type AccountMetadata,
  type AccountQuotaSnapshot,
  type AccountTool,
  type SupportedAntigravityModel,
  SUPPORTED_ANTIGRAVITY_MODELS,
  matchSupportedAntigravityModel,
} from '../../../packages/workflow-model/src/accounts.ts'
import {
  resolveAntigravityDesktopStoragePath,
  resolveAntigravityGlobalStorageDbPath,
  resolveAntigravityGlobalStorageJsonPath,
  resolveAntigravityPbtxtPath,
  type AccountFileManager,
} from './account-adapters.ts'
import type { AccountManager } from './account-manager.ts'
import type { AccountQuotaService } from './account-quota.ts'
import type { AccountStore } from './account-store.ts'

export const ANTIGRAVITY_MODEL_STORAGE_KEYS = [
  'currentModel',
  'selectedModel',
  'activeModel',
  'model',
  'antigravity.currentModel',
  'antigravity.selectedModel',
  'antigravity.model',
  'lastSelectedCascadeModel',
  'jetski.model',
  'last_selected_agent_model',
  'last_selected_model',
  'lastSelectedModel',
  'last_selected_model_name',
  'last_selected_cascade_model_or_alias',
] as const

export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
export const QUOTA_FAILURE_COOLDOWN_MS = 60 * 1000 // 1 minute
export const AUTO_SWITCH_COOLDOWN_MS = 60 * 1000 // 1 minute cooldown between auto switches

export interface AutoSwitchToolConfig {
  enabled: boolean
  updatedAt: number
}

export interface AccountAutoSwitchConfigFile {
  version: 1
  tools: Partial<Record<AccountTool, AutoSwitchToolConfig>>
}

export interface AccountAutoSwitchOptions {
  storagePath?: string
  vscdbPath?: string
  pbtxtPath?: string
  globalStorageJsonPath?: string
  homeDir?: string
  traceHome?: string
  files?: AccountFileManager
  now?: () => number
}

/**
 * Extracts a supported Antigravity model from raw JSON text content.
 */
export function extractModelFromJson(content: string): SupportedAntigravityModel | null {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object') return null

    for (const key of ANTIGRAVITY_MODEL_STORAGE_KEYS) {
      const val = (parsed as Record<string, unknown>)[key]
      if (typeof val === 'string' && val.trim().length > 0) {
        const matched = matchSupportedAntigravityModel(val.trim())
        if (matched) return matched
      }
    }

    const modelPrefs =
      (parsed as Record<string, unknown>)['antigravityUnifiedStateSync.modelPreferences'] ??
      (parsed as Record<string, unknown>)['modelPreferences']
    if (modelPrefs && typeof modelPrefs === 'object') {
      for (const key of Object.keys(modelPrefs as Record<string, unknown>)) {
        const val = (modelPrefs as Record<string, unknown>)[key]
        if (typeof val === 'string' && val.trim().length > 0) {
          const matched = matchSupportedAntigravityModel(val.trim())
          if (matched) return matched
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Extracts a supported model from a base64 encoded string if it contains any recognizable model ID or alias.
 */
export function extractModelFromBase64(val: string): SupportedAntigravityModel | null {
  const trimmed = val.trim()
  if (!trimmed || trimmed.length < 4 || trimmed.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return null

  try {
    const decoded = Buffer.from(trimmed, 'base64')
    const text = decoded.toString('utf8')

    for (const model of SUPPORTED_ANTIGRAVITY_MODELS) {
      const targets = [model.id, model.label, ...model.aliases]
      for (const target of targets) {
        if (text.includes(target)) {
          return model
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extracts a supported Antigravity model from protobuf text format (pbtxt) content.
 * If the value is a placeholder enum (e.g. MODEL_PLACEHOLDER_M*), returns null (no guesswork).
 */
export function extractModelFromPbtxt(content: string): SupportedAntigravityModel | null {
  try {
    const lines = content.split(/\r?\n/)
    for (const line of lines) {
      const match = /^\s*([a-zA-Z0-9_]+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([a-zA-Z0-9_\-.]+))/i.exec(line)
      if (match) {
        const key = match[1]
        const val = match[2] ?? match[3] ?? match[4]
        if (
          key === 'last_selected_agent_model' ||
          key === 'last_selected_model_name' ||
          key === 'last_selected_cascade_model_or_alias' ||
          key === 'last_selected_cascade_model' ||
          key === 'last_selected_model' ||
          key === 'selected_model' ||
          key === 'current_model' ||
          key === 'active_model' ||
          key === 'model'
        ) {
          if (val && !val.startsWith('MODEL_PLACEHOLDER_')) {
            const matched = matchSupportedAntigravityModel(val.trim())
            if (matched) return matched
          }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Reads a model selection from state.vscdb (SQLite ItemTable).
 */
export function readFromVscdb(
  vscdbPath: string,
  options?: Pick<AccountAutoSwitchOptions, 'files'>
): SupportedAntigravityModel | null {
  if (options?.files) {
    try {
      const mockContent = options.files.read(vscdbPath)
      if (mockContent) {
        const fromJson = extractModelFromJson(mockContent)
        if (fromJson) return fromJson
        const fromPbtxt = extractModelFromPbtxt(mockContent)
        if (fromPbtxt) return fromPbtxt
        const fromBase64 = extractModelFromBase64(mockContent)
        if (fromBase64) return fromBase64
      }
    } catch {}
  }

  if (existsSync(vscdbPath)) {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(vscdbPath, { readOnly: true, open: true })
      const keysToCheck = [
        'antigravityUnifiedStateSync.modelPreferences',
        ...ANTIGRAVITY_MODEL_STORAGE_KEYS,
      ]

      const placeholders = keysToCheck.map(() => '?').join(',')
      const stmt = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`)
      const rows = stmt.all(...keysToCheck) as Array<{ key: string; value: unknown }>

      for (const row of rows) {
        const val = row.value
        if (typeof val === 'string' && val.trim().length > 0) {
          const directMatch = matchSupportedAntigravityModel(val.trim())
          if (directMatch) return directMatch

          const jsonMatch = extractModelFromJson(val)
          if (jsonMatch) return jsonMatch

          const base64Match = extractModelFromBase64(val)
          if (base64Match) return base64Match
        }
      }
    } catch {
      return null
    } finally {
      try {
        db?.close()
      } catch {}
    }
  }

  return null
}

/**
 * Reads the currently selected Antigravity model using bounded, read-only multi-source resolution.
 *
 * Sources evaluated in strict priority order:
 * 1. state.vscdb (SQLite globalStorage)
 * 2. app_storage.json (Desktop Electron app storage)
 * 3. storage.json (User globalStorage JSON)
 * 4. antigravity_state.pbtxt (~/.gemini/antigravity/antigravity_state.pbtxt)
 *
 * Safety & Invariant Rules:
 * - Corruption/absence of any source cleanly falls through to the next without failing.
 * - If the model cannot be read or recognized (e.g. placeholder enums MODEL_PLACEHOLDER_M*):
 *   strictly returns null without guessing.
 */
export function readAntigravityCurrentModel(
  options?: Pick<
    AccountAutoSwitchOptions,
    | 'storagePath'
    | 'vscdbPath'
    | 'pbtxtPath'
    | 'globalStorageJsonPath'
    | 'homeDir'
    | 'files'
  >
): SupportedAntigravityModel | null {
  const hasExplicitPath = Boolean(
    options?.storagePath ||
      options?.vscdbPath ||
      options?.pbtxtPath ||
      options?.globalStorageJsonPath
  )
  const home = options?.homeDir || (hasExplicitPath ? undefined : os.homedir())

  // Priority 1: state.vscdb (SQLite globalStorage)
  const vscdbPath =
    options?.vscdbPath || (home ? resolveAntigravityGlobalStorageDbPath(home) : undefined)
  if (vscdbPath) {
    try {
      const model = readFromVscdb(vscdbPath, options)
      if (model) return model
    } catch {}
  }

  // Priority 2: app_storage.json (Desktop Electron storage)
  const desktopStoragePath =
    options?.storagePath || (home ? resolveAntigravityDesktopStoragePath(home) : undefined)
  if (desktopStoragePath) {
    try {
      const content = options?.files
        ? options.files.read(desktopStoragePath)
        : (existsSync(desktopStoragePath) ? readFileSync(desktopStoragePath, 'utf8') : null)
      if (content) {
        const model = extractModelFromJson(content)
        if (model) return model
      }
    } catch {}
  }

  // Priority 3: storage.json (User/globalStorage/storage.json)
  const globalStorageJsonPath =
    options?.globalStorageJsonPath ||
    (home ? resolveAntigravityGlobalStorageJsonPath(home) : undefined)
  if (globalStorageJsonPath) {
    try {
      const content = options?.files
        ? options.files.read(globalStorageJsonPath)
        : (existsSync(globalStorageJsonPath)
            ? readFileSync(globalStorageJsonPath, 'utf8')
            : null)
      if (content) {
        const model = extractModelFromJson(content)
        if (model) return model
      }
    } catch {}
  }

  // Priority 4: antigravity_state.pbtxt (~/.gemini/antigravity/antigravity_state.pbtxt)
  const pbtxtPath =
    options?.pbtxtPath || (home ? resolveAntigravityPbtxtPath(home) : undefined)
  if (pbtxtPath) {
    try {
      const content = options?.files
        ? options.files.read(pbtxtPath)
        : (existsSync(pbtxtPath) ? readFileSync(pbtxtPath, 'utf8') : null)
      if (content) {
        const model = extractModelFromPbtxt(content)
        if (model) return model
      }
    } catch {}
  }

  return null
}

/**
 * Evaluates whether a quota snapshot indicates genuine exhaustion for a specific model.
 * Rule 6: 耗尽 = 该模型 5 小时窗口真实 remainingPercent === 0，或该模型所属周额度真实 0。
 * 未知 / 过期 / 失败 / 限流 / stale 不是 0。
 */
export function isModelExhausted(
  snapshot: AccountQuotaSnapshot | undefined,
  modelId: string
): boolean {
  if (!snapshot) return false
  if (snapshot.status !== 'ready') return false
  if (snapshot.stale === true) return false
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) return false

  const matchingWindows = snapshot.windows.filter((win) => {
    const matched =
      matchSupportedAntigravityModel(win.modelLabel) ||
      matchSupportedAntigravityModel(win.label) ||
      matchSupportedAntigravityModel(win.id)
    return matched?.id === modelId
  })

  if (matchingWindows.length === 0) return false

  // Exhausted if any matching window has verified remainingPercent === 0
  return matchingWindows.some((win) => win.remainingPercent === 0)
}

/**
 * Evaluates whether a candidate account has positive quota for the specific model.
 * Rule 7: 目标账号必须在同一当前模型上 remainingPercent > 0。别的模型有额度不算候选。
 */
export function isCandidateSuitable(
  snapshot: AccountQuotaSnapshot | undefined,
  modelId: string
): boolean {
  if (!snapshot) return false
  if (snapshot.status !== 'ready') return false
  if (snapshot.stale === true) return false
  if (!Array.isArray(snapshot.windows) || snapshot.windows.length === 0) return false

  const matchingWindows = snapshot.windows.filter((win) => {
    const matched =
      matchSupportedAntigravityModel(win.modelLabel) ||
      matchSupportedAntigravityModel(win.label) ||
      matchSupportedAntigravityModel(win.id)
    return matched?.id === modelId
  })

  if (matchingWindows.length === 0) return false

  // Cannot be candidate if any of its windows for this model is 0
  if (matchingWindows.some((win) => win.remainingPercent === 0)) {
    return false
  }

  // Must have at least one window with verified remainingPercent > 0
  return matchingWindows.some(
    (win) => typeof win.remainingPercent === 'number' && win.remainingPercent > 0
  )
}

export class AccountAutoSwitchService {
  private readonly manager: Pick<AccountManager, 'switchAccount' | 'getOverview'>
  private readonly store: AccountStore
  private readonly quotaService: AccountQuotaService
  private readonly notifyChanged: () => void
  private readonly options?: AccountAutoSwitchOptions
  private isSwitching = false
  private cooldownUntil = 0
  private lastStatus: string | undefined = undefined

  constructor(
    manager: Pick<AccountManager, 'switchAccount' | 'getOverview'>,
    store: AccountStore,
    quotaService: AccountQuotaService,
    notifyChanged: () => void,
    options?: AccountAutoSwitchOptions
  ) {
    this.manager = manager
    this.store = store
    this.quotaService = quotaService
    this.notifyChanged = notifyChanged
    this.options = options
  }

  private now(): number {
    return this.options?.now ? this.options.now() : Date.now()
  }

  private get configFilePath(): string {
    const accountsDir = this.store.accountsDir
    return path.join(accountsDir, '.auto-switch.json')
  }

  private readConfigFileSafely(): AccountAutoSwitchConfigFile {
    try {
      const filePath = this.configFilePath
      if (!existsSync(filePath)) {
        return { version: 1, tools: {} }
      }
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.version === 1 && typeof parsed.tools === 'object') {
        return parsed as AccountAutoSwitchConfigFile
      }
      return { version: 1, tools: {} }
    } catch {
      return { version: 1, tools: {} }
    }
  }

  private writeConfigFileSafely(config: AccountAutoSwitchConfigFile): void {
    const accountsDir = this.store.accountsDir
    if (!existsSync(accountsDir)) {
      mkdirSync(accountsDir, { recursive: true, mode: 0o700 })
    }
    const targetPath = this.configFilePath
    const tmpPath = path.join(
      accountsDir,
      `.auto_switch_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.json`
    )
    const payload = JSON.stringify(config, null, 2)
    writeFileSync(tmpPath, payload, { mode: 0o600, encoding: 'utf8' })
    try {
      chmodSync(tmpPath, 0o600)
    } catch {}
    renameSync(tmpPath, targetPath)
  }

  isEnabled(tool: AccountTool): boolean {
    if (tool !== 'antigravity') return false
    const config = this.readConfigFileSafely()
    return Boolean(config.tools[tool]?.enabled)
  }

  async setEnabled(tool: AccountTool, enabled: boolean): Promise<boolean> {
    if (tool !== 'antigravity') return false
    const config = this.readConfigFileSafely()
    config.tools[tool] = {
      enabled,
      updatedAt: this.now(),
    }
    this.writeConfigFileSafely(config)
    this.notifyChanged()
    return enabled
  }

  getStatus(tool: AccountTool): string | undefined {
    if (tool !== 'antigravity') return undefined
    return this.lastStatus
  }

  /**
   * Main evaluation loop. Hooked into renewal cadence and window focus.
   * Ensures active account is checked first; candidates are checked strictly on-demand.
   */
  async checkAndSwitch(trigger: 'scheduled' | 'focus' | 'manual' = 'scheduled'): Promise<AccountActionResult | null> {
    // 1. Check if enabled for Antigravity
    if (!this.isEnabled('antigravity')) {
      return null
    }

    // 2. Concurrency & Cooldown guards
    if (this.isSwitching) return null
    if (this.now() < this.cooldownUntil) return null

    // 3. Read overview for current account states
    const overview = await this.manager.getOverview()
    const toolState = overview.tools.find((t) => t.tool === 'antigravity')

    // Rule 10: recoveryNeeded -> do not switch
    if (toolState?.recoveryNeeded) {
      this.lastStatus = '检测到待恢复事务，已停止自动切换。'
      return null
    }

    const antigravityAccounts = overview.accounts.filter((a) => a.tool === 'antigravity')

    // Rule 10: 仅一个账号或无账号 -> 不切
    if (antigravityAccounts.length <= 1) {
      return null
    }

    // 4. Identify active account
    const activeAccountId = toolState?.activeAccountId
    if (!activeAccountId) {
      this.lastStatus = '未检测到当前 Antigravity 激活账号。'
      return null
    }

    const activeAccount = antigravityAccounts.find((a) => a.id === activeAccountId)
    if (!activeAccount) {
      return null
    }

    // 5. Try reading local current model
    const currentModel = readAntigravityCurrentModel(this.options)

    // 6. Check active account quota without querying any other account
    let activeSnapshot = this.quotaService.getCached([activeAccount])[0]
    const isFresh =
      activeSnapshot?.fetchedAt &&
      this.now() - activeSnapshot.fetchedAt < QUOTA_CACHE_TTL_MS &&
      !activeSnapshot.stale

    if (!isFresh) {
      // Check if in failure cooldown
      const inCooldown =
        activeSnapshot &&
        activeSnapshot.status !== 'ready' &&
        this.now() - activeSnapshot.attemptedAt < QUOTA_FAILURE_COOLDOWN_MS

      if (!inCooldown) {
        try {
          activeSnapshot = await this.quotaService.refreshAccount(activeAccountId)
        } catch {
          // Failure to refresh active account means quota is unknown, not exhausted
          if (!currentModel) {
            this.lastStatus = '无法识别当前 Antigravity 选用模型，已停止自动切换。'
          }
          return null
        }
      }
    }

    // 7. Determine models to evaluate for exhaustion
    let targetModels: SupportedAntigravityModel[] = []
    let isLocalModel = false

    if (currentModel) {
      // Rule 1: readAntigravityCurrentModel 成功时：保持现有逻辑，只盯这一个模型。
      if (!isModelExhausted(activeSnapshot, currentModel.id)) {
        // Current account still has quota (or quota unknown/stale/error)!
        // CRITICAL (Rule 4): DO NOT QUERY OTHER ACCOUNTS!
        return null
      }
      targetModels = [currentModel]
      isLocalModel = true
    } else {
      // Rule 2: 读不到（null / 占位枚举）时：
      // 用当前账号配额快照里、能映射到 7 个可见模型的窗口，作为耗尽判定对象。
      const hasAnyMappedVisibleModel =
        activeSnapshot?.status === 'ready' &&
        !activeSnapshot?.stale &&
        Array.isArray(activeSnapshot?.windows) &&
        activeSnapshot.windows.some((win) => {
          const matched =
            matchSupportedAntigravityModel(win.modelLabel) ||
            matchSupportedAntigravityModel(win.label) ||
            matchSupportedAntigravityModel(win.id)
          return Boolean(matched)
        })

      if (!hasAnyMappedVisibleModel) {
        // 快照中完全没有已映射可见模型时提示无法识别
        this.lastStatus = '无法识别当前 Antigravity 选用模型，已停止自动切换。'
        return null
      }

      targetModels = SUPPORTED_ANTIGRAVITY_MODELS.filter((m) =>
        isModelExhausted(activeSnapshot, m.id)
      )

      if (targetModels.length === 0) {
        // 配额回退成功且可见模型均未耗尽：静默 return null，不改 lastStatus
        return null
      }
    }

    // 8. Active account is confirmed exhausted on target model(s).
    // Evaluate candidates strictly on-demand.
    const candidateAccounts = antigravityAccounts.filter((a) => a.id !== activeAccountId)
    const candidateSnapshots = new Map<string, AccountQuotaSnapshot | undefined>()

    const getCandidateSnapshot = async (
      candidate: AccountMetadata
    ): Promise<AccountQuotaSnapshot | undefined> => {
      if (candidateSnapshots.has(candidate.id)) {
        return candidateSnapshots.get(candidate.id)
      }

      let candSnapshot: AccountQuotaSnapshot | undefined =
        this.quotaService.getCached([candidate])[0]
      const candFresh =
        candSnapshot?.fetchedAt &&
        this.now() - candSnapshot.fetchedAt < QUOTA_CACHE_TTL_MS &&
        !candSnapshot.stale

      if (!candFresh) {
        const inCooldown =
          candSnapshot &&
          candSnapshot.status !== 'ready' &&
          this.now() - candSnapshot.attemptedAt < QUOTA_FAILURE_COOLDOWN_MS

        if (!inCooldown) {
          try {
            candSnapshot = await this.quotaService.refreshAccount(candidate.id)
          } catch {
            candSnapshot = undefined
          }
        }
      }

      candidateSnapshots.set(candidate.id, candSnapshot)
      return candSnapshot
    }

    let chosenCandidate: AccountMetadata | null = null
    let triggeringModel: SupportedAntigravityModel | null = null

    for (const model of targetModels) {
      for (const candidate of candidateAccounts) {
        const candSnapshot = await getCandidateSnapshot(candidate)
        if (isCandidateSuitable(candSnapshot, model.id)) {
          chosenCandidate = candidate
          triggeringModel = model
          break
        }
      }
      if (chosenCandidate && triggeringModel) {
        break
      }
    }

    if (!chosenCandidate || !triggeringModel) {
      this.lastStatus = `所有可用账号的 ${targetModels[0].label} 额度均已耗尽，未执行切换。`
      this.notifyChanged()
      return null
    }

    // Rule 10: 开关中途关闭则中止
    if (!this.isEnabled('antigravity')) {
      return null
    }

    // 9. Execute switch via existing transaction lifecycle
    this.isSwitching = true
    try {
      const res = await this.manager.switchAccount(chosenCandidate.id)
      this.cooldownUntil = this.now() + AUTO_SWITCH_COOLDOWN_MS
      if (res.success) {
        if (isLocalModel) {
          this.lastStatus = `当前模型 ${triggeringModel.label} 额度已耗尽，已自动切换至账号「${chosenCandidate.name}」。`
        } else {
          this.lastStatus = `${triggeringModel.label} 额度已耗尽，已自动切换至账号「${chosenCandidate.name}」。`
        }
      } else {
        this.lastStatus = `自动切换至账号「${chosenCandidate.name}」失败：${res.error || '未知错误'}`
      }
      return res
    } catch (err: any) {
      this.lastStatus = `自动切换失败：${err?.message || '未知错误'}`
      return { success: false, error: err?.message || '未知错误' }
    } finally {
      this.isSwitching = false
      this.notifyChanged()
    }
  }
}
