import React, { useEffect, useMemo, useState } from 'react'
import {
  FileText,
  Plus,
  Trash2,
  Save,
  Link,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowUp,
  ArrowDown,
  FolderPlus,
  RefreshCw,
  Search,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import type {
  ClaudeLinkStatus,
  ManagedProjectRecord,
  ProjectRecord,
  ProjectRuleAssociation,
  PublicRule,
} from '@workflow-skill/workflow-model'
import { useI18n } from '../i18n'

export interface RulesThreeColumnProps {
  notify?: (msg: string) => void
  scope?: 'global' | 'project'
  onScopeChange?: (scope: 'global' | 'project') => void
  projects?: ManagedProjectRecord[] | ProjectRecord[]
  selectedProjectId?: string
  onSelectProjectId?: (id: string) => void
  selectedProject?: ManagedProjectRecord | ProjectRecord | null
}

export function RulesThreeColumn({
  notify,
  scope,
  onScopeChange,
  projects: propProjects,
  selectedProjectId,
  onSelectProjectId,
  selectedProject,
}: RulesThreeColumnProps) {
  const { t } = useI18n()

  const [activeTab, setActiveTab] = useState<'rules' | 'project'>('rules')
  const currentTab = scope !== undefined ? (scope === 'global' ? 'rules' : 'project') : activeTab
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState<PublicRule[]>([])
  const [localProjects, setLocalProjects] = useState<ProjectRecord[]>([])
  const projects = propProjects !== undefined ? propProjects : localProjects
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null)
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null)
  const currentProject = selectedProject !== undefined
    ? selectedProject
    : (projects.find((p) => p.path === selectedProjectPath || p.id === selectedProjectId) ?? null)
  const currentProjectPath = currentProject ? currentProject.path : (selectedProject !== undefined ? '' : (selectedProjectPath || ''))
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [projectsExpanded, setProjectsExpanded] = useState(false)
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const selectionRef = React.useRef({ selectedRuleId, selectedProjectPath: currentProjectPath, isCreatingNew })
  selectionRef.current = { selectedRuleId, selectedProjectPath: currentProjectPath, isCreatingNew }

  // Drafts state ref to preserve edits across switches or background rule syncs
  const draftsRef = React.useRef<Map<string, { name: string; desc: string; content: string }>>(new Map())

  // Rule Editor State
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formContent, setFormContent] = useState('')
  const [formSaving, setFormSaving] = useState(false)

  // Project Rules State
  const [projectAssoc, setProjectAssoc] = useState<ProjectRuleAssociation | null>(null)
  const [selectedRuleIdsForProject, setSelectedRuleIdsForProject] = useState<string[]>([])
  const [claudeStatus, setClaudeStatus] = useState<ClaudeLinkStatus | null>(null)
  const [projectSaving, setProjectSaving] = useState(false)
  const [claudeOperating, setClaudeOperating] = useState(false)

  // Load Rules & Projects
  const refreshData = async () => {
    if (!window.workflowSkill) return
    try {
      if (window.workflowSkill.listRules) {
        const r = await window.workflowSkill.listRules()
        setRules(r)
        if (!selectionRef.current.isCreatingNew) {
          setSelectedRuleId(current => current && r.some(rule => rule.id === current) ? current : r[0]?.id || null)
        }
      }
      if (propProjects === undefined && window.workflowSkill.listProjects) {
        const p = await window.workflowSkill.listProjects()
        setLocalProjects(p)
        if (!selectionRef.current.selectedProjectPath && p.length > 0) {
          const active = window.workflowSkill.getActiveProject
            ? await window.workflowSkill.getActiveProject()
            : null
          setSelectedProjectPath(current => current || (active ? active.path : p[0].path))
        }
      }
    } catch (err: any) {
      console.error('[Trace] Failed to load rules data:', err)
    }
  }

  useEffect(() => {
    refreshData()

    const unbindRules = window.workflowSkill?.onRulesChanged?.(() => {
      refreshData()
    })
    const unbindProjects = window.workflowSkill?.onProjectsChanged?.(() => {
      refreshData()
    })

    return () => {
      unbindRules?.()
      unbindProjects?.()
    }
  }, [])

  // Sync selected rule to editor form
  useEffect(() => {
    if (isCreatingNew) {
      return
    }
    if (selectedRuleId) {
      if (!draftsRef.current.has(selectedRuleId)) {
        const found = rules.find((r) => r.id === selectedRuleId)
        if (found) {
          setFormName(found.name)
          setFormDesc(found.description || '')
          setFormContent(found.content)
        }
      }
    } else if (rules.length > 0) {
      setSelectedRuleId(rules[0].id)
    } else {
      setFormName('')
      setFormDesc('')
      setFormContent('')
    }
  }, [selectedRuleId, rules, isCreatingNew])

  // Sync project configuration when selected project changes
  const projectReqIdRef = React.useRef(0)
  const refreshProjectDetails = async (path: string) => {
    const reqId = ++projectReqIdRef.current
    if (!window.workflowSkill || !path || (currentProject && (currentProject as any).status === 'missing')) {
      setProjectAssoc(null)
      setSelectedRuleIdsForProject([])
      setClaudeStatus(null)
      return
    }
    try {
      const [assoc, link] = await Promise.all([
        window.workflowSkill.getProjectRuleConfig ? window.workflowSkill.getProjectRuleConfig(path) : null,
        window.workflowSkill.checkClaudeLink ? window.workflowSkill.checkClaudeLink(path) : null,
      ])
      if (projectReqIdRef.current !== reqId) return
      if (assoc) {
        setProjectAssoc(assoc)
        setSelectedRuleIdsForProject(assoc.ruleIds || [])
      }
      if (link) {
        setClaudeStatus(link)
      }
    } catch {
      if (projectReqIdRef.current === reqId) {
        setProjectAssoc(null)
        setSelectedRuleIdsForProject([])
        setClaudeStatus(null)
      }
    }
  }

  useEffect(() => {
    setProjectAssoc(null)
    setSelectedRuleIdsForProject([])
    setClaudeStatus(null)
    if (currentProjectPath && (!currentProject || (currentProject as any).status !== 'missing')) {
      refreshProjectDetails(currentProjectPath)
    }
  }, [currentProjectPath, (currentProject as any)?.status])

  // Filtered lists
  const filteredRules = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rules
    return rules.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)) ||
        r.content.toLowerCase().includes(q)
    )
  }, [rules, query])

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
    )
  }, [projects, query])

  // Rule Handlers
  const handleNewRule = () => {
    setIsCreatingNew(true)
    setSelectedRuleId(null)
    const draft = draftsRef.current.get('__new__')
    if (draft) {
      setFormName(draft.name)
      setFormDesc(draft.desc)
      setFormContent(draft.content)
    } else {
      setFormName('新公共规则')
      setFormDesc('')
      setFormContent('# 新规则\n\n- 规则条目 1\n- 规则条目 2\n')
    }
  }

  const handleSelectRule = (ruleId: string) => {
    if (selectedRuleId === ruleId && !isCreatingNew) return
    setIsCreatingNew(false)
    setSelectedRuleId(ruleId)
    const draft = draftsRef.current.get(ruleId)
    if (draft) {
      setFormName(draft.name)
      setFormDesc(draft.desc)
      setFormContent(draft.content)
    } else {
      const found = rules.find((r) => r.id === ruleId)
      if (found) {
        setFormName(found.name)
        setFormDesc(found.description || '')
        setFormContent(found.content)
      }
    }
  }

  const updateFormName = (val: string) => {
    setFormName(val)
    const key = isCreatingNew ? '__new__' : selectedRuleId
    if (key) {
      const cur = draftsRef.current.get(key) || { name: val, desc: formDesc, content: formContent }
      draftsRef.current.set(key, { ...cur, name: val })
    }
  }

  const updateFormDesc = (val: string) => {
    setFormDesc(val)
    const key = isCreatingNew ? '__new__' : selectedRuleId
    if (key) {
      const cur = draftsRef.current.get(key) || { name: formName, desc: val, content: formContent }
      draftsRef.current.set(key, { ...cur, desc: val })
    }
  }

  const updateFormContent = (val: string) => {
    setFormContent(val)
    const key = isCreatingNew ? '__new__' : selectedRuleId
    if (key) {
      const cur = draftsRef.current.get(key) || { name: formName, desc: formDesc, content: val }
      draftsRef.current.set(key, { ...cur, content: val })
    }
  }

  const handleSaveRule = async () => {
    if (!formName.trim()) {
      notify?.('规则名称不能为空')
      return
    }
    if (!window.workflowSkill?.saveRule) return

    setFormSaving(true)
    try {
      const res = await window.workflowSkill.saveRule({
        id: selectedRuleId || undefined,
        name: formName.trim(),
        description: formDesc.trim(),
        content: formContent,
      })
      if (res.success) {
        notify?.(t.rules.savedToast(res.rule.name))
        draftsRef.current.delete(res.rule.id)
        if (selectedRuleId) draftsRef.current.delete(selectedRuleId)
        draftsRef.current.delete('__new__')
        setIsCreatingNew(false)
        setSelectedRuleId(res.rule.id)
        refreshData()
        if (selectedProjectPath) refreshProjectDetails(selectedProjectPath)
      } else {
        notify?.('保存失败')
      }
    } catch (err: any) {
      notify?.(`保存失败: ${err?.message || String(err)}`)
    } finally {
      setFormSaving(false)
    }
  }

  const handleDeleteRule = async () => {
    if (!selectedRuleId || !window.workflowSkill?.deleteRule) return
    const found = rules.find((r) => r.id === selectedRuleId)
    if (!found) return
    if (!confirm(t.rules.confirmDelete)) return

    try {
      const res = await window.workflowSkill.deleteRule(selectedRuleId)
      if (res.success) {
        notify?.(t.rules.deletedToast(found.name))
        draftsRef.current.delete(selectedRuleId)
        setIsCreatingNew(false)
        setSelectedRuleId(null)
        refreshData()
        if (selectedProjectPath) refreshProjectDetails(selectedProjectPath)
      }
    } catch (err: any) {
      notify?.(`删除失败: ${err?.message || String(err)}`)
    }
  }

  const handleToggleProject = async (projectPath: string, ruleId: string): Promise<boolean> => {
    if (!window.workflowSkill?.getProjectRuleConfig || !window.workflowSkill?.setProjectRules) return false
    const proj = projects.find((p) => p.path === projectPath)
    if (proj && (proj as any).status === 'missing') {
      notify?.('项目目录不可用，无法修改项目规则')
      return false
    }
    const config = await window.workflowSkill.getProjectRuleConfig(projectPath)
    const current = config.ruleIds || []
    const isInjected = current.includes(ruleId)
    let updated: string[]
    if (isInjected) {
      updated = current.filter((id) => id !== ruleId)
    } else {
      updated = [...current, ruleId]
    }

    const res = await window.workflowSkill.setProjectRules?.(projectPath, updated)
    if (res?.success) {
      notify?.(isInjected ? '已从项目取消注入规则' : '已成功注入规则到项目')
      refreshData()
      if (selectedProjectPath === projectPath) {
        refreshProjectDetails(projectPath)
      }
      return true
    } else {
      notify?.(`操作失败: ${res?.error || '未知错误'}`)
      return false
    }
  }

  // Project Handlers
  const handleAddProject = async () => {
    if (!window.workflowSkill?.addProject) return
    try {
      const res = await window.workflowSkill.addProject()
      if (res.success && res.project) {
        notify?.(`已添加项目: ${res.project.name}`)
        if (onSelectProjectId) {
          onSelectProjectId(res.project.id)
        } else {
          setSelectedProjectPath(res.project.path)
        }
        window.dispatchEvent(new CustomEvent('workflow-skill:workspace-changed'))
        refreshData()
      } else if (res.error && res.error !== '用户取消了选择') {
        notify?.(`添加项目失败: ${res.error}`)
      }
    } catch (err: any) {
      notify?.(`添加异常: ${err?.message || String(err)}`)
    }
  }

  const handleRemoveProject = async (pathToRemove: string) => {
    if (!window.workflowSkill?.removeProject) return
    if (!confirm(`确定要从 Trace 移除该项目吗？不会删除实际磁盘文件。`)) return

    try {
      const res = await window.workflowSkill.removeProject(pathToRemove)
      if (res.success) {
        notify?.('已移除项目')
        if (selectedProjectPath === pathToRemove) {
          setSelectedProjectPath(null)
        }
        window.dispatchEvent(new CustomEvent('workflow-skill:workspace-changed'))
        refreshData()
      }
    } catch (err: any) {
      notify?.(`移除异常: ${err?.message || String(err)}`)
    }
  }

  const handleToggleProjectRuleItem = (ruleId: string) => {
    setSelectedRuleIdsForProject((prev) => {
      if (prev.includes(ruleId)) {
        return prev.filter((id) => id !== ruleId)
      } else {
        return [...prev, ruleId]
      }
    })
  }

  const handleMoveRule = (ruleId: string, direction: 'up' | 'down') => {
    setSelectedRuleIdsForProject((prev) => {
      const index = prev.indexOf(ruleId)
      if (index < 0) return prev
      if (direction === 'up' && index === 0) return prev
      if (direction === 'down' && index === prev.length - 1) return prev

      const next = [...prev]
      const targetIndex = direction === 'up' ? index - 1 : index + 1
      const temp = next[index]
      next[index] = next[targetIndex]
      next[targetIndex] = temp
      return next
    })
  }

  const handleSaveProjectRules = async () => {
    if (!currentProjectPath || (currentProject && (currentProject as any).status === 'missing') || !window.workflowSkill?.setProjectRules) return
    setProjectSaving(true)
    try {
      const res = await window.workflowSkill.setProjectRules(
        currentProjectPath,
        selectedRuleIdsForProject
      )
      if (res.success) {
        notify?.(t.rules.syncedToast)
        refreshProjectDetails(currentProjectPath)
      } else {
        notify?.(`同步失败: ${res.error || '未知错误'}`)
      }
    } catch (err: any) {
      notify?.(`同步异常: ${err?.message || String(err)}`)
    } finally {
      setProjectSaving(false)
    }
  }

  const handleCreateClaudeLink = async () => {
    if (!currentProjectPath || (currentProject && (currentProject as any).status === 'missing') || !window.workflowSkill?.createClaudeLink) return
    setClaudeOperating(true)
    try {
      const res = await window.workflowSkill.createClaudeLink(currentProjectPath)
      if (res.success) {
        if (res.action === 'skipped') {
          notify?.(t.rules.claudeSkippedToast)
        } else {
          notify?.(t.rules.claudeCreatedToast)
        }
      } else {
        notify?.(t.rules.claudeConflictToast(res.reason || '创建失败'))
      }
      refreshProjectDetails(currentProjectPath)
    } catch (err: any) {
      notify?.(`操作失败: ${err?.message || String(err)}`)
    } finally {
      setClaudeOperating(false)
    }
  }

  // Preview generated AGENTS.md content
  const previewContent = useMemo(() => {
    const selectedRules = selectedRuleIdsForProject
      .map((id) => rules.find((r) => r.id === id))
      .filter(Boolean) as PublicRule[]

    if (selectedRules.length === 0) {
      return '# AGENTS.md\n\n(暂无选中的公共规则)'
    }

    const blocks = selectedRules
      .map(
        (r) =>
          `<!-- TRACE:RULE:START id="${r.id}" name="${r.name}" -->\n${r.content.trim()}\n<!-- TRACE:RULE:END id="${r.id}" -->`
      )
      .join('\n\n')

    return `# Project Guidelines (AGENTS.md)\n\n${blocks}\n`
  }, [selectedRuleIdsForProject, rules])

  return (
    <>
      {/* Column 2: Master List (Width: 210px) */}
      <aside className="app-col-master view-enter">
        {/* Top Header with Segmented Tabs (Compatibility mode only) */}
        <div className="master-header">
          {scope === undefined && (
            <div className="master-tab-segmented">
              <button
                type="button"
                className={`master-tab-btn ${currentTab === 'rules' ? 'is-active' : ''}`}
                onClick={() => (onScopeChange ? onScopeChange('global') : setActiveTab('rules'))}
              >
                {t.rules.tabRules}
              </button>
              <button
                type="button"
                className={`master-tab-btn ${currentTab === 'project' ? 'is-active' : ''}`}
                onClick={() => (onScopeChange ? onScopeChange('project') : setActiveTab('project'))}
              >
                {t.rules.tabProject}
              </button>
            </div>
          )}

          <div className="master-search-row">
            <label className="master-search-input">
              <Search size={13} />
              <input
                type="text"
                placeholder={currentTab === 'rules' ? '搜索规则…' : '搜索项目…'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {currentTab === 'rules' ? (
              <button
                type="button"
                className="btn btn--capsule btn--primary"
                style={{ height: '24px', padding: '0 8px', fontSize: 'var(--text-control)' }}
                onClick={handleNewRule}
                title="新建规则"
              >
                <Plus size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--capsule btn--primary"
                style={{ height: '24px', padding: '0 8px', fontSize: 'var(--text-control)' }}
                onClick={handleAddProject}
                title="添加项目文件夹"
              >
                <FolderPlus size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Master List Content */}
        <div className="master-list-scroll">
          {currentTab === 'rules' ? (
            filteredRules.length === 0 ? (
              <div className="master-empty-state">
                <p style={{ fontSize: 'var(--text-control)', color: 'var(--color-muted)' }}>
                  {query ? '未匹配到规则' : '暂无公共规则'}
                </p>
                {query ? (
                  <button
                    type="button"
                    className="btn btn--capsule btn--secondary btn--sm"
                    style={{ marginTop: '8px' }}
                    onClick={() => setQuery('')}
                  >
                    清空搜索
                  </button>
                ) : (
                  <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-muted)', opacity: 0.7, marginTop: '4px' }}>
                    点击上方「+」新建规则
                  </span>
                )}
              </div>
            ) : (
              filteredRules.map((rule) => {
                const isSelected = rule.id === selectedRuleId && !isCreatingNew
                return (
                  <button
                    key={rule.id}
                    type="button"
                    className={`master-item-row ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => handleSelectRule(rule.id)}
                  >
                    <div className="master-item-logo">
                      <FileText size={14} />
                    </div>
                    <div className="master-item-content">
                      <div className="master-item-title-row">
                        <span className="master-item-title">{rule.name}</span>
                      </div>
                      <span className="master-item-sub">
                        {rule.description || `${rule.content.slice(0, 30)}...`}
                      </span>
                    </div>
                  </button>
                )
              })
            )
          ) : filteredProjects.length === 0 ? (
            <div className="master-empty-state">
              <p style={{ fontSize: 'var(--text-control)', color: 'var(--color-muted)' }}>
                {query ? '未匹配到项目' : t.rules.noProjects}
              </p>
              {query ? (
                <button
                  type="button"
                  className="btn btn--capsule btn--secondary btn--sm"
                  style={{ marginTop: '8px' }}
                  onClick={() => setQuery('')}
                >
                  清空搜索
                </button>
              ) : (
                <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-muted)', opacity: 0.7, marginTop: '4px' }}>
                  点击上方「+」添加项目
                </span>
              )}
            </div>
          ) : (
            filteredProjects.map((p) => {
              const isSelected = currentProject
                ? (p.id === currentProject.id || p.path === currentProject.path)
                : (p.path === currentProjectPath)
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`master-item-row ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => {
                    if (onSelectProjectId) {
                      onSelectProjectId(p.id)
                    } else {
                      setSelectedProjectPath(p.path)
                    }
                  }}
                >
                  <div className="master-item-logo">
                    <FolderPlus size={14} />
                  </div>
                  <div className="master-item-content">
                    <div className="master-item-title-row">
                      <span className="master-item-title">{p.name}</span>
                    </div>
                    <span className="master-item-sub font-mono">{p.path}</span>
                    {(p as any).status === 'missing' && (
                      <span style={{ color: 'var(--color-danger)', fontSize: 'var(--text-caption)' }}>目录失效</span>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </aside>

      {/* Column 3: Detail Stage (Width: minmax(0, 1fr)) */}
      <main className="app-col-detail view-enter">
        {currentTab === 'rules' ? (
          !selectedRuleId && !isCreatingNew ? (
            <div className="detail-stage-wrap rules-stage" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '300px' }}>
              <div style={{ textAlign: 'center', color: 'var(--color-muted)' }}>
                <FileText size={32} style={{ opacity: 0.35, marginBottom: '12px' }} />
                <p style={{ margin: 0, fontSize: 'var(--text-body)' }}>未选择规则，请在左侧选择或新建规则</p>
              </div>
            </div>
          ) : (
            /* Rule Editor & Association Matrix */
            <div className="detail-stage-wrap rules-stage">
              {/* Header & Actions */}
              <div className="rules-detail-header" style={{ alignItems: 'flex-start' }}>
                <div className="rules-detail-header__fields" style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label className="form-label rules-form-label" style={{ fontSize: 'var(--text-control)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      规则名称
                    </label>
                    <input
                      type="text"
                      className="dialog-capsule-input"
                      style={{ fontSize: 'var(--text-body)', fontWeight: 600, width: '100%' }}
                      placeholder={t.rules.ruleNamePlaceholder}
                      value={formName}
                      onChange={(e) => updateFormName(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label className="form-label rules-form-label" style={{ fontSize: 'var(--text-control)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      简短描述
                    </label>
                    <input
                      type="text"
                      className="dialog-capsule-input"
                      style={{ fontSize: 'var(--text-control)', width: '100%' }}
                      placeholder={t.rules.ruleDescPlaceholder}
                      value={formDesc}
                      onChange={(e) => updateFormDesc(e.target.value)}
                    />
                  </div>
                </div>

                <div className="rules-detail-header__actions" style={{ display: 'flex', gap: '8px', alignSelf: 'flex-start', paddingTop: '18px' }}>
                  {selectedRuleId && (
                    <button
                      type="button"
                      className="btn btn--capsule btn--danger"
                      onClick={handleDeleteRule}
                      title={t.rules.deleteRuleBtn}
                    >
                      <Trash2 size={13} /> {t.rules.deleteRuleBtn}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--capsule btn--primary"
                    onClick={handleSaveRule}
                    disabled={formSaving}
                  >
                    <Save size={13} /> {formSaving ? '保存中…' : t.rules.saveRuleBtn}
                  </button>
                </div>
              </div>

              {/* Markdown Editor - Full Width */}
              <div className="rules-full-editor-pane" style={{ marginTop: '16px' }}>
                <label className="form-label rules-form-label" style={{ marginBottom: '6px', display: 'block', fontSize: 'var(--text-control)' }}>
                  Markdown 规则定义
                </label>
                <textarea
                  className="mcp-textarea font-mono skill-md-editor"
                  style={{
                    width: '100%',
                    minHeight: '320px',
                    lineHeight: '1.6',
                    fontSize: 'var(--text-body)',
                    padding: '14px 16px',
                    borderRadius: '8px',
                    resize: 'vertical',
                  }}
                  placeholder={t.rules.ruleContentPlaceholder}
                  value={formContent}
                  onChange={(e) => updateFormContent(e.target.value)}
                />
              </div>

              {/* Collapsible Applied Projects Section */}
              <div className="rules-collapsible-section" style={{ marginTop: '16px' }}>
                <div
                  className="section-collapse-header"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '4px 0',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setProjectsExpanded(!projectsExpanded)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      color: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <FolderPlus size={15} style={{ opacity: 0.8 }} />
                    <span style={{ fontSize: 'var(--text-section)', fontWeight: 600 }}>
                      {t.rules.injectedProjectsTitle}
                    </span>
                    <span className="badge badge--neutral" style={{ fontSize: 'var(--text-control)' }}>
                      共 {projects.length} 个项目
                    </span>
                    {projectsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>

                  <button
                    type="button"
                    className="btn btn--capsule btn--sm"
                    onClick={handleAddProject}
                  >
                    <Plus size={11} /> {t.rules.addProjectBtn}
                  </button>
                </div>

                {projectsExpanded && (
                  <div className="rules-matrix-card" style={{ marginTop: '8px' }}>
                    {projects.length === 0 ? (
                      <div style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--color-muted)', fontSize: 'var(--text-control)' }}>
                        暂未关联任何项目，点击上方「+」添加项目文件夹进行注入
                      </div>
                    ) : (
                      projects.map((proj) => (
                        <ProjectRuleMatrixRow
                          key={proj.id}
                          project={proj}
                          ruleId={selectedRuleId}
                          onToggle={() => (selectedRuleId ? handleToggleProject(proj.path, selectedRuleId) : Promise.resolve(false))}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          /* Project Rules Configuration Mode */
          <div className="detail-stage-wrap rules-stage" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            {/* Project Switcher Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--color-border-subtle)',
                marginBottom: '16px',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: 'var(--text-section)', fontWeight: 600 }}>
                  {currentProject?.name || '未选择项目'}
                </h3>
                <p className="font-mono" style={{ margin: '4px 0 0 0', fontSize: 'var(--text-control)', color: 'var(--color-muted)' }}>
                  {currentProjectPath || '请先在侧边栏选择或添加项目'}
                </p>
              </div>

              {currentProjectPath && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn--capsule btn--sm"
                    onClick={() => window.workflowSkill?.openPathInFinder?.(currentProjectPath)}
                  >
                    <ExternalLink size={12} /> 在访达中打开
                  </button>
                  <button
                    type="button"
                    className="btn btn--capsule btn--danger btn--sm"
                    onClick={() => handleRemoveProject(currentProjectPath)}
                  >
                    <Trash2 size={12} /> {t.rules.removeProjectBtn}
                  </button>
                </div>
              )}
            </div>

            {(currentProject as any)?.status === 'missing' && (
              <div
                style={{
                  padding: '8px 12px',
                  background: 'var(--color-danger-bg)',
                  border: '1px solid var(--color-danger-border)',
                  borderRadius: '6px',
                  fontSize: 'var(--text-control)',
                  color: 'var(--color-danger)',
                  marginBottom: '12px',
                }}
              >
                项目目录不可用，请在项目管理中修复后再同步规则。
              </div>
            )}

            {currentProjectPath ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Card 1: CLAUDE.md Helper */}
                <div
                  style={{
                    padding: claudeStatus?.isCorrect ? '8px 12px' : '14px',
                    borderRadius: '8px',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border-subtle)',
                    transition: 'padding 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                      <Link size={14} style={{ flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 'var(--text-body)', whiteSpace: 'nowrap' }}>{t.rules.claudeLinkTitle}</span>
                      {claudeStatus?.isCorrect ? (
                        <span className="badge badge--success" style={{ fontSize: 'var(--text-caption)' }}>
                          <CheckCircle2 size={11} style={{ marginRight: '4px' }} />
                          {t.rules.claudeLinkedBadge}
                        </span>
                      ) : claudeStatus?.conflict ? (
                        <span className="badge badge--danger" style={{ fontSize: 'var(--text-caption)' }}>
                          <AlertCircle size={11} style={{ marginRight: '4px' }} />
                          {t.rules.claudeConflictBadge}
                        </span>
                      ) : (
                        <span className="badge badge--neutral" style={{ fontSize: 'var(--text-caption)' }}>
                          {t.rules.claudeMissingBadge}
                        </span>
                      )}
                      {!claudeStatus?.isCorrect && (
                        <span style={{ fontSize: 'var(--text-control)', color: 'var(--color-muted)' }}>
                          {claudeStatus?.reason || t.rules.claudeLinkDesc}
                        </span>
                      )}
                    </div>

                    {!claudeStatus?.isCorrect && (
                      <button
                        type="button"
                        className="btn btn--capsule btn--primary btn--sm"
                        onClick={handleCreateClaudeLink}
                        disabled={claudeOperating || Boolean(!currentProjectPath || (currentProject && (currentProject as any).status === 'missing'))}
                        style={{ flexShrink: 0 }}
                      >
                        {claudeOperating ? '处理中…' : t.rules.createClaudeLinkBtn}
                      </button>
                    )}
                  </div>
                  {claudeStatus?.conflict && claudeStatus?.reason && (
                    <p style={{ margin: '6px 0 0 0', fontSize: 'var(--text-control)', color: 'var(--color-danger-ink)' }}>
                      {claudeStatus.reason}
                    </p>
                  )}
                </div>

                {/* Card 2: Rule Selection and Ordering */}
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '8px',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: 'var(--text-body)' }}>{t.rules.projectRulesTitle}</span>
                      <p style={{ margin: '2px 0 0 0', fontSize: 'var(--text-body)', color: 'var(--color-muted)' }}>
                        {t.rules.projectRulesDesc}
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {projectAssoc?.status && (
                        <span
                          className={`badge ${
                            projectAssoc.status === 'synced'
                              ? 'badge--success'
                              : projectAssoc.status === 'failed'
                              ? 'badge--danger'
                              : 'badge--warning'
                          }`}
                          style={{ fontSize: 'var(--text-caption)' }}
                        >
                          {projectAssoc.status === 'synced'
                            ? t.rules.statusSynced
                            : projectAssoc.status === 'failed'
                            ? t.rules.statusFailed
                            : t.rules.statusPending}
                        </span>
                      )}

                      <button
                        type="button"
                        className="btn btn--capsule btn--primary"
                        onClick={handleSaveProjectRules}
                        disabled={projectSaving || Boolean(!currentProjectPath || (currentProject && (currentProject as any).status === 'missing'))}
                      >
                        <RefreshCw size={12} className={projectSaving ? 'spin' : ''} />
                        {projectSaving ? '同步中…' : t.rules.saveAndSyncBtn}
                      </button>
                    </div>
                  </div>

                  {rules.length === 0 ? (
                    <p style={{ fontSize: 'var(--text-body)', color: 'var(--color-muted)', textAlign: 'center', padding: '16px 0' }}>
                      暂无公共规则，请先在「规则库」选项卡中创建规则。
                    </p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {/* First render injected rules in order */}
                      {selectedRuleIdsForProject.map((ruleId, index) => {
                        const rule = rules.find((r) => r.id === ruleId)
                        if (!rule) return null
                        return (
                          <div
                            key={rule.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 12px',
                              borderRadius: '6px',
                              background: 'var(--color-surface-raised)',
                              border: '1px solid var(--control-border-focus)',
                            }}
                          >
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 1 }}>
                              <input
                                type="checkbox"
                                checked={true}
                                onChange={() => handleToggleProjectRuleItem(rule.id)}
                              />
                              <div>
                                <span style={{ fontWeight: 500, fontSize: 'var(--text-body)' }}>{rule.name}</span>
                                <span style={{ marginLeft: '8px', fontSize: 'var(--text-control)', color: 'var(--color-muted)' }}>
                                  #{index + 1}
                                </span>
                              </div>
                            </label>

                            <div style={{ display: 'flex', gap: '4px' }}>
                              <button
                                type="button"
                                className="btn btn--capsule btn--sm"
                                disabled={index === 0}
                                onClick={() => handleMoveRule(rule.id, 'up')}
                                title={t.rules.moveUp}
                              >
                                <ArrowUp size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn btn--capsule btn--sm"
                                disabled={index === selectedRuleIdsForProject.length - 1}
                                onClick={() => handleMoveRule(rule.id, 'down')}
                                title={t.rules.moveDown}
                              >
                                <ArrowDown size={12} />
                              </button>
                            </div>
                          </div>
                        )
                      })}

                      {/* Next render unselected rules */}
                      {rules
                        .filter((r) => !selectedRuleIdsForProject.includes(r.id))
                        .map((rule) => (
                          <div
                            key={rule.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 12px',
                              borderRadius: '6px',
                              background: 'var(--color-surface)',
                              border: '1px solid var(--color-border-subtle)',
                              opacity: 0.8,
                            }}
                          >
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 1 }}>
                              <input
                                type="checkbox"
                                checked={false}
                                onChange={() => handleToggleProjectRuleItem(rule.id)}
                              />
                              <span style={{ fontSize: 'var(--text-body)' }}>{rule.name}</span>
                            </label>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* Card 3: Preview (Collapsible on demand) */}
                <div
                  style={{
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <button
                    type="button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      color: 'inherit',
                    }}
                    onClick={() => setPreviewExpanded(!previewExpanded)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <label className="form-label rules-form-label" style={{ margin: 0, cursor: 'pointer' }}>
                        {t.rules.previewTitle}
                      </label>
                      <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-muted)' }}>
                        ({previewContent.split('\n').length} 行)
                      </span>
                    </div>
                    {previewExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>

                  {previewExpanded && (
                    <textarea
                      className="mcp-textarea font-mono skill-md-editor"
                      readOnly
                      style={{
                        width: '100%',
                        height: '240px',
                        resize: 'vertical',
                        lineHeight: '1.5',
                        fontSize: 'var(--text-control)',
                        padding: '12px 16px',
                        borderRadius: '8px',
                        background: 'var(--control-bg)',
                        marginTop: '10px',
                      }}
                      value={previewContent}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--color-muted)' }}>
                {t.rules.noProjects}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  )
}

function ProjectRuleMatrixRow({
  project,
  ruleId,
  onToggle,
}: {
  project: ProjectRecord
  ruleId: string | null
  onToggle: () => Promise<boolean>
}) {
  const [injected, setInjected] = useState(false)
  const [status, setStatus] = useState<'synced' | 'failed' | 'pending'>('pending')
  const [operating, setOperating] = useState(false)

  const fetchStatus = async () => {
    if (!ruleId || !window.workflowSkill?.getProjectRuleConfig) return
    try {
      const cfg = await window.workflowSkill.getProjectRuleConfig(project.path)
      setInjected((cfg.ruleIds || []).includes(ruleId))
      setStatus(cfg.status || 'pending')
    } catch {}
  }

  useEffect(() => {
    void fetchStatus()
  }, [project.path, ruleId])

  const handleToggle = async () => {
    setOperating(true)
    try {
      const success = await onToggle()
      if (success) {
        await fetchStatus()
      }
    } finally {
      setOperating(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 10px',
        borderRadius: '6px',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
    >
      <div style={{ overflow: 'hidden', marginRight: '8px' }}>
        <div style={{ fontWeight: 500, fontSize: 'var(--text-body)' }}>{project.name}</div>
        <div className="font-mono" style={{ fontSize: 'var(--text-caption)', color: 'var(--color-muted)' }}>
          {project.path}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        {injected ? (
          <span
            className={`badge ${status === 'synced' ? 'badge--success' : status === 'failed' ? 'badge--danger' : 'badge--neutral'}`}
            style={{ fontSize: 'var(--text-caption)' }}
          >
            {status === 'synced' ? '已注入 (已同步)' : status === 'failed' ? '同步失败' : '已注入 (待同步)'}
          </span>
        ) : (
          <span className="badge badge--neutral" style={{ fontSize: 'var(--text-caption)' }}>
            未注入
          </span>
        )}

        <button
          type="button"
          className={`btn btn--capsule btn--sm ${injected ? 'btn--danger' : 'btn--primary'}`}
          onClick={handleToggle}
          disabled={operating || !ruleId}
        >
          {injected ? '取消注入' : '注入'}
        </button>
      </div>
    </div>
  )
}
