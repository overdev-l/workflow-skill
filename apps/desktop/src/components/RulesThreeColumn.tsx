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
} from 'lucide-react'
import type {
  ClaudeLinkStatus,
  ProjectRecord,
  ProjectRuleAssociation,
  PublicRule,
} from '@workflow-skill/workflow-model'
import { useI18n } from '../i18n'

export function RulesThreeColumn({
  notify,
}: {
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()

  const [activeTab, setActiveTab] = useState<'rules' | 'project'>('rules')
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState<PublicRule[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null)
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null)

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
        if (!selectedRuleId && r.length > 0) {
          setSelectedRuleId(r[0].id)
        }
      }
      if (window.workflowSkill.listProjects) {
        const p = await window.workflowSkill.listProjects()
        setProjects(p)
        if (!selectedProjectPath && p.length > 0) {
          const active = window.workflowSkill.getActiveProject
            ? await window.workflowSkill.getActiveProject()
            : null
          setSelectedProjectPath(active ? active.path : p[0].path)
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
    if (selectedRuleId) {
      const found = rules.find((r) => r.id === selectedRuleId)
      if (found) {
        setFormName(found.name)
        setFormDesc(found.description || '')
        setFormContent(found.content)
      }
    } else if (rules.length > 0) {
      setSelectedRuleId(rules[0].id)
    } else {
      setFormName('')
      setFormDesc('')
      setFormContent('')
    }
  }, [selectedRuleId, rules])

  // Sync project configuration when selected project changes
  const refreshProjectDetails = async (path: string) => {
    if (!window.workflowSkill) return
    try {
      if (window.workflowSkill.getProjectRuleConfig) {
        const assoc = await window.workflowSkill.getProjectRuleConfig(path)
        setProjectAssoc(assoc)
        setSelectedRuleIdsForProject(assoc.ruleIds || [])
      }
      if (window.workflowSkill.checkClaudeLink) {
        const link = await window.workflowSkill.checkClaudeLink(path)
        setClaudeStatus(link)
      }
    } catch {}
  }

  useEffect(() => {
    if (selectedProjectPath) {
      refreshProjectDetails(selectedProjectPath)
    }
  }, [selectedProjectPath])

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
    setSelectedRuleId(null)
    setFormName('新公共规则')
    setFormDesc('')
    setFormContent('# 新规则\n\n- 规则条目 1\n- 规则条目 2\n')
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
        setSelectedProjectPath(res.project.path)
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
    if (!selectedProjectPath || !window.workflowSkill?.setProjectRules) return
    setProjectSaving(true)
    try {
      const res = await window.workflowSkill.setProjectRules(
        selectedProjectPath,
        selectedRuleIdsForProject
      )
      if (res.success) {
        notify?.(t.rules.syncedToast)
        refreshProjectDetails(selectedProjectPath)
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
    if (!selectedProjectPath || !window.workflowSkill?.createClaudeLink) return
    setClaudeOperating(true)
    try {
      const res = await window.workflowSkill.createClaudeLink(selectedProjectPath)
      if (res.success) {
        if (res.action === 'skipped') {
          notify?.(t.rules.claudeSkippedToast)
        } else {
          notify?.(t.rules.claudeCreatedToast)
        }
      } else {
        notify?.(t.rules.claudeConflictToast(res.reason || '创建失败'))
      }
      refreshProjectDetails(selectedProjectPath)
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
        {/* Top Header with Segmented Tabs */}
        <div className="master-header">
          <div className="master-tab-segmented">
            <button
              type="button"
              className={`master-tab-btn ${activeTab === 'rules' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('rules')}
            >
              {t.rules.tabRules}
            </button>
            <button
              type="button"
              className={`master-tab-btn ${activeTab === 'project' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('project')}
            >
              {t.rules.tabProject}
            </button>
          </div>

          <div className="master-search-row">
            <label className="master-search-input">
              <Search size={13} />
              <input
                type="text"
                placeholder={activeTab === 'rules' ? '搜索规则…' : '搜索项目…'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {activeTab === 'rules' ? (
              <button
                type="button"
                className="btn btn--capsule btn--primary"
                style={{ height: '24px', padding: '0 8px', fontSize: '0.75rem' }}
                onClick={handleNewRule}
                title="新建规则"
              >
                <Plus size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--capsule btn--primary"
                style={{ height: '24px', padding: '0 8px', fontSize: '0.75rem' }}
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
          {activeTab === 'rules' ? (
            filteredRules.length === 0 ? (
              <div className="master-empty-state">
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {query ? '未匹配到规则' : '暂无公共规则'}
                </p>
                <button
                  type="button"
                  className="btn btn--capsule btn--sm"
                  style={{ marginTop: '8px' }}
                  onClick={handleNewRule}
                >
                  <Plus size={12} /> {t.rules.newRule}
                </button>
              </div>
            ) : (
              filteredRules.map((rule) => {
                const isSelected = rule.id === selectedRuleId
                return (
                  <div
                    key={rule.id}
                    className={`master-item ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedRuleId(rule.id)}
                  >
                    <div className="master-item-icon">
                      <FileText size={14} />
                    </div>
                    <div className="master-item-body">
                      <div className="master-item-title">{rule.name}</div>
                      <div className="master-item-sub">
                        {rule.description || `${rule.content.slice(0, 30)}...`}
                      </div>
                    </div>
                  </div>
                )
              })
            )
          ) : filteredProjects.length === 0 ? (
            <div className="master-empty-state">
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {query ? '未匹配到项目' : t.rules.noProjects}
              </p>
              <button
                type="button"
                className="btn btn--capsule btn--sm"
                style={{ marginTop: '8px' }}
                onClick={handleAddProject}
              >
                <FolderPlus size={12} /> {t.rules.addProjectBtn}
              </button>
            </div>
          ) : (
            filteredProjects.map((p) => {
              const isSelected = p.path === selectedProjectPath
              return (
                <div
                  key={p.id}
                  className={`master-item ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedProjectPath(p.path)}
                >
                  <div className="master-item-body">
                    <div className="master-item-title">{p.name}</div>
                    <div className="master-item-sub font-mono">{p.path}</div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* Column 3: Detail Stage (Width: minmax(0, 1fr)) */}
      <main className="app-col-detail view-enter">
        {activeTab === 'rules' ? (
          /* Rule Editor & Association Matrix */
          <div className="detail-stage-wrap" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header & Actions */}
            <div className="mcp-detail-header" style={{ marginBottom: '16px' }}>
              <div style={{ flex: 1, marginRight: '16px' }}>
                <input
                  type="text"
                  className="dialog-capsule-input"
                  style={{ fontSize: '1rem', fontWeight: 600, width: '100%', marginBottom: '8px' }}
                  placeholder={t.rules.ruleNamePlaceholder}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                />
                <input
                  type="text"
                  className="dialog-capsule-input"
                  style={{ fontSize: '0.8125rem', width: '100%' }}
                  placeholder={t.rules.ruleDescPlaceholder}
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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

            {/* Split Content: Markdown Editor on Left, Injected Projects Matrix on Right */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(280px, 0.9fr)', gap: '16px', flex: 1, minHeight: 0 }}>
              {/* Markdown Editor */}
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <label className="form-label" style={{ marginBottom: '6px' }}>
                  Markdown 规则定义
                </label>
                <textarea
                  className="mcp-textarea font-mono"
                  style={{
                    flex: 1,
                    resize: 'none',
                    lineHeight: '1.5',
                    fontSize: '0.8125rem',
                    padding: '12px',
                    borderRadius: '8px',
                  }}
                  placeholder={t.rules.ruleContentPlaceholder}
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                />
              </div>

              {/* Injected Projects Matrix */}
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <label className="form-label">{t.rules.injectedProjectsTitle}</label>
                  <button
                    type="button"
                    className="btn btn--capsule btn--sm"
                    onClick={handleAddProject}
                  >
                    <Plus size={11} /> {t.rules.addProjectBtn}
                  </button>
                </div>

                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '8px',
                    background: 'var(--bg-glass-subtle)',
                    padding: '8px',
                  }}
                >
                  {projects.length === 0 ? (
                    <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                      {t.rules.noProjects}
                    </div>
                  ) : (
                    projects.map((proj) => {
                      return (
                        <ProjectRuleMatrixRow
                          key={proj.id}
                          project={proj}
                          ruleId={selectedRuleId}
                          onToggle={() => (selectedRuleId ? handleToggleProject(proj.path, selectedRuleId) : Promise.resolve(false))}
                        />
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Project Rules Configuration Mode */
          <div className="detail-stage-wrap" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
            {/* Project Switcher Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--border-subtle)',
                marginBottom: '16px',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  {projects.find((p) => p.path === selectedProjectPath)?.name || '未选择项目'}
                </h3>
                <p className="font-mono" style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {selectedProjectPath || '请先在左侧选择或添加项目'}
                </p>
              </div>

              {selectedProjectPath && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn--capsule btn--sm"
                    onClick={() => window.workflowSkill?.openPathInFinder?.(selectedProjectPath)}
                  >
                    <ExternalLink size={12} /> 在访达中打开
                  </button>
                  <button
                    type="button"
                    className="btn btn--capsule btn--danger btn--sm"
                    onClick={() => handleRemoveProject(selectedProjectPath)}
                  >
                    <Trash2 size={12} /> {t.rules.removeProjectBtn}
                  </button>
                </div>
              )}
            </div>

            {selectedProjectPath ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* Card 1: CLAUDE.md Helper */}
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '8px',
                    background: 'var(--bg-glass-subtle)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Link size={15} />
                        <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{t.rules.claudeLinkTitle}</span>
                        {claudeStatus?.isCorrect ? (
                          <span className="badge badge--success" style={{ fontSize: '0.6875rem' }}>
                            <CheckCircle2 size={11} style={{ marginRight: '4px' }} />
                            {t.rules.claudeLinkedBadge}
                          </span>
                        ) : claudeStatus?.conflict ? (
                          <span className="badge badge--danger" style={{ fontSize: '0.6875rem' }}>
                            <AlertCircle size={11} style={{ marginRight: '4px' }} />
                            {t.rules.claudeConflictBadge}
                          </span>
                        ) : (
                          <span className="badge badge--neutral" style={{ fontSize: '0.6875rem' }}>
                            {t.rules.claudeMissingBadge}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '4px 0 0 0', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        {t.rules.claudeLinkDesc}
                      </p>
                      {claudeStatus?.reason && (
                        <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: claudeStatus.conflict ? 'var(--danger)' : 'var(--text-muted)' }}>
                          {claudeStatus.reason}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      className="btn btn--capsule btn--primary"
                      onClick={handleCreateClaudeLink}
                      disabled={claudeOperating || Boolean(claudeStatus?.isCorrect)}
                    >
                      {claudeOperating ? '处理中…' : t.rules.createClaudeLinkBtn}
                    </button>
                  </div>
                </div>

                {/* Card 2: Rule Selection and Ordering */}
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '8px',
                    background: 'var(--bg-glass-subtle)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{t.rules.projectRulesTitle}</span>
                      <p style={{ margin: '2px 0 0 0', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
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
                          style={{ fontSize: '0.6875rem' }}
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
                        disabled={projectSaving}
                      >
                        <RefreshCw size={12} className={projectSaving ? 'spin' : ''} />
                        {projectSaving ? '同步中…' : t.rules.saveAndSyncBtn}
                      </button>
                    </div>
                  </div>

                  {rules.length === 0 ? (
                    <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
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
                              background: 'var(--bg-glass-active)',
                              border: '1px solid var(--border-focus)',
                            }}
                          >
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 1 }}>
                              <input
                                type="checkbox"
                                checked={true}
                                onChange={() => handleToggleProjectRuleItem(rule.id)}
                              />
                              <div>
                                <span style={{ fontWeight: 500, fontSize: '0.8125rem' }}>{rule.name}</span>
                                <span style={{ marginLeft: '8px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
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
                              background: 'var(--bg-glass-subtle)',
                              border: '1px solid var(--border-subtle)',
                              opacity: 0.8,
                            }}
                          >
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flex: 1 }}>
                              <input
                                type="checkbox"
                                checked={false}
                                onChange={() => handleToggleProjectRuleItem(rule.id)}
                              />
                              <span style={{ fontSize: '0.8125rem' }}>{rule.name}</span>
                            </label>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* Card 3: Preview */}
                <div
                  style={{
                    padding: '14px',
                    borderRadius: '8px',
                    background: 'var(--bg-glass-subtle)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <label className="form-label" style={{ marginBottom: '8px', display: 'block' }}>
                    {t.rules.previewTitle}
                  </label>
                  <textarea
                    className="mcp-textarea font-mono"
                    readOnly
                    style={{
                      width: '100%',
                      height: '180px',
                      resize: 'none',
                      lineHeight: '1.5',
                      fontSize: '0.75rem',
                      padding: '10px',
                      borderRadius: '6px',
                      background: 'var(--bg-canvas-subtle)',
                    }}
                    value={previewContent}
                  />
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
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
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ overflow: 'hidden', marginRight: '8px' }}>
        <div style={{ fontWeight: 500, fontSize: '0.8125rem' }}>{project.name}</div>
        <div className="font-mono" style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
          {project.path}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        {injected ? (
          <span
            className={`badge ${status === 'synced' ? 'badge--success' : status === 'failed' ? 'badge--danger' : 'badge--neutral'}`}
            style={{ fontSize: '0.6875rem' }}
          >
            {status === 'synced' ? '已注入 (已同步)' : status === 'failed' ? '同步失败' : '已注入 (待同步)'}
          </span>
        ) : (
          <span className="badge badge--neutral" style={{ fontSize: '0.6875rem' }}>
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
