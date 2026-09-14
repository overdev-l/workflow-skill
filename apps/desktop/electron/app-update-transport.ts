/**
 * Trace App Updates Transport Layer (OPC-53)
 *
 * Implements production electron-updater bridge and isolated development simulator.
 *
 * Key Invariants:
 * - Production autoUpdater configures autoDownload=false and autoInstallOnAppQuit=false
 *   to guarantee parent main process control over unsaved/recording/account guards.
 * - Production check feed is configured solely via electron-builder app-update.yml;
 *   no secrets or hardcoded URLs exist in source code.
 * - Development simulator uses deterministic synthetic next version with timer progress;
 *   no external network requests or process exit on install.
 * - Clean timer cancellation on unsubscribe or transport disposal.
 */

import { createRequire } from 'node:module'
import type {
  AppUpdateProgressInfo,
  AppUpdateTransport,
  AppUpdateTransportEvents,
  AppUpdateVersionInfo,
} from '../../../packages/workflow-model/src/updates.ts'

export interface ElectronUpdateTransportOptions {
  autoUpdater?: any
  electronUpdater?: any
}

/**
 * Production Electron Update Transport backed by electron-updater.
 *
 * Uses CommonJS-compatible lazy import to prevent premature dependency resolution
 * during unit testing or non-Electron execution.
 */
export function createElectronUpdateTransport(options: ElectronUpdateTransportOptions = {}): AppUpdateTransport {
  let updater = options.autoUpdater
  if (!updater) {
    const req = createRequire(import.meta.url)
    const pkg = options.electronUpdater || req('electron-updater')
    updater = pkg.autoUpdater || pkg.default?.autoUpdater || pkg
  }

  // Enforce controlled update invariants
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = true
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.disableDifferentialDownload = false

  const cleanupFns: Array<() => void> = []

  return {
    subscribe(events: AppUpdateTransportEvents): () => void {
      const onChecking = () => {
        try {
          events.checking?.()
        } catch {
          // Guard against subscriber exceptions
        }
      }

      const onAvailable = (info: any) => {
        try {
          const version = String(info?.version ?? '').trim()
          events.available?.({ version })
        } catch {
          // Guard against subscriber exceptions
        }
      }

      const onNotAvailable = () => {
        try {
          events.notAvailable?.()
        } catch {
          // Guard against subscriber exceptions
        }
      }

      const onProgress = (info: any) => {
        try {
          const progress: AppUpdateProgressInfo = {
            percent: typeof info?.percent === 'number' ? info.percent : 0,
            transferred: typeof info?.transferred === 'number' ? info.transferred : undefined,
            total: typeof info?.total === 'number' ? info.total : undefined,
            bytesPerSecond: typeof info?.bytesPerSecond === 'number' ? info.bytesPerSecond : undefined,
          }
          events.progress?.(progress)
        } catch {
          // Guard against subscriber exceptions
        }
      }

      const onDownloaded = (info: any) => {
        try {
          const version = String(info?.version ?? '').trim()
          events.downloaded?.({ version })
        } catch {
          // Guard against subscriber exceptions
        }
      }

      const onError = (err: any) => {
        try {
          const errorInstance = err instanceof Error ? err : new Error(String(err ?? 'Update transport error'))
          events.error?.(errorInstance)
        } catch {
          // Guard against subscriber exceptions
        }
      }

      updater.on('checking-for-update', onChecking)
      updater.on('update-available', onAvailable)
      updater.on('update-not-available', onNotAvailable)
      updater.on('download-progress', onProgress)
      updater.on('update-downloaded', onDownloaded)
      updater.on('error', onError)

      const unsubscribe = () => {
        updater.removeListener('checking-for-update', onChecking)
        updater.removeListener('update-available', onAvailable)
        updater.removeListener('update-not-available', onNotAvailable)
        updater.removeListener('download-progress', onProgress)
        updater.removeListener('update-downloaded', onDownloaded)
        updater.removeListener('error', onError)
      }

      cleanupFns.push(unsubscribe)
      return unsubscribe
    },

    async checkForUpdates(): Promise<void> {
      await updater.checkForUpdates()
    },

    async downloadUpdate(): Promise<void> {
      await updater.downloadUpdate()
    },

    quitAndInstall(): void {
      // BaseUpdater reports some synchronous failures through an event rather than a throw.
      let failure: Error | undefined
      const captureFailure = (error: Error) => { failure = error }
      updater.on('error', captureFailure)
      try {
        updater.quitAndInstall(false, true)
        if (failure) throw failure
      } finally { updater.removeListener('error', captureFailure) }
    },

    dispose(): void {
      while (cleanupFns.length > 0) {
        const cleanup = cleanupFns.pop()
        try {
          cleanup?.()
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  }
}

// =========================================================================
// Development & Local Test Simulator
// =========================================================================

export interface DevelopmentUpdateTransportOptions {
  currentVersion: string
  targetVersion?: string
  checkDelayMilliseconds?: number
  progressIntervalMilliseconds?: number
  progressSteps?: number
}

/**
 * Computes a deterministic next semver string for simulation.
 * e.g. 1.0.0 -> 1.0.1, 0.2.14 -> 0.2.15, v2.0.0 -> 2.0.1
 */
export function computeDeterministicNextVersion(currentVersion: string): string {
  const trimmed = currentVersion.trim().replace(/^v/, '')
  const semverMatch = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(trimmed)
  if (semverMatch) {
    const major = Number(semverMatch[1])
    const minor = Number(semverMatch[2])
    const patch = Number(semverMatch[3])
    return `${major}.${minor}.${patch + 1}`
  }

  const numberMatch = /^(\d+)(.*)$/.exec(trimmed)
  if (numberMatch) {
    return `${Number(numberMatch[1]) + 1}.0.0`
  }

  return `${trimmed || '1.0.0'}-next.1`
}

export interface DevelopmentUpdateTransport extends AppUpdateTransport {
  isInstalled(): boolean
  getActiveTimersCount(): number
}

/**
 * Development simulator update transport.
 *
 * Operates entirely offline with synthetic versions and timer-based download progress.
 * Never executes external network calls or process exit.
 */
export function createDevelopmentUpdateTransport(
  options: DevelopmentUpdateTransportOptions,
): DevelopmentUpdateTransport {
  const currentVersion = options.currentVersion
  const targetVersion = options.targetVersion ?? computeDeterministicNextVersion(currentVersion)
  const checkDelayMs = Math.max(1, options.checkDelayMilliseconds ?? 30)
  const progressIntervalMs = Math.max(1, options.progressIntervalMilliseconds ?? 25)
  const totalSteps = Math.max(1, options.progressSteps ?? 4)

  const activeTimers = new Set<NodeJS.Timeout>()
  const pendingResolves = new Set<() => void>()
  const subscribers = new Set<AppUpdateTransportEvents>()
  let installed = false
  let isDisposed = false

  const clearTimer = (timer: NodeJS.Timeout) => {
    clearTimeout(timer)
    clearInterval(timer)
    activeTimers.delete(timer)
  }

  return {
    subscribe(events: AppUpdateTransportEvents): () => void {
      if (isDisposed) {
        return () => {}
      }
      subscribers.add(events)
      return () => {
        subscribers.delete(events)
      }
    },

    async checkForUpdates(): Promise<void> {
      if (isDisposed) {
        return
      }

      for (const sub of subscribers) {
        sub.checking?.()
      }

      return new Promise<void>((settle) => {
        const resolve = () => { pendingResolves.delete(resolve); settle() }
        pendingResolves.add(resolve)
        const timer = setTimeout(() => {
          activeTimers.delete(timer)
          if (!isDisposed) {
            for (const sub of subscribers) {
              sub.available?.({ version: targetVersion })
            }
          }
          resolve()
        }, checkDelayMs)

        activeTimers.add(timer)
      })
    },

    async downloadUpdate(): Promise<void> {
      if (isDisposed) {
        return
      }

      const totalBytes = 50 * 1024 * 1024 // 50 MB synthetic bundle
      let currentStep = 0

      return new Promise<void>((settle) => {
        const resolve = () => { pendingResolves.delete(resolve); settle() }
        pendingResolves.add(resolve)
        const timer = setInterval(() => {
          if (isDisposed) {
            clearTimer(timer)
            resolve()
            return
          }

          currentStep++
          const percent = Math.min(100, Math.round((currentStep / totalSteps) * 100))
          const transferred = Math.round((percent / 100) * totalBytes)

          for (const sub of subscribers) {
            sub.progress?.({
              percent,
              transferred,
              total: totalBytes,
              bytesPerSecond: 10 * 1024 * 1024,
            })
          }

          if (currentStep >= totalSteps) {
            clearTimer(timer)
            if (!isDisposed) {
              for (const sub of subscribers) {
                sub.downloaded?.({ version: targetVersion })
              }
            }
            resolve()
          }
        }, progressIntervalMs)

        activeTimers.add(timer)
      })
    },

    quitAndInstall(): void {
      if (isDisposed) {
        return
      }
      installed = true
      // Intentionally do NOT call process.exit() in development/test simulation
    },

    dispose(): void {
      isDisposed = true
      for (const timer of Array.from(activeTimers)) {
        clearTimer(timer)
      }
      activeTimers.clear()
      for (const resolve of pendingResolves) resolve()
      pendingResolves.clear()
      subscribers.clear()
    },

    isInstalled(): boolean {
      return installed
    },

    getActiveTimersCount(): number {
      return activeTimers.size
    },
  }
}
