/**
 * Trace App Updates Pure Service Layer (OPC-53)
 *
 * Implements update lifecycle orchestration, immediate deduplication locks,
 * immutable state tracking, safe error sanitization, and timer scheduling.
 *
 * Key Invariants:
 * - Concurrent checks and downloads are deduplicated via immediate promise locks.
 * - 'downloaded' state is preserved against late checking/notAvailable events and cannot be wiped.
 * - Callbacks after dispose are completely ignored.
 * - State snapshots are immutable and clone-isolated.
 * - Failed install remains retryable without losing downloaded state.
 * - Transport autoInstallOnAppQuit is avoided so parent main controls shutdown guards.
 */

import {
  AppUpdateError,
  clampByteSize,
  clampProgressPercent,
  cloneUpdateState,
  UPDATE_ERROR_ALREADY_INSTALLING,
  UPDATE_ERROR_CHECK_FAILED,
  UPDATE_ERROR_BUSY_CHECKING,
  UPDATE_ERROR_DISABLED,
  UPDATE_ERROR_DOWNLOAD_FAILED,
  UPDATE_ERROR_INSTALL_FAILED,
  UPDATE_ERROR_NO_UPDATE_AVAILABLE,
  type AppUpdateAPI,
  type AppUpdateProgressInfo,
  type AppUpdateState,
  type AppUpdateTransport,
  type AppUpdateVersionInfo,
} from '../../../packages/workflow-model/src/updates.ts'

export const DEFAULT_INITIAL_CHECK_DELAY_MS = 3000 // 3 seconds post-launch
export const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

export interface AppUpdateServiceOptions {
  currentVersion: string
  enabled?: boolean
  transport: AppUpdateTransport
  onStateChanged?: (state: AppUpdateState) => void
  simulated?: boolean
  initialCheckDelayMilliseconds?: number
  checkIntervalMilliseconds?: number
}

export class AppUpdateService {
  private readonly options: AppUpdateServiceOptions
  private readonly currentVersion: string
  private readonly enabled: boolean
  private readonly simulated: boolean
  private readonly initialCheckDelayMs: number
  private readonly checkIntervalMs: number
  private readonly transport: AppUpdateTransport
  private readonly listeners = new Set<(state: AppUpdateState) => void>()

  private currentState: AppUpdateState
  private checkPromise: Promise<AppUpdateState> | null = null
  private downloadPromise: Promise<AppUpdateState> | null = null
  private unsubscribeTransport: (() => void) | null = null
  private initialCheckTimer: NodeJS.Timeout | null = null
  private checkIntervalTimer: NodeJS.Timeout | null = null

  private started = false
  private disposed = false
  private isInstalling = false

  constructor(options: AppUpdateServiceOptions) {
    this.options = options
    this.currentVersion = options.currentVersion.trim()
    this.enabled = options.enabled !== false
    this.simulated = Boolean(options.simulated)
    this.transport = options.transport

    this.initialCheckDelayMs = Math.max(0, options.initialCheckDelayMilliseconds ?? DEFAULT_INITIAL_CHECK_DELAY_MS)
    this.checkIntervalMs = Math.max(10, options.checkIntervalMilliseconds ?? DEFAULT_CHECK_INTERVAL_MS)

    if (!this.enabled) {
      this.currentState = {
        status: 'disabled',
        currentVersion: this.currentVersion,
        ...(this.simulated ? { simulated: true } : {}),
      }
    } else {
      this.currentState = {
        status: 'idle',
        currentVersion: this.currentVersion,
        ...(this.simulated ? { simulated: true } : {}),
      }
    }

    if (options.onStateChanged) {
      this.listeners.add(options.onStateChanged)
    }
  }

  /**
   * Returns an immutable snapshot of the current update state.
   */
  state(): AppUpdateState {
    return cloneUpdateState(this.currentState)
  }

  /**
   * Starts the update service, subscribing to transport events and optionally
   * scheduling automatic background checks. Idempotent.
   */
  start(options: { automatic?: boolean } = {}): void {
    if (this.started || this.disposed) {
      return
    }
    this.started = true

    this.unsubscribeTransport = this.transport.subscribe({
      checking: () => this.handleTransportChecking(),
      available: (info) => this.handleTransportAvailable(info),
      notAvailable: () => this.handleTransportNotAvailable(),
      progress: (info) => this.handleTransportProgress(info),
      downloaded: (info) => this.handleTransportDownloaded(info),
      error: (err) => this.handleTransportError(err),
    })

    const automatic = options.automatic !== false
    if (this.enabled && automatic) {
      this.scheduleAutomaticChecks()
    }
  }

  /**
   * Triggers an update check. Deduplicates concurrent check calls.
   */
  async checkForUpdates(): Promise<AppUpdateState> {
    if (this.disposed) {
      throw new AppUpdateError('更新服务已销毁。')
    }
    if (!this.enabled) {
      throw new AppUpdateError(UPDATE_ERROR_DISABLED)
    }

    // Preserve downloaded state; never reset an installer ready for install
    if (this.currentState.status === 'downloaded') {
      return this.state()
    }

    // Do not interrupt an in-progress download
    if (this.currentState.status === 'downloading') {
      return this.state()
    }

    // Deduplicate concurrent check calls
    if (this.checkPromise) {
      return this.checkPromise
    }

    let resolveOperation!: (state: AppUpdateState) => void
    const operation = new Promise<AppUpdateState>(resolve => { resolveOperation = resolve })
    this.checkPromise = operation
    void (async () => {
      try {
        this.updateState({
          status: 'checking',
          error: undefined,
        })

        await this.transport.checkForUpdates()

        // If transport finishes without emitting available/notAvailable, treat as up to date
        if (this.currentState.status === 'checking') {
          this.updateState({
            status: 'upToDate',
            availableVersion: undefined,
            error: undefined,
          })
        }
      } catch (err) {
        if (this.currentState.status !== 'downloaded') {
          this.updateState({
            status: 'error',
            error: UPDATE_ERROR_CHECK_FAILED,
          })
        }
      } finally {
        this.checkPromise = null
      }

      return this.state()
    })().then(resolveOperation)

    return operation
  }

  /**
   * Initiates download of an available update. Deduplicates concurrent download calls.
   * Supports retry on error if availableVersion is known.
   */
  async downloadUpdate(): Promise<AppUpdateState> {
    if (this.disposed) {
      throw new AppUpdateError('更新服务已销毁。')
    }
    if (!this.enabled) {
      throw new AppUpdateError(UPDATE_ERROR_DISABLED)
    }

    // Already downloaded
    if (this.currentState.status === 'downloaded') {
      return this.state()
    }

    // Deduplicate concurrent download calls
    if (this.downloadPromise) {
      return this.downloadPromise
    }

    if (this.checkPromise) throw new AppUpdateError(UPDATE_ERROR_BUSY_CHECKING)

    const targetVersion = this.currentState.availableVersion
    if (!targetVersion) {
      throw new AppUpdateError(UPDATE_ERROR_NO_UPDATE_AVAILABLE)
    }

    let resolveOperation!: (state: AppUpdateState) => void
    const operation = new Promise<AppUpdateState>(resolve => { resolveOperation = resolve })
    this.downloadPromise = operation
    void (async () => {
      try {
        this.updateState({
          status: 'downloading',
          availableVersion: targetVersion,
          percent: 0,
          transferred: undefined,
          total: undefined,
          bytesPerSecond: undefined,
          error: undefined,
        })

        await this.transport.downloadUpdate()
      } catch (err) {
        // Invariant: A download reject after downloaded event should NOT erase success
        if (this.currentState.status !== 'downloaded') {
          this.updateState({
            status: 'error',
            availableVersion: targetVersion, // preserve for retry
            percent: undefined,
            transferred: undefined,
            total: undefined,
            bytesPerSecond: undefined,
            error: UPDATE_ERROR_DOWNLOAD_FAILED,
          })
        }
      } finally {
        this.downloadPromise = null
      }

      return this.state()
    })().then(resolveOperation)

    return operation
  }

  /**
   * Synchronously validates that an update is downloaded and executes quitAndInstall on transport.
   * Throws safe domain error if update is not ready.
   * On failure, isInstalling lock is released so it remains retryable.
   */
  installUpdate(): AppUpdateState {
    if (this.disposed) {
      throw new AppUpdateError('更新服务已销毁。')
    }
    if (!this.enabled) {
      throw new AppUpdateError(UPDATE_ERROR_DISABLED)
    }
    if (this.isInstalling) {
      throw new AppUpdateError(UPDATE_ERROR_ALREADY_INSTALLING)
    }
    if (this.currentState.status !== 'downloaded') {
      throw new AppUpdateError(UPDATE_ERROR_INSTALL_FAILED)
    }

    this.updateState({ error: undefined })
    this.isInstalling = true
    try {
      this.transport.quitAndInstall()
      return this.state()
    } catch (err) {
      this.isInstalling = false
      if (err instanceof AppUpdateError) {
        throw err
      }
      throw new AppUpdateError(UPDATE_ERROR_INSTALL_FAILED)
    }
  }

  /**
   * Registers a state change listener. Returns unsubscribe function.
   */
  onStateChanged(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Creates an AppUpdateAPI instance wired to this service.
   */
  toAPI(): AppUpdateAPI {
    return {
      getState: async () => this.state(),
      check: async () => this.checkForUpdates(),
      download: async () => this.downloadUpdate(),
      install: async () => this.installUpdate(),
      onChanged: (listener: (state: AppUpdateState) => void) => this.onStateChanged(listener),
    }
  }

  /**
   * Disposes timers, unsubscribes transport listeners, and ignores further callbacks. Idempotent.
   */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true

    this.clearTimers()

    if (this.unsubscribeTransport) {
      try {
        this.unsubscribeTransport()
      } catch {
        // Ignore unsubscribe errors
      }
      this.unsubscribeTransport = null
    }

    try {
      this.transport.dispose?.()
    } catch {
      // Ignore transport disposal errors
    }

    this.listeners.clear()
  }

  // =========================================================================
  // Private Helpers & Transport Event Handlers
  // =========================================================================

  private updateState(partial: Partial<AppUpdateState>): void {
    if (this.disposed) {
      return
    }

    this.currentState = cloneUpdateState({
      ...this.currentState,
      ...partial,
      currentVersion: this.currentVersion,
      ...(this.simulated ? { simulated: true } : {}),
    })

    const snapshot = this.state()
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot)
      } catch {
        // Guard against listener exceptions
      }
    }
  }

  private handleTransportChecking(): void {
    if (this.disposed || !this.enabled) return
    if (this.currentState.status === 'downloaded' || this.currentState.status === 'downloading') {
      return
    }
    this.updateState({
      status: 'checking',
      error: undefined,
    })
  }

  private handleTransportAvailable(info: AppUpdateVersionInfo): void {
    if (this.disposed || !this.enabled) return
    if (this.currentState.status === 'downloaded' || this.currentState.status === 'downloading') {
      return
    }
    const version = (info?.version ?? '').trim()
    this.updateState({
      status: 'available',
      availableVersion: version || this.currentState.availableVersion,
      percent: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    })
  }

  private handleTransportNotAvailable(): void {
    if (this.disposed || !this.enabled) return
    if (this.currentState.status === 'downloaded' || this.currentState.status === 'downloading') {
      return
    }
    this.updateState({
      status: 'upToDate',
      availableVersion: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    })
  }

  private handleTransportProgress(info: AppUpdateProgressInfo): void {
    if (this.disposed || !this.enabled) return
    if (this.currentState.status === 'downloaded') {
      return
    }
    this.updateState({
      status: 'downloading',
      percent: clampProgressPercent(info?.percent),
      transferred: clampByteSize(info?.transferred),
      total: clampByteSize(info?.total),
      bytesPerSecond: clampByteSize(info?.bytesPerSecond),
      error: undefined,
    })
  }

  private handleTransportDownloaded(info: AppUpdateVersionInfo): void {
    if (this.disposed || !this.enabled) return
    const version = (info?.version ?? '').trim()
    this.updateState({
      status: 'downloaded',
      availableVersion: version || this.currentState.availableVersion,
      percent: 100,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    })
  }

  private handleTransportError(err: Error): void {
    if (this.disposed || !this.enabled) return
    // An install failure must unlock retry; unrelated late download errors cannot reset readiness.
    if (this.currentState.status === 'downloaded') {
      if (this.isInstalling) {
        this.isInstalling = false
        this.updateState({ error: UPDATE_ERROR_INSTALL_FAILED })
      }
      return
    }

    const isDownloading = this.currentState.status === 'downloading'
    this.updateState({
      status: 'error',
      error: isDownloading ? UPDATE_ERROR_DOWNLOAD_FAILED : UPDATE_ERROR_CHECK_FAILED,
      availableVersion: this.currentState.availableVersion, // preserve for download retry
      percent: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
    })
  }

  private scheduleAutomaticChecks(): void {
    this.clearTimers()

    this.initialCheckTimer = setTimeout(async () => {
      if (this.disposed || !this.enabled) return
      try {
        await this.checkForUpdates()
      } catch {
        // Safe no-op on periodic error to avoid tight loop
      }

      if (this.disposed || !this.enabled) return
      this.checkIntervalTimer = setInterval(async () => {
        if (this.disposed || !this.enabled) return
        try {
          await this.checkForUpdates()
        } catch {
          // Safe no-op on periodic error to avoid tight loop
        }
      }, this.checkIntervalMs)
      this.checkIntervalTimer.unref?.()
    }, this.initialCheckDelayMs)
    this.initialCheckTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer)
      this.initialCheckTimer = null
    }
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer)
      this.checkIntervalTimer = null
    }
  }
}
