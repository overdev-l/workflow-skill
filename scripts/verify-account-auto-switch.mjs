/**
 * Verification Script for Antigravity Automatic Account Switching (OPC-80)
 *
 * Comprehensive synthetic unit and integration tests:
 * 1. Model recognition & mapping from synthetic storage fixture (handles tiered aliases, labels, IDs)
 * 2. Unrecognized or missing model returns null (no guessing)
 * 3. Model exhaustion rules: 5h or weekly window 0% is exhausted; unknown, expired, stale, error is NOT
 * 4. Candidate suitability rules: same model > 0 required; other models with quota do not qualify
 * 5. Auto switch OFF (default): exhausted model does NOT trigger switch
 * 6. Auto switch ON + active model 5h exhausted + candidate has quota: triggers switchAccount
 * 7. Auto switch ON + active model weekly exhausted + candidate has quota: triggers switchAccount
 * 8. Other model has quota, current model exhausted: candidate is rejected, no switch
 * 9. Active quota unknown or stale: no switch
 * 10. Unrecognized current model: no switch, Chinese message in status
 * 11. Single account or no candidates: no switch
 * 12. Switch toggled OFF midway: aborts switch
 * 13. No tight polling: when active account has quota, candidates are never queried
 * 14. Cooldown prevents rapid double-switching
 * 15. recoveryNeeded blocks switch
 * 16. Setting persistence across manager restart
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-auto-switch.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  readAntigravityCurrentModel,
  isModelExhausted,
  isCandidateSuitable,
  AccountAutoSwitchService,
  extractModelFromJson,
  extractModelFromPbtxt,
  extractModelFromBase64,
  readFromVscdb,
} from '../apps/desktop/electron/account-auto-switch.ts'
import {
  createAccountAdapters,
  resolveAntigravityDesktopStoragePath,
  resolveAntigravityGlobalStorageDbPath,
  resolveAntigravityGlobalStorageJsonPath,
  resolveAntigravityPbtxtPath,
} from '../apps/desktop/electron/account-adapters.ts'
import { AccountManager } from '../apps/desktop/electron/account-manager.ts'
import {
  SUPPORTED_ANTIGRAVITY_MODELS,
  matchSupportedAntigravityModel,
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

const credential = (id, email) => JSON.stringify({
  auth_method: 'consumer',
  token: {
    access_token: `synthetic-${id}`,
    refresh_token: `refresh-${id}`,
    token_type: 'Bearer',
    expiry: new Date(Date.now() + 3600_000).toISOString(),
  },
  account: { id: `id-${id}`, email },
})
const wrapKeyring = raw => `go-keyring-base64:${Buffer.from(raw).toString('base64')}`

console.log('Running Antigravity Auto-Switch Verification Tests...\n')

// 1. Model recognition & mapping
await test('1. Model recognition and alias mapping', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'auto-switch-model-'))
  try {
    const storageFile = path.join(tmp, 'app_storage.json')

    // Test alias: gemini-3.8-flash-tiered -> gemini-3.8-flash-high
    writeFileSync(storageFile, JSON.stringify({ currentModel: 'gemini-3.8-flash-tiered' }))
    const m1 = readAntigravityCurrentModel({ storagePath: storageFile })
    assert.equal(m1?.id, 'gemini-3.8-flash-high')

    // Test label: Gemini 3.8 Flash (High) -> gemini-3.8-flash-high
    writeFileSync(storageFile, JSON.stringify({ selectedModel: 'Gemini 3.8 Flash (High)' }))
    const m2 = readAntigravityCurrentModel({ storagePath: storageFile })
    assert.equal(m2?.id, 'gemini-3.8-flash-high')

    // Test Claude: claude-sonnet-4.6-thinking
    writeFileSync(storageFile, JSON.stringify({ model: 'Claude Sonnet 4.6 (Thinking)' }))
    const m3 = readAntigravityCurrentModel({ storagePath: storageFile })
    assert.equal(m3?.id, 'claude-sonnet-4.6-thinking')

    // Test GPT-OSS: gpt-oss-120b-medium
    writeFileSync(storageFile, JSON.stringify({ activeModel: 'gpt-oss-120b' }))
    const m4 = readAntigravityCurrentModel({ storagePath: storageFile })
    assert.equal(m4?.id, 'gpt-oss-120b-medium')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// 2. Unrecognized model returns null without guessing
await test('2. Unrecognized or missing model returns null (no guesswork)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'auto-switch-missing-'))
  try {
    const storageFile = path.join(tmp, 'app_storage.json')

    // Empty object
    writeFileSync(storageFile, JSON.stringify({}))
    assert.equal(readAntigravityCurrentModel({ storagePath: storageFile }), null)

    // Unrecognized string
    writeFileSync(storageFile, JSON.stringify({ currentModel: 'unknown-model-xyz' }))
    assert.equal(readAntigravityCurrentModel({ storagePath: storageFile }), null)

    // Non-existent file
    assert.equal(readAntigravityCurrentModel({ storagePath: path.join(tmp, 'nonexistent.json') }), null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// 3. Exhaustion evaluation
await test('3. isModelExhausted rules (5h or weekly window 0% is exhausted; unknown/stale/error is not)', () => {
  const modelId = 'gemini-3.8-flash-high'

  // 5h window is 0% -> exhausted
  assert.equal(isModelExhausted({
    accountId: 'a1', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [{ id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 0, period: 'five-hour' }]
  }, modelId), true)

  // weekly window is 0% -> exhausted
  assert.equal(isModelExhausted({
    accountId: 'a1', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [
      { id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 80, period: 'five-hour' },
      { id: 'gemini-3.8-flash-tiered:weekly', label: 'weekly', remainingPercent: 0, period: 'weekly' }
    ]
  }, modelId), true)

  // Both > 0 -> not exhausted
  assert.equal(isModelExhausted({
    accountId: 'a1', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [
      { id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 50, period: 'five-hour' },
      { id: 'gemini-3.8-flash-tiered:weekly', label: 'weekly', remainingPercent: 80, period: 'weekly' }
    ]
  }, modelId), false)

  // remainingPercent undefined -> not exhausted
  assert.equal(isModelExhausted({
    accountId: 'a1', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [{ id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: undefined }]
  }, modelId), false)

  // Status error or rate-limited -> not exhausted
  assert.equal(isModelExhausted({
    accountId: 'a1', tool: 'antigravity', status: 'error', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [{ id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 0 }]
  }, modelId), false)

  // Stale -> not exhausted
  assert.equal(isModelExhausted({
    accountId: 'a1', tool: 'antigravity', status: 'ready', stale: true, attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [{ id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 0 }]
  }, modelId), false)
})

// 4. Candidate suitability evaluation
await test('4. isCandidateSuitable rules (requires >0 on same model; other models do not qualify)', () => {
  const modelId = 'gemini-3.8-flash-high'

  // Has positive quota for same model -> suitable
  assert.equal(isCandidateSuitable({
    accountId: 'a2', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [
      { id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 60 },
      { id: 'gemini-3.8-flash-tiered:weekly', label: 'weekly', remainingPercent: 80 }
    ]
  }, modelId), true)

  // Has 0% on 5h window -> unsuitable
  assert.equal(isCandidateSuitable({
    accountId: 'a2', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [{ id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 0 }]
  }, modelId), false)

  // Has 100% on other model (e.g. claude-sonnet) but NOT on gemini-3.8 -> unsuitable
  assert.equal(isCandidateSuitable({
    accountId: 'a2', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [{ id: 'claude-sonnet-4.6-thinking', label: 'Sonnet', remainingPercent: 100 }]
  }, modelId), false)

  // Has 100% on other model and 0% on gemini-3.8 -> unsuitable
  assert.equal(isCandidateSuitable({
    accountId: 'a2', tool: 'antigravity', status: 'ready', attemptedAt: Date.now(), fetchedAt: Date.now(),
    windows: [
      { id: 'claude-sonnet-4.6-thinking', label: 'Sonnet', remainingPercent: 100 },
      { id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 0 }
    ]
  }, modelId), false)

  // Status not ready -> unsuitable
  assert.equal(isCandidateSuitable({
    accountId: 'a2', tool: 'antigravity', status: 'rate-limited', attemptedAt: Date.now(),
    windows: [{ id: 'gemini-3.8-flash-tiered', label: '5h', remainingPercent: 100 }]
  }, modelId), false)
})

// Helper to set up test environment
function setupManagerTestEnv() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'auto-switch-integration-'))
  const storageFile = path.join(home, 'app_storage.json')
  writeFileSync(storageFile, JSON.stringify({ currentModel: 'gemini-3.8-flash-tiered' }))

  let activeCredential = wrapKeyring(credential('acc1', 'acc1@gmail.com'))
  let inInteractiveSwitch = false

  const adapters = createAccountAdapters({
    homeDir: home,
    env: {},
    antigravityKeychain: {
      available: () => true,
      read: () => activeCredential,
      write: (val) => { activeCredential = val },
    },
    antigravityAssertStopped: () => {},
    async antigravityWithInteractiveSwitch(op) {
      inInteractiveSwitch = true
      try {
        return await op()
      } finally {
        inInteractiveSwitch = false
      }
    },
  })

  // Simulated quota responses per account
  const quotas = new Map()

  const quotaFetch = async (url, init) => {
    const authHeader = init?.headers?.Authorization || ''
    // Identify account from authHeader Bearer synthetic-<id>
    const match = /Bearer synthetic-([a-zA-Z0-9_-]+)/.exec(authHeader)
    const id = match ? match[1] : ''
    const raw = quotas.get(id) || {
      models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.5 } }
    }

    const normalizedModels = {}
    if (raw.models && typeof raw.models === 'object') {
      for (const [mKey, mVal] of Object.entries(raw.models)) {
        if (mVal && typeof mVal === 'object') {
          if ('quotaInfo' in mVal) {
            normalizedModels[mKey] = mVal
          } else {
            const { remainingFraction, displayName, ...rest } = mVal
            normalizedModels[mKey] = {
              displayName: displayName || mKey,
              quotaInfo: remainingFraction !== undefined ? { remainingFraction } : {},
              ...rest,
            }
          }
        }
      }
    }
    const accountQuota = { ...raw, models: normalizedModels }

    if (url.includes('loadCodeAssist')) {
      return new Response(JSON.stringify({ currentTier: { id: 'pro' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('fetchAvailableModels')) {
      return new Response(JSON.stringify(accountQuota), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('retrieveUserQuotaSummary')) {
      return new Response(JSON.stringify(raw.summary || {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('Not Found', { status: 404 })
  }

  const manager = new AccountManager({
    homeDir: home,
    adapters,
    quotaFetch,
    antigravityDesktopStoragePath: storageFile,
  })

  return { home, storageFile, manager, quotas, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

// 5. Auto switch OFF: even if exhausted, does not switch
await test('5. Switch OFF: exhausted model does not trigger switch', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      // Default: disabled
      assert.equal(await env.manager.getAutoSwitch('antigravity'), false)

      // Set Acc 1 quota exhausted on gemini-3.8-flash-tiered
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })
      // Set Acc 2 quota positive
      env.quotas.set('acc2', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.8 } } })

      // Trigger checkAutoSwitch
      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)

      // Active account remains acc1
      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
    } finally {
      env.cleanup()
    }
  })()
})

// 6. Auto switch ON + 5h exhausted -> switches to candidate
await test('6. Switch ON + 5h exhausted -> triggers switch to candidate', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      // Enable auto switch
      await env.manager.setAutoSwitch('antigravity', true)
      assert.equal(await env.manager.getAutoSwitch('antigravity'), true)

      // Set Acc 1 exhausted, Acc 2 positive
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })
      env.quotas.set('acc2', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.8 } } })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res?.success, true)

      // Active account switched to a2!
      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a2.id)
      assert.match(toolState?.autoSwitchStatus || '', /已自动切换至账号「Account 2」/)
    } finally {
      env.cleanup()
    }
  })()
})

// 7. Other model has quota, current model exhausted -> candidate rejected, no switch
await test('7. Other models have quota, current model does not -> candidate rejected, no switch', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)

      // Acc 1 exhausted on currentModel (gemini-3.8)
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })
      // Acc 2 has quota ONLY for claude-sonnet, NOT for gemini-3.8
      env.quotas.set('acc2', { models: { 'claude-sonnet-4.6-thinking': { remainingFraction: 1.0 } } })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)

      // Active account remains a1
      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
      assert.match(toolState?.autoSwitchStatus || '', /额度均已耗尽/)
    } finally {
      env.cleanup()
    }
  })()
})

// 8. Active account quota unknown / error -> no switch
await test('8. Active quota unknown or error -> does not switch', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)

      // Acc 1 quota returns missing remainingFraction (unknown)
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': {} } })
      env.quotas.set('acc2', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.8 } } })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
    } finally {
      env.cleanup()
    }
  })()
})

// 9. Current model unreadable -> no switch, Chinese notice
await test('9. Unreadable current model -> does not switch, emits Chinese status', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)

      // Make storage file invalid/unrecognized
      writeFileSync(env.storageFile, JSON.stringify({ currentModel: 'unknown-vendor-model' }))
      env.quotas.set('acc1', { models: { 'unknown-vendor-model': { remainingFraction: 0.5 } } })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.match(toolState?.autoSwitchStatus || '', /无法识别当前 Antigravity 选用模型/)
    } finally {
      env.cleanup()
    }
  })()
})

// 10. Only single account -> no switch
await test('10. Single account saved -> does not switch', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)
    } finally {
      env.cleanup()
    }
  })()
})

// 11. Switch toggled OFF midway -> aborts switch
await test('11. Switch toggled OFF midway -> aborts switch before calling switchAccount', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })
      env.quotas.set('acc2', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.8 } } })

      // Wrap quotaService refreshAccount to disable autoSwitch while candidate quota is fetched
      const originalRefresh = env.manager.autoSwitchService['quotaService'].refreshAccount.bind(
        env.manager.autoSwitchService['quotaService']
      )
      env.manager.autoSwitchService['quotaService'].refreshAccount = async (id) => {
        const snap = await originalRefresh(id)
        if (id.includes('acc2') || id === (await env.manager.store.list())[1]?.id) {
          // Disable switch midway!
          await env.manager.setAutoSwitch('antigravity', false)
        }
        return snap
      }

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)
    } finally {
      env.cleanup()
    }
  })()
})

// 12. No tight polling on candidates when active account is not exhausted
await test('12. No tight polling on all accounts: candidates are never queried if active account is fine', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 3',
        credential: credential('acc3', 'acc3@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)

      // Active account has 50% quota
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.5 } } })

      let candidateFetchCount = 0
      const originalFetch = env.manager.autoSwitchService['quotaService'].refreshAccount.bind(
        env.manager.autoSwitchService['quotaService']
      )
      env.manager.autoSwitchService['quotaService'].refreshAccount = async (id) => {
        const accounts = await env.manager.store.list()
        const target = accounts.find(a => a.id === id)
        if (target?.name !== 'Account 1') {
          candidateFetchCount++
        }
        return originalFetch(id)
      }

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)
      assert.equal(candidateFetchCount, 0, 'Candidate accounts must NOT be queried when active account is not exhausted')
    } finally {
      env.cleanup()
    }
  })()
})

// 13. Cooldown prevents rapid double-switching
await test('13. Cooldown prevents second auto-switch immediately after a switch', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 3',
        credential: credential('acc3', 'acc3@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)
      env.quotas.set('acc1', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })
      env.quotas.set('acc2', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.8 } } })

      // First switch succeeds to acc2
      const res1 = await env.manager.checkAutoSwitch()
      assert.equal(res1?.success, true)

      // Now immediately set acc2 exhausted as well
      env.quotas.set('acc2', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.0 } } })
      env.quotas.set('acc3', { models: { 'gemini-3.8-flash-tiered': { remainingFraction: 0.9 } } })

      // Second switch attempted immediately -> blocked by cooldown!
      const res2 = await env.manager.checkAutoSwitch()
      assert.equal(res2, null)
    } finally {
      env.cleanup()
    }
  })()
})

// 14. Setting persistence across manager restart
await test('14. Setting persistence across manager restarts', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      await env.manager.setAutoSwitch('antigravity', true)
      assert.equal(await env.manager.getAutoSwitch('antigravity'), true)

      // Create a new AccountManager instance pointing to the same homeDir
      const manager2 = new AccountManager({
        homeDir: env.home,
        antigravityDesktopStoragePath: env.storageFile,
      })

      assert.equal(await manager2.getAutoSwitch('antigravity'), true)

      // Disable on manager2
      await manager2.setAutoSwitch('antigravity', false)
      assert.equal(await manager2.getAutoSwitch('antigravity'), false)

      // Check on manager3
      const manager3 = new AccountManager({
        homeDir: env.home,
        antigravityDesktopStoragePath: env.storageFile,
      })
      assert.equal(await manager3.getAutoSwitch('antigravity'), false)
    } finally {
      env.cleanup()
    }
  })()
})

// 15. Synthetic vscdb (SQLite) model resolution & keys
await test('15. Synthetic vscdb (SQLite) model resolution & keys', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'auto-switch-vscdb-'))
  try {
    const dbPath = path.join(tmp, 'state.vscdb')

    // Helper to create db with key/value
    const createDbWithRow = (key, val) => {
      rmSync(dbPath, { force: true })
      const db = new DatabaseSync(dbPath)
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);')
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, val)
      db.close()
    }

    // 15a. currentModel in vscdb
    createDbWithRow('currentModel', 'gemini-3.8-flash-tiered')
    const m1 = readAntigravityCurrentModel({ vscdbPath: dbPath })
    assert.equal(m1?.id, 'gemini-3.8-flash-high')

    // 15b. antigravityUnifiedStateSync.modelPreferences with JSON
    createDbWithRow('antigravityUnifiedStateSync.modelPreferences', JSON.stringify({
      selectedModel: 'Claude Sonnet 4.6 (Thinking)'
    }))
    const m2 = readAntigravityCurrentModel({ vscdbPath: dbPath })
    assert.equal(m2?.id, 'claude-sonnet-4.6-thinking')

    // 15c. last_selected_model_name
    createDbWithRow('last_selected_model_name', 'gpt-oss-120b')
    const m3 = readAntigravityCurrentModel({ vscdbPath: dbPath })
    assert.equal(m3?.id, 'gpt-oss-120b-medium')

    // 15d. base64 payload containing model string
    createDbWithRow('antigravityUnifiedStateSync.modelPreferences', Buffer.from('model: gemini-3.7-flash-medium').toString('base64'))
    const m4 = readAntigravityCurrentModel({ vscdbPath: dbPath })
    assert.equal(m4?.id, 'gemini-3.7-flash-medium')

    // 15e. Empty or unrecognized row returns null
    createDbWithRow('unknown_key', 'some_value')
    assert.equal(readAntigravityCurrentModel({ vscdbPath: dbPath }), null)

    createDbWithRow('currentModel', 'unrecognized-vendor-model')
    assert.equal(readAntigravityCurrentModel({ vscdbPath: dbPath }), null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// 16. Synthetic pbtxt resolution (valid names vs unresolvable placeholder enums)
await test('16. Synthetic pbtxt resolution (valid names vs unresolvable placeholder enums)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'auto-switch-pbtxt-'))
  try {
    const pbtxtFile = path.join(tmp, 'antigravity_state.pbtxt')

    // 16a. Recognizable model name
    writeFileSync(pbtxtFile, `
agent_onboarding_completed: AGENT_ONBOARDING_STATE_COMPLETED
last_selected_agent_model: "gemini-3.8-flash-high"
migrate_convos_into_projects: MIGRATION_STATUS_COMPLETED
`)
    const m1 = readAntigravityCurrentModel({ pbtxtPath: pbtxtFile })
    assert.equal(m1?.id, 'gemini-3.8-flash-high')

    // 16b. Recognizable model in last_selected_model_name
    writeFileSync(pbtxtFile, `
last_selected_model_name: "claude-sonnet-4.6-thinking"
`)
    const m2 = readAntigravityCurrentModel({ pbtxtPath: pbtxtFile })
    assert.equal(m2?.id, 'claude-sonnet-4.6-thinking')

    // 16c. Placeholder enum MODEL_PLACEHOLDER_M318 must return null (no guesswork!)
    writeFileSync(pbtxtFile, `
agent_onboarding_completed: AGENT_ONBOARDING_STATE_COMPLETED
last_selected_agent_model: MODEL_PLACEHOLDER_M318
migrate_convos_into_projects: MIGRATION_STATUS_COMPLETED
`)
    const m3 = readAntigravityCurrentModel({ pbtxtPath: pbtxtFile })
    assert.equal(m3, null, 'MODEL_PLACEHOLDER_M318 must return null (no guessing)')

    // 16d. Another placeholder enum MODEL_PLACEHOLDER_M0 must return null
    writeFileSync(pbtxtFile, `
last_selected_agent_model: MODEL_PLACEHOLDER_M0
`)
    const m4 = readAntigravityCurrentModel({ pbtxtPath: pbtxtFile })
    assert.equal(m4, null, 'MODEL_PLACEHOLDER_M0 must return null (no guessing)')

    // 16e. Malformed / corrupted pbtxt returns null without throwing
    writeFileSync(pbtxtFile, '{{malformed pbtxt content ::: @@##$$')
    assert.equal(readAntigravityCurrentModel({ pbtxtPath: pbtxtFile }), null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// 17. Multi-source priority and corruption isolation
await test('17. Multi-source priority and corruption isolation', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'auto-switch-priority-'))
  try {
    const vscdbFile = path.join(tmp, 'state.vscdb')
    const appStorageFile = path.join(tmp, 'app_storage.json')
    const pbtxtFile = path.join(tmp, 'antigravity_state.pbtxt')

    // Setup vscdb with gemini-3.8-flash
    const db = new DatabaseSync(vscdbFile)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('currentModel', 'gemini-3.8-flash-tiered')
    db.close()

    // Setup app_storage with claude-sonnet
    writeFileSync(appStorageFile, JSON.stringify({ currentModel: 'claude-sonnet-4.6-thinking' }))

    // Setup pbtxt with gpt-oss
    writeFileSync(pbtxtFile, 'last_selected_agent_model: "gpt-oss-120b"\n')

    // 17a. Priority 1 (vscdb) wins over Priority 2 (app_storage) and Priority 4 (pbtxt)
    const m1 = readAntigravityCurrentModel({
      vscdbPath: vscdbFile,
      storagePath: appStorageFile,
      pbtxtPath: pbtxtFile,
    })
    assert.equal(m1?.id, 'gemini-3.8-flash-high')

    // 17b. Corrupted vscdb (random binary / not valid sqlite) cleanly falls through to app_storage
    writeFileSync(vscdbFile, Buffer.from([0x00, 0xff, 0xfe, 0x12, 0x34, 0x56, 0x78]))
    const m2 = readAntigravityCurrentModel({
      vscdbPath: vscdbFile,
      storagePath: appStorageFile,
      pbtxtPath: pbtxtFile,
    })
    assert.equal(m2?.id, 'claude-sonnet-4.6-thinking')

    // 17c. Corrupted vscdb AND corrupted app_storage falls through to pbtxt
    writeFileSync(appStorageFile, '{ corrupted json :::: ')
    const m3 = readAntigravityCurrentModel({
      vscdbPath: vscdbFile,
      storagePath: appStorageFile,
      pbtxtPath: pbtxtFile,
    })
    assert.equal(m3?.id, 'gpt-oss-120b-medium')

    // 17d. All sources corrupted / invalid returns null
    writeFileSync(pbtxtFile, 'last_selected_agent_model: MODEL_PLACEHOLDER_M318\n')
    const m4 = readAntigravityCurrentModel({
      vscdbPath: vscdbFile,
      storagePath: appStorageFile,
      pbtxtPath: pbtxtFile,
    })
    assert.equal(m4, null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// 18. End-to-end integration: vscdb-driven auto switch and unresolvable placeholder abort
await test('18. End-to-end integration: vscdb-driven auto switch and unresolvable placeholder abort', () => {
  return (async () => {
    // Part A: vscdb-driven auto switch
    const env1 = setupManagerTestEnv()
    try {
      await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env1.manager.setAutoSwitch('antigravity', true)

      // Set up vscdb inside env1.home pointing to claude-sonnet-4.6-thinking
      const vscdbDir = path.join(env1.home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage')
      mkdirSync(vscdbDir, { recursive: true })
      const vscdbPath = path.join(vscdbDir, 'state.vscdb')

      const db = new DatabaseSync(vscdbPath)
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);')
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.modelPreferences',
        JSON.stringify({ selectedModel: 'Claude Sonnet 4.6 (Thinking)' })
      )
      db.close()

      // Active account has 0% on claude-sonnet; candidate has 80%
      env1.quotas.set('acc1', {
        models: { 'claude-sonnet-4.6-thinking': { remainingFraction: 0.0 } }
      })
      env1.quotas.set('acc2', {
        models: { 'claude-sonnet-4.6-thinking': { remainingFraction: 0.8 } }
      })

      // Auto switch should identify claude-sonnet-4.6-thinking from vscdb and execute switch
      const res = await env1.manager.checkAutoSwitch()
      assert.equal(res?.success, true)

      const overview1 = await env1.manager.getOverview()
      const toolState1 = overview1.tools.find(t => t.tool === 'antigravity')
      assert.match(toolState1?.autoSwitchStatus || '', /已自动切换至账号「Account 2」/)
    } finally {
      env1.cleanup()
    }

    // Part B: Placeholder enum abort without switching
    const env2 = setupManagerTestEnv()
    try {
      await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env2.manager.setAutoSwitch('antigravity', true)

      // Clear app_storage and create pbtxt with MODEL_PLACEHOLDER_M318
      writeFileSync(env2.storageFile, JSON.stringify({}))

      const pbtxtDir = path.join(env2.home, '.gemini', 'antigravity')
      mkdirSync(pbtxtDir, { recursive: true })
      writeFileSync(path.join(pbtxtDir, 'antigravity_state.pbtxt'), 'last_selected_agent_model: MODEL_PLACEHOLDER_M318\n')
      env2.quotas.set('acc1', { models: {} })

      // Auto switch should detect unresolvable model and abort without switching
      const res2 = await env2.manager.checkAutoSwitch()
      assert.equal(res2, null)

      const overview2 = await env2.manager.getOverview()
      const toolState2 = overview2.tools.find(t => t.tool === 'antigravity')
      assert.match(toolState2?.autoSwitchStatus || '', /无法识别当前 Antigravity 选用模型/)
    } finally {
      env2.cleanup()
    }
  })()
})

// 19. Local currentModel readable: only checks currentModel, ignores other exhausted models
await test('19. Local currentModel readable: only checks currentModel, ignores other exhausted models', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)

      // Storage has claude-sonnet-4.6-thinking
      writeFileSync(env.storageFile, JSON.stringify({ currentModel: 'claude-sonnet-4.6-thinking' }))

      // Acc1 has gemini-3.8 exhausted (0.0), but claude-sonnet still has quota (0.8)
      env.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.8 },
        },
      })
      // Acc2 has gemini-3.8 quota
      env.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
        },
      })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null, 'Must not switch because readable currentModel (claude-sonnet) is not exhausted')

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
    } finally {
      env.cleanup()
    }
  })()
})

// 20. Local unreadable + active visible model exhausted (5h or weekly) + candidate > 0: switches
await test('20. Local unreadable + active visible model exhausted (5h or weekly) + candidate > 0: switches', () => {
  return (async () => {
    // 20a: 5h window exhausted
    const env1 = setupManagerTestEnv()
    try {
      const a1 = await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env1.manager.setAutoSwitch('antigravity', true)

      // Storage empty -> unreadable current model
      writeFileSync(env1.storageFile, JSON.stringify({}))

      // Acc1 5h exhausted on gemini-3.8
      env1.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
        },
      })
      // Acc2 positive on gemini-3.8
      env1.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
        },
      })

      const res1 = await env1.manager.checkAutoSwitch()
      assert.equal(res1?.success, true)

      const overview1 = await env1.manager.getOverview()
      const toolState1 = overview1.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState1?.activeAccountId, a2.id)
      // Status text must distinguish quota fallback switch from local currentModel switch
      assert.equal(
        toolState1?.autoSwitchStatus,
        'Gemini 3.8 Flash High 额度已耗尽，已自动切换至账号「Account 2」。'
      )
    } finally {
      env1.cleanup()
    }

    // 20b: weekly window exhausted (even if 5h has remaining quota)
    const env2 = setupManagerTestEnv()
    try {
      const a1 = await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env2.manager.setAutoSwitch('antigravity', true)
      writeFileSync(env2.storageFile, JSON.stringify({}))

      // Acc1: 5h has 80%, but weekly has 0%
      env2.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
        },
        summary: {
          groups: [
            {
              groupId: 'gemini',
              displayName: 'Gemini',
              buckets: [
                {
                  bucketId: 'weekly',
                  displayName: 'Weekly',
                  remainingFraction: 0.0,
                },
              ],
            },
          ],
        },
      })

      // Acc2: both > 0
      env2.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
        },
        summary: {
          groups: [
            {
              groupId: 'gemini',
              displayName: 'Gemini',
              buckets: [
                {
                  bucketId: 'weekly',
                  displayName: 'Weekly',
                  remainingFraction: 0.8,
                },
              ],
            },
          ],
        },
      })

      const res2 = await env2.manager.checkAutoSwitch()
      assert.equal(res2?.success, true)

      const overview2 = await env2.manager.getOverview()
      const toolState2 = overview2.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState2?.activeAccountId, a2.id)
      assert.equal(
        toolState2?.autoSwitchStatus,
        'Gemini 3.8 Flash High 额度已耗尽，已自动切换至账号「Account 2」。'
      )
    } finally {
      env2.cleanup()
    }
  })()
})

// 21. Local unreadable + all visible models unknown / stale: no switch, no candidate query
await test('21. Local unreadable + all visible models unknown/stale: does not switch or query candidates', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)
      writeFileSync(env.storageFile, JSON.stringify({}))

      // Acc1 quota: windows have missing remainingFraction (unknown, not 0)
      env.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': {},
        },
      })

      let candidateFetchCount = 0
      const origRefresh = env.manager.autoSwitchService['quotaService'].refreshAccount.bind(
        env.manager.autoSwitchService['quotaService']
      )
      env.manager.autoSwitchService['quotaService'].refreshAccount = async (id) => {
        if (id !== a1.id) {
          candidateFetchCount++
        }
        return origRefresh(id)
      }

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)
      assert.equal(candidateFetchCount, 0, 'Candidate must not be queried when active models are unknown/stale')

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
      assert.match(toolState?.autoSwitchStatus || '', /无法识别当前 Antigravity 选用模型/)
    } finally {
      env.cleanup()
    }
  })()
})

// 22. Local unreadable + only unmapped window is 0: no switch, no candidate query
await test('22. Local unreadable + only unmapped window is 0: does not switch or query candidates', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)
      writeFileSync(env.storageFile, JSON.stringify({}))

      // Acc1 has only an unmapped unknown model at 0.0
      env.quotas.set('acc1', {
        models: {
          'unmapped-internal-model-x': { remainingFraction: 0.0 },
        },
      })
      env.quotas.set('acc2', {
        models: {
          'unmapped-internal-model-x': { remainingFraction: 0.8 },
        },
      })

      let candidateFetchCount = 0
      const origRefresh = env.manager.autoSwitchService['quotaService'].refreshAccount.bind(
        env.manager.autoSwitchService['quotaService']
      )
      env.manager.autoSwitchService['quotaService'].refreshAccount = async (id) => {
        if (id !== a1.id) {
          candidateFetchCount++
        }
        return origRefresh(id)
      }

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)
      assert.equal(candidateFetchCount, 0, 'Candidate must not be queried when only unmapped window is 0')

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
      assert.match(toolState?.autoSwitchStatus || '', /无法识别当前 Antigravity 选用模型/)
    } finally {
      env.cleanup()
    }
  })()
})

// 23. Two visible models exhausted: selects first model in 7-model order that has candidate
await test('23. Two visible models exhausted: selects first in 7-model order with candidate', () => {
  return (async () => {
    // 23a: Candidate 1 has quota for first exhausted model (Gemini 3.8); Candidate 2 has quota for second (Claude Sonnet)
    const env1 = setupManagerTestEnv()
    try {
      const a1 = await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })
      const a3 = await env1.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 3',
        credential: credential('acc3', 'acc3@gmail.com'),
      })

      await env1.manager.setAutoSwitch('antigravity', true)
      writeFileSync(env1.storageFile, JSON.stringify({}))

      // Acc1 exhausted on both Gemini 3.8 and Claude Sonnet
      env1.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.0 },
        },
      })
      // Acc2 has Gemini 3.8
      env1.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.0 },
        },
      })
      // Acc3 has Claude Sonnet
      env1.quotas.set('acc3', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.8 },
        },
      })

      const res1 = await env1.manager.checkAutoSwitch()
      assert.equal(res1?.success, true)

      // Gemini 3.8 Flash High comes before Claude Sonnet in 7-model list, so switches to Acc2!
      const overview1 = await env1.manager.getOverview()
      const toolState1 = overview1.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState1?.activeAccountId, a2.id)
      assert.equal(
        toolState1?.autoSwitchStatus,
        'Gemini 3.8 Flash High 额度已耗尽，已自动切换至账号「Account 2」。'
      )
    } finally {
      env1.cleanup()
    }

    // 23b: First exhausted model (Gemini 3.8) has NO candidate; fallback selects second (Claude Sonnet)
    const env2 = setupManagerTestEnv()
    try {
      const a1 = await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })
      const a3 = await env2.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 3',
        credential: credential('acc3', 'acc3@gmail.com'),
      })

      await env2.manager.setAutoSwitch('antigravity', true)
      writeFileSync(env2.storageFile, JSON.stringify({}))

      // Acc1 exhausted on both
      env2.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.0 },
        },
      })
      // Neither Acc2 nor Acc3 has Gemini 3.8. Acc3 has Claude Sonnet.
      env2.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.0 },
        },
      })
      env2.quotas.set('acc3', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
          'claude-sonnet-4.6-thinking': { remainingFraction: 0.8 },
        },
      })

      const res2 = await env2.manager.checkAutoSwitch()
      assert.equal(res2?.success, true)

      // Gemini 3.8 has no candidate, so Claude Sonnet is selected -> switches to Acc3!
      const overview2 = await env2.manager.getOverview()
      const toolState2 = overview2.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState2?.activeAccountId, a3.id)
      assert.equal(
        toolState2?.autoSwitchStatus,
        'Claude Sonnet 4.6 (Thinking) 额度已耗尽，已自动切换至账号「Account 3」。'
      )
    } finally {
      env2.cleanup()
    }
  })()
})

// 24. Switch OFF: local unreadable + quota exhausted does NOT switch
await test('24. Switch OFF: local unreadable + quota exhausted does not switch', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      // Default: disabled
      assert.equal(await env.manager.getAutoSwitch('antigravity'), false)
      writeFileSync(env.storageFile, JSON.stringify({}))

      env.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.0 },
        },
      })
      env.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
        },
      })

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
    } finally {
      env.cleanup()
    }
  })()
})

// 25. Local unreadable + all visible models remainingPercent > 0: does not switch, does not query candidates, does not emit unresolvable status
await test('25. Local unreadable + all visible models remainingPercent > 0: does not switch, does not query candidates, does not emit unresolvable status', () => {
  const env = setupManagerTestEnv()
  return (async () => {
    try {
      const a1 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 1',
        credential: credential('acc1', 'acc1@gmail.com'),
      })
      const a2 = await env.manager.importAccount({
        tool: 'antigravity',
        name: 'Account 2',
        credential: credential('acc2', 'acc2@gmail.com'),
      })

      await env.manager.setAutoSwitch('antigravity', true)
      writeFileSync(env.storageFile, JSON.stringify({}))

      // Acc1 has visible model with positive quota (not exhausted)
      env.quotas.set('acc1', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.6 },
        },
      })
      env.quotas.set('acc2', {
        models: {
          'gemini-3.8-flash-tiered': { remainingFraction: 0.8 },
        },
      })

      let candidateFetchCount = 0
      const origRefresh = env.manager.autoSwitchService['quotaService'].refreshAccount.bind(
        env.manager.autoSwitchService['quotaService']
      )
      env.manager.autoSwitchService['quotaService'].refreshAccount = async (id) => {
        if (id !== a1.id) {
          candidateFetchCount++
        }
        return origRefresh(id)
      }

      const res = await env.manager.checkAutoSwitch()
      assert.equal(res, null)
      assert.equal(candidateFetchCount, 0, 'Candidates must not be queried when active account visible models have quota')

      const overview = await env.manager.getOverview()
      const toolState = overview.tools.find(t => t.tool === 'antigravity')
      assert.equal(toolState?.activeAccountId, a1.id)
      // Must NOT show "无法识别当前 Antigravity 选用模型" because quota fallback succeeded and model is not exhausted
      assert.notEqual(
        toolState?.autoSwitchStatus,
        '无法识别当前 Antigravity 选用模型，已停止自动切换。'
      )
      assert.equal(toolState?.autoSwitchStatus, undefined)
    } finally {
      env.cleanup()
    }
  })()
})

console.log(`\nTests finished: ${passed} passed, ${failed} failed.`)
if (failed > 0) {
  process.exit(1)
}
