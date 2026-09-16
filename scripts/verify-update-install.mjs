import assert from 'node:assert/strict'
import { AppUpdateInstaller } from '../apps/desktop/electron/app-update-install.ts'
import { AppUpdateService } from '../apps/desktop/electron/app-update-service.ts'
import { createDevelopmentUpdateTransport, createElectronUpdateTransport } from '../apps/desktop/electron/app-update-transport.ts'
import { EventEmitter } from 'node:events'
let reason, ready = true, prepared = 0, installed = 0, release, fail = false
const gate = new AppUpdateInstaller({
  ready: () => ready, blocker: () => reason,
  prepare: () => { prepared++; return new Promise(resolve => { release = resolve }) },
  install: () => { installed++; if (fail) throw new Error('install failed') },
})
for (const blocked of ['unsaved editor', 'recording', 'credential refresh']) {
  reason = blocked
  await assert.rejects(gate.install(), new RegExp(blocked))
}
assert.equal(prepared, 0)
reason = undefined
ready = false
await assert.rejects(gate.install())
ready = true
const first = gate.install()
assert.equal(gate.preparing, true)
assert.equal(gate.install(), first)
await Promise.resolve()
assert.equal(installed, 0)
reason = 'late editor change'
release()
await assert.rejects(first, /late editor change/)
assert.equal(gate.approved, false)
assert.equal(gate.preparing, false)
reason = undefined
fail = true
const second = gate.install()
await Promise.resolve(); release()
await assert.rejects(second, /install failed/)
assert.equal(gate.approved, false)
fail = false
const third = gate.install()
await Promise.resolve(); release(); await third
assert.equal(gate.approved, true)
assert.equal(installed, 2)

// A synchronous transport throw cannot leave the single-flight lock stuck.
let checks = 0, downloads = 0, events
const service = new AppUpdateService({ currentVersion: '1.0.0', transport: {
  subscribe: e => { events = e; return () => {} },
  checkForUpdates: () => { checks++; throw new Error('synthetic transport failure') },
  downloadUpdate: () => { downloads++; throw new Error('synthetic transport failure') },
  quitAndInstall: () => {},
}})
service.start({ automatic: false })
await service.checkForUpdates(); await service.checkForUpdates()
assert.equal(checks, 2)
events.available({ version: '1.0.1' })
await service.downloadUpdate(); await service.downloadUpdate()
assert.equal(downloads, 2)
service.dispose()

// Disposal settles pending simulator operations; it never hangs a caller.
const simulation = createDevelopmentUpdateTransport({currentVersion: '1.0.0', checkDelayMilliseconds: 10000})
const pending = simulation.checkForUpdates()
simulation.dispose()
await pending
assert.equal(simulation.getActiveTimersCount(), 0)

// Production settings and event-based install rejection match electron-updater v26.
const updater = new EventEmitter()
updater.checkForUpdates = async () => {}
updater.downloadUpdate = async () => {}
updater.quitAndInstall = () => { updater.emit('error', new Error('synthetic installer path')) }
const transport = createElectronUpdateTransport({ autoUpdater: updater })
const production = new AppUpdateService({currentVersion: '1.0.0', transport})
production.start({automatic: false})
assert.equal(updater.autoDownload, false)
assert.equal(updater.autoInstallOnAppQuit, false)
assert.equal(updater.disableDifferentialDownload, false)
updater.emit('update-downloaded', { version: '1.0.1' })
assert.throws(() => production.installUpdate(), error => !error.message.includes('synthetic installer path'))
assert.equal(production.state().status, 'downloaded')
updater.quitAndInstall = () => {}
production.installUpdate()
// Mac may asynchronously reject its native staging step.
updater.emit('error', new Error('native staging failed'))
assert.ok(production.state().error)
production.installUpdate()
production.dispose()
assert.equal(updater.listenerCount('error'), 0)
console.log('Update install guards, retries, lifecycle, and production transport: passed')
