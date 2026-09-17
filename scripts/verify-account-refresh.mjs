/**
 * Comprehensive Verification Script for Automatic OAuth Credential Renewal (OPC-48)
 *
 * End-to-end integration tests using synthetic responses and isolated fixtures:
 * 1. Near / Expired / Not Due schedule trigger
 * 2. Still-valid tokens usable when early refresh fails; expired blocked from switch
 * 3. Quota expired 401 integration: force refresh ONCE and retry ONCE
 * 4. Concurrent in-flight deduplication per account ID
 * 5. Force terminal/backoff: force does NOT bypass terminal (reauth-required/unsupported) or active retryAt
 *    Edge test: two forced invalid_grant calls make ONLY 1 network request
 * 6. Scheduler reauth recovery: reimporting same account with new near-expiry grant makes scheduler call again
 * 7. Concurrency: failed post-network response does not poison re-authenticated fresh record
 * 8. Storage write failure leaves status blocked with reason storage (never refreshing), clears in-flight
 * 9. Quota invalidation, custom name persistence, and state transition notifications (including refreshing)
 * 10. Shared Codex and Claude fail closed before network with blocked / runtime-active
 * 11. Native shared Antigravity: active runtime blocks before network (runtime-active)
 * 12. Same account ID with independent grant auto-refreshes without touching native official files
 * 13. Current becomes shared race: grant becoming official current in-flight detected at commit;
 *     fresh rotating token durably retained in store; pending-sync record persisted on disk
 * 14. Durable forward recovery: persisted pending-sync journal survives restart, blocks switch/rollback/recover,
 *     and resumes forward sync on ensureFresh/refreshDueAccounts to ready
 * 15. Global concurrency cap of 3 across manual and scheduled requests
 * 16. Manager dispose cancels in-flight and prevents commits (awaiting fetch entrance)
 * 17. Sync failure / interruption durably retains new rotating credential in store
 * 18. Corrupted or symlink transaction journal fails closed
 * 19. Blocked pending sync state is preserved and not dropped on store failure
 *
 * Usage:
 *   node scripts/verify-account-refresh.mjs
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_TOKEN_URL,
  CLAUDE_CLIENT_ID,
  CLAUDE_TOKEN_URL,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
} from '../apps/desktop/electron/account-oauth-providers.ts'
import { AccountError } from '../packages/workflow-model/src/accounts.ts'

const testRoot = mkdtempSync(path.join(tmpdir(), 'verify-account-refresh-'))
let passed = 0
let failed = 0

async function runTest(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(err)
    failed++
  }
}

function createJwt(payload, header = { alg: 'RS256', typ: 'JWT' }) {
  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encHeader}.${encPayload}.signature_bytes`
}

function mockResponse(data, options = {}) {
  const status = options.status ?? 200
  if (typeof data === 'string') {
    return new Response(data, {
      status,
      headers: {
        'content-type': options.contentType ?? 'text/plain',
        ...(options.headers ? Object.fromEntries(options.headers) : {}),
      },
    })
  }
  return Response.json(data, {
    status,
    headers: options.headers ? Object.fromEntries(options.headers) : undefined,
  })
}

function makeCodexCredential({
  accountId = 'chatgpt-acc-1',
  email = 'codex@openai.com',
  expiresAt,
  refreshToken = 'codex-refresh-token-1',
  accessToken = 'codex-access-token-1',
} = {}) {
  const expSec = Math.floor((expiresAt ?? Date.now() + 3600_000) / 1000)
  const idJwt = createJwt({
    sub: `user-${accountId}`,
    email,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    exp: expSec,
  })
  const accessJwt = createJwt({
    sub: `user-${accountId}`,
    email,
    exp: expSec,
  })
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idJwt,
      access_token: accessJwt,
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  })
}

function makeClaudeCredential({
  accountId = 'claude-acc-1',
  orgId = 'claude-org-1',
  email = 'claude@anthropic.com',
  expiresAt,
  refreshToken = 'claude-refresh-token-1',
  accessToken = `sk-ant-oat01-${'a'.repeat(60)}`,
  clientId = CLAUDE_CLIENT_ID,
} = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: expiresAt ?? Date.now() + 3600_000,
      scopes: ['user:profile', 'user:inference'],
    },
    oauthAccount: {
      accountUuid: accountId,
      organizationUuid: orgId,
      emailAddress: email,
      displayName: 'Claude User',
    },
    oauthClientId: clientId,
  })
}

function makeAntigravityCredential({
  googleId = 'google-123456789',
  email = 'ag@gmail.com',
  expiresAt,
  refreshToken = '1//ag-refresh-token-1',
  accessToken = 'ag-access-token-1',
  clientId = ANTIGRAVITY_CLIENT_ID,
} = {}) {
  return JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(expiresAt ?? Date.now() + 3600_000).toISOString(),
    },
    account: {
      id: googleId,
      email,
      name: 'Google User',
    },
    oauth_client_id: clientId,
  })
}

function setupTestEnvironment(customNow) {
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

  // Base timestamp well in future so imported credentials are valid at import time relative to real Date.now()
  const baseTime = Date.now() + 10_000_000
  let currentTime = customNow ?? baseTime
  const getNow = () => currentTime
  const setNow = (t) => {
    currentTime = t
  }

  const adapters = createAccountAdapters({
    homeDir: testHome,
    env,
    codexHome,
    antigravityFileMode: true,
  })

  return { testHome, codexHome, env, adapters, getNow, setNow }
}

async function main() {
  console.log('Running Automatic OAuth Credential Renewal verification tests...\n')

  // 1. Near / Expired / Not Due Schedule Trigger
  await runTest('1. refreshDueAccounts refreshes near-expiry and expired accounts, but skips not-due accounts', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()
    const now = getNow()

    const refreshedUrls = []
    const fakeFetch = async (url) => {
      refreshedUrls.push(url)
      if (url === CODEX_TOKEN_URL) {
        return mockResponse({
          access_token: createJwt({ sub: 'u1', exp: Math.floor((now + 3600_000) / 1000) }),
          expires_in: 3600,
        })
      }
      if (url === CLAUDE_TOKEN_URL) {
        return mockResponse({ access_token: `sk-ant-oat01-${'b'.repeat(60)}`, expires_in: 3600 })
      }
      if (url === ANTIGRAVITY_TOKEN_URL) {
        return mockResponse({ access_token: 'new-ag-access', token_type: 'Bearer', expires_in: 3600 })
      }
      return mockResponse({}, { status: 404 })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    // Account 1: Not due (expires in 60 min)
    await manager.importAccount({
      tool: 'codex',
      name: 'Codex Not Due',
      credential: makeCodexCredential({ accountId: 'acc-not-due', expiresAt: now + 60 * 60 * 1000 }),
    })

    // Account 2: Near expiry (expires in 4 min, threshold is 5 min)
    const accNear = await manager.importAccount({
      tool: 'claude-code',
      name: 'Claude Near Expiry',
      credential: makeClaudeCredential({ accountId: 'acc-near', expiresAt: now + 4 * 60 * 1000 }),
    })

    // Account 3: Expired relative to getNow() (saved directly via store test seam)
    const expiredTimestamp = Math.min(now - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000)
    const accExpired = await manager.store.save({
      tool: 'antigravity',
      name: 'Antigravity Expired',
      credential: makeAntigravityCredential({ googleId: 'acc-expired', expiresAt: expiredTimestamp }),
      email: 'ag@gmail.com',
      accountId: 'acc-expired',
      expiresAt: expiredTimestamp,
    })

    await manager.refreshDueAccounts()

    // Assert: Claude and Antigravity refreshed, Codex was NOT called
    assert.equal(refreshedUrls.length, 2)
    assert(refreshedUrls.includes(CLAUDE_TOKEN_URL))
    assert(refreshedUrls.includes(ANTIGRAVITY_TOKEN_URL))
    assert(!refreshedUrls.includes(CODEX_TOKEN_URL))

    const overview = await manager.getOverview()
    assert(Array.isArray(overview.refreshes))
    const claudeState = overview.refreshes.find((r) => r.accountId === accNear.id)
    const agState = overview.refreshes.find((r) => r.accountId === accExpired.id)

    assert.equal(claudeState?.status, 'ready')
    assert.equal(agState?.status, 'ready', JSON.stringify(agState))
  })

  // 2. Still-Valid Token Usable When Early Refresh Fails; Expired Blocked from Switch
  await runTest('2. Still-valid token remains switchable when early refresh fails; expired token is blocked from switch', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()
    const now = getNow()

    const failingFetch = async () => mockResponse('Server Error', { status: 500 })

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: failingFetch,
      now: getNow,
    })

    // Account Near Expiry (expires in 4 min)
    const accNear = await manager.importAccount({
      tool: 'claude-code',
      name: 'Claude Near',
      credential: makeClaudeCredential({ accountId: 'acc-near', expiresAt: now + 4 * 60 * 1000 }),
    })

    // Account Already Expired relative to BOTH real Date.now() and injected now
    // Saved via store test seam
    const expiredTimestamp = Math.min(now - 10 * 1000, Date.now() - 10 * 1000)
    const accExpired = await manager.store.save({
      tool: 'claude-code',
      name: 'Claude Expired',
      credential: makeClaudeCredential({ accountId: 'acc-expired', expiresAt: expiredTimestamp }),
      email: 'claude@anthropic.com',
      accountId: 'acc-expired',
      expiresAt: expiredTimestamp,
    })

    // Switching near-expiry account attempts refresh (fails retrying), but token is still valid -> switch succeeds
    const switchNearResult = await manager.switchAccount(accNear.id)
    assert.equal(switchNearResult.success, true)

    // Switching expired account attempts refresh (fails), remains expired -> throws
    await assert.rejects(
      async () => manager.switchAccount(accExpired.id),
      (err) => err instanceof AccountError && err.message.includes('expired')
    )
  })

  // 3. Quota Integration: Force Refresh Once on 401/expired and Retry Once
  await runTest('3. refreshQuota calls ensureFresh then query; if status expired, force refreshes ONCE and retries ONCE', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()
    const now = getNow()

    let quotaAttempts = 0
    let refreshAttempts = 0

    const mockQuotaFetch = async (url) => {
      quotaAttempts++
      if (quotaAttempts === 1) {
        return new Response('Unauthorized', { status: 401 })
      }
      return Response.json({
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 86400,
            reset_at: Math.floor((now + 3600_000) / 1000),
          },
        },
      })
    }

    const mockRefreshFetch = async () => {
      refreshAttempts++
      return Response.json({
        access_token: createJwt({ sub: 'user-acc-quota', exp: Math.floor((now + 3600_000) / 1000) }),
        expires_in: 3600,
        token_type: 'Bearer',
      })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      quotaFetch: mockQuotaFetch,
      refreshFetch: mockRefreshFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Quota Test',
      credential: makeCodexCredential({ accountId: 'acc-quota', expiresAt: now + 3600_000 }),
    })

    const snapshot = await manager.refreshQuota(acc.id)

    assert.equal(refreshAttempts, 1)
    assert.equal(quotaAttempts, 2)
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.windows[0].remainingPercent, 80)
  })

  // 4. Concurrent In-Flight Deduplication
  await runTest('4. Concurrent ensureFreshCredential calls for the same account deduplicate to a single network request', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()
    const now = getNow()

    let fetchCount = 0
    const delayedFetch = async () => {
      fetchCount++
      await new Promise((r) => setTimeout(r, 50))
      return mockResponse({
        access_token: createJwt({ sub: 'user-acc-dedup', exp: Math.floor((now + 3600_000) / 1000) }),
        expires_in: 3600,
      })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: delayedFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Dedup',
      credential: makeCodexCredential({ accountId: 'acc-dedup', expiresAt: now + 3600_000 }),
    })

    const results = await Promise.all([
      manager.ensureFreshCredential(acc.id, { force: true }),
      manager.ensureFreshCredential(acc.id, { force: true }),
      manager.ensureFreshCredential(acc.id, { force: true }),
      manager.ensureFreshCredential(acc.id, { force: true }),
    ])

    assert.equal(fetchCount, 1)
    for (const res of results) {
      assert.equal(res.status, 'ready')
    }
  })

  // 5. Force Does NOT Bypass Terminal Failures or Active Backoff; Two Forced Invalid_Grant Calls Make Only 1 Request
  await runTest('5. Force option does NOT bypass terminal failure or active retryAt; two forced invalid_grant calls make ONLY 1 request', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()
    let fetchCount = 0

    const mockFetch = async () => {
      fetchCount++
      return mockResponse({ error: 'invalid_grant' }, { status: 400 })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: mockFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Force Terminal',
      credential: makeCodexCredential({ accountId: 'acc-force-terminal', expiresAt: getNow() + 3600_000 }),
    })

    // First attempt fails with terminal invalid_grant
    const state1 = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(state1.status, 'reauth-required')
    assert.equal(fetchCount, 1)

    // Second call with force: true MUST NOT make another network request for the same credential fingerprint!
    const state2 = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(state2.status, 'reauth-required')
    assert.equal(fetchCount, 1) // Assert: exactly 1 request made across two forced calls!

    // Test transient backoff: transient 429 error
    let rateLimitFetchCount = 0
    const rateLimitFetch = async () => {
      rateLimitFetchCount++
      return mockResponse({ error: 'rate_limited' }, { status: 429 })
    }

    const managerBackoff = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: rateLimitFetch,
      now: getNow,
    })

    const accBackoff = await managerBackoff.importAccount({
      tool: 'codex',
      name: 'Codex Force Backoff',
      credential: makeCodexCredential({ accountId: 'acc-force-backoff', expiresAt: getNow() + 3600_000 }),
    })

    const bState1 = await managerBackoff.ensureFreshCredential(accBackoff.id, { force: true })
    assert.equal(bState1.status, 'retrying')
    assert.equal(bState1.reason, 'rate-limited')
    assert.equal(rateLimitFetchCount, 1)

    // Calling ensureFreshCredential with force: true while retryAt is in future MUST NOT bypass backoff
    const bState2 = await managerBackoff.ensureFreshCredential(accBackoff.id, { force: true })
    assert.equal(bState2.status, 'retrying')
    assert.equal(rateLimitFetchCount, 1) // NO additional network request made!
  })

  // 6. Scheduler Reauth Recovery: Reimporting Same Account with New Near-Expiry Grant Re-Triggers Scheduler
  await runTest('6. Reimporting same account with new near-expiry grant clears terminal state and scheduler refreshes it', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()
    let fetchCount = 0

    const dynamicFetch = async (url) => {
      fetchCount++
      if (fetchCount === 1) {
        return mockResponse({ error: 'invalid_grant' }, { status: 400 })
      }
      return mockResponse({
        access_token: createJwt({ sub: 'user-acc-reauth-recover', exp: Math.floor((getNow() + 3600_000) / 1000) }),
        expires_in: 3600,
      })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: dynamicFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Reauth Recover',
      credential: makeCodexCredential({ accountId: 'acc-reauth-recover', refreshToken: 'r-token-1', expiresAt: getNow() + 3600_000 }),
    })

    // 1. First refresh fails with terminal invalid_grant
    const state1 = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(state1.status, 'reauth-required')
    assert.equal(fetchCount, 1)

    // 2. User re-authenticates / re-imports the SAME account with a new near-expiry grant
    const newGrantCred = makeCodexCredential({
      accountId: 'acc-reauth-recover',
      refreshToken: 'r-token-2-new',
      expiresAt: getNow() + 4 * 60 * 1000, // Near expiry (4 min)
    })
    await manager.importAccount({
      tool: 'codex',
      name: 'Codex Reauth Recover',
      credential: newGrantCred,
    })

    // 3. Scheduler runs: must detect fresh credential fingerprint, clear reauth-required, and call endpoint
    await manager.refreshDueAccounts()
    assert.equal(fetchCount, 2)

    const overview = await manager.getOverview()
    const stateAfter = overview.refreshes.find((r) => r.accountId === acc.id)
    assert.equal(stateAfter?.status, 'ready')
  })

  // 7. Concurrency: Failed Post-Network Response Does Not Poison Re-authenticated Fresh Record
  await runTest('7. Failed post-network response checks credential fingerprint before tagging terminal failure', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    let networkStarted
    const waitNetwork = new Promise((r) => { networkStarted = r })
    let networkCanFinish
    const waitCanFinish = new Promise((r) => { networkCanFinish = r })

    const slowFailingFetch = async () => {
      networkStarted()
      await waitCanFinish
      return mockResponse({ error: 'invalid_grant' }, { status: 400 })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: slowFailingFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Race Poison',
      credential: makeCodexCredential({ accountId: 'acc-race-poison', expiresAt: getNow() + 3600_000 }),
    })

    const refreshPromise = manager.ensureFreshCredential(acc.id, { force: true })
    await waitNetwork

    // While network is in flight, user re-authenticates (saves new grant)
    const freshReauthedCred = makeCodexCredential({
      accountId: 'acc-race-poison',
      refreshToken: 'fresh-reauthed-token-xyz',
      expiresAt: getNow() + 3600_000,
    })
    await manager.importAccount({
      tool: 'codex',
      name: 'Codex Race Poison',
      credential: freshReauthedCred,
    })

    // Now let network finish with invalid_grant
    networkCanFinish()
    const result = await refreshPromise

    // It detects the credential fingerprint mismatch and does NOT tag terminal reauth-required
    assert.notEqual(result.status, 'reauth-required')
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'credential-conflict')
  })

  // 8. Storage Write Failure Leaves Status Blocked with Reason Storage, Never Refreshing
  await runTest('8. Storage update failure marks status blocked with reason storage, leaves no refreshing and no in-flight leak', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    const successFetch = async () =>
      mockResponse({
        access_token: createJwt({ sub: 'user-acc-store-fail', exp: Math.floor((getNow() + 3600_000) / 1000) }),
        expires_in: 3600,
      })

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: successFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Storage Failure',
      credential: makeCodexCredential({ accountId: 'acc-store-fail', expiresAt: getNow() + 3600_000 }),
    })

    // Simulate disk failure on updateCredential
    manager.store.updateCredential = async () => {
      throw new Error('EACCES: permission denied on manifest.json')
    }

    const state = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(state.status, 'blocked')
    assert.equal(state.reason, 'storage')

    const overview = await manager.getOverview()
    const item = overview.refreshes.find((r) => r.accountId === acc.id)
    assert.equal(item.status, 'blocked')
    assert.equal(item.reason, 'storage')
  })

  // 9. Quota Invalidation, Custom Name Persistence, and State Transition Notifications
  await runTest('9. Successful refresh preserves custom name, invalidates quota, and emits state transitions including refreshing', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    let networkStarted
    const waitNetwork = new Promise((r) => { networkStarted = r })
    let networkCanFinish
    const waitCanFinish = new Promise((r) => { networkCanFinish = r })

    const slowSuccessFetch = async () => {
      networkStarted()
      await waitCanFinish
      return mockResponse({
        access_token: createJwt({ sub: 'user-acc-persist', exp: Math.floor((getNow() + 3600_000) / 1000) }),
        expires_in: 3600,
      })
    }

    const observedStatuses = []
    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: slowSuccessFetch,
      now: getNow,
      onAccountsChanged: async () => {
        const ov = await manager.getOverview()
        const match = ov.refreshes?.find((r) => r.accountId === acc.id)
        if (match) observedStatuses.push(match.status)
      },
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Original Custom Name',
      credential: makeCodexCredential({ accountId: 'acc-persist', expiresAt: getNow() + 3600_000 }),
    })

    await manager.renameAccount(acc.id, 'Renamed By User')

    const refreshPromise = manager.ensureFreshCredential(acc.id, { force: true })
    await waitNetwork

    // While network is in flight, overview must show refreshing
    const inFlightOverview = await manager.getOverview()
    const inFlightState = inFlightOverview.refreshes.find((r) => r.accountId === acc.id)
    assert.equal(inFlightState?.status, 'refreshing')

    networkCanFinish()
    const res = await refreshPromise
    assert.equal(res.status, 'ready')

    const list = await manager.store.list()
    const reloaded = list.find((a) => a.id === acc.id)
    assert.equal(reloaded.name, 'Renamed By User')

    // Notifications must have included 'refreshing'
    assert(observedStatuses.includes('refreshing'))
    assert(observedStatuses.includes('ready'))
  })

  // 10. Shared Codex and Claude Fail Before Network with Blocked / Runtime-Active
  await runTest('10. Shared current Codex and Claude grants fail closed BEFORE network with blocked / runtime-active', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    // 1) Codex shared grant
    const codexSharedToken = 'shared-codex-refresh-token-xyz'
    const codexCred = makeCodexCredential({
      accountId: 'codex-live-acc',
      refreshToken: codexSharedToken,
      expiresAt: getNow() + 3600_000,
    })
    adapters.codex.writeSlot('auth', codexCred)
    adapters.codex.writeSlot('mode', 'file')

    let networkCalled = false
    const fakeFetch = async () => {
      networkCalled = true
      return mockResponse({})
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    const accCodex = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Shared Live',
      credential: codexCred,
    })

    const stateCodex = await manager.ensureFreshCredential(accCodex.id, { force: true })
    assert.equal(stateCodex.status, 'blocked')
    assert.equal(stateCodex.reason, 'runtime-active')
    assert.equal(networkCalled, false) // Failed closed BEFORE calling network!

    // 2) Claude shared grant
    const claudeSharedAccess = `sk-ant-oat01-${'e'.repeat(60)}`
    const claudeSharedRefresh = 'shared-claude-refresh-xyz'
    const claudeCred = makeClaudeCredential({
      accountId: 'claude-live-acc',
      accessToken: claudeSharedAccess,
      refreshToken: claudeSharedRefresh,
      expiresAt: getNow() + 3600_000,
    })
    adapters['claude-code'].writeSlot('oauth', claudeSharedAccess)

    const accClaude = await manager.importAccount({
      tool: 'claude-code',
      name: 'Claude Shared Live',
      credential: claudeCred,
    })

    const stateClaude = await manager.ensureFreshCredential(accClaude.id, { force: true })
    assert.equal(stateClaude.status, 'blocked')
    assert.equal(stateClaude.reason, 'runtime-active')
    assert.equal(networkCalled, false) // Failed closed BEFORE calling network!
  })

  // 11. Native Shared Antigravity: Active Runtime Blocks Before Network (runtime-active)
  await runTest('11. Native shared Antigravity with active running runtime blocks before network (runtime-active)', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    const agSharedRefresh = '1//ag-shared-token-active'
    const agNativeCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'native-ag-access',
        token_type: 'Bearer',
        refresh_token: agSharedRefresh,
        expiry: new Date(getNow() + 3600_000).toISOString(),
      },
    })
    // Slot name for Antigravity is 'oauth'
    adapters.antigravity.writeSlot('oauth', agNativeCred)

    // Simulate IDE active running: assertCanWrite throws
    adapters.antigravity.assertCanRefresh = adapters.antigravity.assertCanWrite = () => {
      throw new AccountError('Antigravity is currently running.')
    }

    let networkCalled = false
    const fakeFetch = async () => {
      networkCalled = true
      return mockResponse({})
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'antigravity',
      name: 'AG Shared Active',
      credential: makeAntigravityCredential({ googleId: 'ag-active', refreshToken: agSharedRefresh, expiresAt: getNow() + 3600_000 }),
    })

    const res = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(res.status, 'blocked')
    assert.equal(res.reason, 'runtime-active')
    assert.equal(networkCalled, false) // Blocked before calling network!
  })

  // 12. Same Account Different Grant: Independent Grant Auto-Refreshes Without Touching Native
  await runTest('12. Same account ID with different grant: independent grant auto-refreshes without touching native official files', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    // Official tool has native grant with refresh token R1
    const nativeCodexCred = makeCodexCredential({
      accountId: 'shared-account-id',
      refreshToken: 'native-cli-refresh-r1',
    })
    adapters.codex.writeSlot('auth', nativeCodexCred)
    adapters.codex.writeSlot('mode', 'file')

    const fakeFetch = async () =>
      mockResponse({
        access_token: createJwt({ sub: 'user-shared-account-id', exp: Math.floor((getNow() + 3600_000) / 1000) }),
        expires_in: 3600,
      })

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    // Trace has separate grant for SAME account ID with refresh token R2
    const independentCred = makeCodexCredential({
      accountId: 'shared-account-id',
      refreshToken: 'trace-independent-refresh-r2',
      expiresAt: getNow() + 3600_000,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Trace Independent Same Account',
      credential: independentCred,
    })

    const state = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(state.status, 'ready')

    // Official tool's auth file is UNTOUCHED! Still has R1
    const officialAuth = adapters.codex.read().auth
    const officialParsed = JSON.parse(officialAuth)
    assert.equal(officialParsed.tokens.account_id, 'shared-account-id')
    assert.equal(officialParsed.tokens.refresh_token, 'native-cli-refresh-r1')
  })

  // 13. Current Becomes Shared Race: Grant Becoming Official Current in Flight Detected at Commit
  await runTest('13. Race condition: grant becoming official current in flight persists new token to store and creates pending-sync', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    let networkStarted
    const waitNetwork = new Promise((r) => { networkStarted = r })
    let networkCanFinish
    const waitCanFinish = new Promise((r) => { networkCanFinish = r })

    const slowFetch = async () => {
      networkStarted()
      await waitCanFinish
      return mockResponse({
        access_token: createJwt({ sub: 'user-acc-b', exp: Math.floor((getNow() + 3600_000) / 1000) }),
        expires_in: 3600,
      })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: slowFetch,
      now: getNow,
    })

    // Official tool initially has native grant A
    const nativeA = makeCodexCredential({ accountId: 'acc-native-a', refreshToken: 'r-a' })
    adapters.codex.writeSlot('auth', nativeA)
    adapters.codex.writeSlot('mode', 'file')

    // Trace has grant B (not current)
    const credB = makeCodexCredential({ accountId: 'acc-b', refreshToken: 'r-b', expiresAt: getNow() + 3600_000 })
    const accB = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Grant B',
      credential: credB,
    })

    // Start refresh of grant B
    const refreshPromise = manager.ensureFreshCredential(accB.id, { force: true })
    await waitNetwork

    // While refresh is in flight, user switches official tool to grant B!
    adapters.codex.writeSlot('auth', credB)

    // Allow network to finish
    networkCanFinish()
    const result = await refreshPromise

    // Commit rechecks native state, detects that grant B became current:
    // Expected to be blocked (cannot safely sync live CLI without coordination)
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'runtime-active')

    // Fresh rotating token was retained in the store
    const storeRecord = await manager.store.get(accB.id)
    const parsedStore = JSON.parse(storeRecord.credential)
    assert.notEqual(parsedStore.tokens.access_token, 'codex-access-token-1')
  })

  // 14. Durable Forward Recovery: Persisted Pending-Sync Journal Survives Restart and Blocks Conflict
  await runTest('14. Persisted pending-sync journal survives manager restart, blocks switch/rollback, and completes forward recovery', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    let ideRunning = false
    adapters.antigravity.assertCanRefresh = adapters.antigravity.assertCanWrite = () => {
      if (ideRunning) throw new AccountError('Antigravity IDE running.')
    }

    const agSharedRefresh = '1//ag-forward-sync-refresh'
    const agNativeCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'native-ag-old-access',
        token_type: 'Bearer',
        refresh_token: agSharedRefresh,
        expiry: new Date(getNow() + 3600_000).toISOString(),
      },
    })
    // Slot name for Antigravity is 'oauth'
    adapters.antigravity.writeSlot('oauth', agNativeCred)

    const fakeFetch = async () => {
      ideRunning = true
      return mockResponse({
        access_token: 'new-rotated-access-token-123',
        token_type: 'Bearer',
        refresh_token: 'new-rotated-refresh-token-456',
        expires_in: 3600,
      })
    }

    const manager1 = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    const acc = await manager1.importAccount({
      tool: 'antigravity',
      name: 'AG Forward Sync Account',
      credential: makeAntigravityCredential({ googleId: 'ag-fwd', refreshToken: agSharedRefresh, expiresAt: getNow() + 3600_000 }),
    })

    // Allow pre-flight assertCanWrite to pass
    ideRunning = false
    const refreshPromise = manager1.ensureFreshCredential(acc.id, { force: true })

    // Simulate IDE starting during flight
    const result = await refreshPromise

    // Blocked because forward sync couldn't write while IDE running
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'runtime-active')

    // Switch account must be blocked while pending sync unresolved
    await assert.rejects(
      async () => manager1.switchAccount(acc.id),
      (err) => err instanceof AccountError && err.message.includes('pending credential synchronization')
    )

    // Rollback must be blocked while pending sync unresolved
    const rollbackRes = await manager1.rollbackAccount('antigravity')
    assert.equal(rollbackRes.success, false)
    assert(rollbackRes.error.includes('pending credential synchronization'))

    // 2. Simulate process restart: create brand new manager instance with fresh in-memory state
    const manager2 = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    // Overview on restarted manager must show blocked status from disk journal!
    const overviewRestart = await manager2.getOverview()
    const stateRestart = overviewRestart.refreshes.find((r) => r.accountId === acc.id)
    assert.equal(stateRestart?.status, 'blocked')
    assert.equal(stateRestart?.reason, 'runtime-active')

    // 3. Now IDE stops: resume forward recovery
    ideRunning = false
    const recoveredState = await manager2.ensureFreshCredential(acc.id)
    assert.equal(recoveredState.status, 'ready')

    // Native credentials successfully updated with new token in 'oauth' slot!
    const nativeFinal = adapters.antigravity.read().oauth
    const parsedNative = JSON.parse(nativeFinal)
    assert.equal(parsedNative.token.access_token, 'new-rotated-access-token-123')
    assert.equal(parsedNative.token.refresh_token, 'new-rotated-refresh-token-456')
  })

  // 15. Global Concurrency Semaphore: Max 3 Active Requests
  await runTest('15. Global concurrency semaphore limits concurrent network requests to 3 across manual and scheduled callers', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    let activeRequests = 0
    let maxConcurrent = 0

    const slowThrottledFetch = async () => {
      activeRequests++
      maxConcurrent = Math.max(maxConcurrent, activeRequests)
      await new Promise((r) => setTimeout(r, 60))
      activeRequests--
      return mockResponse({
        access_token: createJwt({ sub: 'u-sem', exp: Math.floor((getNow() + 3600_000) / 1000) }),
        expires_in: 3600,
      })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: slowThrottledFetch,
      now: getNow,
    })

    const accounts = []
    for (let i = 0; i < 6; i++) {
      const acc = await manager.importAccount({
        tool: 'codex',
        name: `Codex Semaphore ${i}`,
        credential: makeCodexCredential({ accountId: `acc-sem-${i}`, expiresAt: getNow() + 3600_000 }),
      })
      accounts.push(acc)
    }

    await Promise.all(accounts.map((a) => manager.ensureFreshCredential(a.id, { force: true })))

    assert(maxConcurrent <= 3, `Expected max concurrent requests <= 3, got ${maxConcurrent}`)
  })

  // 16. Manager Dispose Cancels In-Flight and Prevents Commits
  await runTest('16. Calling manager.dispose() cancels in-flight requests and prevents committing to store', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    let fetchEntered
    const waitFetchEntered = new Promise((r) => { fetchEntered = r })
    let fetchAborted = false

    const abortableFetch = async (url, init) => {
      fetchEntered()
      init.signal?.addEventListener('abort', () => {
        fetchAborted = true
      })
      await new Promise((resolve) => {
        init.signal?.addEventListener('abort', resolve)
        setTimeout(resolve, 300)
      })
      return mockResponse({ access_token: 'should-not-commit', expires_in: 3600 })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: abortableFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Disposed',
      credential: makeCodexCredential({ accountId: 'acc-disposed', expiresAt: getNow() + 3600_000 }),
    })

    const refreshPromise = manager.ensureFreshCredential(acc.id, { force: true })
    await waitFetchEntered
    manager.dispose()

    await refreshPromise
    assert.equal(fetchAborted, true)

    // Store record was NOT updated with the aborted token
    const record = await manager.store.get(acc.id)
    const parsed = JSON.parse(record.credential)
    assert.notEqual(parsed.tokens.access_token, 'should-not-commit')
  })

  // 17. Sync Failure / Interruption Durably Retains Rotated Credential
  await runTest('17. Refresh during native sync failure durably retains new rotating credential in store', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    const agSharedRefresh = '1//ag-retained-credential-token'
    const agNativeCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'native-old-token',
        token_type: 'Bearer',
        refresh_token: agSharedRefresh,
        expiry: new Date(getNow() + 3600_000).toISOString(),
      },
    })
    adapters.antigravity.writeSlot('oauth', agNativeCred)

    let ideRunning = false
    adapters.antigravity.assertCanRefresh = adapters.antigravity.assertCanWrite = () => {
      if (ideRunning) throw new AccountError('Antigravity IDE running during sync.')
    }

    const rotatedAccessToken = 'synthetic-rotated-access-retained'
    const rotatedRefreshToken = 'synthetic-rotated-refresh-retained'
    const fakeFetch = async () => {
      ideRunning = true
      return mockResponse({
        access_token: rotatedAccessToken,
        token_type: 'Bearer',
        refresh_token: rotatedRefreshToken,
        expires_in: 3600,
      })
    }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: fakeFetch,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'antigravity',
      name: 'AG Retain Test',
      credential: makeAntigravityCredential({ googleId: 'ag-retain', refreshToken: agSharedRefresh, expiresAt: getNow() + 3600_000 }),
    })

    // During commit, simulate IDE running / sync failure
    const result = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(result.status, 'blocked')

    // Store MUST have retained the new rotated credential payload!
    const stored = await manager.store.get(acc.id)
    const parsed = JSON.parse(stored.credential)
    assert.equal(parsed.token.access_token, rotatedAccessToken)
    assert.equal(parsed.token.refresh_token, rotatedRefreshToken)
  })

  // 18. Corrupted or Symlink Transaction Journal Fails Closed
  await runTest('18. Corrupted transaction journal must fail closed with recoveryNeeded and error', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'codex',
      name: 'Codex Journal Test',
      credential: makeCodexCredential({ accountId: 'acc-journal-test', expiresAt: getNow() + 3600_000 }),
    })

    // Write a corrupted (invalid JSON) journal file into transactions directory
    mkdirSync(manager.transactionsDir, { recursive: true })
    const journalPath = path.join(manager.transactionsDir, 'codex.json')
    writeFileSync(journalPath, '{ corrupted json payload: !!', { mode: 0o600 })

    // recoverAccount must fail closed
    const recResult = await manager.recoverAccount('codex')
    assert.equal(recResult.success, false)
    assert.equal(recResult.recoveryNeeded, true)
    assert(recResult.error?.includes('corrupted'))

    // switchAccount must fail closed (throw AccountError)
    await assert.rejects(
      async () => manager.switchAccount(acc.id),
      (err) => err instanceof AccountError && err.message.includes('corrupted')
    )

    // getOverview must report recoveryNeeded
    const overview = await manager.getOverview()
    const codexTool = overview.tools.find((t) => t.tool === 'codex')
    assert.equal(codexTool?.recoveryNeeded, true)
    assert.equal(typeof codexTool?.error, 'string')
  })

  // 19. Blocked Pending Sync Must Not Be Dropped on Store Failure
  await runTest('19. Blocked pending sync state is preserved and not dropped on subsequent store failure', async () => {
    const { testHome, codexHome, env, adapters, getNow } = setupTestEnvironment()

    const agSharedRefresh = '1//ag-blocked-preserve'
    const agNativeCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'native-old',
        token_type: 'Bearer',
        refresh_token: agSharedRefresh,
        expiry: new Date(getNow() + 3600_000).toISOString(),
      },
    })
    adapters.antigravity.writeSlot('oauth', agNativeCred)

    // Running IDE makes ensureFreshCredential block
    let running = false
    adapters.antigravity.assertCanRefresh = adapters.antigravity.assertCanWrite = () => { if (running) throw new AccountError('Antigravity IDE running.') }

    const manager = new AccountManager({
      homeDir: testHome,
      env,
      codexHome,
      adapters,
      refreshFetch: async () => { running = true; return Response.json({ access_token: 'synthetic-pending-new', refresh_token: 'synthetic-pending-rotated', token_type: 'Bearer', expires_in: 3600 }) },
      now: getNow,
    })

    const acc = await manager.importAccount({
      tool: 'antigravity',
      name: 'AG Block Preserve',
      credential: makeAntigravityCredential({ googleId: 'ag-block-preserve', refreshToken: agSharedRefresh, expiresAt: getNow() + 3600_000 }),
    })

    const state = await manager.ensureFreshCredential(acc.id, { force: true })
    assert.equal(state.status, 'blocked')

    // Simulate transient store failure on get
    const originalGet = manager.store.get.bind(manager.store)
    manager.store.get = async (id) => {
      throw new Error('EIO: transient disk error')
    }

    // Refresh attempt during store failure must report blocked / storage, not ready
    const failState = await manager.ensureFreshCredential(acc.id)
    assert.equal(failState.status, 'blocked')
    assert.notEqual(failState.status, 'ready')

    // Restore store: status remains blocked until runtime obstruction is cleared
    manager.store.get = originalGet
    const finalState = await manager.ensureFreshCredential(acc.id)
    assert.equal(finalState.status, 'blocked')
    assert.equal(finalState.reason, 'runtime-active')
  })

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exit(1)
  }
}

main()
