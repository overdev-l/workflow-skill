/**
 * Account Quota Card Component (OPC-48)
 *
 * Renders an individual AI developer account card within the auto-fit grid.
 * Displays username, email, active badge, real quota windows with remaining %
 * and reset time, honest status badges, last updated time, and one-click actions.
 * Antigravity windows are aggregated into three vendor shared pools (Google / OpenAI / Claude).
 *
 * Core Guarantees:
 * - Real quota windows: remaining % and reset time; unknown quota is NOT 0%
 * - Honest expired / forbidden / rate-limited / network / unavailable / stale states
 * - One-click switch directly invokes API without confirmation modal
 * - Current account disabled; accurate progress/error display
 * - Zero secrets or tokens in DOM
 */

import React from 'react'
import { groupAntigravityQuotaWindows } from '../utils/quota-grouping.ts'
import {
  formatQuotaCountdown,
  formatQuotaPeriodLabel,
  formatQuotaPeriodShortLabel,
  formatQuotaUpdatedAgo,
  formatQuotaWindowLabel,
} from '../utils/quota-label.ts'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Clock,
  Pencil,
  RefreshCw,
  Trash2,
  User,
  Zap,
} from 'lucide-react'
import type {
  AccountMetadata,
  AccountQuotaSnapshot,
  AccountQuotaWindow,
  AccountRefreshState,
} from '@workflow-skill/workflow-model/accounts'

export interface AccountQuotaCardProps {
  account: AccountMetadata
  isActive: boolean
  isAvailable: boolean
  isBusy: boolean
  isSwitching: boolean
  isRecoveryNeeded: boolean
  unsupportedReason?: string
  snapshot?: AccountQuotaSnapshot
  renewal?: AccountRefreshState
  onReauthenticate?: () => void
  isQuotaLoading: boolean
  onSwitch: (account: AccountMetadata) => void
  onRename: (account: AccountMetadata) => void
  onDelete: (account: AccountMetadata) => void
  onRefreshQuota: (accountId: string) => void
  formatDate: (timestamp?: number) => string | null
  loc: {
    activeBadge: string
    currentAccountInUse: string
    switchBtn: string
    switchingBtn: string
    renameBtn: string
    removeBtn: string
    refreshQuotaBtn: string
    quotaStatusReady: string
    quotaStatusUnavailable: string
    quotaStatusExpired: string
    quotaStatusForbidden: string
    quotaStatusRateLimited: string
    quotaStatusError: string
    quotaStatusStale: string
    quotaRemaining: string
    quotaUnknown: string
    quotaResetsAt: (time: string) => string
    quotaResetUnavailable: string
    quotaLastUpdated: (time: string) => string
    quotaNotFetched: string
    quotaLoading: string
    accountIdLabel: string
    emailLabel: string
    createdDatePrefix: string
    expiresDatePrefix: string
  }
  locale: string
  presentation?: 'card' | 'detail'
}

function formatQuotaTime(timestamp?: number, locale: string = 'zh-CN'): string | null {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null
  }
  try {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()

    if (isToday) {
      return date.toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    }
    return date.toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}

function formatResetTime(resetsAt?: number, locale: string = 'zh-CN'): string | null {
  if (!resetsAt || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return null
  }
  try {
    const date = new Date(resetsAt)
    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()

    if (isToday) {
      return date.toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    return date.toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}

/** Drives reset countdowns and the relative "updated" label without refetching quota. */
const QUOTA_TICK_INTERVAL_MS = 30_000

function useQuotaClock(enabled: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!enabled) {
      return
    }
    // Realign immediately: a card mounted long before its snapshot arrived would
    // otherwise keep counting down from its mount time until the first tick.
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), QUOTA_TICK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled])

  return now
}

export function AccountQuotaCard({
  account,
  isActive,
  isAvailable,
  isBusy,
  isSwitching,
  isRecoveryNeeded,
  unsupportedReason,
  snapshot,
  renewal,
  onReauthenticate,
  isQuotaLoading,
  onSwitch,
  onRename,
  onDelete,
  onRefreshQuota,
  formatDate,
  loc,
  locale,
  presentation = 'card',
}: AccountQuotaCardProps) {
  const createdDate = formatDate(account.createdAt)
  const expiresDate = formatDate(account.expiresAt)

  // Status badge resolution
  const status = snapshot?.status
  const isStale = Boolean(snapshot?.stale)
  const now = useQuotaClock(Boolean(snapshot))
  const lastUpdatedTime = formatQuotaTime(snapshot?.fetchedAt, locale)
  // Relative age keeps the header compact; the absolute time stays in the tooltip.
  const lastUpdatedAgo = formatQuotaUpdatedAgo(snapshot?.fetchedAt, now, locale) ?? lastUpdatedTime
  const isZh = locale.startsWith('zh')
  const renewalLabels = isZh
    ? { refreshing: '正在续期', ready: '已自动续期', retrying: '续期暂时失败，将重试', 'reauth-required': '需要重新授权', unsupported: '暂不支持自动续期', blocked: '自动续期受阻' }
    : { refreshing: 'Renewing', ready: 'Renewed automatically', retrying: 'Renewal failed; will retry', 'reauth-required': 'Sign-in required', unsupported: 'Automatic renewal unavailable', blocked: 'Renewal blocked' }
  const renewalReasons = isZh
    ? { network: '网络异常', 'rate-limited': '服务限流', 'invalid-grant': '授权已失效', 'missing-refresh-token': '凭据不含刷新令牌', 'unknown-client': '无法确认原授权来源，请重新 OAuth 登录', 'credential-conflict': '登录已在其他位置更新', 'native-access': '无法读取原生登录，请检查凭据访问权限', 'runtime-active': '请先退出官方客户端及 CLI 会话', storage: '凭据保存失败', 'invalid-response': '服务返回的凭据未通过校验' }
    : { network: 'Network unavailable', 'rate-limited': 'Service rate limit', 'invalid-grant': 'Authorization is no longer valid', 'missing-refresh-token': 'No refresh token', 'unknown-client': 'Unknown OAuth client; sign in again', 'credential-conflict': 'Credentials changed elsewhere', 'native-access': 'Check access to native credentials', 'runtime-active': 'Quit the official app and CLI sessions first', storage: 'Could not save credentials', 'invalid-response': 'Invalid credential response' }
  const showRenewal = renewal && (renewal.status !== 'ready' || renewal.refreshedAt)
  const renewalDescription = renewal?.reason === 'runtime-active' && account.tool !== 'antigravity'
    ? (isZh ? '当前工具共用此授权，请通过 OAuth 添加独立授权以自动续期' : 'This grant is shared with the current tool; add a separate OAuth sign-in to renew automatically')
    : renewal?.reason ? renewalReasons[renewal.reason] : undefined

  const getStatusBadge = () => {
    if (!status) {
      return null
    }

    switch (status) {
      case 'ready':
        return (
          <span className="account-quota-status-badge account-quota-status-badge--ready">
            <Check size={10} />
            <span>{loc.quotaStatusReady}</span>
          </span>
        )
      case 'expired':
        return (
          <span className="account-quota-status-badge account-quota-status-badge--expired">
            <AlertCircle size={10} />
            <span>{loc.quotaStatusExpired}</span>
          </span>
        )
      case 'forbidden':
        return (
          <span className="account-quota-status-badge account-quota-status-badge--forbidden">
            <AlertTriangle size={10} />
            <span>{loc.quotaStatusForbidden}</span>
          </span>
        )
      case 'rate-limited':
        return (
          <span className="account-quota-status-badge account-quota-status-badge--limited">
            <Clock size={10} />
            <span>{loc.quotaStatusRateLimited}</span>
          </span>
        )
      case 'unavailable':
        return (
          <span className="account-quota-status-badge account-quota-status-badge--unavailable">
            <span>{loc.quotaStatusUnavailable}</span>
          </span>
        )
      case 'error':
        return (
          <span className="account-quota-status-badge account-quota-status-badge--error">
            <AlertTriangle size={10} />
            <span>{loc.quotaStatusError}</span>
          </span>
        )
      default:
        return null
    }
  }

  // Switch button disabled state & title
  const isSwitchDisabled =
    isActive || isBusy || !isAvailable || isRecoveryNeeded || isSwitching || renewal?.status === 'refreshing' || renewal?.status === 'reauth-required'

  let switchTooltip = loc.switchBtn
  if (isActive) {
    switchTooltip = loc.currentAccountInUse
  } else if (!isAvailable) {
    switchTooltip = unsupportedReason || 'Unavailable in current environment'
  } else if (isRecoveryNeeded) {
    switchTooltip = 'Recovery needed before switching'
  }

  const antigravityModelGroups = account.tool === 'antigravity' && snapshot?.windows
    ? groupAntigravityQuotaWindows(snapshot.windows)
    : []
  const hasRenderableQuotaWindows = account.tool === 'antigravity'
    ? antigravityModelGroups.some((group) => group.windows.length > 0)
    : Boolean(snapshot?.windows && snapshot.windows.length > 0)

  /** Shared numbers behind both the flat window list and the grouped period rows. */
  const describeQuotaWindow = (win: AccountQuotaWindow) => {
    const hasPercent =
      typeof win.remainingPercent === 'number' &&
      Number.isFinite(win.remainingPercent) && win.remainingPercent >= 0 && win.remainingPercent <= 100
    const percent = hasPercent ? win.remainingPercent! : null
    const percentLabel = percent !== null && percent > 0 && percent < 1
      ? '<1'
      : percent?.toLocaleString(locale, { maximumFractionDigits: 1 })
    const percentText = percent !== null ? `${percentLabel ?? '0'}%` : '—'

    // Determine fill bar color based on percentage
    let fillModifier = 'account-quota-fill--high'
    if (percent !== null) {
      if (percent < 20) {
        fillModifier = 'account-quota-fill--low'
      } else if (percent <= 50) {
        fillModifier = 'account-quota-fill--mid'
      }
    }

    return {
      hasPercent,
      percent,
      percentText,
      fillModifier,
      valueLabel: hasPercent ? `${loc.quotaRemaining} ${percentText}` : loc.quotaUnknown,
      resetTime: formatResetTime(win.resetsAt, locale),
    }
  }

  /**
   * One full-width period row inside a vendor shared pool: the pool title already
   * names the models, so the row only carries period, bar, percent and countdown.
   */
  const renderQuotaPeriodRow = (win: AccountQuotaWindow, poolLabel: string) => {
    const periodLabel = formatQuotaPeriodShortLabel(win, account.tool, locale)
    const fullPeriodLabel = formatQuotaPeriodLabel(win, account.tool, locale)
    const accessibleLabel = `${poolLabel} · ${fullPeriodLabel}`
    const { hasPercent, percent, percentText, fillModifier, valueLabel, resetTime } = describeQuotaWindow(win)
    const countdown = formatQuotaCountdown(win.resetsAt, now, locale)
    const resetTitle = resetTime ? loc.quotaResetsAt(resetTime) : undefined

    return (
      <div key={win.id} className="account-quota-period-row">
        <span className="account-quota-period-label" title={accessibleLabel}>
          {periodLabel}
        </span>
        <div
          className={`account-quota-bar-track ${hasPercent ? '' : 'account-quota-bar-track--unknown'}`}
          role="progressbar"
          aria-label={`${accessibleLabel} ${loc.quotaRemaining}`}
          aria-valuenow={hasPercent ? percent! : undefined}
          aria-valuemin={hasPercent ? 0 : undefined}
          aria-valuemax={hasPercent ? 100 : undefined}
          aria-valuetext={valueLabel}
        >
          {/* Only render a fill when percent is explicitly known, never a false 0% */}
          {hasPercent && (
            <div
              className={`account-quota-bar-fill ${fillModifier}`}
              style={{ width: `${Math.max(0, Math.min(100, percent!))}%` }}
            />
          )}
        </div>
        <span className="account-quota-period-value" title={valueLabel}>
          {percentText}
        </span>
        {/* Countdown is omitted entirely when the provider gave no reset time */}
        {countdown && (
          <span className="account-quota-period-countdown" title={resetTitle}>
            <Clock size={9} />
            <span>{countdown}</span>
          </span>
        )}
      </div>
    )
  }

  const renderQuotaWindow = (win: AccountQuotaWindow) => {
    const label = formatQuotaWindowLabel(win, account.tool, locale)
    const { hasPercent, percent, fillModifier, valueLabel, resetTime } = describeQuotaWindow(win)

    return (
      <div key={win.id} className="account-quota-window-item">
        <div className="account-quota-window-header">
          <span className="account-quota-window-label" title={label}>
            {label}
          </span>
          <span className="account-quota-window-value">
            {valueLabel}
          </span>
        </div>

        {/* Progress Bar (Only render when percent is explicitly known, never false 0%) */}
        {hasPercent && (
          <div className="account-quota-bar-track" role="progressbar" aria-label={`${label} ${loc.quotaRemaining}`} aria-valuenow={percent!} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`account-quota-bar-fill ${fillModifier}`}
              style={{
                width: `${Math.max(0, Math.min(100, percent!))}%`,
              }}
            />
          </div>
        )}

        {/* Reset Time (omitted if not provided or invalid) */}
        {resetTime && (
          <div className="account-quota-window-reset" title={loc.quotaResetsAt(resetTime)}>
            <Clock size={9} />
            <span>{loc.quotaResetsAt(resetTime)}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`account-quota-card ${
        presentation === 'detail' ? 'account-quota-card--detail' : ''
      } ${isActive ? 'account-quota-card--active' : ''}`}
    >
      {/* 1. Card Top: User Info & Top-Right Action Controls (Omitted in detail presentation) */}
      {presentation !== 'detail' && (
        <div className="account-card-header">
          <div className="account-card-identity">
            <div className="account-card-avatar">
              <User size={13} />
            </div>
            <div className="account-card-name-group">
              <div className="account-card-name-row">
                <span className="account-card-name" title={account.name}>
                  {account.name}
                </span>
                {isActive && (
                  <span className="account-active-badge">
                    <Check size={9} />
                    <span>{loc.activeBadge}</span>
                  </span>
                )}
              </div>
              {account.email && (
                <span className="account-card-email" title={account.email}>
                  {account.email}
                </span>
              )}
            </div>
          </div>

          <div className="account-card-top-actions">
            {/* Relative snapshot age, sitting next to the control it belongs to */}
            {lastUpdatedAgo && (
              <span
                className={`account-quota-updated-time ${
                  isStale ? 'account-quota-updated-time--stale' : ''
                }`}
                title={lastUpdatedTime ? loc.quotaLastUpdated(lastUpdatedTime) : undefined}
              >
                {lastUpdatedAgo}
              </span>
            )}

            {/* Refresh Quota Icon Button */}
            <button
              type="button"
              className="account-icon-btn"
              onClick={() => onRefreshQuota(account.id)}
              disabled={isBusy || isQuotaLoading}
              title={loc.refreshQuotaBtn}
              aria-label={loc.refreshQuotaBtn}
            >
              <RefreshCw
                size={11}
                className={isQuotaLoading ? 'animate-spin' : ''}
              />
            </button>

            {/* Rename Icon Button */}
            <button
              type="button"
              className="account-icon-btn"
              onClick={() => onRename(account)}
              disabled={isBusy}
              title={loc.renameBtn}
              aria-label={loc.renameBtn}
            >
              <Pencil size={11} />
            </button>

            {/* Delete Icon Button */}
            <button
              type="button"
              className="account-icon-btn account-icon-btn--danger"
              onClick={() => onDelete(account)}
              disabled={isBusy}
              title={loc.removeBtn}
              aria-label={loc.removeBtn}
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}

      {/* 2. Quota & Usage Stage */}
      <div className="account-card-quota-section">
        {/* Status Bar */}
        <div className="account-quota-status-row">
          <div className="account-quota-badges">
            {getStatusBadge()}
            {isStale && (
              <span className="account-quota-status-badge account-quota-status-badge--stale">
                <span>{loc.quotaStatusStale}</span>
              </span>
            )}
            {snapshot?.plan && (
              <span className="account-quota-plan-badge">
                <Zap size={9} />
                <span>{snapshot.plan}</span>
              </span>
            )}
            {!snapshot?.plan && snapshot?.planReason && (
              <span className="account-quota-plan-badge">
                {locale.startsWith('zh') ? '权益暂未确认' : 'Plan unconfirmed'}
              </span>
            )}
          </div>
          {/* Detail presentation has no header, so the status row keeps the fallback */}
          {presentation === 'detail' && lastUpdatedAgo && (
            <span className="account-quota-updated-time" title={lastUpdatedTime ?? undefined}>
              {loc.quotaLastUpdated(lastUpdatedAgo)}
            </span>
          )}
        </div>

        {snapshot?.planReason === 'restricted-age' && (
          <p className="account-plan-notice">
            {locale.startsWith('zh')
              ? 'Google 返回年龄资格限制，暂无法确认订阅权益。请检查 Google 账号的年龄验证状态。'
              : 'Google returned an age eligibility restriction. Check age verification in your Google account; subscription benefits could not be confirmed.'}
          </p>
        )}

        {showRenewal && (
          <div className="account-renewal-notice" role="status">
            <span title={renewalDescription}>
              {renewalLabels[renewal.status]}
              {renewalDescription && ` · ${renewalDescription}`}
              {renewal.retryAt && ` · ${isZh ? '重试于' : 'Retry at'} ${formatQuotaTime(renewal.retryAt, locale) ?? ''}`}
            </span>
            {(renewal.status === 'reauth-required' || renewal.status === 'unsupported') && onReauthenticate && (
              <button type="button" className="account-btn account-btn--sm" disabled={isBusy} onClick={onReauthenticate}>
                {isZh ? '重新授权' : 'Sign in'}
              </button>
            )}
          </div>
        )}

        {/* Quota Windows List */}
        {hasRenderableQuotaWindows ? (
          <div
            className={`account-quota-windows ${account.tool === 'antigravity' ? 'account-quota-windows--antigravity' : ''} ${isStale ? 'account-quota-windows--stale' : ''}`}
            tabIndex={0}
            role="region"
            aria-label={`${account.name} · ${locale.startsWith('zh') ? '共享配额池' : 'Shared quota pools'}${isStale ? ` · ${loc.quotaStatusStale}` : ''}`}
          >
            {account.tool === 'antigravity'
              ? antigravityModelGroups.map((group) => {
                const titleId = `${account.id}-quota-pool-${group.id}`
                return (
                  <div key={group.id} className="account-quota-model-group" role="group" aria-labelledby={titleId}>
                    <div className="account-quota-model-group-header">
                      <span id={titleId} className="account-quota-model-group-title" title={group.label}>
                        {group.label}
                      </span>
                    </div>
                    <div className="account-quota-model-windows">
                      {group.windows.map((win) => renderQuotaPeriodRow(win, group.label))}
                    </div>
                  </div>
                )
              })
              : snapshot?.windows.map((win) => renderQuotaWindow(win))}
          </div>
        ) : isQuotaLoading ? (
          <div className="account-quota-loading-placeholder">
            <RefreshCw size={12} className="animate-spin" />
            <span>{loc.quotaLoading}</span>
          </div>
        ) : (
          <div className="account-quota-empty-placeholder">
            <span>{loc.quotaNotFetched}</span>
          </div>
        )}
      </div>

      {/* 3. Card Footer: Metadata & One-Click Switch Button (Omitted in detail presentation) */}
      {presentation !== 'detail' && (
        <div className="account-card-footer">
          <div className="account-card-meta">
            {createdDate && (
              <span className="account-card-meta-item">
                {loc.createdDatePrefix} {createdDate}
              </span>
            )}
            {expiresDate && (
              <span className="account-card-meta-item">
                {loc.expiresDatePrefix}: {expiresDate}
              </span>
            )}
          </div>

          {/* One-Click Direct Switch Action Button */}
          <button
            type="button"
            className={`account-btn account-card-switch-btn ${
              isActive
                ? 'account-card-switch-btn--active'
                : 'account-btn--primary'
            }`}
            onClick={() => onSwitch(account)}
            disabled={isSwitchDisabled}
            title={switchTooltip}
          >
            {isSwitching ? (
              <>
                <RefreshCw size={11} className="animate-spin" />
                <span>{loc.switchingBtn}</span>
              </>
            ) : isActive ? (
              <>
                <Check size={11} />
                <span>{loc.currentAccountInUse}</span>
              </>
            ) : (
              <>
                <ArrowRightLeft size={11} />
                <span>{loc.switchBtn}</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
