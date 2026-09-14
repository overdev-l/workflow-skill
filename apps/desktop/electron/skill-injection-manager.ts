import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_AI_TOOLS, type BatchItemResult, type Skill } from '@workflow-skill/workflow-model'
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

function validateRemovableLink(targetLinkPath: string): { success: boolean; exists: boolean; error?: string } {
  try {
    const target = lstatSync(targetLinkPath)
    if (!target.isSymbolicLink()) {
      return {
        success: false,
        exists: true,
        error: `目标已存在且不是由 Trace 管理的软链接，已保留: ${targetLinkPath}`,
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
      (t) =>
        t.id === target.targetId ||
        t.id.replace(/-global$/, '') === target.targetId ||
        t.compatibleTools?.some((ct) => ct.id === target.targetId)
    )
    if (!tool) {
      return { success: false, error: `未找到全局 AI 工具: ${target.targetId}` }
    }

    const effectiveHome = getEffectiveHomeDir(options?.homeDir)
    const toolDir = tool.customDir
      ? path.isAbsolute(tool.customDir)
        ? tool.customDir
        : path.join(effectiveHome, tool.customDir)
      : path.join(effectiveHome, tool.defaultDir)

    try {
      if (!existsSync(toolDir)) {
        mkdirSync(toolDir, { recursive: true })
      }
      const targetLink = path.join(toolDir, skillId)
      safeRemoveLink(targetLink)
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
      safeRemoveLink(targetLink)
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
      (t) =>
        t.id === target.targetId ||
        t.id.replace(/-global$/, '') === target.targetId ||
        t.compatibleTools?.some((ct) => ct.id === target.targetId)
    )
    if (!tool) {
      return { success: false, error: `未找到全局 AI 工具: ${target.targetId}` }
    }

    const effectiveHome = getEffectiveHomeDir(options?.homeDir)
    const toolDir = tool.customDir
      ? path.isAbsolute(tool.customDir)
        ? tool.customDir
        : path.join(effectiveHome, tool.customDir)
      : path.join(effectiveHome, tool.defaultDir)

    const targetLink = path.join(toolDir, skillId)
    const removable = validateRemovableLink(targetLink)
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
      result: validateRemovableLink(targetLink),
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
