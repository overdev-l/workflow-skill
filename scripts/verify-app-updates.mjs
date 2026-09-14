/**
 * Verification Script for Trace App Updates (OPC-53)
 *
 * Runs comprehensive unit tests for pure service logic, transport invariants,
 * and edge cases using Node strip types (plain JS in .mjs, importing .ts).
 *
 * Test Suites:
 * 1. Normal flow: check -> available -> download -> downloaded -> install
 * 2. Automatic scheduling seam: initial delay -> interval timer -> dispose cleanup
 * 3. Immediate deduplication locks: concurrent check & download
 * 4. Download retry for known available version after failure
 * 5. Downloaded state preserved against late events, checks, and timers
 * 6. Failed install handling and retryability (isInstalling released on failure)
 * 7. Late callbacks and idempotency after service disposal
 * 8. Finite progress and byte size clamping
 * 9. Safe error sanitization without leaking sensitive URLs/tokens
 * 10. Disabled service state guards
 * 11. Download reject after downloaded event preservation
 * 12. Development simulator transport synthetic next version & timer progress
 * 13. AppUpdateAPI bridge wiring and onChanged listener notifications
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-app-updates.mjs
 */

import assert from 'node:assert/strict'
import { AppUpdateService } from '../apps/desktop/electron/app-update-service.ts'
import {
  computeDeterministicNextVersion,
  createDevelopmentUpdateTransport,
} from '../apps/desktop/electron/app-update-transport.ts'
import {
  AppUpdateError,
  clampByteSize,
  clampProgressPercent,
  UPDATE_ERROR_ALREADY_INSTALLING,
  UPDATE_ERROR_CHECK_FAILED,
  UPDATE_ERROR_DISABLED,
  UPDATE_ERROR_DOWNLOAD_FAILED,
  UPDATE_ERROR_INSTALL_FAILED,
  UPDATE_ERROR_NO_UPDATE_AVAILABLE,
} from '../packages/workflow-model/src/updates.ts'

let passed = 0
let failed = 0

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeTransport() {
  let events = {}
  let checkCalls = 0
  let downloadCalls = 0
  let installCalls = 0
  let installShouldThrow = false
  let checkDeferred = null
  let downloadDeferred = null
  let disposed = false

  return {
    get checkCalls() {
      return checkCalls
    },
    get downloadCalls() {
      return downloadCalls
    },
    get installCalls() {
      return installCalls
    },
    set installShouldThrow(val) {
      installShouldThrow = val
    },
    get isDisposed() {
      return disposed
    },

    emitChecking() {
      events.checking?.()
    },
    emitAvailable(version) {
      events.available?.({ version })
    },
    emitNotAvailable() {
      events.notAvailable?.()
    },
    emitProgress(info) {
      events.progress?.(info)
    },
    emitDownloaded(version) {
      events.downloaded?.({ version })
    },
    emitError(err) {
      events.error?.(err)
    },

    setCheckDeferred(deferred) {
      checkDeferred = deferred
    },
    setDownloadDeferred(deferred) {
      downloadDeferred = deferred
    },

    subscribe(subscribedEvents) {
      events = subscribedEvents
      return () => {
        events = {}
      }
    },

    async checkForUpdates() {
      checkCalls++
      if (checkDeferred) {
        await checkDeferred.promise
      }
    },

    async downloadUpdate() {
      downloadCalls++
      if (downloadDeferred) {
        await downloadDeferred.promise
      }
    },

    quitAndInstall() {
      installCalls++
      if (installShouldThrow) {
        throw new Error('Simulated installer launch failure')
      }
    },

    dispose() {
      disposed = true
      events = {}
    },
  }
}

async function runTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(err)
    throw err
  }
}

console.log('=== Trace App Updates Verification (OPC-53) ===\n')

// 1. Normal Flow
await runTest('Normal Flow: check -> available -> download -> downloaded -> install', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
    enabled: true,
  })

  assert.equal(service.state().status, 'idle')
  assert.equal(service.state().currentVersion, '1.0.0')

  service.start({ automatic: false })

  // Trigger check
  const checkPromise = service.checkForUpdates()
  transport.emitChecking()
  assert.equal(service.state().status, 'checking')

  transport.emitAvailable('1.1.0')
  const checkResult = await checkPromise
  assert.equal(checkResult.status, 'available')
  assert.equal(checkResult.availableVersion, '1.1.0')

  // Trigger download
  const downloadPromise = service.downloadUpdate()
  assert.equal(service.state().status, 'downloading')
  assert.equal(service.state().percent, 0)

  transport.emitProgress({ percent: 50, transferred: 5000, total: 10000, bytesPerSecond: 2500 })
  assert.equal(service.state().percent, 50)
  assert.equal(service.state().transferred, 5000)
  assert.equal(service.state().total, 10000)
  assert.equal(service.state().bytesPerSecond, 2500)

  transport.emitDownloaded('1.1.0')
  const downloadResult = await downloadPromise
  assert.equal(downloadResult.status, 'downloaded')
  assert.equal(downloadResult.percent, 100)

  // Install
  assert.equal(transport.installCalls, 0)
  const installResult = service.installUpdate()
  assert.equal(transport.installCalls, 1)
  assert.equal(installResult.status, 'downloaded')

  service.dispose()
})

// 2. Automatic Schedule Seam
await runTest('Automatic Schedule Seam: initial delay -> periodic interval -> clean dispose', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
    initialCheckDelayMilliseconds: 25,
    checkIntervalMilliseconds: 50,
  })

  service.start({ automatic: true })
  assert.equal(transport.checkCalls, 0)

  // Wait for initial check delay
  await new Promise((r) => setTimeout(r, 45))
  assert.ok(transport.checkCalls >= 1, `Expected at least 1 check call, got ${transport.checkCalls}`)

  // Wait for periodic check interval
  await new Promise((r) => setTimeout(r, 70))
  assert.ok(transport.checkCalls >= 2, `Expected at least 2 check calls, got ${transport.checkCalls}`)

  const callsBeforeDispose = transport.checkCalls
  service.dispose()

  // Ensure no further checks run after dispose
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(transport.checkCalls, callsBeforeDispose)
})

// 3. Immediate Deduplication Locks
await runTest('Immediate Deduplication Locks: concurrent check & download requests', async () => {
  const transport = createFakeTransport()
  const checkDef = createDeferred()
  transport.setCheckDeferred(checkDef)

  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  // Trigger concurrent checks
  const p1 = service.checkForUpdates()
  const p2 = service.checkForUpdates()
  assert.equal(transport.checkCalls, 1)

  transport.emitAvailable('2.0.0')
  checkDef.resolve()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(transport.checkCalls, 1)
  assert.equal(r1.status, 'available')
  assert.equal(r2.status, 'available')

  // Trigger concurrent downloads
  const downloadDef = createDeferred()
  transport.setDownloadDeferred(downloadDef)

  const d1 = service.downloadUpdate()
  const d2 = service.downloadUpdate()
  assert.equal(transport.downloadCalls, 1)

  transport.emitDownloaded('2.0.0')
  downloadDef.resolve()
  const [dr1, dr2] = await Promise.all([d1, d2])
  assert.equal(transport.downloadCalls, 1)
  assert.equal(dr1.status, 'downloaded')
  assert.equal(dr2.status, 'downloaded')

  service.dispose()
})

// 4. Retry on Error for Known Available Version
await runTest('Download Retry: preserves availableVersion on error and succeeds on second attempt', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  // Discover update
  const checkPromise = service.checkForUpdates()
  transport.emitAvailable('1.5.0')
  await checkPromise

  // First download attempt fails
  const downloadDef1 = createDeferred()
  transport.setDownloadDeferred(downloadDef1)
  const d1 = service.downloadUpdate()

  transport.emitError(new Error('Network connection timeout'))
  downloadDef1.reject(new Error('Network connection timeout'))

  const errState = await d1
  assert.equal(errState.status, 'error')
  assert.equal(errState.error, UPDATE_ERROR_DOWNLOAD_FAILED)
  assert.equal(errState.availableVersion, '1.5.0') // Preserved for retry

  // Second download attempt succeeds
  const downloadDef2 = createDeferred()
  transport.setDownloadDeferred(downloadDef2)
  const d2 = service.downloadUpdate()

  transport.emitDownloaded('1.5.0')
  downloadDef2.resolve()

  const successState = await d2
  assert.equal(successState.status, 'downloaded')
  assert.equal(successState.availableVersion, '1.5.0')

  service.dispose()
})

// 5. Downloaded State Preserved Against Late Events & Timers
await runTest('Downloaded State Preserved: immune to late transport events or subsequent checks', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  // Get to downloaded state
  const checkPromise = service.checkForUpdates()
  transport.emitAvailable('1.2.0')
  await checkPromise

  const downloadPromise = service.downloadUpdate()
  transport.emitDownloaded('1.2.0')
  await downloadPromise

  assert.equal(service.state().status, 'downloaded')
  const callsBefore = transport.checkCalls

  // Late events from transport must be ignored
  transport.emitChecking()
  assert.equal(service.state().status, 'downloaded')

  transport.emitNotAvailable()
  assert.equal(service.state().status, 'downloaded')

  transport.emitAvailable('1.3.0')
  assert.equal(service.state().status, 'downloaded')
  assert.equal(service.state().availableVersion, '1.2.0')

  transport.emitProgress({ percent: 10 })
  assert.equal(service.state().status, 'downloaded')

  transport.emitError(new Error('Late network error'))
  assert.equal(service.state().status, 'downloaded')

  // Check or download calls return downloaded state without triggering transport
  const cState = await service.checkForUpdates()
  assert.equal(cState.status, 'downloaded')
  assert.equal(transport.checkCalls, callsBefore)

  const dState = await service.downloadUpdate()
  assert.equal(dState.status, 'downloaded')
  assert.equal(transport.downloadCalls, 1)

  service.dispose()
})

// 6. Failed Install Handling & Retryability
await runTest('Failed Install: rejects with safe error, keeps downloaded state, and remains retryable', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  // Install without download throws
  assert.throws(
    () => service.installUpdate(),
    (err) => err instanceof AppUpdateError && err.message === UPDATE_ERROR_INSTALL_FAILED,
  )

  // Download update
  const cp = service.checkForUpdates()
  transport.emitAvailable('1.0.1')
  await cp

  const dp = service.downloadUpdate()
  transport.emitDownloaded('1.0.1')
  await dp

  // Simulate failure on install
  transport.installShouldThrow = true
  assert.throws(
    () => service.installUpdate(),
    (err) => err instanceof AppUpdateError && err.message === UPDATE_ERROR_INSTALL_FAILED,
  )

  // Invariant: state remains downloaded and retryable
  assert.equal(service.state().status, 'downloaded')

  // Next install attempt succeeds when transport is ready
  transport.installShouldThrow = false
  const state = service.installUpdate()
  assert.equal(state.status, 'downloaded')
  assert.equal(transport.installCalls, 2)

  service.dispose()
})

// 7. Late Callbacks and Idempotency After Service Disposal
await runTest('Disposal Invariants: ignore late callbacks and idempotent start/dispose', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })

  service.start({ automatic: false })
  service.start({ automatic: false }) // Idempotent start

  service.dispose()
  service.dispose() // Idempotent dispose
  assert.ok(transport.isDisposed)

  // Events after disposal must be ignored
  transport.emitAvailable('9.9.9')
  transport.emitProgress({ percent: 50 })
  transport.emitDownloaded('9.9.9')
  transport.emitError(new Error('Ignored error'))

  assert.equal(service.state().status, 'idle')

  // Operations after disposal throw
  await assert.rejects(
    async () => service.checkForUpdates(),
    (err) => err instanceof AppUpdateError,
  )
  await assert.rejects(
    async () => service.downloadUpdate(),
    (err) => err instanceof AppUpdateError,
  )
  assert.throws(
    () => service.installUpdate(),
    (err) => err instanceof AppUpdateError,
  )
})

// 8. Finite Clamping of Progress and Byte Sizes
await runTest('Finite Clamping: handles negative, NaN, Infinity, and out-of-range progress values', async () => {
  assert.equal(clampProgressPercent(-10), 0)
  assert.equal(clampProgressPercent(150), 100)
  assert.equal(clampProgressPercent(NaN), 0)
  assert.equal(clampProgressPercent(Infinity), 0)
  assert.equal(clampProgressPercent(45.6789), 45.68)

  assert.equal(clampByteSize(-500), undefined)
  assert.equal(clampByteSize(NaN), undefined)
  assert.equal(clampByteSize(Infinity), undefined)
  assert.equal(clampByteSize(1048576.8), 1048576)

  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  const cp = service.checkForUpdates()
  transport.emitAvailable('1.0.2')
  await cp

  const dp = service.downloadUpdate()
  transport.emitProgress({ percent: -5, transferred: -100, total: Infinity, bytesPerSecond: NaN })

  assert.equal(service.state().percent, 0)
  assert.equal(service.state().transferred, undefined)
  assert.equal(service.state().total, undefined)
  assert.equal(service.state().bytesPerSecond, undefined)

  transport.emitProgress({ percent: 120, transferred: 5000.7, total: 10000, bytesPerSecond: 1000 })
  assert.equal(service.state().percent, 100)
  assert.equal(service.state().transferred, 5000)
  assert.equal(service.state().total, 10000)
  assert.equal(service.state().bytesPerSecond, 1000)

  transport.emitDownloaded('1.0.2')
  await dp
  service.dispose()
})

// 9. Safe Error Messages Without Secret/URL Leakage
await runTest('Safe Error Messages: never leak raw network URLs or authentication tokens', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  // Check error
  const cp = service.checkForUpdates()
  transport.emitError(new Error('Failed to fetch from https://token:secret123@api.internal.com/update.zip'))
  const state = await cp

  assert.equal(state.status, 'error')
  assert.equal(state.error, UPDATE_ERROR_CHECK_FAILED)
  assert.ok(!state.error.includes('https://'))
  assert.ok(!state.error.includes('secret123'))
  assert.ok(!state.error.includes('api.internal.com'))

  service.dispose()
})

// 10. Disabled Service State Guards
await runTest('Disabled Service: state is disabled and all operations throw domain errors', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
    enabled: false,
    initialCheckDelayMilliseconds: 10,
    checkIntervalMilliseconds: 20,
  })

  assert.equal(service.state().status, 'disabled')

  service.start({ automatic: true })

  // Timers should not be scheduled
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(transport.checkCalls, 0)

  await assert.rejects(
    async () => service.checkForUpdates(),
    (err) => err instanceof AppUpdateError && err.message === UPDATE_ERROR_DISABLED,
  )

  await assert.rejects(
    async () => service.downloadUpdate(),
    (err) => err instanceof AppUpdateError && err.message === UPDATE_ERROR_DISABLED,
  )

  assert.throws(
    () => service.installUpdate(),
    (err) => err instanceof AppUpdateError && err.message === UPDATE_ERROR_DISABLED,
  )

  service.dispose()
})

// 11. Download Reject After Downloaded Event
await runTest('Download Reject After Downloaded Event: does not erase success status', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  const cp = service.checkForUpdates()
  transport.emitAvailable('1.0.5')
  await cp

  const downloadDef = createDeferred()
  transport.setDownloadDeferred(downloadDef)
  const dp = service.downloadUpdate()

  // Transport emits downloaded event first...
  transport.emitDownloaded('1.0.5')
  assert.equal(service.state().status, 'downloaded')

  // ...then the transport download promise subsequently rejects
  downloadDef.reject(new Error('Post-download stream cleanup error'))

  const result = await dp
  assert.equal(result.status, 'downloaded')
  assert.equal(service.state().status, 'downloaded')

  service.dispose()
})

// 12. Development Simulator Transport
await runTest('Development Simulator Transport: deterministic next version and timer progress', async () => {
  assert.equal(computeDeterministicNextVersion('1.0.0'), '1.0.1')
  assert.equal(computeDeterministicNextVersion('0.2.14'), '0.2.15')
  assert.equal(computeDeterministicNextVersion('v2.5.9'), '2.5.10')

  const devTransport = createDevelopmentUpdateTransport({
    currentVersion: '1.2.3',
    checkDelayMilliseconds: 15,
    progressIntervalMilliseconds: 15,
    progressSteps: 3,
  })

  const service = new AppUpdateService({
    currentVersion: '1.2.3',
    transport: devTransport,
    simulated: true,
  })

  assert.equal(service.state().simulated, true)
  service.start({ automatic: false })

  const checkState = await service.checkForUpdates()
  assert.equal(checkState.status, 'available')
  assert.equal(checkState.availableVersion, '1.2.4')
  assert.equal(checkState.simulated, true)

  const downloadState = await service.downloadUpdate()
  assert.equal(downloadState.status, 'downloaded')
  assert.equal(downloadState.percent, 100)
  assert.equal(downloadState.simulated, true)

  assert.equal(devTransport.isInstalled(), false)
  service.installUpdate()
  assert.equal(devTransport.isInstalled(), true)

  service.dispose()
  assert.equal(devTransport.getActiveTimersCount(), 0)
})

// 13. AppUpdateAPI Bridge Wiring and onChanged Notifications
await runTest('AppUpdateAPI Bridge: getState, check, download, install, and onChanged listener', async () => {
  const transport = createFakeTransport()
  const service = new AppUpdateService({
    currentVersion: '1.0.0',
    transport,
  })
  service.start({ automatic: false })

  const api = service.toAPI()
  const capturedStatuses = []
  const unsubscribe = api.onChanged((state) => {
    capturedStatuses.push(state.status)
  })

  const initialState = await api.getState()
  assert.equal(initialState.status, 'idle')

  const checkPromise = api.check()
  transport.emitAvailable('1.0.8')
  await checkPromise

  const downloadPromise = api.download()
  transport.emitDownloaded('1.0.8')
  await downloadPromise

  const installState = await api.install()
  assert.equal(installState.status, 'downloaded')

  unsubscribe()
  assert.ok(capturedStatuses.includes('checking'))
  assert.ok(capturedStatuses.includes('available'))
  assert.ok(capturedStatuses.includes('downloading'))
  assert.ok(capturedStatuses.includes('downloaded'))

  service.dispose()
})

console.log(`\nVerification complete: ${passed} passed, ${failed} failed.`)
