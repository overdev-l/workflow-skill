import type { Skill, ManagedProjectRecord } from '@workflow-skill/workflow-model'

export type SkillScopeTarget = { scope: 'global' } | { scope: 'project'; id: string; name: string; path: string }
export const normalizedProjectPath = (path: string) => path.replace(/[/\\]+$/, '') || '/'
export function skillsInScope(skills: Skill[], target: SkillScopeTarget | null): Skill[] {
  if (!target) return []
  if (target.scope === 'global') return skills
  return skills.filter(skill => skill.targetProjects?.some(path => normalizedProjectPath(path) === normalizedProjectPath(target.path)))
}
interface ScopeApi {
  listManagedProjects: () => Promise<ManagedProjectRecord[]>
  loadLocalSkills: () => Promise<Skill[]>
  saveLocalSkill: (skill: Skill) => Promise<boolean>
  injectSkill: (id: string, target: { scope: 'project'; projectPath: string; relPath: string }) => Promise<{ success: boolean; error?: string }>
}
export async function addSkillToScope(api: ScopeApi, skill: Skill, target: SkillScopeTarget): Promise<void> {
  const validateProject = async () => {
    if (target.scope !== 'project') return
    const project = (await api.listManagedProjects()).find(project => project.id === target.id)
    if (!project || project.status !== 'valid' || normalizedProjectPath(project.path) !== normalizedProjectPath(target.path)) {
      throw new Error('目标项目已移除或目录不可用，请重新选择项目。')
    }
  }
  await validateProject()
  const existing = (await api.loadLocalSkills()).find(item => item.id === skill.id)
  if (!existing && !await api.saveLocalSkill({ ...skill, targetTools: [], targetProjects: [], targetProjectPaths: [] })) {
    throw new Error('保存 Skill 失败，请重试。')
  }
  if (target.scope === 'project') {
    try {
      await validateProject()
      const result = await api.injectSkill(skill.id, { scope: 'project', projectPath: target.path, relPath: '.agents/skills' })
      if (!result.success) throw new Error(result.error || '项目挂载失败')
    } catch (error) {
      throw new Error(`Skill 已保留在全局技能库，尚未添加到项目：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
