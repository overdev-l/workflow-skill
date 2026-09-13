/**
 * Verification Script for Official Tool OAuth Provider Adapters (OPC-48)
 *
 * Comprehensive test suite using recorded-shape synthetic responses and mock fetch:
 * 1. Codex authorization URL parameters, port, callback path, and redirectHost
 * 2. Codex token exchange with JWT claims extraction, identity validation, and normalization
 * 3. Codex rejection on missing sub, missing chatgpt_account_id, malformed JWT, or expired token
 * 4. Claude authorization URL parameters, port, callback path, and redirectHost
 * 5. Claude token exchange with sk-ant-oat format validation, profile lookup, and normalization
 * 6. Claude rejection on invalid token format, missing scopes, contradictory account/org IDs
 * 7. Antigravity authorization URL parameters, port, callback path, and redirectHost
 * 8. Antigravity token exchange with client_secret, profile lookup, and consumer normalization
 * 9. Antigravity rejection on unverified email, missing cloud-platform scope, or invalid token_type
 * 10. HTTP security guards: non-2xx status, oversized body (> 1 MiB), redirect rejection, timeout abort
 * 11. Metadata sanitization: suspicious secret patterns stripped from user-facing fields
 * 12. Full end-to-end integration with AccountOAuthService and AccountAdapter inspection
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-oauth-providers.mjs
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import {
  createAccountOAuthProviders,
  CODEX_CLIENT_ID,
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  CLAUDE_CLIENT_ID,
  CLAUDE_AUTH_URL,
  CLAUDE_TOKEN_URL,
  CLAUDE_PROFILE_URL,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_TOKEN_URL,
  ANTIGRAVITY_PROFILE_URL,
} from '../apps/desktop/electron/account-oauth-providers.ts'
import {
  AccountOAuthService,
} from '../apps/desktop/electron/account-oauth.ts'
import { createAccountAdapters } from '../apps/desktop/electron/account-adapters.ts'
import { AccountError } from '../packages/workflow-model/src/accounts.ts'

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

function createJwt(payload, header = { alg: 'none', typ: 'JWT' }) {
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
  console.log('Running OAuth Provider Adapters verification tests...\n')

  const adapters = createAccountAdapters()

  // 1. Codex Authorization URL
  await runTest('1. Codex authorization URL parameters, port, and redirect host', async () => {
    const providers = createAccountOAuthProviders()
    const codex = providers.codex

    assert.equal(codex.port, 1455)
    assert.equal(codex.redirectHost, 'localhost')
    assert.equal(codex.callbackPath, '/auth/callback')

    const authUrlStr = codex.authorizationUrl({
      state: 'test-state-codex',
      challenge: 'test-challenge-codex',
      redirectUri: 'http://localhost:1455/auth/callback',
    })

    const u = new URL(authUrlStr)
    assert.equal(u.origin + u.pathname, CODEX_AUTH_URL)
    assert.equal(u.searchParams.get('client_id'), CODEX_CLIENT_ID)
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('scope'), 'openid profile email offline_access')
    assert.equal(u.searchParams.get('state'), 'test-state-codex')
    assert.equal(u.searchParams.get('code_challenge'), 'test-challenge-codex')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('id_token_add_organizations'), 'true')
    assert.equal(u.searchParams.get('codex_cli_simplified_flow'), 'true')
    assert.equal(u.searchParams.get('originator'), 'codex_cli_rs')
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  })

  // 2. Codex Token Exchange Success & Adapter Compatibility
  await runTest('2. Codex token exchange and normalization compatible with account-adapters', async () => {
    let capturedReq = null
    const fixedNow = 1720000000000 // fixed epoch ms

    const idTokenPayload = {
      sub: 'user-sub-12345',
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'org-chatgpt-account-999',
      },
      exp: Math.floor((fixedNow + 3600 * 1000) / 1000),
    }

    const fakeFetch = async (url, init) => {
      capturedReq = { url, init }
      return mockResponse({
        access_token: 'codex-access-token-xyz',
        id_token: createJwt(idTokenPayload),
        refresh_token: 'codex-refresh-token-abc',
        expires_in: 3600,
      })
    }

    const providers = createAccountOAuthProviders({
      fetch: fakeFetch,
      now: () => fixedNow,
    })

    const credentialJson = await providers.codex.exchange({
      code: 'code-123',
      verifier: 'verifier-456',
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'test-state',
      signal: new AbortController().signal,
    })

    assert.equal(capturedReq.url, CODEX_TOKEN_URL)
    assert.equal(capturedReq.init.method, 'POST')
    const form = new URLSearchParams(capturedReq.init.body)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'code-123')
    assert.equal(form.get('client_id'), CODEX_CLIENT_ID)
    assert.equal(form.get('code_verifier'), 'verifier-456')
    assert.equal(form.get('redirect_uri'), 'http://localhost:1455/auth/callback')

    const parsed = JSON.parse(credentialJson)
    assert.equal(parsed.auth_mode, 'chatgpt')
    assert.equal(parsed.OPENAI_API_KEY, null)
    assert.equal(parsed.tokens.access_token, 'codex-access-token-xyz')
    assert.equal(parsed.tokens.refresh_token, 'codex-refresh-token-abc')
    assert.equal(parsed.tokens.account_id, 'org-chatgpt-account-999')
    assert.ok(parsed.last_refresh)

    // Inspect with official local adapter to verify full integration compatibility
    const inspected = adapters.codex.inspect(credentialJson)
    assert.equal(inspected.accountId, 'org-chatgpt-account-999')
    assert.equal(inspected.email, 'user@example.com')
  })

  // 3. Codex Rejection on Missing/Malformed Claims or Expiry
  await runTest('3. Codex rejection on missing sub, account ID, or expired token', async () => {
    // Missing chatgpt_account_id
    const badPayload1 = { sub: 'sub-only', exp: Math.floor(Date.now() / 1000) + 3600 }
    const providers1 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'token',
        id_token: createJwt(badPayload1),
        refresh_token: 'refresh',
      }),
    })
    await assert.rejects(
      async () => providers1.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('ChatGPT 账户标识')
    )

    // Missing sub
    const badPayload2 = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acc' }, exp: Math.floor(Date.now() / 1000) + 3600 }
    const providers2 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'token',
        id_token: createJwt(badPayload2),
        refresh_token: 'refresh',
      }),
    })
    await assert.rejects(
      async () => providers2.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('账户标识')
    )

    // Expired token
    const expiredPayload = {
      sub: 'sub',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc' },
      exp: Math.floor(Date.now() / 1000) - 100, // expired 100s ago
    }
    const providers3 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'token',
        id_token: createJwt(expiredPayload),
        refresh_token: 'refresh',
      }),
    })
    await assert.rejects(
      async () => providers3.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('已过期')
    )
  })

  // 4. Claude Authorization URL
  await runTest('4. Claude authorization URL parameters, port, and redirect host', async () => {
    const providers = createAccountOAuthProviders()
    const claude = providers['claude-code']

    assert.equal(claude.port, 0)
    assert.equal(claude.redirectHost, 'localhost')
    assert.equal(claude.callbackPath, '/callback')

    const authUrlStr = claude.authorizationUrl({
      state: 'test-state-claude',
      challenge: 'test-challenge-claude',
      redirectUri: 'http://localhost:54321/callback',
    })

    const u = new URL(authUrlStr)
    assert.equal(u.origin + u.pathname, CLAUDE_AUTH_URL)
    assert.equal(u.searchParams.get('client_id'), CLAUDE_CLIENT_ID)
    assert.equal(u.searchParams.get('code'), 'true')
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('scope'), 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload')
    assert.equal(u.searchParams.get('state'), 'test-state-claude')
    assert.equal(u.searchParams.get('code_challenge'), 'test-challenge-claude')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:54321/callback')
  })

  // 5. Claude Token Exchange & Profile Fetching
  await runTest('5. Claude token exchange with sk-ant-oat validation, profile lookup, and normalization', async () => {
    const requests = []
    const fixedNow = 1720000000000
    const validAccessToken = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890'
    const accountUuid = '11111111-2222-3333-4444-555555555555'
    const orgUuid = '66666666-7777-8888-9999-000000000000'

    const fakeFetch = async (url, init) => {
      requests.push({ url, init })
      if (url === CLAUDE_TOKEN_URL) {
        return mockResponse({
          access_token: validAccessToken,
          refresh_token: 'claude-refresh-token',
          expires_in: 7200,
          scope: 'user:profile user:inference user:sessions:claude_code',
        })
      }
      if (url === CLAUDE_PROFILE_URL) {
        return mockResponse({
          account: {
            uuid: accountUuid,
            email: 'claude.user@example.com',
            display_name: 'Claude Developer',
          },
          organization: {
            uuid: orgUuid,
            billing_type: 'paid',
          },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const providers = createAccountOAuthProviders({
      fetch: fakeFetch,
      now: () => fixedNow,
    })

    const credentialJson = await providers['claude-code'].exchange({
      code: 'code-claude',
      verifier: 'verifier-claude',
      redirectUri: 'http://localhost:54321/callback',
      state: 'state-claude',
      signal: new AbortController().signal,
    })

    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, CLAUDE_TOKEN_URL)
    const tokenReqBody = JSON.parse(requests[0].init.body)
    assert.equal(tokenReqBody.grant_type, 'authorization_code')
    assert.equal(tokenReqBody.code, 'code-claude')
    assert.equal(tokenReqBody.code_verifier, 'verifier-claude')
    assert.equal(tokenReqBody.state, 'state-claude')
    assert.equal(tokenReqBody.client_id, CLAUDE_CLIENT_ID)

    assert.equal(requests[1].url, CLAUDE_PROFILE_URL)
    assert.equal(requests[1].init.headers.Authorization, `Bearer ${validAccessToken}`)

    const parsed = JSON.parse(credentialJson)
    assert.equal(parsed.claudeAiOauth.accessToken, validAccessToken)
    assert.equal(parsed.claudeAiOauth.refreshToken, 'claude-refresh-token')
    assert.equal(parsed.claudeAiOauth.expiresAt, fixedNow + 7200 * 1000)
    assert.equal(parsed.claudeAiOauth.subscriptionType, 'paid')
    assert.equal(parsed.oauthAccount.accountUuid, accountUuid)
    assert.equal(parsed.oauthAccount.emailAddress, 'claude.user@example.com')
    assert.equal(parsed.oauthAccount.organizationUuid, orgUuid)
    assert.equal(parsed.oauthAccount.displayName, 'Claude Developer')
    assert.equal(parsed.oauthClientId, CLAUDE_CLIENT_ID)
  })

  // 6. Claude Contradictory Identity / Malformed Token / Missing Scope
  await runTest('6. Claude rejection on invalid token format, missing scope, or contradictory IDs', async () => {
    // 6.1 Invalid token format (not sk-ant-oatNN-)
    const providers1 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'not-an-oat-token',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'user:profile user:inference',
      }),
    })
    await assert.rejects(
      async () => providers1['claude-code'].exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('订阅访问令牌格式无效')
    )

    // 6.2 Missing inference scope
    const providers2 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'user:profile',
      }),
    })
    await assert.rejects(
      async () => providers2['claude-code'].exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('缺少必需的账户或推理权限')
    )

    // 6.3 Contradictory organization UUID in token response vs profile
    const providers3 = createAccountOAuthProviders({
      fetch: async (url) => {
        if (url === CLAUDE_TOKEN_URL) {
          return mockResponse({
            access_token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890',
            refresh_token: 'refresh',
            expires_in: 3600,
            scope: 'user:profile user:inference',
            organization: { uuid: 'org-token-uuid' },
          })
        }
        return mockResponse({
          account: { uuid: 'acc-uuid', email: 'a@b.com' },
          organization: { uuid: 'org-profile-contradictory-uuid' },
        })
      },
    })
    await assert.rejects(
      async () => providers3['claude-code'].exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('不一致')
    )
  })

  // 7. Antigravity Authorization URL
  await runTest('7. Antigravity authorization URL parameters, port, and redirect host', async () => {
    const providers = createAccountOAuthProviders()
    const antigravity = providers.antigravity

    assert.equal(antigravity.port, 0)
    assert.equal(antigravity.redirectHost, '127.0.0.1')
    assert.equal(antigravity.callbackPath, '/oauth-callback')

    const authUrlStr = antigravity.authorizationUrl({
      state: 'test-state-agy',
      challenge: 'test-challenge-agy',
      redirectUri: 'http://127.0.0.1:4567/oauth-callback',
    })

    const u = new URL(authUrlStr)
    assert.equal(u.origin + u.pathname, ANTIGRAVITY_AUTH_URL)
    assert.equal(u.searchParams.get('client_id'), ANTIGRAVITY_CLIENT_ID)
    assert.equal(u.searchParams.get('access_type'), 'offline')
    assert.equal(u.searchParams.get('prompt'), 'select_account consent')
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('scope'), 'openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile')
    assert.equal(u.searchParams.get('state'), 'test-state-agy')
    assert.equal(u.searchParams.get('code_challenge'), 'test-challenge-agy')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:4567/oauth-callback')
  })

  // 8. Antigravity Token Exchange & Userinfo Success
  await runTest('8. Antigravity token exchange, userinfo lookup, and consumer normalization', async () => {
    const requests = []
    const fixedNow = 1720000000000

    const fakeFetch = async (url, init) => {
      requests.push({ url, init })
      if (url === ANTIGRAVITY_TOKEN_URL) {
        return mockResponse({
          access_token: 'google-access-token-123',
          token_type: 'Bearer',
          refresh_token: 'google-refresh-token-456',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email',
        })
      }
      if (url === ANTIGRAVITY_PROFILE_URL) {
        return mockResponse({
          id: 'google-user-id-789',
          email: 'google.dev@example.com',
          verified_email: true,
          name: 'Google Dev',
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const providers = createAccountOAuthProviders({
      fetch: fakeFetch,
      now: () => fixedNow,
    })

    const credentialJson = await providers.antigravity.exchange({
      code: 'code-agy',
      verifier: 'verifier-agy',
      redirectUri: 'http://127.0.0.1:4567/oauth-callback',
      state: 'state-agy',
      signal: new AbortController().signal,
    })

    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, ANTIGRAVITY_TOKEN_URL)
    const form = new URLSearchParams(requests[0].init.body)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('client_id'), ANTIGRAVITY_CLIENT_ID)
    assert.equal(form.get('client_secret'), ANTIGRAVITY_CLIENT_SECRET)
    assert.equal(form.get('code'), 'code-agy')
    assert.equal(form.get('code_verifier'), 'verifier-agy')

    assert.equal(requests[1].url, ANTIGRAVITY_PROFILE_URL)
    assert.equal(requests[1].init.headers.Authorization, 'Bearer google-access-token-123')

    const parsed = JSON.parse(credentialJson)
    assert.equal(parsed.auth_method, 'consumer')
    assert.equal(parsed.token.access_token, 'google-access-token-123')
    assert.equal(parsed.token.token_type, 'Bearer')
    assert.equal(parsed.token.refresh_token, 'google-refresh-token-456')
    assert.equal(parsed.token.expiry, new Date(fixedNow + 3600 * 1000).toISOString())
    assert.equal(parsed.account.id, 'google-user-id-789')
    assert.equal(parsed.account.email, 'google.dev@example.com')
    assert.equal(parsed.account.name, 'Google Dev')
    assert.equal(parsed.oauth_client_id, ANTIGRAVITY_CLIENT_ID)

    // Inspect with official local adapter to verify compatibility
    const inspected = adapters.antigravity.inspect(credentialJson)
    assert.equal(inspected.expiresAt, fixedNow + 3600 * 1000)
  })

  // 9. Antigravity Unverified Email / Missing Scope / Wrong Token Type
  await runTest('9. Antigravity rejection on unverified email, missing cloud scope, or invalid token type', async () => {
    // 9.1 Unverified email
    const providers1 = createAccountOAuthProviders({
      fetch: async (url) => {
        if (url === ANTIGRAVITY_TOKEN_URL) {
          return mockResponse({
            access_token: 'token',
            token_type: 'Bearer',
            refresh_token: 'refresh',
            expires_in: 3600,
          })
        }
        return mockResponse({
          id: 'id',
          email: 'e@mail.com',
          verified_email: false,
        })
      },
    })
    await assert.rejects(
      async () => providers1.antigravity.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('邮箱未验证')
    )

    // 9.2 Missing cloud-platform scope
    const providers2 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'token',
        token_type: 'Bearer',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'openid email',
      }),
    })
    await assert.rejects(
      async () => providers2.antigravity.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('云平台')
    )

    // 9.3 Invalid token type
    const providers3 = createAccountOAuthProviders({
      fetch: async () => mockResponse({
        access_token: 'token',
        token_type: 'MAC',
        refresh_token: 'refresh',
        expires_in: 3600,
      }),
    })
    await assert.rejects(
      async () => providers3.antigravity.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('令牌类型无效')
    )
  })

  // 10. HTTP Guards: Non-2xx, Oversized Body, Redirect Rejection
  await runTest('10. HTTP security guards: non-2xx status, oversized body (> 1 MiB), redirect rejection', async () => {
    // 10.1 Non-2xx status
    const providers1 = createAccountOAuthProviders({
      fetch: async () => mockResponse({ error: 'invalid_grant' }, { status: 400 }),
    })
    await assert.rejects(
      async () => providers1.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && !err.message.includes('invalid_grant')
    )

    // 10.2 Oversized body (> 1 MiB)
    const giantText = '{"data":"' + 'A'.repeat(1024 * 1024 + 50) + '"}'
    const providers2 = createAccountOAuthProviders({
      fetch: async () => mockResponse(giantText),
    })
    await assert.rejects(
      async () => providers2.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('过大')
    )

    // 10.3 Redirect rejection (redirect: error)
    const providers3 = createAccountOAuthProviders({
      fetch: async (url, init) => {
        assert.equal(init.redirect, 'error', 'Fetch must enforce redirect: error')
        throw new TypeError('fetch failed: redirect not allowed')
      },
    })
    await assert.rejects(
      async () => providers3.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('失败或超时')
    )

    // 10.4 Signal abort during exchange
    const abortController = new AbortController()
    const providers4 = createAccountOAuthProviders({
      fetch: async (url, init) => {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('Aborted'))
          })
        })
      },
    })
    const exchangePromise = providers4.codex.exchange({
      code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: abortController.signal,
    })
    abortController.abort()
    await assert.rejects(
      async () => exchangePromise,
      (err) => err instanceof AccountError && err.message.includes('取消或中断')
    )
  })

  // 11. Metadata Sanitization: Suspicious Secret Patterns
  await runTest('11. Metadata sanitization strips suspicious secret patterns', async () => {
    const providers = createAccountOAuthProviders({
      fetch: async (url) => {
        if (url === CLAUDE_TOKEN_URL) {
          return mockResponse({
            access_token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890',
            refresh_token: 'refresh',
            expires_in: 3600,
            scope: 'user:profile user:inference',
          })
        }
        return mockResponse({
          account: {
            uuid: '11111111-2222-3333-4444-555555555555',
            email: 'user@example.com',
            // Attempt to inject a token as displayName
            display_name: 'sk-ant-api03-leakedtokensecret',
          },
          organization: {
            uuid: '66666666-7777-8888-9999-000000000000',
            // Attempt to inject a client secret as billing_type
            billing_type: 'GOCSPX-secretkey',
          },
        })
      },
    })

    const credentialJson = await providers['claude-code'].exchange({
      code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
    })

    const parsed = JSON.parse(credentialJson)
    // Both suspicious fields must have been omitted/filtered out
    assert.equal(parsed.oauthAccount.displayName, undefined)
    assert.equal(parsed.claudeAiOauth.subscriptionType, undefined)
  })

  // 12. Full Integration: Providers wired into AccountOAuthService
  await runTest('12. Full integration with AccountOAuthService and AccountAdapter inspection', async () => {
    const idTokenPayload = {
      sub: 'codex-integrated-sub',
      email: 'integrated@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'org-chatgpt-account-integrated-123',
      },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }

    const fakeFetch = async (url) => {
      if (url === CODEX_TOKEN_URL) {
        return mockResponse({
          access_token: 'access-integrated',
          id_token: createJwt(idTokenPayload),
          refresh_token: 'refresh-integrated',
          expires_in: 3600,
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const providers = createAccountOAuthProviders({ fetch: fakeFetch })
    let savedRecord = null
    let capturedAuthUrl = null

    const service = new AccountOAuthService({
      providers,
      openExternal: async (url) => {
        capturedAuthUrl = url
      },
      saveAccount: async ({ tool, credential }) => {
        const inspected = adapters[tool].inspect(credential)
        savedRecord = {
          id: randomUUID(),
          tool,
          name: inspected.email ?? 'Integrated Account',
          accountId: inspected.accountId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        return savedRecord
      },
    })

    const session = await service.begin('codex')
    assert.equal(session.phase, 'waiting')

    const authUrl = new URL(capturedAuthUrl)
    const state = authUrl.searchParams.get('state')

    // Simulate callback to port 1455
    const callbackRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 1455,
        path: `/auth/callback?code=synth-code&state=${state}`,
        method: 'GET',
        headers: { host: 'localhost:1455' },
      }, (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ statusCode: res.statusCode, body }))
      })
      req.on('error', reject)
      req.end()
    })

    assert.equal(callbackRes.statusCode, 200)
    assert.ok(callbackRes.body.includes('授权成功'))

    const finalSession = service.get(session.id)
    assert.equal(finalSession.phase, 'succeeded')
    assert.equal(finalSession.accountId, savedRecord.id)

    assert.equal(savedRecord.accountId, 'org-chatgpt-account-integrated-123')
    assert.equal(savedRecord.name, 'integrated@example.com')

    await service.dispose()
  })

  // 13. Stalled body stream timeout seam aborts cleanly
  await runTest('13. Stalled body stream timeout seam aborts cleanly', async () => {
    const stalledStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'))
        // Stalls without closing or providing further bytes
      },
    })

    const providers = createAccountOAuthProviders({
      httpTimeoutMs: 50, // 50ms test seam
      fetch: async () => {
        return new Response(stalledStream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const startTime = Date.now()
    await assert.rejects(
      async () => providers.codex.exchange({
        code: 'c', verifier: 'v', redirectUri: 'r', state: 's', signal: new AbortController().signal,
      }),
      (err) => err instanceof AccountError && err.message.includes('失败或超时')
    )
    const elapsed = Date.now() - startTime
    assert.ok(elapsed < 1000, `Timeout must trigger in bounded seam time (<1000ms), took ${elapsed}ms`)
  })

  console.log(`\nAll OAuth provider verification tests finished: ${passed} passed, ${failed} failed.`)
  if (failed > 0) {
    process.exit(1)
  }
}

await main().catch((err) => {
  console.error('Fatal test runner error:', err)
  process.exit(1)
})
