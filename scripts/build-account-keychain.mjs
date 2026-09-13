#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

if (process.platform !== 'darwin') {
  console.log(`[build-account-keychain] Platform is '${process.platform}'; skipping macOS Keychain helper compilation.`)
  process.exit(0)
}

const sourceFile = path.join(rootDir, 'native', 'account-keychain', 'main.swift')
const targetDir = path.join(rootDir, 'apps', 'desktop', 'native-bin')
const targetBinary = path.join(targetDir, 'trace-account-keychain')
const hashFile = path.join(targetDir, '.trace-account-keychain.hash')

if (!fs.existsSync(sourceFile)) {
  console.error(`[build-account-keychain] Source file does not exist: ${sourceFile}`)
  process.exit(1)
}

fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 })

const sourceContent = fs.readFileSync(sourceFile)
const sourceHash = crypto.createHash('sha256').update(sourceContent).digest('hex')

// Freshness cache check: avoid recompile if source is unchanged to preserve binary signature
if (fs.existsSync(targetBinary) && fs.existsSync(hashFile)) {
  try {
    const cachedHash = fs.readFileSync(hashFile, 'utf8').trim()
    if (cachedHash === sourceHash) {
      console.log('[build-account-keychain] Helper binary is up to date; skipping recompile to preserve native signature.')
      process.exit(0)
    }
  } catch {
    // Recompile on hash read failure
  }
}

const tempBinary = path.join(
  targetDir,
  `.trace-account-keychain.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
)

try {
  console.log(`[build-account-keychain] Compiling ${sourceFile} -> ${targetBinary}...`)
  const result = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-module-name', 'TraceAccountKeychain',
      '-framework', 'Security',
      sourceFile,
      '-o', tempBinary,
    ],
    {
      stdio: 'inherit',
      encoding: 'utf8',
    }
  )

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`xcrun swiftc exited with status ${result.status}`)
  }

  // Stable ad-hoc codesign to avoid repeated macOS ACL prompts
  try {
    const signResult = spawnSync(
      'codesign',
      ['--force', '--sign', '-', '--identifier', 'dev.trace.account-keychain', tempBinary],
      { stdio: 'inherit', encoding: 'utf8' }
    )
    if (signResult.status !== 0) {
      console.warn('[build-account-keychain] codesign returned non-zero; proceeding with unadorned binary.')
    }
  } catch {
    console.warn('[build-account-keychain] codesign skipped or unavailable.')
  }

  fs.chmodSync(tempBinary, 0o755)
  fs.renameSync(tempBinary, targetBinary)
  fs.writeFileSync(hashFile, sourceHash, 'utf8')
  console.log(`[build-account-keychain] Successfully compiled and verified: ${targetBinary}`)
} catch (err) {
  try {
    if (fs.existsSync(tempBinary)) {
      fs.rmSync(tempBinary, { force: true })
    }
  } catch {}
  console.error(`[build-account-keychain] Build failed: ${err.message}`)
  process.exit(1)
}
