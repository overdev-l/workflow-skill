import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ProjectRecord, ProjectSkillPathStatus } from '@workflow-skill/workflow-model'

export const SUPPORTED_PROJECT_SKILL_PATHS: Array<{ id: string; name: string; relPath: string }> = [
  { id: 'agents', name: '.agents 通用规范', relPath: path.join('.agents', 'skills') },
  { id: 'claude', name: 'Claude Code', relPath: path.join('.claude', 'skills') },
  { id: 'cursor', name: 'Cursor IDE', relPath: path.join('.cursor', 'skills') },
  { id: 'github', name: 'GitHub Copilot', relPath: path.join('.github', 'skills') },
  { id: 'trae', name: 'Trae IDE', relPath: path.join('.trae', 'skills') },
  { id: 'gemini', name: 'Google Antigravity & Gemini', relPath: path.join('.gemini', 'skills') },
]

export function getEffectiveTraceHome(customTraceHome?: string): string {
  if (customTraceHome) return customTraceHome
  return path.join(os.homedir(), '.trace')
}

interface StoredConfig {
  projects?: ProjectRecord[]
  activeProjectId?: string | null
  projectWorkspace?: string | null
  [key: string]: unknown
}

function readConfig(traceHome: string): StoredConfig {
  const configPath = path.join(traceHome, 'config.json')
  let config: StoredConfig = {}
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (parsed && typeof parsed === 'object') config = parsed
    }
  } catch {}

  // Migrate legacy valid projectWorkspace into projects list if not already present
  if (config.projectWorkspace && typeof config.projectWorkspace === 'string') {
    try {
      const legacyPath = path.resolve(config.projectWorkspace)
      if (existsSync(legacyPath) && statSync(legacyPath).isDirectory()) {
        const projects = config.projects || []
        const exists = projects.some((p) => p.path && path.resolve(p.path) === legacyPath)
        if (!exists) {
          const migrated: ProjectRecord = {
            id: `legacy-${path.basename(legacyPath).toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${Date.now()}`,
            name: path.basename(legacyPath),
            path: legacyPath,
            addedAt: Date.now(),
          }
          projects.push(migrated)
          config.projects = projects
          if (!config.activeProjectId) {
            config.activeProjectId = migrated.id
          }
          writeConfig(traceHome, config)
        }
      }
    } catch {}
  }

  return config
}

function writeConfig(traceHome: string, config: StoredConfig): void {
  if (!existsSync(traceHome)) {
    mkdirSync(traceHome, { recursive: true })
  }
  const configPath = path.join(traceHome, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

export function listProjects(customTraceHome?: string): ProjectRecord[] {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const config = readConfig(traceHome)
  const list = config.projects || []
  return list.filter((p) => {
    try {
      return Boolean(p.path && existsSync(p.path) && statSync(p.path).isDirectory())
    } catch {
      return false
    }
  })
}

export function getActiveProject(customTraceHome?: string): ProjectRecord | null {
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const config = readConfig(traceHome)
  const validProjects = listProjects(traceHome)

  if (config.activeProjectId) {
    const found = validProjects.find(
      (p) => p.id === config.activeProjectId || path.resolve(p.path) === path.resolve(config.activeProjectId!)
    )
    if (found) return found
  }

  // Fallback to legacy projectWorkspace if present and valid
  if (config.projectWorkspace) {
    const found = validProjects.find((p) => path.resolve(p.path) === path.resolve(config.projectWorkspace!))
    if (found) return found
  }

  return validProjects[0] || null
}

export function getStoredProjectWorkspace(customTraceHome?: string): string {
  const active = getActiveProject(customTraceHome)
  return active?.path || ''
}

export function setActiveProject(
  projectIdOrPath: string,
  customTraceHome?: string
): { success: boolean; project?: ProjectRecord; error?: string } {
  if (!projectIdOrPath) {
    return { success: false, error: '项目路径不能为空' }
  }
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const resolved = path.resolve(projectIdOrPath)
  const projects = listProjects(traceHome)

  let matched = projects.find((p) => p.id === projectIdOrPath || path.resolve(p.path) === resolved)
  if (!matched) {
    // If exists as a directory on disk, add it automatically
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const added = addProject(resolved, traceHome)
      if (!added.success || !added.project) {
        return { success: false, error: added.error || '添加项目失败' }
      }
      matched = added.project
    } else {
      return { success: false, error: `项目路径不存在或无效: ${projectIdOrPath}` }
    }
  }

  const config = readConfig(traceHome)
  config.activeProjectId = matched.id
  config.projectWorkspace = matched.path
  writeConfig(traceHome, config)

  return { success: true, project: matched }
}

export function addProject(
  targetPath: string,
  customTraceHome?: string
): { success: boolean; project?: ProjectRecord; error?: string } {
  if (!targetPath) {
    return { success: false, error: '项目路径不能为空' }
  }

  const resolved = path.resolve(targetPath)
  try {
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      return { success: false, error: `指定的目录不存在或不是文件夹: ${targetPath}` }
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }

  const traceHome = getEffectiveTraceHome(customTraceHome)
  const config = readConfig(traceHome)
  const projects = config.projects || []

  const existingIndex = projects.findIndex((p) => path.resolve(p.path) === resolved)
  const projectName = path.basename(resolved) || resolved

  let project: ProjectRecord
  if (existingIndex >= 0) {
    project = {
      ...projects[existingIndex],
      name: projectName,
      path: resolved,
    }
    projects[existingIndex] = project
  } else {
    project = {
      id: resolved,
      name: projectName,
      path: resolved,
      addedAt: Date.now(),
    }
    projects.push(project)
  }

  config.projects = projects
  config.activeProjectId = project.id
  config.projectWorkspace = project.path
  writeConfig(traceHome, config)

  return { success: true, project }
}

export function removeProject(
  projectIdOrPath: string,
  customTraceHome?: string
): { success: boolean; error?: string } {
  if (!projectIdOrPath) return { success: false, error: '未指定要移除的项目' }
  const traceHome = getEffectiveTraceHome(customTraceHome)
  const config = readConfig(traceHome)
  const resolved = path.resolve(projectIdOrPath)

  const initialCount = (config.projects || []).length
  config.projects = (config.projects || []).filter(
    (p) => p.id !== projectIdOrPath && path.resolve(p.path) !== resolved
  )

  if (config.projects.length === initialCount) {
    return { success: false, error: '未在项目列表中找到该项目' }
  }

  if (config.activeProjectId === projectIdOrPath || config.activeProjectId === resolved) {
    config.activeProjectId = config.projects[0]?.id || null
    config.projectWorkspace = config.projects[0]?.path || null
  }

  writeConfig(traceHome, config)
  return { success: true }
}

export function scanProjectSkillPaths(projectPath: string): ProjectSkillPathStatus[] {
  if (!projectPath || !existsSync(projectPath)) return []

  return SUPPORTED_PROJECT_SKILL_PATHS.map((item) => {
    const fullPath = path.join(projectPath, item.relPath)
    let exists = false
    let skillCount = 0

    try {
      if (existsSync(fullPath)) {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          exists = true
          const entries = readdirSync(fullPath)
          skillCount = entries.filter((e) => !e.startsWith('.')).length
        }
      }
    } catch {}

    return {
      id: item.id,
      name: item.name,
      relPath: item.relPath,
      fullPath,
      exists,
      skillCount,
    }
  })
}

export function ensureProjectSkillPath(projectPath: string, relPath: string): string {
  if (!projectPath || !existsSync(projectPath)) {
    throw new Error(`Invalid project path: ${projectPath}`)
  }
  const target = path.join(projectPath, relPath)
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true })
  }
  return target
}
