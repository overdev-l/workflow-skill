import {
  type AccountQuotaWindow,
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
}

const WEEKLY_WINDOW_SUFFIX = ':weekly'

function visibleModelForWindow(window: AccountQuotaWindow): SupportedAntigravityModel | undefined {
  return (
    matchSupportedAntigravityModel(window.modelLabel) ||
    matchSupportedAntigravityModel(window.label) ||
    matchSupportedAntigravityModel(window.id)
  )
}

function modelIdForWindow(window: AccountQuotaWindow): string {
  return window.id.endsWith(WEEKLY_WINDOW_SUFFIX)
    ? window.id.slice(0, -WEEKLY_WINDOW_SUFFIX.length)
    : window.id
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

/** Groups only the visible Antigravity models so one model owns all of its periods. */
export function groupAntigravityQuotaWindows(windows: AccountQuotaWindow[]): AccountQuotaModelGroup[] {
  if (!Array.isArray(windows)) return []

  const groups = new Map<string, { order: number; group: AccountQuotaModelGroup }>()
  for (const window of windows) {
    const visibleModel = visibleModelForWindow(window)
    if (!visibleModel) continue

    const order = SUPPORTED_ANTIGRAVITY_MODELS.indexOf(visibleModel)
    const existing = groups.get(visibleModel.id)
    if (existing) {
      if (existing.group.id !== visibleModel.id && modelIdForWindow(window) === visibleModel.id) {
        existing.group.id = visibleModel.id
      }
      const samePeriod = window.period
        ? existing.group.windows.findIndex((item) => item.period === window.period)
        : -1
      if (samePeriod >= 0) {
        const current = existing.group.windows[samePeriod]
        existing.group.windows[samePeriod] = mergeQuotaWindows(current, window)
      } else {
        existing.group.windows.push(window)
      }
      continue
    }
    groups.set(visibleModel.id, {
      order,
      group: { id: modelIdForWindow(window), label: visibleModel.label, windows: [window] },
    })
  }

  return Array.from(groups.values())
    .sort((a, b) => a.order - b.order)
    .map(({ group }) => ({
      ...group,
      windows: [...group.windows].sort((a, b) => periodOrder(a) - periodOrder(b)),
    }))
}
