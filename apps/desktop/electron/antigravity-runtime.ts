import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { AccountError } from '../../../packages/workflow-model/src/accounts.ts'

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

export function assertAntigravityStopped(): void {
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { throw new AccountError('无法检查 Antigravity 运行状态，未修改账号。') }
  if (antigravityProcesses(output).length) {
    throw new AccountError('请先退出 Antigravity 客户端并结束所有 agy CLI 会话，再切换或回滚账号；新会话将使用所选账号。')
  }
}
