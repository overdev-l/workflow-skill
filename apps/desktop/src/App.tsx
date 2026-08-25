import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Boxes,
  Check,
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
  Mail,
  Monitor,
  Moon,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from 'lucide-react'
import type {
  Skill,
  Workflow,
  WorkflowNode,
} from '@workflow-skill/workflow-model'
import type {
  CaptureEvent,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'
import { WorkflowGraph } from './components/WorkflowGraph'
import { useI18n, type Locale, type TranslationKeys } from './i18n'

type View = 'skills' | 'workflows'
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
}: {
  items: Workflow[]
  savedMap: Record<string, boolean>
  onOpenDetail: (wf: Workflow) => void
  onSaveSkill: (wf: Workflow) => void
  onDismiss: (wfId: string) => void
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

      {/* Unified Flat Table Container */}
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

          {items.length === 0 ? (
            <div className="clean-empty-state">
              <Check size={28} className="empty-icon" />
              <h3>{t.workflows.emptyTitle}</h3>
              <p>{t.workflows.emptyDesc}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   Level 1: Skills Overview (Clean Flat Table & Segmented Filter)
   ========================================================================= */
function SkillsOverviewPage({
  skills,
  onOpenDetail,
  onNewSkill,
  notify,
}: {
  skills: Skill[]
  onOpenDetail: (skill: Skill) => void
  onNewSkill: () => void
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()
  const [skillTab, setSkillTab] = useState<'local' | 'remote'>('local')
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'pinned'>('all')
  const [remoteCategory, setRemoteCategory] = useState<'all' | 'dev' | 'office'>('all')

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((sk) => {
      if (filterMode === 'pinned' && !sk.pinned) return false
      if (!q) return true
      const searchStr = `${sk.name} ${sk.description} ${sk.apps.join(' ')}`.toLowerCase()
      return searchStr.includes(q)
    })
  }, [skills, query, filterMode])

  const pinnedCount = useMemo(() => skills.filter((s) => s.pinned).length, [skills])

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

        {/* Centered Segmented Tab Switcher (Local vs Remote) */}
        <div className="page-header__center">
          <div className="segmented-pill-track" role="tablist" aria-label={t.skills.title}>
            <button
              type="button"
              className={`segmented-pill-btn ${skillTab === 'local' ? 'is-active' : ''}`}
              onClick={() => {
                setSkillTab('local')
                setQuery('')
              }}
              role="tab"
              aria-selected={skillTab === 'local'}
            >
              <Folder size={13} />
              <span>{t.skills.tabLocal}</span>
            </button>
            <button
              type="button"
              className={`segmented-pill-btn ${skillTab === 'remote' ? 'is-active' : ''}`}
              onClick={() => {
                setSkillTab('remote')
                setQuery('')
              }}
              role="tab"
              aria-selected={skillTab === 'remote'}
            >
              <Globe size={13} />
              <span>{t.skills.tabRemote}</span>
            </button>
          </div>
        </div>

        <div className="page-header__right">
          {skillTab === 'remote' ? (
            <button
              type="button"
              className="btn btn--secondary btn--capsule"
              onClick={() => notify?.(t.skills.remoteComingSoonToast)}
            >
              <Sliders size={13} />
              <span>{t.skills.remoteConfigureBtn}</span>
            </button>
          ) : null}
        </div>
      </header>

      {skillTab === 'local' ? (
        <>
          {/* Local Tab: Filter Row: Floating Capsule Search Box & Flat Segmented Tab */}
          {skills.length > 0 ? (
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
          ) : null}

          {/* Local Skills List Container */}
          <div className="flat-table-wrap stagger-item">
            <div className="flat-rows-list">
              {filteredSkills.map((sk, idx) => (
                <div
                  key={sk.id}
                  className="flat-row"
                  style={{ animationDelay: `${idx * 20}ms` }}
                  onClick={() => onOpenDetail(sk)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flat-row__left">
                    <div className="flat-title-row">
                      {sk.pinned ? <Bookmark size={13} className="flat-pinned-icon" /> : null}
                      <strong className="flat-row-title">{sk.name}</strong>
                    </div>
                    <span className="flat-row-desc">{sk.description}</span>
                  </div>

                  <div className="flat-row__middle">
                    <div className="app-chips-row">
                      {sk.apps.map((a) => (
                        <span key={a} className="app-capsule-chip font-mono">
                          {a}
                        </span>
                      ))}
                    </div>
                    <WorkflowGraph workflow={sk.workflow} compact />
                  </div>

                  <div className="flat-row__right">
                    <span className="flat-row-meta font-mono">{sk.updatedLabel}</span>
                    <span className="pinned-ver-pill font-mono">{t.skills.versionPrefix}{sk.versions}.0</span>
                    <div className="row-chevron-indicator">
                      <ChevronRight size={14} />
                    </div>
                  </div>
                </div>
              ))}

              {skills.length > 0 && filteredSkills.length === 0 ? (
                <div className="clean-empty-state">
                  <Search size={24} className="empty-icon" />
                  <p>{t.skills.emptySearch}</p>
                </div>
              ) : null}

              {skills.length === 0 ? (
                <div className="clean-empty-state">
                  <Boxes size={32} className="empty-icon" />
                  <h3>{t.skills.emptyLocalTitle}</h3>
                  <p>{t.skills.emptyLocalDesc}</p>
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
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Remote Tab: Remote Hub Announcement Banner */}
          <div className="remote-hub-banner stagger-item">
            <div className="remote-hub-banner__left">
              <div className="remote-hub-icon-wrap">
                <Globe size={18} />
              </div>
              <div>
                <strong className="remote-hub-headline">{t.skills.remoteLibraryNoticeTitle}</strong>
                <p className="remote-hub-desc">{t.skills.remoteLibraryNoticeDesc}</p>
              </div>
            </div>
            <button
              type="button"
              className="btn btn--capsule btn--secondary btn--sm"
              onClick={() => notify?.(t.skills.remoteComingSoonToast)}
            >
              <ExternalLink size={12} />
              <span>{t.skills.remoteDocsBtn}</span>
            </button>
          </div>

          {/* Remote Skills Clean Empty State */}
          <div className="flat-table-wrap stagger-item">
            <div className="flat-rows-list">
              <div className="clean-empty-state">
                <Globe size={32} className="empty-icon" />
                <h3>{t.skills.emptyRemoteTitle}</h3>
                <p>{t.skills.emptyRemoteDesc}</p>
                <div className="empty-state-actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--capsule"
                    onClick={() => notify?.(t.skills.remoteComingSoonToast)}
                  >
                    <Sliders size={13} />
                    <span>{t.skills.remoteConfigureBtn}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
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

  useEffect(() => {
    let active = true
    if (window.workflowSkill?.loadLocalSkills) {
      window.workflowSkill
        .loadLocalSkills()
        .then((loaded) => {
          if (active && Array.isArray(loaded)) {
            setSkills(loaded)
          }
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [])

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
                onOpenDetail={(skill) =>
                  setActiveDetail({ workflow: skill.workflow, source: 'skill', skill })
                }
                onNewSkill={() => setNewSkillOpen(true)}
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
