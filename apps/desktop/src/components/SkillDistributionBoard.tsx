import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Download,
  Folder,
  FolderPlus,
  Link2,
  RefreshCw,
  Unlink,
} from 'lucide-react'
import {
  SUPPORTED_PROJECT_SKILL_PATHS,
  type AIToolTarget,
  type ManagedProjectRecord,
  type ProjectSkillPathStatus,
  type Skill,
  type SkillTargetBinding,
} from '@workflow-skill/workflow-model'
import { AIToolLogo } from '../AIToolLogo'
import { useI18n } from '../i18n'

export const getAIToolDisplayName = (tool: AIToolTarget): string => {
  const id = tool.id.toLowerCase()
  if (id.includes('agent')) return 'agents'
  if (id.includes('claude')) return 'Claude Code'
  if (id.includes('cursor')) return 'Cursor'
  if (id.includes('gemini') || id.includes('antigravity')) return 'Antigravity'
  if (id.includes('trae')) return 'Trae'
  if (id.includes('windsurf')) return 'Windsurf'
  if (id.includes('roo')) return 'Roo Code'
  if (id.includes('cline')) return 'Cline'
  if (id.includes('codex') || id.includes('openai')) return 'Codex'
  if (id.includes('opencode')) return 'OpenCode'
  if (id.includes('github') || id.includes('copilot')) return 'GitHub Copilot'
  return tool.name
}

export interface SkillDistributionBoardProps {
  skill: Skill
  aiTools: AIToolTarget[]
  scope: 'global' | 'project'
  onScopeChange?: (scope: 'global' | 'project') => void
  projects?: ManagedProjectRecord[]
  selectedProjectId?: string
  onSelectProjectId?: (projectId: string) => void
  onReloadSkills: () => Promise<void>
  onResolveConflict: (binding: SkillTargetBinding) => void
  onAdoptSkill: () => Promise<void>
  notify?: (msg: string) => void
}

export function SkillDistributionBoard({
  skill,
  aiTools,
  scope,
  onScopeChange,
  projects = [],
  selectedProjectId = '',
  onReloadSkills,
  onResolveConflict,
  onAdoptSkill,
  notify,
}: SkillDistributionBoardProps) {
  const { t } = useI18n()
  const [currentScope, setCurrentScope] = useState<'global' | 'project'>(scope)
  const [busyTargetKey, setBusyTargetKey] = useState<string | null>(null)
  const [adoptingSkill, setAdoptingSkill] = useState(false)
  const [projectPaths, setProjectPaths] = useState<ProjectSkillPathStatus[]>([])

  // Keep scope synced with prop
  useEffect(() => {
    setCurrentScope(scope)
  }, [scope])

  const handleScopeToggle = (newScope: 'global' | 'project') => {
    setCurrentScope(newScope)
    onScopeChange?.(newScope)
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  const refreshProjectPaths = useCallback(async () => {
    if (!selectedProject?.path || !window.workflowSkill?.scanProjectSkillPaths) {
      setProjectPaths([])
      return
    }
    try {
      const res = await window.workflowSkill.scanProjectSkillPaths(selectedProject.path)
      if (Array.isArray(res)) {
        setProjectPaths(res)
      }
    } catch {
      setProjectPaths([])
    }
  }, [selectedProject?.path])

  useEffect(() => {
    if (currentScope === 'project') {
      void refreshProjectPaths()
    }
  }, [currentScope, refreshProjectPaths])

  // Filter global tools
  const globalTools = aiTools.filter((t) => t.scope === 'global' || !t.scope)

  // Calculate linked counts
  const globalLinkedCount = globalTools.filter((tool) => {
    const binding = skill.targetBindings?.find(
      (b) => b.scope === 'global' && (b.toolId === tool.id || b.toolId === tool.id.replace(/-global$/, '')),
    )
    if (binding) return binding.status === 'linked'
    return Boolean(
      skill.targetTools?.includes(tool.id) ||
      skill.targetTools?.includes(tool.id.replace(/-global$/, '')),
    )
  }).length

  const projectLinkedCount = SUPPORTED_PROJECT_SKILL_PATHS.filter((sp) => {
    if (!selectedProject?.path) return false
    const binding = skill.targetBindings?.find(
      (b) =>
        b.scope === 'project' &&
        b.projectPath?.toLowerCase() === selectedProject.path.toLowerCase() &&
        b.relPath === sp.relPath,
    )
    if (binding) return binding.status === 'linked'
    return Boolean(
      skill.targetProjectPaths?.some(
        (item) =>
          item.projectPath.toLowerCase() === selectedProject.path.toLowerCase() &&
          item.relPath === sp.relPath,
      ),
    )
  }).length

  // Global action handler
  const handleGlobalAction = async (
    tool: AIToolTarget,
    status: 'linked' | 'external' | 'conflict' | 'broken' | 'unbound',
    isReady: boolean,
    binding?: SkillTargetBinding,
  ) => {
    const targetKey = `global:${tool.id}`
    if (busyTargetKey) return

    if (status === 'conflict') {
      if (binding) {
        onResolveConflict(binding)
      } else {
        notify?.(`${getAIToolDisplayName(tool)} 存在内容冲突，请在冲突管理中处理`)
      }
      return
    }

    setBusyTargetKey(targetKey)
    const displayName = getAIToolDisplayName(tool)

    try {
      if (status === 'linked') {
        let res: { success: boolean; error?: string }
        if (window.workflowSkill?.uninjectSkill) {
          res = await window.workflowSkill.uninjectSkill(skill.id, {
            scope: 'global',
            targetId: tool.id,
          })
        } else if (window.workflowSkill?.unlinkSkillTarget) {
          const r = await window.workflowSkill.unlinkSkillTarget(skill.id, tool.id)
          res = { success: r?.success !== false, error: (r as any)?.error }
        } else {
          throw new Error('API 不可用')
        }

        if (!res.success) {
          notify?.(res.error || `从 ${displayName} 断开失败`)
          return
        }
        notify?.(t.skills.toastUnlinkedSuccess(displayName))
        await onReloadSkills()
      } else if (status === 'external') {
        if (!window.workflowSkill?.adoptSkill) throw new Error('接管 API 不可用')
        const bindingSkillId = binding?.targetPath.split(/[\\/]/).filter(Boolean).pop()
        const res = await window.workflowSkill.adoptSkill({
          type: 'global',
          toolId: tool.id,
          skillId: bindingSkillId || skill.id,
          targetPath: binding?.targetPath,
        })
        if (!res.success) {
          notify?.(res.error || `接管 ${displayName} 失败`)
          return
        }
        notify?.(t.skills.toastAdoptSuccess(displayName))
        await onReloadSkills()
      } else if (status === 'broken') {
        if (!window.workflowSkill?.injectSkill) throw new Error('连接 API 不可用')
        const res = await window.workflowSkill.injectSkill(skill.id, {
          scope: 'global',
          targetId: tool.id,
        })
        if (!res.success) {
          notify?.(res.error || `修复 ${displayName} 软链失败`)
          return
        }
        notify?.(t.skills.toastFixSuccess(displayName))
        await onReloadSkills()
      } else {
        // unbound
        let res: { success: boolean; error?: string }
        if (window.workflowSkill?.injectSkill) {
          res = await window.workflowSkill.injectSkill(skill.id, {
            scope: 'global',
            targetId: tool.id,
          })
        } else if (window.workflowSkill?.linkSkillTarget) {
          const r = await window.workflowSkill.linkSkillTarget(skill.id, tool.id)
          res = { success: r?.success !== false, error: r?.error }
        } else {
          throw new Error('API 不可用')
        }

        if (!res.success) {
          notify?.(
            res.error ||
              (isReady ? `连接到 ${displayName} 失败` : `挂载并连接到 ${displayName} 失败`),
          )
          return
        }
        notify?.(
          isReady
            ? t.skills.toastLinkedSuccess(displayName)
            : t.skills.toastMountLinkedSuccess(displayName),
        )
        await onReloadSkills()
      }
    } catch (err: any) {
      notify?.(err?.message || `操作失败`)
    } finally {
      setBusyTargetKey(null)
    }
  }

  // Project action handler
  const handleProjectAction = async (
    sp: (typeof SUPPORTED_PROJECT_SKILL_PATHS)[number],
    status: 'linked' | 'external' | 'conflict' | 'broken' | 'unbound',
    exists: boolean,
    binding?: SkillTargetBinding,
  ) => {
    if (!selectedProject?.path) return
    const targetKey = `project:${selectedProject.path}:${sp.relPath}`
    if (busyTargetKey) return

    if (status === 'conflict') {
      if (binding) {
        onResolveConflict(binding)
      } else {
        notify?.(`${selectedProject.name}/${sp.relPath} 存在内容冲突，请在冲突管理中处理`)
      }
      return
    }

    setBusyTargetKey(targetKey)
    const targetName = `${selectedProject.name}/${sp.relPath}`

    try {
      if (status === 'linked') {
        let res: { success: boolean; error?: string }
        if (window.workflowSkill?.uninjectSkill) {
          res = await window.workflowSkill.uninjectSkill(skill.id, {
            scope: 'project',
            projectPath: selectedProject.path,
            relPath: sp.relPath,
          })
        } else if (window.workflowSkill?.unlinkSkillProject) {
          const r = await window.workflowSkill.unlinkSkillProject(skill.id, selectedProject.path)
          res = { success: r?.success !== false }
        } else {
          throw new Error('API 不可用')
        }

        if (!res.success) {
          notify?.(res.error || `从 ${targetName} 断开失败`)
          return
        }
        notify?.(t.skills.toastUnlinkedSuccess(targetName))
        await onReloadSkills()
        await refreshProjectPaths()
      } else if (status === 'external') {
        if (!window.workflowSkill?.adoptSkill) throw new Error('接管 API 不可用')
        const bindingSkillId = binding?.targetPath.split(/[\\/]/).filter(Boolean).pop()
        const res = await window.workflowSkill.adoptSkill({
          type: 'project',
          projectPath: selectedProject.path,
          relPath: sp.relPath,
          skillId: bindingSkillId || skill.id,
          targetPath: binding?.targetPath,
        })
        if (!res.success) {
          notify?.(res.error || `接管 ${targetName} 失败`)
          return
        }
        notify?.(t.skills.toastAdoptSuccess(targetName))
        await onReloadSkills()
        await refreshProjectPaths()
      } else if (status === 'broken') {
        if (!window.workflowSkill?.injectSkill) throw new Error('连接 API 不可用')
        const res = await window.workflowSkill.injectSkill(skill.id, {
          scope: 'project',
          projectPath: selectedProject.path,
          relPath: sp.relPath,
        })
        if (!res.success) {
          notify?.(res.error || `修复 ${targetName} 软链失败`)
          return
        }
        notify?.(t.skills.toastFixSuccess(targetName))
        await onReloadSkills()
        await refreshProjectPaths()
      } else {
        // unbound
        let res: { success: boolean; error?: string }
        if (window.workflowSkill?.injectSkill) {
          res = await window.workflowSkill.injectSkill(skill.id, {
            scope: 'project',
            projectPath: selectedProject.path,
            relPath: sp.relPath,
          })
        } else if (window.workflowSkill?.linkSkillProject) {
          const r = await window.workflowSkill.linkSkillProject(skill.id, selectedProject.path)
          res = { success: r?.success !== false }
        } else {
          throw new Error('API 不可用')
        }

        if (!res.success) {
          notify?.(
            res.error ||
              (exists ? `连接到 ${targetName} 失败` : `挂载并连接到 ${targetName} 失败`),
          )
          return
        }
        notify?.(
          exists
            ? t.skills.toastLinkedSuccess(targetName)
            : t.skills.toastMountLinkedSuccess(targetName),
        )
        await onReloadSkills()
        await refreshProjectPaths()
      }
    } catch (err: any) {
      notify?.(err?.message || `操作失败`)
    } finally {
      setBusyTargetKey(null)
    }
  }

  // If skill is external (not managed by Trace)
  if (skill.ownership === 'external') {
    return (
      <div className="skill-dist-board">
        <div className="skill-dist-header">
          <div className="skill-dist-header__left">
            <Link2 size={14} style={{ color: 'var(--color-muted)' }} />
            <h3 className="skill-dist-title">{t.skills.distributionTitle}</h3>
          </div>
        </div>
        <div className="skill-dist-external-notice">
          <p>{t.skills.externalSkillNotice}</p>
          <button
            type="button"
            className="btn btn--primary btn--capsule btn--sm"
            disabled={adoptingSkill}
            onClick={async () => {
              setAdoptingSkill(true)
              try {
                await onAdoptSkill()
              } finally {
                setAdoptingSkill(false)
              }
            }}
          >
            {adoptingSkill ? (
              <RefreshCw size={11} className="spin" />
            ) : (
              <Download size={11} />
            )}
            <span>{adoptingSkill ? '正在纳入…' : '纳入应用管理'}</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="skill-dist-board">
      {/* Header with Title, Count pill and Scope Switcher */}
      <div className="skill-dist-header">
        <div className="skill-dist-header__left">
          <Link2 size={14} style={{ color: 'var(--color-muted)' }} />
          <h3 className="skill-dist-title">{t.skills.distributionTitle}</h3>
          <span className="skill-dist-count-pill font-mono">
            {currentScope === 'global'
              ? t.skills.distributionLinkedCount(globalLinkedCount, globalTools.length)
              : t.skills.distributionLinkedCount(
                  projectLinkedCount,
                  SUPPORTED_PROJECT_SKILL_PATHS.length,
                )}
          </span>
        </div>

        <div className="master-tab-segmented" style={{ height: '24px' }}>
          <button
            type="button"
            className={`master-tab-btn ${currentScope === 'global' ? 'is-active' : ''}`}
            onClick={() => handleScopeToggle('global')}
          >
            {t.skills.distributionScopeGlobal}
          </button>
          <button
            type="button"
            className={`master-tab-btn ${currentScope === 'project' ? 'is-active' : ''}`}
            onClick={() => handleScopeToggle('project')}
          >
            {t.skills.distributionScopeProject}
          </button>
        </div>
      </div>

      {/* Target Environments List */}
      <div className="skill-dist-list">
        {currentScope === 'global' ? (
          globalTools.map((tool) => {
            const isReady =
              tool.pendingMount === true
                ? false
                : tool.skillsDirExists !== undefined
                ? tool.skillsDirExists
                : Boolean(tool.installed)

            const binding = skill.targetBindings?.find(
              (b) =>
                b.scope === 'global' &&
                (b.toolId === tool.id || b.toolId === tool.id.replace(/-global$/, '')),
            )
            const isDirectlyLinked = Boolean(
              skill.targetTools?.includes(tool.id) ||
                skill.targetTools?.includes(tool.id.replace(/-global$/, '')),
            )

            const status: 'linked' | 'external' | 'conflict' | 'broken' | 'unbound' =
              binding ? binding.status : isDirectlyLinked ? 'linked' : 'unbound'

            const displayStatus =
              status === 'unbound' && !isReady ? 'pendingMount' : status

            const targetKey = `global:${tool.id}`
            const isBusy = busyTargetKey === targetKey
            const displayName = getAIToolDisplayName(tool)
            const toolPath = tool.detectedPath || tool.defaultDir

            return (
              <div
                key={tool.id}
                className={`skill-dist-item ${
                  status === 'linked'
                    ? 'is-linked'
                    : status === 'conflict'
                    ? 'is-conflict'
                    : status === 'broken'
                    ? 'is-broken'
                    : ''
                }`}
              >
                <div className="skill-dist-item__main">
                  <div className="skill-dist-item__logo">
                    <AIToolLogo toolId={tool.id} size={16} />
                  </div>
                  <div className="skill-dist-item__copy">
                    <div className="skill-dist-item__title-row">
                      <span className="skill-dist-item__name">{displayName}</span>
                      <span className="skill-dist-item__readiness">
                        {isReady
                          ? t.skills.readinessReady(tool.itemCount ?? 0)
                          : t.skills.readinessPendingMount}
                      </span>
                      <span className={`skill-dist-status-pill is-${displayStatus}`}>
                        {displayStatus === 'linked'
                          ? t.skills.statusLinked
                          : displayStatus === 'external'
                          ? t.skills.statusExternal
                          : displayStatus === 'conflict'
                          ? t.skills.statusConflict
                          : displayStatus === 'broken'
                          ? t.skills.statusBroken
                          : displayStatus === 'pendingMount'
                          ? t.skills.statusPendingMount
                          : t.skills.statusUnbound}
                      </span>
                    </div>
                    <span className="skill-dist-item__path font-mono" title={toolPath}>
                      {toolPath}
                    </span>
                  </div>
                </div>

                <div className="skill-dist-item__actions">
                  <button
                    type="button"
                    disabled={Boolean(busyTargetKey)}
                    className={`btn btn--capsule btn--sm ${
                      status === 'linked' || status === 'external' || status === 'broken'
                        ? 'btn--secondary'
                        : 'btn--primary'
                    }`}
                    title={
                      !isReady && status === 'unbound'
                        ? t.skills.mountAndLinkGlobalTooltip(toolPath)
                        : undefined
                    }
                    onClick={() => void handleGlobalAction(tool, status, isReady, binding)}
                  >
                    {isBusy ? (
                      <RefreshCw size={11} className="spin" />
                    ) : status === 'linked' ? (
                      <Unlink size={11} />
                    ) : status === 'external' ? (
                      <Download size={11} />
                    ) : status === 'conflict' ? (
                      <AlertTriangle size={11} />
                    ) : status === 'broken' ? (
                      <RefreshCw size={11} />
                    ) : !isReady ? (
                      <FolderPlus size={11} />
                    ) : (
                      <Link2 size={11} />
                    )}
                    <span>
                      {status === 'linked'
                        ? t.skills.actionUnlink
                        : status === 'external'
                        ? t.skills.actionAdopt
                        : status === 'conflict'
                        ? t.skills.actionResolveConflict
                        : status === 'broken'
                        ? t.skills.actionFixLink
                        : !isReady
                        ? t.skills.actionMountAndLink
                        : t.skills.actionLink}
                    </span>
                  </button>
                </div>
              </div>
            )
          })
        ) : !selectedProject ? (
          <div className="skill-dist-empty-note">
            <Folder size={20} style={{ margin: '0 auto 6px auto', opacity: 0.5 }} />
            <p style={{ margin: 0 }}>{t.skills.noProjectSelected}</p>
          </div>
        ) : selectedProject.status === 'missing' ? (
          <div className="skill-dist-empty-note">
            <AlertTriangle size={20} style={{ margin: '0 auto 6px auto', color: 'var(--color-danger)' }} />
            <p style={{ margin: 0 }}>{t.skills.projectMissingNotice(selectedProject.path)}</p>
          </div>
        ) : (
          SUPPORTED_PROJECT_SKILL_PATHS.map((sp) => {
            const pathInfo = projectPaths.find((p) => p.relPath === sp.relPath)
            const exists = pathInfo?.exists ?? false
            const skillCount = pathInfo?.skillCount ?? 0

            const binding = skill.targetBindings?.find(
              (b) =>
                b.scope === 'project' &&
                b.projectPath?.toLowerCase() === selectedProject.path.toLowerCase() &&
                b.relPath === sp.relPath,
            )
            const isDirectlyLinked = Boolean(
              skill.targetProjectPaths?.some(
                (item) =>
                  item.projectPath.toLowerCase() === selectedProject.path.toLowerCase() &&
                  item.relPath === sp.relPath,
              ),
            )

            const status: 'linked' | 'external' | 'conflict' | 'broken' | 'unbound' =
              binding ? binding.status : isDirectlyLinked ? 'linked' : 'unbound'

            const displayStatus =
              status === 'unbound' && !exists ? 'pendingMount' : status

            const targetKey = `project:${selectedProject.path}:${sp.relPath}`
            const isBusy = busyTargetKey === targetKey
            const fullPath = pathInfo?.fullPath || `${selectedProject.path}/${sp.relPath}`
            const displayRelPath = `${selectedProject.name}/${sp.relPath}`

            return (
              <div
                key={sp.id}
                className={`skill-dist-item ${
                  status === 'linked'
                    ? 'is-linked'
                    : status === 'conflict'
                    ? 'is-conflict'
                    : status === 'broken'
                    ? 'is-broken'
                    : ''
                }`}
              >
                <div className="skill-dist-item__main">
                  <div className="skill-dist-item__logo">
                    <AIToolLogo toolId={sp.id} size={16} />
                  </div>
                  <div className="skill-dist-item__copy">
                    <div className="skill-dist-item__title-row">
                      <span className="skill-dist-item__name">{sp.name}</span>
                      <span className="skill-dist-item__readiness">
                        {exists
                          ? t.skills.readinessReady(skillCount)
                          : t.skills.readinessPendingMount}
                      </span>
                      <span className={`skill-dist-status-pill is-${displayStatus}`}>
                        {displayStatus === 'linked'
                          ? t.skills.statusLinked
                          : displayStatus === 'external'
                          ? t.skills.statusExternal
                          : displayStatus === 'conflict'
                          ? t.skills.statusConflict
                          : displayStatus === 'broken'
                          ? t.skills.statusBroken
                          : displayStatus === 'pendingMount'
                          ? t.skills.statusPendingMount
                          : t.skills.statusUnbound}
                      </span>
                    </div>
                    <span className="skill-dist-item__path font-mono" title={fullPath}>
                      {displayRelPath}
                    </span>
                  </div>
                </div>

                <div className="skill-dist-item__actions">
                  <button
                    type="button"
                    disabled={Boolean(busyTargetKey)}
                    className={`btn btn--capsule btn--sm ${
                      status === 'linked' || status === 'external' || status === 'broken'
                        ? 'btn--secondary'
                        : 'btn--primary'
                    }`}
                    title={
                      !exists && status === 'unbound'
                        ? t.skills.mountAndLinkProjectTooltip(
                            selectedProject.name,
                            sp.relPath,
                          )
                        : undefined
                    }
                    onClick={() => void handleProjectAction(sp, status, exists, binding)}
                  >
                    {isBusy ? (
                      <RefreshCw size={11} className="spin" />
                    ) : status === 'linked' ? (
                      <Unlink size={11} />
                    ) : status === 'external' ? (
                      <Download size={11} />
                    ) : status === 'conflict' ? (
                      <AlertTriangle size={11} />
                    ) : status === 'broken' ? (
                      <RefreshCw size={11} />
                    ) : !exists ? (
                      <FolderPlus size={11} />
                    ) : (
                      <Link2 size={11} />
                    )}
                    <span>
                      {status === 'linked'
                        ? t.skills.actionUnlink
                        : status === 'external'
                        ? t.skills.actionAdopt
                        : status === 'conflict'
                        ? t.skills.actionResolveConflict
                        : status === 'broken'
                        ? t.skills.actionFixLink
                        : !exists
                        ? t.skills.actionMountAndLink
                        : t.skills.actionLink}
                    </span>
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
