import { useUpdateBlocker } from './AppUpdate'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Folder,
  Layers,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import type {
  MCPDistributionPreflightItem,
  MCPDistributionPreflightResult,
  MCPDistributionTarget,
  MCPScope,
  MCPServerDefinition,
  MCPServerInput,
  MCPSourceTool,
  MCPTransportType,
} from '@workflow-skill/workflow-model'
import { MCP_SOURCE_TOOLS } from '@workflow-skill/workflow-model'
import { AIToolLogo } from '../AIToolLogo'
import { useI18n } from '../i18n'
import '../mcp.css'

interface KeyValuePair {
  key: string
  value: string
}

const TOOL_TAB_NAMES: Record<MCPSourceTool, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  gemini: 'Gemini',
  codex: 'Codex',
}

interface FormBaseline {
  serverId: string
  revision?: string
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
  | { type: 'switch_tool'; tool: MCPSourceTool }
  | { type: 'switch_scope'; scope: MCPScope }
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

function testServerMatchesQuery(s: MCPServerDefinition, q: string): boolean {
  const toolName = s.sourceTool.toLowerCase()
  const name = s.name.toLowerCase()
  const transport = s.transport.toLowerCase()
  const cmd = (s.command || '').toLowerCase()
  const url = (s.url || '').toLowerCase()
  return (
    name.includes(q) ||
    toolName.includes(q) ||
    transport.includes(q) ||
    cmd.includes(q) ||
    url.includes(q)
  )
}

export function McpThreeColumn({
  notify,
}: {
  notify?: (msg: string) => void
}) {
  const { t } = useI18n()

  const [activeTool, setActiveTool] = useState<MCPSourceTool>('claude-code')
  const [activeTab, setActiveTab] = useState<MCPScope>('global')
  const [query, setQuery] = useState('')
  const [servers, setServers] = useState<{ global: MCPServerDefinition[]; project: MCPServerDefinition[] }>({
    global: [],
    project: [],
  })
  const [loading, setLoading] = useState(false)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)

  // Editor Form State
  const [formName, setFormName] = useState('')
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
  const [formBaseRevision, setFormBaseRevision] = useState<string | undefined>(undefined)
  const [formBaseline, setFormBaseline] = useState<FormBaseline | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const lastLoadedIdRef = useRef<string | null>(null)

  // Unsaved Changes Confirmation State
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingNavigationAction | null>(null)
  const unsavedDialogRef = useRef<HTMLDivElement>(null)
  const cancelUnsavedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!unsavedModalOpen) return
    const previousFocus = document.activeElement as HTMLElement | null
    cancelUnsavedRef.current?.focus()
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setUnsavedModalOpen(false)
        setPendingAction(null)
      } else if (event.key === 'Tab') {
        const buttons = unsavedDialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handleDialogKey, true)
    return () => {
      window.removeEventListener('keydown', handleDialogKey, true)
      previousFocus?.focus()
    }
  }, [unsavedModalOpen])

  // Distribution State
  const [selectedTargets, setSelectedTargets] = useState<Record<string, boolean>>({})
  const [distributing, setDistributing] = useState(false)
  const [preflighting, setPreflighting] = useState(false)
  const [preflightResult, setPreflightResult] = useState<MCPDistributionPreflightResult | null>(null)
  const [preflightModalOpen, setPreflightModalOpen] = useState(false)
  const [frozenServer, setFrozenServer] = useState<MCPServerDefinition | null>(null)
  const [frozenTargets, setFrozenTargets] = useState<MCPDistributionTarget[]>([])

  // Create Modal State
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newScope, setNewScope] = useState<MCPScope>('global')
  const [newTool, setNewTool] = useState<MCPSourceTool>('claude-code')
  const [newName, setNewName] = useState('')
  const [newTransport, setNewTransport] = useState<MCPTransportType>('stdio')
  const [newCommand, setNewCommand] = useState('')
  const [newArgs, setNewArgs] = useState<string[]>([])
  const [newUrl, setNewUrl] = useState('')
  const [createSaving, setCreateSaving] = useState(false)

  // Delete Confirm State
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isBusy = formSaving || toggling || deleting || distributing || preflighting || loading || createSaving

  // Load MCP Servers
  const loadServers = async () => {
    if (!window.workflowSkill?.listMCPServers) return
    setLoading(true)
    setLoadError(null)
    try {
      const data = await window.workflowSkill.listMCPServers()
      setServers(data)
      setLoadError(null)
    } catch (err) {
      const msg = (err as Error).message
      setLoadError(msg)
      notify?.(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadServers()
  }, [])

  // Listen for MCP configuration changes broadcast from main process
  useEffect(() => {
    if (!window.workflowSkill?.onMCPChanged) return
    const unsubscribe = window.workflowSkill.onMCPChanged(() => {
      void loadServers()
    })
    return unsubscribe
  }, [])

  useUpdateBlocker('mcp-actions', createModalOpen || createSaving || formSaving || distributing || toggling || deleting)

  // Dirty detection for all editable fields
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

  // Current tool and scope server list
  const currentList = useMemo(() => {
    const scopeList = activeTab === 'global' ? servers.global : servers.project
    return scopeList.filter((s) => s.sourceTool === activeTool)
  }, [activeTab, activeTool, servers])

  // Filtered servers by query
  const filteredServers = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return currentList
    return currentList.filter((s) => testServerMatchesQuery(s, q))
  }, [currentList, query])

  // Active Selected Server - MUST ONLY be an item in filtered visible list
  const selectedServer = useMemo(() => {
    if (filteredServers.length === 0) return null
    if (!selectedServerId) return filteredServers[0]
    return filteredServers.find((s) => s.id === selectedServerId) || null
  }, [filteredServers, selectedServerId])

  // Keep selectedServerId synchronized with filteredServers without loops
  useEffect(() => {
    // A newly created ID is selected before the refreshed list arrives.
    // Keep that intent while loading instead of replacing it with an old row.
    if (loading || createSaving) return
    if (filteredServers.length === 0) {
      if (selectedServerId !== null) {
        setSelectedServerId(null)
      }
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
    // Only repopulate if selectedServer ID changed to avoid wiping user dirty input
    if (lastLoadedIdRef.current === selectedServer.id) {
      return
    }
    lastLoadedIdRef.current = selectedServer.id
    setFormBaseRevision(selectedServer.revision)

    setFormName(selectedServer.name)
    setFormTransport(selectedServer.transport)
    setFormCommand(selectedServer.command || '')
    const args = selectedServer.args ? [...selectedServer.args] : []
    setFormArgs(args)
    setFormCwd(selectedServer.cwd || '')
    setFormUrl(selectedServer.url || '')

    // Env pairs
    const envPairs = selectedServer.env
      ? Object.entries(selectedServer.env).map(([k, v]) => ({ key: k, value: v }))
      : []
    setFormEnvPairs(envPairs)

    // Headers
    const headerPairs = selectedServer.headers
      ? Object.entries(selectedServer.headers).map(([k, v]) => ({ key: k, value: v }))
      : []
    setFormHeaderPairs(headerPairs)

    // Env Headers (Codex)
    const envHeaderPairs = selectedServer.envHeaders
      ? Object.entries(selectedServer.envHeaders).map(([k, v]) => ({ key: k, value: v }))
      : []
    setFormEnvHeaderPairs(envHeaderPairs)

    setFormBaseline({
      serverId: selectedServer.id,
      revision: selectedServer.revision,
      transport: selectedServer.transport,
      command: selectedServer.command || '',
      args,
      cwd: selectedServer.cwd || '',
      envPairs,
      url: selectedServer.url || '',
      headerPairs,
      envHeaderPairs,
    })

    // Reset target selections: select all other tools by default
    const defaults: Record<string, boolean> = {}
    for (const tool of MCP_SOURCE_TOOLS) {
      if (tool.id !== selectedServer.sourceTool) {
        defaults[`${tool.id}:${selectedServer.scope}`] = true
      }
    }
    setSelectedTargets(defaults)
    setPreflightResult(null)
    setFrozenServer(null)
    setFrozenTargets([])
  }, [selectedServer])

  // Helper to convert KeyValuePair array to Record with duplicate key guard
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

  // Handle Switch Tool Tab
  const handleSwitchTool = (newTool: MCPSourceTool) => {
    if (isBusy || newTool === activeTool) return
    if (isDirty) {
      setPendingAction({ type: 'switch_tool', tool: newTool })
      setUnsavedModalOpen(true)
      return
    }
    executeSwitchTool(newTool)
  }

  const executeSwitchTool = (newTool: MCPSourceTool) => {
    setActiveTool(newTool)
    setPreflightResult(null)
    setFrozenServer(null)
    setFrozenTargets([])
    const scopeList = activeTab === 'global' ? servers.global : servers.project
    const toolList = scopeList.filter((s) => s.sourceTool === newTool)
    const q = query.trim().toLowerCase()
    const matching = q ? toolList.filter((s) => testServerMatchesQuery(s, q)) : toolList
    setSelectedServerId(matching[0]?.id ?? null)
    lastLoadedIdRef.current = null
  }

  // Handle Switch Scope Tab
  const handleSwitchScope = (newScope: MCPScope) => {
    if (isBusy || newScope === activeTab) return
    if (isDirty) {
      setPendingAction({ type: 'switch_scope', scope: newScope })
      setUnsavedModalOpen(true)
      return
    }
    executeSwitchScope(newScope)
  }

  const executeSwitchScope = (newScope: MCPScope) => {
    setActiveTab(newScope)
    setPreflightResult(null)
    setFrozenServer(null)
    setFrozenTargets([])
    const scopeList = newScope === 'global' ? servers.global : servers.project
    const toolList = scopeList.filter((s) => s.sourceTool === activeTool)
    const q = query.trim().toLowerCase()
    const matching = q ? toolList.filter((s) => testServerMatchesQuery(s, q)) : toolList
    setSelectedServerId(matching[0]?.id ?? null)
    lastLoadedIdRef.current = null
  }

  // Handle Select Row
  const handleSelectRow = (serverId: string) => {
    if (isBusy || serverId === selectedServer?.id) return
    if (isDirty) {
      setPendingAction({ type: 'switch_row', serverId })
      setUnsavedModalOpen(true)
      return
    }
    executeSelectRow(serverId)
  }

  const executeSelectRow = (serverId: string) => {
    setSelectedServerId(serverId)
    setPreflightResult(null)
    setFrozenServer(null)
    setFrozenTargets([])
    lastLoadedIdRef.current = null
  }

  // Handle Query Change
  const handleQueryChange = (newQuery: string) => {
    if (isBusy) return
    if (isDirty && selectedServer) {
      const q = newQuery.trim().toLowerCase()
      const currentStillMatches = !q || testServerMatchesQuery(selectedServer, q)
      if (!currentStillMatches) {
        setPendingAction({ type: 'change_query', query: newQuery })
        setUnsavedModalOpen(true)
        return
      }
    }
    executeChangeQuery(newQuery)
  }

  const executeChangeQuery = (newQuery: string) => {
    setQuery(newQuery)
    const q = newQuery.trim().toLowerCase()
    const scopeList = activeTab === 'global' ? servers.global : servers.project
    const toolList = scopeList.filter((s) => s.sourceTool === activeTool)
    const matching = q ? toolList.filter((s) => testServerMatchesQuery(s, q)) : toolList

    if (selectedServerId && !matching.some((s) => s.id === selectedServerId)) {
      setSelectedServerId(matching[0]?.id ?? null)
      lastLoadedIdRef.current = null
    }
  }

  // Handle Open Create Modal
  const handleOpenCreate = () => {
    if (isBusy) return
    if (isDirty) {
      setPendingAction({ type: 'open_create' })
      setUnsavedModalOpen(true)
      return
    }
    executeOpenCreate()
  }

  const executeOpenCreate = () => {
    setNewTool(activeTool)
    setNewScope(activeTab)
    setNewName('')
    setNewTransport('stdio')
    setNewCommand('')
    setNewArgs([])
    setNewUrl('')
    setCreateModalOpen(true)
  }

  // Cancel Unsaved Modal
  const handleCancelUnsaved = () => {
    setUnsavedModalOpen(false)
    setPendingAction(null)
  }

  // Confirm Discard Unsaved Changes
  const handleConfirmDiscard = () => {
    setUnsavedModalOpen(false)
    const action = pendingAction
    setPendingAction(null)
    if (!action) return

    if (action.type === 'switch_tool') {
      executeSwitchTool(action.tool)
    } else if (action.type === 'switch_scope') {
      executeSwitchScope(action.scope)
    } else if (action.type === 'switch_row') {
      executeSelectRow(action.serverId)
    } else if (action.type === 'change_query') {
      executeChangeQuery(action.query)
    } else if (action.type === 'open_create') {
      executeOpenCreate()
    }
  }

  // Keyboard navigation for tool tabs
  const handleToolTabKeyDown = (e: React.KeyboardEvent, currentToolId: MCPSourceTool) => {
    const currentIndex = MCP_SOURCE_TOOLS.findIndex((tool) => tool.id === currentToolId)
    if (currentIndex === -1) return

    let nextIndex = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      nextIndex = (currentIndex + 1) % MCP_SOURCE_TOOLS.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      nextIndex = (currentIndex - 1 + MCP_SOURCE_TOOLS.length) % MCP_SOURCE_TOOLS.length
    } else if (e.key === 'Home') {
      e.preventDefault()
      nextIndex = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      nextIndex = MCP_SOURCE_TOOLS.length - 1
    }

    if (nextIndex !== -1) {
      const targetTool = MCP_SOURCE_TOOLS[nextIndex]
      handleSwitchTool(targetTool.id)
      const el = document.getElementById(`mcp-tool-tab-${targetTool.id}`)
      el?.focus()
    }
  }

  // Keyboard navigation for scope tabs
  const handleScopeTabKeyDown = (e: React.KeyboardEvent, currentScope: MCPScope) => {
    let nextScope: MCPScope | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      nextScope = currentScope === 'global' ? 'project' : 'global'
    } else if (e.key === 'Home') {
      e.preventDefault()
      nextScope = 'global'
    } else if (e.key === 'End') {
      e.preventDefault()
      nextScope = 'project'
    }

    if (nextScope && nextScope !== currentScope) {
      handleSwitchScope(nextScope)
      const el = document.getElementById(`mcp-scope-tab-${nextScope}`)
      el?.focus()
    }
  }

  // Handle Save
  const handleSave = async () => {
    if (!selectedServer || !window.workflowSkill?.saveMCPServer) return
    const envRes = pairsToRecord(formEnvPairs)
    const headerRes = pairsToRecord(formHeaderPairs)
    const envHeaderRes = pairsToRecord(formEnvHeaderPairs)

    if (envRes.hasDuplicates || headerRes.hasDuplicates || envHeaderRes.hasDuplicates) {
      notify?.(t.mcp.duplicateKeyWarning)
      return
    }

    setFormSaving(true)
    try {
      const input: MCPServerInput = {
        name: selectedServer.name, // Primary name is immutable to prevent orphaned duplicates
        transport: formTransport,
        command: formTransport === 'stdio' ? formCommand.trim() : undefined,
        args: formTransport === 'stdio' ? formArgs : undefined,
        cwd: formTransport === 'stdio' && formCwd.trim() ? formCwd.trim() : undefined,
        env: formTransport === 'stdio' ? envRes.record : undefined,
        url: formTransport !== 'stdio' ? formUrl.trim() : undefined,
        headers: formTransport !== 'stdio' ? headerRes.record : undefined,
        envHeaders: formTransport !== 'stdio' ? envHeaderRes.record : undefined,
        enabled: selectedServer.enabled,
        sourceRaw: selectedServer.sourceRaw,
        expectedRevision: formBaseRevision,
      }

      const res = await window.workflowSkill.saveMCPServer(
        {
          tool: selectedServer.sourceTool,
          scope: selectedServer.scope,
          expectedRevision: formBaseRevision,
        },
        input
      )

      if (res.success) {
        notify?.(t.mcp.savedToast(input.name))
        const newRevision = res.server?.revision || formBaseRevision
        if (res.server?.revision) {
          setFormBaseRevision(res.server.revision)
        }
        // Reset baseline after successful save
        setFormBaseline({
          serverId: selectedServer.id,
          revision: newRevision,
          transport: formTransport,
          command: formTransport === 'stdio' ? formCommand : '',
          args: formTransport === 'stdio' ? [...formArgs] : [],
          cwd: formTransport === 'stdio' ? formCwd : '',
          envPairs: formTransport === 'stdio' ? [...formEnvPairs] : [],
          url: formTransport !== 'stdio' ? formUrl : '',
          headerPairs: formTransport !== 'stdio' ? [...formHeaderPairs] : [],
          envHeaderPairs: formTransport !== 'stdio' ? [...formEnvHeaderPairs] : [],
        })
        await loadServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setFormSaving(false)
    }
  }

  // Handle Toggle Enable/Disable
  const handleToggleEnable = async () => {
    if (!selectedServer || !window.workflowSkill?.toggleMCPServer) return
    const nextState = !selectedServer.enabled
    setToggling(true)
    try {
      const res = await window.workflowSkill.toggleMCPServer(
        {
          tool: selectedServer.sourceTool,
          scope: selectedServer.scope,
          name: selectedServer.name,
          expectedRevision: selectedServer.revision,
        },
        nextState
      )
      if (res.success) {
        notify?.(nextState ? t.mcp.enabledToast(selectedServer.name) : t.mcp.disabledToast(selectedServer.name))
        if (formBaseRevision === selectedServer.revision && res.server?.revision) {
          setFormBaseRevision(res.server.revision)
          setFormBaseline((prev) => (prev ? { ...prev, revision: res.server?.revision } : null))
        }
        await loadServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setToggling(false)
    }
  }

  // Handle Delete
  const handleDelete = async () => {
    if (!selectedServer || !window.workflowSkill?.deleteMCPServer) return
    setDeleting(true)
    try {
      const res = await window.workflowSkill.deleteMCPServer({
        tool: selectedServer.sourceTool,
        scope: selectedServer.scope,
        name: selectedServer.name,
        expectedRevision: selectedServer.revision,
      })
      if (res.success) {
        notify?.(t.mcp.deletedToast(selectedServer.name))
        setDeleteConfirmOpen(false)
        setSelectedServerId(null)
        setFormBaseline(null)
        lastLoadedIdRef.current = null
        setPreflightResult(null)
        setFrozenServer(null)
        setFrozenTargets([])
        await loadServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  // Handle Create New Server
  const handleCreate = async () => {
    if (!newName.trim() || !window.workflowSkill?.saveMCPServer) return
    setCreateSaving(true)
    try {
      const input: MCPServerInput = {
        name: newName.trim(),
        transport: newTransport,
        command: newTransport === 'stdio' ? newCommand.trim() : undefined,
        args: newTransport === 'stdio' ? newArgs : undefined,
        url: newTransport !== 'stdio' ? newUrl.trim() : undefined,
        enabled: true,
      }

      const res = await window.workflowSkill.saveMCPServer(
        { tool: newTool, scope: newScope },
        { ...input, isNew: true }
      )

      if (res.success && res.server) {
        notify?.(t.mcp.savedToast(input.name))
        setCreateModalOpen(false)
        setNewName('')
        setNewCommand('')
        setNewArgs([])
        setNewUrl('')
        // Navigate to newly created server destination so it is visible
        setActiveTool(newTool)
        setActiveTab(newScope)
        setQuery('')
        setSelectedServerId(res.server.id)
        setFormBaseline(null)
        lastLoadedIdRef.current = null
        setPreflightResult(null)
        setFrozenServer(null)
        setFrozenTargets([])
        await loadServers()
      } else {
        notify?.(res.error || t.mcp.operationFailed)
      }
    } catch (err) {
      notify?.((err as Error).message)
    } finally {
      setCreateSaving(false)
    }
  }

  // Handle Distribution Preflight
  const handlePreflight = async () => {
    if (isBusy || !selectedServer || !window.workflowSkill?.preflightMCPDistribution) return
    const targets: MCPDistributionTarget[] = Object.entries(selectedTargets)
      .filter(([, checked]) => checked)
      .map(([key]) => {
        const [tool, scope] = key.split(':') as [MCPSourceTool, MCPScope]
        return { tool, scope }
      })

    if (targets.length === 0) {
      notify?.(t.mcp.distributeSelectTargets)
      return
    }

    setPreflighting(true)
    try {
      const result = await window.workflowSkill.preflightMCPDistribution(selectedServer, targets)
      setPreflightResult(result)
      // Freeze the source server and targets snapshot with their preflight revision tokens
      setFrozenServer({ ...selectedServer })
      setFrozenTargets(
        result.targets.map((t) => ({
          tool: t.tool,
          scope: t.scope,
          expectedRevision: t.currentRevision,
        }))
      )
      setPreflightModalOpen(true)
    } catch (err) {
      notify?.(t.mcp.distributeFailToast((err as Error).message))
    } finally {
      setPreflighting(false)
    }
  }

  // Handle Execute Distribution
  const handleDistribute = async () => {
    if (!frozenServer || frozenTargets.length === 0 || !window.workflowSkill?.distributeMCPServer) return

    setDistributing(true)
    try {
      const report = await window.workflowSkill.distributeMCPServer(frozenServer, frozenTargets)
      const successCount = report.results.filter((r) => r.success).length
      const failCount = report.results.filter((r) => !r.success).length

      if (report.overallSuccess) {
        notify?.(t.mcp.distributeSuccessToast(successCount))
      } else if (successCount > 0) {
        notify?.(t.mcp.partialSuccessToast(successCount, failCount))
      } else {
        notify?.(t.mcp.distributeFailToast(report.results[0]?.error || t.mcp.operationFailed))
      }

      setPreflightModalOpen(false)
      await loadServers()
    } catch (err) {
      notify?.(t.mcp.distributeFailToast((err as Error).message))
    } finally {
      setDistributing(false)
    }
  }

  return (
    <>
      {/* =========================================================================
          Column 2: Master List (Width: 210px) - AGENTS.md §1.1
          ========================================================================= */}
      <aside className="app-col-master view-enter">
        <div className="master-header">
          {/* Tool Selector: 4 Tool Tabs - Height: 24px */}
          <div className="mcp-tool-nav">
            <div
              role="tablist"
              aria-label={t.mcp.toolTabsLabel}
              className="master-tab-segmented mcp-tool-segmented"
            >
              {MCP_SOURCE_TOOLS.map((tool) => {
                const isSelected = activeTool === tool.id
                return (
                  <button
                    type="button"
                    role="tab"
                    id={`mcp-tool-tab-${tool.id}`}
                    key={tool.id}
                    aria-selected={isSelected}
                    aria-label={TOOL_TAB_NAMES[tool.id]}
                    title={TOOL_TAB_NAMES[tool.id]}
                    tabIndex={isSelected ? 0 : -1}
                    className={`master-tab-btn mcp-tool-tab-btn ${isSelected ? 'is-active' : ''}`}
                    onClick={() => handleSwitchTool(tool.id)}
                    onKeyDown={(e) => handleToolTabKeyDown(e, tool.id)}
                    disabled={isBusy}
                  >
                    <AIToolLogo toolId={tool.id} size={14} color />
                  </button>
                )
              })}
            </div>
            <div className="mcp-selected-tool-label">
              <span className="mcp-selected-tool-name">{TOOL_TAB_NAMES[activeTool]}</span>
            </div>
          </div>

          {/* Segmented Tab: [ 全局 | 项目 ] - Height: 24px */}
          <div className="master-header-top">
            <div
              role="tablist"
              aria-label={t.mcp.scopeTabsLabel}
              className="master-tab-segmented mcp-scope-segmented"
            >
              <button
                type="button"
                role="tab"
                id="mcp-scope-tab-global"
                aria-selected={activeTab === 'global'}
                aria-label={t.mcp.tabGlobal}
                tabIndex={activeTab === 'global' ? 0 : -1}
                className={`master-tab-btn ${activeTab === 'global' ? 'is-active' : ''}`}
                onClick={() => handleSwitchScope('global')}
                onKeyDown={(e) => handleScopeTabKeyDown(e, 'global')}
                disabled={isBusy}
              >
                <span>{t.mcp.tabGlobal}</span>
              </button>
              <button
                type="button"
                role="tab"
                id="mcp-scope-tab-project"
                aria-selected={activeTab === 'project'}
                aria-label={t.mcp.tabProject}
                tabIndex={activeTab === 'project' ? 0 : -1}
                className={`master-tab-btn ${activeTab === 'project' ? 'is-active' : ''}`}
                onClick={() => handleSwitchScope('project')}
                onKeyDown={(e) => handleScopeTabKeyDown(e, 'project')}
                disabled={isBusy}
              >
                <span>{t.mcp.tabProject}</span>
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
              onClick={() => void loadServers()}
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
                  : t.mcp.emptyToolTitle(TOOL_TAB_NAMES[activeTool])}
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
                  {t.mcp.emptyToolDesc(
                    TOOL_TAB_NAMES[activeTool],
                    activeTab === 'global' ? t.mcp.tabGlobal : t.mcp.tabProject
                  )}
                </p>
              )}
            </div>
          ) : (
            filteredServers.map((server) => {
              const isSelected = selectedServer?.id === server.id
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
                      <AIToolLogo toolId={server.sourceTool} size={15} color />
                    </div>
                    <div className="mcp-master-row__info">
                      <span className="mcp-master-row__name">{server.name}</span>
                      <div className="mcp-master-row__sub">
                        <span className="mcp-badge mcp-badge--transport">{server.transport}</span>
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

        {/* Bottom Action Bar: New Server Button (Height: 24px) */}
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
      <section className="app-col-detail view-enter" style={{ overflowY: 'auto' }}>
        {!selectedServer ? (
          <div className="detail-empty-wrap" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '12px' }}>
            <Server size={32} style={{ color: 'var(--color-muted)', opacity: 0.5 }} />
            <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--color-ink)', margin: 0 }}>
              {query.trim()
                ? t.mcp.emptySearch
                : filteredServers.length === 0
                ? t.mcp.emptyToolTitle(TOOL_TAB_NAMES[activeTool])
                : t.mcp.emptyDetailTitle}
            </h2>
            <p style={{ fontSize: '0.8125rem', color: 'var(--color-muted)', maxWidth: 360, textAlign: 'center', margin: 0 }}>
              {query.trim()
                ? t.mcp.emptySearchDesc(query)
                : filteredServers.length === 0
                ? t.mcp.emptyToolDesc(
                    TOOL_TAB_NAMES[activeTool],
                    activeTab === 'global' ? t.mcp.tabGlobal : t.mcp.tabProject
                  )
                : t.mcp.emptyDetailDesc}
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
                  <AIToolLogo toolId={selectedServer.sourceTool} size={24} color />
                </div>
                <div className="mcp-hero-titles">
                  <div className="mcp-hero-title-row">
                    <h1 className="mcp-hero-name font-mono">{selectedServer.name}</h1>
                    <span className="pinned-ver-pill font-mono">{selectedServer.transport}</span>
                    <span className="pinned-ver-pill">
                      {selectedServer.scope === 'global' ? t.mcp.tabGlobal : t.mcp.tabProject}
                    </span>
                    {!selectedServer.enabled ? (
                      <span className="mcp-badge mcp-badge--disabled">{t.mcp.statusDisabled}</span>
                    ) : (
                      <span className="mcp-badge" style={{ background: 'rgba(16, 185, 129, 0.12)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                        {t.mcp.statusActive}
                      </span>
                    )}
                  </div>
                  <div className="mcp-hero-subtitle font-mono">
                    <span>{selectedServer.configPath}</span>
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
                  style={{ color: '#ef4444' }}
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

            {/* Main Configuration Card */}
            <div className="mcp-card">
              <h3 className="mcp-card-title">
                <span>{t.mcp.configCardTitle}</span>
                <span className="font-mono" style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                  {selectedServer.sourceTool}
                </span>
              </h3>

              <div className="mcp-form-grid">
                {/* Name - Immutable primary key */}
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
                              <textarea rows={1}
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
                    {selectedServer.sourceTool === 'codex' && <div className="mcp-form-field">
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
                    </div>}
                  </>
                )}
              </div>
            </div>

            {/* Cross-Tool Distribution Matrix Card */}
            <div className="mcp-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <h3 className="mcp-card-title">{t.mcp.distributeTitle}</h3>
                  <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', margin: '2px 0 0' }}>
                    {t.mcp.distributeSubtitle}
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn--capsule-ghost btn--sm"
                    onClick={() => void handlePreflight()}
                  >
                    <Search size={12} />
                    <span>{t.mcp.preflightBtn}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn--capsule btn--sm"
                    disabled={isBusy}
                    onClick={() => void handlePreflight()}
                  >
                    {distributing ? <RefreshCw size={12} className="spin" /> : <Share2 size={12} />}
                    <span>{distributing ? t.mcp.distributingBtn : t.mcp.distributeBtn}</span>
                  </button>
                </div>
              </div>

              {/* Matrix Grid */}
              <div className="mcp-dist-matrix">
                {MCP_SOURCE_TOOLS.map((tool) => {
                  const isCurrentSource = tool.id === selectedServer.sourceTool
                  const targetKey = `${tool.id}:${selectedServer.scope}`
                  const isChecked = Boolean(selectedTargets[targetKey])

                  // Check if server with same name exists in this tool & scope
                  const scopeList = selectedServer.scope === 'global' ? servers.global : servers.project
                  const targetMatch = scopeList.find(
                    (s) => s.sourceTool === tool.id && s.name === selectedServer.name
                  )

                  let statusText = t.mcp.notConfigured
                  let statusClass = 'is-none'

                  if (isCurrentSource) {
                    statusText = t.mcp.currentSource
                    statusClass = 'is-synced'
                  } else if (targetMatch) {
                    // Compare transport and parameters
                    const isSynced =
                      targetMatch.transport === selectedServer.transport &&
                      targetMatch.command === selectedServer.command &&
                      targetMatch.url === selectedServer.url
                    if (isSynced) {
                      statusText = t.mcp.alreadySynced
                      statusClass = 'is-synced'
                    } else {
                      statusText = t.mcp.differentConfig
                      statusClass = 'is-diff'
                    }
                  }

                  return (
                    <div
                      key={tool.id}
                      className={`mcp-dist-card ${isCurrentSource ? 'is-current' : ''}`}
                    >
                      <div className="mcp-dist-card__top">
                        <div className="mcp-dist-card__tool">
                          <AIToolLogo toolId={tool.id} size={18} color />
                          <span className="mcp-dist-card__name">{tool.name}</span>
                        </div>
                        <span className={`mcp-dist-status-badge ${statusClass}`}>{statusText}</span>
                      </div>

                      <div className="mcp-dist-card__path">
                        {selectedServer.scope === 'global' ? tool.globalConfigFileName : tool.projectConfigFileName}
                      </div>

                      <div className="mcp-dist-card__footer">
                        {isCurrentSource ? (
                          <span style={{ fontSize: '0.6875rem', color: 'var(--color-muted)' }}>{t.mcp.currentSource}</span>
                        ) : (
                          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', cursor: 'pointer', color: 'var(--color-ink)' }}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                setSelectedTargets({
                                  ...selectedTargets,
                                  [targetKey]: e.target.checked,
                                })
                              }}
                            />
                            <span>{t.mcp.syncTargetLabel}</span>
                          </label>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* =========================================================================
          Modals: Unsaved Changes Confirmation Dialog
          ========================================================================= */}
      {unsavedModalOpen ? (
        <div className="mcp-dialog-overlay" onClick={handleCancelUnsaved}>
          <div ref={unsavedDialogRef} role="dialog" aria-modal="true" aria-labelledby="mcp-unsaved-title" className="mcp-dialog-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="mcp-dialog-header">
              <h3 id="mcp-unsaved-title" className="mcp-dialog-title">{t.mcp.unsavedTitle}</h3>
              <button
                type="button"
                className="clear-search-btn"
                aria-label={t.mcp.cancelBtn}
                onClick={handleCancelUnsaved}
              >
                <X size={14} />
              </button>
            </div>

            <div className="mcp-dialog-body">
              <p style={{ fontSize: '0.8125rem', color: 'var(--color-ink)', margin: 0 }}>
                {t.mcp.unsavedDesc}
              </p>
            </div>

            <div className="mcp-dialog-footer">
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                ref={cancelUnsavedRef}
                onClick={handleCancelUnsaved}
              >
                <span>{t.mcp.cancelBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule btn--sm"
                style={{ background: '#ef4444', borderColor: '#ef4444', color: '#ffffff' }}
                onClick={handleConfirmDiscard}
              >
                <span>{t.mcp.discardBtn}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* =========================================================================
          Modals: Create New MCP Server Dialog
          ========================================================================= */}
      {createModalOpen ? (
        <div className="mcp-dialog-overlay" onClick={() => setCreateModalOpen(false)}>
          <div className="mcp-dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-dialog-header">
              <h3 className="mcp-dialog-title">{t.mcp.createTitle}</h3>
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setCreateModalOpen(false)}
              >
                <X size={14} />
              </button>
            </div>

            <div className="mcp-dialog-body">
              {/* Scope & Tool selector */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="mcp-form-field">
                  <label className="mcp-field-label">{t.mcp.scopeLabel}</label>
                  <select
                    className="mcp-input"
                    value={newScope}
                    onChange={(e) => setNewScope(e.target.value as MCPScope)}
                  >
                    <option value="global">{t.mcp.tabGlobal}</option>
                    <option value="project">{t.mcp.tabProject}</option>
                  </select>
                </div>

                <div className="mcp-form-field">
                  <label className="mcp-field-label">{t.mcp.sourceToolLabel}</label>
                  <select
                    className="mcp-input"
                    value={newTool}
                    onChange={(e) => setNewTool(e.target.value as MCPSourceTool)}
                  >
                    {MCP_SOURCE_TOOLS.map((tool) => (
                      <option key={tool.id} value={tool.id}>
                        {tool.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Server Name */}
              <div className="mcp-form-field">
                <label className="mcp-field-label">{t.mcp.serverNameLabel}</label>
                <input
                  className="mcp-input font-mono"
                  placeholder={t.mcp.serverNamePlaceholder}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>

              {/* Transport */}
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
                  <div className="mcp-form-field">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label className="mcp-field-label" style={{ margin: 0 }}>{t.mcp.argsLabel}</label>
                      <button
                        type="button"
                        className="btn btn--capsule-ghost btn--sm"
                        style={{ height: '22px', padding: '0 6px', fontSize: '0.6875rem' }}
                        onClick={() => setNewArgs([...newArgs, ''])}
                      >
                        <Plus size={10} />
                        <span>{t.mcp.addArgBtn}</span>
                      </button>
                    </div>
                    <div className="mcp-args-list">
                      {newArgs.length === 0 ? (
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-muted)', fontStyle: 'italic', padding: '4px 0' }}>
                          {t.mcp.argsPlaceholder}
                        </div>
                      ) : (
                        newArgs.map((arg, idx) => (
                          <div key={idx} className="mcp-arg-row">
                            <textarea rows={1}
                              aria-label={`${t.mcp.argsLabel} ${idx + 1}`}
                              className="mcp-arg-input"
                              placeholder={t.mcp.argPlaceholder}
                              value={arg}
                              onChange={(e) => {
                                const next = [...newArgs]
                                next[idx] = e.target.value
                                setNewArgs(next)
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn--capsule-ghost btn--sm"
                              style={{ width: '22px', height: '22px', padding: 0 }}
                              onClick={() => setNewArgs(newArgs.filter((_, i) => i !== idx))}
                              title="Delete"
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
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

            <div className="mcp-dialog-footer">
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setCreateModalOpen(false)}
              >
                <span>{t.mcp.cancelBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule btn--sm"
                disabled={!newName.trim() || createSaving}
                onClick={() => void handleCreate()}
              >
                {createSaving ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
                <span>{createSaving ? t.mcp.savingBtn : t.mcp.createBtn}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Preflight Modal */}
      {preflightModalOpen && preflightResult ? (
        <div className="mcp-dialog-overlay" onClick={() => setPreflightModalOpen(false)}>
          <div className="mcp-dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-dialog-header">
              <h3 className="mcp-dialog-title">{t.mcp.preflightBtn}</h3>
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setPreflightModalOpen(false)}
              >
                <X size={14} />
              </button>
            </div>

            <div className="mcp-dialog-body">
              <p style={{ fontSize: '0.8125rem', color: 'var(--color-ink)', margin: 0 }}>
                {t.mcp.preflightSummary(frozenServer?.name || "")}
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {preflightResult.targets.map((target, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'var(--surface-float)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '0.8125rem' }}>
                        <AIToolLogo toolId={target.tool} size={14} color />
                        <span>{target.tool} ({target.scope})</span>
                      </div>
                      {target.willOverwrite ? (
                        <span style={{ fontSize: '0.6875rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <AlertCircle size={10} />
                          <span>{t.mcp.willOverwriteNotice}</span>
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.6875rem', color: '#10b981', display: 'flex', alignItems: 'center', gap: '3px' }}>
                          <CheckCircle2 size={10} />
                          <span>{t.mcp.newTargetLabel}</span>
                        </span>
                      )}
                    </div>
                    <span className="font-mono" style={{ fontSize: '0.6875rem', color: 'var(--color-muted)' }}>
                      {target.configPath}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mcp-dialog-footer">
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setPreflightModalOpen(false)}
              >
                <span>{t.mcp.cancelBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule btn--sm"
                disabled={distributing}
                onClick={() => void handleDistribute()}
              >
                {distributing ? <RefreshCw size={12} className="spin" /> : <Share2 size={12} />}
                <span>{t.mcp.distributeBtn}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete Confirm Modal */}
      {deleteConfirmOpen && selectedServer ? (
        <div className="mcp-dialog-overlay" onClick={() => setDeleteConfirmOpen(false)}>
          <div className="mcp-dialog-box" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="mcp-dialog-header">
              <h3 className="mcp-dialog-title">{t.mcp.deleteConfirmTitle}</h3>
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setDeleteConfirmOpen(false)}
              >
                <X size={14} />
              </button>
            </div>

            <div className="mcp-dialog-body">
              <p style={{ fontSize: '0.8125rem', color: 'var(--color-ink)', margin: 0 }}>
                {t.mcp.deleteConfirmDesc(selectedServer.name, selectedServer.sourceTool)}
              </p>
              <p className="font-mono" style={{ fontSize: '0.6875rem', color: 'var(--color-muted)', margin: 0 }}>
                {selectedServer.configPath}
              </p>
            </div>

            <div className="mcp-dialog-footer">
              <button
                type="button"
                className="btn btn--capsule-ghost btn--sm"
                onClick={() => setDeleteConfirmOpen(false)}
              >
                <span>{t.mcp.cancelBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn--capsule btn--sm"
                style={{ background: '#ef4444', borderColor: '#ef4444', color: '#ffffff' }}
                disabled={deleting}
                onClick={() => void handleDelete()}
              >
                {deleting ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
                <span>{t.mcp.confirmDeleteBtn}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
