import { useEffect, useState } from 'react'
import type { ProjectSkillDiscoveryResult } from '@workflow-skill/workflow-model'

export function useProjectSkills(projectPath: string | null) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<ProjectSkillDiscoveryResult & { path: string | null; loading: boolean }>({
    path: null, skills: [], errors: [], loading: false,
  })
  useEffect(() => {
    if (!projectPath) return
    let active = true
    let generation = 0
    const refresh = async () => {
      const current = ++generation
      setState({ path: projectPath, skills: [], errors: [], loading: true })
      try {
        if (!window.workflowSkill?.discoverProjectSkills) throw new Error('项目 Skill 扫描暂不可用，请重新启动应用。')
        const result = await window.workflowSkill.discoverProjectSkills(projectPath)
        if (active && generation === current) setState({ ...result, path: projectPath, loading: false })
      } catch (error) {
        if (active && generation === current) setState({ path: projectPath, skills: [], loading: false,
          errors: [error instanceof Error ? error.message : '读取项目 Skill 失败'] })
      }
    }
    void refresh()
    const onRefresh = () => void refresh()
    const offSkills = window.workflowSkill?.onSkillsChanged?.(onRefresh)
    const offProjects = window.workflowSkill?.onProjectsChanged?.(onRefresh)
    window.addEventListener('focus', onRefresh)
    return () => { active = false; generation++; offSkills?.(); offProjects?.(); window.removeEventListener('focus', onRefresh) }
  }, [projectPath, revision])
  const current = projectPath !== null && state.path === projectPath
  return {
    skills: current ? state.skills : [],
    errors: current ? state.errors : [],
    loading: Boolean(projectPath) && (!current || state.loading),
    refresh: () => setRevision(value => value + 1),
  }
}
