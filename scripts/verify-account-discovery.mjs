/**
 * Verification Script for Account Discovery & Synchronization (OPC-48)
 *
 * Runs isolated end-to-end tests for automatic account discovery/sync:
 * 1. Automatic discovery and import from tool credentials (syncCurrentAccounts)
 * 2. Unchanged credentials do not write to disk or notify change listeners
 * 3. Updated credentials replace payload and metadata atomically, invalidating quota
 * 4. Dedup by adapter identityKey with tool + workspace separation, never email alone
 * 5. Custom name and createdAt preservation across updates
 * 6. Concurrent duplicate discovery/import calls serialized without duplicate records
 * 7. Corrupted existing account in store is not swallowed into a duplicate
 * 8. Missing credentials return not-found, and per-tool errors are strictly isolated
 * 9. Known expired credential is not saved
 * 10. Existing valid credential is not replaced by older/expired token
 * 11. Delete suppression across restart prevents immediate resurrection
 * 12. Changed login breaks suppression and is discovered
 * 13. Explicit authenticated add/import clears matching suppression
 * 14. Suppression storage corruption detection and delete-abort protection
 * 15. Safe atomic update in AccountStore: generation files, pointer commit, failure preservation
 * 16. Rollback file non-interference and no official tool writes during discovery
 * 17. Adapter optional readCurrentCredential discovery independent of switch capability
 * 18. Store.list ignores private support files (.suppressions.json)
 * 19. Full saved OAuth + token-only current projection yields same active id without metadata downgrade or duplicate
 * 20. Corrupted stored credential payload with valid manifest is caught and does not create duplicate
 * 21. Full OAuth save + official raw projection delete suppresses across restart for Claude and Google; credential change breaks suppression
 * 22. getOverview: Claude .credentials.json-only matched active account (read-only), Antigravity native unsupported retains unknown, Codex conflict does not falsely mark active
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-discovery.mjs
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import { AccountStore, MAX_SUPPRESSION_FILE_SIZE } from '../apps/desktop/electron/account-store.ts'
import {
  ACCOUNT_TOOLS,
  AccountError,
  validateAccountId,
  validateAccountName,
} from '../packages/workflow-model/src/accounts.ts'

const testRoot = mkdtempSync(path.join(tmpdir(), 'verify-account-discovery-'))
let passed = 0
let failed = 0

function createCodexJwt({
  email = 'user@openai.com',
  accountId = 'chatgpt-acc-1',
  sub = 'user_123',
  exp = Math.floor(Date.now() / 1000) + 3600,
  extraClaims = {},
} = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      email,
      sub,
      'https://api.openai.com/auth': {
        user_id: sub,
        chatgpt_account_id: accountId,
      },
      exp,
      ...extraClaims,
    })
  ).toString('base64url')
  return `${header}.${payload}.signature_bytes`
}

function createCodexCredential({
  email = 'user@openai.com',
  accountId = 'chatgpt-acc-1',
  exp,
  extraClaims = {},
} = {}) {
  const jwtExp = exp ?? Math.floor(Date.now() / 1000) + 3600
  const accessJwt = createCodexJwt({ email, accountId, exp: jwtExp, extraClaims })
  const idJwt = createCodexJwt({ email, accountId, exp: jwtExp, extraClaims })
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idJwt,
      access_token: accessJwt,
      refresh_token: `refresh-token-${accountId}`,
      account_id: accountId,
    },
  })
}

function createClaudeCredential(id = '1') {
  return `sk-ant-oat01-${id.padStart(4, '0')}${'a'.repeat(60)}`
}

function createAntigravityCredential({ expiry, id = '1' } = {}) {
  return JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: `ya29.test-ag-access-${id}`,
      refresh_token: `1//test-ag-refresh-${id}`,
      token_type: 'Bearer',
      expiry: expiry || new Date(Date.now() + 3600_000).toISOString(),
    },
  })
}

function createFullClaudeCredential({
  access = createClaudeCredential('1'),
  refresh = 'sk-ant-ort01-' + 'r'.repeat(60),
  accountId = 'acc-claude-uuid-1',
  organizationId = 'org-claude-uuid-1',
  email = 'claude-full@example.com',
  displayName = 'Claude Full User',
  expiresAt = Date.now() + 3600_000,
} = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
    },
    oauthAccount: {
      accountUuid: accountId,
      organizationUuid: organizationId,
      emailAddress: email,
      displayName,
    },
  })
}

function createFullAntigravityCredential({
  id = '1',
  email = 'google-user@gmail.com',
  name = 'Google User',
  accountId = 'google-acc-1',
  expiry,
} = {}) {
  return JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: `ya29.test-ag-access-${id}`,
      refresh_token: `1//test-ag-refresh-${id}`,
      token_type: 'Bearer',
      expiry: expiry || new Date(Date.now() + 3600_000).toISOString(),
    },
    account: {
      id: accountId,
      email,
      name,
    },
    oauth_client_id: `client-id-${id}`,
  })
}

async function runTest(name, fn) {
  const testHome = path.join(testRoot, Math.random().toString(36).substring(2, 10))
  mkdirSync(testHome, { recursive: true })
  const env = { ...process.env, HOME: testHome }
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_BASE_URL
  delete env.CLAUDE_CODE_USE_BEDROCK
  delete env.CLAUDE_CODE_USE_VERTEX
  delete env.CLAUDE_CODE_USE_FOUNDRY
  delete env.CLAUDE_CONFIG_DIR
  delete env.GEMINI_API_KEY
  delete env.GOOGLE_API_KEY
  delete env.JETSKI_APP_DATA_DIR

  const codexHome = path.join(testHome, '.codex')

  const adapters = createAccountAdapters({
    homeDir: testHome,
    env,
    codexHome,
    antigravityFileMode: true,
  })

  let changedCount = 0
  const manager = new AccountManager({
    homeDir: testHome,
    env,
    codexHome,
    adapters,
    onAccountsChanged: () => {
      changedCount++
    },
  })

  try {
    await fn({
      testHome,
      env,
      codexHome,
      adapters,
      manager,
      getChangedCount: () => changedCount,
      resetChangedCount: () => {
        changedCount = 0
      },
    })
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(err)
  }
}

async function main() {
  console.log(`Starting Account Discovery verification suite in: ${testRoot}`)

  // 1. Automatic discovery and import from tool credentials
  await runTest('discovers and imports active credentials across tools', async ({
    testHome,
    codexHome,
    manager,
    getChangedCount,
  }) => {
    // Write active credentials for codex, claude, antigravity
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'dev@openai.com' }))

    const claudeDir = path.join(testHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: createClaudeCredential('1') } })
    )

    const agDir = path.join(testHome, '.gemini', 'antigravity-cli')
    mkdirSync(agDir, { recursive: true })
    writeFileSync(path.join(agDir, 'antigravity-oauth-token'), createAntigravityCredential({ id: '1' }))

    const results = await manager.syncCurrentAccounts()
    assert.equal(results.length, 3)

    const codexRes = results.find((r) => r.tool === 'codex')
    assert.ok(codexRes)
    assert.equal(codexRes.status, 'imported')
    assert.ok(codexRes.accountId)

    const claudeRes = results.find((r) => r.tool === 'claude-code')
    assert.ok(claudeRes)
    assert.equal(claudeRes.status, 'imported')
    assert.ok(claudeRes.accountId)

    const agRes = results.find((r) => r.tool === 'antigravity')
    assert.ok(agRes)
    assert.equal(agRes.status, 'imported')
    assert.ok(agRes.accountId)

    assert.equal(getChangedCount(), 1, 'Listeners notified on imports')

    // Check overview
    const overview = await manager.getOverview()
    assert.equal(overview.accounts.length, 3)

    const codexAcc = overview.accounts.find((a) => a.tool === 'codex')
    assert.equal(codexAcc.email, 'dev@openai.com')
    assert.equal(codexAcc.name, 'dev@openai.com', 'Default name derived from email')

    const claudeAcc = overview.accounts.find((a) => a.tool === 'claude-code')
    assert.equal(claudeAcc.name, 'Claude Code', 'Stable default tool label used when email absent')
  })

  // 2. Unchanged credentials do not write to disk or notify change listeners
  await runTest('unchanged credentials report unchanged without disk writes or notifications', async ({
    testHome,
    codexHome,
    manager,
    getChangedCount,
    resetChangedCount,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'user@openai.com' }))

    const firstResults = await manager.syncCurrentAccounts()
    const codexFirst = firstResults.find((r) => r.tool === 'codex')
    assert.equal(codexFirst.status, 'imported')

    const manifestPath = path.join(manager.store.accountsDir, codexFirst.accountId, 'manifest.json')
    const manifestMtimeBefore = statSync(manifestPath).mtimeMs

    resetChangedCount()
    const secondResults = await manager.syncCurrentAccounts()
    const codexSecond = secondResults.find((r) => r.tool === 'codex')
    assert.equal(codexSecond.status, 'unchanged')
    assert.equal(codexSecond.accountId, codexFirst.accountId)

    const manifestMtimeAfter = statSync(manifestPath).mtimeMs
    assert.equal(manifestMtimeBefore, manifestMtimeAfter, 'Unchanged must not touch manifest file')
    assert.equal(getChangedCount(), 0, 'Unchanged must not notify change listeners')
  })

  // 3. Updated credentials replace payload and metadata atomically, invalidating quota
  await runTest('updated credential replaces payload and metadata atomically, invalidating quota', async ({
    testHome,
    codexHome,
    manager,
    getChangedCount,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      createCodexCredential({ email: 'user@openai.com', accountId: 'acc-work-1', exp: Math.floor(Date.now() / 1000) + 1800 })
    )

    const firstRes = await manager.syncCurrentAccounts()
    const originalCodex = firstRes.find((r) => r.tool === 'codex')
    assert.equal(originalCodex.status, 'imported')

    const originalRecord = await manager.store.get(originalCodex.accountId)
    const originalCreatedAt = originalRecord.metadata.createdAt

    // Rename to custom name
    await manager.renameAccount(originalCodex.accountId, 'My Primary Codex')

    // Update credential file with refreshed token (same identityKey)
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      createCodexCredential({ email: 'user@openai.com', accountId: 'acc-work-1', exp: Math.floor(Date.now() / 1000) + 7200 })
    )

    const changesBefore = getChangedCount()
    const secondRes = await manager.syncCurrentAccounts()
    const updatedCodex = secondRes.find((r) => r.tool === 'codex')
    assert.equal(updatedCodex.status, 'updated')
    assert.equal(updatedCodex.accountId, originalCodex.accountId)

    // Verify stored account properties
    const updatedRecord = await manager.store.get(originalCodex.accountId)
    assert.equal(updatedRecord.metadata.id, originalCodex.accountId, 'ID preserved')
    assert.equal(updatedRecord.metadata.name, 'My Primary Codex', 'Custom name preserved')
    assert.equal(updatedRecord.metadata.createdAt, originalCreatedAt, 'createdAt preserved')
    assert.ok(updatedRecord.metadata.updatedAt > originalCreatedAt, 'updatedAt refreshed')
    assert.notEqual(updatedRecord.credential, originalRecord.credential, 'Payload updated')
    assert.equal(getChangedCount(), changesBefore + 1, 'Listeners notified on update')
  })

  // 4. Dedup by adapter identityKey with tool + workspace separation, never email alone
  await runTest('dedup uses tool + identityKey separation, never email alone', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    const sharedEmail = 'shared@example.com'

    // Codex account for workspace 1
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      createCodexCredential({ email: sharedEmail, accountId: 'chatgpt-workspace-1', sub: 'user_1' })
    )

    // Antigravity account with same email in custom claims/profile
    const agDir = path.join(testHome, '.gemini', 'antigravity-cli')
    mkdirSync(agDir, { recursive: true })
    writeFileSync(path.join(agDir, 'antigravity-oauth-token'), createAntigravityCredential({ id: 'ag-1' }))

    await manager.syncCurrentAccounts()

    // Import second Codex account with same email but DIFFERENT chatgpt_account_id
    const credWorkspace2 = createCodexCredential({ email: sharedEmail, accountId: 'chatgpt-workspace-2', sub: 'user_2' })
    await manager.importAccount({ tool: 'codex', name: 'Codex Workspace 2', credential: credWorkspace2 })

    const list = await manager.store.list()
    assert.equal(list.length, 3, 'Different tools and different workspaces must be stored separately')

    const codexAccounts = list.filter((a) => a.tool === 'codex')
    assert.equal(codexAccounts.length, 2, 'Workspaces within tool are strictly separated')

    const agAccounts = list.filter((a) => a.tool === 'antigravity')
    assert.equal(agAccounts.length, 1, 'Tool isolation holds')
  })

  // 5. Custom name and createdAt preservation on manual import / saveAuthenticatedAccount
  await runTest('saveAuthenticatedAccount and manual import preserve existing custom name and id', async ({
    manager,
  }) => {
    const initialCred = createCodexCredential({ email: 'oauth@openai.com', accountId: 'acc-oauth-1', sub: 'user_oauth' })

    const saved = await manager.saveAuthenticatedAccount({
      tool: 'codex',
      credential: initialCred,
      name: 'Initial Name',
    })
    assert.equal(saved.name, 'Initial Name')

    // User gives it a custom name
    await manager.renameAccount(saved.id, 'My Customized Title')

    // Refreshed OAuth token comes in via saveAuthenticatedAccount
    const refreshedCred = createCodexCredential({
      email: 'oauth@openai.com',
      accountId: 'acc-oauth-1',
      sub: 'user_oauth',
      exp: Math.floor(Date.now() / 1000) + 10000,
    })

    const updated = await manager.saveAuthenticatedAccount({
      tool: 'codex',
      credential: refreshedCred,
      name: 'Ignored Proposed Name',
    })

    assert.equal(updated.id, saved.id, 'Account ID preserved')
    assert.equal(updated.name, 'My Customized Title', 'Custom name preserved')
    assert.equal(updated.createdAt, saved.createdAt, 'createdAt preserved')
  })

  // 6. Concurrent duplicate discovery / import calls serialized without duplicates
  await runTest('concurrent sync and save calls do not create duplicates', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'concurrent@openai.com' }))

    // Execute 5 concurrent syncCurrentAccounts calls
    const syncPromises = Array.from({ length: 5 }, () => manager.syncCurrentAccounts())
    const allResults = await Promise.all(syncPromises)

    const list = await manager.store.list('codex')
    assert.equal(list.length, 1, 'Exactly one account created under concurrent sync')

    // Exactly one should be 'imported', rest should be 'unchanged'
    const statuses = allResults.map((res) => res.find((r) => r.tool === 'codex').status)
    assert.equal(statuses.filter((s) => s === 'imported').length, 1)
    assert.equal(statuses.filter((s) => s === 'unchanged').length, 4)
  })

  // 7. Corrupted existing account in store is not swallowed into a duplicate
  await runTest('corrupted account in store is reported and not duplicated', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'corrupt@openai.com' }))

    const first = await manager.syncCurrentAccounts()
    const codexAcc = first.find((r) => r.tool === 'codex')
    assert.equal(codexAcc.status, 'imported')

    // Corrupt manifest file on disk
    const manifestPath = path.join(manager.store.accountsDir, codexAcc.accountId, 'manifest.json')
    writeFileSync(manifestPath, '{"version": 1, "corrupted": true}')

    const second = await manager.syncCurrentAccounts()
    const codexRes = second.find((r) => r.tool === 'codex')
    assert.equal(codexRes.status, 'error')
    assert.ok(codexRes.message)

    // Must not create a duplicate directory
    const entries = readdirSync(manager.store.accountsDir).filter((e) => !e.startsWith('.'))
    assert.equal(entries.length, 1, 'Corrupted account must not be duplicated')
  })

  // 8. Missing credentials return not-found, and per-tool errors are strictly isolated
  await runTest('missing credentials report not-found and one-tool error is isolated', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    // Codex: no auth file -> not-found
    // Claude: corrupt settings.json -> error
    // Antigravity: valid token -> imported
    const claudeDir = path.join(testHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(path.join(claudeDir, 'settings.json'), 'not valid json')

    const agDir = path.join(testHome, '.gemini', 'antigravity-cli')
    mkdirSync(agDir, { recursive: true })
    writeFileSync(path.join(agDir, 'antigravity-oauth-token'), createAntigravityCredential({ id: 'ag-iso' }))

    const results = await manager.syncCurrentAccounts()
    assert.equal(results.length, 3)

    const codexRes = results.find((r) => r.tool === 'codex')
    assert.equal(codexRes.status, 'not-found')

    const claudeRes = results.find((r) => r.tool === 'claude-code')
    assert.equal(claudeRes.status, 'error')
    assert.ok(claudeRes.message)

    const agRes = results.find((r) => r.tool === 'antigravity')
    assert.equal(agRes.status, 'imported')
    assert.ok(agRes.accountId)
  })

  // 9. Known expired credential is not saved
  await runTest('known expired credential on disk is not saved', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    const expiredExp = Math.floor(Date.now() / 1000) - 3600 // Expired 1 hour ago
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'exp@openai.com', exp: expiredExp }))

    const results = await manager.syncCurrentAccounts()
    const codexRes = results.find((r) => r.tool === 'codex')
    assert.equal(codexRes.status, 'expired')

    const list = await manager.store.list('codex')
    assert.equal(list.length, 0, 'Expired credential must not be saved')
  })

  // 10. Existing valid credential is not replaced by older/expired token
  await runTest('newer valid stored credential is not replaced by older current credential', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    const futureExp = Math.floor(Date.now() / 1000) + 7200
    const olderExp = Math.floor(Date.now() / 1000) + 1800

    // Store has newer valid credential (from OAuth callback)
    const newerCred = createCodexCredential({ email: 'valid@openai.com', accountId: 'acc-older-test', exp: futureExp })
    const saved = await manager.saveAuthenticatedAccount({ tool: 'codex', credential: newerCred })

    // On disk, tool has older credential
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      createCodexCredential({ email: 'valid@openai.com', accountId: 'acc-older-test', exp: olderExp })
    )

    const results = await manager.syncCurrentAccounts()
    const codexRes = results.find((r) => r.tool === 'codex')
    assert.equal(codexRes.status, 'unchanged')

    const stored = await manager.store.get(saved.id)
    assert.equal(stored.metadata.expiresAt, futureExp * 1000, 'Newer expiresAt preserved')
  })

  // 11. Delete suppression across restart prevents immediate resurrection
  await runTest('delete suppression prevents resurrection across manager restarts', async ({
    testHome,
    codexHome,
    env,
    adapters,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'dismiss@openai.com' }))

    const initial = await manager.syncCurrentAccounts()
    const codexInitial = initial.find((r) => r.tool === 'codex')
    assert.equal(codexInitial.status, 'imported')

    // Delete account
    await manager.deleteAccount(codexInitial.accountId)
    assert.equal((await manager.store.list('codex')).length, 0)

    // Check suppression file exists in accountsDir
    const suppressionFile = path.join(manager.store.accountsDir, '.suppressions.json')
    assert.ok(existsSync(suppressionFile))
    if (process.platform !== 'win32') {
      assert.equal(statSync(suppressionFile).mode & 0o777, 0o600)
    }

    // Immediate sync: dismissed
    const second = await manager.syncCurrentAccounts()
    const codexSecond = second.find((r) => r.tool === 'codex')
    assert.equal(codexSecond.status, 'dismissed')
    assert.equal((await manager.store.list('codex')).length, 0)

    // Simulate restart with fresh manager
    const freshManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
    })

    const restartResults = await freshManager.syncCurrentAccounts()
    const codexRestart = restartResults.find((r) => r.tool === 'codex')
    assert.equal(codexRestart.status, 'dismissed', 'Remains dismissed across restart')
    assert.equal((await freshManager.store.list('codex')).length, 0)

    // Changed login: new account is discovered!
    writeFileSync(
      path.join(codexHome, 'auth.json'),
      createCodexCredential({ email: 'newlogin@openai.com', accountId: 'new-account-id', sub: 'user_new' })
    )

    const changedResults = await freshManager.syncCurrentAccounts()
    const codexChanged = changedResults.find((r) => r.tool === 'codex')
    assert.equal(codexChanged.status, 'imported', 'Changed login must be discovered')
    assert.equal((await freshManager.store.list('codex')).length, 1)
  })

  // 12. Explicit authenticated add/import clears matching suppression
  await runTest('explicit import or saveAuthenticatedAccount clears matching suppression', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    const cred = createCodexCredential({ email: 'explicit@openai.com', accountId: 'acc-explicit-1' })
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), cred)

    const first = await manager.syncCurrentAccounts()
    const codexFirst = first.find((r) => r.tool === 'codex')
    await manager.deleteAccount(codexFirst.accountId)

    // Verify dismissed
    const dismissedRes = await manager.syncCurrentAccounts()
    assert.equal(dismissedRes.find((r) => r.tool === 'codex').status, 'dismissed')

    // Explicit manual import of the exact same credential
    await manager.importAccount({ tool: 'codex', name: 'Explicitly Re-added', credential: cred })

    // Subsequent sync sees it as unchanged
    const afterImportRes = await manager.syncCurrentAccounts()
    assert.equal(afterImportRes.find((r) => r.tool === 'codex').status, 'unchanged')
  })

  // 13. Suppression storage corruption detection and delete-abort protection
  await runTest('corrupted suppression file reports corruption and aborts deletion', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'auth.json'), createCodexCredential({ email: 'safe-delete@openai.com' }))

    const first = await manager.syncCurrentAccounts()
    const codexAcc = first.find((r) => r.tool === 'codex')
    assert.equal(codexAcc.status, 'imported')

    // Corrupt suppression file
    const suppressionFile = path.join(manager.store.accountsDir, '.suppressions.json')
    writeFileSync(suppressionFile, 'corrupt { json')

    // deleteAccount must abort because recording suppression failed
    await assert.rejects(
      async () => await manager.deleteAccount(codexAcc.accountId),
      (err) => err instanceof AccountError
    )

    // Account record was NOT deleted!
    const record = await manager.store.get(codexAcc.accountId)
    assert.equal(record.metadata.id, codexAcc.accountId, 'Account must not be deleted if suppression fails')
  })

  // 14. Safe atomic update in AccountStore: generation files, pointer commit, failure preservation
  await runTest('AccountStore updateCredential uses generation files and atomic pointer commit', async ({
    testHome,
  }) => {
    const store = new AccountStore({ homeDir: testHome })
    const saved = await store.save({
      tool: 'antigravity',
      name: 'Generation Test',
      credential: 'token-v1',
    })

    const accountDir = path.join(store.accountsDir, saved.id)
    const manifestV1 = JSON.parse(readFileSync(path.join(accountDir, 'manifest.json'), 'utf8'))
    assert.equal(manifestV1.version, 1)
    assert.equal(manifestV1.credentialFile, 'credential.utf8')

    // Update credential to v2
    const updated = await store.updateCredential(saved.id, {
      credential: 'token-v2-refreshed',
      email: 'refreshed@google.com',
    })

    assert.equal(updated.id, saved.id)
    assert.equal(updated.name, 'Generation Test', 'Name preserved')
    assert.equal(updated.email, 'refreshed@google.com', 'Email updated')

    const manifestV2 = JSON.parse(readFileSync(path.join(accountDir, 'manifest.json'), 'utf8'))
    assert.equal(manifestV2.version, 2)
    assert.ok(manifestV2.credentialFile.startsWith('credential.'))
    assert.ok(manifestV2.credentialFile.endsWith('.utf8'))
    assert.notEqual(manifestV2.credentialFile, 'credential.utf8')

    // Old credential file was removed
    assert.equal(existsSync(path.join(accountDir, 'credential.utf8')), false)
    // New generation credential file exists
    assert.ok(existsSync(path.join(accountDir, manifestV2.credentialFile)))

    // Reading record returns updated credential
    const retrieved = await store.get(saved.id)
    assert.equal(retrieved.credential, 'token-v2-refreshed')

    // Oversize / path traversal rejections
    await assert.rejects(
      async () => await store.updateCredential(saved.id, { credential: '' }),
      (err) => err instanceof AccountError
    )
  })

  // 15. Rollback file non-interference and no official tool writes during discovery
  await runTest('discovery never mutates transactions or official auth files', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    const initialContent = createCodexCredential({ email: 'readonly-test@openai.com' })
    const authPath = path.join(codexHome, 'auth.json')
    writeFileSync(authPath, initialContent)

    await manager.syncCurrentAccounts()

    // Verify official auth file was untouched
    assert.equal(readFileSync(authPath, 'utf8'), initialContent)

    // Verify transactions directory is completely empty
    if (existsSync(manager.transactionsDir)) {
      const txFiles = readdirSync(manager.transactionsDir)
      assert.equal(txFiles.length, 0, 'Transactions directory must not have journals from discovery')
    }
  })

  // 16. Adapter optional readCurrentCredential discovery independent of switch capability
  await runTest('readCurrentCredential called when capability available is false', async ({
    manager,
  }) => {
    let readCurrentCalled = false
    const customAdapter = {
      tool: 'antigravity',
      capability: () => ({ tool: 'antigravity', available: false, reason: 'Native switch disabled' }),
      inspect: (raw) => {
        const parsed = JSON.parse(raw)
        return { credential: raw, identityKey: `ag:${parsed.id}` }
      },
      read: () => ({ oauth: null }),
      desired: (cred) => ({ oauth: cred }),
      writeSlot: () => {},
      credentialFrom: () => null, // Would return null normally
      readCurrentCredential: () => {
        readCurrentCalled = true
        return JSON.stringify({ id: 'agy-custom-token-123' })
      },
    }

    manager.adapters.antigravity = customAdapter

    const results = await manager.syncCurrentAccounts()
    const agRes = results.find((r) => r.tool === 'antigravity')
    assert.ok(readCurrentCalled, 'readCurrentCredential was invoked')
    assert.equal(agRes.status, 'imported')
    assert.ok(agRes.accountId)
  })

  // 17. Store.list ignores private support files (.suppressions.json)
  await runTest('Store.list ignores .suppressions.json support file', async ({ testHome }) => {
    const store = new AccountStore({ homeDir: testHome })
    const saved = await store.save({
      tool: 'claude-code',
      name: 'Claude Active',
      credential: createClaudeCredential('99'),
    })

    // Create a suppression entry
    await store.recordSuppression('claude-code', 'a'.repeat(64))

    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, saved.id)
  })

  // 18. Full saved OAuth + token-only current projection yields same active id without metadata downgrade or duplicates
  await runTest('full saved OAuth + token-only current projection matches active id without metadata downgrade or duplicate', async ({
    manager,
  }) => {
    const fullOAuthCredential = JSON.stringify({
      auth_method: 'oauth',
      tokens: {
        access_token: 'access-jwt-shared-secret-xyz',
        refresh_token: 'refresh-jwt-shared-secret-xyz',
        id_token: 'id-token-abc',
        account_id: 'chatgpt-enterprise-1',
      },
      email: 'corp@openai.com',
    })

    const tokenOnlyProjection = JSON.stringify({
      auth_method: 'token-only',
      tokens: {
        access_token: 'access-jwt-shared-secret-xyz',
      },
    })

    let currentDiskCredential = tokenOnlyProjection

    const syntheticOAuthAdapter = {
      tool: 'codex',
      capability: () => ({ tool: 'codex', available: true }),
      inspect: (raw) => {
        const parsed = JSON.parse(raw)
        const isFull = parsed.auth_method === 'oauth'
        return {
          credential: raw,
          email: parsed.email,
          accountId: isFull ? parsed.tokens.account_id : undefined,
          identityKey: isFull ? `codex:${parsed.tokens.account_id}` : `codex:token:${parsed.tokens.access_token}`,
        }
      },
      read: () => ({ auth: currentDiskCredential, mode: 'file' }),
      desired: (cred) => ({ auth: cred, mode: 'file' }),
      writeSlot: (_slot, val) => {
        currentDiskCredential = val
      },
      credentialFrom: (state) => state.auth,
      matchesIdentity: (leftRaw, rightRaw) => {
        const left = JSON.parse(leftRaw)
        const right = JSON.parse(rightRaw)
        if (left.tokens?.account_id && right.tokens?.account_id) {
          return left.tokens.account_id === right.tokens.account_id
        }
        return left.tokens?.access_token === right.tokens?.access_token
      },
      mergeCredential: (incomingRaw, storedRaw) => {
        const incoming = JSON.parse(incomingRaw)
        const stored = JSON.parse(storedRaw)
        if (incoming.auth_method === 'token-only' && stored.auth_method === 'oauth') {
          return storedRaw
        }
        return incomingRaw
      },
    }

    manager.adapters.codex = syntheticOAuthAdapter

    // 1. Save full OAuth account in store
    const saved = await manager.saveAuthenticatedAccount({
      tool: 'codex',
      credential: fullOAuthCredential,
      name: 'Corporate ChatGPT',
    })
    assert.equal(saved.name, 'Corporate ChatGPT')
    assert.equal(saved.email, 'corp@openai.com')

    // 2. getOverview with current token-only disk projection resolves to the SAME activeAccountId
    const overview = await manager.getOverview()
    const codexTool = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexTool.activeAccountId, saved.id, 'Token-only projection must resolve to full saved OAuth account ID')

    // 3. syncCurrentAccounts matches via matchesIdentity, calls mergeCredential,
    // sees it is unchanged, and does NOT downgrade or duplicate
    const syncResults = await manager.syncCurrentAccounts()
    const codexRes = syncResults.find((r) => r.tool === 'codex')
    assert.equal(codexRes.status, 'unchanged', 'Sync must identify full OAuth account as unchanged')
    assert.equal(codexRes.accountId, saved.id)

    // 4. Verify no duplicate accounts were created
    const codexAccounts = await manager.store.list('codex')
    assert.equal(codexAccounts.length, 1, 'No duplicate account must be created')

    // 5. Verify stored credential was not downgraded to token-only
    const storedRecord = await manager.store.get(saved.id)
    assert.equal(storedRecord.credential, fullOAuthCredential, 'Full OAuth metadata must NOT be downgraded')
    assert.equal(storedRecord.metadata.name, 'Corporate ChatGPT')
    assert.equal(storedRecord.metadata.email, 'corp@openai.com')
  })

  // 20. Corrupted stored credential payload with valid manifest is caught and does not create duplicate
  await runTest('corrupted stored credential with valid manifest fails and never duplicates', async ({
    testHome,
    codexHome,
    manager,
  }) => {
    mkdirSync(codexHome, { recursive: true })
    const validCred = createCodexCredential({ email: 'corrupt-cred@openai.com' })
    writeFileSync(path.join(codexHome, 'auth.json'), validCred)

    // Initial sync saves account
    const first = await manager.syncCurrentAccounts()
    const codexAcc = first.find((r) => r.tool === 'codex')
    assert.equal(codexAcc.status, 'imported')

    const accountDir = path.join(manager.store.accountsDir, codexAcc.accountId)
    const manifestPath = path.join(accountDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    // Overwrite credential file with invalid JSON, and update manifest to match length and hash
    // so store.get() verifies manifest & file integrity without throwing, but adapter.inspect() fails!
    const corruptPayload = Buffer.from('{ corrupt json content: [ not valid', 'utf8')
    const corruptHash = createHash('sha256').update(corruptPayload).digest('hex')
    writeFileSync(path.join(accountDir, manifest.credentialFile), corruptPayload)
    manifest.payloadLength = corruptPayload.length
    manifest.payloadSha256 = corruptHash
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    // Verify store.get() succeeds (storage level integrity passes)
    const storedRec = await manager.store.get(codexAcc.accountId)
    assert.equal(storedRec.credential, corruptPayload.toString('utf8'))

    // Attempt syncCurrentAccounts: must return status: 'error' and NOT create a duplicate account
    const syncResults = await manager.syncCurrentAccounts()
    const codexRes = syncResults.find((r) => r.tool === 'codex')
    assert.equal(codexRes.status, 'error')
    assert.match(codexRes.message, /corrupt/i)

    const entriesAfterSync = readdirSync(manager.store.accountsDir).filter((e) => !e.startsWith('.'))
    assert.equal(entriesAfterSync.length, 1, 'Corrupted stored credential must not lead to duplicate on sync')

    // Attempt explicit importAccount: must reject and NOT create a duplicate account
    await assert.rejects(
      () => manager.importAccount({ tool: 'codex', credential: validCred, name: 'Attempt Duplicate' }),
      (err) => err instanceof AccountError && /corrupt/i.test(err.message)
    )

    const entriesAfterImport = readdirSync(manager.store.accountsDir).filter((e) => !e.startsWith('.'))
    assert.equal(entriesAfterImport.length, 1, 'Corrupted stored credential must not lead to duplicate on import')
  })

  // 21. Full OAuth save -> official raw projection -> delete -> sync dismissed across restart for Claude + Google; credential change breaks suppression
  await runTest('full OAuth save then delete with raw projection suppresses across restart for Claude and Google', async ({
    testHome,
    env,
    codexHome,
    manager,
  }) => {
    // Part A: Claude Code
    const claudeAccess = createClaudeCredential('claude-del-1')
    const claudeFull = createFullClaudeCredential({
      access: claudeAccess,
      email: 'claude-del@anthropic.com',
      accountId: 'acc-uuid-del-1',
      organizationId: 'org-uuid-del-1',
    })

    // 1. Save full OAuth record in manager
    const savedClaude = await manager.saveAuthenticatedAccount({
      tool: 'claude-code',
      credential: claudeFull,
      name: 'Claude Corp',
    })

    // 2. Official raw projection on disk: settings.json only contains CLAUDE_CODE_OAUTH_TOKEN access token
    const claudeDir = path.join(testHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const claudeSettings = path.join(claudeDir, 'settings.json')
    writeFileSync(claudeSettings, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: claudeAccess } }, null, 2))

    // 3. Delete account: must suppress both full OAuth fingerprint and current on-disk raw access token fingerprint
    await manager.deleteAccount(savedClaude.id)
    await assert.rejects(() => manager.store.get(savedClaude.id))

    // 4. Simulate restart with fresh manager instance
    const restartAdaptersA = createAccountAdapters({ homeDir: testHome, env, codexHome, antigravityFileMode: true })
    const restartManagerA = new AccountManager({ homeDir: testHome, env, codexHome, adapters: restartAdaptersA })

    // 5. Sync after restart must report dismissed, NOT re-imported!
    const syncResA1 = await restartManagerA.syncCurrentAccounts()
    const claudeDismissed = syncResA1.find((r) => r.tool === 'claude-code')
    assert.equal(claudeDismissed.status, 'dismissed', 'Raw access token projection must remain dismissed across restart')

    // 6. Exact credential change breaks suppression
    const claudeAccessNew = createClaudeCredential('claude-del-2')
    writeFileSync(claudeSettings, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: claudeAccessNew } }, null, 2))

    const syncResA2 = await restartManagerA.syncCurrentAccounts()
    const claudeReimported = syncResA2.find((r) => r.tool === 'claude-code')
    assert.equal(claudeReimported.status, 'imported', 'Changing on-disk credential must break suppression')

    // Part B: Google Antigravity
    const agyAccess = 'ya29.test-ag-access-del-1'
    const agyRefresh = '1//test-ag-refresh-del-1'
    const agyFull = createFullAntigravityCredential({
      id: 'del-1',
      email: 'ag-del@gmail.com',
      name: 'Google Dev',
      accountId: 'google-del-1',
    })

    // 1. Save full OAuth record in manager
    const savedGoogle = await manager.saveAuthenticatedAccount({
      tool: 'antigravity',
      credential: agyFull,
      name: 'Google Dev',
    })

    // 2. Official raw projection on disk: token-only JSON without account profile or client id
    const agDir = path.join(testHome, '.gemini', 'antigravity-cli')
    mkdirSync(agDir, { recursive: true })
    const agFile = path.join(agDir, 'antigravity-oauth-token')
    writeFileSync(
      agFile,
      JSON.stringify(
        {
          auth_method: 'consumer',
          token: {
            access_token: agyAccess,
            refresh_token: agyRefresh,
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
        null,
        2
      )
    )

    // 3. Delete account: must suppress both full OAuth fingerprint and raw on-disk token fingerprint
    await manager.deleteAccount(savedGoogle.id)
    await assert.rejects(() => manager.store.get(savedGoogle.id))

    // 4. Simulate restart with fresh manager instance
    const restartAdaptersB = createAccountAdapters({ homeDir: testHome, env, codexHome, antigravityFileMode: true })
    const restartManagerB = new AccountManager({ homeDir: testHome, env, codexHome, adapters: restartAdaptersB })

    // 5. Sync after restart must report dismissed, NOT re-imported!
    const syncResB1 = await restartManagerB.syncCurrentAccounts()
    const agyDismissed = syncResB1.find((r) => r.tool === 'antigravity')
    assert.equal(agyDismissed.status, 'dismissed', 'Raw Google token projection must remain dismissed across restart')

    // 6. Exact credential change breaks suppression
    writeFileSync(
      agFile,
      JSON.stringify(
        {
          auth_method: 'consumer',
          token: {
            access_token: 'ya29.test-ag-access-del-2',
            refresh_token: '1//test-ag-refresh-del-2',
            token_type: 'Bearer',
            expiry: new Date(Date.now() + 3600_000).toISOString(),
          },
        },
        null,
        2
      )
    )

    const syncResB2 = await restartManagerB.syncCurrentAccounts()
    const agyReimported = syncResB2.find((r) => r.tool === 'antigravity')
    assert.equal(agyReimported.status, 'imported', 'Changing on-disk credential must break suppression')
  })

  // 22. getOverview: Claude .credentials.json-only matched active account (read-only), Antigravity native unsupported retains unknown, Codex conflict does not falsely mark active
  await runTest('getOverview matches Claude credentials.json read-only, handles native Antigravity and Codex conflicts', async ({
    testHome,
    env,
    codexHome,
    manager,
  }) => {
    // 1. Claude: credentials.json autodiscovered account matched in getOverview (read-only)
    const claudeDir = path.join(testHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const credPath = path.join(claudeDir, '.credentials.json')
    const settingsPath = path.join(claudeDir, 'settings.json')
    const claudeOAuth = createFullClaudeCredential({
      email: 'claude-autodiscover@anthropic.com',
      accountId: 'acc-uuid-overview-1',
      organizationId: 'org-uuid-overview-1',
    })
    writeFileSync(credPath, claudeOAuth)
    writeFileSync(settingsPath, '{}')

    // Discovery imports the account
    const syncRes = await manager.syncCurrentAccounts()
    const claudeAcc = syncRes.find((r) => r.tool === 'claude-code')
    assert.equal(claudeAcc.status, 'imported')

    const credMtimeBefore = statSync(credPath).mtimeMs
    const settingsMtimeBefore = statSync(settingsPath).mtimeMs

    // getOverview resolves active account from .credentials.json!
    const overview = await manager.getOverview()
    const claudeTool = overview.tools.find((t) => t.tool === 'claude-code')
    assert.equal(claudeTool.activeAccountId, claudeAcc.accountId)
    assert.equal(claudeTool.activeIdentity, 'claude-autodiscover@anthropic.com')

    // Read-only verification: no files modified, no settings.json mutation
    assert.equal(statSync(credPath).mtimeMs, credMtimeBefore)
    assert.equal(statSync(settingsPath).mtimeMs, settingsMtimeBefore)
    assert.equal(readFileSync(settingsPath, 'utf8'), '{}')

    // 2. Unknown identity remains unknown; does not read .claude.json
    // Write arbitrary .claude.json with fake email
    writeFileSync(path.join(testHome, '.claude.json'), JSON.stringify({ email: 'stale-fake@fake.com' }))
    // Overwrite .credentials.json with access token without profile claims
    const anonToken = createClaudeCredential('anon-token-1')
    writeFileSync(credPath, anonToken)

    const anonOverview = await manager.getOverview()
    const anonTool = anonOverview.tools.find((t) => t.tool === 'claude-code')
    assert.equal(anonTool.activeAccountId, undefined)
    assert.equal(anonTool.activeIdentity, undefined, 'Unknown identity must remain unknown without reading .claude.json')

    // 3. Antigravity native unsupported retains active unknown per capability
    const nativeAdapters = createAccountAdapters({
      homeDir: testHome,
      env: { ...env, SSH_TTY: undefined, SSH_CLIENT: undefined, SSH_CONNECTION: undefined },
      codexHome,
      antigravityFileMode: false, // native mode
    })
    const nativeManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters: nativeAdapters,
    })
    // Even if an agy token file exists on disk
    const agDir = path.join(testHome, '.gemini', 'antigravity-cli')
    mkdirSync(agDir, { recursive: true })
    writeFileSync(path.join(agDir, 'antigravity-oauth-token'), createAntigravityCredential({ id: 'native-test' }))

    const nativeOverview = await nativeManager.getOverview()
    const nativeAgyCap = nativeOverview.capabilities.find((c) => c.tool === 'antigravity')
    assert.equal(nativeAgyCap.available, false)
    assert.equal(nativeAgyCap.reasonCode, 'antigravity-file-mode-required')
    const nativeAgyTool = nativeOverview.tools.find((t) => t.tool === 'antigravity')
    assert.equal(nativeAgyTool.activeAccountId, undefined, 'Antigravity native unsupported must retain unknown active account')
    assert.equal(nativeAgyTool.activeIdentity, undefined, 'Antigravity native unsupported must retain unknown active identity')

    // 4. Codex conflict does not falsely mark active
    mkdirSync(codexHome, { recursive: true })
    const conflictConfig = 'forced_login_method = "api"\n'
    writeFileSync(path.join(codexHome, 'config.toml'), conflictConfig)
    const conflictCred = createCodexCredential({ email: 'conflict-user@openai.com' })
    writeFileSync(path.join(codexHome, 'auth.json'), conflictCred)

    const conflictAdapters = createAccountAdapters({ homeDir: testHome, env, codexHome })
    const conflictManager = new AccountManager({ homeDir: testHome, env, codexHome, adapters: conflictAdapters })

    // Save account in store
    const savedConflictAcc = await conflictManager.importAccount({
      tool: 'codex',
      name: 'Conflict User',
      credential: conflictCred,
    })

    const conflictOverview = await conflictManager.getOverview()
    const conflictCap = conflictOverview.capabilities.find((c) => c.tool === 'codex')
    assert.equal(conflictCap.available, false)
    assert.equal(conflictCap.reasonCode, 'codex-auth-conflict')
    const conflictCodexTool = conflictOverview.tools.find((t) => t.tool === 'codex')
    assert.equal(conflictCodexTool.activeAccountId, undefined, 'Codex conflict must not falsely mark active')
    assert.equal(conflictCodexTool.activeIdentity, undefined, 'Codex conflict must not falsely mark identity')
  })

  console.log(`\nAccount Discovery suite completed: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
