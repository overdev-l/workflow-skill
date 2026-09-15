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
  const central = path.join(traceHome, 'skills')
  try {
    for (const file of readdirSync(central).sort()) {
      if (!file.endsWith('.json')) continue
      try {
        const skill = JSON.parse(readFileSync(path.join(central, file), 'utf8')) as Skill
        if (!skill || typeof skill.id !== 'string' || file !== `${skill.id}.json` || path.basename(skill.id) !== skill.id) continue
        const source = realpathSync(path.join(central, skill.id))
        if (!managed.has(source)) managed.set(source, skill)
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
      try {
        if (!statSync(entry).isDirectory()) continue
        const source = realpathSync(entry)
        const mdPath = path.join(source, 'SKILL.md')
        // Ordinary directories without SKILL.md are not skills.
        try { lstatSync(mdPath) } catch (error) { if (missing(error)) continue; throw error }
        const markdown = readFileSync(mdPath, 'utf8')
        const existing = bySource.get(source)
        if (existing) { existing.projectSource!.relativePaths.push(relativePath); continue }
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
        const record = managed.get(source)
        const id = record?.id || `project:${createHash('sha256').update(canonicalProject + '\0' + source).digest('hex')}`
        const skillName = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : name
        const description = typeof metadata.description === 'string' ? metadata.description : ''
        bySource.set(source, {
          id, name: skillName, description, apps: strings(record?.apps), updatedLabel: '项目本地',
          pinned: Boolean(record?.pinned), sourceRuns: record?.sourceRuns || 0, versions: record?.versions || 1,
          workflow: record?.workflow && Array.isArray(record.workflow.nodes) && Array.isArray(record.workflow.edges)
            ? record.workflow : { id: `wf-${id}`, name: skillName, summary: description, repeatCount: 0,
              estimatedMinutes: 0, confidence: 0, nodes: [], edges: [] },
          targetTools: strings(record?.targetTools), targetProjects: [project],
          tags: strings(metadata.tags), triggers: strings(metadata.triggers),
          skillPath: source, skillMarkdown: markdown,
          projectSource: { projectPath: project, relativePaths: [relativePath], ...(record ? { managedSkillId: record.id } : {}) },
        })
      } catch (error) { errors.push(`${relativePath}：${message(error)}`) }
    }
  }
  return { skills: [...bySource.values()], errors }
}
