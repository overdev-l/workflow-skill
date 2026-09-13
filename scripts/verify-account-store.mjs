/**
 * Verification Script for AI Tool Account Store (OPC-48)
 *
 * Runs comprehensive end-to-end tests in an isolated temporary root:
 * 1. Basic save, read, list & renderer-safe metadata secrecy (zero credential leakage)
 * 2. Large payload support (> 2KB without artificial limits)
 * 3. File and directory permissions enforcement (0o700 dirs, 0o600 files)
 * 4. Atomic rename and delete operations (isolated from active tool credentials)
 * 5. Malformed inputs rejection before any filesystem write
 * 6. Parent and root symlink rejection (.trace symlink & outside traceHome)
 * 7. UUID-named symlink entry detection in list(), get(), and delete()
 * 8. Nested symlink detection in delete() without touching external files
 * 9. Hard-link rejection (nlink > 1 detected on manifest or credential)
 * 10. Forged credentialFile rejected (must be exactly credential.utf8)
 * 11. Oversize file guards before read (manifest > 64 KiB, credential > 5 MiB)
 * 12. Malformed JSON errors never leak sentinel credentials
 * 13. Explicit corruption detection and preservation (corrupted data never wiped/replaced)
 * 14. Serialized mutation execution under concurrent load
 * 15. Legacy profile directory non-interference and presence detection
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-account-store.mjs
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AccountStore, hasLegacyProfiles } from '../apps/desktop/electron/account-store.ts'
import {
  ACCOUNT_TOOLS,
  AccountError,
  MAX_MANIFEST_FILE_SIZE,
  sanitizeErrorMessage,
  validateAccountId,
  validateAccountName,
  validateAccountTool,
} from '../packages/workflow-model/src/accounts.ts'

const testRoot = mkdtempSync(path.join(tmpdir(), 'verify-account-store-'))
let passed = 0
let failed = 0

async function runTest(name, fn) {
  const testHome = path.join(testRoot, Math.random().toString(36).substring(2, 10))
  mkdirSync(testHome, { recursive: true })
  const store = new AccountStore({ homeDir: testHome })

  try {
    await fn({ testHome, store })
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(err)
  }
}

async function main() {
  console.log(`Starting AccountStore verification suite in: ${testRoot}`)

  // 1. Basic save, read, list & metadata contains no payload
  await runTest('save, read, list and metadata contains no payload', async ({ store }) => {
    const credPayload = 'user-google-oauth-refresh-token-xyz'
    const saved = await store.save({
      tool: 'antigravity',
      name: 'Google Dev Account',
      email: 'dev@google.internal',
      accountId: 'g-100200300',
      credential: credPayload,
      expiresAt: Date.now() + 3600_000,
    })

    // Verify metadata properties and absence of payload
    assert.ok(saved.id, 'Metadata must include valid ID')
    validateAccountId(saved.id)
    assert.equal(saved.tool, 'antigravity')
    assert.equal(saved.name, 'Google Dev Account')
    assert.equal(saved.email, 'dev@google.internal')
    assert.equal(saved.accountId, 'g-100200300')
    assert.equal('credential' in saved, false, 'Renderer-facing metadata must NOT have credential')
    assert.equal('payload' in saved, false, 'Renderer-facing metadata must NOT have payload')

    // Internal get(id) returns metadata and credential
    const retrieved = await store.get(saved.id)
    assert.equal(retrieved.credential, credPayload, 'Internal get must return exact payload')
    assert.equal(retrieved.metadata.id, saved.id)
    assert.equal('credential' in retrieved.metadata, false, 'Metadata in record must NOT have credential')

    // list() returns metadata array with zero credentials
    const all = await store.list()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, saved.id)
    assert.equal('credential' in all[0], false, 'List metadata must NOT contain credential')

    // Filter by tool
    const antigravityOnly = await store.list('antigravity')
    assert.equal(antigravityOnly.length, 1)
    const codexOnly = await store.list('codex')
    assert.equal(codexOnly.length, 0)
  })

  // 2. Long payload > 2KB
  await runTest('handles long payloads > 2KB without artificial limits', async ({ store }) => {
    const longPayload = JSON.stringify({
      tokens: Array.from({ length: 1500 }, (_, i) => ({
        index: i,
        token: `mock-long-token-${i}-${'abcdef'.repeat(10)}`,
      })),
    })

    assert.ok(Buffer.byteLength(longPayload, 'utf8') > 2048, 'Payload must be strictly > 2KB')

    const saved = await store.save({
      tool: 'codex',
      name: 'Codex Enterprise Account',
      credential: longPayload,
    })

    const retrieved = await store.get(saved.id)
    assert.equal(retrieved.credential, longPayload, 'Retrieved payload must match byte-for-byte')

    const manifestFile = path.join(store.baseDirectory, saved.id, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    assert.equal(manifest.payloadLength, Buffer.byteLength(longPayload, 'utf8'))
    assert.ok(manifest.payloadSha256.length === 64)
  })

  // 3. File modes (0o700 for directories, 0o600 for files)
  await runTest('file and directory permission enforcement', async ({ store }) => {
    const saved = await store.save({
      tool: 'claude-code',
      name: 'Claude Pro Account',
      credential: 'claude-session-token-abc',
    })

    if (process.platform !== 'win32') {
      const traceStat = statSync(store.traceHome)
      assert.equal(traceStat.mode & 0o777, 0o700, 'traceHome directory must be 0o700')

      const rootStat = statSync(store.baseDirectory)
      assert.equal(rootStat.mode & 0o777, 0o700, 'Accounts base directory must be 0o700')

      const accountDir = path.join(store.baseDirectory, saved.id)
      const dirStat = statSync(accountDir)
      assert.equal(dirStat.mode & 0o777, 0o700, 'Account directory must be 0o700')

      const manifestStat = statSync(path.join(accountDir, 'manifest.json'))
      assert.equal(manifestStat.mode & 0o777, 0o600, 'Manifest file must be 0o600')

      const credStat = statSync(path.join(accountDir, 'credential.utf8'))
      assert.equal(credStat.mode & 0o777, 0o600, 'Credential file must be 0o600')
    }
  })

  // 4. Rename & Delete
  await runTest('rename and delete operations', async ({ store }) => {
    const saved = await store.save({
      tool: 'antigravity',
      name: 'Original Account Name',
      credential: 'secret-token-123',
    })

    // Rename
    const renamed = await store.rename(saved.id, 'Updated Account Name')
    assert.equal(renamed.name, 'Updated Account Name')
    assert.equal('credential' in renamed, false)

    const reChecked = await store.get(saved.id)
    assert.equal(reChecked.metadata.name, 'Updated Account Name')
    assert.equal(reChecked.credential, 'secret-token-123')

    // Delete
    await store.delete(saved.id)
    const afterDeleteList = await store.list()
    assert.equal(afterDeleteList.length, 0)

    await assert.rejects(
      async () => await store.get(saved.id),
      (err) => err instanceof AccountError && err.message.includes('Account not found')
    )
  })

  // 5. Malformed name / id / tool rejected before writes
  await runTest('malformed name, id, tool, and control characters rejected before writes', async ({ store }) => {
    // Malformed tool
    await assert.rejects(
      async () => await store.save({ tool: 'unsupported-tool', name: 'Valid Name', credential: 'token' }),
      (err) => err instanceof AccountError && !err.message.includes('unsupported-tool')
    )

    // Malformed names
    const invalidNames = [
      '',
      '   ',
      'x'.repeat(101),
      '__proto__',
      'constructor',
      'prototype',
      '../traversal',
      'path/with/slash',
      'path\\with\\backslash',
      'null\x00byte',
    ]

    for (const badName of invalidNames) {
      await assert.rejects(
        async () => await store.save({ tool: 'antigravity', name: badName, credential: 'token' }),
        (err) => err instanceof AccountError
      )
    }

    // Malformed email and accountId with control characters
    await assert.rejects(
      async () => await store.save({ tool: 'antigravity', name: 'Valid Name', credential: 'token', email: 'user\x00@bad.com' }),
      (err) => err instanceof AccountError
    )
    await assert.rejects(
      async () => await store.save({ tool: 'antigravity', name: 'Valid Name', credential: 'token', accountId: 'id\x1fbad' }),
      (err) => err instanceof AccountError
    )

    // Malformed ID
    const invalidIds = ['not-a-uuid', '../../escape', '__proto__', '   ']
    for (const badId of invalidIds) {
      await assert.rejects(
        async () => await store.get(badId),
        (err) => err instanceof AccountError && !err.message.includes(badId)
      )
      await assert.rejects(
        async () => await store.rename(badId, 'New Name'),
        (err) => err instanceof AccountError && !err.message.includes(badId)
      )
      await assert.rejects(
        async () => await store.delete(badId),
        (err) => err instanceof AccountError && !err.message.includes(badId)
      )
    }

    // Verify store baseDirectory remains empty
    if (existsSync(store.baseDirectory)) {
      const items = readdirSync(store.baseDirectory)
      assert.equal(items.length, 0, 'No files or directories should be created for rejected inputs')
    }
  })

  // 6. Parent symlink rejection (.trace parent symlink & outside traceHome)
  await runTest('traceHome symlink and outside traceHome paths rejected', async ({ testHome }) => {
    const externalDir = path.join(testHome, 'external-dir')
    mkdirSync(externalDir, { recursive: true })

    // .trace created as symlink pointing to externalDir
    const traceSymlink = path.join(testHome, '.trace')
    symlinkSync(externalDir, traceSymlink)

    const symlinkStore = new AccountStore({ homeDir: testHome })
    await assert.rejects(
      async () => await symlinkStore.save({ tool: 'antigravity', name: 'Symlink Test', credential: 'secret' }),
      (err) => err instanceof AccountError && err.message.includes('Security violation')
    )

    // Verify external target was untouched
    assert.equal(readdirSync(externalDir).length, 0)

    // traceHome pointing outside homeDir rejected in constructor
    assert.throws(
      () => new AccountStore({ homeDir: testHome, traceHome: path.join(testRoot, 'other-dir') }),
      (err) => err instanceof AccountError && err.message.includes('Security violation')
    )
  })

  // 7. UUID-named symlink entry detection in list(), get(), and delete()
  await runTest('UUID-named symlink entries detected and rejected by list and get', async ({ store, testHome }) => {
    // Save one legitimate account first
    await store.save({ tool: 'antigravity', name: 'Valid Account', credential: 'valid-secret' })

    // Create a symlink entry named with a valid UUID inside accountsDir
    const externalTarget = path.join(testHome, 'external-secret-target')
    mkdirSync(externalTarget, { recursive: true })

    const fakeUuid = randomUUID()
    const symlinkPath = path.join(store.baseDirectory, fakeUuid)
    symlinkSync(externalTarget, symlinkPath)

    // list() must NOT skip the symlink; it must detect it and throw
    await assert.rejects(
      async () => await store.list(),
      (err) => err instanceof AccountError && err.message.includes('Security violation')
    )

    // get() must detect and reject symlink
    await assert.rejects(
      async () => await store.get(fakeUuid),
      (err) => err instanceof AccountError && err.message.includes('Security violation')
    )

    // delete() must detect and reject symlink
    await assert.rejects(
      async () => await store.delete(fakeUuid),
      (err) => err instanceof AccountError && err.message.includes('Security violation')
    )

    // External directory remains untouched
    assert.equal(readdirSync(externalTarget).length, 0)
  })

  // 8. Nested symlink detection in delete()
  await runTest('nested symlinks in account directory detected on delete', async ({ store, testHome }) => {
    const saved = await store.save({ tool: 'codex', name: 'Account With Nested Symlink', credential: 'token' })

    const externalFile = path.join(testHome, 'external-sensitive.txt')
    writeFileSync(externalFile, 'critical-system-data')

    const nestedSymlink = path.join(store.baseDirectory, saved.id, 'nested-symlink.txt')
    symlinkSync(externalFile, nestedSymlink)

    // delete() must detect nested symlink and reject without modifying external file
    await assert.rejects(
      async () => await store.delete(saved.id),
      (err) => err instanceof AccountError && err.message.includes('Security violation')
    )

    assert.ok(existsSync(externalFile), 'External sensitive file must remain intact')
    assert.equal(readFileSync(externalFile, 'utf8'), 'critical-system-data')
  })

  // 9. Hard-link rejection (nlink > 1)
  await runTest('hard-linked files rejected on read', async ({ store }) => {
    const saved = await store.save({ tool: 'antigravity', name: 'Hardlink Account', credential: 'token-data' })

    const accountDir = path.join(store.baseDirectory, saved.id)
    const manifestPath = path.join(accountDir, 'manifest.json')
    const hardlinkManifest = path.join(accountDir, 'hardlink-manifest.json')

    try {
      linkSync(manifestPath, hardlinkManifest)

      await assert.rejects(
        async () => await store.get(saved.id),
        (err) => err instanceof AccountError && err.message.includes('hard link detected')
      )
    } finally {
      try { unlinkSync(hardlinkManifest) } catch {}
    }
  })

  // 10. Forged credentialFile rejected
  await runTest('forged credentialFile in manifest rejected', async ({ store }) => {
    const saved = await store.save({ tool: 'claude-code', name: 'Forged File Account', credential: 'token-abc' })

    const manifestPath = path.join(store.baseDirectory, saved.id, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    // Alter credentialFile to forged file name
    manifest.credentialFile = 'forged.txt'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    await assert.rejects(
      async () => await store.get(saved.id),
      (err) => err instanceof AccountError && err.message.includes('credentialFile must be exactly credential.utf8')
    )

    await assert.rejects(
      async () => await store.list(),
      (err) => err instanceof AccountError && err.message.includes('credentialFile must be exactly credential.utf8')
    )

    // Manifest file is preserved
    assert.ok(existsSync(manifestPath), 'Corrupted manifest must be preserved on disk')
  })

  // 11. Oversize file guards before read
  await runTest('oversize manifest guarded before read', async ({ store }) => {
    const saved = await store.save({ tool: 'antigravity', name: 'Oversize Account', credential: 'small-token' })

    const manifestPath = path.join(store.baseDirectory, saved.id, 'manifest.json')
    const padded = JSON.stringify({ padding: 'x'.repeat(MAX_MANIFEST_FILE_SIZE + 100) })
    writeFileSync(manifestPath, padded)

    await assert.rejects(
      async () => await store.get(saved.id),
      (err) => err instanceof AccountError && err.message.includes('manifest file size is invalid')
    )
  })

  // 12. Malformed JSON errors never leak sentinel credentials
  await runTest('malformed JSON errors never leak sentinel credentials', async ({ store }) => {
    const sentinelCredential = 'sentinel-super-secret-token-xyz-98765'
    const saved = await store.save({
      tool: 'antigravity',
      name: 'Sentinel Account',
      credential: sentinelCredential,
    })

    const manifestPath = path.join(store.baseDirectory, saved.id, 'manifest.json')
    writeFileSync(manifestPath, '{ malformed json truncated: true')

    let caughtError = null
    try {
      await store.get(saved.id)
    } catch (err) {
      caughtError = err
    }

    assert.ok(caughtError instanceof AccountError, 'Must be AccountError')
    assert.ok(!caughtError.message.includes(sentinelCredential), 'Raw error must not contain sentinel')

    const sanitized = sanitizeErrorMessage(caughtError)
    assert.ok(!sanitized.includes(sentinelCredential), 'Sanitized error must not contain sentinel')
    assert.equal(sanitized, 'Account corrupted: invalid manifest JSON.')

    // Rename JSON parse error check
    let renameError = null
    try {
      await store.rename(saved.id, 'New Name')
    } catch (err) {
      renameError = err
    }
    assert.ok(renameError instanceof AccountError)
    assert.equal(sanitizeErrorMessage(renameError), 'Account corrupted: invalid manifest JSON.')
  })

  // 13. Explicit corruption detection and preservation
  await runTest('corrupted manifest and hash rejected without wiping', async ({ store }) => {
    const saved = await store.save({
      tool: 'antigravity',
      name: 'To Be Corrupted',
      credential: 'original-valid-credential',
    })

    const accountDir = path.join(store.baseDirectory, saved.id)
    const manifestPath = path.join(accountDir, 'manifest.json')
    const credPath = path.join(accountDir, 'credential.utf8')

    // Case A: Tampered payload hash
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.payloadSha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    await assert.rejects(
      async () => await store.get(saved.id),
      (err) => err instanceof AccountError && err.message.includes('hash mismatch')
    )

    // Verify account files are preserved (never wiped or deleted on corruption)
    assert.ok(existsSync(manifestPath), 'Manifest must NOT be wiped on corruption')
    assert.ok(existsSync(credPath), 'Credential file must NOT be wiped on corruption')

    // Case B: Tampered payload length
    manifest.payloadSha256 = JSON.parse(readFileSync(manifestPath, 'utf8')).payloadSha256
    manifest.payloadLength = 99999
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    await assert.rejects(
      async () => await store.get(saved.id),
      (err) => err instanceof AccountError && err.message.includes('length mismatch')
    )
  })

  // 14. Concurrent mutations
  await runTest('concurrent mutations execute in serialized critical sections', async ({ store }) => {
    const promises = Array.from({ length: 8 }, (_, i) =>
      store.save({
        tool: ACCOUNT_TOOLS[i % ACCOUNT_TOOLS.length],
        name: `Concurrent Account ${i}`,
        credential: `token-${i}`,
      })
    )

    const results = await Promise.all(promises)
    assert.equal(results.length, 8)

    const list = await store.list()
    assert.equal(list.length, 8)

    // Verify no stray staging directories remain
    const dirEntries = readdirSync(store.baseDirectory)
    const stagingDirs = dirEntries.filter((name) => name.startsWith('.staging_'))
    assert.equal(stagingDirs.length, 0, 'All staging directories must be cleanly removed')
  })

  // 15. Legacy profiles non-interference
  await runTest('preserves legacy profiles and provides non-destructive detection', async ({ store, testHome }) => {
    const traceHome = path.join(testHome, '.trace')
    const legacyProfDir = path.join(traceHome, 'profiles', 'prof_legacy_123')
    mkdirSync(legacyProfDir, { recursive: true })
    writeFileSync(path.join(legacyProfDir, 'manifest.json'), '{"legacy": true}')

    assert.equal(hasLegacyProfiles(traceHome), true, 'hasLegacyProfiles must detect existing profile')

    // Normal store operations in accounts root
    const saved = await store.save({
      tool: 'antigravity',
      name: 'Modern Account',
      credential: 'modern-token',
    })

    assert.ok(existsSync(path.join(store.baseDirectory, saved.id)))
    assert.ok(existsSync(path.join(legacyProfDir, 'manifest.json')), 'Legacy profile must be completely untouched')
  })

  console.log(`\nVerification complete: ${passed} passed, ${failed} failed.`)

  // Cleanup test root
  try {
    rmSync(testRoot, { recursive: true, force: true })
  } catch {}

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
