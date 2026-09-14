import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  ClaudeLinkResult,
  ClaudeLinkStatus,
  ProjectRuleAssociation,
  PublicRule,
} from '@workflow-skill/workflow-model'

export function getEffectiveTraceHome(customTraceHome?: string): string {
  if (customTraceHome) return customTraceHome
  return path.join(os.homedir(), '.trace')
}

function getRulesFilePath(traceHome: string): string {
  return path.join(traceHome, 'rules.json')
}

function getProjectRulesFilePath(traceHome: string): string {
  return path.join(traceHome, 'project-rules.json')
}

function readRulesFile(traceHome: string): PublicRule[] {
  const filePath = getRulesFilePath(traceHome)
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      if (Array.isArray(data)) return data
    }
  } catch {}
  return []
}

function writeRulesFile(traceHome: string, rules: PublicRule[]): void {
  if (!existsSync(traceHome)) {
    mkdirSync(traceHome, { recursive: true })
  }
  const filePath = getRulesFilePath(traceHome)
  writeFileSync(filePath, JSON.stringify(rules, null, 2), 'utf8')
}

function readProjectRulesFile(traceHome: string): Record<string, ProjectRuleAssociation> {
  const filePath = getProjectRulesFilePath(traceHome)
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      if (data && typeof data === 'object') return data
    }
  } catch {}
  return {}
}

function writeProjectRulesFile(traceHome: string, records: Record<string, ProjectRuleAssociation>): void {
  if (!existsSync(traceHome)) {
    mkdirSync(traceHome, { recursive: true })
  }
  const filePath = getProjectRulesFilePath(traceHome)
  writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8')
}

// Marker Regex & Builders with Attribute Escaping
export function escapeMarkerAttr(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/--/g, '&#45;&#45;')
}

export function unescapeMarkerAttr(str: string): string {
  return (str || '')
    .replace(/&#45;&#45;/g, '--')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function buildRuleBlock(rule: PublicRule): string {
  const trimmed = rule.content.trim()
  const safeId = escapeMarkerAttr(rule.id)
  const safeName = escapeMarkerAttr(rule.name)
  return `<!-- TRACE:RULE:START id="${safeId}" name="${safeName}" -->\n${trimmed}\n<!-- TRACE:RULE:END id="${safeId}" -->`
}

export const RULE_BLOCK_REGEX = /<!-- TRACE:RULE:START id="([^"]+)"(?:\s+name="([^"]*)")?\s*-->([\s\S]*?)<!-- TRACE:RULE:END id="\1"\s*-->/g

export function renderAgentsMdContent(existingContent: string | null, rulesInOrder: PublicRule[]): string {
  const ruleBlocks = rulesInOrder.map((r) => buildRuleBlock(r)).join('\n\n')

  if (existingContent === null || existingContent.trim() === '') {
    if (ruleBlocks.length === 0) return ''
    return `# Project Guidelines (AGENTS.md)\n\n${ruleBlocks}\n`
  }

  // Find all existing rule blocks
  RULE_BLOCK_REGEX.lastIndex = 0
  const matches: Array<{ start: number; end: number; id: string }> = []
  let m: RegExpExecArray | null
  while ((m = RULE_BLOCK_REGEX.exec(existingContent)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      id: m[1],
    })
  }

  if (matches.length === 0) {
    if (ruleBlocks.length === 0) return existingContent
    const base = existingContent.trimEnd()
    return `${base}\n\n${ruleBlocks}\n`
  }

  // Collect native chunks between the managed blocks
  // Chunk 0: before first block
  // Chunk 1..N-1: between blocks
  // Chunk N: after last block
  const nativeChunks: string[] = []
  nativeChunks.push(existingContent.slice(0, matches[0].start))
  for (let i = 0; i < matches.length - 1; i++) {
    nativeChunks.push(existingContent.slice(matches[i].end, matches[i + 1].start))
  }
  nativeChunks.push(existingContent.slice(matches[matches.length - 1].end))

  // Build the content:
  // nativeChunks[0] + [managed ruleBlocks at deterministic first block position] + remaining native chunks
  let result = ''

  if (ruleBlocks.length > 0) {
    const head = nativeChunks[0]
    if (head.trim() === '') {
      result = ruleBlocks
    } else {
      result = head.trimEnd() + '\n\n' + ruleBlocks
    }

    // Append remaining native chunks (preserving native text between and after)
    for (let i = 1; i < nativeChunks.length; i++) {
      const chunk = nativeChunks[i]
      if (chunk.trim() !== '') {
        result = result.trimEnd() + '\n\n' + chunk.trim()
      }
    }
    result = result.trimEnd() + '\n'
  } else {
    // All managed blocks removed: preserve all non-empty native chunks
    const parts: string[] = []
    for (const chunk of nativeChunks) {
      if (chunk.trim() !== '') {
        parts.push(chunk.trim())
      }
    }
    result = parts.length > 0 ? parts.join('\n\n') + '\n' : ''
  }

  return result
}

export function listRules(customTraceHome?: string): PublicRule[] {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  return readRulesFile(traceHome)
}

export function getRule(ruleId: string, customTraceHome?: string): PublicRule | null {
  const rules = listRules(customTraceHome)
  return rules.find((r) => r.id === ruleId) || null
}

export function saveRule(
  input: Partial<PublicRule> & { name: string; content: string },
  customTraceHome?: string
): {
  success: boolean
  rule: PublicRule
  syncResults: Array<{ projectPath: string; success: boolean; error?: string }>
} {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const rules = readRulesFile(traceHome)

  const ruleId =
    input.id ||
    `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const existingIndex = rules.findIndex((r) => r.id === ruleId)
  const now = Date.now()

  const rule: PublicRule = {
    id: ruleId,
    name: input.name.trim(),
    content: input.content,
    description: input.description?.trim() || '',
    createdAt: existingIndex >= 0 ? rules[existingIndex].createdAt : now,
    updatedAt: now,
  }

  if (existingIndex >= 0) {
    rules[existingIndex] = rule
  } else {
    rules.push(rule)
  }

  writeRulesFile(traceHome, rules)

  // Automatically synchronize only associated projects
  const syncResults = syncProjectsForSavedRule(rule, traceHome)

  return { success: true, rule, syncResults }
}

function syncProjectsForSavedRule(
  rule: PublicRule,
  traceHome: string
): Array<{ projectPath: string; success: boolean; error?: string }> {
  const associations = readProjectRulesFile(traceHome)
  const results: Array<{ projectPath: string; success: boolean; error?: string }> = []

  for (const [projectPath, assoc] of Object.entries(associations)) {
    if (assoc.ruleIds && assoc.ruleIds.includes(rule.id)) {
      const syncRes = syncProjectRulesInternal(projectPath, assoc.ruleIds, traceHome)
      results.push({
        projectPath,
        success: syncRes.success,
        error: syncRes.error,
      })
    }
  }

  return results
}

export function deleteRule(
  ruleId: string,
  customTraceHome?: string
): {
  success: boolean
  syncResults: Array<{ projectPath: string; success: boolean; error?: string }>
} {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const rules = readRulesFile(traceHome)
  const filtered = rules.filter((r) => r.id !== ruleId)
  writeRulesFile(traceHome, filtered)

  // Uninject from all associated projects
  const associations = readProjectRulesFile(traceHome)
  const results: Array<{ projectPath: string; success: boolean; error?: string }> = []

  for (const [projectPath, assoc] of Object.entries(associations)) {
    if (assoc.ruleIds && assoc.ruleIds.includes(ruleId)) {
      const updatedRuleIds = assoc.ruleIds.filter((id) => id !== ruleId)
      assoc.ruleIds = updatedRuleIds
      const syncRes = syncProjectRulesInternal(projectPath, updatedRuleIds, traceHome)
      results.push({
        projectPath,
        success: syncRes.success,
        error: syncRes.error,
      })
    }
  }

  writeProjectRulesFile(traceHome, associations)
  return { success: true, syncResults: results }
}

export function getProjectRuleConfig(
  projectPath: string,
  customTraceHome?: string
): ProjectRuleAssociation {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const associations = readProjectRulesFile(traceHome)
  const resolved = path.resolve(projectPath)

  return (
    associations[resolved] ||
    associations[projectPath] || {
      projectPath: resolved,
      ruleIds: [],
      status: 'pending',
    }
  )
}

export function setProjectRules(
  projectPath: string,
  ruleIds: string[],
  customTraceHome?: string
): { success: boolean; status: 'synced' | 'failed'; error?: string } {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  return syncProjectRulesInternal(projectPath, ruleIds, traceHome)
}

export function uninjectRuleFromProject(
  projectPath: string,
  ruleId: string,
  customTraceHome?: string
): { success: boolean; status: 'synced' | 'failed'; error?: string } {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const assoc = getProjectRuleConfig(projectPath, traceHome)
  const newRuleIds = assoc.ruleIds.filter((id) => id !== ruleId)
  return syncProjectRulesInternal(projectPath, newRuleIds, traceHome)
}

export function syncProjectRules(
  projectPath: string,
  customTraceHome?: string
): { success: boolean; status: 'synced' | 'failed'; error?: string } {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const assoc = getProjectRuleConfig(projectPath, traceHome)
  return syncProjectRulesInternal(projectPath, assoc.ruleIds, traceHome)
}

function syncProjectRulesInternal(
  projectPath: string,
  ruleIds: string[],
  traceHome: string
): { success: boolean; status: 'synced' | 'failed'; error?: string } {
  if (!projectPath) {
    return { success: false, status: 'failed', error: '未指定项目路径' }
  }

  const resolved = path.resolve(projectPath)
  let isDir = false
  try {
    isDir = existsSync(resolved) && statSync(resolved).isDirectory()
  } catch {}

  if (!isDir) {
    const associations = readProjectRulesFile(traceHome)
    associations[resolved] = {
      projectPath: resolved,
      ruleIds,
      lastSyncedAt: Date.now(),
      status: 'failed',
      lastError: `项目目录不存在或不是文件夹: ${resolved}`,
    }
    writeProjectRulesFile(traceHome, associations)
    return { success: false, status: 'failed', error: `项目目录不存在或不是文件夹: ${resolved}` }
  }

  const allRules = readRulesFile(traceHome)
  const orderedRules: PublicRule[] = []
  for (const id of ruleIds) {
    const found = allRules.find((r) => r.id === id)
    if (found) orderedRules.push(found)
  }

  const agentsPath = path.join(resolved, 'AGENTS.md')
  let existingContent: string | null = null

  if (existsSync(agentsPath)) {
    try {
      existingContent = readFileSync(agentsPath, 'utf8')
    } catch (err: any) {
      return { success: false, status: 'failed', error: `读取 AGENTS.md 失败: ${err?.message}` }
    }
  }

  try {
    const newContent = renderAgentsMdContent(existingContent, orderedRules)
    writeFileSync(agentsPath, newContent, 'utf8')

    const associations = readProjectRulesFile(traceHome)
    associations[resolved] = {
      projectPath: resolved,
      ruleIds,
      lastSyncedAt: Date.now(),
      status: 'synced',
    }
    writeProjectRulesFile(traceHome, associations)

    return { success: true, status: 'synced' }
  } catch (err: any) {
    const associations = readProjectRulesFile(traceHome)
    associations[resolved] = {
      projectPath: resolved,
      ruleIds,
      lastSyncedAt: Date.now(),
      status: 'failed',
      lastError: err?.message || String(err),
    }
    writeProjectRulesFile(traceHome, associations)
    return { success: false, status: 'failed', error: err?.message || String(err) }
  }
}

// =========================================================================
// CLAUDE.md Helper
// =========================================================================

export function checkClaudeMdLink(projectPath: string): ClaudeLinkStatus {
  let isDir = false
  try {
    isDir = Boolean(projectPath && existsSync(projectPath) && statSync(projectPath).isDirectory())
  } catch {}
  if (!isDir) {
    return {
      exists: false,
      isSymlink: false,
      isCorrect: false,
      conflict: false,
      reason: '项目路径不存在或不是文件夹',
    }
  }

  const claudePath = path.join(projectPath, 'CLAUDE.md')
  try {
    const stat = lstatSync(claudePath)
    if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(claudePath)
      const isCorrect =
        linkTarget === 'AGENTS.md' ||
        path.resolve(projectPath, linkTarget) === path.resolve(projectPath, 'AGENTS.md')
      return {
        exists: true,
        isSymlink: true,
        target: linkTarget,
        isCorrect,
        conflict: !isCorrect,
        reason: isCorrect
          ? 'CLAUDE.md 正确指向同目录 AGENTS.md'
          : `CLAUDE.md 软链接指向了不同目标: ${linkTarget}`,
      }
    } else {
      return {
        exists: true,
        isSymlink: false,
        isCorrect: false,
        conflict: true,
        reason: 'CLAUDE.md 已经存在且为普通文件或目录，存在冲突',
      }
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return {
        exists: false,
        isSymlink: false,
        isCorrect: false,
        conflict: false,
      }
    }
    return {
      exists: false,
      isSymlink: false,
      isCorrect: false,
      conflict: true,
      reason: err?.message || String(err),
    }
  }
}

export function createClaudeMdLink(projectPath: string): ClaudeLinkResult {
  let isDir = false
  try {
    isDir = Boolean(projectPath && existsSync(projectPath) && statSync(projectPath).isDirectory())
  } catch {}
  if (!isDir) {
    return { success: false, reason: '项目路径不存在或不是文件夹' }
  }

  const claudePath = path.join(projectPath, 'CLAUDE.md')

  try {
    const stat = lstatSync(claudePath)
    if (stat.isSymbolicLink()) {
      const linkTarget = readlinkSync(claudePath)
      const isCorrect =
        linkTarget === 'AGENTS.md' ||
        path.resolve(projectPath, linkTarget) === path.resolve(projectPath, 'AGENTS.md')

      if (isCorrect) {
        return { success: true, action: 'skipped', reason: 'CLAUDE.md 已经是正确软链接，无需重复创建' }
      } else {
        return {
          success: false,
          conflict: true,
          reason: `冲突：当前 CLAUDE.md 指向了 "${linkTarget}" 而非 "AGENTS.md"，请手动处理以防静默覆盖`,
        }
      }
    } else {
      return {
        success: false,
        conflict: true,
        reason: '冲突：项目根目录已存在普通文件或目录 CLAUDE.md，请手动处理以防静默覆盖',
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      return { success: false, reason: err?.message || String(err) }
    }
  }

  // File does not exist, create relative symlink CLAUDE.md -> AGENTS.md
  try {
    symlinkSync('AGENTS.md', claudePath)
    return { success: true, action: 'created' }
  } catch (err: any) {
    return { success: false, reason: `创建软链接失败: ${err?.message || String(err)}` }
  }
}
