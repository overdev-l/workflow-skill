import type { AccountQuotaWindow } from '@workflow-skill/workflow-model/accounts'

export interface AccountQuotaModelGroup {
  id: string
  label: string
  windows: AccountQuotaWindow[]
}

const WEEKLY_WINDOW_SUFFIX = ':weekly'

// The quota API also returns internal aliases and legacy variants. Keep the
// account card aligned with the models users can actually select in Antigravity.
const SUPPORTED_ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High' },
  { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash Medium' },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash Medium' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro Low' },
  { id: 'claude-sonnet-4.6-thinking', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4.6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
] as const

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
    return candidates.some((candidate) => candidate === normalizedLabel || candidate === normalizedId)
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
      const samePeriod = window.period
        ? existing.group.windows.findIndex((item) => item.period === window.period)
        : -1
      if (samePeriod >= 0) {
        const current = existing.group.windows[samePeriod]
        if (current.remainingPercent === undefined && window.remainingPercent !== undefined) {
          existing.group.windows[samePeriod] = window
        }
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
