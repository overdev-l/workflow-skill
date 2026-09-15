import type { AccountQuotaWindow, AccountTool } from '@workflow-skill/workflow-model/accounts'

/** Keep model quotas separate from subscription usage periods. */
export function formatQuotaWindowLabel(window: AccountQuotaWindow, tool: AccountTool, locale: string): string {
  const zh = locale.startsWith('zh')
  if (tool === 'antigravity') {
    if (!window.period) return window.label
    const periodLabel = window.period === 'weekly'
      ? (zh ? '周额度' : 'Weekly quota')
      : (zh ? '5 小时额度' : '5-hour quota')
    return `${window.modelLabel ?? window.label} · ${periodLabel}`
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
