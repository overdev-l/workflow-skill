import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import asar from '@electron/asar'

const platform = process.argv[2] || (process.platform === 'darwin' ? 'mac' : 'win')
assert.ok(['mac', 'win'].includes(platform), 'Unsupported package target')
const resources = platform === 'mac'
  ? 'dist/desktop/mac-arm64/Trace.app/Contents/Resources'
  : 'dist/desktop/win-unpacked/resources'
const archive = path.join(resources, 'app.asar')
const files = asar.listPackage(archive)
const forbidden = files.filter(file => /\.map$|\.log$|\/\.turbo(?:\/|$)|\/node_modules\/@workflow-skill\//.test(file))
assert.equal(forbidden.length, 0, 'Package contains source maps, private workspace sources, or build logs')
for (const file of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.cjs']) {
  assert.ok(asar.extractFile(archive, file).length, 'Required application entry missing')
}
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString())
assert.equal(metadata.traceUpdatesEnabled, process.env.TRACE_RELEASE === '1', 'Incorrect update enablement for build channel')
assert.ok(files.includes('/node_modules/electron-updater/package.json'), 'Updater runtime dependency missing')
assert.ok(fs.statSync(path.join(resources, 'recorders', platform === 'mac' ? 'workflow-recorder-macos' : 'WorkflowRecorder.exe')).isFile(), 'Native recorder missing')
if (platform === 'mac') assert.ok(fs.statSync(path.join(resources, 'native-bin/trace-account-keychain')).isFile(), 'Keychain helper missing')
console.log(`Packaged ${platform} runtime, update channel, and source exclusions: passed`)
