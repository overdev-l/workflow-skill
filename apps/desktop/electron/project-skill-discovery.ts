import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { ProjectSkillDiscoveryResult, Skill } from '@workflow-skill/workflow-model'
import { SUPPORTED_PROJECT_SKILL_PATHS } from './project-manager.ts'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Discover physical project assets without importing or changing any source. */
export function discoverProjectSkills(projectPath: string, traceHome: string): ProjectSkillDiscoveryResult {
  const project = path.resolve(projectPath)
  const canonicalProject = realpathSync(project)
  if (!statSync(project).isDirectory()) throw new Error('项目路径不是目录')
  // Probe readability even when none of the supported skill directories exist.
  readdirSync(project)
  const errors: string[] = []
  const bySource = new Map<string, Skill>()
  const managed = new Map<string, Skill>()
  const managedById = new Map<string, Skill>()
  const central = path.join(traceHome, 'skills')
  try {
    for (const file of readdirSync(central).sort()) {
      if (!file.endsWith('.json')) continue
      try {
        const skill = JSON.parse(readFileSync(path.join(central, file), 'utf8')) as Skill
        if (!skill || typeof skill.id !== 'string' || file !== `${skill.id}.json` || path.basename(skill.id) !== skill.id) continue
        const source = realpathSync(path.join(central, skill.id))
        if (!managed.has(source)) managed.set(source, skill)
        if (!managedById.has(skill.id)) managedById.set(skill.id, skill)
      } catch { /* Invalid central records do not prevent read-only local discovery. */ }
    }
  } catch (error) {
    if (!missing(error)) errors.push(`读取中心库关联失败：${message(error)}`)
  }

  for (const { relPath } of SUPPORTED_PROJECT_SKILL_PATHS) {
    const directory = path.join(project, relPath)
    try { lstatSync(directory) } catch (error) {
      if (!missing(error)) errors.push(`${relPath}：${message(error)}`)
      continue
    }
    let entries: string[]
    try { entries = readdirSync(directory).sort() } catch (error) {
      errors.push(`${relPath}：${message(error)}`)
      continue
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const entry = path.join(directory, name)
      const relativePath = path.join(relPath, name)
      const expectedManagedSkill = managedById.get(name)
      const expectedManagedSource = expectedManagedSkill ? path.join(central, expectedManagedSkill.id) : undefined
      const addConflictBinding = (status: 'conflict' | 'broken', linkTarget?: string) => {
        if (!expectedManagedSkill || !expectedManagedSource) return
        const existing = bySource.get(expectedManagedSource)
        const binding = {
          scope: 'project' as const,
          projectPath: project,
          relPath,
          targetPath: entry,
          status,
          linkTarget,
          error: status === 'broken' ? '软链接指向不存在的目标路径' : '目标未指向应用中央 Skill',
        }
        if (existing) {
          existing.targetBindings?.push(binding)
          existing.projectSource?.relativePaths.push(relativePath)
          return
        }
        let centralMarkdown = expectedManagedSkill.skillMarkdown || ''
        try { centralMarkdown = readFileSync(path.join(expectedManagedSource, 'SKILL.md'), 'utf8') } catch {}
        bySource.set(expectedManagedSource, {
          ...expectedManagedSkill,
          updatedLabel: status === 'broken' ? '链接损坏' : '冲突',
          skillPath: expectedManagedSource,
          skillMarkdown: centralMarkdown,
          ownership: 'app',
          scopeStatus: status === 'broken' ? '链接损坏' : '冲突',
          sourcePath: expectedManagedSource,
          targetBindings: [binding],
          projectSource: { projectPath: project, relativePaths: [relativePath], managedSkillId: expectedManagedSkill.id },
        })
      }
      try {
        let isSym = false
        try {
          const entryLstat = lstatSync(entry)
          isSym = entryLstat.isSymbolicLink()
        } catch (error) {
          if (!missing(error)) errors.push(`${relativePath}：${message(error)}`)
          continue
        }

        let source: string
        try {
          if (!statSync(entry).isDirectory()) continue
          source = realpathSync(entry)
        } catch (error) {
          if (isSym) {
            addConflictBinding('broken')
            if (expectedManagedSkill) continue
            errors.push(`${relativePath}：软链接损坏或目标不存在`)
          } else if (!missing(error)) {
            addConflictBinding('conflict')
            if (expectedManagedSkill) continue
            errors.push(`${relativePath}：${message(error)}`)
          }
          continue
        }

        const mdPath = path.join(source, 'SKILL.md')
        // Ordinary directories without SKILL.md are not skills.
        try { lstatSync(mdPath) } catch (error) { if (missing(error)) continue; throw error }
        const markdown = readFileSync(mdPath, 'utf8')
        const existing = bySource.get(source)
        if (existing) {
          existing.projectSource!.relativePaths.push(relativePath)
          existing.targetBindings?.push({
            scope: 'project',
            projectPath: project,
            relPath,
            targetPath: entry,
            status: existing.ownership === 'app' ? 'linked' : 'external',
            linkTarget: isSym ? source : undefined,
          })
          continue
        }
        let metadata: Record<string, unknown> = {}
        const frontmatter = markdown.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
        if (frontmatter) {
          try {
            const document = parseDocument(frontmatter[1])
            if (document.errors.length) throw document.errors[0]
            const parsed = document.toJS({ maxAliasCount: 100 })
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
          } catch (error) { errors.push(`${relativePath} 元数据解析失败，已保留原文：${message(error)}`) }
        }
        const record = isSym ? managed.get(source) : undefined
        const isAppManaged = Boolean(record)
        if (expectedManagedSkill && !isAppManaged) {
          addConflictBinding('conflict', isSym ? source : undefined)
          continue
        }
        const id = record?.id || `project:${createHash('sha256').update(canonicalProject + '\0' + source).digest('hex')}`
        const skillName = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : name
        const description = typeof metadata.description === 'string' ? metadata.description : ''
        bySource.set(source, {
          id, name: skillName, description, apps: strings(record?.apps), updatedLabel: isAppManaged ? '应用管理' : '外部持有',
          pinned: Boolean(record?.pinned), sourceRuns: record?.sourceRuns || 0, versions: record?.versions || 1,
          workflow: record?.workflow && Array.isArray(record.workflow.nodes) && Array.isArray(record.workflow.edges)
            ? record.workflow : { id: `wf-${id}`, name: skillName, summary: description, repeatCount: 0,
              estimatedMinutes: 0, confidence: 0, nodes: [], edges: [] },
          targetTools: strings(record?.targetTools), targetProjects: [project],
          tags: strings(metadata.tags), triggers: strings(metadata.triggers),
          skillPath: source, skillMarkdown: markdown,
          ownership: isAppManaged ? 'app' : 'external',
          scopeStatus: isAppManaged ? '项目软链' : '外部持有',
          sourcePath: isAppManaged ? path.join(central, record!.id) : entry,
          externalSource: !isAppManaged ? {
            type: 'project',
            projectPath: project,
            relPath,
            fullPath: entry,
            isSymlink: isSym,
            symlinkTarget: isSym ? source : undefined,
          } : undefined,
          targetBindings: [{
            scope: 'project',
            projectPath: project,
            relPath,
            targetPath: entry,
            status: isAppManaged ? 'linked' : 'external',
            linkTarget: isSym ? source : undefined,
          }],
          projectSource: { projectPath: project, relativePaths: [relativePath], ...(isAppManaged ? { managedSkillId: record!.id } : {}) },
        })
      } catch (error) { errors.push(`${relativePath}：${message(error)}`) }
    }
  }
  return { skills: [...bySource.values()], errors }
}
