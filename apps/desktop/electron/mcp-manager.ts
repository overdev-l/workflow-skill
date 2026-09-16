import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode,
} from 'jsonc-parser'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parseTOML } from 'toml-eslint-parser'
import {
  type BatchItemResult,
  type CentralMCPServer,
  type MCPDistributionPreflightItem,
  type MCPDistributionPreflightResult,
  type MCPDistributionReport,
  type MCPDistributionResultItem,
  type MCPDistributionTarget,
  type MCPScope,
  type MCPServerDefinition,
  type MCPServerInput,
  type MCPSourceTool,
  type MCPTargetAssociation,
  type MCPTransportType,
  MCP_SOURCE_TOOLS,
} from '@workflow-skill/workflow-model'

export const VALID_MCP_TOOLS: readonly MCPSourceTool[] = [
  'claude-code',
  'cursor',
  'gemini',
  'codex',
  'opencode',
  'grok',
  'antigravity',
]
export const VALID_MCP_SCOPES: readonly MCPScope[] = ['global', 'project']

export function validateToolAndScope(tool: unknown, scope: unknown): { tool: MCPSourceTool; scope: MCPScope } {
  if (!VALID_MCP_TOOLS.includes(tool as MCPSourceTool)) {
    throw new Error(`Invalid tool "${String(tool)}". Must be one of: ${VALID_MCP_TOOLS.join(', ')}`)
  }
  if (!VALID_MCP_SCOPES.includes(scope as MCPScope)) {
    throw new Error(`Invalid scope "${String(scope)}". Must be "global" or "project"`)
  }
  return { tool: tool as MCPSourceTool, scope: scope as MCPScope }
}

export interface MCPOptions {
  homeDir?: string
  projectWorkspace?: string
  traceHome?: string
  getProjectWorkspace?: () => string
  getTraceHome?: () => string
  beforeWriteHook?: () => void // Test hook to simulate concurrent external writes
  beforeSecondWriteHook?: () => void // Test hook to simulate second write failure
}

export interface DisabledServerRecord {
  id: string
  name: string
  sourceTool: MCPSourceTool
  tool: MCPSourceTool
  scope: MCPScope
  server: MCPServerDefinition
  rawEntry: Record<string, unknown>
  projectWorkspace?: string
  disabledAt: number
}

interface DisabledRegistryFile {
  version: 1
  entries: Record<string, DisabledServerRecord>
}

// =========================================================================
// Path Resolution
// =========================================================================

export function getEffectiveHomeDir(options?: MCPOptions): string {
  return options?.homeDir || os.homedir()
}

export function getEffectiveProjectWorkspace(options?: MCPOptions): string {
  if (options?.projectWorkspace && options.projectWorkspace.trim()) {
    return options.projectWorkspace.trim()
  }
  if (options?.getProjectWorkspace) {
    const ws = options.getProjectWorkspace()
    if (ws && ws.trim()) return ws.trim()
  }
  throw new Error('No valid project workspace selected. Please select a project.')
}

export function getEffectiveTraceHome(options?: MCPOptions): string {
  if (options?.traceHome) return options.traceHome
  if (options?.getTraceHome) return options.getTraceHome()
  return path.join(getEffectiveHomeDir(options), '.trace')
}

export function resolveMCPConfigPath(
  tool: MCPSourceTool,
  scope: MCPScope,
  options?: MCPOptions
): string {
  validateToolAndScope(tool, scope)
  const homeDir = getEffectiveHomeDir(options)

  if (scope === 'global') {
    switch (tool) {
      case 'claude-code':
        return path.join(homeDir, '.claude.json')
      case 'cursor':
        return path.join(homeDir, '.cursor', 'mcp.json')
      case 'gemini':
        return path.join(homeDir, '.gemini', 'settings.json')
      case 'codex':
        return path.join(homeDir, '.codex', 'config.toml')
      case 'opencode': {
        const jsoncPath = path.join(homeDir, '.config', 'opencode', 'opencode.jsonc')
        const jsonPath = path.join(homeDir, '.config', 'opencode', 'opencode.json')
        if (existsSync(jsoncPath) && !existsSync(jsonPath)) return jsoncPath
        return jsonPath
      }
      case 'grok':
        return path.join(homeDir, '.grok', 'config.toml')
      case 'antigravity':
        return path.join(homeDir, '.gemini', 'config', 'mcp_config.json')
    }
  } else if (scope === 'project') {
    const projectWorkspace = getEffectiveProjectWorkspace(options)
    switch (tool) {
      case 'claude-code':
        return path.join(projectWorkspace, '.mcp.json')
      case 'cursor':
        return path.join(projectWorkspace, '.cursor', 'mcp.json')
      case 'gemini':
        return path.join(projectWorkspace, '.gemini', 'settings.json')
      case 'codex':
        return path.join(projectWorkspace, '.codex', 'config.toml')
      case 'opencode': {
        const jsoncPath = path.join(projectWorkspace, 'opencode.jsonc')
        const jsonPath = path.join(projectWorkspace, 'opencode.json')
        if (existsSync(jsoncPath) && !existsSync(jsonPath)) return jsoncPath
        return jsonPath
      }
      case 'grok':
        return path.join(projectWorkspace, '.grok', 'config.toml')
      case 'antigravity':
        return path.join(projectWorkspace, '.agents', 'mcp_config.json')
    }
  } else {
    throw new Error(`Unsupported MCP scope: ${String(scope)}`)
  }
}

export function getDisabledRegistryPath(options?: MCPOptions): string {
  const traceHome = getEffectiveTraceHome(options)
  return path.join(traceHome, 'mcp-disabled.json')
}

// =========================================================================
// Validation & Security
// =========================================================================

export function validateServerName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Server name must be a non-empty string.')
  }
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new Error('Server name length must be between 1 and 100 characters.')
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error('Server name cannot use restricted object property names.')
  }
  if (/[/\\:]/.test(name) || name.includes('..')) {
    throw new Error('Server name cannot contain path traversal or separator characters.')
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(
      'Server name contains invalid characters. Use letters, numbers, dashes, underscores, or dots.'
    )
  }
}

function validateServerNameForTool(name: string, targetTool?: MCPSourceTool): void {
  validateServerName(name)

  // Grok's native loader only admits names that start with a letter or
  // underscore and contain ASCII letters, digits, underscores, or dashes.
  if (targetTool === 'grok' && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error('Grok server names must start with a letter or underscore and contain only letters, numbers, dashes, or underscores.')
  }
}

export function validateServerInput(input: MCPServerInput, targetTool?: MCPSourceTool): void {
  validateServerNameForTool(input.name, targetTool)

  if (targetTool) {
    if (!VALID_MCP_TOOLS.includes(targetTool)) {
      throw new Error(`Invalid tool "${targetTool}". Must be one of: ${VALID_MCP_TOOLS.join(', ')}`)
    }
  }

  if (!['stdio', 'sse', 'http'].includes(input.transport)) {
    throw new Error(`Unsupported transport type: "${input.transport}". Must be "stdio", "sse", or "http".`)
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('Property "enabled" must be a boolean.')
  }

  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.trim().length === 0)) {
    throw new Error('Property "cwd" must be a non-empty string if provided.')
  }

  if (input.expectedRevision !== undefined && typeof input.expectedRevision !== 'string') {
    throw new Error('Property "expectedRevision" must be a string if provided.')
  }

  // Codex does not support SSE
  if (targetTool === 'codex' && input.transport === 'sse') {
    throw new Error('Codex does not support SSE transport. Use HTTP (streamable) or stdio.')
  }

  if (targetTool) {
    const meta = MCP_SOURCE_TOOLS.find((m) => m.id === targetTool)
    if (meta && !meta.supportedTransports.includes(input.transport)) {
      throw new Error(`${meta.name} does not support ${input.transport} transport.`)
    }
  }

  // Non-Codex tools do not support env_http_headers
  if (targetTool && targetTool !== 'codex' && input.envHeaders && Object.keys(input.envHeaders).length > 0) {
    throw new Error(`${targetTool} does not support env_http_headers. Only Codex supports this feature.`)
  }

  if (input.transport === 'stdio') {
    if (!input.command || typeof input.command !== 'string' || input.command.trim().length === 0) {
      throw new Error('Command is required for stdio transport.')
    }
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === 'string')) {
        throw new Error('Arguments must be an array of strings.')
      }
    }
    if (input.env !== undefined) {
      if (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env)) {
        throw new Error('Environment variables must be a key-value object.')
      }
      for (const [k, v] of Object.entries(input.env)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          throw new Error('Environment variable keys and values must be strings.')
        }
      }
    }
  } else {
    // sse or http
    if (!input.url || typeof input.url !== 'string' || input.url.trim().length === 0) {
      throw new Error('URL is required for SSE or HTTP transport.')
    }
    const trimmedUrl = input.url.trim()
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      throw new Error('URL must start with http:// or https://')
    }
    if (input.headers !== undefined) {
      if (typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers)) {
        throw new Error('Headers must be a key-value object.')
      }
      for (const [k, v] of Object.entries(input.headers)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          throw new Error('Header keys and values must be strings.')
        }
      }
    }
    if (input.envHeaders !== undefined) {
      if (typeof input.envHeaders !== 'object' || input.envHeaders === null || Array.isArray(input.envHeaders)) {
        throw new Error('Environment headers must be a key-value object.')
      }
      for (const [k, v] of Object.entries(input.envHeaders)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          throw new Error('Environment header keys and values must be strings.')
        }
      }
    }
  }
}

// =========================================================================
// Atomic File Operations & Deep Equality
// =========================================================================

export function atomicWriteFile(targetPath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.trace-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  try {
    writeFileSync(tempPath, content, { mode, encoding: 'utf8' })
    renameSync(tempPath, targetPath)
  } finally {
    if (existsSync(tempPath)) {
      try {
        rmSync(tempPath, { force: true })
      } catch {}
    }
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false
    if (!deepEqual(objA[key], objB[key])) return false
  }
  return true
}

// =========================================================================
// Revision Computation & Concurrency Guard
// =========================================================================

export function computeServerRevision(
  tool: MCPSourceTool,
  scope: MCPScope,
  name: string,
  options?: MCPOptions
): string {
  validateToolAndScope(tool, scope)
  const configPath = resolveMCPConfigPath(tool, scope, options)

  const configContent = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const disabled = getDisabledEntry(tool, scope, name, options)
  const disabledStr = disabled ? JSON.stringify(disabled) : ''

  const h = createHash('sha256')
  h.update(configContent)
  h.update(disabledStr)
  h.update(`${scope}:${tool}:${name}`)
  return h.digest('hex').slice(0, 16)
}

// =========================================================================
// Transaction Manager & Owned Writes Tracking
// =========================================================================

export interface WrittenFileRecord {
  filePath: string
  initialExisted: boolean
  initialContent: string | null
  initialMode: number
  writtenContent: string
}

export class TransactionManager {
  private written: WrittenFileRecord[] = []

  public recordWrite(
    filePath: string,
    initialExisted: boolean,
    initialContent: string | null,
    initialMode: number,
    writtenContent: string
  ): void {
    const existing = this.written.find((r) => r.filePath === filePath)
    if (existing) {
      existing.writtenContent = writtenContent
    } else {
      this.written.push({
        filePath,
        initialExisted,
        initialContent,
        initialMode,
        writtenContent,
      })
    }
  }

  public rollback(): void {
    let incomplete = false
    for (let i = this.written.length - 1; i >= 0; i--) {
      const record = this.written[i]
      try {
        if (!existsSync(record.filePath)) {
          incomplete = true
          continue
        }
        const currentContent = readFileSync(record.filePath, 'utf8')
        // Restore ONLY owned writes and ONLY IF current bytes still equal our written bytes
        if (currentContent === record.writtenContent) {
          if (record.initialExisted && record.initialContent !== null) {
            atomicWriteFile(record.filePath, record.initialContent, record.initialMode)
          } else {
            rmSync(record.filePath, { force: true })
          }
        } else {
          incomplete = true
        }
      } catch {
        incomplete = true
      }
    }
    if (incomplete) throw new Error('MCP rollback incomplete: a file changed externally or could not be restored. Reload the configuration before continuing.')
  }

  public hasWrites(): boolean {
    return this.written.length > 0
  }
}

// =========================================================================
// Trace Disabled Registry
// =========================================================================

function makeRegistryKey(scope: MCPScope, tool: MCPSourceTool, name: string, projectWorkspace?: string): string {
  if (scope === 'project' && projectWorkspace) {
    return `project:${projectWorkspace}:${tool}:${name}`
  }
  return `${scope}:${tool}:${name}`
}

export function loadDisabledRegistry(options?: MCPOptions): Record<string, DisabledServerRecord> {
  const regPath = getDisabledRegistryPath(options)
  if (!existsSync(regPath)) return {}
  const raw = readFileSync(regPath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as DisabledRegistryFile
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.entries !== 'object') {
      throw new Error('Disabled registry file format is corrupted.')
    }
    return parsed.entries || {}
  } catch (err) {
    throw new Error(`Failed to parse disabled registry at "${regPath}": ${(err as Error).message}`)
  }
}

export function saveDisabledRegistry(
  entries: Record<string, DisabledServerRecord>,
  options?: MCPOptions,
  tx?: TransactionManager
): void {
  const regPath = getDisabledRegistryPath(options)
  const initialExisted = existsSync(regPath)
  let initialContent: string | null = null
  let initialMode = 0o600
  if (initialExisted) {
    try {
      initialContent = readFileSync(regPath, 'utf8')
      initialMode = statSync(regPath).mode & 0o777
    } catch {}
  }
  const data: DisabledRegistryFile = {
    version: 1,
    entries,
  }
  const serialized = JSON.stringify(data, null, 2) + '\n'
  atomicWriteFile(regPath, serialized, initialMode)
  if (tx) {
    tx.recordWrite(regPath, initialExisted, initialContent, initialMode, serialized)
  }
}

function getDisabledEntry(
  tool: MCPSourceTool,
  scope: MCPScope,
  name: string,
  options?: MCPOptions
): DisabledServerRecord | undefined {
  if (!VALID_MCP_TOOLS.includes(tool) || !VALID_MCP_SCOPES.includes(scope)) {
    return undefined
  }
  const projectWorkspace = scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined
  const registry = loadDisabledRegistry(options)
  const key = makeRegistryKey(scope, tool, name, projectWorkspace)
  return registry[key]
}

function setDisabledEntry(
  record: DisabledServerRecord,
  options?: MCPOptions,
  tx?: TransactionManager
): void {
  const projectWorkspace = record.scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined
  const registry = loadDisabledRegistry(options)
  const key = makeRegistryKey(record.scope, record.sourceTool || record.tool, record.name, projectWorkspace)
  registry[key] = {
    ...record,
    tool: record.sourceTool || record.tool,
    sourceTool: record.sourceTool || record.tool,
  }
  saveDisabledRegistry(registry, options, tx)
}

function removeDisabledEntry(
  tool: MCPSourceTool,
  scope: MCPScope,
  name: string,
  options?: MCPOptions,
  tx?: TransactionManager
): DisabledServerRecord | undefined {
  const projectWorkspace = scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined
  const registry = loadDisabledRegistry(options)
  const key = makeRegistryKey(scope, tool, name, projectWorkspace)
  const existing = registry[key]
  if (existing) {
    delete registry[key]
    saveDisabledRegistry(registry, options, tx)
  }
  return existing
}

// =========================================================================
// Format Conversion & Field Translation
// =========================================================================

export function buildServerDefinitionFromRaw(
  tool: MCPSourceTool,
  scope: MCPScope,
  name: string,
  entry: Record<string, unknown>,
  configPath: string,
  nativeEnabled?: boolean,
  revision?: string
): MCPServerDefinition {
  const id = `${scope}:${tool}:${name}`

  // 1. Identify Transport
  let transport: MCPTransportType = 'stdio'
  if (tool === 'claude-code') {
    if (entry.type === 'sse') transport = 'sse'
    else if (entry.type === 'http') transport = 'http'
    else if (typeof entry.url === 'string' && entry.url.length > 0) {
      transport = entry.type === 'sse' ? 'sse' : 'http'
    } else {
      transport = 'stdio'
    }
  } else if (tool === 'gemini') {
    if (typeof entry.httpUrl === 'string' && entry.httpUrl.length > 0) {
      transport = 'http'
    } else if (typeof entry.url === 'string' && entry.url.length > 0) {
      transport = 'sse'
    } else {
      transport = 'stdio'
    }
  } else if (tool === 'antigravity') {
    if (typeof entry.serverUrl === 'string' && entry.serverUrl.length > 0) {
      transport = entry.transport === 'sse' || entry.type === 'sse' ? 'sse' : 'http'
    } else if (typeof entry.url === 'string' && entry.url.length > 0) {
      transport = entry.transport === 'sse' || entry.type === 'sse' ? 'sse' : 'http'
    } else {
      transport = 'stdio'
    }
  } else if (tool === 'opencode') {
    if (entry.type === 'remote' || (typeof entry.url === 'string' && entry.url.length > 0)) {
      transport = entry.transport === 'sse' ? 'sse' : 'http'
    } else {
      transport = 'stdio'
    }
  } else if (tool === 'grok') {
    if (entry.transport === 'sse') {
      transport = 'sse'
    } else if (entry.transport === 'http') {
      transport = 'http'
    } else if (typeof entry.url === 'string' && entry.url.length > 0) {
      transport = 'http'
    } else {
      transport = 'stdio'
    }
  } else {
    // Cursor & Codex
    if (typeof entry.url === 'string' && entry.url.length > 0) {
      transport = 'http'
    } else {
      transport = 'stdio'
    }
  }

  // 2. Extract standard fields
  let command: string | undefined
  let args: string[] | undefined

  if (tool === 'opencode' && Array.isArray(entry.command)) {
    const cmdList = entry.command.map((c) => String(c))
    command = cmdList[0] || ''
    args = cmdList.slice(1)
  } else {
    command = typeof entry.command === 'string' ? entry.command : undefined
    args = Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : undefined
  }

  let env: Record<string, string> | undefined
  if (
    tool === 'opencode' &&
    entry.environment &&
    typeof entry.environment === 'object' &&
    !Array.isArray(entry.environment)
  ) {
    env = entry.environment as Record<string, string>
  } else if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
    env = entry.env as Record<string, string>
  }

  const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined

  let url: string | undefined
  if (tool === 'gemini' && typeof entry.httpUrl === 'string') {
    url = entry.httpUrl
  } else if (tool === 'antigravity' && typeof entry.serverUrl === 'string') {
    url = entry.serverUrl
  } else if (typeof entry.url === 'string') {
    url = entry.url
  }

  let headers: Record<string, string> | undefined
  if (tool === 'codex' && entry.http_headers && typeof entry.http_headers === 'object') {
    headers = entry.http_headers as Record<string, string>
  } else if (entry.headers && typeof entry.headers === 'object') {
    headers = entry.headers as Record<string, string>
  }

  let envHeaders: Record<string, string> | undefined
  if (tool === 'codex' && entry.env_http_headers && typeof entry.env_http_headers === 'object') {
    envHeaders = entry.env_http_headers as Record<string, string>
  }

  // 3. Enabled status
  let enabled = true
  if (typeof nativeEnabled === 'boolean') {
    enabled = nativeEnabled
  } else if ((tool === 'codex' || tool === 'grok') && typeof entry.enabled === 'boolean') {
    enabled = entry.enabled
  } else if (tool === 'antigravity' || tool === 'opencode') {
    if (entry.disabled === true || entry.enabled === false) {
      enabled = false
    } else {
      enabled = true
    }
  }

  return {
    id,
    name,
    sourceTool: tool,
    scope,
    transport,
    command,
    args,
    env,
    cwd,
    url,
    headers,
    envHeaders,
    enabled,
    sourceRaw: { ...entry },
    configPath,
    revision,
  }
}

export function convertServerToToolConfig(
  tool: MCPSourceTool,
  input: MCPServerDefinition | MCPServerInput,
  existingRaw?: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = existingRaw ? { ...existingRaw } : {}

  if (tool === 'claude-code') {
    if (input.transport === 'stdio') {
      result.type = 'stdio'
      result.command = input.command || ''
      if (input.args && input.args.length > 0) result.args = input.args
      else delete result.args
      if (input.env && Object.keys(input.env).length > 0) result.env = input.env
      else delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.url
      delete result.headers
    } else {
      result.type = input.transport === 'sse' ? 'sse' : 'http'
      result.url = input.url || ''
      if (input.headers && Object.keys(input.headers).length > 0) result.headers = input.headers
      else delete result.headers
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    }
  } else if (tool === 'cursor') {
    delete result.type
    if (input.transport === 'stdio') {
      result.command = input.command || ''
      if (input.args && input.args.length > 0) result.args = input.args
      else delete result.args
      if (input.env && Object.keys(input.env).length > 0) result.env = input.env
      else delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.url
      delete result.headers
    } else {
      result.url = input.url || ''
      if (input.headers && Object.keys(input.headers).length > 0) result.headers = input.headers
      else delete result.headers
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    }
  } else if (tool === 'gemini') {
    delete result.type
    if (input.transport === 'stdio') {
      result.command = input.command || ''
      if (input.args && input.args.length > 0) result.args = input.args
      else delete result.args
      if (input.env && Object.keys(input.env).length > 0) result.env = input.env
      else delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.url
      delete result.httpUrl
      delete result.headers
    } else if (input.transport === 'sse') {
      result.url = input.url || ''
      delete result.httpUrl
      if (input.headers && Object.keys(input.headers).length > 0) result.headers = input.headers
      else delete result.headers
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    } else {
      // Streamable HTTP
      result.httpUrl = input.url || ''
      delete result.url
      if (input.headers && Object.keys(input.headers).length > 0) result.headers = input.headers
      else delete result.headers
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    }
  } else if (tool === 'codex') {
    delete result.type
    if (input.transport === 'stdio') {
      result.command = input.command || ''
      if (input.args && input.args.length > 0) result.args = input.args
      else delete result.args
      if (input.env && Object.keys(input.env).length > 0) result.env = input.env
      else delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.url
      delete result.http_headers
      delete result.env_http_headers
    } else {
      result.url = input.url || ''
      if (input.headers && Object.keys(input.headers).length > 0) result.http_headers = input.headers
      else delete result.http_headers
      if (input.envHeaders && Object.keys(input.envHeaders).length > 0) {
        result.env_http_headers = input.envHeaders
      } else {
        delete result.env_http_headers
      }
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    }

    if (typeof input.enabled === 'boolean') {
      result.enabled = input.enabled
    }
  } else if (tool === 'grok') {
    delete result.type
    if (input.transport === 'stdio') {
      delete result.transport
      result.command = input.command || ''
      if (input.args && input.args.length > 0) result.args = input.args
      else delete result.args
      if (input.env && Object.keys(input.env).length > 0) result.env = input.env
      else delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.url
      delete result.headers
    } else {
      result.url = input.url || ''
      if (input.transport === 'sse' || input.transport === 'http') {
        result.transport = input.transport
      }
      if (input.headers && Object.keys(input.headers).length > 0) result.headers = input.headers
      else delete result.headers
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    }

    if (typeof input.enabled === 'boolean') {
      result.enabled = input.enabled
    }
  } else if (tool === 'antigravity') {
    delete result.type
    if (input.transport === 'stdio') {
      delete result.transport
      result.command = input.command || ''
      if (input.args && input.args.length > 0) result.args = input.args
      else delete result.args
      if (input.env && Object.keys(input.env).length > 0) result.env = input.env
      else delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.serverUrl
      delete result.url
      delete result.httpUrl
      delete result.headers
    } else {
      result.serverUrl = input.url || ''
      // Antigravity negotiates remote SSE/Streamable HTTP from serverUrl;
      // its native schema has no transport discriminator.
      delete result.transport
      delete result.url
      delete result.httpUrl
      if (input.headers && Object.keys(input.headers).length > 0) result.headers = input.headers
      else delete result.headers
      delete result.command
      delete result.args
      delete result.env
      delete result.cwd
    }

    if (input.enabled === false) {
      result.disabled = true
      delete result.enabled
    } else if (input.enabled === true) {
      delete result.disabled
      if (existingRaw && 'enabled' in existingRaw) {
        result.enabled = true
      }
    }
  } else if (tool === 'opencode') {
    if (input.transport === 'stdio') {
      result.type = 'local'
      delete result.transport
      const cmdList: string[] = []
      if (input.command) cmdList.push(input.command)
      if (input.args && input.args.length > 0) {
        cmdList.push(...input.args)
      }
      result.command = cmdList
      if (input.env && Object.keys(input.env).length > 0) {
        result.environment = input.env
      } else {
        delete result.environment
      }
      delete result.env
      if (input.cwd) result.cwd = input.cwd
      else delete result.cwd
      delete result.url
      delete result.headers
    } else {
      result.type = 'remote'
      result.url = input.url || ''
      // OpenCode v2 remote servers are Streamable HTTP and are represented by
      // type + url; do not emit a non-schema transport field.
      delete result.transport
      if (input.headers && Object.keys(input.headers).length > 0) {
        result.headers = input.headers
      } else {
        delete result.headers
      }
      delete result.command
      delete result.args
      delete result.environment
      delete result.env
      delete result.cwd
    }

    const usedOldEnabledStyle =
      existingRaw && typeof existingRaw.enabled === 'boolean' && existingRaw.disabled === undefined
    if (input.enabled === false) {
      if (usedOldEnabledStyle) {
        result.enabled = false
        delete result.disabled
      } else {
        result.disabled = true
        delete result.enabled
      }
    } else if (input.enabled === true) {
      if (usedOldEnabledStyle) {
        result.enabled = true
        delete result.disabled
      } else {
        delete result.disabled
      }
    }
  }

  return result
}

// =========================================================================
// Lossless JSON Config Operations
// =========================================================================

export function readJsonConfig(
  filePath: string
): { data: Record<string, unknown>; rawText: string } | null {
  if (!existsSync(filePath)) return null
  const rawText = readFileSync(filePath, 'utf8')
  try {
    const parsed = JSON.parse(rawText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Top-level JSON structure is not an object.')
    }
    return { data: parsed as Record<string, unknown>, rawText }
  } catch (err) {
    throw new Error(
      `Failed to parse JSON file "${filePath}": ${(err as Error).message}. File content preserved.`
    )
  }
}

export function writeJsonConfigPreserving(
  filePath: string,
  mutator: (mcpServers: Record<string, unknown>, root: Record<string, unknown>) => void,
  tx?: TransactionManager
): void {
  const initialExisted = existsSync(filePath)
  let initialContent: string | null = null
  let initialMode = 0o600
  if (initialExisted) {
    try {
      initialContent = readFileSync(filePath, 'utf8')
      initialMode = statSync(filePath).mode & 0o777
    } catch {}
  }

  const existing = readJsonConfig(filePath)
  const root = existing ? { ...existing.data } : {}
  const originalKeys = existing ? Object.keys(existing.data) : []

  // Ensure mcpServers exists as an object and guard against malformed non-object structures
  if (root.mcpServers !== undefined) {
    if (typeof root.mcpServers !== 'object' || root.mcpServers === null || Array.isArray(root.mcpServers)) {
      throw new Error(
        `Safety violation: Existing mcpServers property in "${filePath}" is malformed (${Array.isArray(root.mcpServers) ? 'array' : typeof root.mcpServers}). Refusing to overwrite.`
      )
    }
    root.mcpServers = { ...(root.mcpServers as Record<string, unknown>) }
  } else {
    root.mcpServers = {}
  }

  const workingMcpServers = root.mcpServers as Record<string, unknown>
  mutator(workingMcpServers, root)

  // Invariant verification: Verify all non-mcpServers top-level keys remain unchanged
  // (unless mutator explicitly updated native policies like mcp, projects, or disabledMcpServers)
  if (existing) {
    for (const key of originalKeys) {
      if (key === 'mcpServers' || key === 'mcp' || key === 'projects' || key === 'disabledMcpServers') continue
      if (!deepEqual(existing.data[key], root[key])) {
        throw new Error(
          `Safety violation: Writing to "${filePath}" would modify non-MCP key "${key}". Write aborted.`
        )
      }
    }
  }

  const serialized = JSON.stringify(root, null, 2) + '\n'
  atomicWriteFile(filePath, serialized, initialMode)
  if (tx) {
    tx.recordWrite(filePath, initialExisted, initialContent, initialMode, serialized)
  }
}

// =========================================================================
// Lossless TOML Config Operations (Codex)
// =========================================================================

export function readTomlConfig(
  filePath: string
): { data: Record<string, unknown>; rawText: string } | null {
  if (!existsSync(filePath)) return null
  const rawText = readFileSync(filePath, 'utf8')
  try {
    parseTOML(rawText)
    const data = parseToml(rawText) as Record<string, unknown>
    return { data, rawText }
  } catch (err) {
    throw new Error(
      `Failed to parse TOML file "${filePath}": ${(err as Error).message}. File content preserved.`
    )
  }
}

interface TomlTableSpan {
  serverName: string
  keyPath: string[]
  start: number
  end: number
}

function findMcpTableSpans(rawText: string): TomlTableSpan[] {
  if (!rawText.trim()) return []
  const ast = parseTOML(rawText)
  const topLevel = ast.body[0]
  if (!topLevel || !Array.isArray(topLevel.body)) return []

  // Reject unsupported valid TOML shapes: root inline or dotted table for mcp_servers
  for (const item of topLevel.body) {
    if (item.type === 'TOMLKeyValue' && item.key) {
      const firstKey = (item.key as any).keys?.[0]
      const keyName = firstKey?.name || firstKey?.value
      if (keyName === 'mcp_servers') {
        throw new Error(
          'Unsupported TOML format: root inline or dotted table for mcp_servers. Use standard [mcp_servers.<name>] sections.'
        )
      }
    }
  }

  const spans: TomlTableSpan[] = []
  const topBody = topLevel.body

  for (let i = 0; i < topBody.length; i++) {
    const node = topBody[i]
    if (
      node.type === 'TOMLTable' &&
      Array.isArray(node.resolvedKey) &&
      node.resolvedKey[0] === 'mcp_servers' &&
      node.resolvedKey.length >= 2
    ) {
      const serverName = String(node.resolvedKey[1])
      const keyPath = node.resolvedKey.map((k: string | number) => String(k))

      // Line start of this table header
      let lineStart = rawText.lastIndexOf('\n', node.range[0] - 1)
      lineStart = lineStart === -1 ? 0 : lineStart + 1

      // Calculate end of this table (start of next item or EOF)
      let lineEnd = rawText.length
      if (i + 1 < topBody.length) {
        const nextNode = topBody[i + 1]
        let nextStart = rawText.lastIndexOf('\n', nextNode.range[0] - 1)
        nextStart = nextStart === -1 ? 0 : nextStart + 1

        // Check if comments before nextNode belong to nextNode
        if (ast.comments && ast.comments.length > 0) {
          const commentsBeforeNext = ast.comments.filter(
            (c) => c.range[0] >= node.range[1] && c.range[1] <= nextNode.range[0]
          )
          if (commentsBeforeNext.length > 0) {
            let docCommentStart = nextStart
            for (let ci = commentsBeforeNext.length - 1; ci >= 0; ci--) {
              const comm = commentsBeforeNext[ci]
              let commLineStart = rawText.lastIndexOf('\n', comm.range[0] - 1)
              commLineStart = commLineStart === -1 ? 0 : commLineStart + 1
              const textBetween = rawText.slice(comm.range[1], docCommentStart).trim()
              if (textBetween === '') {
                docCommentStart = commLineStart
              } else {
                break
              }
            }
            nextStart = docCommentStart
          }
        }
        lineEnd = nextStart
      }

      spans.push({
        serverName,
        keyPath,
        start: lineStart,
        end: lineEnd,
      })
    }
  }

  return spans
}

export function writeTomlConfigLossless(
  filePath: string,
  serverName: string,
  serverTomlData: Record<string, unknown> | null,
  tx?: TransactionManager
): void {
  const initialExisted = existsSync(filePath)
  let initialContent: string | null = null
  let initialMode = 0o600
  if (initialExisted) {
    try {
      initialContent = readFileSync(filePath, 'utf8')
      initialMode = statSync(filePath).mode & 0o777
    } catch {}
  }

  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''

  let initialParsed: Record<string, unknown> = {}
  if (existing.trim()) {
    try {
      parseTOML(existing)
      initialParsed = parseToml(existing) as Record<string, unknown>
    } catch (err) {
      throw new Error(
        `Cannot modify invalid TOML file "${filePath}": ${(err as Error).message}. Original file unchanged.`
      )
    }
  }

  // Safety check on existing mcp_servers property in parsed TOML
  if (initialParsed.mcp_servers !== undefined) {
    if (
      typeof initialParsed.mcp_servers !== 'object' ||
      initialParsed.mcp_servers === null ||
      Array.isArray(initialParsed.mcp_servers)
    ) {
      throw new Error(
        `Safety violation: Existing mcp_servers property in "${filePath}" is malformed. Refusing to overwrite.`
      )
    }
  }

  let newText = ''

  if (!existing.trim()) {
    if (serverTomlData) {
      newText = stringifyToml({ mcp_servers: { [serverName]: serverTomlData } }).trim() + '\n'
    } else {
      newText = ''
    }
  } else {
    const allSpans = findMcpTableSpans(existing)
    // Collect EVERY span belonging to this server (including nested sub-tables like [mcp_servers.demo.env])
    const matchingSpans = allSpans.filter((s) => s.serverName === serverName)

    if (matchingSpans.length > 0) {
      // Sort matching spans ascending
      matchingSpans.sort((a, b) => a.start - b.start)

      if (serverTomlData) {
        // Replace the primary table span with the new stringified table,
        // and DELETE all subsequent nested sub-table spans (e.g. [mcp_servers.demo.env])
        const newSectionStr =
          stringifyToml({ mcp_servers: { [serverName]: serverTomlData } }).trim() + '\n'

        // Apply edits in reverse order so character offsets remain valid
        let text = existing
        for (let i = matchingSpans.length - 1; i >= 1; i--) {
          const span = matchingSpans[i]
          text = text.slice(0, span.start) + text.slice(span.end)
        }

        // Replace primary span without trimming prefix or suffix outside target span
        const primary = matchingSpans[0]
        text = text.slice(0, primary.start) + newSectionStr + text.slice(primary.end)
        newText = text
      } else {
        // Deletion: Remove all spans in reverse order
        let text = existing
        for (let i = matchingSpans.length - 1; i >= 0; i--) {
          const span = matchingSpans[i]
          text = text.slice(0, span.start) + text.slice(span.end)
        }
        newText = text
      }
    } else {
      if (serverTomlData) {
        // Add new table
        const sectionStr = stringifyToml({ mcp_servers: { [serverName]: serverTomlData } }).trim() + '\n'
        if (allSpans.length > 0) {
          const lastSpan = allSpans[allSpans.length - 1]
          newText = existing.slice(0, lastSpan.end) + '\n' + sectionStr + existing.slice(lastSpan.end)
        } else {
          const suffix = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
          newText = existing + suffix + sectionStr
        }
      } else {
        newText = existing
      }
    }
  }

  // NOTE: Do NOT perform global regex blankline collapsing here, to preserve non-MCP whitespace verbatim!

  // Invariant & Outcome Verification:
  if (newText.trim()) {
    try {
      parseTOML(newText)
      const newParsed = parseToml(newText) as Record<string, unknown>

      // 1. Non-MCP section invariant
      const initialNonMcp = { ...initialParsed }
      delete initialNonMcp.mcp_servers
      const newNonMcp = { ...newParsed }
      delete newNonMcp.mcp_servers

      if (!deepEqual(initialNonMcp, newNonMcp)) {
        throw new Error(
          `Safety violation: TOML edit on "${filePath}" would corrupt non-MCP sections. Aborted.`
        )
      }

      // 2. Complete MCP outcome verification: verify other servers and target server
      const initialMcpServers = (initialParsed.mcp_servers as Record<string, unknown>) || {}
      const newMcpServers = (newParsed.mcp_servers as Record<string, unknown>) || {}

      for (const [otherName, otherDef] of Object.entries(initialMcpServers)) {
        if (otherName !== serverName) {
          if (!deepEqual(newMcpServers[otherName], otherDef)) {
            throw new Error(
              `Safety violation: TOML edit on "${filePath}" modified unrelated MCP server "${otherName}". Aborted.`
            )
          }
        }
      }

      if (serverTomlData) {
        const resultingServer = newMcpServers[serverName]
        if (!deepEqual(resultingServer, serverTomlData)) {
          throw new Error(
            `Safety violation: Server "${serverName}" in "${filePath}" did not match target definition after write. Aborted.`
          )
        }
      } else {
        if (newMcpServers[serverName] !== undefined) {
          throw new Error(
            `Safety violation: Server "${serverName}" still exists in "${filePath}" after delete. Aborted.`
          )
        }
      }
    } catch (err) {
      throw new Error(`Failed to verify lossless TOML edit on "${filePath}": ${(err as Error).message}`)
    }
  }

  atomicWriteFile(filePath, newText, initialMode)
  if (tx) {
    tx.recordWrite(filePath, initialExisted, initialContent, initialMode, newText)
  }
}

// =========================================================================
// Lossless OpenCode JSONC Operations
// =========================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOpenCodeServerEntry(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  return (
    value.type === 'local' ||
    value.type === 'remote' ||
    typeof value.command === 'string' ||
    Array.isArray(value.command) ||
    typeof value.url === 'string'
  )
}

export function readOpenCodeConfig(
  filePath: string
): { data: Record<string, unknown>; rawText: string } | null {
  if (!existsSync(filePath)) return null
  const rawText = readFileSync(filePath, 'utf8')
  const errors: ParseError[] = []
  const parsed = parseJsonc(rawText, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new Error(
      `Failed to parse JSON file "${filePath}": ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}. File content preserved.`
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`OpenCode configuration "${filePath}" top-level is not an object. File content preserved.`)
  }
  return { data: parsed as Record<string, unknown>, rawText }
}

export function writeOpenCodeConfigLossless(
  filePath: string,
  serverName: string,
  serverData: Record<string, unknown> | null,
  tx?: TransactionManager
): void {
  const initialExisted = existsSync(filePath)
  let initialContent: string | null = null
  let initialMode = 0o600
  if (initialExisted) {
    try {
      initialContent = readFileSync(filePath, 'utf8')
      initialMode = statSync(filePath).mode & 0o777
    } catch {}
  }

  const existingRaw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  let initialParsed: Record<string, unknown> = {}
  if (existingRaw.trim()) {
    const errors: ParseError[] = []
    const parsed = parseJsonc(existingRaw, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      throw new Error(
        `Cannot modify invalid JSON/JSONC file "${filePath}": ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}. Original file unchanged.`
      )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`OpenCode configuration "${filePath}" top-level is not an object. Original file unchanged.`)
    }
    initialParsed = parsed as Record<string, unknown>
  }

  if (initialParsed.mcp !== undefined) {
    if (!isRecord(initialParsed.mcp)) {
      throw new Error(
        `Safety violation: Existing mcp property in "${filePath}" is malformed. Refusing to overwrite.`
      )
    }
  }

  const mcpObj = isRecord(initialParsed.mcp) ? initialParsed.mcp : undefined
  if (mcpObj?.servers !== undefined && !isRecord(mcpObj.servers)) {
    throw new Error(
      `Safety violation: Existing mcp.servers property in "${filePath}" is malformed. Refusing to overwrite.`
    )
  }

  // Determine keyPath:
  // Check if serverName already exists under mcp.servers or legacy mcp.<name>
  let keyPath: string[]
  const serversObj = isRecord(mcpObj?.servers) ? mcpObj.servers : undefined

  if (serversObj && Object.prototype.hasOwnProperty.call(serversObj, serverName)) {
    keyPath = ['mcp', 'servers', serverName]
  } else if (
    mcpObj &&
    serverName !== 'servers' &&
    Object.prototype.hasOwnProperty.call(mcpObj, serverName) &&
    isOpenCodeServerEntry(mcpObj[serverName])
  ) {
    keyPath = ['mcp', serverName]
  } else if (
    serverData === null &&
    mcpObj &&
    Object.prototype.hasOwnProperty.call(mcpObj, serverName)
  ) {
    throw new Error(
      `OpenCode MCP entry "${serverName}" is not a server definition; refusing to delete an unrelated mcp property.`
    )
  } else {
    // New entry: default to current official mcp.servers.<name>
    keyPath = ['mcp', 'servers', serverName]
  }

  const baseText = existingRaw.trim() ? existingRaw : '{\n}\n'
  const edits = modify(baseText, keyPath, serverData === null ? undefined : serverData, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const newText = applyEdits(baseText, edits)

  // Invariant & Outcome Verification:
  if (newText.trim()) {
    const verifyErrors: ParseError[] = []
    const newParsed = parseJsonc(newText, verifyErrors, { allowTrailingComma: true }) as Record<string, unknown>
    if (verifyErrors.length > 0) {
      throw new Error(`Failed to verify OpenCode JSON edit on "${filePath}": output has syntax errors. Aborted.`)
    }

    // 1. Non-MCP root property invariant
    const initialNonMcp = { ...initialParsed }
    delete initialNonMcp.mcp
    const newNonMcp = { ...newParsed }
    delete newNonMcp.mcp
    if (!deepEqual(initialNonMcp, newNonMcp)) {
      throw new Error(`Safety violation: OpenCode edit on "${filePath}" would modify non-MCP keys. Aborted.`)
    }

    // 2. MCP outcome verification: verify other servers remain identical
    const getServersMap = (root: Record<string, unknown>) => {
      const map = new Map<string, unknown>()
      const m = root.mcp as Record<string, unknown> | undefined
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        if (m.servers && typeof m.servers === 'object' && !Array.isArray(m.servers)) {
          for (const [k, v] of Object.entries(m.servers as Record<string, unknown>)) {
            map.set(k, v)
          }
        }
        for (const [k, v] of Object.entries(m)) {
          if (k !== 'servers' && !map.has(k) && isOpenCodeServerEntry(v)) {
            map.set(k, v)
          }
        }
      }
      return map
    }

    const initialMap = getServersMap(initialParsed)
    const newMap = getServersMap(newParsed)

    for (const [otherName, otherDef] of initialMap.entries()) {
      if (otherName !== serverName) {
        if (!deepEqual(newMap.get(otherName), otherDef)) {
          throw new Error(
            `Safety violation: OpenCode edit on "${filePath}" modified unrelated MCP server "${otherName}". Aborted.`
          )
        }
      }
    }

    if (serverData !== null) {
      if (!deepEqual(newMap.get(serverName), serverData)) {
        throw new Error(
          `Safety violation: Server "${serverName}" in "${filePath}" did not match target definition after write. Aborted.`
        )
      }
    } else {
      if (newMap.has(serverName)) {
        throw new Error(
          `Safety violation: Server "${serverName}" still exists in "${filePath}" after delete. Aborted.`
        )
      }
    }
  }

  atomicWriteFile(filePath, newText, initialMode)
  if (tx) {
    tx.recordWrite(filePath, initialExisted, initialContent, initialMode, newText)
  }
}

// =========================================================================
// Public Read Services
// =========================================================================

export function readMCPServersForTool(
  tool: MCPSourceTool,
  scope: MCPScope,
  options?: MCPOptions
): MCPServerDefinition[] {
  let configPath: string
  try {
    configPath = resolveMCPConfigPath(tool, scope, options)
  } catch {
    return []
  }
  const results: MCPServerDefinition[] = []
  const activeNames = new Set<string>()

  if (tool === 'codex' || tool === 'grok') {
    // Read TOML (Codex, Grok)
    if (existsSync(configPath)) {
      const parsed = readTomlConfig(configPath)
      if (parsed && isRecord(parsed.data.mcp_servers)) {
        const serversObj = parsed.data.mcp_servers as Record<string, unknown>
        for (const [name, rawVal] of Object.entries(serversObj)) {
          if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
            activeNames.add(name)
            const revision = computeServerRevision(tool, scope, name, options)
            results.push(
              buildServerDefinitionFromRaw(
                tool,
                scope,
                name,
                rawVal as Record<string, unknown>,
                configPath,
                (rawVal as { enabled?: boolean }).enabled !== false,
                revision
              )
            )
          }
        }
      }
    }
  } else if (tool === 'opencode') {
    // Read OpenCode JSON/JSONC
    if (existsSync(configPath)) {
      const parsedRes = readOpenCodeConfig(configPath)
      if (parsedRes && isRecord(parsedRes.data.mcp)) {
        const mcpObj = parsedRes.data.mcp as Record<string, unknown>
        // 1. Current official structure: mcp.servers.<name>
        if (isRecord(mcpObj.servers)) {
          const serversObj = mcpObj.servers as Record<string, unknown>
          for (const [name, rawVal] of Object.entries(serversObj)) {
            if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
              activeNames.add(name)
              const raw = rawVal as Record<string, unknown>
              const isEnabled = raw.disabled !== true && raw.enabled !== false
              const revision = computeServerRevision(tool, scope, name, options)
              results.push(
                buildServerDefinitionFromRaw(
                  tool,
                  scope,
                  name,
                  raw,
                  configPath,
                  isEnabled,
                  revision
                )
              )
            }
          }
        }
        // 2. Compatibility with legacy mcp.<name>
        for (const [key, rawVal] of Object.entries(mcpObj)) {
          if (key === 'servers' || activeNames.has(key)) continue
          if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
            const raw = rawVal as Record<string, unknown>
            if (raw.type || raw.command || raw.url) {
              activeNames.add(key)
              const isEnabled = raw.disabled !== true && raw.enabled !== false
              const revision = computeServerRevision(tool, scope, key, options)
              results.push(
                buildServerDefinitionFromRaw(
                  tool,
                  scope,
                  key,
                  raw,
                  configPath,
                  isEnabled,
                  revision
                )
              )
            }
          }
        }
      }
    }
  } else if (tool === 'antigravity') {
    // Read Google Antigravity JSON (mcpServers.<name>)
    if (existsSync(configPath)) {
      const parsed = readJsonConfig(configPath)
      if (
        parsed &&
        parsed.data.mcpServers &&
        typeof parsed.data.mcpServers === 'object' &&
        !Array.isArray(parsed.data.mcpServers)
      ) {
        const serversObj = parsed.data.mcpServers as Record<string, unknown>
        for (const [name, rawVal] of Object.entries(serversObj)) {
          if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
            activeNames.add(name)
            const raw = rawVal as Record<string, unknown>
            const isEnabled = raw.disabled !== true && raw.enabled !== false
            const revision = computeServerRevision(tool, scope, name, options)
            results.push(
              buildServerDefinitionFromRaw(
                tool,
                scope,
                name,
                raw,
                configPath,
                isEnabled,
                revision
              )
            )
          }
        }
      }
    }
  } else {
    // Read JSON tool (Claude, Cursor, Gemini)
    if (existsSync(configPath)) {
      const parsed = readJsonConfig(configPath)
      if (parsed && parsed.data.mcpServers && typeof parsed.data.mcpServers === 'object' && !Array.isArray(parsed.data.mcpServers)) {
        const serversObj = parsed.data.mcpServers as Record<string, unknown>

        // Gemini native exclusion check: mcp.excluded or mcp.allowed
        const geminiMcp = parsed.data.mcp as { excluded?: string[]; allowed?: string[] } | undefined

        // Claude disabled servers check (both root and project workspace)
        const claudeRootDisabled = Array.isArray(parsed.data.disabledMcpServers)
          ? (parsed.data.disabledMcpServers as string[])
          : undefined
        const projectWorkspace = scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined
        const claudeProjects = parsed.data.projects as Record<string, { disabledMcpServers?: string[] }> | undefined
        const claudeDisabledList = projectWorkspace && claudeProjects?.[projectWorkspace]?.disabledMcpServers

        for (const [name, rawVal] of Object.entries(serversObj)) {
          if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
            activeNames.add(name)

            let isEnabled = true
            if (tool === 'gemini' && geminiMcp) {
              if (geminiMcp.excluded && Array.isArray(geminiMcp.excluded) && geminiMcp.excluded.includes(name)) {
                isEnabled = false
              } else if (geminiMcp.allowed && Array.isArray(geminiMcp.allowed) && !geminiMcp.allowed.includes(name)) {
                isEnabled = false
              }
            } else if (tool === 'claude-code') {
              if (claudeRootDisabled && claudeRootDisabled.includes(name)) {
                isEnabled = false
              } else if (claudeDisabledList && Array.isArray(claudeDisabledList) && claudeDisabledList.includes(name)) {
                isEnabled = false
              }
            }

            const revision = computeServerRevision(tool, scope, name, options)
            results.push(
              buildServerDefinitionFromRaw(
                tool,
                scope,
                name,
                rawVal as Record<string, unknown>,
                configPath,
                isEnabled,
                revision
              )
            )
          }
        }
      }
    }
  }

  // Also include servers in the Trace disabled registry for this tool & scope
  const registry = loadDisabledRegistry(options)
  const currentProjectWorkspace = scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined

  for (const record of Object.values(registry)) {
    const recordTool = record.sourceTool || record.tool
    if (recordTool === tool && record.scope === scope) {
      if (scope === 'project' && record.projectWorkspace && currentProjectWorkspace) {
        if (path.resolve(record.projectWorkspace) !== path.resolve(currentProjectWorkspace)) {
          continue
        }
      }
      if (!activeNames.has(record.name)) {
        const revision = computeServerRevision(tool, scope, record.name, options)
        results.push({
          ...record.server,
          sourceTool: tool,
          enabled: false,
          configPath,
          revision,
        })
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

export async function readAllMCPServers(options?: MCPOptions): Promise<{
  global: MCPServerDefinition[]
  project: MCPServerDefinition[]
}> {
  const tools = VALID_MCP_TOOLS

  const globalList: MCPServerDefinition[] = []
  const projectList: MCPServerDefinition[] = []

  for (const tool of tools) {
    globalList.push(...readMCPServersForTool(tool, 'global', options))
    projectList.push(...readMCPServersForTool(tool, 'project', options))
  }

  return {
    global: globalList,
    project: projectList,
  }
}

// =========================================================================
// Transactional Mutation Services with Conflict Protection & Rollback
// =========================================================================

// =========================================================================
// Transactional Mutation Services with Conflict Protection & Rollback
// =========================================================================

export function saveMCPServer(
  target: { tool: MCPSourceTool; scope: MCPScope; expectedRevision?: string },
  input: MCPServerInput & { isNew?: boolean },
  options?: MCPOptions
): { success: boolean; server?: MCPServerDefinition; error?: string } {
  try {
    validateToolAndScope(target?.tool, target?.scope)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }

  const tx = new TransactionManager()
  const configPath = resolveMCPConfigPath(target.tool, target.scope, options)

  try {
    validateServerInput(input, target.tool)

    // Check collision if creating new server
    if (input.isNew) {
      const existingServers = readMCPServersForTool(target.tool, target.scope, options)
      if (existingServers.some((s) => s.name === input.name)) {
        return {
          success: false,
          error: `Collision error: Server "${input.name}" already exists in ${target.tool} (${target.scope}).`,
        }
      }
    }

    // Check revision conflict if expectedRevision provided
    const expectedRev = input.expectedRevision || target.expectedRevision
    if (expectedRev) {
      const currentRev = computeServerRevision(target.tool, target.scope, input.name, options)
      if (currentRev !== expectedRev) {
        return {
          success: false,
          error: `Revision conflict: Server "${input.name}" has been modified concurrently. Please reload.`,
        }
      }
    }

    // Optional test hook for concurrent writes
    if (options?.beforeWriteHook) {
      options.beforeWriteHook()
    }

    // Immediate recheck of revision after hook
    if (expectedRev) {
      const currentRevAfterHook = computeServerRevision(target.tool, target.scope, input.name, options)
      if (currentRevAfterHook !== expectedRev) {
        return {
          success: false,
          error: `Revision conflict: Server "${input.name}" has been modified concurrently. Please reload.`,
        }
      }
    }

    const disabledEntry = getDisabledEntry(target.tool, target.scope, input.name, options)

    // Handle CASE A: Saving with enabled: false
    if (input.enabled === false) {
      if (target.tool === 'codex' || target.tool === 'grok') {
        const existingToml = readTomlConfig(configPath)
        const mcpObj = (existingToml?.data.mcp_servers as Record<string, unknown>) || {}
        let existingRaw = mcpObj[input.name] as Record<string, unknown> | undefined
        if (!existingRaw && disabledEntry?.rawEntry) {
          existingRaw = disabledEntry.rawEntry
        }
        const tomlData = convertServerToToolConfig(target.tool, { ...input, enabled: false }, existingRaw)
        writeTomlConfigLossless(configPath, input.name, tomlData, tx)

        const server = buildServerDefinitionFromRaw(
          target.tool,
          target.scope,
          input.name,
          tomlData,
          configPath,
          false,
          computeServerRevision(target.tool, target.scope, input.name, options)
        )
        return { success: true, server }
      } else if (target.tool === 'opencode') {
        const existingRes = readOpenCodeConfig(configPath)
        let existingRaw: Record<string, unknown> | undefined
        const mcpObj = existingRes?.data.mcp as Record<string, unknown> | undefined
        if (isRecord(mcpObj?.servers)) {
          existingRaw = mcpObj.servers[input.name] as Record<string, unknown> | undefined
        }
        if (!existingRaw && mcpObj && isOpenCodeServerEntry(mcpObj[input.name])) {
          existingRaw = mcpObj[input.name] as Record<string, unknown>
        }
        if (!existingRaw && disabledEntry?.rawEntry) {
          existingRaw = disabledEntry.rawEntry
        }
        const toolData = convertServerToToolConfig(target.tool, { ...input, enabled: false }, existingRaw)
        writeOpenCodeConfigLossless(configPath, input.name, toolData, tx)

        const server = buildServerDefinitionFromRaw(
          target.tool,
          target.scope,
          input.name,
          toolData,
          configPath,
          false,
          computeServerRevision(target.tool, target.scope, input.name, options)
        )
        return { success: true, server }
      } else if (target.tool === 'antigravity') {
        const existingJson = readJsonConfig(configPath)
        const existingRaw = (existingJson?.data.mcpServers as Record<string, unknown>)?.[input.name] as
          | Record<string, unknown>
          | undefined
        const baseRaw = existingRaw || disabledEntry?.rawEntry || {}
        const toolData = convertServerToToolConfig(target.tool, { ...input, enabled: false }, baseRaw)
        writeJsonConfigPreserving(
          configPath,
          (mcpServers) => {
            mcpServers[input.name] = toolData
          },
          tx
        )

        const serverDef = buildServerDefinitionFromRaw(
          target.tool,
          target.scope,
          input.name,
          toolData,
          configPath,
          false,
          computeServerRevision(target.tool, target.scope, input.name, options)
        )
        return { success: true, server: serverDef }
      }

      // JSON tools (Claude, Cursor, Gemini):
      // Remove from active file and persist in Trace disabled registry
      const existingJson = readJsonConfig(configPath)
      const existingRaw = (existingJson?.data.mcpServers as Record<string, unknown>)?.[input.name] as
        | Record<string, unknown>
        | undefined
      const baseRaw = existingRaw || disabledEntry?.rawEntry || {}
      const toolData = convertServerToToolConfig(target.tool, input, baseRaw)

      const serverDef = buildServerDefinitionFromRaw(
        target.tool,
        target.scope,
        input.name,
        toolData,
        configPath,
        false
      )

      // 1. Ensure active config file exists and does not contain input.name
      writeJsonConfigPreserving(
        configPath,
        (mcpServers, root) => {
          delete mcpServers[input.name]
          if (target.tool === 'gemini') {
            if (!root.mcp || typeof root.mcp !== 'object') root.mcp = {}
            const mcpObj = root.mcp as { excluded?: string[]; allowed?: string[] }
            if (Array.isArray(mcpObj.allowed)) {
              mcpObj.allowed = mcpObj.allowed.filter((e) => e !== input.name)
            }
            if (!Array.isArray(mcpObj.excluded)) mcpObj.excluded = []
            if (!mcpObj.excluded.includes(input.name)) mcpObj.excluded.push(input.name)
          }
        },
        tx
      )

      if (options?.beforeSecondWriteHook) {
        options.beforeSecondWriteHook()
      }

      // 2. Save to disabled registry
      setDisabledEntry(
        {
          id: serverDef.id,
          name: input.name,
          sourceTool: target.tool,
          tool: target.tool,
          scope: target.scope,
          server: serverDef,
          rawEntry: toolData,
          projectWorkspace: target.scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined,
          disabledAt: Date.now(),
        },
        options,
        tx
      )

      // Read-back verification
      const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
      const reloaded = verifiedServers.find((s) => s.name === input.name)
      if (!reloaded || reloaded.enabled !== false) {
        throw new Error(`Policy verification failed: Server "${input.name}" could not be saved as disabled.`)
      }

      serverDef.revision = computeServerRevision(target.tool, target.scope, input.name, options)
      return { success: true, server: serverDef }
    }

    // Handle CASE B: Saving with enabled: true (active)
    let existingRaw: Record<string, unknown> | undefined

    if (target.tool === 'codex' || target.tool === 'grok') {
      const existingToml = readTomlConfig(configPath)
      if (existingToml?.data.mcp_servers && typeof existingToml.data.mcp_servers === 'object') {
        const mcpObj = existingToml.data.mcp_servers as Record<string, unknown>
        existingRaw = mcpObj[input.name] as Record<string, unknown> | undefined
      }
      if (!existingRaw && disabledEntry?.rawEntry) {
        existingRaw = disabledEntry.rawEntry
      }
      const tomlData = convertServerToToolConfig(target.tool, input, existingRaw)
      writeTomlConfigLossless(configPath, input.name, tomlData, tx)
    } else if (target.tool === 'opencode') {
      const existingRes = readOpenCodeConfig(configPath)
      const mcpObj = existingRes?.data.mcp as Record<string, unknown> | undefined
      if (isRecord(mcpObj?.servers)) {
        existingRaw = mcpObj.servers[input.name] as Record<string, unknown> | undefined
      }
      if (!existingRaw && mcpObj && isOpenCodeServerEntry(mcpObj[input.name])) {
        existingRaw = mcpObj[input.name] as Record<string, unknown>
      }
      if (!existingRaw && disabledEntry?.rawEntry) {
        existingRaw = disabledEntry.rawEntry
      }
      const toolData = convertServerToToolConfig(target.tool, input, existingRaw)
      writeOpenCodeConfigLossless(configPath, input.name, toolData, tx)
    } else if (target.tool === 'antigravity') {
      const existingJson = readJsonConfig(configPath)
      if (existingJson?.data.mcpServers && typeof existingJson.data.mcpServers === 'object') {
        const mcpObj = existingJson.data.mcpServers as Record<string, unknown>
        existingRaw = mcpObj[input.name] as Record<string, unknown> | undefined
      }
      if (!existingRaw && disabledEntry?.rawEntry) {
        existingRaw = disabledEntry.rawEntry
      }
      const jsonData = convertServerToToolConfig(target.tool, input, existingRaw)
      writeJsonConfigPreserving(
        configPath,
        (mcpServers) => {
          mcpServers[input.name] = jsonData
        },
        tx
      )
    } else {
      const existingJson = readJsonConfig(configPath)
      if (existingJson?.data.mcpServers && typeof existingJson.data.mcpServers === 'object') {
        const mcpObj = existingJson.data.mcpServers as Record<string, unknown>
        existingRaw = mcpObj[input.name] as Record<string, unknown> | undefined
      }
      // CRUCIAL: If it was disabled, existingRaw in active file is undefined, but disabledEntry HAS rawEntry!
      if (!existingRaw && disabledEntry?.rawEntry) {
        existingRaw = disabledEntry.rawEntry
      }
      const jsonData = convertServerToToolConfig(target.tool, input, existingRaw)
      writeJsonConfigPreserving(
        configPath,
        (mcpServers, root) => {
          mcpServers[input.name] = jsonData

          // Gemini native policy adjustments
          if (target.tool === 'gemini') {
            if (root.mcp && typeof root.mcp === 'object') {
              const mcpObj = root.mcp as { excluded?: string[]; allowed?: string[] }
              if (Array.isArray(mcpObj.excluded)) {
                mcpObj.excluded = mcpObj.excluded.filter((e) => e !== input.name)
              }
              if (Array.isArray(mcpObj.allowed)) {
                if (!mcpObj.allowed.includes(input.name)) {
                  mcpObj.allowed.push(input.name)
                }
              }
            }
          }

          // Claude native policy adjustments
          if (target.tool === 'claude-code') {
            if (Array.isArray(root.disabledMcpServers)) {
              root.disabledMcpServers = root.disabledMcpServers.filter((e) => e !== input.name)
            }
            if (target.scope === 'project' && root.projects && typeof root.projects === 'object') {
              const currentWorkspace = getEffectiveProjectWorkspace(options)
              const proj = (root.projects as Record<string, { disabledMcpServers?: string[] }>)[currentWorkspace]
              if (proj && Array.isArray(proj.disabledMcpServers)) {
                proj.disabledMcpServers = proj.disabledMcpServers.filter((e) => e !== input.name)
              }
            }
          }
        },
        tx
      )
    }

    if (options?.beforeSecondWriteHook) {
      options.beforeSecondWriteHook()
    }

    if (disabledEntry) {
      // Was disabled: remove from disabled registry
      removeDisabledEntry(target.tool, target.scope, input.name, options, tx)
    }

    // Read-back verification
    const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
    const reloaded = verifiedServers.find((s) => s.name === input.name)
    if (!reloaded) {
      throw new Error(`Verification error: Server "${input.name}" could not be read back after save.`)
    }
    if (reloaded.enabled !== true) {
      throw new Error(
        `Policy error: Unable to safely enable "${input.name}" in ${target.tool} due to conflicting tool policy (reloaded enabled=false).`
      )
    }

    const savedRaw = convertServerToToolConfig(target.tool, input, existingRaw)
    const server = buildServerDefinitionFromRaw(
      target.tool,
      target.scope,
      input.name,
      savedRaw,
      configPath,
      true,
      computeServerRevision(target.tool, target.scope, input.name, options)
    )

    return { success: true, server }
  } catch (err) {
    try { tx.rollback() } catch (rollbackError) {
      return { success: false, error: `${(err as Error).message}. ${(rollbackError as Error).message}` }
    }
    return { success: false, error: (err as Error).message }
  }
}

export function deleteMCPServer(
  target: { tool: MCPSourceTool; scope: MCPScope; name: string; expectedRevision?: string },
  options?: MCPOptions
): { success: boolean; error?: string } {
  try {
    validateToolAndScope(target?.tool, target?.scope)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }

  const tx = new TransactionManager()
  const configPath = resolveMCPConfigPath(target.tool, target.scope, options)

  try {
    validateServerName(target.name)

    if (target.expectedRevision) {
      const currentRev = computeServerRevision(target.tool, target.scope, target.name, options)
      if (currentRev !== target.expectedRevision) {
        return {
          success: false,
          error: `Revision conflict: Server "${target.name}" has been modified concurrently. Please reload.`,
        }
      }
    }

    if (options?.beforeWriteHook) {
      options.beforeWriteHook()
    }

    if (target.expectedRevision) {
      const currentRevAfterHook = computeServerRevision(target.tool, target.scope, target.name, options)
      if (currentRevAfterHook !== target.expectedRevision) {
        return {
          success: false,
          error: `Revision conflict: Server "${target.name}" has been modified concurrently. Please reload.`,
        }
      }
    }

    // 1. Delete from tool file if present
    if (target.tool === 'codex' || target.tool === 'grok') {
      if (existsSync(configPath)) {
        writeTomlConfigLossless(configPath, target.name, null, tx)
      }
    } else if (target.tool === 'opencode') {
      if (existsSync(configPath)) {
        writeOpenCodeConfigLossless(configPath, target.name, null, tx)
      }
    } else {
      if (existsSync(configPath)) {
        writeJsonConfigPreserving(
          configPath,
          (mcpServers, root) => {
            delete mcpServers[target.name]
            // Clean up native policy if Gemini
            if (target.tool === 'gemini' && root.mcp && typeof root.mcp === 'object') {
              const mcpObj = root.mcp as { excluded?: string[]; allowed?: string[] }
              if (Array.isArray(mcpObj.excluded)) {
                mcpObj.excluded = mcpObj.excluded.filter((e) => e !== target.name)
              }
              if (Array.isArray(mcpObj.allowed)) {
                mcpObj.allowed = mcpObj.allowed.filter((e) => e !== target.name)
              }
            }
            // Clean up native policy if Claude
            if (target.tool === 'claude-code') {
              if (Array.isArray(root.disabledMcpServers)) {
                root.disabledMcpServers = root.disabledMcpServers.filter((e) => e !== target.name)
              }
              if (target.scope === 'project' && root.projects && typeof root.projects === 'object') {
                const currentWorkspace = getEffectiveProjectWorkspace(options)
                const proj = (root.projects as Record<string, { disabledMcpServers?: string[] }>)[currentWorkspace]
                if (proj && Array.isArray(proj.disabledMcpServers)) {
                  proj.disabledMcpServers = proj.disabledMcpServers.filter((e) => e !== target.name)
                }
              }
            }
          },
          tx
        )
      }
    }

    if (options?.beforeSecondWriteHook) {
      options.beforeSecondWriteHook()
    }

    // 2. Delete from disabled registry if present
    removeDisabledEntry(target.tool, target.scope, target.name, options, tx)

    return { success: true }
  } catch (err) {
    try { tx.rollback() } catch (rollbackError) {
      return { success: false, error: `${(err as Error).message}. ${(rollbackError as Error).message}` }
    }
    return { success: false, error: (err as Error).message }
  }
}

export function toggleMCPServer(
  target: { tool: MCPSourceTool; scope: MCPScope; name: string; expectedRevision?: string },
  enabled: boolean,
  options?: MCPOptions
): { success: boolean; server?: MCPServerDefinition; error?: string } {
  try {
    validateToolAndScope(target?.tool, target?.scope)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }

  const tx = new TransactionManager()
  const configPath = resolveMCPConfigPath(target.tool, target.scope, options)

  try {
    validateServerName(target.name)

    if (target.expectedRevision) {
      const currentRev = computeServerRevision(target.tool, target.scope, target.name, options)
      if (currentRev !== target.expectedRevision) {
        return {
          success: false,
          error: `Revision conflict: Server "${target.name}" has been modified concurrently. Please reload.`,
        }
      }
    }

    if (options?.beforeWriteHook) {
      options.beforeWriteHook()
    }

    if (target.expectedRevision) {
      const currentRevAfterHook = computeServerRevision(target.tool, target.scope, target.name, options)
      if (currentRevAfterHook !== target.expectedRevision) {
        return {
          success: false,
          error: `Revision conflict: Server "${target.name}" has been modified concurrently. Please reload.`,
        }
      }
    }

    // Codex and Grok native enabled = false
    if (target.tool === 'codex' || target.tool === 'grok') {
      const existing = readTomlConfig(configPath)
      const toolTitle = target.tool === 'codex' ? 'Codex' : 'Grok'
      if (!existing || !existing.data.mcp_servers) {
        throw new Error(`${toolTitle} MCP server "${target.name}" not found in config.toml`)
      }
      const mcpObj = existing.data.mcp_servers as Record<string, unknown>
      const serverEntry = mcpObj[target.name] as Record<string, unknown> | undefined
      if (!serverEntry) {
        throw new Error(`${toolTitle} MCP server "${target.name}" not found.`)
      }
      const updated = { ...serverEntry, enabled }
      writeTomlConfigLossless(configPath, target.name, updated, tx)

      // Verification
      const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
      const reloaded = verifiedServers.find((s) => s.name === target.name)
      if (!reloaded || reloaded.enabled !== enabled) {
        throw new Error(`Policy error: Unable to toggle "${target.name}" to enabled=${enabled}.`)
      }

      const server = buildServerDefinitionFromRaw(
        target.tool,
        target.scope,
        target.name,
        updated,
        configPath,
        enabled,
        computeServerRevision(target.tool, target.scope, target.name, options)
      )
      return { success: true, server }
    }

    // OpenCode native disabled / enabled toggle in JSONC
    if (target.tool === 'opencode') {
      const existing = readOpenCodeConfig(configPath)
      const mcpObj = existing?.data.mcp as Record<string, unknown> | undefined
      let serverEntry: Record<string, unknown> | undefined
      if (mcpObj?.servers && typeof mcpObj.servers === 'object') {
        serverEntry = (mcpObj.servers as Record<string, unknown>)[target.name] as Record<string, unknown> | undefined
      }
      if (!serverEntry && mcpObj && isOpenCodeServerEntry(mcpObj[target.name])) {
        serverEntry = mcpObj[target.name] as Record<string, unknown>
      }
      if (!serverEntry) {
        throw new Error(`OpenCode MCP server "${target.name}" not found in ${path.basename(configPath)}.`)
      }

      const updated = { ...serverEntry }
      if (!enabled) {
        if ('enabled' in updated) {
          updated.enabled = false
        } else {
          updated.disabled = true
        }
      } else {
        delete updated.disabled
        if ('enabled' in updated) {
          updated.enabled = true
        }
      }

      writeOpenCodeConfigLossless(configPath, target.name, updated, tx)

      // Verification
      const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
      const reloaded = verifiedServers.find((s) => s.name === target.name)
      if (!reloaded || reloaded.enabled !== enabled) {
        throw new Error(`Policy error: Server "${target.name}" failed to toggle to enabled=${enabled}.`)
      }

      const server = buildServerDefinitionFromRaw(
        target.tool,
        target.scope,
        target.name,
        updated,
        configPath,
        enabled,
        computeServerRevision(target.tool, target.scope, target.name, options)
      )
      return { success: true, server }
    }

    // Antigravity native disabled: true toggle in JSON
    if (target.tool === 'antigravity') {
      const existingJson = readJsonConfig(configPath)
      if (!existingJson || !existingJson.data.mcpServers) {
        throw new Error(`Antigravity MCP server "${target.name}" not found in ${path.basename(configPath)}.`)
      }
      const mcpServers = existingJson.data.mcpServers as Record<string, unknown>
      const serverEntry = mcpServers[target.name] as Record<string, unknown> | undefined
      if (!serverEntry) {
        throw new Error(`Antigravity MCP server "${target.name}" not found in ${path.basename(configPath)}.`)
      }

      const updated = { ...serverEntry }
      if (!enabled) {
        updated.disabled = true
      } else {
        delete updated.disabled
        if ('enabled' in updated) {
          updated.enabled = true
        }
      }

      writeJsonConfigPreserving(
        configPath,
        (mcp) => {
          mcp[target.name] = updated
        },
        tx
      )

      removeDisabledEntry(target.tool, target.scope, target.name, options, tx)

      // Verification
      const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
      const reloaded = verifiedServers.find((s) => s.name === target.name)
      if (!reloaded || reloaded.enabled !== enabled) {
        throw new Error(`Policy error: Server "${target.name}" failed to toggle to enabled=${enabled}.`)
      }

      const server = buildServerDefinitionFromRaw(
        target.tool,
        target.scope,
        target.name,
        updated,
        configPath,
        enabled,
        computeServerRevision(target.tool, target.scope, target.name, options)
      )
      return { success: true, server }
    }

    // JSON tools (Claude, Cursor, Gemini)
    if (!enabled) {
      // DISABLE:
      const existingJson = readJsonConfig(configPath)
      if (!existingJson || !existingJson.data.mcpServers) {
        throw new Error(`Server "${target.name}" not found in ${path.basename(configPath)}.`)
      }
      const mcpServers = existingJson.data.mcpServers as Record<string, unknown>
      const rawEntry = mcpServers[target.name] as Record<string, unknown> | undefined
      if (!rawEntry) {
        throw new Error(`Server "${target.name}" not found in ${path.basename(configPath)}.`)
      }

      const serverDef = buildServerDefinitionFromRaw(
        target.tool,
        target.scope,
        target.name,
        rawEntry,
        configPath,
        false
      )

      // Step 1: Write to disabled registry first
      setDisabledEntry(
        {
          id: serverDef.id,
          name: target.name,
          sourceTool: target.tool,
          tool: target.tool,
          scope: target.scope,
          server: serverDef,
          rawEntry,
          projectWorkspace: target.scope === 'project' ? getEffectiveProjectWorkspace(options) : undefined,
          disabledAt: Date.now(),
        },
        options,
        tx
      )

      if (options?.beforeSecondWriteHook) {
        options.beforeSecondWriteHook()
      }

      // Step 2: Remove from active config file
      writeJsonConfigPreserving(
        configPath,
        (mcp, root) => {
          delete mcp[target.name]
          // If Gemini, add to mcp.excluded and remove from mcp.allowed
          if (target.tool === 'gemini') {
            if (!root.mcp || typeof root.mcp !== 'object') root.mcp = {}
            const mcpObj = root.mcp as { excluded?: string[]; allowed?: string[] }
            if (Array.isArray(mcpObj.allowed)) {
              mcpObj.allowed = mcpObj.allowed.filter((e) => e !== target.name)
            }
            if (!Array.isArray(mcpObj.excluded)) mcpObj.excluded = []
            if (!mcpObj.excluded.includes(target.name)) mcpObj.excluded.push(target.name)
          }
        },
        tx
      )

      // Verification
      const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
      const reloaded = verifiedServers.find((s) => s.name === target.name)
      if (!reloaded || reloaded.enabled !== false) {
        throw new Error(`Policy error: Server "${target.name}" failed to disable.`)
      }

      serverDef.revision = computeServerRevision(target.tool, target.scope, target.name, options)
      return { success: true, server: serverDef }
    } else {
      // ENABLE:
      // Check if Gemini was natively disabled via mcp.excluded
      const existingJson = readJsonConfig(configPath)
      const isAlreadyInActiveFile = Boolean(
        (existingJson?.data.mcpServers as Record<string, unknown>)?.[target.name]
      )

      if ((target.tool === 'gemini' || target.tool === 'claude-code') && isAlreadyInActiveFile) {
        writeJsonConfigPreserving(
          configPath,
          (_mcp, root) => {
            if (target.tool === 'gemini' && root.mcp && typeof root.mcp === 'object') {
              const mcpObj = root.mcp as { excluded?: string[]; allowed?: string[] }
              if (Array.isArray(mcpObj.excluded)) {
                mcpObj.excluded = mcpObj.excluded.filter((e) => e !== target.name)
              }
              if (Array.isArray(mcpObj.allowed)) {
                if (!mcpObj.allowed.includes(target.name)) {
                  mcpObj.allowed.push(target.name)
                }
              }
            }
            if (target.tool === 'claude-code') {
              if (Array.isArray(root.disabledMcpServers)) {
                root.disabledMcpServers = root.disabledMcpServers.filter((e) => e !== target.name)
              }
              if (target.scope === 'project' && root.projects && typeof root.projects === 'object') {
                const currentWorkspace = getEffectiveProjectWorkspace(options)
                const proj = (root.projects as Record<string, { disabledMcpServers?: string[] }>)[currentWorkspace]
                if (proj && Array.isArray(proj.disabledMcpServers)) {
                  proj.disabledMcpServers = proj.disabledMcpServers.filter((e) => e !== target.name)
                }
              }
            }
          },
          tx
        )
        removeDisabledEntry(target.tool, target.scope, target.name, options, tx)

        // Verification
        const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
        const reloaded = verifiedServers.find((s) => s.name === target.name)
        if (!reloaded || reloaded.enabled !== true) {
          throw new Error(`Policy error: Server "${target.name}" failed to enable due to conflicting policy.`)
        }

        const activeEntry = (existingJson!.data.mcpServers as Record<string, unknown>)[target.name]
        const server = buildServerDefinitionFromRaw(
          target.tool,
          target.scope,
          target.name,
          activeEntry as Record<string, unknown>,
          configPath,
          true,
          computeServerRevision(target.tool, target.scope, target.name, options)
        )
        return { success: true, server }
      }

      // Check disabled registry
      const disabled = getDisabledEntry(target.tool, target.scope, target.name, options)
      if (!disabled) {
        throw new Error(`Disabled server record for "${target.name}" was not found.`)
      }

      // Step 1: FIRST write back to active tool configuration file
      writeJsonConfigPreserving(
        configPath,
        (mcp, root) => {
          mcp[target.name] = disabled.rawEntry
          if (target.tool === 'gemini' && root.mcp && typeof root.mcp === 'object') {
            const mcpObj = root.mcp as { excluded?: string[]; allowed?: string[] }
            if (Array.isArray(mcpObj.excluded)) {
              mcpObj.excluded = mcpObj.excluded.filter((e) => e !== target.name)
            }
            if (Array.isArray(mcpObj.allowed)) {
              if (!mcpObj.allowed.includes(target.name)) {
                mcpObj.allowed.push(target.name)
              }
            }
          }
          if (target.tool === 'claude-code') {
            if (Array.isArray(root.disabledMcpServers)) {
              root.disabledMcpServers = root.disabledMcpServers.filter((e) => e !== target.name)
            }
            if (target.scope === 'project' && root.projects && typeof root.projects === 'object') {
              const currentWorkspace = getEffectiveProjectWorkspace(options)
              const proj = (root.projects as Record<string, { disabledMcpServers?: string[] }>)[currentWorkspace]
              if (proj && Array.isArray(proj.disabledMcpServers)) {
                proj.disabledMcpServers = proj.disabledMcpServers.filter((e) => e !== target.name)
              }
            }
          }
        },
        tx
      )

      if (options?.beforeSecondWriteHook) {
        options.beforeSecondWriteHook()
      }

      // Step 2: ONLY AFTER tool write succeeds, remove from disabled registry
      removeDisabledEntry(target.tool, target.scope, target.name, options, tx)

      // Verification
      const verifiedServers = readMCPServersForTool(target.tool, target.scope, options)
      const reloaded = verifiedServers.find((s) => s.name === target.name)
      if (!reloaded || reloaded.enabled !== true) {
        throw new Error(`Policy error: Server "${target.name}" failed to enable due to conflicting policy.`)
      }

      const server: MCPServerDefinition = {
        ...disabled.server,
        enabled: true,
        revision: computeServerRevision(target.tool, target.scope, target.name, options),
      }
      return { success: true, server }
    }
  } catch (err) {
    try { tx.rollback() } catch (rollbackError) {
      return { success: false, error: `${(err as Error).message}. ${(rollbackError as Error).message}` }
    }
    return { success: false, error: (err as Error).message }
  }
}

// =========================================================================
// Cross-Tool Distribution & Preflight
// =========================================================================

export function preflightMCPDistribution(
  server: MCPServerDefinition | MCPServerInput,
  targets: MCPDistributionTarget[],
  options?: MCPOptions
): MCPDistributionPreflightResult {
  const items: MCPDistributionPreflightItem[] = []

  for (const target of targets) {
    const reasons: string[] = []
    let compatible = true
    let targetExists = false
    let willOverwrite = false
    let configPath = ''
    let currentRevision: string | undefined

    // 1. Validate tool and scope
    const validTools: readonly MCPSourceTool[] = VALID_MCP_TOOLS
    const validScopes: MCPScope[] = ['global', 'project']
    if (!validTools.includes(target.tool) || !validScopes.includes(target.scope)) {
      items.push({
        tool: target.tool,
        scope: target.scope,
        configPath: '',
        targetExists: false,
        willOverwrite: false,
        compatible: false,
        reasons: [`Invalid target tool "${target.tool}" or scope "${target.scope}".`],
      })
      continue
    }

    const targetOptions = target.projectWorkspace ? { ...options, projectWorkspace: target.projectWorkspace } : options
    try {
      try {
        validateServerNameForTool(server.name, target.tool)
      } catch (err) {
        compatible = false
        reasons.push((err as Error).message)
      }

      configPath = resolveMCPConfigPath(target.tool, target.scope, targetOptions)
      targetExists = existsSync(configPath)

      // 2. Validate target file validity if exists
      if (targetExists) {
        if (target.tool === 'codex' || target.tool === 'grok') {
          const parsed = readTomlConfig(configPath)
          if (!parsed) {
            compatible = false
            reasons.push(`Target configuration file "${configPath}" cannot be read.`)
          } else if (parsed.data.mcp_servers !== undefined && !isRecord(parsed.data.mcp_servers)) {
            compatible = false
            reasons.push(`Target configuration file "${configPath}" has a malformed mcp_servers property.`)
          } else if (isRecord(parsed.data.mcp_servers)) {
            willOverwrite = Boolean(parsed.data.mcp_servers[server.name])
          }
        } else if (target.tool === 'opencode') {
          const parsed = readOpenCodeConfig(configPath)
          if (!parsed) {
            compatible = false
            reasons.push(`Target configuration file "${configPath}" cannot be read.`)
          } else if (parsed.data.mcp !== undefined && !isRecord(parsed.data.mcp)) {
            compatible = false
            reasons.push(`Target configuration file "${configPath}" has a malformed mcp property.`)
          } else {
            const mcpObj = isRecord(parsed.data.mcp) ? parsed.data.mcp : undefined
            if (mcpObj?.servers !== undefined && !isRecord(mcpObj.servers)) {
              compatible = false
              reasons.push(`Target configuration file "${configPath}" has a malformed mcp.servers property.`)
            } else {
              const serversObj = isRecord(mcpObj?.servers) ? mcpObj.servers : undefined
              const legacyEntry = mcpObj?.[server.name]
              willOverwrite = Boolean(
                serversObj && Object.prototype.hasOwnProperty.call(serversObj, server.name)
              ) || isOpenCodeServerEntry(legacyEntry)
            }
          }
        } else {
          const parsed = readJsonConfig(configPath)
          if (!parsed) {
            compatible = false
            reasons.push(`Target configuration file "${configPath}" cannot be read.`)
          } else if (parsed.data.mcpServers !== undefined && !isRecord(parsed.data.mcpServers)) {
            compatible = false
            reasons.push(`Target configuration file "${configPath}" has a malformed mcpServers property.`)
          } else if (isRecord(parsed.data.mcpServers)) {
            willOverwrite = Boolean(parsed.data.mcpServers[server.name])
          }
        }
      }

      // Check disabled registry collisions too
      const disabled = getDisabledEntry(target.tool, target.scope, server.name, targetOptions)
      if (disabled) willOverwrite = true

      if (willOverwrite) {
        reasons.push(`Target configuration already defines "${server.name}". Distribution will overwrite it.`)
      }

      // 3. Transport compatibility
      const toolMeta = MCP_SOURCE_TOOLS.find((m) => m.id === target.tool)
      if (toolMeta && !toolMeta.supportedTransports.includes(server.transport)) {
        compatible = false
        if (target.tool === 'codex' && server.transport === 'sse') {
          reasons.push('Codex does not support SSE transport. Use HTTP (streamable) or stdio.')
        } else {
          reasons.push(
            `${toolMeta.name} does not support ${server.transport.toUpperCase()} transport. Supported transports: ${toolMeta.supportedTransports.join(', ')}.`
          )
        }
      }

      if (target.tool !== 'codex' && server.envHeaders && Object.keys(server.envHeaders).length > 0) {
        compatible = false
        reasons.push(`${target.tool} does not support env_http_headers.`)
      }

      if (targetExists) {
        currentRevision = computeServerRevision(target.tool, target.scope, server.name, targetOptions)
      }
    } catch (err) {
      compatible = false
      reasons.push(`Preflight check failed on target: ${(err as Error).message}`)
    }

    items.push({
      tool: target.tool,
      scope: target.scope,
      projectWorkspace: target.projectWorkspace,
      configPath,
      targetExists,
      willOverwrite,
      compatible,
      currentRevision,
      reasons: reasons.length > 0 ? reasons : undefined,
    })
  }

  const canDistribute = items.length > 0 && items.every((i) => i.compatible)

  return {
    canDistribute,
    targets: items,
  }
}

export function distributeMCPServer(
  server: MCPServerDefinition | MCPServerInput,
  targets: MCPDistributionTarget[],
  options?: MCPOptions
): MCPDistributionReport {
  validateServerInput(server)

  if (!Array.isArray(targets) || targets.length === 0) {
    return {
      overallSuccess: false,
      results: [
        {
          tool: 'claude-code',
          scope: 'global',
          configPath: '',
          success: false,
          error: 'At least one distribution target is required.',
        },
      ],
    }
  }

  // Pre-validate all target tools and scopes
  for (const t of targets) {
    try {
      validateToolAndScope(t.tool, t.scope)
    } catch (err) {
      return {
        overallSuccess: false,
        results: targets.map((item) => ({
          tool: item.tool,
          scope: item.scope,
          configPath: '',
          success: false,
          error: `Invalid target: ${(err as Error).message}`,
        })),
      }
    }
  }

  // Reject duplicate targets
  const seenTargets = new Set<string>()
  for (const t of targets) {
    const key = `${t.tool}:${t.scope}`
    if (seenTargets.has(key)) {
      return {
        overallSuccess: false,
        results: targets.map((item) => ({
          tool: item.tool,
          scope: item.scope,
          configPath: '',
          success: false,
          error: `Duplicate distribution target "${key}".`,
        })),
      }
    }
    seenTargets.add(key)
  }

  // 1. Run Preflight First
  const preflight = preflightMCPDistribution(server, targets, options)
  if (!preflight.canDistribute) {
    return {
      overallSuccess: false,
      results: preflight.targets.map((t) => ({
        tool: t.tool,
        scope: t.scope,
        configPath: t.configPath,
        success: false,
        error: t.reasons?.join('; ') || 'Preflight validation failed for target.',
      })),
    }
  }

  // 2. Pre-verify revisions of ALL targets before performing ANY writes!
  for (const target of targets) {
    const pfItem = preflight.targets.find(
      (pt) =>
        pt.tool === target.tool &&
        pt.scope === target.scope &&
        (!pt.projectWorkspace || !target.projectWorkspace || path.resolve(pt.projectWorkspace) === path.resolve(target.projectWorkspace))
    )
    if (pfItem && pfItem.targetExists) {
      if (!target.expectedRevision && pfItem.willOverwrite) {
        return {
          overallSuccess: false,
          results: targets.map((t) => ({
            tool: t.tool,
            scope: t.scope,
            configPath: pfItem.configPath,
            success: false,
            error: `Target "${target.tool}" (${target.scope}) already contains "${server.name}". Distribution requires expectedRevision token from preflight.`,
          })),
        }
      }
      if (target.expectedRevision) {
        const targetOptions = target.projectWorkspace ? { ...options, projectWorkspace: target.projectWorkspace } : options
        const currentRev = computeServerRevision(target.tool, target.scope, server.name, targetOptions)
        if (currentRev !== target.expectedRevision) {
          return {
            overallSuccess: false,
            results: targets.map((t) => ({
              tool: t.tool,
              scope: t.scope,
              configPath: pfItem.configPath,
              success: false,
              error: `Target "${target.tool}" (${target.scope}) revision conflict: expected ${target.expectedRevision}, but found ${currentRev}.`,
            })),
          }
        }
      }
    }
  }

  const results: MCPDistributionResultItem[] = []

  for (const target of targets) {
    const targetOptions = target.projectWorkspace ? { ...options, projectWorkspace: target.projectWorkspace } : options
    let configPath = ''
    try {
      configPath = resolveMCPConfigPath(target.tool, target.scope, targetOptions)
      const saveRes = saveMCPServer(
        { tool: target.tool, scope: target.scope, expectedRevision: target.expectedRevision },
        {
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          url: server.url,
          headers: server.headers,
          envHeaders: server.envHeaders,
          enabled: server.enabled !== false,
        },
        targetOptions
      )

      if (saveRes.success) {
        results.push({
          tool: target.tool,
          scope: target.scope,
          projectWorkspace: target.projectWorkspace,
          configPath,
          success: true,
        })
      } else {
        results.push({
          tool: target.tool,
          scope: target.scope,
          projectWorkspace: target.projectWorkspace,
          configPath,
          success: false,
          error: saveRes.error || 'Failed to save server.',
        })
      }
    } catch (err) {
      results.push({
        tool: target.tool,
        scope: target.scope,
        projectWorkspace: target.projectWorkspace,
        configPath,
        success: false,
        error: (err as Error).message,
      })
    }
  }

  const overallSuccess = results.length > 0 && results.every((r) => r.success)

  return {
    overallSuccess,
    results,
  }
}

// Reusable Snapshot Helpers
export async function exportMCPProfileSnapshot(
  options?: MCPOptions
): Promise<{
  global: Record<MCPSourceTool, MCPServerDefinition[]>
  project: Record<MCPSourceTool, MCPServerDefinition[]>
}> {
  const tools = VALID_MCP_TOOLS
  const globalRecord = {} as Record<MCPSourceTool, MCPServerDefinition[]>
  const projectRecord = {} as Record<MCPSourceTool, MCPServerDefinition[]>

  for (const tool of tools) {
    globalRecord[tool] = readMCPServersForTool(tool, 'global', options)
    projectRecord[tool] = readMCPServersForTool(tool, 'project', options)
  }

  return { global: globalRecord, project: projectRecord }
}

// =========================================================================
// Central MCP Source Assets & Target Injection (OPC-56)
// =========================================================================

export function getCentralMCPRegistryPath(options?: MCPOptions): string {
  const traceHome = getEffectiveTraceHome(options)
  return path.join(traceHome, 'mcp-central.json')
}

export function loadCentralMCPRegistry(options?: MCPOptions): Record<string, CentralMCPServer> {
  const filePath = getCentralMCPRegistryPath(options)
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      if (data && typeof data === 'object') return data
    }
  } catch {}
  return {}
}

export function saveCentralMCPRegistry(
  registry: Record<string, CentralMCPServer>,
  options?: MCPOptions
): void {
  const traceHome = getEffectiveTraceHome(options)
  if (!existsSync(traceHome)) {
    mkdirSync(traceHome, { recursive: true })
  }
  const filePath = getCentralMCPRegistryPath(options)
  writeFileSync(filePath, JSON.stringify(registry, null, 2), 'utf8')
}

export async function readCentralMCPServers(options?: MCPOptions): Promise<CentralMCPServer[]> {
  const registry = loadCentralMCPRegistry(options)

  // Also discover servers from tools that might have been configured before or externally
  try {
    const discovered = await readAllMCPServers(options)
    let registryModified = false

    const registerDiscovered = (server: MCPServerDefinition) => {
      const id = server.name
      const projectPath =
        server.scope === 'project'
          ? options?.projectWorkspace || options?.getProjectWorkspace?.()
          : undefined

      if (!registry[id]) {
        registry[id] = {
          id,
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          url: server.url,
          headers: server.headers,
          envHeaders: server.envHeaders,
          enabled: server.enabled,
          updatedAt: server.updatedAt || Date.now(),
          targetAssociations: [
            {
              tool: server.sourceTool,
              scope: server.scope,
              projectPath,
              injectedAt: Date.now(),
              lastSyncStatus: 'synced',
            },
          ],
        }
        registryModified = true
      } else {
        const existingAssocs = registry[id].targetAssociations || []
        const exists = existingAssocs.some(
          (a) =>
            a.tool === server.sourceTool &&
            a.scope === server.scope &&
            (!projectPath || !a.projectPath || path.resolve(a.projectPath) === path.resolve(projectPath))
        )
        if (!exists) {
          existingAssocs.push({
            tool: server.sourceTool,
            scope: server.scope,
            projectPath,
            injectedAt: Date.now(),
            lastSyncStatus: 'synced',
          })
          registry[id].targetAssociations = existingAssocs
          registryModified = true
        }
      }
    }

    for (const s of discovered.global) registerDiscovered(s)
    for (const s of discovered.project) registerDiscovered(s)

    if (registryModified) {
      saveCentralMCPRegistry(registry, options)
    }
  } catch {}

  return Object.values(registry)
}

export function saveCentralMCPServer(
  input: Partial<CentralMCPServer> & { name: string; transport: MCPTransportType },
  options?: MCPOptions
): {
  success: boolean
  server?: CentralMCPServer
  syncResults?: Array<{ tool: MCPSourceTool; scope: MCPScope; projectPath?: string; success: boolean; error?: string }>
  error?: string
} {
  try {
    validateServerInput(input as MCPServerInput)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }

  const registry = loadCentralMCPRegistry(options)
  const id = input.id || input.name

  const existing = registry[id] || registry[input.name]
  const targetAssociations = input.targetAssociations || existing?.targetAssociations || []

  const server: CentralMCPServer = {
    id,
    name: input.name,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: input.env,
    cwd: input.cwd,
    url: input.url,
    headers: input.headers,
    envHeaders: input.envHeaders,
    enabled: input.enabled !== false,
    description: input.description,
    targetAssociations,
    updatedAt: Date.now(),
  }

  // Synchronize changes to all associated injected targets
  const syncResults: Array<{ tool: MCPSourceTool; scope: MCPScope; projectPath?: string; success: boolean; error?: string }> = []
  for (const assoc of targetAssociations) {
    try {
      const targetOptions = assoc.projectPath ? { ...options, projectWorkspace: assoc.projectPath } : options
      const saveRes = saveMCPServer(
        { tool: assoc.tool, scope: assoc.scope },
        {
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          url: server.url,
          headers: server.headers,
          envHeaders: server.envHeaders,
          enabled: server.enabled,
        },
        targetOptions
      )
      assoc.lastSyncStatus = saveRes.success ? 'synced' : 'failed'
      assoc.lastError = saveRes.error
      syncResults.push({
        tool: assoc.tool,
        scope: assoc.scope,
        projectPath: assoc.projectPath,
        success: saveRes.success,
        error: saveRes.error,
      })
    } catch (err: any) {
      assoc.lastSyncStatus = 'failed'
      assoc.lastError = err?.message || String(err)
      syncResults.push({
        tool: assoc.tool,
        scope: assoc.scope,
        projectPath: assoc.projectPath,
        success: false,
        error: err?.message || String(err),
      })
    }
  }

  registry[id] = server
  saveCentralMCPRegistry(registry, options)

  return { success: true, server, syncResults }
}

export function injectMCPServerToTarget(
  serverIdOrName: string,
  target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string },
  options?: MCPOptions
): { success: boolean; error?: string } {
  try {
    validateToolAndScope(target.tool, target.scope)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }

  const registry = loadCentralMCPRegistry(options)
  const server = registry[serverIdOrName] || Object.values(registry).find((s) => s.name === serverIdOrName)
  if (!server) {
    return { success: false, error: `找不到 MCP 资产: ${serverIdOrName}` }
  }

  const projectPath =
    target.scope === 'project'
      ? target.projectPath || options?.projectWorkspace || options?.getProjectWorkspace?.()
      : undefined

  if (target.scope === 'project' && !projectPath) {
    return { success: false, error: '未指定有效的项目路径' }
  }

  const targetOptions = projectPath ? { ...options, projectWorkspace: projectPath } : options

  const saveRes = saveMCPServer(
    { tool: target.tool, scope: target.scope },
    {
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      envHeaders: server.envHeaders,
      enabled: server.enabled,
    },
    targetOptions
  )

  if (!saveRes.success) {
    return { success: false, error: saveRes.error || '写入目标配置失败' }
  }

  // Update target associations
  const assocs = server.targetAssociations || []
  const existingIdx = assocs.findIndex(
    (a) =>
      a.tool === target.tool &&
      a.scope === target.scope &&
      (!projectPath || !a.projectPath || path.resolve(a.projectPath) === path.resolve(projectPath))
  )

  const newAssoc: MCPTargetAssociation = {
    tool: target.tool,
    scope: target.scope,
    projectPath,
    injectedAt: Date.now(),
    lastSyncStatus: 'synced',
  }

  if (existingIdx >= 0) {
    assocs[existingIdx] = newAssoc
  } else {
    assocs.push(newAssoc)
  }

  server.targetAssociations = assocs
  registry[server.id] = server
  saveCentralMCPRegistry(registry, options)

  return { success: true }
}

export function uninjectMCPServerFromTarget(
  serverIdOrName: string,
  target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string },
  options?: MCPOptions
): { success: boolean; error?: string } {
  try {
    validateToolAndScope(target.tool, target.scope)
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }

  const registry = loadCentralMCPRegistry(options)
  const server = registry[serverIdOrName] || Object.values(registry).find((s) => s.name === serverIdOrName)
  if (!server) {
    return { success: false, error: `找不到 MCP 资产: ${serverIdOrName}` }
  }

  const projectPath =
    target.scope === 'project'
      ? target.projectPath || options?.projectWorkspace || options?.getProjectWorkspace?.()
      : undefined

  if (target.scope === 'project') {
    if (!projectPath) {
      return { success: false, error: '未指定有效的项目路径' }
    }
    try {
      if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
        return { success: false, error: `项目路径不存在或不是文件夹: ${projectPath}` }
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  }

  const targetOptions = projectPath ? { ...options, projectWorkspace: projectPath } : options

  // Delete from target config
  const delRes = deleteMCPServer({ tool: target.tool, scope: target.scope, name: server.name }, targetOptions)
  if (!delRes.success) {
    // Record failed status in target associations
    const assocs = server.targetAssociations || []
    const match = assocs.find(
      (a) =>
        a.tool === target.tool &&
        a.scope === target.scope &&
        (!projectPath || !a.projectPath || path.resolve(a.projectPath) === path.resolve(projectPath))
    )
    if (match) {
      match.lastSyncStatus = 'failed'
      match.lastError = delRes.error || '从目标工具配置中删除失败'
      saveCentralMCPRegistry(registry, options)
    }
    return { success: false, error: delRes.error || '从目标工具配置中删除失败' }
  }

  // Remove target from associations on real success, retaining central server source
  const assocs = (server.targetAssociations || []).filter((a) => {
    if (a.tool !== target.tool || a.scope !== target.scope) return true
    if (target.scope === 'project' && projectPath && a.projectPath) {
      return path.resolve(a.projectPath) !== path.resolve(projectPath)
    }
    return false
  })

  server.targetAssociations = assocs
  registry[server.id] = server
  saveCentralMCPRegistry(registry, options)

  return { success: true }
}

export function deleteCentralMCPServer(
  serverIdOrName: string,
  options?: MCPOptions
): {
  success: boolean
  error?: string
  targetErrors?: Array<{ target: any; error: string }>
  failedTargets?: Array<{ tool: MCPSourceTool; scope: MCPScope; projectPath?: string; error: string }>
} {
  const registry = loadCentralMCPRegistry(options)
  const server = registry[serverIdOrName] || Object.values(registry).find((s) => s.name === serverIdOrName)
  if (!server) {
    return { success: false, error: `找不到 MCP 资产: ${serverIdOrName}` }
  }

  const failedTargets: Array<{ tool: MCPSourceTool; scope: MCPScope; projectPath?: string; error: string }> = []
  const remainingAssocs: MCPTargetAssociation[] = []

  // Uninject from all targets through uninjectMCPServerFromTarget to ensure full validation
  for (const assoc of [...(server.targetAssociations || [])]) {
    try {
      const uninjRes = uninjectMCPServerFromTarget(
        server.id,
        { tool: assoc.tool, scope: assoc.scope, projectPath: assoc.projectPath },
        options
      )
      if (!uninjRes.success) {
        assoc.lastSyncStatus = 'failed'
        assoc.lastError = uninjRes.error || '从目标删除失败'
        remainingAssocs.push(assoc)
        failedTargets.push({
          tool: assoc.tool,
          scope: assoc.scope,
          projectPath: assoc.projectPath,
          error: uninjRes.error || '从目标删除失败',
        })
      }
    } catch (err: any) {
      assoc.lastSyncStatus = 'failed'
      assoc.lastError = err?.message || String(err)
      remainingAssocs.push(assoc)
      failedTargets.push({
        tool: assoc.tool,
        scope: assoc.scope,
        projectPath: assoc.projectPath,
        error: err?.message || String(err),
      })
    }
  }

  if (failedTargets.length > 0) {
    server.targetAssociations = remainingAssocs
    registry[server.id] = server
    saveCentralMCPRegistry(registry, options)
    const targetErrors = failedTargets.map((f) => ({ target: f, error: f.error }))
    return {
      success: false,
      error: `无法完全从目标工具中删除资产: ${failedTargets.map((f) => `${f.tool}: ${f.error}`).join('; ')}`,
      targetErrors,
      failedTargets,
    }
  }

  delete registry[server.id]
  if (server.name !== server.id) {
    delete registry[server.name]
  }

  saveCentralMCPRegistry(registry, options)
  return { success: true }
}

export function batchInjectMCPServers(
  serverIds: string[],
  target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string },
  options?: MCPOptions
): { results: Array<{ id: string; success: boolean; error?: string }> } {
  const results: Array<{ id: string; success: boolean; error?: string }> = []
  for (const id of serverIds) {
    const res = injectMCPServerToTarget(id, target, options)
    results.push({ id, success: res.success, error: res.error })
  }
  return { results }
}

export function batchUninjectMCPServers(
  serverIds: string[],
  target: { tool: MCPSourceTool; scope: MCPScope; projectPath?: string },
  options?: MCPOptions
): { results: Array<{ id: string; success: boolean; error?: string }> } {
  const results: Array<{ id: string; success: boolean; error?: string }> = []
  for (const id of serverIds) {
    const res = uninjectMCPServerFromTarget(id, target, options)
    results.push({ id, success: res.success, error: res.error })
  }
  return { results }
}
