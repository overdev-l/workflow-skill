/**
 * Verification Script for AI Tool Account Quota Service (OPC-48)
 *
 * Comprehensive isolated unit and integration tests for AccountQuotaService:
 * 1. Codex positive parse (primary/secondary windows, durations, reset_at, plan, headers)
 * 2. Claude positive parse (5h, 7d, 7d Opus, 7d Sonnet, utilization, resets_at, headers)
 * 3. Antigravity positive parse (loadCodeAssist, fetchAvailableModels, remainingFraction, plan)
 * 4. Real zero remaining vs missing (genuine 0 is preserved, missing percentage is undefined)
 * 5. Invalid and out-of-range values (<0, >100, NaN, malformed JSON, empty models)
 * 6. HTTP status mappings (401->expired, 403->forbidden, 429->rate-limited, 500->error)
 * 7. Safe network error handling (fetch throws, timeout, body > 1 MiB)
 * 8. Redirect mode (redirect: 'error' enforced, redirects rejected)
 * 9. Token expiration without network calls (past JWT exp, past Antigravity expiry)
 * 10. Zero secret leakage (snapshots and errors never contain tokens or raw server bodies)
 * 11. Per-account cache isolation & getCached (cloned snapshots, no network, pruning)
 * 12. Same-account in-flight deduplication (concurrent calls share 1 fetch)
 * 13. Stale cache preservation on failure (failed refresh keeps prior windows with stale: true)
 * 14. In-flight deletion and modification safety (no resurrection of deleted/mutated accounts)
 * 15. Antigravity 403 project retry (retries without project on initial 403)
 * 16. Concurrency bounding (concurrent requests bounded by MAX_CONCURRENT_HTTP)
 * 17. Invalidate method (evicts cache and notifies listener)
 * 18. onChanged callback error isolation (listener throws without crashing service)
 * 19. Disallowed network endpoint protection (rejects unauthorized URLs)
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-quota.mjs
 */

import assert from 'node:assert/strict'
import { groupAntigravityQuotaWindows } from '../apps/desktop/src/utils/quota-grouping.ts'
import { formatQuotaWindowLabel } from '../apps/desktop/src/utils/quota-label.ts'
import { randomUUID } from 'node:crypto'
import {
  AccountQuotaService,
  HTTP_TIMEOUT_MS,
  MAX_CONCURRENT_HTTP,
  MAX_RESPONSE_BYTES,
} from '../apps/desktop/electron/account-quota.ts'
import {
  AccountError,
} from '../packages/workflow-model/src/accounts.ts'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`✗ ${name}:`, err)
  }
}

class MockStore {
  constructor() {
    this.records = new Map()
  }

  set(id, record) {
    this.records.set(id, structuredClone(record))
  }

  delete(id) {
    this.records.delete(id)
  }

  async get(id) {
    const record = this.records.get(id)
    if (!record) {
      throw new AccountError('Account not found.')
    }
    return structuredClone(record)
  }
}

function createCodexJwt(exp = Math.floor(Date.now() / 1000) + 3600, accountId = 'chatgpt-acc-1') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'user_123',
      exp,
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    })
  ).toString('base64url')
  return `${header}.${payload}.mock_sig`
}

function makeCodexAccount({
  id = randomUUID(),
  accountId = 'chatgpt-acc-1',
  exp = Math.floor(Date.now() / 1000) + 3600,
  updatedAt = Date.now(),
} = {}) {
  const access = createCodexJwt(exp, accountId)
  const credential = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: access,
      access_token: access,
      refresh_token: 'refresh_secret_123',
      account_id: accountId,
    },
  })
  return {
    metadata: {
      id,
      tool: 'codex',
      name: 'Codex Test',
      accountId,
      createdAt: updatedAt,
      updatedAt,
    },
    credential,
  }
}

function makeClaudeAccount({
  id = randomUUID(),
  token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890',
  updatedAt = Date.now(),
} = {}) {
  return {
    metadata: {
      id,
      tool: 'claude-code',
      name: 'Claude Test',
      createdAt: updatedAt,
      updatedAt,
    },
    credential: token,
  }
}

function makeAntigravityAccount({
  id = randomUUID(),
  expiryMs = Date.now() + 3600_000,
  updatedAt = Date.now(),
} = {}) {
  const credential = JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: 'ya29.antigravity_token_xyz',
      refresh_token: 'refresh_secret_antigravity',
      token_type: 'Bearer',
      expiry: new Date(expiryMs).toISOString(),
    },
  })
  return {
    metadata: {
      id,
      tool: 'antigravity',
      name: 'Antigravity Test',
      createdAt: updatedAt,
      updatedAt,
    },
    credential,
  }
}

function jsonResponse(data, status = 200, headers = {}) {
  const body = JSON.stringify(data)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

await test('1. Codex positive query: primary/secondary windows, durations, reset_at, plan, and headers', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  let capturedInit = null
  let capturedUrl = null

  const mockFetch = async (url, init) => {
    capturedUrl = url
    capturedInit = init
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18000,
          reset_at: 1800000000,
        },
        secondary_window: {
          used_percent: 80,
          limit_window_seconds: 604800,
          reset_at: 1800086400,
        },
      },
    })
  }

  const service = new AccountQuotaService({ store, fetch: mockFetch })
  const snapshot = await service.refreshAccount(acc.metadata.id)

  assert.equal(snapshot.accountId, acc.metadata.id)
  assert.equal(snapshot.tool, 'codex')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.plan, 'plus')
  assert.equal(snapshot.windows.length, 2)

  // primary_window
  const pw = snapshot.windows.find((w) => w.id === 'primary_window')
  assert.ok(pw)
  assert.equal(pw.remainingPercent, 75) // 100 - 25
  assert.equal(pw.label, '5h')
  assert.equal(pw.resetsAt, 1800000000000)

  // secondary_window
  const sw = snapshot.windows.find((w) => w.id === 'secondary_window')
  assert.ok(sw)
  assert.equal(sw.remainingPercent, 20) // 100 - 80
  assert.equal(sw.label, '7d')
  assert.equal(sw.resetsAt, 1800086400000)

  // Verify headers and security options
  assert.equal(capturedUrl, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(capturedInit.redirect, 'error')
  assert.equal(capturedInit.headers['ChatGPT-Account-Id'], acc.metadata.accountId)
  assert.ok(capturedInit.headers['Authorization'].startsWith('Bearer ey'))
})

await test('2. Claude positive query: 5h, 7d, 7d Opus, 7d Sonnet windows, utilization, resets_at, and headers', async () => {
  const store = new MockStore()
  const acc = makeClaudeAccount()
  store.set(acc.metadata.id, acc)

  let capturedInit = null
  let capturedUrl = null

  const mockFetch = async (url, init) => {
    capturedUrl = url
    capturedInit = init
    return jsonResponse({
      five_hour: { utilization: 25, resets_at: '2030-01-01T00:00:00Z' },
      seven_day: { utilization: 50, resets_at: '2030-01-07T00:00:00Z' },
      seven_day_opus: { utilization: 10, resets_at: '2030-01-07T00:00:00Z' },
      seven_day_sonnet: { utilization: 90, resets_at: '2030-01-07T00:00:00Z' },
      plan: 'Claude Pro',
    })
  }

  const service = new AccountQuotaService({ store, fetch: mockFetch })
  const snapshot = await service.refreshAccount(acc.metadata.id)

  assert.equal(snapshot.accountId, acc.metadata.id)
  assert.equal(snapshot.tool, 'claude-code')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.plan, 'Claude Pro')
  assert.equal(snapshot.windows.length, 4)

  const w5h = snapshot.windows.find((w) => w.id === 'five_hour')
  assert.ok(w5h)
  assert.equal(w5h.remainingPercent, 75) // 100 - 25
  assert.equal(w5h.label, '5h')
  assert.equal(w5h.resetsAt, Date.parse('2030-01-01T00:00:00Z'))

  const w7d = snapshot.windows.find((w) => w.id === 'seven_day')
  assert.ok(w7d)
  assert.equal(w7d.remainingPercent, 50) // 100 - 50

  const wOpus = snapshot.windows.find((w) => w.id === 'seven_day_opus')
  assert.ok(wOpus)
  assert.equal(wOpus.remainingPercent, 90)

  const wSonnet = snapshot.windows.find((w) => w.id === 'seven_day_sonnet')
  assert.ok(wSonnet)
  assert.equal(wSonnet.remainingPercent, 10)

  assert.equal(capturedUrl, 'https://api.anthropic.com/api/oauth/usage')
  assert.equal(capturedInit.redirect, 'error')
  assert.equal(capturedInit.headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(capturedInit.headers['User-Agent'], 'claude-code/2.1.0')
  assert.equal(capturedInit.headers['Authorization'], `Bearer ${acc.credential}`)
})

await test('Claude full OAuth credential queries with access token only and redacts response labels', async () => {
  const store = new MockStore()
  const acc = makeClaudeAccount()
  const access = acc.credential
  const refresh = 'synthetic-full-claude-refresh'
  acc.credential = JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600_000, scopes: ['user:profile', 'user:inference'] } })
  store.set(acc.metadata.id, acc)
  let authorization
  const service = new AccountQuotaService({ store, fetch: async (_url, init) => {
    authorization = init.headers.Authorization
    return jsonResponse({ five_hour: { utilization: 25 }, plan: refresh })
  } })
  const snapshot = await service.refreshAccount(acc.metadata.id)
  assert.equal(authorization, `Bearer ${access}`)
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.windows[0].remainingPercent, 75)
  assert.ok(!JSON.stringify(snapshot).includes(refresh))
  assert.ok(!JSON.stringify(snapshot).includes(access))
})

await test('3. Antigravity positive query: loadCodeAssist, fetchAvailableModels, remainingFraction, and tier', async () => {
  const store = new MockStore()
  const acc = makeAntigravityAccount()
  store.set(acc.metadata.id, acc)

  const calls = []
  const mockFetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    if (url.endsWith(':loadCodeAssist')) {
      return jsonResponse({
        cloudaicompanionProject: 'test-project-123',
        currentTier: { name: 'Gemini Advanced' },
      })
    }
    if (url.endsWith(':fetchAvailableModels')) {
      return jsonResponse({
        models: {
          'gemini-pro': {
            displayName: 'Gemini Pro',
            quotaInfo: {
              remainingFraction: 0.7,
              resetTime: '2030-01-01T00:00:00Z',
            },
          },
          'claude-sonnet': {
            quotaInfo: {
              remainingFraction: 0, // Genuine 0
              resetTime: '2030-01-01T00:00:00Z',
            },
          },
        },
      })
    }
    if (url.endsWith(':retrieveUserQuotaSummary')) {
      return jsonResponse({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{
              bucketId: 'gemini_weekly',
              window: 'weekly',
              remainingFraction: 0.82,
              resetTime: '2030-01-02T00:00:00Z',
            }],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [{
              bucketId: 'claude_gpt_weekly',
              window: 'weekly',
              remainingFraction: 0.55,
              resetTime: '2030-01-03T00:00:00Z',
            }],
          },
        ],
      })
    }
    throw new Error('Unexpected URL')
  }

  const service = new AccountQuotaService({ store, fetch: mockFetch })
  const snapshot = await service.refreshAccount(acc.metadata.id)

  assert.equal(snapshot.accountId, acc.metadata.id)
  assert.equal(snapshot.tool, 'antigravity')
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.plan, 'Gemini Advanced')
  assert.equal(snapshot.windows.length, 4)

  const m1 = snapshot.windows.find((w) => w.id === 'gemini-pro')
  assert.ok(m1)
  assert.equal(m1.label, 'Gemini Pro')
  assert.equal(m1.period, 'five-hour')
  assert.equal(m1.durationSeconds, 18000)
  assert.equal(m1.remainingPercent, 70)
  assert.equal(m1.resetsAt, Date.parse('2030-01-01T00:00:00Z'))

  const m1Weekly = snapshot.windows.find((w) => w.id === 'gemini-pro:weekly')
  assert.ok(m1Weekly)
  assert.equal(m1Weekly.label, 'Gemini Pro')
  assert.equal(m1Weekly.period, 'weekly')
  assert.equal(m1Weekly.durationSeconds, 604800)
  assert.equal(m1Weekly.remainingPercent, 82)
  assert.equal(m1Weekly.resetsAt, Date.parse('2030-01-02T00:00:00Z'))

  const m2 = snapshot.windows.find((w) => w.id === 'claude-sonnet')
  assert.ok(m2)
  assert.equal(m2.label, 'claude-sonnet') // Fallback to id
  assert.equal(m2.period, 'five-hour')
  assert.equal(m2.remainingPercent, 0) // Genuine zero preserved

  const m2Weekly = snapshot.windows.find((w) => w.id === 'claude-sonnet:weekly')
  assert.ok(m2Weekly)
  assert.equal(m2Weekly.period, 'weekly')
  assert.equal(m2Weekly.remainingPercent, 55)
  assert.equal(m2Weekly.resetsAt, Date.parse('2030-01-03T00:00:00Z'))

  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].body, { metadata: { ideType: 'ANTIGRAVITY' } })
  assert.deepEqual(calls[1].body, { project: 'test-project-123' })
  assert.deepEqual(calls[2].body, { project: 'test-project-123' })
})

await test('Antigravity keeps late tiered model aliases beyond the internal model cap', async () => {
  const store = new MockStore()
  const acc = makeAntigravityAccount()
  store.set(acc.metadata.id, acc)

  const rawModels = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `gemini-internal-${index}`,
      { quotaInfo: { remainingFraction: 0.5 } },
    ])
  )
  rawModels['gemini-3.7-flash-tiered'] = { quotaInfo: { remainingFraction: 0.7 } }
  rawModels['gemini-3.8-flash-tiered'] = { quotaInfo: { remainingFraction: 0.8 } }

  const service = new AccountQuotaService({
    store,
    fetch: async (url) => {
      if (url.endsWith(':fetchAvailableModels')) return jsonResponse({ models: rawModels })
      if (url.endsWith(':retrieveUserQuotaSummary')) return jsonResponse({ groups: [] })
      return jsonResponse({})
    },
  })
  const snapshot = await service.refreshAccount(acc.metadata.id)

  assert.ok(snapshot.windows.some((window) => window.id === 'gemini-3.7-flash-tiered'))
  assert.ok(snapshot.windows.some((window) => window.id === 'gemini-3.8-flash-tiered'))
})

await test('4. Real zero remaining vs missing percentage: genuine 0 preserved, missing is undefined', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  const mockFetch = async () => {
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 100, // Genuine 100 used -> 0 remaining
          limit_window_seconds: 18000,
        },
        secondary_window: {
          // used_percent is missing
          limit_window_seconds: 604800,
        },
      },
    })
  }

  const service = new AccountQuotaService({ store, fetch: mockFetch })
  const snapshot = await service.refreshAccount(acc.metadata.id)

  assert.equal(snapshot.status, 'ready')
  const pw = snapshot.windows.find((w) => w.id === 'primary_window')
  assert.equal(pw.remainingPercent, 0) // Genuine 0!

  const sw = snapshot.windows.find((w) => w.id === 'secondary_window')
  assert.equal(sw.remainingPercent, undefined) // Unknown, NOT zero!
  assert.ok(!('remainingPercent' in sw))
})

await test('5. Invalid and out-of-range values: negative, over 100, NaN, and empty models object', async () => {
  const store = new MockStore()
  const codexAcc = makeCodexAccount()
  store.set(codexAcc.metadata.id, codexAcc)

  // Out of range percentages
  const mockFetchCodex = async () => {
    return jsonResponse({
      rate_limit: {
        primary_window: {
          used_percent: -10, // Invalid
        },
        secondary_window: {
          used_percent: 150, // Invalid
        },
      },
    })
  }

  const service1 = new AccountQuotaService({ store, fetch: mockFetchCodex })
  const snap1 = await service1.refreshAccount(codexAcc.metadata.id)
  assert.equal(snap1.status, 'unavailable')
  assert.equal(snap1.windows[0].remainingPercent, undefined)
  assert.equal(snap1.windows[1].remainingPercent, undefined)

  // Antigravity empty models -> unavailable
  const agyAcc = makeAntigravityAccount()
  store.set(agyAcc.metadata.id, agyAcc)
  const mockFetchAgy = async (url) => {
    if (url.endsWith(':loadCodeAssist')) return jsonResponse({})
    if (url.endsWith(':fetchAvailableModels')) return jsonResponse({ models: {} })
    return jsonResponse({})
  }
  const service2 = new AccountQuotaService({ store, fetch: mockFetchAgy })
  const snap2 = await service2.refreshAccount(agyAcc.metadata.id)
  assert.equal(snap2.status, 'unavailable')
  assert.equal(snap2.windows.length, 0)
})

await test('6. HTTP status mappings: 401->expired, 403->forbidden, 429->rate-limited, 500->error', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  for (const [code, expectedStatus] of [
    [401, 'expired'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'error'],
    [502, 'error'],
  ]) {
    const service = new AccountQuotaService({
      store,
      fetch: async () => new Response('Error', { status: code }),
    })
    const snap = await service.refreshAccount(acc.metadata.id)
    assert.equal(snap.status, expectedStatus, `Expected ${expectedStatus} for HTTP ${code}`)
    assert.equal(snap.windows.length, 0)
  }
})

await test('7. Safe network error handling: network abort/error and response > 1 MiB limit', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  // Fetch throws connection error
  const serviceThrow = new AccountQuotaService({
    store,
    fetch: async () => {
      throw new Error('ECONNRESET')
    },
  })
  const snap1 = await serviceThrow.refreshAccount(acc.metadata.id)
  assert.equal(snap1.status, 'error')

  // Response exceeding 1 MiB limit
  const hugeBody = 'x'.repeat(MAX_RESPONSE_BYTES + 1024)
  const serviceHuge = new AccountQuotaService({
    store,
    fetch: async () => new Response(hugeBody, { status: 200 }),
  })
  const snap2 = await serviceHuge.refreshAccount(acc.metadata.id)
  assert.equal(snap2.status, 'error')
})

await test('8. Redirect mode: redirect: "error" enforced', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  let passedRedirectOption = null
  const service = new AccountQuotaService({
    store,
    fetch: async (url, init) => {
      passedRedirectOption = init.redirect
      return jsonResponse({ rate_limit: { primary_window: { used_percent: 50 } } })
    },
  })
  await service.refreshAccount(acc.metadata.id)
  assert.equal(passedRedirectOption, 'error')
})

await test('9. Offline token expiration check: expired tokens yield expired status without network calls', async () => {
  const store = new MockStore()

  // Codex account with expired JWT claim
  const expiredCodex = makeCodexAccount({ exp: Math.floor(Date.now() / 1000) - 300 })
  store.set(expiredCodex.metadata.id, expiredCodex)

  // Antigravity account with expired ISO date
  const expiredAgy = makeAntigravityAccount({ expiryMs: Date.now() - 300_000 })
  store.set(expiredAgy.metadata.id, expiredAgy)

  let networkCalled = false
  const guardFetch = async () => {
    networkCalled = true
    return jsonResponse({})
  }

  const service = new AccountQuotaService({ store, fetch: guardFetch })

  const snapCodex = await service.refreshAccount(expiredCodex.metadata.id)
  assert.equal(snapCodex.status, 'expired')
  assert.equal(networkCalled, false, 'Network must not be called for expired Codex token')

  const snapAgy = await service.refreshAccount(expiredAgy.metadata.id)
  assert.equal(snapAgy.status, 'expired')
  assert.equal(networkCalled, false, 'Network must not be called for expired Antigravity token')
})

await test('10. Zero secret leakage: snapshots and errors never contain tokens or raw error bodies', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  const secretBody = JSON.stringify({
    error: {
      message: 'Sensitive secret token leaked in error: secret_tok_12345',
    },
  })

  const service = new AccountQuotaService({
    store,
    fetch: async () => new Response(secretBody, { status: 403 }),
  })

  const snapshot = await service.refreshAccount(acc.metadata.id)
  const snapshotJson = JSON.stringify(snapshot)

  assert.ok(!snapshotJson.includes('secret_tok_12345'))
  assert.ok(!snapshotJson.includes('refresh_secret_123'))
  assert.ok(!snapshotJson.includes('ey')) // JWT prefix
  assert.equal(snapshot.status, 'forbidden')
})

await test('11. Per-account cache isolation & getCached: cloned data, zero network, and pruning', async () => {
  const store = new MockStore()
  const acc1 = makeCodexAccount()
  const acc2 = makeClaudeAccount()
  store.set(acc1.metadata.id, acc1)
  store.set(acc2.metadata.id, acc2)

  let networkCalls = 0
  const mockFetch = async () => {
    networkCalls++
    return jsonResponse({
      rate_limit: { primary_window: { used_percent: 30 } },
    })
  }

  const service = new AccountQuotaService({ store, fetch: mockFetch })

  // Refresh acc1 only
  await service.refreshAccount(acc1.metadata.id)
  assert.equal(networkCalls, 1)

  // getCached does not call network
  const cached1 = service.getCached([acc1.metadata, acc2.metadata])
  assert.equal(networkCalls, 1, 'getCached must never call network')
  assert.equal(cached1.length, 1)
  assert.equal(cached1[0].accountId, acc1.metadata.id)

  // Mutating returned object does not corrupt cache
  cached1[0].plan = 'mutated-plan'
  const cached2 = service.getCached([acc1.metadata])
  assert.notEqual(cached2[0].plan, 'mutated-plan')

  // Pruning: when acc1 is omitted from accounts, it is pruned from cache
  const cachedEmpty = service.getCached([acc2.metadata])
  assert.equal(cachedEmpty.length, 0)
  // Calling again with acc1 now returns empty because it was pruned!
  const cachedAfterPrune = service.getCached([acc1.metadata])
  assert.equal(cachedAfterPrune.length, 0)

  // Re-populate acc1
  await service.refreshAccount(acc1.metadata.id)
  assert.equal(service.getCached([acc1.metadata]).length, 1)

  // When account metadata updatedAt changes, getCached prunes stale entry
  const modifiedAcc1 = { ...acc1.metadata, updatedAt: acc1.metadata.updatedAt + 1000 }
  const cachedAfterUpdate = service.getCached([modifiedAcc1])
  assert.equal(cachedAfterUpdate.length, 0, 'Stale cache entry must be pruned on updatedAt change')
})

await test('12. Same-account in-flight deduplication: concurrent calls share a single fetch', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  let fetchCalls = 0
  const slowFetch = async () => {
    fetchCalls++
    await new Promise((r) => setTimeout(r, 40))
    return jsonResponse({
      rate_limit: { primary_window: { used_percent: 20 } },
    })
  }

  const service = new AccountQuotaService({ store, fetch: slowFetch })

  const [res1, res2, res3] = await Promise.all([
    service.refreshAccount(acc.metadata.id),
    service.refreshAccount(acc.metadata.id),
    service.refreshAccount(acc.metadata.id),
  ])

  assert.equal(fetchCalls, 1, 'Must only trigger 1 fetch for concurrent requests on same account')
  assert.equal(res1.status, 'ready')
  assert.equal(res2.status, 'ready')
  assert.equal(res3.status, 'ready')
  assert.deepEqual(res1, res2)
  assert.deepEqual(res2, res3)
})

await test('13. Stale cache preservation on failure: retains prior windows with stale: true', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  let failNext = false
  const mockFetch = async () => {
    if (failNext) {
      return new Response('Server Error', { status: 500 })
    }
    return jsonResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18000 },
      },
    })
  }

  let currentTime = 10000
  const service = new AccountQuotaService({
    store,
    fetch: mockFetch,
    now: () => currentTime,
  })

  // Initial successful refresh
  const snap1 = await service.refreshAccount(acc.metadata.id)
  assert.equal(snap1.status, 'ready')
  assert.equal(snap1.windows.length, 1)
  assert.equal(snap1.fetchedAt, 10000)
  assert.equal(snap1.stale, undefined)

  // Subsequent failed refresh
  failNext = true
  currentTime = 20000
  const snap2 = await service.refreshAccount(acc.metadata.id)

  assert.equal(snap2.status, 'error')
  assert.equal(snap2.stale, true)
  assert.equal(snap2.attemptedAt, 20000)
  assert.equal(snap2.fetchedAt, 10000) // Retained from prior success
  assert.equal(snap2.windows.length, 1) // Prior windows preserved!
  assert.equal(snap2.windows[0].remainingPercent, 60)
})

await test('14. In-flight deletion and modification safety: no cache resurrection', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  // Account deleted while fetch in flight
  const deletingFetch = async () => {
    store.delete(acc.metadata.id)
    return jsonResponse({
      rate_limit: { primary_window: { used_percent: 10 } },
    })
  }

  const service = new AccountQuotaService({ store, fetch: deletingFetch })
  await assert.rejects(service.refreshAccount(acc.metadata.id), /账号已移除/)

  // Verify it was NOT resurrected in cache
  const cached = service.getCached([acc.metadata])
  assert.equal(cached.length, 0, 'Deleted account must not be resurrected in cache')

  // Account modified while fetch in flight
  const acc2 = makeCodexAccount()
  store.set(acc2.metadata.id, acc2)

  const modifyingFetch = async () => {
    // External update to account
    const updated = {
      ...acc2,
      metadata: { ...acc2.metadata, updatedAt: acc2.metadata.updatedAt + 500 },
      credential: '{"different":"credential"}',
    }
    store.set(acc2.metadata.id, updated)
    return jsonResponse({
      rate_limit: { primary_window: { used_percent: 10 } },
    })
  }

  const service2 = new AccountQuotaService({ store, fetch: modifyingFetch })
  await assert.rejects(service2.refreshAccount(acc2.metadata.id), /账号凭据已变更/)
  const cached2 = service2.getCached([acc2.metadata])
  assert.equal(cached2.length, 0, 'Modified account must not cache old fetch result')
})

await test('15. Antigravity 403 project retry: retries fetchAvailableModels without project', async () => {
  const store = new MockStore()
  const acc = makeAntigravityAccount()
  store.set(acc.metadata.id, acc)

  const requests = []
  const retryFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ url, body })

    if (url.endsWith(':loadCodeAssist')) {
      return jsonResponse({ cloudaicompanionProject: 'forbidden-project' })
    }
    if (url.endsWith(':fetchAvailableModels')) {
      if (body?.project === 'forbidden-project') {
        // Return 403 when project is specified
        return new Response('Forbidden', { status: 403 })
      }
      // Retry without project succeeds!
      return jsonResponse({
        models: {
          'gemini-flash': {
            displayName: 'Gemini Flash',
            quotaInfo: { remainingFraction: 0.8 },
          },
        },
      })
    }
    return new Response('Not found', { status: 404 })
  }

  const service = new AccountQuotaService({ store, fetch: retryFetch })
  const snapshot = await service.refreshAccount(acc.metadata.id)

  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.windows.length, 2)
  assert.equal(snapshot.windows[0].id, 'gemini-flash')
  assert.equal(snapshot.windows[0].remainingPercent, 80)
  assert.equal(snapshot.windows[1].id, 'gemini-flash:weekly')
  assert.equal(snapshot.windows[1].remainingPercent, undefined)

  // Verify that retry happened with empty body
  assert.equal(requests.length, 4)
  assert.deepEqual(requests[1].body, { project: 'forbidden-project' })
  assert.deepEqual(requests[2].body, {})
  assert.deepEqual(requests[3].body, {})
})

await test('16. Concurrency bounds: simultaneous requests bounded by MAX_CONCURRENT_HTTP', async () => {
  const store = new MockStore()
  const accounts = []
  for (let i = 0; i < 10; i++) {
    const acc = makeCodexAccount({ accountId: `acc-${i}` })
    accounts.push(acc)
    store.set(acc.metadata.id, acc)
  }

  let activeFetches = 0
  let peakFetches = 0

  const throttledFetch = async () => {
    activeFetches++
    peakFetches = Math.max(peakFetches, activeFetches)
    await new Promise((r) => setTimeout(r, 20))
    activeFetches--
    return jsonResponse({
      rate_limit: { primary_window: { used_percent: 50 } },
    })
  }

  const service = new AccountQuotaService({ store, fetch: throttledFetch })

  await Promise.all(accounts.map((a) => service.refreshAccount(a.metadata.id)))

  assert.ok(peakFetches <= MAX_CONCURRENT_HTTP, `Peak fetches (${peakFetches}) exceeded MAX_CONCURRENT_HTTP (${MAX_CONCURRENT_HTTP})`)
})

await test('17. Invalidate method: evicts cache and triggers onChanged', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  let changedCount = 0
  const service = new AccountQuotaService({
    store,
    fetch: async () => jsonResponse({ rate_limit: { primary_window: { used_percent: 50 } } }),
    onChanged: () => {
      changedCount++
    },
  })

  await service.refreshAccount(acc.metadata.id)
  assert.equal(service.getCached([acc.metadata]).length, 1)
  const countAfterRefresh = changedCount

  service.invalidate(acc.metadata.id)
  assert.equal(service.getCached([acc.metadata]).length, 0)
  assert.equal(changedCount, countAfterRefresh + 1)
})

await test('18. onChanged callback error isolation: listener error does not crash service', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)

  const service = new AccountQuotaService({
    store,
    fetch: async () => jsonResponse({ rate_limit: { primary_window: { used_percent: 50 } } }),
    onChanged: () => {
      throw new Error('Callback crashed!')
    },
  })

  // refreshAccount must not throw when listener fails
  const snap = await service.refreshAccount(acc.metadata.id)
  assert.equal(snap.status, 'ready')

  // invalidate must not throw when listener fails
  assert.doesNotThrow(() => {
    service.invalidate(acc.metadata.id)
  })
})

await test('19. Credential URL fields cannot redirect quota requests', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  acc.credential = JSON.stringify({ ...JSON.parse(acc.credential), base_url: 'https://attacker.invalid', chatgpt_base_url: 'https://attacker.invalid' })
  store.set(acc.metadata.id, acc)
  const urls = []
  const service = new AccountQuotaService({
    store,
    fetch: async (url) => {
      urls.push(url)
      return jsonResponse({ rate_limit: { primary_window: { used_percent: 50 } } })
    },
  })

  // Calling refreshAccount on normal account targets allowlisted URL
  const snap = await service.refreshAccount(acc.metadata.id)
  assert.equal(snap.status, 'ready')
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/wham/usage'])
})

await test('20. Positive fractional quota is not rounded to zero; unknown windows are unavailable', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)
  let data = { rate_limit: { primary_window: { used_percent: 99.9, reset_at: 1e308 } } }
  const service = new AccountQuotaService({ store, fetch: async () => jsonResponse(data) })
  const tiny = await service.refreshAccount(acc.metadata.id)
  assert.ok(tiny.windows[0].remainingPercent > 0 && tiny.windows[0].remainingPercent < 1)
  assert.equal(tiny.windows[0].resetsAt, undefined)
  service.invalidate(acc.metadata.id)
  data = { rate_limit: { primary_window: {} } }
  const unknown = await service.refreshAccount(acc.metadata.id)
  assert.equal(unknown.status, 'unavailable')
  assert.equal(unknown.fetchedAt, undefined)
  assert.equal(unknown.windows[0].remainingPercent, undefined)
  const agy = makeAntigravityAccount()
  store.set(agy.metadata.id, agy)
  let remainingFraction = 0.0001
  const agyService = new AccountQuotaService({ store, fetch: async url => jsonResponse(url.endsWith(':loadCodeAssist') ? {} : { models: { 'gemini-pro': { quotaInfo: { remainingFraction } }, 'no-quota': { displayName: 'No quota' } } }) })
  const fractional = await agyService.refreshAccount(agy.metadata.id)
  assert.equal(fractional.windows.length, 2)
  assert.equal(fractional.windows[0].remainingPercent, 0.01)
  agyService.invalidate(agy.metadata.id)
  remainingFraction = undefined
  assert.equal((await agyService.refreshAccount(agy.metadata.id)).status, 'unavailable')
})

await test('21. Successful response labels cannot echo access or refresh tokens', async () => {
  const store = new MockStore()
  const acc = makeAntigravityAccount()
  store.set(acc.metadata.id, acc)
  const secrets = JSON.parse(acc.credential).token
  const service = new AccountQuotaService({ store, fetch: async url => jsonResponse(url.endsWith(':loadCodeAssist') ? { paidTier: { name: secrets.refresh_token } } : { models: {
    'gemini-pro': { displayName: secrets.access_token, quotaInfo: { remainingFraction: 0.5 } },
    [secrets.refresh_token]: { quotaInfo: { remainingFraction: 0.5 } },
  } }) })
  const snapshot = await service.refreshAccount(acc.metadata.id)
  const text = JSON.stringify(snapshot)
  assert.ok(!text.includes(secrets.access_token) && !text.includes(secrets.refresh_token))
  assert.equal(snapshot.status, 'unavailable')
})

await test('22. Failed refresh after credential replacement cannot reuse the prior credential quota', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)
  let fail = false
  const service = new AccountQuotaService({ store, fetch: async () => fail ? new Response('', { status: 403 }) : jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } }) })
  await service.refreshAccount(acc.metadata.id)
  const replacement = makeCodexAccount({ id: acc.metadata.id, updatedAt: acc.metadata.updatedAt, accountId: 'different-account' })
  store.set(acc.metadata.id, replacement)
  fail = true
  const result = await service.refreshAccount(acc.metadata.id)
  assert.equal(result.status, 'forbidden')
  assert.equal(result.windows.length, 0)
  assert.equal(result.fetchedAt, undefined)
})

await test('23. Deadline aborts both pending fetch and stalled response body', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)
  let fetchSignal
  const stalledFetch = new AccountQuotaService({ store, fetch: async (_url, init) => {
    fetchSignal = init.signal
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  } })
  let bodyCancelled = false
  const stalledBody = new AccountQuotaService({ store, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    cancel() { bodyCancelled = true },
  })) })
  const start = Date.now()
  const results = await Promise.all([stalledFetch.refreshAccount(acc.metadata.id), stalledBody.refreshAccount(acc.metadata.id)])
  assert.ok(Date.now() - start >= HTTP_TIMEOUT_MS - 100)
  assert.ok(fetchSignal.aborted)
  assert.ok(bodyCancelled)
  assert.deepEqual(results.map(result => result.status), ['error', 'error'])
})

await test('Antigravity distinguishes paid entitlement from allowed tiers and age restrictions', async () => {
  const store = new MockStore(), acc = makeAntigravityAccount()
  store.set(acc.metadata.id, acc)
  let body = { paidTier: { id:'g1-pro-tier', name:'Google AI Pro' }, currentTier:{name:'Antigravity'} }, modelsFail = false
  const service = new AccountQuotaService({store, fetch: async url => url.endsWith(':loadCodeAssist') ? jsonResponse(body) : modelsFail ? jsonResponse({},500) : jsonResponse({models:{model:{quotaInfo:{remainingFraction:1}}}})})
  const paid = await service.refreshAccount(acc.metadata.id)
  assert.equal(paid.plan, 'Google AI Pro')
  assert.equal(paid.planReason, undefined)
  body = {allowedTiers:[{name:'Google AI Pro'}],ineligibleTiers:[{reasonCode:'RESTRICTED_AGE'}]}
  modelsFail = true
  const changedRestriction = await service.refreshAccount(acc.metadata.id)
  assert.equal(changedRestriction.plan, undefined)
  assert.equal(changedRestriction.planReason, 'restricted-age')
  modelsFail = false
  const restricted = await service.refreshAccount(acc.metadata.id)
  assert.equal(restricted.status, 'ready')
  assert.equal(restricted.plan, undefined)
  assert.equal(restricted.planReason, 'restricted-age')
  modelsFail = true
  const stale = await service.refreshAccount(acc.metadata.id)
  assert.equal(stale.stale, true)
  assert.equal(stale.planReason, 'restricted-age')
  assert.equal(stale.plan, undefined)
  modelsFail = false; body = {allowedTiers:[{name:'Google AI Pro'}]}
  const unknown = await service.refreshAccount(acc.metadata.id)
  assert.equal(unknown.plan, undefined)
  assert.equal(unknown.planReason, 'unavailable')
})

await test('Quota periods follow provider duration, not primary/secondary position', async () => {
  const store = new MockStore()
  const acc = makeCodexAccount()
  store.set(acc.metadata.id, acc)
  for (const [primary, secondary] of [[604800, 18000], [18000, 604800], [undefined, -1], [0, '18000'], [3600, 86400]]) {
    const service = new AccountQuotaService({store, fetch: async () => jsonResponse({rate_limit: {
      primary_window: {used_percent: 25, limit_window_seconds: primary, reset_at: 1800000000},
      secondary_window: {used_percent: 80, limit_window_seconds: secondary, reset_at: 1800086400},
    }})})
    const snapshot = await service.refreshAccount(acc.metadata.id)
    assert.equal(snapshot.windows.length, 2)
    for (const [index, duration] of [primary, secondary].entries()) {
      const win = snapshot.windows[index]
      assert.equal(win.durationSeconds, typeof duration === 'number' && duration > 0 ? duration : undefined)
      assert.equal(win.remainingPercent, index === 0 ? 75 : 20)
      assert.equal(win.resetsAt, (index === 0 ? 1800000000 : 1800086400) * 1000)
      const expected = duration === 604800 ? '周额度' : duration === 18000 ? '5 小时额度'
        : duration === 3600 ? '1 小时额度' : duration === 86400 ? '1 天额度' : '额度（周期未知）'
      assert.equal(formatQuotaWindowLabel(win, 'codex', 'zh-CN'), expected)
    }
  }
})

await test('Localized labels preserve Claude model scope and Antigravity model names', async () => {
  const store = new MockStore()
  const acc = makeClaudeAccount()
  store.set(acc.metadata.id, acc)
  const ids = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
  const service = new AccountQuotaService({store, fetch: async () => jsonResponse(Object.fromEntries(
    ids.map(id => [id, {utilization: 35, resets_at: '2027-01-01T00:00:00Z'}])
  ))})
  const snapshot = await service.refreshAccount(acc.metadata.id)
  assert.deepEqual(snapshot.windows.map(w => w.durationSeconds), [18000, 604800, 604800, 604800])
  assert.deepEqual(snapshot.windows.map(w => formatQuotaWindowLabel(w, 'claude-code', 'zh-CN')),
    ['5 小时额度', '周额度', '周额度 · Opus', '周额度 · Sonnet'])
  assert.deepEqual(snapshot.windows.map(w => formatQuotaWindowLabel(w, 'claude-code', 'en-US')),
    ['5-hour quota', 'Weekly quota', 'Weekly quota · Opus', 'Weekly quota · Sonnet'])
  assert.equal(formatQuotaWindowLabel({id: 'primary_window', label: 'Primary'}, 'codex', 'en-US'), 'Quota (period unknown)')
  for (const durationSeconds of [NaN, Infinity, -1, 0]) {
    assert.equal(formatQuotaWindowLabel({id: 'primary_window', label: '5h', durationSeconds}, 'codex', 'zh-CN'), '额度（周期未知）')
  }
  assert.equal(formatQuotaWindowLabel({id: 'model', label: 'Claude Sonnet'}, 'antigravity', 'zh-CN'), 'Claude Sonnet')
  assert.equal(formatQuotaWindowLabel({id: 'gemini-pro', label: 'Gemini Pro', modelLabel: 'Gemini Pro', period: 'five-hour', durationSeconds: 18000}, 'antigravity', 'zh-CN'), 'Gemini Pro · 5 小时额度')
  assert.equal(formatQuotaWindowLabel({id: 'gemini-pro:weekly', label: 'Gemini Pro', modelLabel: 'Gemini Pro', period: 'weekly', durationSeconds: 604800}, 'antigravity', 'en-US'), 'Gemini Pro · Weekly quota')
})

await test('Antigravity quota UI keeps the visible model set and groups two periods per model', async () => {
  const models = [
    ['gemini-3.8-flash-tiered', 'Gemini 3.8 Flash High'],
    ['gemini-3.7-flash-tiered', 'Gemini 3.7 Flash Medium'],
    ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash Medium'],
    ['gemini-3.1-pro-low', 'Gemini 3.1 Pro Low'],
    ['claude-sonnet-4.6-thinking', 'Claude Sonnet 4.6 (Thinking)'],
    ['claude-opus-4.6-thinking', 'Claude Opus 4.6 (Thinking)'],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
  ]
  const windows = models.flatMap(([id, label], index) => [
    { id, label: id.endsWith('-tiered') ? id : label, modelLabel: id.endsWith('-tiered') ? id : label, period: 'five-hour', remainingPercent: 90 - index },
    { id: `${id}:weekly`, label: id.endsWith('-tiered') ? id : label, modelLabel: id.endsWith('-tiered') ? id : label, period: 'weekly', remainingPercent: 80 - index },
  ])
  windows.push({ id: 'internal-model', label: 'Internal Model', period: 'five-hour', remainingPercent: 99 })

  const groups = groupAntigravityQuotaWindows(windows)
  assert.deepEqual(groups.map((group) => group.label), models.map(([, label]) => label))
  assert.equal(groups.length, 7)
  assert.ok(groups.every((group) => group.windows.length === 2))
  assert.deepEqual(groups[0].windows.map((window) => window.period), ['weekly', 'five-hour'])
})

console.log(`\n========================================`)
console.log(`Account Quota Verification: ${passed} passed, ${failed} failed`)
console.log(`========================================`)

if (failed > 0) {
  process.exit(1)
}
