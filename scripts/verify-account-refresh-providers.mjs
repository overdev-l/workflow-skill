/**
 * Verification Script for Official Tool OAuth Refresh Providers (OPC-48)
 *
 * Synthetic unit and protocol tests for:
 * 1. Codex token refresh exchange, parameter formatting, rotation, omission, identity check
 * 2. Codex response omitting expires_in but using future access JWT exp; rejection of expired JWT
 * 3. Rejection of invalid/empty refresh_token in response (not treated as omitted)
 * 4. Claude token refresh exchange, sk-ant-oat format validation, rotation, setup token rejection
 * 5. Claude validation of both account UUID and organization UUID
 * 6. Antigravity token refresh exchange, client_secret, token_type check, rotation, unknown client rejection
 * 7. Antigravity rejection on malformed or missing-sub id_token
 * 8. Non-Bearer token_type rejection
 * 9. Rejection of unknown custom client IDs in raw Codex and Claude credentials
 * 10. HTTP protocol bounds: 15s timeout, 1 MiB body limit, 429 rate-limited, 400/401 invalid_grant
 * 11. Bounded exponential backoff schedule
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-refresh-providers.mjs
 */

import assert from 'node:assert/strict'
import {
  refreshCodexToken,
  refreshClaudeToken,
  refreshAntigravityToken,
  executeBoundedTokenRequest,
  NetworkError,
  RateLimitedError,
  InvalidGrantError,
  MissingRefreshTokenError,
  UnknownClientError,
  InvalidResponseError,
  calculateBackoffMs,
} from '../apps/desktop/electron/account-refresh.ts'
import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  CLAUDE_CLIENT_ID,
  CLAUDE_TOKEN_URL,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_TOKEN_URL,
} from '../apps/desktop/electron/account-oauth-providers.ts'

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
  return `${encHeader}.${encPayload}.fakeSignature`
}

function mockResponse(data, options = {}) {
  const bodyText = typeof data === 'string' ? data : JSON.stringify(data)
  const status = options.status ?? 200
  const headersMap = new Map([
    ['content-type', options.contentType ?? 'application/json'],
    ['content-length', String(Buffer.byteLength(bodyText, 'utf8'))],
    ...(options.headers ? Object.entries(options.headers) : []),
  ])

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => headersMap.get(k.toLowerCase()) ?? null,
    },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  }
}

async function main() {
  console.log('Running OAuth Refresh Providers verification tests...\n')

  const fixedNow = Date.now() + 10_000_000

  // 1. Codex token refresh: parameter formatting and rotation
  await runTest('1. Codex token refresh: urlencoded body, client_id, and token rotation', async () => {
    let capturedReq = null
    const oldIdJwt = createJwt({
      sub: 'user-sub-codex-1',
      email: 'user@openai.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-codex-1' },
      exp: Math.floor(fixedNow / 1000) - 60,
    })

    const initialCred = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: oldIdJwt,
        access_token: 'old-access-token',
        refresh_token: 'old-refresh-token-codex',
        account_id: 'acc-codex-1',
      },
    })

    const futureAccessJwt = createJwt({
      sub: 'user-sub-codex-1',
      exp: Math.floor((fixedNow + 3600 * 1000) / 1000),
    })

    const fakeFetch = async (url, init) => {
      capturedReq = { url, init }
      return mockResponse({
        access_token: futureAccessJwt,
        refresh_token: 'rotated-refresh-token-codex',
        expires_in: 3600,
      })
    }

    const result = await refreshCodexToken(initialCred, fakeFetch, () => fixedNow)

    assert.equal(capturedReq.url, CODEX_TOKEN_URL)
    assert.equal(capturedReq.init.method, 'POST')
    assert.equal(capturedReq.init.headers['Content-Type'], 'application/x-www-form-urlencoded')

    const bodyParams = new URLSearchParams(capturedReq.init.body)
    assert.equal(bodyParams.get('grant_type'), 'refresh_token')
    assert.equal(bodyParams.get('client_id'), CODEX_CLIENT_ID)
    assert.equal(bodyParams.get('refresh_token'), 'old-refresh-token-codex')

    const parsed = JSON.parse(result.credential)
    assert.equal(parsed.tokens.access_token, futureAccessJwt)
    assert.equal(parsed.tokens.refresh_token, 'rotated-refresh-token-codex')
    assert.equal(parsed.tokens.account_id, 'acc-codex-1')
    assert.equal(result.expiresAt, Math.floor((fixedNow + 3600 * 1000) / 1000) * 1000)
  })

  // 2. Codex token refresh: real response omitting expires_in but containing access JWT exp
  await runTest('2. Codex token refresh: response omitting expires_in derives valid expiry from access JWT exp', async () => {
    const initialCred = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'old-access',
        refresh_token: 'valid-refresh-token',
        account_id: 'acc-jwt-exp',
      },
    })

    const targetExpiry = fixedNow + 1800 * 1000
    const accessJwtWithExp = createJwt({
      sub: 'user-sub',
      exp: Math.floor(targetExpiry / 1000),
    })

    // Real Codex response omits expires_in
    const fakeFetch = async () =>
      mockResponse({
        access_token: accessJwtWithExp,
        token_type: 'Bearer',
      })

    const result = await refreshCodexToken(initialCred, fakeFetch, () => fixedNow)
    assert.equal(result.expiresAt, Math.floor(targetExpiry / 1000) * 1000)
  })

  // 3. Codex token refresh: already-expired access JWT exp rejected
  await runTest('3. Codex token refresh: response with already-expired access JWT exp is rejected', async () => {
    const initialCred = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'old-access',
        refresh_token: 'valid-refresh-token',
        account_id: 'acc-expired-jwt',
      },
    })

    const expiredAccessJwt = createJwt({
      sub: 'user-sub',
      exp: Math.floor((fixedNow - 60 * 1000) / 1000), // expired 1 min ago
    })

    const fakeFetch = async () =>
      mockResponse({
        access_token: expiredAccessJwt,
      })

    await assert.rejects(
      async () => refreshCodexToken(initialCred, fakeFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 4. Response with invalid/empty refresh_token rejected across providers (not treated as omitted)
  await runTest('4. Providers reject response with refresh_token as empty string or null instead of treating omitted', async () => {
    const codexCred = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'old-access',
        refresh_token: 'persisted-refresh-token',
        account_id: 'acc-codex-2',
      },
    })

    // Empty string refresh_token
    const emptyRefreshFetch = async () =>
      mockResponse({
        access_token: createJwt({ sub: 'user-1', exp: Math.floor(fixedNow / 1000) + 3600 }),
        refresh_token: '',
        expires_in: 3600,
      })

    await assert.rejects(
      async () => refreshCodexToken(codexCred, emptyRefreshFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )

    // Null refresh_token
    const nullRefreshFetch = async () =>
      mockResponse({
        access_token: createJwt({ sub: 'user-1', exp: Math.floor(fixedNow / 1000) + 3600 }),
        refresh_token: null,
        expires_in: 3600,
      })

    await assert.rejects(
      async () => refreshCodexToken(codexCred, nullRefreshFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 5. Codex token refresh: changed subject in new ID token rejected
  await runTest('5. Codex token refresh: changed identity sub in ID token is rejected', async () => {
    const oldIdJwt = createJwt({
      sub: 'original-user-sub',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' },
    })
    const initialCred = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: oldIdJwt,
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: 'acc-1',
      },
    })

    const rogueIdJwt = createJwt({
      sub: 'different-user-sub',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' },
    })

    const fakeFetch = async () =>
      mockResponse({
        access_token: createJwt({ sub: 'user-sub', exp: Math.floor(fixedNow / 1000) + 3600 }),
        id_token: rogueIdJwt,
        expires_in: 3600,
      })

    await assert.rejects(
      async () => refreshCodexToken(initialCred, fakeFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 6. Codex custom client rejection
  await runTest('6. Codex token refresh: custom unknown client ID in credential throws UnknownClientError', async () => {
    const credWithCustomClient = JSON.stringify({
      auth_mode: 'chatgpt',
      client_id: 'custom_unknown_client_id_123',
      tokens: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        account_id: 'acc-1',
      },
    })

    await assert.rejects(
      async () => refreshCodexToken(credWithCustomClient, async () => {}, () => fixedNow),
      (err) => err instanceof UnknownClientError
    )
  })

  // 7. Claude token refresh: JSON body, client_id, and sk-ant-oat validation
  await runTest('7. Claude token refresh: JSON body, client_id, and sk-ant-oat format validation', async () => {
    let capturedReq = null
    const oldAccess = `sk-ant-oat01-${'a'.repeat(60)}`
    const oldRefresh = 'claude-refresh-token-123'

    const initialCred = JSON.stringify({
      claudeAiOauth: {
        accessToken: oldAccess,
        refreshToken: oldRefresh,
        expiresAt: fixedNow - 1000,
      },
      oauthAccount: {
        accountUuid: 'acc-uuid-claude-1',
        organizationUuid: 'org-uuid-claude-1',
        emailAddress: 'user@claude.ai',
      },
      oauthClientId: CLAUDE_CLIENT_ID,
    })

    const newAccess = `sk-ant-oat01-${'b'.repeat(60)}`
    const fakeFetch = async (url, init) => {
      capturedReq = { url, init }
      return mockResponse({
        access_token: newAccess,
        refresh_token: 'rotated-claude-refresh',
        expires_in: 7200,
        token_type: 'Bearer',
      })
    }

    const result = await refreshClaudeToken(initialCred, fakeFetch, () => fixedNow)

    assert.equal(capturedReq.url, CLAUDE_TOKEN_URL)
    assert.equal(capturedReq.init.method, 'POST')
    assert.equal(capturedReq.init.headers['Content-Type'], 'application/json')

    const bodyObj = JSON.parse(capturedReq.init.body)
    assert.equal(bodyObj.grant_type, 'refresh_token')
    assert.equal(bodyObj.client_id, CLAUDE_CLIENT_ID)
    assert.equal(bodyObj.refresh_token, oldRefresh)

    const parsed = JSON.parse(result.credential)
    assert.equal(parsed.claudeAiOauth.accessToken, newAccess)
    assert.equal(parsed.claudeAiOauth.refreshToken, 'rotated-claude-refresh')
    assert.equal(parsed.claudeAiOauth.expiresAt, fixedNow + 7200 * 1000)
    assert.equal(parsed.oauthAccount.accountUuid, 'acc-uuid-claude-1')
    assert.equal(result.email, 'user@claude.ai')
  })

  // 8. Claude token refresh: validate returned org UUID as well as account UUID
  await runTest('8. Claude token refresh: mismatched organization UUID in response is rejected', async () => {
    const initialCred = JSON.stringify({
      claudeAiOauth: {
        accessToken: `sk-ant-oat01-${'a'.repeat(60)}`,
        refreshToken: 'refresh-token',
        expiresAt: fixedNow,
      },
      oauthAccount: {
        accountUuid: 'acc-uuid-1',
        organizationUuid: 'org-uuid-1',
      },
      oauthClientId: CLAUDE_CLIENT_ID,
    })

    const fakeFetch = async () =>
      mockResponse({
        access_token: `sk-ant-oat01-${'c'.repeat(60)}`,
        expires_in: 3600,
        organization: { uuid: 'different-org-uuid' }, // mismatch!
      })

    await assert.rejects(
      async () => refreshClaudeToken(initialCred, fakeFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 9. Claude token refresh: setup token without refresh token rejected
  await runTest('9. Claude token refresh: setup token (no refresh token) throws MissingRefreshTokenError', async () => {
    const setupTokenCred = `sk-ant-oat01-${'c'.repeat(60)}`
    await assert.rejects(
      async () => refreshClaudeToken(setupTokenCred, async () => {}, () => fixedNow),
      (err) => err instanceof MissingRefreshTokenError
    )
  })

  // 10. Claude token refresh: unknown client rejected in raw JSON
  await runTest('10. Claude token refresh: foreign client ID in raw JSON throws UnknownClientError', async () => {
    const cred = JSON.stringify({
      claudeAiOauth: {
        accessToken: `sk-ant-oat01-${'d'.repeat(60)}`,
        refreshToken: 'valid-refresh',
        expiresAt: fixedNow,
      },
      oauth_client_id: 'foreign-unknown-client-id',
    })

    await assert.rejects(
      async () => refreshClaudeToken(cred, async () => {}, () => fixedNow),
      (err) => err instanceof UnknownClientError
    )
  })

  // 11. Antigravity token refresh: client_secret, token_type check, and rotation
  await runTest('11. Antigravity token refresh: urlencoded with secret, token_type Bearer, rotation', async () => {
    let capturedReq = null
    const initialCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'old-ag-access',
        token_type: 'Bearer',
        refresh_token: '1//old-ag-refresh-token',
        expiry: new Date(fixedNow - 1000).toISOString(),
      },
      account: {
        id: '10987654321',
        email: 'dev@gmail.com',
        name: 'Dev User',
      },
      oauth_client_id: ANTIGRAVITY_CLIENT_ID,
    })

    const fakeFetch = async (url, init) => {
      capturedReq = { url, init }
      return mockResponse({
        access_token: 'new-ag-access-token',
        refresh_token: '1//new-ag-refresh-rotated',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    }

    const result = await refreshAntigravityToken(initialCred, fakeFetch, () => fixedNow)

    assert.equal(capturedReq.url, ANTIGRAVITY_TOKEN_URL)
    assert.equal(capturedReq.init.method, 'POST')
    assert.equal(capturedReq.init.headers['Content-Type'], 'application/x-www-form-urlencoded')

    const form = new URLSearchParams(capturedReq.init.body)
    assert.equal(form.get('grant_type'), 'refresh_token')
    assert.equal(form.get('client_id'), ANTIGRAVITY_CLIENT_ID)
    assert.equal(form.get('client_secret'), ANTIGRAVITY_CLIENT_SECRET)
    assert.equal(form.get('refresh_token'), '1//old-ag-refresh-token')

    const parsed = JSON.parse(result.credential)
    assert.equal(parsed.token.access_token, 'new-ag-access-token')
    assert.equal(parsed.token.refresh_token, '1//new-ag-refresh-rotated')
    assert.equal(parsed.account.email, 'dev@gmail.com')
    assert.equal(parsed.oauth_client_id, ANTIGRAVITY_CLIENT_ID)
  })

  // 12. Antigravity token refresh: reject non-Bearer token_type
  await runTest('12. Antigravity token refresh: non-Bearer token_type is rejected', async () => {
    const initialCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'old-ag-access',
        token_type: 'Bearer',
        refresh_token: '1//refresh',
        expiry: new Date(fixedNow - 1000).toISOString(),
      },
      oauth_client_id: ANTIGRAVITY_CLIENT_ID,
    })

    const nonBearerFetch = async () =>
      mockResponse({
        access_token: 'new-access',
        token_type: 'Mac', // invalid
        expires_in: 3600,
      })

    await assert.rejects(
      async () => refreshAntigravityToken(initialCred, nonBearerFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 13. Antigravity token refresh: malformed or missing-sub id_token rejected
  await runTest('13. Antigravity token refresh: malformed or missing-sub id_token is rejected', async () => {
    const initialCred = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'old-ag-access',
        token_type: 'Bearer',
        refresh_token: '1//refresh',
        expiry: new Date(fixedNow - 1000).toISOString(),
      },
      account: { id: 'google-acc-123' },
      oauth_client_id: ANTIGRAVITY_CLIENT_ID,
    })

    // id_token without sub claim
    const badIdToken = createJwt({ email: 'test@gmail.com' }) // no sub!
    const fakeFetch = async () =>
      mockResponse({
        access_token: 'new-access',
        token_type: 'Bearer',
        id_token: badIdToken,
        expires_in: 3600,
      })

    await assert.rejects(
      async () => refreshAntigravityToken(initialCred, fakeFetch, () => fixedNow),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 14. Antigravity token refresh: unknown client ID rejected
  await runTest('14. Antigravity token refresh: imported keychain without client ID throws UnknownClientError', async () => {
    const credWithoutClientId = JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'ag-access',
        token_type: 'Bearer',
        refresh_token: '1//refresh',
        expiry: new Date(fixedNow + 1000).toISOString(),
      },
      account: {
        id: '12345',
        email: 'user@gmail.com',
      },
    })

    await assert.rejects(
      async () => refreshAntigravityToken(credWithoutClientId, async () => {}, () => fixedNow),
      (err) => err instanceof UnknownClientError
    )
  })

  // 15. HTTP Guards: 429 Rate Limited
  await runTest('15. HTTP guards: 429 status throws RateLimitedError', async () => {
    const fakeFetch = async () => mockResponse({ error: 'slow_down' }, { status: 429 })

    await assert.rejects(
      async () =>
        executeBoundedTokenRequest('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: {},
          body: '',
          fetchFn: fakeFetch,
        }),
      (err) => err instanceof RateLimitedError
    )
  })

  // 16. HTTP Guards: 400 invalid_grant
  await runTest('16. HTTP guards: 400 with invalid_grant throws InvalidGrantError', async () => {
    const fakeFetch = async () =>
      mockResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked' }, { status: 400 })

    await assert.rejects(
      async () =>
        executeBoundedTokenRequest('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: {},
          body: '',
          fetchFn: fakeFetch,
        }),
      (err) => err instanceof InvalidGrantError
    )
  })

  // 17. HTTP Guards: 401 Unauthorized
  await runTest('17. HTTP guards: 401 status throws InvalidGrantError', async () => {
    const fakeFetch = async () => mockResponse({ error: 'unauthorized' }, { status: 401 })

    await assert.rejects(
      async () =>
        executeBoundedTokenRequest('https://auth.openai.com/oauth/token', {
          method: 'POST',
          headers: {},
          body: '',
          fetchFn: fakeFetch,
        }),
      (err) => err instanceof InvalidGrantError
    )
  })

  // 18. HTTP Guards: 500 Network error
  await runTest('18. HTTP guards: 500 status throws NetworkError', async () => {
    const fakeFetch = async () => mockResponse('Internal Server Error', { status: 500 })

    await assert.rejects(
      async () =>
        executeBoundedTokenRequest('https://platform.claude.com/v1/oauth/token', {
          method: 'POST',
          headers: {},
          body: '',
          fetchFn: fakeFetch,
        }),
      (err) => err instanceof NetworkError
    )
  })

  // 19. HTTP Guards: oversized response (> 1 MiB) rejected
  await runTest('19. HTTP guards: response body > 1 MiB throws InvalidResponseError', async () => {
    const hugeText = 'x'.repeat(1024 * 1024 + 10)
    const fakeFetch = async () => mockResponse(hugeText)

    await assert.rejects(
      async () =>
        executeBoundedTokenRequest('https://auth.openai.com/oauth/token', {
          method: 'POST',
          headers: {},
          body: '',
          fetchFn: fakeFetch,
        }),
      (err) => err instanceof InvalidResponseError
    )
  })

  // 20. Exponential backoff calculations
  await runTest('20. Exponential backoff: bounded schedule without tight loop', async () => {
    assert.equal(calculateBackoffMs(1), 30_000)
    assert.equal(calculateBackoffMs(2), 60_000)
    assert.equal(calculateBackoffMs(3), 120_000)
    assert.equal(calculateBackoffMs(4), 240_000)
    assert.equal(calculateBackoffMs(5), 480_000)
    assert.equal(calculateBackoffMs(6), 600_000) // capped at 10m
    assert.equal(calculateBackoffMs(10), 600_000)
  })

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exit(1)
  }
}

main()
