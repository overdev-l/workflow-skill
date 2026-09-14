import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  AccountError,
  sanitizeErrorMessage,
  type AccountActionResult,
} from '../../../packages/workflow-model/src/accounts.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_PS_ARGS = ['-axo', 'pid=,comm=']
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_EXEC_TIMEOUT_MS = 3000
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024

export interface AntigravityRuntimeDeps {
  getPsOutput?(): string
  getPsOutputAsync?(): Promise<string>
  quitApp?(bundlePath: string): Promise<void>
  openApp?(bundlePath: string): Promise<void>
  sleep?(ms: number): Promise<void>
  now?(): number
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

interface ResolvedDeps {
  getPsOutput(): string
  getPsOutputAsync(): Promise<string>
  quitApp(bundlePath: string): Promise<void>
  openApp(bundlePath: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
  timeoutMs: number
  pollIntervalMs: number
  signal?: AbortSignal
}

const defaultDeps: ResolvedDeps = {
  getPsOutput(): string {
    try {
      return execFileSync('/bin/ps', DEFAULT_PS_ARGS, {
        encoding: 'utf8',
        timeout: DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。')
    }
  },
  async getPsOutputAsync(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('/bin/ps', DEFAULT_PS_ARGS, {
        encoding: 'utf8',
        timeout: DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
      })
      return stdout
    } catch {
      throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。')
    }
  },
  async quitApp(bundlePath: string): Promise<void> {
    await execFileAsync('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'tell application (item 1 of argv) to quit',
      '-e', 'end run',
      bundlePath,
    ], {
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
    })
  },
  async openApp(bundlePath: string): Promise<void> {
    await execFileAsync('/usr/bin/open', [bundlePath], {
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
    })
  },
  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  },
  now(): number {
    return Date.now()
  },
  timeoutMs: DEFAULT_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  signal: undefined,
}

function resolveDeps(custom?: AntigravityRuntimeDeps): ResolvedDeps {
  if (!custom) return defaultDeps
  const now = custom.now ?? defaultDeps.now
  const sleep = custom.sleep ?? defaultDeps.sleep
  const timeoutMs = custom.timeoutMs ?? defaultDeps.timeoutMs
  const pollIntervalMs = custom.pollIntervalMs ?? defaultDeps.pollIntervalMs
  const signal = custom.signal

  const getPsOutput = custom.getPsOutput ?? defaultDeps.getPsOutput
  const getPsOutputAsync = custom.getPsOutputAsync ??
    (custom.getPsOutput ? async () => custom.getPsOutput!() : defaultDeps.getPsOutputAsync)
  const quitApp = custom.quitApp ?? defaultDeps.quitApp
  const openApp = custom.openApp ?? defaultDeps.openApp

  return {
    getPsOutput,
    getPsOutputAsync,
    quitApp,
    openApp,
    sleep,
    now,
    timeoutMs,
    pollIntervalMs,
    signal,
  }
}

interface SwitchLease {
  active: boolean
  deps?: AntigravityRuntimeDeps
}

const leaseStorage = new AsyncLocalStorage<SwitchLease>()

/** Inspect executable names only; command-line arguments may contain credentials. */
export function antigravityProcesses(output: string): string[] {
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^\d+\s+(.+)$/)
    if (!match) return []
    const executable = match[1]
    const name = path.basename(executable)
    return name === 'agy' || name === 'Antigravity' ||
      (name === 'language_server' && executable.includes('/Antigravity.app/Contents/Resources/bin/'))
      ? [name] : []
  })
}

export interface ParsedBundleInfo {
  bundlePath: string
  isGui: boolean
  isHelper: boolean
}

/**
 * Narrowed bundle detection for exact Antigravity.app on macOS:
 * - Must be an absolute, normalized path without traversal segments.
 * - Exact bundle basename must be Antigravity.app (no arbitrary Antigravity Other.app).
 * - Exact main GUI executable must be Contents/MacOS/Antigravity (no nested foo/Antigravity).
 * - Helpers must be located in recognized bundle subdirectories.
 */
export function parseAntigravityBundle(executable: string): ParsedBundleInfo | null {
  if (!executable || typeof executable !== 'string') return null
  if (!path.posix.isAbsolute(executable)) return null
  if (executable !== path.posix.normalize(executable)) return null
  if (executable.includes('/../') || executable.includes('/./')) return null

  const match = executable.match(/^(.+?\.app)(?:\/|$)/)
  if (!match) return null
  const bundlePath = match[1]
  if (path.posix.basename(bundlePath) !== 'Antigravity.app') return null

  const rel = executable.slice(bundlePath.length).replace(/^\/+/, '')
  if (rel === 'Contents/MacOS/Antigravity') {
    return { bundlePath, isGui: true, isHelper: false }
  }

  // Contents/MacOS only contains the main binary; reject nested or alternative binaries under Contents/MacOS/
  if (rel.startsWith('Contents/MacOS/')) {
    return null
  }

  // Helpers must reside inside recognized subdirectories of Antigravity.app (e.g. Contents/Resources/bin/, Contents/Frameworks/)
  if (
    rel.startsWith('Contents/Resources/') ||
    rel.startsWith('Contents/Frameworks/') ||
    (executable.startsWith(bundlePath + '/') && rel.length > 0)
  ) {
    return { bundlePath, isGui: false, isHelper: true }
  }

  return null
}

export interface AntigravityProcessInfo {
  pid: number
  executable: string
  bundlePath: string
}

export interface AntigravityScanResult {
  cliPids: number[]
  guiProcesses: AntigravityProcessInfo[]
  helperProcesses: AntigravityProcessInfo[]
  allProcesses: { pid: number; executable: string }[]
}

export function scanAntigravityProcesses(psOutput: string): AntigravityScanResult {
  const cliPids: number[] = []
  const guiProcesses: AntigravityProcessInfo[] = []
  const helperProcesses: AntigravityProcessInfo[] = []
  const allProcesses: { pid: number; executable: string }[] = []

  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = parseInt(match[1], 10)
    const executable = match[2].trim()
    allProcesses.push({ pid, executable })

    const name = path.basename(executable)
    if (name === 'agy') {
      cliPids.push(pid)
      continue
    }

    const bundleInfo = parseAntigravityBundle(executable)
    if (bundleInfo) {
      if (bundleInfo.isGui) {
        guiProcesses.push({ pid, executable, bundlePath: bundleInfo.bundlePath })
      } else if (bundleInfo.isHelper) {
        helperProcesses.push({ pid, executable, bundlePath: bundleInfo.bundlePath })
      }
    }
  }

  return { cliPids, guiProcesses, helperProcesses, allProcesses }
}

function checkAntigravityStopped(deps: ResolvedDeps, options: { ignoreCli: boolean }): void {
  let output: string
  try {
    output = deps.getPsOutput()
  } catch (err) {
    if (err instanceof AccountError) throw err
    throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。')
  }

  const { cliPids, guiProcesses, helperProcesses } = scanAntigravityProcesses(output)
  const legacyNames = antigravityProcesses(output)

  if (options.ignoreCli) {
    // Interactive guard: specific client remains-running message and retry instruction; CLI is ignored
    const hasGuiOrHelper = guiProcesses.length > 0 || helperProcesses.length > 0 ||
      legacyNames.some(name => name !== 'agy')
    if (hasGuiOrHelper) {
      throw new AccountError('Antigravity 客户端仍在运行，请先完全退出客户端后再重试切换账号；现有 agy CLI 会话无需退出。')
    }
  } else {
    // Strict guard: requires quitting both client and CLI for renewal/refresh
    const hasAny = cliPids.length > 0 || guiProcesses.length > 0 || helperProcesses.length > 0 ||
      legacyNames.length > 0
    if (hasAny) {
      throw new AccountError('请先退出 Antigravity 客户端并结束所有 agy CLI 会话，再切换或续期账号；新会话将使用所选账号。')
    }
  }
}

export function assertAntigravityStopped(deps?: AntigravityRuntimeDeps): void {
  const store = leaseStorage.getStore()
  const isInteractive = store?.active === true
  const effectiveDeps = resolveDeps(deps ?? store?.deps)
  checkAntigravityStopped(effectiveDeps, { ignoreCli: isInteractive })
}

export function assertAntigravityStoppedStrict(deps?: AntigravityRuntimeDeps): void {
  const store = leaseStorage.getStore()
  const effectiveDeps = resolveDeps(deps ?? store?.deps)
  checkAntigravityStopped(effectiveDeps, { ignoreCli: false })
}

let switchMutex: Promise<void> = Promise.resolve()

export async function withAntigravityAccountSwitch(
  operation: () => Promise<AccountActionResult>,
  customDeps?: AntigravityRuntimeDeps,
): Promise<AccountActionResult> {
  const prev = switchMutex
  let releaseLock: () => void = () => {}
  switchMutex = new Promise<void>(resolve => { releaseLock = resolve })

  try {
    await prev
  } catch {
    // Ignore previous failure in queue
  }

  try {
    return await executeInteractiveSwitch(operation, customDeps)
  } finally {
    releaseLock()
  }
}

async function restoreIfVerifiedGone(guiBundles: string[], deps: ResolvedDeps): Promise<boolean> {
  if (guiBundles.length === 0) return false
  let checkOutput: string
  try {
    checkOutput = await deps.getPsOutputAsync()
  } catch {
    // Poll scan failure means we cannot verify whether GUI is gone or still running.
    // Avoid launching if unknown.
    return false
  }

  const running = new Set(scanAntigravityProcesses(checkOutput).guiProcesses.map(p => p.bundlePath))
  let attempted = false
  for (const bundlePath of guiBundles) {
    if (running.has(bundlePath)) continue
    attempted = true
    try { await deps.openApp(bundlePath) } catch { /* Preserve the original operation failure. */ }
  }
  return attempted

}

async function executeInteractiveSwitch(
  operation: () => Promise<AccountActionResult>,
  customDeps?: AntigravityRuntimeDeps,
): Promise<AccountActionResult> {
  const deps = resolveDeps(customDeps)

  if (deps.signal?.aborted) {
    throw new AccountError('账号切换已取消，未修改账号。')
  }

  let initialOutput: string
  try {
    initialOutput = await deps.getPsOutputAsync()
  } catch (err) {
    if (err instanceof AccountError) throw err
    throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。')
  }

  const initialScan = scanAntigravityProcesses(initialOutput)
  const guiBundles = Array.from(new Set(initialScan.guiProcesses.map(p => p.bundlePath)))

  if (guiBundles.length > 0) {
    for (const bundlePath of guiBundles) {
      try {
        await deps.quitApp(bundlePath)
      } catch (err) {
        await restoreIfVerifiedGone(guiBundles, deps)
        if (err instanceof AccountError) throw err
        throw new AccountError('退出 Antigravity 客户端失败或已取消，未修改账号。请在客户端完全退出后重试。')
      }
    }
  }

  const startTime = deps.now()
  while (true) {
    if (deps.signal?.aborted) {
      await restoreIfVerifiedGone(guiBundles, deps)
      throw new AccountError('账号切换已取消，未修改账号。')
    }

    let pollOutput: string
    try {
      pollOutput = await deps.getPsOutputAsync()
    } catch (err) {
      const restored = await restoreIfVerifiedGone(guiBundles, deps)
      if (restored) {
        throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。已尝试重新打开客户端。')
      }
      throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。如果客户端已退出，请手动重新打开。')
    }

    const pollScan = scanAntigravityProcesses(pollOutput)
    const hasGuiOrHelper = pollScan.guiProcesses.length > 0 || pollScan.helperProcesses.length > 0

    if (!hasGuiOrHelper) {
      break
    }

    if (deps.now() - startTime >= deps.timeoutMs) {
      await restoreIfVerifiedGone(guiBundles, deps)
      if (guiBundles.length > 0) {
        throw new AccountError('等待 Antigravity 客户端退出超时，未修改账号。请在客户端完全退出后重试。')
      } else {
        throw new AccountError('Antigravity 后台辅助进程仍在运行，等待退出超时，未修改账号。请在进程退出后重试。')
      }
    }

    await deps.sleep(deps.pollIntervalMs)
  }

  const lease: SwitchLease = { active: true, deps: customDeps }
  let didThrow = false
  let thrownValue: unknown = undefined
  let opResult: AccountActionResult | undefined

  try {
    opResult = await leaseStorage.run(lease, async () => {
      return await operation()
    })
  } catch (err) {
    didThrow = true
    thrownValue = err
  } finally {
    lease.active = false
  }

  let restartWarning: string | undefined
  if (guiBundles.length > 0) {
    for (const bundlePath of guiBundles) {
      try {
        await deps.openApp(bundlePath)
      } catch {
        restartWarning = 'Antigravity 账号已切换，但重新启动客户端失败，请手动打开。'
      }
    }
  }

  if (didThrow) {
    if (thrownValue instanceof AccountError) throw thrownValue
    if (thrownValue instanceof Error) throw new AccountError(sanitizeErrorMessage(thrownValue))
    throw new AccountError('账号切换操作异常中止，未完成切换。')
  }

  if (!opResult || typeof opResult !== 'object' || typeof opResult.success !== 'boolean') {
    throw new AccountError('账号切换操作返回了无效的结果。')
  }

  if (opResult.success && restartWarning) {
    return {
      ...opResult,
      warning: restartWarning,
    }
  }

  return opResult
}
