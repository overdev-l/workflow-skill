#!/usr/bin/env node
/**
 * Verification Script for Desktop Update Publishing & Release Pipeline (OPC-53)
 *
 * Runs comprehensive unit tests on synthetic fixtures, blockmap decompression,
 * preflight checks, upload ordering, and fail-closed error handling:
 * 1. Realistic compressed blockmap fixture validation (gzip/deflate JSON)
 * 2. Valid dual-platform release bundle verification (macOS + Windows exact names)
 * 3. Actual upload ordering: immutable artifacts first, manifests strictly last
 * 4. Upload failure prevents manifest update
 * 5. Preflight resumable partial publishing (matching remote SHA-512 skips upload)
 * 6. Preflight immutability violation rejection (differing remote SHA-512)
 * 7. Preflight auth/network failure fails closed (zero uploads performed)
 * 8. Path traversal and slash rejection without silent basename normalization
 * 9. Symlink rejection for release artifacts and blockmaps
 * 10. Missing sha512 and invalid/negative size rejection
 * 11. Duplicate manifest entries rejection
 * 12. Stray different-version artifact detection
 * 13. Generic HTTPS update URL validation
 *
 * Usage:
 *   node scripts/verify-update-publishing.mjs
 */

import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import yaml from 'yaml'
import {
  computeSha512Base64,
  isStableSemver,
  publishDesktopUpdates,
  validateBlockmapFile,
  validateUpdateUrl,
  verifyReleaseDirectory,
} from './publish-desktop-updates.mjs'

// Synthetic fixture versions are independent of the CI release tag.
delete process.env.GITHUB_REF

let passed = 0
let failed = 0

async function runTest(name, fn) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verify-pub-'))
  try {
    await fn(tempDir)
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(err)
    throw err
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore temp cleanup error
    }
  }
}

console.log('=== Trace Desktop Update Publishing Verification ===\n')

function createCompressedBlockmap() {
  const payload = JSON.stringify({
    version: '2',
    files: [
      {
        name: 'test-bundle',
        offset: 0,
        checksums: ['a1b2c3d4e5f6'],
        sizes: [24],
      },
    ],
  })
  return zlib.gzipSync(Buffer.from(payload, 'utf8'))
}

function createSyntheticReleaseBundle(dir, version = '1.0.0') {
  const macZipName = `Trace-${version}-mac-arm64.zip`
  const macZipBlockmap = `${macZipName}.blockmap`
  const macDmgName = `Trace-${version}-mac-arm64.dmg`

  const winExeName = `Trace-${version}-win-x64.exe`
  const winExeBlockmap = `${winExeName}.blockmap`

  const blockmapData = createCompressedBlockmap()

  const files = {
    [macZipName]: Buffer.from('synthetic-mac-zip-content'),
    [macZipBlockmap]: blockmapData,
    [macDmgName]: Buffer.from('synthetic-mac-dmg-content'),
    [winExeName]: Buffer.from('synthetic-windows-exe-content'),
    [winExeBlockmap]: blockmapData,
  }

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content)
  }

  const macManifest = {
    version,
    files: [
      {
        url: macZipName,
        sha512: computeSha512Base64(files[macZipName]),
        size: files[macZipName].length,
      },
      {
        url: macDmgName,
        sha512: computeSha512Base64(files[macDmgName]),
        size: files[macDmgName].length,
      },
    ],
    path: macZipName,
    sha512: computeSha512Base64(files[macZipName]),
    releaseDate: new Date().toISOString(),
  }

  const winManifest = {
    version,
    files: [
      {
        url: winExeName,
        sha512: computeSha512Base64(files[winExeName]),
        size: files[winExeName].length,
      },
    ],
    path: winExeName,
    sha512: computeSha512Base64(files[winExeName]),
    releaseDate: new Date().toISOString(),
  }

  writeFileSync(path.join(dir, 'latest-mac.yml'), yaml.stringify(macManifest), 'utf8')
  writeFileSync(path.join(dir, 'latest.yml'), yaml.stringify(winManifest), 'utf8')

  return { files, macManifest, winManifest }
}

// 1. Realistic Compressed Blockmap Fixture Validation
await runTest('Blockmap Validation: validates gzip/deflate JSON and rejects corrupt data', async (dir) => {
  const validPath = path.join(dir, 'valid.blockmap')
  writeFileSync(validPath, createCompressedBlockmap())
  validateBlockmapFile(validPath)

  const emptyPath = path.join(dir, 'empty.blockmap')
  writeFileSync(emptyPath, Buffer.alloc(0))
  assert.throws(() => validateBlockmapFile(emptyPath), /empty/)

  const corruptPath = path.join(dir, 'corrupt.blockmap')
  writeFileSync(corruptPath, Buffer.from('plain-uncompressed-text'))
  assert.throws(() => validateBlockmapFile(corruptPath), /not valid gzip\/deflate/)
})

// 2. Valid Dual-Platform Release Bundle
await runTest('Valid Bundle: verifies exact platform filenames, sha512, and sizes', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.2.0')
  const plan = verifyReleaseDirectory({ dir, expectedVersion: '1.2.0' })

  assert.equal(plan.version, '1.2.0')
  assert.equal(plan.manifestFiles.length, 2)
  assert.deepEqual(plan.manifestFiles, ['latest.yml', 'latest-mac.yml'])

  assert.ok(plan.immutableFiles.includes('Trace-1.2.0-win-x64.exe'))
  assert.ok(plan.immutableFiles.includes('Trace-1.2.0-win-x64.exe.blockmap'))
  assert.ok(plan.immutableFiles.includes('Trace-1.2.0-mac-arm64.zip'))
  assert.ok(plan.immutableFiles.includes('Trace-1.2.0-mac-arm64.dmg'))
  assert.ok(plan.immutableFiles.includes('Trace-1.2.0-mac-arm64.zip.blockmap'))
})

// 3. Upload Ordering & Execution
await runTest('Upload Ordering: immutable artifacts first, manifests strictly last', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')

  const uploadedKeys = []
  const mockReadRemote = async () => ({ status: 404 })
  const mockUpload = async (_bucket, filename) => {
    uploadedKeys.push(filename)
  }

  const result = await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: true, bucket: 'test-bucket' },
    { readRemote: mockReadRemote, upload: mockUpload },
  )

  assert.equal(result.success, true)
  assert.equal(result.dryRun, false)

  // Manifests must be the last two uploads
  const lastTwo = uploadedKeys.slice(-2)
  assert.deepEqual(lastTwo, ['latest.yml', 'latest-mac.yml'])

  // Windows exe must be uploaded before manifests
  const exeIdx = uploadedKeys.indexOf('Trace-1.0.0-win-x64.exe')
  const latestIdx = uploadedKeys.indexOf('latest.yml')
  assert.ok(exeIdx !== -1 && exeIdx < latestIdx)
})

// 4. Upload Failure Prevents Manifest Update
await runTest('Upload Failure Guard: artifact upload failure prevents manifest upload', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')

  const uploadedKeys = []
  const mockReadRemote = async () => ({ status: 404 })
  const mockUpload = async (_bucket, filename) => {
    if (filename.endsWith('.dmg')) {
      throw new Error('Simulated network drop on DMG upload')
    }
    uploadedKeys.push(filename)
  }

  await assert.rejects(
    async () =>
      publishDesktopUpdates(
        { dir, version: '1.0.0', publish: true, bucket: 'test-bucket' },
        { readRemote: mockReadRemote, upload: mockUpload },
      ),
    /Simulated network drop/,
  )

  // Neither latest.yml nor latest-mac.yml should have been uploaded
  assert.ok(!uploadedKeys.includes('latest.yml'))
  assert.ok(!uploadedKeys.includes('latest-mac.yml'))
})

// 5. Preflight Resumable Partial Publishing (Skipping Identical Uploads)
await runTest('Resumable Partial Publish: skips remote artifacts matching identical SHA-512', async (dir) => {
  const { files } = createSyntheticReleaseBundle(dir, '1.0.0')

  const uploadedKeys = []
  const winExeHash = computeSha512Base64(files['Trace-1.0.0-win-x64.exe'])

  // Mock remote: Windows exe already exists with identical SHA-512, all others 404
  const mockReadRemote = async (filename) => {
    if (filename === 'Trace-1.0.0-win-x64.exe') {
      return { status: 200, sha512: winExeHash, size: files['Trace-1.0.0-win-x64.exe'].length }
    }
    return { status: 404 }
  }

  const mockUpload = async (_bucket, filename) => {
    uploadedKeys.push(filename)
  }

  await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: true, bucket: 'test-bucket' },
    { readRemote: mockReadRemote, upload: mockUpload },
  )

  // Trace-1.0.0-win-x64.exe should be SKIPPED
  assert.ok(!uploadedKeys.includes('Trace-1.0.0-win-x64.exe'))
  // Other files must be uploaded
  assert.ok(uploadedKeys.includes('Trace-1.0.0-mac-arm64.zip'))
  assert.ok(uploadedKeys.includes('latest-mac.yml'))
})

// 6. Preflight Immutability Violation Rejection
await runTest('Immutability Violation: rejects when remote artifact has differing SHA-512', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')

  const mockReadRemote = async (filename) => {
    if (filename === 'Trace-1.0.0-win-x64.exe') {
      // Differing remote content hash
      return { status: 200, sha512: 'mismatched-different-remote-sha512-hash-value-here==', size: 500 }
    }
    return { status: 404 }
  }

  const uploadedKeys = []
  const mockUpload = async (_bucket, filename) => {
    uploadedKeys.push(filename)
  }

  await assert.rejects(
    async () =>
      publishDesktopUpdates(
        { dir, version: '1.0.0', publish: true, bucket: 'test-bucket' },
        { readRemote: mockReadRemote, upload: mockUpload },
      ),
    /Immutability violation/,
  )

  // ZERO files should have been uploaded
  assert.equal(uploadedKeys.length, 0)
})

// 7. Preflight Failure Fails Closed
await runTest('Preflight Fail-Closed: unexpected HTTP status aborts before any upload', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')

  const mockReadRemote = async () => {
    // Simulated 403 Forbidden or 503 error from Cloudflare
    return { status: 403 }
  }

  const uploadedKeys = []
  const mockUpload = async (_bucket, filename) => {
    uploadedKeys.push(filename)
  }

  await assert.rejects(
    async () =>
      publishDesktopUpdates(
        { dir, version: '1.0.0', publish: true, bucket: 'test-bucket' },
        { readRemote: mockReadRemote, upload: mockUpload },
      ),
    /failed closed/,
  )

  assert.equal(uploadedKeys.length, 0)
})

// 8. Path Traversal & Slash Rejection
await runTest('Path Traversal: rejects slashes and traversal without silent normalization', async (dir) => {
  const { macManifest } = createSyntheticReleaseBundle(dir, '1.0.0')
  macManifest.files[0].url = '../../Trace-1.0.0-mac-arm64.zip'
  writeFileSync(path.join(dir, 'latest-mac.yml'), yaml.stringify(macManifest), 'utf8')

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Path traversal and slashes are strictly forbidden/,
  )
})

// 9. Symlink Rejection
await runTest('Symlink Rejection: rejects release binaries that are symbolic links', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const realDmg = path.join(dir, 'Trace-1.0.0-mac-arm64.dmg')
  const realBackup = path.join(dir, 'backup.dmg')

  // Move real file and replace with symlink
  writeFileSync(realBackup, Buffer.from('backup-payload'))
  rmSync(realDmg)
  symlinkSync(realBackup, realDmg)

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Symlink rejected/,
  )
})

// 10. Missing Hash and Invalid Size Rejection
await runTest('Manifest Validation: rejects missing sha512 and negative/non-integer size', async (dir) => {
  const { macManifest } = createSyntheticReleaseBundle(dir, '1.0.0')
  macManifest.files[0].sha512 = ''
  writeFileSync(path.join(dir, 'latest-mac.yml'), yaml.stringify(macManifest), 'utf8')

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Invalid or missing sha512/,
  )

  const { winManifest } = createSyntheticReleaseBundle(dir, '1.0.0')
  winManifest.files[0].size = -10
  writeFileSync(path.join(dir, 'latest.yml'), yaml.stringify(winManifest), 'utf8')

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Invalid size/,
  )
})

// 11. Duplicate Manifest Entries Rejection
await runTest('Duplicate Rejection: rejects duplicate entries within files array', async (dir) => {
  const { winManifest } = createSyntheticReleaseBundle(dir, '1.0.0')
  winManifest.files.push({ ...winManifest.files[0] })
  writeFileSync(path.join(dir, 'latest.yml'), yaml.stringify(winManifest), 'utf8')

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Duplicate entry/,
  )
})

// 12. Stray Different-Version Binaries Rejection
await runTest('Stray Artifacts: rejects stray different-version binaries in output directory', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  writeFileSync(path.join(dir, 'Trace-0.9.0-win-x64.exe'), Buffer.from('old-exe'))

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Stray release file detected/,
  )
})

// 13. Update URL Validation
await runTest('Update URL Validation: requires strict HTTPS format', async () => {
  assert.equal(validateUpdateUrl('https://updates.example.invalid'), 'https://updates.example.invalid')
  assert.equal(validateUpdateUrl('https://updates.example.invalid/'), 'https://updates.example.invalid')

  assert.throws(() => validateUpdateUrl('http://updates.example.invalid'), /must be https:/)
  assert.throws(() => validateUpdateUrl('https://user:pass@updates.example.invalid'), /credentials/)
  assert.throws(() => validateUpdateUrl('https://updates.example.invalid?foo=bar'), /query strings/)
  assert.throws(() => validateUpdateUrl('https://updates.example.invalid#frag'), /hash fragments/)
})

await runTest('Release tag validation: mismatched tags and absent explicit publish versions fail', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  process.env.GITHUB_REF = 'refs/tags/v2.0.0'
  try {
    assert.throws(() => verifyReleaseDirectory({dir, expectedVersion: '1.0.0'}), /GITHUB_REF/)
  } finally { delete process.env.GITHUB_REF }
  await assert.rejects(publishDesktopUpdates({dir, publish: true, bucket: 'test-bucket'}), /requires --version/)
})

console.log(`\nVerification complete: ${passed} passed, ${failed} failed.`)
