/**
 * Account Quota Card Component (OPC-48)
 *
 * Renders an individual AI developer account card within the auto-fit grid.
 * Displays username, email, active badge, real quota windows with remaining %
 * and reset time, honest status badges, last updated time, and one-click actions.
 *
 * Core Guarantees:
 * - Real quota windows: remaining % and reset time; unknown quota is NOT 0%
 * - Honest expired / forbidden / rate-limited / network / unavailable / stale states
 * - One-click switch directly invokes API without confirmation modal
 * - Current account disabled; accurate progress/error display
 * - Zero secrets or tokens in DOM
 */

import React from 'react'
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

export function AccountQuotaCard({
  account,
  isActive,
  isAvailable,
  isBusy,
  isSwitching,
  isRecoveryNeeded,
  unsupportedReason,
  snapshot,
  isQuotaLoading,
  onSwitch,
  onRename,
  onDelete,
  onRefreshQuota,
  formatDate,
  loc,
  locale,
}: AccountQuotaCardProps) {
  const createdDate = formatDate(account.createdAt)
  const expiresDate = formatDate(account.expiresAt)

  // Status badge resolution
  const status = snapshot?.status
  const isStale = Boolean(snapshot?.stale)
  const lastUpdatedTime = formatQuotaTime(snapshot?.fetchedAt, locale)

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
    isActive || isBusy || !isAvailable || isRecoveryNeeded || isSwitching

  let switchTooltip = loc.switchBtn
  if (isActive) {
    switchTooltip = loc.currentAccountInUse
  } else if (!isAvailable) {
    switchTooltip = unsupportedReason || 'Unavailable in current environment'
  } else if (isRecoveryNeeded) {
    switchTooltip = 'Recovery needed before switching'
  }

  return (
    <div
      className={`account-quota-card ${
        isActive ? 'account-quota-card--active' : ''
      }`}
    >
      {/* 1. Card Top: User Info & Top-Right Action Controls */}
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
          {lastUpdatedTime && (
            <span className="account-quota-updated-time">
              {loc.quotaLastUpdated(lastUpdatedTime)}
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

        {/* Quota Windows List */}
        {snapshot && snapshot.windows && snapshot.windows.length > 0 ? (
          <div
            className="account-quota-windows"
            tabIndex={0}
            role="region"
            aria-label={`${account.name} · ${locale.startsWith('zh') ? '模型配额' : 'Model quotas'}`}
          >
            {snapshot.windows.map((win: AccountQuotaWindow) => {
              const hasPercent =
                typeof win.remainingPercent === 'number' &&
                Number.isFinite(win.remainingPercent) && win.remainingPercent >= 0 && win.remainingPercent <= 100
              const percent = hasPercent ? win.remainingPercent! : null
              const percentLabel = percent !== null && percent > 0 && percent < 1
                ? '<1'
                : percent?.toLocaleString(locale, { maximumFractionDigits: 1 })
              const resetTime = formatResetTime(win.resetsAt, locale)

              // Determine fill bar color based on percentage
              let fillModifier = 'account-quota-fill--high'
              if (percent !== null) {
                if (percent < 20) {
                  fillModifier = 'account-quota-fill--low'
                } else if (percent <= 50) {
                  fillModifier = 'account-quota-fill--mid'
                }
              }

              return (
                <div key={win.id} className="account-quota-window-item">
                  <div className="account-quota-window-header">
                    <span className="account-quota-window-label" title={win.label}>
                      {win.label}
                    </span>
                    <span className="account-quota-window-value">
                      {hasPercent ? `${loc.quotaRemaining} ${percentLabel}%` : loc.quotaUnknown}
                    </span>
                  </div>

                  {/* Progress Bar (Only render when percent is explicitly known, never false 0%) */}
                  {hasPercent && (
                    <div className="account-quota-bar-track" role="progressbar" aria-label={`${win.label} ${loc.quotaRemaining}`} aria-valuenow={percent!} aria-valuemin={0} aria-valuemax={100}>
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
                    <div className="account-quota-window-reset">
                      <Clock size={9} />
                      <span>{loc.quotaResetsAt(resetTime)}</span>
                    </div>
                  )}
                </div>
              )
            })}
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

      {/* 3. Card Footer: Metadata & One-Click Switch Button */}
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
    </div>
  )
}
