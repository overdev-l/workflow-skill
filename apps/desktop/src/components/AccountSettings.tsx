/**
 * AI Developer Account Settings Component (OPC-48)
 *
 * Provides a native macOS-style UI for managing independent developer accounts
 * across Antigravity (Google), Codex (ChatGPT), and Claude Code (subscription).
 *
 * Replaces ProfileSettings entirely for account-only management.
 *
 * Core Guarantees & Constraints:
 * - Pure metadata-only presentation (zero secret or raw token exposure in DOM/logs/notifications)
 * - Plaintext account files explained in ordinary, everyday language (user-only permissions)
 * - Safe error handling: backend sends safe errors; robust display with length cap
 * - Independent per-tool state, capabilities, rollback, and emergency recovery
 * - Compact capsule design system (24px/22px buttons, 28px inputs, 24px segmented controls)
 * - Credential input masked by default with explicit toggle; cleared on success/cancel
 * - Current active identity means local file selection, not remote authenticated identity
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Download,
  Eye,
  EyeOff,
  Info,
  Pencil,
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
  AccountsOverview,
  AccountTool,
  AccountToolCapability,
  AccountToolState,
} from '@workflow-skill/workflow-model/accounts'
import { AIToolLogo } from '../AIToolLogo'
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
  labelKey: 'toolAntigravity' | 'toolCodex' | 'toolClaudeCode'
  pureLabelKey: 'toolPureAntigravity' | 'toolPureCodex' | 'toolPureClaudeCode'
  pureName: string
  brand: string
}

const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'antigravity',
    labelKey: 'toolAntigravity',
    pureLabelKey: 'toolPureAntigravity',
    pureName: 'Antigravity',
    brand: 'Antigravity (Google)',
  },
  {
    id: 'codex',
    labelKey: 'toolCodex',
    pureLabelKey: 'toolPureCodex',
    pureName: 'Codex',
    brand: 'Codex (ChatGPT)',
  },
  {
    id: 'claude-code',
    labelKey: 'toolClaudeCode',
    pureLabelKey: 'toolPureClaudeCode',
    pureName: 'Claude Code',
    brand: 'Claude Code',
  },
] as const

const DICTIONARY = {
  'zh-CN': {
    headerTitle: 'AI 账号管理',
    masterHeading: '账号管理',
    headerDescription:
      '独立管理 Antigravity (Google)、Codex (ChatGPT) 与 Claude Code 的账号凭据。切换前自动备份账号文件，仅供新会话读取。',
    securityNotice:
      '凭据以明文保存在本机，文件权限限制为当前系统用户读写。Trace 不读写系统钥匙串。',
    legacyNoticeTitle: '历史配置快照提示',
    legacyNoticeDesc:
      '检测到此前创建的配置快照；历史快照已安全保留。当前账号管理仅负责独立的登录凭据，不再应用历史快照中的模型或 MCP 设定。',
    toolAntigravity: 'Antigravity (Google)',
    toolCodex: 'Codex (ChatGPT)',
    toolClaudeCode: 'Claude Code',
    toolPureAntigravity: 'Antigravity',
    toolPureCodex: 'Codex',
    toolPureClaudeCode: 'Claude Code',
    capabilityStatusReady: '本地支持',
    capabilityStatusLimited: '功能受限',
    activeIdentityLabel: '当前配置：',
    noActiveIdentity: '未检测到本地账号配置',
    activeBadge: '当前配置',
    sessionsNotice:
      '提示：切换仅更新本机账号凭证文件，在新终端或工具会话中生效。已有运行中的会话不会自动变更；项目配置或环境变量若存在可能覆盖全局账号。',
    refreshBtn: '刷新',
    rollbackBtn: '回滚上次切换',
    rollingBackBtn: '正在回滚…',
    captureBtn: '捕获当前账号',
    importBtn: '导入凭据',
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
      '可点击「导入凭据」添加账号凭据副本；若工具受支持亦可点击「捕获当前账号」保存当前凭据。',
    switchBtn: '切换',
    switchingBtn: '正在写入…',
    renameBtn: '重命名',
    removeBtn: '移除',
    confirmSwitchTitle: '确认写入账号配置',
    confirmSwitchPrompt: (name: string, toolName: string) =>
      `确定要将 ${toolName} 的本地凭据写入为账号「${name}」吗？操作仅备份与写入账号凭据文件，请在新会话中确认登录身份。`,
    confirmSwitchBtn: '确认写入',
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
    captureModalTitle: (toolName: string) => `捕获当前 ${toolName} 账号`,
    captureModalHelp:
      'Trace 将读取本机当前工具已配置的凭据文件并保存为独立副本，供日后快速还原。',
    captureNameLabel: '账号名称',
    captureNamePlaceholder: '例如：个人账号',
    confirmCaptureBtn: '确认捕获',
    capturingBtn: '正在捕获…',
    importModalTitle: (toolName: string) => `导入 ${toolName} 凭据`,
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
  },
  'en-US': {
    headerTitle: 'Account Manager',
    masterHeading: 'Accounts',
    headerDescription:
      'Manage independent credentials for Antigravity (Google), Codex (ChatGPT), and Claude Code. Credential files are backed up before switching and take effect in new sessions.',
    securityNotice:
      'Credentials are saved locally as plaintext files, restricted to read/write by the current user. Trace does not access the system keychain.',
    legacyNoticeTitle: 'Legacy Snapshot Profiles',
    legacyNoticeDesc:
      'Previous environment snapshots are safely preserved. Account management now independently handles sign-in credentials and no longer applies model or MCP settings from legacy snapshots.',
    toolAntigravity: 'Antigravity (Google)',
    toolCodex: 'Codex (ChatGPT)',
    toolClaudeCode: 'Claude Code',
    toolPureAntigravity: 'Antigravity',
    toolPureCodex: 'Codex',
    toolPureClaudeCode: 'Claude Code',
    capabilityStatusReady: 'Supported',
    capabilityStatusLimited: 'Limited / Unsupported',
    activeIdentityLabel: 'Configured Account:',
    noActiveIdentity: 'No local account configuration detected',
    activeBadge: 'Configured',
    sessionsNotice:
      'Notice: Swapping only updates local credential files for new sessions. Existing sessions are not altered automatically. Project-level configs or environment variables take precedence if present.',
    refreshBtn: 'Refresh',
    rollbackBtn: 'Rollback Last Switch',
    rollingBackBtn: 'Rolling back…',
    captureBtn: 'Capture Active Account',
    importBtn: 'Import Credential',
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
      'Click "Import Credential" to save an account copy, or click "Capture Active Account" if the tool is supported.',
    switchBtn: 'Switch',
    switchingBtn: 'Writing…',
    renameBtn: 'Rename',
    removeBtn: 'Remove',
    confirmSwitchTitle: 'Confirm Account Configuration',
    confirmSwitchPrompt: (name: string, toolName: string) =>
      `Write account credentials for "${name}" to ${toolName}? This backs up and updates only credential files. Please verify identity in a new session.`,
    confirmSwitchBtn: 'Confirm Write',
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
    captureModalTitle: (toolName: string) => `Capture Active ${toolName} Account`,
    captureModalHelp:
      'Trace will read your active credentials on this computer and save an independent copy for fast restoration.',
    captureNameLabel: 'Account Name',
    captureNamePlaceholder: 'e.g., Personal Subscription',
    confirmCaptureBtn: 'Capture & Save',
    capturingBtn: 'Capturing…',
    importModalTitle: (toolName: string) => `Import ${toolName} Credential`,
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
  // Cap length to prevent overflowing UI
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

  // Tool Segmented Selection
  const [selectedTool, setSelectedTool] = useState<AccountTool>('antigravity')

  // Master Tool Buttons Ref for Keyboard Navigation
  const masterToolButtonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const handleToolKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (isBusy) return
    let nextIndex = -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      nextIndex = (index + 1) % TOOLS.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      nextIndex = (index - 1 + TOOLS.length) % TOOLS.length
    }
    if (nextIndex >= 0) {
      setSelectedTool(TOOLS[nextIndex].id)
      setErrorMessage(null)
      masterToolButtonRefs.current[nextIndex]?.focus()
    }
  }

  // Overview State
  const [overview, setOverview] = useState<AccountsOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [isBusy, setIsBusy] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Modals & Form States
  const [showCaptureModal, setShowCaptureModal] = useState<boolean>(false)
  const [captureName, setCaptureName] = useState<string>('')

  const [showImportModal, setShowImportModal] = useState<boolean>(false)
  const [importName, setImportName] = useState<string>('')
  const [importCredential, setImportCredential] = useState<string>('')
  const [isCredentialMasked, setIsCredentialMasked] = useState<boolean>(true)

  const [pendingSwitchAccount, setPendingSwitchAccount] = useState<AccountMetadata | null>(null)
  const [pendingRenameAccount, setPendingRenameAccount] = useState<AccountMetadata | null>(null)
  const [renameName, setRenameName] = useState<string>('')

  const [pendingDeleteAccount, setPendingDeleteAccount] = useState<AccountMetadata | null>(null)

  // Focus & Accessibility Element Refs
  const captureInputRef = useRef<HTMLInputElement>(null)
  const importNameInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const confirmSwitchButtonRef = useRef<HTMLButtonElement>(null)
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null)

  // Modal IDs for ARIA
  const captureModalTitleId = useId()
  const importModalTitleId = useId()
  const switchModalTitleId = useId()
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
    if (showCaptureModal) {
      captureInputRef.current?.focus()
    }
  }, [showCaptureModal])

  useEffect(() => {
    if (showImportModal) {
      importNameInputRef.current?.focus()
    }
  }, [showImportModal])

  useEffect(() => {
    if (pendingRenameAccount) {
      renameInputRef.current?.focus()
    }
  }, [pendingRenameAccount])

  useEffect(() => {
    if (pendingSwitchAccount) {
      confirmSwitchButtonRef.current?.focus()
    }
  }, [pendingSwitchAccount])

  useEffect(() => {
    if (pendingDeleteAccount) {
      confirmDeleteButtonRef.current?.focus()
    }
  }, [pendingDeleteAccount])

  // Common Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        if (pendingSwitchAccount) {
          setPendingSwitchAccount(null)
        } else if (pendingRenameAccount) {
          setPendingRenameAccount(null)
          setRenameName('')
        } else if (pendingDeleteAccount) {
          setPendingDeleteAccount(null)
        } else if (showCaptureModal) {
          setShowCaptureModal(false)
          setCaptureName('')
        } else if (showImportModal) {
          setShowImportModal(false)
          setImportName('')
          setImportCredential('')
          setIsCredentialMasked(true)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    isBusy,
    pendingSwitchAccount,
    pendingRenameAccount,
    pendingDeleteAccount,
    showCaptureModal,
    showImportModal,
  ])

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
    const nextIndex = (index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length
    focusables[nextIndex]?.focus()
  }

  // Error recovery helper: on failure refresh status so recovery state is loaded while preserving error message
  const handleFailure = async (error: unknown, fallbackMessage: string) => {
    const sanitized = formatErrorMessage(error, fallbackMessage)
    setErrorMessage(sanitized)
    onNotify?.(sanitized, 'error')
    await loadData()
  }

  // Derived state for the currently selected tool
  const currentCapability = useMemo<AccountToolCapability | undefined>(() => {
    return overview?.capabilities.find((c) => c.tool === selectedTool)
  }, [overview, selectedTool])

  const isAvailable = currentCapability ? currentCapability.available : true

  const currentToolState = useMemo<AccountToolState | undefined>(() => {
    return overview?.tools.find((t) => t.tool === selectedTool)
  }, [overview, selectedTool])

  const activeAccountId = currentToolState?.activeAccountId
  const activeIdentity = currentToolState?.activeIdentity

  // Rollback and recovery restore files only; do NOT gate on isAvailable
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

  // Handlers for Account Operations
  // Capture is gated on isAvailable
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
      setShowCaptureModal(false)
      onNotify?.(loc.captureSuccess(created.name), 'success')
      await loadData()
    } catch (err: unknown) {
      await handleFailure(err, 'Failed to capture account.')
    } finally {
      setIsBusy(false)
    }
  }

  // Import is NOT gated on isAvailable: saving account copy is always permitted
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
      // Clear secret text immediately after success
      setImportCredential('')
      setImportName('')
      setIsCredentialMasked(true)
      setShowImportModal(false)
      onNotify?.(loc.importSuccess(created.name), 'success')
      await loadData()
    } catch (err: unknown) {
      // Clear secret on failure as well
      setImportCredential('')
      await handleFailure(err, 'Failed to import credential.')
    } finally {
      setIsBusy(false)
    }
  }

  // Switch is gated on isAvailable
  const handleSwitchConfirmed = async () => {
    if (!api || !pendingSwitchAccount || isBusy || !isAvailable) return
    const target = pendingSwitchAccount

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res: AccountActionResult = await api.switchAccount(target.id)
      if (res && res.success) {
        onNotify?.(loc.switchSuccess(target.name), 'success')
        setPendingSwitchAccount(null)
        await loadData()
      } else {
        setPendingSwitchAccount(null)
        await handleFailure(res?.error, 'Failed to switch account.')
      }
    } catch (err: unknown) {
      setPendingSwitchAccount(null)
      await handleFailure(err, 'Failed to switch account.')
    } finally {
      setIsBusy(false)
    }
  }

  // Rollback is NOT gated on isAvailable (restore file only)
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

  // Emergency recovery is NOT gated on isAvailable (restore file only)
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


  const masterColumnNode = (
    <aside className="app-col-master view-enter">
      <div className="master-header">
        <div className="master-header-top">
          <h2 className="master-title account-master-heading">{loc.masterHeading}</h2>
        </div>
      </div>

      <div
        className="master-list-scroll account-master-list"
        role="tablist"
        aria-orientation="vertical"
        aria-label={loc.masterHeading}
      >
        {TOOLS.map((tool, index) => {
          const isSelected = selectedTool === tool.id
          return (
            <button
              key={tool.id}
              ref={(el) => {
                masterToolButtonRefs.current[index] = el
              }}
              type="button"
              role="tab"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              className={`account-master-row master-item-row ${
                isSelected ? 'is-selected' : ''
              }`}
              onClick={() => {
                if (!isBusy && selectedTool !== tool.id) {
                  setSelectedTool(tool.id)
                  setErrorMessage(null)
                }
              }}
              onKeyDown={(e) => handleToolKeyDown(e, index)}
              disabled={isBusy}
            >
              <div className="account-master-row-logo master-item-logo">
                <AIToolLogo toolId={tool.id} size={15} color />
              </div>
              <span className="account-master-row-name master-item-title">
                {loc[tool.pureLabelKey] || tool.pureName}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )

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
        <>
          {masterColumnNode}
          <section className="app-col-detail view-enter" style={{ overflowY: 'auto' }}>
            <div className="account-workspace-detail">
              {unavailableContent}
            </div>
          </section>
        </>
      )
    }

    return (
      <div className="account-settings-container">
        {unavailableContent}
      </div>
    )
  }

  const detailCardNode = (
    <div className="account-card">
      {/* Header Title (Clean, no unnecessary badges or icons) */}
      <div className="account-header-row">
        <h3 className="account-title">{loc.headerTitle}</h3>
      </div>

      <p className="account-desc">{loc.headerDescription}</p>
      <p className="account-security-notice">{loc.securityNotice}</p>

      {/* Legacy Profile Notice (when legacy profiles exist) */}
      {overview?.legacyProfilesPresent && (
        <div className="account-legacy-notice" role="status">
          <Info size={14} className="account-legacy-icon" />
          <div>
            <strong>{loc.legacyNoticeTitle}：</strong>
            <span>{loc.legacyNoticeDesc}</span>
          </div>
        </div>
      )}

      {/* Error Callout */}
      {errorMessage && (
        <div className="account-error-callout" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            className="account-btn account-btn--sm"
            onClick={() => setErrorMessage(null)}
            aria-label={loc.closeBtn}
            title={loc.closeBtn}
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* Three Compact Tool Segmented Buttons (Disabled while busy to preserve consistency - settings mode only) */}
      {presentation === 'settings' && (
        <div
          className="account-segmented"
          role="tablist"
          aria-label="AI Tools"
        >
          {TOOLS.map((tool) => {
            const isSelected = selectedTool === tool.id
            return (
              <button
                key={tool.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                className={`account-segmented-btn ${
                  isSelected ? 'account-segmented-btn--active' : ''
                }`}
                onClick={() => {
                  if (!isBusy && selectedTool !== tool.id) {
                    setSelectedTool(tool.id)
                    setErrorMessage(null)
                  }
                }}
                disabled={isBusy}
              >
                <span>{loc[tool.labelKey]}</span>
              </button>
            )
          })}
        </div>
      )}

        {/* Selected Tool Stage */}
        <div className="account-tool-stage">
          {/* Capability Guidance & Caveats (Always shown, even when available) */}
          <div className="account-capability-box">
            <div className="account-capability-header">
              <div className="account-capability-title-row">
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
                <span className="account-capability-details">
                  {currentCapability.details}
                </span>
              )}
            </div>
          </div>

          {/* currentToolState.error MUST render if present */}
          {currentToolState?.error && (
            <div className="account-tool-error-callout" role="alert">
              <AlertTriangle size={14} className="account-tool-error-icon" />
              <div className="account-tool-error-body">
                <strong>{loc.toolErrorTitle}</strong>
                <span>{currentToolState.error}</span>
              </div>
            </div>
          )}

          {/* Per-Tool Interrupted State / Emergency Recovery Banner */}
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
                    {activeAccount?.email && activeAccount.name !== activeAccount.email
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
                onClick={() => {
                  setErrorMessage(null)
                  void loadData()
                }}
                disabled={loading || isBusy}
                title={loc.refreshBtn}
              >
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                <span>{loc.refreshBtn}</span>
              </button>

              {/* Rollback is NOT gated on isAvailable */}
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={handleRollback}
                disabled={!canRollback || isBusy}
                title={loc.rollbackBtn}
              >
                <RotateCcw size={12} />
                <span>{isBusy ? loc.rollingBackBtn : loc.rollbackBtn}</span>
              </button>

              {/* Capture is gated on isAvailable */}
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => {
                  setCaptureName('')
                  setShowCaptureModal(true)
                }}
                disabled={!isAvailable || isBusy || isRecoveryNeeded}
              >
                <Download size={12} />
                <span>{loc.captureBtn}</span>
              </button>

              {/* Import is NOT gated on isAvailable */}
              <button
                type="button"
                className="account-btn account-btn--primary account-btn--sm"
                onClick={() => {
                  setImportName('')
                  setImportCredential('')
                  setIsCredentialMasked(true)
                  setShowImportModal(true)
                }}
                disabled={isBusy}
              >
                <Upload size={12} />
                <span>{loc.importBtn}</span>
              </button>
            </div>
          </div>

          {/* Running Sessions Informative Hint */}
          <p className="account-sessions-hint">{loc.sessionsNotice}</p>

          {/* Saved Accounts List Section */}
          <div className="account-list-section">
            <div className="account-section-header">
              <h4 className="account-section-title">{loc.savedAccountsTitle}</h4>
            </div>

            {loading && !overview && (
              <p className="account-desc" role="status">
                {loc.loading}
              </p>
            )}

            {toolSavedAccounts.length > 0 ? (
              <div className="account-list">
                {toolSavedAccounts.map((account) => {
                  const isActive = account.id === activeAccountId
                  const createdDate = formatDate(account.createdAt)
                  const expiresDate = formatDate(account.expiresAt)

                  return (
                    <div key={account.id} className="account-item-row">
                      <div className="account-item-main">
                        <div className="account-item-title-row">
                          <span className="account-item-name">{account.name}</span>
                          {isActive && (
                            <span className="account-active-badge">
                              <Check size={10} />
                              <span>{loc.activeBadge}</span>
                            </span>
                          )}
                          {account.email && (
                            <span className="account-item-email">
                              ({account.email})
                            </span>
                          )}
                        </div>

                        <div className="account-item-meta">
                          {account.accountId && (
                            <span>
                              {loc.accountIdLabel}: {account.accountId}
                            </span>
                          )}
                          {createdDate && (
                            <span className="account-item-date">
                              {loc.createdDatePrefix} {createdDate}
                            </span>
                          )}
                          {expiresDate && (
                            <span className="account-item-date">
                              {loc.expiresDatePrefix}: {expiresDate}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="account-item-actions">
                        <button
                          type="button"
                          className="account-btn account-btn--sm"
                          onClick={() => {
                            setRenameName(account.name)
                            setPendingRenameAccount(account)
                          }}
                          disabled={isBusy}
                          title={loc.renameBtn}
                        >
                          <Pencil size={11} />
                          <span>{loc.renameBtn}</span>
                        </button>

                        <button
                          type="button"
                          className="account-btn account-btn--danger account-btn--sm"
                          onClick={() => setPendingDeleteAccount(account)}
                          disabled={isBusy}
                          title={loc.removeBtn}
                        >
                          <Trash2 size={11} />
                          <span>{loc.removeBtn}</span>
                        </button>

                        {/* Switch is gated on isAvailable */}
                        <button
                          type="button"
                          className={`account-btn account-btn--sm ${
                            isActive ? '' : 'account-btn--primary'
                          }`}
                          onClick={() => setPendingSwitchAccount(account)}
                          disabled={
                            isBusy ||
                            !isAvailable ||
                            isRecoveryNeeded ||
                            isActive
                          }
                          title={loc.switchBtn}
                        >
                          <ArrowRightLeft size={11} />
                          <span>{isActive ? loc.activeBadge : loc.switchBtn}</span>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              !loading && (
                <div className="account-empty-state">
                  <span className="account-empty-title">{loc.emptyAccountsTitle}</span>
                  <span className="account-empty-desc">{loc.emptyAccountsDesc}</span>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    )

  const modalsNode = (
    <>
      {/* Modal: Capture Current Active Account */}
      {showCaptureModal && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={captureModalTitleId}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => {
              setShowCaptureModal(false)
              setCaptureName('')
            })
          }
        >
          <div className="account-modal-box">
            <div className="account-modal-header">
              <h4 id={captureModalTitleId} className="account-modal-title">
                {loc.captureModalTitle(currentToolDefinition.brand)}
              </h4>
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => {
                  setShowCaptureModal(false)
                  setCaptureName('')
                }}
                disabled={isBusy}
                aria-label={loc.closeBtn}
              >
                <X size={10} />
              </button>
            </div>

            <form onSubmit={handleCaptureSubmit} className="account-modal-body">
              <span className="account-modal-help">{loc.captureModalHelp}</span>

              <div className="account-field-group">
                <label htmlFor="account-capture-name-input" className="account-label">
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
                    setShowCaptureModal(false)
                    setCaptureName('')
                  }}
                  disabled={isBusy}
                >
                  {loc.cancelBtn}
                </button>
                <button
                  type="submit"
                  className="account-btn account-btn--primary"
                  disabled={isBusy || !captureName.trim()}
                >
                  {isBusy ? loc.capturingBtn : loc.confirmCaptureBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Import Credential */}
      {showImportModal && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={importModalTitleId}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => {
              setShowImportModal(false)
              setImportName('')
              setImportCredential('')
              setIsCredentialMasked(true)
            })
          }
        >
          <div className="account-modal-box">
            <div className="account-modal-header">
              <h4 id={importModalTitleId} className="account-modal-title">
                {loc.importModalTitle(currentToolDefinition.brand)}
              </h4>
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => {
                  setShowImportModal(false)
                  setImportName('')
                  setImportCredential('')
                  setIsCredentialMasked(true)
                }}
                disabled={isBusy}
                aria-label={loc.closeBtn}
              >
                <X size={10} />
              </button>
            </div>

            <form onSubmit={handleImportSubmit} className="account-modal-body">
              <span className="account-modal-help">
                {getImportHelpText(selectedTool)}
              </span>

              <div className="account-field-group">
                <label htmlFor="account-import-name-input" className="account-label">
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
                    title={isCredentialMasked ? loc.showSecretBtn : loc.hideSecretBtn}
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
                  onClick={() => {
                    setShowImportModal(false)
                    setImportName('')
                    setImportCredential('')
                    setIsCredentialMasked(true)
                  }}
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
          </div>
        </div>
      )}

      {/* Modal: Confirm Switch Account (Configuring credentials, no verified login claims) */}
      {pendingSwitchAccount && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={switchModalTitleId}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => setPendingSwitchAccount(null))
          }
        >
          <div className="account-modal-box">
            <div className="account-modal-header">
              <h4 id={switchModalTitleId} className="account-modal-title">
                {loc.confirmSwitchTitle}
              </h4>
              <button
                type="button"
                className="account-btn account-btn--sm"
                onClick={() => setPendingSwitchAccount(null)}
                disabled={isBusy}
                aria-label={loc.closeBtn}
              >
                <X size={10} />
              </button>
            </div>

            <div className="account-modal-body">
              <p>
                {loc.confirmSwitchPrompt(
                  pendingSwitchAccount.name,
                  currentToolDefinition.brand
                )}
              </p>
            </div>

            <div className="account-modal-actions">
              <button
                type="button"
                className="account-btn"
                onClick={() => setPendingSwitchAccount(null)}
                disabled={isBusy}
              >
                {loc.cancelBtn}
              </button>
              <button
                ref={confirmSwitchButtonRef}
                type="button"
                className="account-btn account-btn--primary"
                onClick={handleSwitchConfirmed}
                disabled={isBusy}
              >
                {isBusy ? loc.switchingBtn : loc.confirmSwitchBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Rename Saved Account */}
      {pendingRenameAccount && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={renameModalTitleId}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => {
              setPendingRenameAccount(null)
              setRenameName('')
            })
          }
        >
          <div className="account-modal-box">
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

      {/* Modal: Confirm Remove Saved Copy (NOT logout) */}
      {pendingDeleteAccount && (
        <div
          className="account-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={deleteModalTitleId}
          onKeyDown={(e) =>
            handleModalTrapKeyDown(e, () => setPendingDeleteAccount(null))
          }
        >
          <div className="account-modal-box">
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

  if (presentation === 'workspace') {
    return (
      <>
        {masterColumnNode}
        <section className="app-col-detail view-enter" style={{ overflowY: 'auto' }}>
          <div className="account-workspace-detail">
            {detailCardNode}
          </div>
        </section>
        {modalsNode}
      </>
    )
  }

  return (
    <div className="account-settings-container">
      {detailCardNode}
      {modalsNode}
    </div>
  )
}
