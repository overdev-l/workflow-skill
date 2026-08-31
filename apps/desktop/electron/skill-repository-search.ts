import { spawn } from 'node:child_process'
import type { RepositorySkillSearchResult } from '@workflow-skill/workflow-model'

const MAX_OUTPUT_BYTES = 512 * 1024
const SEARCH_TIMEOUT_MS = 60_000
const REPOSITORY_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/

export function normalizeRepositorySlug(value: string) {
  const repository = value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('请输入 owner/repo 格式的 GitHub 仓库，例如 kacperkapusciak/goldie')
  }
  return repository
}

function stripTerminalControl(value: string) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/\r[^\n]*/g, '')
}

export function parseRepositorySkillList(repository: string, output: string): RepositorySkillSearchResult {
  const cleaned = stripTerminalControl(output)
  const sourceMatch = cleaned.match(/Source:\s*(https?:\/\/\S+)/i)
  const lines = cleaned.split(/\r?\n/)
  const availableIndex = lines.findIndex((line) => line.includes('Available Skills'))
  const skills: RepositorySkillSearchResult['skills'] = []
  let current: RepositorySkillSearchResult['skills'][number] | undefined

  for (const line of availableIndex >= 0 ? lines.slice(availableIndex + 1) : []) {
    if (line.includes('Use --skill')) break
    const nameMatch = line.match(/^\s*│\s{4}([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*$/)
    if (nameMatch) {
      current = { name: nameMatch[1], description: '' }
      skills.push(current)
      continue
    }
    const descriptionMatch = line.match(/^\s*│\s{6}(.+?)\s*$/)
    if (current && descriptionMatch) {
      current.description = `${current.description} ${descriptionMatch[1]}`.trim()
    }
  }

  if (skills.length === 0) {
    throw new Error('仓库中没有发现可用的 SKILL.md')
  }

  return {
    repository,
    sourceUrl: sourceMatch?.[1] || `https://github.com/${repository}`,
    skills,
  }
}

export function searchRepositorySkills(repositoryInput: string, workingDirectory: string) {
  const repository = normalizeRepositorySlug(repositoryInput)
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'

  return new Promise<RepositorySkillSearchResult>((resolve, reject) => {
    const child = spawn(command, ['--yes', 'skills', 'add', repository, '--list'], {
      cwd: workingDirectory,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let settled = false

    const append = (chunk: Buffer | string) => {
      if (output.length >= MAX_OUTPUT_BYTES) return
      output += chunk.toString().slice(0, MAX_OUTPUT_BYTES - output.length)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error('仓库搜索超时，请检查网络后重试'))
    }, SEARCH_TIMEOUT_MS)
    timer.unref?.()

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动 skills CLI：${error.message}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stripTerminalControl(output).trim().split(/\r?\n/).at(-1) || '仓库搜索失败'))
        return
      }
      try {
        resolve(parseRepositorySkillList(repository, output))
      } catch (error) {
        reject(error)
      }
    })
  })
}
