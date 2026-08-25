import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code,
  Command,
  Copy,
  Cpu,
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
  Languages,
  Link2,
  Mail,
  Monitor,
  Moon,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Unlink,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from 'lucide-react'
import {
  DEFAULT_AI_TOOLS,
  demoSkills,
  type AIToolCategory,
  type AIToolTarget,
  type Skill,
  type Workflow,
  type WorkflowNode,
} from '@workflow-skill/workflow-model'
import type {
  CaptureEvent,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'
import { WorkflowGraph } from './components/WorkflowGraph'
import { AIToolLogo } from './AIToolLogo'
import { useI18n, type Locale, type TranslationKeys } from './i18n'

export type View = 'skills' | 'workflows' | 'environments'
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
}: {
  view: View
  setView: (view: View) => void
  inSettings: boolean
  settingsTab: SettingsTab
  setSettingsTab: (tab: SettingsTab) => void
  onEnterSettings: () => void
  onExitSettings: () => void
  onBackToOverview: () => void
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

          {/* Settings Section Brand */}
          <div className="sidebar-brand">
            <span className="brand-name">{t.nav.settings}</span>
          </div>

          {/* Settings Category Tabs */}
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
          {/* Brand Header */}
          <div className="sidebar-brand">
            <span className="brand-name">{t.brand.name}</span>
          </div>

          {/* Main Navigation Capsule Views: Skill, Workflow */}
          <nav className="sidebar-nav-list">
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
              className={`nav-pill-btn ${view === 'environments' ? 'is-active' : ''}`}
              onClick={() => {
                setView('environments')
                onBackToOverview()
              }}
            >
              <div className="nav-pill-btn__left">
                <Cpu size={15} className="nav-icon" />
                <span>{t.nav.environments}</span>
              </div>
            </button>
          </nav>

          {/* Clean Footer: Settings Entry */}
          <div className="sidebar-footer">
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
  onConfirm: (skill: Skill) => void
}) {
  const { t } = useI18n()
  if (!open || !skill) return null

  const linkedTools = aiTools.filter((tool) => skill.targetTools?.includes(tool.id))

  return (
    <div className="glass-modal-overlay view-enter" onClick={onClose}>
      <div className="glass-dialog-box safe-delete-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="safe-delete-header">
          <div className="danger-icon-badge">
            <AlertTriangle size={20} />
          </div>
          <div>
            <h3 className="glass-dialog-title">{t.skills.safeDeleteConfirmTitle}</h3>
            <p className="glass-dialog-desc">{t.skills.safeDeleteConfirmDesc(skill.name, linkedTools.length)}</p>
          </div>
        </div>

        {linkedTools.length > 0 ? (
          <div className="safe-delete-targets-list">
            <span className="safe-delete-targets-label">{t.skills.safeDeleteLinkedNotice}</span>
            <div className="safe-delete-targets-grid">
              {linkedTools.map((tool) => (
                <div key={tool.id} className="safe-delete-target-row font-mono">
                  <AIToolLogo toolId={tool.id} size={15} color />
                  <span className="target-name">{tool.name}</span>
                  <span className="target-path">({tool.detectedPath || tool.defaultDir}/{skill.id})</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="glass-dialog-actions">
          <button type="button" className="btn btn--secondary btn--capsule" onClick={onClose}>
            {t.skills.cancelBtn}
          </button>
          <button
            type="button"
            className="btn btn--danger btn--capsule"
            onClick={() => {
              onConfirm(skill)
              onClose()
            }}
          >
            <Trash2 size={13} />
            <span>{t.skills.confirmDeleteBtn}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function SkillDetailDrawer({
  skill,
  aiTools,
  open,
  onClose,
  onToggleLink,
  onDeleteRequest,
  notify,
}: {
  skill: Skill | null
  aiTools: AIToolTarget[]
  open: boolean
  onClose: () => void
  onToggleLink: (skill: Skill, toolId: string) => Promise<void>
  onDeleteRequest: (skill: Skill) => void
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()
  const [editingMd, setEditingMd] = useState('')
  const [savingMd, setSavingMd] = useState(false)

  useEffect(() => {
    if (skill) {
      setEditingMd(skill.skillMarkdown || '')
      if (window.workflowSkill?.readSkillMarkdown) {
        window.workflowSkill.readSkillMarkdown(skill.id).then((content) => {
          if (content) setEditingMd(content)
        }).catch(() => {})
      }
    }
  }, [skill])

  if (!open || !skill) return null

  const handleOpenSourceDir = () => {
    if (window.workflowSkill?.getStoragePath && window.workflowSkill?.openPathInFinder) {
      window.workflowSkill.getStoragePath().then((root) => {
        void window.workflowSkill?.openPathInFinder?.(`${root}/skills/${skill.id}`)
      }).catch(() => {})
    }
  }

  const handleSaveMarkdown = async () => {
    setSavingMd(true)
    try {
      if (window.workflowSkill?.saveSkillMarkdown) {
        await window.workflowSkill.saveSkillMarkdown(skill.id, editingMd)
      }
      notify?.(t.skills.savedSkillMdToast)
    } finally {
      setSavingMd(false)
    }
  }

  return (
    <div className="skill-drawer-overlay view-enter" onClick={onClose}>
      <aside className="skill-drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="skill-drawer-header">
          <div className="skill-drawer-title-wrap">
            <div className="skill-drawer-title-row">
              <h2 className="skill-drawer-title">{skill.name}</h2>
              <span className="pinned-ver-pill font-mono">{t.skills.versionPrefix}{skill.versions}.0</span>
            </div>
            <p className="skill-drawer-desc">{skill.description}</p>
          </div>
          <button type="button" className="drawer-close-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="skill-drawer-body">
          {/* Central Store Info */}
          <div className="skill-central-store-card">
            <div className="central-store-info">
              <Folder size={14} className="central-folder-icon" />
              <div className="central-store-paths">
                <span className="central-store-label">{t.skills.openSourceDirBtn}</span>
                <span className="central-store-path font-mono">~/.trace/skills/{skill.id}/SKILL.md</span>
              </div>
            </div>
            <button type="button" className="btn btn--secondary btn--capsule" onClick={handleOpenSourceDir}>
              <FolderOpen size={12} />
              <span>{t.skills.openSourceDirBtn}</span>
            </button>
          </div>

          {/* AI Tools Distribution Matrix */}
          <div className="skill-drawer-section">
            <div className="drawer-section-header">
              <h3 className="drawer-section-title">{t.skills.distributionMatrixTitle}</h3>
              <span className="drawer-section-sub">（支持 NTFS Junction 与 Symlink 跨平台无缝挂载）</span>
            </div>

            <div className="drawer-tool-list">
              {aiTools.map((tool) => {
                const isLinked = Boolean(skill.targetTools?.includes(tool.id))
                return (
                  <div key={tool.id} className={`drawer-tool-row ${isLinked ? 'is-linked' : ''}`}>
                    <div className="drawer-tool-left">
                      <div className="drawer-tool-icon-wrap">
                        <AIToolLogo toolId={tool.id} size={18} color />
                      </div>
                      <div className="drawer-tool-meta">
                        <div className="drawer-tool-name-row">
                          <strong className="drawer-tool-name">{tool.name}</strong>
                          <span className="tool-category-badge">{tool.category.toUpperCase()}</span>
                          <span className={`tool-installed-badge ${tool.installed ? 'is-installed' : ''}`}>
                            {tool.installed ? t.skills.installedBadge : t.skills.notInstalledBadge}
                          </span>
                        </div>
                        <span className="drawer-tool-path font-mono">
                          {tool.detectedPath || tool.defaultDir}/{skill.id}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`btn btn--capsule ${isLinked ? 'btn--primary' : 'btn--secondary'}`}
                      onClick={() => onToggleLink(skill, tool.id)}
                    >
                      {isLinked ? <Link2 size={12} /> : <Unlink size={12} />}
                      <span>{isLinked ? t.skills.healthyStatus : t.skills.unlinkedStatus}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Live SKILL.md Editor */}
          <div className="skill-drawer-section">
            <div className="drawer-section-header">
              <h3 className="drawer-section-title">{t.skills.editSkillMdTitle}</h3>
              <button
                type="button"
                className="btn btn--secondary btn--capsule"
                onClick={handleSaveMarkdown}
                disabled={savingMd}
              >
                <Check size={12} />
                <span>{t.skills.saveSkillMdBtn}</span>
              </button>
            </div>
            <textarea
              className="skill-md-editor font-mono"
              value={editingMd}
              onChange={(e) => setEditingMd(e.target.value)}
              placeholder="# SKILL.md Instructions..."
              rows={12}
            />
          </div>

          {/* Danger Zone */}
          <div className="skill-drawer-section danger-zone-section">
            <div className="danger-zone-card">
              <div className="danger-zone-info">
                <strong>{t.skills.safeDeleteConfirmTitle}</strong>
                <span>删除此 Skill 将自动解除全部已挂载工具目录的软链接，并移除中央源文件。</span>
              </div>
              <button
                type="button"
                className="btn btn--danger btn--capsule"
                onClick={() => onDeleteRequest(skill)}
              >
                <Trash2 size={13} />
                <span>{t.skills.confirmDeleteBtn}</span>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

function SkillsOverviewPage({
  skills,
  aiTools,
  onOpenDetail,
  onNewSkill,
  onToggleLinkTarget,
  onDeleteSkill,
  onDetectTools,
  notify,
}: {
  skills: Skill[]
  aiTools: AIToolTarget[]
  onOpenDetail: (skill: Skill) => void
  onNewSkill: () => void
  onToggleLinkTarget: (skill: Skill, targetId: string) => Promise<void>
  onDeleteSkill: (skill: Skill) => void
  onDetectTools: () => void
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()
  const [skillTab, setSkillTab] = useState<'local' | 'remote'>('local')
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'pinned'>('all')
  const [categoryFilter, setCategoryFilter] = useState<AIToolCategory>('all')
  const [selectedToolFilter, setSelectedToolFilter] = useState<string>('all')

  // Drawer and Delete Modal States
  const [drawerSkill, setDrawerSkill] = useState<Skill | null>(null)
  const [deleteModalSkill, setDeleteModalSkill] = useState<Skill | null>(null)

  // Filter skills by search query, pin status, AI tool category, and specific target tool
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((sk) => {
      if (filterMode === 'pinned' && !sk.pinned) return false

      if (categoryFilter !== 'all') {
        const targetToolObjects = (sk.targetTools || []).map((tid) => aiTools.find((t) => t.id === tid)).filter(Boolean)
        const matchesCategory = targetToolObjects.some((t) => t?.category === categoryFilter)
        if (!matchesCategory) return false
      }

      if (selectedToolFilter !== 'all') {
        if (!sk.targetTools?.includes(selectedToolFilter)) return false
      }

      if (!q) return true
      const searchStr = `${sk.name} ${sk.description} ${(sk.apps || []).join(' ')} ${(sk.tags || []).join(' ')} ${(sk.triggers || []).join(' ')} ${(sk.targetTools || []).join(' ')}`.toLowerCase()
      return searchStr.includes(q)
    })
  }, [skills, query, filterMode, categoryFilter, selectedToolFilter, aiTools])

  const pinnedCount = useMemo(() => skills.filter((s) => s.pinned).length, [skills])

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<AIToolCategory, number> = {
      all: skills.length,
      ide: 0,
      cli: 0,
      extension: 0,
      standard: 0,
    }
    for (const sk of skills) {
      const categories = new Set(
        (sk.targetTools || []).map((tid) => aiTools.find((t) => t.id === tid)?.category).filter(Boolean)
      )
      if (categories.has('ide')) counts.ide += 1
      if (categories.has('cli')) counts.cli += 1
      if (categories.has('extension')) counts.extension += 1
      if (categories.has('standard')) counts.standard += 1
    }
    return counts
  }, [skills, aiTools])

  const handleOpenLocalDir = () => {
    if (window.workflowSkill?.getStoragePath && window.workflowSkill?.openPathInFinder) {
      window.workflowSkill.getStoragePath().then((root) => {
        void window.workflowSkill?.openPathInFinder?.(root)
      }).catch(() => {})
    }
  }

  return (
    <div className="clean-page view-enter">
      <header className="page-header stagger-item">
        <div className="page-header__left">
          <h1 className="page-title">{skillTab === 'local' ? t.skills.title : t.skills.remoteLibraryTitle}</h1>
          <span className="page-subtitle">{skillTab === 'local' ? t.skills.subtitle : t.skills.remoteLibrarySub}</span>
        </div>

        {/* Centered Segmented Tab Switcher (Local vs Remote with Spring Slider) */}
        <div className="page-header__center">
          <SkillSegmentedTabs
            value={skillTab}
            onChange={(next) => {
              setSkillTab(next)
              setQuery('')
            }}
          />
        </div>

        <div className="page-header__right">
          {skillTab === 'local' ? (
            <>
              <button
                type="button"
                className="btn btn--secondary btn--capsule"
                onClick={onDetectTools}
                title={t.skills.detectToolsBtn}
              >
                <Sparkles size={13} className="sparkle-active-icon" />
                <span>{t.skills.detectToolsBtn}</span>
              </button>
              <button type="button" className="btn btn--primary btn--capsule" onClick={onNewSkill}>
                <Plus size={13} />
                <span>{t.skills.newSkill}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--secondary btn--capsule"
              onClick={() => notify?.(t.skills.remoteComingSoonToast)}
            >
              <Sliders size={13} />
              <span>{t.skills.remoteConfigureBtn}</span>
            </button>
          )}
        </div>
      </header>

      {skillTab === 'local' ? (
        <div key="local-tab" className="tab-content-pane">
          {skills.length > 0 ? (
            <>
              {/* Filter Toolbar: Search, Pins, and AI Tool Category Segmented Filter */}
              <div className="filter-toolbar-row stagger-item">
                <label className="search-capsule-box">
                  <Search size={14} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t.skills.searchPlaceholder}
                  />
                  {query ? (
                    <button type="button" className="clear-search-btn" onClick={() => setQuery('')}>
                      <X size={13} />
                    </button>
                  ) : null}
                </label>

                {/* Flat Category Switcher */}
                <div className="flat-segmented-filter">
                  <button
                    type="button"
                    className={`filter-pill-tab ${filterMode === 'all' ? 'is-active' : ''}`}
                    onClick={() => setFilterMode('all')}
                  >
                    <span>{t.skills.allSection}</span>
                    <span className="filter-count-badge font-mono">{skills.length}</span>
                  </button>
                  <button
                    type="button"
                    className={`filter-pill-tab ${filterMode === 'pinned' ? 'is-active' : ''}`}
                    onClick={() => setFilterMode('pinned')}
                  >
                    <Bookmark size={12} className="filter-pin-icon" />
                    <span>{t.skills.pinnedSection}</span>
                    <span className="filter-count-badge font-mono">{pinnedCount}</span>
                  </button>
                </div>
              </div>

              {/* AI Tool Category Rail & Quick Tool Filter Pills */}
              <div className="ai-tool-filter-rail stagger-item">
                <div className="category-capsule-tabs">
                  <button
                    type="button"
                    className={`cat-pill-btn ${categoryFilter === 'all' ? 'is-active' : ''}`}
                    onClick={() => {
                      setCategoryFilter('all')
                      setSelectedToolFilter('all')
                    }}
                  >
                    <span>{t.skills.categoryAll}</span>
                    <span className="cat-count-badge font-mono">{categoryCounts.all}</span>
                  </button>
                  <button
                    type="button"
                    className={`cat-pill-btn ${categoryFilter === 'ide' ? 'is-active' : ''}`}
                    onClick={() => {
                      setCategoryFilter('ide')
                      setSelectedToolFilter('all')
                    }}
                  >
                    <span>{t.skills.categoryIde}</span>
                    <span className="cat-count-badge font-mono">{categoryCounts.ide}</span>
                  </button>
                  <button
                    type="button"
                    className={`cat-pill-btn ${categoryFilter === 'cli' ? 'is-active' : ''}`}
                    onClick={() => {
                      setCategoryFilter('cli')
                      setSelectedToolFilter('all')
                    }}
                  >
                    <span>{t.skills.categoryCli}</span>
                    <span className="cat-count-badge font-mono">{categoryCounts.cli}</span>
                  </button>
                  <button
                    type="button"
                    className={`cat-pill-btn ${categoryFilter === 'extension' ? 'is-active' : ''}`}
                    onClick={() => {
                      setCategoryFilter('extension')
                      setSelectedToolFilter('all')
                    }}
                  >
                    <span>{t.skills.categoryExtension}</span>
                    <span className="cat-count-badge font-mono">{categoryCounts.extension}</span>
                  </button>
                  <button
                    type="button"
                    className={`cat-pill-btn ${categoryFilter === 'standard' ? 'is-active' : ''}`}
                    onClick={() => {
                      setCategoryFilter('standard')
                      setSelectedToolFilter('all')
                    }}
                  >
                    <span>{t.skills.categoryStandard}</span>
                    <span className="cat-count-badge font-mono">{categoryCounts.standard}</span>
                  </button>
                </div>

                {/* Secondary Quick Filter: Specific AI Tools Chips */}
                <div className="tool-quick-filter-chips">
                  <button
                    type="button"
                    className={`tool-filter-chip ${selectedToolFilter === 'all' ? 'is-active' : ''}`}
                    onClick={() => setSelectedToolFilter('all')}
                  >
                    <span>{t.skills.allToolsFilter}</span>
                  </button>
                  {aiTools
                    .filter((tool) => categoryFilter === 'all' || tool.category === categoryFilter)
                    .map((tool) => {
                      const count = skills.filter((s) => s.targetTools?.includes(tool.id)).length
                      const isSelected = selectedToolFilter === tool.id
                      return (
                        <button
                          key={tool.id}
                          type="button"
                          className={`tool-filter-chip ${isSelected ? 'is-active' : ''} ${tool.installed ? 'is-installed' : ''}`}
                          onClick={() => setSelectedToolFilter(isSelected ? 'all' : tool.id)}
                        >
                          <AIToolLogo toolId={tool.id} size={12} color={isSelected} />
                          <span>{tool.name}</span>
                          <span className="tool-chip-count font-mono">{count}</span>
                        </button>
                      )
                    })}
                </div>
              </div>

              {/* Local Skills List Container */}
              {filteredSkills.length > 0 ? (
                <div className="flat-table-wrap stagger-item">
                  <div className="flat-rows-list">
                    {filteredSkills.map((sk, idx) => (
                      <div
                        key={sk.id}
                        className="flat-row skill-distribution-row"
                        style={{ animationDelay: `${idx * 20}ms` }}
                        onClick={() => setDrawerSkill(sk)}
                        role="button"
                        tabIndex={0}
                      >
                        {/* Left: Metadata */}
                        <div className="flat-row__left">
                          <div className="flat-title-row">
                            {sk.pinned ? <Bookmark size={13} className="flat-pinned-icon" /> : null}
                            <strong className="flat-row-title">{sk.name}</strong>
                            {sk.tags?.slice(0, 2).map((tag) => (
                              <span key={tag} className="skill-tag-pill font-mono">
                                #{tag}
                              </span>
                            ))}
                          </div>
                          <span className="flat-row-desc">{sk.description}</span>
                          {sk.triggers && sk.triggers.length > 0 ? (
                            <div className="skill-triggers-row">
                              {sk.triggers.map((trig) => (
                                <span key={trig} className="skill-trigger-chip font-mono">
                                  {trig}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        {/* Middle: Live Distribution Capsule Pills Matrix */}
                        <div className="flat-row__middle">
                          <div className="target-capsules-group">
                            {aiTools
                              .filter((tool) => categoryFilter === 'all' || tool.category === categoryFilter)
                              .slice(0, 5)
                              .map((tool) => {
                                const isLinked = Boolean(sk.targetTools?.includes(tool.id))
                                return (
                                  <AIToolTargetPill
                                    key={tool.id}
                                    tool={tool}
                                    isLinked={isLinked}
                                    title={
                                      isLinked
                                        ? t.skills.linkedTooltip(tool.name, tool.detectedPath || tool.defaultDir)
                                        : t.skills.unlinkedTooltip(tool.name)
                                    }
                                    onClick={() => void onToggleLinkTarget(sk, tool.id)}
                                  />
                                )
                              })}
                            {aiTools.length > 5 && categoryFilter === 'all' ? (
                              <button
                                type="button"
                                className="target-capsule-more font-mono"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDrawerSkill(sk)
                                }}
                              >
                                +{aiTools.length - 5}
                              </button>
                            ) : null}
                          </div>
                          <WorkflowGraph workflow={sk.workflow} compact />
                        </div>

                        {/* Right: Meta, Actions, and Chevron */}
                        <div className="flat-row__right">
                          <span className="flat-row-meta font-mono">{sk.updatedLabel}</span>
                          <span className="pinned-ver-pill font-mono">{t.skills.versionPrefix}{sk.versions}.0</span>
                          <button
                            type="button"
                            className="row-action-icon-btn"
                            title="配置分发与规则"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDrawerSkill(sk)
                            }}
                          >
                            <MoreHorizontal size={15} />
                          </button>
                          <div className="row-chevron-indicator">
                            <ChevronRight size={14} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                /* Zero-Card Clean Empty Search State */
                <div className="clean-empty-state stagger-item">
                  <div className="empty-icon-halo">
                    <Search size={26} className="empty-icon-glow" />
                  </div>
                  <h3 className="empty-title">{t.skills.emptySearch}</h3>
                  <p className="empty-desc">{t.skills.emptySearchDesc(query)}</p>
                  <div className="empty-state-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--capsule"
                      onClick={() => {
                        setQuery('')
                        setCategoryFilter('all')
                        setSelectedToolFilter('all')
                      }}
                    >
                      <X size={13} />
                      <span>{t.skills.clearSearchBtn}</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Zero-Card Clean Empty Local Skills State */
            <div className="clean-empty-state stagger-item">
              <div className="empty-icon-halo">
                <Boxes size={30} className="empty-icon-glow" />
              </div>
              <h3 className="empty-title">{t.skills.emptyLocalTitle}</h3>
              <p className="empty-desc">{t.skills.emptyLocalDesc}</p>
              <div className="empty-state-actions">
                <button type="button" className="btn btn--primary btn--capsule" onClick={onNewSkill}>
                  <Plus size={13} />
                  <span>{t.skills.newSkill}</span>
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--capsule"
                  onClick={handleOpenLocalDir}
                >
                  <FolderOpen size={13} />
                  <span>{t.skills.openLocalDirBtn}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div key="remote-tab" className="tab-content-pane">
          {/* Zero-Card Clean Empty Remote Skills State */}
          <div className="clean-empty-state stagger-item">
            <div className="empty-icon-halo">
              <Globe size={30} className="empty-icon-glow" />
            </div>
            <h3 className="empty-title">{t.skills.emptyRemoteTitle}</h3>
            <p className="empty-desc">{t.skills.emptyRemoteDesc}</p>
            <div className="empty-state-actions">
              <button
                type="button"
                className="btn btn--secondary btn--capsule"
                onClick={() => notify?.(t.skills.remoteComingSoonToast)}
              >
                <Sliders size={13} />
                <span>{t.skills.remoteConfigureBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule-ghost btn--capsule"
                onClick={() => notify?.(t.skills.remoteComingSoonToast)}
              >
                <ExternalLink size={13} />
                <span>{t.skills.remoteDocsBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-over Skill Detail & Distribution Matrix Drawer */}
      <SkillDetailDrawer
        skill={drawerSkill}
        aiTools={aiTools}
        open={Boolean(drawerSkill)}
        onClose={() => setDrawerSkill(null)}
        onToggleLink={onToggleLinkTarget}
        onDeleteRequest={(sk) => {
          setDrawerSkill(null)
          setDeleteModalSkill(sk)
        }}
        notify={notify}
      />

      {/* Safe Delete Modal with Explicit Downstream Links List */}
      <SafeDeleteSkillModal
        skill={deleteModalSkill}
        aiTools={aiTools}
        open={Boolean(deleteModalSkill)}
        onClose={() => setDeleteModalSkill(null)}
        onConfirm={onDeleteSkill}
      />
    </div>
  )
}

/* =========================================================================
   AI Environments Hub & Tool Distribution Management Page
   ========================================================================= */
function AIEnvironmentsPage({
  aiTools,
  skills,
  onDetectTools,
  onToggleLinkTarget,
  onBulkLink,
  onBulkUnlink,
  notify,
}: {
  aiTools: AIToolTarget[]
  skills: Skill[]
  onDetectTools: () => void
  onToggleLinkTarget: (skill: Skill, targetId: string) => Promise<void>
  onBulkLink: (targetId: string) => Promise<void>
  onBulkUnlink: (targetId: string) => Promise<void>
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()
  const [categoryFilter, setCategoryFilter] = useState<AIToolCategory>('all')
  const [query, setQuery] = useState('')

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase()
    return aiTools.filter((tool) => {
      if (categoryFilter !== 'all' && tool.category !== categoryFilter) return false
      if (!q) return true
      const searchStr = `${tool.name} ${tool.description || ''} ${tool.defaultDir} ${tool.category}`.toLowerCase()
      return searchStr.includes(q)
    })
  }, [aiTools, categoryFilter, query])

  const installedCount = useMemo(() => aiTools.filter((t) => t.installed).length, [aiTools])

  const totalActiveLinks = useMemo(() => {
    return skills.reduce((acc, sk) => acc + (sk.targetTools?.length || 0), 0)
  }, [skills])

  const handleOpenToolDir = (tool: AIToolTarget) => {
    const targetPath = tool.detectedPath || tool.defaultDir
    if (window.workflowSkill?.openPathInFinder) {
      void window.workflowSkill.openPathInFinder(targetPath)
    }
  }

  const handleOpenCentralStore = () => {
    if (window.workflowSkill?.getStoragePath && window.workflowSkill?.openPathInFinder) {
      window.workflowSkill
        .getStoragePath()
        .then((root) => {
          void window.workflowSkill?.openPathInFinder?.(`${root}/skills`)
        })
        .catch(() => {})
    }
  }

  return (
    <div className="clean-page view-enter">
      {/* Header */}
      <header className="page-header stagger-item">
        <div className="page-header__left">
          <h1 className="page-title">{t.environments.title}</h1>
          <span className="page-subtitle">{t.environments.subtitle}</span>
        </div>

        <div className="page-header__right">
          <button
            type="button"
            className="btn btn--secondary btn--capsule"
            onClick={onDetectTools}
            title={t.environments.rescanBtn}
          >
            <Sparkles size={13} className="sparkle-active-icon" />
            <span>{t.environments.rescanBtn}</span>
          </button>
          <button
            type="button"
            className="btn btn--capsule-ghost btn--capsule"
            onClick={handleOpenCentralStore}
          >
            <FolderOpen size={13} />
            <span>中央仓库</span>
          </button>
        </div>
      </header>

      {/* Hero Metric Cards */}
      <div className="env-hero-metrics-grid stagger-item">
        <div className="env-metric-card">
          <span className="env-metric-label">{t.environments.metricSupported}</span>
          <div className="env-metric-value-row">
            <span className="env-metric-num font-mono">{aiTools.length}</span>
            <span className="env-metric-unit">大主流环境</span>
          </div>
          <span className="env-metric-hint">AI IDE、终端 Agent、插件扩展与开放标准</span>
        </div>

        <div className="env-metric-card">
          <span className="env-metric-label">{t.environments.metricInstalled}</span>
          <div className="env-metric-value-row">
            <span className="env-metric-num font-mono is-green">{installedCount}</span>
            <span className="env-metric-unit">个本地已就绪</span>
          </div>
          <span className="env-metric-hint">已自动感知配置目录与技能路径</span>
        </div>

        <div className="env-metric-card">
          <span className="env-metric-label">{t.environments.metricLinks}</span>
          <div className="env-metric-value-row">
            <span className="env-metric-num font-mono is-accent">{totalActiveLinks}</span>
            <span className="env-metric-unit">处实时挂载</span>
          </div>
          <span className="env-metric-hint">NTFS Junction / Symlink 物理软链分发</span>
        </div>
      </div>

      {/* Filter Toolbar: Search & Categories */}
      <div className="filter-toolbar-row stagger-item">
        <label className="search-capsule-box">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 AI 环境名称、目录或分类…"
          />
          {query ? (
            <button type="button" className="clear-search-btn" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          ) : null}
        </label>

        {/* Category Segmented Tabs */}
        <div className="category-capsule-tabs">
          <button
            type="button"
            className={`cat-pill-btn ${categoryFilter === 'all' ? 'is-active' : ''}`}
            onClick={() => setCategoryFilter('all')}
          >
            <span>{t.skills.categoryAll}</span>
            <span className="cat-count-badge font-mono">{aiTools.length}</span>
          </button>
          <button
            type="button"
            className={`cat-pill-btn ${categoryFilter === 'ide' ? 'is-active' : ''}`}
            onClick={() => setCategoryFilter('ide')}
          >
            <span>{t.skills.categoryIde}</span>
            <span className="cat-count-badge font-mono">
              {aiTools.filter((t) => t.category === 'ide').length}
            </span>
          </button>
          <button
            type="button"
            className={`cat-pill-btn ${categoryFilter === 'cli' ? 'is-active' : ''}`}
            onClick={() => setCategoryFilter('cli')}
          >
            <span>{t.skills.categoryCli}</span>
            <span className="cat-count-badge font-mono">
              {aiTools.filter((t) => t.category === 'cli').length}
            </span>
          </button>
          <button
            type="button"
            className={`cat-pill-btn ${categoryFilter === 'extension' ? 'is-active' : ''}`}
            onClick={() => setCategoryFilter('extension')}
          >
            <span>{t.skills.categoryExtension}</span>
            <span className="cat-count-badge font-mono">
              {aiTools.filter((t) => t.category === 'extension').length}
            </span>
          </button>
          <button
            type="button"
            className={`cat-pill-btn ${categoryFilter === 'standard' ? 'is-active' : ''}`}
            onClick={() => setCategoryFilter('standard')}
          >
            <span>{t.skills.categoryStandard}</span>
            <span className="cat-count-badge font-mono">
              {aiTools.filter((t) => t.category === 'standard').length}
            </span>
          </button>
        </div>
      </div>

      {/* Environments Grid List */}
      <div className="env-cards-grid stagger-item">
        {filteredTools.map((tool, idx) => {
          const mountedSkills = skills.filter((s) => s.targetTools?.includes(tool.id))
          const isAllMounted = mountedSkills.length === skills.length && skills.length > 0
          return (
            <div
              key={tool.id}
              className={`env-card ${tool.installed ? 'is-installed' : ''}`}
              style={{ animationDelay: `${idx * 25}ms` }}
            >
              {/* Card Header: LobeHub Official Logo + Titles + Badges */}
              <div className="env-card-header">
                <div className="env-logo-wrap">
                  <AIToolLogo toolId={tool.id} size={36} color />
                </div>
                <div className="env-title-meta">
                  <div className="env-title-row">
                    <h3 className="env-tool-name">{tool.name}</h3>
                    <span className="env-cat-badge">{tool.category.toUpperCase()}</span>
                  </div>
                  <span className={`env-status-pill ${tool.installed ? 'is-ready' : 'is-unready'}`}>
                    <span className="env-status-dot" />
                    <span>{tool.installed ? t.environments.installedReady : t.environments.notDetected}</span>
                  </span>
                </div>
              </div>

              {/* Description */}
              <p className="env-desc">{tool.description}</p>

              {/* Directory Path */}
              <div className="env-path-box">
                <div className="env-path-text font-mono" title={tool.detectedPath || tool.defaultDir}>
                  <Folder size={12} className="env-path-icon" />
                  <span>{tool.detectedPath || tool.defaultDir}</span>
                </div>
                <button
                  type="button"
                  className="env-path-open-btn"
                  title={t.environments.openDirBtn}
                  onClick={() => handleOpenToolDir(tool)}
                >
                  <ExternalLink size={12} />
                </button>
              </div>

              {/* Mounted Skills Summary & Chips */}
              <div className="env-mounted-section">
                <div className="env-mounted-header">
                  <span className="env-mounted-title">
                    {t.environments.mountedSkillsLabel(mountedSkills.length)}
                  </span>
                  <span className="env-mounted-ratio font-mono">
                    {mountedSkills.length}/{skills.length}
                  </span>
                </div>

                <div className="env-skill-chips-wrap">
                  {mountedSkills.length > 0 ? (
                    mountedSkills.map((sk) => (
                      <button
                        key={sk.id}
                        type="button"
                        className="env-skill-chip is-linked"
                        title="点击解除此 Skill 软链接"
                        onClick={() => void onToggleLinkTarget(sk, tool.id)}
                      >
                        <Link2 size={10} className="env-chip-link-icon" />
                        <span>{sk.name}</span>
                        <X size={10} className="env-chip-unlink-icon" />
                      </button>
                    ))
                  ) : (
                    <span className="env-no-skills-hint">{t.environments.noMountedSkills}</span>
                  )}
                </div>
              </div>

              {/* Card Footer Actions */}
              <div className="env-card-footer">
                {isAllMounted ? (
                  <button
                    type="button"
                    className="btn btn--secondary btn--capsule btn--sm"
                    onClick={() => void onBulkUnlink(tool.id)}
                  >
                    <Unlink size={12} />
                    <span>{t.environments.unlinkAllFromTargetBtn}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary btn--capsule btn--sm"
                    onClick={() => void onBulkLink(tool.id)}
                  >
                    <Link2 size={12} />
                    <span>{t.environments.syncAllToTargetBtn}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn--capsule-ghost btn--capsule btn--sm"
                  onClick={() => handleOpenToolDir(tool)}
                >
                  <FolderOpen size={12} />
                  <span>打开目录</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
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
      <section className="detail-glass-stage">
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
    id: 'new_skill',
    groupId: 'global',
    titleKey: 'shortcutNewSkillTitle',
    descKey: 'shortcutNewSkillDesc',
    defaultKey: '⇧⌘N',
  },
  {
    id: 'search_filter',
    groupId: 'global',
    titleKey: 'shortcutSearchTitle',
    descKey: 'shortcutSearchDesc',
    defaultKey: '⌘F',
  },
  {
    id: 'escape_back',
    groupId: 'global',
    titleKey: 'shortcutEscTitle',
    descKey: 'shortcutEscDesc',
    defaultKey: 'ESC',
  },
  {
    id: 'toggle_observe',
    groupId: 'engine',
    titleKey: 'shortcutToggleObserveTitle',
    descKey: 'shortcutToggleObserveDesc',
    defaultKey: '⌥⌘P',
  },
  {
    id: 'save_skill',
    groupId: 'engine',
    titleKey: 'shortcutSaveSkillTitle',
    descKey: 'shortcutSaveSkillDesc',
    defaultKey: '⌘S',
  },
  {
    id: 'export_code',
    groupId: 'engine',
    titleKey: 'shortcutExportCodeTitle',
    descKey: 'shortcutExportCodeDesc',
    defaultKey: '⇧⌘E',
  },
  {
    id: 'nav_skills',
    groupId: 'nav',
    titleKey: 'shortcutSkillsNavTitle',
    descKey: 'shortcutSkillsNavDesc',
    defaultKey: '⌘1',
  },
  {
    id: 'nav_workflows',
    groupId: 'nav',
    titleKey: 'shortcutWorkflowsNavTitle',
    descKey: 'shortcutWorkflowsNavDesc',
    defaultKey: '⌘2',
  },
  {
    id: 'nav_settings',
    groupId: 'nav',
    titleKey: 'shortcutSettingsNavTitle',
    descKey: 'shortcutSettingsNavDesc',
    defaultKey: '⌘,',
  },
]

function formatKeyboardEvent(e: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(e.key)) {
    return null
  }

  const parts: string[] = []
  if (e.ctrlKey) parts.push('⌃')
  if (e.altKey) parts.push('⌥')
  if (e.shiftKey) parts.push('⇧')
  if (e.metaKey) parts.push('⌘')

  let keyName = e.key.toUpperCase()
  if (e.key === 'Escape') keyName = 'ESC'
  else if (e.key === 'Enter') keyName = '↵'
  else if (e.key === 'Backspace') keyName = '⌫'
  else if (e.key === 'Tab') keyName = '⇥'
  else if (e.key === 'ArrowUp') keyName = '↑'
  else if (e.key === 'ArrowDown') keyName = '↓'
  else if (e.key === 'ArrowLeft') keyName = '←'
  else if (e.key === 'ArrowRight') keyName = '→'
  else if (e.key === ' ') keyName = 'SPACE'

  if (
    parts.length === 0 &&
    !['ESC', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].includes(
      keyName,
    )
  ) {
    return null
  }

  return `${parts.join('')}${keyName}`
}

function KeyboardShortcutsSection({ onShowToast }: { onShowToast?: (msg: string) => void }) {
  const { t } = useI18n()
  const [customShortcuts, setCustomShortcuts] = useState<Record<string, string>>(() => {
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem('trace_shortcuts_v1')
        if (saved) return JSON.parse(saved)
      } catch {}
    }
    return {}
  })
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const getShortcutKey = (def: ShortcutConfig) => {
    if (customShortcuts[def.id] !== undefined) {
      return customShortcuts[def.id]
    }
    return def.defaultKey
  }

  const handleClear = (id: string) => {
    const next = { ...customShortcuts, [id]: '' }
    setCustomShortcuts(next)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('trace_shortcuts_v1', JSON.stringify(next))
    }
    onShowToast?.(t.settings.shortcutUpdatedToast)
  }

  const handleResetDefaults = () => {
    setCustomShortcuts({})
    setRecordingId(null)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('trace_shortcuts_v1')
    }
    onShowToast?.(t.settings.shortcutResetToast)
  }

  useEffect(() => {
    if (!recordingId) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecordingId(null)
        return
      }

      const combo = formatKeyboardEvent(e)
      if (combo) {
        const next = { ...customShortcuts, [recordingId]: combo }
        setCustomShortcuts(next)
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('trace_shortcuts_v1', JSON.stringify(next))
        }
        setRecordingId(null)
        onShowToast?.(`${combo} · ${t.settings.shortcutUpdatedToast}`)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingId, customShortcuts, t, onShowToast])

  const groups = [
    { id: 'global' as const, label: t.settings.shortcutsGroupGlobal },
    { id: 'engine' as const, label: t.settings.shortcutsGroupEngine },
    { id: 'nav' as const, label: t.settings.shortcutsGroupNav },
  ]

  return (
    <>
      <header className="page-header stagger-item">
        <div className="page-header__left">
          <h1 className="page-title">{t.settings.shortcutsTab}</h1>
          <span className="page-subtitle">{t.settings.shortcutsSub}</span>
        </div>
        <div className="page-header__right">
          <button
            type="button"
            className="btn btn--capsule btn--secondary btn--sm"
            onClick={handleResetDefaults}
          >
            <RotateCcw size={12} />
            <span>{t.settings.resetShortcutsBtn}</span>
          </button>
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
                const keyCombo = getShortcutKey(item)
                const isRecording = recordingId === item.id
                const title = t.settings[item.titleKey] as string
                const desc = t.settings[item.descKey] as string

                return (
                  <div key={item.id} className="flat-shortcut-row">
                    <div className="flat-shortcut-info">
                      <strong className="flat-shortcut-title">{title}</strong>
                      <p className="flat-shortcut-desc">{desc}</p>
                    </div>

                    <div className="flat-shortcut-controls">
                      <div className="shortcut-key-action-pair">
                        {isRecording ? (
                          <div className="shortcut-recording-badge font-mono">
                            <span className="recording-pulse-dot" />
                            <span>{t.settings.recordingShortcut}</span>
                          </div>
                        ) : (
                          <div className="shortcut-pill-wrap">
                            {keyCombo ? (
                              <kbd className="shortcut-key-badge font-mono">{keyCombo}</kbd>
                            ) : (
                              <span className="shortcut-unassigned-text font-mono">
                                {t.settings.unassignedShortcut}
                              </span>
                            )}
                          </div>
                        )}

                        <button
                          type="button"
                          className={`shortcut-action-icon-btn ${isRecording ? 'is-active' : ''}`}
                          title={t.settings.editShortcutTooltip}
                          onClick={() => setRecordingId(isRecording ? null : item.id)}
                          aria-label={t.settings.editShortcutTooltip}
                        >
                          <Pencil size={13} />
                        </button>
                      </div>

                      <div className="shortcut-delete-action">
                        <button
                          type="button"
                          className="shortcut-action-icon-btn"
                          title={t.settings.clearShortcutTooltip}
                          onClick={() => handleClear(item.id)}
                          disabled={!keyCombo || isRecording}
                          aria-label={t.settings.clearShortcutTooltip}
                        >
                          <Trash2 size={13} />
                        </button>
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
}) {
  const { t, locale, setLocale, resolvedLocale } = useI18n()
  const [storagePath, setStoragePath] = useState<string>('')

  useEffect(() => {
    let active = true
    if (window.workflowSkill?.getStoragePath) {
      window.workflowSkill.getStoragePath().then((p) => {
        if (active) setStoragePath(p)
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

          {/* Unified Flat Settings Group (Zero Nested Cards) */}
          <div className="flat-settings-card stagger-item">
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

            {/* Row 3: Local Data Storage Path */}
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
          </div>
        </>
      ) : null}

      {tab === 'shortcuts' ? (
        <KeyboardShortcutsSection onShowToast={onShowToast} />
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
                            className="btn btn--capsule btn--primary btn--sm"
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
                            className="btn btn--capsule btn--primary btn--sm"
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
                <span className="status-badge-ok font-mono">{t.settings.aboutReleaseBadge}</span>
              </div>
              <span className="about-sub font-mono">{t.settings.aboutBuild}</span>
              <p className="about-manifesto">{t.settings.aboutManifesto}</p>
            </div>
          </div>
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
        id: 'view-environments',
        label: '切换至 AI 环境生态',
        hint: 'G E',
        run: () => onSelectView('environments'),
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
    <div className="modal-glass-backdrop" onMouseDown={onClose}>
      <div
        className="command-glass-box modal-pop"
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
    <div className="modal-glass-backdrop" onMouseDown={onClose}>
      <div
        className="glass-dialog-box modal-pop"
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

        <div className="code-glass-frame">
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
}: {
  open: boolean
  onClose: () => void
  onCreate: (name: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName('')
      window.setTimeout(() => inputRef.current?.focus(), 40)
    }
  }, [open])

  if (!open) return null

  return (
    <div className="modal-glass-backdrop" onMouseDown={onClose}>
      <form
        className="glass-dialog-box glass-dialog-box--small modal-pop"
        onSubmit={(e) => {
          e.preventDefault()
          const finalName = name.trim() || t.skills.newSkill
          onCreate(finalName)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header-row">
          <div>
            <h2>{t.skills.createDialogTitle}</h2>
            <p>{t.skills.createDialogDesc}</p>
          </div>
          <button type="button" className="dialog-close-btn" onClick={onClose} aria-label={t.skills.cancelBtn}>
            <X size={15} />
          </button>
        </div>

        <div className="dialog-input-area">
          <label>
            <span>{t.skills.skillNameLabel}</span>
            <input
              ref={inputRef}
              className="dialog-capsule-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.skills.skillNamePlaceholder}
            />
          </label>
        </div>

        <div className="dialog-footer-row">
          <button type="button" className="btn btn--capsule btn--secondary" onClick={onClose}>
            {t.skills.cancelBtn}
          </button>
          <button type="submit" className="btn btn--capsule btn--primary">
            {t.skills.confirmCreateBtn}
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

/* =========================================================================
   Main App Root
   ========================================================================= */
export function App() {
  const { t } = useI18n()
  const stageRef = useRef<HTMLDivElement>(null)
  const autoStartRequestedRef = useRef(false)
  const [view, setView] = useState<View>('skills')
  const [inSettings, setInSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>('dark')
  const [observing, setObserving] = useState(true)
  const [commandOpen, setCommandOpen] = useState(false)
  const [newSkillOpen, setNewSkillOpen] = useState(false)
  const [exportState, setExportState] = useState<{
    open: boolean
    skillName: string
    workflow: Workflow | null
  }>({ open: false, skillName: '', workflow: null })

  // Real Dynamic Skills & Discoveries in State (Zero Fake Data)
  const [skills, setSkills] = useState<Skill[]>([])
  const [discoveries, setDiscoveries] = useState<Workflow[]>([])
  const [aiTools, setAiTools] = useState<AIToolTarget[]>(DEFAULT_AI_TOOLS)

  const handleDetectTools = () => {
    if (window.workflowSkill?.getAITools) {
      window.workflowSkill
        .getAITools()
        .then((detected) => {
          if (Array.isArray(detected) && detected.length > 0) {
            setAiTools(detected)
            const installedCount = detected.filter((t) => t.installed).length
            setToast(t.skills.detectToolsToast(installedCount))
          }
        })
        .catch(() => {})
    } else {
      setToast(t.skills.detectToolsToast(DEFAULT_AI_TOOLS.length))
    }
  }

  useEffect(() => {
    let active = true
    if (window.workflowSkill?.getAITools) {
      window.workflowSkill
        .getAITools()
        .then((detected) => {
          if (active && Array.isArray(detected) && detected.length > 0) {
            setAiTools(detected)
          }
        })
        .catch(() => {})
    }
    if (window.workflowSkill?.loadLocalSkills) {
      window.workflowSkill
        .loadLocalSkills()
        .then((loaded) => {
          if (active && Array.isArray(loaded)) {
            if (loaded.length > 0) {
              setSkills(loaded)
            } else {
              // Seed demo skills with rich target tools data
              setSkills(demoSkills)
              for (const ds of demoSkills) {
                void window.workflowSkill?.saveLocalSkill?.(ds)
              }
            }
          }
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [])

  const handleToggleLinkTarget = async (skill: Skill, targetId: string) => {
    const isCurrentlyLinked = Boolean(skill.targetTools?.includes(targetId))
    const tool = aiTools.find((t) => t.id === targetId) || DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
    const toolName = tool?.name || targetId

    if (isCurrentlyLinked) {
      if (window.workflowSkill?.unlinkSkillTarget) {
        await window.workflowSkill.unlinkSkillTarget(skill.id, targetId)
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id
            ? { ...s, targetTools: (s.targetTools || []).filter((id) => id !== targetId) }
            : s,
        ),
      )
      setToast(t.skills.unlinkedSuccessToast(skill.name, toolName))
    } else {
      if (window.workflowSkill?.linkSkillTarget) {
        await window.workflowSkill.linkSkillTarget(skill.id, targetId)
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id
            ? { ...s, targetTools: Array.from(new Set([...(s.targetTools || []), targetId])) }
            : s,
        ),
      )
      setToast(t.skills.linkedSuccessToast(skill.name, toolName))
    }
  }

  const handleDeleteSkillCompletely = async (skill: Skill) => {
    if (window.workflowSkill?.deleteSkillCompletely) {
      await window.workflowSkill.deleteSkillCompletely(skill.id)
    } else if (window.workflowSkill?.deleteLocalSkill) {
      await window.workflowSkill.deleteLocalSkill(skill.id)
    }
    setSkills((prev) => prev.filter((s) => s.id !== skill.id))
    if (activeDetail?.skill?.id === skill.id) {
      setActiveDetail(null)
    }
    setToast(`已彻底删除 “${skill.name}”`)
  }

  const handleBulkLinkToTarget = async (targetId: string) => {
    const tool = aiTools.find((t) => t.id === targetId) || DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
    const toolName = tool?.name || targetId

    if (window.workflowSkill?.linkAllSkillsToTarget) {
      const res = await window.workflowSkill.linkAllSkillsToTarget(targetId)
      if (res.success) {
        setSkills((prev) =>
          prev.map((s) => ({
            ...s,
            targetTools: Array.from(new Set([...(s.targetTools || []), targetId])),
          })),
        )
        setToast(t.environments.bulkLinkSuccessToast(res.count, toolName))
      }
    } else {
      setSkills((prev) =>
        prev.map((s) => ({
          ...s,
          targetTools: Array.from(new Set([...(s.targetTools || []), targetId])),
        })),
      )
      setToast(t.environments.bulkLinkSuccessToast(skills.length, toolName))
    }
  }

  const handleBulkUnlinkFromTarget = async (targetId: string) => {
    const tool = aiTools.find((t) => t.id === targetId) || DEFAULT_AI_TOOLS.find((t) => t.id === targetId)
    const toolName = tool?.name || targetId

    if (window.workflowSkill?.unlinkAllSkillsFromTarget) {
      const res = await window.workflowSkill.unlinkAllSkillsFromTarget(targetId)
      if (res.success) {
        setSkills((prev) =>
          prev.map((s) => ({
            ...s,
            targetTools: (s.targetTools || []).filter((id) => id !== targetId),
          })),
        )
        setToast(t.environments.bulkUnlinkSuccessToast(res.count, toolName))
      }
    } else {
      setSkills((prev) =>
        prev.map((s) => ({
          ...s,
          targetTools: (s.targetTools || []).filter((id) => id !== targetId),
        })),
      )
      setToast(t.environments.bulkUnlinkSuccessToast(skills.length, toolName))
    }
  }

  // Active Level-2 Workflow Detail State
  const [activeDetail, setActiveDetail] = useState<ActiveDetailState | null>(null)

  // Track saved workflow states
  const [savedWorkflowIds, setSavedWorkflowIds] = useState<Record<string, boolean>>({})

  const [toast, setToast] = useState('')
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>()
  const [recentEvents, setRecentEvents] = useState<CaptureEvent[]>([])

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
    api
      .getRecorderStatus()
      .then((status) => {
        if (!mounted) return
        setRecorderStatus(status)
        setObserving(status.state === 'observing')
        if (
          status.permissions.screenRecording &&
          status.permissions.accessibility &&
          status.state === 'idle' &&
          !autoStartRequestedRef.current
        ) {
          autoStartRequestedRef.current = true
          void api.sendRecorderCommand({ type: 'start', sessionId: crypto.randomUUID() })
        } else {
          void api.sendRecorderCommand({ type: 'status' })
        }
      })
      .catch(() => setToast(t.toast.nativeNotReady))

    const unsubscribe = api.onRecorderMessage((message: RecorderEnvelope) => {
      if (message.type === 'status') {
        setRecorderStatus(message.payload)
        setObserving(message.payload.state === 'observing')
        if (
          message.payload.permissions.screenRecording &&
          message.payload.permissions.accessibility &&
          message.payload.state === 'idle' &&
          !autoStartRequestedRef.current
        ) {
          autoStartRequestedRef.current = true
          void api.sendRecorderCommand({ type: 'start', sessionId: crypto.randomUUID() })
        }
      } else if (message.type === 'capture-event') {
        setRecentEvents((events) => [message.payload, ...events].slice(0, 20))
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
    return () => {
      mounted = false
      unsubscribe()
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
  }, [commandOpen, exportState.open, newSkillOpen, activeDetail, inSettings])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const toggleObserving = () => {
    const api = window.workflowSkill
    if (!api) {
      setObserving((v) => !v)
      setToast(observing ? t.toast.observePaused : t.toast.observeResumed)
      return
    }
    if (observing) {
      void api.sendRecorderCommand({ type: 'pause' })
    } else {
      void api.sendRecorderCommand({ type: 'resume' })
    }
  }

  const handleSaveWorkflow = (wf: Workflow) => {
    setSavedWorkflowIds((prev) => ({ ...prev, [wf.id]: true }))

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
      updatedLabel: '刚刚',
    }

    setSkills((prev) => {
      const existing = prev.find((s) => s.id === wf.id)
      if (existing) return prev
      return [newSk, ...prev]
    })

    if (window.workflowSkill?.saveLocalSkill) {
      void window.workflowSkill.saveLocalSkill(newSk)
    }

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
    <div className="app-shell" data-theme={resolvedTheme}>
      {/* Global Top Window Drag Strip for macOS */}
      <div className="app-window-drag-strip" />

      {/* Dynamic Sidebar Rail: App Navigation vs Settings Mode */}
      <AppSidebar
        view={view}
        setView={setView}
        inSettings={inSettings}
        settingsTab={settingsTab}
        setSettingsTab={setSettingsTab}
        onEnterSettings={() => {
          setActiveDetail(null)
          setSettingsTab('general')
          setInSettings(true)
        }}
        onExitSettings={() => setInSettings(false)}
        onBackToOverview={() => setActiveDetail(null)}
      />

      {/* Floating Liquid Glass Main Canvas Stage */}
      <main className="app-main-stage" ref={stageRef}>
        {inSettings ? (
          /* Dedicated Settings Main Content View */
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
          />
        ) : activeDetail ? (
          /* Level 2 Dedicated Workflow Detail Page */
          <WorkflowDetailPage
            detailState={activeDetail}
            isSaved={Boolean(savedWorkflowIds[activeDetail.workflow.id])}
            onBack={() => setActiveDetail(null)}
            onSaveSkill={handleSaveWorkflow}
            onExportCode={(wf, name) => setExportState({ open: true, skillName: name, workflow: wf })}
            notify={setToast}
          />
        ) : (
          /* Level 1 Overview Pages */
          <>
            {view === 'skills' ? (
              <SkillsOverviewPage
                skills={skills}
                aiTools={aiTools}
                onOpenDetail={(skill) =>
                  setActiveDetail({ workflow: skill.workflow, source: 'skill', skill })
                }
                onNewSkill={() => setNewSkillOpen(true)}
                onToggleLinkTarget={handleToggleLinkTarget}
                onDeleteSkill={handleDeleteSkillCompletely}
                onDetectTools={handleDetectTools}
                notify={setToast}
              />
            ) : null}

            {view === 'workflows' ? (
              <WorkflowsOverviewPage
                items={discoveries}
                savedMap={savedWorkflowIds}
                onOpenDetail={(wf) => setActiveDetail({ workflow: wf, source: 'workflow' })}
                onSaveSkill={handleSaveWorkflow}
                onDismiss={(wfId) => {
                  setDiscoveries((prev) => prev.filter((i) => i.id !== wfId))
                  setToast(t.workflows.dismissedToast)
                }}
                observing={observing}
              />
            ) : null}

            {view === 'environments' ? (
              <AIEnvironmentsPage
                aiTools={aiTools}
                skills={skills}
                onDetectTools={handleDetectTools}
                onToggleLinkTarget={handleToggleLinkTarget}
                onBulkLink={handleBulkLinkToTarget}
                onBulkUnlink={handleBulkUnlinkFromTarget}
                notify={setToast}
              />
            ) : null}
          </>
        )}
      </main>

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
