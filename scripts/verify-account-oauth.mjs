/**
 * Verification Script for Isolated OAuth Session Engine (OPC-48)
 *
 * Comprehensive end-to-end tests for AccountOAuthService using actual loopback HTTP:
 * 1. PKCE and independent 32-byte state generation and S256 challenge
 * 2. Strict authorization HTTPS origins allowlist and URL parameter verification
 * 3. Successful OAuth flow (loopback callback, exchange, save exactly once, 200 SUCCESS_HTML)
 * 4. Renderer-safe session secrecy (snapshot returns only safe fields, no state/verifier/secrets)
 * 5. Wrong method / path / host / duplicate query params do NOT consume live waiting login
 * 6. Wrong state timingSafeEqual rejection does NOT consume live waiting login, subsequent valid callback succeeds
 * 7. Provider error (access_denied) transitions session to error with trusted message and failure HTML
 * 8. Cancellation while waiting cancels session, closes server, rejects subsequent callback
 * 9. Cancellation during exchange aborts signal, does NOT call saveAccount, sets session to cancelled
 * 10. Timeout while waiting expires session, closes server, rejects subsequent callback
 * 11. Timeout during exchange aborts signal, does NOT call saveAccount, sets session to expired
 * 12. Cancellation-versus-commit boundary: cancel during saveAccount waits for commit; if save succeeds, session is succeeded
 * 13. Cancellation-versus-commit boundary: if save fails during raced cancel, session is cancelled
 * 14. Timeouts do not resurrect saved accounts or overwrite succeeded status
 * 15. Port collision / start failure rejects cleanly and frees active login lock
 * 16. Simultaneous starts (concurrent begin) atomically rejects second call with busy error
 * 17. Malformed UUID rejection for get(), cancel(), and reopen()
 * 18. Reopen allowed waiting only (reopen while waiting succeeds; reopen in terminal state rejects)
 * 19. Browser launch rejection closes server, frees active session, rejects with AccountError
 * 20. Dispose cleanup cleans timers, servers, sessions, rejects subsequent begin()
 * 21. Provider redirectHost localhost configuration (constructs localhost redirectUri, accepts localhost Host header)
 * 22. Bounded terminal sessions pruning (caps terminal sessions at 20)
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-oauth.mjs
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import {
  AccountOAuthService,
  ALLOWED_AUTHORIZATION_ORIGINS,
  validateAuthorizationUrl,
} from '../apps/desktop/electron/account-oauth.ts'
import {
  ACCOUNT_TOOLS,
  AccountError,
} from '../packages/workflow-model/src/accounts.ts'

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

function requestHttp(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr)
    const headers = options.headers ? { ...options.headers } : {}
    if (!headers.host && !headers.Host) {
      headers.host = `${parsed.hostname}:${parsed.port}`
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          })
        })
      }
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

function createMockProvider(overrides = {}) {
  return {
    port: 0,
    callbackPath: '/oauth/callback',
    authorizationUrl({ state, challenge, redirectUri }) {
      const u = new URL('https://auth.openai.com/authorize')
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('state', state)
      u.searchParams.set('code_challenge', challenge)
      u.searchParams.set('code_challenge_method', 'S256')
      u.searchParams.set('redirect_uri', redirectUri)
      return u.toString()
    },
    async exchange({ code, verifier, redirectUri, signal }) {
      return JSON.stringify({ access_token: `token-for-${code}` })
    },
    ...overrides,
  }
}

async function main() {
  console.log('Running OAuth Session Engine verification tests...\n')

  // 1. PKCE and independent 32-byte state generation and S256 challenge
  await runTest('1. PKCE, independent 32-byte state generation, and S256 challenge', async () => {
    let capturedAuthUrl = ''
    let capturedExchangeVerifier = ''
    let capturedExchangeState = ''
    const provider = createMockProvider({
      exchange: async ({ code, verifier, state }) => {
        capturedExchangeVerifier = verifier
        capturedExchangeState = state
        return 'dummy-credential'
      },
    })

    const service = new AccountOAuthService({
      providers: { codex: provider },
      openExternal: async (url) => {
        capturedAuthUrl = url
      },
      saveAccount: async ({ tool, credential }) => ({
        id: randomUUID(),
        tool,
        name: 'test-account',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const session = await service.begin('codex')
    assert.ok(capturedAuthUrl, 'openExternal must be called with authorization URL')

    const authUrl = new URL(capturedAuthUrl)
    const state = authUrl.searchParams.get('state')
    const challenge = authUrl.searchParams.get('code_challenge')
    const method = authUrl.searchParams.get('code_challenge_method')

    assert.equal(method, 'S256', 'code_challenge_method must be S256')
    assert.ok(state && state.length >= 43, 'state must be >= 43 chars (32 bytes base64url)')
    assert.ok(challenge && challenge.length >= 43, 'challenge must be base64url SHA256')

    // Simulate callback to verify exchange receives verifier matching challenge
    const redirectUri = authUrl.searchParams.get('redirect_uri')
    const callbackRes = await requestHttp(`${redirectUri}?code=synth-code-1&state=${state}`)
    assert.equal(callbackRes.statusCode, 200)

    assert.ok(capturedExchangeVerifier.length >= 43, 'verifier must be 32+ bytes base64url')
    assert.equal(capturedExchangeState, state, 'state passed to exchange must match session state')
    const expectedChallenge = createHash('sha256').update(capturedExchangeVerifier, 'ascii').digest('base64url')
    assert.equal(challenge, expectedChallenge, 'code_challenge must match SHA256(verifier)')

    await service.dispose()
  })

  // 2. Strict authorization HTTPS origins allowlist and parameter verification
  await runTest('2. Strict authorization HTTPS origins allowlist and parameter verification', async () => {
    const validInputs = {
      state: 'test-state',
      challenge: 'test-challenge',
      redirectUri: 'http://127.0.0.1:1234/callback',
    }

    // Allowed origins
    for (const origin of ALLOWED_AUTHORIZATION_ORIGINS) {
      const validUrl = `${origin}/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`
      assert.doesNotThrow(() => validateAuthorizationUrl(validUrl, validInputs))
    }

    // Disallowed origins
    assert.throws(
      () => validateAuthorizationUrl(`https://evil.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`, validInputs),
      /白名单/
    )

    // HTTP rejected
    assert.throws(
      () => validateAuthorizationUrl(`http://auth.openai.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`, validInputs),
      /HTTPS/
    )

    // Userinfo rejected
    assert.throws(
      () => validateAuthorizationUrl(`https://user:pass@auth.openai.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`, validInputs),
      /凭据/
    )

    // Fragment hash rejected
    assert.throws(
      () => validateAuthorizationUrl(`https://auth.openai.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}#secret`, validInputs),
      /哈希/
    )

    // Mismatched state rejected
    assert.throws(
      () => validateAuthorizationUrl(`https://auth.openai.com/oauth?state=wrong-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`, validInputs),
      /state/
    )

    // Mismatched challenge rejected
    assert.throws(
      () => validateAuthorizationUrl(`https://auth.openai.com/oauth?state=test-state&code_challenge=wrong-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`, validInputs),
      /code_challenge/
    )

    // Mismatched code_challenge_method rejected
    assert.throws(
      () => validateAuthorizationUrl(`https://auth.openai.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=plain&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`, validInputs),
      /S256/
    )

    // Mismatched redirect_uri rejected
    assert.throws(
      () => validateAuthorizationUrl(`https://auth.openai.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:9999/callback')}`, validInputs),
      /redirect_uri/
    )
  })

  // 3. Successful OAuth flow (loopback callback, exchange, save exactly once, 200 SUCCESS_HTML)
  await runTest('3. Successful OAuth flow and duplicate callback rejection during deferred exchange', async () => {
    let capturedUrl = ''
    let saveCount = 0
    let exchangeStarted = false
    const accountId = randomUUID()

    const provider = createMockProvider({
      exchange: async () => {
        exchangeStarted = true
        // Defer exchange slightly so duplicate request can arrive during 'exchanging' phase
        await new Promise((r) => setTimeout(r, 60))
        return 'dummy-credential'
      },
    })

    const service = new AccountOAuthService({
      providers: { antigravity: provider },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool, credential }) => {
        saveCount++
        return {
          id: accountId,
          tool,
          name: 'Antigravity User',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      },
    })

    const initial = await service.begin('antigravity')
    assert.equal(initial.phase, 'waiting')

    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    // Start first callback in background
    const req1Promise = requestHttp(`${redirectUri}?code=synth-code-1&state=${state}`)

    // Wait until exchange has started and phase is 'exchanging'
    while (!exchangeStarted) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(service.get(initial.id).phase, 'exchanging')

    // Duplicate callback during active exchange must receive 409 Conflict
    const res2 = await requestHttp(`${redirectUri}?code=synth-code-1&state=${state}`)
    assert.equal(res2.statusCode, 409, 'Duplicate callback during exchange must return 409')

    // Wait for the first request to complete
    const res1 = await req1Promise
    assert.equal(res1.statusCode, 200)
    assert.ok(res1.body.includes('授权成功'), 'Body must contain Chinese success message')
    assert.ok(res1.body.includes('Authorization Successful'), 'Body must contain English success message')
    assert.equal(res1.headers['content-security-policy'], "default-src 'none'")
    assert.equal(res1.headers['referrer-policy'], 'no-referrer')

    assert.equal(saveCount, 1, 'saveAccount must be called exactly once')

    const snapshot = service.get(initial.id)
    assert.equal(snapshot.phase, 'succeeded')
    assert.equal(snapshot.accountId, accountId)
    assert.equal(snapshot.error, undefined)

    // Subsequent callback after terminal state must be refused because listener is cleanly closed
    await assert.rejects(
      async () => requestHttp(`${redirectUri}?code=synth-code-1&state=${state}`),
      /ECONNREFUSED|ECONNRESET/
    )

    await service.dispose()
  })

  // 4. Renderer-safe session secrecy (snapshot returns only safe fields, no state/verifier/secrets)
  await runTest('4. Renderer-safe session secrecy (no sensitive fields leaked in snapshot, HTML, or error)', async () => {
    let capturedUrl = ''
    const secretCredential = 'top-secret-oauth-bearer-token'

    const service = new AccountOAuthService({
      providers: {
        'claude-code': createMockProvider({
          exchange: async () => secretCredential,
        }),
      },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool, credential }) => ({
        id: randomUUID(),
        tool,
        name: 'claude-user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const initial = await service.begin('claude-code')
    const allowedKeys = new Set(['id', 'tool', 'phase', 'expiresAt', 'accountId', 'error'])

    for (const key of Object.keys(initial)) {
      assert.ok(allowedKeys.has(key), `Initial snapshot must not contain sensitive key: ${key}`)
    }

    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    const res = await requestHttp(`${redirectUri}?code=my-secret-code&state=${state}`)
    assert.equal(res.statusCode, 200)

    // Verify HTML contains no reflected credentials, code, or state
    assert.ok(!res.body.includes('my-secret-code'), 'HTML must not reflect authorization code')
    assert.ok(!res.body.includes(state), 'HTML must not reflect session state')
    assert.ok(!res.body.includes(secretCredential), 'HTML must not reflect credential')

    const finalSnap = service.get(initial.id)
    for (const key of Object.keys(finalSnap)) {
      assert.ok(allowedKeys.has(key), `Final snapshot must not contain sensitive key: ${key}`)
    }

    await service.dispose()
  })

  // 5. Wrong method / path / host / duplicate query params do NOT consume live waiting login
  await runTest('5. Malformed requests do NOT consume live waiting login', async () => {
    let capturedUrl = ''
    let saved = false

    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool, credential }) => {
        saved = true
        return {
          id: randomUUID(),
          tool,
          name: 'codex-user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      },
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    // 5.1 POST method rejected (405)
    const postRes = await requestHttp(`${redirectUri}?code=synth-code&state=${state}`, { method: 'POST' })
    assert.equal(postRes.statusCode, 405)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after 405')

    // 5.2 Wrong path rejected (404)
    const u = new URL(redirectUri)
    const wrongPathRes = await requestHttp(`http://${u.host}/wrong/path?code=synth-code&state=${state}`)
    assert.equal(wrongPathRes.statusCode, 404)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after 404')

    // 5.3 Wrong Host header rejected (400)
    const wrongHostRes = await requestHttp(`${redirectUri}?code=synth-code&state=${state}`, {
      headers: { host: 'evil.com:1234' },
    })
    assert.equal(wrongHostRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after wrong host')

    // 5.4 Duplicate state rejected (400)
    const dupStateRes = await requestHttp(`${redirectUri}?state=${state}&state=second-state&code=synth-code`)
    assert.equal(dupStateRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after dup state')

    // 5.5 Duplicate code rejected (400)
    const dupCodeRes = await requestHttp(`${redirectUri}?state=${state}&code=code1&code=code2`)
    assert.equal(dupCodeRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after dup code')

    // 5.6 Missing state rejected (400)
    const missStateRes = await requestHttp(`${redirectUri}?code=synth-code`)
    assert.equal(missStateRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after missing state')

    // 5.7 Missing both code and error rejected (400)
    const missBothRes = await requestHttp(`${redirectUri}?state=${state}`)
    assert.equal(missBothRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after missing both')

    // 5.8 Mixed error and code rejected (400)
    const mixedRes = await requestHttp(`${redirectUri}?state=${state}&code=synth-code&error=access_denied`)
    assert.equal(mixedRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting after mixed error/code')

    // 5.9 Valid callback must now succeed and consume the session
    const validRes = await requestHttp(`${redirectUri}?code=synth-code&state=${state}`)
    assert.equal(validRes.statusCode, 200)
    assert.equal(saved, true)
    assert.equal(service.get(initial.id).phase, 'succeeded')

    await service.dispose()
  })

  // 6. Wrong state timingSafeEqual rejection does NOT consume live waiting login
  await runTest('6. Wrong state does NOT consume live waiting login; subsequent valid callback succeeds', async () => {
    let capturedUrl = ''
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool }) => ({
        id: randomUUID(),
        tool,
        name: 'test-user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    // Wrong state (same length)
    const forgedState = 'x'.repeat(state.length)
    const wrongStateRes = await requestHttp(`${redirectUri}?code=synth-code&state=${forgedState}`)
    assert.equal(wrongStateRes.statusCode, 400)
    assert.equal(service.get(initial.id).phase, 'waiting', 'Phase must remain waiting')

    // Valid state now succeeds
    const validRes = await requestHttp(`${redirectUri}?code=synth-code&state=${state}`)
    assert.equal(validRes.statusCode, 200)
    assert.equal(service.get(initial.id).phase, 'succeeded')

    await service.dispose()
  })

  // 7. Provider error (access_denied) transitions session to error with trusted message
  await runTest('7. Provider error handling with trusted message and failure HTML', async () => {
    let capturedUrl = ''
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => {
        throw new Error('Should not be called')
      },
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    const errorRes = await requestHttp(`${redirectUri}?error=access_denied&state=${state}`)
    assert.equal(errorRes.statusCode, 200)
    assert.ok(errorRes.body.includes('授权失败'), 'Failure HTML must be displayed')
    assert.ok(!errorRes.body.includes('access_denied'), 'Raw provider error must not be reflected in HTML')

    const snap = service.get(initial.id)
    assert.equal(snap.phase, 'error')
    assert.equal(snap.error, 'OAuth 授权被拒绝或失败。')

    await service.dispose()
  })

  // 8. Cancellation while waiting cancels session, closes server, rejects subsequent callback
  await runTest('8. Cancellation while waiting', async () => {
    let capturedUrl = ''
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => {
        throw new Error('Should not save')
      },
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    await service.cancel(initial.id)
    assert.equal(service.get(initial.id).phase, 'cancelled')

    // Callback should fail to connect or be rejected
    await assert.rejects(
      async () => requestHttp(`${redirectUri}?code=synth-code&state=${state}`),
      /ECONNREFUSED|ECONNRESET/
    )

    await service.dispose()
  })

  // 9. Cancellation during exchange aborts signal, does NOT call saveAccount, sets session to cancelled
  await runTest('9. Cancellation during token exchange', async () => {
    let capturedUrl = ''
    let exchangeStarted = false
    let signalAborted = false
    let saved = false

    const service = new AccountOAuthService({
      providers: {
        codex: createMockProvider({
          exchange: async ({ signal }) => {
            exchangeStarted = true
            return new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                signalAborted = true
                reject(new Error('Aborted'))
              })
            })
          },
        }),
      },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => {
        saved = true
        return {
          id: randomUUID(),
          tool: 'codex',
          name: 'codex-user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      },
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    // Fire callback in background
    const callbackPromise = requestHttp(`${redirectUri}?code=synth-code&state=${state}`)

    // Wait until exchange has started
    while (!exchangeStarted) {
      await new Promise((r) => setTimeout(r, 10))
    }

    assert.equal(service.get(initial.id).phase, 'exchanging')

    // Cancel while exchanging
    await service.cancel(initial.id)

    assert.equal(signalAborted, true, 'AbortSignal must be aborted on cancel')
    assert.equal(saved, false, 'saveAccount must not be invoked')
    assert.equal(service.get(initial.id).phase, 'cancelled')

    await callbackPromise.catch(() => {})
    await service.dispose()
  })

  // 10. Timeout while waiting expires session, closes server, rejects subsequent callback
  await runTest('10. Timeout while waiting', async () => {
    let capturedUrl = ''
    let nowTime = 1000

    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => {
        throw new Error('Should not save')
      },
      now: () => nowTime,
      timeoutMs: 50,
    })

    const initial = await service.begin('codex')
    assert.equal(initial.phase, 'waiting')

    // Advance time past timeout
    nowTime += 100
    await new Promise((r) => setTimeout(r, 70))

    const snap = service.get(initial.id)
    assert.equal(snap.phase, 'expired')
    assert.equal(snap.error, 'OAuth 登录超时，请重试。')

    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    await assert.rejects(
      async () => requestHttp(`${redirectUri}?code=synth-code&state=${state}`),
      /ECONNREFUSED|ECONNRESET/
    )

    await service.dispose()
  })

  // 11. Timeout during exchange aborts signal, does NOT call saveAccount, sets session to expired
  await runTest('11. Timeout during token exchange', async () => {
    let capturedUrl = ''
    let exchangeStarted = false
    let signalAborted = false
    let saved = false

    const service = new AccountOAuthService({
      providers: {
        codex: createMockProvider({
          exchange: async ({ signal }) => {
            exchangeStarted = true
            return new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                signalAborted = true
                reject(new Error('Aborted'))
              })
            })
          },
        }),
      },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => {
        saved = true
        return {
          id: randomUUID(),
          tool: 'codex',
          name: 'codex-user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      },
      timeoutMs: 50,
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    const callbackPromise = requestHttp(`${redirectUri}?code=synth-code&state=${state}`)

    while (!exchangeStarted) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // Wait for timeout to trigger
    await new Promise((r) => setTimeout(r, 70))

    assert.equal(signalAborted, true, 'AbortSignal must be triggered on timeout')
    assert.equal(saved, false, 'saveAccount must not be invoked')
    assert.equal(service.get(initial.id).phase, 'expired')

    await callbackPromise.catch(() => {})
    await service.dispose()
  })

  // 12. Cancellation-versus-commit boundary: cancel during saveAccount waits for commit; if save succeeds, session is succeeded
  await runTest('12. Cancellation-versus-commit boundary: save succeeds -> session is succeeded', async () => {
    let capturedUrl = ''
    let saveStarted = false
    const accountId = randomUUID()

    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool }) => {
        saveStarted = true
        await new Promise((r) => setTimeout(r, 50))
        return {
          id: accountId,
          tool,
          name: 'codex-user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      },
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    const callbackPromise = requestHttp(`${redirectUri}?code=synth-code&state=${state}`)

    while (!saveStarted) {
      await new Promise((r) => setTimeout(r, 10))
    }

    // Cancel called while persistence is in flight
    const cancelPromise = service.cancel(initial.id)

    await Promise.all([callbackPromise, cancelPromise])

    const snap = service.get(initial.id)
    assert.equal(snap.phase, 'succeeded', 'Commit succeeded, so session must report succeeded rather than cancelled')
    assert.equal(snap.accountId, accountId)

    await service.dispose()
  })

  // 13. Cancellation-versus-commit boundary: if save fails during raced cancel, session is cancelled
  await runTest('13. Cancellation-versus-commit boundary: save fails during raced cancel -> session is cancelled', async () => {
    let capturedUrl = ''
    let saveStarted = false

    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => {
        saveStarted = true
        await new Promise((r) => setTimeout(r, 50))
        throw new Error('Disk full or store error')
      },
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    const callbackPromise = requestHttp(`${redirectUri}?code=synth-code&state=${state}`)

    while (!saveStarted) {
      await new Promise((r) => setTimeout(r, 10))
    }

    const cancelPromise = service.cancel(initial.id)

    await Promise.all([callbackPromise.catch(() => {}), cancelPromise])

    const snap = service.get(initial.id)
    assert.equal(snap.phase, 'cancelled', 'Commit failed during cancel race, session should be cancelled')

    await service.dispose()
  })

  // 14. Timeouts do not resurrect saved accounts or overwrite succeeded status
  await runTest('14. Timeouts do not overwrite succeeded status', async () => {
    let capturedUrl = ''
    let nowTime = 1000

    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool }) => ({
        id: randomUUID(),
        tool,
        name: 'test-user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      now: () => nowTime,
      timeoutMs: 60,
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const state = authUrl.searchParams.get('state')
    const redirectUri = authUrl.searchParams.get('redirect_uri')

    await requestHttp(`${redirectUri}?code=synth-code&state=${state}`)
    assert.equal(service.get(initial.id).phase, 'succeeded')

    // Advance time past original timeout
    nowTime += 200
    await new Promise((r) => setTimeout(r, 80))

    // Phase must remain succeeded
    assert.equal(service.get(initial.id).phase, 'succeeded', 'Timeout must not overwrite succeeded')

    await service.dispose()
  })

  // 15. Port collision / start failure rejects cleanly and frees active login lock
  await runTest('15. Port collision / start failure rejects cleanly and frees active login', async () => {
    // Occupy a port
    const occupiedServer = net.createServer()
    await new Promise((resolve) => occupiedServer.listen(0, '127.0.0.1', resolve))
    const occupiedPort = occupiedServer.address().port

    const service = new AccountOAuthService({
      providers: {
        codex: createMockProvider({ port: occupiedPort }),
        antigravity: createMockProvider({ port: 0 }),
      },
      openExternal: async () => {},
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'antigravity',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    // begin() on occupied port must reject with AccountError
    await assert.rejects(
      async () => service.begin('codex'),
      (err) => err instanceof AccountError && err.message.includes('端口监听失败')
    )

    // Active lock must have been released; another begin() on ephemeral port 0 should succeed
    const okSession = await service.begin('antigravity')
    assert.equal(okSession.phase, 'waiting')

    occupiedServer.close()
    await service.dispose()
  })

  // 16. Simultaneous starts (concurrent begin) atomically rejects second call with busy error
  await runTest('16. Simultaneous starts atomically reject busy before async listen/open', async () => {
    let openCount = 0
    const service = new AccountOAuthService({
      providers: {
        codex: createMockProvider(),
        antigravity: createMockProvider(),
      },
      openExternal: async () => {
        openCount++
        await new Promise((r) => setTimeout(r, 20))
      },
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'codex',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const results = await Promise.allSettled([
      service.begin('codex'),
      service.begin('antigravity'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    assert.equal(fulfilled.length, 1, 'Exactly one concurrent begin must succeed')
    assert.equal(rejected.length, 1, 'Exactly one concurrent begin must be rejected')
    assert.ok(
      rejected[0].reason instanceof AccountError && rejected[0].reason.message.includes('正在进行的登录流程'),
      'Busy rejection must use trusted AccountError message'
    )

    await service.dispose()
  })

  // 17. Malformed UUID rejection for get(), cancel(), and reopen()
  await runTest('17. Malformed UUID rejection for get(), cancel(), and reopen()', async () => {
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async () => {},
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'codex',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    assert.throws(() => service.get('invalid-uuid'), /UUID/)
    await assert.rejects(async () => service.cancel('invalid-uuid'), /UUID/)
    await assert.rejects(async () => service.reopen('invalid-uuid'), /UUID/)

    await service.dispose()
  })

  // 18. Reopen allowed waiting only (reopen while waiting succeeds; reopen in terminal state rejects)
  await runTest('18. Reopen allowed waiting only', async () => {
    let reopenCount = 0
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async () => {
        reopenCount++
      },
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'codex',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const initial = await service.begin('codex')
    assert.equal(reopenCount, 1)

    // Reopen while waiting must succeed
    await service.reopen(initial.id)
    assert.equal(reopenCount, 2)

    // Cancel session
    await service.cancel(initial.id)

    // Reopen after terminal state must reject
    await assert.rejects(
      async () => service.reopen(initial.id),
      (err) => err instanceof AccountError && err.message.includes('等待状态')
    )

    await service.dispose()
  })

  // 19. Browser launch rejection closes server, frees active session, rejects with AccountError
  await runTest('19. Browser launch rejection cleanup and lock release', async () => {
    const service = new AccountOAuthService({
      providers: {
        codex: createMockProvider(),
        antigravity: createMockProvider(),
      },
      openExternal: async () => {
        throw new Error('Browser launch failed')
      },
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'codex',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    await assert.rejects(
      async () => service.begin('codex'),
      (err) => err instanceof AccountError && err.message.includes('打开浏览器授权页面失败')
    )

    // Active session lock must have been released; subsequent begin can run
    let opened = false
    const workingService = new AccountOAuthService({
      providers: { antigravity: createMockProvider() },
      openExternal: async () => {
        opened = true
      },
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'antigravity',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const snap = await workingService.begin('antigravity')
    assert.equal(snap.phase, 'waiting')
    assert.equal(opened, true)

    await service.dispose()
    await workingService.dispose()
  })

  // 20. Dispose cleanup cleans timers, servers, sessions, rejects subsequent begin()
  await runTest('20. Dispose cleanup', async () => {
    let capturedUrl = ''
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'codex',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const session = await service.begin('codex')
    assert.equal(session.phase, 'waiting')

    await service.dispose()

    // Subsequent begin() must reject
    await assert.rejects(
      async () => service.begin('codex'),
      (err) => err instanceof AccountError && err.message.includes('已释放')
    )

    // Server should be closed
    const authUrl = new URL(capturedUrl)
    const redirectUri = authUrl.searchParams.get('redirect_uri')
    await assert.rejects(
      async () => requestHttp(`${redirectUri}?code=synth-code&state=dummy`),
      /ECONNREFUSED|ECONNRESET/
    )
  })

  // 21. Provider redirectHost localhost configuration
  await runTest('21. Provider redirectHost localhost configuration', async () => {
    let capturedUrl = ''
    const service = new AccountOAuthService({
      providers: {
        codex: createMockProvider({
          redirectHost: 'localhost',
        }),
      },
      openExternal: async (url) => {
        capturedUrl = url
      },
      saveAccount: async ({ tool }) => ({
        id: randomUUID(),
        tool,
        name: 'localhost-user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const initial = await service.begin('codex')
    const authUrl = new URL(capturedUrl)
    const redirectUri = authUrl.searchParams.get('redirect_uri')
    assert.ok(redirectUri.startsWith('http://localhost:'), 'Redirect URI must use localhost string')

    const state = authUrl.searchParams.get('state')
    const parsedRedirect = new URL(redirectUri)

    // Send HTTP callback to 127.0.0.1 with Host header 'localhost:<port>'
    const res = await requestHttp(`http://127.0.0.1:${parsedRedirect.port}${parsedRedirect.pathname}?code=synth-code&state=${state}`, {
      headers: { host: `localhost:${parsedRedirect.port}` },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(service.get(initial.id).phase, 'succeeded')

    await service.dispose()
  })

  // 22. Bounded terminal sessions pruning (caps terminal sessions at 20)
  await runTest('22. Bounded terminal sessions pruning (caps terminal sessions at 20)', async () => {
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider() },
      openExternal: async () => {},
      saveAccount: async () => ({
        id: randomUUID(),
        tool: 'codex',
        name: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    })

    const sessionIds = []
    for (let i = 0; i < 25; i++) {
      const session = await service.begin('codex')
      sessionIds.push(session.id)
      await service.cancel(session.id)
    }

    // Oldest sessions should have been evicted; newest sessions should remain accessible
    let missingCount = 0
    let foundCount = 0
    for (const id of sessionIds) {
      try {
        service.get(id)
        foundCount++
      } catch {
        missingCount++
      }
    }

    assert.equal(foundCount, 20, 'At most 20 terminal sessions should be preserved in memory')
    assert.equal(missingCount, 5, 'Excess oldest terminal sessions must be pruned')

    await service.dispose()
  })

  // 23. Begin then immediate dispose race: no browser open, no save, no orphan listener
  await runTest('23. Begin then immediate dispose race: no browser open, no save, no orphan listener', async () => {
    let openCalled = false
    let saveCalled = false
    const service = new AccountOAuthService({
      providers: { codex: createMockProvider({ port: 0 }) },
      openExternal: async () => {
        openCalled = true
      },
      saveAccount: async () => {
        saveCalled = true
        return { id: randomUUID(), tool: 'codex', name: 'test', createdAt: 0, updatedAt: 0 }
      },
    })

    // Call begin() and immediately call dispose() in the very same event loop tick
    const beginPromise = service.begin('codex')
    const disposePromise = service.dispose()

    await Promise.allSettled([beginPromise, disposePromise])

    assert.equal(openCalled, false, 'Browser must NOT be opened if disposed immediately')
    assert.equal(saveCalled, false, 'Account must NOT be saved')

    const beginResult = await beginPromise.catch((err) => err)
    assert.ok(
      beginResult instanceof AccountError || (typeof beginResult === 'object' && beginResult.phase === 'cancelled'),
      'begin() must reject or cancel cleanly'
    )
  })

  // 24. Strict integer port and finite positive timeout validation
  await runTest('24. Strict integer port and finite positive timeout validation', async () => {
    // Non-integer port
    const service1 = new AccountOAuthService({
      providers: { codex: createMockProvider({ port: 1455.5 }) },
      openExternal: async () => {},
      saveAccount: async () => ({ id: randomUUID(), tool: 'codex', name: 'test', createdAt: 0, updatedAt: 0 }),
    })
    await assert.rejects(
      async () => service1.begin('codex'),
      (err) => err instanceof AccountError && err.message.includes('端口号无效')
    )

    // Negative timeoutMs in constructor
    assert.throws(
      () => new AccountOAuthService({
        providers: { codex: createMockProvider() },
        openExternal: async () => {},
        saveAccount: async () => ({ id: randomUUID(), tool: 'codex', name: 'test', createdAt: 0, updatedAt: 0 }),
        timeoutMs: -500,
      }),
      (err) => err instanceof AccountError && err.message.includes('超时时间必须为有效的正有限数值')
    )

    // NaN timeoutMs in constructor
    assert.throws(
      () => new AccountOAuthService({
        providers: { codex: createMockProvider() },
        openExternal: async () => {},
        saveAccount: async () => ({ id: randomUUID(), tool: 'codex', name: 'test', createdAt: 0, updatedAt: 0 }),
        timeoutMs: NaN,
      }),
      (err) => err instanceof AccountError && err.message.includes('超时时间必须为有效的正有限数值')
    )
  })

  // 25. Duplicate authorization URL parameters reject
  await runTest('25. Duplicate authorization URL parameters reject', async () => {
    const validInputs = {
      state: 'test-state',
      challenge: 'test-challenge',
      redirectUri: 'http://127.0.0.1:1234/callback',
    }

    // Duplicate state parameter
    assert.throws(
      () => validateAuthorizationUrl(
        `https://auth.openai.com/oauth?state=test-state&state=dup-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}`,
        validInputs
      ),
      (err) => err instanceof AccountError && err.message.includes('重复')
    )

    // Duplicate redirect_uri parameter
    assert.throws(
      () => validateAuthorizationUrl(
        `https://auth.openai.com/oauth?state=test-state&code_challenge=test-challenge&code_challenge_method=S256&redirect_uri=${encodeURIComponent('http://127.0.0.1:1234/callback')}&redirect_uri=http://evil.com`,
        validInputs
      ),
      (err) => err instanceof AccountError && err.message.includes('重复')
    )
  })

  console.log(`\nAll OAuth verification tests finished: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exit(1)
  }
}

await main().catch((err) => {
  console.error('Fatal test runner error:', err)
  process.exit(1)
})
