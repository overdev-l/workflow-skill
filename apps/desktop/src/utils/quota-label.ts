import type { AccountQuotaWindow, AccountTool } from '@workflow-skill/workflow-model/accounts'

/** Format only the provider period, without repeating the model name. */
export function formatQuotaPeriodLabel(window: AccountQuotaWindow, tool: AccountTool, locale: string): string {
  const zh = locale.startsWith('zh')
  if (tool === 'antigravity') {
    if (window.period === 'weekly') {
      return zh ? '周额度' : 'Weekly quota'
    }
    if (window.period === 'five-hour') {
      return zh ? '5 小时额度' : '5-hour quota'
    }
    return zh ? '额度（周期未知）' : 'Quota (period unknown)'
  }
  const claudePeriods: Record<string, number> = {
    five_hour: 18000, seven_day: 604800, seven_day_opus: 604800, seven_day_sonnet: 604800,
  }
  const seconds = tool === 'claude-code' ? claudePeriods[window.id] ?? window.durationSeconds : window.durationSeconds
  let label: string
  if (seconds === 18000) label = zh ? '5 小时额度' : '5-hour quota'
  else if (seconds === 604800) label = zh ? '周额度' : 'Weekly quota'
  else if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    label = zh ? '额度（周期未知）' : 'Quota (period unknown)'
  } else {
    const [divisor, unit, en] = seconds % 86400 === 0 ? [86400, '天', 'day'] as const
      : seconds % 3600 === 0 ? [3600, '小时', 'hour'] as const
      : seconds % 60 === 0 ? [60, '分钟', 'minute'] as const : [1, '秒', 'second'] as const
    const amount = (seconds / divisor).toLocaleString(locale, { maximumFractionDigits: 20 })
    label = zh ? `${amount} ${unit}额度` : `${amount}-${en} quota`
  }
  if (tool === 'claude-code') {
    if (window.id === 'seven_day_opus') return `${label} · Opus`
    if (window.id === 'seven_day_sonnet') return `${label} · Sonnet`
  }
  return label
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Countdown to the next reset, e.g. `2h13m` / `4d02h`.
 * Returns null when there is no usable reset timestamp, so the caller can omit
 * the column entirely instead of rendering a placeholder.
 */
export function formatQuotaCountdown(resetsAt: number | undefined, now: number, locale: string): string | null {
  if (!resetsAt || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return null
  }
  const zh = locale.startsWith('zh')
  const remaining = resetsAt - now
  if (remaining <= 0) {
    return zh ? '即将重置' : 'Due'
  }
  if (remaining < MINUTE_MS) {
    return zh ? '<1 分钟' : '<1m'
  }
  if (remaining < HOUR_MS) {
    return `${Math.floor(remaining / MINUTE_MS)}m`
  }
  if (remaining < DAY_MS) {
    const hours = Math.floor(remaining / HOUR_MS)
    const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS)
    return `${hours}h${String(minutes).padStart(2, '0')}m`
  }
  const days = Math.floor(remaining / DAY_MS)
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS)
  return `${days}d${String(hours).padStart(2, '0')}h`
}

/**
 * Relative age of a quota snapshot, e.g. `刚刚` / `3 分钟前` / `2 小时前`.
 * Returns null past 24 hours so the caller can fall back to an absolute date.
 */
export function formatQuotaUpdatedAgo(fetchedAt: number | undefined, now: number, locale: string): string | null {
  if (!fetchedAt || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
    return null
  }
  const zh = locale.startsWith('zh')
  const elapsed = now - fetchedAt
  if (elapsed < 0 || elapsed < MINUTE_MS) {
    return zh ? '刚刚' : 'just now'
  }
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS)
    return zh ? `${minutes} 分钟前` : `${minutes}m ago`
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS)
    return zh ? `${hours} 小时前` : `${hours}h ago`
  }
  return null
}

/**
 * Compact period label for the shared-pool period rows, where the vendor pool
 * title already carries the model name and the row only needs its window.
 */
export function formatQuotaPeriodShortLabel(window: AccountQuotaWindow, tool: AccountTool, locale: string): string {
  const zh = locale.startsWith('zh')
  if (window.period === 'weekly') {
    return zh ? '周' : '7d'
  }
  if (window.period === 'five-hour') {
    return zh ? '5 小时' : '5h'
  }
  return formatQuotaPeriodLabel(window, tool, locale)
}

/** Keep model quotas separate from subscription usage periods. */
export function formatQuotaWindowLabel(window: AccountQuotaWindow, tool: AccountTool, locale: string): string {
  if (tool === 'antigravity') {
    if (!window.period) return window.label
    return `${window.modelLabel ?? window.label} · ${formatQuotaPeriodLabel(window, tool, locale)}`
  }
  return formatQuotaPeriodLabel(window, tool, locale)
}
