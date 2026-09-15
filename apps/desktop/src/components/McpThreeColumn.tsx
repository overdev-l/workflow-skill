import { useUpdateBlocker } from './AppUpdate'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Folder,
  FolderPlus,
  Layers,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Trash2,
  X,
} from 'lucide-react'
import type {
  BatchItemResult,
  CentralMCPServer,
  MCPScope,
  MCPServerInput,
  MCPSourceTool,
  MCPTargetAssociation,
  MCPTransportType,
  ProjectRecord,
} from '@workflow-skill/workflow-model'
import { MCP_SOURCE_TOOLS } from '@workflow-skill/workflow-model'
import { AIToolLogo } from '../AIToolLogo'
import { useI18n } from '../i18n'
import '../mcp.css'

interface KeyValuePair {
  key: string
  value: string
}

const TOOL_NAMES: Record<MCPSourceTool, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini',
  codex: 'Codex',
}

// Tool protocol compatibility
const TOOL_TRANSPORT_SUPPORT: Record<MCPSourceTool, MCPTransportType[]> = {
  'claude-code': ['stdio', 'sse', 'http'],
  cursor: ['stdio', 'sse'],
  gemini: ['stdio', 'sse'],
  codex: ['stdio', 'sse', 'http'],
}

// Tools supporting project-scope configs
const PROJECT_SUPPORTED_TOOLS: MCPSourceTool[] = ['claude-code', 'cursor', 'codex']

interface FormBaseline {
  serverId: string
  transport: MCPTransportType
  command: string
  args: string[]
  cwd: string
  envPairs: KeyValuePair[]
  url: string
  headerPairs: KeyValuePair[]
  envHeaderPairs: KeyValuePair[]
}

type PendingNavigationAction =
  | { type: 'switch_scope'; scope: 'all' | 'global' | 'project' }
  | { type: 'switch_row'; serverId: string }
  | { type: 'change_query'; query: string }
  | { type: 'open_create' }

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function areKeyValuePairsEqual(a: KeyValuePair[], b: KeyValuePair[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].value !== b[i].value) return false
  }
  return true
}

function normalizePath(p?: string): string {
  if (!p) return ''
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function McpThreeColumn({
  notify,
}: {
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()

  const [activeScopeTab, setActiveScopeTab] = useState<'all' | 'global' | 'project'>('all')
  const [query, setQuery] = useState('')
  const [centralServers, setCentralServers] = useState<CentralMCPServer[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('')

  // Target operating states
  const [targetOperating, setTargetOperating] = useState<Record<string, boolean>>({})

  // Editor Form State
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formTransport, setFormTransport] = useState<MCPTransportType>('stdio')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState<string[]>([])
  const [formCwd, setFormCwd] = useState('')
  const [formEnvPairs, setFormEnvPairs] = useState<KeyValuePair[]>([])
  const [formUrl, setFormUrl] = useState('')
  const [formHeaderPairs, setFormHeaderPairs] = useState<KeyValuePair[]>([])
  const [formEnvHeaderPairs, setFormEnvHeaderPairs] = useState<KeyValuePair[]>([])
  const [formSaving, setFormSaving] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [formBaseline, setFormBaseline] = useState<FormBaseline | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const lastLoadedIdRef = useRef<string | null>(null)

  // Unsaved Changes Confirmation State
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingNavigationAction | null>(null)

  // Create Modal State
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newTransport, setNewTransport] = useState<MCPTransportType>('stdio')
  const [newCommand, setNewCommand] = useState('')
  const [newArgs, setNewArgs] = useState<string[]>([])
  const [newUrl, setNewUrl] = useState('')
  const [createSaving, setCreateSaving] = useState(false)

  // Delete Confirm State
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isBusy = formSaving || toggling || deleting || loading || createSaving

  // 1. Load Central Servers & Projects
  const loadCentralServers = async () => {
    if (!window.workflowSkill?.listCentralMCPServers) return
    setLoading(true)
    setLoadError(null)
    try {
      const data = await window.workflowSkill.listCentralMCPServers()
      setCentralServers(data || [])
      setLoadError(null)
    } catch (err) {
      const msg = (err as Error).message
      setLoadError(msg)
      notify?.(msg)
    } finally {
      setLoading(false)
    }
  }

  const loadProjects = async () => {
    if (!window.workflowSkill?.listProjects) return
    try {
      const list = await window.workflowSkill.listProjects()
      setProjects(list || [])
      if (list && list.length > 0 && !selectedProjectPath) {
        if (window.workflowSkill.getActiveProject) {
          const active = await window.workflowSkill.getActiveProject()
          setSelectedProjectPath(active ? active.path : list[0].path)
        } else {
          setSelectedProjectPath(list[0].path)
        }
      }
    } catch {}
  }

  const handleAddProject = async () => {
    if (!window.workflowSkill?.addProject) return
    try {
      const res = await window.workflowSkill.addProject()
      if (res.success && res.project) {
        await loadProjects()
        setSelectedProjectPath(res.project.path)
        notify?.(`已添加项目: ${res.project.name}`)
      }
    } catch (err: any) {
      notify?.(`添加项目失败: ${err.message}`)
    }
  }

  useEffect(() => {
    void loadCentralServers()
    void loadProjects()
  }, [])

  // Listen for MCP and project configuration changes broadcast from main process
  useEffect(() => {
    const unbindMCP = window.workflowSkill?.onMCPChanged?.(() => {
      void loadCentralServers()
    })
    const unbindProjects = window.workflowSkill?.onProjectsChanged?.(() => {
      void loadProjects()
      void loadCentralServers()
    })
    return () => {
      unbindMCP?.()
      unbindProjects?.()
    }
  }, [])

  useUpdateBlocker('mcp-actions', createModalOpen || createSaving || formSaving || toggling || deleting)

  // Dirty detection for editable fields
  const isDirty = useMemo(() => {
    if (!formBaseline || !selectedServerId) return false
    if (formBaseline.serverId !== selectedServerId) return false
    if (formTransport !== formBaseline.transport) return true

    if (formTransport === 'stdio') {
      if (formCommand !== formBaseline.command) return true
      if (formCwd !== formBaseline.cwd) return true
      if (!areStringArraysEqual(formArgs, formBaseline.args)) return true
      if (!areKeyValuePairsEqual(formEnvPairs, formBaseline.envPairs)) return true
    } else {
      if (formUrl !== formBaseline.url) return true
      if (!areKeyValuePairsEqual(formHeaderPairs, formBaseline.headerPairs)) return true
      if (!areKeyValuePairsEqual(formEnvHeaderPairs, formBaseline.envHeaderPairs)) return true
    }

    return false
  }, [
    formBaseline,
    selectedServerId,
    formTransport,
    formCommand,
    formCwd,
    formArgs,
    formEnvPairs,
    formUrl,
    formHeaderPairs,
    formEnvHeaderPairs,
  ])
  useUpdateBlocker('mcp-editor', isDirty)

  // Filtered servers by scope tab and search query
  const filteredServers = useMemo(() => {
    let list = centralServers

    if (activeScopeTab === 'global') {
      list = list.filter((s) => (s.targetAssociations || []).some((a) => a.scope === 'global'))
    } else if (activeScopeTab === 'project') {
      list = list.filter((s) => (s.targetAssociations || []).some((a) => a.scope === 'project'))
    }

    const q = query.trim().toLowerCase()
    if (!q) return list

    return list.filter((s) => {
      const name = (s.name || '').toLowerCase()
      const desc = (s.description || '').toLowerCase()
      const transport = (s.transport || '').toLowerCase()
      const cmd = (s.command || '').toLowerCase()
      const url = (s.url || '').toLowerCase()
      return (
        name.includes(q) ||
        desc.includes(q) ||
        transport.includes(q) ||
        cmd.includes(q) ||
        url.includes(q)
      )
    })
  }, [centralServers, activeScopeTab, query])

  // Active Selected Server
  const selectedServer = useMemo(() => {
    if (filteredServers.length === 0) return null
    if (!selectedServerId) return filteredServers[0]
    return filteredServers.find((s) => s.id === selectedServerId) || null
  }, [filteredServers, selectedServerId])

  // Synchronize selectedServerId
  useEffect(() => {
    if (loading || createSaving) return
    if (filteredServers.length === 0) {
      if (selectedServerId !== null) setSelectedServerId(null)
      return
    }
    const exists = filteredServers.some((s) => s.id === selectedServerId)
    if (!exists) {
      setSelectedServerId(filteredServers[0].id)
    }
  }, [filteredServers, selectedServerId, loading, createSaving])

  // Populate editor form when active server changes
  useEffect(() => {
    if (!selectedServer) {
      lastLoadedIdRef.current = null
      setFormBaseline(null)
      return
    }
    if (lastLoadedIdRef.current === selectedServer.id) {
      return
    }
    lastLoadedIdRef.current = selectedServer.id

    setFormName(selectedServer.name)
    setFormDescription(selectedServer.description || '')
    setFormTransport(selectedServer.transport)
    setFormCommand(selectedServer.command || '')
    const args = selectedServer.args ? [...selectedServer.args] : []
    setFormArgs(args)
    setFormCwd(selectedServer.cwd || '')
    setFormUrl(selectedServer.url || '')

    const envPairs = selectedServer.env
      ? Object.entries(selectedServer.env).map(([k, v]) => ({ key: k, value: v }))
      : []
    setFormEnvPairs(envPairs)

    const headerPairs = selectedServer.headers
      ? Object.entries(selectedServer.headers).map(([k, v]) => ({ key: k, value: v }))
      : []
    setFormHeaderPairs(headerPairs)

    const envHeaderPairs = selectedServer.envHeaders
      ? Object.entries(selectedServer.envHeaders).map(([k, v]) => ({ key: k, value: v }))
      : []
    setFormEnvHeaderPairs(envHeaderPairs)

    setFormBaseline({
      serverId: selectedServer.id,
      transport: selectedServer.transport,
      command: selectedServer.command || '',
      args,
      cwd: selectedServer.cwd || '',
      envPairs,
      url: selectedServer.url || '',
      headerPairs,
      envHeaderPairs,
    })
  }, [selectedServer])

  // Convert pairs to record with duplicate key detection
  const pairsToRecord = (pairs: KeyValuePair[]): { record: Record<string, string>; hasDuplicates: boolean } => {
    const record: Record<string, string> = {}
    const seen = new Set<string>()
    let hasDuplicates = false
    for (const p of pairs) {
      const k = p.key.trim()
      if (!k) continue
      if (seen.has(k)) {
        hasDuplicates = true
      }
      seen.add(k)
      record[k] = p.value
    }
    return { record, hasDuplicates }
  }

  // Navigation handlers with unsaved guard
  const handleSwitchScope = (newScope: 'all' | 'global' | 'project') => {
    if (isBusy || newScope === activeScopeTab) return
    if (isDirty) {
      setPendingAction({ type: 'switch_scope', scope: newScope })
      setUnsavedModalOpen(true)
      return
    }
    setActiveScopeTab(newScope)
    lastLoadedIdRef.current = null
  }

  const handleSelectRow = (serverId: string) => {
    if (isBusy || serverId === selectedServer?.id) return
    if (isDirty) {
      setPendingAction({ type: 'switch_row', serverId })
      setUnsavedModalOpen(true)
      return
    }
    setSelectedServerId(serverId)
    lastLoadedIdRef.current = null
  }

  const handleQueryChange = (newQuery: string) => {
    if (isBusy) return
    if (isDirty && selectedServer) {
      const q = newQuery.trim().toLowerCase()
      const matches = !q || (selectedServer.name && selectedServer.name.toLowerCase().includes(q))
      if (!matches) {
        setPendingAction({ type: 'change_query', query: newQuery })
        setUnsavedModalOpen(true)
        return
      }
    }
    setQuery(newQuery)
  }

  const handleOpenCreate = () => {
    if (isBusy) return
    if (isDirty) {
      setPendingAction({ type: 'open_create' })
      setUnsavedModalOpen(true)
      return
    }
    setNewName('')
    setNewDescription('')
    setNewTransport('stdio')
    setNewCommand('')
    setNewArgs([])
    setNewUrl('')
    setCreateModalOpen(true)
  }

  const handleConfirmDiscard = () => {
    setUnsavedModalOpen(false)
    const action = pendingAction
    setPendingAction(null)
    if (!action) return

    if (action.type === 'switch_scope') {
      setActiveScopeTab(action.scope)
      lastLoadedIdRef.current = null
    } else if (action.type === 'switch_row') {
      setSelectedServerId(action.serverId)
      lastLoadedIdRef.current = null
    } else if (action.type === 'change_query') {
      setQuery(action.query)
    } else if (action.type === 'open_create') {
      setNewName('')
      setNewDescription('')
      setNewTransport('stdio')
      setNewCommand('')
      setNewArgs([])
      setNewUrl('')
      setCreateModalOpen(true)
    }
  }

  // 2. Save Central Server
  const handleSave = async () => {
    if (!selectedServer || !window.workflowSkill?.saveCentralMCPServer) return
    const envRes = pairsToRecord(formEnvPairs)
    const headerRes = pairsToRecord(formHeaderPairs)
    const envHeaderRes = pairsToRecord(formEnvHeaderPairs)

    if (envRes.hasDuplicates || headerRes.hasDuplicates || envHeaderRes.hasDuplicates) {
      notify?.(t.mcp.duplicateKeyWarning)
      return
    }

    setFormSaving(true)
    try {
      const input = {
        id: selectedServer.id,
        name: selectedServer.name,
        description: formDescription.trim() || undefined,
        transport: formTransport,
        command: formTransport === 'stdio' ? formCommand.trim() : undefined,
        args: formTransport === 'stdio' ? formArgs : undefined,
        cwd: formTransport === 'stdio' && formCwd.trim() ? formCwd.trim() : undefined,
        env: formTransport === 'stdio' ? envRes.record : undefined,
        url: formTransport !== 'stdio' ? formUrl.trim() : undefined,
        headers: formTransport !== 'stdio' ? headerRes.record : undefined,
        envHeaders: formTransport !== 'stdio' ? envHeaderRes.record : undefined,
        enabled: selectedServer.enabled,
        targetAssociations: selectedServer.targetAssociations,
      }

      const res = await window.workflowSkill.saveCentralMCPServer(input)

      if (res.success) {
        notify?.(t.mcp.savedToast(input.name))
        setFormBaseline({
          serverId: selectedServer.id,
          transport: formTransport,
          command: formTransport === 'stdio' ? formCommand : '',
          args: formTransport === 'stdio' ? [...formArgs] : [],
          cwd: formTransport === 'stdio' ? formCwd : '',
          envPairs: formTransport === 'stdio' ? [...formEnvPairs] : [],
          url: formTransport !== 'stdio' ? formUrl : '',
          headerPairs: formTransport !== 'stdio' ? [...formHeaderPairs] : [],
          envHeaderPairs: formTransport !== 'stdio' ? [...formEnvHeaderPairs] : [],
        })
        await loadCentralServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setFormSaving(false)
    }
  }

  // 3. Toggle Server Enabled State
  const handleToggleEnable = async () => {
    if (!selectedServer || !window.workflowSkill?.saveCentralMCPServer) return
    const nextState = !selectedServer.enabled
    setToggling(true)
    try {
      const res = await window.workflowSkill.saveCentralMCPServer({
        ...selectedServer,
        enabled: nextState,
      })
      if (res.success) {
        notify?.(nextState ? t.mcp.enabledToast(selectedServer.name) : t.mcp.disabledToast(selectedServer.name))
        await loadCentralServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setToggling(false)
    }
  }

  // 4. Delete Central Server (Truthful failure inspection)
  const handleDelete = async () => {
    if (!selectedServer || !window.workflowSkill?.deleteCentralMCPServer) return
    setDeleting(true)
    try {
      const res = await window.workflowSkill.deleteCentralMCPServer(selectedServer.id)
      if (res.success) {
        notify?.(t.mcp.deletedToast(selectedServer.name))
        setDeleteConfirmOpen(false)
        setSelectedServerId(null)
        setFormBaseline(null)
        lastLoadedIdRef.current = null
        await loadCentralServers()
      } else {
        const errDetail = res.targetErrors && res.targetErrors.length > 0
          ? `部分注入目标取消失败: ${res.targetErrors.map((e) => e.error).join('; ')}`
          : (res.error || t.mcp.operationFailed)
        notify?.(errDetail)
        await loadCentralServers()
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  // 5. Create Central Server
  const handleCreate = async () => {
    if (!newName.trim() || !window.workflowSkill?.saveCentralMCPServer) return
    setCreateSaving(true)
    try {
      const res = await window.workflowSkill.saveCentralMCPServer({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        transport: newTransport,
        command: newTransport === 'stdio' ? newCommand.trim() : undefined,
        args: newTransport === 'stdio' ? newArgs : undefined,
        url: newTransport !== 'stdio' ? newUrl.trim() : undefined,
        enabled: true,
      })

      if (res.success && res.server) {
        notify?.(t.mcp.savedToast(res.server.name))
        setCreateModalOpen(false)
        setNewName('')
        setNewDescription('')
        setNewCommand('')
        setNewArgs([])
        setNewUrl('')
        setSelectedServerId(res.server.id)
        setFormBaseline(null)
        lastLoadedIdRef.current = null
        await loadCentralServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setCreateSaving(false)
    }
  }

  // 6. Inject / Uninject to Target with Authoritative Feedback
  const handleInject = async (target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => {
    if (!selectedServer || !window.workflowSkill?.injectMCPServer) return
    const opKey = `${target.tool}:${target.scope}:${target.projectPath || ''}`
    setTargetOperating((prev) => ({ ...prev, [opKey]: true }))

    try {
      const res = await window.workflowSkill.injectMCPServer(selectedServer.id, target)
      if (res.success) {
        const targetLabel = target.scope === 'global' ? TOOL_NAMES[target.tool] : `${TOOL_NAMES[target.tool]} (项目)`
        notify?.(`已成功注入到 ${targetLabel}`)
        await loadCentralServers()
      } else {
        notify?.(res.error || `注入到 ${TOOL_NAMES[target.tool]} 失败`)
        await loadCentralServers()
      }
    } catch (err: any) {
      notify?.(`注入异常: ${err?.message || String(err)}`)
    } finally {
      setTargetOperating((prev) => ({ ...prev, [opKey]: false }))
    }
  }

  const handleUninject = async (target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }) => {
    if (!selectedServer || !window.workflowSkill?.uninjectMCPServer) return
    const opKey = `${target.tool}:${target.scope}:${target.projectPath || ''}`
    setTargetOperating((prev) => ({ ...prev, [opKey]: true }))

    try {
      const res = await window.workflowSkill.uninjectMCPServer(selectedServer.id, target)
      if (res.success) {
        const targetLabel = target.scope === 'global' ? TOOL_NAMES[target.tool] : `${TOOL_NAMES[target.tool]} (项目)`
        notify?.(`已从 ${targetLabel} 取消注入`)
        await loadCentralServers()
      } else {
        notify?.(res.error || `从 ${TOOL_NAMES[target.tool]} 取消注入失败`)
        await loadCentralServers()
      }
    } catch (err: any) {
      notify?.(`取消注入异常: ${err?.message || String(err)}`)
    } finally {
      setTargetOperating((prev) => ({ ...prev, [opKey]: false }))
    }
  }

  // Check target association state
  const getTargetAssociation = (tool: MCPSourceTool, scope: MCPScope, projectPath?: string): MCPTargetAssociation | undefined => {
    if (!selectedServer?.targetAssociations) return undefined
    const normTargetProj = normalizePath(projectPath)
    return selectedServer.targetAssociations.find((a) => {
      if (a.tool !== tool || a.scope !== scope) return false
      if (scope === 'project') {
        return normalizePath(a.projectPath) === normTargetProj
      }
      return true
    })
  }

  return (
    <>
      {/* =========================================================================
          Column 2: Master List (Width: 210px) - AGENTS.md §1.1
          ========================================================================= */}
      <aside className="app-col-master view-enter">
        <div className="master-header">
          {/* Scope Segmented Tabs: [ 全部 | 全局 | 项目 ] - Height: 24px */}
          <div className="master-header-top">
            <div
              role="tablist"
              aria-label="MCP 资产作用域"
              className="master-tab-segmented mcp-scope-segmented"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeScopeTab === 'all'}
                tabIndex={activeScopeTab === 'all' ? 0 : -1}
                className={`master-tab-btn ${activeScopeTab === 'all' ? 'is-active' : ''}`}
                onClick={() => handleSwitchScope('all')}
                disabled={isBusy}
              >
                <span>全部</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeScopeTab === 'global'}
                tabIndex={activeScopeTab === 'global' ? 0 : -1}
                className={`master-tab-btn ${activeScopeTab === 'global' ? 'is-active' : ''}`}
                onClick={() => handleSwitchScope('global')}
                disabled={isBusy}
              >
                <span>全局</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeScopeTab === 'project'}
                tabIndex={activeScopeTab === 'project' ? 0 : -1}
                className={`master-tab-btn ${activeScopeTab === 'project' ? 'is-active' : ''}`}
                onClick={() => handleSwitchScope('project')}
                disabled={isBusy}
              >
                <span>项目</span>
              </button>
            </div>
          </div>

          {/* Search Box - Height: 28px */}
          <div className="master-search-row">
            <label className="master-search-input">
              <Search size={13} />
              <input
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                placeholder={t.mcp.searchPlaceholder}
                disabled={isBusy}
              />
              {query ? (
                <button
                  type="button"
                  className="clear-search-btn"
                  onClick={() => handleQueryChange('')}
                  title={t.mcp.clearSearchBtn}
                  disabled={isBusy}
                >
                  <X size={12} />
                </button>
              ) : null}
            </label>
          </div>
        </div>

        {loadError && (
          <div
            className="mcp-load-error-banner"
            role="alert"
            style={{
              margin: '8px 10px',
              padding: '8px 10px',
              background: 'rgba(255, 69, 58, 0.12)',
              border: '1px solid rgba(255, 69, 58, 0.28)',
              borderRadius: '6px',
              fontSize: '11px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <span style={{ color: 'var(--color-danger, #ff453a)', wordBreak: 'break-word', lineHeight: '1.4' }}>
              {loadError}
            </span>
            <button
              type="button"
              className="btn btn--capsule btn--sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void loadCentralServers()}
            >
              {t.mcp.retryBtn}
            </button>
          </div>
        )}

        {/* Master List Scroll */}
        <div className="master-list-scroll">
          {filteredServers.length === 0 ? (
            <div className="master-list-status">
              <Server size={18} style={{ opacity: 0.6 }} />
              <span>
                {query
                  ? t.mcp.emptySearch
                  : activeScopeTab === 'global'
                  ? '暂无全局已注入的 MCP 资产'
                  : activeScopeTab === 'project'
                  ? '暂无项目已注入的 MCP 资产'
                  : '中央资产库暂无 MCP 服务'}
              </span>
              {query ? (
                <button
                  type="button"
                  className="btn btn--capsule-ghost btn--capsule btn--sm"
                  onClick={() => handleQueryChange('')}
                  disabled={isBusy}
                >
                  <span>{t.mcp.clearSearchBtn}</span>
                </button>
              ) : (
                <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', textAlign: 'center', margin: '4px 0 0' }}>
                  点击下方「新建 MCP Server」添加中央资产，随时一键分发到各个 AI 工具。
                </p>
              )}
            </div>
          ) : (
            filteredServers.map((server) => {
              const isSelected = selectedServer?.id === server.id
              const assocs = server.targetAssociations || []
              const hasError = assocs.some((a) => a.lastSyncStatus === 'failed')
              const injectedCount = assocs.length

              return (
                <button
                  type="button"
                  key={server.id}
                  className={`mcp-master-row master-item-row ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => handleSelectRow(server.id)}
                  disabled={isBusy}
                >
                  <div className="mcp-master-row__left">
                    <div className="mcp-master-row__logo">
                      <Layers size={15} style={{ color: 'var(--color-accent)' }} />
                    </div>
                    <div className="mcp-master-row__info">
                      <span className="mcp-master-row__name">{server.name}</span>
                      <div className="mcp-master-row__sub">
                        <span className="mcp-badge mcp-badge--transport">{server.transport}</span>
                        {hasError ? (
                          <span className="mcp-badge" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-ink)' }}>
                            同步失败
                          </span>
                        ) : injectedCount > 0 ? (
                          <span className="mcp-badge" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success-ink)' }}>
                            {injectedCount} 注入
                          </span>
                        ) : (
                          <span className="mcp-badge mcp-badge--disabled">未注入</span>
                        )}
                        {!server.enabled ? (
                          <span className="mcp-badge mcp-badge--disabled">{t.mcp.statusDisabled}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Bottom Action Bar: New Central Server Button (Height: 24px) */}
        <div className="mcp-master-action-bar">
          <button
            type="button"
            className="btn btn--capsule btn--sm"
            onClick={handleOpenCreate}
            disabled={isBusy}
          >
            <Plus size={12} />
            <span>{t.mcp.newServer}</span>
          </button>
        </div>
      </aside>

      {/* =========================================================================
          Column 3: Detail Stage (Width: minmax(0, 1fr)) - AGENTS.md §1.1
          ========================================================================= */}
      <section className="app-col-detail view-enter">
        {!selectedServer ? (
          <div className="detail-empty-wrap" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
            <Server size={32} style={{ color: 'var(--color-muted)', opacity: 0.5 }} />
            <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--color-ink)', margin: 0 }}>
              {query.trim()
                ? t.mcp.emptySearch
                : filteredServers.length === 0
                ? '暂无 MCP 资产'
                : t.mcp.emptyDetailTitle}
            </h2>
            <p style={{ fontSize: '0.8125rem', color: 'var(--color-muted)', maxWidth: 360, textAlign: 'center', margin: 0 }}>
              在左侧列表中选择一个 MCP 资产以编辑配置，或通过注入矩阵一键注入到全局 AI 宿主与工程项目。
            </p>
            <button
              type="button"
              className="btn btn--capsule"
              style={{ marginTop: 8 }}
              onClick={handleOpenCreate}
              disabled={isBusy}
            >
              <Plus size={13} />
              <span>{t.mcp.newServer}</span>
            </button>
          </div>
        ) : (
          <div className="mcp-detail-container">
            {/* Detail Hero Header */}
            <div className="mcp-hero-header">
              <div className="mcp-hero-left">
                <div className="mcp-hero-logo-box">
                  <Layers size={24} style={{ color: 'var(--color-accent)' }} />
                </div>
                <div className="mcp-hero-titles">
                  <div className="mcp-hero-title-row">
                    <h1 className="mcp-hero-name font-mono">{selectedServer.name}</h1>
                    <span className="pinned-ver-pill font-mono">{selectedServer.transport}</span>
                    <span className="pinned-ver-pill">
                      已注入 {(selectedServer.targetAssociations || []).length} 个目标
                    </span>
                    {!selectedServer.enabled ? (
                      <span className="mcp-badge mcp-badge--disabled">{t.mcp.statusDisabled}</span>
                    ) : (
                      <span className="mcp-badge" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success-ink)', border: '1px solid color-mix(in oklch, var(--color-success) 30%, transparent)' }}>
                        {t.mcp.statusActive}
                      </span>
                    )}
                  </div>
                  <div className="mcp-hero-subtitle font-mono">
                    <span>中央资产库标识: {selectedServer.id}</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons: Enable/Disable, Delete, Save (All 24px) */}
              <div className="mcp-hero-actions">
                <button
                  type="button"
                  className={`btn btn--capsule btn--sm ${selectedServer.enabled ? 'btn--capsule-ghost' : ''}`}
                  disabled={isBusy}
                  onClick={() => void handleToggleEnable()}
                  title={selectedServer.enabled ? t.mcp.disableBtn : t.mcp.enableBtn}
                >
                  {toggling ? <RefreshCw size={12} className="spin" /> : <Power size={12} />}
                  <span>{selectedServer.enabled ? t.mcp.disableBtn : t.mcp.enableBtn}</span>
                </button>

                <button
                  type="button"
                  className="btn btn--capsule-ghost btn--capsule btn--sm"
                  style={{ color: 'var(--color-danger-ink)' }}
                  disabled={isBusy}
                  onClick={() => setDeleteConfirmOpen(true)}
                  title={t.mcp.deleteBtn}
                >
                  {deleting ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
                  <span>{t.mcp.deleteBtn}</span>
                </button>

                <button
                  type="button"
                  className="btn btn--capsule btn--sm"
                  disabled={isBusy}
                  onClick={() => void handleSave()}
                >
                  {formSaving ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
                  <span>{formSaving ? t.mcp.savingBtn : t.mcp.saveBtn}</span>
                </button>
              </div>
            </div>

            {/* Restart Session Notice Banner */}
            <div className="mcp-notice-banner">
              <AlertCircle size={14} />
              <span>{t.mcp.restartNotice}</span>
            </div>

            {/* 1. Target Injection Matrix Card (OPC-56 Core) */}
            <div className="mcp-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <h3 className="mcp-card-title" style={{ margin: 0 }}>目标环境注入矩阵 (Target Injection Matrix)</h3>
                  <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', margin: '2px 0 0' }}>
                    集中分发并注入到全局 AI 宿主或特定工程项目中，修改中央定义会自动同步到所有已注入目标。
                  </p>
                </div>
              </div>

              {/* Sub-section: Global Tools */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>全局 AI 宿主环境</span>
                  <span className="branch-badge font-mono">
                    {(selectedServer.targetAssociations || []).filter((a) => a.scope === 'global').length}/{MCP_SOURCE_TOOLS.length}
                  </span>
                </div>

                <div className="mcp-dist-matrix">
                  {MCP_SOURCE_TOOLS.map((tool) => {
                    const assoc = getTargetAssociation(tool.id, 'global')
                    const isAssociated = Boolean(assoc)
                    const isSynced = assoc?.lastSyncStatus === 'synced'
                    const isFailed = assoc?.lastSyncStatus === 'failed'
                    const supportedTransports = TOOL_TRANSPORT_SUPPORT[tool.id] || []
                    const isCompatible = supportedTransports.includes(selectedServer.transport)
                    const opKey = `${tool.id}:global:`
                    const isOperating = Boolean(targetOperating[opKey])

                    let statusBadge = <span className="mcp-dist-status-badge is-none">未注入</span>
                    if (isFailed) {
                      statusBadge = (
                        <span
                          className="mcp-dist-status-badge is-diff"
                          style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-ink)', borderColor: 'color-mix(in oklch, var(--color-danger) 30%, transparent)' }}
                          title={assoc?.lastError || '同步写入目标失败'}
                        >
                          同步失败
                        </span>
                      )
                    } else if (isSynced) {
                      statusBadge = <span className="mcp-dist-status-badge is-synced">已注入</span>
                    }

                    return (
                      <div key={tool.id} className={`mcp-dist-card ${isAssociated ? 'is-current' : ''}`}>
                        <div className="mcp-dist-card__top">
                          <div className="mcp-dist-card__tool">
                            <AIToolLogo toolId={tool.id} size={18} color />
                            <span className="mcp-dist-card__name">{tool.name}</span>
                          </div>
                          {statusBadge}
                        </div>

                        <div className="mcp-dist-card__path">
                          {tool.globalConfigFileName}
                        </div>

                        {!isCompatible ? (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--color-muted)', fontStyle: 'italic', marginTop: 4 }}>
                            此宿主不支持 {selectedServer.transport} 传输
                          </div>
                        ) : isFailed && assoc?.lastError ? (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--color-danger-ink)', marginTop: 4, wordBreak: 'break-all' }}>
                            {assoc.lastError}
                          </div>
                        ) : null}

                        <div className="mcp-dist-card__footer">
                          {isAssociated ? (
                            <button
                              type="button"
                              className="btn btn--capsule-ghost btn--sm"
                              style={{ height: '22px', fontSize: '0.6875rem', color: 'var(--color-danger-ink)' }}
                              disabled={isOperating || isBusy}
                              onClick={() => void handleUninject({ tool: tool.id, scope: 'global' })}
                            >
                              {isOperating ? <RefreshCw size={10} className="spin" /> : <X size={10} />}
                              <span>取消注入</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--capsule btn--sm"
                              style={{ height: '22px', fontSize: '0.6875rem' }}
                              disabled={!isCompatible || isOperating || isBusy}
                              onClick={() => void handleInject({ tool: tool.id, scope: 'global' })}
                            >
                              {isOperating ? <RefreshCw size={10} className="spin" /> : <Plus size={10} />}
                              <span>注入</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Sub-section: Project Environments */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>工程项目环境</span>
                  </div>

                  {projects.length > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Folder size={12} style={{ color: 'var(--color-accent)' }} />
                      <select
                        value={selectedProjectPath}
                        onChange={(e) => setSelectedProjectPath(e.target.value)}
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.path}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--capsule-ghost btn--sm"
                        title="添加项目文件夹"
                        onClick={handleAddProject}
                      >
                        <FolderPlus size={11} />
                      </button>
                    </div>
                  ) : null}
                </div>

                {projects.length === 0 ? (
                  <div
                    style={{
                      padding: '12px',
                      background: 'var(--color-surface)',
                      border: '1px dashed var(--color-border)',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                      尚未登记工程项目。添加项目后即可将 MCP 服务注入到项目专有的 .mcp.json 等配置中。
                    </span>
                    <button
                      type="button"
                      className="btn btn--capsule btn--sm"
                      onClick={handleAddProject}
                    >
                      <FolderPlus size={12} />
                      <span>添加项目</span>
                    </button>
                  </div>
                ) : (
                  <div className="mcp-dist-matrix">
                    {PROJECT_SUPPORTED_TOOLS.map((toolId) => {
                      const tool = MCP_SOURCE_TOOLS.find((t) => t.id === toolId)!
                      const assoc = getTargetAssociation(toolId, 'project', selectedProjectPath)
                      const isAssociated = Boolean(assoc)
                      const isSynced = assoc?.lastSyncStatus === 'synced'
                      const isFailed = assoc?.lastSyncStatus === 'failed'
                      const supportedTransports = TOOL_TRANSPORT_SUPPORT[toolId] || []
                      const isCompatible = supportedTransports.includes(selectedServer.transport)
                      const opKey = `${toolId}:project:${selectedProjectPath}`
                      const isOperating = Boolean(targetOperating[opKey])

                      let statusBadge = <span className="mcp-dist-status-badge is-none">未注入</span>
                      if (isFailed) {
                        statusBadge = (
                          <span
                            className="mcp-dist-status-badge is-diff"
                            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-ink)', borderColor: 'color-mix(in oklch, var(--color-danger) 30%, transparent)' }}
                            title={assoc?.lastError || '同步写入项目配置失败'}
                          >
                            同步失败
                          </span>
                        )
                      } else if (isSynced) {
                        statusBadge = <span className="mcp-dist-status-badge is-synced">已注入</span>
                      }

                      return (
                        <div key={toolId} className={`mcp-dist-card ${isAssociated ? 'is-current' : ''}`}>
                          <div className="mcp-dist-card__top">
                            <div className="mcp-dist-card__tool">
                              <AIToolLogo toolId={toolId} size={18} color />
                              <span className="mcp-dist-card__name">{tool.name}</span>
                            </div>
                            {statusBadge}
                          </div>

                          <div className="mcp-dist-card__path font-mono">
                            {tool.projectConfigFileName}
                          </div>

                          {!isCompatible ? (
                            <div style={{ fontSize: '0.6875rem', color: 'var(--color-muted)', fontStyle: 'italic', marginTop: 4 }}>
                              此工具项目配置不支持 {selectedServer.transport}
                            </div>
                          ) : isFailed && assoc?.lastError ? (
                            <div style={{ fontSize: '0.6875rem', color: 'var(--color-danger-ink)', marginTop: 4, wordBreak: 'break-all' }}>
                              {assoc.lastError}
                            </div>
                          ) : null}

                          <div className="mcp-dist-card__footer">
                            {isAssociated ? (
                              <button
                                type="button"
                                className="btn btn--capsule-ghost btn--sm"
                                style={{ height: '22px', fontSize: '0.6875rem', color: 'var(--color-danger-ink)' }}
                                disabled={isOperating || isBusy}
                                onClick={() => void handleUninject({ tool: toolId, scope: 'project', projectPath: selectedProjectPath })}
                              >
                                {isOperating ? <RefreshCw size={10} className="spin" /> : <X size={10} />}
                                <span>取消注入</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn--capsule btn--sm"
                                style={{ height: '22px', fontSize: '0.6875rem' }}
                                disabled={!isCompatible || isOperating || isBusy}
                                onClick={() => void handleInject({ tool: toolId, scope: 'project', projectPath: selectedProjectPath })}
                              >
                                {isOperating ? <RefreshCw size={10} className="spin" /> : <Plus size={10} />}
                                <span>注入项目</span>
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* 2. Main Configuration Card */}
            <div className="mcp-card">
              <h3 className="mcp-card-title">
                <span>{t.mcp.configCardTitle}</span>
                <span className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                  {selectedServer.id}
                </span>
              </h3>

              <div className="mcp-form-grid">
                {/* Name - Immutable primary key for existing server */}
                <div className="mcp-form-field">
                  <label className="mcp-field-label">{t.mcp.serverNameLabel}</label>
                  <input
                    className="mcp-input font-mono"
                    value={formName}
                    readOnly
                    disabled
                    style={{ opacity: 0.7, cursor: 'not-allowed' }}
                    title={t.mcp.nameImmutableHint}
                  />
                  <span style={{ fontSize: '0.6875rem', color: 'var(--color-muted)', marginTop: 2 }}>
                    {t.mcp.nameImmutableHint}
                  </span>
                </div>

                {/* Description */}
                <div className="mcp-form-field">
                  <label className="mcp-field-label">服务描述 (可选)</label>
                  <input
                    className="mcp-input"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="描述该 MCP Server 的用途与提供的工具"
                  />
                </div>

                {/* Transport Selector (Segmented 24px) */}
                <div className="mcp-form-field">
                  <label className="mcp-field-label">{t.mcp.transportLabel}</label>
                  <div className="master-tab-segmented" style={{ width: 'fit-content' }}>
                    <button
                      type="button"
                      className={`master-tab-btn ${formTransport === 'stdio' ? 'is-active' : ''}`}
                      onClick={() => setFormTransport('stdio')}
                    >
                      <span>stdio</span>
                    </button>
                    <button
                      type="button"
                      className={`master-tab-btn ${formTransport === 'sse' ? 'is-active' : ''}`}
                      onClick={() => setFormTransport('sse')}
                    >
                      <span>sse</span>
                    </button>
                    <button
                      type="button"
                      className={`master-tab-btn ${formTransport === 'http' ? 'is-active' : ''}`}
                      onClick={() => setFormTransport('http')}
                    >
                      <span>http (streamable)</span>
                    </button>
                  </div>
                </div>

                {/* stdio fields */}
                {formTransport === 'stdio' ? (
                  <>
                    <div className="mcp-form-field">
                      <label className="mcp-field-label">{t.mcp.commandLabel}</label>
                      <input
                        className="mcp-input font-mono"
                        value={formCommand}
                        onChange={(e) => setFormCommand(e.target.value)}
                        placeholder={t.mcp.commandPlaceholder}
                      />
                    </div>

                    <div className="mcp-form-field">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <label className="mcp-field-label" style={{ margin: 0 }}>{t.mcp.argsLabel}</label>
                        <button
                          type="button"
                          className="btn btn--capsule-ghost btn--sm"
                          style={{ height: '22px', padding: '0 6px', fontSize: '0.6875rem' }}
                          onClick={() => setFormArgs([...formArgs, ''])}
                        >
                          <Plus size={10} />
                          <span>{t.mcp.addArgBtn}</span>
                        </button>
                      </div>
                      <div className="mcp-args-list">
                        {formArgs.length === 0 ? (
                          <div style={{ fontSize: '0.75rem', color: 'var(--color-muted)', fontStyle: 'italic', padding: '4px 0' }}>
                            {t.mcp.argsPlaceholder}
                          </div>
                        ) : (
                          formArgs.map((arg, idx) => (
                            <div key={idx} className="mcp-arg-row">
                              <textarea
                                rows={1}
                                aria-label={`${t.mcp.argsLabel} ${idx + 1}`}
                                className="mcp-arg-input"
                                placeholder={t.mcp.argPlaceholder}
                                value={arg}
                                onChange={(e) => {
                                  const next = [...formArgs]
                                  next[idx] = e.target.value
                                  setFormArgs(next)
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn--capsule-ghost btn--sm"
                                style={{ width: '22px', height: '22px', padding: 0 }}
                                onClick={() => setFormArgs(formArgs.filter((_, i) => i !== idx))}
                                title="Delete"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="mcp-form-field">
                      <label className="mcp-field-label">{t.mcp.cwdLabel}</label>
                      <input
                        className="mcp-input font-mono"
                        value={formCwd}
                        onChange={(e) => setFormCwd(e.target.value)}
                        placeholder={t.mcp.cwdPlaceholder}
                      />
                    </div>

                    {/* Environment Variables Key-Value List */}
                    <div className="mcp-form-field">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label className="mcp-field-label">{t.mcp.envLabel}</label>
                        <button
                          type="button"
                          className="btn btn--capsule-ghost btn--sm"
                          style={{ height: '22px', padding: '0 6px', fontSize: '0.6875rem' }}
                          onClick={() => setFormEnvPairs([...formEnvPairs, { key: '', value: '' }])}
                        >
                          <Plus size={10} />
                          <span>{t.mcp.addEnvVarBtn}</span>
                        </button>
                      </div>

                      <div className="mcp-kv-list">
                        {formEnvPairs.map((pair, idx) => (
                          <div key={idx} className="mcp-kv-row">
                            <input
                              className="mcp-kv-input"
                              placeholder={t.mcp.keyPlaceholder}
                              value={pair.key}
                              onChange={(e) => {
                                const next = [...formEnvPairs]
                                next[idx].key = e.target.value
                                setFormEnvPairs(next)
                              }}
                            />
                            <input
                              className="mcp-kv-input"
                              placeholder={t.mcp.valPlaceholder}
                              value={pair.value}
                              onChange={(e) => {
                                const next = [...formEnvPairs]
                                next[idx].value = e.target.value
                                setFormEnvPairs(next)
                              }}
                            />
                            <button
                              type="button"
                              className="mcp-kv-delete-btn"
                              onClick={() => setFormEnvPairs(formEnvPairs.filter((_, i) => i !== idx))}
                              title="Delete"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  /* sse or http fields */
                  <>
                    <div className="mcp-form-field">
                      <label className="mcp-field-label">{t.mcp.urlLabel}</label>
                      <input
                        className="mcp-input font-mono"
                        value={formUrl}
                        onChange={(e) => setFormUrl(e.target.value)}
                        placeholder={t.mcp.urlPlaceholder}
                      />
                    </div>

                    {/* Headers Key-Value List */}
                    <div className="mcp-form-field">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label className="mcp-field-label">{t.mcp.headersLabel}</label>
                        <button
                          type="button"
                          className="btn btn--capsule-ghost btn--sm"
                          style={{ height: '22px', padding: '0 6px', fontSize: '0.6875rem' }}
                          onClick={() => setFormHeaderPairs([...formHeaderPairs, { key: '', value: '' }])}
                        >
                          <Plus size={10} />
                          <span>{t.mcp.addHeaderBtn}</span>
                        </button>
                      </div>

                      <div className="mcp-kv-list">
                        {formHeaderPairs.map((pair, idx) => (
                          <div key={idx} className="mcp-kv-row">
                            <input
                              className="mcp-kv-input"
                              placeholder={t.mcp.keyPlaceholder}
                              value={pair.key}
                              onChange={(e) => {
                                const next = [...formHeaderPairs]
                                next[idx].key = e.target.value
                                setFormHeaderPairs(next)
                              }}
                            />
                            <input
                              className="mcp-kv-input"
                              placeholder={t.mcp.valPlaceholder}
                              value={pair.value}
                              onChange={(e) => {
                                const next = [...formHeaderPairs]
                                next[idx].value = e.target.value
                                setFormHeaderPairs(next)
                              }}
                            />
                            <button
                              type="button"
                              className="mcp-kv-delete-btn"
                              onClick={() => setFormHeaderPairs(formHeaderPairs.filter((_, i) => i !== idx))}
                              title="Delete"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Codex env_http_headers */}
                    <div className="mcp-form-field">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label className="mcp-field-label">{t.mcp.envHeadersLabel}</label>
                        <button
                          type="button"
                          className="btn btn--capsule-ghost btn--sm"
                          style={{ height: '22px', padding: '0 6px', fontSize: '0.6875rem' }}
                          onClick={() => setFormEnvHeaderPairs([...formEnvHeaderPairs, { key: '', value: '' }])}
                        >
                          <Plus size={10} />
                          <span>{t.mcp.addHeaderBtn}</span>
                        </button>
                      </div>

                      <div className="mcp-kv-list">
                        {formEnvHeaderPairs.map((pair, idx) => (
                          <div key={idx} className="mcp-kv-row">
                            <input
                              className="mcp-kv-input"
                              placeholder="Header (e.g. X-API-Key)"
                              value={pair.key}
                              onChange={(e) => {
                                const next = [...formEnvHeaderPairs]
                                next[idx].key = e.target.value
                                setFormEnvHeaderPairs(next)
                              }}
                            />
                            <input
                              className="mcp-kv-input"
                              placeholder="ENV_VAR (e.g. MY_KEY_ENV)"
                              value={pair.value}
                              onChange={(e) => {
                                const next = [...formEnvHeaderPairs]
                                next[idx].value = e.target.value
                                setFormEnvHeaderPairs(next)
                              }}
                            />
                            <button
                              type="button"
                              className="mcp-kv-delete-btn"
                              onClick={() => setFormEnvHeaderPairs(formEnvHeaderPairs.filter((_, i) => i !== idx))}
                              title="Delete"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Unsaved Changes Dialog */}
      {unsavedModalOpen && (
        <div className="modal-glass-backdrop view-enter" onClick={() => setUnsavedModalOpen(false)}>
          <div className="glass-dialog-box modal-pop" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header-row">
              <h3 className="glass-dialog-title">{t.mcp.unsavedTitle}</h3>
              <button type="button" className="clear-search-btn" onClick={() => setUnsavedModalOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <p className="dialog-desc-text">{t.mcp.unsavedDesc}</p>
            <div className="dialog-footer-row">
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setUnsavedModalOpen(false)}
              >
                {t.mcp.cancelBtn}
              </button>
              <button
                type="button"
                className="btn btn--danger btn--capsule btn--sm"
                onClick={handleConfirmDiscard}
              >
                {t.mcp.discardBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirmOpen && selectedServer && (
        <div className="modal-glass-backdrop view-enter" onClick={() => setDeleteConfirmOpen(false)}>
          <div className="glass-dialog-box modal-pop" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header-row">
              <h3 className="glass-dialog-title">{t.mcp.deleteConfirmTitle}</h3>
              <button type="button" className="clear-search-btn" onClick={() => setDeleteConfirmOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <p className="dialog-desc-text">
              确定要删除中央 MCP 资产 “{selectedServer.name}” 吗？该操作会自动尝试从所有已注入的环境中解除注入，并在全部成功后彻底删除该定义。
            </p>
            <div className="dialog-footer-row">
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={deleting}
              >
                {t.mcp.cancelBtn}
              </button>
              <button
                type="button"
                className="btn btn--danger btn--capsule btn--sm"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
                <span>{deleting ? '正在删除…' : t.mcp.confirmDeleteBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create New Server Modal */}
      {createModalOpen && (
        <div className="modal-glass-backdrop view-enter" onClick={() => setCreateModalOpen(false)}>
          <div className="glass-dialog-box modal-pop" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="dialog-header-row">
              <h3 className="glass-dialog-title">{t.mcp.createTitle}</h3>
              <button type="button" className="clear-search-btn" onClick={() => setCreateModalOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <p className="dialog-desc-text">在中央资产库创建新的 MCP Server 定义，随后可随时注入到任意工具环境。</p>

            <div className="mcp-form-grid" style={{ marginTop: 12 }}>
              <div className="mcp-form-field">
                <label className="mcp-field-label">{t.mcp.serverNameLabel}</label>
                <input
                  className="mcp-input font-mono"
                  placeholder={t.mcp.serverNamePlaceholder}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>

              <div className="mcp-form-field">
                <label className="mcp-field-label">服务描述 (可选)</label>
                <input
                  className="mcp-input"
                  placeholder="例如: GitHub 官方集成服务"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
              </div>

              <div className="mcp-form-field">
                <label className="mcp-field-label">{t.mcp.transportLabel}</label>
                <div className="master-tab-segmented" style={{ width: 'fit-content' }}>
                  <button
                    type="button"
                    className={`master-tab-btn ${newTransport === 'stdio' ? 'is-active' : ''}`}
                    onClick={() => setNewTransport('stdio')}
                  >
                    <span>stdio</span>
                  </button>
                  <button
                    type="button"
                    className={`master-tab-btn ${newTransport === 'sse' ? 'is-active' : ''}`}
                    onClick={() => setNewTransport('sse')}
                  >
                    <span>sse</span>
                  </button>
                  <button
                    type="button"
                    className={`master-tab-btn ${newTransport === 'http' ? 'is-active' : ''}`}
                    onClick={() => setNewTransport('http')}
                  >
                    <span>http</span>
                  </button>
                </div>
              </div>

              {newTransport === 'stdio' ? (
                <>
                  <div className="mcp-form-field">
                    <label className="mcp-field-label">{t.mcp.commandLabel}</label>
                    <input
                      className="mcp-input font-mono"
                      placeholder={t.mcp.commandPlaceholder}
                      value={newCommand}
                      onChange={(e) => setNewCommand(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="mcp-form-field">
                  <label className="mcp-field-label">{t.mcp.urlLabel}</label>
                  <input
                    className="mcp-input font-mono"
                    placeholder={t.mcp.urlPlaceholder}
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="dialog-footer-row" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setCreateModalOpen(false)}
                disabled={createSaving}
              >
                {t.mcp.cancelBtn}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--capsule btn--sm"
                onClick={() => void handleCreate()}
                disabled={!newName.trim() || createSaving}
              >
                {createSaving ? <RefreshCw size={12} className="spin" /> : <Plus size={12} />}
                <span>{createSaving ? '创建中…' : t.mcp.createBtn}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
