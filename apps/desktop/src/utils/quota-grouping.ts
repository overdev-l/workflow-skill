import type { AccountQuotaWindow } from '@workflow-skill/workflow-model/accounts'

export interface AccountQuotaModelGroup {
  id: string
  label: string
  windows: AccountQuotaWindow[]
}

const WEEKLY_WINDOW_SUFFIX = ':weekly'

// The quota API also returns internal aliases and legacy variants. Keep the
// account card aligned with the models users can actually select in Antigravity.
type SupportedAntigravityModel = {
  id: string
  label: string
  aliases: readonly string[]
}

const SUPPORTED_ANTIGRAVITY_MODELS: readonly SupportedAntigravityModel[] = [
  {
    id: 'gemini-3.8-flash-high',
    label: 'Gemini 3.8 Flash High',
    aliases: ['gemini-3.8-flash-tiered'],
  },
  {
    id: 'gemini-3.7-flash-medium',
    label: 'Gemini 3.7 Flash Medium',
    aliases: ['gemini-3.7-flash-tiered'],
  },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash Medium', aliases: [] },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro Low', aliases: [] },
  { id: 'claude-sonnet-4.6-thinking', label: 'Claude Sonnet 4.6 (Thinking)', aliases: [] },
  { id: 'claude-opus-4.6-thinking', label: 'Claude Opus 4.6 (Thinking)', aliases: [] },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', aliases: [] },
]

function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[‐‑–—_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function visibleModelForWindow(window: AccountQuotaWindow): (typeof SUPPORTED_ANTIGRAVITY_MODELS)[number] | undefined {
  const candidates = [window.modelLabel, window.label, window.id]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeModelName)

  return SUPPORTED_ANTIGRAVITY_MODELS.find((model) => {
    const normalizedLabel = normalizeModelName(model.label)
    const normalizedId = normalizeModelName(model.id)
    const normalizedAliases = model.aliases.map(normalizeModelName)
    return candidates.some((candidate) =>
      candidate === normalizedLabel ||
      candidate === normalizedId ||
      normalizedAliases.includes(candidate)
    )
  })
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
