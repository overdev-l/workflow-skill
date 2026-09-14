/**
 * Trace App Updates Shared Protocol & Domain Types (OPC-53)
 *
 * Defines shared data structures, runtime types, and sanitization helpers
 * for desktop application updates.
 *
 * Key Invariants:
 * - Immediate state locks prevent concurrent check/download operations
 * - Downloaded state remains preserved against late check/notAvailable events
 * - Error messages never leak URLs, auth tokens, or filesystem paths
 * - Progress percentages and byte sizes are strictly clamped to finite numbers
 * - Snapshots are immutable and safe across IPC boundaries
 */

export type AppUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/**
 * Public renderer-safe snapshot representing current application update state.
 */
export interface AppUpdateState {
  status: AppUpdateStatus
  currentVersion: string
  availableVersion?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  error?: string
  simulated?: boolean
}

/**
 * Public IPC / contextBridge API contract exposed to the renderer.
 */
export interface AppUpdateAPI {
  getState(): Promise<AppUpdateState>
  check(): Promise<AppUpdateState>
  download(): Promise<AppUpdateState>
  install(): Promise<AppUpdateState>
  onChanged(listener: (state: AppUpdateState) => void): () => void
}

/**
 * Progress payload emitted during update downloads.
 */
export interface AppUpdateProgressInfo {
  percent: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

/**
 * Target version information emitted on available/downloaded events.
 */
export interface AppUpdateVersionInfo {
  version: string
}

/**
 * Callback event listeners subscribed by AppUpdateService on AppUpdateTransport.
 */
export interface AppUpdateTransportEvents {
  checking?: () => void
  available?: (info: AppUpdateVersionInfo) => void
  notAvailable?: () => void
  progress?: (info: AppUpdateProgressInfo) => void
  downloaded?: (info: AppUpdateVersionInfo) => void
  error?: (err: Error) => void
}

/**
 * Transport abstraction separating electron-updater / simulator from update service logic.
 */
export interface AppUpdateTransport {
  subscribe(events: AppUpdateTransportEvents): () => void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
  dispose?(): void
}

// =========================================================================
// Domain Errors & Sanitized Messages
// =========================================================================

export const UPDATE_ERROR_CHECK_FAILED = '检查更新失败，请检查网络连接后重试。'
export const UPDATE_ERROR_DOWNLOAD_FAILED = '下载更新失败，请检查网络连接后重试。'
export const UPDATE_ERROR_INSTALL_FAILED = '安装更新失败，更新文件尚未准备就绪。'
export const UPDATE_ERROR_DISABLED = '应用更新功能已禁用。'
export const UPDATE_ERROR_BUSY_CHECKING = '正在检查更新，请稍候。'
export const UPDATE_ERROR_BUSY_DOWNLOADING = '正在下载更新，请稍候。'
export const UPDATE_ERROR_ALREADY_INSTALLING = '更新正在安装中，请稍候。'
export const UPDATE_ERROR_NO_UPDATE_AVAILABLE = '当前没有可下载的更新。'
export const UPDATE_ERROR_GENERIC = '更新操作失败，请稍后重试。'

/**
 * Typed domain error for update operations with user-safe messages.
 */
export class AppUpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppUpdateError'
    Object.setPrototypeOf(this, AppUpdateError.prototype)
  }
}

/**
 * Returns safe error messages for renderer consumption, never leaking sensitive URLs or internals.
 */
export function sanitizeUpdateError(error: unknown, fallbackMessage: string = UPDATE_ERROR_GENERIC): string {
  if (error instanceof AppUpdateError) {
    return error.message
  }
  return fallbackMessage
}

/**
 * Clamps progress percentage to a finite float between 0 and 100 with at most 2 decimal places.
 */
export function clampProgressPercent(percent: unknown): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || Number.isNaN(percent)) {
    return 0
  }
  if (percent <= 0) return 0
  if (percent >= 100) return 100
  return Math.round(percent * 100) / 100
}

/**
 * Clamps byte counts or transfer rates to non-negative finite integers.
 */
export function clampByteSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(value) || value < 0) {
    return undefined
  }
  return Math.floor(value)
}

/**
 * Creates an immutable, prototype-clean clone of an AppUpdateState snapshot.
 */
export function cloneUpdateState(state: AppUpdateState): AppUpdateState {
  const cloned: AppUpdateState = {
    status: state.status,
    currentVersion: state.currentVersion,
  }

  if (state.availableVersion !== undefined) {
    cloned.availableVersion = state.availableVersion
  }
  if (state.percent !== undefined) {
    cloned.percent = state.percent
  }
  if (state.transferred !== undefined) {
    cloned.transferred = state.transferred
  }
  if (state.total !== undefined) {
    cloned.total = state.total
  }
  if (state.bytesPerSecond !== undefined) {
    cloned.bytesPerSecond = state.bytesPerSecond
  }
  if (state.error !== undefined) {
    cloned.error = state.error
  }
  if (state.simulated !== undefined) {
    cloned.simulated = state.simulated
  }

  return Object.freeze(cloned)
}
