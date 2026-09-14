import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import { AccountError } from '../packages/workflow-model/src/accounts.ts'

const home = mkdtempSync(path.join(os.tmpdir(), 'trace-switch-lifecycle-'))
const credential = id => JSON.stringify({ auth_method: 'consumer', token: { access_token: `synthetic-${id}`, refresh_token: `refresh-${id}`, token_type: 'Bearer', expiry: new Date(Date.now() + 3600_000).toISOString() } })
const wrap = raw => `go-keyring-base64:${Buffer.from(raw).toString('base64')}`
const original = wrap(credential('original'))
let current = original, inSwitch = false, cancel = false, warn = false, failWrite = false
let writes = 0, lifecycleCalls = 0
const adapters = createAccountAdapters({ homeDir: home, env: {},
  antigravityKeychain: { available: () => true, read: () => current, write(value) {
    assert.equal(inSwitch, true, 'Every interactive native write must be inside lifecycle')
    if (failWrite) throw new AccountError('Synthetic write failure')
    writes++; current = value
  } },
  antigravityAssertStopped() { assert.equal(inSwitch, true) },
  async antigravityWithInteractiveSwitch(operation) {
    lifecycleCalls++
    if (cancel) throw new AccountError('Client quit cancelled')
    inSwitch = true
    try {
      const result = await operation()
      return result.success && warn ? { ...result, warning: 'Reopen the client manually' } : result
    } finally { inSwitch = false }
  },
})
const manager = new AccountManager({ homeDir: home, adapters })
try {
  const account = await manager.importAccount({ tool: 'antigravity', name: 'Target', credential: credential('target') })
  cancel = true
  await assert.rejects(manager.switchAccount(account.id), /quit cancelled/)
  assert.equal(writes, 0)
  assert.equal(current, original)
  cancel = false; warn = true
  const switched = await manager.switchAccount(account.id)
  assert.equal(switched.success, true)
  assert.match(switched.warning, /manually/)
  assert.equal((await manager.getOverview()).tools.find(t => t.tool === 'antigravity').activeAccountId, account.id)
  warn = false
  assert.equal((await manager.rollbackAccount('antigravity')).success, true)
  assert.equal(current, original, 'Rollback restores exact original bytes')
  failWrite = true
  assert.equal((await manager.switchAccount(account.id)).success, false)
  assert.equal(current, original)
  assert.equal(inSwitch, false)
  assert.equal(lifecycleCalls, 4)
  const beforeInvalid = lifecycleCalls
  await assert.rejects(manager.switchAccount('not-a-uuid'))
  assert.equal(lifecycleCalls, beforeInvalid, 'Invalid requests must not close any client')
  console.log('Interactive account lifecycle: cancellation, scoped writes, active identity, restart warning, rollback, failure, invalid input passed')
} finally { rmSync(home, { recursive: true, force: true }) }
