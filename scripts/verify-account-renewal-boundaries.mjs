/** Independent regression checks for renewal suppression, races and HTTP bounds. All credentials and requests are synthetic. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { ANTIGRAVITY_CLIENT_ID } from '../apps/desktop/electron/account-oauth-providers.ts'
import { executeBoundedTokenRequest, NetworkError } from '../apps/desktop/electron/account-refresh.ts'

const baseNow = Date.now()
const credential = (grant = 'a', id = 'user-a', expiresAt = baseNow + 60_000) => JSON.stringify({
  auth_method: 'consumer', oauth_client_id: ANTIGRAVITY_CLIENT_ID,
  token: { access_token: `synthetic-access-${grant}`, refresh_token: `synthetic-refresh-${grant}`, token_type: 'Bearer', expiry: new Date(expiresAt).toISOString() },
  account: { id, email: `${id}@example.invalid` },
})
const success = () => Response.json({ access_token: 'synthetic-renewed-access', expires_in: 3600, token_type: 'Bearer', refresh_token: 'synthetic-rotated-refresh' })
async function fixture(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'trace-renewal-boundary-'))
  const managers = []
  const make = (options = {}) => {
    const manager = new AccountManager({ homeDir: home, env: {}, adapters: createAccountAdapters({ homeDir: home, env: {}, antigravityFileMode: true }), ...options })
    managers.push(manager)
    return manager
  }
  try { await run(make) } finally { managers.forEach(m => m.dispose()); rmSync(home, { recursive: true, force: true }) }
}

await fixture(async make => {
  let calls = 0
  const m = make({ refreshFetch: async () => { calls++; return Response.json({ error: 'invalid_grant', error_description: 'synthetic-secret-not-for-ui' }, { status: 400 }) } })
  const a = await m.importAccount({ tool: 'antigravity', name: 'Personal', credential: credential() })
  await m.ensureFreshCredential(a.id, { force: true })
  await m.ensureFreshCredential(a.id, { force: true })
  assert.equal(calls, 1, 'forced retries must respect revoked-grant suppression')
  assert.equal(JSON.stringify(await m.getOverview()).includes('synthetic-secret'), false)
  await m.saveAuthenticatedAccount({ tool: 'antigravity', credential: credential('b') })
  await m.refreshDueAccounts()
  assert.equal(calls, 2, 'scheduler must notice replacement grant after reauthentication')
  await m.saveAuthenticatedAccount({ tool: 'antigravity', credential: credential('long-lived-new-grant', 'user-a', baseNow + 3_600_000) })
  assert.equal((await m.getOverview()).refreshes.some(state => state.accountId === a.id && state.status === 'reauth-required'), false, 'successful reauthentication clears obsolete UI failure even when new token is not due')
})
console.log('✓ Revocation suppression, safe UI metadata and scheduler recovery after reauthentication')

await fixture(async make => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const m = make({ refreshFetch: async () => { started(); await pending; return success() } })
  const a = await m.importAccount({ tool: 'antigravity', name: 'Deleted', credential: credential() })
  const renewing = m.ensureFreshCredential(a.id)
  await began
  await m.deleteAccount(a.id)
  release()
  await renewing
  assert.equal((await m.store.list()).length, 0, 'in-flight renewal must not resurrect a deleted account')
})
console.log('✓ Deleting an account during renewal cannot resurrect it')

await fixture(async make => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const m = make({ refreshFetch: async () => { started(); await pending; return success() } })
  const a = await m.importAccount({ tool: 'antigravity', name: 'Custom name', credential: credential() })
  const renewing = m.ensureFreshCredential(a.id)
  await began
  await m.saveAuthenticatedAccount({ tool: 'antigravity', credential: credential('reauth') })
  const fresh = (await m.store.get(a.id)).credential
  release()
  await renewing
  assert.equal((await m.store.get(a.id)).credential, fresh, 'old renewal response must not overwrite reauthentication')
  assert.equal((await m.store.get(a.id)).metadata.name, 'Custom name')
})
console.log('✓ Reauthentication wins over an older in-flight successful refresh')

let timeoutAborted = false
await assert.rejects(executeBoundedTokenRequest('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: {}, body: '', httpTimeoutMs: 20,
  fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { timeoutAborted = true; reject(new Error('synthetic fetch abort')) }, { once: true })
  }),
}), NetworkError)
assert.equal(timeoutAborted, true)
console.log('✓ Token request timeout aborts the underlying HTTP request')

await assert.rejects(executeBoundedTokenRequest('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: {}, body: '', httpTimeoutMs: 20,
  fetchFn: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"synthetic-partial"}')) } })),
}), NetworkError, 'a cancelled, unfinished body must not be accepted even if its prefix is valid JSON')
console.log('✓ A timed-out body cannot become a successful token response')

await fixture(async make => {
  let calls = 0
  const m = make({ refreshFetch: async () => { calls++; return success() } })
  const jwt = claims => 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.synthetic'
  const account = await m.importAccount({ tool: 'codex', name: 'Custom OAuth source', credential: JSON.stringify({
    auth_mode: 'chatgpt', client_id: 'synthetic-unknown-client',
    tokens: { account_id: 'workspace-a', id_token: jwt({ sub: 'person-a' }), access_token: jwt({ sub: 'person-a', exp: Math.floor((baseNow + 60_000) / 1000) }), refresh_token: 'synthetic-custom-grant' },
  }) })
  const state = await m.ensureFreshCredential(account.id)
  assert.equal(calls, 0, 'import normalization must not erase an explicitly unknown OAuth client')
  assert.equal(state.reason, 'unknown-client')
})
console.log('✓ Unknown OAuth client association survives import and prevents token requests')

await fixture(async make => {
  let calls = 0
  const m = make({ refreshFetch: async () => { calls++; return success() } })
  const a = await m.importAccount({ tool: 'antigravity', name: 'Recover manifest write', credential: credential() })
  const previous = (await m.store.get(a.id)).credential
  m.store.updateCredential = async () => { throw new Error('Synthetic disk write failure') }
  assert.equal((await m.ensureFreshCredential(a.id)).reason, 'storage')
  const pending = path.join(m.traceHome, 'pending-sync', `${a.id}.json`)
  assert.equal(existsSync(pending), true, 'a manifest failure must preserve the new rotating grant in the recovery record')
  assert.equal(statSync(pending).mode & 0o777, 0o600)
  assert.equal((await m.store.get(a.id)).credential, previous)
  m.dispose()
  const restarted = make({ refreshFetch: async () => { throw new Error('Recovery must not make a token request') } })
  assert.equal((await restarted.ensureFreshCredential(a.id)).status, 'ready')
  assert.equal(JSON.parse((await restarted.store.get(a.id)).credential).token.refresh_token, 'synthetic-rotated-refresh')
  assert.equal(calls, 1)
  assert.equal(existsSync(pending), false)
})
console.log('✓ Manifest write failure retains rotating grant; restart restores it without another token request')

for (const corruption of ['symlink', 'invalid-json']) {
  await fixture(async make => {
    let calls = 0
    const m = make({ refreshFetch: async () => { calls++; return success() } })
    const a = await m.importAccount({ tool: 'antigravity', name: 'Journal boundary', credential: credential() })
    const journalDir = path.join(m.traceHome, 'pending-sync')
    if (corruption === 'symlink') {
      const other = path.join(m.homeDir, 'other-directory')
      mkdirSync(other)
      symlinkSync(other, journalDir)
    } else {
      mkdirSync(journalDir)
      writeFileSync(path.join(journalDir, `${a.id}.json`), '{"version":1,"synthetic-secret":')
    }
    assert.equal((await m.ensureFreshCredential(a.id)).reason, 'storage')
    assert.equal(calls, 0, 'unsafe recovery storage must block before any token request')
    await assert.rejects(m.getOverview())
  })
}
console.log('✓ Symlink and corrupted renewal journals fail closed before network or native writes')

for (const obstruction of ['write-failure', 'foreign-native-change']) {
  await fixture(async make => {
    let m, calls = 0
    let failWrites = false
    const foreign = credential('foreign', 'user-other', baseNow + 3_600_000)
    m = make({ refreshFetch: async () => {
      calls++
      if (obstruction === 'foreign-native-change') m.adapters.antigravity.writeSlot('oauth', m.adapters.antigravity.desired(foreign).oauth)
      else failWrites = true
      return success()
    } })
    const adapter = m.adapters.antigravity
    const nativeBefore = adapter.desired(credential())
    adapter.writeSlot('oauth', nativeBefore.oauth)
    const writeSlot = adapter.writeSlot.bind(adapter)
    adapter.writeSlot = (...args) => { if (failWrites) throw new Error('Synthetic native write failure'); return writeSlot(...args) }
    const a = await m.importAccount({ tool: 'antigravity', name: 'Native recovery', credential: credential() })
    const state = await m.ensureFreshCredential(a.id)
    assert.equal(state.status, 'blocked')
    assert.equal(JSON.parse((await m.store.get(a.id)).credential).token.refresh_token, 'synthetic-rotated-refresh')
    const nativeAfter = adapter.read().oauth
    assert.equal(nativeAfter, obstruction === 'write-failure' ? nativeBefore.oauth : adapter.desired(foreign).oauth)
    m.dispose()
    const restarted = make({ refreshFetch: async () => { throw new Error('Recovery must not rotate again') } })
    const recovered = await restarted.ensureFreshCredential(a.id)
    if (obstruction === 'write-failure') {
      assert.equal(recovered.status, 'ready')
      assert.equal(JSON.parse(restarted.adapters.antigravity.read().oauth).token.refresh_token, 'synthetic-rotated-refresh')
    } else {
      assert.equal(recovered.reason, 'credential-conflict')
      assert.equal(restarted.adapters.antigravity.read().oauth, nativeAfter)
    }
    assert.equal(calls, 1)
  })
}
console.log('✓ Native write failure recovers forward after restart; external native changes are never overwritten')

await fixture(async make => {
  let count = 0, began
  const started = new Promise(resolve => { began = resolve })
  const m = make({ refreshFetch: async (_url, options) => {
    if (++count === 3) began()
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Synthetic cancellation')), { once: true }))
  } })
  const accounts = []
  for (let i = 0; i < 6; i++) accounts.push(await m.importAccount({ tool: 'antigravity', name: `Queue ${i}`, credential: credential(`queue-${i}`, `user-${i}`) }))
  const requests = accounts.map(a => m.ensureFreshCredential(a.id))
  await started
  m.dispose()
  let timer
  try { await Promise.race([Promise.all(requests), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Disposal left queued renewals unresolved')), 1000) })]) } finally { clearTimeout(timer) }
  assert.equal(count, 3, 'disposed queued requests must never enter the network')
})
console.log('✓ Disposal resolves queued renewals and aborts all three active requests')
