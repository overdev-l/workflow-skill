import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ProfileManager } from '../apps/desktop/electron/profile-manager.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-profile-faults-'))
const slots = ['.claude/settings.json', '.claude.json', '.codex/auth.json', '.codex/config.toml']
let caseNumber = 0
const fixture = async () => {
  const homeDir = path.join(root, String(++caseNumber))
  mkdirSync(homeDir)
  let secret = 'fixture-A'
  let throwAfterWrite = false
  const keychainAdapter = {
    isSupported: true,
    async readSecret(service, account = 'fixture-account') {
      return secret === null ? null : { service, account, secret }
    },
    async writeSecret(_service, _account, value) {
      secret = value
      if (throwAfterWrite) { throwAfterWrite = false; throw new Error('Injected writeback failure') }
    },
    async deleteSecret() { secret = null; return true },
  }
  const manager = new ProfileManager({ homeDir, keychainAdapter, claudeKeychainAccount: 'fixture-account' })
  const putState = state => {
    secret = `fixture-${state}`
    for (const relative of slots) {
      const target = path.join(homeDir, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      const content = relative.endsWith('.toml')
        ? `# ${state}\nmodel = "fixture-${state}"\n[mcp_servers.demo]\ncommand = "node"\n`
        : relative === '.claude.json'
          ? JSON.stringify({ projects: { untouched: true }, mcpServers: { demo: { command: `fixture-${state}` } } }, null, 3)
          : JSON.stringify({ fixture: state }, null, 3)
      writeFileSync(target, content, { mode: 0o640 })
    }
  }
  putState('A')
  const profile = await manager.captureCurrentProfile({ name: 'Fixture A' })
  putState('B')
  const before = slots.map(relative => ({ relative, bytes: readFileSync(path.join(homeDir, relative)), mode: statSync(path.join(homeDir, relative)).mode & 0o777 }))
  const assertRestored = () => {
    assert.equal(secret, 'fixture-B')
    for (const file of before) {
      assert.deepEqual(readFileSync(path.join(homeDir, file.relative)), file.bytes, file.relative)
      assert.equal(statSync(path.join(homeDir, file.relative)).mode & 0o777, file.mode, file.relative)
    }
  }
  return { homeDir, manager, profile, assertRestored, mutateThenThrow: () => throwAfterWrite = true, setSecret: value => secret = value, getSecret: () => secret }
}

try {
  for (const relative of ['.claude/settings.json', '.codex/auth.json']) {
    const c = await fixture()
    c.manager.setFailureHooks({ failAfterFileWrite: target => target.endsWith(relative) })
    const result = await c.manager.switchProfile(c.profile.id)
    assert.equal(result.success, false)
    assert.equal(result.recoveryNeeded, false, result.error)
    c.assertRestored()
    console.log(`PASS failed write compensation: ${relative}`)
  }
  {
    const c = await fixture()
    c.mutateThenThrow()
    const result = await c.manager.switchProfile(c.profile.id)
    assert.equal(result.success, false)
    assert.equal(result.recoveryNeeded, false, result.error)
    c.assertRestored()
    console.log('PASS Keychain mutation followed by error restores prior secret')
  }
  {
    const c = await fixture()
    c.manager.setFailureHooks({ failAfterFileWrite: () => true, failDuringRollback: true })
    const result = await c.manager.switchProfile(c.profile.id)
    assert.equal(result.success, false)
    assert.equal(result.recoveryNeeded, true)
    assert.equal((await c.manager.getRecoveryStatus()).isRecoveryNeeded, true)
    await assert.rejects(() => c.manager.switchProfile(c.profile.id))
    c.manager.setFailureHooks({})
    assert.equal((await c.manager.performEmergencyRecovery()).success, true)
    c.assertRestored()
    console.log('PASS failed compensation retains recovery and restores from durable backup')
  }
  {
    const c = await fixture()
    assert.equal((await c.manager.switchProfile(c.profile.id)).success, true)
    c.setSecret('fixture-refreshed-externally')
    await assert.rejects(() => c.manager.rollbackLastSwitch(), /Rollback conflict/)
    assert.equal(c.getSecret(), 'fixture-refreshed-externally')
    console.log('PASS rollback rejects externally refreshed credentials')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
