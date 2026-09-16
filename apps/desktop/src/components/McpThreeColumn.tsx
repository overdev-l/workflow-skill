import { useUpdateBlocker } from './AppUpdate'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Download,
  Folder,
  FolderPlus,
  Globe,
  Layers,
  Plus,
  Power,
  RefreshCw,
  Server,
  Trash2,
  Unlink,
  X,
} from 'lucide-react'
import type {
  CentralMCPServer,
  ConflictResolutionStrategy,
  MCPScope,
  MCPScopeStatus,
  MCPSourceTool,
  MCPTargetAssociation,
  MCPTransportType,
  ProjectRecord,
} from '@workflow-skill/workflow-model'
import { MCP_SOURCE_TOOLS } from '@workflow-skill/workflow-model'
import { AIToolLogo } from '../AIToolLogo'
import { ConflictResolutionDialog } from './ConflictResolutionDialog'
import { useI18n } from '../i18n'
import '../mcp.css'

function getMcpBadgeClass(status?: MCPScopeStatus | string): string {
  switch (status) {
    case '外部持有':
      return 'mcp-badge--external'
    case '全局已注入':
    case '项目已注入':
      return 'mcp-badge--injected'
    case '冲突':
      return 'mcp-badge--conflict'
    case '未注入':
      return 'mcp-badge--unbound'
    case '应用管理':
    default:
      return 'mcp-badge--app'
  }
}

function getMcpServerBadge(
  server: CentralMCPServer,
  activeScope?: 'global' | 'project',
  projectPath?: string,
): MCPScopeStatus {
  if (server.ownership === 'external') {
    return '外部持有'
  }
  const assocs = server.targetAssociations || []
  if (activeScope) {
    const scopeAssocs = assocs.filter((a) => {
      if (a.scope !== activeScope) return false
      if (activeScope === 'project' && projectPath) {
        return normalizePath(a.projectPath) === normalizePath(projectPath)
      }
      return true
    })
    if (scopeAssocs.some((a) => a.lastSyncStatus === 'conflict')) {
      return '冲突'
    }
    if (scopeAssocs.length > 0) {
      return activeScope === 'project' ? '项目已注入' : '全局已注入'
    }
    if (assocs.some((a) => a.lastSyncStatus === 'conflict')) {
      return '冲突'
    }
    return server.ownership === 'app' || assocs.length > 0 ? '应用管理' : '未注入'
  }
  if (assocs.some((a) => a.lastSyncStatus === 'conflict')) {
    return '冲突'
  }
  return server.scopeStatus || (assocs.length > 0 ? '应用管理' : '未注入')
}

interface KeyValuePair {
  key: string
  value: string
}

const TOOL_NAMES: Record<MCPSourceTool, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  antigravity: 'Antigravity',
}

// All 7 tools support project-scope configs with confirmed paths
const PROJECT_SUPPORTED_TOOLS: MCPSourceTool[] = [
  'claude-code',
  'cursor',
  'gemini',
  'codex',
  'opencode',
  'grok',
  'antigravity',
]

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
  | { type: 'switch_scope'; scope: 'global' | 'project' }
  | { type: 'switch_row'; serverId: string }
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

  const [activeScopeTab, setActiveScopeTab] = useState<'global' | 'project'>('global')
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
  const [injectionOpen, setInjectionOpen] = useState(false)
  const [injectionStep, setInjectionStep] = useState<'scope' | 'tools'>('scope')
  const [injectionScope, setInjectionScope] = useState<MCPScope>('global')
  const [injectionProjectPath, setInjectionProjectPath] = useState('')
  const [selectedInjectionTools, setSelectedInjectionTools] = useState<MCPSourceTool[]>([])
  const [injectionSaving, setInjectionSaving] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [disconnectingTarget, setDisconnectingTarget] = useState<string | null>(null)
  const [mcpConflictAssociation, setMcpConflictAssociation] = useState<MCPTargetAssociation | null>(null)
  const [mcpConflictBusy, setMcpConflictBusy] = useState(false)
  const [mcpConflictError, setMcpConflictError] = useState('')

  const isBusy = formSaving || toggling || deleting || loading || createSaving || injectionSaving || adopting || Boolean(disconnectingTarget) || mcpConflictBusy || Boolean(mcpConflictAssociation)

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
        if (injectionOpen && injectionScope === 'project') setInjectionProjectPath(res.project.path)
        notify?.(`已添加项目: ${res.project.name}`)
      } else if (res.error) {
        notify?.(`添加项目失败: ${res.error}`)
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

  useUpdateBlocker('mcp-actions', createModalOpen || createSaving || formSaving || toggling || deleting || injectionOpen || injectionSaving || Boolean(mcpConflictAssociation))

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

  const closeInjectionFlow = () => {
    setInjectionOpen(false)
    setInjectionStep('scope')
    setSelectedInjectionTools([])
  }

  // Scope tabs describe the next injection target. Central MCP assets stay
  // visible in both tabs, including assets that have not been injected yet.
  const filteredServers = useMemo(() => {
    return centralServers
  }, [centralServers])

  // Active Selected Server
  const selectedServer = useMemo(() => {
    if (filteredServers.length === 0) return null
    if (!selectedServerId) return filteredServers[0]
    return filteredServers.find((s) => s.id === selectedServerId) || null
  }, [filteredServers, selectedServerId])
  const selectedServerIsExternal = selectedServer?.ownership === 'external'

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
  const handleSwitchScope = (newScope: 'global' | 'project') => {
    if (isBusy || newScope === activeScopeTab) return
    if (isDirty) {
      setPendingAction({ type: 'switch_scope', scope: newScope })
      setUnsavedModalOpen(true)
      return
    }
    closeInjectionFlow()
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
    closeInjectionFlow()
    setSelectedServerId(serverId)
    lastLoadedIdRef.current = null
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
      closeInjectionFlow()
      setActiveScopeTab(action.scope)
      lastLoadedIdRef.current = null
    } else if (action.type === 'switch_row') {
      closeInjectionFlow()
      setSelectedServerId(action.serverId)
      lastLoadedIdRef.current = null
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
    if (!selectedServer || selectedServerIsExternal || !window.workflowSkill?.saveCentralMCPServer) return
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
    if (!selectedServer || selectedServerIsExternal || !window.workflowSkill?.saveCentralMCPServer) return
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
    if (!selectedServer || selectedServerIsExternal || !window.workflowSkill?.deleteCentralMCPServer) return
    setDeleting(true)
    try {
      const res = await window.workflowSkill.deleteCentralMCPServer(selectedServer.id)
      if (res.success) {
        notify?.(t.mcp.deletedToast(selectedServer.name))
        setDeleteConfirmOpen(false)
        closeInjectionFlow()
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

  // Adopt External MCP Server into App Management
  const handleAdoptServer = async () => {
    if (!selectedServer || !window.workflowSkill?.adoptMCPServer) return
    setAdopting(true)
    try {
      const discoveredTarget = selectedServer.discoveredTarget
      if (!discoveredTarget) {
        notify?.('未找到可纳入的外部 MCP 目标')
        return
      }
      const res = await window.workflowSkill.adoptMCPServer({
        ...discoveredTarget,
        name: selectedServer.name,
      })
      if (res.success && res.server) {
        notify?.(`已成功纳入应用管理: ${res.server.name}`)
        setSelectedServerId(res.server.id)
        lastLoadedIdRef.current = null
        await loadCentralServers()
      } else {
        notify?.(res.error || '纳入应用管理失败')
      }
    } catch (err: any) {
      notify?.(err.message || '纳入应用管理失败')
    } finally {
      setAdopting(false)
    }
  }

  // Disconnect target without deleting central asset
  const handleDisconnectTarget = async (assoc: MCPTargetAssociation) => {
    if (!selectedServer || !window.workflowSkill?.disconnectMCPServer) return
    const key = `${assoc.tool}:${assoc.scope}:${assoc.projectPath || ''}`
    setDisconnectingTarget(key)
    try {
      const res = await window.workflowSkill.disconnectMCPServer(selectedServer.id, {
        tool: assoc.tool,
        scope: assoc.scope,
        projectPath: assoc.projectPath,
      })
      if (res.success) {
        notify?.(`已断开 ${TOOL_NAMES[assoc.tool] || assoc.tool} 目标配置，中央资产已保留`)
        await loadCentralServers()
      } else {
        notify?.(res.error || '断开失败')
      }
    } catch (err: any) {
      notify?.(err.message || '断开失败')
    } finally {
      setDisconnectingTarget(null)
    }
  }

  const handleResolveMcpConflict = async (strategy: ConflictResolutionStrategy) => {
    if (!selectedServer || !mcpConflictAssociation || !window.workflowSkill?.resolveMCPConflict) return
    setMcpConflictBusy(true)
    setMcpConflictError('')
    try {
      const association = mcpConflictAssociation
      const result = await window.workflowSkill.resolveMCPConflict({
        serverIdOrName: selectedServer.id,
        target: {
          tool: association.tool,
          scope: association.scope,
          projectPath: association.projectPath,
        },
        strategy,
      })
      if (!result.success) {
        setMcpConflictError(result.error || '解决 MCP 冲突失败')
        return
      }
      setMcpConflictAssociation(null)
      await loadCentralServers()
      notify?.(result.backupPath
        ? `MCP 冲突已解决，原版本已备份到 ${result.backupPath}`
        : strategy === 'keep_external' ? '已保留外部 MCP，并解除应用关联' : 'MCP 冲突已解决')
    } catch (error) {
      setMcpConflictError(error instanceof Error ? error.message : '解决 MCP 冲突失败')
    } finally {
      setMcpConflictBusy(false)
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

  const injectionToolOptions = useMemo(() => {
    if (!selectedServer) return []
    if (injectionScope === 'global') return MCP_SOURCE_TOOLS
    return MCP_SOURCE_TOOLS.filter((tool) => PROJECT_SUPPORTED_TOOLS.includes(tool.id))
  }, [injectionScope, selectedServer])

  const isInjectionToolCompatible = (tool: typeof MCP_SOURCE_TOOLS[number]) => {
    return Boolean(selectedServer && tool.supportedTransports.includes(selectedServer.transport))
  }

  const runTargetOperation = async (
    target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string },
    operation: 'inject' | 'uninject',
  ): Promise<{ success: boolean; error?: string }> => {
    if (!selectedServer) return { success: false, error: '未选择 MCP 资产' }
    const api = window.workflowSkill
    const fn = operation === 'inject' ? api?.injectMCPServer : api?.uninjectMCPServer
    if (!fn) return { success: false, error: '当前运行环境不支持 MCP 注入操作' }

    const opKey = `${target.tool}:${target.scope}:${target.projectPath || ''}`
    setTargetOperating((prev) => ({ ...prev, [opKey]: true }))
    try {
      return await fn(selectedServer.id, target)
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      setTargetOperating((prev) => ({ ...prev, [opKey]: false }))
    }
  }

  const handleOpenInjection = () => {
    if (isBusy || !selectedServer) return
    const nextScope = activeScopeTab
    setInjectionScope(nextScope)
    setInjectionProjectPath(selectedProjectPath || projects[0]?.path || '')
    setSelectedInjectionTools([])
    setInjectionStep('scope')
    setInjectionOpen(true)
  }

  const handleConfirmInjectionScope = () => {
    if (!selectedServer) return
    if (injectionScope === 'project' && !injectionProjectPath) {
      notify?.('请先选择或添加一个项目')
      return
    }

    if (injectionScope === 'project') setSelectedProjectPath(injectionProjectPath)
    const projectPath = injectionScope === 'project' ? injectionProjectPath : undefined
    setSelectedInjectionTools(
      injectionToolOptions
        .filter((tool) => Boolean(getTargetAssociation(tool.id, injectionScope, projectPath)))
        .map((tool) => tool.id),
    )
    setInjectionStep('tools')
  }

  const handleApplyInjection = async () => {
    if (!selectedServer || injectionSaving) return
    const projectPath = injectionScope === 'project' ? injectionProjectPath : undefined
    const selectedTools = new Set(selectedInjectionTools)
    const operations: Array<{
      tool: MCPSourceTool
      target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string }
      operation: 'inject' | 'uninject'
    }> = []

    for (const tool of injectionToolOptions) {
      const association = getTargetAssociation(tool.id, injectionScope, projectPath)
      const compatible = isInjectionToolCompatible(tool)
      if (selectedTools.has(tool.id) && !association && compatible) {
        operations.push({
          tool: tool.id,
          target: { tool: tool.id, scope: injectionScope, projectPath },
          operation: 'inject',
        })
      } else if (!selectedTools.has(tool.id) && association) {
        operations.push({
          tool: tool.id,
          target: { tool: tool.id, scope: injectionScope, projectPath },
          operation: 'uninject',
        })
      }
    }

    if (operations.length === 0) {
      notify?.('注入目标没有变化')
      setInjectionOpen(false)
      return
    }

    setInjectionSaving(true)
    const failures: string[] = []
    let completed = 0
    try {
      for (const item of operations) {
        const result = await runTargetOperation(item.target, item.operation)
        if (result.success) {
          completed += 1
        } else {
          failures.push(`${TOOL_NAMES[item.tool]}：${result.error || '操作失败'}`)
        }
      }
      await loadCentralServers()
      setInjectionOpen(false)
      setInjectionStep('scope')
      setSelectedInjectionTools([])
      if (failures.length > 0) {
        notify?.(`已完成 ${completed}/${operations.length} 个目标，失败：${failures.join('；')}`)
      } else {
        notify?.(`已完成 ${completed} 个 MCP 注入目标`)
      }
    } finally {
      setInjectionSaving(false)
    }
  }

  return (
    <>
      {/* =========================================================================
          Column 2: Master List (Width: 210px) - AGENTS.md §1.1
          ========================================================================= */}
      <aside className="app-col-master view-enter">
        <div className="master-header">
          {/* Scope Segmented Tabs: [ 全局 | 项目 ] - Height: 24px */}
          <div className="master-header-top">
            <div
              role="tablist"
              aria-label="MCP 注入目标范围"
              className="master-tab-segmented mcp-scope-segmented"
            >
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
                中央资产库暂无 MCP 服务
              </span>
              <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', textAlign: 'center', margin: '4px 0 0' }}>
                点击下方「新建 MCP Server」添加中央资产，随后可在右侧选择注入范围与 AI 工具。
              </p>
            </div>
          ) : (
            filteredServers.map((server) => {
              const isSelected = selectedServer?.id === server.id
              const badgeText = getMcpServerBadge(server, activeScopeTab, selectedProjectPath)
              const badgeClass = getMcpBadgeClass(badgeText)

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
                    </div>
                  </div>
                  <span className={`mcp-badge ${badgeClass}`} style={{ fontSize: '0.625rem', padding: '1px 5px', height: 'auto', flexShrink: 0, marginLeft: 'auto' }}>
                    {badgeText}
                  </span>
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
              {filteredServers.length === 0
                ? '暂无 MCP 资产'
                : t.mcp.emptyDetailTitle}
            </h2>
            <p style={{ fontSize: '0.8125rem', color: 'var(--color-muted)', maxWidth: 360, textAlign: 'center', margin: 0 }}>
              在左侧列表中选择一个 MCP 资产以编辑配置，或在右侧按范围选择要注入的 AI 工具。
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
                  <Layers size={20} style={{ color: 'var(--color-accent)' }} />
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

              {/* Action Buttons: external assets must be adopted before editing */}
              <div className="mcp-hero-actions">
                {selectedServerIsExternal ? (
                  <button type="button" className="btn btn--primary btn--capsule btn--sm" disabled={isBusy} onClick={() => void handleAdoptServer()}>
                    {adopting ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
                    <span>{adopting ? '正在纳入…' : '纳入应用管理'}</span>
                  </button>
                ) : <>
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
                </>}
              </div>
            </div>

            {/* Restart Session Notice Banner */}
            <div className="mcp-notice-banner">
              <AlertCircle size={14} />
              <span>{t.mcp.restartNotice}</span>
            </div>

            <div className="mcp-ownership-card">
              <div className="mcp-ownership-card__header">
                <div>
                  <div className="mcp-ownership-label">资产持有</div>
                  <div className="mcp-ownership-title-row">
                    <span className={`mcp-badge ${getMcpBadgeClass(getMcpServerBadge(selectedServer))}`}>
                      {getMcpServerBadge(selectedServer)}
                    </span>
                    <span className="mcp-ownership-hint">
                      {selectedServerIsExternal ? '当前配置由 AI 应用自行维护' : '中央 MCP 资产由 Trace 维护，目标配置只保存注入结果'}
                    </span>
                  </div>
                </div>
                {selectedServerIsExternal ? (
                  <button type="button" className="btn btn--primary btn--capsule btn--sm" disabled={isBusy} onClick={() => void handleAdoptServer()}>
                    {adopting ? <RefreshCw size={11} className="spin" /> : <Download size={11} />}
                    <span>转移到应用管理</span>
                  </button>
                ) : null}
              </div>
              <div className="mcp-ownership-item">
                <span className="mcp-ownership-label">来源</span>
                <span className="mcp-ownership-val font-mono" title={selectedServer.discoveredTarget?.configPath || selectedServer.id}>
                  {selectedServer.discoveredTarget?.configPath || `Trace 中央库 · ${selectedServer.id}`}
                </span>
              </div>
              {selectedServerIsExternal && selectedServer.discoveredTarget ? (
                <div className="mcp-ownership-item">
                  <span className="mcp-ownership-label">发现位置</span>
                  <span className="mcp-ownership-val">{TOOL_NAMES[selectedServer.discoveredTarget.tool]} · {selectedServer.discoveredTarget.scope === 'global' ? '全局' : `项目 · ${selectedServer.discoveredTarget.projectPath || ''}`}</span>
                </div>
              ) : null}
              {!selectedServerIsExternal && (selectedServer.targetAssociations || []).length > 0 ? (
                <div className="mcp-ownership-targets">
                  {(selectedServer.targetAssociations || []).map((association) => {
                    const key = `${association.tool}:${association.scope}:${association.projectPath || ''}`
                    const state = association.lastSyncStatus === 'conflict' ? '冲突' : association.scope === 'project' ? '项目已注入' : '全局已注入'
                    return (
                      <div className="mcp-ownership-target" key={key}>
                        <div className="mcp-ownership-target__copy">
                          <AIToolLogo toolId={association.tool} size={14} color />
                          <span>{TOOL_NAMES[association.tool] || association.tool}</span>
                          <span className={`mcp-badge ${getMcpBadgeClass(state)}`}>{state}</span>
                          {association.scope === 'project' ? <span className="mcp-ownership-target__path font-mono">{association.projectPath}</span> : null}
                        </div>
                        {association.lastSyncStatus === 'conflict' ? (
                          <button
                            type="button"
                            className="btn btn--capsule-ghost btn--sm"
                            disabled={isBusy}
                            onClick={() => { setMcpConflictAssociation(association); setMcpConflictError('') }}
                          >
                            <AlertCircle size={10} />
                            <span>解决冲突</span>
                          </button>
                        ) : (
                          <button type="button" className="btn btn--capsule-ghost btn--sm" disabled={isBusy} onClick={() => void handleDisconnectTarget(association)}>
                            {disconnectingTarget === key ? <RefreshCw size={10} className="spin" /> : <Unlink size={10} />}
                            <span>断开</span>
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>

            {/* 1. Main Configuration Card (Preceding Injection per DESIGN.md §8.7) */}
            <div className="mcp-card">
              <h3 className="mcp-card-title">
                <span>{t.mcp.configCardTitle}</span>
                <span className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                  {selectedServer.id}
                </span>
              </h3>

              <fieldset disabled={selectedServerIsExternal} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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

                    {/* Lossless Args List */}
                    <div className="mcp-form-field">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label className="mcp-field-label">{t.mcp.argsLabel}</label>
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
                        {formArgs.map((arg, idx) => (
                          <div key={idx} className="mcp-arg-row">
                            <input
                              className="mcp-arg-input font-mono"
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
                              className="mcp-arg-delete-btn"
                              onClick={() => setFormArgs(formArgs.filter((_, i) => i !== idx))}
                              title="Delete"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* CWD */}
                    <div className="mcp-form-field">
                      <label className="mcp-field-label">{t.mcp.cwdLabel}</label>
                      <input
                        className="mcp-input font-mono"
                        value={formCwd}
                        onChange={(e) => setFormCwd(e.target.value)}
                        placeholder={t.mcp.cwdPlaceholder}
                      />
                    </div>

                    {/* Env Variables Key-Value List */}
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
                              className="mcp-kv-input font-mono"
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
              </fieldset>
            </div>

            {/* 2. Two-step MCP injection flow */}
            <div className="mcp-card mcp-injection-card">
              <div className="mcp-injection-heading">
                <div>
                  <h3 className="mcp-card-title">注入到 AI 工具</h3>
                  <p className="mcp-injection-description">先确定作用范围，再选择要写入的 AI 工具配置。</p>
                </div>
                <span className="pinned-ver-pill font-mono">
                  已注入 {(selectedServer.targetAssociations || []).length} 个目标
                </span>
              </div>

              {!injectionOpen ? (
                selectedServerIsExternal ? (
                  <div className="mcp-injection-summary">
                    <span>该 MCP 仍由目标应用持有。先纳入应用管理，Trace 才能安全地跨工具分发与断开。</span>
                    <button type="button" className="btn btn--primary btn--capsule btn--sm" disabled={isBusy} onClick={() => void handleAdoptServer()}>
                      {adopting ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
                      <span>{adopting ? '正在纳入…' : '纳入后管理'}</span>
                    </button>
                  </div>
                ) : (
                <div className="mcp-injection-summary">
                  <span>中央资产由 Trace 统一保管，可按需注入到全局或项目范围。</span>
                  <button
                    type="button"
                    className="btn btn--primary btn--capsule btn--sm"
                    onClick={handleOpenInjection}
                    disabled={isBusy}
                  >
                    <Plus size={12} />
                    <span>开始注入</span>
                  </button>
                </div>
                )
              ) : (
                <div className="mcp-injection-flow">
                  <div className="mcp-injection-steps" aria-label="注入步骤">
                    <span className={`mcp-injection-step ${injectionStep === 'scope' ? 'is-active' : 'is-complete'}`}>
                      <span className="mcp-injection-step__number">1</span>
                      选择范围
                    </span>
                    <span className={`mcp-injection-step ${injectionStep === 'tools' ? 'is-active' : ''}`}>
                      <span className="mcp-injection-step__number">2</span>
                      勾选 AI 工具
                    </span>
                  </div>

                  {injectionStep === 'scope' ? (
                    <div className="mcp-injection-step-panel">
                      <fieldset className="mcp-injection-fieldset">
                        <legend>选择注入范围</legend>
                        <div className="mcp-injection-scope-options">
                          <label className={`mcp-injection-scope-option ${injectionScope === 'global' ? 'is-selected' : ''}`}>
                            <input
                              type="radio"
                              name={`mcp-injection-scope-${selectedServer.id}`}
                              value="global"
                              checked={injectionScope === 'global'}
                              onChange={() => setInjectionScope('global')}
                            />
                            <Globe size={16} aria-hidden="true" />
                            <span>
                              <strong>全局</strong>
                              <small>写入用户级 AI 工具配置</small>
                            </span>
                          </label>
                          <label className={`mcp-injection-scope-option ${injectionScope === 'project' ? 'is-selected' : ''}`}>
                            <input
                              type="radio"
                              name={`mcp-injection-scope-${selectedServer.id}`}
                              value="project"
                              checked={injectionScope === 'project'}
                              onChange={() => setInjectionScope('project')}
                            />
                            <Folder size={16} aria-hidden="true" />
                            <span>
                              <strong>项目</strong>
                              <small>只写入选定项目的 AI 工具配置</small>
                            </span>
                          </label>
                        </div>
                      </fieldset>

                      {injectionScope === 'project' ? (
                        projects.length > 0 ? (
                          <div className="mcp-injection-project-picker">
                            <label htmlFor="mcp-injection-project">目标项目</label>
                            <div className="mcp-injection-project-controls">
                              <Folder size={13} aria-hidden="true" />
                              <select
                                id="mcp-injection-project"
                                className="mcp-select"
                                value={injectionProjectPath}
                                onChange={(e) => setInjectionProjectPath(e.target.value)}
                              >
                                {projects.map((project) => (
                                  <option key={project.id} value={project.path}>{project.name}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="btn btn--capsule-ghost btn--sm icon-only"
                                title="添加项目文件夹"
                                aria-label="添加项目文件夹"
                                onClick={handleAddProject}
                                disabled={isBusy}
                              >
                                <FolderPlus size={12} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mcp-injection-no-project">
                            <span>尚未登记项目，添加后即可使用项目范围注入。</span>
                            <button type="button" className="btn btn--capsule btn--sm" onClick={handleAddProject} disabled={isBusy}>
                              <FolderPlus size={12} />
                              <span>添加项目</span>
                            </button>
                          </div>
                        )
                      ) : null}

                      <div className="mcp-injection-actions">
                        <button type="button" className="btn btn--capsule-ghost btn--sm" onClick={() => setInjectionOpen(false)} disabled={isBusy}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary btn--capsule btn--sm"
                          onClick={handleConfirmInjectionScope}
                          disabled={injectionScope === 'project' && !injectionProjectPath}
                        >
                          <span>确定范围，下一步</span>
                          <span aria-hidden="true">→</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mcp-injection-step-panel">
                      <div className="mcp-injection-tools-heading">
                        <div>
                          <strong>{injectionScope === 'global' ? '全局 AI 工具' : '项目 AI 工具'}</strong>
                          <span>
                            {injectionScope === 'global'
                              ? '选择要同步的用户级配置'
                              : `项目：${projects.find((project) => project.path === injectionProjectPath)?.name || injectionProjectPath}`}
                          </span>
                        </div>
                        <button type="button" className="btn btn--capsule-ghost btn--sm" onClick={() => setInjectionStep('scope')} disabled={isBusy}>
                          返回修改范围
                        </button>
                      </div>

                      <div className="mcp-injection-tools" role="group" aria-label="选择 AI 工具">
                        {injectionToolOptions.map((tool) => {
                          const association = getTargetAssociation(tool.id, injectionScope, injectionProjectPath)
                          const isAssociated = Boolean(association)
                          const isCompatible = isInjectionToolCompatible(tool)
                          const isSelected = selectedInjectionTools.includes(tool.id)
                          const opKey = `${tool.id}:${injectionScope}:${injectionProjectPath}`
                          const isOperating = Boolean(targetOperating[opKey])

                          return (
                            <label
                              key={tool.id}
                              className={`mcp-injection-tool-option ${isSelected ? 'is-selected' : ''} ${!isCompatible && !isAssociated ? 'is-disabled' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={(!isCompatible && !isAssociated) || isBusy}
                                onChange={() => {
                                  setSelectedInjectionTools((current) => current.includes(tool.id)
                                    ? current.filter((id) => id !== tool.id)
                                    : [...current, tool.id])
                                }}
                              />
                              <AIToolLogo toolId={tool.id} size={18} color={isSelected} />
                              <span className="mcp-injection-tool-copy">
                                <strong>{tool.name}</strong>
                                <small>
                                  {!isCompatible
                                    ? `不支持 ${selectedServer.transport}`
                                    : association?.lastError || (isAssociated ? '已注入，取消勾选可移除' : '尚未注入')}
                                </small>
                              </span>
                              <span className="mcp-injection-tool-status">
                                {isOperating ? <RefreshCw size={12} className="spin" /> : association?.lastSyncStatus === 'failed' ? '失败' : isAssociated ? '已注入' : '待注入'}
                              </span>
                            </label>
                          )
                        })}
                      </div>

                      <p className="mcp-injection-hint">已注入的工具默认勾选；取消勾选并确认后会从该范围解除注入。</p>
                      <div className="mcp-injection-actions">
                        <button type="button" className="btn btn--capsule-ghost btn--sm" onClick={() => setInjectionOpen(false)} disabled={isBusy}>
                          取消
                        </button>
                        <button type="button" className="btn btn--primary btn--capsule btn--sm" onClick={() => void handleApplyInjection()} disabled={isBusy}>
                          {injectionSaving ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
                          <span>{injectionSaving ? '正在同步…' : '确认注入'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
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

      <ConflictResolutionDialog
        open={Boolean(mcpConflictAssociation && selectedServer)}
        assetKind="MCP"
        assetName={selectedServer?.name || ''}
        targetLabel={mcpConflictAssociation
          ? `${TOOL_NAMES[mcpConflictAssociation.tool] || mcpConflictAssociation.tool} · ${mcpConflictAssociation.scope === 'project' ? `项目 · ${mcpConflictAssociation.projectPath || ''}` : '全局'}`
          : ''}
        sourcePath={selectedServer ? `Trace 中央库 · ${selectedServer.id}` : undefined}
        targetPath={mcpConflictAssociation?.configPath || selectedServer?.discoveredTarget?.configPath}
        statusLabel="目标配置已被外部修改"
        canUseTarget
        busy={mcpConflictBusy}
        error={mcpConflictError}
        onClose={() => { if (!mcpConflictBusy) setMcpConflictAssociation(null) }}
        onResolve={handleResolveMcpConflict}
      />

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
