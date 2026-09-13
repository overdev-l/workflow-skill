/**
 * AI Developer Account Settings & Workbench Component (OPC-48)
 *
 * Provides a native macOS-style UI for managing independent developer accounts
 * across Claude Code, OpenAI Codex, and Google Antigravity.
 *
 * Two-Column Workbench Architecture:
 * - Left App navigation (supervisor)
 * - Full right workbench (AccountSettings)
 * - Top-right tool tabs in order Claude / Codex / Antigravity with keyboard navigation
 * - Auto-fit grid of account cards with real quota windows, reset time, and one-click switch
 * - Bounded concurrency (max 2) quota fetcher with cache TTL and error cooldown
 * - Modals rendered as siblings outside backdrop-filter workbench section
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react'
import type {
  AccountActionResult,
  AccountManagementAPI,
  AccountMetadata,
  AccountQuotaSnapshot,
  AccountsOverview,
  AccountTool,
  AccountToolCapability,
  AccountToolState,
} from '@workflow-skill/workflow-model/accounts'
import { AIToolLogo } from '../AIToolLogo'
import { AccountQuotaCard } from './AccountQuotaCard'
import { useI18n } from '../i18n.tsx'
import '../accounts.css'

export type AccountSettingsAPI = AccountManagementAPI

export interface AccountSettingsProps {
  presentation?: 'settings' | 'workspace'
  api?: AccountManagementAPI
  onNotify?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

interface ToolDefinition {
  id: AccountTool
  labelKey: 'toolClaudeCode' | 'toolCodex' | 'toolAntigravity'
  pureLabelKey: 'toolPureClaudeCode' | 'toolPureCodex' | 'toolPureAntigravity'
  pureName: string
  brand: string
}

/**
 * Tool order strictly: Claude / Codex / Antigravity
 */
const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'claude-code',
    labelKey: 'toolClaudeCode',
    pureLabelKey: 'toolPureClaudeCode',
    pureName: 'Claude Code',
    brand: 'Claude Code',
  },
  {
    id: 'codex',
    labelKey: 'toolCodex',
    pureLabelKey: 'toolPureCodex',
    pureName: 'Codex',
    brand: 'Codex (ChatGPT)',
  },
  {
    id: 'antigravity',
    labelKey: 'toolAntigravity',
    pureLabelKey: 'toolPureAntigravity',
    pureName: 'Antigravity',
    brand: 'Antigravity (Google)',
  },
] as const

const MAX_CONCURRENT_QUOTA_REQUESTS = 2
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const QUOTA_FAILURE_COOLDOWN_MS = 60 * 1000 // 1 minute cooldown to prevent retry loops

const DICTIONARY = {
  'zh-CN': {
    headerTitle: 'AI 账号管理',
    masterHeading: '账号管理',
    headerDescription:
      '独立管理 Claude Code、Codex (ChatGPT) 与 Antigravity (Google) 的账号凭据。切换前自动备份账号文件，仅供新会话读取。',
    securityNotice:
      '凭据以明文保存在本机，文件权限限制为当前系统用户读写。Trace 不读写系统钥匙串。',
    legacyNoticeTitle: '历史配置快照提示',
    legacyNoticeDesc:
      '检测到此前创建的配置快照；历史快照已安全保留。当前账号管理仅负责独立的登录凭据，不再应用历史快照中的模型或 MCP 设定。',
    toolClaudeCode: 'Claude Code',
    toolCodex: 'Codex (ChatGPT)',
    toolAntigravity: 'Antigravity (Google)',
    toolPureClaudeCode: 'Claude',
    toolPureCodex: 'Codex',
    toolPureAntigravity: 'Antigravity',
    capabilityStatusReady: '本地支持',
    capabilityStatusLimited: '功能受限',
    activeIdentityLabel: '当前配置：',
    noActiveIdentity: '未检测到本地账号配置',
    activeBadge: '当前配置',
    currentAccountInUse: '当前使用中',
    sessionsNotice:
      '提示：切换仅更新本机账号凭证文件，在新终端或工具会话中生效。已有运行中的会话不会自动变更；项目配置或环境变量若存在可能覆盖全局账号。',
    refreshBtn: '刷新',
    rollbackBtn: '回滚上次切换',
    rollingBackBtn: '正在回滚…',
    captureBtn: '保存当前登录',
    importBtn: '导入凭据',
    addAccountBtn: '添加账号',
    addAccountModalTitle: (brand: string) => `添加 ${brand} 账号`,
    tabSaveLogin: '保存当前登录',
    tabImportCredential: '导入凭据',
    capabilityUnavailableTitle: '当前工具运行受限',
    capabilityUnavailableDesc: '该工具在当前 macOS 环境下未满足账号操作条件。',
    toolErrorTitle: '工具运行状态异常',
    recoveryBannerTitle: '检测到未完成的切换状态',
    recoveryBannerDesc:
      '上次切换操作未正常结束。系统已安全保护原始凭据备份，请点击紧急恢复按钮恢复至切换前状态。',
    emergencyRecoverBtn: '立即恢复',
    recoveringBtn: '正在恢复…',
    savedAccountsTitle: '已保存的账号列表',
    emptyAccountsTitle: '暂无保存的账号',
    emptyAccountsDesc:
      '可点击「导入凭据」添加账号凭据副本；若工具受支持亦可点击「保存当前登录」保存当前凭据。',
    switchBtn: '切换',
    switchingBtn: '正在写入…',
    renameBtn: '重命名',
    removeBtn: '移除',
    renameModalTitle: '重命名保存的账号',
    renameLabel: '新名称',
    renamePlaceholder: '例如：工作专属账号',
    confirmRenameBtn: '保存名称',
    savingNameBtn: '正在保存…',
    removeModalTitle: '移除保存的账号记录',
    removeModalPrompt: (name: string, toolName: string) =>
      `确定要从 Trace 移除保存的 ${toolName} 账号「${name}」吗？此操作仅删除本机保存的凭据副本，不会登出您的实际服务账号。`,
    confirmRemoveBtn: '确认移除',
    removingBtn: '正在移除…',
    captureModalHelp:
      'Trace 将读取本机当前工具已配置的凭据文件并保存为独立副本，供日后快速还原。',
    captureNameLabel: '账号名称',
    captureNamePlaceholder: '例如：个人账号',
    confirmCaptureBtn: '确认保存',
    capturingBtn: '正在保存…',
    importNameLabel: '账号名称',
    importNamePlaceholder: '例如：备用订阅账号',
    importCredentialLabel: '凭据内容',
    showSecretBtn: '显示明文',
    hideSecretBtn: '隐藏内容',
    importCredentialHelpAntigravity:
      '说明：请粘贴兼容文件登录配置的 Google 账号凭据文件内容（并非 Gemini API Key）。',
    importCredentialHelpCodex:
      '说明：请粘贴 Codex ChatGPT 的 auth.json 文件内容。',
    importCredentialHelpClaudeCode:
      '说明：请粘贴通过 claude setup-token 命令生成的 Claude 订阅凭据 Token。',
    importCredentialPlaceholder:
      '在此粘贴凭据内容（内容仅在提交时处理，保存后不会在界面中回显）…',
    confirmImportBtn: '确认导入',
    importingBtn: '正在导入…',
    cancelBtn: '取消',
    closeBtn: '关闭',
    nameRequired: '请输入有效的账号名称',
    credentialRequired: '请输入有效的凭据内容',
    loadError: '读取账号概览失败，请重试。',
    loading: '正在读取账号信息…',
    unavailableTitle: '原生桌面服务未连接',
    unavailableDesc: '账号管理依赖本地 Electron 桌面服务。请在桌面应用端运行。',
    captureSuccess: (name: string) => `已保存账号「${name}」`,
    importSuccess: (name: string) => `已导入账号「${name}」`,
    switchSuccess: (name: string) => `已写入「${name}」账号配置，请在新会话确认身份`,
    rollbackSuccess: '已回滚至上一次的账号凭据文件，请在新会话确认身份',
    recoverySuccess: '紧急恢复完成：已恢复原始账号凭据备份',
    renameSuccess: (name: string) => `账号已重命名为「${name}」`,
    deleteSuccess: (name: string) => `已移除账号「${name}」的本地副本`,
    accountIdLabel: 'ID',
    emailLabel: '邮箱',
    createdDatePrefix: '创建于',
    updatedDatePrefix: '更新于',
    expiresDatePrefix: '过期时间',
    quotaStatusReady: '正常',
    quotaStatusUnavailable: '不可用',
    quotaStatusExpired: '凭据已过期',
    quotaStatusForbidden: '无访问权限',
    quotaStatusRateLimited: '已被限流',
    quotaStatusError: '获取失败',
    quotaStatusStale: '可能已过时',
    quotaRemaining: '剩余',
    quotaUnknown: '未知',
    quotaResetsAt: (time: string) => `重置于 ${time}`,
    quotaResetUnavailable: '重置时间未知',
    quotaLastUpdated: (time: string) => `更新于 ${time}`,
    quotaNotFetched: '未获取配额信息',
    quotaLoading: '正在获取配额…',
    refreshQuotaBtn: '刷新配额',
    detailsLabel: '详情',
  },
  'en-US': {
    headerTitle: 'AI Account Manager',
    masterHeading: 'Accounts',
    headerDescription:
      'Manage independent credentials for Claude Code, Codex (ChatGPT), and Antigravity (Google). Credential files are backed up before switching and take effect in new sessions.',
    securityNotice:
      'Credentials are saved locally as plaintext files, restricted to read/write by the current user. Trace does not access the system keychain.',
    legacyNoticeTitle: 'Legacy Snapshot Profiles',
    legacyNoticeDesc:
      'Previous environment snapshots are safely preserved. Account management now independently handles sign-in credentials and no longer applies model or MCP settings from legacy snapshots.',
    toolClaudeCode: 'Claude Code',
    toolCodex: 'Codex (ChatGPT)',
    toolAntigravity: 'Antigravity (Google)',
    toolPureClaudeCode: 'Claude',
    toolPureCodex: 'Codex',
    toolPureAntigravity: 'Antigravity',
    capabilityStatusReady: 'Supported',
    capabilityStatusLimited: 'Limited / Unsupported',
    activeIdentityLabel: 'Configured Account:',
    noActiveIdentity: 'No local account configuration detected',
    activeBadge: 'Configured',
    currentAccountInUse: 'In Use',
    sessionsNotice:
      'Notice: Swapping only updates local credential files for new sessions. Existing sessions are not altered automatically. Project-level configs or environment variables take precedence if present.',
    refreshBtn: 'Refresh',
    rollbackBtn: 'Rollback Last Switch',
    rollingBackBtn: 'Rolling back…',
    captureBtn: 'Save Active Account',
    importBtn: 'Import Credential',
    addAccountBtn: 'Add Account',
    addAccountModalTitle: (brand: string) => `Add ${brand} Account`,
    tabSaveLogin: 'Save Active Account',
    tabImportCredential: 'Import Credential',
    capabilityUnavailableTitle: 'Tool Currently Unavailable',
    capabilityUnavailableDesc:
      'Account management requirements are not met for this tool in the current environment.',
    toolErrorTitle: 'Tool State Error',
    recoveryBannerTitle: 'Interrupted Switch Detected',
    recoveryBannerDesc:
      'The previous switch operation did not finish cleanly. An original backup is preserved. Click emergency recovery to restore pre-switch state.',
    emergencyRecoverBtn: 'Emergency Recover',
    recoveringBtn: 'Recovering…',
    savedAccountsTitle: 'Saved Accounts',
    emptyAccountsTitle: 'No Saved Accounts Yet',
    emptyAccountsDesc:
      'Click "Import Credential" to save an account copy, or click "Save Active Account" if the tool is supported.',
    switchBtn: 'Switch',
    switchingBtn: 'Writing…',
    renameBtn: 'Rename',
    removeBtn: 'Remove',
    renameModalTitle: 'Rename Saved Account',
    renameLabel: 'New Name',
    renamePlaceholder: 'e.g., Work Account',
    confirmRenameBtn: 'Save Name',
    savingNameBtn: 'Saving…',
    removeModalTitle: 'Remove Saved Account Copy',
    removeModalPrompt: (name: string, toolName: string) =>
      `Remove saved copy of "${name}" for ${toolName} from Trace? This only deletes the local copy and will not log you out of your actual remote account.`,
    confirmRemoveBtn: 'Confirm Remove',
    removingBtn: 'Removing…',
    captureModalHelp:
      'Trace will read your active credentials on this computer and save an independent copy for fast restoration.',
    captureNameLabel: 'Account Name',
    captureNamePlaceholder: 'e.g., Personal Subscription',
    confirmCaptureBtn: 'Save & Capture',
    capturingBtn: 'Saving…',
    importNameLabel: 'Account Name',
    importNamePlaceholder: 'e.g., Backup Work Account',
    importCredentialLabel: 'Credential Content',
    showSecretBtn: 'Show',
    hideSecretBtn: 'Hide',
    importCredentialHelpAntigravity:
      'Help: Paste Google account credential file contents from a compatible file-login setup (not Gemini API key).',
    importCredentialHelpCodex:
      'Help: Paste auth.json contents for Codex ChatGPT.',
    importCredentialHelpClaudeCode:
      'Help: Paste Claude subscription token generated by claude setup-token.',
    importCredentialPlaceholder:
      'Paste credential content here (never displayed after saving)…',
    confirmImportBtn: 'Import Account',
    importingBtn: 'Importing…',
    cancelBtn: 'Cancel',
    closeBtn: 'Close',
    nameRequired: 'Please enter a valid account name',
    credentialRequired: 'Please enter valid credential content',
    loadError: 'Failed to load accounts overview. Please try again.',
    loading: 'Loading account information…',
    unavailableTitle: 'Desktop Service Unavailable',
    unavailableDesc:
      'Account management requires native Electron desktop services. Please run in the Trace Desktop application.',
    captureSuccess: (name: string) => `Saved account "${name}"`,
    importSuccess: (name: string) => `Imported account "${name}"`,
    switchSuccess: (name: string) => `Configured account "${name}". Verify identity in a new session.`,
    rollbackSuccess: 'Rolled back to previous account credential file. Verify identity in a new session.',
    recoverySuccess: 'Emergency recovery completed: restored original credential backup',
    renameSuccess: (name: string) => `Account renamed to "${name}"`,
    deleteSuccess: (name: string) => `Removed local copy of "${name}"`,
    accountIdLabel: 'ID',
    emailLabel: 'Email',
    createdDatePrefix: 'Created',
    updatedDatePrefix: 'Updated',
    expiresDatePrefix: 'Expires',
    quotaStatusReady: 'Ready',
    quotaStatusUnavailable: 'Unavailable',
    quotaStatusExpired: 'Expired',
    quotaStatusForbidden: 'Forbidden',
    quotaStatusRateLimited: 'Rate Limited',
    quotaStatusError: 'Error',
    quotaStatusStale: 'Stale',
    quotaRemaining: 'Remaining',
    quotaUnknown: 'Unknown',
    quotaResetsAt: (time: string) => `Resets at ${time}`,
    quotaResetUnavailable: 'Reset unavailable',
    quotaLastUpdated: (time: string) => `Updated ${time}`,
    quotaNotFetched: 'No quota data',
    quotaLoading: 'Fetching quota…',
    refreshQuotaBtn: 'Refresh quota',
    detailsLabel: 'Details',
  },
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback
  let message = ''
  if (typeof error === 'string') {
    message = error.trim()
  } else if (error instanceof Error) {
    message = error.message.trim()
  } else if (typeof (error as any)?.message === 'string') {
    message = (error as any).message.trim()
  } else if (typeof (error as any)?.error === 'string') {
    message = (error as any).error.trim()
  }
  if (!message || message === '[object Object]') {
    message = fallback
  }
  if (message.length > 240) {
    message = message.slice(0, 237) + '…'
  }
  return message
}

export function AccountSettings({
  presentation = 'settings',
  api,
  onNotify,
}: AccountSettingsProps) {
  const { resolvedLocale } = useI18n()
  const loc = DICTIONARY[resolvedLocale] || DICTIONARY['zh-CN']

  // Tool Selection strictly Claude / Codex / Antigravity
  const [selectedTool, setSelectedTool] = useState<AccountTool>('claude-code')

  // Top Tabs Ref for Keyboard Navigation
  const tabButtonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (isBusy) return
    let nextIndex = -1
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      nextIndex = (index + 1) % TOOLS.length
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      nextIndex = (index - 1 + TOOLS.length) % TOOLS.length
    } else if (e.key === 'Home') {
      e.preventDefault()
      nextIndex = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      nextIndex = TOOLS.length - 1
    }
    if (nextIndex >= 0) {
      setSelectedTool(TOOLS[nextIndex].id)
      setErrorMessage(null)
      tabButtonRefs.current[nextIndex]?.focus()
    }
  }

  // Overview State
  const [overview, setOverview] = useState<AccountsOverview | null>(null)
  const overviewRef = useRef<AccountsOverview | null>(null)
  overviewRef.current = overview

  const [loading, setLoading] = useState<boolean>(true)
  const [isBusy, setIsBusy] = useState<boolean>(false)
  const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showCapabilityDetails, setShowCapabilityDetails] = useState<boolean>(false)

  // Quotas State & Concurrency Management
  const [quotas, setQuotas] = useState<Record<string, AccountQuotaSnapshot>>({})
  const [inFlightQuotas, setInFlightQuotas] = useState<Set<string>>(new Set())
  const inFlightQuotasRef = useRef<Set<string>>(new Set())

  const failedQuotaAttempts = useRef<Map<string, number>>(new Map())
  const quotaFetchQueue = useRef<string[]>([])
  const activeWorkers = useRef<number>(0)

  // Modals & Form States
  const [showAddAccountModal, setShowAddAccountModal] = useState<boolean>(false)
  const [addAccountMethod, setAddAccountMethod] = useState<'capture' | 'import'>('capture')
  const [captureName, setCaptureName] = useState<string>('')
  const [importName, setImportName] = useState<string>('')
  const [importCredential, setImportCredential] = useState<string>('')
  const [isCredentialMasked, setIsCredentialMasked] = useState<boolean>(true)

  const [pendingRenameAccount, setPendingRenameAccount] = useState<AccountMetadata | null>(null)
  const [renameName, setRenameName] = useState<string>('')
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<AccountMetadata | null>(null)

  // Focus & Accessibility Element Refs
  const captureInputRef = useRef<HTMLInputElement>(null)
  const importNameInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null)

  // Modal IDs for ARIA
  const addAccountModalTitleId = useId()
  const renameModalTitleId = useId()
  const deleteModalTitleId = useId()

  // Stale async result & unmount guards
  const isMountedRef = useRef<boolean>(true)
  const reqSeqRef = useRef<number>(0)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Derived state for the currently selected tool
  const currentCapability = useMemo<AccountToolCapability | undefined>(() => {
    const capability = overview?.capabilities.find((c) => c.tool === selectedTool)
    if (!capability || resolvedLocale !== 'en-US') return capability
    const reasons = {
      'codex-auth-conflict': 'Codex is configured for API sign-in or another provider. Resolve the authentication conflict in Codex first.',
      'claude-auth-conflict': 'An environment token, API key, authentication helper, or another provider takes precedence. Resolve the conflict in Claude first.',
      'antigravity-file-mode-required': 'Native Antigravity file-based switching is not yet verified. You can save accounts and query quotas; switching remains unavailable.',
    }
    const details = {
      'codex-file': 'Uses ChatGPT auth.json with file credential storage. Verify identity in a new Codex session; project configuration and launch arguments can override global settings.',
      'claude-setup-token': 'Imports a subscription token from claude setup-token into settings.json. Supports model requests and local MCP; Remote Control and Claude.ai connectors are unavailable. Email, expiry and usage permissions require separate verification.',
      'antigravity-ssh-file': 'File switching is limited to the CLI fallback in a real SSH session. Native desktop switching without Keychain is unverified. Trace does not access Keychain or substitute Gemini API keys.',
    }
    return {
      ...capability,
      reason: capability.reasonCode ? reasons[capability.reasonCode] : capability.reason,
      details: capability.detailsCode ? details[capability.detailsCode] : capability.details,
    }
  }, [overview, selectedTool, resolvedLocale])

  const isAvailable = currentCapability ? currentCapability.available : true

  const currentToolState = useMemo<AccountToolState | undefined>(() => {
    return overview?.tools.find((t) => t.tool === selectedTool)
  }, [overview, selectedTool])

  const activeAccountId = currentToolState?.activeAccountId
  const activeIdentity = currentToolState?.activeIdentity

  const canRollback =
    Boolean(currentToolState?.canRollback) && !currentToolState?.recoveryNeeded
  const isRecoveryNeeded = Boolean(currentToolState?.recoveryNeeded)

  const toolSavedAccounts = useMemo<AccountMetadata[]>(() => {
    if (!overview?.accounts) return []
    return overview.accounts.filter((a) => a.tool === selectedTool)
  }, [overview, selectedTool])

  const activeAccount = useMemo<AccountMetadata | undefined>(() => {
    return toolSavedAccounts.find((a) => a.id === activeAccountId)
  }, [toolSavedAccounts, activeAccountId])

  const currentToolDefinition = useMemo<ToolDefinition>(() => {
    return TOOLS.find((t) => t.id === selectedTool) || TOOLS[0]
  }, [selectedTool])

  // Process bounded concurrency quota queue (max 2)
  const processQuotaQueue = useCallback(() => {
    if (!api || typeof api.refreshQuota !== 'function' || !isMountedRef.current) return

    while (
      activeWorkers.current < MAX_CONCURRENT_QUOTA_REQUESTS &&
      quotaFetchQueue.current.length > 0
    ) {
      const nextAccountId = quotaFetchQueue.current.shift()
      if (!nextAccountId) break
      if (inFlightQuotasRef.current.has(nextAccountId)) continue

      // Verify account still exists in current accounts
      const currentAccounts = overviewRef.current?.accounts || []
      const account = currentAccounts.find((a) => a.id === nextAccountId)
      if (!account) {
        continue // Deleted, skip
      }

      activeWorkers.current++
      inFlightQuotasRef.current.add(nextAccountId)
      setInFlightQuotas(new Set(inFlightQuotasRef.current))

      api
        .refreshQuota(nextAccountId)
        .then((snapshot) => {
          if (!isMountedRef.current) return
          // Race guard: ensure account STILL exists in latest accounts
          const latestAccounts = overviewRef.current?.accounts || []
          const stillExists = latestAccounts.some((a) => a.id === nextAccountId && a.tool === account.tool && a.updatedAt === account.updatedAt)
          if (!stillExists) return // Discard deleted account result

          if (snapshot && snapshot.accountId === nextAccountId && snapshot.tool === account.tool) {
            setQuotas((prev) => ({
              ...prev,
              [nextAccountId]: snapshot,
            }))
            if (snapshot.status === 'ready') failedQuotaAttempts.current.delete(nextAccountId)
            else failedQuotaAttempts.current.set(nextAccountId, snapshot.attemptedAt)
          }
        })
        .catch(() => {
          if (!isMountedRef.current) return
          if (!overviewRef.current?.accounts.some((a) => a.id === nextAccountId && a.updatedAt === account.updatedAt)) return
          failedQuotaAttempts.current.set(nextAccountId, Date.now())
          setQuotas((prev) => {
            const existing = prev[nextAccountId]
            return {
              ...prev,
              [nextAccountId]: {
                accountId: nextAccountId,
                tool: account.tool,
                status: 'error',
                windows: existing?.windows || [],
                attemptedAt: Date.now(),
                fetchedAt: existing?.fetchedAt,
                stale: Boolean(existing),
              },
            }
          })
        })
        .finally(() => {
          activeWorkers.current--
          inFlightQuotasRef.current.delete(nextAccountId)
          if (isMountedRef.current) {
            setInFlightQuotas(new Set(inFlightQuotasRef.current))
            processQuotaQueue()
          }
        })
    }
  }, [api])

  // Enqueue visible accounts for quota fetch
  const enqueueVisibleQuotas = useCallback(
    (forceRefresh = false) => {
      if (!api || typeof api.refreshQuota !== 'function') return
      const now = Date.now()
      const candidates: string[] = []

      for (const account of toolSavedAccounts) {
        if (inFlightQuotasRef.current.has(account.id)) continue
        if (quotaFetchQueue.current.includes(account.id)) continue

        const snapshot = quotas[account.id]
        if (forceRefresh) {
          candidates.push(account.id)
          continue
        }

        if (!snapshot) {
          const lastFailed = failedQuotaAttempts.current.get(account.id)
          if (!lastFailed || now - lastFailed >= QUOTA_FAILURE_COOLDOWN_MS) {
            candidates.push(account.id)
          }
        } else {
          const lastTime = snapshot.attemptedAt || snapshot.fetchedAt || 0
          if (now - lastTime > QUOTA_CACHE_TTL_MS) {
            const lastFailed = failedQuotaAttempts.current.get(account.id)
            if (!lastFailed || now - lastFailed >= QUOTA_FAILURE_COOLDOWN_MS) {
              candidates.push(account.id)
            }
          }
        }
      }

      if (candidates.length > 0) {
        quotaFetchQueue.current.push(...candidates)
        processQuotaQueue()
      }
    },
    [api, toolSavedAccounts, quotas, processQuotaQueue]
  )

  // Trigger quota fetching when selected tool changes or accounts list loaded
  const lastToolRunRef = useRef<string>('')
  const lastAccountIdsRef = useRef<string>('')

  useEffect(() => {
    const currentAccountIds = toolSavedAccounts.map((a) => `${a.id}:${a.updatedAt}`).sort().join(',')
    if (
      lastToolRunRef.current !== selectedTool ||
      lastAccountIdsRef.current !== currentAccountIds
    ) {
      lastToolRunRef.current = selectedTool
      lastAccountIdsRef.current = currentAccountIds
      quotaFetchQueue.current = quotaFetchQueue.current.filter(id => toolSavedAccounts.some(account => account.id === id))
      enqueueVisibleQuotas(false)
    }
  }, [selectedTool, toolSavedAccounts, enqueueVisibleQuotas])

  // Single account explicit quota refresh
  const handleRefreshAccountQuota = useCallback(
    (accountId: string) => {
      if (!api || typeof api.refreshQuota !== 'function' || isBusy) return
      if (inFlightQuotasRef.current.has(accountId)) return
      failedQuotaAttempts.current.delete(accountId)
      if (!quotaFetchQueue.current.includes(accountId)) {
        quotaFetchQueue.current.unshift(accountId)
      }
      processQuotaQueue()
    },
    [api, isBusy, processQuotaQueue]
  )

  // Load Overview Data
  const loadData = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }

    const seq = ++reqSeqRef.current
    try {
      setLoading(true)
      const data = await api.getOverview()
      if (!isMountedRef.current || seq !== reqSeqRef.current) return
      setOverview(data)
      overviewRef.current = data

      // Merge backend quotas without erasing in-flight state or fresher local records
      {
        setQuotas((prev) => {
          const next = Object.fromEntries(Object.entries(prev).filter(([id]) => data.accounts.some(account => account.id === id)))
          for (const q of data.quotas ?? []) {
            if (!inFlightQuotasRef.current.has(q.accountId)) {
              const existing = next[q.accountId]
              if (!existing || q.attemptedAt >= (existing.attemptedAt || 0)) {
                next[q.accountId] = q
              }
            }
          }
          return next
        })
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || seq !== reqSeqRef.current) return
      setErrorMessage(formatErrorMessage(err, loc.loadError))
    } finally {
      if (isMountedRef.current && seq === reqSeqRef.current) {
        setLoading(false)
      }
    }
  }, [api, loc.loadError])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // Register onAccountsChanged once and unsubscribe
  useEffect(() => {
    if (!api?.onAccountsChanged) return
    const unsubscribe = api.onAccountsChanged(() => {
      void loadData()
    })
    return () => {
      unsubscribe?.()
    }
  }, [api, loadData])

  // Focus management when modals open
  useEffect(() => {
    if (showAddAccountModal) {
      if (addAccountMethod === 'capture') {
        captureInputRef.current?.focus()
      } else {
        importNameInputRef.current?.focus()
      }
    }
  }, [showAddAccountModal, addAccountMethod])

  useEffect(() => {
    if (pendingRenameAccount) {
      renameInputRef.current?.focus()
    }
  }, [pendingRenameAccount])

  useEffect(() => {
    if (pendingDeleteAccount) {
      confirmDeleteButtonRef.current?.focus()
    }
  }, [pendingDeleteAccount])

  // Common Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        if (pendingRenameAccount) {
          setPendingRenameAccount(null)
          setRenameName('')
        } else if (pendingDeleteAccount) {
          setPendingDeleteAccount(null)
        } else if (showAddAccountModal) {
          setShowAddAccountModal(false)
          setCaptureName('')
          setImportName('')
          setImportCredential('')
          setIsCredentialMasked(true)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, pendingRenameAccount, pendingDeleteAccount, showAddAccountModal])

  // Focus Trap within Modal Dialogs
  const handleModalTrapKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    onClose: () => void
  ) => {
    if (event.key === 'Escape') {
      if (!isBusy) {
        event.stopPropagation()
        onClose()
      }
      return
    }
    if (event.key !== 'Tab') return

    const focusables = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    )
    if (!focusables.length) return

    const index = focusables.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const nextIndex =
      (index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length
    focusables[nextIndex]?.focus()
  }

  // Error recovery helper
  const handleFailure = async (error: unknown, fallbackMessage: string) => {
    const sanitized = formatErrorMessage(error, fallbackMessage)
    setErrorMessage(sanitized)
    onNotify?.(sanitized, 'error')
    await loadData()
  }

  // Capture Account Submit
  const handleCaptureSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api || isBusy || !isAvailable) return

    const trimmed = captureName.trim()
    if (!trimmed) {
      setErrorMessage(loc.nameRequired)
      return
    }

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const created = await api.captureAccount({
        tool: selectedTool,
        name: trimmed,
      })
      setCaptureName('')
      setShowAddAccountModal(false)
      onNotify?.(loc.captureSuccess(created.name), 'success')
      await loadData()
    } catch (err: unknown) {
      await handleFailure(err, 'Failed to capture account.')
    } finally {
      setIsBusy(false)
    }
  }

  // Import Credential Submit
  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api || isBusy) return

    const trimmedName = importName.trim()
    if (!trimmedName) {
      setErrorMessage(loc.nameRequired)
      return
    }
    const trimmedCredential = importCredential.trim()
    if (!trimmedCredential) {
      setErrorMessage(loc.credentialRequired)
      return
    }

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const created = await api.importAccount({
        tool: selectedTool,
        name: trimmedName,
        credential: trimmedCredential,
      })
      setImportCredential('')
      setImportName('')
      setIsCredentialMasked(true)
      setShowAddAccountModal(false)
      onNotify?.(loc.importSuccess(created.name), 'success')
      await loadData()
    } catch (err: unknown) {
      setImportCredential('')
      await handleFailure(err, 'Failed to import credential.')
    } finally {
      setIsBusy(false)
    }
  }

  // One-click Switch: invokes API directly without confirmation modal
  const handleDirectSwitch = async (account: AccountMetadata) => {
    if (!api || isBusy || !isAvailable || isRecoveryNeeded) return
    if (account.id === activeAccountId) return

    try {
      setIsBusy(true)
      setSwitchingAccountId(account.id)
      setErrorMessage(null)

      const res: AccountActionResult = await api.switchAccount(account.id)
      if (res && res.success) {
        onNotify?.(loc.switchSuccess(account.name), 'success')
        await loadData()
      } else {
        await handleFailure(res?.error, 'Failed to switch account.')
      }
    } catch (err: unknown) {
      await handleFailure(err, 'Failed to switch account.')
    } finally {
      setIsBusy(false)
      setSwitchingAccountId(null)
    }
  }

  // Rollback Action
  const handleRollback = async () => {
    if (!api || isBusy || !canRollback) return

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res: AccountActionResult = await api.rollbackAccount(selectedTool)
      if (res && res.success) {
        onNotify?.(loc.rollbackSuccess, 'success')
        await loadData()
      } else {
        await handleFailure(res?.error, 'Failed to rollback account switch.')
      }
    } catch (err: unknown) {
      await handleFailure(err, 'Failed to rollback account switch.')
    } finally {
      setIsBusy(false)
    }
  }

  // Emergency Recovery Action
  const handleEmergencyRecovery = async () => {
    if (!api || isBusy) return

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res: AccountActionResult = await api.recoverAccount(selectedTool)
      if (res && res.success) {
        onNotify?.(loc.recoverySuccess, 'success')
        await loadData()
      } else {
        await handleFailure(res?.error, 'Emergency recovery could not complete.')
      }
    } catch (err: unknown) {
      await handleFailure(err, 'Emergency recovery failed.')
    } finally {
      setIsBusy(false)
    }
  }

  // Rename Action
  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api || !pendingRenameAccount || isBusy) return

    const trimmed = renameName.trim()
    if (!trimmed) {
      setErrorMessage(loc.nameRequired)
      return
    }

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const updated = await api.renameAccount(pendingRenameAccount.id, trimmed)
      setPendingRenameAccount(null)
      setRenameName('')
      onNotify?.(loc.renameSuccess(updated.name), 'success')
      await loadData()
    } catch (err: unknown) {
      setPendingRenameAccount(null)
      await handleFailure(err, 'Failed to rename account.')
    } finally {
      setIsBusy(false)
    }
  }

  // Delete Action
  const handleDeleteConfirmed = async () => {
    if (!api || !pendingDeleteAccount || isBusy) return
    const target = pendingDeleteAccount

    try {
      setIsBusy(true)
      setErrorMessage(null)
      await api.deleteAccount(target.id)
      setPendingDeleteAccount(null)
      onNotify?.(loc.deleteSuccess(target.name), 'success')
      await loadData()
    } catch (err: unknown) {
      setPendingDeleteAccount(null)
      await handleFailure(err, 'Failed to remove saved account copy.')
    } finally {
      setIsBusy(false)
    }
  }

  // Refresh visible accounts and overview
  const handleRefreshAll = async () => {
    setErrorMessage(null)
    await loadData()
    enqueueVisibleQuotas(true)
  }

  const formatDate = (timestamp?: number): string | null => {
    if (!timestamp) return null
    try {
      return new Date(timestamp).toLocaleDateString(resolvedLocale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    } catch {
      return null
    }
  }

  const getImportHelpText = (tool: AccountTool): string => {
    switch (tool) {
      case 'antigravity':
        return loc.importCredentialHelpAntigravity
      case 'codex':
        return loc.importCredentialHelpCodex
      case 'claude-code':
        return loc.importCredentialHelpClaudeCode
    }
  }

  // Open Add Account modal with specific method
  const openAddAccount = (method: 'capture' | 'import' = 'capture') => {
    if (isBusy) return
    const targetMethod = !isAvailable && method === 'capture' ? 'import' : method
    setAddAccountMethod(targetMethod)
    setCaptureName('')
    setImportName('')
    setImportCredential('')
    setIsCredentialMasked(true)
    setShowAddAccountModal(true)
  }

  if (!api) {
    const unavailableContent = (
      <div className="account-card">
        <div className="account-empty-state">
          <span className="account-empty-title">{loc.unavailableTitle}</span>
          <span className="account-empty-desc">{loc.unavailableDesc}</span>
        </div>
      </div>
    )

    if (presentation === 'workspace') {
      return (
        <section className="app-col-detail account-workbench-stage view-enter">
          <div className="account-workbench-wrap">{unavailableContent}</div>
        </section>
      )
    }

    return <div className="account-settings-container">{unavailableContent}</div>
  }

  // Modals Node: rendered as siblings outside workbench section to cover all columns
  const modalsNode = (
    <>
      {/* Unified Add Account Modal (Save Active Login & Import Credential) */}
      {showAddAccountModal && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={addAccountModalTitleId}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isBusy) {
              setShowAddAccountModal(false)
            }
          }}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => setShowAddAccountModal(false))
          }
        >
          <div
            className="account-modal-box"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="account-modal-header">
              <h4 id={addAccountModalTitleId} className="account-modal-title">
                {loc.addAccountModalTitle(currentToolDefinition.brand)}
              </h4>
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => setShowAddAccountModal(false)}
                disabled={isBusy}
                aria-label={loc.closeBtn}
              >
                <X size={10} />
              </button>
            </div>

            {/* Segmented Method Switcher */}
            <div
              className="account-modal-tabs"
              role="tablist"
              aria-label="Add Method"
            >
              <button
                type="button"
                role="tab"
                aria-selected={addAccountMethod === 'capture'}
                className={`account-modal-tab-btn ${
                  addAccountMethod === 'capture'
                    ? 'account-modal-tab-btn--active'
                    : ''
                }`}
                onClick={() => setAddAccountMethod('capture')}
                disabled={isBusy}
              >
                <Download size={11} />
                <span>{loc.tabSaveLogin}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={addAccountMethod === 'import'}
                className={`account-modal-tab-btn ${
                  addAccountMethod === 'import'
                    ? 'account-modal-tab-btn--active'
                    : ''
                }`}
                onClick={() => setAddAccountMethod('import')}
                disabled={isBusy}
              >
                <Upload size={11} />
                <span>{loc.tabImportCredential}</span>
              </button>
            </div>

            {addAccountMethod === 'capture' ? (
              <form onSubmit={handleCaptureSubmit} className="account-modal-body">
                <span className="account-modal-help">{loc.captureModalHelp}</span>

                {!isAvailable && (
                  <div className="account-tool-error-callout" role="alert">
                    <AlertTriangle size={13} className="account-tool-error-icon" />
                    <div className="account-tool-error-body">
                      <strong>{loc.capabilityUnavailableTitle}</strong>
                      <span>
                        {currentCapability?.reason || loc.capabilityUnavailableDesc}
                      </span>
                    </div>
                  </div>
                )}

                <div className="account-field-group">
                  <label
                    htmlFor="account-capture-name-input"
                    className="account-label"
                  >
                    {loc.captureNameLabel} *
                  </label>
                  <input
                    id="account-capture-name-input"
                    ref={captureInputRef}
                    type="text"
                    className="account-input"
                    value={captureName}
                    onChange={(e) => setCaptureName(e.target.value)}
                    placeholder={loc.captureNamePlaceholder}
                    disabled={isBusy || !isAvailable}
                    maxLength={100}
                    required
                  />
                </div>

                <div className="account-modal-actions">
                  <button
                    type="button"
                    className="account-btn"
                    onClick={() => setShowAddAccountModal(false)}
                    disabled={isBusy}
                  >
                    {loc.cancelBtn}
                  </button>
                  <button
                    type="submit"
                    className="account-btn account-btn--primary"
                    disabled={isBusy || !isAvailable || !captureName.trim()}
                  >
                    {isBusy ? loc.capturingBtn : loc.confirmCaptureBtn}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleImportSubmit} className="account-modal-body">
                <span className="account-modal-help">
                  {getImportHelpText(selectedTool)}
                </span>

                <div className="account-field-group">
                  <label
                    htmlFor="account-import-name-input"
                    className="account-label"
                  >
                    {loc.importNameLabel} *
                  </label>
                  <input
                    id="account-import-name-input"
                    ref={importNameInputRef}
                    type="text"
                    className="account-input"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder={loc.importNamePlaceholder}
                    disabled={isBusy}
                    maxLength={100}
                    required
                  />
                </div>

                <div className="account-field-group">
                  <div className="account-field-header">
                    <label
                      htmlFor="account-import-credential-input"
                      className="account-label"
                    >
                      {loc.importCredentialLabel} *
                    </label>
                    <button
                      type="button"
                      className="account-mask-toggle-btn"
                      onClick={() => setIsCredentialMasked((prev) => !prev)}
                      tabIndex={0}
                      title={
                        isCredentialMasked ? loc.showSecretBtn : loc.hideSecretBtn
                      }
                    >
                      {isCredentialMasked ? <Eye size={12} /> : <EyeOff size={12} />}
                      <span>
                        {isCredentialMasked ? loc.showSecretBtn : loc.hideSecretBtn}
                      </span>
                    </button>
                  </div>
                  <textarea
                    id="account-import-credential-input"
                    className={`account-textarea ${
                      isCredentialMasked ? 'account-textarea--masked' : ''
                    }`}
                    value={importCredential}
                    onChange={(e) => setImportCredential(e.target.value)}
                    placeholder={loc.importCredentialPlaceholder}
                    disabled={isBusy}
                    spellCheck={false}
                    rows={4}
                    required
                  />
                </div>

                <div className="account-modal-actions">
                  <button
                    type="button"
                    className="account-btn"
                    onClick={() => setShowAddAccountModal(false)}
                    disabled={isBusy}
                  >
                    {loc.cancelBtn}
                  </button>
                  <button
                    type="submit"
                    className="account-btn account-btn--primary"
                    disabled={
                      isBusy || !importName.trim() || !importCredential.trim()
                    }
                  >
                    {isBusy ? loc.importingBtn : loc.confirmImportBtn}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Rename Account Modal */}
      {pendingRenameAccount && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={renameModalTitleId}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isBusy) {
              setPendingRenameAccount(null)
              setRenameName('')
            }
          }}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => {
              setPendingRenameAccount(null)
              setRenameName('')
            })
          }
        >
          <div
            className="account-modal-box"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="account-modal-header">
              <h4 id={renameModalTitleId} className="account-modal-title">
                {loc.renameModalTitle}
              </h4>
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => {
                  setPendingRenameAccount(null)
                  setRenameName('')
                }}
                disabled={isBusy}
                aria-label={loc.closeBtn}
              >
                <X size={10} />
              </button>
            </div>

            <form onSubmit={handleRenameSubmit} className="account-modal-body">
              <div className="account-field-group">
                <label htmlFor="account-rename-input" className="account-label">
                  {loc.renameLabel} *
                </label>
                <input
                  id="account-rename-input"
                  ref={renameInputRef}
                  type="text"
                  className="account-input"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  placeholder={loc.renamePlaceholder}
                  disabled={isBusy}
                  maxLength={100}
                  required
                />
              </div>

              <div className="account-modal-actions">
                <button
                  type="button"
                  className="account-btn"
                  onClick={() => {
                    setPendingRenameAccount(null)
                    setRenameName('')
                  }}
                  disabled={isBusy}
                >
                  {loc.cancelBtn}
                </button>
                <button
                  type="submit"
                  className="account-btn account-btn--primary"
                  disabled={isBusy || !renameName.trim()}
                >
                  {isBusy ? loc.savingNameBtn : loc.confirmRenameBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Account Modal */}
      {pendingDeleteAccount && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={deleteModalTitleId}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isBusy) {
              setPendingDeleteAccount(null)
            }
          }}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => setPendingDeleteAccount(null))
          }
        >
          <div
            className="account-modal-box"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="account-modal-header">
              <h4 id={deleteModalTitleId} className="account-modal-title">
                {loc.removeModalTitle}
              </h4>
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => setPendingDeleteAccount(null)}
                disabled={isBusy}
                aria-label={loc.closeBtn}
              >
                <X size={10} />
              </button>
            </div>

            <div className="account-modal-body">
              <p>
                {loc.removeModalPrompt(
                  pendingDeleteAccount.name,
                  currentToolDefinition.brand
                )}
              </p>
            </div>

            <div className="account-modal-actions">
              <button
                type="button"
                className="account-btn"
                onClick={() => setPendingDeleteAccount(null)}
                disabled={isBusy}
              >
                {loc.cancelBtn}
              </button>
              <button
                ref={confirmDeleteButtonRef}
                type="button"
                className="account-btn account-btn--danger"
                onClick={handleDeleteConfirmed}
                disabled={isBusy}
              >
                {isBusy ? loc.removingBtn : loc.confirmRemoveBtn}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  // Capability strip: concise tool-level notice preserving unsupported switch reason (no Keychain)
  const capabilityStripNode = (
    <div className="account-capability-strip">
      <div className="account-capability-strip-left">
        <span
          className={`account-capability-label ${
            isAvailable
              ? 'account-capability-label--ready'
              : 'account-capability-label--limited'
          }`}
        >
          {isAvailable ? loc.capabilityStatusReady : loc.capabilityStatusLimited}
        </span>
        {currentCapability?.reason && (
          <span className="account-capability-reason">
            {currentCapability.reason}
          </span>
        )}
      </div>
      {currentCapability?.details && (
        <button
          type="button"
          className="account-capability-details-toggle"
          onClick={() => setShowCapabilityDetails((prev) => !prev)}
        >
          <span>{loc.detailsLabel}</span>
          <ChevronDown
            size={11}
            className={`transition-transform duration-150 ${
              showCapabilityDetails ? 'rotate-180' : ''
            }`}
          />
        </button>
      )}
    </div>
  )

  // Account Card Grid Content
  const gridContentNode = (
    <div
      role="tabpanel"
      id={`account-panel-${selectedTool}`}
      aria-labelledby={`account-tab-${selectedTool}`}
      className="account-grid-stage"
    >
      {loading && !overview && (
        <p className="account-desc" role="status">
          {loc.loading}
        </p>
      )}

      {toolSavedAccounts.length > 0 ? (
        <div className="account-grid">
          {toolSavedAccounts.map((account) => {
            const isActive = account.id === activeAccountId
            const snapshot = quotas[account.id]
            const isQuotaLoading = inFlightQuotas.has(account.id)
            const isSwitching = switchingAccountId === account.id

            return (
              <AccountQuotaCard
                key={account.id}
                account={account}
                isActive={isActive}
                isAvailable={isAvailable}
                isBusy={isBusy}
                isSwitching={isSwitching}
                isRecoveryNeeded={isRecoveryNeeded}
                unsupportedReason={currentCapability?.reason}
                snapshot={snapshot}
                isQuotaLoading={isQuotaLoading}
                onSwitch={handleDirectSwitch}
                onRename={(acc) => {
                  setRenameName(acc.name)
                  setPendingRenameAccount(acc)
                }}
                onDelete={(acc) => setPendingDeleteAccount(acc)}
                onRefreshQuota={handleRefreshAccountQuota}
                formatDate={formatDate}
                loc={loc}
                locale={resolvedLocale}
              />
            )
          })}
        </div>
      ) : (
        !loading && (
          <div className="account-empty-state">
            <span className="account-empty-title">{loc.emptyAccountsTitle}</span>
            <span className="account-empty-desc">{loc.emptyAccountsDesc}</span>
            <div className="account-empty-actions">
              <button
                type="button"
                className="account-btn"
                onClick={() => openAddAccount('capture')}
                disabled={!isAvailable || isBusy || isRecoveryNeeded}
                title={
                  !isAvailable
                    ? currentCapability?.reason || loc.capabilityStatusLimited
                    : loc.captureBtn
                }
              >
                <Download size={11} />
                <span>{loc.captureBtn}</span>
              </button>
              <button
                type="button"
                className="account-btn account-btn--primary"
                onClick={() => openAddAccount('import')}
                disabled={isBusy}
              >
                <Upload size={11} />
                <span>{loc.importBtn}</span>
              </button>
            </div>
          </div>
        )
      )}
    </div>
  )

  // 1. Workspace Presentation (Two Columns overall: Left app nav + full right workbench)
  if (presentation === 'workspace') {
    return (
      <>
        <section className="app-col-detail account-workbench-stage view-enter" aria-label={loc.headerTitle}>
          <div className="account-workbench-wrap">
            {/* Compact header: tool tabs on the left, account actions on the right. */}
            <div className="account-workbench-header">
              <div
                role="tablist"
                aria-label="AI Tools"
                className="account-tool-tabs"
              >
                {TOOLS.map((tool, index) => {
                  const isSelected = selectedTool === tool.id
                  return (
                    <button
                      key={tool.id}
                      ref={(el) => {
                        tabButtonRefs.current[index] = el
                      }}
                      id={`account-tab-${tool.id}`}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      aria-controls={`account-panel-${tool.id}`}
                      tabIndex={isSelected ? 0 : -1}
                      className={`account-tool-tab-btn ${
                        isSelected ? 'account-tool-tab-btn--active' : ''
                      }`}
                      onClick={() => {
                        if (!isBusy && selectedTool !== tool.id) {
                          setSelectedTool(tool.id)
                          setErrorMessage(null)
                        }
                      }}
                      onKeyDown={(e) => handleTabKeyDown(e, index)}
                      disabled={isBusy}
                    >
                      <AIToolLogo toolId={tool.id} size={13} color />
                      <span>{loc[tool.pureLabelKey] || tool.pureName}</span>
                    </button>
                  )
                })}
              </div>
              <div className="account-workbench-actions">
                {canRollback && (
                  <button
                    type="button"
                    className="account-btn account-btn--sm"
                    onClick={handleRollback}
                    disabled={isBusy}
                    title={loc.rollbackBtn}
                  >
                    <RotateCcw size={11} />
                    <span>{isBusy ? loc.rollingBackBtn : loc.rollbackBtn}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="account-btn account-btn--primary"
                  onClick={() => openAddAccount(isAvailable ? 'capture' : 'import')}
                  disabled={isBusy}
                >
                  <Plus size={12} />
                  <span>{loc.addAccountBtn}</span>
                </button>
              </div>
            </div>

            {/* Error Callout */}
            {errorMessage && (
              <div className="account-error-callout" role="alert">
                <span>{errorMessage}</span>
                <button
                  type="button"
                  className="account-btn account-btn--sm"
                  onClick={() => setErrorMessage(null)}
                  aria-label={loc.closeBtn}
                >
                  <X size={10} />
                </button>
              </div>
            )}

            {/* Recovery Banner */}
            {isRecoveryNeeded && (
              <div className="account-recovery-banner" role="status">
                <div className="account-recovery-info">
                  <AlertTriangle size={18} className="account-recovery-icon" />
                  <div className="account-recovery-text">
                    <strong>{loc.recoveryBannerTitle}</strong>
                    <p>{currentToolState?.error || loc.recoveryBannerDesc}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="account-btn account-btn--danger account-btn--sm"
                  onClick={handleEmergencyRecovery}
                  disabled={isBusy}
                >
                  <RotateCcw size={12} />
                  <span>{isBusy ? loc.recoveringBtn : loc.emergencyRecoverBtn}</span>
                </button>
              </div>
            )}

            {/* Tool State Error Callout */}
            {currentToolState?.error && (
              <div className="account-tool-error-callout" role="alert">
                <AlertTriangle size={14} className="account-tool-error-icon" />
                <div className="account-tool-error-body">
                  <strong>{loc.toolErrorTitle}</strong>
                  <span>{currentToolState.error}</span>
                </div>
              </div>
            )}

            {/* Account Cards Grid */}
            {gridContentNode}
          </div>
        </section>
        {modalsNode}
      </>
    )
  }

  // 2. Settings Presentation Mode (Native macOS 2-Column Settings View)
  return (
    <div className="account-settings-container">
      <div className="account-card">
        <div className="account-header-row">
          <h3 className="account-title">{loc.headerTitle}</h3>
        </div>

        <p className="account-desc">{loc.headerDescription}</p>
        <p className="account-security-notice">{loc.securityNotice}</p>

        {overview?.legacyProfilesPresent && (
          <div className="account-legacy-notice" role="status">
            <Info size={14} className="account-legacy-icon" />
            <div>
              <strong>{loc.legacyNoticeTitle}：</strong>
              <span>{loc.legacyNoticeDesc}</span>
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="account-error-callout" role="alert">
            <span>{errorMessage}</span>
            <button
              type="button"
              className="account-btn account-btn--sm"
              onClick={() => setErrorMessage(null)}
              aria-label={loc.closeBtn}
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* Tool Segmented Tabs */}
        <div
          role="tablist"
          aria-label="AI Tools"
          className="account-tool-tabs"
          style={{ alignSelf: 'flex-start' }}
        >
          {TOOLS.map((tool, index) => {
            const isSelected = selectedTool === tool.id
            return (
              <button
                key={tool.id}
                ref={(el) => {
                  tabButtonRefs.current[index] = el
                }}
                id={`account-settings-tab-${tool.id}`}
                type="button"
                role="tab"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                className={`account-tool-tab-btn ${
                  isSelected ? 'account-tool-tab-btn--active' : ''
                }`}
                onClick={() => {
                  if (!isBusy && selectedTool !== tool.id) {
                    setSelectedTool(tool.id)
                    setErrorMessage(null)
                  }
                }}
                onKeyDown={(e) => handleTabKeyDown(e, index)}
                disabled={isBusy}
              >
                <AIToolLogo toolId={tool.id} size={13} color />
                <span>{loc[tool.pureLabelKey] || tool.pureName}</span>
              </button>
            )
          })}
        </div>

        {/* Selected Tool Stage */}
        <div className="account-tool-stage">
          {capabilityStripNode}

          {currentToolState?.error && (
            <div className="account-tool-error-callout" role="alert">
              <AlertTriangle size={14} className="account-tool-error-icon" />
              <div className="account-tool-error-body">
                <strong>{loc.toolErrorTitle}</strong>
                <span>{currentToolState.error}</span>
              </div>
            </div>
          )}

          {isRecoveryNeeded && (
            <div className="account-recovery-banner" role="status">
              <div className="account-recovery-info">
                <AlertTriangle size={18} className="account-recovery-icon" />
                <div className="account-recovery-text">
                  <strong>{loc.recoveryBannerTitle}</strong>
                  <p>{currentToolState?.error || loc.recoveryBannerDesc}</p>
                </div>
              </div>
              <button
                type="button"
                className="account-btn account-btn--danger account-btn--sm"
                onClick={handleEmergencyRecovery}
                disabled={isBusy}
              >
                <RotateCcw size={12} />
                <span>{isBusy ? loc.recoveringBtn : loc.emergencyRecoverBtn}</span>
              </button>
            </div>
          )}

          {/* Configured Identity Bar & Action Controls */}
          <div className="account-tool-header">
            <div className="account-tool-identity-group">
              <span className="account-tool-identity-label">
                {loc.activeIdentityLabel}
              </span>
              {activeIdentity || activeAccount ? (
                <span className="account-tool-identity-chip">
                  <User size={12} />
                  <span>
                    {activeAccount?.name || activeIdentity}
                    {activeAccount?.email &&
                    activeAccount.name !== activeAccount.email
                      ? ` (${activeAccount.email})`
                      : ''}
                  </span>
                </span>
              ) : (
                <span className="account-tool-identity-chip account-tool-identity-chip--empty">
                  <span>{loc.noActiveIdentity}</span>
                </span>
              )}
            </div>

            <div className="account-tool-actions">
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={handleRefreshAll}
                disabled={loading || isBusy}
                title={loc.refreshBtn}
              >
                <RefreshCw
                  size={12}
                  className={loading ? 'animate-spin' : ''}
                />
                <span>{loc.refreshBtn}</span>
              </button>

              {canRollback && (
                <button
                  type="button"
                  className="account-btn account-btn--sm"
                  onClick={handleRollback}
                  disabled={isBusy}
                  title={loc.rollbackBtn}
                >
                  <RotateCcw size={12} />
                  <span>{isBusy ? loc.rollingBackBtn : loc.rollbackBtn}</span>
                </button>
              )}

              <button
                type="button"
                className="account-btn account-btn--primary account-btn--sm"
                onClick={() => openAddAccount(isAvailable ? 'capture' : 'import')}
                disabled={isBusy}
              >
                <Plus size={12} />
                <span>{loc.addAccountBtn}</span>
              </button>
            </div>
          </div>

          <p className="account-sessions-hint">{loc.sessionsNotice}</p>

          {/* Cards Grid */}
          {gridContentNode}
        </div>
      </div>
      {modalsNode}
    </div>
  )
}
