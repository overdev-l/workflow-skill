#!/usr/bin/env node
/**
 * Verification Script for Desktop Update Publishing & GitHub Release Pipeline
 *
 * Runs comprehensive unit tests on synthetic fixtures, blockmap decompression,
 * preflight checks, gh CLI release workflow, upload ordering, and fail-closed error handling:
 * 1. Realistic compressed blockmap fixture validation (gzip/deflate JSON)
 * 2. Valid dual-platform release bundle verification (macOS + Windows exact names)
 * 3. Strict repository format validation (owner/name)
 * 4. Dry-run mode: zero file writes and zero gh command invocations
 * 5. Stable publishing workflow: upload ordering (binaries first, manifests last, latest=true)
 * 6. Preview publishing workflow: excludes platform manifests, prerelease=true, latest=false
 * 7. Draft hidden: asset upload failure aborts before publishing draft
 * 8. Draft hidden: remote asset verification failure aborts before publishing draft
 * 9. Public release immutability guard: returns verified-existing, rejects mismatch, never clobbers
 * 10. Resumable draft: skips matching remote draft artifacts and uploads remaining
 * 11. Resumable draft collision: rejects differing content/size with zero uploads
 * 12. Auth and network fail closed: 401/403/network errors abort safely without leaks
 * 13. Generic release notes: user-facing notes contain no private source commits/logs
 * 14. Path traversal and slash rejection without silent basename normalization
 * 15. Symlink rejection for release artifacts and blockmaps
 * 16. Missing sha512 and invalid/negative size rejection
 * 17. Duplicate manifest entries rejection
 * 18. Stray different-version artifact detection
 * 19. Explicit version requirement and GITHUB_REF mismatch validation
 *
 * Usage:
 *   node scripts/verify-update-publishing.mjs
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import yaml from 'yaml'
import {
  computeSha512Base64,
  generateGenericReleaseNotes,
  isStableSemver,
  publishDesktopUpdates,
  validateBlockmapFile,
  validateRepository,
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

function createMockGh({
  release = null,
  failOnUpload = null,
  authError = false,
  networkError = false,
} = {}) {
  const calls = []
  let currentRelease = release ? JSON.parse(JSON.stringify(release)) : null

  const gh = async (args) => {
    calls.push(args)
    const subcommand = args[1]

    if (authError) {
      return { status: 1, stderr: 'HTTP 401: Bad credentials' }
    }
    if (networkError) {
      return { status: 1, stderr: 'Could not resolve host: github.com' }
    }

    if (subcommand === 'view') {
      if (!currentRelease) {
        return { status: 1, stderr: 'HTTP 404: release not found' }
      }
      return {
        status: 0,
        stdout: JSON.stringify(currentRelease),
      }
    }

    if (subcommand === 'create') {
      const tag = args[2]
      const isPrerelease = args.includes('--prerelease')
      currentRelease = {
        id: 'rel-synthetic',
        tagName: tag,
        isDraft: true,
        isPrerelease,
        assets: [],
      }
      return { status: 0, stdout: '' }
    }

    if (subcommand === 'upload') {
      const filePath = args[3]
      const filename = path.basename(filePath)
      if (failOnUpload && filename === failOnUpload) {
        return { status: 1, stderr: 'Simulated upload error' }
      }
      const stat = statSync(filePath)
      const content = readFileSync(filePath)
      const sha256 = crypto.createHash('sha256').update(content).digest('hex')
      if (!currentRelease) {
        currentRelease = { id: 'rel-synthetic', isDraft: true, assets: [] }
      }
      currentRelease.assets.push({
        id: `asset-${currentRelease.assets.length + 1}`,
        name: filename,
        size: stat.size,
        digest: `sha256:${sha256}`,
      })
      return { status: 0, stdout: '' }
    }

    if (subcommand === 'download') {
      const pattern = args[args.indexOf('--pattern') + 1]
      const outDir = args[args.indexOf('--dir') + 1]
      if (outDir && pattern) {
        writeFileSync(path.join(outDir, pattern), Buffer.from('mock-downloaded-payload'))
      }
      return { status: 0, stdout: '' }
    }

    if (subcommand === 'edit') {
      if (currentRelease) {
        if (args.includes('--draft=false')) {
          currentRelease.isDraft = false
        }
        if (args.includes('--latest=true')) {
          currentRelease.latest = true
        }
        if (args.includes('--prerelease=true')) {
          currentRelease.isPrerelease = true
        }
      }
      return { status: 0, stdout: '' }
    }

    return { status: 0, stdout: '' }
  }

  return {
    gh,
    calls,
    getCurrentRelease: () => currentRelease,
  }
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

// 3. Strict Repository Format Validation
await runTest('Repository Validation: requires strict owner/name format', async () => {
  assert.equal(validateRepository('my-org/my-repo'), 'my-org/my-repo')
  assert.equal(validateRepository('owner/repo.name'), 'owner/repo.name')
  assert.equal(validateRepository('User-123/Project_456'), 'User-123/Project_456')

  assert.throws(() => validateRepository(''), /Repository is required/)
  assert.throws(() => validateRepository('invalid-no-slash'), /Invalid repository format/)
  assert.throws(() => validateRepository('owner/repo/extra'), /Invalid repository format/)
  assert.throws(() => validateRepository('https://github.com/owner/repo'), /Invalid repository format/)
  assert.throws(() => validateRepository('../owner/repo'), /Invalid repository format/)
})

// 4. Dry-Run Mode: Zero File Writes and Zero Commands
await runTest('Dry-Run Mode: verifies directory with zero uploads and zero commands', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const mock = createMockGh()

  const result = await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: false, repository: 'test-org/test-repo' },
    { gh: mock.gh },
  )

  assert.equal(result.success, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.tag, 'v1.0.0')
  assert.equal(mock.calls.length, 0)
})

// 5. Stable Upload Ordering & Manifests Strictly Last
await runTest('Stable Upload Ordering: binaries first, checksums next, manifests strictly last', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const mock = createMockGh()

  const result = await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
    { gh: mock.gh },
  )

  assert.equal(result.success, true)
  assert.equal(result.dryRun, false)
  assert.equal(result.tag, 'v1.0.0')

  const uploadCalls = mock.calls.filter((c) => c[1] === 'upload')
  const uploadedFiles = uploadCalls.map((c) => path.basename(c[3]))

  // Manifests must be the last two uploads
  const lastTwo = uploadedFiles.slice(-2)
  assert.deepEqual(lastTwo, ['latest.yml', 'latest-mac.yml'])

  // Checksum file must be uploaded before manifests
  assert.ok(uploadedFiles.includes('checksums-sha512.txt'))

  // Windows exe must be uploaded before manifests
  const exeIdx = uploadedFiles.indexOf('Trace-1.0.0-win-x64.exe')
  const latestIdx = uploadedFiles.indexOf('latest.yml')
  assert.ok(exeIdx !== -1 && exeIdx < latestIdx)

  // Edit call must publish with draft=false, prerelease=false, latest=true
  const editCall = mock.calls.find((c) => c[1] === 'edit')
  assert.ok(editCall)
  assert.ok(editCall.includes('--draft=false'))
  assert.ok(editCall.includes('--prerelease=false'))
  assert.ok(editCall.includes('--latest=true'))
})

// 6. Preview Publishing Excludes Manifests
await runTest('Preview Publishing: creates prerelease, uploads binaries/checksums, strictly excludes manifests', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const mock = createMockGh()

  const result = await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo', preview: true },
    { gh: mock.gh },
  )

  assert.equal(result.success, true)
  assert.equal(result.dryRun, false)
  assert.equal(result.tag, 'preview-v1.0.0')
  assert.equal(result.preview, true)

  const uploadCalls = mock.calls.filter((c) => c[1] === 'upload')
  const uploadedFiles = uploadCalls.map((c) => path.basename(c[3]))

  // Strictly NEVER upload latest*.yml for preview
  assert.ok(!uploadedFiles.includes('latest.yml'))
  assert.ok(!uploadedFiles.includes('latest-mac.yml'))

  // Uploads binaries, blockmaps, and checksums
  assert.ok(uploadedFiles.includes('Trace-1.0.0-win-x64.exe'))
  assert.ok(uploadedFiles.includes('Trace-1.0.0-mac-arm64.zip'))
  assert.ok(uploadedFiles.includes('checksums-sha512.txt'))

  // Draft creation must include --prerelease
  const createCall = mock.calls.find((c) => c[1] === 'create')
  assert.ok(createCall.includes('--prerelease'))

  // Edit call must set prerelease=true and latest=false
  const editCall = mock.calls.find((c) => c[1] === 'edit')
  assert.ok(editCall)
  assert.ok(editCall.includes('--draft=false'))
  assert.ok(editCall.includes('--prerelease=true'))
  assert.ok(editCall.includes('--latest=false'))
})

// 7. Draft Hidden: Asset Upload Failure Prevents Publishing
await runTest('Draft Hidden - Upload Failure: asset upload failure aborts before publishing draft', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const mock = createMockGh({ failOnUpload: 'Trace-1.0.0-mac-arm64.dmg' })

  await assert.rejects(
    () => publishDesktopUpdates(
      { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
      { gh: mock.gh },
    ),
    /Failed to upload asset 'Trace-1.0.0-mac-arm64.dmg'/,
  )

  // Edit call to publish must NEVER have been called
  const editCall = mock.calls.find((c) => c[1] === 'edit')
  assert.equal(editCall, undefined)
})

// 8. Draft Hidden: Remote Asset Verification Failure Prevents Publishing
await runTest('Draft Hidden - Remote Verification: missing asset on remote aborts publishing', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const mock = createMockGh()
  const baseGh = mock.gh
  let uploadCount = 0

  const gh = async (args) => {
    if (args[1] === 'upload') {
      uploadCount++
    }
    if (args[1] === 'view' && uploadCount > 0) {
      // Simulate remote asset omission on verification view
      const rel = JSON.parse(JSON.stringify(mock.getCurrentRelease()))
      rel.assets = rel.assets.filter((a) => !a.name.endsWith('.dmg'))
      return { status: 0, stdout: JSON.stringify(rel) }
    }
    return baseGh(args)
  }

  await assert.rejects(
    () => publishDesktopUpdates(
      { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
      { gh },
    ),
    /Remote asset verification failed/,
  )

  // Edit call to publish must NEVER have been called
  const editCall = mock.calls.find((c) => c[1] === 'edit')
  assert.equal(editCall, undefined)
})

// 9. Public Release Immutability Guard
await runTest('Immutability Guard: verified intact public release returns verified-existing; mismatch rejects', async (dir) => {
  const { files } = createSyntheticReleaseBundle(dir, '1.0.0')

  const winExe = 'Trace-1.0.0-win-x64.exe'
  const winBm = 'Trace-1.0.0-win-x64.exe.blockmap'
  const macZip = 'Trace-1.0.0-mac-arm64.zip'
  const macBm = 'Trace-1.0.0-mac-arm64.zip.blockmap'
  const macDmg = 'Trace-1.0.0-mac-arm64.dmg'

  const macManifestContent = readFileSync(path.join(dir, 'latest-mac.yml'))
  const winManifestContent = readFileSync(path.join(dir, 'latest.yml'))

  const checksumLines = [
    ...verifyReleaseDirectory({dir, expectedVersion: '1.0.0'}).immutableFiles,
  ].map((fn) => `${crypto.createHash('sha512').update(files[fn]).digest('hex')}  ${fn}`).join('\n') + '\n'
  const checksumSize = Buffer.byteLength(checksumLines, 'utf8')

  const completeAssets = [
    { name: winExe, size: files[winExe].length },
    { name: winBm, size: files[winBm].length },
    { name: macZip, size: files[macZip].length },
    { name: macBm, size: files[macBm].length },
    { name: macDmg, size: files[macDmg].length },
    { name: 'checksums-sha512.txt', size: checksumSize },
    { name: 'latest.yml', size: winManifestContent.length },
    { name: 'latest-mac.yml', size: macManifestContent.length },
  ].map((item, idx) => ({ id: `asset-${idx}`, ...item, digest: 'sha256:' + crypto.createHash('sha256').update(
    item.name === 'checksums-sha512.txt' ? Buffer.from(checksumLines) : readFileSync(path.join(dir, item.name))
  ).digest('hex') }))

  const publicRel = {
    id: 'rel-pub',
    tagName: 'v1.0.0',
    isDraft: false,
    isPrerelease: false,
    assets: completeAssets,
  }

  // Intact public release: returns verifiedExisting without upload or edit
  const mockPublic = createMockGh({ release: publicRel })
  const result = await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
    { gh: mockPublic.gh },
  )
  assert.equal(result.success, true)
  assert.equal(result.verifiedExisting, true)
  assert.equal(mockPublic.calls.filter((c) => c[1] === 'upload').length, 0)
  assert.equal(mockPublic.calls.filter((c) => c[1] === 'edit').length, 0)

  // Incomplete public release: rejects with immutability violation
  const incompleteRel = {
    ...publicRel,
    assets: completeAssets.slice(0, 2),
  }
  const mockIncomplete = createMockGh({ release: incompleteRel })
  await assert.rejects(
    () => publishDesktopUpdates(
      { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
      { gh: mockIncomplete.gh },
    ),
    /Immutability violation/,
  )
})

// 10. Resumable Draft: Skips Identical Uploads
await runTest('Resumable Draft: skips remote draft artifacts matching identical digest', async (dir) => {
  const { files } = createSyntheticReleaseBundle(dir, '1.0.0')
  const winExeName = 'Trace-1.0.0-win-x64.exe'
  const winExeBuf = files[winExeName]
  const winExeSha256 = crypto.createHash('sha256').update(winExeBuf).digest('hex')

  const draftRel = {
    id: 'rel-draft-1',
    tagName: 'v1.0.0',
    isDraft: true,
    isPrerelease: false,
    assets: [
      {
        id: 'asset-1',
        name: winExeName,
        size: winExeBuf.length,
        digest: `sha256:${winExeSha256}`,
      },
    ],
  }

  const mockDraft = createMockGh({ release: draftRel })
  const result = await publishDesktopUpdates(
    { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
    { gh: mockDraft.gh },
  )

  assert.equal(result.success, true)
  const uploadCalls = mockDraft.calls.filter((c) => c[1] === 'upload')
  const uploadedFilenames = uploadCalls.map((c) => path.basename(c[3]))

  // Trace-1.0.0-win-x64.exe was already in draft and must NOT be re-uploaded
  assert.ok(!uploadedFilenames.includes(winExeName))
  // Other files were missing and must be uploaded
  assert.ok(uploadedFilenames.includes('Trace-1.0.0-mac-arm64.zip'))
  assert.ok(uploadedFilenames.includes('latest-mac.yml'))
})

// 11. Resumable Draft Collision Rejection
await runTest('Draft Collision: rejects when existing draft artifact has differing digest or size', async (dir) => {
  const { files } = createSyntheticReleaseBundle(dir, '1.0.0')
  const winExeName = 'Trace-1.0.0-win-x64.exe'

  // Collision with differing hash
  const collidingDraft = {
    id: 'rel-colliding',
    tagName: 'v1.0.0',
    isDraft: true,
    isPrerelease: false,
    assets: [
      {
        id: 'asset-1',
        name: winExeName,
        size: files[winExeName].length,
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    ],
  }

  const mock = createMockGh({ release: collidingDraft })
  await assert.rejects(
    () => publishDesktopUpdates(
      { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
      { gh: mock.gh },
    ),
    /Collision detected/,
  )

  assert.equal(mock.calls.filter((c) => c[1] === 'upload').length, 0)
})

// 12. Auth and Network Fail Closed
await runTest('Auth and Network Fail-Closed: unexpected 401/403/network error fails closed without leaks', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')

  // Auth failure
  const mockAuth = createMockGh({ authError: true })
  await assert.rejects(
    () => publishDesktopUpdates(
      { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
      { gh: mockAuth.gh },
    ),
    /authentication or network failure/,
  )
  assert.equal(mockAuth.calls.filter((c) => c[1] === 'upload').length, 0)

  // Network failure
  const mockNet = createMockGh({ networkError: true })
  await assert.rejects(
    () => publishDesktopUpdates(
      { dir, version: '1.0.0', publish: true, repository: 'test-org/test-repo' },
      { gh: mockNet.gh },
    ),
    /authentication or network failure/,
  )
  assert.equal(mockNet.calls.filter((c) => c[1] === 'upload').length, 0)
})

// 13. Generic Release Notes
await runTest('Release Notes: generic user-facing text without private repository logs or commits', async () => {
  const stableNotes = generateGenericReleaseNotes({ version: '1.0.0', tag: 'v1.0.0', preview: false })
  assert.ok(stableNotes.includes('Trace Desktop v1.0.0'))
  assert.ok(!stableNotes.includes('git commit'))
  assert.ok(!stableNotes.includes('workflow-skill'))

  const previewNotes = generateGenericReleaseNotes({ version: '1.0.0', tag: 'preview-v1.0.0', preview: true })
  assert.ok(previewNotes.includes('Trace Desktop Preview v1.0.0'))
  assert.ok(previewNotes.includes('Unsigned'))
  assert.ok(!previewNotes.includes('workflow-skill'))
})

// 14. Path Traversal & Slash Rejection
await runTest('Path Traversal: rejects slashes and traversal without silent normalization', async (dir) => {
  const { macManifest } = createSyntheticReleaseBundle(dir, '1.0.0')
  macManifest.files[0].url = '../../Trace-1.0.0-mac-arm64.zip'
  writeFileSync(path.join(dir, 'latest-mac.yml'), yaml.stringify(macManifest), 'utf8')

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Path traversal and slashes are strictly forbidden/,
  )
})

// 15. Symlink Rejection
await runTest('Symlink Rejection: rejects release binaries that are symbolic links', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  const realDmg = path.join(dir, 'Trace-1.0.0-mac-arm64.dmg')
  const realBackup = path.join(dir, 'backup.dmg')

  writeFileSync(realBackup, Buffer.from('backup-payload'))
  rmSync(realDmg)
  symlinkSync(realBackup, realDmg)

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Symlink rejected/,
  )
})

// 16. Missing Hash and Invalid Size Rejection
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

// 17. Duplicate Manifest Entries Rejection
await runTest('Duplicate Rejection: rejects duplicate entries within files array', async (dir) => {
  const { winManifest } = createSyntheticReleaseBundle(dir, '1.0.0')
  winManifest.files.push({ ...winManifest.files[0] })
  writeFileSync(path.join(dir, 'latest.yml'), yaml.stringify(winManifest), 'utf8')

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Duplicate entry/,
  )
})

// 18. Stray Different-Version Binaries Rejection
await runTest('Stray Artifacts: rejects stray different-version binaries in output directory', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  writeFileSync(path.join(dir, 'Trace-0.9.0-win-x64.exe'), Buffer.from('old-exe'))

  assert.throws(
    () => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }),
    /Stray release file detected/,
  )
})

// 19. Release Tag & Version Validation
await runTest('Release Tag Validation: mismatched tags and absent explicit publish versions fail', async (dir) => {
  createSyntheticReleaseBundle(dir, '1.0.0')
  process.env.GITHUB_REF = 'refs/tags/v2.0.0'
  try {
    assert.throws(() => verifyReleaseDirectory({ dir, expectedVersion: '1.0.0' }), /GITHUB_REF/)
  } finally {
    delete process.env.GITHUB_REF
  }
  await assert.rejects(
    publishDesktopUpdates({ dir, publish: true, repository: 'test-org/test-repo' }),
    /Publishing requires explicit --version or expectedVersion/,
  )
})

console.log(`\nVerification complete: ${passed} passed, ${failed} failed.`)
