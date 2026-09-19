import { useUpdateBlocker } from './AppUpdate'
/**
 * AI Developer Account Settings & Workbench Component (OPC-48)
 *
 * Provides a native macOS-style UI for managing independent developer accounts
 * across Claude Code, OpenAI Codex, and Google Antigravity.
 *
 * Two-Column Workbench Architecture:
 * - Left App navigation (supervisor)
 * - Full right workbench (AccountSettings)
 * - Top-left tool tabs in order Claude / Codex / Antigravity with keyboard navigation
 * - Auto-fit grid of account cards with real quota windows, reset time, and one-click switch
 * - Bounded concurrency (max 2) quota fetcher with cache TTL and error cooldown
 * - Modals rendered as siblings outside backdrop-filter workbench section
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Upload,
  User,
  X,
} from 'lucide-react'
import {
  type AccountActionResult,
  type AccountDiscoveryResult,
  type AccountDiscoveryStatus,
  type AccountManagementAPI,
  type AccountOAuthSession,
  type AccountMetadata,
  type AccountQuotaSnapshot,
  type AccountsOverview,
  type AccountTool,
  type AccountToolCapability,
  type AccountToolState,
  cleanAccountErrorMessage,
} from '@workflow-skill/workflow-model/accounts'
import { AIToolLogo } from '../AIToolLogo'
import { AccountQuotaCard } from './AccountQuotaCard'
import { useI18n } from '../i18n.tsx'
import '../accounts.css'

export type AccountSettingsAPI = AccountManagementAPI

export interface AccountSettingsProps {
  presentation?: 'settings' | 'workspace'
  api?: AccountSettingsAPI
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
    activeBadge: '当前账号',
    currentAccountInUse: '当前使用中',
    sessionsNotice:
      '提示：切换仅更新本机账号凭证文件，在新终端或工具会话中生效。已有运行中的会话不会自动变更；项目配置或环境变量若存在可能覆盖全局账号。',
    refreshBtn: '刷新',
    refreshAllBtn: '刷新全部',
    refreshingAllBtn: '刷新中…',
    rollbackBtn: '回滚上次切换',
    rollingBackBtn: '正在回滚…',
    captureBtn: '保存当前登录',
    importBtn: '导入凭据',
    addAccountBtn: '添加账号',
    addAccountModalTitle: (brand: string) => `添加 ${brand} 账号`,
    tabOAuthLogin: 'OAuth 登录',
    tabImportCredential: '导入凭据',
    oauthModalHelp:
      '点击下方按钮将在系统默认浏览器中打开官方登录页面。完成授权后，Trace 会自动检测并保存您的账号凭据。',
    signInWithTool: (toolName: string) => `使用 ${toolName} 登录`,
    oauthStarting: '正在启动官方登录会话…',
    oauthStatusWaiting: '已在浏览器打开登录页面，等待授权完成…',
    oauthStatusWaitingDesc:
      '请在浏览器中完成登录与权限授予。授权成功后，Trace 将自动保存凭据。',
    oauthStatusExchanging: '正在验证授权并保存凭据…',
    oauthStatusExchangingDesc:
      '正在与服务提供商完成令牌交换并安全写入本机凭据副本。',
    oauthReopenBrowserBtn: '重新打开浏览器',
    oauthCancelBtn: '取消登录',
    oauthExpired: '登录会话已过期，请重试。',
    oauthFailed: '登录失败，请重试。',
    oauthSuccess: (brand: string) => `已成功保存 ${brand} 账号至 Trace`,
    discoveryExpiredNotice:
      '检测到当前工具本地凭据已过期或失效，建议重新通过 OAuth 登录。',
    discoveryErrorNotice: '自动检测当前工具本地账号时发生异常。',
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
      '暂未检测到本机凭据文件。您可以通过「OAuth 登录」授权添加账号，或手动「导入凭据」保存副本。',
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
      '说明：支持粘贴完整的 claudeAiOauth JSON 认证凭据，或通过 claude setup-token 命令生成的订阅凭据 Token。',
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
    importFailure: '导入凭据失败，请检查格式后重试。',
    switchSuccess: (name: string) => `已写入「${name}」账号配置，请在新会话确认身份`,
    switchFailure: '切换账号失败，请重试。',
    rollbackSuccess: '已回滚至上一次的账号凭据文件，请在新会话确认身份',
    rollbackFailure: '回滚账号切换失败，请重试。',
    recoverySuccess: '紧急恢复完成：已恢复原始账号凭据备份',
    recoveryFailure: '紧急恢复失败，请重试。',
    renameSuccess: (name: string) => `账号已重命名为「${name}」`,
    renameFailure: '重命名账号失败，请重试。',
    deleteSuccess: (name: string) => `已移除账号「${name}」的本地副本`,
    deleteFailure: '移除账号副本失败，请重试。',
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
    autoSwitchLabel: '自动切换',
    autoSwitchDesc: '额度耗尽时自动切至可用账号',
    autoSwitchFullDesc: '当前选用模型额度耗尽后自动切换至有额度的账号（可能重启客户端）',
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
    activeBadge: 'Current account',
    currentAccountInUse: 'In Use',
    sessionsNotice:
      'Notice: Swapping only updates local credential files for new sessions. Existing sessions are not altered automatically. Project-level configs or environment variables take precedence if present.',
    refreshBtn: 'Refresh',
    refreshAllBtn: 'Refresh all',
    refreshingAllBtn: 'Refreshing…',
    rollbackBtn: 'Rollback Last Switch',
    rollingBackBtn: 'Rolling back…',
    captureBtn: 'Save Active Account',
    importBtn: 'Import Credential',
    addAccountBtn: 'Add Account',
    addAccountModalTitle: (brand: string) => `Add ${brand} Account`,
    tabOAuthLogin: 'OAuth Login',
    tabImportCredential: 'Import Credential',
    oauthModalHelp:
      'Click the button below to open the official sign-in page in your default browser. After authorization, Trace will automatically detect and save your account credential.',
    signInWithTool: (toolName: string) => `Sign in with ${toolName}`,
    oauthStarting: 'Starting official sign-in session…',
    oauthStatusWaiting: 'Sign-in page opened in your browser. Waiting for authorization…',
    oauthStatusWaitingDesc:
      'Please complete authorization in your browser. Trace will automatically save your credential once complete.',
    oauthStatusExchanging: 'Exchanging authorization token…',
    oauthStatusExchangingDesc:
      'Completing token exchange with provider and saving account credential…',
    oauthReopenBrowserBtn: 'Reopen Browser',
    oauthCancelBtn: 'Cancel Sign-in',
    oauthExpired: 'Sign-in session expired. Please try again.',
    oauthFailed: 'Sign-in failed. Please try again.',
    oauthSuccess: (brand: string) => `Saved ${brand} account to Trace`,
    discoveryExpiredNotice:
      'Local credential for this tool has expired. Please re-authenticate via OAuth.',
    discoveryErrorNotice:
      'An error occurred while automatically checking local accounts for this tool.',
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
      'No local credential file detected. You can add an account via "OAuth Login" or manually "Import Credential".',
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
      'Help: Paste full claudeAiOauth JSON credentials, or subscription token generated by claude setup-token.',
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
    importFailure: 'Failed to import credential.',
    switchSuccess: (name: string) => `Configured account "${name}". Verify identity in a new session.`,
    switchFailure: 'Failed to switch account.',
    rollbackSuccess: 'Rolled back to previous account credential file. Verify identity in a new session.',
    rollbackFailure: 'Failed to rollback account switch.',
    recoverySuccess: 'Emergency recovery completed: restored original credential backup',
    recoveryFailure: 'Emergency recovery failed.',
    renameSuccess: (name: string) => `Account renamed to "${name}"`,
    renameFailure: 'Failed to rename account.',
    deleteSuccess: (name: string) => `Removed local copy of "${name}"`,
    deleteFailure: 'Failed to remove saved account copy.',
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
    autoSwitchLabel: 'Auto Switch',
    autoSwitchDesc: 'Auto-switch when model quota is exhausted',
    autoSwitchFullDesc:
      'Automatically switch to an account with remaining quota when the active model is exhausted (may restart client).',
  },
}

export function formatErrorMessage(error: unknown, fallback: string): string {
  return cleanAccountErrorMessage(error, fallback)
}

export function AccountSettings({
  presentation = 'settings',
  api: propApi,
  onNotify,
}: AccountSettingsProps) {
  const { resolvedLocale } = useI18n()
  const loc = DICTIONARY[resolvedLocale] || DICTIONARY['zh-CN']

  const api: AccountSettingsAPI | undefined =
    propApi || (typeof window !== 'undefined' ? (window as any).workflowSkill?.accounts : undefined)
  const apiRef = useRef<AccountSettingsAPI | undefined>(api)
  useEffect(() => {
    apiRef.current = api
  }, [api])

  // Tool Selection strictly Claude / Codex / Antigravity
  const [selectedTool, setSelectedTool] = useState<AccountTool>('claude-code')
  // Top Tabs Ref for Keyboard Navigation
  const tabButtonRefs = useRef<(HTMLButtonElement | null)[]>([])

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

  // OAuth Session State (OPC-48)
  const [oauthSession, setOauthSession] = useState<AccountOAuthSession | null>(null)
  const [isStartingOAuth, setIsStartingOAuth] = useState<boolean>(false)
  const [isCancellingOAuth, setIsCancellingOAuth] = useState(false)
  const [oauthError, setOauthError] = useState<string | null>(null)

  const activeSessionRef = useRef<{ id: string; tool: AccountTool } | null>(null)
  const startPendingRef = useRef<boolean>(false)
  const cancelPendingOnStartRef = useRef<boolean>(false)
  const sessionGenerationRef = useRef<number>(0)
  const terminalNotifiedRef = useRef<string | null>(null)

  const isOAuthPending = isStartingOAuth || isCancellingOAuth || Boolean(oauthSession) || startPendingRef.current

  // Auto Account Discovery State (OPC-48)
  const [discoveryResults, setDiscoveryResults] = useState<
    Partial<Record<AccountTool, AccountDiscoveryResult>>
  >({})
  const [dismissedFeedback, setDismissedFeedback] = useState<Record<string, boolean>>({})
  const [dismissedLegacyNotice, setDismissedLegacyNotice] = useState<boolean>(() => {
    try {
      return localStorage.getItem('trace_account_dismissed_legacy_notice') === 'true'
    } catch {
      return false
    }
  })
  const isSyncingAccountsRef = useRef<boolean>(false)
  const lastAccountSyncTimeRef = useRef<number>(0)

  // Modals & Form States
  const [showAddAccountModal, setShowAddAccountModal] = useState<boolean>(false)
  const [addAccountMethod, setAddAccountMethod] = useState<'oauth' | 'import'>('oauth')
  const [importName, setImportName] = useState<string>('')
  const [importCredential, setImportCredential] = useState<string>('')
  const [isCredentialMasked, setIsCredentialMasked] = useState<boolean>(true)
  useUpdateBlocker('account-editor', showAddAccountModal || isBusy)

  const [pendingRenameAccount, setPendingRenameAccount] = useState<AccountMetadata | null>(null)
  const [renameName, setRenameName] = useState<string>('')
  useUpdateBlocker('account-rename', Boolean(pendingRenameAccount))
  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<AccountMetadata | null>(null)

  // Stable refs for scan & race-condition guards
  const isBusyRef = useRef<boolean>(isBusy)
  isBusyRef.current = isBusy
  const showAddAccountModalRef = useRef<boolean>(showAddAccountModal)
  showAddAccountModalRef.current = showAddAccountModal
  const isStartingOAuthRef = useRef<boolean>(isStartingOAuth)
  isStartingOAuthRef.current = isStartingOAuth
  const loadDataRef = useRef<(() => Promise<void>) | null>(null)
  const enqueueVisibleQuotasRef = useRef<((forceRefresh?: boolean) => void) | null>(null)

  // Focus & Accessibility Element Refs
  const oauthSignInButtonRef = useRef<HTMLButtonElement>(null)
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
      sessionGenerationRef.current++
      if (startPendingRef.current) {
        cancelPendingOnStartRef.current = true
      }
      const sessionToCancel = activeSessionRef.current
      activeSessionRef.current = null
      if (sessionToCancel && apiRef.current && typeof apiRef.current.cancelOAuth === 'function') {
        apiRef.current.cancelOAuth(sessionToCancel.id).catch(() => {})
      }
    }
  }, [])

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (isBusy || isOAuthPending) return
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

  // Derived state for the currently selected tool
  const currentCapability = useMemo<AccountToolCapability | undefined>(() => {
    const capability = overview?.capabilities.find((c) => c.tool === selectedTool)
    if (!capability) return capability

    const reasonsEn: Record<string, string> = {
      'codex-auth-conflict': 'Codex is configured for API sign-in or another provider. Resolve the authentication conflict in Codex first.',
      'claude-auth-conflict': 'An environment token, API key, authentication helper, or another provider takes precedence. Resolve the conflict in Claude first.',
      'antigravity-file-mode-required': 'This environment does not support native Antigravity switching.',
      'antigravity-helper-unavailable': 'The Antigravity authentication helper is missing. Rebuild the app.',
      'antigravity-auth-conflict': 'Another Antigravity authentication source takes precedence. Resolve it before switching.',
    }
    const reasonsZh: Record<string, string> = {
      'codex-auth-conflict': 'Codex 已配置为 API 登录或其他提供商。请先在 Codex 中解决认证冲突。',
      'claude-auth-conflict': '检测到环境令牌、API Key、认证辅助程序或其他提供商配置；请先在 Claude 中处理认证优先级冲突。',
      'antigravity-file-mode-required': '当前环境不支持 Antigravity 原生账号切换。',
      'antigravity-helper-unavailable': 'Antigravity 认证助手未安装，请重新构建应用。',
      'antigravity-auth-conflict': 'Antigravity 存在其他优先认证来源，请先处理冲突。',
    }

    const detailsEn: Record<string, string> = {
      'codex-file': 'Uses ChatGPT auth.json with file credential storage. Verify identity in a new Codex session; project configuration and launch arguments can override global settings.',
      'claude-setup-token': 'Stores full OAuth login or imported subscription credentials; switching projects the access token into settings.json env. Supports model requests and local MCP; Remote Control and Claude.ai connectors remain unchanged and unavailable. Verify identity in a new session; setup-token alone cannot confirm email or expiry offline.',
      'antigravity-ssh-file': 'Uses only the CLI fallback file in a real SSH session; native desktop authentication is unchanged.',
      'antigravity-native-keychain': 'Antigravity CLI and desktop share native credentials. Switching or rolling back reopens the running desktop client. Existing CLI sessions remain open; new CLI sessions use the selected account. Only the Antigravity Keychain item is accessed; saved accounts remain in local files.',
    }
    const detailsZh: Record<string, string> = {
      'codex-file': '使用 ChatGPT auth.json 文件凭据存储。请在新 Codex 会话中确认身份；项目配置和启动参数可能会覆盖全局设置。',
      'claude-setup-token': '完整保存 OAuth 官方登录凭据或导入的订阅凭据；切换时仍向 settings.json 环境变量投影 access token。支持模型请求与本地 MCP；Remote Control 与 Claude.ai 连接器保持不变且不可用。请在新会话中确认身份；单独的 setup-token 无法离线验证邮箱或有效期。',
      'antigravity-ssh-file': '仅使用真实 SSH 会话中的 CLI 后备文件，不改变原生客户端认证。',
      'antigravity-native-keychain': 'Antigravity CLI 与客户端共享原生认证。切换或回滚时会正常退出并重新打开正在运行的客户端。现有 CLI 会话保留，新 CLI 会话使用所选账号。仅访问 Antigravity 钥匙串项，账号库仍保存在本地文件。',
    }

    const reasons = resolvedLocale === 'en-US' ? reasonsEn : reasonsZh
    const details = resolvedLocale === 'en-US' ? detailsEn : detailsZh

    return {
      ...capability,
      reason: capability.reasonCode && reasons[capability.reasonCode] ? reasons[capability.reasonCode] : capability.reason,
      details: capability.detailsCode && details[capability.detailsCode] ? details[capability.detailsCode] : capability.details,
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
    (forceRefresh = false, respectFailureCooldown = false) => {
      if (!api || typeof api.refreshQuota !== 'function') return
      const now = Date.now()
      const candidates: string[] = []

      for (const account of toolSavedAccounts) {
        if (inFlightQuotasRef.current.has(account.id)) continue
        if (quotaFetchQueue.current.includes(account.id)) continue

        const snapshot = quotas[account.id]
        const lastFailed = failedQuotaAttempts.current.get(account.id)
        if (respectFailureCooldown && lastFailed && now - lastFailed < QUOTA_FAILURE_COOLDOWN_MS) continue
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
  enqueueVisibleQuotasRef.current = enqueueVisibleQuotas

  // Trigger quota fetching when selected tool changes or accounts list loaded
  const lastToolRunRef = useRef<string>('')
  const lastAccountIdsRef = useRef<string>('')

  useEffect(() => {
    const currentAccountIds = toolSavedAccounts.map((a) => `${a.id}:${a.updatedAt}`).sort().join(',')
    const toolChanged = lastToolRunRef.current !== selectedTool
    if (
      toolChanged ||
      lastAccountIdsRef.current !== currentAccountIds
    ) {
      lastToolRunRef.current = selectedTool
      lastAccountIdsRef.current = currentAccountIds
      quotaFetchQueue.current = quotaFetchQueue.current.filter(id => toolSavedAccounts.some(account => account.id === id))
      enqueueVisibleQuotas(toolChanged, true)
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
  loadDataRef.current = loadData

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
      if (addAccountMethod === 'oauth') {
        oauthSignInButtonRef.current?.focus()
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
          void closeAddAccountModal()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, pendingRenameAccount, pendingDeleteAccount, showAddAccountModal, isStartingOAuth, oauthSession])

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

  // OAuth Session Handlers (OPC-48)
  const handleOAuthSuccess = useCallback(
    async (session: AccountOAuthSession, tool: AccountTool) => {
      const notifyKey = `success:${session.id}`
      if (terminalNotifiedRef.current === notifyKey) {
        return
      }
      terminalNotifiedRef.current = notifyKey

      activeSessionRef.current = null
      setOauthSession(null)
      setShowAddAccountModal(false)

      // Clear import state and reset mask toggle even after switching tabs
      setImportName('')
      setImportCredential('')
      setIsCredentialMasked(true)

      const toolDef = TOOLS.find((t) => t.id === tool) || currentToolDefinition
      onNotify?.(loc.oauthSuccess(toolDef.brand), 'success')

      await loadData()

      if (session.accountId) {
        handleRefreshAccountQuota(session.accountId)
      } else {
        enqueueVisibleQuotas(true)
      }
    },
    [currentToolDefinition, enqueueVisibleQuotas, handleRefreshAccountQuota, loadData, loc, onNotify]
  )

  const handleOAuthTerminal = useCallback(
    (session: AccountOAuthSession) => {
      const notifyKey = `terminal:${session.id}:${session.phase}`
      if (terminalNotifiedRef.current === notifyKey) {
        return
      }
      terminalNotifiedRef.current = notifyKey

      activeSessionRef.current = null
      setOauthSession(null)
      if (session.phase === 'expired') {
        setOauthError(loc.oauthExpired)
      } else if (session.phase === 'error') {
        setOauthError(
          session.error ? formatErrorMessage(session.error, loc.oauthFailed) : loc.oauthFailed
        )
      } else if (session.phase === 'cancelled') {
        setOauthError(null)
      }
    },
    [loc.oauthExpired, loc.oauthFailed]
  )

  const handleStartOAuth = async () => {
    if (
      !api ||
      typeof api.startOAuth !== 'function' ||
      isBusy ||
      isStartingOAuth ||
      isCancellingOAuth ||
      startPendingRef.current ||
      Boolean(activeSessionRef.current) ||
      Boolean(oauthSession)
    ) {
      return
    }

    const targetTool = selectedTool
    const generation = ++sessionGenerationRef.current

    setIsStartingOAuth(true)
    setOauthError(null)
    startPendingRef.current = true
    cancelPendingOnStartRef.current = false

    try {
      const session = await api.startOAuth(targetTool)

      if (
        !isMountedRef.current ||
        generation !== sessionGenerationRef.current ||
        cancelPendingOnStartRef.current
      ) {
        cancelPendingOnStartRef.current = false
        if (session?.id && apiRef.current && typeof apiRef.current.cancelOAuth === 'function') {
          try {
            await apiRef.current.cancelOAuth(session.id).catch(() => {})
            if (typeof apiRef.current.getOAuthSession === 'function') {
              const terminal = await apiRef.current.getOAuthSession(session.id)
              if (isMountedRef.current && terminal && terminal.phase === 'succeeded') {
                await handleOAuthSuccess(terminal, targetTool)
                return
              }
            }
          } catch {
            // ignore
          }
        }
        return
      }

      if (!session || !session.id) {
        throw new Error(loc.oauthFailed)
      }

      activeSessionRef.current = { id: session.id, tool: targetTool }
      setOauthSession(session)

      if (session.phase === 'succeeded') {
        await handleOAuthSuccess(session, targetTool)
      } else if (
        session.phase === 'cancelled' ||
        session.phase === 'expired' ||
        session.phase === 'error'
      ) {
        handleOAuthTerminal(session)
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== sessionGenerationRef.current) return
      setOauthError(formatErrorMessage(err, loc.oauthFailed))
    } finally {
      startPendingRef.current = false
      cancelPendingOnStartRef.current = false
      if (isMountedRef.current) {
        setIsStartingOAuth(false)
      }
    }
  }

  // OAuth Session Polling (OPC-48)
  useEffect(() => {
    if (!oauthSession || !api || typeof api.getOAuthSession !== 'function') return
    if (oauthSession.phase !== 'waiting' && oauthSession.phase !== 'exchanging') return

    const sessionId = oauthSession.id
    const sessionTool = oauthSession.tool
    const generation = sessionGenerationRef.current
    const expiresAt = oauthSession.expiresAt

    let isPolling = false
    let consecutiveErrors = 0
    let stopped = false
    const isCurrent = () => !stopped && isMountedRef.current && generation === sessionGenerationRef.current && activeSessionRef.current?.id === sessionId
    const interval = setInterval(async () => {
      if (!isCurrent() || isPolling) return
      isPolling = true
      try {
        let updated = await api.getOAuthSession(sessionId)
        if (!isCurrent()) return
        if (!updated || updated.id !== sessionId || updated.tool !== sessionTool) throw new Error(loc.oauthFailed)
        // Ask the backend for the commit result before displaying a local timeout.
        if ((updated.phase === 'waiting' || updated.phase === 'exchanging') && Date.now() >= expiresAt) {
          await api.cancelOAuth(sessionId)
          updated = await api.getOAuthSession(sessionId)
          if (!isCurrent()) return
          if (updated.phase !== 'succeeded' && updated.phase !== 'error') updated = { ...updated, phase: 'expired' }
        }
        consecutiveErrors = 0
        if (updated.phase === 'succeeded') {
          clearInterval(interval)
          await handleOAuthSuccess(updated, sessionTool)
        } else if (updated.phase === 'cancelled' || updated.phase === 'expired' || updated.phase === 'error') {
          clearInterval(interval)
          handleOAuthTerminal(updated)
        } else {
          setOauthSession(updated)
        }
      } catch (err: unknown) {
        if (!isCurrent()) return
        if (++consecutiveErrors >= 3 || Date.now() >= expiresAt) {
          clearInterval(interval)
          activeSessionRef.current = null
          setOauthSession(null)
          setOauthError(Date.now() >= expiresAt ? loc.oauthExpired : formatErrorMessage(err, loc.oauthFailed))
          void api.cancelOAuth(sessionId).catch(() => {})
        }
      } finally {
        isPolling = false
      }
    }, 1000)
    return () => { stopped = true; clearInterval(interval) }
  }, [oauthSession?.id, oauthSession?.phase, oauthSession?.tool, oauthSession?.expiresAt, api, handleOAuthSuccess, handleOAuthTerminal, loc.oauthExpired, loc.oauthFailed])

  const handleReopenBrowser = async () => {
    if (!api || typeof api.reopenOAuth !== 'function' || !oauthSession) return
    try {
      await api.reopenOAuth(oauthSession.id)
    } catch (err: unknown) {
      setOauthError(formatErrorMessage(err, loc.oauthFailed))
    }
  }

  const closeAddAccountModal = async () => {
    if (isBusy || isCancellingOAuth) return
    setIsCancellingOAuth(true)
    try {

      if (startPendingRef.current) {
        cancelPendingOnStartRef.current = true
        sessionGenerationRef.current++
      }

      const sessionToCancel = activeSessionRef.current
      activeSessionRef.current = null
      setOauthSession(null)
      setOauthError(null)

      if (sessionToCancel && apiRef.current) {
        try {
          if (typeof apiRef.current.cancelOAuth === 'function') {
            await apiRef.current.cancelOAuth(sessionToCancel.id).catch(() => {})
          }
        } catch {
          // ignore cancel error
        }
        try {
          if (typeof apiRef.current.getOAuthSession === 'function') {
            const terminal = await apiRef.current.getOAuthSession(sessionToCancel.id)
            if (isMountedRef.current && terminal && terminal.phase === 'succeeded') {
              await handleOAuthSuccess(terminal, sessionToCancel.tool)
              return
            }
          }
        } catch {
          // ignore
        }
      }

      setShowAddAccountModal(false)
      setImportName('')
      setImportCredential('')
      setIsCredentialMasked(true)
    } finally {
      if (isMountedRef.current) setIsCancellingOAuth(false)
    }
  }

  // Auto Account Discovery (OPC-48)
  const runAutoScan = useCallback(async (force = false) => {
    if (!apiRef.current || typeof apiRef.current.syncCurrentAccounts !== 'function' || !isMountedRef.current) return
    if (isBusyRef.current || showAddAccountModalRef.current || isStartingOAuthRef.current || Boolean(activeSessionRef.current)) return
    if (isSyncingAccountsRef.current) return

    const now = Date.now()
    if (!force && now - lastAccountSyncTimeRef.current < 30_000) {
      return
    }

    isSyncingAccountsRef.current = true
    lastAccountSyncTimeRef.current = now

    try {
      const results = await apiRef.current.syncCurrentAccounts()
      if (!isMountedRef.current) return

      if (Array.isArray(results)) {
        const nextResults: Partial<Record<AccountTool, AccountDiscoveryResult>> = {}
        let hasNewOrUpdated = false

        for (const res of results) {
          if (!res || !res.tool) continue
          nextResults[res.tool] = res
          if (res.status === 'imported' || res.status === 'updated') {
            hasNewOrUpdated = true
          }
        }

        setDiscoveryResults((prev) => ({ ...prev, ...nextResults }))

        if (hasNewOrUpdated) {
          await loadDataRef.current?.()
          enqueueVisibleQuotasRef.current?.(false)
        }
      }
    } catch {
      // Silently catch scan errors
    } finally {
      isSyncingAccountsRef.current = false
    }
  }, [])

  // Mount sync
  useEffect(() => {
    void runAutoScan(true)
  }, [runAutoScan])

  // Window focus sync with 30s throttle
  useEffect(() => {
    const handleFocus = () => {
      void runAutoScan(false)
    }
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('focus', handleFocus)
    }
  }, [runAutoScan])

  const currentDiscoveryNotice = useMemo(() => {
    const res = discoveryResults[selectedTool]
    if (!res) return null
    if (res.status !== 'expired' && res.status !== 'error' && res.status !== 'unavailable') {
      return null
    }
    const key = `${selectedTool}:${res.status}`
    if (dismissedFeedback[key]) return null
    return res
  }, [discoveryResults, selectedTool, dismissedFeedback])

  const getDiscoveryNoticeText = useCallback((notice: AccountDiscoveryResult): string => {
    if (notice.status === 'expired') {
      return loc.discoveryExpiredNotice
    }
    if (notice.status === 'unavailable') {
      return loc.capabilityUnavailableDesc
    }
    if (notice.status === 'error') {
      if (notice.message && notice.message !== 'error' && notice.message !== 'expired' && notice.message !== 'unavailable') {
        return formatErrorMessage(notice.message, loc.discoveryErrorNotice)
      }
      return loc.discoveryErrorNotice
    }
    return notice.message ? formatErrorMessage(notice.message, loc.discoveryErrorNotice) : loc.discoveryErrorNotice
  }, [loc])

  const lastNotifiedNoticeRef = useRef<string | null>(null)
  useEffect(() => {
    const errorText = currentToolState?.error
    const noticeText = currentDiscoveryNotice ? getDiscoveryNoticeText(currentDiscoveryNotice) : null
    const messageToToast = errorText
      ? (noticeText && !noticeText.includes(errorText) && !errorText.includes(noticeText)
          ? `${errorText}（${noticeText}）`
          : errorText)
      : noticeText
    if (messageToToast && messageToToast !== lastNotifiedNoticeRef.current) {
      lastNotifiedNoticeRef.current = messageToToast
      onNotify?.(messageToToast, 'error')
    } else if (!messageToToast) {
      lastNotifiedNoticeRef.current = null
    }
  }, [currentToolState?.error, currentDiscoveryNotice, onNotify, getDiscoveryNoticeText])

  const authorizeNativeAccount = async () => {
    if (!api?.authorizeAntigravityKeychain || isBusy || isOAuthPending) return
    setIsBusy(true)
    try {
      await api.authorizeAntigravityKeychain()
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(formatErrorMessage(error, loc.discoveryErrorNotice))
    } finally {
      setIsBusy(false)
      isBusyRef.current = false
      await runAutoScan(true)
      await loadDataRef.current?.()
    }
  }

  const nativeAccessButton = selectedTool === 'antigravity' &&
    currentCapability?.detailsCode === 'antigravity-native-keychain' &&
    /Keychain|钥匙串/.test(`${currentToolState?.error ?? ''} ${currentDiscoveryNotice?.message ?? ''}`) &&
    api?.authorizeAntigravityKeychain ? (
      <button type="button" className="account-btn account-btn--sm" onClick={() => void authorizeNativeAccount()} disabled={isBusy || isOAuthPending}>
        {resolvedLocale === 'en-US' ? 'Allow account access' : '允许读取账号'}
      </button>
    ) : null

  const [togglingAutoSwitch, setTogglingAutoSwitch] = useState<boolean>(false)

  const handleToggleAutoSwitch = async (enabled: boolean) => {
    if (!api?.setAutoSwitch || togglingAutoSwitch || isBusy || isOAuthPending) return
    setTogglingAutoSwitch(true)
    try {
      await api.setAutoSwitch('antigravity', enabled)
      setOverview((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          tools: prev.tools.map((t) =>
            t.tool === 'antigravity' ? { ...t, autoSwitchEnabled: enabled } : t
          ),
        }
      })
    } catch (err: unknown) {
      await handleFailure(err, '切换自动切换设置失败。')
    } finally {
      setTogglingAutoSwitch(false)
    }
  }

  const autoSwitchNode =
    selectedTool === 'antigravity' ? (
      <div className="account-auto-switch-card" role="region" aria-label={loc.autoSwitchLabel}>
        <div className="account-auto-switch-info">
          <div className="account-auto-switch-title-row">
            <span className="account-auto-switch-label">{loc.autoSwitchLabel}</span>
            <span
              className="account-auto-switch-desc"
              title={loc.autoSwitchFullDesc || loc.autoSwitchDesc}
            >
              {loc.autoSwitchDesc}
            </span>
          </div>
          {currentToolState?.autoSwitchStatus && (
            <span className="account-auto-switch-status">{currentToolState.autoSwitchStatus}</span>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(currentToolState?.autoSwitchEnabled)}
          aria-label={loc.autoSwitchLabel}
          className={`account-toggle-btn ${currentToolState?.autoSwitchEnabled ? 'account-toggle-btn--active' : ''}`}
          onClick={() => void handleToggleAutoSwitch(!currentToolState?.autoSwitchEnabled)}
          disabled={isBusy || isOAuthPending || togglingAutoSwitch}
        >
          <span className="account-toggle-knob" />
        </button>
      </div>
    ) : null

  // Import Credential Submit
  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api || isBusy || isOAuthPending) return

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
      await handleFailure(err, loc.importFailure)
    } finally {
      setIsBusy(false)
    }
  }

  // One-click Switch: invokes API directly without confirmation modal
  const handleDirectSwitch = async (account: AccountMetadata) => {
    if (!api || isBusy || isOAuthPending || !isAvailable || isRecoveryNeeded) return
    if (account.id === activeAccountId) return

    try {
      setIsBusy(true)
      setSwitchingAccountId(account.id)
      setErrorMessage(null)

      const res: AccountActionResult = await api.switchAccount(account.id)
      if (res && res.success) {
        onNotify?.(account.tool === 'antigravity' && currentCapability?.detailsCode === 'antigravity-native-keychain'
          ? (resolvedLocale === 'en-US' ? 'Antigravity account switched. New CLI sessions use this account; existing sessions remain unchanged.' : 'Antigravity 账号已切换，新 CLI 会话将使用此账号，现有会话保持不变。')
          : loc.switchSuccess(account.name), 'success')
        if (res.warning) onNotify?.(res.warning, 'warning')
        await loadData()
        enqueueVisibleQuotasRef.current?.(true)
      } else {
        await handleFailure(res?.error, loc.switchFailure)
      }
    } catch (err: unknown) {
      await handleFailure(err, loc.switchFailure)
    } finally {
      setIsBusy(false)
      setSwitchingAccountId(null)
    }
  }

  // Rollback Action
  const handleRollback = async () => {
    if (!api || isBusy || isOAuthPending || !canRollback) return

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res: AccountActionResult = await api.rollbackAccount(selectedTool)
      if (res && res.success) {
        onNotify?.(loc.rollbackSuccess, 'success')
        if (res.warning) onNotify?.(res.warning, 'warning')
        await loadData()
        enqueueVisibleQuotasRef.current?.(true)
      } else {
        await handleFailure(res?.error, loc.rollbackFailure)
      }
    } catch (err: unknown) {
      await handleFailure(err, loc.rollbackFailure)
    } finally {
      setIsBusy(false)
    }
  }

  // Emergency Recovery Action
  const handleEmergencyRecovery = async () => {
    if (!api || isBusy || isOAuthPending) return

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res: AccountActionResult = await api.recoverAccount(selectedTool)
      if (res && res.success) {
        onNotify?.(loc.recoverySuccess, 'success')
        await loadData()
      } else {
        await handleFailure(res?.error, loc.recoveryFailure)
      }
    } catch (err: unknown) {
      await handleFailure(err, loc.recoveryFailure)
    } finally {
      setIsBusy(false)
    }
  }

  // Rename Action
  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api || !pendingRenameAccount || isBusy || isOAuthPending) return

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
      await handleFailure(err, loc.renameFailure)
    } finally {
      setIsBusy(false)
    }
  }

  // Delete Action
  const handleDeleteConfirmed = async () => {
    if (!api || !pendingDeleteAccount || isBusy || isOAuthPending) return
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
      await handleFailure(err, loc.deleteFailure)
    } finally {
      setIsBusy(false)
    }
  }

  // Refresh visible accounts and overview
  const isRefreshingQuotas = toolSavedAccounts.some(account => inFlightQuotas.has(account.id))
  const handleRefreshAll = async () => {
    if (loading || isBusy || isOAuthPending) return
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

  // Open Add Account modal with specific method (default: oauth)
  const openAddAccount = (method: 'oauth' | 'import' = 'oauth') => {
    if (isBusy || isOAuthPending || startPendingRef.current) return
    setAddAccountMethod(method)
    setImportName('')
    setImportCredential('')
    setIsCredentialMasked(true)
    setOauthError(null)
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
      {/* Unified Add Account Modal (OAuth Login & Import Credential) */}
      {showAddAccountModal && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={addAccountModalTitleId}
          onClick={(e) => {
            if (e.target === e.currentTarget && !isBusy) {
              void closeAddAccountModal()
            }
          }}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => void closeAddAccountModal())
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
                onClick={() => void closeAddAccountModal()}
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
                aria-selected={addAccountMethod === 'oauth'}
                className={`account-modal-tab-btn ${
                  addAccountMethod === 'oauth'
                    ? 'account-modal-tab-btn--active'
                    : ''
                }`}
                onClick={() => {
                  if (!isOAuthPending) {
                    setAddAccountMethod('oauth')
                    setOauthError(null)
                  }
                }}
                disabled={isBusy || isOAuthPending}
              >
                <ExternalLink size={11} />
                <span>{loc.tabOAuthLogin}</span>
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
                onClick={() => {
                  if (!isOAuthPending) {
                    setAddAccountMethod('import')
                  }
                }}
                disabled={isBusy || isOAuthPending}
              >
                <Upload size={11} />
                <span>{loc.tabImportCredential}</span>
              </button>
            </div>

            {addAccountMethod === 'oauth' ? (
              <div className="account-modal-body">
                <span className="account-modal-help">{loc.oauthModalHelp}</span>

                {oauthError && (
                  <div className="account-modal-error-callout" role="alert">
                    <span>{oauthError}</span>
                    <button
                      type="button"
                      className="account-btn account-btn--sm"
                      onClick={() => setOauthError(null)}
                      aria-label={loc.closeBtn}
                    >
                      <X size={10} />
                    </button>
                  </div>
                )}

                {isStartingOAuth ? (
                  <div className="account-oauth-status-box" role="status">
                    <Loader2 size={18} className="animate-spin account-oauth-spinner" />
                    <strong className="account-oauth-status-title">{loc.oauthStarting}</strong>
                    <div className="account-oauth-actions">
                      <button
                        type="button"
                        className="account-btn account-btn--sm"
                        onClick={() => void closeAddAccountModal()}
                      >
                        {loc.cancelBtn}
                      </button>
                    </div>
                  </div>
                ) : oauthSession ? (
                  <div className="account-oauth-status-box" role="status">
                    <Loader2 size={18} className="animate-spin account-oauth-spinner" />
                    <strong className="account-oauth-status-title">
                      {oauthSession.phase === 'exchanging'
                        ? loc.oauthStatusExchanging
                        : loc.oauthStatusWaiting}
                    </strong>
                    <p className="account-oauth-status-desc">
                      {oauthSession.phase === 'exchanging'
                        ? loc.oauthStatusExchangingDesc
                        : loc.oauthStatusWaitingDesc}
                    </p>
                    <div className="account-oauth-actions">
                      {oauthSession.phase === 'waiting' && (
                        <button
                          type="button"
                          className="account-btn account-btn--sm"
                          onClick={() => void handleReopenBrowser()}
                        >
                          <ExternalLink size={10} />
                          <span>{loc.oauthReopenBrowserBtn}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="account-btn account-btn--sm"
                        onClick={() => void closeAddAccountModal()}
                      >
                        {loc.oauthCancelBtn}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="account-oauth-start-wrap">
                    <button
                      ref={oauthSignInButtonRef}
                      type="button"
                      className="account-btn account-btn--primary account-btn--oauth-signin"
                      onClick={() => void handleStartOAuth()}
                      disabled={isBusy || isStartingOAuth || startPendingRef.current}
                    >
                      <AIToolLogo toolId={selectedTool} size={14} color />
                      <span>{loc.signInWithTool(currentToolDefinition.pureName)}</span>
                      <ExternalLink size={11} />
                    </button>
                    <div className="account-modal-actions">
                      <button
                        type="button"
                        className="account-btn"
                        onClick={() => void closeAddAccountModal()}
                      >
                        {loc.cancelBtn}
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
                    onClick={() => void closeAddAccountModal()}
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
            className="account-modal-box account-modal-box--sm"
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
            className="account-modal-box account-modal-box--sm"
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

  // Tool-level capability details (only rendered when limited or having specific reasons/details)
  const capabilityStripNode = (!isAvailable || currentCapability?.reason) ? (
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
  ) : null

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
                isBusy={isBusy || isOAuthPending}
                isSwitching={isSwitching}
                isRecoveryNeeded={isRecoveryNeeded}
                unsupportedReason={currentCapability?.reason}
                snapshot={snapshot}
                renewal={overview?.refreshes?.find(state => state.accountId === account.id)}
                onReauthenticate={() => openAddAccount('oauth')}
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
                className="account-btn account-btn--primary"
                onClick={() => openAddAccount('oauth')}
                disabled={isBusy || isOAuthPending}
              >
                <ExternalLink size={11} />
                <span>{loc.tabOAuthLogin}</span>
              </button>
              <button
                type="button"
                className="account-btn"
                onClick={() => openAddAccount('import')}
                disabled={isBusy || isOAuthPending}
              >
                <Upload size={11} />
                <span>{loc.tabImportCredential}</span>
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
                        if (!isBusy && !isOAuthPending && selectedTool !== tool.id) {
                          setSelectedTool(tool.id)
                          setErrorMessage(null)
                        }
                      }}
                      onKeyDown={(e) => handleTabKeyDown(e, index)}
                      disabled={isBusy || isOAuthPending}
                    >
                      <AIToolLogo toolId={tool.id} size={13} color />
                      <span>{loc[tool.pureLabelKey] || tool.pureName}</span>
                    </button>
                  )
                })}
              </div>
              <div className="account-workbench-actions">
                {selectedTool === 'antigravity' && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(currentToolState?.autoSwitchEnabled)}
                    aria-label={loc.autoSwitchLabel}
                    title={
                      currentToolState?.autoSwitchStatus
                        ? `${loc.autoSwitchFullDesc || loc.autoSwitchDesc}（${currentToolState.autoSwitchStatus}）`
                        : (loc.autoSwitchFullDesc || loc.autoSwitchDesc)
                    }
                    className="account-header-auto-switch"
                    onClick={() => void handleToggleAutoSwitch(!currentToolState?.autoSwitchEnabled)}
                    disabled={isBusy || isOAuthPending || togglingAutoSwitch}
                  >
                    <span className="account-header-auto-switch-label">{loc.autoSwitchLabel}</span>
                    <span
                      className={`account-header-auto-switch-toggle ${
                        currentToolState?.autoSwitchEnabled ? 'account-header-auto-switch-toggle--active' : ''
                      }`}
                    >
                      <span className="account-header-auto-switch-knob" />
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="account-btn account-btn--sm"
                  onClick={handleRefreshAll}
                  disabled={loading || isRefreshingQuotas || isBusy || isOAuthPending}
                  title={loc.refreshAllBtn}
                  aria-label={loc.refreshAllBtn}
                >
                  <RefreshCw size={12} className={loading || isRefreshingQuotas ? 'animate-spin' : ''} />
                  <span>{loading || isRefreshingQuotas ? loc.refreshingAllBtn : loc.refreshAllBtn}</span>
                </button>
                <button
                  type="button"
                  className="account-btn account-btn--primary"
                  onClick={() => openAddAccount('oauth')}
                  disabled={isBusy || isOAuthPending}
                >
                  <Plus size={12} />
                  <span>{loc.addAccountBtn}</span>
                </button>
              </div>
            </div>

            {/* Error Callout */}
            {errorMessage && errorMessage !== currentToolState?.error && (
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
                  disabled={isBusy || isOAuthPending}
                >
                  <RotateCcw size={12} />
                  <span>{isBusy ? loc.recoveringBtn : loc.emergencyRecoverBtn}</span>
                </button>
              </div>
            )}

            {/* Tool State Warning Callout */}
            {currentToolState?.warning && !currentToolState?.error && !isRecoveryNeeded && (
              <div className="account-sessions-hint" style={{ margin: '4px 0' }} role="status">
                <Info size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
                <span>{currentToolState.warning}</span>
              </div>
            )}

            {nativeAccessButton}

            {capabilityStripNode}
            {activeIdentity && (
              <div className="account-tool-identity-chip-wrap">
                <span className="account-desc">{loc.activeIdentityLabel}</span>
                <span className="account-tool-identity-chip"><User size={11} /><span>{activeIdentity}</span></span>
              </div>
            )}
            {overview?.legacyProfilesPresent && !dismissedLegacyNotice && (
              <div className="account-legacy-notice" role="status">
                <Info size={14} className="account-legacy-icon" />
                <div className="account-legacy-text">
                  <strong>{loc.legacyNoticeTitle}：</strong>
                  <span>{loc.legacyNoticeDesc}</span>
                </div>
                <button
                  type="button"
                  className="account-contextual-callout-dismiss"
                  onClick={() => {
                    setDismissedLegacyNotice(true)
                    try {
                      localStorage.setItem('trace_account_dismissed_legacy_notice', 'true')
                    } catch {}
                  }}
                  aria-label={loc.closeBtn}
                >
                  <X size={10} />
                </button>
              </div>
            )}
            {/* Account Cards Grid */}
            {gridContentNode}

            {/* Consolidated guidance strip */}
            <div className="account-guidance-strip">
              <span className="account-guidance-item">{loc.securityNotice}</span>
              <span className="account-guidance-item">{loc.sessionsNotice}</span>
            </div>
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

        {overview?.legacyProfilesPresent && !dismissedLegacyNotice && (
          <div className="account-legacy-notice" role="status">
            <Info size={14} className="account-legacy-icon" />
            <div className="account-legacy-text">
              <strong>{loc.legacyNoticeTitle}：</strong>
              <span>{loc.legacyNoticeDesc}</span>
            </div>
            <button
              type="button"
              className="account-contextual-callout-dismiss"
              onClick={() => {
                setDismissedLegacyNotice(true)
                try {
                  localStorage.setItem('trace_account_dismissed_legacy_notice', 'true')
                } catch {}
              }}
              aria-label={loc.closeBtn}
            >
              <X size={10} />
            </button>
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
                  if (!isBusy && !isOAuthPending && selectedTool !== tool.id) {
                    setSelectedTool(tool.id)
                    setErrorMessage(null)
                  }
                }}
                onKeyDown={(e) => handleTabKeyDown(e, index)}
                disabled={isBusy || isOAuthPending}
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
          {autoSwitchNode}

          {nativeAccessButton}

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
                disabled={isBusy || isOAuthPending}
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
                disabled={loading || isBusy || isOAuthPending}
                title={loc.refreshBtn}
              >
                <RefreshCw
                  size={12}
                  className={loading ? 'animate-spin' : ''}
                />
                <span>{loc.refreshBtn}</span>
              </button>

              <button
                type="button"
                className="account-btn account-btn--primary account-btn--sm"
                onClick={() => openAddAccount('oauth')}
                disabled={isBusy || isOAuthPending}
              >
                <Plus size={12} />
                <span>{loc.addAccountBtn}</span>
              </button>
            </div>
          </div>

          {/* Cards Grid */}
          {gridContentNode}

          {/* Consolidated guidance strip */}
          <div className="account-guidance-strip">
            <span className="account-guidance-item">{loc.securityNotice}</span>
            <span className="account-guidance-item">{loc.sessionsNotice}</span>
          </div>
        </div>
      </div>
      {modalsNode}
    </div>
  )
}
