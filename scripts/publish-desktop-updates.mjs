#!/usr/bin/env node
/**
 * Trace Desktop Updates Publishing Script (OPC-53)
 *
 * Verifies and publishes release artifacts to Cloudflare R2:
 * - Validates TWO platform manifests (latest-mac.yml and latest.yml)
 * - Requires exact stable semver (major.minor.patch) matching --version or GITHUB_REF tag
 * - Enforces exact safe filenames: Trace-${version}-mac-arm64.zip/dmg and Trace-${version}-win-x64.exe
 * - Rejects path traversal, url encoding, duplicate entries, and symlinks
 * - Validates required sha512 and positive integer size on every manifest file entry
 * - Validates compressed blockmaps (.zip.blockmap, .exe.blockmap) by decompressing gzip/deflate JSON
 * - Preflight verification via HTTPS HEAD/GET to TRACE_UPDATE_URL:
 *   - 404 explicitly required for new artifacts
 *   - 200 with identical SHA-512 skipped for resumable partial publishing
 *   - 200 with differing SHA-512 rejected (immutability violation)
 *   - Any other status (401, 403, 500, 503) fails closed
 * - Preflights ALL immutable artifacts before any upload occurs
 * - Uploads immutable artifacts sequentially first, manifests last
 * - Uses `pnpm --filter @workflow-skill/web exec wrangler r2 object put <bucket>/<key> --file <path> --remote`
 * - Defaults to dry-run; requires explicit `--publish`
 * - Strictly avoids leaking secrets or echoing raw remote error outputs
 *
 * Usage:
 *   node scripts/publish-desktop-updates.mjs [--dir <dist/desktop>] [--version <0.1.0>] [--publish] [--bucket <name>]
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import yaml from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

// =========================================================================
// Pure Verification Helpers (Exported for Unit Tests)
// =========================================================================

export const STABLE_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const SHA512_BASE64_REGEX = /^[A-Za-z0-9+/=]{86,88}$/

export function normalizeVersion(v) {
  return String(v ?? '').trim().replace(/^v/, '')
}

export function isStableSemver(version) {
  const norm = normalizeVersion(version)
  return STABLE_SEMVER_REGEX.test(norm)
}

export function computeSha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64')
}

/**
 * Validates a generic HTTPS update URL without credentials, query, or fragment.
 */
export function validateUpdateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Update URL is required.')
  }
  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error('Invalid update URL format.')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Protocol must be https:, got '${parsed.protocol}'`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Update URL must not contain username or password credentials.')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Update URL must not contain query strings or hash fragments.')
  }
  let href = parsed.href
  if (href.endsWith('/')) {
    href = href.slice(0, -1)
  }
  return href
}

/**
 * Decompresses and validates a blockmap file (gzip or deflate compressed JSON).
 */
export function validateBlockmapFile(filePath) {
  const data = readFileSync(filePath)
  if (data.length === 0) {
    throw new Error(`Blockmap file is empty: ${filePath}`)
  }
  let decompressed
  try {
    decompressed = zlib.gunzipSync(data)
  } catch {
    try {
      decompressed = zlib.inflateSync(data)
    } catch {
      throw new Error(`Blockmap file is not valid gzip/deflate compressed data: ${filePath}`)
    }
  }
  if (decompressed.length === 0) {
    throw new Error(`Decompressed blockmap is empty: ${filePath}`)
  }
  try {
    const parsed = JSON.parse(decompressed.toString('utf8'))
    if (parsed?.version !== '2' || !Array.isArray(parsed.files) || !parsed.files.length
      || parsed.files.some(file => !Number.isSafeInteger(file.offset) || file.offset < 0
        || !Array.isArray(file.sizes) || !file.sizes.length || file.sizes.some(size => !Number.isSafeInteger(size) || size <= 0)
        || !Array.isArray(file.checksums) || file.checksums.length !== file.sizes.length
        || file.checksums.some(checksum => typeof checksum !== 'string' || !checksum))) {
      throw new Error('Blockmap JSON schema is invalid')
    }
  } catch (err) {
    throw new Error(`Blockmap decompressed content is not valid JSON: ${err.message}`)
  }
}

/**
 * Verifies the release directory, both platform manifests, all files, hashes, and sizes.
 */
export function verifyReleaseDirectory(options) {
  const dir = path.resolve(options.dir)
  if (!existsSync(dir)) {
    throw new Error(`Release directory does not exist: ${dir}`)
  }

  if (options.publish && !options.version && !options.expectedVersion && !/^refs\/tags\/v/.test(process.env.GITHUB_REF ?? '')) throw new Error('Publishing requires --version or a stable GITHUB_REF tag.')

  // Determine expected target version
  let expectedVersion = (options.expectedVersion || options.version) ? normalizeVersion(options.expectedVersion || options.version) : undefined
  if (!expectedVersion && process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/tags/v')) {
    expectedVersion = normalizeVersion(process.env.GITHUB_REF.slice('refs/tags/v'.length))
  }
  if (!expectedVersion) {
    try {
      const desktopPkg = JSON.parse(readFileSync(path.join(rootDir, 'apps', 'desktop', 'package.json'), 'utf8'))
      expectedVersion = normalizeVersion(desktopPkg.version)
    } catch {
      // Ignored
    }
  }

  if (expectedVersion && !isStableSemver(expectedVersion)) {
    throw new Error(`Expected version '${expectedVersion}' is not a valid stable semver (major.minor.patch).`)
  }

  // If GITHUB_REF is set and differs from expectedVersion, fail immediately
  if (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/tags/v')) {
    const tagVersion = normalizeVersion(process.env.GITHUB_REF.slice('refs/tags/v'.length))
    if (expectedVersion && tagVersion !== expectedVersion) {
      throw new Error(`GITHUB_REF tag version '${tagVersion}' does not match target version '${expectedVersion}'.`)
    }
  }

  const macManifestPath = path.join(dir, 'latest-mac.yml')
  const winManifestPath = path.join(dir, 'latest.yml')

  if (!existsSync(macManifestPath)) {
    throw new Error(`Missing macOS manifest: ${macManifestPath}`)
  }
  if (!existsSync(winManifestPath)) {
    throw new Error(`Missing Windows manifest: ${winManifestPath}`)
  }

  for (const manifest of [macManifestPath, winManifestPath]) {
    if (!lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink()) throw new Error('Manifest must be a regular file, not a symlink.')
  }
  let macManifest
  let winManifest
  try {
    macManifest = yaml.parse(readFileSync(macManifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`Failed to parse latest-mac.yml: ${err.message}`)
  }
  try {
    winManifest = yaml.parse(readFileSync(winManifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`Failed to parse latest.yml: ${err.message}`)
  }

  if (!macManifest || typeof macManifest !== 'object') {
    throw new Error('latest-mac.yml is empty or invalid.')
  }
  if (!winManifest || typeof winManifest !== 'object') {
    throw new Error('latest.yml is empty or invalid.')
  }

  const macVersion = normalizeVersion(macManifest.version)
  const winVersion = normalizeVersion(winManifest.version)

  if (!macVersion || !winVersion) {
    throw new Error('Manifests must define a non-empty version field.')
  }
  if (macVersion !== winVersion) {
    throw new Error(`Platform version mismatch: latest-mac.yml is '${macVersion}' but latest.yml is '${winVersion}'.`)
  }
  if (!isStableSemver(macVersion)) {
    throw new Error(`Manifest version '${macVersion}' is not a valid stable semver.`)
  }
  if (expectedVersion && macVersion !== expectedVersion) {
    throw new Error(`Manifest version '${macVersion}' does not match expected version '${expectedVersion}'.`)
  }

  const version = macVersion

  // Expected exact artifact naming convention
  const expectedMacZip = `Trace-${version}-mac-arm64.zip`
  const expectedMacDmg = `Trace-${version}-mac-arm64.dmg`
  const expectedWinExe = `Trace-${version}-win-x64.exe`

  /**
   * Validates manifest files entries without silently normalizing paths
   */
  const validateManifestFiles = (manifest, manifestName, platform) => {
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error(`${manifestName} must contain a non-empty 'files' array.`)
    }

    const entries = []
    const seenFilenames = new Set()

    for (const item of manifest.files) {
      if (!item || typeof item !== 'object') {
        throw new Error(`Invalid entry in ${manifestName} files list.`)
      }

      const filename = item.url
      if (!filename || typeof filename !== 'string') {
        throw new Error(`Entry in ${manifestName} missing url property.`)
      }

      // Strictly reject path separators, traversal sequences, or normalization
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.trim() !== filename) {
        throw new Error(`Unsafe or non-base filename in ${manifestName}: '${filename}'. Path traversal and slashes are strictly forbidden.`)
      }

      if (seenFilenames.has(filename)) {
        throw new Error(`Duplicate entry in ${manifestName}: '${filename}' is declared more than once.`)
      }
      seenFilenames.add(filename)

      // Validate required SHA-512
      if (!item.sha512 || typeof item.sha512 !== 'string' || !SHA512_BASE64_REGEX.test(item.sha512)) {
        throw new Error(`Invalid or missing sha512 for '${filename}' in ${manifestName}. Must be valid base64 SHA-512.`)
      }

      // Validate required positive integer size
      if (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size <= 0) {
        throw new Error(`Invalid size for '${filename}' in ${manifestName}. Must be a positive integer.`)
      }

      // Validate filename exact match and version containment
      if (platform === 'mac') {
        if (filename !== expectedMacZip && filename !== expectedMacDmg) {
          throw new Error(`Unexpected macOS artifact filename in ${manifestName}: '${filename}'. Expected '${expectedMacZip}' or '${expectedMacDmg}'.`)
        }
      } else {
        if (filename !== expectedWinExe) {
          throw new Error(`Unexpected Windows artifact filename in ${manifestName}: '${filename}'. Expected '${expectedWinExe}'.`)
        }
      }

      entries.push({
        filename,
        sha512: item.sha512,
        size: item.size,
      })
    }

    // Validate legacy path/sha512 fields if present
    if (manifest.path) {
      if (typeof manifest.path !== 'string' || manifest.path.includes('/') || manifest.path.includes('\\') || manifest.path.includes('..')) {
        throw new Error(`Unsafe legacy path in ${manifestName}: '${manifest.path}'`)
      }
      const matching = entries.find((e) => e.filename === manifest.path)
      if (!matching) {
        throw new Error(`Legacy path '${manifest.path}' does not match any entry in ${manifestName} files list.`)
      }
      if (manifest.sha512 && manifest.sha512 !== matching.sha512) {
        throw new Error(`Legacy sha512 in ${manifestName} does not match files entry sha512 for '${manifest.path}'.`)
      }
    }

    return entries
  }

  const macEntries = validateManifestFiles(macManifest, 'latest-mac.yml', 'mac')
  const winEntries = validateManifestFiles(winManifest, 'latest.yml', 'win')

  // Verify presence of required platform formats
  if (!macEntries.some((e) => e.filename.endsWith('.zip'))) {
    throw new Error(`latest-mac.yml is missing required .zip artifact: '${expectedMacZip}'`)
  }
  if (!macEntries.some((e) => e.filename.endsWith('.dmg'))) {
    throw new Error(`latest-mac.yml is missing required .dmg artifact: '${expectedMacDmg}'`)
  }
  if (!winEntries.some((e) => e.filename.endsWith('.exe'))) {
    throw new Error('latest.yml is missing required .exe artifact.')
  }

  // Check physical files on disk: verify size, sha512, and non-symlink
  const allArtifactEntries = [...macEntries, ...winEntries]
  const immutableFilesMap = new Map() // filename -> { sha512, size, isBlockmap: boolean }

  for (const entry of allArtifactEntries) {
    const filePath = path.join(dir, entry.filename)
    if (!existsSync(filePath)) {
      throw new Error(`Manifest artifact missing on disk: ${filePath}`)
    }

    const lstat = lstatSync(filePath)
    if (lstat.isSymbolicLink()) {
      throw new Error(`Symlink rejected for release artifact: ${filePath}`)
    }
    if (!lstat.isFile()) {
      throw new Error(`Artifact is not a regular file: ${filePath}`)
    }

    const stat = statSync(filePath)
    if (stat.size !== entry.size) {
      throw new Error(`File size mismatch for '${entry.filename}': expected ${entry.size}, got ${stat.size}`)
    }

    const content = readFileSync(filePath)
    const computedSha512 = computeSha512Base64(content)
    if (computedSha512 !== entry.sha512) {
      throw new Error(`SHA-512 hash mismatch for '${entry.filename}'!\nExpected: ${entry.sha512}\nComputed: ${computedSha512}`)
    }

    immutableFilesMap.set(entry.filename, {
      sha512: entry.sha512,
      size: entry.size,
      isBlockmap: false,
    })

    // Check required companion blockmap for zip and exe
    const blockmapName = `${entry.filename}.blockmap`
    const blockmapPath = path.join(dir, blockmapName)
    if (entry.filename.endsWith('.zip') || entry.filename.endsWith('.exe')) {
      if (!existsSync(blockmapPath)) {
        throw new Error(`Required blockmap missing on disk: ${blockmapPath}`)
      }
    }

    if (existsSync(blockmapPath)) {
      const bmStat = lstatSync(blockmapPath)
      if (bmStat.isSymbolicLink()) {
        throw new Error(`Symlink rejected for blockmap: ${blockmapPath}`)
      }
      if (!bmStat.isFile()) {
        throw new Error(`Blockmap is not a regular file: ${blockmapPath}`)
      }

      // Validate compressed blockmap payload is valid non-empty gzip/deflate JSON
      validateBlockmapFile(blockmapPath)

      const bmContent = readFileSync(blockmapPath)
      immutableFilesMap.set(blockmapName, {
        sha512: computeSha512Base64(bmContent),
        size: bmContent.length,
        isBlockmap: true,
      })
    }
  }

  // Guard against stray different-version binaries in output directory
  const dirContents = readdirSync(dir)
  for (const item of dirContents) {
    const lower = item.toLowerCase()
    if (lower.endsWith('.zip') || lower.endsWith('.dmg') || lower.endsWith('.exe') || lower.endsWith('.blockmap')) {
      if (!immutableFilesMap.has(item)) {
        throw new Error(`Stray release file detected in directory: '${item}'. Directory must strictly contain target version ${version} artifacts.`)
      }
    }
  }

  // Enforce upload ordering: Windows exe/blockmap first, macOS zip/dmg/blockmaps next, manifests last
  const immutableFiles = Array.from(immutableFilesMap.keys()).sort((a, b) => {
    const aIsWin = a.includes('win-x64') || a.includes('Trace-Setup')
    const bIsWin = b.includes('win-x64') || b.includes('Trace-Setup')
    if (aIsWin && !bIsWin) return -1
    if (!aIsWin && bIsWin) return 1
    return a.localeCompare(b)
  })

  const manifestFiles = ['latest.yml', 'latest-mac.yml']

  return {
    version,
    immutableFiles,
    manifestFiles,
    immutableFilesMap,
    dir,
  }
}

// =========================================================================
// Preflight & Upload Execution Engine
// =========================================================================

/**
 * Default remote preflight checker using HTTPS HEAD and GET against TRACE_UPDATE_URL
 */
async function defaultReadRemote(baseUrl, filename) {
  const url = `${baseUrl}/${filename}`
  let headRes
  try {
    headRes = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    throw new Error(`Network failure during preflight probe of '${filename}'.`)
  }

  if (headRes.status === 404) {
    return { status: 404 }
  }

  if (headRes.status === 200) {
    let getRes
    try {
      getRes = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000) })
    } catch {
      throw new Error(`Failed to download existing remote artifact '${filename}' for verification.`)
    }

    if (getRes.status !== 200) {
      throw new Error(`Unexpected response when verifying existing remote artifact '${filename}' (status ${getRes.status}).`)
    }

    const buf = Buffer.from(await getRes.arrayBuffer())
    return {
      status: 200,
      sha512: computeSha512Base64(buf),
      size: buf.length,
    }
  }

  // Fail closed on any other status (401, 403, 500, 503) without leaking raw remote messages
  throw new Error(`Remote preflight failed for '${filename}' with unexpected HTTP status ${headRes.status}.`)
}

/**
 * Default wrangler R2 upload execution
 */
function defaultUpload(bucket, filename, filePath) {
  console.log(`[publish-desktop-updates] Uploading: ${filename} -> r2://${bucket}/${filename}`)
  const result = spawnSync(
    'pnpm',
    [
      '--filter', '@workflow-skill/web',
      'exec', 'wrangler', 'r2', 'object', 'put',
      `${bucket}/${filename}`,
      '--file', filePath,
      '--remote',
    ],
    {
      cwd: rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  )

  if (result.status !== 0) {
    // Fail closed without leaking command or credentials
    throw new Error(`Upload failed for '${filename}'. Check R2 permissions and network.`)
  }
}

/**
 * Core publishing workflow orchestrator
 */
export async function publishDesktopUpdates(options, dependencies = {}) {
  const plan = verifyReleaseDirectory(options)
  const isPublish = Boolean(options.publish)

  const readRemote = dependencies.readRemote || (async (f) => defaultReadRemote(validateUpdateUrl(process.env.TRACE_UPDATE_URL), f))
  const upload = dependencies.upload || defaultUpload

  console.log(`[publish-desktop-updates] Verified release version: ${plan.version}`)
  console.log(`[publish-desktop-updates] Immutable artifacts count: ${plan.immutableFiles.length}`)

  if (!isPublish) {
    console.log('[DRY-RUN] Release directory verified. Zero files uploaded. Pass --publish to execute.')
    return { success: true, dryRun: true, plan }
  }

  const bucket = options.bucket || process.env.TRACE_UPDATE_BUCKET
  if (!bucket) {
    throw new Error('Missing R2 bucket. Provide --bucket or TRACE_UPDATE_BUCKET environment variable.')
  }

  // Phase 1: Preflight ALL immutable artifacts BEFORE any upload
  console.log('\nPhase 1: Preflighting all immutable artifacts against remote origin...')
  const filesToUpload = []

  for (const filename of plan.immutableFiles) {
    const localInfo = plan.immutableFilesMap.get(filename)
    const remote = await readRemote(filename)

    if (remote.status === 404) {
      filesToUpload.push(filename)
    } else if (remote.status === 200) {
      if (remote.sha512 === localInfo.sha512) {
        console.log(`  - [SKIP] '${filename}' already uploaded with identical SHA-512 (resumable retry).`)
      } else {
        throw new Error(`Immutability violation: Remote artifact '${filename}' already exists with differing SHA-512 content. Release versions are strictly immutable.`)
      }
    } else {
      throw new Error(`Remote preflight check failed closed for '${filename}'.`)
    }
  }

  console.log(`Preflight complete: ${filesToUpload.length} artifacts to upload, ${plan.immutableFiles.length - filesToUpload.length} skipped.`)

  // Phase 2: Upload immutable artifacts sequentially
  console.log('\nPhase 2: Uploading immutable artifacts...')
  for (const filename of filesToUpload) {
    const localPath = path.join(plan.dir, filename)
    await upload(bucket, filename, localPath)
  }

  // Phase 3: Upload manifests last
  console.log('\nPhase 3: Uploading platform manifests...')
  for (const manifestName of plan.manifestFiles) {
    const localPath = path.join(plan.dir, manifestName)
    await upload(bucket, manifestName, localPath)
  }

  console.log(`\n[PUBLISH SUCCESS] Release ${plan.version} successfully published to r2://${bucket}.`)
  return { success: true, dryRun: false, plan }
}

// =========================================================================
// CLI Runner
// =========================================================================

async function runCli() {
  const args = process.argv.slice(2)
  const getArg = (name, fallback) => {
    const idx = args.indexOf(name)
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
    return fallback
  }

  const isPublish = args.includes('--publish')
  const dir = getArg('--dir', path.join(rootDir, 'dist', 'desktop'))
  const version = getArg('--version', undefined)
  const bucket = getArg('--bucket', process.env.TRACE_UPDATE_BUCKET)

  console.log('=== Trace Desktop Updates Publisher (OPC-53) ===')
  console.log(`Mode: ${isPublish ? 'REAL PUBLISH (--publish)' : 'DRY-RUN (default)'}`)
  console.log(`Directory: ${dir}`)

  try {
    await publishDesktopUpdates({
      dir,
      version,
      publish: isPublish,
      bucket,
    })
  } catch (err) {
    console.error(`\n[PUBLISH FAILED]: ${err.message}`)
    process.exit(1)
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  runCli().catch((err) => {
    console.error(`Fatal: ${err.message}`)
    process.exit(1)
  })
}
