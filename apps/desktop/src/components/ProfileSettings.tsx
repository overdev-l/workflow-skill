/**
 * AI Developer Profile Settings Component (OPC-48)
 *
 * Provides a native macOS-style UI for capturing, switching, and rolling back
 * Claude Code and OpenAI Codex developer profiles (credentials + model settings + MCP).
 *
 * Invariants:
 * - Pure metadata-only presentation (zero secret or token exposure)
 * - Safe error handling (never raw stacktraces or exception text)
 * - One-click byte-exact rollback and emergency recovery banner
 * - Compact capsule design system (24px/22px buttons, 28px inputs)
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRightLeft,
  Key,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  ProfileManagementAPI,
  ProfileMetadata,
  ProfileRecoveryStatus,
} from '@workflow-skill/workflow-model/profiles'
import { useI18n } from '../i18n.tsx'
import '../profiles.css'

export type ProfileSettingsAPI = ProfileManagementAPI

export interface ProfileSettingsProps {
  api?: ProfileSettingsAPI
  onNotify?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

const DICTIONARY = {
  'zh-CN': {
    headerTitle: '账号配置',
    headerBadge: 'Claude Code & Codex',
    headerDescription:
      '一起保存和切换 Claude Code、Codex 的凭据、模型与全局 MCP。快照以明文保存在本机，仅当前用户可访问；切换前自动备份，可一键回滚。新配置在新的工具会话中生效。',
    saveBtn: '保存当前配置',
    savingBtn: '正在保存…',
    saveFormTitle: '捕获当前环境配置为新 Profile',
    saveFormHelp:
      '提示：请先在外部终端中登录并配置好 Claude Code 或 Codex 的目标账号，然后在下方输入配置名称进行捕获。',
    nameLabel: '配置名称',
    namePlaceholder: '例如：工作账号或个人账号',
    descLabel: '描述（可选）',
    descPlaceholder: '备注该账号的用途或组织归属…',
    cancelBtn: '取消',
    confirmSaveBtn: '确认保存',
    rollbackBtn: '回滚上次切换',
    rollingBackBtn: '正在回滚…',
    refreshBtn: '刷新',
    recoveryBannerTitle: '检测到未完成的切换状态',
    recoveryBannerDesc:
      '上次切换操作未完全结束。系统已安全保护原始备份，请点击紧急恢复按钮恢复至切换前状态。',
    emergencyRecoverBtn: '立即恢复',
    recoveringBtn: '正在恢复…',
    confirmSwitchTitle: '确认切换配置',
    confirmSwitchPrompt: (name: string) =>
      `确定要切换到配置「${name}」吗？系统将在切换前自动备份当前配置，支持一键回滚。`,
    confirmSwitchBtn: '确认切换',
    switchingBtn: '正在切换…',
    switchBtn: '切换',
    emptyTitle: '暂无已保存的账号配置',
    emptyDesc:
      '点击右上方的「保存当前配置」，将当前系统的 Claude Code 和 Codex 凭证、模型参数及 MCP 配置保存为首个 Profile。',
    authChip: '凭证',
    modelChip: '模型',
    mcpChip: 'MCP',
    unavailableTitle: '原生桌面服务未连接',
    unavailableDesc:
      '账号配置管理依赖本地 Electron 桌面服务及系统钥匙串。请在桌面应用端运行。',
    switchSuccess: (name: string) => `已成功切换至配置「${name}」`,
    rollbackSuccess: '已成功回滚至切换前的配置状态',
    recoverySuccess: '紧急恢复成功，配置已恢复为原始备份状态',
    captureSuccess: (name: string) => `已成功保存配置「${name}」`,
    nameRequired: '请输入有效的配置名称',
    loadError: '读取账号配置失败，请重试。',
    loading: '正在读取账号配置…',
  },
  'en-US': {
    headerTitle: 'Account Profiles',
    headerBadge: 'Claude Code & Codex',
    headerDescription:
      'Save and switch Claude Code and Codex credentials, models, and global MCP together. Snapshots are stored as plaintext on this computer with access restricted to your user. Each switch creates a rollback backup. Changes apply to new tool sessions.',
    saveBtn: 'Save Current Setup',
    savingBtn: 'Saving…',
    saveFormTitle: 'Capture Active Setup as Profile',
    saveFormHelp:
      'Tip: Log in and configure your desired account in Claude Code or Codex CLI first, then enter a name below to capture the active environment.',
    nameLabel: 'Profile Name',
    namePlaceholder: 'e.g., Work or Personal',
    descLabel: 'Description (Optional)',
    descPlaceholder: 'Notes about organization or subscription plan…',
    cancelBtn: 'Cancel',
    confirmSaveBtn: 'Save Profile',
    rollbackBtn: 'Rollback Last Switch',
    rollingBackBtn: 'Rolling back…',
    refreshBtn: 'Refresh',
    recoveryBannerTitle: 'Interrupted Switch Detected',
    recoveryBannerDesc:
      'A previous profile switch did not finish cleanly. Your original pre-switch snapshot is intact. Click emergency recovery to restore.',
    emergencyRecoverBtn: 'Emergency Recover',
    recoveringBtn: 'Recovering…',
    confirmSwitchTitle: 'Confirm Profile Switch',
    confirmSwitchPrompt: (name: string) =>
      `Switch to profile "${name}"? Current state will be automatically snapshotted before applying.`,
    confirmSwitchBtn: 'Confirm Switch',
    switchingBtn: 'Switching…',
    switchBtn: 'Switch',
    emptyTitle: 'No Saved Profiles Yet',
    emptyDesc:
      'Click "Save Current Setup" above to capture active Claude Code & Codex credentials, model settings, and MCP servers as your first profile.',
    authChip: 'Auth',
    modelChip: 'Model',
    mcpChip: 'MCP',
    unavailableTitle: 'Desktop Service Unavailable',
    unavailableDesc:
      'Profile management requires native desktop services and OS keychain. Please run inside the Trace Desktop application.',
    switchSuccess: (name: string) => `Switched to profile "${name}"`,
    rollbackSuccess: 'Successfully rolled back to previous profile state',
    recoverySuccess: 'Emergency recovery completed: restored to original backup',
    captureSuccess: (name: string) => `Profile "${name}" saved successfully`,
    nameRequired: 'Please enter a valid profile name',
    loadError: 'Failed to load profiles. Please try again.',
    loading: 'Loading account profiles…',
  },
}

export function ProfileSettings({ api, onNotify }: ProfileSettingsProps) {
  const { resolvedLocale } = useI18n()
  const loc = DICTIONARY[resolvedLocale] || DICTIONARY['zh-CN']

  const [profiles, setProfiles] = useState<ProfileMetadata[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [isBusy, setIsBusy] = useState<boolean>(false)
  const [recoveryStatus, setRecoveryStatus] = useState<ProfileRecoveryStatus | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Form State
  const [showCaptureForm, setShowCaptureForm] = useState<boolean>(false)
  const [captureName, setCaptureName] = useState<string>('')
  const [captureDesc, setCaptureDesc] = useState<string>('')

  // Confirmation Modal State
  const [pendingSwitchProfile, setPendingSwitchProfile] = useState<ProfileMetadata | null>(null)

  const nameInputRef = useRef<HTMLInputElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const modalTitleId = useId()

  const loadData = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      const [list, status] = await Promise.all([
        api.listProfiles(),
        api.getProfileRecoveryStatus(),
      ])
      setProfiles(list)
      setRecoveryStatus(status)
    } catch {
      setErrorMessage(loc.loadError)
    } finally {
      setLoading(false)
    }
  }, [api, loc.loadError])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (!api?.onProfilesChanged) return
    const unsubscribe = api.onProfilesChanged(() => {
      loadData()
    })
    return () => {
      unsubscribe?.()
    }
  }, [api, loadData])

  useEffect(() => {
    if (showCaptureForm) {
      nameInputRef.current?.focus()
    }
  }, [showCaptureForm])

  useEffect(() => {
    if (pendingSwitchProfile) {
      confirmButtonRef.current?.focus()
    }
  }, [pendingSwitchProfile])

  // Keyboard navigation for modal & capture form
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        if (pendingSwitchProfile) {
          setPendingSwitchProfile(null)
        } else if (showCaptureForm) {
          setShowCaptureForm(false)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pendingSwitchProfile, showCaptureForm, isBusy])

  const handleCaptureSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!api) return

    const trimmedName = captureName.trim()
    if (!trimmedName) {
      setErrorMessage(loc.nameRequired)
      return
    }

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const created = await api.captureProfile({
        name: trimmedName,
        description: captureDesc.trim() || undefined,
      })

      setCaptureName('')
      setCaptureDesc('')
      setShowCaptureForm(false)
      onNotify?.(loc.captureSuccess(created.name), 'success')
      await loadData()
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to capture profile.')
    } finally {
      setIsBusy(false)
    }
  }

  const handleSwitchConfirmed = async () => {
    if (!api || !pendingSwitchProfile) return
    const target = pendingSwitchProfile

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res = await api.switchProfile(target.id)

      if (res.success) {
        onNotify?.(loc.switchSuccess(target.name), 'success')
      } else {
        setErrorMessage(res.error || 'Failed to switch profile.')
      }

      setPendingSwitchProfile(null)
      await loadData()
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to switch profile.')
      setPendingSwitchProfile(null)
    } finally {
      setIsBusy(false)
    }
  }

  const handleRollback = async () => {
    if (!api) return

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res = await api.rollbackProfile()

      if (res.success) {
        onNotify?.(loc.rollbackSuccess, 'success')
      } else {
        setErrorMessage(res.error || 'Failed to rollback profile switch.')
      }

      await loadData()
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to rollback profile switch.')
    } finally {
      setIsBusy(false)
    }
  }

  const handleEmergencyRecovery = async () => {
    if (!api) return

    try {
      setIsBusy(true)
      setErrorMessage(null)
      const res = await api.recoverProfile()

      if (res.success) {
        onNotify?.(loc.recoverySuccess, 'success')
      } else {
        setErrorMessage(res.error || 'Emergency recovery could not complete.')
      }

      await loadData()
    } catch (err: any) {
      setErrorMessage(err?.message || 'Emergency recovery failed.')
    } finally {
      setIsBusy(false)
    }
  }

  // Capability status
  const isRecoveryPending = Boolean(recoveryStatus?.isRecoveryNeeded)
  const canRollback =
    recoveryStatus?.journalStatus === 'completed' && !isRecoveryPending

  if (!api) {
    return (
      <div className="profile-settings-container">
        <div className="profile-card">
          <div className="profile-empty-state">
            <ShieldCheck size={28} className="profile-recovery-icon" />
            <span className="profile-empty-title">{loc.unavailableTitle}</span>
            <span className="profile-empty-desc">{loc.unavailableDesc}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="profile-settings-container">
      <div className="profile-card">
        {/* Header Title & Description */}
        <div className="profile-header-row">
          <div className="profile-title-group">
            <h3 className="profile-title">{loc.headerTitle}</h3>
            <span className="profile-badge">{loc.headerBadge}</span>
          </div>
          <div className="profile-toolbar-actions">
            <button
              type="button"
              className="profile-btn profile-btn--sm"
              onClick={() => { setErrorMessage(null); void loadData() }}
              disabled={loading || isBusy}
              title={loc.refreshBtn}
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              <span>{loc.refreshBtn}</span>
            </button>
            <button
              type="button"
              className="profile-btn profile-btn--sm"
              onClick={handleRollback}
              disabled={!canRollback || isBusy || isRecoveryPending}
            >
              <RotateCcw size={12} />
              <span>{loc.rollbackBtn}</span>
            </button>
            <button
              type="button"
              className="profile-btn profile-btn--primary profile-btn--sm"
              onClick={() => setShowCaptureForm(true)}
              disabled={showCaptureForm || isBusy || isRecoveryPending}
            >
              <Plus size={12} />
              <span>{loc.saveBtn}</span>
            </button>
          </div>
        </div>

        <p className="profile-desc">{loc.headerDescription}</p>

        {/* Error Callout */}
        {errorMessage && (
          <div className="profile-error-callout" role="alert">
            <span>{errorMessage}</span>
            <button
              type="button"
              className="profile-btn profile-btn--sm"
              onClick={() => setErrorMessage(null)}
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* Emergency Recovery Banner */}
        {isRecoveryPending && (
          <div className="profile-recovery-banner" role="status">
            <div className="profile-recovery-info">
              <AlertTriangle size={18} className="profile-recovery-icon" />
              <div className="profile-recovery-text">
                <strong>{loc.recoveryBannerTitle}</strong>
                <p>{loc.recoveryBannerDesc}</p>
              </div>
            </div>
            <button
              type="button"
              className="profile-btn profile-btn--danger profile-btn--sm"
              onClick={handleEmergencyRecovery}
              disabled={isBusy}
            >
              <RotateCcw size={12} />
              <span>{isBusy ? loc.recoveringBtn : loc.emergencyRecoverBtn}</span>
            </button>
          </div>
        )}

        {/* Inline Capture Form */}
        {showCaptureForm && (
          <form className="profile-capture-box" onSubmit={handleCaptureSubmit}>
            <div className="profile-capture-header">
              <span className="profile-capture-title">{loc.saveFormTitle}</span>
              <span className="profile-capture-help">{loc.saveFormHelp}</span>
            </div>

            <div className="profile-field-group">
              <label htmlFor="profile-name-input" className="profile-label">
                {loc.nameLabel} *
              </label>
              <input
                id="profile-name-input"
                ref={nameInputRef}
                type="text"
                className="profile-input"
                value={captureName}
                onChange={(e) => setCaptureName(e.target.value)}
                placeholder={loc.namePlaceholder}
                disabled={isBusy}
                maxLength={80}
                required
              />
            </div>

            <div className="profile-field-group">
              <label htmlFor="profile-desc-input" className="profile-label">
                {loc.descLabel}
              </label>
              <input
                id="profile-desc-input"
                type="text"
                className="profile-input"
                value={captureDesc}
                onChange={(e) => setCaptureDesc(e.target.value)}
                placeholder={loc.descPlaceholder}
                disabled={isBusy}
                maxLength={120}
              />
            </div>

            <div className="profile-capture-actions">
              <button
                type="button"
                className="profile-btn profile-btn--sm"
                onClick={() => setShowCaptureForm(false)}
                disabled={isBusy}
              >
                {loc.cancelBtn}
              </button>
              <button
                type="submit"
                className="profile-btn profile-btn--primary profile-btn--sm"
                disabled={isBusy || !captureName.trim()}
              >
                {isBusy ? loc.savingBtn : loc.confirmSaveBtn}
              </button>
            </div>
          </form>
        )}

        {loading && <p className="profile-desc" role="status">{loc.loading}</p>}

        {/* Profile List */}
        {profiles.length > 0 ? (
          <div className="profile-list">
            {profiles.map((p) => {
              const claudeSummary = p.tools.find((t) => t.tool === 'claude-code')
              const codexSummary = p.tools.find((t) => t.tool === 'codex')
              const dateText = new Date(p.createdAt).toLocaleDateString(
                resolvedLocale,
                {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }
              )

              return (
                <div key={p.id} className="profile-item-row">
                  <div className="profile-item-main">
                    <div className="profile-item-title-row">
                      <span className="profile-item-name">{p.name}</span>
                      <span className="profile-item-date">{dateText}</span>
                    </div>

                    {p.description && (
                      <span className="profile-item-desc">{p.description}</span>
                    )}

                    <div className="profile-item-slots">
                      {claudeSummary && (
                        <span
                          className={`profile-slot-chip ${
                            claudeSummary.hasCredentials ? 'profile-slot-chip--active' : ''
                          }`}
                        >
                          <Key size={10} />
                          <span>Claude Code</span>
                        </span>
                      )}
                      {codexSummary && (
                        <span
                          className={`profile-slot-chip ${
                            codexSummary.hasCredentials ? 'profile-slot-chip--active' : ''
                          }`}
                        >
                          <Key size={10} />
                          <span>Codex</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="profile-item-actions">
                    <button
                      type="button"
                      className="profile-btn profile-btn--sm"
                      onClick={() => setPendingSwitchProfile(p)}
                      disabled={isBusy || isRecoveryPending}
                    >
                      <ArrowRightLeft size={11} />
                      <span>{loc.switchBtn}</span>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          !loading &&
          !showCaptureForm && (
            <div className="profile-empty-state">
              <span className="profile-empty-title">{loc.emptyTitle}</span>
              <span className="profile-empty-desc">{loc.emptyDesc}</span>
            </div>
          )
        )}
      </div>

      {/* Confirmation Modal */}
      {pendingSwitchProfile && (
        <div
          className="profile-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={modalTitleId}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            if (!buttons.length) return
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            event.preventDefault()
            buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus()
          }}
        >
          <div className="profile-modal-box">
            <h4 id={modalTitleId} className="profile-modal-title">
              {loc.confirmSwitchTitle}
            </h4>
            <p className="profile-modal-body">
              {loc.confirmSwitchPrompt(pendingSwitchProfile.name)}
            </p>
            <div className="profile-modal-actions">
              <button
                type="button"
                className="profile-btn"
                onClick={() => setPendingSwitchProfile(null)}
                disabled={isBusy}
              >
                {loc.cancelBtn}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className="profile-btn profile-btn--primary"
                onClick={handleSwitchConfirmed}
                disabled={isBusy}
              >
                {isBusy ? loc.switchingBtn : loc.confirmSwitchBtn}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
