import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createAntigravityKeychain,
  decodeAntigravitySecret,
  encodeAntigravitySecret,
  decodeGoKeyringBase64,
  encodeGoKeyringBase64,
  decodeAntigravityKeychainSecret,
  encodeAntigravityKeychainSecret,
  resolveHelperPath,
  GO_KEYRING_BASE64_PREFIX,
  MAX_KEYCHAIN_PAYLOAD_SIZE,
} from '../apps/desktop/electron/antigravity-keychain.ts'
import {
  AccountError,
  sanitizeErrorMessage,
} from '../packages/workflow-model/src/accounts.ts'

console.log('--- Starting Antigravity Keychain Bridge Invariant Tests ---')

// 1. Full go-keyring-base64 codec invariants
{
  const realAntigravityJson = JSON.stringify({
    auth_method: 'consumer',
    token: {
      access_token: 'ya29.synthetic-access-token-12345',
      token_type: 'Bearer',
      refresh_token: '1//synthetic-refresh-token-67890',
      expiry: '2026-12-31T23:59:59.000Z',
    },
  })

  // Encode adds the go-keyring-base64: prefix
  const wrapped = encodeAntigravityKeychainSecret(realAntigravityJson)
  assert.ok(wrapped.startsWith(GO_KEYRING_BASE64_PREFIX), 'Must contain go-keyring-base64: prefix')
  const base64Body = wrapped.slice(GO_KEYRING_BASE64_PREFIX.length)
  assert.equal(base64Body.length % 4, 0, 'Base64 portion must be multiple of 4')
  assert.equal(Buffer.from(base64Body, 'base64').toString('base64'), base64Body, 'Base64 portion must be strictly canonical')

  // Decode wrapped secret
  const decoded = decodeAntigravityKeychainSecret(wrapped)
  assert.equal(decoded, realAntigravityJson, 'Decode must roundtrip exact JSON payload')

  // Legacy plain JSON: accepted after strict UTF-8 roundtrip
  assert.equal(decodeAntigravityKeychainSecret(realAntigravityJson), realAntigravityJson, 'Legacy plain JSON must be accepted')

  // Bare Base64 without go-keyring-base64: prefix MUST be rejected
  assert.throws(
    () => decodeAntigravityKeychainSecret(base64Body),
    (err) => err instanceof AccountError && err.message.includes('缺少 go-keyring-base64: 前缀'),
    'Bare Base64 without prefix must be rejected'
  )

  // Corrupted base64 after prefix
  assert.throws(
    () => decodeAntigravityKeychainSecret(`${GO_KEYRING_BASE64_PREFIX}not-valid-base64!`),
    (err) => err instanceof AccountError
  )

  // Non-canonical padding bits after prefix
  assert.throws(
    () => decodeAntigravityKeychainSecret(`${GO_KEYRING_BASE64_PREFIX}ZE==`),
    (err) => err instanceof AccountError && err.message.includes('非规范 Base64')
  )

  // Invalid UTF-8 bytes after prefix
  const invalidUtf8Base64 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')
  assert.throws(
    () => decodeAntigravityKeychainSecret(`${GO_KEYRING_BASE64_PREFIX}${invalidUtf8Base64}`),
    (err) => err instanceof AccountError && err.message.includes('UTF-8')
  )

  // Raw base64 utilities remain accessible
  assert.equal(decodeAntigravitySecret(base64Body), realAntigravityJson)
  assert.equal(encodeAntigravitySecret(realAntigravityJson), base64Body)
  assert.equal(decodeGoKeyringBase64(base64Body), realAntigravityJson)
  assert.equal(encodeGoKeyringBase64(realAntigravityJson), base64Body)
}

// 2. resolveHelperPath security: NO process.cwd() fallback & symlink rejection
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sec-test-'))
  try {
    const maliciousDir = path.join(tempDir, 'native-bin')
    fs.mkdirSync(maliciousDir, { recursive: true })
    const maliciousBinary = path.join(maliciousDir, 'trace-account-keychain')
    fs.writeFileSync(maliciousBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    // Symlink rejection test
    const symlinkPath = path.join(tempDir, 'symlink-keychain')
    fs.symlinkSync(maliciousBinary, symlinkPath)
    assert.equal(resolveHelperPath(symlinkPath), null, 'Symlink customPath must be rejected')

    // Regular executable customPath works
    assert.equal(resolveHelperPath(maliciousBinary), maliciousBinary, 'Valid executable customPath accepted')

    // Verify resolveHelperPath without customPath does NOT pick up arbitrary cwd files
    const oldCwd = process.cwd()
    try {
      process.chdir(tempDir)
      const resolved = resolveHelperPath()
      assert.notEqual(
        resolved,
        maliciousBinary,
        'resolveHelperPath must never look in process.cwd()'
      )
    } finally {
      process.chdir(oldCwd)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

// 3. executeRequest rejects non-zero exit even when stdout says ok:true
{
  const deceptiveBridge = createAntigravityKeychain({
    runner: () => ({
      status: 1,
      stdout: JSON.stringify({ ok: true, data: 'deceptive-data' }),
    }),
  })
  assert.throws(
    () => deceptiveBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('异常退出'),
    'Non-zero exit code with ok:true must be rejected'
  )
}

// 4. Missing `data` property on read is malformed (null only means missing)
{
  // Missing 'data' key entirely
  const missingDataKeyBridge = createAntigravityKeychain({
    runner: () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true }),
    }),
  })
  assert.throws(
    () => missingDataKeyBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('格式无效'),
    'Read response missing data property must throw malformed error'
  )

  // 'data': null strictly means missing item -> returns null
  const nullDataBridge = createAntigravityKeychain({
    runner: () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, data: null }),
    }),
  })
  assert.equal(nullDataBridge.read(), null, 'Explicit null data must return null')

  // 'data': non-string non-null -> malformed
  const numberDataBridge = createAntigravityKeychain({
    runner: () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, data: 12345 }),
    }),
  })
  assert.throws(
    () => numberDataBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('格式无效')
  )
}

// 5. Bounded raw success data
{
  const oversizeDataBridge = createAntigravityKeychain({
    runner: () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, data: 'x'.repeat(MAX_KEYCHAIN_PAYLOAD_SIZE + 1) }),
    }),
  })
  assert.throws(
    () => oversizeDataBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('超过大小限制'),
    'Success data exceeding MAX_KEYCHAIN_PAYLOAD_SIZE must be rejected'
  )
}

// 6. Synchronous spawn throw handling
{
  const throwingBridge = createAntigravityKeychain({
    runner: () => {
      throw new Error('Synchronous crash in process spawner')
    },
  })
  assert.throws(
    () => throwingBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('操作失败'),
    'Synchronous exception must be caught and rethrown as static AccountError'
  )
}

// 7. Direct object from runner handled cleanly
{
  const directObjBridge = createAntigravityKeychain({
    runner: () => ({ ok: true, data: 'secret-val' }),
  })
  assert.equal(directObjBridge.read(), 'secret-val', 'Direct response object must be normalized and accepted')

  const directErrBridge = createAntigravityKeychain({
    runner: () => ({ ok: false, error: 'denied' }),
  })
  assert.throws(
    () => directErrBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('被拒绝')
  )

  const directInvalidBridge = createAntigravityKeychain({
    runner: () => ({ arbitrary_key: true }),
  })
  assert.throws(
    () => directInvalidBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('格式无效')
  )
}

// 8. Interactive flag support in read and write/delete
{
  let lastRequest = null
  const flagBridge = createAntigravityKeychain({
    runner: (params) => {
      lastRequest = JSON.parse(params.input)
      return { status: 0, stdout: JSON.stringify({ ok: true, data: 'val' }) }
    },
  })

  // Read: default false
  flagBridge.read()
  assert.equal(lastRequest.interactive, false)

  // Read: explicit true
  flagBridge.read(true)
  assert.equal(lastRequest.interactive, true)

  // Read: options object
  flagBridge.read({ interactive: true })
  assert.equal(lastRequest.interactive, true)

  // Write: default false
  flagBridge.write('new-val')
  assert.equal(lastRequest.action, 'write')
  assert.equal(lastRequest.interactive, false)

  // Write: explicit interactive
  flagBridge.write('new-val', true)
  assert.equal(lastRequest.interactive, true)

  // Delete: default false
  flagBridge.write(null)
  assert.equal(lastRequest.action, 'delete')
  assert.equal(lastRequest.interactive, false)

  // Delete: explicit interactive
  flagBridge.write(null, true)
  assert.equal(lastRequest.interactive, true)
}

// 9. Standard domain errors: locked, denied, unavailable, timeout, oversize
{
  const lockedBridge = createAntigravityKeychain({
    runner: () => ({ status: 0, stdout: JSON.stringify({ ok: false, error: 'locked' }) }),
  })
  assert.throws(
    () => lockedBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('已锁定')
  )

  const deniedBridge = createAntigravityKeychain({
    runner: () => ({ status: 0, stdout: JSON.stringify({ ok: false, error: 'denied' }) }),
  })
  assert.throws(
    () => deniedBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('被拒绝')
  )

  const unavailBridge = createAntigravityKeychain({
    runner: () => ({ status: 0, stdout: JSON.stringify({ ok: false, error: 'unavailable' }) }),
  })
  assert.throws(
    () => unavailBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('服务不可用')
  )

  const timeoutBridge = createAntigravityKeychain({
    runner: () => ({ error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }),
  })
  assert.throws(
    () => timeoutBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('超时')
  )

  const bufErrorBridge = createAntigravityKeychain({
    runner: () => ({ error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }) }),
  })
  assert.throws(
    () => bufErrorBridge.read(),
    (err) => err instanceof AccountError && err.message.includes('超过大小限制')
  )
}

// 10. No credentials in argv & no credentials in errors
{
  const calls = []
  const sentinel = 'SECRET_TOKEN_SENTINEL_NEVER_LEAK_99999'

  const recordingBridge = createAntigravityKeychain({
    runner: (params) => {
      calls.push(params)
      return { status: 0, stdout: JSON.stringify({ ok: true }) }
    },
  })

  recordingBridge.write(sentinel)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.length, 0, 'No credential in argv: args array must be empty')
  assert.ok(!JSON.stringify(calls[0].args).includes(sentinel), 'Argv must never contain credential')
  assert.ok(calls[0].input.includes(sentinel), 'Credential must be provided strictly via stdin input')

  const leakingAttemptBridge = createAntigravityKeychain({
    runner: () => ({
      status: 1,
      stdout: JSON.stringify({ ok: false, error: 'denied', leakedSecret: sentinel }),
    }),
  })

  try {
    leakingAttemptBridge.read()
    assert.fail('Expected error')
  } catch (err) {
    assert.ok(err instanceof AccountError)
    assert.ok(!err.message.includes(sentinel), 'AccountError message must not leak credentials')
    assert.ok(!sanitizeErrorMessage(err).includes(sentinel), 'sanitizeErrorMessage must not leak credentials')
  }
}

// 11. Exact raw rollback write preservation: bridge read returns EXACT RAW secret, bridge write sends EXACT RAW secret
{
  let mockStoredItem = `${GO_KEYRING_BASE64_PREFIX}ZXhhY3QtcmF3LWJhc2U2NC1zZWNyZXQtcGF5bG9hZC1mb3ItYmFja3Vw`
  const statefulBridge = createAntigravityKeychain({
    runner: (params) => {
      const req = JSON.parse(params.input)
      if (req.action === 'read') {
        return { status: 0, stdout: JSON.stringify({ ok: true, data: mockStoredItem }) }
      }
      if (req.action === 'write') {
        mockStoredItem = req.secret
        return { status: 0, stdout: JSON.stringify({ ok: true }) }
      }
      if (req.action === 'delete') {
        mockStoredItem = null
        return { status: 0, stdout: JSON.stringify({ ok: true }) }
      }
      return { status: 0, stdout: JSON.stringify({ ok: false, error: 'malformed' }) }
    },
  })

  // 1. Transactional backup reads exact raw secret (with go-keyring-base64: intact)
  const backup = statefulBridge.read()
  assert.equal(backup, mockStoredItem)

  // 2. Switch account writes new raw secret
  const newSecret = `${GO_KEYRING_BASE64_PREFIX}bmV3LXJhdy1zZWNyZXQtcG9zdC1zd2l0Y2g=`
  statefulBridge.write(newSecret)
  assert.equal(mockStoredItem, newSecret)

  // 3. Rollback writes backup exact raw secret
  statefulBridge.write(backup)
  assert.equal(mockStoredItem, backup, 'Rollback must preserve exact raw secret byte-for-byte')

  // 4. Delete item via write(null)
  statefulBridge.write(null)
  assert.equal(mockStoredItem, null)
  assert.equal(statefulBridge.read(), null)
}

console.log('All Antigravity Keychain tests passed successfully!')

for (const status of [null, undefined]) {
  const bridge = createAntigravityKeychain({ runner: () => ({status, stdout: JSON.stringify({ok:true, data:'synthetic'})}) });
  assert.throws(() => bridge.read(), /异常退出/);
}
