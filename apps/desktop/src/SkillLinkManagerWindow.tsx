import { useEffect, useState } from 'react'
import {
  Check,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Globe,
  Link2,
  Plus,
  RefreshCw,
  Unlink,
} from 'lucide-react'
import { DEFAULT_AI_TOOLS, type AIProjectItem, type AIToolTarget, type Skill } from '@workflow-skill/workflow-model'
import { AIToolLogo } from './AIToolLogo'

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

export function SkillLinkManagerWindow() {
  const [skillId, setSkillId] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    const hash = window.location.hash
    const match = hash.match(/skillId=([^&]+)/)
    return match ? decodeURIComponent(match[1]) : ''
  })

  const [activeTab, setActiveTab] = useState<'global' | 'projects'>('global')
  const [skills, setSkills] = useState<Skill[]>([])
  const [aiTools, setAiTools] = useState<AIToolTarget[]>(DEFAULT_AI_TOOLS)
  const [projects, setProjects] = useState<AIProjectItem[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  // 1. Sync and apply system/app theme
  useEffect(() => {
    const applyTheme = (theme: 'dark' | 'light') => {
      if (document.documentElement) document.documentElement.dataset.theme = theme
      if (document.body) document.body.dataset.theme = theme
    }

    const detectTheme = () => {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      applyTheme(isDark ? 'dark' : 'light')
    }

    if (window.workflowSkill?.getSystemTheme) {
      window.workflowSkill.getSystemTheme().then(applyTheme).catch(detectTheme)
    } else {
      detectTheme()
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMediaChange = (e: MediaQueryListEvent) => {
      applyTheme(e.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', handleMediaChange)
    return () => media.removeEventListener('change', handleMediaChange)
  }, [])

  // 2. Listen for IPC skill change when window is already open
  useEffect(() => {
    if (window.workflowSkill?.onLinkWindowSkillChange) {
      return window.workflowSkill.onLinkWindowSkillChange((newSkillId) => {
        setSkillId(newSkillId)
      })
    }
  }, [])

  // 3. Auto clear toast
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(t)
  }, [toast])

  // 4. Load skills, global tools & scanned AI projects
  const reloadData = async () => {
    if (window.workflowSkill?.getAITools) {
      try {
        const detected = await window.workflowSkill.getAITools()
        if (Array.isArray(detected) && detected.length > 0) {
          setAiTools(detected)
        }
      } catch {}
    }

    if (window.workflowSkill?.getAIProjects) {
      try {
        const projList = await window.workflowSkill.getAIProjects()
        if (Array.isArray(projList)) {
          setProjects(projList)
        }
      } catch {}
    }

    if (window.workflowSkill?.loadLocalSkills) {
      try {
        const loaded = await window.workflowSkill.loadLocalSkills()
        if (Array.isArray(loaded)) {
          setSkills(loaded)
        }
      } catch {}
    }
  }

  useEffect(() => {
    void reloadData()
  }, [skillId])

  const currentSkill = skills.find((s) => s.id === skillId)
  const targetTools = currentSkill?.targetTools || []
  const targetProjects = currentSkill?.targetProjects || []

  // Filter global tools
  const globalTools = aiTools.filter((t) => (t.scope === 'global' || !t.scope) && t.installed !== false)

  // Toggle Global AI Tool Target
  const handleToggleGlobalTarget = async (tool: AIToolTarget) => {
    if (!currentSkill || busy) return
    const isCurrentlyLinked = targetTools.includes(tool.id)
    const displayName = getAIToolDisplayName(tool)

    setBusy(true)
    try {
      if (isCurrentlyLinked) {
        if (window.workflowSkill?.unlinkSkillTarget) {
          await window.workflowSkill.unlinkSkillTarget(currentSkill.id, tool.id)
        }
        setSkills((prev) =>
          prev.map((s) =>
            s.id === currentSkill.id
              ? { ...s, targetTools: (s.targetTools || []).filter((id) => id !== tool.id) }
              : s,
          ),
        )
        setToast(`已从 ${displayName} 取消软链接`)
      } else {
        if (window.workflowSkill?.linkSkillTarget) {
          await window.workflowSkill.linkSkillTarget(currentSkill.id, tool.id)
        }
        setSkills((prev) =>
          prev.map((s) =>
            s.id === currentSkill.id
              ? { ...s, targetTools: Array.from(new Set([...(s.targetTools || []), tool.id])) }
              : s,
          ),
        )
        setToast(`已成功软链接到 ${displayName}`)
      }
    } finally {
      setBusy(false)
    }
  }

  // Toggle Project Target
  const handleToggleProjectTarget = async (proj: AIProjectItem) => {
    if (!currentSkill || busy) return
    const isCurrentlyLinked = targetProjects.includes(proj.path)

    setBusy(true)
    try {
      if (isCurrentlyLinked) {
        if (window.workflowSkill?.unlinkSkillProject) {
          await window.workflowSkill.unlinkSkillProject(currentSkill.id, proj.path)
        }
        setSkills((prev) =>
          prev.map((s) =>
            s.id === currentSkill.id
              ? { ...s, targetProjects: (s.targetProjects || []).filter((p) => p !== proj.path) }
              : s,
          ),
        )
        setToast(`已从项目 ${proj.name} 取消软链接`)
      } else {
        if (window.workflowSkill?.linkSkillProject) {
          await window.workflowSkill.linkSkillProject(currentSkill.id, proj.path)
        }
        setSkills((prev) =>
          prev.map((s) =>
            s.id === currentSkill.id
              ? { ...s, targetProjects: Array.from(new Set([...(s.targetProjects || []), proj.path])) }
              : s,
          ),
        )
        setToast(`已成功软链接到项目 ${proj.name}`)
      }
    } finally {
      setBusy(false)
    }
  }

  // Add custom project folder
  const handleAddCustomProject = async () => {
    if (window.workflowSkill?.selectCustomProject) {
      try {
        const added = await window.workflowSkill.selectCustomProject()
        if (added) {
          setProjects((prev) => {
            if (prev.some((p) => p.path === added.path)) return prev
            return [added, ...prev]
          })
          if (currentSkill && window.workflowSkill?.linkSkillProject) {
            await window.workflowSkill.linkSkillProject(currentSkill.id, added.path)
            setSkills((prev) =>
              prev.map((s) =>
                s.id === currentSkill.id
                  ? { ...s, targetProjects: Array.from(new Set([...(s.targetProjects || []), added.path])) }
                  : s,
              ),
            )
            setToast(`已添加并软链接到 ${added.name}`)
          }
        }
      } catch {}
    }
  }

  const handleClose = () => {
    if (window.workflowSkill?.closeSkillLinkWindow) {
      void window.workflowSkill.closeSkillLinkWindow()
    } else {
      window.close()
    }
  }

  if (!currentSkill) {
    return (
      <div className="link-window-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center', color: 'var(--color-muted)' }}>
          <RefreshCw size={22} className="spin-slow" style={{ margin: '0 auto 8px auto', color: 'var(--color-accent)' }} />
          <p style={{ fontSize: '0.8125rem' }}>正在加载 Skill 分发数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="link-window-shell">
      {/* Native macOS Window Titlebar: Clean Skill Name */}
      <div className="link-window-titlebar">
        <div className="titlebar-drag-region" />
        <div className="titlebar-center">
          <Link2 size={13} style={{ color: 'var(--color-accent)' }} />
          <span className="titlebar-title">{currentSkill.name}</span>
        </div>
      </div>

      {/* Segmented Switcher: 全局 / 项目 */}
      <div className="link-window-nav-bar">
        <div className="master-tab-segmented">
          <button
            type="button"
            className={`master-tab-btn ${activeTab === 'global' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('global')}
            style={{ minWidth: '72px' }}
          >
            全局
          </button>
          <button
            type="button"
            className={`master-tab-btn ${activeTab === 'projects' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('projects')}
            style={{ minWidth: '72px' }}
          >
            项目
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="env-tree-body" style={{ flex: 1, maxHeight: 'none', padding: '10px 14px' }}>
        {activeTab === 'global' ? (
          /* List 1: Installed AI Global Environments */
          <div className="env-clean-list">
            {globalTools.map((tool) => {
              const isLinked = targetTools.includes(tool.id)
              const displayName = getAIToolDisplayName(tool)

              return (
                <div
                  key={tool.id}
                  className={`env-clean-row ${isLinked ? 'is-linked' : ''}`}
                  onClick={() => void handleToggleGlobalTarget(tool)}
                >
                  <div className="env-row-left">
                    <div className="master-item-logo">
                      <AIToolLogo toolId={tool.id} size={16} />
                    </div>
                    <div className="env-row-text">
                      <span className="env-row-title">{displayName}</span>
                      <span className="env-row-path font-mono">
                        {tool.detectedPath || tool.defaultDir}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className={`btn btn--capsule btn--sm ${isLinked ? 'btn--secondary' : 'btn--primary'}`}
                    style={{ pointerEvents: 'none', height: '22px', fontSize: '0.6875rem', padding: '0 10px', flexShrink: 0 }}
                  >
                    {isLinked ? <Unlink size={11} /> : <Link2 size={11} />}
                    <span>{isLinked ? '清除链接' : '创建链接'}</span>
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          /* List 2: AI Opened / Recent Projects */
          <div className="env-clean-list">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: '4px', padding: '0 4px' }}>
              <button
                type="button"
                className="btn btn--capsule btn--capsule-ghost btn--sm"
                onClick={() => void handleAddCustomProject()}
                title="选择本地项目工作区目录软链接"
              >
                <Plus size={12} />
                <span>添加项目目录</span>
              </button>
            </div>

            {projects.length > 0 ? (
              projects.map((proj) => {
                const isLinked = targetProjects.includes(proj.path)

                return (
                  <div
                    key={proj.path}
                    className={`env-clean-row ${isLinked ? 'is-linked' : ''}`}
                    onClick={() => void handleToggleProjectTarget(proj)}
                  >
                    <div className="env-row-left">
                      <div className="master-item-logo">
                        <Folder size={15} style={{ color: isLinked ? 'var(--color-accent)' : 'var(--color-muted)' }} />
                      </div>
                      <div className="env-row-text">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="env-row-title">{proj.name}</span>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            {proj.sources.map((src) => {
                              const s = src.toLowerCase()
                              const toolId = s.includes('cursor')
                                ? 'cursor'
                                : s.includes('claude')
                                ? 'claude'
                                : s.includes('antigravity') || s.includes('gemini')
                                ? 'antigravity'
                                : s.includes('trae')
                                ? 'trae'
                                : s.includes('code') || s.includes('vscode')
                                ? 'vscode'
                                : s.includes('windsurf')
                                ? 'windsurf'
                                : 'agents'

                              return (
                                <span
                                  key={src}
                                  className="env-source-logo-chip"
                                  title={`在 ${src} 中打开过`}
                                >
                                  <AIToolLogo toolId={toolId} size={12} />
                                </span>
                              )
                            })}
                          </div>
                        </div>
                        <span className="env-row-path font-mono">
                          {proj.skillDir}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`btn btn--capsule btn--sm ${isLinked ? 'btn--secondary' : 'btn--primary'}`}
                      style={{ pointerEvents: 'none', height: '22px', fontSize: '0.6875rem', padding: '0 10px', flexShrink: 0 }}
                    >
                      {isLinked ? <Unlink size={11} /> : <Link2 size={11} />}
                      <span>{isLinked ? '清除链接' : '创建链接'}</span>
                    </button>
                  </div>
                )
              })
            ) : (
              <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--color-muted)' }}>
                <FolderOpen size={24} style={{ margin: '0 auto 8px auto', opacity: 0.5 }} />
                <p style={{ fontSize: '0.8125rem', margin: 0 }}>暂未扫描到 AI 打开的项目</p>
                <button
                  type="button"
                  className="btn btn--primary btn--capsule btn--sm"
                  style={{ marginTop: '12px' }}
                  onClick={() => void handleAddCustomProject()}
                >
                  <Plus size={12} />
                  <span>添加项目目录</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialog Footer: Clean & Minimal */}
      <div className="dialog-footer-row env-tree-dialog-footer">
        <div />
        <button type="button" className="btn btn--primary btn--capsule btn--sm" onClick={handleClose}>
          <span>完成</span>
        </button>
      </div>

      {/* Floating Mini Toast */}
      {toast ? (
        <div className="app-capsule-toast toast-enter" style={{ bottom: '16px', right: '16px' }}>
          <span>{toast}</span>
        </div>
      ) : null}
    </div>
  )
}
