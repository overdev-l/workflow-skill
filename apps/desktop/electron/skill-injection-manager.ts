import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseDocument } from 'yaml'
import {
  DEFAULT_AI_TOOLS,
  type AdoptSkillResult,
  type BatchItemResult,
  type DisconnectSkillResult,
  type Skill,
  type SkillTargetBinding,
} from '@workflow-skill/workflow-model'
import { SUPPORTED_PROJECT_SKILL_PATHS } from './project-manager.ts'

export interface SkillInjectionOptions {
  traceHome?: string
  defaultProjectWorkspace?: string
  homeDir?: string
}

export function getEffectiveTraceHome(customTraceHome?: string): string {
  if (customTraceHome) return customTraceHome
  return path.join(os.homedir(), '.trace')
}

export function getEffectiveHomeDir(customHomeDir?: string): string {
  if (customHomeDir) return customHomeDir
  return os.homedir()
}

function resolveGlobalSkillDirectory(tool: (typeof DEFAULT_AI_TOOLS)[number], homeDir: string): string {
  if (tool.id === 'gemini-global') {
    const candidates = [
      path.join(homeDir, '.gemini', 'antigravity', 'skills'),
      path.join(homeDir, '.gemini', 'config', 'skills'),
      path.join(homeDir, '.gemini', 'skills'),
    ]
    return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
  }
  return tool.customDir
    ? path.isAbsolute(tool.customDir)
      ? tool.customDir
      : path.join(homeDir, tool.customDir)
    : path.join(homeDir, tool.defaultDir)
}

export function validateProjectSkillRelPath(relPath?: string): {
  valid: boolean
  normalized?: string
  error?: string
} {
  if (!relPath) {
    return { valid: true, normalized: path.join('.agents', 'skills') }
  }

  // Reject absolute paths
  if (path.isAbsolute(relPath)) {
    return { valid: false, error: `拒绝绝对路径作为项目技能相对目录: ${relPath}` }
  }

  // Normalize path and reject path traversal
  const normalized = path.normalize(relPath).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
  if (normalized.startsWith('..') || normalized.includes('..') || path.isAbsolute(normalized)) {
    return { valid: false, error: `拒绝路径穿越或未知路径: ${relPath}` }
  }

  // Must match one of SUPPORTED_PROJECT_SKILL_PATHS
  const isSupported = SUPPORTED_PROJECT_SKILL_PATHS.some((p) => {
    const targetNorm = path.normalize(p.relPath).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    return targetNorm === normalized || p.id === relPath
  })

  if (!isSupported) {
    const allowed = SUPPORTED_PROJECT_SKILL_PATHS.map((p) => p.relPath).join(', ')
    return { valid: false, error: `不支持的项目技能相对路径: ${relPath}。仅允许: ${allowed}` }
  }

  const matched = SUPPORTED_PROJECT_SKILL_PATHS.find((p) => {
    const targetNorm = path.normalize(p.relPath).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    return targetNorm === normalized || p.id === relPath
  })

  return { valid: true, normalized: matched?.relPath || normalized }
}

export function ensureSkillCentralDirectory(skill: Skill, traceHome: string): string {
  const skillFolder = path.join(traceHome, 'skills', skill.id)
  if (!existsSync(skillFolder)) {
    mkdirSync(skillFolder, { recursive: true })
  }
  const mdPath = path.join(skillFolder, 'SKILL.md')
  if (!existsSync(mdPath)) {
    const mdContent =
      skill.skillMarkdown ||
      `---\nname: ${skill.id}\ndescription: ${skill.description || skill.name}\ntools: [${skill.apps?.join(', ') || 'System'}]\nversion: ${skill.versions || 1}.0.0\n---\n\n# ${skill.name}\n\n${skill.description || ''}\n`
    writeFileSync(mdPath, mdContent, 'utf8')
  }
  return skillFolder
}

export function safeRemoveLink(targetLinkPath: string): boolean {
  try {
    const lstat = lstatSync(targetLinkPath)
    if (lstat.isSymbolicLink()) {
      unlinkSync(targetLinkPath)
      return true
    }
  } catch {}
  return false
}

export function inspectSkillTarget(
  targetLinkPath: string,
  expectedCentralFolder?: string
): {
  exists: boolean
  isSymlink: boolean
  targetPath?: string
  status: 'linked' | 'external' | 'conflict' | 'broken' | 'unbound'
  error?: string
} {
  try {
    const lstat = lstatSync(targetLinkPath)
    if (lstat.isSymbolicLink()) {
      try {
        const real = realpathSync(targetLinkPath)
        if (expectedCentralFolder) {
          const expectedReal = existsSync(expectedCentralFolder)
            ? realpathSync(expectedCentralFolder)
            : path.resolve(expectedCentralFolder)
          if (real === expectedReal) {
            return { exists: true, isSymlink: true, targetPath: real, status: 'linked' }
          } else {
            return { exists: true, isSymlink: true, targetPath: real, status: 'external' }
          }
        }
        return { exists: true, isSymlink: true, targetPath: real, status: 'linked' }
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          return { exists: true, isSymlink: true, status: 'broken', error: '软链接指向不存在的目标路径' }
        }
        return { exists: true, isSymlink: true, status: 'conflict', error: err?.message || String(err) }
      }
    } else if (lstat.isDirectory()) {
      if (expectedCentralFolder) {
        return { exists: true, isSymlink: false, targetPath: targetLinkPath, status: 'conflict', error: '目标已存在且为普通目录，非 Trace 管理软链接' }
      }
      return { exists: true, isSymlink: false, targetPath: targetLinkPath, status: 'external' }
    } else {
      return { exists: true, isSymlink: false, targetPath: targetLinkPath, status: 'conflict', error: '目标已存在且为普通文件' }
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { exists: false, isSymlink: false, status: 'unbound' }
    }
    return { exists: false, isSymlink: false, status: 'conflict', error: err?.message || String(err) }
  }
}

function validateRemovableLink(
  targetLinkPath: string,
  expectedCentralFolder?: string
): { success: boolean; exists: boolean; error?: string } {
  try {
    const target = lstatSync(targetLinkPath)
    if (!target.isSymbolicLink()) {
      return {
        success: false,
        exists: true,
        error: `目标已存在且不是由 Trace 管理的软链接，已保留: ${targetLinkPath}`,
      }
    }
    if (expectedCentralFolder) {
      try {
        const linkDest = realpathSync(targetLinkPath)
        const centralDest = realpathSync(expectedCentralFolder)
        if (linkDest !== centralDest) {
          return {
            success: false,
            exists: true,
            error: `软链接指向外部目标而非由 Trace 管理的中心资产，已保留: ${targetLinkPath}`,
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          return {
            success: false,
            exists: true,
            error: `软链接解析失败，已保留: ${err?.message || String(err)}`,
          }
        }
      }
    }
    return { success: true, exists: true }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { success: true, exists: false }
    return { success: false, exists: false, error: `检查技能链接失败: ${err?.message || String(err)}` }
  }
}

export function injectSkillToTarget(
  skillId: string,
  target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string },
  options?: SkillInjectionOptions
): { success: boolean; linkPath?: string; error?: string } {
  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const skillsDir = path.join(traceHome, 'skills')
  const filePath = path.join(skillsDir, `${skillId}.json`)

  if (!existsSync(filePath)) {
    return { success: false, error: `Skill 不存在: ${skillId}` }
  }

  let skill: Skill
  try {
    skill = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (err: any) {
    return { success: false, error: `解析 Skill 失败: ${err?.message}` }
  }

  const centralFolder = ensureSkillCentralDirectory(skill, traceHome)
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'

  if (target.scope === 'global') {
    if (!target.targetId) {
      return { success: false, error: '未指定全局目标工具标识' }
    }
    const tool = DEFAULT_AI_TOOLS.find(
      (t) => t.scope === 'global' && (
        t.id === target.targetId ||
        t.id.replace(/-global$/, '') === target.targetId ||
        t.compatibleTools?.some((ct) => ct.id === target.targetId)
      )
    )
    if (!tool) {
      return { success: false, error: `未找到全局 AI 工具: ${target.targetId}` }
    }

    const effectiveHome = getEffectiveHomeDir(options?.homeDir)
    const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)

    try {
      if (!existsSync(toolDir)) {
        mkdirSync(toolDir, { recursive: true })
      }
      const targetLink = path.join(toolDir, skillId)
      const existing = inspectSkillTarget(targetLink, centralFolder)
      if (existing.exists && existing.status !== 'linked') {
        return { success: false, error: existing.error || `目标已存在外部 Skill，已保留: ${targetLink}` }
      }
      if (existing.exists) unlinkSync(targetLink)
      symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)

      skill.targetTools = Array.from(new Set([...(skill.targetTools || []), target.targetId]))
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
      return { success: true, linkPath: targetLink }
    } catch (err: any) {
      return { success: false, error: `创建软链接失败: ${err?.message || String(err)}` }
    }
  } else if (target.scope === 'project') {
    const projectPath = target.projectPath || options?.defaultProjectWorkspace
    if (!projectPath) {
      return { success: false, error: '未指定有效的项目路径' }
    }

    const resolvedProject = path.resolve(projectPath)
    try {
      if (!existsSync(resolvedProject) || !statSync(resolvedProject).isDirectory()) {
        return { success: false, error: `项目路径不存在或不是文件夹: ${projectPath}` }
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }

    const relValidation = validateProjectSkillRelPath(target.relPath)
    if (!relValidation.valid || !relValidation.normalized) {
      return { success: false, error: relValidation.error || '无效的项目技能相对路径' }
    }

    const projectSkillDir = path.join(resolvedProject, relValidation.normalized)
    try {
      if (!existsSync(projectSkillDir)) {
        mkdirSync(projectSkillDir, { recursive: true })
      }
      const targetLink = path.join(projectSkillDir, skillId)
      const existing = inspectSkillTarget(targetLink, centralFolder)
      if (existing.exists && existing.status !== 'linked') {
        return { success: false, error: existing.error || `目标已存在外部 Skill，已保留: ${targetLink}` }
      }
      if (existing.exists) unlinkSync(targetLink)
      symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)

      skill.targetProjects = Array.from(new Set([...(skill.targetProjects || []), resolvedProject]))
      skill.targetProjectPaths = [
        ...(skill.targetProjectPaths || []).filter(
          (item) => !(path.resolve(item.projectPath) === resolvedProject && item.relPath === relValidation.normalized)
        ),
        { projectPath: resolvedProject, relPath: relValidation.normalized },
      ]
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
      return { success: true, linkPath: targetLink }
    } catch (err: any) {
      return { success: false, error: `创建项目技能软链接失败: ${err?.message || String(err)}` }
    }
  }

  return { success: false, error: `未知的注入目标作用域: ${(target as any)?.scope}` }
}

export function uninjectSkillFromTarget(
  skillId: string,
  target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string },
  options?: SkillInjectionOptions
): { success: boolean; error?: string } {
  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const skillsDir = path.join(traceHome, 'skills')
  const filePath = path.join(skillsDir, `${skillId}.json`)

  if (!existsSync(filePath)) {
    return { success: false, error: `Skill 不存在: ${skillId}` }
  }

  let skill: Skill
  try {
    skill = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (err: any) {
    return { success: false, error: `解析 Skill 失败: ${err?.message || String(err)}` }
  }

  if (target.scope === 'global') {
    if (!target.targetId) {
      return { success: false, error: '未指定全局目标工具标识' }
    }
    const tool = DEFAULT_AI_TOOLS.find(
      (t) => t.scope === 'global' && (
        t.id === target.targetId ||
        t.id.replace(/-global$/, '') === target.targetId ||
        t.compatibleTools?.some((ct) => ct.id === target.targetId)
      )
    )
    if (!tool) {
      return { success: false, error: `未找到全局 AI 工具: ${target.targetId}` }
    }

    const effectiveHome = getEffectiveHomeDir(options?.homeDir)
    const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)

    const centralFolder = path.join(skillsDir, skillId)
    const targetLink = path.join(toolDir, skillId)
    const removable = validateRemovableLink(targetLink, centralFolder)
    if (!removable.success) return { success: false, error: removable.error }

    try {
      if (removable.exists) unlinkSync(targetLink)
      skill.targetTools = (skill.targetTools || []).filter((id) => id !== target.targetId)
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
    } catch (err: any) {
      return { success: false, error: `取消全局技能注入失败: ${err?.message || String(err)}` }
    }

    return { success: true }
  } else if (target.scope === 'project') {
    const projectPath = target.projectPath || options?.defaultProjectWorkspace
    if (!projectPath) {
      return { success: false, error: '未指定有效的项目路径' }
    }

    const resolvedProject = path.resolve(projectPath)
    try {
      if (!existsSync(resolvedProject) || !statSync(resolvedProject).isDirectory()) {
        return { success: false, error: `项目路径不存在或不是文件夹: ${projectPath}` }
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }

    const centralFolder = path.join(skillsDir, skillId)
    const targetLinks: string[] = []
    if (target.relPath) {
      const relValidation = validateProjectSkillRelPath(target.relPath)
      if (!relValidation.valid || !relValidation.normalized) {
        return { success: false, error: relValidation.error || '无效的项目技能相对路径' }
      }
      targetLinks.push(path.join(resolvedProject, relValidation.normalized, skillId))
    } else {
      for (const sp of SUPPORTED_PROJECT_SKILL_PATHS) {
        targetLinks.push(path.join(resolvedProject, sp.relPath, skillId))
      }
    }

    const removableLinks = targetLinks.map((targetLink) => ({
      targetLink,
      result: validateRemovableLink(targetLink, centralFolder),
    }))
    const conflict = removableLinks.find(({ result }) => !result.success)
    if (conflict) return { success: false, error: conflict.result.error }

    try {
      for (const { targetLink, result } of removableLinks) {
        if (result.exists) unlinkSync(targetLink)
      }
      skill.targetProjectPaths = (skill.targetProjectPaths || []).filter((item) => {
        if (path.resolve(item.projectPath) !== resolvedProject) return true
        return target.relPath ? item.relPath !== validateProjectSkillRelPath(target.relPath).normalized : false
      })
      const stillTargetsProject = skill.targetProjectPaths.some(
        (item) => path.resolve(item.projectPath) === resolvedProject
      )
      if (!stillTargetsProject) {
        skill.targetProjects = (skill.targetProjects || []).filter((p) => path.resolve(p) !== resolvedProject)
      }
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
    } catch (err: any) {
      return { success: false, error: `取消项目技能注入失败: ${err?.message || String(err)}` }
    }

    return { success: true }
  }

  return { success: false, error: `未知的注入目标作用域: ${(target as any)?.scope}` }
}

export function batchInjectSkills(
  skillIds: string[],
  target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string },
  options?: SkillInjectionOptions
): { results: BatchItemResult[] } {
  const results: BatchItemResult[] = []
  for (const id of skillIds) {
    const res = injectSkillToTarget(id, target, options)
    results.push({ id, success: res.success, error: res.error })
  }
  return { results }
}

export function batchUninjectSkills(
  skillIds: string[],
  target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string },
  options?: SkillInjectionOptions
): { results: BatchItemResult[] } {
  const results: BatchItemResult[] = []
  for (const id of skillIds) {
    const res = uninjectSkillFromTarget(id, target, options)
    results.push({ id, success: res.success, error: res.error })
  }
  return { results }
}

export interface AdoptSkillTarget {
  type?: 'global' | 'project'
  toolId?: string
  projectPath?: string
  relPath?: string
  skillId?: string
  targetPath?: string
}

export function adoptSkillAsset(
  target: AdoptSkillTarget,
  options?: SkillInjectionOptions
): AdoptSkillResult {
  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const centralSkillsDir = path.join(traceHome, 'skills')
  const effectiveHome = getEffectiveHomeDir(options?.homeDir)

  // 1. Resolve the source only from a known supported target. The renderer may
  // provide targetPath for display/debugging, but it can never select an
  // arbitrary filesystem path for an ownership-changing operation.
  if (!target.skillId || path.basename(target.skillId) !== target.skillId || target.skillId.includes('..')) {
    return { success: false, error: '技能标识无效，拒绝执行纳入操作' }
  }

  let sourcePath = ''
  let normalizedProjectPath: string | undefined
  let normalizedProjectRelPath: string | undefined
  if (target.type === 'global') {
    if (!target.toolId) return { success: false, error: '未指定全局目标工具标识' }
    const tool = DEFAULT_AI_TOOLS.find(
      (t) =>
        t.scope === 'global' && (
          t.id === target.toolId ||
          t.id.replace(/-global$/, '') === target.toolId ||
          t.compatibleTools?.some((ct) => ct.id === target.toolId)
        )
    )
    if (!tool) return { success: false, error: `未找到全局 AI 工具: ${target.toolId}` }
    const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)
    sourcePath = path.resolve(toolDir, target.skillId)
  } else if (target.type === 'project') {
    const projectPath = target.projectPath || options?.defaultProjectWorkspace
    if (!projectPath) return { success: false, error: '未指定项目路径' }
    const validation = validateProjectSkillRelPath(target.relPath || '.agents/skills')
    if (!validation.valid || !validation.normalized) {
      return { success: false, error: validation.error || '无效的项目技能相对路径' }
    }
    normalizedProjectPath = path.resolve(projectPath)
    normalizedProjectRelPath = validation.normalized
    sourcePath = path.resolve(normalizedProjectPath, normalizedProjectRelPath, target.skillId)
  } else {
    return { success: false, error: '未指定有效的技能采纳目标' }
  }

  if (target.targetPath && path.resolve(target.targetPath) !== sourcePath) {
    return { success: false, error: '采纳目标路径与受支持的 AI 环境路径不一致，已拒绝操作' }
  }

  // 2. Validate source existence
  let sourceStat
  try {
    sourceStat = lstatSync(sourcePath)
  } catch (err: any) {
    return { success: false, error: `技能源路径不存在或不可访问: ${sourcePath} (${err?.message || String(err)})` }
  }

  // Check if it is already a symlink pointing to a central skill in traceHome.
  // This is an idempotent metadata repair, not a second migration.
  if (sourceStat.isSymbolicLink()) {
    try {
      const linkDest = realpathSync(sourcePath)
      const rel = path.relative(centralSkillsDir, linkDest)
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        const parts = rel.split(path.sep).filter(Boolean)
        if (parts.length >= 1) {
          const centralId = parts[0]
          const jsonPath = path.join(centralSkillsDir, `${centralId}.json`)
          if (existsSync(jsonPath)) {
            const existingSkill = JSON.parse(readFileSync(jsonPath, 'utf8')) as Skill
            const projectPath = normalizedProjectPath
            if (target.type === 'global' && target.toolId) {
              existingSkill.targetTools = Array.from(new Set([...(existingSkill.targetTools || []), target.toolId]))
              existingSkill.scopeStatus = '全局软链'
            } else if (projectPath && normalizedProjectRelPath) {
              existingSkill.targetProjects = Array.from(new Set([...(existingSkill.targetProjects || []), projectPath]))
              existingSkill.targetProjectPaths = Array.from(
                new Map(
                  [...(existingSkill.targetProjectPaths || []), { projectPath, relPath: normalizedProjectRelPath }]
                    .map((item) => [`${path.resolve(item.projectPath)}\0${item.relPath}`, item] as const),
                ).values(),
              )
              existingSkill.scopeStatus = '项目软链'
            }
            existingSkill.ownership = 'app'
            writeFileSync(jsonPath, JSON.stringify(existingSkill, null, 2), 'utf8')
            return { success: true, skill: existingSkill, linkPath: sourcePath }
          }
        }
      }
    } catch {}
  }

  // 3. Check SKILL.md in source directory (follow symlink to read content if external symlink)
  let realSourceDir = sourcePath
  if (sourceStat.isSymbolicLink()) {
    try {
      realSourceDir = realpathSync(sourcePath)
    } catch (err: any) {
      return { success: false, error: `外部软链接损坏，无法读取源目录: ${sourcePath}` }
    }
  }

  try {
    if (!statSync(realSourceDir).isDirectory()) {
      return { success: false, error: `技能源路径不是文件夹: ${realSourceDir}` }
    }
  } catch (err: any) {
    return { success: false, error: `读取技能源目录失败: ${err?.message || String(err)}` }
  }

  const skillMdPath = path.join(realSourceDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    return { success: false, error: `源目录中未找到 SKILL.md，不是规范的 Skill 资产: ${realSourceDir}` }
  }

  let skillMdContent = ''
  try {
    skillMdContent = readFileSync(skillMdPath, 'utf8')
  } catch (err: any) {
    return { success: false, error: `读取 SKILL.md 失败: ${err?.message || String(err)}` }
  }

  // 4. Parse metadata from SKILL.md
  let skillName = ''
  let skillDescription = ''
  let tags: string[] = []
  let triggers: string[] = []
  const frontmatter = skillMdContent.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (frontmatter) {
    try {
      const doc = parseDocument(frontmatter[1])
      const parsed = doc.toJS()
      if (parsed && typeof parsed === 'object') {
        if (typeof (parsed as any).name === 'string') skillName = (parsed as any).name.trim()
        if (typeof (parsed as any).description === 'string') skillDescription = (parsed as any).description.trim()
        if (Array.isArray((parsed as any).tags)) tags = (parsed as any).tags.filter((t: any) => typeof t === 'string')
        if (Array.isArray((parsed as any).triggers)) triggers = (parsed as any).triggers.filter((t: any) => typeof t === 'string')
      }
    } catch {}
  }
  if (!skillName) {
    const h1 = skillMdContent.match(/^#\s+(.+)$/m)
    if (h1) skillName = h1[1].trim()
  }
  if (!skillName) skillName = path.basename(sourcePath)

  // 5. Determine a stable central Skill ID. Reuse an existing central record
  // only when its canonical SKILL.md is identical; otherwise keep both assets
  // recoverable by allocating a suffixed ID instead of overwriting data.
  const rawId = (target.skillId || skillName || path.basename(sourcePath))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
  let id = rawId
  let existingSkill: Skill | undefined
  let reuseCentral = false
  const rawCentralFolder = path.join(centralSkillsDir, rawId)
  const rawCentralJson = path.join(centralSkillsDir, `${rawId}.json`)
  if (existsSync(rawCentralFolder) && existsSync(rawCentralJson)) {
    try {
      const existingMarkdown = readFileSync(path.join(rawCentralFolder, 'SKILL.md'), 'utf8')
      if (existingMarkdown === skillMdContent) {
        existingSkill = JSON.parse(readFileSync(rawCentralJson, 'utf8')) as Skill
        reuseCentral = existingSkill?.id === rawId
      }
    } catch {}
  }
  let counter = 1
  while (!reuseCentral && (existsSync(path.join(centralSkillsDir, id)) || existsSync(path.join(centralSkillsDir, `${id}.json`)))) {
    id = `${rawId}-${counter++}`
  }

  const centralFolder = path.join(centralSkillsDir, id)
  const centralJson = path.join(centralSkillsDir, `${id}.json`)
  let previousCentralJsonContent: string | null = null
  if (reuseCentral) {
    try { previousCentralJsonContent = readFileSync(centralJson, 'utf8') } catch {}
  }

  // 6. Copy source directory contents to centralFolder
  if (!reuseCentral) {
    try {
      mkdirSync(centralSkillsDir, { recursive: true })
      cpSync(realSourceDir, centralFolder, { recursive: true, errorOnExist: true })
      if (!existsSync(path.join(centralFolder, 'SKILL.md'))) {
        throw new Error('复制后 SKILL.md 不存在')
      }
    } catch (err: any) {
      try { rmSync(centralFolder, { recursive: true, force: true }) } catch {}
      return { success: false, error: `复制技能资产到中央库失败: ${err?.message || String(err)}` }
    }
  }

  // 7. Write central record JSON
  const resolvedProjectPath = normalizedProjectPath
  const targetTools = target.type === 'global' && target.toolId
    ? Array.from(new Set([...(existingSkill?.targetTools || []), target.toolId]))
    : [...(existingSkill?.targetTools || [])]
  const targetProjectPaths = [...(existingSkill?.targetProjectPaths || [])]
  if (resolvedProjectPath && normalizedProjectRelPath) {
    const key = `${resolvedProjectPath}\0${normalizedProjectRelPath}`
    if (!targetProjectPaths.some((item) => `${path.resolve(item.projectPath)}\0${item.relPath}` === key)) {
      targetProjectPaths.push({ projectPath: resolvedProjectPath, relPath: normalizedProjectRelPath })
    }
  }
  const targetProjects = resolvedProjectPath
    ? Array.from(new Set([...(existingSkill?.targetProjects || []), resolvedProjectPath]))
    : [...(existingSkill?.targetProjects || [])]
  const skillRecord: Skill = {
    ...(existingSkill || {}),
    id,
    name: skillName,
    description: skillDescription || existingSkill?.description || '',
    apps: existingSkill?.apps || ['AI Agent Runtime'],
    updatedLabel: '刚刚纳入',
    pinned: existingSkill?.pinned || false,
    sourceRuns: existingSkill?.sourceRuns || 0,
    versions: existingSkill?.versions || 1,
    workflow: existingSkill?.workflow || {
      id: `wf-${id}`,
      name: skillName,
      summary: skillDescription || `Adopted skill workflow for ${skillName}`,
      repeatCount: 0,
      estimatedMinutes: 0,
      confidence: 100,
      nodes: [],
      edges: [],
    },
    targetTools,
    targetProjects,
    targetProjectPaths,
    tags: tags.length > 0 ? tags : existingSkill?.tags,
    triggers: triggers.length > 0 ? triggers : existingSkill?.triggers,
    skillPath: centralFolder,
    skillMarkdown: skillMdContent,
    ownership: 'app',
    scopeStatus: target.type === 'global' ? '全局软链' : '项目软链',
  }

  try {
    writeFileSync(centralJson, JSON.stringify(skillRecord, null, 2), 'utf8')
  } catch (err: any) {
    if (!reuseCentral) {
      try { rmSync(centralFolder, { recursive: true, force: true }) } catch {}
    } else if (previousCentralJsonContent !== null) {
      try { writeFileSync(centralJson, previousCentralJsonContent, 'utf8') } catch {}
    }
    return { success: false, error: `写入中央技能元数据失败: ${err?.message || String(err)}` }
  }

  // 8. Replace sourcePath with a symlink to centralFolder. The temporary
  // backup lives beside the source so the rename is atomic even when the
  // source and Trace home are on different volumes.
  const backupDir = path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.trace-adopt-backup-${Date.now()}`)
  try {
    renameSync(sourcePath, backupDir)
  } catch (err: any) {
    if (!reuseCentral) {
      try { rmSync(centralFolder, { recursive: true, force: true }) } catch {}
      try { if (existsSync(centralJson)) unlinkSync(centralJson) } catch {}
    } else if (previousCentralJsonContent !== null) {
      try { writeFileSync(centralJson, previousCentralJsonContent, 'utf8') } catch {}
    }
    return { success: false, error: `备份原始技能目录失败，已取消纳入: ${err?.message || String(err)}` }
  }

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    symlinkSync(path.resolve(centralFolder), path.resolve(sourcePath), symlinkType)
    // Verification
    const createdStat = lstatSync(sourcePath)
    if (!createdStat.isSymbolicLink()) {
      throw new Error('创建的目标不是软链接')
    }
    const verifiedDest = realpathSync(sourcePath)
    if (verifiedDest !== realpathSync(centralFolder)) {
      throw new Error(`软链接指向不匹配: ${verifiedDest} vs ${centralFolder}`)
    }
  } catch (err: any) {
    // ROLLBACK
    try { rmSync(sourcePath, { recursive: true, force: true }) } catch {}
    try { renameSync(backupDir, sourcePath) } catch {}
    if (!reuseCentral) {
      try { rmSync(centralFolder, { recursive: true, force: true }) } catch {}
      try { if (existsSync(centralJson)) unlinkSync(centralJson) } catch {}
    } else if (previousCentralJsonContent !== null) {
      try { writeFileSync(centralJson, previousCentralJsonContent, 'utf8') } catch {}
    }
    return { success: false, error: `创建或验证软链接失败，已安全回滚原始目录: ${err?.message || String(err)}` }
  }

  // Source replaced successfully. Preserve a recoverable backup when possible.
  const trashPath = path.join(traceHome, '.trash', `${id}-${Date.now()}`)
  try {
    mkdirSync(path.dirname(trashPath), { recursive: true })
    renameSync(backupDir, trashPath)
  } catch {
    // Keep the side-by-side backup if it cannot be moved across volumes.
  }

  return { success: true, skill: skillRecord, linkPath: sourcePath }
}

export function disconnectSkillTarget(
  skillId: string,
  target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string },
  options?: SkillInjectionOptions
): DisconnectSkillResult {
  return uninjectSkillFromTarget(skillId, target, options)
}

export function discoverAllGlobalSkills(options?: SkillInjectionOptions): Skill[] {
  const root = getEffectiveTraceHome(options?.traceHome)
  const centralSkillsDir = path.join(root, 'skills')
  const effectiveHome = getEffectiveHomeDir(options?.homeDir)

  if (!existsSync(centralSkillsDir)) {
    try {
      mkdirSync(centralSkillsDir, { recursive: true })
    } catch {}
  }

  const skillsMap = new Map<string, Skill>()

  // 1. Load existing central skills from ~/.trace/skills
  try {
    if (existsSync(centralSkillsDir)) {
      const files = readdirSync(centralSkillsDir)
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = readFileSync(path.join(centralSkillsDir, file), 'utf8')
            const parsed = JSON.parse(content) as Skill
            if (parsed && parsed.id) {
              const skillFolder = path.join(centralSkillsDir, parsed.id)
              const mdPath = path.join(skillFolder, 'SKILL.md')
              if (existsSync(mdPath)) {
                parsed.skillMarkdown = readFileSync(mdPath, 'utf8')
              }
              parsed.skillPath = skillFolder
              parsed.ownership = 'app'

              // Validate target bindings for global tools
              const bindings: SkillTargetBinding[] = []
              let hasHealthyLink = false
              let hasConflict = false
              let hasBrokenLink = false

              const linkedTargetIds: string[] = []
              for (const tool of DEFAULT_AI_TOOLS.filter((candidate) => candidate.scope === 'global')) {
                const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)
                const targetLink = path.join(toolDir, parsed.id)
                const inspection = inspectSkillTarget(targetLink, skillFolder)
                const storedToolId = (parsed.targetTools || []).find((toolId) =>
                  toolId === tool.id ||
                  toolId === tool.id.replace(/-global$/, '') ||
                  tool.compatibleTools?.some((compatible) => compatible.id === toolId)
                )
                const toolId = storedToolId || tool.id
                bindings.push({
                  scope: 'global',
                  toolId,
                  targetPath: targetLink,
                  status: inspection.status,
                  linkTarget: inspection.targetPath,
                  error: inspection.error,
                })
                if (inspection.status === 'linked') {
                  hasHealthyLink = true
                  linkedTargetIds.push(toolId)
                }
                if (inspection.status === 'conflict' || inspection.status === 'external') hasConflict = true
                if (inspection.status === 'broken') hasBrokenLink = true
              }

              parsed.targetBindings = bindings
              // Discovery is intentionally read-only, but the in-memory record
              // must reflect the physical links instead of stale historical
              // targetTools metadata.
              parsed.targetTools = Array.from(new Set(linkedTargetIds))
              if (hasConflict) {
                parsed.scopeStatus = '冲突'
              } else if (hasBrokenLink) {
                parsed.scopeStatus = '链接损坏'
              } else if (hasHealthyLink) {
                parsed.scopeStatus = '全局软链'
              } else {
                parsed.scopeStatus = '未注入'
              }

              skillsMap.set(parsed.id, parsed)
            }
          } catch {}
        }
      }
    }
  } catch {}

  // 2. Discover external skills from global AI tool directories
  // NOTE: This must remain purely READ-ONLY! Never silently persist to central repository!
  for (const tool of DEFAULT_AI_TOOLS.filter((t) => t.scope === 'global')) {
    const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)
    if (!existsSync(toolDir)) continue

    try {
      const items = readdirSync(toolDir)
      for (const item of items) {
        if (item.startsWith('.')) continue
        const itemPath = path.join(toolDir, item)
        let stat
        try {
          stat = lstatSync(itemPath)
        } catch {
          continue
        }

        const isSym = stat.isSymbolicLink()
        let realPath = itemPath
        if (isSym) {
          try {
            realPath = realpathSync(itemPath)
          } catch {
            continue
          }
        }

        let isDir = false
        try {
          isDir = statSync(realPath).isDirectory()
        } catch {
          continue
        }
        if (!isDir) continue

        // Check if realPath points into central skills directory
        const centralRel = path.relative(centralSkillsDir, realPath)
        const isCentral = !centralRel.startsWith('..') && !path.isAbsolute(centralRel)

        if (isCentral && isSym) {
          // It's a symlink pointing to central skill!
          const centralId = centralRel.split(path.sep)[0]
          if (skillsMap.has(centralId)) {
            const skill = skillsMap.get(centralId)!
            if (!skill.targetTools?.includes(tool.id)) {
              skill.targetTools = Array.from(new Set([...(skill.targetTools || []), tool.id]))
            }
            if (skill.scopeStatus !== '冲突') {
              skill.scopeStatus = '全局软链'
            }
          }
          continue
        }

        // Otherwise, it's an external directory or external symlink!
        const skillMdPath = path.join(realPath, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue

        let skillMd = ''
        try {
          skillMd = readFileSync(skillMdPath, 'utf8')
        } catch {}

        let name = ''
        let description = ''
        let tags: string[] = []
        let triggers: string[] = []
        const frontmatter = skillMd.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
        if (frontmatter) {
          try {
            const doc = parseDocument(frontmatter[1])
            const parsedDoc = doc.toJS()
            if (parsedDoc && typeof parsedDoc === 'object') {
              if (typeof (parsedDoc as any).name === 'string') name = (parsedDoc as any).name.trim()
              if (typeof (parsedDoc as any).description === 'string') description = (parsedDoc as any).description.trim()
              if (Array.isArray((parsedDoc as any).tags)) tags = (parsedDoc as any).tags.filter((t: any) => typeof t === 'string')
              if (Array.isArray((parsedDoc as any).triggers)) triggers = (parsedDoc as any).triggers.filter((t: any) => typeof t === 'string')
            }
          } catch {}
        }
        if (!name) {
          const h1Match = skillMd.match(/^#\s+(.+)$/m)
          if (h1Match) name = h1Match[1].trim()
        }
        if (!name) name = item
        if (!description) description = `从 ${tool.name} 目录发现的外部技能`

        const extId = `external:global:${tool.id}:${item}`
        if (!skillsMap.has(extId)) {
          skillsMap.set(extId, {
            id: extId,
            name,
            description,
            apps: ['AI Agent Runtime'],
            updatedLabel: '外部持有',
            pinned: false,
            sourceRuns: 0,
            versions: 1,
            workflow: {
              id: `wf-${extId}`,
              name,
              summary: description,
              repeatCount: 0,
              estimatedMinutes: 0,
              confidence: 0,
              nodes: [],
              edges: [],
            },
            targetTools: [tool.id],
            tags: tags.length > 0 ? tags : [tool.id.replace('-global', '')],
            triggers,
            skillPath: realPath,
            sourcePath: itemPath,
            skillMarkdown: skillMd,
            ownership: 'external',
            scopeStatus: '外部持有',
            externalSource: {
              type: 'global',
              toolId: tool.id,
              fullPath: itemPath,
              isSymlink: isSym,
              symlinkTarget: isSym ? realPath : undefined,
            },
            targetBindings: [
              {
                scope: 'global',
                toolId: tool.id,
                targetPath: itemPath,
                status: 'external',
                linkTarget: isSym ? realPath : undefined,
              },
            ],
          })
        }
      }
    } catch {}
  }

  return Array.from(skillsMap.values())
}
