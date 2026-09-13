import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import { antigravityProcesses } from '../apps/desktop/electron/antigravity-runtime.ts'
import { AccountError, sanitizeErrorMessage } from '../packages/workflow-model/src/accounts.ts'
const home = mkdtempSync(path.join(os.tmpdir(), 'trace-antigravity-native-'))
const credential = n => JSON.stringify({ auth_method: 'consumer', token: { access_token: `synthetic-access-${n}`, refresh_token: `synthetic-refresh-${n}`, token_type: 'Bearer', expiry: new Date(Date.now() + 3600_000).toISOString() } })
const wrap = raw => `go-keyring-base64:${Buffer.from(raw).toString('base64')}`
let raw = wrap(credential('a')), writes = [], running = false, denied = false, profileCalls = 0
const original = raw
const keychain = { available: () => true, read() { if (denied) throw new AccountError('认证访问被拒绝。'); return raw }, write(value) { if (denied) throw new AccountError('认证访问被拒绝。'); writes.push(value); raw = value } }
const adapters = createAccountAdapters({ homeDir: home, env: {}, antigravityKeychain: keychain,
  antigravityAssertStopped() { if (running) throw new AccountError('请先退出 Antigravity。') },
  antigravityIdentityFetch: async (url, options) => {
    profileCalls++
    assert.equal(url, 'https://www.googleapis.com/oauth2/v2/userinfo')
    assert.equal(options.redirect, 'error')
    assert.match(options.headers.Authorization, /^Bearer synthetic-access-/)
    return new Response(JSON.stringify({ id: 'account-a', email: 'a@example.invalid', name: 'Account A', verified_email: true }))
  },
})
const manager = new AccountManager({ homeDir: home, adapters })
try {
  const native = adapters.antigravity
  assert.equal(native.capability().available, true)
  assert.equal(native.capability().detailsCode, 'antigravity-native-keychain')
  assert.equal(native.journalKey, 'antigravity-native')
  assert.deepEqual(native.read(), { oauth: original })
  assert.equal(native.readCurrentCredential(), Buffer.from(original.split(':')[1], 'base64').toString())
  // A historical CLI file must not override the native login or be written during a switch.
  const fallback = path.join(home, '.gemini/antigravity-cli/antigravity-oauth-token')
  mkdirSync(path.dirname(fallback), { recursive: true }); writeFileSync(fallback, credential('history'))
  const fallbackBefore = readFileSync(fallback, 'utf8')
  const first = (await manager.syncCurrentAccounts()).find(r => r.tool === 'antigravity')
  assert.equal(first.status, 'imported')
  assert.equal((await manager.getOverview()).accounts[0].email, 'a@example.invalid')
  const concurrent = await Promise.all([manager.syncCurrentAccounts(), manager.syncCurrentAccounts()])
  assert.ok(concurrent.every(results => results.find(r => r.tool === 'antigravity').status === 'unchanged'))
  assert.equal(profileCalls, 1)
  await manager.renameAccount(first.accountId, 'Custom name')
  await manager.syncCurrentAccounts()
  assert.equal((await manager.store.get(first.accountId)).metadata.name, 'Custom name')
  assert.equal((await manager.getOverview()).tools.find(t => t.tool === 'antigravity').activeAccountId, first.accountId)
  assert.equal(writes.length, 0)
  const b = await manager.importAccount({ tool: 'antigravity', name: 'B', credential: credential('b') })
  // Legacy journals remain untouched and cannot be replayed into the native item.
  mkdirSync(manager.transactionsDir, { recursive: true })
  const legacyPath = path.join(manager.transactionsDir, 'antigravity.json')
  const legacy = JSON.stringify({ version: 1, tool: 'antigravity', phase: 'complete', before: { oauth: null }, after: { oauth: fallbackBefore } })
  writeFileSync(legacyPath, legacy)
  assert.equal((await manager.rollbackAccount('antigravity')).success, false)
  running = true
  await assert.rejects(manager.switchAccount(b.id), /先退出/)
  assert.equal(writes.length, 0)
  running = false
  assert.equal((await manager.switchAccount(b.id)).success, true)
  assert.equal(readFileSync(fallback, 'utf8'), fallbackBefore)
  assert.equal(readFileSync(legacyPath, 'utf8'), legacy)
  assert.ok(existsSync(path.join(manager.transactionsDir, 'antigravity-native.json')))
  assert.equal((await manager.getOverview()).tools.find(t => t.tool === 'antigravity').activeAccountId, b.id)
  assert.equal((await manager.rollbackAccount('antigravity')).success, true)
  assert.equal(raw, original, 'rollback preserves exact original wrapped bytes')
  assert.equal((await manager.switchAccount(b.id)).success, true)
  const foreign = wrap(credential('external-refresh')); raw = foreign
  assert.equal((await manager.rollbackAccount('antigravity')).success, false)
  assert.equal(raw, foreign)
  // Missing native item round-trips back to missing, not the legacy file.
  rmSync(path.join(manager.transactionsDir, 'antigravity-native.json')); raw = null
  assert.equal((await manager.switchAccount(b.id)).success, true)
  assert.equal((await manager.rollbackAccount('antigravity')).success, true)
  assert.equal(raw, null)
  raw = original
  await manager.deleteAccount(first.accountId)
  assert.equal((await manager.syncCurrentAccounts()).find(r => r.tool === 'antigravity').status, 'dismissed')
  denied = true
  assert.equal((await manager.syncCurrentAccounts()).find(r => r.tool === 'antigravity').status, 'error')
  assert.match((await manager.getOverview()).tools.find(t => t.tool === 'antigravity').error, /拒绝/)
  assert.equal(sanitizeErrorMessage(new Error('synthetic-secret')).includes('synthetic-secret'), false)
  denied = false
  assert.equal(createAccountAdapters({ homeDir: home, env: { GEMINI_API_KEY: 'synthetic' }, antigravityKeychain: keychain }).antigravity.capability().available, false)
  assert.deepEqual(antigravityProcesses('1 /bin/sh\n2 /Users/u/.local/bin/agy\n3 /Applications/Antigravity.app/Contents/Resources/bin/language_server\n4 /other/language_server\n5 /Applications/Antigravity.app/Contents/MacOS/Antigravity'), ['agy', 'language_server', 'Antigravity'])
  console.log('Antigravity native: discovery, identity cache, deduplication, active account, exact rollback, legacy isolation, missing item, process guard, denial and external conflicts passed.')
} finally { rmSync(home, { recursive: true, force: true }) }
