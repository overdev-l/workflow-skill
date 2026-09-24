import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Folder,
  FolderOpen,
  Key,
  Layers,
  RefreshCw,
  Server,
  Sparkles,
  X,
} from 'lucide-react'
import {
  ONBOARDING_STEP_ORDER,
  type OnboardingMcpCandidate,
  type OnboardingMcpMigrationResult,
  type OnboardingSkillCandidate,
  type OnboardingSkillMigrationRequest,
  type OnboardingSkillMigrationResult,
  type OnboardingStepCounts,
  type OnboardingStepId,
  type OnboardingStepOutcome,
  type ProjectRecord,
} from '@workflow-skill/workflow-model'
import { OnboardingShaderBackground } from './OnboardingShaderBackground'
import './OnboardingWizard.css'

export interface OnboardingWizardProps {
  onFinished: () => void
}

interface StepFeedback {
  migratedCount: number
  failedCount: number
  failures: Array<{ label: string; error: string }>
}

/**
 * Strategy semantics follow the shared adoption engine (see ConflictResolutionDialog):
 * - use_app    keep the central library version, target becomes a symlink to it
 * - use_target overwrite the central library with the version found on disk
 * - rename     import alongside under a suffixed central id
 */
type ConflictStrategy = 'use_app' | 'use_target' | 'rename'

const DEFAULT_CONFLICT_STRATEGY: ConflictStrategy = 'use_app'

const CONFLICT_STRATEGY_OPTIONS: Array<{ id: ConflictStrategy; label: string; hint: string }> = [
  { id: 'use_app', label: '保留中心库', hint: '中心库版本不变，原目录内容备份到回收目录后改为软链' },
  { id: 'use_target', label: '用本地版覆盖', hint: '用扫描到的版本覆盖中心库，旧版本已备份' },
  { id: 'rename', label: '重命名导入', hint: '两个版本都保留，本次导入使用带后缀的新标识' },
]

export function OnboardingWizard({ onFinished }: OnboardingWizardProps): JSX.Element {
  // Step state (0: global-skills, 1: global-mcp, 2: select-project, 3: project-assets)
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0)
  const [completedSteps, setCompletedSteps] = useState<Set<OnboardingStepId>>(new Set())
  const [busy, setBusy] = useState<boolean>(false)
  const [globalError, setGlobalError] = useState<string | null>(null)

  // Step 1: Global Skills State
  const [globalSkills, setGlobalSkills] = useState<OnboardingSkillCandidate[]>([])
  const [selectedGlobalSkillPaths, setSelectedGlobalSkillPaths] = useState<Set<string>>(new Set())
  const [globalSkillConflicts, setGlobalSkillConflicts] = useState<Record<string, ConflictStrategy>>({})
  const [globalSkillFeedback, setGlobalSkillFeedback] = useState<StepFeedback | null>(null)

  // Step 2: Global MCP State
  const [globalMcps, setGlobalMcps] = useState<OnboardingMcpCandidate[]>([])
  const [selectedGlobalMcpIds, setSelectedGlobalMcpIds] = useState<Set<string>>(new Set())
  const [globalMcpFeedback, setGlobalMcpFeedback] = useState<StepFeedback | null>(null)

  // Step 3: Project Selection State
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null)
  const [projectStepSkipped, setProjectStepSkipped] = useState<boolean>(false)

  // Step 4: Project Assets State
  const [projectAssetsTab, setProjectAssetsTab] = useState<'skills' | 'mcp'>('skills')
  const [projectSkills, setProjectSkills] = useState<OnboardingSkillCandidate[]>([])
  const [selectedProjectSkillPaths, setSelectedProjectSkillPaths] = useState<Set<string>>(new Set())
  const [projectSkillConflicts, setProjectSkillConflicts] = useState<Record<string, ConflictStrategy>>({})
  const [projectMcps, setProjectMcps] = useState<OnboardingMcpCandidate[]>([])
  const [selectedProjectMcpIds, setSelectedProjectMcpIds] = useState<Set<string>>(new Set())
  const [projectAssetsFeedback, setProjectAssetsFeedback] = useState<StepFeedback | null>(null)
  const [projectAssetsScanned, setProjectAssetsScanned] = useState<boolean>(false)

  const currentStepId = ONBOARDING_STEP_ORDER[currentStepIndex]

  // Safe helper to persist step outcomes
  const recordStepOutcome = async (
    stepId: OnboardingStepId,
    outcome: OnboardingStepOutcome,
    counts?: OnboardingStepCounts
  ) => {
    try {
      if (window.workflowSkill?.setOnboardingStep) {
        await window.workflowSkill.setOnboardingStep(stepId, outcome, counts)
      }
      setCompletedSteps((prev) => new Set([...prev, stepId]))
    } catch (err: any) {
      setGlobalError(err?.message || `持久化步骤 ${stepId} 状态失败`)
    }
  }

  // 1. Initial Scan: Global Skills on mount
  useEffect(() => {
    let active = true
    const scanGlobalSkills = async () => {
      setBusy(true)
      setGlobalError(null)
      try {
        if (!window.workflowSkill?.scanGlobalSkillCandidates) {
          throw new Error('当前环境未暴露 scanGlobalSkillCandidates API')
        }
        const candidates = await window.workflowSkill.scanGlobalSkillCandidates()
        if (!active) return
        setGlobalSkills(candidates)

        // Select all candidates that are not already linked by default
        const initialSelected = new Set<string>()
        const initialConflicts: Record<string, ConflictStrategy> = {}
        for (const c of candidates) {
          if (!c.alreadyLinked) {
            initialSelected.add(c.absolutePath)
          }
          if (c.conflictsWithCentralId) {
            initialConflicts[c.absolutePath] = DEFAULT_CONFLICT_STRATEGY
          }
        }
        setSelectedGlobalSkillPaths(initialSelected)
        setGlobalSkillConflicts(initialConflicts)
      } catch (err: any) {
        if (active) setGlobalError(err?.message || '扫描全局技能候选失败')
      } finally {
        if (active) setBusy(false)
      }
    }

    scanGlobalSkills()
    return () => {
      active = false
    }
  }, [])

  // 2. Scan Global MCP when moving to step 1
  useEffect(() => {
    if (currentStepIndex !== 1 || globalMcps.length > 0) return
    let active = true
    const scanGlobalMcp = async () => {
      setBusy(true)
      setGlobalError(null)
      try {
        if (!window.workflowSkill?.scanGlobalMcpCandidates) {
          throw new Error('当前环境未暴露 scanGlobalMcpCandidates API')
        }
        const candidates = await window.workflowSkill.scanGlobalMcpCandidates()
        if (!active) return
        setGlobalMcps(candidates)

        // Select all unmanaged candidates by default
        const initialSelected = new Set<string>()
        for (const m of candidates) {
          if (!m.alreadyManaged) {
            initialSelected.add(m.serverId)
          }
        }
        setSelectedGlobalMcpIds(initialSelected)
      } catch (err: any) {
        if (active) setGlobalError(err?.message || '扫描全局 MCP 候选失败')
      } finally {
        if (active) setBusy(false)
      }
    }

    scanGlobalMcp()
    return () => {
      active = false
    }
  }, [currentStepIndex, globalMcps.length])

  // 4. Scan Project Assets when moving to step 3 (if project is selected)
  useEffect(() => {
    if (currentStepIndex !== 3 || projectStepSkipped || !selectedProject || projectAssetsScanned) return
    let active = true
    const scanProjectAssets = async () => {
      setBusy(true)
      setGlobalError(null)
      try {
        const [skills, mcps] = await Promise.all([
          window.workflowSkill?.scanProjectSkillCandidates
            ? window.workflowSkill.scanProjectSkillCandidates(selectedProject.path)
            : Promise.resolve([]),
          window.workflowSkill?.scanProjectMcpCandidates
            ? window.workflowSkill.scanProjectMcpCandidates(selectedProject.path)
            : Promise.resolve([]),
        ])
        if (!active) return
        setProjectSkills(skills)
        setProjectMcps(mcps)

        const initialSelectedSkills = new Set<string>()
        const initialConflicts: Record<string, ConflictStrategy> = {}
        for (const s of skills) {
          if (!s.alreadyLinked) {
            initialSelectedSkills.add(s.absolutePath)
          }
          if (s.conflictsWithCentralId) {
            initialConflicts[s.absolutePath] = DEFAULT_CONFLICT_STRATEGY
          }
        }
        setSelectedProjectSkillPaths(initialSelectedSkills)
        setProjectSkillConflicts(initialConflicts)

        const initialSelectedMcps = new Set<string>()
        for (const m of mcps) {
          if (!m.alreadyManaged) {
            initialSelectedMcps.add(m.serverId)
          }
        }
        setSelectedProjectMcpIds(initialSelectedMcps)
        setProjectAssetsScanned(true)
      } catch (err: any) {
        if (active) setGlobalError(err?.message || '扫描项目资产失败')
      } finally {
        if (active) setBusy(false)
      }
    }

    scanProjectAssets()
    return () => {
      active = false
    }
  }, [currentStepIndex, projectStepSkipped, selectedProject, projectAssetsScanned])

  // Group global skills by sourceLabel
  const globalSkillGroups = useMemo(() => {
    const map: Record<string, OnboardingSkillCandidate[]> = {}
    for (const s of globalSkills) {
      const label = s.sourceLabel || '其他'
      if (!map[label]) map[label] = []
      map[label].push(s)
    }
    return Object.entries(map)
  }, [globalSkills])

  // Handlers for Step 1: Global Skills
  const handleToggleGlobalSkill = (path: string) => {
    setSelectedGlobalSkillPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleGlobalSkillConflictChange = (path: string, strategy: ConflictStrategy) => {
    setGlobalSkillConflicts((prev) => ({
      ...prev,
      [path]: strategy,
    }))
  }

  const handleSkipGlobalSkills = async () => {
    setBusy(true)
    try {
      await recordStepOutcome('global-skills', 'skipped', {
        skippedCount: globalSkills.length,
      })
      setCurrentStepIndex(1)
    } finally {
      setBusy(false)
    }
  }

  const handleMigrateGlobalSkills = async () => {
    if (selectedGlobalSkillPaths.size === 0) {
      await handleSkipGlobalSkills()
      return
    }
    setBusy(true)
    setGlobalError(null)
    try {
      if (!window.workflowSkill?.migrateOnboardingSkills) {
        throw new Error('当前环境未暴露 migrateOnboardingSkills API')
      }
      const requests: OnboardingSkillMigrationRequest[] = Array.from(selectedGlobalSkillPaths).map(
        (path) => {
          const candidate = globalSkills.find((s) => s.absolutePath === path)
          const conflictStrategy = candidate?.conflictsWithCentralId
            ? globalSkillConflicts[path] || DEFAULT_CONFLICT_STRATEGY
            : undefined
          return {
            absolutePath: path,
            conflictStrategy,
          }
        }
      )

      const results: OnboardingSkillMigrationResult[] =
        await window.workflowSkill.migrateOnboardingSkills(requests)

      const failures: Array<{ label: string; error: string }> = []
      let migratedCount = 0
      for (const r of results) {
        if (r.ok) {
          migratedCount++
        } else {
          const matched = globalSkills.find((s) => s.absolutePath === r.absolutePath)
          failures.push({
            label: matched?.skillName || r.absolutePath,
            error: r.error || '技能迁移失败',
          })
        }
      }

      const failedCount = failures.length
      const feedback: StepFeedback = {
        migratedCount,
        failedCount,
        failures,
      }
      setGlobalSkillFeedback(feedback)

      const outcome: OnboardingStepOutcome = failedCount > 0 ? 'partial' : 'migrated'
      await recordStepOutcome('global-skills', outcome, {
        migratedCount,
        failedCount,
        skippedCount: globalSkills.length - requests.length,
      })

      // If all selected migrated without any failure, advance to step 2 automatically
      if (failedCount === 0) {
        setCurrentStepIndex(1)
      }
    } catch (err: any) {
      setGlobalError(err?.message || '执行全局技能迁移失败')
    } finally {
      setBusy(false)
    }
  }

  // Handlers for Step 2: Global MCP
  const handleToggleGlobalMcp = (serverId: string) => {
    setSelectedGlobalMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(serverId)) next.delete(serverId)
      else next.add(serverId)
      return next
    })
  }

  const handleSkipGlobalMcp = async () => {
    setBusy(true)
    try {
      await recordStepOutcome('global-mcp', 'skipped', {
        skippedCount: globalMcps.length,
      })
      setCurrentStepIndex(2)
    } finally {
      setBusy(false)
    }
  }

  const handleMigrateGlobalMcp = async () => {
    if (selectedGlobalMcpIds.size === 0) {
      await handleSkipGlobalMcp()
      return
    }
    setBusy(true)
    setGlobalError(null)
    try {
      if (!window.workflowSkill?.migrateOnboardingMcp) {
        throw new Error('当前环境未暴露 migrateOnboardingMcp API')
      }
      const serverIds = Array.from(selectedGlobalMcpIds)
      const results: OnboardingMcpMigrationResult[] =
        await window.workflowSkill.migrateOnboardingMcp(serverIds)

      const failures: Array<{ label: string; error: string }> = []
      let migratedCount = 0
      for (const r of results) {
        if (r.ok) {
          migratedCount++
        } else {
          const matched = globalMcps.find((m) => m.serverId === r.serverId)
          failures.push({
            label: matched?.serverName || r.serverId,
            error: r.error || 'MCP 服务迁移失败',
          })
        }
      }

      const failedCount = failures.length
      const feedback: StepFeedback = {
        migratedCount,
        failedCount,
        failures,
      }
      setGlobalMcpFeedback(feedback)

      const outcome: OnboardingStepOutcome = failedCount > 0 ? 'partial' : 'migrated'
      await recordStepOutcome('global-mcp', outcome, {
        migratedCount,
        failedCount,
        skippedCount: globalMcps.length - serverIds.length,
      })

      if (failedCount === 0) {
        setCurrentStepIndex(2)
      }
    } catch (err: any) {
      setGlobalError(err?.message || '执行全局 MCP 迁移失败')
    } finally {
      setBusy(false)
    }
  }

  // Handlers for Step 3: Select Project
  const handleSelectProjectFolder = async () => {
    setBusy(true)
    setGlobalError(null)
    try {
      if (!window.workflowSkill?.selectOnboardingProject) {
        throw new Error('当前环境未暴露 selectOnboardingProject API')
      }
      const project = await window.workflowSkill.selectOnboardingProject()
      if (project) {
        setSelectedProject(project)
        setProjectStepSkipped(false)
        setProjectAssetsScanned(false)
      }
      // If project is null, user cancelled dialog, stay on current step.
    } catch (err: any) {
      setGlobalError(err?.message || '选择项目失败')
    } finally {
      setBusy(false)
    }
  }

  const handleSkipProjectSelection = async () => {
    setBusy(true)
    try {
      setSelectedProject(null)
      setProjectStepSkipped(true)
      await recordStepOutcome('select-project', 'skipped')
      setCurrentStepIndex(3)
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmProjectSelection = async () => {
    if (!selectedProject) return
    setBusy(true)
    try {
      await recordStepOutcome('select-project', 'migrated')
      setCurrentStepIndex(3)
    } finally {
      setBusy(false)
    }
  }

  // Handlers for Step 4: Project Assets
  const handleToggleProjectSkill = (path: string) => {
    setSelectedProjectSkillPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleProjectSkillConflictChange = (path: string, strategy: ConflictStrategy) => {
    setProjectSkillConflicts((prev) => ({
      ...prev,
      [path]: strategy,
    }))
  }

  const handleToggleProjectMcp = (serverId: string) => {
    setSelectedProjectMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(serverId)) next.delete(serverId)
      else next.add(serverId)
      return next
    })
  }

  const handleFinishAll = async (stepOutcome: OnboardingStepOutcome, counts?: OnboardingStepCounts) => {
    setBusy(true)
    try {
      await recordStepOutcome('project-assets', stepOutcome, counts)
      if (window.workflowSkill?.completeOnboarding) {
        await window.workflowSkill.completeOnboarding()
      }
      onFinished()
    } catch (err: any) {
      setGlobalError(err?.message || '完成引导流程失败')
    } finally {
      setBusy(false)
    }
  }

  const handleSkipProjectAssets = async () => {
    await handleFinishAll('skipped', {
      skippedCount: projectSkills.length + projectMcps.length,
    })
  }

  const handleMigrateProjectAssets = async () => {
    setBusy(true)
    setGlobalError(null)
    try {
      const failures: Array<{ label: string; error: string }> = []
      let migratedCount = 0

      // Migrate project skills
      if (selectedProjectSkillPaths.size > 0 && window.workflowSkill?.migrateOnboardingSkills) {
        const skillReqs: OnboardingSkillMigrationRequest[] = Array.from(selectedProjectSkillPaths).map(
          (path) => {
            const candidate = projectSkills.find((s) => s.absolutePath === path)
            const conflictStrategy = candidate?.conflictsWithCentralId
              ? projectSkillConflicts[path] || DEFAULT_CONFLICT_STRATEGY
              : undefined
            return {
              absolutePath: path,
              conflictStrategy,
            }
          }
        )
        const skillResults = await window.workflowSkill.migrateOnboardingSkills(skillReqs)
        for (const r of skillResults) {
          if (r.ok) {
            migratedCount++
          } else {
            const matched = projectSkills.find((s) => s.absolutePath === r.absolutePath)
            failures.push({
              label: `[技能] ${matched?.skillName || r.absolutePath}`,
              error: r.error || '技能迁移失败',
            })
          }
        }
      }

      // Migrate project MCPs
      if (selectedProjectMcpIds.size > 0 && window.workflowSkill?.migrateOnboardingMcp) {
        const mcpResults = await window.workflowSkill.migrateOnboardingMcp(
          Array.from(selectedProjectMcpIds)
        )
        for (const r of mcpResults) {
          if (r.ok) {
            migratedCount++
          } else {
            const matched = projectMcps.find((m) => m.serverId === r.serverId)
            failures.push({
              label: `[MCP] ${matched?.serverName || r.serverId}`,
              error: r.error || 'MCP 服务迁移失败',
            })
          }
        }
      }

      const failedCount = failures.length
      const feedback: StepFeedback = {
        migratedCount,
        failedCount,
        failures,
      }
      setProjectAssetsFeedback(feedback)

      const outcome: OnboardingStepOutcome = failedCount > 0 ? 'partial' : 'migrated'
      const counts: OnboardingStepCounts = {
        migratedCount,
        failedCount,
        skippedCount:
          projectSkills.length + projectMcps.length - (selectedProjectSkillPaths.size + selectedProjectMcpIds.size),
      }

      // If no failures, finish immediately
      if (failedCount === 0) {
        await handleFinishAll(outcome, counts)
      } else {
        // If failures exist, persist step outcome so far and let user review before clicking complete
        await recordStepOutcome('project-assets', outcome, counts)
      }
    } catch (err: any) {
      setGlobalError(err?.message || '迁移项目资产失败')
    } finally {
      setBusy(false)
    }
  }

  // Navigation: Go back to previous step
  const handlePrevStep = () => {
    if (currentStepIndex > 0) {
      setGlobalError(null)
      setCurrentStepIndex(currentStepIndex - 1)
    }
  }

  // Step names for stepper
  const stepTitles = ['全局技能', '全局 MCP', '选择项目', '项目资产']

  return (
    <div className="onboarding-wizard-container">
      {/* Background Shader Layer */}
      <OnboardingShaderBackground />

      {/* Content Surface Layer */}
      <div className="onboarding-wizard-dialog" role="dialog" aria-modal="true">
        {/* Top Header & 4-Step Stepper */}
        <header className="onboarding-header">
          <div className="onboarding-header__top">
            <div className="onboarding-header__title-wrap">
              <div className="onboarding-header__logo">
                <Sparkles size={16} />
              </div>
              <h2 className="onboarding-header__title">初始化配置向导</h2>
            </div>
          </div>

          {/* Stepper Navigation */}
          <div className="onboarding-stepper">
            {stepTitles.map((title, idx) => {
              const stepId = ONBOARDING_STEP_ORDER[idx]
              const isActive = idx === currentStepIndex
              const isCompleted = completedSteps.has(stepId) || idx < currentStepIndex
              return (
                <div
                  key={stepId}
                  className={`onboarding-step-item ${isActive ? 'is-active' : ''} ${
                    isCompleted ? 'is-completed' : ''
                  }`}
                >
                  <div className="onboarding-step-indicator">
                    {isCompleted && !isActive ? <Check size={11} /> : idx + 1}
                  </div>
                  <span className="onboarding-step-label">{title}</span>
                  {idx < stepTitles.length - 1 && <div className="onboarding-step-line" />}
                </div>
              )
            })}
          </div>
        </header>

        {/* Global Error Banner */}
        {globalError && (
          <div className="onboarding-error-banner" role="alert">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={14} />
              <span>{globalError}</span>
            </div>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setGlobalError(null)}
              aria-label="关闭错误提示"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Wizard Main Body */}
        <main className="onboarding-body">
          {/* STEP 1: Global Skills */}
          {currentStepIndex === 0 && (
            <>
              <div className="onboarding-step-lead">
                <h3 className="onboarding-step-title">迁移全局 AI 技能资产</h3>
                <p className="onboarding-step-desc">
                  从已安装的全局 AI 工具（Agents / Codex / Claude）扫描可纳管技能并导入中央资产库。
                </p>
              </div>

              {/* Feedback Summary if available */}
              {globalSkillFeedback && (
                <div
                  className={`onboarding-feedback-card ${
                    globalSkillFeedback.failedCount > 0 ? 'is-partial' : 'is-success'
                  }`}
                >
                  <div className="onboarding-feedback-title">
                    {globalSkillFeedback.failedCount > 0 ? (
                      <>
                        <AlertCircle size={14} />
                        <span>
                          部分技能迁移完成：成功 {globalSkillFeedback.migratedCount} 项，失败{' '}
                          {globalSkillFeedback.failedCount} 项
                        </span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={14} />
                        <span>已成功迁移 {globalSkillFeedback.migratedCount} 项技能</span>
                      </>
                    )}
                  </div>
                  {globalSkillFeedback.failures.length > 0 && (
                    <ul className="onboarding-feedback-failures">
                      {globalSkillFeedback.failures.map((f, i) => (
                        <li key={i}>
                          <strong>{f.label}：</strong>
                          <span>{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {globalSkills.length === 0 && !busy ? (
                <div className="onboarding-empty-notice">
                  <Layers size={24} />
                  <span>未发现可迁移的全局技能资产。</span>
                </div>
              ) : (
                globalSkillGroups.map(([groupLabel, items]) => (
                  <div key={groupLabel} className="onboarding-group-card">
                    <div className="onboarding-group-header">
                      <span className="onboarding-group-title">{groupLabel}</span>
                      <span className="onboarding-group-count">{items.length} 个候选</span>
                    </div>
                    <div className="onboarding-item-list">
                      {items.map((item) => {
                        const isSelected = selectedGlobalSkillPaths.has(item.absolutePath)
                        const isConflict = Boolean(item.conflictsWithCentralId)
                        const currentStrategy =
                          globalSkillConflicts[item.absolutePath] || DEFAULT_CONFLICT_STRATEGY

                        return (
                          <div
                            key={item.absolutePath}
                            className={`onboarding-item-row ${
                              item.alreadyLinked ? 'is-disabled' : ''
                            }`}
                          >
                            <div className="onboarding-item-left">
                              <input
                                type="checkbox"
                                className="onboarding-item-checkbox"
                                checked={!item.alreadyLinked && isSelected}
                                disabled={item.alreadyLinked || busy}
                                onChange={() => handleToggleGlobalSkill(item.absolutePath)}
                              />
                              <div className="onboarding-item-info">
                                <span className="onboarding-item-name">{item.skillName}</span>
                                <span className="onboarding-item-sub font-mono">
                                  {item.absolutePath}
                                </span>
                              </div>
                            </div>

                            <div className="onboarding-item-right">
                              {item.alreadyLinked && (
                                <span className="onboarding-badge onboarding-badge--neutral">
                                  已接管
                                </span>
                              )}

                              {isConflict && !item.alreadyLinked && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span className="onboarding-badge onboarding-badge--warning">
                                    冲突
                                  </span>
                                  {/* Conflict 3-choice Segmented Switcher (24px height) */}
                                  <div
                                    className="onboarding-segmented-tab-container"
                                    role="tablist"
                                    aria-label="冲突策略选择"
                                  >
                                    {CONFLICT_STRATEGY_OPTIONS.map((option) => (
                                      <button
                                        key={option.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={currentStrategy === option.id}
                                        title={option.hint}
                                        className={`onboarding-segmented-tab-btn ${
                                          currentStrategy === option.id ? 'is-active' : ''
                                        }`}
                                        disabled={busy}
                                        onClick={() =>
                                          handleGlobalSkillConflictChange(item.absolutePath, option.id)
                                        }
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {/* STEP 2: Global MCP */}
          {currentStepIndex === 1 && (
            <>
              <div className="onboarding-step-lead">
                <h3 className="onboarding-step-title">接入全局 MCP 服务</h3>
                <p className="onboarding-step-desc">
                  纳管外部工具配置的 MCP 服务，敏感凭据将自动迁移并隔离存放至系统原生钥匙串中。
                </p>
              </div>

              {/* Feedback Summary if available */}
              {globalMcpFeedback && (
                <div
                  className={`onboarding-feedback-card ${
                    globalMcpFeedback.failedCount > 0 ? 'is-partial' : 'is-success'
                  }`}
                >
                  <div className="onboarding-feedback-title">
                    {globalMcpFeedback.failedCount > 0 ? (
                      <>
                        <AlertCircle size={14} />
                        <span>
                          部分 MCP 服务迁移完成：成功 {globalMcpFeedback.migratedCount} 项，失败{' '}
                          {globalMcpFeedback.failedCount} 项
                        </span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={14} />
                        <span>已成功接入 {globalMcpFeedback.migratedCount} 项 MCP 服务</span>
                      </>
                    )}
                  </div>
                  {globalMcpFeedback.failures.length > 0 && (
                    <ul className="onboarding-feedback-failures">
                      {globalMcpFeedback.failures.map((f, i) => (
                        <li key={i}>
                          <strong>{f.label}：</strong>
                          <span>{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {globalMcps.length === 0 && !busy ? (
                <div className="onboarding-empty-notice">
                  <Server size={24} />
                  <span>未发现可纳管的全局 MCP 服务。</span>
                </div>
              ) : (
                <div className="onboarding-group-card">
                  <div className="onboarding-group-header">
                    <span className="onboarding-group-title">发现的 MCP 服务</span>
                    <span className="onboarding-group-count">{globalMcps.length} 个服务</span>
                  </div>
                  <div className="onboarding-item-list">
                    {globalMcps.map((candidate) => {
                      const isSelected = selectedGlobalMcpIds.has(candidate.serverId)

                      return (
                        <div
                          key={candidate.serverId}
                          className={`onboarding-item-row ${
                            candidate.alreadyManaged ? 'is-disabled' : ''
                          }`}
                        >
                          <div className="onboarding-item-left">
                            <input
                              type="checkbox"
                              className="onboarding-item-checkbox"
                              checked={!candidate.alreadyManaged && isSelected}
                              disabled={candidate.alreadyManaged || busy}
                              onChange={() => handleToggleGlobalMcp(candidate.serverId)}
                            />
                            <div className="onboarding-item-info">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className="onboarding-item-name">{candidate.serverName}</span>
                                <span className="onboarding-badge onboarding-badge--neutral">
                                  {candidate.sourceToolId}
                                </span>
                                <span className="onboarding-badge onboarding-badge--neutral">
                                  {candidate.transport}
                                </span>
                              </div>

                              {/* Secrets Notice & Desensitized Field Paths */}
                              {candidate.hasSecrets && (
                                <div className="onboarding-mcp-secrets">
                                  <span className="onboarding-badge onboarding-badge--key">
                                    <Key size={10} />
                                    含鉴权凭据，将存入系统钥匙串
                                  </span>
                                  {candidate.secretFieldPaths?.length > 0 && (
                                    <div className="onboarding-secret-tags font-mono">
                                      {candidate.secretFieldPaths.map((fp) => (
                                        <span key={fp} className="onboarding-secret-tag">
                                          {fp}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="onboarding-item-right">
                            {candidate.alreadyManaged && (
                              <span className="onboarding-badge onboarding-badge--neutral">
                                已纳管
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {/* STEP 3: Select Project */}
          {currentStepIndex === 2 && (
            <>
              <div className="onboarding-step-lead">
                <h3 className="onboarding-step-title">选择工作区项目</h3>
                <p className="onboarding-step-desc">
                  绑定一个正在开发的代码工程文件夹，以支持项目范围专有的 Skills 和 MCP 配置。
                </p>
              </div>

              {!selectedProject ? (
                <div className="onboarding-project-card">
                  <div className="onboarding-project-icon-box">
                    <Folder size={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                      尚未绑定本地项目工程
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 2 }}>
                      选择工程文件夹后，向导将扫描并导入该项目专有的 Skills 及 MCP 配置
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={handleSelectProjectFolder}
                  >
                    <FolderOpen size={13} style={{ marginRight: 6 }} />
                    选择项目文件夹
                  </button>
                </div>
              ) : (
                <div className="onboarding-project-selected-card">
                  <div className="onboarding-project-selected-info">
                    <div className="onboarding-project-icon-box">
                      <Folder size={20} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                        {selectedProject.name}
                      </div>
                      <div
                        className="font-mono"
                        style={{
                          fontSize: 11,
                          color: 'var(--color-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          marginTop: 2,
                        }}
                      >
                        {selectedProject.path}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={busy}
                    onClick={handleSelectProjectFolder}
                  >
                    重新选择
                  </button>
                </div>
              )}
            </>
          )}

          {/* STEP 4: Project Assets */}
          {currentStepIndex === 3 && (
            <>
              <div className="onboarding-step-lead">
                <h3 className="onboarding-step-title">导入项目专有资产</h3>
                <p className="onboarding-step-desc">
                  {selectedProject
                    ? `从工程「${selectedProject.name}」中扫描出项目特定的技能与 MCP 配置。`
                    : '未指定项目工程，无需迁移项目资产。'}
                </p>
              </div>

              {/* Feedback Summary if available */}
              {projectAssetsFeedback && (
                <div
                  className={`onboarding-feedback-card ${
                    projectAssetsFeedback.failedCount > 0 ? 'is-partial' : 'is-success'
                  }`}
                >
                  <div className="onboarding-feedback-title">
                    {projectAssetsFeedback.failedCount > 0 ? (
                      <>
                        <AlertCircle size={14} />
                        <span>
                          部分项目资产迁移完成：成功 {projectAssetsFeedback.migratedCount} 项，失败{' '}
                          {projectAssetsFeedback.failedCount} 项
                        </span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={14} />
                        <span>已成功迁移 {projectAssetsFeedback.migratedCount} 项项目资产</span>
                      </>
                    )}
                  </div>
                  {projectAssetsFeedback.failures.length > 0 && (
                    <ul className="onboarding-feedback-failures">
                      {projectAssetsFeedback.failures.map((f, i) => (
                        <li key={i}>
                          <strong>{f.label}：</strong>
                          <span>{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {!selectedProject || projectStepSkipped ? (
                <div className="onboarding-project-card">
                  <div className="onboarding-project-icon-box" style={{ opacity: 0.8 }}>
                    <Layers size={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                      未选择项目，已跳过
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 2 }}>
                      后续您可随时在主界面或设置页中添加代码工程。现在您可以直接完成初始引导。
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Segmented Tab Switcher (24px height) between Skills and MCP */}
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <div
                      className="onboarding-segmented-tab-container"
                      role="tablist"
                      aria-label="资产类型切换"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={projectAssetsTab === 'skills'}
                        className={`onboarding-segmented-tab-btn ${
                          projectAssetsTab === 'skills' ? 'is-active' : ''
                        }`}
                        onClick={() => setProjectAssetsTab('skills')}
                      >
                        项目 Skills ({projectSkills.length})
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={projectAssetsTab === 'mcp'}
                        className={`onboarding-segmented-tab-btn ${
                          projectAssetsTab === 'mcp' ? 'is-active' : ''
                        }`}
                        onClick={() => setProjectAssetsTab('mcp')}
                      >
                        项目 MCP ({projectMcps.length})
                      </button>
                    </div>
                  </div>

                  {/* Skills Tab Content */}
                  {projectAssetsTab === 'skills' && (
                    <div className="onboarding-group-card">
                      <div className="onboarding-group-header">
                        <span className="onboarding-group-title">项目 Skills 候选</span>
                        <span className="onboarding-group-count">{projectSkills.length} 个候选</span>
                      </div>
                      <div className="onboarding-item-list">
                        {projectSkills.length === 0 ? (
                          <div className="onboarding-empty-notice" style={{ padding: '24px 16px' }}>
                            <span>该项目下未发现可纳管的 Skills。</span>
                          </div>
                        ) : (
                          projectSkills.map((item) => {
                            const isSelected = selectedProjectSkillPaths.has(item.absolutePath)
                            const isConflict = Boolean(item.conflictsWithCentralId)
                            const currentStrategy =
                              projectSkillConflicts[item.absolutePath] || DEFAULT_CONFLICT_STRATEGY

                            return (
                              <div
                                key={item.absolutePath}
                                className={`onboarding-item-row ${
                                  item.alreadyLinked ? 'is-disabled' : ''
                                }`}
                              >
                                <div className="onboarding-item-left">
                                  <input
                                    type="checkbox"
                                    className="onboarding-item-checkbox"
                                    checked={!item.alreadyLinked && isSelected}
                                    disabled={item.alreadyLinked || busy}
                                    onChange={() => handleToggleProjectSkill(item.absolutePath)}
                                  />
                                  <div className="onboarding-item-info">
                                    <span className="onboarding-item-name">{item.skillName}</span>
                                    <span className="onboarding-item-sub font-mono">
                                      {item.absolutePath}
                                    </span>
                                  </div>
                                </div>

                                <div className="onboarding-item-right">
                                  {item.alreadyLinked && (
                                    <span className="onboarding-badge onboarding-badge--neutral">
                                      已接管
                                    </span>
                                  )}

                                  {isConflict && !item.alreadyLinked && (
                                    <div
                                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                      <span className="onboarding-badge onboarding-badge--warning">
                                        冲突
                                      </span>
                                      <div
                                        className="onboarding-segmented-tab-container"
                                        role="tablist"
                                        aria-label="冲突策略选择"
                                      >
                                        {CONFLICT_STRATEGY_OPTIONS.map((option) => (
                                          <button
                                            key={option.id}
                                            type="button"
                                            role="tab"
                                            aria-selected={currentStrategy === option.id}
                                            title={option.hint}
                                            className={`onboarding-segmented-tab-btn ${
                                              currentStrategy === option.id ? 'is-active' : ''
                                            }`}
                                            disabled={busy}
                                            onClick={() =>
                                              handleProjectSkillConflictChange(
                                                item.absolutePath,
                                                option.id
                                              )
                                            }
                                          >
                                            {option.label}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}

                  {/* MCP Tab Content */}
                  {projectAssetsTab === 'mcp' && (
                    <div className="onboarding-group-card">
                      <div className="onboarding-group-header">
                        <span className="onboarding-group-title">项目 MCP 服务候选</span>
                        <span className="onboarding-group-count">{projectMcps.length} 个服务</span>
                      </div>
                      <div className="onboarding-item-list">
                        {projectMcps.length === 0 ? (
                          <div className="onboarding-empty-notice" style={{ padding: '24px 16px' }}>
                            <span>该项目下未发现可纳管的 MCP 服务。</span>
                          </div>
                        ) : (
                          projectMcps.map((candidate) => {
                            const isSelected = selectedProjectMcpIds.has(candidate.serverId)

                            return (
                              <div
                                key={candidate.serverId}
                                className={`onboarding-item-row ${
                                  candidate.alreadyManaged ? 'is-disabled' : ''
                                }`}
                              >
                                <div className="onboarding-item-left">
                                  <input
                                    type="checkbox"
                                    className="onboarding-item-checkbox"
                                    checked={!candidate.alreadyManaged && isSelected}
                                    disabled={candidate.alreadyManaged || busy}
                                    onChange={() => handleToggleProjectMcp(candidate.serverId)}
                                  />
                                  <div className="onboarding-item-info">
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span className="onboarding-item-name">
                                        {candidate.serverName}
                                      </span>
                                      <span className="onboarding-badge onboarding-badge--neutral">
                                        {candidate.sourceToolId}
                                      </span>
                                      <span className="onboarding-badge onboarding-badge--neutral">
                                        {candidate.transport}
                                      </span>
                                    </div>

                                    {candidate.hasSecrets && (
                                      <div className="onboarding-mcp-secrets">
                                        <span className="onboarding-badge onboarding-badge--key">
                                          <Key size={10} />
                                          含鉴权凭据，将存入系统钥匙串
                                        </span>
                                        {candidate.secretFieldPaths?.length > 0 && (
                                          <div className="onboarding-secret-tags font-mono">
                                            {candidate.secretFieldPaths.map((fp) => (
                                              <span key={fp} className="onboarding-secret-tag">
                                                {fp}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="onboarding-item-right">
                                  {candidate.alreadyManaged && (
                                    <span className="onboarding-badge onboarding-badge--neutral">
                                      已纳管
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </main>

        {/* Wizard Footer Actions */}
        <footer className="onboarding-footer">
          <div className="onboarding-footer__left">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={currentStepIndex === 0 || busy}
              onClick={handlePrevStep}
            >
              <ArrowLeft size={13} style={{ marginRight: 4 }} />
              上一步
            </button>
          </div>

          <div className="onboarding-footer__right">
            {/* STEP 1: Global Skills Actions */}
            {currentStepIndex === 0 && (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={handleSkipGlobalSkills}
                >
                  跳过
                </button>
                {globalSkillFeedback && globalSkillFeedback.failedCount > 0 ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => setCurrentStepIndex(1)}
                  >
                    继续下一步
                    <ArrowRight size={13} style={{ marginLeft: 4 }} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={handleMigrateGlobalSkills}
                  >
                    {busy && <RefreshCw size={12} className="animate-spin" style={{ marginRight: 4 }} />}
                    迁移选中项
                  </button>
                )}
              </>
            )}

            {/* STEP 2: Global MCP Actions */}
            {currentStepIndex === 1 && (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={handleSkipGlobalMcp}
                >
                  跳过
                </button>
                {globalMcpFeedback && globalMcpFeedback.failedCount > 0 ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => setCurrentStepIndex(2)}
                  >
                    继续下一步
                    <ArrowRight size={13} style={{ marginLeft: 4 }} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={handleMigrateGlobalMcp}
                  >
                    {busy && <RefreshCw size={12} className="animate-spin" style={{ marginRight: 4 }} />}
                    迁移选中项
                  </button>
                )}
              </>
            )}

            {/* STEP 3: Select Project Actions */}
            {currentStepIndex === 2 && (
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={handleSkipProjectSelection}
                >
                  跳过
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!selectedProject || busy}
                  onClick={handleConfirmProjectSelection}
                >
                  确认并继续
                  <ArrowRight size={13} style={{ marginLeft: 4 }} />
                </button>
              </>
            )}

            {/* STEP 4: Project Assets Actions */}
            {currentStepIndex === 3 && (
              <>
                {!selectedProject || projectStepSkipped ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => handleFinishAll('skipped')}
                  >
                    {busy && <RefreshCw size={12} className="animate-spin" style={{ marginRight: 4 }} />}
                    完成引导
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy}
                      onClick={handleSkipProjectAssets}
                    >
                      跳过
                    </button>
                    {projectAssetsFeedback && projectAssetsFeedback.failedCount > 0 ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy}
                        onClick={() =>
                          handleFinishAll('partial', {
                            migratedCount: projectAssetsFeedback.migratedCount,
                            failedCount: projectAssetsFeedback.failedCount,
                          })
                        }
                      >
                        确认完成
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy}
                        onClick={handleMigrateProjectAssets}
                      >
                        {busy && (
                          <RefreshCw size={12} className="animate-spin" style={{ marginRight: 4 }} />
                        )}
                        迁移并完成
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
