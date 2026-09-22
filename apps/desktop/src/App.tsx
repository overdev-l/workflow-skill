import { ProjectsThreeColumn } from './components/ProjectsThreeColumn'
import { AppUpdate, useUpdateBlocker } from './components/AppUpdate'
import { SkillDiagnosticWorkbench } from './components/SkillDiagnosticWorkbench'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  BookOpen,
  Boxes,
  Check,
  CheckCheck,
  CheckCircle2,
  CircleDot,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code,
  Command,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  Grid,
  Info,
  Keyboard,
  Languages,
  Link2,
  ListTree,
  Mail,
  Monitor,
  MousePointer2,
  Moon,
  MoveVertical,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Star,
  Stethoscope,
  Sun,
  Terminal,
  Trash2,
  Unlink,
  Users,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from 'lucide-react'
import {
  DEFAULT_AI_TOOLS,
  demoSkills,
  SUPPORTED_PROJECT_SKILL_PATHS,
  type AIToolCategory,
  type AIToolTarget,
  type BatchSkillAdoptionResult,
  type ConflictResolutionStrategy,
  type DeleteSkillMode,
  type ProjectRecord,
  type ManagedProjectRecord,
  type RemoteSkill,
  type Skill,
  type SkillAdoptionPlan,
  type SkillTargetBinding,
  type Workflow,
  type WorkflowNode,
} from '@workflow-skill/workflow-model'
import type {
  BrowserCaptureEnvelope,
  BrowserCaptureStatus,
  CaptureEvent,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'
import { AddSkillDialog } from './components/AddSkillDialog'
import { useProjectSkills } from './use-project-skills'
import { addSkillToScope, skillsInScope, type SkillScopeTarget } from './skill-scope'
import { WorkflowGraph } from './components/WorkflowGraph'
import { McpThreeColumn } from './components/McpThreeColumn'
import { ConflictResolutionDialog } from './components/ConflictResolutionDialog'
import { RulesThreeColumn } from './components/RulesThreeColumn'
import { AccountSettings } from './components/AccountSettings'
import { AIToolLogo } from './AIToolLogo'
import { useI18n, type Locale, type TranslationKeys } from './i18n'

export type View = 'skills' | 'workflows' | 'mcp' | 'rules' | 'projects' | 'accounts'
type SettingsTab = 'general' | 'shortcuts' | 'permissions' | 'about'
export type ThemeMode = 'dark' | 'light' | 'system'

interface ActiveDetailState {
  workflow: Workflow
  source: 'workflow' | 'skill'
  skill?: Skill
}

/* =========================================================================
   Sidebar Rail (Switches dynamically between App Navigation and Settings Navigation)
   ========================================================================= */
function AppSidebar({
  view,
  setView,
  inSettings,
  settingsTab,
  setSettingsTab,
  onEnterSettings,
  onExitSettings,
  onBackToOverview,
  masterCollapsed,
  onToggleMasterCollapse,
  scope,
  onScopeChange,
  projects,
  selectedProjectId,
  onSelectProjectId,
  selectedProject,
}: {
  view: View
  setView: (view: View) => void
  inSettings: boolean
  settingsTab: SettingsTab
  setSettingsTab: (tab: SettingsTab) => void
  onEnterSettings: () => void
  onExitSettings: () => void
  onBackToOverview: () => void
  masterCollapsed?: boolean
  onToggleMasterCollapse?: () => void
  scope?: 'global' | 'project'
  onScopeChange?: (scope: 'global' | 'project') => void
  projects?: ManagedProjectRecord[]
  selectedProjectId?: string
  onSelectProjectId?: (id: string) => void
  selectedProject?: ManagedProjectRecord | null
}) {
  const { t } = useI18n()

  return (
    <aside className="app-sidebar" aria-label={t.nav.settings}>
      {/* Top Drag Handle for macOS Window Dragging */}
      <div className="sidebar-drag-handle" />

      {inSettings ? (
        /* Settings Sidebar Mode */
        <div className="settings-sidebar-mode view-enter">
          {/* Top: Return to App Button */}
          <button
            type="button"
            className="back-to-app-btn"
            onClick={onExitSettings}
            aria-label={t.nav.backToApp}
          >
            <ArrowLeft size={14} className="back-arrow" />
            <span>{t.nav.backToApp}</span>
          </button>

          {/* Settings Section Navigation Pills */}
          <nav className="sidebar-nav-list">
            <button
              type="button"
              className={`nav-pill-btn ${settingsTab === 'general' ? 'is-active' : ''}`}
              onClick={() => setSettingsTab('general')}
            >
              <div className="nav-pill-btn__left">
                <Sliders size={15} className="nav-icon" />
                <span>{t.nav.general}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${settingsTab === 'shortcuts' ? 'is-active' : ''}`}
              onClick={() => setSettingsTab('shortcuts')}
            >
              <div className="nav-pill-btn__left">
                <Command size={15} className="nav-icon" />
                <span>{t.nav.shortcuts}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${settingsTab === 'permissions' ? 'is-active' : ''}`}
              onClick={() => setSettingsTab('permissions')}
            >
              <div className="nav-pill-btn__left">
                <ShieldCheck size={15} className="nav-icon" />
                <span>{t.nav.permissions}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${settingsTab === 'about' ? 'is-active' : ''}`}
              onClick={() => setSettingsTab('about')}
            >
              <div className="nav-pill-btn__left">
                <Info size={15} className="nav-icon" />
                <span>{t.nav.about}</span>
              </div>
            </button>
          </nav>
        </div>
      ) : (
        /* Standard App Navigation Mode */
        <div className="app-sidebar-mode view-enter">
          {view !== 'accounts' && scope && onScopeChange && (
            <div className="sidebar-workspace-section">
              <div className="master-tab-segmented sidebar-scope-segmented" role="tablist" aria-label={t.workspace.scopeLabel}>
                <button
                  type="button"
                  role="tab"
                  className={`master-tab-btn ${scope === 'global' ? 'is-active' : ''}`}
                  aria-selected={scope === 'global'}
                  onClick={() => onScopeChange('global')}
                >
                  <Globe size={11} className="sidebar-scope-icon" />
                  <span>{t.workspace.global}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`master-tab-btn ${scope === 'project' ? 'is-active' : ''}`}
                  aria-selected={scope === 'project'}
                  onClick={() => onScopeChange('project')}
                >
                  <Folder size={11} className="sidebar-scope-icon" />
                  <span>{t.workspace.project}</span>
                </button>
              </div>

              {scope === 'project' && (
                <div className="sidebar-project-picker">
                  <div className="sidebar-project-select-wrap">
                    <select
                      className="sidebar-project-select"
                      value={selectedProjectId || ''}
                      onChange={(e) => onSelectProjectId?.(e.target.value)}
                      aria-label={t.workspace.selectProject}
                      disabled={!projects || projects.length === 0}
                    >
                      {!projects || projects.length === 0 ? (
                        <option value="">{t.workspace.noProjects}</option>
                      ) : (
                        <>
                          <option value="" disabled>
                            {t.workspace.selectProject}
                          </option>
                          {selectedProjectId && !selectedProject && (
                            <option value={selectedProjectId}>项目已移除</option>
                          )}
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}{p.status === 'missing' ? ` (${t.workspace.missingTag})` : ''}
                            </option>
                          ))}
                        </>
                      )}
                    </select>
                    <ChevronDown size={12} className="sidebar-project-select-arrow" />
                  </div>
                  {selectedProject?.status === 'missing' && (
                    <span className="sidebar-project-status-warn" role="alert">
                      {t.workspace.missingProject}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Main Navigation Capsule Views */}
          <nav className="sidebar-nav-list">
            <button type="button" className={`nav-pill-btn ${view === 'projects' ? 'is-active' : ''}`} onClick={() => { setView('projects'); onBackToOverview() }}>
              <div className="nav-pill-btn__left"><FolderTree size={15} className="nav-icon" /><span>{t.nav.projects}</span></div>
            </button>
            <button
              type="button"
              className={`nav-pill-btn ${view === 'skills' ? 'is-active' : ''}`}
              onClick={() => {
                setView('skills')
                onBackToOverview()
              }}
            >
              <div className="nav-pill-btn__left">
                <Zap size={15} className="nav-icon" />
                <span>{t.nav.skill}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${view === 'workflows' ? 'is-active' : ''}`}
              onClick={() => {
                setView('workflows')
                onBackToOverview()
              }}
            >
              <div className="nav-pill-btn__left">
                <WorkflowIcon size={15} className="nav-icon" />
                <span>{t.nav.workflow}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${view === 'mcp' ? 'is-active' : ''}`}
              onClick={() => {
                setView('mcp')
                onBackToOverview()
              }}
            >
              <div className="nav-pill-btn__left">
                <Server size={15} className="nav-icon" />
                <span>{t.nav.mcp}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${view === 'rules' ? 'is-active' : ''}`}
              onClick={() => {
                setView('rules')
                onBackToOverview()
              }}
            >
              <div className="nav-pill-btn__left">
                <BookOpen size={15} className="nav-icon" />
                <span>{t.nav.rules}</span>
              </div>
            </button>

            <button
              type="button"
              className={`nav-pill-btn ${view === 'accounts' ? 'is-active' : ''}`}
              aria-current={view === 'accounts' ? 'page' : undefined}
              onClick={() => {
                setView('accounts')
                onBackToOverview()
              }}
            >
              <div className="nav-pill-btn__left">
                <Users size={15} className="nav-icon" />
                <span>{t.nav.accounts}</span>
              </div>
            </button>
          </nav>

          {/* Clean Footer: Settings Entry & Master Column Toggle */}
          <div className="sidebar-footer">
            <AppUpdate compact />
            {!inSettings && view !== 'accounts' && onToggleMasterCollapse && (
              <button
                type="button"
                className={`nav-pill-btn master-toggle-nav-btn ${masterCollapsed ? 'is-collapsed' : ''}`}
                onClick={onToggleMasterCollapse}
                title={masterCollapsed ? `${t.nav.expandMaster} (⌘B)` : `${t.nav.collapseMaster} (⌘B)`}
                aria-label={masterCollapsed ? t.nav.expandMaster : t.nav.collapseMaster}
                aria-expanded={!masterCollapsed}
              >
                <div className="nav-pill-btn__left">
                  {masterCollapsed ? (
                    <PanelLeftOpen size={15} className="nav-icon" />
                  ) : (
                    <PanelLeftClose size={15} className="nav-icon" />
                  )}
                  <span>{masterCollapsed ? t.nav.expandMaster : t.nav.collapseMaster}</span>
                </div>
                <kbd className="sidebar-shortcut-tag">⌘B</kbd>
              </button>
            )}
            <button
              type="button"
              className="nav-pill-btn settings-entry-btn"
              onClick={onEnterSettings}
            >
              <div className="nav-pill-btn__left">
                <Settings size={15} className="nav-icon" />
                <span>{t.nav.settings}</span>
              </div>
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

/* =========================================================================
   Level 1: Workflows Overview (Clean Flat List & High-Density Rows)
   ========================================================================= */
function WorkflowsOverviewPage({
  items,
  savedMap,
  onOpenDetail,
  onSaveSkill,
  onDismiss,
  observing = true,
}: {
  items: Workflow[]
  savedMap: Record<string, boolean>
  onOpenDetail: (wf: Workflow) => void
  onSaveSkill: (wf: Workflow) => void
  onDismiss: (wfId: string) => void
  observing?: boolean
}) {
  const { t } = useI18n()

  return (
    <div className="clean-page view-enter">
      <header className="page-header stagger-item">
        <div className="page-header__left">
          <h1 className="page-title">{t.workflows.title}</h1>
          <span className="page-subtitle">{t.workflows.subtitle}</span>
        </div>
      </header>

      {items.length > 0 ? (
        /* Unified Flat Table Container */
        <div className="flat-table-wrap stagger-item">
          <div className="flat-rows-list">
            {items.map((wf, idx) => {
              const apps = Array.from(new Set(wf.nodes.map((n) => n.app).filter(Boolean)))
              const isSaved = Boolean(savedMap[wf.id])

              return (
                <div
                  key={wf.id}
                  className="flat-row stagger-item"
                  style={{ animationDelay: `${idx * 25}ms` }}
                  onClick={() => onOpenDetail(wf)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flat-row__left">
                    <div className="flat-title-row">
                      <strong className="flat-row-title">{wf.name}</strong>
                      <span className="conf-pill font-mono">{t.workflows.confidenceBadge(wf.confidence)}</span>
                    </div>
                    <p className="flat-row-desc">{wf.summary}</p>
                  </div>

                  <div className="flat-row__middle">
                    <div className="app-chips-row">
                      {apps.map((a) => (
                        <span key={a} className="app-capsule-chip font-mono">
                          {a}
                        </span>
                      ))}
                    </div>
                    <WorkflowGraph workflow={wf} compact />
                  </div>

                  <div className="flat-row__right" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={`btn btn--capsule ${isSaved ? 'btn--saved' : 'btn--primary'}`}
                      onClick={() => onSaveSkill(wf)}
                    >
                      <Check size={13} className={`btn-check-icon ${isSaved ? 'is-animating' : ''}`} />
                      <span>{isSaved ? t.workflows.savedAsSkill : t.workflows.saveAsSkill}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn--capsule-ghost icon-only"
                      onClick={() => onDismiss(wf.id)}
                      title={t.workflows.dismissAction}
                    >
                      <Trash2 size={13} />
                    </button>
                    <div className="row-chevron-indicator" onClick={() => onOpenDetail(wf)}>
                      <ChevronRight size={14} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        /* Zero-Card Clean Empty State */
        <div className="clean-empty-state stagger-item">
          <div className="empty-icon-halo">
            <Sparkles size={28} className="empty-icon-glow" />
          </div>
          <h3 className="empty-title">{t.workflows.emptyTitle}</h3>
          <p className="empty-desc">{t.workflows.emptyDesc}</p>
          <div className="empty-status-pill font-mono">
            <span className={`live-pulsing-dot ${observing ? 'is-observing' : 'is-paused'}`} />
            <span>{observing ? t.workflows.observingLiveHint : t.workflows.observingPausedHint}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/* =========================================================================
   Level 1: Skills Overview (Clean Flat Table & Segmented Filter)
   ========================================================================= */
function SkillSegmentedTabs({
  value,
  onChange,
}: {
  value: 'local' | 'remote'
  onChange: (val: 'local' | 'remote') => void
}) {
  const { t } = useI18n()
  const options = useMemo(
    () => [
      { key: 'local' as const, label: t.skills.tabLocal, icon: Folder },
      { key: 'remote' as const, label: t.skills.tabRemote, icon: Globe },
    ],
    [t],
  )

  const [indicator, setIndicator] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  })
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const trackRef = useRef<HTMLDivElement>(null)

  const updatePosition = () => {
    const activeIndex = options.findIndex((opt) => opt.key === value)
    const activeBtn = tabRefs.current[activeIndex]
    if (activeBtn) {
      setIndicator({
        left: activeBtn.offsetLeft,
        width: activeBtn.offsetWidth,
        ready: true,
      })
    }
  }

  useEffect(() => {
    updatePosition()
    const timer = setTimeout(updatePosition, 30)
    return () => clearTimeout(timer)
  }, [value, t])

  useEffect(() => {
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      updatePosition()
    })
    ro.observe(track)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="segmented-pill-track" ref={trackRef} role="tablist" aria-label={t.skills.title}>
      {indicator.ready && indicator.width > 0 ? (
        <div
          className="segmented-pill-indicator"
          style={{
            transform: `translate3d(${indicator.left}px, 0, 0)`,
            width: `${indicator.width}px`,
          }}
        />
      ) : null}

      {options.map((opt, idx) => {
        const Icon = opt.icon
        const isActive = opt.key === value
        return (
          <button
            key={opt.key}
            ref={(el) => {
              tabRefs.current[idx] = el
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`segmented-pill-btn ${isActive ? 'is-active' : ''}`}
            onClick={() => onChange(opt.key)}
          >
            <Icon size={15} className="pill-icon" />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function ToolIcon({ name, size = 12, className }: { name: string; size?: number; className?: string }) {
  switch (name) {
    case 'Zap':
      return <Zap size={size} className={className} />
    case 'Sparkles':
      return <Sparkles size={size} className={className} />
    case 'Terminal':
      return <Terminal size={size} className={className} />
    case 'Monitor':
      return <Monitor size={size} className={className} />
    case 'Boxes':
      return <Boxes size={size} className={className} />
    case 'FolderTree':
      return <FolderTree size={size} className={className} />
    default:
      return <Code size={size} className={className} />
  }
}

function AIToolTargetPill({
  tool,
  isLinked,
  isBroken,
  onClick,
  title,
}: {
  tool: AIToolTarget
  isLinked: boolean
  isBroken?: boolean
  onClick: (e: React.MouseEvent) => void
  title?: string
}) {
  return (
    <button
      type="button"
      className={`target-capsule-pill ${isLinked ? 'is-linked' : 'is-unlinked'} ${isBroken ? 'is-broken' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick(e)
      }}
      title={title}
    >
      <span className="target-pill-icon">
        <AIToolLogo toolId={tool.id} size={13} color={isLinked} />
      </span>
      <span className="target-pill-name">{tool.name}</span>
      {isLinked ? (
        <Link2 size={10} className="target-pill-status-icon is-active" />
      ) : (
        <span className="target-pill-dot" />
      )}
    </button>
  )
}

function SafeDeleteSkillModal({
  skill,
  aiTools,
  open,
  onClose,
  onConfirm,
}: {
  skill: Skill | null
  aiTools: AIToolTarget[]
  open: boolean
  onClose: () => void
  onConfirm: (skill: Skill, mode: DeleteSkillMode) => void | Promise<void>
}) {
  const { t } = useI18n()
  const [deleting, setDeleting] = useState(false)
  const [deleteMode, setDeleteMode] = useState<DeleteSkillMode>('trash')
  const deletingRef = useRef(false)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    deletingRef.current = false
    setDeleting(false)
    setDeleteMode('trash')
    const focusTimer = window.setTimeout(() => cancelButtonRef.current?.focus(), 40)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deletingRef.current) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  if (!open || !skill) return null

  const linkedTools = aiTools.filter((tool) => skill.targetTools?.includes(tool.id))

  const handleConfirm = async () => {
    if (deleting) return
    deletingRef.current = true
    setDeleting(true)
    try {
      await onConfirm(skill, deleteMode)
      onClose()
    } catch {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  return (
    <div
      className="modal-backdrop safe-delete-backdrop view-enter"
      onMouseDown={() => {
        if (!deleting) onClose()
      }}
    >
      <div
        className="dialog-surface safe-delete-dialog modal-pop"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="safe-delete-title"
        aria-describedby="safe-delete-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="safe-delete-header">
          <div className={`danger-icon-badge ${deleteMode === 'permanent' ? 'is-critical' : 'is-recoverable'}`}>
            {deleteMode === 'trash' ? <Archive size={18} /> : <AlertTriangle size={20} />}
          </div>
          <div className="safe-delete-heading-copy">
            <h2 id="safe-delete-title">{t.skills.safeDeleteConfirmTitle}</h2>
            <p id="safe-delete-description">{t.skills.safeDeleteConfirmDesc(skill.name, linkedTools.length)}</p>
          </div>
        </div>

        <div className="dialog-body" style={{ minHeight: 0, overflowY: 'auto' }}>
        <fieldset className="safe-delete-mode-fieldset" disabled={deleting}>
          <legend>{t.skills.safeDeleteModeLabel}</legend>
          <div className="safe-delete-mode-options">
            <label className={`safe-delete-mode-option ${deleteMode === 'trash' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="delete-skill-mode"
                value="trash"
                checked={deleteMode === 'trash'}
                onChange={() => setDeleteMode('trash')}
              />
              <Archive size={15} aria-hidden="true" />
              <span>
                <strong>{t.skills.safeDeleteTrashTitle}</strong>
                <small>{t.skills.safeDeleteTrashDesc}</small>
              </span>
            </label>
            <label className={`safe-delete-mode-option is-permanent ${deleteMode === 'permanent' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="delete-skill-mode"
                value="permanent"
                checked={deleteMode === 'permanent'}
                onChange={() => setDeleteMode('permanent')}
              />
              <Trash2 size={15} aria-hidden="true" />
              <span>
                <strong>{t.skills.safeDeletePermanentTitle}</strong>
                <small>{t.skills.safeDeletePermanentDesc}</small>
              </span>
            </label>
          </div>
        </fieldset>

        {linkedTools.length > 0 ? (
          <div className="safe-delete-targets-list">
            <span className="safe-delete-targets-label">{t.skills.safeDeleteLinkedNotice}</span>
            <ul className="safe-delete-targets-grid">
              {linkedTools.map((tool) => (
                <li key={tool.id} className="safe-delete-target-row">
                  <span className="safe-delete-target-icon" aria-hidden="true">
                    <AIToolLogo toolId={tool.id} size={15} color />
                  </span>
                  <span className="safe-delete-target-copy">
                    <strong className="target-name">{tool.name}</strong>
                    <span
                      className="target-path font-mono"
                      title={`${tool.detectedPath || tool.defaultDir}/${skill.id}`}
                    >
                      {tool.detectedPath || tool.defaultDir}/{skill.id}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        </div>
        <div className="safe-delete-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="btn btn--secondary btn--capsule"
            onClick={onClose}
            disabled={deleting}
          >
            {t.skills.cancelBtn}
          </button>
          <button
            type="button"
            className={`btn ${deleteMode === 'permanent' ? 'btn--danger' : 'btn--primary'} btn--capsule`}
            onClick={() => void handleConfirm()}
            disabled={deleting}
          >
            {deleteMode === 'trash' ? <Archive size={13} /> : <Trash2 size={13} />}
            <span>
              {deleting
                ? deleteMode === 'trash' ? t.skills.movingToTrashBtn : t.skills.deletingBtn
                : deleteMode === 'trash' ? t.skills.moveToTrashBtn : t.skills.confirmDeleteBtn}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

function SkillAdoptionDialog({
  open,
  plan,
  result,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean
  plan: SkillAdoptionPlan | null
  result: BatchSkillAdoptionResult | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  if (!open || !plan) return null

  const readyItems = plan.items.filter(item => item.status === 'ready')
  const conflictItems = plan.items.filter(item => item.status !== 'ready')
  const completedTargets = result?.linkedTargetCount || 0
  const failedItems = result?.failedCount || 0

  return (
    <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
      <div
        className="dialog-surface skill-adoption-dialog modal-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-adoption-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div>
            <h2 id="skill-adoption-title">统一接管现有 Skill</h2>
            <p>将现有目录纳入 Trace 中心库，并统一为可恢复的软链接。</p>
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="dialog-body skill-adoption-dialog__body">
          {result ? (
            <div className={`skill-adoption-result ${result.success ? 'is-success' : 'is-partial'}`} role="status">
              <CheckCircle2 size={18} />
              <div>
                <strong>{result.success ? '接管完成' : '接管已完成一部分'}</strong>
                <span>已统一连接 {completedTargets} 个入口{failedItems > 0 ? `，${failedItems} 个 Skill 仍需处理` : ''}。</span>
              </div>
            </div>
          ) : (
            <>
              <div className="skill-adoption-summary">
                <div><strong>{plan.totalSkills}</strong><span>个 Skill</span></div>
                <div><strong>{plan.totalTargets}</strong><span>个全局 / 项目入口</span></div>
                <div><strong>{plan.adoptableTargets}</strong><span>个可直接接管</span></div>
              </div>
              <p className="skill-adoption-dialog__notice">
                Trace 会先复制到中心库，再替换目标入口。原目录会保留在 <code>~/.trace/.trash</code>，不会静默删除内容。
              </p>
              {readyItems.length > 0 ? (
                <div className="skill-adoption-list">
                  {readyItems.slice(0, 6).map(item => (
                    <div className="skill-adoption-list__row" key={item.key}>
                      <Check size={12} />
                      <span>{item.name}</span>
                      <small>{item.targets.length} 个入口</small>
                    </div>
                  ))}
                  {readyItems.length > 6 ? <small className="skill-adoption-list__more">还有 {readyItems.length - 6} 个 Skill</small> : null}
                </div>
              ) : null}
              {conflictItems.length > 0 ? (
                <div className="skill-adoption-warning">
                  <AlertTriangle size={13} />
                  <span>{conflictItems.length} 个 Skill 与中心库内容不同，本次不会自动覆盖。</span>
                </div>
              ) : null}
              {plan.errors.length > 0 ? (
                <div className="skill-adoption-warning">
                  <AlertTriangle size={13} />
                  <span>{plan.errors.length} 个入口无法读取，将保留原状。</span>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="dialog-footer-row">
          <button type="button" className="btn btn--secondary btn--capsule" onClick={onClose} disabled={busy}>关闭</button>
          {!result && plan.adoptableTargets > 0 ? (
            <button type="button" className="btn btn--primary btn--capsule" onClick={onConfirm} disabled={busy}>
              {busy ? <RefreshCw size={13} className="spin" /> : <Link2 size={13} />}
              <span>{busy ? '正在接管…' : `接管可处理项 (${plan.adoptableTargets})`}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface AIEnvGroup {
  key: string
  name: string
  logoId: string
  tools: AIToolTarget[]
}

const AI_ENVIRONMENT_FAMILIES = [
  { key: 'agents', name: 'agents', match: (t: AIToolTarget) => t.id.includes('agents') },
  { key: 'claude', name: 'Claude Code', match: (t: AIToolTarget) => t.id.includes('claude') },
  { key: 'cursor', name: 'Cursor', match: (t: AIToolTarget) => t.id.includes('cursor') },
  { key: 'gemini', name: 'Antigravity', match: (t: AIToolTarget) => t.id.includes('gemini') || t.id.includes('antigravity') },
  { key: 'trae', name: 'Trae', match: (t: AIToolTarget) => t.id.includes('trae') },
  { key: 'windsurf', name: 'Windsurf', match: (t: AIToolTarget) => t.id.includes('windsurf') },
  { key: 'roo', name: 'Roo Code', match: (t: AIToolTarget) => t.id.includes('roo') },
  { key: 'cline', name: 'Cline', match: (t: AIToolTarget) => t.id.includes('cline') },
  { key: 'codex', name: 'Codex', match: (t: AIToolTarget) => t.id.includes('codex') || t.id.includes('openai') },
  { key: 'opencode', name: 'OpenCode', match: (t: AIToolTarget) => t.id.includes('opencode') },
  { key: 'github', name: 'GitHub Copilot', match: (t: AIToolTarget) => t.id.includes('github') || t.id.includes('copilot') },
]

function groupAIToolsByEnvironment(tools: AIToolTarget[]): AIEnvGroup[] {
  const groups: AIEnvGroup[] = []
  const used = new Set<string>()

  for (const fam of AI_ENVIRONMENT_FAMILIES) {
    const matched = tools.filter((t) => fam.match(t))
    if (matched.length > 0) {
      matched.forEach((t) => used.add(t.id))
      matched.sort((a, b) => (a.scope === 'global' ? -1 : 1))
      groups.push({
        key: fam.key,
        name: fam.name,
        logoId: matched[0].id,
        tools: matched,
      })
    }
  }

  const remaining = tools.filter((t) => !used.has(t.id))
  for (const t of remaining) {
    groups.push({
      key: t.id,
      name: t.name,
      logoId: t.id,
      tools: [t],
    })
  }

  return groups
}

function ManageSkillLinksModal({
  skill,
  skills,
  aiTools,
  open,
  onClose,
  onToggleLinkTarget,
  onRefreshAiTools,
  notify,
}: {
  skill: Skill | null
  skills: Skill[]
  aiTools: AIToolTarget[]
  open: boolean
  onClose: () => void
  onToggleLinkTarget: (skill: Skill, targetId: string) => Promise<void>
  onRefreshAiTools?: () => Promise<void>
  notify?: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<'global' | 'project'>('global')
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [projectPathOperating, setProjectPathOperating] = useState<Record<string, boolean>>({})
  const [projectLinkMap, setProjectLinkMap] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!open) return
    if (window.workflowSkill?.listProjects) {
      window.workflowSkill.listProjects().then((projs) => {
        if (Array.isArray(projs)) setProjects(projs)
      }).catch(() => {})
    }
  }, [open])

  if (!open || !skill) return null

  const currentSkill = skills.find((s) => s.id === skill.id) || skill
  const targetTools = currentSkill.targetTools || []
  const targetProjects = currentSkill.targetProjects || []
  const targetProjectPaths = currentSkill.targetProjectPaths
  const envGroups = groupAIToolsByEnvironment(aiTools)
  const totalLinkedCount = aiTools.filter((t) => targetTools.includes(t.id)).length + targetProjects.length

  const handleToggleGroup = async (group: AIEnvGroup) => {
    if (busy) return
    const allLinked = group.tools.every((t) => targetTools.includes(t.id))
    const shouldLink = !allLinked

    setBusy(true)
    try {
      for (const t of group.tools) {
        const isLinked = targetTools.includes(t.id)
        if (shouldLink && !isLinked) {
          await onToggleLinkTarget(currentSkill, t.id)
        } else if (!shouldLink && isLinked) {
          await onToggleLinkTarget(currentSkill, t.id)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const handleToggleProjectPath = async (proj: ProjectRecord, relPath: string) => {
    if (busy || !currentSkill) return
    const key = `${proj.path}:${relPath}`
    const isCurrentlyLinked = Boolean(projectLinkMap[key] !== undefined
      ? projectLinkMap[key]
      : targetProjectPaths
        ? targetProjectPaths.some((item) =>
            item.projectPath.toLowerCase() === proj.path.toLowerCase() && item.relPath === relPath)
        : targetProjects.some((p) => p && p.toLowerCase() === proj.path.toLowerCase()))
    setProjectPathOperating((prev) => ({ ...prev, [key]: true }))

    try {
      if (isCurrentlyLinked) {
        if (window.workflowSkill?.uninjectSkill) {
          const res = await window.workflowSkill.uninjectSkill(currentSkill.id, {
            scope: 'project',
            projectPath: proj.path,
            relPath,
          })
          if (res.success) {
            setProjectLinkMap((prev) => ({ ...prev, [key]: false }))
            currentSkill.targetProjectPaths = (currentSkill.targetProjectPaths || []).filter((item) =>
              !(item.projectPath.toLowerCase() === proj.path.toLowerCase() && item.relPath === relPath))
            if (!currentSkill.targetProjectPaths.some((item) =>
              item.projectPath.toLowerCase() === proj.path.toLowerCase())) {
              currentSkill.targetProjects = (currentSkill.targetProjects || []).filter(
                (p) => p.toLowerCase() !== proj.path.toLowerCase())
            }
            await onRefreshAiTools?.()
          } else {
            notify?.(res.error || `取消注入失败`)
          }
        }
      } else {
        if (window.workflowSkill?.injectSkill) {
          const res = await window.workflowSkill.injectSkill(currentSkill.id, {
            scope: 'project',
            projectPath: proj.path,
            relPath,
          })
          if (res.success) {
            setProjectLinkMap((prev) => ({ ...prev, [key]: true }))
            currentSkill.targetProjects = Array.from(new Set([...(currentSkill.targetProjects || []), proj.path]))
            currentSkill.targetProjectPaths = [
              ...(currentSkill.targetProjectPaths || []).filter((item) =>
                !(item.projectPath.toLowerCase() === proj.path.toLowerCase() && item.relPath === relPath)),
              { projectPath: proj.path, relPath },
            ]
            await onRefreshAiTools?.()
          } else {
            notify?.(res.error || `注入失败`)
          }
        }
      }
    } catch (err: any) {
      notify?.(err?.message || `操作失败`)
    } finally {
      setProjectPathOperating((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleBatchToggleProject = async (proj: ProjectRecord, shouldInject: boolean) => {
    if (busy || !currentSkill) return
    setBusy(true)
    try {
      const successfulPaths: string[] = []
      const errors: string[] = []
      for (const sp of SUPPORTED_PROJECT_SKILL_PATHS) {
        const key = `${proj.path}:${sp.relPath}`
        if (shouldInject) {
          if (window.workflowSkill?.batchInjectSkills) {
            const res = await window.workflowSkill.batchInjectSkills([currentSkill.id], {
              scope: 'project',
              projectPath: proj.path,
              relPath: sp.relPath,
            })
            const failed = res.results.find((item) => !item.success)
            if (failed) {
              errors.push(failed.error || `${sp.relPath} 注入失败`)
              continue
            }
          }
          successfulPaths.push(sp.relPath)
          setProjectLinkMap((prev) => ({ ...prev, [key]: true }))
        } else {
          if (window.workflowSkill?.batchUninjectSkills) {
            const res = await window.workflowSkill.batchUninjectSkills([currentSkill.id], {
              scope: 'project',
              projectPath: proj.path,
              relPath: sp.relPath,
            })
            const failed = res.results.find((item) => !item.success)
            if (failed) {
              errors.push(failed.error || `${sp.relPath} 取消失败`)
              continue
            }
          }
          successfulPaths.push(sp.relPath)
          setProjectLinkMap((prev) => ({ ...prev, [key]: false }))
        }
      }
      if (shouldInject) {
        if (successfulPaths.length > 0) {
          currentSkill.targetProjects = Array.from(new Set([...(currentSkill.targetProjects || []), proj.path]))
          currentSkill.targetProjectPaths = [
            ...(currentSkill.targetProjectPaths || []).filter((item) =>
              item.projectPath.toLowerCase() !== proj.path.toLowerCase() || !successfulPaths.includes(item.relPath)),
            ...successfulPaths.map((relPath) => ({ projectPath: proj.path, relPath })),
          ]
          await onRefreshAiTools?.()
        }
      } else {
        if (successfulPaths.length > 0) {
          currentSkill.targetProjectPaths = (currentSkill.targetProjectPaths || []).filter((item) =>
            item.projectPath.toLowerCase() !== proj.path.toLowerCase() || !successfulPaths.includes(item.relPath))
          if (!currentSkill.targetProjectPaths.some((item) => item.projectPath.toLowerCase() === proj.path.toLowerCase())) {
            currentSkill.targetProjects = (currentSkill.targetProjects || []).filter(
              (p) => p.toLowerCase() !== proj.path.toLowerCase()
            )
          }
          await onRefreshAiTools?.()
        }
      }
      if (errors.length > 0 && successfulPaths.length === 0) {
        notify?.(errors.join('; '))
      }
    } catch (err: any) {
      notify?.(err?.message || `批量操作失败`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop view-enter" onClick={onClose}>
      <div
        className="dialog-surface modal-pop env-link-tree-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Dialog Header */}
        <div className="dialog-header-row env-tree-dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Link2 size={15} style={{ color: 'var(--color-ink)' }} />
            <h3 className="dialog-title" style={{ margin: 0, fontSize: 'var(--text-section)', fontWeight: 650 }}>
              {currentSkill.name}
            </h3>
          </div>
          <button type="button" className="clear-search-btn" onClick={onClose} style={{ cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>

        {/* Tab Switcher: [ 全局宿主 | 工程项目 ] */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 16px 10px' }}>
          <div className="master-tab-segmented" style={{ width: 'fit-content' }}>
            <button
              type="button"
              className={`master-tab-btn ${activeTab === 'global' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('global')}
              disabled={busy}
            >
              <span>全局宿主</span>
            </button>
            <button
              type="button"
              className={`master-tab-btn ${activeTab === 'project' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('project')}
              disabled={busy}
            >
              <span>工程项目 ({projects.length})</span>
            </button>
          </div>
        </div>

        {/* Tree Body */}
        <div className="env-tree-body" style={{ maxHeight: '380px', overflowY: 'auto' }}>
          {activeTab === 'global' ? (
            envGroups.map((group) => {
              const linkedCount = group.tools.filter((t) => targetTools.includes(t.id)).length
              const allLinked = group.tools.length > 0 && linkedCount === group.tools.length
              const hasLinked = linkedCount > 0

              return (
                <div key={group.key} className="env-tree-branch">
                  <div className="env-tree-branch-header">
                    <div className="branch-header-left">
                      <AIToolLogo toolId={group.logoId} size={16} />
                      <span className="branch-title">{group.name}</span>
                      {group.tools.length > 1 ? (
                        <span className="branch-badge font-mono">
                          {linkedCount}/{group.tools.length}
                        </span>
                      ) : hasLinked ? (
                        <span className="branch-badge font-mono" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)', borderColor: 'var(--color-success-border)' }}>
                          已注入
                        </span>
                      ) : null}
                    </div>

                    {group.tools.length > 1 ? (
                      <div className="branch-header-actions">
                        <button
                          type="button"
                          className="btn btn--capsule-ghost btn--capsule btn--sm branch-action-btn"
                          onClick={() => void handleToggleGroup(group)}
                          disabled={busy}
                        >
                          {allLinked ? '取消' : '全选'}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="env-tree-children" style={{ paddingLeft: '14px' }}>
                    {group.tools.map((tool) => {
                      const isLinked = targetTools.includes(tool.id)
                      const isProject = tool.scope === 'project'

                      return (
                        <div
                          key={tool.id}
                          className={`env-tree-node-row ${isLinked ? 'is-linked' : ''}`}
                          onClick={() => void onToggleLinkTarget(currentSkill, tool.id)}
                        >
                          <div className="node-content-left">
                            <span
                              className={`env-scope-tag ${isProject ? 'is-project' : 'is-global'}`}
                              title={isProject ? '当前项目工作区目录' : '用户全局主目录'}
                            >
                              {isProject ? <FolderTree size={10} /> : <Globe size={10} />}
                              <span>{isProject ? '项目' : '全局'}</span>
                            </span>

                            <span className="node-path font-mono">
                              {tool.detectedPath || tool.defaultDir}
                            </span>
                          </div>

                          <button
                            type="button"
                            className={`btn btn--capsule btn--sm ${isLinked ? 'btn--secondary' : 'btn--capsule-ghost'}`}
                            style={{ pointerEvents: 'none', height: '22px', fontSize: 'var(--text-caption)', padding: '0 10px', flexShrink: 0 }}
                          >
                            {isLinked ? <Check size={11} /> : <Link2 size={11} />}
                            <span>{isLinked ? '已注入' : '未注入'}</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          ) : projects.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--color-muted)' }}>
              <Folder size={24} style={{ margin: '0 auto 8px', opacity: 0.4 }} />
              <p style={{ fontSize: 'var(--text-body)', margin: 0 }}>暂无已登记的项目工作区</p>
              <p style={{ fontSize: 'var(--text-control)', margin: '4px 0 0', opacity: 0.7 }}>
                请先在 MCP 页面或系统设置中添加本地项目文件夹
              </p>
            </div>
          ) : (
            projects.map((proj) => {
              const isProjectLinked = SUPPORTED_PROJECT_SKILL_PATHS.some((item) => {
                const key = `${proj.path}:${item.relPath}`
                if (projectLinkMap[key] !== undefined) return projectLinkMap[key]
                return targetProjectPaths
                  ? targetProjectPaths.some((target) =>
                      target.projectPath.toLowerCase() === proj.path.toLowerCase() && target.relPath === item.relPath)
                  : targetProjects.some((p) => p && p.toLowerCase() === proj.path.toLowerCase())
              })

              return (
                <div key={proj.id} className="env-tree-branch">
                  <div className="env-tree-branch-header">
                    <div className="branch-header-left">
                      <Folder size={15} style={{ color: 'var(--color-ink)' }} />
                      <span className="branch-title">{proj.name}</span>
                      {isProjectLinked ? (
                        <span className="branch-badge font-mono" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)', borderColor: 'var(--color-success-border)' }}>
                          已关联
                        </span>
                      ) : null}
                    </div>

                    <div className="branch-header-actions">
                      <button
                        type="button"
                        className="btn btn--capsule-ghost btn--capsule btn--sm branch-action-btn"
                        onClick={() => void handleBatchToggleProject(proj, !isProjectLinked)}
                        disabled={busy}
                      >
                        {isProjectLinked ? '取消全部' : '全选注入'}
                      </button>
                    </div>
                  </div>

                  <div className="env-tree-children" style={{ paddingLeft: '14px' }}>
                    {SUPPORTED_PROJECT_SKILL_PATHS.map((sp) => {
                      const key = `${proj.path}:${sp.relPath}`
                      const isNodeLinked = Boolean(
                        projectLinkMap[key] !== undefined
                          ? projectLinkMap[key]
                          : targetProjectPaths
                            ? targetProjectPaths.some((target) =>
                                target.projectPath.toLowerCase() === proj.path.toLowerCase() && target.relPath === sp.relPath)
                            : isProjectLinked
                      )
                      const isOp = Boolean(projectPathOperating[key])

                      return (
                        <div
                          key={sp.id}
                          className={`env-tree-node-row ${isNodeLinked ? 'is-linked' : ''}`}
                          onClick={() => void handleToggleProjectPath(proj, sp.relPath)}
                        >
                          <div className="node-content-left">
                            <span className="env-scope-tag is-project" title={sp.name}>
                              <FolderTree size={10} />
                              <span>{sp.name}</span>
                            </span>

                            <span className="node-path font-mono">
                              {proj.name}/{sp.relPath}
                            </span>
                          </div>

                          <button
                            type="button"
                            className={`btn btn--capsule btn--sm ${isNodeLinked ? 'btn--secondary' : 'btn--capsule-ghost'}`}
                            style={{ pointerEvents: 'none', height: '22px', fontSize: 'var(--text-caption)', padding: '0 10px', flexShrink: 0 }}
                          >
                            {isOp ? (
                              <RefreshCw size={11} className="spin" />
                            ) : isNodeLinked ? (
                              <Check size={11} />
                            ) : (
                              <Link2 size={11} />
                            )}
                            <span>{isNodeLinked ? '已注入' : '未注入'}</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Dialog Footer */}
        <div className="dialog-footer-row env-tree-dialog-footer">
          <div style={{ fontSize: 'var(--text-control)', color: 'var(--color-muted)' }}>
            当前已注入到 <strong>{totalLinkedCount}</strong> 个环境与工作区
          </div>
          <button type="button" className="btn btn--primary btn--capsule btn--sm" onClick={onClose}>
            <span>完成</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function ExpandableSkillDesc({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > 100
  return (
    <div style={{ marginTop: '6px', fontSize: 'var(--text-body)', color: 'var(--color-muted)', lineHeight: 1.5 }}>
      <p style={{ margin: 0, display: expanded || !isLong ? 'block' : '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {text}
      </p>
      {isLong && (
        <button
          type="button"
          className="btn btn--capsule-ghost btn--sm"
          style={{ padding: 0, height: '18px', fontSize: 'var(--text-caption)', marginTop: '2px', color: 'var(--color-ink)', cursor: 'pointer' }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起描述' : '展开描述'}
        </button>
      )}
    </div>
  )
}

function getSkillOwnershipLabel(skill: Skill): string {
  if (skill.scopeStatus === '待接管') return '待接管'
  if (skill.ownership === 'external') return '外部持有'
  if (skill.scopeStatus === '冲突' || skill.scopeStatus === '链接损坏') return skill.scopeStatus
  if (skill.scopeStatus === '全局软链' || skill.scopeStatus === '项目软链') return skill.scopeStatus
  if (skill.ownership === 'app') return '应用管理'
  return skill.scopeStatus || '未注入'
}

function getSkillOwnershipClass(skill: Skill): string {
  const label = getSkillOwnershipLabel(skill)
  if (label === '外部持有') return 'skill-ownership-badge--external'
  if (label === '待接管') return 'skill-ownership-badge--pending'
  if (label === '冲突' || label === '链接损坏') return 'skill-ownership-badge--conflict'
  if (label === '全局软链' || label === '项目软链') return 'skill-ownership-badge--linked'
  if (label === '未注入') return 'skill-ownership-badge--unbound'
  return 'skill-ownership-badge--app'
}

function getSkillTargetLabel(target: { scope: 'global' | 'project'; toolId?: string; projectPath?: string; relPath?: string }): string {
  if (target.scope === 'global') return target.toolId || '全局环境'
  const projectName = target.projectPath?.split(/[\\/]/).filter(Boolean).pop() || '项目'
  return `${projectName}${target.relPath ? ` · ${target.relPath}` : ''}`
}

/* =========================================================================
   3-Column macOS Pro View: Skills Architecture (Column 2 + Column 3)
   ========================================================================= */
function SkillsThreeColumn({
  skills,
  aiTools,
  selectedSkillId,
  onSelectSkillId,
  onToggleLinkTarget,
  onDeleteSkill,
  onReloadSkills,
  onExportCode,
  notify,
  scope: controlledScope,
  onScopeChange: controlledOnScopeChange,
  projects: controlledProjects,
  selectedProjectId: controlledSelectedProjectId,
  onSelectProjectId: controlledOnSelectProjectId,
  selectedProject: controlledSelectedProject,
  onRefreshProjects,
}: {
  skills: Skill[]
  aiTools: AIToolTarget[]
  selectedSkillId: string
  onSelectSkillId: (id: string) => void
  onToggleLinkTarget: (skill: Skill, targetId: string) => Promise<void>
  onDeleteSkill: (skill: Skill, mode: DeleteSkillMode) => Promise<void>
  onReloadSkills: () => Promise<void>
  onExportCode: (workflow: Workflow, name: string) => void
  notify?: (msg: string) => void
  scope?: 'global' | 'project'
  onScopeChange?: (scope: 'global' | 'project') => void
  projects?: ManagedProjectRecord[]
  selectedProjectId?: string
  onSelectProjectId?: (id: string) => void
  selectedProject?: ManagedProjectRecord | null
  onRefreshProjects?: () => Promise<void> | void
}) {
  const isControlledScope = controlledScope !== undefined
  const [internalSkillTab, setInternalSkillTab] = useState<'global' | 'project'>('global')
  const skillTab = isControlledScope ? controlledScope : internalSkillTab
  const setSkillTab = (nextScope: 'global' | 'project') => {
    if (isControlledScope) {
      controlledOnScopeChange?.(nextScope)
    } else {
      setInternalSkillTab(nextScope)
    }
  }

  const isControlledProjects = controlledProjects !== undefined
  const [internalProjects, setInternalProjects] = useState<ManagedProjectRecord[]>([])
  const projects = isControlledProjects ? controlledProjects : internalProjects

  const isControlledProjectId = controlledSelectedProjectId !== undefined
  const [internalProjectId, setInternalProjectId] = useState('')
  const projectId = isControlledProjectId ? controlledSelectedProjectId : internalProjectId
  const setProjectId = (nextId: string) => {
    if (isControlledProjectId) {
      controlledOnSelectProjectId?.(nextId)
    } else {
      setInternalProjectId(nextId)
    }
  }

  const [projectError, setProjectError] = useState('')
  const [skillMdContent, setSkillMdContent] = useState('')
  const [deleteModalSkill, setDeleteModalSkill] = useState<Skill | null>(null)
  const [linkModalSkill, setLinkModalSkill] = useState<Skill | null>(null)
  const [addTarget, setAddTarget] = useState<SkillScopeTarget | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const [adoptingSkill, setAdoptingSkill] = useState(false)
  const [disconnectingSkillTarget, setDisconnectingSkillTarget] = useState<string | null>(null)
  const [skillConflictBinding, setSkillConflictBinding] = useState<SkillTargetBinding | null>(null)
  const [skillConflictBusy, setSkillConflictBusy] = useState(false)
  const [skillConflictError, setSkillConflictError] = useState('')
  const [skillAdoptionPlan, setSkillAdoptionPlan] = useState<SkillAdoptionPlan | null>(null)
  const [skillAdoptionResult, setSkillAdoptionResult] = useState<BatchSkillAdoptionResult | null>(null)
  const [skillAdoptionOpen, setSkillAdoptionOpen] = useState(false)
  const [skillAdoptionBusy, setSkillAdoptionBusy] = useState(false)
  const [isDiagnosticMode, setIsDiagnosticMode] = useState(false)
  useUpdateBlocker('skill-add', addOpen || createOpen)
  useUpdateBlocker('skill-conflict', Boolean(skillConflictBinding))
  useUpdateBlocker('skill-adoption', (skillAdoptionOpen || isDiagnosticMode) && skillAdoptionBusy)
  useEffect(() => {
    if (isControlledProjects) return
    let active = true
    let generation = 0
    const refresh = async () => {
      const current = ++generation
      try {
        if (!window.workflowSkill?.listManagedProjects) throw new Error('项目管理暂不可用')
        const [result, activeProject] = await Promise.all([window.workflowSkill.listManagedProjects(), window.workflowSkill.getActiveProject?.()])
        if (!active || current !== generation) return
        setInternalProjects(result)
        setProjectError('')
        setInternalProjectId(previous => previous || result.find(project => project.id === activeProject?.id && project.status === 'valid')?.id || result.find(project => project.status === 'valid')?.id || '')
      } catch (error) {
        if (active && current === generation) {
          setInternalProjects([])
          setProjectError(error instanceof Error ? error.message : '读取项目失败')
        }
      }
    }
    void refresh()
    const unsubscribe = window.workflowSkill?.onProjectsChanged?.(() => void refresh())
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => { active = false; unsubscribe?.(); window.removeEventListener('focus', onFocus) }
  }, [isControlledProjects])
  const selectedProject = controlledSelectedProject !== undefined
    ? controlledSelectedProject
    : (projects.find(project => project.id === projectId) || null)
  const target: SkillScopeTarget | null = skillTab === 'global' ? { scope: 'global' }
    : selectedProject?.status === 'valid' ? { scope: 'project', id: selectedProject.id, name: selectedProject.name, path: selectedProject.path } : null
  const installedTools = useMemo(() => aiTools.filter(tool => tool.installed), [aiTools])
  const projectDiscovery = useProjectSkills(target?.scope === 'project' ? target.path : null)
  const visibleSkills = skillTab === 'project' ? projectDiscovery.skills : skillsInScope(skills, target)
  const managedSkills = useMemo(() => {
    return visibleSkills.filter(skill => skill.ownership === 'app' && skill.scopeStatus !== '待接管' && skill.scopeStatus !== '外部持有')
  }, [visibleSkills])
  const externalSkills = useMemo(() => {
    return visibleSkills.filter(skill => skill.ownership !== 'app' || skill.scopeStatus === '待接管' || skill.scopeStatus === '外部持有')
  }, [visibleSkills])
  const activeLocalSkill = isDiagnosticMode
    ? null
    : (visibleSkills.find(skill => skill.id === selectedSkillId) || managedSkills[0] || externalSkills[0] || null)
  const displaySkills = useMemo(() => {
    if (managedSkills.length > 0) {
      if (activeLocalSkill && activeLocalSkill.ownership !== 'app' && !managedSkills.some(s => s.id === activeLocalSkill.id)) {
        return [...managedSkills, activeLocalSkill]
      }
      return managedSkills
    }
    return visibleSkills
  }, [managedSkills, activeLocalSkill, visibleSkills])
  const activeLinkedTools = aiTools.filter(tool => activeLocalSkill?.targetTools?.includes(tool.id))
  const activeSkillBindings = (activeLocalSkill?.targetBindings || []).filter(binding => {
    if (binding.scope !== skillTab) return false
    if (skillTab === 'project' && selectedProject?.path && binding.projectPath) {
      return binding.projectPath === selectedProject.path
    }
    return true
  })
  const disconnectableSkillBindings = activeSkillBindings.filter(binding => binding.status === 'linked')
  const refreshSkillAdoptionPlan = async () => {
    if (!window.workflowSkill?.getSkillAdoptionPlan) return
    try {
      const plan = await window.workflowSkill.getSkillAdoptionPlan()
      setSkillAdoptionPlan(plan)
    } catch {
      setSkillAdoptionPlan(null)
    }
  }
  useEffect(() => {
    void refreshSkillAdoptionPlan()
  }, [])
  useEffect(() => {
    let active = true
    setSkillMdContent(activeLocalSkill?.skillMarkdown || '')
    if (activeLocalSkill && !activeLocalSkill.projectSource && window.workflowSkill?.readSkillMarkdown) {
      void window.workflowSkill.readSkillMarkdown(activeLocalSkill.id).then(content => {
        if (active && content) setSkillMdContent(content)
      }).catch(() => {})
    }
    return () => { active = false }
  }, [activeLocalSkill?.id, activeLocalSkill?.skillMarkdown, skillTab, projectId])
  const add = async (skill: Skill) => {
    const api = window.workflowSkill
    if (!addTarget || !api?.listManagedProjects || !api.loadLocalSkills || !api.saveLocalSkill || !api.injectSkill) {
      throw new Error('添加暂不可用，请重新打开应用。')
    }
    try {
      await addSkillToScope({ listManagedProjects: api.listManagedProjects, loadLocalSkills: api.loadLocalSkills,
        saveLocalSkill: api.saveLocalSkill, injectSkill: api.injectSkill }, skill, addTarget)
      onSelectSkillId(skill.id)
      notify?.(addTarget.scope === 'global' ? '已添加到全局技能库' : `已添加到项目 ${addTarget.name}`)
    } finally {
      projectDiscovery.refresh()
      await onReloadSkills().catch(() => notify?.('列表刷新失败，请重新打开 Skill 页面。'))
      await onRefreshProjects?.()
    }
  }
  const handleAdoptSkill = async () => {
    const external = activeLocalSkill?.externalSource
    if (!activeLocalSkill || !external || !window.workflowSkill?.adoptSkill) return
    const skillId = external.fullPath.split(/[\\/]/).filter(Boolean).pop() || activeLocalSkill.id
    setAdoptingSkill(true)
    try {
      const result = await window.workflowSkill.adoptSkill({
        type: external.type,
        toolId: external.toolId,
        projectPath: external.projectPath,
        relPath: external.relPath,
        skillId,
      })
      if (!result.success || !result.skill) {
        notify?.(result.error || '纳入应用管理失败')
        return
      }
      onSelectSkillId(result.skill.id)
      projectDiscovery.refresh()
      await onReloadSkills()
      await refreshSkillAdoptionPlan()
      await onRefreshProjects?.()
      notify?.(`已成功纳入应用管理: ${result.skill.name}`)
    } catch (error) {
      notify?.(error instanceof Error ? error.message : '纳入应用管理失败')
    } finally {
      setAdoptingSkill(false)
    }
  }
  const handleAdoptAllSkills = async () => {
    if (skillAdoptionBusy || !window.workflowSkill?.adoptAllSkills) return
    setSkillAdoptionBusy(true)
    setSkillAdoptionResult(null)
    try {
      const result = await window.workflowSkill.adoptAllSkills()
      setSkillAdoptionResult(result)
      projectDiscovery.refresh()
      await onReloadSkills()
      await refreshSkillAdoptionPlan()
      await onRefreshProjects?.()
      if (result.linkedTargetCount > 0) {
        notify?.(`已接管 ${result.adoptedCount} 个 Skill，统一连接 ${result.linkedTargetCount} 个入口`)
      } else if (result.skippedCount > 0) {
        notify?.(`已完成可处理项，仍有 ${result.skippedCount} 个 Skill 需要单独确认`)
      }
    } catch (error) {
      notify?.(error instanceof Error ? error.message : '批量接管 Skill 失败')
    } finally {
      setSkillAdoptionBusy(false)
    }
  }
  const handleAdoptBinding = async (binding: SkillTargetBinding) => {
    if (!activeLocalSkill || !window.workflowSkill?.adoptSkill || adoptingSkill) return
    const skillId = binding.targetPath.split(/[\\/]/).filter(Boolean).pop() || activeLocalSkill.id
    setAdoptingSkill(true)
    try {
      const result = await window.workflowSkill.adoptSkill({
        type: binding.scope,
        toolId: binding.toolId,
        projectPath: binding.projectPath,
        relPath: binding.relPath,
        skillId,
        targetPath: binding.targetPath,
      })
      if (!result.success || !result.skill) {
        notify?.(result.error || '接管 Skill 失败')
        return
      }
      onSelectSkillId(result.skill.id)
      projectDiscovery.refresh()
      await onReloadSkills()
      await refreshSkillAdoptionPlan()
      await onRefreshProjects?.()
      notify?.(`已接管 ${result.skill.name}，并连接到 ${getSkillTargetLabel(binding)}`)
    } catch (error) {
      notify?.(error instanceof Error ? error.message : '接管 Skill 失败')
    } finally {
      setAdoptingSkill(false)
    }
  }
  const handleDisconnectSkillTarget = async (binding: NonNullable<Skill['targetBindings']>[number]) => {
    if (!activeLocalSkill || !window.workflowSkill?.disconnectSkill) return
    const key = `${binding.scope}:${binding.toolId || ''}:${binding.projectPath || ''}:${binding.relPath || ''}`
    setDisconnectingSkillTarget(key)
    try {
      const result = await window.workflowSkill.disconnectSkill(activeLocalSkill.id, binding.scope === 'global'
        ? { scope: 'global', targetId: binding.toolId }
        : { scope: 'project', projectPath: binding.projectPath, relPath: binding.relPath })
      if (!result.success) {
        notify?.(result.error || '断开 Skill 失败')
        return
      }
      projectDiscovery.refresh()
      await onReloadSkills()
      await onRefreshProjects?.()
      notify?.(`已断开 ${getSkillTargetLabel(binding)}，中央 Skill 资产仍保留`)
    } catch (error) {
      notify?.(error instanceof Error ? error.message : '断开 Skill 失败')
    } finally {
      setDisconnectingSkillTarget(null)
    }
  }
  const handleResolveSkillConflict = async (strategy: ConflictResolutionStrategy) => {
    if (!activeLocalSkill || !skillConflictBinding || !window.workflowSkill?.resolveSkillConflict) return
    setSkillConflictBusy(true)
    setSkillConflictError('')
    try {
      const binding = skillConflictBinding
      const result = await window.workflowSkill.resolveSkillConflict({
        skillId: activeLocalSkill.id,
        target: {
          scope: binding.scope,
          toolId: binding.toolId,
          projectPath: binding.projectPath,
          relPath: binding.relPath,
          targetPath: binding.targetPath,
        },
        strategy,
      })
      if (!result.success) {
        setSkillConflictError(result.error || '解决 Skill 冲突失败')
        return
      }
      setSkillConflictBinding(null)
      projectDiscovery.refresh()
      await onReloadSkills()
      await refreshSkillAdoptionPlan()
      await onRefreshProjects?.()
      notify?.(result.backupPath
        ? `Skill 冲突已解决，原版本已备份到 ${result.backupPath}`
        : strategy === 'keep_external' ? '已保留外部 Skill，并解除应用关联' : 'Skill 冲突已解决')
    } catch (error) {
      setSkillConflictError(error instanceof Error ? error.message : '解决 Skill 冲突失败')
    } finally {
      setSkillConflictBusy(false)
    }
  }
  const fromRemote = (remote: Pick<RemoteSkill, 'id' | 'name' | 'description' | 'tags' | 'skillMarkdown'>): Skill => ({
    id: remote.id, name: remote.name, description: remote.description, tags: remote.tags,
    skillMarkdown: remote.skillMarkdown, apps: [], updatedLabel: '刚刚添加', pinned: false,
    sourceRuns: 0, versions: 1,
    workflow: { id: `wf-${remote.id}`, name: remote.name, summary: remote.description,
      repeatCount: 0, estimatedMinutes: 0, confidence: 0, nodes: [], edges: [] },
  })
  const targetLabel = addTarget?.scope === 'project' ? `项目 · ${addTarget.name}` : '全局技能库'
  return (
    <>
      <aside className="app-col-master view-enter skill-scope-master">
        <div className="master-header">
          <div className="master-header-top">
            <div className="master-tab-segmented" aria-label="Skill 范围">
              {(['global', 'project'] as const).map(scope => <button key={scope} type="button"
                className={`master-tab-btn ${skillTab === scope ? 'is-active' : ''}`}
                aria-pressed={skillTab === scope} onClick={() => setSkillTab(scope)}>{scope === 'global' ? '全局' : '项目'}</button>)}
            </div>
            <button
              type="button"
              className={`btn btn--capsule btn--secondary btn--sm ${isDiagnosticMode ? 'btn--active' : ''}`}
              aria-label="Skill 诊断与批量接管"
              title="打开 Skill 诊断与批量接管工作台"
              onClick={() => {
                setIsDiagnosticMode(prev => !prev)
              }}
            >
              <Stethoscope size={13} />
            </button>
            <button type="button" className="btn btn--capsule btn--secondary btn--sm" aria-label="添加 Skill"
              disabled={!target} onClick={() => { setAddTarget(target); setAddOpen(true) }}><Plus size={13} /></button>
          </div>
          {skillTab === 'project' && <>
            <div className="skill-project-select">
              <select className="dialog-capsule-input" aria-label="目标项目" value={projectId}
                onChange={event => setProjectId(event.target.value)}>
                <option value="" disabled>选择项目</option>
                {projectId && !selectedProject && <option value={projectId}>项目已移除</option>}
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.status === 'missing' ? '（目录不可用）' : ''}</option>)}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </div>
          {(projectError || selectedProject?.status === 'missing') && <p role="alert" className="master-list-status">{projectError || '项目目录不可用，请在项目管理中修复。'}</p>}
          </>}
        </div>
        {skillAdoptionPlan && (skillAdoptionPlan.totalTargets > 0 || skillAdoptionPlan.errors.length > 0 || externalSkills.length > 0) ? (
          <div
            className={`skill-diagnostic-entry-card ${isDiagnosticMode ? 'is-active' : ''}`}
            onClick={() => setIsDiagnosticMode(true)}
            role="button"
            tabIndex={0}
            aria-pressed={isDiagnosticMode}
          >
            <div className="skill-diagnostic-entry-card__row">
              <div className="skill-diagnostic-entry-card__title">
                <Stethoscope size={12} className="skill-diagnostic-entry-card__icon" />
                <span>诊断与批量接管</span>
              </div>
              <span className="skill-diagnostic-entry-card__badge">
                {skillAdoptionPlan.totalSkills || externalSkills.length || skillAdoptionPlan.errors.length}
              </span>
            </div>
            <div className="skill-diagnostic-entry-card__summary">
              {skillAdoptionPlan.adoptableTargets > 0 && (
                <span className="is-adoptable">{skillAdoptionPlan.adoptableTargets} 个可接管</span>
              )}
              {skillAdoptionPlan.conflictTargets > 0 && (
                <span className="is-conflict"> · {skillAdoptionPlan.conflictTargets} 个冲突</span>
              )}
              {skillAdoptionPlan.errors.length > 0 && (
                <span className="is-error"> · {skillAdoptionPlan.errors.length} 项异常</span>
              )}
            </div>
          </div>
        ) : null}
        <div className="master-list-scroll">
          {skillTab === 'project' && projectDiscovery.errors.length > 0 && <div className="master-list-status" role="alert">
            <span>{projectDiscovery.errors.join('；')}</span>
            <button type="button" className="btn btn--capsule btn--secondary btn--sm" onClick={() => { projectDiscovery.refresh(); void onRefreshProjects?.() }}>重新扫描</button>
          </div>}
          {displaySkills.map(skill => <button type="button" key={skill.id}
            className={`master-item-row ${!isDiagnosticMode && activeLocalSkill?.id === skill.id ? 'is-selected' : ''}`}
            aria-pressed={!isDiagnosticMode && activeLocalSkill?.id === skill.id} onClick={() => {
              setIsDiagnosticMode(false)
              onSelectSkillId(skill.id)
            }}>
            <Folder size={15} />
            <span className="skill-master-item-copy">
              <span className="master-item-title">{skill.name}</span>
              <span className={`skill-ownership-badge ${getSkillOwnershipClass(skill)}`}>{getSkillOwnershipLabel(skill)}</span>
            </span>
          </button>)}
          {externalSkills.length > 0 && !isDiagnosticMode && (
            <div className="master-list-external-summary">
              <span>{externalSkills.length} 个外部 Skill 待接管</span>
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setIsDiagnosticMode(true)}
              >
                前往诊断 →
              </button>
            </div>
          )}
        </div>
      </aside>
      <section className="app-col-detail view-enter">
        {isDiagnosticMode ? (
          <SkillDiagnosticWorkbench
            plan={skillAdoptionPlan}
            result={skillAdoptionResult}
            busy={skillAdoptionBusy}
            scope={skillTab}
            selectedProject={selectedProject}
            projects={projects}
            skills={skills}
            projectDiscoveryErrors={projectDiscovery.errors}
            onAdoptAll={handleAdoptAllSkills}
            onSelectSkill={(skillId) => {
              setIsDiagnosticMode(false)
              onSelectSkillId(skillId)
            }}
            onResolveConflict={(binding, skill) => {
              setIsDiagnosticMode(false)
              onSelectSkillId(skill.id)
              setSkillConflictBinding(binding)
            }}
            onRefresh={async () => {
              projectDiscovery.refresh()
              await onReloadSkills()
              await refreshSkillAdoptionPlan()
              await onRefreshProjects?.()
            }}
            onClose={() => {
              setIsDiagnosticMode(false)
              if (displaySkills.length > 0 && !activeLocalSkill) {
                onSelectSkillId(displaySkills[0].id)
              }
            }}
          />
        ) : activeLocalSkill ? (
            <div className="detail-stage-wrap">
              {/* Clean macOS Pro Document Header */}
              <header className="detail-hero-header" style={{ marginBottom: '14px' }}>
                <div className="detail-hero-header__row1" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', minHeight: '28px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <Folder size={20} style={{ color: 'var(--color-ink)', flexShrink: 0 }} />
                    <h1 className="detail-hero-name" style={{ margin: 0, fontSize: 'var(--text-title)', fontWeight: 600, lineHeight: 1.3 }}>
                      {activeLocalSkill.name}
                    </h1>
                  </div>

                  <div className="detail-hero-header__actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {activeLocalSkill.ownership === 'external' ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--capsule btn--sm"
                        disabled={adoptingSkill}
                        onClick={() => void handleAdoptSkill()}
                      >
                        {adoptingSkill ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
                        <span>{adoptingSkill ? '正在纳入…' : '纳入应用管理'}</span>
                      </button>
                    ) : activeLocalSkill.projectSource && !activeLocalSkill.projectSource.managedSkillId ? (
                      <span className="skill-project-local-label">项目本地 Skill</span>
                    ) : <>
                    {/* Explicit Distribution / Link Management Button as sole action */}
                    <button
                      type="button"
                      className="btn btn--capsule btn--secondary btn--sm"
                      onClick={() => {
                        if (window.workflowSkill?.openSkillLinkWindow) {
                          void window.workflowSkill.openSkillLinkWindow(activeLocalSkill.id)
                        } else {
                          setLinkModalSkill(activeLocalSkill)
                        }
                      }}
                      title={`已分发至 ${activeLinkedTools.length} 个 AI 环境`}
                    >
                      <Link2 size={12} />
                      <span>管理分发 {activeLinkedTools.length > 0 ? `(${activeLinkedTools.length})` : ''}</span>
                    </button>

                    {/* Indicative Avatar Stack (Purely visual display, non-clickable) */}
                    {activeLinkedTools.length > 0 ? (
                      <div
                        className="linked-tools-avatar-stack"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                        title={activeLinkedTools.map((t) => getAIToolDisplayName(t)).join('、')}
                      >
                        {activeLinkedTools.slice(0, 4).map((tool, idx) => (
                          <div
                            key={tool.id}
                            className="linked-tool-avatar"
                            style={{ zIndex: 10 + idx }}
                          >
                            <AIToolLogo toolId={tool.id} size={16} color />
                          </div>
                        ))}
                        {activeLinkedTools.length > 4 ? (
                          <div className="linked-tool-avatar-more" style={{ zIndex: 20 }}>
                            +{activeLinkedTools.length - 4}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Export Code if has workflow */}
                    {activeLocalSkill.workflow?.nodes.length ? (
                      <button
                        type="button"
                        className="btn btn--capsule btn--secondary btn--sm"
                        onClick={() => onExportCode(activeLocalSkill.workflow!, activeLocalSkill.name)}
                        title="导出代码"
                      >
                        <Code size={12} />
                        <span>导出</span>
                      </button>
                    ) : null}

                    {/* Delete Button */}
                    <button
                      type="button"
                      className="btn btn--capsule btn--danger btn--sm"
                      onClick={() => setDeleteModalSkill(activeLocalSkill)}
                    >
                      <Trash2 size={12} />
                      <span>删除</span>
                    </button>
                    </>}
                  </div>
                </div>

                {/* Row 3: Description with expandable toggle if long */}
                {activeLocalSkill.description ? (
                  <ExpandableSkillDesc text={activeLocalSkill.description} />
                ) : null}
              </header>

              {/* Pure Document View (Read-Only) */}
              <div className="skill-doc-wrap">
                <div className="skill-doc-meta-bar font-mono">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <FileText size={12} style={{ color: 'var(--color-ink)' }} />
                    <span title={activeLocalSkill.skillPath}>{activeLocalSkill.projectSource
                      ? `${activeLocalSkill.projectSource.relativePaths.join(' · ')} / SKILL.md` : 'SKILL.md'}</span>
                  </div>
                </div>

                <pre className="skill-doc-preview">
                  {skillMdContent || activeLocalSkill.skillMarkdown || '（无 SKILL.md 内容）'}
                </pre>
              </div>
            </div>
          ) : (
            <div className="clean-empty-state">
              <FolderTree size={30} className="empty-icon-glow" />
              <h3 className="empty-title">{skillTab === 'project' && projectDiscovery.loading ? '正在扫描项目 Skill…' : skillTab === 'project' && projectDiscovery.errors.length ? '项目 Skill 扫描未完成，请重试' : skillTab === 'project' && !target ? '请在项目管理中添加或修复项目' : '当前范围暂无 Skill，点击 + 添加'}</h3>
              {skillAdoptionPlan && skillAdoptionPlan.totalTargets > 0 ? (
                <button
                  type="button"
                  className="btn btn--primary btn--capsule btn--sm"
                  style={{ marginTop: '12px' }}
                  onClick={() => setIsDiagnosticMode(true)}
                >
                  <Stethoscope size={12} />
                  <span>打开 Skill 诊断与批量接管工作台</span>
                </button>
              ) : null}
            </div>
          )
}
        <SafeDeleteSkillModal
          skill={deleteModalSkill}
          aiTools={installedTools}
          open={Boolean(deleteModalSkill)}
          onClose={() => setDeleteModalSkill(null)}
          onConfirm={onDeleteSkill}
        />

        <SkillAdoptionDialog
          open={skillAdoptionOpen}
          plan={skillAdoptionPlan}
          result={skillAdoptionResult}
          busy={skillAdoptionBusy}
          onClose={() => { if (!skillAdoptionBusy) setSkillAdoptionOpen(false) }}
          onConfirm={() => void handleAdoptAllSkills()}
        />

        <ManageSkillLinksModal
          skill={linkModalSkill}
          skills={skills}
          aiTools={aiTools}
          open={Boolean(linkModalSkill)}
          onClose={() => setLinkModalSkill(null)}
          onToggleLinkTarget={onToggleLinkTarget}
          onRefreshAiTools={onReloadSkills}
          notify={notify}
        />
        <ConflictResolutionDialog
          open={Boolean(skillConflictBinding && activeLocalSkill)}
          assetKind="Skill"
          assetName={activeLocalSkill?.name || ''}
          targetLabel={skillConflictBinding ? getSkillTargetLabel(skillConflictBinding) : ''}
          sourcePath={activeLocalSkill?.sourcePath || activeLocalSkill?.skillPath}
          targetPath={skillConflictBinding?.targetPath}
          statusLabel={skillConflictBinding?.status === 'broken' ? '链接损坏' : '存在冲突'}
          canUseTarget={skillConflictBinding?.status !== 'broken'}
          busy={skillConflictBusy}
          error={skillConflictError}
          onClose={() => { if (!skillConflictBusy) setSkillConflictBinding(null) }}
          onResolve={handleResolveSkillConflict}
        />
        <AddSkillDialog open={addOpen} targetLabel={targetLabel}
          disabledReason={addTarget?.scope === 'project' && !projects.some(project => project.id === addTarget.id && project.path === addTarget.path && project.status === 'valid') ? '目标项目已移除或目录不可用，请重新选择。' : undefined} onClose={() => setAddOpen(false)}
          onAdd={remote => add(fromRemote(remote))} onCreate={() => { setAddOpen(false); setCreateError(''); setCreateOpen(true) }} />
        <NewSkillDialog open={createOpen} busy={createBusy} error={createError} targetLabel={targetLabel}
          onClose={() => { if (!createBusy) setCreateOpen(false) }} onCreate={async name => {
            if (createBusy) return
            setCreateBusy(true); setCreateError('')
            try {
              await add(fromRemote({ id: `skill-${crypto.randomUUID()}`, name, description: '', tags: [],
                skillMarkdown: `# ${name}\n\n` }))
              setCreateOpen(false)
            } catch (error) { setCreateError(error instanceof Error ? error.message : '创建失败') }
            finally { setCreateBusy(false) }
          }} />
      </section>
    </>
  )
}

/* =========================================================================
   AI tool display helpers shared by Skill distribution UI
   ========================================================================= */
const getAIToolDisplayName = (tool: AIToolTarget): string => {
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


/* =========================================================================
   3-Column macOS Pro View: Workflows Architecture (Column 2 + Column 3)
   ========================================================================= */
function captureEventApp(event: CaptureEvent) {
  return event.applicationName || event.applicationId?.split('.').pop() || 'System'
}

function captureEventLabel(event: CaptureEvent, isZh: boolean) {
  if (event.eventType === 'browser-navigation') return isZh ? '打开网页' : 'Opened page'
  if (event.eventType === 'browser-click') return isZh ? '点击网页元素' : 'Clicked page element'
  if (event.eventType === 'browser-change') return isZh ? '修改表单字段' : 'Changed form field'
  if (event.eventType === 'browser-submit') return isZh ? '提交网页表单' : 'Submitted web form'
  if (event.eventType === 'network-request') {
    return isZh
      ? `发起 ${event.network?.method || 'HTTP'} 请求`
      : `Sent ${event.network?.method || 'HTTP'} request`
  }
  if (event.eventType === 'network-response') {
    return isZh
      ? `收到 ${event.network?.status || 'HTTP'} 响应`
      : `Received ${event.network?.status || 'HTTP'} response`
  }
  if (event.eventType === 'application-activated') return isZh ? '切换前台应用' : 'Switched active app'
  if (event.eventType === 'scroll') return isZh ? '滚动界面' : 'Scrolled interface'
  if (event.eventType === 'key-down') {
    return event.modifiers ? (isZh ? '使用键盘或快捷键' : 'Used keyboard or shortcut') : (isZh ? '键盘输入' : 'Keyboard input')
  }
  if (event.eventType === 'mouse-right-down') return isZh ? '右键点击' : 'Right click'
  if (event.eventType === 'mouse-other-down') return isZh ? '辅助键点击' : 'Auxiliary click'
  if (event.eventType === 'mouse-left-down') {
    return Number(event.attributes.clickState) >= 2 ? (isZh ? '双击界面元素' : 'Double clicked element') : (isZh ? '点击界面元素' : 'Clicked interface element')
  }
  return event.eventType
}

function workflowSkillMarkdown(workflow: Workflow, isZh: boolean) {
  const oneLine = (value: string) => value.replace(/\r?\n/g, ' ').trim()
  const apps = Array.from(new Set(workflow.nodes.map((node) => node.app).filter(Boolean)))
  const description = oneLine(workflow.summary || workflow.name)
  const steps = workflow.nodes.map((node, index) => {
    const app = node.app ? ` — ${oneLine(node.app)}` : ''
    const detail = node.detail?.trim()
    const http = node.http
      ? `\n   - HTTP: \`${oneLine(node.http.method)} ${oneLine(node.http.url)}\``
        + `\n   - Headers: \`${oneLine(JSON.stringify(node.http.headers))}\``
        + (node.http.body ? `\n   - Body: \`${oneLine(node.http.body)}\`` : '')
        + (node.http.expectedStatus ? `\n   - Expected status: \`${node.http.expectedStatus}\`` : '')
      : ''
    return `${index + 1}. **${oneLine(node.label)}**${app}${detail ? `\n   - ${oneLine(detail)}` : ''}${http}`
  }).join('\n')

  if (isZh) {
    return `---
name: ${workflow.id}
description: ${JSON.stringify(description)}
tools: ${JSON.stringify(apps.length > 0 ? apps : ['System'])}
version: 1.0.0
---

# ${oneLine(workflow.name)}

${description}

## 执行步骤

${steps}

## 执行原则

- 严格按上述顺序执行；等待步骤完成后再进入下一步。
- 若目标应用、控件或必要上下文缺失，先向用户确认，不要猜测。
- 不记录或复述密码、令牌及其他敏感输入内容。
`
  }

  return `---
name: ${workflow.id}
description: ${JSON.stringify(description)}
tools: ${JSON.stringify(apps.length > 0 ? apps : ['System'])}
version: 1.0.0
---

# ${oneLine(workflow.name)}

${description}

## Workflow Steps

${steps}

## Execution Rules

- Follow the steps in order and wait for each wait step before continuing.
- If a target app, control, or required context is missing, ask the user instead of guessing.
- Never record or repeat passwords, tokens, or other sensitive input content.
`
}

function captureTargetLabel(event: CaptureEvent, isZh: boolean) {
  if (event.network) {
    try {
      const url = new URL(event.network.url)
      return `${event.network.method} ${url.host}${url.pathname}`
    } catch {
      return `${event.network.method} ${event.network.url}`
    }
  }
  if (event.eventType === 'browser-navigation' && event.page?.url) {
    try {
      const url = new URL(event.page.url)
      return `${url.host}${url.pathname}`
    } catch {
      return event.page.url
    }
  }
  const role = event.target?.subrole || event.target?.role
  if (!role) return isZh ? '未识别界面元素' : 'Unidentified interface element'
  return role.replace(/^AX/, '').replace(/^ControlType\./, '').replace(/([a-z])([A-Z])/g, '$1 $2')
}

function CaptureEventGlyph({ event, size = 14 }: { event: CaptureEvent; size?: number }) {
  if (event.source?.startsWith('browser')) return <Globe size={size} />
  if (event.eventType === 'application-activated') return <AppWindow size={size} />
  if (event.eventType === 'scroll') return <MoveVertical size={size} />
  if (event.eventType === 'key-down') return <Keyboard size={size} />
  if (event.eventType.startsWith('mouse-')) return <MousePointer2 size={size} />
  return <CircleDot size={size} />
}

function WorkflowsThreeColumn({
  items,
  savedMap,
  selectedWorkflowId,
  onSelectWorkflowId,
  onSaveSkill,
  observing,
  recorderStatus,
  browserCaptureStatus,
  recentEvents,
  captureSessionId,
  onToggleCapture,
  onUpdateWorkflow,
  onExportCode,
  notify,
}: {
  items: Workflow[]
  savedMap: Record<string, boolean>
  selectedWorkflowId: string
  onSelectWorkflowId: (id: string) => void
  onSaveSkill: (workflow: Workflow) => void
  observing: boolean
  recorderStatus?: RecorderStatus
  browserCaptureStatus?: BrowserCaptureStatus
  recentEvents: CaptureEvent[]
  captureSessionId: string
  onToggleCapture: () => void
  onUpdateWorkflow: (workflow: Workflow) => Promise<boolean>
  onExportCode: (workflow: Workflow, name: string) => void
  notify?: (msg: string) => void
}) {
  const { t, resolvedLocale } = useI18n()
  const [query, setQuery] = useState('')
  const [masterMode, setMasterMode] = useState<'workflows' | 'events'>('workflows')
  const [selectedEventId, setSelectedEventId] = useState('')
  const [draft, setDraft] = useState<Workflow | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [detailTab, setDetailTab] = useState<'graph' | 'steps' | 'skill'>('graph')
  const [saving, setSaving] = useState(false)
  const wasObservingRef = useRef(observing)
  const activeWorkflowIdRef = useRef('')
  const isZh = resolvedLocale === 'zh-CN'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => {
      const searchStr = `${i.name} ${i.summary || ''}`.toLowerCase()
      return searchStr.includes(q)
    })
  }, [items, query])

  const activeWf = useMemo(() => {
    return filtered.find((w) => w.id === selectedWorkflowId) || filtered[0] || null
  }, [filtered, selectedWorkflowId])

  const filteredEvents = useMemo(() => {
    const sessionEvents = captureSessionId
      ? recentEvents.filter((event) => event.sessionId === captureSessionId)
      : []
    const q = query.trim().toLowerCase()
    if (!q) return sessionEvents
    return sessionEvents.filter((event) => {
      const search = [
        captureEventApp(event),
        captureEventLabel(event, isZh),
        event.eventType,
        event.target?.role,
        event.target?.subrole,
        event.target?.identifier,
        event.page?.url,
        event.network?.method,
        event.network?.url,
        event.network?.status,
      ].filter(Boolean).join(' ').toLowerCase()
      return search.includes(q)
    })
  }, [recentEvents, captureSessionId, query, isZh])

  const activeEvent = useMemo(() => (
    filteredEvents.find((event) => event.id === selectedEventId) || filteredEvents[0] || null
  ), [filteredEvents, selectedEventId])

  const selectMasterMode = (mode: 'workflows' | 'events') => {
    setMasterMode(mode)
    setQuery('')
  }

  useEffect(() => {
    if (observing) {
      setMasterMode('events')
      setQuery('')
    } else if (wasObservingRef.current) {
      setMasterMode('workflows')
      setQuery('')
    }
    wasObservingRef.current = observing
  }, [observing])

  useEffect(() => {
    if (!activeWf) {
      setDraft(null)
      setSelectedNodeId('')
      activeWorkflowIdRef.current = ''
      return
    }
    if (activeWorkflowIdRef.current !== activeWf.id) {
      activeWorkflowIdRef.current = activeWf.id
      setDetailTab('graph')
    }
    setDraft({
      ...activeWf,
      nodes: activeWf.nodes.map((node) => ({ ...node })),
      edges: activeWf.edges.map((edge) => ({ ...edge })),
      capture: activeWf.capture ? { ...activeWf.capture, sessionIds: [...activeWf.capture.sessionIds] } : undefined,
    })
    setSelectedNodeId(activeWf.nodes[0]?.id || '')
  }, [activeWf])

  const isDirty = Boolean(draft && activeWf && JSON.stringify(draft) !== JSON.stringify(activeWf))
  useUpdateBlocker('workflow-editor', isDirty || saving)
  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId) || null
  const skillPreview = useMemo(
    () => draft ? workflowSkillMarkdown(draft, isZh) : '',
    [draft, isZh],
  )

  const updateDraftNode = (changes: Partial<WorkflowNode>) => {
    setDraft((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === selectedNodeId ? { ...node, ...changes } : node),
    } : current)
  }

  const rebuildLinearEdges = (nodes: WorkflowNode[]) => (
    nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }))
  )

  const moveSelectedNode = (offset: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current
      const index = current.nodes.findIndex((node) => node.id === selectedNodeId)
      const nextIndex = index + offset
      if (index < 0 || nextIndex < 0 || nextIndex >= current.nodes.length) return current
      const nodes = [...current.nodes]
      const [node] = nodes.splice(index, 1)
      nodes.splice(nextIndex, 0, node)
      return { ...current, nodes, edges: rebuildLinearEdges(nodes) }
    })
  }

  const deleteSelectedNode = () => {
    setDraft((current) => {
      if (!current || current.nodes.length <= 1) return current
      const index = current.nodes.findIndex((node) => node.id === selectedNodeId)
      const nodes = current.nodes.filter((node) => node.id !== selectedNodeId)
      setSelectedNodeId(nodes[Math.min(Math.max(index, 0), nodes.length - 1)]?.id || '')
      return { ...current, nodes, edges: rebuildLinearEdges(nodes) }
    })
  }

  const addStep = () => {
    setDetailTab('steps')
    setDraft((current) => {
      if (!current) return current
      const node: WorkflowNode = {
        id: `node-${Date.now()}`,
        label: isZh ? '新步骤' : 'New step',
        detail: '',
        kind: 'action',
        confidence: 100,
      }
      const nodes = [...current.nodes, node]
      setSelectedNodeId(node.id)
      return { ...current, nodes, edges: rebuildLinearEdges(nodes) }
    })
  }

  const saveDraft = async () => {
    if (!draft || !draft.name.trim()) return false
    setSaving(true)
    try {
      const next = { ...draft, name: draft.name.trim(), summary: draft.summary?.trim() }
      const saved = await onUpdateWorkflow(next)
      if (saved) notify?.(t.workflows.savedChanges)
      return saved
    } finally {
      setSaving(false)
    }
  }

  const saveAsSkill = async () => {
    if (!draft) return
    if (isDirty && !(await saveDraft())) return
    onSaveSkill(draft)
  }

  const copySkillPreview = async () => {
    if (!skillPreview) return
    try {
      await navigator.clipboard.writeText(skillPreview)
      notify?.(t.detail.copiedToast)
    } catch {
      notify?.(t.toast.nativeNotReady)
    }
  }

  return (
    <>
      {/* Column 2: Master List of Discovered Workflows */}
      <aside className="app-col-master view-enter">
        <div className="master-header">
          <div className="master-header-top">
            <div className="master-tab-segmented workflow-master-tabs" role="tablist" aria-label={t.workflows.title}>
              <button
                type="button"
                role="tab"
                aria-selected={masterMode === 'workflows'}
                className={`master-tab-btn ${masterMode === 'workflows' ? 'is-active' : ''}`}
                onClick={() => selectMasterMode('workflows')}
              >
                {t.workflows.tabPatterns}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={masterMode === 'events'}
                className={`master-tab-btn ${masterMode === 'events' ? 'is-active' : ''}`}
                onClick={() => selectMasterMode('events')}
              >
                {t.workflows.tabEvents}
              </button>
            </div>
            <span className={`capture-master-state ${observing ? 'is-live' : 'is-paused'}`} title={observing ? t.workflows.eventStreamLive : t.workflows.eventStreamPaused}>
              <span className="capture-master-state__dot" />
            </span>
          </div>
          <div className="master-search-row">
            <label className="master-search-input">
              <Search size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={masterMode === 'workflows'
                  ? t.workflows.searchPatternsPlaceholder
                  : t.workflows.searchEventsPlaceholder}
              />
              {query ? (
                <button type="button" className="clear-search-btn" onClick={() => setQuery('')}>
                  <X size={12} />
                </button>
              ) : null}
            </label>
          </div>
        </div>

        <div className="master-list-scroll">
          {masterMode === 'workflows' ? filtered.map((wf) => {
            const isSelected = activeWf?.id === wf.id
            const isSaved = Boolean(savedMap[wf.id])
            return (
              <div
                key={wf.id}
                className={`master-item-row ${isSelected ? 'is-selected' : ''}`}
                onClick={() => onSelectWorkflowId(wf.id)}
              >
                <div className="master-item-logo">
                  <WorkflowIcon size={16} style={{ color: 'var(--color-ink)' }} />
                </div>
                <div className="master-item-content">
                  <div className="master-item-title-row">
                    <span className="master-item-title">{wf.name}</span>
                    {isSaved ? <Bookmark size={11} style={{ color: 'var(--color-success)' }} /> : null}
                  </div>
                  <span className="master-item-sub">{wf.summary || '已捕获操作流'}</span>
                  <div className="master-item-meta-row">
                    <span className="master-item-badge font-mono">{t.workflows.stepCount(wf.nodes.length)}</span>
                    <span className="master-item-mounted-chip font-mono">
                      {isSaved ? t.workflows.savedAsSkill : t.workflows.singleCapture}
                    </span>
                  </div>
                </div>
              </div>
            )
          }) : filteredEvents.length > 0 ? filteredEvents.map((event) => {
            const isSelected = activeEvent?.id === event.id
            const occurredAt = new Date(event.occurredAt)
            return (
              <button
                type="button"
                key={event.id}
                className={`capture-event-row ${isSelected ? 'is-selected' : ''}`}
                onClick={() => setSelectedEventId(event.id)}
              >
                <span className="capture-event-glyph" aria-hidden="true">
                  <CaptureEventGlyph event={event} />
                </span>
                <span className="capture-event-row__body">
                  <span className="capture-event-row__top">
                    <strong>{captureEventLabel(event, isZh)}</strong>
                    <time dateTime={event.occurredAt}>
                      {Number.isNaN(occurredAt.getTime()) ? '' : occurredAt.toLocaleTimeString(resolvedLocale, {
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                      })}
                    </time>
                  </span>
                  <span className="capture-event-row__meta">
                    <span>{captureEventApp(event)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{captureTargetLabel(event, isZh)}</span>
                  </span>
                </span>
              </button>
            )
          }) : (
            <div className="master-list-status capture-events-empty">
              <Activity size={16} />
              <span>{query ? (isZh ? '没有匹配的行为' : 'No matching actions') : t.workflows.eventEmptyTitle}</span>
            </div>
          )}
        </div>
      </aside>

      {/* Column 3: Detail Canvas of Selected Workflow */}
      <section className="app-col-detail view-enter">
        {masterMode === 'events' ? (
          <div className="detail-stage-wrap capture-listener-stage">
            <header className="capture-listener-header">
              <div className="capture-listener-title-group">
                <span className={`capture-listener-orb ${observing ? 'is-live' : 'is-paused'}`} aria-hidden="true">
                  <Activity size={15} />
                </span>
                <div>
                  <div className="capture-listener-title-row">
                    <h1>{observing ? t.workflows.captureActiveTitle : t.workflows.captureIdleTitle}</h1>
                    <span className={`capture-state-label ${observing ? 'is-live' : 'is-paused'}`}>
                      <span className="capture-state-label__dot" />
                      {observing ? t.workflows.eventStreamLive : t.workflows.eventStreamPaused}
                    </span>
                  </div>
                  <p>{observing ? t.workflows.captureActiveDesc : t.workflows.captureIdleDesc}</p>
                </div>
              </div>
              {(observing || filteredEvents.length > 0) ? (
                <button
                  type="button"
                  className={`btn btn--capsule btn--sm ${observing ? 'capture-finish-btn' : 'btn--primary'}`}
                  onClick={onToggleCapture}
                >
                  {observing ? <Check size={12} /> : <Play size={12} />}
                  <span>{observing ? t.workflows.capturePause : t.workflows.captureStart}</span>
                </button>
              ) : null}
            </header>

            {(observing || filteredEvents.length > 0) ? (
              <div className="capture-listener-summary" aria-label={t.workflows.eventStreamTitle}>
                <span><Activity size={12} />{t.workflows.storedEvents(filteredEvents.length)}</span>
                <span className="capture-summary-divider" aria-hidden="true" />
                <span>
                  <Globe size={12} />
                  {t.workflows.currentApp(browserCaptureStatus?.pageUrl || recorderStatus?.activeApplication || 'Browser')}
                </span>
                {captureSessionId ? (
                  <>
                    <span className="capture-summary-divider" aria-hidden="true" />
                    <span className="font-mono">{captureSessionId.slice(0, 8)}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            {activeEvent ? (
              <section className="capture-event-inspector" aria-labelledby="capture-event-inspector-title">
                <div className="capture-event-inspector__header">
                  <span className="capture-event-glyph capture-event-glyph--large" aria-hidden="true">
                    <CaptureEventGlyph event={activeEvent} size={18} />
                  </span>
                  <div className="capture-event-inspector__title">
                    <span id="capture-event-inspector-title">{t.workflows.eventInspectorTitle}</span>
                    <h2>{captureEventLabel(activeEvent, isZh)}</h2>
                  </div>
                  <time dateTime={activeEvent.occurredAt} className="font-mono">
                    {new Date(activeEvent.occurredAt).toLocaleString(resolvedLocale, { hour12: false })}
                  </time>
                </div>

                <dl className="capture-event-facts">
                  <div>
                    <dt>{isZh ? '应用' : 'Application'}</dt>
                    <dd>{captureEventApp(activeEvent)}</dd>
                  </div>
                  <div>
                    <dt>{isZh ? '行为类型' : 'Action type'}</dt>
                    <dd className="font-mono">{activeEvent.eventType}</dd>
                  </div>
                  <div>
                    <dt>{isZh ? '目标元素' : 'Target element'}</dt>
                    <dd>{captureTargetLabel(activeEvent, isZh)}</dd>
                  </div>
                  <div>
                    <dt>{isZh ? '控件标识' : 'Element identifier'}</dt>
                    <dd className="font-mono">{activeEvent.target?.identifier || (isZh ? '未提供' : 'Not available')}</dd>
                  </div>
                  {activeEvent.pointer ? (
                    <div>
                      <dt>{isZh ? '指针位置' : 'Pointer position'}</dt>
                      <dd className="font-mono">x {Math.round(activeEvent.pointer.x)} · y {Math.round(activeEvent.pointer.y)}</dd>
                    </div>
                  ) : null}
                  {activeEvent.keyCode !== undefined ? (
                    <div>
                      <dt>{isZh ? '键盘语义' : 'Keyboard semantics'}</dt>
                      <dd className="font-mono">Key {activeEvent.keyCode} · Mod {activeEvent.modifiers || 0}</dd>
                    </div>
                  ) : null}
                  {activeEvent.target?.bounds ? (
                    <div>
                      <dt>{isZh ? '元素范围' : 'Element bounds'}</dt>
                      <dd className="font-mono">
                        {Math.round(activeEvent.target.bounds.width)} × {Math.round(activeEvent.target.bounds.height)}
                      </dd>
                    </div>
                  ) : null}
                  {activeEvent.network ? (
                    <>
                      <div>
                        <dt>{isZh ? '请求方法' : 'HTTP method'}</dt>
                        <dd className="font-mono">{activeEvent.network.method}</dd>
                      </div>
                      <div>
                        <dt>{isZh ? '响应状态' : 'Response status'}</dt>
                        <dd className="font-mono">{activeEvent.network.status ?? (isZh ? '等待响应' : 'Pending')}</dd>
                      </div>
                    </>
                  ) : null}
                  <div>
                    <dt>{isZh ? '会话' : 'Session'}</dt>
                    <dd className="font-mono">{activeEvent.sessionId.slice(0, 12)}</dd>
                  </div>
                </dl>

                {Object.keys(activeEvent.attributes).length > 0 ? (
                  <div className="capture-event-attributes">
                    <span>{isZh ? '附加语义' : 'Additional semantics'}</span>
                    <div>
                      {Object.entries(activeEvent.attributes).map(([key, value]) => (
                        <code key={key}>{key}: {value}</code>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="capture-privacy-note">
                  <ShieldCheck size={14} />
                  <span>{t.workflows.privacyNote}</span>
                </div>
              </section>
            ) : observing ? (
              <div className="capture-listener-empty">
                <span className="capture-listener-orb is-live" aria-hidden="true"><Activity size={18} /></span>
                <h2>{t.workflows.eventEmptyTitle}</h2>
                <p>{t.workflows.eventEmptyDesc}</p>
              </div>
            ) : (
              <div className="capture-onboarding">
                <div className="capture-onboarding__hero">
                  <span className="capture-onboarding__icon"><WorkflowIcon size={24} /></span>
                  <h2>{t.workflows.guideTitle}</h2>
                  <p>{t.workflows.captureIdleDesc}</p>
                </div>
                <p className="capture-guide-inline-hint">
                  {t.workflows.guideStart} · {t.workflows.guideOperate} · {t.workflows.guideFinish}
                </p>
                <button type="button" className="btn btn--capsule btn--primary" onClick={onToggleCapture}>
                  <Play size={13} />
                  <span>{t.workflows.captureStart}</span>
                </button>
                <div className="capture-privacy-note"><ShieldCheck size={14} /><span>{t.workflows.privacyNote}</span></div>
              </div>
            )}
          </div>
        ) : draft && activeWf ? (
          <div className="detail-stage-wrap workflow-editor-stage">
            {/* Unified Hero Header per DESIGN §8.7 */}
            <header className="detail-hero-header" style={{ marginBottom: '14px' }}>
              <div className="detail-hero-header__row1" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', minHeight: '28px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <div className="detail-hero-header__icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-ink)' }}>
                    <WorkflowIcon size={20} />
                  </div>
                  <h1 className="detail-hero-header__title" style={{ margin: 0, fontSize: 'var(--text-title)', fontWeight: 600, lineHeight: 1.3 }}>
                    {draft.name}
                  </h1>
                </div>

                <div className="detail-hero-header__actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`btn btn--capsule btn--sm ${isDirty ? 'btn--primary' : 'btn--secondary'}`}
                    onClick={() => void saveDraft()}
                    disabled={!isDirty || saving}
                    title={t.workflows.saveChanges}
                  >
                    <Save size={12} />
                    <span>{saving ? t.workflows.savingChanges : t.workflows.saveChanges}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn--capsule btn--secondary btn--sm"
                    onClick={() => void saveAsSkill()}
                    disabled={Boolean(savedMap[activeWf.id])}
                    title={t.workflows.saveAsSkill}
                  >
                    <Sparkles size={12} />
                    <span>{savedMap[activeWf.id] ? t.workflows.savedAsSkill : t.workflows.saveAsSkill}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn--capsule btn--secondary btn--sm"
                    onClick={() => onExportCode(draft, draft.name)}
                    title={t.detail.exportCodeBtn}
                  >
                    <Code size={12} />
                    <span>{t.detail.exportCodeBtn}</span>
                  </button>
                </div>
              </div>

              <div className="detail-hero-header__row2" style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px', color: 'var(--color-muted)', fontSize: 'var(--text-body)' }}>
                {draft.summary ? (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '600px' }}>
                    {draft.summary}
                  </span>
                ) : null}
                {draft.summary ? <span style={{ opacity: 0.4 }}>•</span> : null}
                <span className="font-mono">{t.workflows.stepCount(draft.nodes.length)}</span>
              </div>
            </header>

            <nav className="master-tab-segmented workflow-detail-tabs" role="tablist" aria-label={t.workflows.workspaceTabsLabel}>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'graph'}
                aria-controls="workflow-graph-panel"
                className={`master-tab-btn ${detailTab === 'graph' ? 'is-active' : ''}`}
                onClick={() => setDetailTab('graph')}
              >
                <WorkflowIcon size={11} />
                <span>{t.workflows.graphTab}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'steps'}
                aria-controls="workflow-steps-panel"
                className={`master-tab-btn ${detailTab === 'steps' ? 'is-active' : ''}`}
                onClick={() => setDetailTab('steps')}
              >
                <ListTree size={11} />
                <span>{t.workflows.stepsTab}</span>
                <span className="workflow-detail-tab-count font-mono">{draft.nodes.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'skill'}
                aria-controls="workflow-skill-panel"
                className={`master-tab-btn ${detailTab === 'skill' ? 'is-active' : ''}`}
                onClick={() => setDetailTab('skill')}
              >
                <FileText size={11} />
                <span>{t.workflows.skillTab}</span>
              </button>
            </nav>

            {detailTab === 'graph' ? (
              <section id="workflow-graph-panel" role="tabpanel" className="detail-section-card workflow-graph-card workflow-tab-panel">
                <WorkflowGraph
                  workflow={draft}
                  selectedNodeId={selectedNodeId}
                  onNodeSelect={(node) => setSelectedNodeId(node?.id || '')}
                />
                {selectedNode ? (
                  <div className="workflow-graph-selection">
                    <span className={`workflow-step-kind ${selectedNode.kind === 'wait' ? 'is-wait' : ''}`}>
                      {selectedNode.kind === 'wait' ? <Clock3 size={12} /> : <Zap size={12} />}
                    </span>
                    <div>
                      <strong>{selectedNode.label}</strong>
                      <small>{selectedNode.app || t.workflows.noAppLabel}</small>
                    </div>
                    <button type="button" className="btn btn--secondary btn--capsule btn--sm" onClick={() => setDetailTab('steps')}>
                      <Pencil size={11} /><span>{t.workflows.editSelectedStep}</span>
                    </button>
                  </div>
                ) : null}
              </section>
            ) : detailTab === 'steps' ? (
              <section id="workflow-steps-panel" role="tabpanel" className="workflow-steps-workbench workflow-tab-panel">
                <div className="workflow-step-list-pane">
                  <div className="workflow-step-list-pane__header">
                    <div>
                      <strong>{t.workflows.stepListTitle}</strong>
                      <span>{t.workflows.stepCount(draft.nodes.length)}</span>
                    </div>
                    <button type="button" className="btn btn--secondary btn--capsule btn--sm" onClick={addStep}>
                      <Plus size={11} /><span>{t.workflows.addStep}</span>
                    </button>
                  </div>
                  <div className="workflow-step-list" role="listbox" aria-label={t.workflows.stepListTitle}>
                    {draft.nodes.map((node, index) => (
                      <button
                        key={node.id}
                        type="button"
                        role="option"
                        aria-selected={node.id === selectedNodeId}
                        className={`workflow-step-row ${node.id === selectedNodeId ? 'is-selected' : ''}`}
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        <span className="workflow-step-row__index font-mono">{String(index + 1).padStart(2, '0')}</span>
                        <span className={`workflow-step-kind ${node.kind === 'wait' ? 'is-wait' : ''}`}>
                          {node.kind === 'wait' ? <Clock3 size={12} /> : <Zap size={12} />}
                        </span>
                        <span className="workflow-step-row__content">
                          <strong>{node.label}</strong>
                          <small>{node.app || t.workflows.noAppLabel}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <aside className="workflow-step-editor">
                  <div className="workflow-step-editor__header">
                    <span>{t.workflows.stepEditorTitle}</span>
                    <div className="workflow-step-editor__header-actions">
                      {isDirty ? (
                        <span className="workflow-unsaved-indicator" title={t.workflows.unsavedChanges} aria-label={t.workflows.unsavedChanges}>
                          <CircleDot size={9} />
                        </span>
                      ) : null}
                      {selectedNode ? <code>{String(draft.nodes.findIndex((node) => node.id === selectedNode.id) + 1).padStart(2, '0')}</code> : null}
                    </div>
                  </div>
                  {selectedNode ? (
                    <div className="workflow-step-editor__fields">
                      <label>
                        <span>{t.workflows.stepNameLabel}</span>
                        <input value={selectedNode.label} onChange={(event) => updateDraftNode({ label: event.target.value })} />
                      </label>
                      <div className="workflow-editor-field-row">
                        <label>
                          <span>{t.workflows.stepTypeLabel}</span>
                          <select value={selectedNode.kind} onChange={(event) => updateDraftNode({ kind: event.target.value as WorkflowNode['kind'] })}>
                            <option value="action">{t.workflows.actionType}</option>
                            <option value="wait">{t.workflows.waitType}</option>
                          </select>
                        </label>
                        <label>
                          <span>{t.workflows.stepAppLabel}</span>
                          <input value={selectedNode.app || ''} onChange={(event) => updateDraftNode({ app: event.target.value })} />
                        </label>
                      </div>
                      <label>
                        <span>{t.workflows.stepDetailLabel}</span>
                        <textarea value={selectedNode.detail || ''} onChange={(event) => updateDraftNode({ detail: event.target.value })} />
                      </label>
                      <div className="workflow-step-editor__actions">
                        <button type="button" className="btn btn--secondary btn--capsule btn--sm" onClick={() => moveSelectedNode(-1)} disabled={draft.nodes[0]?.id === selectedNode.id} title={t.workflows.moveEarlier}>
                          <ArrowUp size={11} /><span>{t.workflows.moveEarlier}</span>
                        </button>
                        <button type="button" className="btn btn--secondary btn--capsule btn--sm" onClick={() => moveSelectedNode(1)} disabled={draft.nodes.at(-1)?.id === selectedNode.id} title={t.workflows.moveLater}>
                          <ArrowDown size={11} /><span>{t.workflows.moveLater}</span>
                        </button>
                        <button type="button" className="btn btn--capsule-ghost btn--capsule btn--sm" onClick={deleteSelectedNode} disabled={draft.nodes.length <= 1} title={t.workflows.deleteStep}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ) : <p className="workflow-step-editor__hint">{t.workflows.selectStepHint}</p>}
                </aside>
              </section>
            ) : (
              <section id="workflow-skill-panel" role="tabpanel" className="workflow-skill-preview workflow-tab-panel">
                <header className="workflow-skill-preview__header">
                  <div>
                    <strong>{t.workflows.skillPreviewTitle}</strong>
                    <span>{t.workflows.skillPreviewDesc}</span>
                  </div>
                  <div>
                    <button type="button" className="btn btn--secondary btn--capsule btn--sm" onClick={() => void copySkillPreview()}>
                      <Copy size={11} /><span>{t.detail.copyClipboardBtn}</span>
                    </button>
                  </div>
                </header>
                <pre className="workflow-skill-preview__code"><code>{skillPreview}</code></pre>
              </section>
            )}
          </div>
        ) : (
          <div className="capture-onboarding capture-onboarding--empty">
            <div className="capture-onboarding__hero">
              <span className="capture-onboarding__icon"><WorkflowIcon size={24} /></span>
              <h2>{t.workflows.emptyTitle}</h2>
              <p>{t.workflows.emptyDesc}</p>
            </div>
            <p className="capture-guide-inline-hint">
              {t.workflows.guideStart} · {t.workflows.guideOperate} · {t.workflows.guideFinish}
            </p>
            <button type="button" className="btn btn--capsule btn--primary" onClick={onToggleCapture}>
              <Play size={13} /><span>{t.workflows.captureStart}</span>
            </button>
          </div>
        )}
      </section>
    </>
  )
}



/* =========================================================================
   Level 2: Dedicated Workflow Detail Page (Floating Glass Workbench)
   ========================================================================= */
function WorkflowDetailPage({
  detailState,
  isSaved,
  onBack,
  onSaveSkill,
  onExportCode,
  notify,
}: {
  detailState: ActiveDetailState
  isSaved: boolean
  onBack: () => void
  onSaveSkill: (wf: Workflow) => void
  onExportCode: (wf: Workflow, name: string) => void
  notify: (msg: string) => void
}) {
  const { t } = useI18n()
  const { workflow, source, skill } = detailState
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(
    workflow.nodes.find((n) => n.kind === 'wait') || workflow.nodes[0] || null,
  )

  const apps = useMemo(() => {
    const set = new Set<string>()
    workflow.nodes.forEach((n) => {
      if (n.app) set.add(n.app)
    })
    return Array.from(set)
  }, [workflow])

  return (
    <div className="detail-canvas-page view-enter">
      {/* Floating Glass Top Bar */}
      <header className="detail-floating-bar">
        <div className="detail-nav-left">
          <button type="button" className="capsule-back-btn" onClick={onBack} aria-label={t.detail.back}>
            <ArrowLeft size={14} className="back-arrow" />
            <span>{t.detail.back}</span>
          </button>

          <div className="workflow-title-block">
            <h1 className="detail-title">{workflow.name}</h1>
            <span className="capsule-meta-pill font-mono">
              {source === 'workflow'
                ? t.workflows.confidenceBadge(workflow.confidence)
                : `v${skill?.versions ?? 1}.0 RELEASE`}
            </span>
          </div>
        </div>

        {/* Structured Capsule Actions */}
        <div className="detail-actions-right">
          {source === 'workflow' ? (
            <>
              <button
                type="button"
                className={`btn btn--capsule ${isSaved ? 'btn--saved' : 'btn--primary'}`}
                onClick={() => onSaveSkill(workflow)}
              >
                <Check size={13} className={`btn-check-icon ${isSaved ? 'is-animating' : ''}`} />
                <span>{isSaved ? t.detail.savedSkillBtn : t.detail.saveSkillBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule btn--secondary"
                onClick={() => onExportCode(workflow, workflow.name)}
              >
                <Code size={13} />
                <span>{t.detail.exportCodeBtn}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--capsule btn--primary"
                onClick={() => onExportCode(workflow, workflow.name)}
              >
                <Download size={13} />
                <span>{t.detail.exportCodeBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule btn--secondary"
                onClick={() => notify(`正在编辑“${workflow.name}”步骤`)}
              >
                <Pencil size={13} />
                <span>编辑步骤</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule-ghost icon-only"
                onClick={() => notify(`已归档“${workflow.name}”`)}
                title="归档"
              >
                <Archive size={14} />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Floating Glass Flow Section */}
      <section className="detail-stage-surface">
        <div className="section-capsule-head">
          <span className="section-capsule-title">工作流拓扑步骤图 (点击节点查看执行审计与通路点亮)</span>
        </div>

        <div className="detail-flow-stage">
          <WorkflowGraph
            workflow={workflow}
            selectedNodeId={selectedNode?.id}
            onNodeSelect={(node) => setSelectedNode(node)}
          />
        </div>
      </section>

      {/* Bottom Inspection & Rationale Flat Stage */}
      <section className="flat-detail-stage stagger-item">
        {/* Left: Step Inspection */}
        <div className="flat-detail-pane">
          <div className="pane-header-row">
            <span className="pane-title">{t.detail.stepInspectorTitle}</span>
            {selectedNode?.app ? (
              <span className="app-capsule-chip font-mono">{selectedNode.app}</span>
            ) : null}
          </div>

          {selectedNode ? (
            <div className="pane-body">
              <div className="step-main-row">
                <strong className="step-name">{selectedNode.label}</strong>
                <span className="capsule-meta-pill font-mono">
                  {selectedNode.kind === 'wait' ? 'WAIT_IO' : 'ACTION_EXEC'}
                </span>
              </div>

              <p className="step-description">
                {selectedNode.kind === 'wait'
                  ? '等待目标应用程序完成文件写入与数据导出，平均静默耗时 42.0 秒。'
                  : selectedNode.app
                    ? `捕获到与 [${selectedNode.app}] 的连续语义交互，参数匹配率 100%。`
                    : '跨应用操作序列中稳定的状态转移与数据输入。'}
              </p>

              <div className="runs-history-table font-mono">
                <div className="runs-header">
                  <span>历史样本</span>
                  <span>执行耗时</span>
                  <span>状态</span>
                </div>
                <div className="runs-row">
                  <span>今天 09:41:22</span>
                  <span>38.4s</span>
                  <span className="status-pass">PASS</span>
                </div>
                <div className="runs-row">
                  <span>08-20 09:38:15</span>
                  <span>44.1s</span>
                  <span className="status-pass">PASS</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="inspector-empty">点击上方流程图中的步骤节点进行检查</div>
          )}
        </div>

        {/* Right: Pattern Induction & Contract */}
        <div className="flat-detail-pane">
          <div className="pane-header-row">
            <span className="pane-title">模式归纳与执行契约</span>
            <span className="status-badge-ok font-mono">VERIFIED</span>
          </div>

          <div className="pane-body">
            <p className="induction-text">
              在多次独立会话中检测到一致的文件产出。因相关准备工作的执行时序发生过重排，系统已抽象为<strong>并行分支 (Parallel Split/Join)</strong>。
            </p>

            <div className="contract-grid font-mono">
              <div className="contract-cell">
                <span className="cell-k">输入依赖</span>
                <strong className="cell-v">{apps[0] || 'Finder'}</strong>
              </div>
              <div className="contract-cell">
                <span className="cell-k">产出产物</span>
                <strong className="cell-v">summary.xlsx, details.pdf</strong>
              </div>
              <div className="contract-cell">
                <span className="cell-k">平均节约</span>
                <strong className="cell-v">~{workflow.estimatedMinutes} 分钟</strong>
              </div>
              <div className="contract-cell">
                <span className="cell-k">{t.settings.sandboxLabel}</span>
                <strong className="cell-v status-pass">{t.settings.sandboxVal}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

/* =========================================================================
   Theme Segmented Capsule Tabs (With Physical Sliding Spring Indicator)
   ========================================================================= */
function ThemeSegmentedTabs({
  value,
  onChange,
}: {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}) {
  const { t } = useI18n()
  const themeOptions = useMemo(
    () => [
      { mode: 'light' as const, label: t.settings.themeLight, icon: Sun },
      { mode: 'dark' as const, label: t.settings.themeDark, icon: Moon },
      { mode: 'system' as const, label: t.settings.themeSystem, icon: Monitor },
    ],
    [t],
  )

  const [indicator, setIndicator] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  })
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const trackRef = useRef<HTMLDivElement>(null)

  const updatePosition = () => {
    const activeIndex = themeOptions.findIndex((opt) => opt.mode === value)
    const activeBtn = tabRefs.current[activeIndex]
    if (activeBtn) {
      setIndicator({
        left: activeBtn.offsetLeft,
        width: activeBtn.offsetWidth,
        ready: true,
      })
    }
  }

  useEffect(() => {
    updatePosition()
    const timer = setTimeout(updatePosition, 30)
    return () => clearTimeout(timer)
  }, [value, t])

  useEffect(() => {
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      updatePosition()
    })
    ro.observe(track)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="theme-segmented-track" ref={trackRef} role="tablist" aria-label={t.settings.themeTitle}>
      {indicator.ready && indicator.width > 0 ? (
        <div
          className="theme-segmented-indicator"
          style={{
            transform: `translate3d(${indicator.left}px, 0, 0)`,
            width: `${indicator.width}px`,
          }}
        />
      ) : null}

      {themeOptions.map((opt, idx) => {
        const Icon = opt.icon
        const isActive = value === opt.mode
        return (
          <button
            key={opt.mode}
            ref={(el) => {
              tabRefs.current[idx] = el
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`theme-segmented-tab ${isActive ? 'is-active' : ''}`}
            onClick={() => onChange(opt.mode)}
          >
            <Icon size={14} className="theme-tab-icon" />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* =========================================================================
   Language Segmented Capsule Tabs (Native Autonyms - 100% Constant Width)
   ========================================================================= */
const LANGUAGE_OPTIONS: { locale: Locale; label: string; icon: typeof Globe }[] = [
  { locale: 'zh-CN', label: '简体中文', icon: Globe },
  { locale: 'en-US', label: 'English', icon: Globe },
  { locale: 'system', label: '跟随系统', icon: Languages },
]

function LanguageSegmentedTabs({
  value,
  onChange,
}: {
  value: Locale
  onChange: (loc: Locale) => void
}) {
  const { t } = useI18n()
  const [indicator, setIndicator] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  })
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const trackRef = useRef<HTMLDivElement>(null)

  const getLabel = (opt: typeof LANGUAGE_OPTIONS[0]) => {
    if (opt.locale === 'system') return t.settings.langSystem
    return opt.label
  }

  const updatePosition = () => {
    const activeIndex = LANGUAGE_OPTIONS.findIndex((opt) => opt.locale === value)
    const activeBtn = tabRefs.current[activeIndex]
    if (activeBtn) {
      setIndicator({
        left: activeBtn.offsetLeft,
        width: activeBtn.offsetWidth,
        ready: true,
      })
    }
  }

  useEffect(() => {
    updatePosition()
    const timer = setTimeout(updatePosition, 30)
    return () => clearTimeout(timer)
  }, [value, t])

  useEffect(() => {
    const track = trackRef.current
    if (!track || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      updatePosition()
    })
    ro.observe(track)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="theme-segmented-track" ref={trackRef} role="tablist" aria-label={t.settings.langTitle}>
      {indicator.ready && indicator.width > 0 ? (
        <div
          className="theme-segmented-indicator"
          style={{
            transform: `translate3d(${indicator.left}px, 0, 0)`,
            width: `${indicator.width}px`,
          }}
        />
      ) : null}

      {LANGUAGE_OPTIONS.map((opt, idx) => {
        const Icon = opt.icon
        const isActive = value === opt.locale
        return (
          <button
            key={opt.locale}
            ref={(el) => {
              tabRefs.current[idx] = el
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`theme-segmented-tab ${isActive ? 'is-active' : ''}`}
            onClick={() => onChange(opt.locale)}
          >
            <Icon size={14} className="theme-tab-icon" />
            <span>{getLabel(opt)}</span>
          </button>
        )
      })}
    </div>
  )
}

/* =========================================================================
   Keyboard Shortcuts Management Component (macOS Native Keybinding Matrix)
   ========================================================================= */
interface ShortcutConfig {
  id: string
  groupId: 'global' | 'engine' | 'nav'
  titleKey: keyof TranslationKeys['settings']
  descKey: keyof TranslationKeys['settings']
  defaultKey: string
}

const SHORTCUT_DEFINITIONS: ShortcutConfig[] = [
  {
    id: 'command_palette',
    groupId: 'global',
    titleKey: 'shortcutCmdKTitle',
    descKey: 'shortcutCmdKDesc',
    defaultKey: '⌘K',
  },
  {
    id: 'toggle_master_column',
    groupId: 'global',
    titleKey: 'shortcutToggleMasterTitle',
    descKey: 'shortcutToggleMasterDesc',
    defaultKey: '⌘B',
  },
  {
    id: 'escape_back',
    groupId: 'global',
    titleKey: 'shortcutEscTitle',
    descKey: 'shortcutEscDesc',
    defaultKey: 'ESC',
  },
]

function KeyboardShortcutsSection() {
  const { t } = useI18n()

  const groups = [
    { id: 'global' as const, label: t.settings.shortcutsGroupGlobal },
  ]

  return (
    <>
      <header className="page-header stagger-item">
        <div className="page-header__left">
          <h1 className="page-title">{t.settings.shortcutsTab}</h1>
          <span className="page-subtitle">{t.settings.shortcutsSub}</span>
        </div>
      </header>

      {groups.map((group) => {
        const items = SHORTCUT_DEFINITIONS.filter((d) => d.groupId === group.id)
        if (items.length === 0) return null

        return (
          <div key={group.id} className="settings-section-block stagger-item">
            <span className="settings-section-label">{group.label}</span>
            <div className="flat-settings-card">
              {items.map((item) => {
                const title = t.settings[item.titleKey] as string
                const desc = t.settings[item.descKey] as string

                return (
                  <div key={item.id} className="flat-shortcut-row">
                    <div className="flat-shortcut-info">
                      <strong className="flat-shortcut-title">{title}</strong>
                      <p className="flat-shortcut-desc">{desc}</p>
                    </div>

                    <div className="flat-shortcut-controls">
                      <div className="shortcut-pill-wrap">
                        <kbd className="shortcut-key-badge font-mono">{item.defaultKey}</kbd>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </>
  )
}

/* =========================================================================
   Settings Main Content Page (macOS Native Grouped Flat Settings View)
   ========================================================================= */
function SettingsMainPage({
  tab,
  themeMode,
  resolvedTheme,
  onChangeThemeMode,
  observing,
  onToggleObserving,
  recorderStatus,
  onRequestPermissions,
  onShowToast,
  onNavigateToAccounts,
}: {
  tab: SettingsTab
  themeMode: ThemeMode
  resolvedTheme: 'dark' | 'light'
  onChangeThemeMode: (mode: ThemeMode) => void
  observing: boolean
  onToggleObserving: () => void
  recorderStatus?: RecorderStatus
  onRequestPermissions: (type?: 'accessibility' | 'screenRecording' | 'all', e?: React.MouseEvent) => void
  onShowToast?: (msg: string) => void
  onNavigateToAccounts?: () => void
}) {
  const { t, locale, setLocale, resolvedLocale } = useI18n()
  const [storagePath, setStoragePath] = useState<string>('')
  const [projectWorkspace, setProjectWorkspace] = useState<string>('')
  const [migrating, setMigrating] = useState<boolean>(false)

  useEffect(() => {
    let active = true
    if (window.workflowSkill?.getStoragePath) {
      window.workflowSkill.getStoragePath().then((p) => {
        if (active) setStoragePath(p)
      }).catch(() => {})
    }
    if (window.workflowSkill?.getProjectWorkspace) {
      window.workflowSkill.getProjectWorkspace().then((ws) => {
        if (active) setProjectWorkspace(ws)
      }).catch(() => {})
    }
    return () => { active = false }
  }, [])

  const handleSelectStoragePath = async () => {
    if (window.workflowSkill?.selectStoragePath) {
      const selected = await window.workflowSkill.selectStoragePath()
      if (selected) {
        setStoragePath(selected)
        onShowToast?.(t.settings.dataStoragePathChangedToast)
      }
    }
  }

  const handleSelectProjectWorkspace = async () => {
    if (window.workflowSkill?.selectProjectWorkspace) {
      const selected = await window.workflowSkill.selectProjectWorkspace()
      if (selected) {
        setProjectWorkspace(selected)
        window.dispatchEvent(new CustomEvent('workflow-skill:workspace-changed'))
        onShowToast?.(`已切换当前项目工作区为 ${selected}`)
      }
    }
  }

  const handleMigrateAllSkills = async () => {
    if (migrating) return
    if (!window.workflowSkill?.migrateAllSkillsToProject) {
      onShowToast?.('当前环境不支持迁移 API')
      return
    }

    setMigrating(true)
    try {
      const res = await window.workflowSkill.migrateAllSkillsToProject(projectWorkspace)
      if (res.success) {
        onShowToast?.(`已成功将 ${res.count} 个 Skill 迁移至项目，并在原位置创建软链接！`)
      } else {
        onShowToast?.(`迁移失败: ${res.error || '未知错误'}`)
      }
    } catch (err: any) {
      onShowToast?.(`迁移异常: ${err.message || String(err)}`)
    } finally {
      setMigrating(false)
    }
  }

  const handleRevealStoragePath = () => {
    if (storagePath && window.workflowSkill?.openPathInFinder) {
      void window.workflowSkill.openPathInFinder(storagePath)
    }
  }

  const handleResetStoragePath = async () => {
    if (window.workflowSkill?.resetStoragePath) {
      const def = await window.workflowSkill.resetStoragePath()
      setStoragePath(def)
      onShowToast?.(t.settings.dataStoragePathChangedToast)
    }
  }

  return (
    <div className="clean-page view-enter">
      {tab === 'general' ? (
        <>
          <header className="page-header stagger-item">
            <div className="page-header__left">
              <h1 className="page-title">{t.settings.generalTab}</h1>
              <span className="page-subtitle">{t.settings.generalSub}</span>
            </div>
          </header>

          {/* Card 1: 外观与语言 */}
          <div className="settings-section-block stagger-item">
            <span className="settings-section-label">外观与语言</span>
            <div className="flat-settings-card">
              {/* Row 1: Appearance Theme */}
              <div className="flat-setting-row">
                <div className="flat-setting-info">
                  <strong className="flat-setting-title">{t.settings.themeTitle}</strong>
                  <p className="flat-setting-desc">{t.settings.themeDesc}</p>
                </div>
                <div className="flat-setting-control">
                  <ThemeSegmentedTabs value={themeMode} onChange={onChangeThemeMode} />
                </div>
              </div>

              {/* Row 2: Interface Language */}
              <div className="flat-setting-row">
                <div className="flat-setting-info">
                  <strong className="flat-setting-title">{t.settings.langTitle}</strong>
                  <p className="flat-setting-desc">{t.settings.langDesc}</p>
                </div>
                <div className="flat-setting-control">
                  <LanguageSegmentedTabs value={locale} onChange={setLocale} />
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: 存储与工作区 */}
          <div className="settings-section-block stagger-item" style={{ marginTop: '16px' }}>
            <span className="settings-section-label">存储与工作区</span>
            <div className="flat-settings-card">
              {/* Local Data Storage Path */}
              <div className="flat-setting-row">
                <div className="flat-setting-info">
                  <strong className="flat-setting-title">{t.settings.dataStoragePathTitle}</strong>
                  <p className="flat-setting-desc font-mono" title={storagePath}>
                    {storagePath
                      ? storagePath
                          .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
                          .replace(/^\/Users\/[^/]+/, '~')
                          .replace(/^\\Users\\[^\\]+/, '~')
                      : t.settings.dataStoragePathPlaceholder}
                  </p>
                </div>
                <div className="flat-setting-control">
                  <div className="setting-actions-group">
                    <button
                      type="button"
                      className="btn btn--capsule btn--secondary btn--sm"
                      onClick={handleSelectStoragePath}
                    >
                      <FolderOpen size={12} />
                      <span>{t.settings.dataStoragePathSelectBtn}</span>
                    </button>
                    {(() => {
                      const isMac = typeof navigator !== 'undefined' && /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent)
                      const revealTitle = isMac ? t.settings.dataStoragePathRevealBtnMac : t.settings.dataStoragePathRevealBtnWin
                      const isDefault =
                        storagePath.endsWith('.trace') ||
                        storagePath.endsWith('.trace\\') ||
                        storagePath.endsWith('.trace/') ||
                        storagePath.endsWith('/.trace') ||
                        storagePath.endsWith('\\.trace')

                      return (
                        <>
                          <button
                            type="button"
                            className="btn btn--capsule btn--capsule-ghost btn--sm icon-only"
                            onClick={handleRevealStoragePath}
                            title={revealTitle}
                            aria-label={revealTitle}
                          >
                            <ExternalLink size={12} />
                          </button>
                          {storagePath && !isDefault ? (
                            <button
                              type="button"
                              className="btn btn--capsule btn--capsule-ghost btn--sm icon-only"
                              onClick={handleResetStoragePath}
                              title={t.settings.dataStoragePathResetBtn}
                              aria-label={t.settings.dataStoragePathResetBtn}
                            >
                              <RotateCcw size={12} />
                            </button>
                          ) : null}
                        </>
                      )
                    })()}
                  </div>
                </div>
              </div>

              {/* Project Workspace */}
              <div className="flat-setting-row">
                <div className="flat-setting-info">
                  <strong className="flat-setting-title">当前项目工作区</strong>
                  <p className="flat-setting-desc font-mono" title={projectWorkspace || '未设置项目工作区'}>
                    {projectWorkspace
                      ? projectWorkspace
                          .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
                          .replace(/^\/Users\/[^/]+/, '~')
                          .replace(/^\\Users\\[^\\]+/, '~')
                      : '使用默认启动目录'}
                  </p>
                </div>
                <div className="flat-setting-control">
                  <div className="setting-actions-group">
                    <button
                      type="button"
                      className="btn btn--capsule btn--secondary btn--sm"
                      onClick={handleSelectProjectWorkspace}
                    >
                      <FolderOpen size={12} />
                      <span>选择工作区</span>
                    </button>
                    {projectWorkspace ? (
                      <button
                        type="button"
                        className="btn btn--capsule btn--capsule-ghost btn--sm icon-only"
                        onClick={() => {
                          if (window.workflowSkill?.openPathInFinder) {
                            void window.workflowSkill.openPathInFinder(projectWorkspace)
                          }
                        }}
                        title="在访达中打开项目工作区"
                        aria-label="在访达中打开项目工作区"
                      >
                        <ExternalLink size={12} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* One-Click Migration to Current Project */}
              <div className="flat-setting-row">
                <div className="flat-setting-info">
                  <strong className="flat-setting-title">一键迁移 Skill 到当前项目</strong>
                  <p className="flat-setting-desc">
                    将所有 Skill 物理文件迁移至当前项目工作区的 <code className="font-mono">.agents/skills</code> 中，并在原位置创建软链接以保持全局环境兼容。
                  </p>
                </div>
                <div className="flat-setting-control">
                  <button
                    type="button"
                    className="btn btn--capsule btn--secondary btn--sm"
                    onClick={handleMigrateAllSkills}
                    disabled={migrating}
                    style={{ minWidth: '136px' }}
                  >
                    {migrating ? (
                      <RefreshCw size={12} className="spin-slow" />
                    ) : (
                      <FolderTree size={12} />
                    )}
                    <span>{migrating ? '正在迁移...' : '一键迁移到项目'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Card 3: AI 账号管理 */}
          <div className="settings-section-block stagger-item" style={{ marginTop: '16px' }}>
            <span className="settings-section-label">AI 账号管理</span>
            <div className="flat-settings-card">
              <div className="flat-setting-row">
                <div className="flat-setting-info">
                  <strong className="flat-setting-title">AI 账号管理</strong>
                  <p className="flat-setting-desc">
                    配置 Claude Code、Codex、Antigravity 等官方账号，管理使用额度与凭据。
                  </p>
                </div>
                <div className="flat-setting-control">
                  <button
                    type="button"
                    className="btn btn--capsule btn--secondary btn--sm"
                    onClick={onNavigateToAccounts}
                  >
                    <Users size={12} />
                    <span>前往账号管理</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {tab === 'shortcuts' ? (
        <KeyboardShortcutsSection />
      ) : null}

      {tab === 'permissions' ? (
        <>
          <header className="page-header stagger-item">
            <div className="page-header__left">
              <h1 className="page-title">{t.settings.permissionsTab}</h1>
              <span className="page-subtitle">{t.settings.permissionsSub}</span>
            </div>
          </header>

          {/* Top Security Status Banner */}
          {(() => {
            const screenRecordingOk = Boolean(recorderStatus?.permissions.screenRecording)
            const accessibilityOk = Boolean(recorderStatus?.permissions.accessibility)
            const allAuthorized = screenRecordingOk && accessibilityOk

            return (
              <>
                <div className="flat-security-banner stagger-item">
                  <div className="security-banner__left">
                    <div className="security-banner-info">
                      <strong className="security-headline">
                        {allAuthorized ? t.settings.permissionsReadyHeadline : t.settings.permissionsMissingHeadline}
                      </strong>
                      <p className="security-desc">
                        {allAuthorized ? t.settings.permissionsReadyDesc : t.settings.permissionsMissingDesc}
                      </p>
                    </div>
                  </div>
                  <div className="security-banner__right">
                    <button
                      type="button"
                      className={`btn btn--capsule ${allAuthorized ? 'btn--secondary' : 'btn--primary'}`}
                      onClick={(e) => onRequestPermissions?.(allAuthorized ? 'all' : screenRecordingOk ? 'accessibility' : 'screenRecording', e)}
                    >
                      <ShieldCheck size={13} />
                      <span>{allAuthorized ? t.settings.refreshPermissionsBtn : t.settings.requestPermissionsBtn}</span>
                    </button>
                  </div>
                </div>

                {/* Section 1: macOS System Permissions */}
                <div className="settings-section-block stagger-item">
                  <span className="settings-section-label">{t.settings.sectionSystemPerms}</span>
                  <div className="flat-settings-card">
                    {/* Row 1: Screen Recording */}
                    <div className="flat-setting-row">
                      <div className="flat-setting-info">
                        <strong className="flat-setting-title">{t.settings.screenRecordingTitle}</strong>
                        <p className="flat-setting-desc">{t.settings.screenRecordingDesc}</p>
                      </div>
                      <div className="flat-setting-control">
                        {screenRecordingOk ? (
                          <span className="perm-badge perm-badge--ok font-mono">
                            <Check size={12} />
                            <span>{t.settings.authorized}</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--capsule btn--secondary btn--sm"
                            onClick={(e) => onRequestPermissions?.('screenRecording', e)}
                          >
                            <span>{t.settings.waitingAuth}</span>
                            <ArrowRight size={11} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Row 2: Accessibility Semantics */}
                    <div className="flat-setting-row">
                      <div className="flat-setting-info">
                        <strong className="flat-setting-title">{t.settings.accessibilityTitle}</strong>
                        <p className="flat-setting-desc">{t.settings.accessibilityDesc}</p>
                      </div>
                      <div className="flat-setting-control">
                        {accessibilityOk ? (
                          <span className="perm-badge perm-badge--ok font-mono">
                            <Check size={12} />
                            <span>{t.settings.authorized}</span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--capsule btn--secondary btn--sm"
                            onClick={(e) => onRequestPermissions?.('accessibility', e)}
                          >
                            <span>{t.settings.waitingAuth}</span>
                            <ArrowRight size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )
          })()}
        </>
      ) : null}

      {tab === 'about' ? (
        <>
          <header className="page-header stagger-item">
            <div className="page-header__left">
              <h1 className="page-title">{t.settings.aboutTab}</h1>
              <span className="page-subtitle">{t.settings.aboutSub}</span>
            </div>
          </header>

          <div className="flat-settings-card stagger-item">
            <div className="about-hero-block">
              <div className="flat-title-with-badge">
                <strong className="about-name">{t.settings.aboutTitle}</strong>
              </div>

              <p className="about-manifesto">{t.settings.aboutManifesto}</p>
            </div>
          </div>
          <AppUpdate />
        </>
      ) : null}
    </div>
  )
}

/* =========================================================================
   Command Palette (Cmd+K) (Floating Glass Modal with Full Keyboard Nav)
   ========================================================================= */
function AppCommandPalette({
  open,
  onClose,
  onSelectView,
  onOpenSettings,
  onToggleObserving,
  observing,
  onChangeThemeMode,
  onOpenNewSkill,
}: {
  open: boolean
  onClose: () => void
  onSelectView: (view: View) => void
  onOpenSettings: () => void
  onToggleObserving: () => void
  observing: boolean
  onChangeThemeMode: (mode: ThemeMode) => void
  onOpenNewSkill: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const actions = useMemo(
    () => [
      {
        id: 'view-skills',
        label: t.command.jumpSkills,
        hint: t.command.jumpSkillsHint,
        run: () => onSelectView('skills'),
      },
      {
        id: 'view-workflows',
        label: t.command.jumpWorkflows,
        hint: t.command.jumpWorkflowsHint,
        run: () => onSelectView('workflows'),
      },
      {
        id: 'view-mcp',
        label: '切换至 MCP Server',
        hint: 'G M',
        run: () => onSelectView('mcp'),
      },
      {
        id: 'view-accounts',
        label: t.command.jumpAccounts,
        hint: t.command.jumpAccountsHint,
        run: () => onSelectView('accounts'),
      },
      {
        id: 'new-skill',
        label: t.command.newSkill,
        hint: t.command.newSkillHint,
        run: () => onOpenNewSkill(),
      },
      {
        id: 'open-settings',
        label: t.command.openSettings,
        hint: t.command.openSettingsHint,
        run: () => onOpenSettings(),
      },
      {
        id: 'toggle-observe',
        label: observing ? t.command.pauseObserve : t.command.resumeObserve,
        hint: observing ? t.command.pauseObserveHint : t.command.resumeObserveHint,
        run: () => onToggleObserving(),
      },
      {
        id: 'theme-light',
        label: t.command.themeLight,
        hint: t.command.themeLightHint,
        run: () => onChangeThemeMode('light'),
      },
      {
        id: 'theme-dark',
        label: t.command.themeDark,
        hint: t.command.themeDarkHint,
        run: () => onChangeThemeMode('dark'),
      },
      {
        id: 'theme-system',
        label: t.command.themeSystem,
        hint: t.command.themeSystemHint,
        run: () => onChangeThemeMode('system'),
      },
    ],
    [observing, onSelectView, onOpenNewSkill, onOpenSettings, onToggleObserving, onChangeThemeMode, t],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.hint.toLowerCase().includes(q),
    )
  }, [actions, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [filtered.length])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      window.setTimeout(() => inputRef.current?.focus(), 40)
    }
  }, [open])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].run()
        onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="command-panel modal-pop"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="command-search-capsule">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.command.searchPlaceholder}
          />
          <kbd className="font-mono" onClick={onClose} style={{ cursor: 'pointer' }}>ESC</kbd>
        </div>

        <div className="command-results-list" ref={listRef}>
          {filtered.map((action, idx) => (
            <button
              key={action.id}
              type="button"
              className={`command-capsule-item ${idx === selectedIndex ? 'is-selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => {
                action.run()
                onClose()
              }}
            >
              <span className="label-text">{action.label}</span>
              <span className="hint-text">{action.hint}</span>
            </button>
          ))}

          {filtered.length === 0 ? (
            <div className="command-empty-text">{t.command.empty}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   Export Modal (Liquid Glass)
   ========================================================================= */
function ExportSkillDialog({
  skillName,
  workflow,
  open,
  onClose,
  notify,
}: {
  skillName: string
  workflow: Workflow | null
  open: boolean
  onClose: () => void
  notify: (msg: string) => void
}) {
  const { t } = useI18n()
  const [format, setFormat] = useState<'python' | 'json' | 'applescript'>('python')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) setCopied(false)
  }, [open, format])

  if (!open || !workflow) return null

  const generateCode = () => {
    if (format === 'json') {
      return JSON.stringify(
        {
          schema: 'https://trace.local/v1/skill.json',
          name: skillName,
          summary: workflow.summary,
          confidence: workflow.confidence,
          nodes: workflow.nodes,
          edges: workflow.edges,
        },
        null,
        2,
      )
    }
    if (format === 'python') {
      return `"""
Trace Skill Blueprint: ${skillName}
Confidence: ${workflow.confidence}%
Summary: ${workflow.summary}
"""

from trace_engine import Workflow, Step

wf = Workflow(name="${skillName}")

# Steps
${workflow.nodes
  .map(
    (n, idx) =>
      `step_${n.id} = Step(index=${idx + 1}, id="${n.id}", label="${n.label}", app="${n.app || 'SYSTEM'}", kind="${n.kind}")`,
  )
  .join('\n')}

# Connections
${workflow.edges.map((e) => `wf.pipe(step_${e.from}, step_${e.to})`).join('\n')}

if __name__ == "__main__":
    wf.dry_run()
`
    }
    return `-- Trace AppleScript Automation: ${skillName}
tell application "${workflow.nodes[0]?.app || 'Finder'}"
    activate
    -- Process target files
end tell
`
  }

  const code = generateCode()

  const handleCopy = () => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    notify(t.detail.copiedToast)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="dialog-surface modal-pop"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div>
            <h2>{t.detail.exportDialogTitle}</h2>
            <p>{t.detail.exportDialogDesc}</p>
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose} aria-label={t.skills.cancelBtn}>
            <X size={15} />
          </button>
        </div>

        <div className="export-format-nav font-mono">
          <button
            type="button"
            className={`format-capsule-pill ${format === 'python' ? 'is-active' : ''}`}
            onClick={() => setFormat('python')}
          >
            Python SDK
          </button>
          <button
            type="button"
            className={`format-capsule-pill ${format === 'json' ? 'is-active' : ''}`}
            onClick={() => setFormat('json')}
          >
            JSON Schema
          </button>
          <button
            type="button"
            className={`format-capsule-pill ${format === 'applescript' ? 'is-active' : ''}`}
            onClick={() => setFormat('applescript')}
          >
            AppleScript
          </button>
        </div>

        <div className="code-frame dialog-body">
          <pre>
            <code>{code}</code>
          </pre>
        </div>

        <div className="dialog-footer-row">
          <button
            type="button"
            className={`btn btn--capsule ${copied ? 'btn--saved' : 'btn--primary'}`}
            onClick={handleCopy}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? t.detail.copiedClipboardBtn : t.detail.copyClipboardBtn}</span>
          </button>
          <button type="button" className="btn btn--capsule btn--secondary" onClick={onClose}>
            {t.skills.cancelBtn}
          </button>
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   New Skill Modal (Liquid Glass)
   ========================================================================= */
function NewSkillDialog({
  open,
  onClose,
  onCreate,
  busy = false,
  error = '',
  targetLabel,
}: {
  open: boolean
  busy?: boolean
  error?: string
  targetLabel?: string
  onClose: () => void
  onCreate: (name: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    setName('')
    dialogRef.current?.showModal()
    inputRef.current?.focus()
    return () => { dialogRef.current?.close(); previous?.focus() }
  }, [open])

  if (!open) return null

  return (
    <dialog ref={dialogRef} className="skill-create-dialog" aria-label={t.skills.createDialogTitle}
      onCancel={event => { event.preventDefault(); if (!busy) closeRef.current() }}>
      <form
        className="dialog-surface dialog-surface--small modal-pop"
        onSubmit={(e) => {
          e.preventDefault()
          const finalName = name.trim() || t.skills.newSkill
          if (!busy) onCreate(finalName)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div>
            <h2>{t.skills.createDialogTitle}</h2>
            <p>{targetLabel || t.skills.createDialogDesc}</p>
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose} disabled={busy} aria-label={t.skills.cancelBtn}>
            <X size={15} />
          </button>
        </div>

        <div className="dialog-input-area dialog-body">
          <label>
            <span>{t.skills.skillNameLabel}</span>
            <input
              disabled={busy}
              ref={inputRef}
              className="dialog-capsule-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.skills.skillNamePlaceholder}
            />
          </label>
        </div>

        {error && <p role="alert" className="dialog-body">{error}</p>}
        <div className="dialog-footer-row">
          <button type="button" className="btn btn--capsule btn--secondary" onClick={onClose} disabled={busy}>
            {t.skills.cancelBtn}
          </button>
          <button disabled={busy} type="submit" className="btn btn--capsule btn--primary">
            {t.skills.confirmCreateBtn}
          </button>
        </div>
      </form>
    </dialog>
  )
}

function BrowserCaptureDialog({
  open,
  starting,
  onClose,
  onStart,
}: {
  open: boolean
  starting: boolean
  onClose: () => void
  onStart: (url: string) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [url, setUrl] = useState(() => {
    try {
      return window.localStorage.getItem('trace:last-browser-capture-url') || 'https://'
    } catch {
      return 'https://'
    }
  })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 40)
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={starting ? undefined : onClose}>
      <form
        className="dialog-surface modal-pop browser-capture-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          void onStart(url).then((started) => {
            if (!started) return
            try {
              window.localStorage.setItem('trace:last-browser-capture-url', url.trim())
            } catch {}
          })
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div>
            <h2>{t.workflows.browserDialogTitle}</h2>
            <p>{t.workflows.browserDialogDesc}</p>
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose} aria-label={t.skills.cancelBtn} disabled={starting}>
            <X size={15} />
          </button>
        </div>

        <div className="dialog-input-area dialog-body">
          <label>
            <span>{t.workflows.browserUrlLabel}</span>
            <input
              ref={inputRef}
              className="dialog-capsule-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t.workflows.browserUrlPlaceholder}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={starting}
            />
          </label>
          <div className="browser-capture-dialog__note">
            <ShieldCheck size={13} />
            <span>{t.workflows.browserDialogPrivacy}</span>
          </div>
        </div>

        <div className="dialog-footer-row">
          <button type="button" className="btn btn--capsule btn--secondary" onClick={onClose} disabled={starting}>
            {t.skills.cancelBtn}
          </button>
          <button type="submit" className="btn btn--capsule btn--primary" disabled={starting || !url.trim()}>
            {starting ? <RefreshCw size={12} className="master-list-status__spinner" /> : <Globe size={12} />}
            <span>{starting ? t.workflows.browserStarting : t.workflows.browserStartBtn}</span>
          </button>
        </div>
      </form>
    </div>
  )
}

function updateDomTheme(theme: 'dark' | 'light') {
  if (typeof window !== 'undefined') {
    const root = window.document?.documentElement
    const body = window.document?.body
    if (root) root.dataset.theme = theme
    if (body) body.dataset.theme = theme
  }
}

function transitionTheme(callback: () => void) {
  if (typeof window !== 'undefined') {
    const doc = window.document as unknown as { startViewTransition?: (cb: () => void) => void }
    if (typeof doc?.startViewTransition === 'function') {
      doc.startViewTransition(callback)
      return
    }
  }
  callback()
}

const MASTER_COLUMN_DEFAULT_WIDTH = 280
const MASTER_COLUMN_MIN_WIDTH = 240
const MASTER_COLUMN_MAX_WIDTH = 360
const MASTER_COLUMN_STORAGE_KEY = 'trace:master-column-width'
const MASTER_COLUMN_COLLAPSED_STORAGE_KEY = 'trace:master-column-collapsed'

function isEditableTarget(target: EventTarget | null): boolean {
  const element =
    (target instanceof HTMLElement ? target : null) ||
    (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
  if (!element) return false
  if (element.isContentEditable) return true
  const tagName = element.tagName.toUpperCase()
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true
  }
  return Boolean(
    element.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable], [role="textbox"], .monaco-editor, .cm-editor, .skill-md-editor'
    )
  )
}

function clampMasterColumnWidth(width: number) {
  const viewportMax = typeof window === 'undefined'
    ? MASTER_COLUMN_MAX_WIDTH
    : Math.max(MASTER_COLUMN_MIN_WIDTH, window.innerWidth - 160 - 480)
  return Math.round(Math.min(Math.max(width, MASTER_COLUMN_MIN_WIDTH), MASTER_COLUMN_MAX_WIDTH, viewportMax))
}

function getInitialMasterColumnWidth() {
  if (typeof window === 'undefined') return MASTER_COLUMN_DEFAULT_WIDTH
  try {
    const raw = window.localStorage.getItem(MASTER_COLUMN_STORAGE_KEY)
    const stored = Number(raw)
    if (Number.isFinite(stored) && stored > 0) {
      if (stored === 210) return MASTER_COLUMN_DEFAULT_WIDTH
      return Math.round(Math.min(Math.max(stored, MASTER_COLUMN_MIN_WIDTH), MASTER_COLUMN_MAX_WIDTH))
    }
  } catch {}
  return MASTER_COLUMN_DEFAULT_WIDTH
}

function MasterColumnResizeHandle({
  onToggleCollapse,
}: {
  onToggleCollapse?: () => void
}) {
  const handleRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const preferredWidthRef = useRef(getInitialMasterColumnWidth())
  const widthRef = useRef(clampMasterColumnWidth(preferredWidthRef.current))
  const [width, setWidth] = useState(widthRef.current)

  const renderWidth = (nextWidth: number) => {
    const clamped = clampMasterColumnWidth(nextWidth)
    widthRef.current = clamped
    setWidth(clamped)
    document.documentElement.style.setProperty('--master-column-width', `${clamped}px`)
    return clamped
  }

  const applyWidth = (nextWidth: number, persist = false) => {
    const clamped = renderWidth(nextWidth)
    preferredWidthRef.current = clamped
    if (persist) {
      try {
        window.localStorage.setItem(MASTER_COLUMN_STORAGE_KEY, String(clamped))
      } catch {}
    }
  }

  const finishResize = () => {
    if (!dragStartRef.current) return
    dragStartRef.current = null
    document.body.classList.remove('is-resizing-master-column')
    applyWidth(widthRef.current, true)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragStartRef.current = { pointerX: event.clientX, width: widthRef.current }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing-master-column')
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return
    applyWidth(dragStartRef.current.width + event.clientX - dragStartRef.current.pointerX)
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    finishResize()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 24 : 8
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = widthRef.current - step
    if (event.key === 'ArrowRight') nextWidth = widthRef.current + step
    if (event.key === 'Home') nextWidth = MASTER_COLUMN_MIN_WIDTH
    if (event.key === 'End') nextWidth = MASTER_COLUMN_MAX_WIDTH
    if (nextWidth === null) return
    event.preventDefault()
    applyWidth(nextWidth, true)
  }

  useLayoutEffect(() => {
    renderWidth(preferredWidthRef.current)
    const handleWindowResize = () => renderWidth(preferredWidthRef.current)
    window.addEventListener('resize', handleWindowResize)
    return () => {
      window.removeEventListener('resize', handleWindowResize)
      document.body.classList.remove('is-resizing-master-column')
    }
  }, [])

  return (
    <div
      ref={handleRef}
      className="master-column-resizer"
      role="separator"
      aria-label="调整中间栏宽度"
      aria-orientation="vertical"
      aria-valuemin={MASTER_COLUMN_MIN_WIDTH}
      aria-valuemax={MASTER_COLUMN_MAX_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      tabIndex={0}
      title="拖拽调整中间栏宽度，双击恢复默认 (280px)"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={finishResize}
      onDoubleClick={() => applyWidth(MASTER_COLUMN_DEFAULT_WIDTH, true)}
      onKeyDown={handleKeyDown}
    >
      {onToggleCollapse && (
        <button
          type="button"
          className="master-resizer-collapse-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapse()
          }}
          title="折叠中间栏 (⌘B)"
          aria-label="折叠中间栏"
          tabIndex={-1}
        >
          <PanelLeftClose size={12} />
        </button>
      )}
    </div>
  )
}

/* =========================================================================
   Main App Root
   ========================================================================= */
export function App() {
  const { t, resolvedLocale } = useI18n()
  const stageRef = useRef<HTMLDivElement>(null)
  const [toast, setToast] = useState('')
  const [view, setView] = useState<View>('skills')
  const [inSettings, setInSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>('dark')
  const [observing, setObserving] = useState(false)
  const [browserCaptureOpen, setBrowserCaptureOpen] = useState(false)
  const [browserCaptureStarting, setBrowserCaptureStarting] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [newSkillOpen, setNewSkillOpen] = useState(false)
  useUpdateBlocker('new-skill', newSkillOpen)
  const [exportState, setExportState] = useState<{
    open: boolean
    skillName: string
    workflow: Workflow | null
  }>({ open: false, skillName: '', workflow: null })

  const [masterCollapsed, setMasterCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(MASTER_COLUMN_COLLAPSED_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const isMasterCollapsed = !inSettings && view !== 'accounts' && masterCollapsed
  const toggleMasterCollapse = useCallback(() => {
    setMasterCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(MASTER_COLUMN_COLLAPSED_STORAGE_KEY, String(next))
      } catch {}
      return next
    })
  }, [])

  // Shared Workspace State across App (OPC-73)
  const [workspaceScope, setWorkspaceScope] = useState<'global' | 'project'>('global')
  const [workspaceProjects, setWorkspaceProjects] = useState<ManagedProjectRecord[]>([])
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string>('')

  const refreshWorkspaceProjects = useCallback(async () => {
    try {
      if (!window.workflowSkill?.listManagedProjects) return
      const [projects, activeProject] = await Promise.all([
        window.workflowSkill.listManagedProjects(),
        window.workflowSkill.getActiveProject ? window.workflowSkill.getActiveProject() : Promise.resolve(null),
      ])
      const allProjects = Array.isArray(projects) ? projects : []
      setWorkspaceProjects(allProjects)
      setWorkspaceProjectId((prev) => {
        if (prev && allProjects.some((p) => p.id === prev)) {
          return prev
        }
        const activeValid = allProjects.find((p) => p.id === activeProject?.id && p.status === 'valid')
        if (activeValid) return activeValid.id
        const firstValid = allProjects.find((p) => p.status === 'valid')
        return firstValid ? firstValid.id : ''
      })
    } catch {
      setWorkspaceProjects([])
      setWorkspaceProjectId('')
    }
  }, [])

  useEffect(() => {
    void refreshWorkspaceProjects()
    const unsubscribe = window.workflowSkill?.onProjectsChanged?.(() => {
      void refreshWorkspaceProjects()
    })
    const onFocus = () => void refreshWorkspaceProjects()
    const onWorkspaceChanged = () => void refreshWorkspaceProjects()
    window.addEventListener('focus', onFocus)
    window.addEventListener('workflow-skill:workspace-changed', onWorkspaceChanged)
    return () => {
      unsubscribe?.()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('workflow-skill:workspace-changed', onWorkspaceChanged)
    }
  }, [refreshWorkspaceProjects])

  const workspaceSelectedProject = useMemo(() => {
    return workspaceProjects.find((p) => p.id === workspaceProjectId) || null
  }, [workspaceProjects, workspaceProjectId])

  const handleSelectWorkspaceProjectId = useCallback(async (id: string) => {
    if (window.workflowSkill?.setActiveProject) {
      try {
        const res = await window.workflowSkill.setActiveProject(id)
        if (res && res.success === false) {
          setToast(res.error || '切换项目失败')
          return
        }
      } catch (err) {
        setToast(err instanceof Error ? err.message : '切换项目失败')
        return
      }
    }
    setWorkspaceProjectId(id)
    window.dispatchEvent(new CustomEvent('workflow-skill:workspace-changed'))
  }, [])

  // Real Dynamic Skills & Discoveries in State (Zero Fake Data)
  const [skills, setSkills] = useState<Skill[]>([])
  const [discoveries, setDiscoveries] = useState<Workflow[]>([])
  const [aiTools, setAiTools] = useState<AIToolTarget[]>(DEFAULT_AI_TOOLS)

  // 3-Column macOS Selection States
  const [selectedSkillId, setSelectedSkillId] = useState<string>('')
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('')

  const aiToolsReqSeqRef = useRef(0)
  const refreshAiTools = useCallback(async () => {
    if (!window.workflowSkill?.getAITools) return
    const currentSeq = ++aiToolsReqSeqRef.current
    try {
      const detected = await window.workflowSkill.getAITools()
      if (currentSeq === aiToolsReqSeqRef.current && Array.isArray(detected) && detected.length > 0) {
        setAiTools(detected)
      }
    } catch {
      // Retain current state on error
    }
  }, [])

  const skillsReqSeqRef = useRef(0)
  const refreshSkills = useCallback(async () => {
    if (!window.workflowSkill?.loadLocalSkills) return
    const currentSeq = ++skillsReqSeqRef.current
    try {
      const loaded = await window.workflowSkill.loadLocalSkills()
      if (currentSeq === skillsReqSeqRef.current && Array.isArray(loaded)) {
        if (loaded.length > 0) {
          setSkills(loaded)
          setSelectedSkillId((prev) => prev || loaded[0].id)
        } else {
          // Seed demo skills with rich target tools data
          setSkills(demoSkills)
          setSelectedSkillId((prev) => prev || demoSkills[0].id)
          for (const ds of demoSkills) {
            void window.workflowSkill?.saveLocalSkill?.(ds)
          }
        }
      }
    } catch {
      // Retain current state on error
    }
  }, [])

  const refreshAllSkillsData = useCallback(async () => {
    await Promise.all([refreshSkills(), refreshAiTools()])
  }, [refreshSkills, refreshAiTools])

  useEffect(() => {
    void refreshAiTools()
    void refreshSkills()

    const handleWorkspaceChanged = () => {
      void refreshAiTools()
      void refreshSkills()
    }
    window.addEventListener('workflow-skill:workspace-changed', handleWorkspaceChanged)

    const unsubscribeSkills = window.workflowSkill?.onSkillsChanged?.(() => {
      void refreshAiTools()
      void refreshSkills()
    })

    return () => {
      window.removeEventListener('workflow-skill:workspace-changed', handleWorkspaceChanged)
      unsubscribeSkills?.()
    }
  }, [refreshAiTools, refreshSkills])

  const handleToggleLinkTarget = async (skill: Skill, targetId: string) => {
    const isCurrentlyLinked = Boolean(skill.targetTools?.includes(targetId))
    const tool = aiTools.find((t) => t.id === targetId) || DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
    const toolName = tool?.name || targetId

    try {
      if (isCurrentlyLinked) {
        if (window.workflowSkill?.unlinkSkillTarget) {
          const res = await window.workflowSkill.unlinkSkillTarget(skill.id, targetId)
          if (res && res.success === false) {
            setToast(`Failed to unlink ${skill.name} from ${toolName}`)
            return
          }
        }
        setSkills((prev) =>
          prev.map((s) =>
            s.id === skill.id
              ? { ...s, targetTools: (s.targetTools || []).filter((id) => id !== targetId) }
              : s,
          ),
        )
        await refreshAiTools()
        setToast(t.skills.unlinkedSuccessToast(skill.name, toolName))
      } else {
        if (window.workflowSkill?.linkSkillTarget) {
          const res = await window.workflowSkill.linkSkillTarget(skill.id, targetId)
          if (res && res.success === false) {
            setToast(`Failed to link ${skill.name} to ${toolName}`)
            return
          }
        }
        setSkills((prev) =>
          prev.map((s) =>
            s.id === skill.id
              ? { ...s, targetTools: Array.from(new Set([...(s.targetTools || []), targetId])) }
              : s,
          ),
        )
        await refreshAiTools()
        setToast(t.skills.linkedSuccessToast(skill.name, toolName))
      }
    } catch (err: any) {
      setToast(err?.message || (isCurrentlyLinked ? `Failed to unlink ${skill.name} from ${toolName}` : `Failed to link ${skill.name} to ${toolName}`))
    }
  }

  const handleDeleteSkillCompletely = async (skill: Skill, mode: DeleteSkillMode) => {
    let deleted = false
    if (window.workflowSkill?.deleteSkillCompletely) {
      deleted = await window.workflowSkill.deleteSkillCompletely(skill.id, mode)
    } else if (window.workflowSkill?.deleteLocalSkill) {
      deleted = await window.workflowSkill.deleteLocalSkill(skill.id, mode)
    }
    if (!deleted) throw new Error('Skill deletion failed')
    setSkills((prev) => prev.filter((s) => s.id !== skill.id))
    if (activeDetail?.skill?.id === skill.id) {
      setActiveDetail(null)
    }
    await refreshAiTools()
    setToast(mode === 'trash' ? t.skills.trashedToast(skill.name) : t.skills.deletedToast(skill.name))
  }

  // Active Level-2 Workflow Detail State
  const [activeDetail, setActiveDetail] = useState<ActiveDetailState | null>(null)

  // Track saved workflow states
  const [savedWorkflowIds, setSavedWorkflowIds] = useState<Record<string, boolean>>({})

  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>()
  const [browserCaptureStatus, setBrowserCaptureStatus] = useState<BrowserCaptureStatus>()
  const [recentEvents, setRecentEvents] = useState<CaptureEvent[]>([])
  const [captureSessionId, setCaptureSessionId] = useState('')
  const pendingCaptureSessionIdRef = useRef('')

  const handleChangeThemeMode = (nextMode: ThemeMode) => {
    transitionTheme(() => {
      setThemeMode(nextMode)
    })
  }

  useEffect(() => {
    const getSystemTheme = (): 'dark' | 'light' =>
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

    const effective = themeMode === 'system' ? getSystemTheme() : themeMode
    setResolvedTheme(effective)
    updateDomTheme(effective)

    if (window.workflowSkill?.setTheme) {
      void window.workflowSkill.setTheme(themeMode)
    }

    if (themeMode === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (e: MediaQueryListEvent) => {
        const next = e.matches ? 'dark' : 'light'
        transitionTheme(() => {
          setResolvedTheme(next)
          updateDomTheme(next)
        })
      }
      media.addEventListener('change', listener)
      return () => media.removeEventListener('change', listener)
    }
  }, [themeMode])

  useEffect(() => {
    const api = window.workflowSkill
    if (!api) return

    let mounted = true
    const applyRecorderStatus = (status: RecorderStatus) => {
      if (!mounted) return
      setRecorderStatus(status)
    }
    const applyBrowserCaptureStatus = (status: BrowserCaptureStatus) => {
      if (!mounted) return
      setBrowserCaptureStatus(status)
      setObserving(status.state === 'capturing')
      if (status.sessionId) setCaptureSessionId(status.sessionId)
    }
    const loadCapturedWorkflows = () => {
      if (!api.loadCapturedWorkflows) return
      void api
        .loadCapturedWorkflows()
        .then((workflows) => {
          if (!mounted) return
          setDiscoveries(workflows)
          const completedSessionId = pendingCaptureSessionIdRef.current
          const completedWorkflow = completedSessionId
            ? workflows.find((workflow) => workflow.capture?.sessionIds.includes(completedSessionId))
            : undefined
          if (completedWorkflow) {
            pendingCaptureSessionIdRef.current = ''
            setSelectedWorkflowId(completedWorkflow.id)
            return
          }
          setSelectedWorkflowId((current) => (
            workflows.some((workflow) => workflow.id === current) ? current : workflows[0]?.id || ''
          ))
        })
        .catch(() => {})
    }
    const loadCapturedEvents = () => {
      if (!api.loadCapturedEvents) return
      void api
        .loadCapturedEvents(200)
        .then((events) => {
          if (mounted) setRecentEvents(events)
        })
        .catch(() => {})
    }

    loadCapturedWorkflows()
    loadCapturedEvents()
    api
      .getRecorderStatus()
      .then((status) => {
        applyRecorderStatus(status)
        void api.sendRecorderCommand({ type: 'status' })
      })
      .catch(() => setToast(t.toast.nativeNotReady))
    if (api.getBrowserCaptureStatus && api.sendBrowserCaptureCommand) {
      void api.getBrowserCaptureStatus().then((status) => {
        applyBrowserCaptureStatus(status)
        void api.sendBrowserCaptureCommand?.({ type: 'status' })
      }).catch(() => setToast(t.toast.nativeNotReady))
    }

    const unsubscribe = api.onRecorderMessage((message: RecorderEnvelope) => {
      if (message.type === 'status') {
        applyRecorderStatus(message.payload)
      } else if (message.type === 'capture-event') {
        setCaptureSessionId(message.payload.sessionId)
        setRecentEvents((events) => [message.payload, ...events.filter((event) => event.id !== message.payload.id)].slice(0, 200))
        setRecorderStatus((status) =>
          status
            ? {
                ...status,
                eventCount: status.eventCount + 1,
                activeApplication: message.payload.applicationId ?? status.activeApplication,
                timestamp: message.timestamp,
              }
            : status,
        )
      } else if (message.type === 'frame-sample') {
        setRecorderStatus((status) =>
          status
            ? {
                ...status,
                frameCount: message.payload.frameNumber,
                timestamp: message.timestamp,
              }
            : status,
        )
      } else if (message.type === 'error') {
        setToast(message.payload.message)
      }
    })
    const unsubscribeBrowser = api.onBrowserCaptureMessage?.((message: BrowserCaptureEnvelope) => {
      if (message.type === 'status') {
        applyBrowserCaptureStatus(message.payload)
      } else if (message.type === 'capture-event') {
        setCaptureSessionId(message.payload.sessionId)
        setRecentEvents((events) => [message.payload, ...events.filter((event) => event.id !== message.payload.id)].slice(0, 200))
        setBrowserCaptureStatus((status) => status ? {
          ...status,
          eventCount: status.eventCount + 1,
          requestCount: status.requestCount + (message.payload.eventType === 'network-request' ? 1 : 0),
          pageUrl: message.payload.page?.url || status.pageUrl,
          pageTitle: message.payload.page?.title || status.pageTitle,
          timestamp: message.timestamp,
        } : status)
      } else if (message.type === 'error') {
        setToast(message.payload.message)
      }
    })
    const unsubscribeWorkflows = api.onCapturedWorkflowsChanged?.(() => {
      loadCapturedWorkflows()
      loadCapturedEvents()
    })
    return () => {
      mounted = false
      unsubscribe()
      unsubscribeBrowser?.()
      unsubscribeWorkflows?.()
    }
  }, [])

  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [view, activeDetail, inSettings, settingsTab])

  // Precise ESC Key Hierarchy: Modals -> Level-2 Detail -> Settings
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((v) => !v)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        if (!inSettings && view !== 'accounts' && !isEditableTarget(event.target)) {
          event.preventDefault()
          toggleMasterCollapse()
          return
        }
      }
      if (event.key === 'Escape') {
        // Priority 1: Modals
        if (commandOpen) {
          setCommandOpen(false)
          return
        }
        if (exportState.open) {
          setExportState({ open: false, skillName: '', workflow: null })
          return
        }
        if (newSkillOpen) {
          setNewSkillOpen(false)
          return
        }
        if (browserCaptureOpen && !browserCaptureStarting) {
          setBrowserCaptureOpen(false)
          return
        }
        // Priority 2: Detail Page
        if (activeDetail) {
          setActiveDetail(null)
          return
        }
        // Priority 3: Settings Mode
        if (inSettings) {
          setInSettings(false)
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [commandOpen, exportState.open, newSkillOpen, browserCaptureOpen, browserCaptureStarting, activeDetail, inSettings, view, toggleMasterCollapse])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const toggleObserving = async () => {
    const api = window.workflowSkill
    if (!api?.sendBrowserCaptureCommand) {
      setToast(t.toast.nativeNotReady)
      return
    }
    if (observing) {
      const sessionId = captureSessionId || browserCaptureStatus?.sessionId || ''
      pendingCaptureSessionIdRef.current = sessionId
      try {
        await api.sendBrowserCaptureCommand({ type: 'stop' })
      } catch {
        pendingCaptureSessionIdRef.current = ''
        setToast(t.toast.nativeNotReady)
      }
    } else {
      setBrowserCaptureOpen(true)
    }
  }

  const startBrowserCapture = async (url: string) => {
    const api = window.workflowSkill
    if (!api?.sendBrowserCaptureCommand) {
      setToast(t.toast.nativeNotReady)
      return false
    }
    const sessionId = crypto.randomUUID()
    setBrowserCaptureStarting(true)
    setCaptureSessionId(sessionId)
    setRecentEvents((events) => events.filter((event) => event.sessionId !== sessionId))
    try {
      await api.sendBrowserCaptureCommand({ type: 'start', sessionId, url })
      setBrowserCaptureOpen(false)
      return true
    } catch (error) {
      setCaptureSessionId('')
      setToast(error instanceof Error ? error.message : t.toast.nativeNotReady)
      return false
    } finally {
      setBrowserCaptureStarting(false)
    }
  }

  const handleUpdateCapturedWorkflow = async (workflow: Workflow) => {
    const api = window.workflowSkill
    if (!api?.updateCapturedWorkflow) {
      setToast(t.toast.nativeNotReady)
      return false
    }
    try {
      const updated = await api.updateCapturedWorkflow(workflow)
      if (updated) {
        setDiscoveries((current) => current.map((item) => item.id === workflow.id ? workflow : item))
      }
      return updated
    } catch {
      setToast(t.toast.nativeNotReady)
      return false
    }
  }

  const handleSaveWorkflow = async (wf: Workflow) => {
    const appList = Array.from(new Set(wf.nodes.map((n) => n.app).filter((a): a is string => Boolean(a))))
    const newSk: Skill = {
      id: wf.id,
      name: wf.name,
      description: wf.summary,
      apps: appList.length > 0 ? appList : ['System'],
      versions: 1,
      pinned: true,
      sourceRuns: wf.repeatCount || 1,
      workflow: wf,
      skillMarkdown: workflowSkillMarkdown(wf, resolvedLocale === 'zh-CN'),
      updatedLabel: '刚刚',
    }

    if (window.workflowSkill?.saveLocalSkill) {
      const saved = await window.workflowSkill.saveLocalSkill(newSk)
      if (!saved) {
        setToast(t.toast.nativeNotReady)
        return
      }
    }

    setSavedWorkflowIds((prev) => ({ ...prev, [wf.id]: true }))
    setSkills((prev) => {
      return [newSk, ...prev.filter((skill) => skill.id !== wf.id)]
    })

    setToast(t.workflows.savedToast(wf.name))
  }

  const handleCreateNewSkill = (name: string) => {
    const id = `custom-${Date.now()}`
    const newWf: Workflow = {
      id,
      name,
      confidence: 100,
      repeatCount: 1,
      summary: t.skills.customFrameworkDesc,
      nodes: [
        { id: '1', label: '准备工作', kind: 'action', app: 'Finder', confidence: 95 },
        { id: '2', label: '执行处理', kind: 'action', app: 'Terminal', confidence: 92 },
        { id: 'done', label: '完成', kind: 'action', confidence: 99 },
      ],
      edges: [
        { from: '1', to: '2' },
        { from: '2', to: 'done' },
      ],
      estimatedMinutes: 5,
    }
    const newSkill: Skill = {
      id,
      name,
      description: t.skills.customFrameworkDesc,
      apps: ['Finder', 'Terminal'],
      versions: 1,
      pinned: true,
      sourceRuns: 1,
      workflow: newWf,
      updatedLabel: '刚刚',
    }
    setSkills((prev) => [newSkill, ...prev])
    if (window.workflowSkill?.saveLocalSkill) {
      void window.workflowSkill.saveLocalSkill(newSkill)
    }
    setNewSkillOpen(false)
    setToast(t.skills.createdToast(name))
  }

  const requestRecorderPermissions = (
    targetType?: 'accessibility' | 'screenRecording' | 'all',
    e?: React.MouseEvent,
  ) => {
    const api = window.workflowSkill
    if (!api?.sendRecorderCommand) return
    if (targetType === 'all') {
      void api.sendRecorderCommand({ type: 'status' })
      setToast(t.settings.verifyingToast)
      return
    }

    const permType = targetType === 'screenRecording' ? 'screenRecording' : 'accessibility'
    let sourceFrame: { x: number; y: number; width: number; height: number } | undefined
    if (e && typeof window !== 'undefined') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      sourceFrame = {
        x: Math.round(window.screenX + rect.left),
        y: Math.round(window.screenY + rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
    }
    void (async () => {
      await api.openPrivacySettings?.(permType, sourceFrame)
      // The permiso flow grants access by dragging the app into System Settings.
      // Triggering the native permission prompt here would reactivate Trace and
      // cover System Settings immediately after it opens.
      await api.sendRecorderCommand({ type: 'status' })
    })()
    setToast(t.settings.verifyingToast)
  }

  return (
    <div className={`app-shell ${inSettings ? 'is-settings' : view === 'accounts' ? 'is-accounts' : ''} ${isMasterCollapsed ? 'is-master-collapsed' : ''}`} data-theme={resolvedTheme}>
      {/* Global Top Window Drag Strip for macOS */}
      <div className="app-window-drag-strip" />

      {/* Floating Expand Trigger when Master Column is Collapsed */}
      {isMasterCollapsed ? (
        <button
          type="button"
          className="master-expand-floating-trigger"
          onClick={toggleMasterCollapse}
          title={`${t.nav.expandMaster} (⌘B)`}
          aria-label={t.nav.expandMaster}
        >
          <PanelLeftOpen size={13} />
          <span>{t.nav.expandMaster}</span>
          <kbd>⌘B</kbd>
        </button>
      ) : null}

      {/* Column 1: Sidebar Rail */}
      <AppSidebar
        view={view}
        setView={(v) => {
          setInSettings(false)
          setView(v)
        }}
        inSettings={inSettings}
        settingsTab={settingsTab}
        setSettingsTab={setSettingsTab}
        onEnterSettings={() => {
          setActiveDetail(null)
          setSettingsTab('general')
          setInSettings(true)
        }}
        onExitSettings={() => setInSettings(false)}
        onBackToOverview={() => {
          setActiveDetail(null)
          setInSettings(false)
        }}
        masterCollapsed={isMasterCollapsed}
        onToggleMasterCollapse={!inSettings && view !== 'accounts' ? toggleMasterCollapse : undefined}
        scope={workspaceScope}
        onScopeChange={setWorkspaceScope}
        projects={workspaceProjects}
        selectedProjectId={workspaceProjectId}
        onSelectProjectId={handleSelectWorkspaceProjectId}
        selectedProject={workspaceSelectedProject}
      />

      {!inSettings && view !== 'accounts' ? <MasterColumnResizeHandle onToggleCollapse={toggleMasterCollapse} /> : null}

      {/* Settings Mode: Clean 2-Pane Architecture (Sidebar + Full Width Settings Stage) */}
      {inSettings ? (
        <main className="app-main-stage view-enter">
          <SettingsMainPage
            tab={settingsTab}
            themeMode={themeMode}
            resolvedTheme={resolvedTheme}
            onChangeThemeMode={handleChangeThemeMode}
            observing={observing}
            onToggleObserving={toggleObserving}
            recorderStatus={recorderStatus}
            onRequestPermissions={requestRecorderPermissions}
            onShowToast={setToast}
            onNavigateToAccounts={() => {
              setInSettings(false)
              setView('accounts')
            }}
          />
        </main>
      ) : view === 'projects' ? (
        <ProjectsThreeColumn notify={setToast} />
      ) : view === 'mcp' ? (
        <McpThreeColumn
          notify={setToast}
          scope={workspaceScope}
          projects={workspaceProjects}
          selectedProjectId={workspaceProjectId}
          selectedProject={workspaceSelectedProject}
          onScopeChange={setWorkspaceScope}
          onSelectProjectId={handleSelectWorkspaceProjectId}
        />
      ) : view === 'rules' ? (
        <RulesThreeColumn
          notify={setToast}
          scope={workspaceScope}
          projects={workspaceProjects}
          selectedProjectId={workspaceProjectId}
          selectedProject={workspaceSelectedProject}
          onScopeChange={setWorkspaceScope}
          onSelectProjectId={handleSelectWorkspaceProjectId}
        />
      ) : view === 'accounts' ? (
        <AccountSettings presentation="workspace" api={window.workflowSkill?.accounts} onNotify={setToast} />
      ) : view === 'skills' ? (
        <SkillsThreeColumn
          skills={skills}
          aiTools={aiTools}
          selectedSkillId={selectedSkillId}
          onSelectSkillId={setSelectedSkillId}
          onToggleLinkTarget={handleToggleLinkTarget}
          onDeleteSkill={handleDeleteSkillCompletely}
          onReloadSkills={refreshAllSkillsData}
          onExportCode={(wf, name) => setExportState({ open: true, skillName: name, workflow: wf })}
          notify={setToast}
          scope={workspaceScope}
          onScopeChange={setWorkspaceScope}
          projects={workspaceProjects}
          selectedProjectId={workspaceProjectId}
          onSelectProjectId={handleSelectWorkspaceProjectId}
          selectedProject={workspaceSelectedProject}
          onRefreshProjects={refreshWorkspaceProjects}
        />
      ) : (
        <WorkflowsThreeColumn
          items={discoveries}
          savedMap={savedWorkflowIds}
          selectedWorkflowId={selectedWorkflowId}
          onSelectWorkflowId={setSelectedWorkflowId}
          onSaveSkill={handleSaveWorkflow}
          observing={observing}
          recorderStatus={recorderStatus}
          browserCaptureStatus={browserCaptureStatus}
          recentEvents={recentEvents}
          captureSessionId={captureSessionId}
          onToggleCapture={() => void toggleObserving()}
          onUpdateWorkflow={handleUpdateCapturedWorkflow}
          onExportCode={(wf, name) => setExportState({ open: true, skillName: name, workflow: wf })}
          notify={setToast}
        />
      )}

      {/* Modals & Dialogs */}
      <AppCommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onSelectView={(v) => {
          setInSettings(false)
          setView(v)
          setActiveDetail(null)
        }}
        onOpenSettings={() => {
          setActiveDetail(null)
          setSettingsTab('general')
          setCommandOpen(false)
          setInSettings(true)
        }}
        onOpenNewSkill={() => {
          setCommandOpen(false)
          setNewSkillOpen(true)
        }}
        onToggleObserving={toggleObserving}
        observing={observing}
        onChangeThemeMode={handleChangeThemeMode}
      />

      <NewSkillDialog
        open={newSkillOpen}
        onClose={() => setNewSkillOpen(false)}
        onCreate={handleCreateNewSkill}
      />

      <BrowserCaptureDialog
        open={browserCaptureOpen}
        starting={browserCaptureStarting}
        onClose={() => setBrowserCaptureOpen(false)}
        onStart={startBrowserCapture}
      />

      <ExportSkillDialog
        skillName={exportState.skillName}
        workflow={exportState.workflow}
        open={exportState.open}
        onClose={() => setExportState({ open: false, skillName: '', workflow: null })}
        notify={setToast}
      />

      {/* Floating Capsule Toast */}
      {toast ? (
        <div className="app-capsule-toast toast-enter" role="status">
          <span>{toast}</span>
        </div>
      ) : null}
    </div>
  )
}
