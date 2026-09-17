import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import { AccountError, cleanAccountErrorMessage } from '../packages/workflow-model/src/accounts.ts'

const home = mkdtempSync(path.join(os.tmpdir(), 'trace-switch-lifecycle-'))
const credential = (id, email) => JSON.stringify({
  auth_method: 'consumer',
  token: { access_token: `synthetic-${id}`, refresh_token: `refresh-${id}`, token_type: 'Bearer', expiry: new Date(Date.now() + 3600_000).toISOString() },
  ...(email ? { account: { id: `id-${id}`, email } } : {}),
})
const wrap = raw => `go-keyring-base64:${Buffer.from(raw).toString('base64')}`
const original = wrap(credential('original'))
let current = original, inSwitch = false, cancel = false, warn = false, failWrite = false
let writes = 0, lifecycleCalls = 0
let clientSessionIdentity = 'target-user@gmail.com'
const adapters = createAccountAdapters({ homeDir: home, env: {},
  antigravityKeychain: { available: () => true, read: () => current, write(value) {
    assert.equal(inSwitch, true, 'Every interactive native write must be inside lifecycle')
    if (failWrite) throw new AccountError('Synthetic write failure')
    writes++; current = value
  } },
  antigravityAssertStopped() { assert.equal(inSwitch, true) },
  antigravityClientIdentity: 'target-user@gmail.com',
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
  const account = await manager.importAccount({ tool: 'antigravity', name: 'Target', credential: credential('target', 'target-user@gmail.com') })
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

// Desktop client session identity mismatch and honest activeAccountId reporting
{
  const home2 = mkdtempSync(path.join(os.tmpdir(), 'trace-switch-mismatch-'))
  const credWithAccount = (id, email) => JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: `synthetic-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expiry: new Date(Date.now() + 3600_000).toISOString(),
    },
    account: { id: `id-${id}`, email },
  })
  const originalWithAccount = wrap(credWithAccount('original', 'old-client-user@gmail.com'))
  let activeCli = originalWithAccount
  let clientSessionIdentity = 'old-client-user@gmail.com'

  const testAdapters = createAccountAdapters({
    homeDir: home2,
    env: {},
    antigravityKeychain: {
      available: () => true,
      read: () => activeCli,
      write: val => { activeCli = val },
    },
    antigravityAssertStopped: () => {},
    antigravityClientIdentity: clientSessionIdentity,
    async antigravityWithInteractiveSwitch(operation, context) {
      const result = await operation()
      if (!result.success) return result
      // Simulate client identity probe after restart
      if (context?.expectedIdentity && context.expectedIdentity !== clientSessionIdentity) {
        // Post-restart mismatch: trigger rollback
        if (context.rollback) await context.rollback()
        return {
          success: false,
          mismatch: true,
          error: `Antigravity 客户端未切换至目标账号（当前仍为 ${clientSessionIdentity}），已自动回滚。`,
        }
      }
      return result
    },
  })

  const mgr2 = new AccountManager({ homeDir: home2, adapters: testAdapters })

  try {
    const origAcc = await mgr2.importAccount({
      tool: 'antigravity',
      name: 'Original',
      credential: credWithAccount('original', 'old-client-user@gmail.com'),
    })
    const targetAcc = await mgr2.importAccount({
      tool: 'antigravity',
      name: 'Target',
      credential: credWithAccount('target', 'target-user@gmail.com'),
    })

    // Initially: activeCli matches origAcc, and clientSessionIdentity matches origAcc
    const overview1 = await mgr2.getOverview()
    const agy1 = overview1.tools.find(t => t.tool === 'antigravity')
    assert.equal(agy1.activeAccountId, origAcc.id, 'Original account is active when both CLI and client match')

    // Now test client session mismatch: clientSessionIdentity becomes mismatched
    testAdapters.antigravity.getClientIdentity = () => 'completely-different@gmail.com'
    const overviewMismatch = await mgr2.getOverview()
    const agyMismatch = overviewMismatch.tools.find(t => t.tool === 'antigravity')
    assert.equal(agyMismatch.activeAccountId, undefined, 'Must not claim target or original active when client identity is in conflict')
    assert.equal(agyMismatch.activeIdentity, 'completely-different@gmail.com')
    assert.match(agyMismatch.error, /不一致/)

    // Restore client identity to match origAcc
    testAdapters.antigravity.getClientIdentity = () => 'old-client-user@gmail.com'

    // Attempt to switch to target, but client restart fails to switch session (remains old-client-user@gmail.com)
    const switchRes = await mgr2.switchAccount(targetAcc.id)
    assert.equal(switchRes.success, false, 'Switch must report failure when client session fails to update')
    assert.equal(switchRes.mismatch, true, 'Switch result must indicate mismatch')
    assert.match(switchRes.error, /未切换至目标账号/)

    // Verify rollback left the original account intact and target was NOT made active
    const overviewAfter = await mgr2.getOverview()
    const agyAfter = overviewAfter.tools.find(t => t.tool === 'antigravity')
    assert.equal(agyAfter.activeAccountId, origAcc.id, 'Rollback restored original active account')
    assert.notEqual(agyAfter.activeAccountId, targetAcc.id, 'Target account must NEVER be marked active on mismatch')

    // Now simulate client successfully switching to target
    clientSessionIdentity = 'target-user@gmail.com'
    testAdapters.antigravity.getClientIdentity = () => 'target-user@gmail.com'
    const switchSuccess = await mgr2.switchAccount(targetAcc.id)
    assert.equal(switchSuccess.success, true, 'Switch must succeed when client session assumes target identity')

    const overviewSuccess = await mgr2.getOverview()
    const agySuccess = overviewSuccess.tools.find(t => t.tool === 'antigravity')
    assert.equal(agySuccess.activeAccountId, targetAcc.id, 'Target account is now active')
    assert.equal(agySuccess.activeIdentity, 'target-user@gmail.com')

    // Synthetic case: matched Antigravity credential has null/unknown client identity
    testAdapters.antigravity.getClientIdentity = () => null
    const overviewNullIdentity = await mgr2.getOverview()
    const agyNullIdentity = overviewNullIdentity.tools.find(t => t.tool === 'antigravity')
    assert.equal(agyNullIdentity.activeAccountId, undefined, 'Must not claim active account when client identity is null/unknown')
    assert.equal(agyNullIdentity.activeIdentity, undefined, 'Displayed identity must remain unset/clearly unverified')
    assert.match(agyNullIdentity.error, /登录身份未验证/)
    assert.match(agyNullIdentity.error, /请启动客户端并登录，或重试切换/)

    // Also test empty string client identity
    testAdapters.antigravity.getClientIdentity = () => '   '
    const overviewEmptyIdentity = await mgr2.getOverview()
    const agyEmptyIdentity = overviewEmptyIdentity.tools.find(t => t.tool === 'antigravity')
    assert.equal(agyEmptyIdentity.activeAccountId, undefined, 'Must not claim active account when client identity is whitespace')
    assert.equal(agyEmptyIdentity.activeIdentity, undefined, 'Displayed identity must remain unset when client identity is whitespace')
    assert.match(agyEmptyIdentity.error, /登录身份未验证/)

    // Interactive switch: probe returns null / unavailable -> triggers rollback and reports failure
    let rollbackCount = 0
    let rollbackSucceeded = true
    testAdapters.antigravity.withInteractiveSwitch = async (operation, context) => {
      const result = await operation()
      if (!result.success) return result
      if (context?.rollback) {
        rollbackCount++
        try {
          if (rollbackSucceeded) {
            await context.rollback()
          } else {
            throw new AccountError('Synthetic rollback failure in lifecycle')
          }
        } catch {
          rollbackSucceeded = false
        }
      }
      return {
        success: false,
        mismatch: true,
        recoveryNeeded: !rollbackSucceeded,
        error: rollbackSucceeded
          ? '无法验证 Antigravity 客户端登录身份，已自动回滚。'
          : '无法验证 Antigravity 客户端登录身份，且自动回滚失败。',
      }
    }

    const switchNullRes = await mgr2.switchAccount(origAcc.id)
    assert.equal(switchNullRes.success, false)
    assert.equal(switchNullRes.mismatch, true)
    assert.equal(switchNullRes.recoveryNeeded, false)
    assert.equal(rollbackCount, 1)

    // Interactive switch: rollback failure -> returns recoveryNeeded: true
    rollbackSucceeded = false
    const switchRollbackFail = await mgr2.switchAccount(origAcc.id)
    assert.equal(switchRollbackFail.success, false)
    assert.equal(switchRollbackFail.recoveryNeeded, true, 'Rollback failure must report recoveryNeeded: true')
    assert.equal(rollbackCount, 2)
    assert.match(switchRollbackFail.error, /回滚失败/)

    console.log('Client session probe, honest activeAccountId, rollback on mismatch, and match success passed')
  } finally {
    rmSync(home2, { recursive: true, force: true })
  }
}

// Both client and CLI exited: switch and rollback in AccountManager
{
  const home3 = mkdtempSync(path.join(os.tmpdir(), 'trace-switch-both-stopped-'))
  let activeToken = wrap(credential('initial', 'both-stopped@gmail.com'))
  let switchCalls = 0

  const adapters3 = createAccountAdapters({
    homeDir: home3,
    env: {},
    antigravityKeychain: {
      available: () => true,
      read: () => activeToken,
      write: val => { activeToken = val },
    },
    antigravityAssertStopped: () => {},
    antigravityClientIdentity: 'target-both-stopped@gmail.com',
    async antigravityWithInteractiveSwitch(operation) {
      switchCalls++
      return await operation()
    },
  })

  const mgr3 = new AccountManager({ homeDir: home3, adapters: adapters3 })

  try {
    const acc1 = await mgr3.importAccount({
      tool: 'antigravity',
      name: 'Initial',
      credential: credential('initial', 'both-stopped@gmail.com'),
    })
    const acc2 = await mgr3.importAccount({
      tool: 'antigravity',
      name: 'Target',
      credential: credential('target', 'target-both-stopped@gmail.com'),
    })

    const switchRes = await mgr3.switchAccount(acc2.id)
    assert.equal(switchRes.success, true, 'Switch must succeed when both client and CLI are exited')
    assert.equal(switchCalls, 1)

    const rollbackRes = await mgr3.rollbackAccount('antigravity')
    assert.equal(rollbackRes.success, true, 'Rollback must succeed when both client and CLI are exited')
    assert.equal(switchCalls, 2)

    console.log('Both client and CLI exited: switch and rollback succeed cleanly')
  } finally {
    rmSync(home3, { recursive: true, force: true })
  }
}

// IPC error mapping: action call envelopes and remote method wrapper stripping
{
  const home4 = mkdtempSync(path.join(os.tmpdir(), 'trace-switch-ipc-error-'))
  let activeToken = wrap(credential('ipc-initial', 'ipc-user@gmail.com'))

  const adapters4 = createAccountAdapters({
    homeDir: home4,
    env: {},
    antigravityKeychain: {
      available: () => true,
      read: () => activeToken,
      write: val => { activeToken = val },
    },
    antigravityAssertStopped: () => {
      throw new AccountError('Antigravity 客户端仍在运行，请先完全退出客户端后再重试切换账号；现有 agy CLI 会话无需退出。')
    },
    antigravityClientIdentity: 'ipc-user@gmail.com',
  })

  const mgr4 = new AccountManager({ homeDir: home4, adapters: adapters4 })

  // Electron IPC action envelope simulation (as implemented in main.ts)
  async function accountActionCall(operation) {
    try {
      return await operation()
    } catch (error) {
      return { success: false, error: cleanAccountErrorMessage(error) }
    }
  }

  try {
    const acc = await mgr4.importAccount({
      tool: 'antigravity',
      name: 'IPC Test',
      credential: credential('ipc-test', 'ipc-test@gmail.com'),
    })

    // Simulated accounts:switch IPC handler call
    const switchActionResult = await accountActionCall(async () => {
      return await mgr4.switchAccount(acc.id)
    })

    // Result must be a structured failure object, NOT a thrown IPC exception:
    assert.equal(switchActionResult.success, false)
    assert.equal(typeof switchActionResult.error, 'string')
    assert.equal(
      switchActionResult.error,
      'Antigravity 客户端仍在运行，请先完全退出客户端后再重试切换账号；现有 agy CLI 会话无需退出。'
    )
    assert.equal(switchActionResult.error.includes('Error invoking remote method'), false)
    assert.equal(switchActionResult.error.includes('accounts:switch'), false)

    // Electron-level remote method wrapping string sanitation:
    const wrappedIpcError =
      "Error invoking remote method 'accounts:switch': Error: Antigravity 客户端仍在运行，请先完全退出客户端后再重试切换账号；现有 agy CLI 会话无需退出。"
    const stripped = cleanAccountErrorMessage(wrappedIpcError)
    assert.equal(
      stripped,
      'Antigravity 客户端仍在运行，请先完全退出客户端后再重试切换账号；现有 agy CLI 会话无需退出。'
    )
    assert.equal(stripped.includes('Error invoking remote method'), false)

    console.log('IPC error mapping: structured error envelopes and wrapper stripping passed')
  } finally {
    rmSync(home4, { recursive: true, force: true })
  }
}
