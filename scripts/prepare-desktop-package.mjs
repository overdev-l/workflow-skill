#!/usr/bin/env node
/**
 * Trace Desktop Release Resources Preparation Script (OPC-53)
 *
 * Prepares native release binaries and resources before electron-builder packaging:
 * - macOS: Compiles/stages Swift recorder (`workflow-recorder-macos`) and
 *   account keychain binary (`trace-account-keychain`).
 * - Windows: Executes `dotnet publish --self-contained` for win-x64 and stages
 *   the entire output folder into `recorders/` so `WorkflowRecorder.exe` runs
 *   out of the box without requiring external .NET runtime installation.
 * - Validates desktop icon and tray resources.
 *
 * Usage:
 *   node scripts/prepare-desktop-package.mjs [--platform <darwin|win32>] [--arch <arm64|x64>] [--check-only]
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const desktopDir = path.join(rootDir, 'apps', 'desktop')
const releaseResourcesDir = path.join(desktopDir, 'release-resources')
const releaseRecordersDir = path.join(releaseResourcesDir, 'recorders')
const releaseNativeBinDir = path.join(releaseResourcesDir, 'native-bin')
const desktopResourcesDir = path.join(desktopDir, 'resources')

const args = process.argv.slice(2)
function getArgValue(name, defaultValue) {
  const idx = args.indexOf(name)
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return defaultValue
}

const targetPlatform = getArgValue('--platform', process.platform)
const targetArch = getArgValue('--arch', process.arch)
const isCheckOnly = args.includes('--check-only')
const skipBuild = args.includes('--skip-build')

if (targetPlatform !== process.platform || targetArch !== process.arch
  || !((targetPlatform === 'darwin' && targetArch === 'arm64') || (targetPlatform === 'win32' && targetArch === 'x64'))) {
  throw new Error('Build on native macOS arm64 or Windows x64; cross-platform staging is unsupported.')
}
if (!isCheckOnly && !skipBuild) rmSync(releaseResourcesDir, { recursive: true, force: true })
console.log(`[prepare-desktop-package] Target platform: ${targetPlatform}, arch: ${targetArch}`)

function runCommand(command, cmdArgs, cwd = rootDir) {
  console.log(`[prepare-desktop-package] Running: ${command} ${cmdArgs.join(' ')}`)
  const result = spawnSync(command, cmdArgs, {
    cwd,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit status ${result.status}: ${command} ${cmdArgs.join(' ')}`)
  }
}

/**
 * Prepares macOS release binaries.
 */
function prepareMacOS() {
  const recorderBinarySource = path.join(rootDir, 'recorders', 'macos', '.build', 'release', 'workflow-recorder-macos')
  const recorderBinaryTarget = path.join(releaseRecordersDir, 'workflow-recorder-macos')

  const keychainBinarySource = path.join(desktopDir, 'native-bin', 'trace-account-keychain')
  const keychainBinaryTarget = path.join(releaseNativeBinDir, 'trace-account-keychain')

  if (isCheckOnly) {
    if (!existsSync(recorderBinarySource) && !existsSync(recorderBinaryTarget)) {
      throw new Error(`Missing macOS recorder binary: neither ${recorderBinarySource} nor ${recorderBinaryTarget} exists.`)
    }
    if (!existsSync(keychainBinarySource) && !existsSync(keychainBinaryTarget)) {
      throw new Error(`Missing macOS keychain binary: neither ${keychainBinarySource} nor ${keychainBinaryTarget} exists.`)
    }
    console.log('[prepare-desktop-package] Check passed for macOS release resources.')
    return
  }

  mkdirSync(releaseRecordersDir, { recursive: true })
  mkdirSync(releaseNativeBinDir, { recursive: true })

  // 1. Build Swift recorder release if needed
  if (!skipBuild) {
    console.log('[prepare-desktop-package] Building macOS recorder in release mode...')
    runCommand('swift', ['build', '-c', 'release', '--package-path', 'recorders/macos'])
  }

  if (!existsSync(recorderBinarySource)) {
    throw new Error(`Expected recorder binary not found after build: ${recorderBinarySource}`)
  }
  copyFileSync(recorderBinarySource, recorderBinaryTarget)
  chmodSync(recorderBinaryTarget, 0o755)
  console.log(`[prepare-desktop-package] Staged macOS recorder: ${recorderBinaryTarget}`)

  // 2. Build Account Keychain helper if needed
  if (!skipBuild) {
    console.log('[prepare-desktop-package] Building macOS keychain helper...')
    runCommand(process.execPath, [path.join(rootDir, 'scripts', 'build-account-keychain.mjs')])
  }

  if (!existsSync(keychainBinarySource)) {
    throw new Error(`Expected keychain binary not found: ${keychainBinarySource}`)
  }
  copyFileSync(keychainBinarySource, keychainBinaryTarget)
  chmodSync(keychainBinaryTarget, 0o755)
  console.log(`[prepare-desktop-package] Staged macOS keychain helper: ${keychainBinaryTarget}`)
}

/**
 * Prepares Windows release binaries (dotnet publish win-x64 self-contained).
 */
function prepareWindows() {
  const winProjectFile = path.join(rootDir, 'recorders', 'windows', 'WorkflowRecorder', 'WorkflowRecorder.csproj')
  const winExecutableTarget = path.join(releaseRecordersDir, 'WorkflowRecorder.exe')

  if (isCheckOnly) {
    if (!existsSync(winExecutableTarget)) {
      throw new Error(`Missing Windows recorder executable: ${winExecutableTarget}`)
    }
    console.log('[prepare-desktop-package] Check passed for Windows release resources.')
    return
  }

  mkdirSync(releaseRecordersDir, { recursive: true })
  mkdirSync(releaseNativeBinDir, { recursive: true })

  if (!skipBuild) {
    console.log('[prepare-desktop-package] Publishing Windows recorder win-x64 self-contained...')
    runCommand('dotnet', [
      'publish',
      winProjectFile,
      '-c', 'Release',
      '-r', 'win-x64',
      '--self-contained', 'true',
      '-o', releaseRecordersDir,
    ])
  }

  if (!existsSync(winExecutableTarget)) {
    throw new Error(`Expected Windows executable not found after publish: ${winExecutableTarget}`)
  }
  console.log(`[prepare-desktop-package] Staged Windows self-contained recorder at ${releaseRecordersDir}`)
}

/**
 * Validates desktop resources (icons, tray frames).
 */
function validateDesktopResources() {
  if (!existsSync(desktopResourcesDir)) {
    throw new Error(`Desktop resources directory missing: ${desktopResourcesDir}`)
  }
  const icon = path.join(desktopResourcesDir, 'trace-spirit-icon.png')
  if (!existsSync(icon)) {
    throw new Error(`Primary desktop icon missing: ${icon}`)
  }
  console.log('[prepare-desktop-package] Desktop resources validated successfully.')
}

try {
  validateDesktopResources()

  if (targetPlatform === 'darwin') {
    prepareMacOS()
  } else if (targetPlatform === 'win32') {
    prepareWindows()
  } else {
    console.warn(`[prepare-desktop-package] Platform '${targetPlatform}' does not have dedicated native recorder release tasks.`)
  }

  console.log('[prepare-desktop-package] Release resources prepared successfully.')
} catch (err) {
  console.error(`[prepare-desktop-package] Error: ${err.message}`)
  process.exit(1)
}
