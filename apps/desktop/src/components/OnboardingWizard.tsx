import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Folder,
  FolderOpen,
  Key,
  Layers,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import {
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

type ConflictStrategy = 'use_app' | 'use_target' | 'rename'

const DEFAULT_CONFLICT_STRATEGY: ConflictStrategy = 'use_app'

const CONFLICT_STRATEGY_OPTIONS: Array<{ id: ConflictStrategy; label: string; hint: string }> = [
  { id: 'use_app', label: '保留中心库', hint: '中心库版本不变，原目录内容备份到回收目录后改为软链' },
  { id: 'use_target', label: '用本地版覆盖', hint: '用扫描到的版本覆盖中心库，旧版本已备份' },
  { id: 'rename', label: '重命名导入', hint: '两个版本都保留，本次导入使用带后缀的新标识' },
]

export type WizardStage =
  | 'value-1' // Card 1: Every workflow. One central hub.
  | 'value-2' // Card 2: All your Skills & MCPs, everywhere you code.
  | 'value-3' // Card 3: 100% Local-first. Your secrets stay yours.
  | 'setup-skills' // Step 4: 全局技能扫描与接管
  | 'setup-mcp' // Step 5: 全局 MCP 发现与接管
  | 'setup-project' // Step 6: 本地工作区项目接入
  | 'setup-project-assets' // Step 7: 项目级技能/MCP
  | 'ready' // Step 8: Trace is ready 🥳

export function OnboardingWizard({ onFinished }: OnboardingWizardProps): JSX.Element {
  const [stage, setStage] = useState<WizardStage>('value-1')
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

  // Step 4: Project Assets State
  const [projectAssetsTab, setProjectAssetsTab] = useState<'skills' | 'mcp'>('skills')
  const [projectSkills, setProjectSkills] = useState<OnboardingSkillCandidate[]>([])
  const [selectedProjectSkillPaths, setSelectedProjectSkillPaths] = useState<Set<string>>(new Set())
  const [projectSkillConflicts, setProjectSkillConflicts] = useState<Record<string, ConflictStrategy>>({})
  const [projectMcps, setProjectMcps] = useState<OnboardingMcpCandidate[]>([])
  const [selectedProjectMcpIds, setSelectedProjectMcpIds] = useState<Set<string>>(new Set())
  const [projectAssetsFeedback, setProjectAssetsFeedback] = useState<StepFeedback | null>(null)
  const [projectAssetsScanned, setProjectAssetsScanned] = useState<boolean>(false)

  // Total migration statistics for the Ready screen
  const [totalMigratedSkills, setTotalMigratedSkills] = useState<number>(0)
  const [totalMigratedMcps, setTotalMigratedMcps] = useState<number>(0)

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
    } catch (err: any) {
      setGlobalError(err?.message || `持久化步骤 ${stepId} 状态失败`)
    }
  }

  // 1. Initial Scan: Global Skills on mount
  useEffect(() => {
    let active = true
    const scanGlobalSkills = async () => {
      try {
        if (!window.workflowSkill?.scanGlobalSkillCandidates) return
        const candidates = await window.workflowSkill.scanGlobalSkillCandidates()
        if (!active) return
        setGlobalSkills(candidates)

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
      }
    }

    scanGlobalSkills()
    return () => {
      active = false
    }
  }, [])

  // 2. Scan Global MCP when entering setup-mcp
  useEffect(() => {
    if (stage !== 'setup-mcp' || globalMcps.length > 0) return
    let active = true
    const scanGlobalMcp = async () => {
      setBusy(true)
      setGlobalError(null)
      try {
        if (!window.workflowSkill?.scanGlobalMcpCandidates) return
        const candidates = await window.workflowSkill.scanGlobalMcpCandidates()
        if (!active) return
        setGlobalMcps(candidates)

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
  }, [stage, globalMcps.length])

  // 3. Scan Project Assets when entering setup-project-assets
  useEffect(() => {
    if (stage !== 'setup-project-assets' || !selectedProject || projectAssetsScanned) return
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
  }, [stage, selectedProject, projectAssetsScanned])

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

  // Global Skills Handlers
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
      setStage('setup-mcp')
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
      setGlobalSkillFeedback({
        migratedCount,
        failedCount,
        failures,
      })
      setTotalMigratedSkills((prev) => prev + migratedCount)

      const outcome: OnboardingStepOutcome = failedCount > 0 ? 'partial' : 'migrated'
      await recordStepOutcome('global-skills', outcome, {
        migratedCount,
        failedCount,
        skippedCount: globalSkills.length - requests.length,
      })

      if (failedCount === 0) {
        setStage('setup-mcp')
      }
    } catch (err: any) {
      setGlobalError(err?.message || '执行全局技能迁移失败')
    } finally {
      setBusy(false)
    }
  }

  // Global MCP Handlers
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
      setStage('setup-project')
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
      setGlobalMcpFeedback({
        migratedCount,
        failedCount,
        failures,
      })
      setTotalMigratedMcps((prev) => prev + migratedCount)

      const outcome: OnboardingStepOutcome = failedCount > 0 ? 'partial' : 'migrated'
      await recordStepOutcome('global-mcp', outcome, {
        migratedCount,
        failedCount,
        skippedCount: globalMcps.length - serverIds.length,
      })

      if (failedCount === 0) {
        setStage('setup-project')
      }
    } catch (err: any) {
      setGlobalError(err?.message || '执行全局 MCP 迁移失败')
    } finally {
      setBusy(false)
    }
  }

  // Select Project Handlers
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
        setProjectAssetsScanned(false)
      }
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
      await recordStepOutcome('select-project', 'skipped')
      await recordStepOutcome('project-assets', 'skipped')
      setStage('ready')
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmProjectSelection = async () => {
    if (!selectedProject) return
    setBusy(true)
    try {
      await recordStepOutcome('select-project', 'migrated')
      // Advance to project assets inspection
      setStage('setup-project-assets')
    } finally {
      setBusy(false)
    }
  }

  // Project Assets Handlers
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

  const handleSkipProjectAssets = async () => {
    setBusy(true)
    try {
      await recordStepOutcome('project-assets', 'skipped', {
        skippedCount: projectSkills.length + projectMcps.length,
      })
      setStage('ready')
    } finally {
      setBusy(false)
    }
  }

  const handleMigrateProjectAssets = async () => {
    setBusy(true)
    setGlobalError(null)
    try {
      const failures: Array<{ label: string; error: string }> = []
      let migratedCount = 0

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
      setProjectAssetsFeedback({
        migratedCount,
        failedCount,
        failures,
      })
      setTotalMigratedSkills((prev) => prev + migratedCount)

      const outcome: OnboardingStepOutcome = failedCount > 0 ? 'partial' : 'migrated'
      const counts: OnboardingStepCounts = {
        migratedCount,
        failedCount,
        skippedCount:
          projectSkills.length +
          projectMcps.length -
          (selectedProjectSkillPaths.size + selectedProjectMcpIds.size),
      }

      await recordStepOutcome('project-assets', outcome, counts)
      if (failedCount === 0) {
        setStage('ready')
      }
    } catch (err: any) {
      setGlobalError(err?.message || '迁移项目资产失败')
    } finally {
      setBusy(false)
    }
  }

  // Completion Handler
  const handleCompleteAll = async () => {
    setBusy(true)
    try {
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

  // Navigation Back
  const handlePrev = () => {
    setGlobalError(null)
    if (stage === 'value-2') setStage('value-1')
    else if (stage === 'value-3') setStage('value-2')
    else if (stage === 'setup-skills') setStage('value-3')
    else if (stage === 'setup-mcp') setStage('setup-skills')
    else if (stage === 'setup-project') setStage('setup-mcp')
    else if (stage === 'setup-project-assets') setStage('setup-project')
    else if (stage === 'ready') setStage('setup-project')
  }

  // Segmented Bar Progress Configuration (6 Main Milestone Bars)
  const STAGE_ORDER: WizardStage[] = [
    'value-1',
    'value-2',
    'value-3',
    'setup-skills',
    'setup-mcp',
    'setup-project',
  ]
  const currentProgressIndex = (() => {
    if (stage === 'ready') return 5
    if (stage === 'setup-project-assets') return 5
    const idx = STAGE_ORDER.indexOf(stage)
    return idx >= 0 ? idx : 0
  })()

  const isValueCard = stage === 'value-1' || stage === 'value-2' || stage === 'value-3'

  return (
    <div className="onboarding-wizard-container">
      {/* Background WebGL Shader Layer */}
      <OnboardingShaderBackground />

      {/* Main Glass Dialog */}
      <div className="onboarding-wizard-dialog" role="dialog" aria-modal="true">
        {/* macOS Top Window Bar */}
        <header className="onboarding-top-bar">
          <div className="onboarding-traffic-lights" aria-hidden="true">
            <span className="onboarding-traffic-dot onboarding-traffic-dot--close" />
            <span className="onboarding-traffic-dot onboarding-traffic-dot--min" />
            <span className="onboarding-traffic-dot onboarding-traffic-dot--max" />
          </div>

          <div className="onboarding-top-bar__brand">
            <Sparkles size={13} />
            <span>Trace Workflow & Skill</span>
          </div>

          {/* Quick Skip for Value Cards */}
          <div>
            {isValueCard && (
              <button
                type="button"
                className="onboarding-skip-btn"
                onClick={() => setStage('setup-skills')}
              >
                跳过介绍
              </button>
            )}
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
              className="onboarding-skip-btn"
              onClick={() => setGlobalError(null)}
              aria-label="关闭提示"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Wizard Main Content Body */}
        <main className="onboarding-body">
          {/* ================= CARD 1: VALUE HERO ================= */}
          {stage === 'value-1' && (
            <div className="onboarding-value-stage">
              <div className="onboarding-value-hero">
                <div className="onboarding-value-tag">
                  <Sparkles size={11} />
                  <span>自动化资产中枢</span>
                </div>
                <h1 className="onboarding-value-title">
                  Every workflow.<br />
                  <span>One central hub.</span>
                </h1>
                <p className="onboarding-value-desc">
                  捕获你的日常浏览器与桌面操作流，自动沉淀为高复用价值的 Skill 与 MCP 工具。跨开发环境无缝调度，让经验化为资产。
                </p>
              </div>

              <div className="onboarding-value-mock-container">
                <div className="mock-window-card">
                  <div className="mock-header">
                    <div className="onboarding-traffic-lights">
                      <span className="onboarding-traffic-dot onboarding-traffic-dot--close" />
                      <span className="onboarding-traffic-dot onboarding-traffic-dot--min" />
                      <span className="onboarding-traffic-dot onboarding-traffic-dot--max" />
                    </div>
                    <span className="mock-badge mock-badge--rec">
                      <span className="mock-pulse-dot" />
                      <span>LIVE CAPTURE</span>
                    </span>
                  </div>

                  <div className="mock-step-list">
                    <div className="mock-step-row">
                      <span className="mock-step-num">01</span>
                      <span>cdp.navigate("github.com/trending")</span>
                    </div>
                    <div className="mock-step-row">
                      <span className="mock-step-num">02</span>
                      <span>page.extract_feed(items: 10)</span>
                    </div>
                    <div className="mock-step-row">
                      <span className="mock-step-num">03</span>
                      <span>synthesize_skill("daily-digest")</span>
                    </div>
                  </div>

                  <div className="mock-skill-result">
                    <div className="mock-skill-title">
                      <Sparkles size={13} style={{ color: 'var(--color-primary)' }} />
                      <span>github-daily-digest</span>
                    </div>
                    <span className="onboarding-badge onboarding-badge--success">3 步骤 · 已验证</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================= CARD 2: ECOSYSTEM ================= */}
          {stage === 'value-2' && (
            <div className="onboarding-value-stage">
              <div className="onboarding-value-hero">
                <div className="onboarding-value-tag">
                  <Cpu size={11} />
                  <span>多环境生态分发</span>
                </div>
                <h1 className="onboarding-value-title">
                  All your Skills & MCPs.<br />
                  <span>Everywhere you code.</span>
                </h1>
                <p className="onboarding-value-desc">
                  一次录制与沉淀，跨开发环境自动分发。让 Claude Code、Codex、Cursor 与 Gemini 即刻掌握你的专属能力。
                </p>
              </div>

              <div className="onboarding-value-mock-container">
                <div className="mock-window-card">
                  <div className="mock-header">
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-ink)' }}>
                      分发就绪矩阵
                    </span>
                    <span className="onboarding-badge onboarding-badge--key">4 个工具就绪</span>
                  </div>

                  <div className="mock-ecosystem-grid">
                    <div className="mock-eco-row">
                      <div className="mock-eco-left">
                        <Terminal size={14} style={{ color: 'var(--color-primary)' }} />
                        <span>Claude Code</span>
                      </div>
                      <span className="mock-eco-status">
                        <CheckCircle2 size={12} />
                        <span>~/.claude/skills</span>
                      </span>
                    </div>

                    <div className="mock-eco-row">
                      <div className="mock-eco-left">
                        <Layers size={14} style={{ color: 'var(--color-accent)' }} />
                        <span>Cursor IDE</span>
                      </div>
                      <span className="mock-eco-status">
                        <CheckCircle2 size={12} />
                        <span>自动软链生效</span>
                      </span>
                    </div>

                    <div className="mock-eco-row">
                      <div className="mock-eco-left">
                        <Cpu size={14} style={{ color: 'var(--color-ink)' }} />
                        <span>Codex CLI</span>
                      </div>
                      <span className="mock-eco-status">
                        <CheckCircle2 size={12} />
                        <span>中心库直连</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================= CARD 3: LOCAL-FIRST & PRIVACY ================= */}
          {stage === 'value-3' && (
            <div className="onboarding-value-stage">
              <div className="onboarding-value-hero">
                <div className="onboarding-value-tag">
                  <ShieldCheck size={11} />
                  <span>本地优先与安全</span>
                </div>
                <h1 className="onboarding-value-title">
                  100% Local-first.<br />
                  <span>Your secrets stay yours.</span>
                </h1>
                <p className="onboarding-value-desc">
                  所有工作流数据、技能代码与配置均存储在你的 Mac 本地；API Key 与鉴权凭据直通 macOS Keychain 硬件级保护，明文零落盘，绝不上报云端。
                </p>
              </div>

              <div className="onboarding-value-mock-container">
                <div className="mock-window-card">
                  <div className="mock-header">
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-ink)' }}>
                      隐私与凭据沙盒
                    </span>
                    <span className="onboarding-badge onboarding-badge--success">
                      <Lock size={10} />
                      <span>Keychain 已锁定</span>
                    </span>
                  </div>

                  <div className="mock-security-list">
                    <div className="mock-security-item">
                      <CheckCircle2 size={14} className="mock-security-icon" />
                      <div>
                        <div className="mock-security-title">本地优先存储架构</div>
                        <div className="mock-security-desc">全量工作流资产保存在 ~/.trace，支持完全离线运行</div>
                      </div>
                    </div>

                    <div className="mock-security-item">
                      <Key size={14} className="mock-security-icon" />
                      <div>
                        <div className="mock-security-title">系统 Keychain 凭据安全</div>
                        <div className="mock-security-desc">MCP Secret 存入苹果安全钥匙串，JSON 仅存脱敏引用</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================= STEP 4: SETUP SKILLS ================= */}
          {stage === 'setup-skills' && (
            <>
              <div className="onboarding-step-lead">
                <h2 className="onboarding-step-title">迁移全局 AI 技能资产</h2>
                <p className="onboarding-step-desc">
                  扫描已安装的全局 AI 工具（Agents / Codex / Claude），一次性接管进 Trace 中心库统一管理。
                </p>
              </div>

              {globalSkillFeedback && (
                <div
                  className={`onboarding-feedback-card ${
                    globalSkillFeedback.failedCount === 0 ? 'is-success' : 'is-partial'
                  }`}
                >
                  <div className="onboarding-feedback-title">
                    <CheckCircle2 size={14} />
                    <span>
                      {globalSkillFeedback.failedCount === 0
                        ? `成功迁移 ${globalSkillFeedback.migratedCount} 个全局技能`
                        : `迁移完成：${globalSkillFeedback.migratedCount} 个成功，${globalSkillFeedback.failedCount} 个失败`}
                    </span>
                  </div>
                  {globalSkillFeedback.failures.length > 0 && (
                    <ul className="onboarding-feedback-failures">
                      {globalSkillFeedback.failures.map((f, i) => (
                        <li key={i}>
                          <strong>{f.label}:</strong> {f.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {globalSkills.length === 0 ? (
                <div className="onboarding-project-card">
                  <Sparkles size={24} style={{ color: 'var(--color-muted)' }} />
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--color-muted)' }}>
                    未在已支持的全局目录（~/.agents、~/.codex、~/.claude）中发现可迁移的技能
                  </p>
                </div>
              ) : (
                globalSkillGroups.map(([groupLabel, items]) => (
                  <div key={groupLabel} className="onboarding-group-card">
                    <div className="onboarding-group-header">
                      <span className="onboarding-group-title">{groupLabel} 全局技能</span>
                      <span className="onboarding-group-count">{items.length} 个候选</span>
                    </div>

                    <div className="onboarding-item-list">
                      {items.map((skill) => {
                        const isSelected = selectedGlobalSkillPaths.has(skill.absolutePath)
                        const isConflict = Boolean(skill.conflictsWithCentralId)
                        const currentStrategy =
                          globalSkillConflicts[skill.absolutePath] || DEFAULT_CONFLICT_STRATEGY

                        return (
                          <div
                            key={skill.absolutePath}
                            className={`onboarding-item-row ${skill.alreadyLinked ? 'is-disabled' : ''}`}
                          >
                            <div className="onboarding-item-left">
                              <input
                                type="checkbox"
                                className="onboarding-item-checkbox"
                                checked={isSelected}
                                disabled={skill.alreadyLinked}
                                onChange={() => handleToggleGlobalSkill(skill.absolutePath)}
                              />
                              <div className="onboarding-item-info">
                                <span className="onboarding-item-name">{skill.skillName}</span>
                                <span className="onboarding-item-sub">{skill.absolutePath}</span>
                              </div>
                            </div>

                            <div className="onboarding-item-right">
                              {skill.alreadyLinked ? (
                                <span className="onboarding-badge onboarding-badge--neutral">已由中心库接管</span>
                              ) : isConflict ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span className="onboarding-badge onboarding-badge--warning">同名冲突</span>
                                  <div className="onboarding-segmented-tab-container">
                                    {CONFLICT_STRATEGY_OPTIONS.map((opt) => (
                                      <button
                                        key={opt.id}
                                        type="button"
                                        className={`onboarding-segmented-tab-btn ${
                                          currentStrategy === opt.id ? 'is-active' : ''
                                        }`}
                                        title={opt.hint}
                                        onClick={() =>
                                          handleGlobalSkillConflictChange(skill.absolutePath, opt.id)
                                        }
                                      >
                                        {opt.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <span className="onboarding-badge onboarding-badge--neutral">就绪</span>
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

          {/* ================= STEP 5: SETUP MCP ================= */}
          {stage === 'setup-mcp' && (
            <>
              <div className="onboarding-step-lead">
                <h2 className="onboarding-step-title">接管全局 MCP 外部服务</h2>
                <p className="onboarding-step-desc">
                  汇聚全局 MCP Server 配置。API Key 等敏感凭据一律写入 macOS Keychain，保证明文零落盘。
                </p>
              </div>

              {globalMcpFeedback && (
                <div
                  className={`onboarding-feedback-card ${
                    globalMcpFeedback.failedCount === 0 ? 'is-success' : 'is-partial'
                  }`}
                >
                  <div className="onboarding-feedback-title">
                    <CheckCircle2 size={14} />
                    <span>
                      {globalMcpFeedback.failedCount === 0
                        ? `成功迁移 ${globalMcpFeedback.migratedCount} 个 MCP 服务`
                        : `迁移完成：${globalMcpFeedback.migratedCount} 个成功，${globalMcpFeedback.failedCount} 个失败`}
                    </span>
                  </div>
                  {globalMcpFeedback.failures.length > 0 && (
                    <ul className="onboarding-feedback-failures">
                      {globalMcpFeedback.failures.map((f, i) => (
                        <li key={i}>
                          <strong>{f.label}:</strong> {f.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {globalMcps.length === 0 ? (
                <div className="onboarding-project-card">
                  <Server size={24} style={{ color: 'var(--color-muted)' }} />
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--color-muted)' }}>
                    未扫描到可导入的全局 MCP 服务配置
                  </p>
                </div>
              ) : (
                <div className="onboarding-group-card">
                  <div className="onboarding-group-header">
                    <span className="onboarding-group-title">发现的全局 MCP 列表</span>
                    <span className="onboarding-group-count">{globalMcps.length} 个配置</span>
                  </div>

                  <div className="onboarding-item-list">
                    {globalMcps.map((mcp) => {
                      const isSelected = selectedGlobalMcpIds.has(mcp.serverId)
                      return (
                        <div
                          key={mcp.serverId}
                          className={`onboarding-item-row ${mcp.alreadyManaged ? 'is-disabled' : ''}`}
                        >
                          <div className="onboarding-item-left">
                            <input
                              type="checkbox"
                              className="onboarding-item-checkbox"
                              checked={isSelected}
                              disabled={mcp.alreadyManaged}
                              onChange={() => handleToggleGlobalMcp(mcp.serverId)}
                            />
                            <div className="onboarding-item-info">
                              <span className="onboarding-item-name">{mcp.serverName}</span>
                              <span className="onboarding-item-sub">
                                {mcp.sourceToolId ? `来源: ${mcp.sourceToolId} · 传输: ${mcp.transport}` : `传输: ${mcp.transport}`}
                              </span>
                              {mcp.secretFieldPaths && mcp.secretFieldPaths.length > 0 && (
                                <div className="onboarding-mcp-secrets">
                                  <div className="onboarding-secret-tags">
                                    {mcp.secretFieldPaths.map((sec) => (
                                      <span key={sec} className="onboarding-secret-tag">
                                        <Key size={10} style={{ display: 'inline', marginRight: 2 }} />
                                        {sec} (Keychain 托管)
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="onboarding-item-right">
                            {mcp.alreadyManaged ? (
                              <span className="onboarding-badge onboarding-badge--neutral">已在管理中</span>
                            ) : (
                              <span className="onboarding-badge onboarding-badge--neutral">{mcp.transport}</span>
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

          {/* ================= STEP 6: SELECT PROJECT ================= */}
          {stage === 'setup-project' && (
            <>
              <div className="onboarding-step-lead">
                <h2 className="onboarding-step-title">接入首个工作区项目</h2>
                <p className="onboarding-step-desc">
                  绑定一个本地工作区仓库，Trace 将自动挂载该项目下的专用技能与 MCP 配置。
                </p>
              </div>

              {selectedProject ? (
                <div className="onboarding-project-selected-card">
                  <div className="onboarding-project-selected-info">
                    <div className="onboarding-project-icon-box">
                      <FolderOpen size={20} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                        {selectedProject.name}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                        {selectedProject.path}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn--capsule"
                    style={{ background: 'var(--color-surface-raised)', color: 'var(--color-ink)' }}
                    onClick={handleSelectProjectFolder}
                  >
                    更换目录
                  </button>
                </div>
              ) : (
                <div className="onboarding-project-card">
                  <Folder size={32} style={{ color: 'var(--color-primary)' }} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                      选择你经常使用的项目代码库
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                      支持自动识别 .agents, .claude, .cursor, .gemini 等环境配置
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary-cta"
                    onClick={handleSelectProjectFolder}
                  >
                    <FolderOpen size={13} />
                    <span>浏览本地文件夹...</span>
                  </button>
                </div>
              )}
            </>
          )}

          {/* ================= STEP 7: PROJECT ASSETS ================= */}
          {stage === 'setup-project-assets' && (
            <>
              <div className="onboarding-step-lead">
                <h2 className="onboarding-step-title">项目专属资产接管</h2>
                <p className="onboarding-step-desc">
                  在项目 <strong>{selectedProject?.name}</strong> 中扫描到的技能与 MCP 服务配置。
                </p>
              </div>

              {projectAssetsFeedback && (
                <div
                  className={`onboarding-feedback-card ${
                    projectAssetsFeedback.failedCount === 0 ? 'is-success' : 'is-partial'
                  }`}
                >
                  <div className="onboarding-feedback-title">
                    <CheckCircle2 size={14} />
                    <span>
                      {projectAssetsFeedback.failedCount === 0
                        ? `成功迁移 ${projectAssetsFeedback.migratedCount} 个项目资产`
                        : `迁移完成：${projectAssetsFeedback.migratedCount} 个成功，${projectAssetsFeedback.failedCount} 个失败`}
                    </span>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
                <div className="onboarding-segmented-tab-container">
                  <button
                    type="button"
                    className={`onboarding-segmented-tab-btn ${
                      projectAssetsTab === 'skills' ? 'is-active' : ''
                    }`}
                    onClick={() => setProjectAssetsTab('skills')}
                  >
                    项目技能 ({projectSkills.length})
                  </button>
                  <button
                    type="button"
                    className={`onboarding-segmented-tab-btn ${
                      projectAssetsTab === 'mcp' ? 'is-active' : ''
                    }`}
                    onClick={() => setProjectAssetsTab('mcp')}
                  >
                    项目 MCP ({projectMcps.length})
                  </button>
                </div>
              </div>

              {projectAssetsTab === 'skills' && (
                <div className="onboarding-group-card">
                  <div className="onboarding-item-list">
                    {projectSkills.length === 0 ? (
                      <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--color-muted)' }}>
                        未在项目中发现技能目录
                      </div>
                    ) : (
                      projectSkills.map((s) => (
                        <div key={s.absolutePath} className="onboarding-item-row">
                          <div className="onboarding-item-left">
                            <input
                              type="checkbox"
                              className="onboarding-item-checkbox"
                              checked={selectedProjectSkillPaths.has(s.absolutePath)}
                              onChange={() => handleToggleProjectSkill(s.absolutePath)}
                            />
                            <div className="onboarding-item-info">
                              <span className="onboarding-item-name">{s.skillName}</span>
                              <span className="onboarding-item-sub">{s.absolutePath}</span>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {projectAssetsTab === 'mcp' && (
                <div className="onboarding-group-card">
                  <div className="onboarding-item-list">
                    {projectMcps.length === 0 ? (
                      <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--color-muted)' }}>
                        未在项目中发现 MCP 配置
                      </div>
                    ) : (
                      projectMcps.map((m) => (
                        <div key={m.serverId} className="onboarding-item-row">
                          <div className="onboarding-item-left">
                            <input
                              type="checkbox"
                              className="onboarding-item-checkbox"
                              checked={selectedProjectMcpIds.has(m.serverId)}
                              onChange={() => handleToggleProjectMcp(m.serverId)}
                            />
                            <div className="onboarding-item-info">
                              <span className="onboarding-item-name">{m.serverName}</span>
                              <span className="onboarding-item-sub">{m.transport}</span>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ================= STEP 8: READY & CELEBRATION ================= */}
          {stage === 'ready' && (
            <div className="onboarding-ready-stage">
              <div className="onboarding-ready-badge">
                <Sparkles size={28} />
              </div>
              <h1 className="onboarding-ready-title">Trace is ready to go 🥳</h1>
              <p className="onboarding-ready-desc">
                你的统一工作流与 Skill 资产中心已完成初始化。所有配置与安全凭据均已本地落库。
              </p>

              <div className="onboarding-ready-stats-grid">
                <div className="onboarding-ready-stat-card">
                  <span className="onboarding-ready-stat-value">{totalMigratedSkills}</span>
                  <span className="onboarding-ready-stat-label">已接管技能资产</span>
                </div>
                <div className="onboarding-ready-stat-card">
                  <span className="onboarding-ready-stat-value">{totalMigratedMcps}</span>
                  <span className="onboarding-ready-stat-label">已托管 MCP 服务</span>
                </div>
                <div className="onboarding-ready-stat-card">
                  <span className="onboarding-ready-stat-value">
                    {selectedProject ? '已连接' : '跳过'}
                  </span>
                  <span className="onboarding-ready-stat-label">本地工作区状态</span>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Wizard Footer Controls */}
        <footer className="onboarding-footer">
          {/* Left: Back Button */}
          <div className="onboarding-footer__left">
            {stage !== 'value-1' && stage !== 'ready' && (
              <button
                type="button"
                className="btn--secondary-cta"
                onClick={handlePrev}
                disabled={busy}
              >
                <ArrowLeft size={13} />
                <span>返回</span>
              </button>
            )}
          </div>

          {/* Middle: Segmented Capsule Indicators */}
          <div className="onboarding-indicators" aria-label="向导阶段指示器">
            {STAGE_ORDER.map((s, idx) => {
              const isActive = idx === currentProgressIndex
              const isPassed = idx < currentProgressIndex
              return (
                <div
                  key={s}
                  className={`onboarding-indicator-bar ${isActive ? 'is-active' : ''} ${
                    isPassed ? 'is-passed' : ''
                  }`}
                />
              )
            })}
          </div>

          {/* Right: Actions */}
          <div className="onboarding-footer__right">
            {/* Value 1 */}
            {stage === 'value-1' && (
              <button
                type="button"
                className="btn--primary-cta"
                onClick={() => setStage('value-2')}
              >
                <span>即刻开始</span>
                <ArrowRight size={13} />
              </button>
            )}

            {/* Value 2 */}
            {stage === 'value-2' && (
              <button
                type="button"
                className="btn--primary-cta"
                onClick={() => setStage('value-3')}
              >
                <span>继续了解</span>
                <ArrowRight size={13} />
              </button>
            )}

            {/* Value 3 */}
            {stage === 'value-3' && (
              <button
                type="button"
                className="btn--primary-cta"
                onClick={() => setStage('setup-skills')}
              >
                <span>我准备好了</span>
                <ArrowRight size={13} />
              </button>
            )}

            {/* Setup Skills */}
            {stage === 'setup-skills' && (
              <>
                <button
                  type="button"
                  className="btn--secondary-cta"
                  disabled={busy}
                  onClick={handleSkipGlobalSkills}
                >
                  暂不接管
                </button>
                <button
                  type="button"
                  className="btn--primary-cta"
                  disabled={busy || selectedGlobalSkillPaths.size === 0}
                  onClick={handleMigrateGlobalSkills}
                >
                  {busy ? <RefreshCw size={13} className="spin" /> : <ArrowRight size={13} />}
                  <span>导入选定技能 ({selectedGlobalSkillPaths.size})</span>
                </button>
              </>
            )}

            {/* Setup MCP */}
            {stage === 'setup-mcp' && (
              <>
                <button
                  type="button"
                  className="btn--secondary-cta"
                  disabled={busy}
                  onClick={handleSkipGlobalMcp}
                >
                  暂不导入
                </button>
                <button
                  type="button"
                  className="btn--primary-cta"
                  disabled={busy || selectedGlobalMcpIds.size === 0}
                  onClick={handleMigrateGlobalMcp}
                >
                  {busy ? <RefreshCw size={13} className="spin" /> : <ArrowRight size={13} />}
                  <span>接入 Keychain 托管 ({selectedGlobalMcpIds.size})</span>
                </button>
              </>
            )}

            {/* Setup Project */}
            {stage === 'setup-project' && (
              <>
                <button
                  type="button"
                  className="btn--secondary-cta"
                  disabled={busy}
                  onClick={handleSkipProjectSelection}
                >
                  稍后连接
                </button>
                <button
                  type="button"
                  className="btn--primary-cta"
                  disabled={busy || !selectedProject}
                  onClick={handleConfirmProjectSelection}
                >
                  <span>确认并继续</span>
                  <ArrowRight size={13} />
                </button>
              </>
            )}

            {/* Setup Project Assets */}
            {stage === 'setup-project-assets' && (
              <>
                <button
                  type="button"
                  className="btn--secondary-cta"
                  disabled={busy}
                  onClick={handleSkipProjectAssets}
                >
                  跳过此步
                </button>
                <button
                  type="button"
                  className="btn--primary-cta"
                  disabled={busy}
                  onClick={handleMigrateProjectAssets}
                >
                  {busy ? <RefreshCw size={13} className="spin" /> : <ArrowRight size={13} />}
                  <span>完成迁移</span>
                </button>
              </>
            )}

            {/* Ready */}
            {stage === 'ready' && (
              <button
                type="button"
                className="btn--primary-cta"
                disabled={busy}
                onClick={handleCompleteAll}
              >
                <span>开启 Trace 工作台</span>
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
