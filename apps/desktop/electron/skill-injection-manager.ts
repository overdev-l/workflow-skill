import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
  type BatchSkillAdoptionResult,
  type BatchItemResult,
  type ConflictResolutionStrategy,
  type DisconnectSkillResult,
  type ResolveSkillConflictInput,
  type ResolveSkillConflictResult,
  type ResolveSkillConflictTarget,
  type Skill,
  type SkillAdoptionPlan,
  type SkillAdoptionPlanItem,
  type SkillAdoptionPlanTarget,
  type SkillAdoptionTargetResult,
  type SkillTargetBinding,
} from '@workflow-skill/workflow-model'
import { SUPPORTED_PROJECT_SKILL_PATHS } from './project-manager.ts'

export interface SkillInjectionOptions {
  traceHome?: string
  defaultProjectWorkspace?: string
  homeDir?: string
  projectPaths?: string[]
}

export function getEffectiveTraceHome(customTraceHome?: string): string {
  if (customTraceHome) return customTraceHome
  return path.join(os.homedir(), '.trace')
}

export function getEffectiveHomeDir(customHomeDir?: string): string {
  if (customHomeDir) return customHomeDir
  return os.homedir()
}

/**
 * Create a deterministic fingerprint for a Skill directory without following
 * nested symlinks. The latter is important here: a Skill may contain helper
 * links, but discovery must never walk outside the asset it is inspecting.
 */
export function getSkillDirectoryFingerprint(directory: string): string {
  const hash = createHash('sha256')
  const visit = (current: string, relative: string) => {
    const entries = readdirSync(current).sort((a, b) => a.localeCompare(b))
    for (const name of entries) {
      const entry = path.join(current, name)
      const entryRelative = path.join(relative, name).split(path.sep).join('/')
      const stat = lstatSync(entry)
      if (stat.isDirectory()) {
        hash.update(`dir\0${entryRelative}\0`)
        visit(entry, entryRelative)
      } else if (stat.isSymbolicLink()) {
        hash.update(`link\0${entryRelative}\0${readlinkSync(entry)}\0`)
      } else if (stat.isFile()) {
        hash.update(`file\0${entryRelative}\0`)
        hash.update(readFileSync(entry))
        hash.update('\0')
      } else {
        hash.update(`other\0${entryRelative}\0${stat.mode}\0`)
      }
    }
  }
  visit(directory, '')
  return hash.digest('hex')
}

function tryGetSkillDirectoryFingerprint(directory: string): string | undefined {
  try {
    return getSkillDirectoryFingerprint(directory)
  } catch {
    return undefined
  }
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
  expectedCentralFolder?: string,
  expectedContentHash?: string,
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
          } else if (expectedContentHash && tryGetSkillDirectoryFingerprint(real) === expectedContentHash) {
            return {
              exists: true,
              isSymlink: true,
              targetPath: real,
              status: 'external',
              error: '目标是外部软链接，但内容与应用源一致，可纳入应用管理',
            }
          } else {
            return {
              exists: true,
              isSymlink: true,
              targetPath: real,
              status: expectedContentHash ? 'conflict' : 'external',
              error: expectedContentHash ? '目标软链接指向外部目录且内容与应用源不一致' : undefined,
            }
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
        if (expectedContentHash && tryGetSkillDirectoryFingerprint(targetLinkPath) === expectedContentHash) {
          return {
            exists: true,
            isSymlink: false,
            targetPath: targetLinkPath,
            status: 'external',
            error: '目标是普通目录，但内容与应用源一致，可纳入应用管理',
          }
        }
        return {
          exists: true,
          isSymlink: false,
          targetPath: targetLinkPath,
          status: 'conflict',
          error: expectedContentHash
            ? '目标是普通目录且内容与应用源不一致'
            : '目标已存在且为普通目录，非 Trace 管理软链接',
        }
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
  // Preserve the pre-adoption source with the same cross-volume fallback used
  // by conflict resolution. If the configured Trace storage is on another
  // volume, the backup may remain beside the source rather than being lost.
  preserveTargetInTrash(backupDir, traceHome, `${id}-adopt`)

  return { success: true, skill: skillRecord, linkPath: sourcePath }
}

function isPathInside(parent: string, candidate: string): boolean {
  const normalizeExistingPath = (value: string) => {
    try { return realpathSync(value) } catch { return path.resolve(value) }
  }
  const relative = path.relative(normalizeExistingPath(parent), normalizeExistingPath(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizePathWithoutFinalSymlink(value: string): string {
  const resolved = path.resolve(value)
  try { return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved)) }
  catch { return resolved }
}

function isDirectCentralLink(targetPath: string, centralFolder: string): boolean {
  try {
    const stat = lstatSync(targetPath)
    if (!stat.isSymbolicLink()) return false
    const linkTarget = readlinkSync(targetPath)
    const resolvedLinkTarget = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(targetPath), linkTarget)
    return normalizePathWithoutFinalSymlink(resolvedLinkTarget) === normalizePathWithoutFinalSymlink(centralFolder)
  } catch {
    return false
  }
}

function normalizeSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
}

function resolveGlobalTool(targetId: string) {
  return DEFAULT_AI_TOOLS.find(
    (tool) => tool.scope === 'global' && (
      tool.id === targetId ||
      tool.id.replace(/-global$/, '') === targetId ||
      tool.compatibleTools?.some((compatible) => compatible.id === targetId)
    )
  )
}

function readExistingCentralHash(centralSkillsDir: string, suggestedSkillId: string): string | undefined {
  const folder = path.join(centralSkillsDir, suggestedSkillId)
  const record = path.join(centralSkillsDir, `${suggestedSkillId}.json`)
  if (!existsSync(folder) || !existsSync(record)) return undefined
  return tryGetSkillDirectoryFingerprint(folder)
}

interface CollectedSkillAdoptionTarget {
  target: SkillAdoptionPlanTarget
}

function collectSkillAdoptionTarget(
  descriptor: AdoptSkillTarget,
  targetPath: string,
  centralSkillsDir: string,
  errors: string[],
): CollectedSkillAdoptionTarget | null {
  let stat
  try {
    stat = lstatSync(targetPath)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') errors.push(`${targetPath}：无法读取目标，${err?.message || String(err)}`)
    return null
  }

  const isSymlink = stat.isSymbolicLink()
  let canonicalSourcePath: string
  try {
    canonicalSourcePath = realpathSync(targetPath)
  } catch (err: any) {
    errors.push(`${targetPath}：${isSymlink ? '软链接已损坏，' : ''}无法接管（${err?.message || String(err)}）`)
    return null
  }

  let sourceStat
  try {
    sourceStat = statSync(canonicalSourcePath)
  } catch (err: any) {
    errors.push(`${targetPath}：源目录不可访问，${err?.message || String(err)}`)
    return null
  }
  if (!sourceStat.isDirectory()) return null
  if (isPathInside(centralSkillsDir, canonicalSourcePath)) return null

  const skillMarkdownPath = path.join(canonicalSourcePath, 'SKILL.md')
  if (!existsSync(skillMarkdownPath)) return null
  const contentHash = tryGetSkillDirectoryFingerprint(canonicalSourcePath)
  if (!contentHash) {
    errors.push(`${targetPath}：无法计算 Skill 内容指纹，已跳过`)
    return null
  }

  const skillId = path.basename(targetPath)
  return {
    target: {
      scope: descriptor.type === 'project' ? 'project' : 'global',
      toolId: descriptor.toolId,
      projectPath: descriptor.projectPath,
      relPath: descriptor.relPath,
      skillId,
      targetPath,
      sourcePath: targetPath,
      canonicalSourcePath,
      status: 'external',
      isSymlink,
      contentHash,
    },
  }
}

function collectGlobalSkillAdoptionTargets(
  centralSkillsDir: string,
  effectiveHome: string,
  errors: string[],
): CollectedSkillAdoptionTarget[] {
  const targets: CollectedSkillAdoptionTarget[] = []
  for (const tool of DEFAULT_AI_TOOLS.filter((candidate) => candidate.scope === 'global')) {
    const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)
    if (!existsSync(toolDir)) continue
    let items: string[]
    try {
      items = readdirSync(toolDir).sort((a, b) => a.localeCompare(b))
    } catch (err: any) {
      errors.push(`${tool.name}：无法读取技能目录，${err?.message || String(err)}`)
      continue
    }
    for (const item of items) {
      if (item.startsWith('.')) continue
      const targetPath = path.join(toolDir, item)
      const collected = collectSkillAdoptionTarget(
        { type: 'global', toolId: tool.id },
        targetPath,
        centralSkillsDir,
        errors,
      )
      if (collected) targets.push(collected)
    }
  }
  return targets
}

function collectProjectSkillAdoptionTargets(
  centralSkillsDir: string,
  projectPaths: string[],
  errors: string[],
): CollectedSkillAdoptionTarget[] {
  const targets: CollectedSkillAdoptionTarget[] = []
  const projects = Array.from(new Set(projectPaths.map((project) => path.resolve(project))))
  for (const projectPath of projects) {
    try {
      if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
        errors.push(`项目路径不存在或不是文件夹：${projectPath}`)
        continue
      }
    } catch (err: any) {
      errors.push(`项目路径不可访问：${projectPath}（${err?.message || String(err)}）`)
      continue
    }

    for (const supportedPath of SUPPORTED_PROJECT_SKILL_PATHS) {
      const skillDir = path.join(projectPath, supportedPath.relPath)
      if (!existsSync(skillDir)) continue
      let items: string[]
      try {
        items = readdirSync(skillDir).sort((a, b) => a.localeCompare(b))
      } catch (err: any) {
        errors.push(`${projectPath}/${supportedPath.relPath}：无法读取技能目录，${err?.message || String(err)}`)
        continue
      }
      for (const item of items) {
        if (item.startsWith('.')) continue
        const targetPath = path.join(skillDir, item)
        const collected = collectSkillAdoptionTarget(
          { type: 'project', projectPath, relPath: supportedPath.relPath },
          targetPath,
          centralSkillsDir,
          errors,
        )
        if (collected) targets.push(collected)
      }
    }
  }
  return targets
}

function adoptionPlanItemStatus(
  centralSkillsDir: string,
  suggestedSkillId: string,
  contentHash: string,
): { status: SkillAdoptionPlanItem['status']; reason?: string } {
  const existingHash = readExistingCentralHash(centralSkillsDir, suggestedSkillId)
  if (!existingHash) return { status: 'ready' }
  if (existingHash === contentHash) {
    return { status: 'ready', reason: '中心库已有相同内容，接管时复用现有源资产' }
  }
  return {
    status: 'conflict',
    reason: `中心库已有 ${suggestedSkillId}，但内容不同。为避免静默覆盖，该项需要单独确认。`,
  }
}

/** Build a read-only plan for taking over existing global/project Skills. */
export function buildSkillAdoptionPlan(options?: SkillInjectionOptions): SkillAdoptionPlan {
  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const centralSkillsDir = path.join(traceHome, 'skills')
  const errors: string[] = []
  const collected = [
    ...collectGlobalSkillAdoptionTargets(centralSkillsDir, getEffectiveHomeDir(options?.homeDir), errors),
    ...collectProjectSkillAdoptionTargets(centralSkillsDir, options?.projectPaths || [], errors),
  ]
  const grouped = new Map<string, CollectedSkillAdoptionTarget[]>()
  for (const item of collected) {
    const hash = item.target.contentHash || ''
    const key = `${item.target.canonicalSourcePath}\0${hash}`
    const group = grouped.get(key) || []
    group.push(item)
    grouped.set(key, group)
  }

  const items: SkillAdoptionPlanItem[] = Array.from(grouped.entries()).map(([key, group]) => {
    const first = group[0].target
    const suggestedSkillId = normalizeSkillId(first.skillId)
    const contentHash = first.contentHash || ''
    const status = adoptionPlanItemStatus(centralSkillsDir, suggestedSkillId, contentHash)
    return {
      key,
      suggestedSkillId,
      name: first.skillId,
      sourcePath: first.canonicalSourcePath,
      contentHash,
      targets: group.map((entry) => entry.target),
      ...status,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // Multiple physical sources with the same Skill name are safe only when
  // their content is identical. Keep divergent versions visible for explicit
  // handling instead of relying on execution order to allocate a suffix.
  const sameNameGroups = new Map<string, SkillAdoptionPlanItem[]>()
  for (const item of items) {
    const group = sameNameGroups.get(item.suggestedSkillId) || []
    group.push(item)
    sameNameGroups.set(item.suggestedSkillId, group)
  }
  for (const [suggestedSkillId, groups] of sameNameGroups) {
    const hashes = new Set(groups.map((item) => item.contentHash))
    if (hashes.size <= 1) continue
    for (const item of groups) {
      item.status = 'conflict'
      item.reason = `发现多个名为 ${suggestedSkillId} 但内容不同的 Skill。为避免静默覆盖，该项需要单独确认。`
    }
  }

  const totalTargets = items.reduce((sum, item) => sum + item.targets.length, 0)
  const adoptableTargets = items
    .filter((item) => item.status === 'ready')
    .reduce((sum, item) => sum + item.targets.length, 0)
  const conflictTargets = items
    .filter((item) => item.status === 'conflict' || item.status === 'invalid')
    .reduce((sum, item) => sum + item.targets.length, 0)

  return {
    generatedAt: Date.now(),
    projectPaths: Array.from(new Set((options?.projectPaths || []).map((project) => path.resolve(project)))),
    items,
    totalSkills: items.length,
    totalTargets,
    adoptableTargets,
    conflictTargets,
    errors,
  }
}

function updateAdoptedSkillBinding(
  skillId: string,
  target: SkillAdoptionPlanTarget,
  options: SkillInjectionOptions,
): { success: boolean; error?: string } {
  const traceHome = getEffectiveTraceHome(options.traceHome)
  const filePath = path.join(traceHome, 'skills', `${skillId}.json`)
  try {
    const skill = JSON.parse(readFileSync(filePath, 'utf8')) as Skill
    skill.ownership = 'app'
    skill.skillPath = path.join(traceHome, 'skills', skillId)
    skill.updatedLabel = '刚刚纳入'
    if (target.scope === 'global' && target.toolId) {
      const tool = resolveGlobalTool(target.toolId)
      const canonicalToolId = tool?.id || target.toolId
      skill.targetTools = Array.from(new Set([...(skill.targetTools || []), canonicalToolId]))
      skill.scopeStatus = '全局软链'
    } else if (target.scope === 'project' && target.projectPath && target.relPath) {
      const projectPath = path.resolve(target.projectPath)
      skill.targetProjects = Array.from(new Set([...(skill.targetProjects || []), projectPath]))
      skill.targetProjectPaths = Array.from(
        new Map(
          [...(skill.targetProjectPaths || []), { projectPath, relPath: target.relPath }]
            .map((item) => [`${path.resolve(item.projectPath)}\0${item.relPath}`, item] as const),
        ).values(),
      )
      skill.scopeStatus = '项目软链'
    }
    writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
    return { success: true }
  } catch (err: any) {
    return { success: false, error: `保存纳入后的 Skill 关联失败: ${err?.message || String(err)}` }
  }
}

function resolvePlanTargetStatus(target: SkillAdoptionPlanTarget, centralFolder: string) {
  return inspectSkillTarget(target.targetPath, centralFolder, target.contentHash)
}

function linkAdoptedTarget(
  skillId: string,
  target: SkillAdoptionPlanTarget,
  options: SkillInjectionOptions,
): SkillAdoptionTargetResult {
  const traceHome = getEffectiveTraceHome(options.traceHome)
  const centralFolder = path.join(traceHome, 'skills', skillId)
  const current = resolvePlanTargetStatus(target, centralFolder)
  if (current.status === 'conflict' || current.status === 'broken') {
    return { targetPath: target.targetPath, success: false, error: current.error || '目标在预览后发生变化，已保留原内容' }
  }
  if (current.status === 'linked' && isDirectCentralLink(target.targetPath, centralFolder)) {
    const metadata = updateAdoptedSkillBinding(skillId, target, options)
    return metadata.success
      ? { targetPath: target.targetPath, success: true, linkPath: target.targetPath }
      : { targetPath: target.targetPath, success: false, error: metadata.error }
  }

  let backupPath = ''
  let originalLinkTarget = ''
  let createdLink = false
  try {
    mkdirSync(path.dirname(target.targetPath), { recursive: true })
    if (current.exists && current.status === 'external') {
      if (target.contentHash && current.targetPath) {
        const currentHash = tryGetSkillDirectoryFingerprint(current.targetPath)
        if (currentHash !== target.contentHash) {
          return { targetPath: target.targetPath, success: false, error: '目标内容在接管前发生变化，已保留原内容' }
        }
      }
      backupPath = preserveTargetInTrash(target.targetPath, traceHome, `${skillId}-adopt`)
      if (!backupPath) return { targetPath: target.targetPath, success: false, error: '无法备份目标内容，已保留原目标' }
    } else if (current.exists && current.status === 'linked') {
      originalLinkTarget = readlinkSync(target.targetPath)
      unlinkSync(target.targetPath)
    }
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(path.resolve(centralFolder), path.resolve(target.targetPath), symlinkType)
    createdLink = true
    const verified = inspectSkillTarget(target.targetPath, centralFolder)
    if (verified.status !== 'linked') throw new Error('创建后 realpath 校验失败')
    const metadata = updateAdoptedSkillBinding(skillId, target, options)
    if (!metadata.success) {
      try { unlinkSync(target.targetPath) } catch {}
      if (originalLinkTarget) {
        try { symlinkSync(originalLinkTarget, target.targetPath, symlinkType) } catch {}
      } else {
        restoreTargetFromTrash(backupPath, target.targetPath)
      }
      return { targetPath: target.targetPath, success: false, error: metadata.error }
    }
    return { targetPath: target.targetPath, success: true, linkPath: target.targetPath }
  } catch (err: any) {
    if (createdLink) {
      try { unlinkSync(target.targetPath) } catch {}
    }
    if (originalLinkTarget) {
      try {
        symlinkSync(originalLinkTarget, target.targetPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {}
    } else {
      restoreTargetFromTrash(backupPath, target.targetPath)
    }
    return { targetPath: target.targetPath, success: false, error: `创建统一软链接失败: ${err?.message || String(err)}` }
  }
}

/** Execute a previously previewable, idempotent batch Skill adoption. */
export function adoptAllSkills(options?: SkillInjectionOptions): BatchSkillAdoptionResult {
  const plan = buildSkillAdoptionPlan(options)
  const results: BatchSkillAdoptionResult['results'] = []
  let adoptedCount = 0
  let linkedTargetCount = 0
  let failedCount = 0
  let skippedCount = 0

  for (const item of plan.items) {
    if (item.status !== 'ready' || item.targets.length === 0) {
      skippedCount += 1
      results.push({
        key: item.key,
        success: false,
        adopted: false,
        targets: [],
        error: item.reason || '该 Skill 需要单独处理，未执行批量接管',
      })
      continue
    }

    const first = item.targets[0]
    const firstDescriptor: AdoptSkillTarget = {
      type: first.scope,
      toolId: first.toolId,
      projectPath: first.projectPath,
      relPath: first.relPath,
      skillId: first.skillId,
      targetPath: first.targetPath,
    }
    const adopted = adoptSkillAsset(firstDescriptor, options)
    if (!adopted.success || !adopted.skill) {
      failedCount += 1
      results.push({ key: item.key, success: false, adopted: false, targets: [], error: adopted.error || '接管 Skill 失败' })
      continue
    }

    adoptedCount += 1
    const targetResults: SkillAdoptionTargetResult[] = []
    for (const target of item.targets) {
      const result = linkAdoptedTarget(adopted.skill.id, target, options || {})
      targetResults.push(result)
      if (result.success) linkedTargetCount += 1
    }
    const itemSuccess = targetResults.every((result) => result.success)
    if (!itemSuccess) failedCount += 1
    results.push({
      key: item.key,
      skillId: adopted.skill.id,
      success: itemSuccess,
      adopted: true,
      targets: targetResults,
      error: itemSuccess ? undefined : '部分目标未能完成统一软链接',
    })
  }

  return {
    success: failedCount === 0 && plan.errors.length === 0,
    plan,
    results,
    adoptedCount,
    linkedTargetCount,
    failedCount,
    skippedCount,
  }
}

export function disconnectSkillTarget(
  skillId: string,
  target: { scope: 'global' | 'project'; targetId?: string; projectPath?: string; relPath?: string },
  options?: SkillInjectionOptions
): DisconnectSkillResult {
  return uninjectSkillFromTarget(skillId, target, options)
}

export function preserveTargetInTrash(targetPath: string, traceHome: string, prefix: string): string {
  const trashDir = path.join(traceHome, '.trash')
  mkdirSync(trashDir, { recursive: true })
  const backupName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const backupPath = path.join(trashDir, backupName)

  let isSym = false
  try {
    const lstat = lstatSync(targetPath)
    isSym = lstat.isSymbolicLink()
  } catch {
    return ''
  }

  if (isSym) {
    try {
      renameSync(targetPath, backupPath)
      return backupPath
    } catch {
      let linkDest = ''
      try {
        linkDest = readlinkSync(targetPath)
      } catch {}
      if (!linkDest) return ''
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
      try {
        const absoluteDest = path.isAbsolute(linkDest)
          ? linkDest
          : path.resolve(path.dirname(targetPath), linkDest)
        symlinkSync(absoluteDest, backupPath, symlinkType)
      } catch {
        return ''
      }
      try {
        unlinkSync(targetPath)
        return backupPath
      } catch {
        try { unlinkSync(backupPath) } catch {}
        return ''
      }
    }
  } else {
    try {
      renameSync(targetPath, backupPath)
      return backupPath
    } catch {
      try {
        cpSync(targetPath, backupPath, { recursive: true })
        rmSync(targetPath, { recursive: true, force: true })
        try { lstatSync(targetPath); return '' } catch { return backupPath }
      } catch {
        return ''
      }
    }
  }
}

function restoreTargetFromTrash(backupPath: string, targetPath: string): boolean {
  if (!backupPath) return false
  try { lstatSync(backupPath) } catch { return false }
  try {
    const targetStat = lstatSync(targetPath)
    if (targetStat.isSymbolicLink()) unlinkSync(targetPath)
    else rmSync(targetPath, { recursive: true, force: true })
  } catch {}

  try {
    mkdirSync(path.dirname(targetPath), { recursive: true })
    renameSync(backupPath, targetPath)
    return true
  } catch {
    try {
      const backupStat = lstatSync(backupPath)
      if (backupStat.isSymbolicLink()) {
        const linkDest = readlinkSync(backupPath)
        const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
        symlinkSync(linkDest, targetPath, symlinkType)
        unlinkSync(backupPath)
      } else {
        cpSync(backupPath, targetPath, { recursive: true })
        rmSync(backupPath, { recursive: true, force: true })
      }
      return true
    } catch {
      return false
    }
  }
}

export function resolveSkillConflict(
  input: ResolveSkillConflictInput,
  options?: SkillInjectionOptions
): ResolveSkillConflictResult {
  if (!['use_app', 'use_target', 'keep_external'].includes(input.strategy)) {
    return { success: false, error: '无效的冲突解决策略' }
  }

  if (!input.skillId || path.basename(input.skillId) !== input.skillId || input.skillId.includes('..')) {
    return { success: false, error: '技能标识无效，拒绝执行操作' }
  }

  const traceHome = getEffectiveTraceHome(options?.traceHome)
  const skillsDir = path.join(traceHome, 'skills')
  const filePath = path.join(skillsDir, `${input.skillId}.json`)
  const centralFolder = path.join(skillsDir, input.skillId)

  if (!existsSync(filePath) || !existsSync(centralFolder)) {
    return { success: false, error: `Skill 不存在: ${input.skillId}` }
  }

  let skill: Skill
  let previousSkillJsonContent = ''
  try {
    previousSkillJsonContent = readFileSync(filePath, 'utf8')
    skill = JSON.parse(previousSkillJsonContent)
  } catch (err: any) {
    return { success: false, error: `解析 Skill 失败: ${err?.message || String(err)}` }
  }

  const effectiveHome = getEffectiveHomeDir(options?.homeDir)
  let targetLink = ''
  let resolvedProject: string | undefined
  let validatedRelPath: string | undefined

  if (input.target.scope === 'global') {
    if (!input.target.toolId) {
      return { success: false, error: '未指定全局目标工具标识' }
    }
    const tool = DEFAULT_AI_TOOLS.find(
      (t) =>
        t.scope === 'global' && (
          t.id === input.target.toolId ||
          t.id.replace(/-global$/, '') === input.target.toolId ||
          t.compatibleTools?.some((ct) => ct.id === input.target.toolId)
        )
    )
    if (!tool) {
      return { success: false, error: `未找到全局 AI 工具: ${input.target.toolId}` }
    }
    const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)
    targetLink = path.resolve(toolDir, input.skillId)
  } else if (input.target.scope === 'project') {
    const projectPath = input.target.projectPath || options?.defaultProjectWorkspace
    if (!projectPath) {
      return { success: false, error: '未指定有效的项目路径' }
    }
    resolvedProject = path.resolve(projectPath)
    try {
      if (!existsSync(resolvedProject) || !statSync(resolvedProject).isDirectory()) {
        return { success: false, error: `项目路径不存在或不是文件夹: ${projectPath}` }
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }

    const relValidation = validateProjectSkillRelPath(input.target.relPath || '.agents/skills')
    if (!relValidation.valid || !relValidation.normalized) {
      return { success: false, error: relValidation.error || '无效的项目技能相对路径' }
    }
    validatedRelPath = relValidation.normalized
    targetLink = path.resolve(resolvedProject, validatedRelPath, input.skillId)
  } else {
    return { success: false, error: `未知的目标作用域: ${(input.target as any)?.scope}` }
  }

  // Verify that the renderer-supplied path, if present, matches the derived path
  if (input.target.targetPath && path.resolve(input.target.targetPath) !== targetLink) {
    return { success: false, error: '目标路径不匹配受支持的环境规范路径，拒绝执行操作' }
  }

  // Inspect current status of the target
  const inspection = inspectSkillTarget(targetLink, centralFolder)
  if (!inspection.exists) {
    return { success: false, error: '目标路径不存在，无冲突可解决' }
  }
  if (inspection.status === 'linked') {
    return { success: false, error: '目标软链接已正常连接到中心库，无冲突可解决' }
  }
  if (inspection.status === 'unbound') {
    return { success: false, error: '目标未连接且不存在冲突，无需解决' }
  }

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'

  if (input.strategy === 'use_app') {
    // 1. Preserve conflicting target into .trash
    const backupPath = preserveTargetInTrash(targetLink, traceHome, `${input.skillId}-target`)
    if (!backupPath) {
      return { success: false, error: '无法安全备份冲突目标，已保留原目标，未执行覆盖' }
    }

    // 2. Recreate symlink to central folder
    try {
      mkdirSync(path.dirname(targetLink), { recursive: true })
      symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)
      const verified = inspectSkillTarget(targetLink, centralFolder)
      if (verified.status !== 'linked') {
        throw new Error('创建软链接后校验失败')
      }
    } catch (err: any) {
      restoreTargetFromTrash(backupPath, targetLink)
      return { success: false, error: `重新创建中心软链接失败: ${err?.message || String(err)}` }
    }

    // 3. Update central metadata
    if (input.target.scope === 'global') {
      skill.targetTools = Array.from(new Set([...(skill.targetTools || []), input.target.toolId!]))
    } else if (resolvedProject && validatedRelPath) {
      skill.targetProjects = Array.from(new Set([...(skill.targetProjects || []), resolvedProject]))
      skill.targetProjectPaths = [
        ...(skill.targetProjectPaths || []).filter(
          (item) => !(path.resolve(item.projectPath) === resolvedProject && item.relPath === validatedRelPath)
        ),
        { projectPath: resolvedProject, relPath: validatedRelPath },
      ]
    }
    skill.updatedLabel = '刚刚解决冲突'
    try {
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
    } catch (err: any) {
      try { unlinkSync(targetLink) } catch {}
      restoreTargetFromTrash(backupPath, targetLink)
      try { writeFileSync(filePath, previousSkillJsonContent, 'utf8') } catch {}
      return { success: false, error: `保存冲突解决结果失败，已恢复原目标: ${err?.message || String(err)}` }
    }

    return { success: true, skill, backupPath }
  }

  if (input.strategy === 'use_target') {
    // 1. Check if target is readable
    if (inspection.status === 'broken') {
      return { success: false, error: '目标软链接已损坏且无法读取源文件，无法以目标为准。请选择以应用为准或保留外部。' }
    }

    let realTargetDir = targetLink
    try {
      if (lstatSync(targetLink).isSymbolicLink()) {
        realTargetDir = realpathSync(targetLink)
      }
    } catch {
      return { success: false, error: '目标软链接已损坏，无法解析源目录，无法以目标为准。请选择以应用为准或保留外部。' }
    }

    try {
      if (!statSync(realTargetDir).isDirectory()) {
        return { success: false, error: '目标源不是文件夹，无法作为技能源' }
      }
    } catch (err: any) {
      return { success: false, error: `无法访问目标源: ${err?.message || String(err)}` }
    }

    const targetMdPath = path.join(realTargetDir, 'SKILL.md')
    if (!existsSync(targetMdPath)) {
      return { success: false, error: '目标目录中未找到 SKILL.md，无法作为技能源' }
    }

    let targetSkillMd = ''
    try {
      targetSkillMd = readFileSync(targetMdPath, 'utf8')
    } catch (err: any) {
      return { success: false, error: `读取目标 SKILL.md 失败: ${err?.message || String(err)}` }
    }

    // 2. Parse metadata from target SKILL.md
    let targetName = ''
    let targetDesc = ''
    let tags: string[] = []
    let triggers: string[] = []
    const frontmatter = targetSkillMd.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (frontmatter) {
      try {
        const doc = parseDocument(frontmatter[1])
        const parsed = doc.toJS()
        if (parsed && typeof parsed === 'object') {
          if (typeof (parsed as any).name === 'string') targetName = (parsed as any).name.trim()
          if (typeof (parsed as any).description === 'string') targetDesc = (parsed as any).description.trim()
          if (Array.isArray((parsed as any).tags)) tags = (parsed as any).tags.filter((t: any) => typeof t === 'string')
          if (Array.isArray((parsed as any).triggers)) triggers = (parsed as any).triggers.filter((t: any) => typeof t === 'string')
        }
      } catch {}
    }
    if (!targetName) {
      const h1 = targetSkillMd.match(/^#\s+(.+)$/m)
      if (h1) targetName = h1[1].trim()
    }

    // 3. Preserve old central source in .trash before replacing
    const trashDir = path.join(traceHome, '.trash')
    mkdirSync(trashDir, { recursive: true })
    const centralBackupPath = path.join(trashDir, `${input.skillId}-central-${Date.now()}`)
    const previousCentralJsonContent = readFileSync(filePath, 'utf8')
    const centralJsonBackupPath = `${centralBackupPath}.json`
    try {
      cpSync(centralFolder, centralBackupPath, { recursive: true })
      writeFileSync(centralJsonBackupPath, previousCentralJsonContent, 'utf8')
    } catch (err: any) {
      try { rmSync(centralBackupPath, { recursive: true, force: true }) } catch {}
      try { unlinkSync(centralJsonBackupPath) } catch {}
      return { success: false, error: `备份中央技能目录失败: ${err?.message || String(err)}` }
    }

    const restoreCentral = () => {
      try {
        rmSync(centralFolder, { recursive: true, force: true })
        cpSync(centralBackupPath, centralFolder, { recursive: true })
        writeFileSync(filePath, previousCentralJsonContent, 'utf8')
      } catch {}
    }

    // 4. Import target contents into centralFolder
    try {
      rmSync(centralFolder, { recursive: true, force: true })
      mkdirSync(centralFolder, { recursive: true })
      cpSync(realTargetDir, centralFolder, { recursive: true })
    } catch (err: any) {
      // Rollback centralFolder from centralBackupPath
      try {
        rmSync(centralFolder, { recursive: true, force: true })
        cpSync(centralBackupPath, centralFolder, { recursive: true })
      } catch {}
      return { success: false, error: `导入目标技能内容失败: ${err?.message || String(err)}` }
    }

    // 5. Update central metadata JSON
    skill.name = targetName || skill.name
    skill.description = targetDesc || skill.description
    skill.skillMarkdown = targetSkillMd
    if (tags.length > 0) skill.tags = tags
    if (triggers.length > 0) skill.triggers = triggers
    skill.versions = (skill.versions || 1) + 1
    skill.updatedLabel = '刚刚解决冲突'

    if (input.target.scope === 'global') {
      skill.targetTools = Array.from(new Set([...(skill.targetTools || []), input.target.toolId!]))
    } else if (resolvedProject && validatedRelPath) {
      skill.targetProjects = Array.from(new Set([...(skill.targetProjects || []), resolvedProject]))
      skill.targetProjectPaths = [
        ...(skill.targetProjectPaths || []).filter(
          (item) => !(path.resolve(item.projectPath) === resolvedProject && item.relPath === validatedRelPath)
        ),
        { projectPath: resolvedProject, relPath: validatedRelPath },
      ]
    }

    try {
      writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')
    } catch (err: any) {
      restoreCentral()
      return { success: false, error: `写入中央技能元数据失败: ${err?.message || String(err)}` }
    }

    // 6. Replace target with symlink to centralFolder
    const targetBackupPath = preserveTargetInTrash(targetLink, traceHome, `${input.skillId}-target`)
    if (!targetBackupPath) {
      restoreCentral()
      return { success: false, error: '无法安全备份目标技能，已恢复原中央资产，未替换目标' }
    }
    try {
      symlinkSync(path.resolve(centralFolder), path.resolve(targetLink), symlinkType)
      const verified = inspectSkillTarget(targetLink, centralFolder)
      if (verified.status !== 'linked') {
        throw new Error('替换为中央软链接后校验失败')
      }
    } catch (err: any) {
      restoreTargetFromTrash(targetBackupPath, targetLink)
      restoreCentral()
      return { success: false, error: `创建中央软链接失败: ${err?.message || String(err)}` }
    }

    return { success: true, skill, backupPath: centralBackupPath }
  }

  if (input.strategy === 'keep_external') {
    // Leave target completely untouched, and remove only the association from Trace metadata
    if (input.target.scope === 'global') {
      skill.targetTools = (skill.targetTools || []).filter(
        (t) => t !== input.target.toolId && t !== input.target.toolId?.replace(/-global$/, '')
      )
    } else if (resolvedProject && validatedRelPath) {
      skill.targetProjectPaths = (skill.targetProjectPaths || []).filter(
        (item) => !(path.resolve(item.projectPath) === resolvedProject && item.relPath === validatedRelPath)
      )
      const hasOtherInProject = (skill.targetProjectPaths || []).some(
        (item) => path.resolve(item.projectPath) === resolvedProject
      )
      if (!hasOtherInProject) {
        skill.targetProjects = (skill.targetProjects || []).filter((p) => path.resolve(p) !== resolvedProject)
      }
    }
    skill.updatedLabel = '刚刚解决冲突'
    writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8')

    return { success: true, skill }
  }

  return { success: false, error: '未知的冲突解决策略' }
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
              const expectedContentHash = tryGetSkillDirectoryFingerprint(skillFolder)

              // Validate target bindings for global tools
              const bindings: SkillTargetBinding[] = []
              let hasHealthyLink = false
              let hasExternalTarget = false
              let hasConflict = false
              let hasBrokenLink = false

              const linkedTargetIds: string[] = []
              for (const tool of DEFAULT_AI_TOOLS.filter((candidate) => candidate.scope === 'global')) {
                const toolDir = resolveGlobalSkillDirectory(tool, effectiveHome)
                const targetLink = path.join(toolDir, parsed.id)
                const inspection = inspectSkillTarget(targetLink, skillFolder, expectedContentHash)
                bindings.push({
                  scope: 'global',
                  toolId: tool.id,
                  targetPath: targetLink,
                  status: inspection.status,
                  linkTarget: inspection.targetPath,
                  error: inspection.error,
                })
                if (inspection.status === 'linked') {
                  hasHealthyLink = true
                  linkedTargetIds.push(tool.id)
                }
                if (inspection.status === 'external') hasExternalTarget = true
                if (inspection.status === 'conflict') hasConflict = true
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
              } else if (hasExternalTarget) {
                parsed.scopeStatus = '待接管'
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
            if (skill.scopeStatus !== '冲突' && skill.scopeStatus !== '待接管') {
              skill.scopeStatus = '全局软链'
            }
          }
          continue
        }

        // A central record with the same id already owns this physical entry.
        // Keep its per-target binding instead of creating a duplicate external
        // row for the ordinary directory or wrong link.
        if (skillsMap.has(item)) continue

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
