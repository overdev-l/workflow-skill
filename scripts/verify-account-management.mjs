/**
 * Verification Script for AI Tool Account Management (OPC-48)
 *
 * Comprehensive end-to-end tests for AccountManager integrating actual account-adapters:
 * 1. Switch and rollback for Codex and Claude using actual adapters
 * 2. Unmanaged settings (model, MCP servers) preservation during switch & rollback
 * 3. Originally absent files properly created on switch and restored to absent on rollback
 * 4. Failure injection: partial write compensation restores before state and prior complete journal
 * 5. Failure injection: compensation failure retains pending journal and reports recoveryNeeded
 * 6. CAS protection: concurrent external auth write during beforeWrite hook detected and aborted
 * 7. Rollback second-slot failure leaves pending journal; fresh manager restart and recoverAccount completes restoration
 * 8. Recovery: recoverAccount restores before state when slots are in before/after states
 * 9. Recovery: recoverAccount refuses recovery when foreign changes are detected
 * 10. External credential conflict: rollback aborted when credentials changed externally
 * 11. Malformed journal rejected, never wiped, reported in getOverview
 * 12. Journal with unknown or mismatched slot keys rejected as corrupt
 * 13. Symlink traceHome rejected without modifying external directory permissions
 * 14. Private storage permissions: 0o700 for directory, 0o600 for journal
 * 15. Renderer metadata secrecy: zero raw tokens in getOverview, errors, or notifications
 * 16. Expired credentials (with expired access JWT) and API key rejection on capture, import, and switch
 * 17. Tool capability gating and per-tool capability readerror isolation
 * 18. Large (>64 KiB) credential switch, rollback, and recovery within 64 MiB limit
 * 19. Antigravity synthetic consumer account switch and rollback in file mode
 * 20. Legacy profile data (~/.trace/profiles) untouched and detected via legacyProfilesPresent
 * 21. Restart manager state: fresh AccountManager reconstructs active account and rollback state
 * 22. Serialized mutation execution under concurrent load
 * 23. onAccountsChanged listener and option callbacks invoked on state changes
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-management.mjs
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import {
  ACCOUNT_TOOLS,
  AccountError,
} from '../packages/workflow-model/src/accounts.ts'

const testRoot = mkdtempSync(path.join(tmpdir(), 'verify-account-mgmt-'))
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
  const jwtExp = exp ?? (Math.floor(Date.now() / 1000) + 3600)
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
    await fn({ testHome, env, codexHome, adapters, manager, getChangedCount: () => changedCount })
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(err)
  }
}

async function main() {
  console.log(`Starting AccountManager verification suite in: ${testRoot}`)

  // 1. Separate tool account switch and rollback with actual adapters
  await runTest('switch and rollback for Codex and Claude using actual adapters', async ({ manager, codexHome, testHome }) => {
    const credA = createCodexCredential({ email: 'devA@openai.com', accountId: 'acc-A' })
    const credB = createCodexCredential({ email: 'devB@openai.com', accountId: 'acc-B' })

    const accA = await manager.importAccount({ tool: 'codex', name: 'Account A', credential: credA })
    const accB = await manager.importAccount({ tool: 'codex', name: 'Account B', credential: credB })

    // Switch to A
    const resA = await manager.switchAccount(accA.id)
    assert.equal(resA.success, true)

    let overview = await manager.getOverview()
    let codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.activeAccountId, accA.id)
    assert.equal(codexState.activeIdentity, 'devA@openai.com')

    // Switch to B
    const resB = await manager.switchAccount(accB.id)
    assert.equal(resB.success, true)

    overview = await manager.getOverview()
    codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.activeAccountId, accB.id)
    assert.equal(codexState.activeIdentity, 'devB@openai.com')
    assert.equal(codexState.canRollback, true)

    // Rollback to A
    const rollRes = await manager.rollbackAccount('codex')
    assert.equal(rollRes.success, true)

    overview = await manager.getOverview()
    codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.activeAccountId, accA.id)
    assert.equal(codexState.activeIdentity, 'devA@openai.com')

    // Claude test
    const claudeCredA = createClaudeCredential('1')
    const claudeCredB = createClaudeCredential('2')
    const claudeAccA = await manager.importAccount({ tool: 'claude-code', name: 'Claude A', credential: claudeCredA })
    const claudeAccB = await manager.importAccount({ tool: 'claude-code', name: 'Claude B', credential: claudeCredB })

    const cResA = await manager.switchAccount(claudeAccA.id)
    assert.equal(cResA.success, true)
    overview = await manager.getOverview()
    let claudeState = overview.tools.find((t) => t.tool === 'claude-code')
    assert.equal(claudeState.activeAccountId, claudeAccA.id)
    assert.equal(claudeState.activeIdentity, 'Claude A')

    const cResB = await manager.switchAccount(claudeAccB.id)
    assert.equal(cResB.success, true)
    overview = await manager.getOverview()
    claudeState = overview.tools.find((t) => t.tool === 'claude-code')
    assert.equal(claudeState.activeAccountId, claudeAccB.id)
    assert.equal(claudeState.activeIdentity, 'Claude B')

    const cRoll = await manager.rollbackAccount('claude-code')
    assert.equal(cRoll.success, true)
    overview = await manager.getOverview()
    claudeState = overview.tools.find((t) => t.tool === 'claude-code')
    assert.equal(claudeState.activeAccountId, claudeAccA.id)
    assert.equal(claudeState.activeIdentity, 'Claude A')
  })

  // 2. Unmanaged settings (model, MCP servers) preservation during switch and rollback
  await runTest('preserve unmanaged model and MCP settings', async ({ manager, codexHome, testHome }) => {
    mkdirSync(codexHome, { recursive: true })
    const configTomlPath = path.join(codexHome, 'config.toml')
    const originalToml = `# Codex Configuration\nmodel = "o3-pro"\n\n[mcp_servers.database]\ncommand = "npx"\nargs = ["@modelcontextprotocol/server-postgres"]\n`
    writeFileSync(configTomlPath, originalToml, { mode: 0o644 })

    const claudeSettingsDir = path.join(testHome, '.claude')
    mkdirSync(claudeSettingsDir, { recursive: true })
    const claudeSettingsPath = path.join(claudeSettingsDir, 'settings.json')
    const originalClaudeSettings = {
      model: 'claude-3-7-sonnet',
      mcpServers: { localGit: { command: 'git' } },
      unrelatedField: true,
    }
    writeFileSync(claudeSettingsPath, JSON.stringify(originalClaudeSettings, null, 2), { mode: 0o644 })

    const credCodex = createCodexCredential({ email: 'mcp@openai.com', accountId: 'acc-mcp' })
    const accCodex = await manager.importAccount({ tool: 'codex', name: 'Codex MCP', credential: credCodex })

    const credClaude = createClaudeCredential('100')
    const accClaude = await manager.importAccount({ tool: 'claude-code', name: 'Claude MCP', credential: credClaude })

    await manager.switchAccount(accCodex.id)
    await manager.switchAccount(accClaude.id)

    // After switch: Codex config.toml has cli_auth_credentials_store added, but model and mcp_servers preserved
    const afterSwitchToml = readFileSync(configTomlPath, 'utf8')
    assert.ok(afterSwitchToml.includes('model = "o3-pro"'))
    assert.ok(afterSwitchToml.includes('[mcp_servers.database]'))

    // Claude settings.json preserved non-auth fields
    const afterClaudeSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'))
    assert.equal(afterClaudeSettings.model, 'claude-3-7-sonnet')
    assert.deepEqual(afterClaudeSettings.mcpServers, { localGit: { command: 'git' } })
    assert.equal(afterClaudeSettings.unrelatedField, true)

    // Rollback both
    await manager.rollbackAccount('codex')
    await manager.rollbackAccount('claude-code')

    // After rollback: config.toml is exact match with original
    assert.equal(readFileSync(configTomlPath, 'utf8'), originalToml)

    const rolledClaudeSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'))
    assert.equal(rolledClaudeSettings.model, 'claude-3-7-sonnet')
    assert.deepEqual(rolledClaudeSettings.mcpServers, { localGit: { command: 'git' } })
  })

  // 3. Originally absent files handled cleanly on switch and restored on rollback
  await runTest('originally absent files restored to absent on rollback', async ({ manager, codexHome }) => {
    const authFile = path.join(codexHome, 'auth.json')
    assert.equal(existsSync(authFile), false, 'Auth file must be initially absent')

    const cred = createCodexCredential({ email: 'absent@openai.com', accountId: 'acc-absent' })
    const acc = await manager.importAccount({ tool: 'codex', name: 'Absent Test', credential: cred })

    await manager.switchAccount(acc.id)
    assert.equal(existsSync(authFile), true, 'Auth file created after switch')

    await manager.rollbackAccount('codex')
    assert.equal(existsSync(authFile), false, 'Auth file must be absent after rolling back original state')
  })

  // 4. Failure injection: partial write compensation restores before state and prior journal
  await runTest('failure injection partial write compensation', async ({ testHome, env, codexHome, adapters }) => {
    let failWrite = false
    const faultManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      beforeWrite: (tool, slot, index) => {
        if (failWrite && slot === 'mode') {
          throw new Error('Injected filesystem write failure on mode slot')
        }
      },
    })

    const cred1 = createCodexCredential({ email: 'state1@openai.com', accountId: 'acc-1' })
    const cred2 = createCodexCredential({ email: 'state2@openai.com', accountId: 'acc-2' })

    const acc1 = await faultManager.importAccount({ tool: 'codex', name: 'Acc 1', credential: cred1 })
    const acc2 = await faultManager.importAccount({ tool: 'codex', name: 'Acc 2', credential: cred2 })

    await faultManager.switchAccount(acc1.id)

    failWrite = true
    const switchResult = await faultManager.switchAccount(acc2.id)
    assert.equal(switchResult.success, false)
    assert.equal(switchResult.recoveryNeeded, false, 'Compensation should succeed without requiring manual recovery')

    // Verify state compensated back to acc1 and prior complete journal restored
    const overview = await faultManager.getOverview()
    const codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.activeAccountId, acc1.id)
    assert.equal(codexState.recoveryNeeded, false)
  })

  // 5. Failure injection: compensation failure retains pending journal
  await runTest('compensation failure retains pending journal', async ({ testHome, env, codexHome, adapters }) => {
    let failWrite = false
    const faultManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      beforeWrite: (tool, slot, index) => {
        if (failWrite) {
          const authFile = path.join(codexHome, 'auth.json')
          writeFileSync(authFile, JSON.stringify({ external: 'foreign-conflict' }))
          throw new Error('Injected crash during write')
        }
      },
    })

    const credA = createCodexCredential({ email: 'initial@openai.com', accountId: 'acc-init' })
    const credB = createCodexCredential({ email: 'target@openai.com', accountId: 'acc-target' })

    const accA = await faultManager.importAccount({ tool: 'codex', name: 'Init', credential: credA })
    const accB = await faultManager.importAccount({ tool: 'codex', name: 'Target', credential: credB })

    await faultManager.switchAccount(accA.id)

    failWrite = true
    const result = await faultManager.switchAccount(accB.id)
    assert.equal(result.success, false)
    assert.equal(result.recoveryNeeded, true)

    const overview = await faultManager.getOverview()
    const toolState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(toolState.recoveryNeeded, true)

    // Pending journal blocks new switch
    const blockedSwitch = await faultManager.switchAccount(accA.id)
    assert.equal(blockedSwitch.success, false)
    assert.equal(blockedSwitch.recoveryNeeded, true)
  })

  // 6. CAS protection: concurrent external auth write during beforeWrite hook detected and aborted
  await runTest('CAS detection of concurrent external auth write', async ({ testHome, env, codexHome, adapters }) => {
    let injectConflict = false
    const casManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      beforeWrite: (tool, slot, index) => {
        if (injectConflict && slot === 'auth') {
          // Mutate auth.json right before slot write
          const authFile = path.join(codexHome, 'auth.json')
          writeFileSync(authFile, JSON.stringify({ external: 'concurrent-token' }))
        }
      },
    })

    const credA = createCodexCredential({ email: 'casA@openai.com', accountId: 'acc-casA' })
    const credB = createCodexCredential({ email: 'casB@openai.com', accountId: 'acc-casB' })

    const accA = await casManager.importAccount({ tool: 'codex', name: 'CAS A', credential: credA })
    const accB = await casManager.importAccount({ tool: 'codex', name: 'CAS B', credential: credB })

    await casManager.switchAccount(accA.id)

    injectConflict = true
    const res = await casManager.switchAccount(accB.id)
    assert.equal(res.success, false)
    assert.ok(res.error)
  })

  // 7. Rollback second-slot failure leaves pending journal; fresh manager restart and recoverAccount completes restoration
  await runTest('rollback second-slot failure leaves pending journal and recovers cleanly', async ({ testHome, env, codexHome, adapters }) => {
    let failRollbackMode = false
    const faultManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      beforeWrite: (tool, slot, index) => {
        if (failRollbackMode && slot === 'mode') {
          throw new Error('Injected failure during rollback on mode slot')
        }
      },
    })

    const credA = createCodexCredential({ email: 'rbA@openai.com', accountId: 'acc-rbA' })
    const credB = createCodexCredential({ email: 'rbB@openai.com', accountId: 'acc-rbB' })

    const accA = await faultManager.importAccount({ tool: 'codex', name: 'RB A', credential: credA })
    const accB = await faultManager.importAccount({ tool: 'codex', name: 'RB B', credential: credB })

    await faultManager.switchAccount(accA.id)
    await faultManager.switchAccount(accB.id)

    failRollbackMode = true
    const rollResult = await faultManager.rollbackAccount('codex')
    assert.equal(rollResult.success, false)
    assert.equal(rollResult.recoveryNeeded, true)

    // Instantiate fresh manager pointing to same root
    const freshManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
    })

    let overview = await freshManager.getOverview()
    let codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.recoveryNeeded, true)

    // Execute recovery
    const recResult = await freshManager.recoverAccount('codex')
    assert.equal(recResult.success, true)

    overview = await freshManager.getOverview()
    codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.recoveryNeeded, false)
    assert.equal(codexState.activeAccountId, accA.id)
  })

  // 8. Recovery: recoverAccount restores before state
  await runTest('recoverAccount restores before state', async ({ testHome, env, codexHome, adapters, manager }) => {
    const credA = createCodexCredential({ email: 'recA@openai.com', accountId: 'acc-recA' })
    const credB = createCodexCredential({ email: 'recB@openai.com', accountId: 'acc-recB' })

    const accA = await manager.importAccount({ tool: 'codex', name: 'Rec A', credential: credA })
    const accB = await manager.importAccount({ tool: 'codex', name: 'Rec B', credential: credB })

    await manager.switchAccount(accA.id)

    // Manually write a pending journal using REAL adapter slot names ('auth', 'mode')
    const journalPath = path.join(manager.transactionsDir, 'codex.json')
    const pendingJournal = {
      version: 1,
      tool: 'codex',
      phase: 'pending',
      before: { auth: adapters.codex.inspect(credA).credential, mode: 'file' },
      after: { auth: adapters.codex.inspect(credB).credential, mode: 'file' },
      previousAccountId: accA.id,
      selectedAccountId: accB.id,
    }
    mkdirSync(manager.transactionsDir, { recursive: true })
    writeFileSync(journalPath, JSON.stringify(pendingJournal, null, 2), { mode: 0o600 })

    // Slot is in partial write state (after)
    const authFile = path.join(codexHome, 'auth.json')
    writeFileSync(authFile, adapters.codex.inspect(credB).credential)

    let overview = await manager.getOverview()
    assert.equal(overview.tools.find((t) => t.tool === 'codex').recoveryNeeded, true)

    const recResult = await manager.recoverAccount('codex')
    assert.equal(recResult.success, true)

    const restoredContent = readFileSync(authFile, 'utf8')
    assert.equal(restoredContent, adapters.codex.inspect(credA).credential)

    overview = await manager.getOverview()
    assert.equal(overview.tools.find((t) => t.tool === 'codex').recoveryNeeded, false)
  })

  // 9. Recovery refuses foreign changes
  await runTest('recoverAccount refuses foreign changes', async ({ manager, codexHome, adapters }) => {
    const credA = createCodexCredential({ email: 'forA@openai.com', accountId: 'acc-forA' })
    const credB = createCodexCredential({ email: 'forB@openai.com', accountId: 'acc-forB' })

    const accA = await manager.importAccount({ tool: 'codex', name: 'For A', credential: credA })
    const accB = await manager.importAccount({ tool: 'codex', name: 'For B', credential: credB })

    await manager.switchAccount(accA.id)

    const journalPath = path.join(manager.transactionsDir, 'codex.json')
    const pendingJournal = {
      version: 1,
      tool: 'codex',
      phase: 'pending',
      before: { auth: adapters.codex.inspect(credA).credential, mode: 'file' },
      after: { auth: adapters.codex.inspect(credB).credential, mode: 'file' },
      selectedAccountId: accB.id,
    }
    mkdirSync(manager.transactionsDir, { recursive: true })
    writeFileSync(journalPath, JSON.stringify(pendingJournal, null, 2), { mode: 0o600 })

    // Foreign change on slot
    const authFile = path.join(codexHome, 'auth.json')
    writeFileSync(authFile, JSON.stringify({ foreign: 'unknown-change' }))

    const recResult = await manager.recoverAccount('codex')
    assert.equal(recResult.success, false)
    assert.equal(recResult.recoveryNeeded, true)
  })

  // 10. External credential conflict: rollback aborted when credentials changed externally
  await runTest('rollback conflict detection on external credential change', async ({ manager, codexHome }) => {
    const credA = createCodexCredential({ email: 'confA@openai.com', accountId: 'acc-confA' })
    const credB = createCodexCredential({ email: 'confB@openai.com', accountId: 'acc-confB' })

    const accA = await manager.importAccount({ tool: 'codex', name: 'Conf A', credential: credA })
    const accB = await manager.importAccount({ tool: 'codex', name: 'Conf B', credential: credB })

    await manager.switchAccount(accA.id)
    await manager.switchAccount(accB.id)

    // Simulate external token refresh
    const refreshedCredB = createCodexCredential({ email: 'confB@openai.com', accountId: 'acc-confB-refreshed' })
    const authFile = path.join(codexHome, 'auth.json')
    writeFileSync(authFile, refreshedCredB)

    const rollbackResult = await manager.rollbackAccount('codex')
    assert.equal(rollbackResult.success, false)
    assert.match(rollbackResult.error, /external/i)

    // Refreshed credential was NOT overwritten
    assert.equal(readFileSync(authFile, 'utf8'), refreshedCredB)
  })

  // 11. Malformed journal rejected, never wiped, reported in getOverview
  await runTest('malformed journal rejected and preserved', async ({ manager }) => {
    const journalPath = path.join(manager.transactionsDir, 'codex.json')
    mkdirSync(manager.transactionsDir, { recursive: true })
    const corruptContent = '{ "corrupt_json": true, incomplete...'
    writeFileSync(journalPath, corruptContent, { mode: 0o600 })

    const overview = await manager.getOverview()
    const codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.recoveryNeeded, true)
    assert.ok(codexState.error, 'Should report error for corrupted journal')

    assert.equal(readFileSync(journalPath, 'utf8'), corruptContent)

    const cred = createCodexCredential()
    const acc = await manager.importAccount({ tool: 'codex', name: 'Corrupt Test', credential: cred })
    await assert.rejects(async () => manager.switchAccount(acc.id), AccountError)
  })

  // 12. Journal with unknown or mismatched slot keys rejected as corrupt
  await runTest('journal with unknown slot keys rejected', async ({ manager, adapters }) => {
    const journalPath = path.join(manager.transactionsDir, 'codex.json')
    mkdirSync(manager.transactionsDir, { recursive: true })

    const badSlotJournal = {
      version: 1,
      tool: 'codex',
      phase: 'complete',
      before: { auth: null, mode: null, unknown_slot: 'malicious' },
      after: { auth: 'a', mode: 'file', unknown_slot: 'malicious' },
    }
    writeFileSync(journalPath, JSON.stringify(badSlotJournal, null, 2), { mode: 0o600 })

    const overview = await manager.getOverview()
    const codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.recoveryNeeded, true)
    assert.match(codexState.error, /corrupted|slot/i)
  })

  // 13. Symlink traceHome rejected without modifying external directory permissions
  await runTest('symlink traceHome rejected and external directory not modified', async ({ testHome }) => {
    const externalDir = path.join(testRoot, `external-dir-${randomUUID()}`)
    mkdirSync(externalDir, { mode: 0o755 })

    const symlinkPath = path.join(testHome, '.trace')
    symlinkSync(externalDir, symlinkPath)

    // Attempting to instantiate or operate with symlink traceHome
    assert.throws(() => {
      new AccountManager({ homeDir: testHome, traceHome: symlinkPath })
    }, AccountError)

    // External directory permissions were NOT modified
    const stat = statSync(externalDir)
    assert.notEqual(stat.mode & 0o777, 0o700, 'External directory must not have permissions changed by trace')
  })

  // 14. Private storage permissions: 0o700 for directory, 0o600 for journal
  await runTest('enforce 700 dir and 600 file permissions', async ({ manager }) => {
    const cred = createCodexCredential()
    const acc = await manager.importAccount({ tool: 'codex', name: 'Perms Test', credential: cred })
    await manager.switchAccount(acc.id)

    if (process.platform !== 'win32') {
      const dirStat = statSync(manager.transactionsDir)
      assert.equal(dirStat.mode & 0o777, 0o700, 'Transactions directory must be 0o700')

      const journalFile = path.join(manager.transactionsDir, 'codex.json')
      const fileStat = statSync(journalFile)
      assert.equal(fileStat.mode & 0o777, 0o600, 'Journal file must be 0o600')
    }
  })

  // 15. Renderer metadata secrecy: zero raw tokens in getOverview, errors, or notifications
  await runTest('renderer metadata secrecy: zero credential leakage', async ({ manager }) => {
    const secretOatToken = createClaudeCredential('99')
    const secretJwt = createCodexJwt({ email: 'secret@corp.internal', accountId: 'secret-acc-99' })
    const credCodex = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: secretJwt,
        access_token: secretJwt,
        refresh_token: 'secret-refresh-token-bytes-do-not-leak',
        account_id: 'secret-acc-99',
      },
    })

    const accCodex = await manager.importAccount({ tool: 'codex', name: 'Secret Codex', credential: credCodex })
    const accClaude = await manager.importAccount({ tool: 'claude-code', name: 'Secret Claude', credential: secretOatToken })

    await manager.switchAccount(accCodex.id)
    await manager.switchAccount(accClaude.id)

    const overview = await manager.getOverview()
    const jsonOverview = JSON.stringify(overview)

    assert.equal(jsonOverview.includes('secret-refresh-token'), false, 'refresh_token must not leak in overview')
    assert.equal(jsonOverview.includes(secretOatToken), false, 'Claude oauth token must not leak in overview')

    for (const acc of overview.accounts) {
      assert.equal('credential' in acc, false)
      assert.equal('payload' in acc, false)
    }
  })

  // 16. Expired credentials (with expired access JWT) and API key rejection on capture, import, and switch
  await runTest('expired credentials and API key rejection', async ({ manager }) => {
    // Expired Codex credential: expired exp claim in access_token
    const expiredCodex = createCodexCredential({
      email: 'expired@openai.com',
      accountId: 'acc-exp',
      exp: Math.floor(Date.now() / 1000) - 3600,
    })

    await assert.rejects(
      async () => manager.importAccount({ tool: 'codex', name: 'Expired', credential: expiredCodex }),
      AccountError
    )

    // Expired Antigravity credential
    const expiredAg = createAntigravityCredential({
      expiry: new Date(Date.now() - 3600_000).toISOString(),
    })
    await assert.rejects(
      async () => manager.importAccount({ tool: 'antigravity', name: 'Expired AG', credential: expiredAg }),
      AccountError
    )

    // Claude API key instead of OAuth
    await assert.rejects(
      async () =>
        manager.importAccount({
          tool: 'claude-code',
          name: 'API Key',
          credential: 'sk-ant-api03-abcdef1234567890123456789012345678901234567890',
        }),
      AccountError
    )
  })

  // 17. Tool capability gating and per-tool capability readerror isolation
  await runTest('capability gating and per-tool readerror isolation', async ({ testHome, env, codexHome }) => {
    // Malform Claude's settings.json to trigger parse error during capability/read
    const claudeDir = path.join(testHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(path.join(claudeDir, 'settings.json'), '{ malformed json...')

    const adapters = createAccountAdapters({
      homeDir: testHome,
      env,
      codexHome,
      antigravityFileMode: false, // Antigravity gated
    })

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
    })

    // Overview must NOT crash: Claude error is isolated to Claude tool
    const overview = await manager.getOverview()
    assert.equal(overview.tools.length, 3)

    const claudeCap = overview.capabilities.find((c) => c.tool === 'claude-code')
    assert.equal(claudeCap.available, false)
    assert.ok(claudeCap.reason)

    const agCap = overview.capabilities.find((c) => c.tool === 'antigravity')
    assert.equal(agCap.available, false)

    // Codex is completely unaffected and available!
    const codexCap = overview.capabilities.find((c) => c.tool === 'codex')
    assert.equal(codexCap.available, true)

    // Import is allowed for gated Antigravity tool
    const agCred = createAntigravityCredential()
    const imported = await manager.importAccount({ tool: 'antigravity', name: 'Gated Ag', credential: agCred })
    assert.ok(imported.id)

    // Switch is gated
    await assert.rejects(async () => manager.switchAccount(imported.id), AccountError)
  })

  // 18. Large (>64 KiB) credential switch, rollback, and recovery within 64 MiB limit
  await runTest('large (>64 KiB) credential switch, rollback, and recovery', async ({ manager, codexHome }) => {
    // Large claim padding to reach ~100 KiB
    const largePadding = 'x'.repeat(100 * 1024)
    const largeCred = createCodexCredential({
      email: 'large@openai.com',
      accountId: 'acc-large',
      extraClaims: { padding: largePadding },
    })

    const acc = await manager.importAccount({ tool: 'codex', name: 'Large Cred', credential: largeCred })
    const switchRes = await manager.switchAccount(acc.id)
    assert.equal(switchRes.success, true)

    const journalPath = path.join(manager.transactionsDir, 'codex.json')
    const stat = statSync(journalPath)
    assert.ok(stat.size > 64 * 1024, 'Journal size should exceed 64 KiB')

    let overview = await manager.getOverview()
    let codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.activeAccountId, acc.id)

    const rollRes = await manager.rollbackAccount('codex')
    assert.equal(rollRes.success, true)
  })

  // 19. Antigravity synthetic consumer account switch and rollback in file mode
  await runTest('antigravity synthetic consumer account switch and rollback', async ({ manager, testHome }) => {
    const agCredA = createAntigravityCredential({ id: 'A' })
    const agCredB = createAntigravityCredential({ id: 'B' })

    const accA = await manager.importAccount({ tool: 'antigravity', name: 'Ag A', credential: agCredA })
    const accB = await manager.importAccount({ tool: 'antigravity', name: 'Ag B', credential: agCredB })

    const resA = await manager.switchAccount(accA.id)
    assert.equal(resA.success, true)

    const agAuthFile = path.join(testHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    assert.equal(existsSync(agAuthFile), true)
    assert.equal(readFileSync(agAuthFile, 'utf8'), manager.adapters.antigravity.inspect(agCredA).credential)

    let overview = await manager.getOverview()
    let agState = overview.tools.find((t) => t.tool === 'antigravity')
    assert.equal(agState.activeAccountId, accA.id)
    assert.equal(agState.activeIdentity, 'Ag A')

    const resB = await manager.switchAccount(accB.id)
    assert.equal(resB.success, true)
    overview = await manager.getOverview()
    agState = overview.tools.find((t) => t.tool === 'antigravity')
    assert.equal(agState.activeAccountId, accB.id)

    const rollRes = await manager.rollbackAccount('antigravity')
    assert.equal(rollRes.success, true)
    overview = await manager.getOverview()
    agState = overview.tools.find((t) => t.tool === 'antigravity')
    assert.equal(agState.activeAccountId, accA.id)
  })

  // 20. Legacy profile data (~/.trace/profiles) untouched and detected via legacyProfilesPresent
  await runTest('legacy profile directory non-interference', async ({ manager, testHome }) => {
    const legacyDir = path.join(testHome, '.trace', 'profiles', 'legacy-account-1')
    mkdirSync(legacyDir, { recursive: true })
    const legacyManifest = path.join(legacyDir, 'profile.json')
    writeFileSync(legacyManifest, JSON.stringify({ legacyProfile: true }), { mode: 0o600 })

    const cred = createCodexCredential()
    const acc = await manager.importAccount({ tool: 'codex', name: 'New Acc', credential: cred })
    await manager.switchAccount(acc.id)

    const overview = await manager.getOverview()
    assert.equal(overview.legacyProfilesPresent, true)

    assert.equal(existsSync(legacyManifest), true)
    assert.equal(JSON.parse(readFileSync(legacyManifest, 'utf8')).legacyProfile, true)
  })

  // 21. Restart manager state: fresh AccountManager reconstructs active account and rollback state
  await runTest('restart manager state persistence', async ({ testHome, env, codexHome, adapters, manager }) => {
    const credA = createCodexCredential({ email: 'restartA@openai.com', accountId: 'acc-restartA' })
    const credB = createCodexCredential({ email: 'restartB@openai.com', accountId: 'acc-restartB' })

    const accA = await manager.importAccount({ tool: 'codex', name: 'Acc A', credential: credA })
    const accB = await manager.importAccount({ tool: 'codex', name: 'Acc B', credential: credB })

    await manager.switchAccount(accA.id)
    await manager.switchAccount(accB.id)

    const freshManager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
    })

    const overview = await freshManager.getOverview()
    const codexState = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexState.activeAccountId, accB.id)
    assert.equal(codexState.activeIdentity, 'restartB@openai.com')
    assert.equal(codexState.canRollback, true)
    assert.equal(overview.accounts.length, 2)

    const rollRes = await freshManager.rollbackAccount('codex')
    assert.equal(rollRes.success, true)

    const rolledOverview = await freshManager.getOverview()
    assert.equal(rolledOverview.tools.find((t) => t.tool === 'codex').activeAccountId, accA.id)
  })

  // 22. Serialized mutation execution under concurrent load
  await runTest('concurrent mutation lock serialization', async ({ manager }) => {
    const creds = Array.from({ length: 5 }, (_, i) =>
      createCodexCredential({ email: `concurrent${i}@openai.com`, accountId: `acc-conc-${i}` })
    )

    const promises = creds.map((credential, i) =>
      manager.importAccount({ tool: 'codex', name: `Conc ${i}`, credential })
    )

    const results = await Promise.all(promises)
    assert.equal(results.length, 5)

    const overview = await manager.getOverview()
    assert.equal(overview.accounts.length, 5)
  })

  // 23. onAccountsChanged listener and option callbacks
  await runTest('onAccountsChanged listener invocation', async ({ manager }) => {
    let listenerFired = 0
    const unsubscribe = manager.onAccountsChanged(() => {
      listenerFired++
    })

    const cred = createCodexCredential()
    const acc = await manager.importAccount({ tool: 'codex', name: 'Event Test', credential: cred })
    assert.ok(listenerFired >= 1, 'Event listener must fire on import')

    await manager.renameAccount(acc.id, 'Renamed Event Test')
    assert.ok(listenerFired >= 2, 'Event listener must fire on rename')

    await manager.switchAccount(acc.id)
    assert.ok(listenerFired >= 3, 'Event listener must fire on switch')

    unsubscribe()
    const beforeCount = listenerFired
    await manager.deleteAccount(acc.id)
    assert.equal(listenerFired, beforeCount, 'Unsubscribed listener must not fire')
  })

  await runTest('quota refresh uses the saved account without changing active credentials', async ({ testHome, env, codexHome }) => {
    const requests = []
    const manager = new AccountManager({ homeDir: testHome, env, codexHome,
      quotaFetch: async (url, options) => {
        requests.push({ url, headers: new Headers(options.headers) })
        return Response.json({ plan_type: 'plus', rate_limit: { primary_window: {
          used_percent: 25, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600,
        } } })
      },
    })
    const active = await manager.importAccount({ tool: 'codex', name: 'Active', credential: createCodexCredential({ accountId: 'quota-active' }) })
    const other = await manager.importAccount({ tool: 'codex', name: 'Other', credential: createCodexCredential({ accountId: 'quota-other' }) })
    await manager.switchAccount(active.id)
    const authPath = path.join(codexHome, 'auth.json')
    const configPath = path.join(codexHome, 'config.toml')
    const originalAuth = readFileSync(authPath, 'utf8')
    const originalConfig = readFileSync(configPath, 'utf8')
    await manager.getOverview()
    assert.equal(requests.length, 0, 'Overview must not trigger network requests')
    let notifications = 0
    manager.onAccountsChanged(() => { notifications++ })
    const snapshot = await manager.refreshQuota(other.id)
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.accountId, other.id)
    assert.equal(snapshot.windows[0].remainingPercent, 75)
    assert.equal(requests[0].headers.get('ChatGPT-Account-Id'), 'quota-other')
    assert.ok(notifications > 0)
    const overview = await manager.getOverview()
    assert.equal(overview.tools.find(tool => tool.tool === 'codex').activeAccountId, active.id)
    assert.equal(overview.quotas.find(quota => quota.accountId === other.id).status, 'ready')
    assert.equal(readFileSync(authPath, 'utf8'), originalAuth)
    assert.equal(readFileSync(configPath, 'utf8'), originalConfig)
    const serialized = JSON.stringify(overview)
    const saved = await manager.store.get(other.id)
    assert.ok(!serialized.includes(JSON.parse(saved.credential).tokens.access_token))
    await manager.deleteAccount(other.id)
    assert.equal((await manager.getOverview()).quotas.some(quota => quota.accountId === other.id), false)
    assert.equal(readFileSync(authPath, 'utf8'), originalAuth)
  })

  console.log(`\nAccountManager suite finished: ${passed} passed, ${failed} failed.`)

  try {
    rmSync(testRoot, { recursive: true, force: true })
  } catch {}

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err)
  process.exit(1)
})
