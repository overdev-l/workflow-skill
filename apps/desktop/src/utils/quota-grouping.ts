import {
  type AccountQuotaWindow,
  type AntigravityModelFamily,
  type SupportedAntigravityModel,
  SUPPORTED_ANTIGRAVITY_MODELS,
  matchSupportedAntigravityModel,
  normalizeAntigravityModelName,
} from '@workflow-skill/workflow-model/accounts'

export type { SupportedAntigravityModel }
export { SUPPORTED_ANTIGRAVITY_MODELS }

export interface AccountQuotaModelGroup {
  id: string
  label: string
  windows: AccountQuotaWindow[]
  family?: AntigravityModelFamily
}

export const ANTIGRAVITY_FAMILY_ORDER: readonly AntigravityModelFamily[] = [
  'google',
  'openai',
  'claude',
]

export const ANTIGRAVITY_FAMILY_CONFIG: Record<
  AntigravityModelFamily,
  {
    id: AntigravityModelFamily
    label: string
    order: number
  }
> = {
  google: {
    id: 'google',
    label: 'Google / Gemini',
    order: 0,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI / GPT',
    order: 1,
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    order: 2,
  },
}

const WEEKLY_WINDOW_SUFFIX = ':weekly'

function visibleModelForWindow(window: AccountQuotaWindow): SupportedAntigravityModel | undefined {
  return (
    matchSupportedAntigravityModel(window.modelLabel) ||
    matchSupportedAntigravityModel(window.label) ||
    matchSupportedAntigravityModel(window.id)
  )
}

export function resolveAntigravityFamily(window: AccountQuotaWindow): AntigravityModelFamily | undefined {
  if (window.family === 'google' || window.family === 'openai' || window.family === 'claude') {
    return window.family
  }
  const visibleModel = visibleModelForWindow(window)
  if (visibleModel?.family) {
    return visibleModel.family
  }
  const text = `${window.id} ${window.label} ${window.modelLabel ?? ''}`.toLowerCase()
  if (/(?:gemini|google)/.test(text)) return 'google'
  if (/(?:claude|anthropic)/.test(text)) return 'claude'
  if (/(?:gpt|openai)/.test(text)) return 'openai'
  return undefined
}

function resolveWindowPeriod(window: AccountQuotaWindow): 'weekly' | 'five-hour' {
  if (window.period === 'weekly' || window.id.endsWith(WEEKLY_WINDOW_SUFFIX)) {
    return 'weekly'
  }
  if (window.durationSeconds === 604800) {
    return 'weekly'
  }
  return 'five-hour'
}

function periodOrder(window: AccountQuotaWindow): number {
  if (window.period === 'weekly') return 0
  if (window.period === 'five-hour') return 1
  return 2
}

export function mergeQuotaWindows(current: AccountQuotaWindow, incoming: AccountQuotaWindow): AccountQuotaWindow {
  let remainingPercent: number | undefined
  let resetsAt: number | undefined

  if (current.remainingPercent === undefined) {
    remainingPercent = incoming.remainingPercent
  } else if (incoming.remainingPercent === undefined) {
    remainingPercent = current.remainingPercent
  } else {
    // Both defined:
    // 1. A real 0% represents exhaustion and must never be replaced by a non-zero value.
    // 2. If both are non-zero, conservative lower quota takes precedence (Math.min).
    remainingPercent = Math.min(current.remainingPercent, incoming.remainingPercent)
  }

  if (remainingPercent === 0) {
    // When exhausted, prefer reset time of the exhausted window (or later reset time if both exhausted)
    if (incoming.remainingPercent === 0 && current.remainingPercent !== 0) {
      resetsAt = incoming.resetsAt ?? current.resetsAt
    } else if (current.remainingPercent === 0 && incoming.remainingPercent !== 0) {
      resetsAt = current.resetsAt ?? incoming.resetsAt
    } else {
      resetsAt = (current.resetsAt && incoming.resetsAt)
        ? Math.max(current.resetsAt, incoming.resetsAt)
        : (incoming.resetsAt ?? current.resetsAt)
    }
  } else if (
    remainingPercent !== undefined &&
    incoming.remainingPercent !== undefined &&
    incoming.remainingPercent < (current.remainingPercent ?? Infinity)
  ) {
    resetsAt = incoming.resetsAt ?? current.resetsAt
  } else {
    resetsAt = current.resetsAt ?? incoming.resetsAt
  }

  const merged: AccountQuotaWindow = {
    ...current,
  }
  if (remainingPercent !== undefined) {
    merged.remainingPercent = remainingPercent
  } else {
    delete merged.remainingPercent
  }
  if (resetsAt !== undefined) {
    merged.resetsAt = resetsAt
  } else {
    delete merged.resetsAt
  }

  return merged
}

/** Groups Antigravity model windows into the 3 shared vendor quota pools (Google / OpenAI / Claude). */
export function groupAntigravityQuotaWindows(windows: AccountQuotaWindow[]): AccountQuotaModelGroup[] {
  if (!Array.isArray(windows)) return []

  const familyWindows = new Map<AntigravityModelFamily, Map<'weekly' | 'five-hour', AccountQuotaWindow>>()

  for (const window of windows) {
    const family = resolveAntigravityFamily(window)
    if (!family) continue

    const period = resolveWindowPeriod(window)
    const config = ANTIGRAVITY_FAMILY_CONFIG[family]
    if (!config) continue

    let periodMap = familyWindows.get(family)
    if (!periodMap) {
      periodMap = new Map<'weekly' | 'five-hour', AccountQuotaWindow>()
      familyWindows.set(family, periodMap)
    }

    const normalizedWindow: AccountQuotaWindow = {
      ...window,
      id: period === 'weekly' ? `${family}:weekly` : family,
      label: config.label,
      modelLabel: config.label,
      family,
      period,
      durationSeconds: window.durationSeconds ?? (period === 'weekly' ? 604800 : 18000),
    }

    const existing = periodMap.get(period)
    if (existing) {
      periodMap.set(period, mergeQuotaWindows(existing, normalizedWindow))
    } else {
      periodMap.set(period, normalizedWindow)
    }
  }

  const result: AccountQuotaModelGroup[] = []
  for (const family of ANTIGRAVITY_FAMILY_ORDER) {
    const periodMap = familyWindows.get(family)
    if (!periodMap || periodMap.size === 0) continue

    const config = ANTIGRAVITY_FAMILY_CONFIG[family]
    const sortedWindows = Array.from(periodMap.values()).sort((a, b) => periodOrder(a) - periodOrder(b))

    result.push({
      id: config.id,
      label: config.label,
      windows: sortedWindows,
      family,
    })
  }

  return result
}
