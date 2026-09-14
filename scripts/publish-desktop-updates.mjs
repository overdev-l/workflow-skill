#!/usr/bin/env node
/**
 * Trace Desktop Updates Publishing Script
 *
 * Publishes release artifacts to GitHub Releases using GitHub CLI (`gh`):
 * - Verifies dual platform manifests (latest-mac.yml and latest.yml)
 * - Requires exact stable semver (major.minor.patch) matching --version or GITHUB_REF tag
 * - Enforces exact safe filenames: Trace-${version}-mac-arm64.zip/dmg and Trace-${version}-win-x64.exe
 * - Rejects path traversal, url encoding, duplicate entries, and symlinks
 * - Validates required sha512 and positive integer size on every manifest file entry
 * - Validates compressed blockmaps (.zip.blockmap, .exe.blockmap) by decompressing gzip/deflate JSON
 *
 * SECURITY & GOVERNANCE:
 * - Source repository is strictly PRIVATE; releases are published to a separate CI/release repo.
 * - Release notes are user-facing generic notes; no private commit logs or source metadata are leaked.
 * - Code signing & signature enforcement is the responsibility of the supervisor CI pipeline before invoking this script.
 * - Stable publishing publishes full platform manifests and sets latest=true, requiring explicit caller authorization.
 * - Preview publishing creates unsigned pre-releases (prerelease=true, latest=false, preview-vX.Y.Z tag)
 *   and strictly NEVER uploads platform manifests (latest*.yml), only binaries, blockmaps, and checksums.
 * - Draft release remains hidden until all remote assets are uploaded and their names & sizes verified.
 * - Public releases are immutable: re-running against a published release verifies existing assets or rejects safely; NEVER --clobber.
 * - Resumable draft uploads: existing draft assets are verified via hash/digest; collisions reject.
 * - Fail closed on auth, network, or unknown errors; never leaks stdout/stderr credentials or tokens.
 *
 * Usage:
 *   node scripts/publish-desktop-updates.mjs [--dir <dist/desktop>] [--version <0.1.0>] [--publish] [--repository <owner/name>] [--preview]
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
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
export const REPOSITORY_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

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

export function computeSha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Validates target GitHub repository in strict owner/name format.
 */
export function validateRepository(repo) {
  if (!repo || typeof repo !== 'string') {
    throw new Error('Repository is required and must be in owner/name format.')
  }
  const trimmed = repo.trim()
  if (!REPOSITORY_REGEX.test(trimmed)) {
    throw new Error(`Invalid repository format: '${repo}'. Expected 'owner/name'.`)
  }
  return trimmed
}

/**
 * Generates user-facing generic release notes without private source commits or logs.
 */
export function generateGenericReleaseNotes({ version, tag, preview }) {
  if (preview) {
    return [
      `# Trace Desktop Preview v${version}`,
      '',
      'Automated preview build of Trace Desktop.',
      '',
      `- Version: ${version}`,
      `- Tag: ${tag}`,
      '- Pre-release: true',
      '- Note: Unsigned build for preview testing and verification.',
    ].join('\n')
  }

  return [
    `# Trace Desktop v${version}`,
    '',
    'Official production release of Trace Desktop.',
    '',
    `- Version: ${version}`,
    `- Tag: ${tag}`,
    '- Platforms: macOS (arm64), Windows (x64)',
  ].join('\n')
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
export function verifyReleaseDirectory(options = {}) {
  const dir = path.resolve(options.dir)
  if (!existsSync(dir)) {
    throw new Error(`Release directory does not exist: ${dir}`)
  }

  if (options.publish && !options.version && !options.expectedVersion && !/^refs\/tags\/v/.test(process.env.GITHUB_REF ?? '')) {
    throw new Error('Publishing requires explicit --version or expectedVersion.')
  }

  // Determine expected target version
  let expectedVersion = (options.expectedVersion || options.version) ? normalizeVersion(options.expectedVersion || options.version) : undefined
  if (!expectedVersion && process.env.GITHUB_REF) {
    if (process.env.GITHUB_REF.startsWith('refs/tags/v')) {
      expectedVersion = normalizeVersion(process.env.GITHUB_REF.slice('refs/tags/v'.length))
    } else if (process.env.GITHUB_REF.startsWith('refs/tags/preview-v')) {
      expectedVersion = normalizeVersion(process.env.GITHUB_REF.slice('refs/tags/preview-v'.length))
    }
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
  if (process.env.GITHUB_REF) {
    if (process.env.GITHUB_REF.startsWith('refs/tags/v')) {
      const tagVersion = normalizeVersion(process.env.GITHUB_REF.slice('refs/tags/v'.length))
      if (expectedVersion && tagVersion !== expectedVersion) {
        throw new Error(`GITHUB_REF tag version '${tagVersion}' does not match target version '${expectedVersion}'.`)
      }
    } else if (process.env.GITHUB_REF.startsWith('refs/tags/preview-v')) {
      const tagVersion = normalizeVersion(process.env.GITHUB_REF.slice('refs/tags/preview-v'.length))
      if (expectedVersion && tagVersion !== expectedVersion) {
        throw new Error(`GITHUB_REF tag version '${tagVersion}' does not match target version '${expectedVersion}'.`)
      }
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
    if (!lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink()) {
      throw new Error('Manifest must be a regular file, not a symlink.')
    }
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
  const immutableFilesMap = new Map()

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
// GitHub CLI Interaction & Error Handling Helpers
// =========================================================================

/**
 * Checks if a gh command result represents an explicit 404 (Not Found).
 */
export function isGhNotFound(result) {
  if (!result || result.status === 0) {
    return false
  }
  if (result.notFound === true || result.status === 404) {
    return true
  }
  const stderr = String(result.stderr || '')
  const stdout = String(result.stdout || '')
  const combined = `${stderr}\n${stdout}`

  // If auth, network, or permission errors are indicated, it is NOT not-found
  if (/401|403|bad credentials|unauthorized|forbidden|authentication|permission|rate limit|saml|timeout|network|could not resolve host|econnrefused/i.test(combined)) {
    return false
  }

  // Explicit 404 / Not Found detection
  if (/HTTP 404|release not found|Not Found/i.test(combined)) {
    return true
  }

  return false
}

/**
 * Checks if a gh command result represents an auth, permission, or network failure.
 */
export function isGhAuthOrNetworkError(result) {
  if (!result || result.status === 0) {
    return false
  }
  if (result.status === 401 || result.status === 403) {
    return true
  }
  const combined = `${String(result.stderr || '')}\n${String(result.stdout || '')}`
  return /401|403|bad credentials|unauthorized|forbidden|authentication|permission|rate limit|saml|timeout|network|could not resolve host|econnrefused/i.test(combined)
}

function defaultExecGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    cwd: options.cwd || rootDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: options.env || process.env,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  }
}

// =========================================================================
// Core Publishing Workflow Orchestrator
// =========================================================================

/**
 * Core publishing workflow orchestrator for GitHub Releases.
 *
 * @param {Object} options
 * @param {string} options.dir - Release directory containing built artifacts and manifests
 * @param {string} [options.version] - Explicit target version (e.g. '1.0.0')
 * @param {string} [options.expectedVersion] - Alternative explicit expected version
 * @param {boolean} [options.publish=false] - True to execute real publishing; defaults to dry-run
 * @param {string} [options.repository] - GitHub target repository ('owner/name')
 * @param {boolean} [options.preview=false] - True for unsigned preview release (prerelease=true, latest=false, no manifests)
 * @param {string} [options.tagSuffix] - Optional immutable suffix for preview tag
 * @param {Object} [dependencies={}] - Injected dependencies for testing (gh CLI interaction)
 */
export async function publishDesktopUpdates(options = {}, dependencies = {}) {
  const isPublish = Boolean(options.publish)
  const isPreview = Boolean(options.preview)

  // Step 1: Validate all local files before any network call or mutation
  const plan = verifyReleaseDirectory(options)

  if (isPublish && !options.version && !options.expectedVersion) {
    throw new Error('Publishing requires explicit --version or expectedVersion.')
  }

  const rawRepo = options.repository || (isPublish ? process.env.GITHUB_REPOSITORY : undefined)
  if (options.repository) {
    validateRepository(options.repository)
  }
  if (isPublish && !rawRepo) {
    throw new Error('Repository is required for publishing. Provide --repository <owner/name> or GITHUB_REPOSITORY.')
  }
  const repository = rawRepo ? validateRepository(rawRepo) : undefined

  if (options.tagSuffix && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(options.tagSuffix)) throw new Error('Invalid preview tag suffix.')
  const tag = isPreview
    ? `preview-v${plan.version}${options.tagSuffix ? `-${options.tagSuffix}` : ''}`
    : `v${plan.version}`

  console.log(`[publish-desktop-updates] Target tag: ${tag}`)
  console.log(`[publish-desktop-updates] Mode: ${isPublish ? (isPreview ? 'PREVIEW PUBLISH' : 'STABLE PUBLISH') : 'DRY-RUN'}`)
  if (repository) {
    console.log(`[publish-desktop-updates] Target repository: ${repository}`)
  }

  // Dry-run mode: strictly zero file writes and zero gh command calls
  if (!isPublish) {
    console.log('[DRY-RUN] Release directory verified. Zero files uploaded. Pass --publish to execute.')
    return {
      success: true,
      dryRun: true,
      plan,
      tag,
      repository,
      preview: isPreview,
    }
  }

  const execGh = dependencies.gh || dependencies.execGh || defaultExecGh

  // Step 2: Inspect remote release by gh release view
  console.log(`\nPhase 1: Inspecting release '${tag}' in repository '${repository}'...`)
  const viewArgs = ['release', 'view', tag, '--repo', repository, '--json', 'id,isDraft,isPrerelease,assets,tagName']
  let viewRes
  try {
    viewRes = await execGh(viewArgs, { cwd: rootDir, env: process.env })
  } catch {
    throw new Error('Failed to execute GitHub CLI command.')
  }

  let existingRelease = null
  if (viewRes.status === 0) {
    try {
      existingRelease = typeof viewRes.stdout === 'object' ? viewRes.stdout : JSON.parse(viewRes.stdout)
    } catch {
      throw new Error('Failed to parse GitHub release details.')
    }
  } else if (isGhNotFound(viewRes)) {
    existingRelease = null
  } else if (isGhAuthOrNetworkError(viewRes)) {
    throw new Error('GitHub CLI authentication or network failure. Fail closed.')
  } else {
    throw new Error('GitHub CLI release view failed closed.')
  }

  // Step 3: Build local expected files map & sha512 checksum file
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'trace-release-'))
  try {
    const expectedFilesMap = new Map()

    for (const filename of plan.immutableFiles) {
      const localPath = path.join(plan.dir, filename)
      const buf = readFileSync(localPath)
      expectedFilesMap.set(filename, {
        filePath: localPath,
        size: buf.length,
        sha512: computeSha512Base64(buf),
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        isManifest: false,
      })
    }

    // Generate sha512 checksum file
    const checksumLines = plan.immutableFiles.map((fn) => {
      const item = expectedFilesMap.get(fn)
      return `${Buffer.from(item.sha512, 'base64').toString('hex')}  ${fn}`
    }).join('\n') + '\n'
    const checksumBuf = Buffer.from(checksumLines, 'utf8')
    const checksumPath = path.join(tempDir, 'checksums-sha512.txt')
    writeFileSync(checksumPath, checksumBuf)
    expectedFilesMap.set('checksums-sha512.txt', {
      filePath: checksumPath,
      size: checksumBuf.length,
      sha512: computeSha512Base64(checksumBuf),
      sha256: crypto.createHash('sha256').update(checksumBuf).digest('hex'),
      isManifest: false,
    })

    // For stable release, include manifests (preview NEVER uploads manifests)
    if (!isPreview) {
      for (const manifestName of plan.manifestFiles) {
        const localPath = path.join(plan.dir, manifestName)
        const buf = readFileSync(localPath)
        expectedFilesMap.set(manifestName, {
          filePath: localPath,
          size: buf.length,
          sha512: computeSha512Base64(buf),
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          isManifest: true,
        })
      }
    }

    if (existingRelease) {
      if (existingRelease.tagName !== tag || existingRelease.isPrerelease !== isPreview) throw new Error('Existing release tag/channel differs from requested release.')
      for (const asset of existingRelease.assets || []) {
        if (!expectedFilesMap.has(asset.name)) throw new Error('Release contains an unexpected asset; review the draft manually.')
      }
    }

    // Step 4: Immutability guard for already published (public) releases
    if (existingRelease && !existingRelease.isDraft) {
      console.log(`Release '${tag}' is already published. Checking immutability guard...`)
      const remoteAssets = Array.isArray(existingRelease.assets) ? existingRelease.assets : []

      for (const [filename, info] of expectedFilesMap.entries()) {
        const remoteAsset = remoteAssets.find((a) => a.name === filename)
        if (!remoteAsset) {
          throw new Error(`Immutability violation: Published release '${tag}' is missing required asset '${filename}'. Never clobber published releases.`)
        }
        if (remoteAsset.size !== info.size) {
          throw new Error(`Immutability violation: Published release '${tag}' asset '${filename}' size (${remoteAsset.size}) does not match local (${info.size}).`)
        }
        if (!remoteAsset.digest) throw new Error('Published asset has no verifiable digest; refusing to mark it verified.')
        if (remoteAsset.digest) {
          const norm = remoteAsset.digest.replace(/^sha256:/i, '').toLowerCase()
          if (norm !== info.sha256.toLowerCase()) {
            throw new Error(`Immutability violation: Published release '${tag}' asset '${filename}' digest differs.`)
          }
        }
      }

      console.log(`[publish-desktop-updates] Verified intact existing public release: ${tag}`)
      return {
        success: true,
        dryRun: false,
        verifiedExisting: true,
        plan,
        tag,
        repository,
        version: plan.version,
        preview: isPreview,
      }
    }

    // Step 5: Handle existing draft (resumable / collision check) or create new draft
    const verifiedInDraft = new Set()
    if (existingRelease && existingRelease.isDraft) {
      console.log(`Existing draft release found for '${tag}'. Checking existing assets for resume / collision...`)
      const remoteAssets = Array.isArray(existingRelease.assets) ? existingRelease.assets : []

      for (const remoteAsset of remoteAssets) {
        const name = remoteAsset.name
        if (!expectedFilesMap.has(name)) {
          throw new Error(`Collision detected: Existing draft contains unknown or unexpected asset '${name}'.`)
        }
        const localInfo = expectedFilesMap.get(name)
        if (remoteAsset.size !== localInfo.size) {
          throw new Error(`Collision detected: Existing draft asset '${name}' size (${remoteAsset.size}) does not match local (${localInfo.size}).`)
        }

        if (remoteAsset.digest) {
          const norm = remoteAsset.digest.replace(/^sha256:/i, '').toLowerCase()
          if (norm !== localInfo.sha256.toLowerCase()) {
            throw new Error(`Collision detected: Existing draft asset '${name}' SHA-256 digest differs from local.`)
          }
        } else if (remoteAsset.sha256) {
          if (remoteAsset.sha256.toLowerCase() !== localInfo.sha256.toLowerCase()) {
            throw new Error(`Collision detected: Existing draft asset '${name}' SHA-256 digest differs from local.`)
          }
        } else if (remoteAsset.sha512) {
          if (remoteAsset.sha512 !== localInfo.sha512) {
            throw new Error(`Collision detected: Existing draft asset '${name}' SHA-512 digest differs from local.`)
          }
        } else {
          // Download and verify hash via temp file
          const dlDir = mkdtempSync(path.join(tempDir, 'dl-'))
          const dlRes = await execGh([
            'release', 'download', tag,
            '--repo', repository,
            '--pattern', name,
            '--dir', dlDir,
          ], { cwd: rootDir, env: process.env })
          if (dlRes.status !== 0) {
            throw new Error(`Failed to download draft asset '${name}' for verification.`)
          }
          const dlPath = path.join(dlDir, name)
          if (!existsSync(dlPath)) {
            throw new Error(`Downloaded draft asset '${name}' missing.`)
          }
          const dlBuf = readFileSync(dlPath)
          const dlSha512 = computeSha512Base64(dlBuf)
          if (dlSha512 !== localInfo.sha512) {
            throw new Error(`Collision detected: Downloaded draft asset '${name}' hash differs from local.`)
          }
        }

        verifiedInDraft.add(name)
        console.log(`  - [SKIP] '${name}' already uploaded with verified digest (resumable draft).`)
      }
    } else {
      // Create new draft release (hidden until all assets validated)
      console.log(`Creating new draft release '${tag}'...`)
      const notesContent = generateGenericReleaseNotes({
        version: plan.version,
        tag,
        preview: isPreview,
      })
      const notesPath = path.join(tempDir, 'release-notes.md')
      writeFileSync(notesPath, notesContent, 'utf8')

      const createArgs = [
        'release', 'create', tag,
        '--repo', repository,
        '--draft',
        '--title', isPreview ? `Trace Desktop Preview v${plan.version}` : `Trace Desktop v${plan.version}`,
        '--notes-file', notesPath,
      ]
      if (isPreview) {
        createArgs.push('--prerelease')
      }

      const createRes = await execGh(createArgs, { cwd: rootDir, env: process.env })
      if (createRes.status !== 0) {
        if (isGhAuthOrNetworkError(createRes)) {
          throw new Error('GitHub CLI authentication or network error during draft creation.')
        }
        throw new Error('Failed to create draft release on GitHub.')
      }
    }

    // Step 6: Upload assets in strict order:
    // 1. Binaries/blockmaps
    // 2. Checksum file
    // 3. Platform manifests strictly last for stable (never for preview)
    const filesToUpload = []

    for (const filename of plan.immutableFiles) {
      if (!verifiedInDraft.has(filename)) {
        filesToUpload.push({ filename, filePath: expectedFilesMap.get(filename).filePath })
      }
    }

    if (!verifiedInDraft.has('checksums-sha512.txt')) {
      filesToUpload.push({ filename: 'checksums-sha512.txt', filePath: expectedFilesMap.get('checksums-sha512.txt').filePath })
    }

    if (!isPreview) {
      for (const manifest of plan.manifestFiles) {
        if (!verifiedInDraft.has(manifest)) {
          filesToUpload.push({ filename: manifest, filePath: expectedFilesMap.get(manifest).filePath })
        }
      }
    }

    console.log(`Uploading ${filesToUpload.length} remaining assets to draft release...`)
    for (const item of filesToUpload) {
      console.log(`  - Uploading: ${item.filename}`)
      const uploadArgs = ['release', 'upload', tag, item.filePath, '--repo', repository]
      const uploadRes = await execGh(uploadArgs, { cwd: rootDir, env: process.env })
      if (uploadRes.status !== 0) {
        if (isGhAuthOrNetworkError(uploadRes)) {
          throw new Error(`GitHub CLI authentication or network error during upload of '${item.filename}'.`)
        }
        throw new Error(`Failed to upload asset '${item.filename}' to GitHub release.`)
      }
    }

    // Step 7: Verify all remote assets names & sizes before publishing draft
    console.log('\nPhase 6: Verifying all remote assets on draft before publishing...')
    let postViewRes
    try {
      postViewRes = await execGh(viewArgs, { cwd: rootDir, env: process.env })
    } catch {
      throw new Error('Failed to inspect draft release after upload.')
    }

    if (postViewRes.status !== 0) {
      throw new Error('Failed to inspect draft release after upload.')
    }

    let postRelease
    try {
      postRelease = typeof postViewRes.stdout === 'object' ? postViewRes.stdout : JSON.parse(postViewRes.stdout)
    } catch {
      throw new Error('Failed to parse release details after upload.')
    }

    const postAssets = Array.isArray(postRelease.assets) ? postRelease.assets : []
    if (postRelease.isDraft !== true || postRelease.tagName !== tag) throw new Error('Draft release state changed during upload.')
    if (postAssets.some(asset => !expectedFilesMap.has(asset.name))) throw new Error('Draft contains unexpected assets.')
    for (const [filename, info] of expectedFilesMap.entries()) {
      const match = postAssets.find((a) => a.name === filename)
      if (!match) {
        throw new Error(`Remote asset verification failed: Asset '${filename}' is missing from release.`)
      }
      if (match.size !== info.size) {
        throw new Error(`Remote asset verification failed: Asset '${filename}' size (${match.size}) does not match expected size (${info.size}).`)
      }
    }

    // Step 8: Publish draft release
    console.log(`Publishing release '${tag}' (draft=false, prerelease=${isPreview}, latest=${!isPreview})...`)
    const editArgs = [
      'release', 'edit', tag,
      '--repo', repository,
      '--draft=false',
      `--prerelease=${isPreview ? 'true' : 'false'}`,
      `--latest=${isPreview ? 'false' : 'true'}`,
    ]
    const editRes = await execGh(editArgs, { cwd: rootDir, env: process.env })
    if (editRes.status !== 0) {
      if (isGhAuthOrNetworkError(editRes)) {
        throw new Error('GitHub CLI authentication or network error while publishing draft release.')
      }
      throw new Error('Failed to publish draft release on GitHub.')
    }

    console.log(`\n[PUBLISH SUCCESS] Release '${tag}' successfully published to GitHub repository '${repository}'.`)
    return {
      success: true,
      dryRun: false,
      tag,
      repository,
      version: plan.version,
      preview: isPreview,
      plan,
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignored
    }
  }
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
  const isPreview = args.includes('--preview')
  const dir = getArg('--dir', path.join(rootDir, 'dist', 'desktop'))
  const version = getArg('--version', undefined)
  const repository = getArg('--repository', process.env.GITHUB_REPOSITORY)
  const tagSuffix = getArg('--tag-suffix', undefined)

  console.log('=== Trace Desktop Updates Publisher ===')
  console.log(`Mode: ${isPublish ? (isPreview ? 'PREVIEW PUBLISH (--preview)' : 'STABLE PUBLISH (--publish)') : 'DRY-RUN (default)'}`)
  console.log(`Directory: ${dir}`)
  if (repository) {
    console.log(`Repository: ${repository}`)
  }

  try {
    await publishDesktopUpdates({
      dir,
      version,
      publish: isPublish,
      preview: isPreview,
      repository,
      tagSuffix,
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
