import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VALID_MCP_TOOLS,
  computeServerRevision,
  deleteMCPServer,
  distributeMCPServer,
  exportMCPProfileSnapshot,
  getDisabledRegistryPath,
  injectMCPServerToTarget,
  preflightMCPDistribution,
  readAllMCPServers,
  readCentralMCPServers,
  readMCPServersForTool,
  resolveMCPConfigPath,
  saveCentralMCPServer,
  saveMCPServer,
  toggleMCPServer,
  uninjectMCPServerFromTarget,
  deleteCentralMCPServer,
  batchInjectMCPServers,
  batchUninjectMCPServers,
  validateServerName,
} from '../apps/desktop/electron/mcp-manager.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRequire = createRequire(path.join(__dirname, '../apps/desktop/package.json'))
const { parse: parseToml } = desktopRequire('smol-toml')
const { parseTOML } = desktopRequire('toml-eslint-parser')
const { parse: parseJsonc } = desktopRequire('jsonc-parser')

const testRoot = mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-verify-'))

try {
  console.log('=== Trace MCP Management Verification ===')

  // =========================================================================
  // Section A: Supervisor Independent Review Cases (Verbatim)
  // =========================================================================
  console.log('\n--- Section A: Supervisor Review Cases ---')

  const setFile = (p, text) => {
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
  }

  const runSupervisorCase = async (name, fn) => {
    const home = path.join(testRoot, 'case-' + String(Math.random()).slice(2, 10))
    mkdirSync(home, { recursive: true })
    const o = { homeDir: home, projectWorkspace: path.join(home, 'project') }
    try {
      await fn(o)
      console.log('PASS', name)
    } catch (e) {
      console.log('FAIL', name, ':', e.message)
      throw e
    }
  }

  // Case 1: disabled service survives reload
  await runSupervisorCase('disabled service survives reload', (o) => {
    const t = { tool: 'cursor', scope: 'global' }
    assert.equal(saveMCPServer(t, { name: 'demo', transport: 'stdio', command: 'npx' }, o).success, true)
    assert.equal(toggleMCPServer({ ...t, name: 'demo' }, false, o).success, true)
    assert.equal(readMCPServersForTool('cursor', 'global', o).find((s) => s.name === 'demo')?.enabled, false)
  })

  // Case 2: create disabled JSON service stays inactive
  await runSupervisorCase('create disabled JSON service stays inactive', (o) => {
    const t = { tool: 'gemini', scope: 'global' }
    assert.equal(saveMCPServer(t, { name: 'demo', transport: 'stdio', command: 'npx', enabled: false }, o).success, true)
    assert.equal(readMCPServersForTool('gemini', 'global', o).find((s) => s.name === 'demo')?.enabled, false)
    const p = resolveMCPConfigPath('gemini', 'global', o)
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).mcpServers?.demo, undefined)
  })

  // Case 3: nested TOML server can be edited
  await runSupervisorCase('nested TOML server can be edited', (o) => {
    const p = resolveMCPConfigPath('codex', 'global', o)
    setFile(
      p,
      'model = "test"\n[mcp_servers.demo]\ncommand = "node"\n[mcp_servers.demo.env]\nTOKEN = "fixture"\n# preserve comment\n[desktop]\nvalue = true\n'
    )
    const r = saveMCPServer(
      { tool: 'codex', scope: 'global' },
      { name: 'demo', transport: 'stdio', command: 'npx', env: { TOKEN: 'fixture' } },
      o
    )
    assert.equal(r.success, true, r.error)
    assert.ok(readFileSync(p, 'utf8').includes('# preserve comment\n[desktop]\nvalue = true'))
  })

  // Case 4: unsupported SSE to Codex is rejected
  await runSupervisorCase('unsupported SSE to Codex is rejected', (o) => {
    const p = preflightMCPDistribution(
      { name: 'demo', transport: 'sse', url: 'https://fixture.invalid/mcp' },
      [{ tool: 'codex', scope: 'global' }],
      o
    )
    assert.equal(p.canDistribute, false)
  })

  // Case 5: invalid target is rejected before distribution
  await runSupervisorCase('invalid target is rejected before distribution', (o) => {
    setFile(resolveMCPConfigPath('cursor', 'global', o), '{broken')
    const p = preflightMCPDistribution(
      { name: 'demo', transport: 'stdio', command: 'node' },
      [{ tool: 'cursor', scope: 'global' }],
      o
    )
    assert.equal(p.canDistribute, false)
  })

  // Case 6: Gemini native exclusion is shown disabled
  await runSupervisorCase('Gemini native exclusion is shown disabled', (o) => {
    setFile(
      resolveMCPConfigPath('gemini', 'global', o),
      JSON.stringify({ mcpServers: { demo: { command: 'node' } }, mcp: { excluded: ['demo'] } })
    )
    assert.equal(readMCPServersForTool('gemini', 'global', o)[0].enabled, false)
  })

  // Case 7: failed enable preserves disabled recovery record
  await runSupervisorCase('failed enable preserves disabled recovery record', (o) => {
    const t = { tool: 'cursor', scope: 'global' }
    const p = resolveMCPConfigPath('cursor', 'global', o)
    setFile(p, '{broken')
    const rp = getDisabledRegistryPath(o)
    setFile(
      rp,
      JSON.stringify({
        version: 1,
        entries: {
          'global:cursor:demo': {
            id: 'global:cursor:demo',
            name: 'demo',
            sourceTool: 'cursor',
            tool: 'cursor',
            scope: 'global',
            server: { name: 'demo' },
            rawEntry: { command: 'node' },
          },
        },
      })
    )
    const before = readFileSync(rp, 'utf8')
    assert.equal(toggleMCPServer({ ...t, name: 'demo' }, true, o).success, false)
    assert.equal(readFileSync(rp, 'utf8'), before)
  })

  // Case 8: concurrent editor write does not overwrite newer command
  await runSupervisorCase('concurrent editor write does not overwrite newer command', (o) => {
    const t = { tool: 'cursor', scope: 'global' }
    const p = resolveMCPConfigPath('cursor', 'global', o)
    saveMCPServer(t, { name: 'demo', transport: 'stdio', command: 'node' }, o)
    const before = readMCPServersForTool('cursor', 'global', o)[0]
    const r = saveMCPServer(
      { ...t, expectedRevision: before.revision },
      { name: 'demo', transport: 'stdio', command: 'old-editor' },
      { ...o, beforeWriteHook: () => setFile(p, JSON.stringify({ mcpServers: { demo: { command: 'external-new' } } })) }
    )
    assert.equal(r.success, false)
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).mcpServers.demo.command, 'external-new')
  })

  // Case 9: non-MCP TOML whitespace preserved verbatim
  await runSupervisorCase('non-MCP TOML whitespace preserved verbatim', (o) => {
    const p = resolveMCPConfigPath('codex', 'global', o)
    const suffix = '# desktop comment\n\n\n[desktop]\nname = "fixture"\n'
    setFile(p, '[mcp_servers.demo]\ncommand = "node"\n' + suffix)
    const r = saveMCPServer({ tool: 'codex', scope: 'global' }, { name: 'demo', transport: 'stdio', command: 'npx' }, o)
    assert.equal(r.success, true, r.error)
    assert.ok(readFileSync(p, 'utf8').endsWith(suffix))
  })

  // Case 10: disabled edit re-enable keeps custom source fields
  await runSupervisorCase('disabled edit re-enable keeps custom source fields', (o) => {
    const t = { tool: 'cursor', scope: 'global' }
    const p = resolveMCPConfigPath('cursor', 'global', o)
    setFile(p, JSON.stringify({ mcpServers: { demo: { command: 'node', fixtureOption: { retained: true } } } }))
    toggleMCPServer({ ...t, name: 'demo' }, false, o)
    assert.equal(saveMCPServer(t, { name: 'demo', transport: 'stdio', command: 'node', enabled: true }, o).success, true)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')).mcpServers.demo.fixtureOption, { retained: true })
  })

  // Case 11: invalid scope cannot mutate project config
  await runSupervisorCase('invalid scope cannot mutate project config', (o) => {
    const r = saveMCPServer({ tool: 'cursor', scope: 'invalid' }, { name: 'demo', transport: 'stdio', command: 'node' }, o)
    assert.equal(r.success, false)
    assert.equal(existsSync(resolveMCPConfigPath('cursor', 'project', o)), false)
  })

  // =========================================================================
  // Section B: In-depth Regressions & Boundary Coverage
  // =========================================================================
  console.log('\n--- Section B: In-depth Regressions & Boundary Coverage ---')

  const fakeHome = path.join(testRoot, 'home')
  const fakeWorkspace = path.join(testRoot, 'workspace')
  const fakeTraceHome = path.join(fakeHome, '.trace')

  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(fakeWorkspace, { recursive: true })
  mkdirSync(fakeTraceHome, { recursive: true })

  const options = {
    homeDir: fakeHome,
    projectWorkspace: fakeWorkspace,
    traceHome: fakeTraceHome,
  }

  // 1. Large Claude JSON Preservation (~135KB, 84 unrelated keys, 42 projects)
  console.log('Test B1: Large Claude JSON Invariant Preservation (~135KB, 84 keys, 42 projects)...')
  const claudePath = resolveMCPConfigPath('claude-code', 'global', options)
  const largeClaudeConfig = {
    theme: 'dark',
    version: 42,
    autoUpdates: true,
    telemetry: false,
    editorSettings: {
      tabSize: 2,
      fontFamily: 'SF Mono',
      renderWhitespace: 'selection',
    },
    projects: {},
    mcpServers: {
      'existing-server': {
        type: 'stdio',
        command: 'echo',
        args: ['hello'],
      },
    },
  }

  for (let i = 0; i < 84; i++) {
    largeClaudeConfig[`custom_config_key_${i}`] = {
      index: i,
      name: `Enterprise Governance Setting Rule ${i}`,
      enabled: i % 2 === 0,
      category: `security-policy-domain-${i % 7}`,
      description: `This configuration parameter controls runtime sandboxing policy, telemetry sanitization boundaries, audit trail emissions, and external process capability containment for subsystem module ${i}. Ensure high compliance with ISO-27001 and SOC2 type II audit requirements when modifying this parameter in enterprise environments.`,
      documentation: `Reference manual for policy cluster ${i}: provides operational guidelines for zero-trust token delegation, inter-process communication channels, and secure container boundaries across internal developer workstations.`,
      tags: ['config', `item-${i}`, 'governance', 'enterprise-tier-4', 'soc2-compliant', 'audit-trail', 'zero-trust'],
      nested: {
        score: i * 1.5,
        metadata: {
          flag: true,
          revision: `rev-2026-09-${(i % 28) + 1}`,
          complianceProfile: 'enterprise-strict-enforcement',
          validationRegex: '^([a-zA-Z0-9_-]+)@internal\\.enterprise\\.corp$',
          documentationUrl: `https://docs.enterprise.internal/governance/standards/clause-${i}`,
          fallbackStrategy: 'graceful-degradation-with-alerting',
          maintainerTeam: `core-security-infrastructure-group-${i % 4}`,
        },
        telemetry: {
          sampleRate: 0.15,
          endpoint: `https://telemetry-gateway-${i % 5}.enterprise.internal/v2/metrics`,
          piiScrubbingEnabled: true,
          encryptionAlgorithm: 'AES-256-GCM',
          keyRotationIntervalDays: 90,
          bufferCapacityBytes: 65536,
        },
      },
    }
  }

  for (let p = 0; p < 42; p++) {
    const projPath = `/Users/developer/repos/enterprise-project-${p}`
    largeClaudeConfig.projects[projPath] = {
      id: `proj-${p}`,
      displayName: `Enterprise Core Project Repository Cluster ${p}`,
      description: `Production monorepo workspace for mission-critical microservice ${p}. Configured with strict workspace approval boundaries, automated lint checks, and isolated MCP tool bindings.`,
      autoApprove: ['bash', 'readFile', 'grep_search', 'view_file'],
      disabledMcpServers: [`ext-tool-${p}`, `legacy-indexer-${p}`],
      rules: ['no-any', 'strict-null-checks', 'enforce-isolated-modules', 'audit-all-subprocess-spawns'],
      lastOpened: Date.now() - p * 100000,
      workspaceSettings: {
        nodeVersion: 'v20.18.0',
        packageManager: 'pnpm@9.12.0',
        enableTypeCheckingOnSave: true,
        maxContextWindowTokens: 128000,
        environmentVariables: {
          PROJECT_ENV: 'staging',
          AUDIT_LOG_DESTINATION: `/var/log/enterprise-audit/proj-${p}.log`,
          API_ENDPOINT: `https://api-${p}.internal.network/v1`,
          MAX_RETRIES: '3',
          TIMEOUT_MS: '15000',
          DIAGNOSTIC_LEVEL: 'verbose',
        },
        securityPolicy: {
          allowExternalNetworkAccess: false,
          requireSignedCommits: true,
          sandboxExecutionTimeoutSec: 120,
          enforceProtectedBranches: true,
        },
      },
    }
  }

  const serializedInitial = JSON.stringify(largeClaudeConfig, null, 2)
  writeFileSync(claudePath, serializedInitial, 'utf8')
  assert(Buffer.byteLength(serializedInitial, 'utf8') >= 134144, 'Claude config must be >= 131KiB (134,144 bytes)')

  const addRes = saveMCPServer(
    { tool: 'claude-code', scope: 'global' },
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { DEBUG: 'true' },
    },
    options
  )
  assert.equal(addRes.success, true)

  const updateRes = saveMCPServer(
    { tool: 'claude-code', scope: 'global' },
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp', '/var'],
      env: { DEBUG: 'false', EXTRA: '1' },
    },
    options
  )
  assert.equal(updateRes.success, true)

  const delRes = deleteMCPServer(
    { tool: 'claude-code', scope: 'global', name: 'filesystem' },
    options
  )
  assert.equal(delRes.success, true)

  const diskContent = JSON.parse(readFileSync(claudePath, 'utf8'))
  for (let i = 0; i < 84; i++) {
    const key = `custom_config_key_${i}`
    assert.deepEqual(diskContent[key], largeClaudeConfig[key], `Key ${key} must be preserved`)
  }
  assert.equal(Object.keys(diskContent.projects).length, 42, 'Must have exactly 42 projects')
  for (let p = 0; p < 42; p++) {
    const projPath = `/Users/developer/repos/enterprise-project-${p}`
    assert.deepEqual(diskContent.projects[projPath], largeClaudeConfig.projects[projPath])
  }
  assert.equal(diskContent.theme, 'dark')
  assert(diskContent.mcpServers['existing-server'] !== undefined)
  assert.equal(diskContent.mcpServers.filesystem, undefined)
  console.log('PASS Large Claude JSON Invariant Preservation')

  // 2. Codex TOML Lossless Editing & Preservation of Comments and Quoted Keys
  console.log('Test B2: Codex TOML Lossless Editing, Comments & Quoted Keys...')
  const codexPath = resolveMCPConfigPath('codex', 'global', options)
  const initialToml = `# Codex Configuration File
# Top-level comment
model = "o3-mini"
temperature = 0.7

[desktop]
# Window dimensions and preferences
width = 1280
height = 800
zoom = 1.0

[plugins.web_search]
# Web search integration settings
options = { max_results = 5, timeout = 30 }

[marketplaces."custom.repo"]
url = "https://custom.repo/market"

[mcp_servers.sqlite]
# Local database server
command = "uvx"
args = ["mcp-server-sqlite", "--db", "test.db"]
enabled = true

[mcp_servers."quoted.dot-server"]
command = "node"
args = ["quoted.js"]
`
  mkdirSync(path.dirname(codexPath), { recursive: true })
  writeFileSync(codexPath, initialToml, 'utf8')

  const codexAddRes = saveMCPServer(
    { tool: 'codex', scope: 'global' },
    {
      name: 'fetch',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token-123' },
      envHeaders: { 'X-API-Key': 'SECRET_KEY_ENV' },
      enabled: true,
    },
    options
  )
  assert.equal(codexAddRes.success, true)

  const codexDelRes = deleteMCPServer(
    { tool: 'codex', scope: 'global', name: 'quoted.dot-server' },
    options
  )
  assert.equal(codexDelRes.success, true)

  const rawDiskToml = readFileSync(codexPath, 'utf8')
  parseTOML(rawDiskToml)
  const parsedDiskToml = parseToml(rawDiskToml)

  assert.ok(rawDiskToml.includes('# Codex Configuration File'))
  assert.ok(rawDiskToml.includes('# Window dimensions and preferences'))
  assert.ok(rawDiskToml.includes('# Web search integration settings'))
  assert.equal(parsedDiskToml.model, 'o3-mini')
  assert.deepEqual(parsedDiskToml.desktop, { width: 1280, height: 800, zoom: 1.0 })
  assert.equal(parsedDiskToml.mcp_servers['quoted.dot-server'], undefined)
  assert.equal(parsedDiskToml.mcp_servers.fetch.url, 'https://example.com/mcp')
  assert.deepEqual(parsedDiskToml.mcp_servers.fetch.http_headers, { Authorization: 'Bearer token-123' })
  assert.deepEqual(parsedDiskToml.mcp_servers.fetch.env_http_headers, { 'X-API-Key': 'SECRET_KEY_ENV' })
  console.log('PASS Codex TOML Lossless Editing & Comments')

  // 3. Four-Way Transport and Field Mapping
  console.log('Test B3: Four-Way Transport and Field Mapping...')
  const cursorStdio = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    {
      name: 'cursor-stdio',
      transport: 'stdio',
      command: 'python3',
      args: ['main.py'],
      env: { PY: '3' },
    },
    options
  )
  assert.equal(cursorStdio.success, true)

  const geminiSse = saveMCPServer(
    { tool: 'gemini', scope: 'global' },
    {
      name: 'gemini-sse',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { Auth: 'token' },
    },
    options
  )
  assert.equal(geminiSse.success, true)

  const geminiHttp = saveMCPServer(
    { tool: 'gemini', scope: 'global' },
    {
      name: 'gemini-http',
      transport: 'http',
      url: 'https://example.com/http-stream',
      headers: { Auth: 'token' },
    },
    options
  )
  assert.equal(geminiHttp.success, true)

  const geminiDisk = JSON.parse(readFileSync(resolveMCPConfigPath('gemini', 'global', options), 'utf8'))
  assert.equal(geminiDisk.mcpServers['gemini-sse'].url, 'https://example.com/sse')
  assert.equal(geminiDisk.mcpServers['gemini-sse'].httpUrl, undefined)
  assert.equal(geminiDisk.mcpServers['gemini-http'].httpUrl, 'https://example.com/http-stream')
  assert.equal(geminiDisk.mcpServers['gemini-http'].url, undefined)
  console.log('PASS Four-Way Transport Mapping')

  // 4. Concurrency Guard: Revision Conflict Detection
  console.log('Test B4: Concurrency Guard & Revision Conflict Protection...')
  const rev1 = computeServerRevision('cursor', 'global', 'cursor-stdio', options)
  assert.ok(rev1 && typeof rev1 === 'string' && rev1.length >= 8)

  // External modification simulation
  const cursorCfgPath = resolveMCPConfigPath('cursor', 'global', options)
  const cursorObj = JSON.parse(readFileSync(cursorCfgPath, 'utf8'))
  cursorObj.mcpServers['cursor-stdio'].command = 'python3.11'
  writeFileSync(cursorCfgPath, JSON.stringify(cursorObj, null, 2), 'utf8')

  // Stale save must be rejected
  const conflictRes = saveMCPServer(
    { tool: 'cursor', scope: 'global', expectedRevision: rev1 },
    { name: 'cursor-stdio', transport: 'stdio', command: 'python3.12' },
    options
  )
  assert.equal(conflictRes.success, false)
  assert.ok(conflictRes.error?.includes('Revision conflict'))
  console.log('PASS Concurrency Guard & Revision Conflict Protection')

  // 5. Collision Guard: New Create Rejects Existing Same-Name Server
  console.log('Test B5: Collision Guard on New Create...')
  const collisionRes = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    { name: 'cursor-stdio', transport: 'stdio', command: 'node', isNew: true },
    options
  )
  assert.equal(collisionRes.success, false)
  assert.ok(collisionRes.error?.includes('Collision error'))
  console.log('PASS Collision Guard on New Create')

  // 6. Direct Codex SSE Rejection in saveMCPServer
  console.log('Test B6: Codex SSE Direct Save Rejection...')
  const codexSseRes = saveMCPServer(
    { tool: 'codex', scope: 'global' },
    { name: 'bad-sse', transport: 'sse', url: 'https://bad.sse/endpoint' },
    options
  )
  assert.equal(codexSseRes.success, false)
  assert.ok(codexSseRes.error?.includes('Codex does not support SSE transport'))
  console.log('PASS Codex SSE Direct Save Rejection')

  // 7. Non-Codex envHeaders Rejection
  console.log('Test B7: Non-Codex envHeaders Rejection...')
  const nonCodexEnvHeaderRes = saveMCPServer(
    { tool: 'claude-code', scope: 'global' },
    {
      name: 'env-header-test',
      transport: 'http',
      url: 'https://example.com',
      envHeaders: { SECRET: 'ENV_VAR' },
    },
    options
  )
  assert.equal(nonCodexEnvHeaderRes.success, false)
  assert.ok(nonCodexEnvHeaderRes.error?.includes('does not support env_http_headers'))
  console.log('PASS Non-Codex envHeaders Rejection')

  // 8. Safe Transaction Rollback on Failure
  console.log('Test B8: Safe Transaction Rollback on Injected Failure...')
  const testHomeRollback = path.join(testRoot, 'rollback-test')
  mkdirSync(testHomeRollback, { recursive: true })
  const rbOptions = { homeDir: testHomeRollback, projectWorkspace: path.join(testHomeRollback, 'proj') }
  const rbConfigPath = resolveMCPConfigPath('cursor', 'global', rbOptions)
  mkdirSync(path.dirname(rbConfigPath), { recursive: true })
  writeFileSync(rbConfigPath, JSON.stringify({ mcpServers: { initial: { command: 'echo' } } }), 'utf8')
  const initialBytes = readFileSync(rbConfigPath, 'utf8')

  // Inject failure via test hook
  const rbFailRes = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    { name: 'failing-server', transport: 'stdio', command: 'fail' },
    {
      ...rbOptions,
      beforeWriteHook: () => {
        throw new Error('Injected disk IO failure')
      },
    }
  )
  assert.equal(rbFailRes.success, false)
  assert.equal(readFileSync(rbConfigPath, 'utf8'), initialBytes, 'Original config must be intact after rollback')
  console.log('PASS Safe Transaction Rollback')

  // 8b. Second Write Failure Rollback on Multi-Step Operation
  console.log('Test B8b: Second Write Failure Rollback on Multi-Step Operation...')
  const rbTest2 = path.join(testRoot, 'rollback-test-2')
  mkdirSync(rbTest2, { recursive: true })
  const rbOptions2 = { homeDir: rbTest2, projectWorkspace: path.join(rbTest2, 'proj') }
  const rbConfigPath2 = resolveMCPConfigPath('cursor', 'global', rbOptions2)
  mkdirSync(path.dirname(rbConfigPath2), { recursive: true })
  writeFileSync(rbConfigPath2, JSON.stringify({ mcpServers: { initial: { command: 'echo' } } }), 'utf8')
  const initialBytes2 = readFileSync(rbConfigPath2, 'utf8')

  const failSecondWriteRes = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    { name: 'initial', transport: 'stdio', command: 'echo', enabled: false },
    {
      ...rbOptions2,
      beforeSecondWriteHook: () => {
        throw new Error('Injected failure before second write')
      },
    }
  )
  assert.equal(failSecondWriteRes.success, false)
  assert.equal(readFileSync(rbConfigPath2, 'utf8'), initialBytes2, 'Step 1 write must be rolled back on step 2 failure')
  console.log('PASS Second Write Failure Rollback')

  // 8c. Rollback Does Not Overwrite Concurrent External Edits
  console.log('Test B8c: Rollback Does Not Overwrite Concurrent External Edits...')
  const rbTest3 = path.join(testRoot, 'rollback-test-3')
  mkdirSync(rbTest3, { recursive: true })
  const rbOptions3 = { homeDir: rbTest3, projectWorkspace: path.join(rbTest3, 'proj') }
  const rbConfigPath3 = resolveMCPConfigPath('cursor', 'global', rbOptions3)
  mkdirSync(path.dirname(rbConfigPath3), { recursive: true })
  writeFileSync(rbConfigPath3, JSON.stringify({ mcpServers: { s1: { command: 'v1' } } }), 'utf8')

  const failWithConcurrentRes = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    { name: 's1', transport: 'stdio', command: 'v2', enabled: false },
    {
      ...rbOptions3,
      beforeSecondWriteHook: () => {
        writeFileSync(rbConfigPath3, JSON.stringify({ mcpServers: { s1: { command: 'concurrent-edit' } } }), 'utf8')
        throw new Error('Injected failure after concurrent external edit')
      },
    }
  )
  assert.equal(failWithConcurrentRes.success, false)
  assert.equal(JSON.parse(readFileSync(rbConfigPath3, 'utf8')).mcpServers.s1.command, 'concurrent-edit')
  console.log('PASS Rollback Preserves External Modifications')

  // 8d. Malformed mcpServers Structure Safety
  console.log('Test B8d: Malformed mcpServers Structure Safety...')
  const malformedTestPath = path.join(testRoot, 'malformed-test')
  mkdirSync(malformedTestPath, { recursive: true })
  const malformedOptions = { homeDir: malformedTestPath, projectWorkspace: path.join(malformedTestPath, 'proj') }
  const malformedConfigPath = resolveMCPConfigPath('cursor', 'global', malformedOptions)

  mkdirSync(path.dirname(malformedConfigPath), { recursive: true })
  writeFileSync(malformedConfigPath, JSON.stringify({ mcpServers: ['bad', 'array'] }), 'utf8')
  const arrayRes = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    { name: 'demo', transport: 'stdio', command: 'node' },
    malformedOptions
  )
  assert.equal(arrayRes.success, false)
  assert.ok(arrayRes.error?.includes('malformed'))
  assert.equal(readFileSync(malformedConfigPath, 'utf8'), JSON.stringify({ mcpServers: ['bad', 'array'] }))

  writeFileSync(malformedConfigPath, JSON.stringify({ mcpServers: null }), 'utf8')
  const nullRes = saveMCPServer(
    { tool: 'cursor', scope: 'global' },
    { name: 'demo', transport: 'stdio', command: 'node' },
    malformedOptions
  )
  assert.equal(nullRes.success, false)
  assert.ok(nullRes.error?.includes('malformed'))
  console.log('PASS Malformed mcpServers Safety')

  // 8e. Native Policy Synchronization (Gemini mcp.allowed and Claude disabledMcpServers)
  console.log('Test B8e: Native Policy Synchronization (Gemini & Claude)...')
  const policyTestPath = path.join(testRoot, 'policy-test')
  mkdirSync(policyTestPath, { recursive: true })
  const policyOptions = { homeDir: policyTestPath, projectWorkspace: path.join(policyTestPath, 'proj') }

  // Gemini mcp.allowed and mcp.excluded
  const geminiPath = resolveMCPConfigPath('gemini', 'global', policyOptions)
  mkdirSync(path.dirname(geminiPath), { recursive: true })
  writeFileSync(
    geminiPath,
    JSON.stringify({
      mcpServers: { test1: { command: 'node' } },
      mcp: { allowed: ['other'], excluded: ['test1'] },
    }),
    'utf8'
  )
  assert.equal(readMCPServersForTool('gemini', 'global', policyOptions)[0].enabled, false)

  const geminiEnableRes = toggleMCPServer({ tool: 'gemini', scope: 'global', name: 'test1' }, true, policyOptions)
  assert.equal(geminiEnableRes.success, true)
  assert.equal(readMCPServersForTool('gemini', 'global', policyOptions)[0].enabled, true)
  const geminiAfter = JSON.parse(readFileSync(geminiPath, 'utf8'))
  assert.ok(geminiAfter.mcp.allowed.includes('test1'))
  assert.ok(!geminiAfter.mcp.excluded.includes('test1'))

  // Claude root disabledMcpServers
  const claudeTestPath = resolveMCPConfigPath('claude-code', 'global', policyOptions)
  writeFileSync(
    claudeTestPath,
    JSON.stringify({
      mcpServers: { test2: { type: 'stdio', command: 'node' } },
      disabledMcpServers: ['test2'],
    }),
    'utf8'
  )
  assert.equal(readMCPServersForTool('claude-code', 'global', policyOptions)[0].enabled, false)

  const claudeEnableRes = toggleMCPServer({ tool: 'claude-code', scope: 'global', name: 'test2' }, true, policyOptions)
  assert.equal(claudeEnableRes.success, true)
  assert.equal(readMCPServersForTool('claude-code', 'global', policyOptions)[0].enabled, true)
  const claudeAfter = JSON.parse(readFileSync(claudeTestPath, 'utf8'))
  assert.ok(!claudeAfter.disabledMcpServers.includes('test2'))
  console.log('PASS Native Policy Synchronization')

  // 9. Server Name Security Validation
  console.log('Test B9: Server Name Security Validation...')
  assert.throws(() => validateServerName(''), /non-empty string/)
  assert.throws(() => validateServerName('../etc/passwd'), /path traversal/)
  assert.throws(() => validateServerName('__proto__'), /restricted object property/)
  assert.throws(() => validateServerName('constructor'), /restricted object property/)
  assert.throws(() => validateServerName('bad/name'), /path traversal/)
  const invalidGrokName = saveMCPServer(
    { tool: 'grok', scope: 'global' },
    { name: 'bad.name', transport: 'stdio', command: 'node' },
    options
  )
  assert.equal(invalidGrokName.success, false)
  assert.ok(invalidGrokName.error?.includes('Grok server names'))
  console.log('PASS Server Name Security Validation')

  // 10. File Mode 0600 Security Permissions
  console.log('Test B10: File Mode 0600 Permissions...')
  if (process.platform !== 'win32') {
    const cursorStat = statSync(resolveMCPConfigPath('cursor', 'global', options))
    assert.equal(cursorStat.mode & 0o777, 0o600, 'MCP config must be mode 0600')
  }
  console.log('PASS File Mode 0600 Permissions')

  // 11. Cross-Tool N-Target Distribution with Preflight Tokens & Overwrite Guard
  console.log('Test B11: N-Target Cross-Tool Distribution & Preflight Tokens...')
  const distSource = {
    name: 'dist-service',
    transport: 'http',
    url: 'https://dist.service/endpoint',
    headers: { 'X-Key': 'key-value' },
    enabled: true,
  }
  const distTargets = [
    { tool: 'claude-code', scope: 'global' },
    { tool: 'cursor', scope: 'global' },
    { tool: 'gemini', scope: 'global' },
    { tool: 'codex', scope: 'global' },
  ]
  const preflight = preflightMCPDistribution(distSource, distTargets, options)
  assert.equal(preflight.canDistribute, true)
  assert.equal(preflight.targets.length, 4)

  // Use frozen preflight tokens for initial distribution
  const targetsWithTokens = preflight.targets.map((t) => ({
    tool: t.tool,
    scope: t.scope,
    expectedRevision: t.currentRevision,
  }))
  const distReport = distributeMCPServer(distSource, targetsWithTokens, options)
  assert.equal(distReport.overallSuccess, true)
  assert.equal(distReport.results.length, 4)
  assert.ok(distReport.results.every((r) => r.success))

  // Re-distribution without tokens when targets already contain the server must be rejected
  const distWithoutTokens = distributeMCPServer(distSource, distTargets, options)
  assert.equal(distWithoutTokens.overallSuccess, false)
  assert.ok(distWithoutTokens.results.every((r) => !r.success))
  assert.ok(distWithoutTokens.results[0].error?.includes('Distribution requires expectedRevision token'))

  // Re-distribution with fresh preflight tokens succeeds
  const preflight2 = preflightMCPDistribution(distSource, distTargets, options)
  const targetsWithTokens2 = preflight2.targets.map((t) => ({
    tool: t.tool,
    scope: t.scope,
    expectedRevision: t.currentRevision,
  }))
  const distReport2 = distributeMCPServer(distSource, targetsWithTokens2, options)
  assert.equal(distReport2.overallSuccess, true)

  // Assert target contents
  const claudeDist = JSON.parse(readFileSync(resolveMCPConfigPath('claude-code', 'global', options), 'utf8'))
  assert.equal(claudeDist.mcpServers['dist-service'].type, 'http')
  assert.equal(claudeDist.mcpServers['dist-service'].url, 'https://dist.service/endpoint')

  const cursorDist = JSON.parse(readFileSync(resolveMCPConfigPath('cursor', 'global', options), 'utf8'))
  assert.equal(cursorDist.mcpServers['dist-service'].url, 'https://dist.service/endpoint')

  const geminiDist = JSON.parse(readFileSync(resolveMCPConfigPath('gemini', 'global', options), 'utf8'))
  assert.equal(geminiDist.mcpServers['dist-service'].httpUrl, 'https://dist.service/endpoint')

  const codexDist = parseToml(readFileSync(resolveMCPConfigPath('codex', 'global', options), 'utf8'))
  assert.equal(codexDist.mcp_servers['dist-service'].url, 'https://dist.service/endpoint')
  console.log('PASS N-Target Distribution with Preflight Tokens')

  // 12. readAllMCPServers Unified Aggregation
  console.log('Test B12: readAllMCPServers Unified Aggregation...')
  const allServers = await readAllMCPServers(options)
  assert.ok(allServers.global.length >= 3, 'Should aggregate global servers from all tools')
  assert.ok(allServers.global.some((s) => s.name === 'dist-service'))
  console.log('PASS readAllMCPServers Unified Aggregation')

  // =========================================================================
  // Section C: Seven-Protocol Verification (OPC-47)
  // =========================================================================
  console.log('\n--- Section C: Seven-Protocol Verification (OPC-47) ---')

  // C1: 7-Tool Config Path Resolution (Global & Project + OpenCode .jsonc)
  console.log('Test C1: 7-Tool Config Path Resolution (Global & Project)...')
  const home = options.homeDir
  const workspace = options.projectWorkspace
  assert.equal(resolveMCPConfigPath('claude-code', 'global', options), path.join(home, '.claude.json'))
  assert.equal(resolveMCPConfigPath('claude-code', 'project', options), path.join(workspace, '.mcp.json'))
  assert.equal(resolveMCPConfigPath('cursor', 'global', options), path.join(home, '.cursor/mcp.json'))
  assert.equal(resolveMCPConfigPath('cursor', 'project', options), path.join(workspace, '.cursor/mcp.json'))
  assert.equal(resolveMCPConfigPath('gemini', 'global', options), path.join(home, '.gemini/settings.json'))
  assert.equal(resolveMCPConfigPath('gemini', 'project', options), path.join(workspace, '.gemini/settings.json'))
  assert.equal(resolveMCPConfigPath('codex', 'global', options), path.join(home, '.codex/config.toml'))
  assert.equal(resolveMCPConfigPath('codex', 'project', options), path.join(workspace, '.codex/config.toml'))
  assert.equal(resolveMCPConfigPath('opencode', 'global', options), path.join(home, '.config/opencode/opencode.json'))
  assert.equal(resolveMCPConfigPath('opencode', 'project', options), path.join(workspace, 'opencode.json'))
  assert.equal(resolveMCPConfigPath('grok', 'global', options), path.join(home, '.grok/config.toml'))
  assert.equal(resolveMCPConfigPath('grok', 'project', options), path.join(workspace, '.grok/config.toml'))
  assert.equal(resolveMCPConfigPath('antigravity', 'global', options), path.join(home, '.gemini/config/mcp_config.json'))
  assert.equal(resolveMCPConfigPath('antigravity', 'project', options), path.join(workspace, '.agents/mcp_config.json'))

  // OpenCode prefers .jsonc if existing on disk
  const jsoncProjPath = path.join(workspace, 'opencode.jsonc')
  writeFileSync(jsoncProjPath, '{\n  // jsonc\n}', 'utf8')
  assert.equal(resolveMCPConfigPath('opencode', 'project', options), jsoncProjPath)
  rmSync(jsoncProjPath)
  console.log('PASS 7-Tool Config Path Resolution')

  // C2: OpenCode Current Schema & Legacy Schema Read/Write Compatibility
  console.log('Test C2: OpenCode Current & Legacy Schema Read/Write Compatibility...')
  const opencodePath = resolveMCPConfigPath('opencode', 'global', options)
  mkdirSync(path.dirname(opencodePath), { recursive: true })
  writeFileSync(
    opencodePath,
    JSON.stringify(
      {
        mcp: {
          servers: {
            'server-current-stdio': {
              type: 'local',
              command: ['node', 'cli.js', '--mode', 'prod'],
              environment: { DEBUG: 'trace:*' },
            },
            'server-current-remote': {
              type: 'remote',
              url: 'https://opencode.internal/sse',
              headers: { Authorization: 'Bearer token-123' },
            },
          },
          'server-legacy': {
            type: 'local',
            command: ['python3', 'app.py'],
          },
        },
      },
      null,
      2
    ),
    'utf8'
  )

  const opencodeServers = readMCPServersForTool('opencode', 'global', options)
  assert.equal(opencodeServers.length, 3)

  const stdioServer = opencodeServers.find((s) => s.name === 'server-current-stdio')
  assert.ok(stdioServer)
  assert.equal(stdioServer.transport, 'stdio')
  assert.equal(stdioServer.command, 'node')
  assert.deepEqual(stdioServer.args, ['cli.js', '--mode', 'prod'])
  assert.deepEqual(stdioServer.env, { DEBUG: 'trace:*' })
  assert.equal(stdioServer.enabled, true)

  const remoteServer = opencodeServers.find((s) => s.name === 'server-current-remote')
  assert.ok(remoteServer)
  assert.equal(remoteServer.transport, 'http')
  assert.equal(remoteServer.url, 'https://opencode.internal/sse')
  assert.deepEqual(remoteServer.headers, { Authorization: 'Bearer token-123' })
  assert.equal(remoteServer.enabled, true)

  const legacyServer = opencodeServers.find((s) => s.name === 'server-legacy')
  assert.ok(legacyServer)
  assert.equal(legacyServer.transport, 'stdio')
  assert.equal(legacyServer.command, 'python3')
  assert.deepEqual(legacyServer.args, ['app.py'])

  // Toggle stdioServer to disabled
  const togRes = toggleMCPServer({ tool: 'opencode', scope: 'global', name: 'server-current-stdio' }, false, options)
  assert.equal(togRes.success, true)
  const afterTog = readMCPServersForTool('opencode', 'global', options).find((s) => s.name === 'server-current-stdio')
  assert.equal(afterTog.enabled, false)

  // Toggle back to enabled
  const togBackRes = toggleMCPServer({ tool: 'opencode', scope: 'global', name: 'server-current-stdio' }, true, options)
  assert.equal(togBackRes.success, true)
  const afterTogBack = readMCPServersForTool('opencode', 'global', options).find((s) => s.name === 'server-current-stdio')
  assert.equal(afterTogBack.enabled, true)
  console.log('PASS OpenCode Current & Legacy Schema Read/Write')

  // C3: OpenCode Lossless JSONC Comment & Trailing Comma Preservation
  console.log('Test C3: OpenCode Lossless JSONC Comment & Trailing Comma Preservation...')
  const rawJsonc = `// Global configuration header
{
  // User profile theme
  "theme": "dark-high-contrast",
  /* Multi-line editor settings
     preserving linebreaks */
  "editor": {
    "tabSize": 2,
    "formatOnSave": true,
  },
  "mcp": {
    // Active servers list
    "servers": {
      // Base runner
      "base-runner": {
        "type": "local",
        "command": ["sh", "start.sh"],
      },
    },
  },
}
`
  writeFileSync(opencodePath, rawJsonc, 'utf8')

  const saveOpencodeNew = saveMCPServer(
    { tool: 'opencode', scope: 'global' },
    {
      name: 'new-tool',
      transport: 'stdio',
      command: 'docker',
      args: ['run', '-i', 'mcp-img'],
    },
    options
  )
  assert.equal(saveOpencodeNew.success, true)

  const contentAfterSave = readFileSync(opencodePath, 'utf8')
  assert.ok(contentAfterSave.includes('// Global configuration header'))
  assert.ok(contentAfterSave.includes('// User profile theme'))
  assert.ok(contentAfterSave.includes('/* Multi-line editor settings'))
  assert.ok(contentAfterSave.includes('"tabSize": 2,'))
  assert.ok(contentAfterSave.includes('// Active servers list'))
  assert.ok(contentAfterSave.includes('// Base runner'))

  const delOpencodeNew = deleteMCPServer({ tool: 'opencode', scope: 'global', name: 'new-tool' }, options)
  assert.equal(delOpencodeNew.success, true)

  const contentAfterDelete = readFileSync(opencodePath, 'utf8')
  assert.ok(!contentAfterDelete.includes('new-tool'))
  assert.ok(contentAfterDelete.includes('// Global configuration header'))
  assert.ok(contentAfterDelete.includes('"tabSize": 2,'))
  assert.ok(contentAfterDelete.includes('"base-runner"'))

  // A malformed current server map must fail closed without changing bytes.
  const malformedOpenCode = JSON.stringify({ mcp: { servers: [] }, theme: 'keep' })
  writeFileSync(opencodePath, malformedOpenCode, 'utf8')
  const malformedOpenCodeRes = saveMCPServer(
    { tool: 'opencode', scope: 'global' },
    { name: 'should-not-write', transport: 'stdio', command: 'node' },
    options
  )
  assert.equal(malformedOpenCodeRes.success, false)
  assert.equal(readFileSync(opencodePath, 'utf8'), malformedOpenCode)

  // A non-server mcp option such as timeout must not be mistaken for a
  // legacy server when a new server reuses that name.
  const reservedOpenCode = JSON.stringify({ mcp: { timeout: { startup: 1000 } } })
  writeFileSync(opencodePath, reservedOpenCode, 'utf8')
  const reservedOpenCodeRes = saveMCPServer(
    { tool: 'opencode', scope: 'global' },
    { name: 'timeout', transport: 'stdio', command: 'node' },
    options
  )
  assert.equal(reservedOpenCodeRes.success, true)
  const reservedOpenCodeData = parseJsonc(readFileSync(opencodePath, 'utf8'))
  assert.deepEqual(reservedOpenCodeData.mcp.timeout, { startup: 1000 })
  assert.deepEqual(reservedOpenCodeData.mcp.servers.timeout.command, ['node'])

  writeFileSync(opencodePath, rawJsonc, 'utf8')
  console.log('PASS OpenCode Lossless JSONC Comments & Trailing Commas')

  // C4: Grok TOML Support (Stdio & Remote SSE/HTTP), Comments, and Enabled Toggle
  console.log('Test C4: Grok TOML Support, Remote SSE/HTTP & Lossless Comments...')
  const grokPath = resolveMCPConfigPath('grok', 'global', options)
  mkdirSync(path.dirname(grokPath), { recursive: true })
  const initialGrokToml = `# Grok AI Configuration
default_model = "grok-3"

[system]
sandbox = "strict" # security sandbox

[mcp_servers.search]
command = "grok-search"
args = ["--live"]
enabled = true
`
  writeFileSync(grokPath, initialGrokToml, 'utf8')

  const grokServers = readMCPServersForTool('grok', 'global', options)
  assert.equal(grokServers.length, 1)
  assert.equal(grokServers[0].name, 'search')
  assert.equal(grokServers[0].command, 'grok-search')
  assert.deepEqual(grokServers[0].args, ['--live'])
  assert.equal(grokServers[0].enabled, true)

  const grokTog = toggleMCPServer({ tool: 'grok', scope: 'global', name: 'search' }, false, options)
  assert.equal(grokTog.success, true)
  assert.equal(readMCPServersForTool('grok', 'global', options)[0].enabled, false)

  const grokContentAfterTog = readFileSync(grokPath, 'utf8')
  assert.ok(grokContentAfterTog.includes('# Grok AI Configuration'))
  assert.ok(grokContentAfterTog.includes('[system]'))
  assert.ok(grokContentAfterTog.includes('enabled = false'))

  const saveGrokRemote = saveMCPServer(
    { tool: 'grok', scope: 'global' },
    {
      name: 'grok-sse',
      transport: 'sse',
      url: 'https://api.x.ai/mcp/sse',
      headers: { Authorization: 'Bearer grok-key' },
    },
    options
  )
  assert.equal(saveGrokRemote.success, true)
  const grokRemoteDef = readMCPServersForTool('grok', 'global', options).find((s) => s.name === 'grok-sse')
  assert.equal(grokRemoteDef.transport, 'sse')
  assert.equal(grokRemoteDef.url, 'https://api.x.ai/mcp/sse')
  assert.deepEqual(grokRemoteDef.headers, { Authorization: 'Bearer grok-key' })
  console.log('PASS Grok TOML Support & Remote SSE/HTTP')

  // C5: Antigravity Protocol (Strict serverUrl, JSON mcpServers, In-Place disabled: true)
  console.log('Test C5: Antigravity Protocol (Strict serverUrl & disabled: true)...')
  const agyPath = resolveMCPConfigPath('antigravity', 'global', options)
  mkdirSync(path.dirname(agyPath), { recursive: true })

  const agyStdioRes = saveMCPServer(
    { tool: 'antigravity', scope: 'global' },
    {
      name: 'agy-stdio',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { ENV_VAR: '1' },
      cwd: '/var/app',
    },
    options
  )
  assert.equal(agyStdioRes.success, true)

  const agyHttpRes = saveMCPServer(
    { tool: 'antigravity', scope: 'global' },
    {
      name: 'agy-remote',
      transport: 'http',
      url: 'https://internal.corp/mcp',
      headers: { 'X-Auth': 'token' },
    },
    options
  )
  assert.equal(agyHttpRes.success, true)

  const agyRaw = JSON.parse(readFileSync(agyPath, 'utf8'))
  assert.equal(agyRaw.mcpServers['agy-stdio'].command, 'node')
  assert.deepEqual(agyRaw.mcpServers['agy-stdio'].args, ['server.js'])
  assert.deepEqual(agyRaw.mcpServers['agy-stdio'].env, { ENV_VAR: '1' })
  assert.equal(agyRaw.mcpServers['agy-stdio'].cwd, '/var/app')

  // Antigravity MUST use serverUrl, NEVER url or httpUrl
  assert.equal(agyRaw.mcpServers['agy-remote'].serverUrl, 'https://internal.corp/mcp')
  assert.equal(agyRaw.mcpServers['agy-remote'].url, undefined)
  assert.equal(agyRaw.mcpServers['agy-remote'].httpUrl, undefined)
  assert.equal(agyRaw.mcpServers['agy-remote'].transport, undefined)

  const agyServers = readMCPServersForTool('antigravity', 'global', options)
  const readAgyRemote = agyServers.find((s) => s.name === 'agy-remote')
  assert.equal(readAgyRemote.transport, 'http')
  assert.equal(readAgyRemote.url, 'https://internal.corp/mcp')
  assert.deepEqual(readAgyRemote.headers, { 'X-Auth': 'token' })

  // Toggle agy-stdio to disabled
  const agyTog = toggleMCPServer({ tool: 'antigravity', scope: 'global', name: 'agy-stdio' }, false, options)
  assert.equal(agyTog.success, true)
  assert.equal(readMCPServersForTool('antigravity', 'global', options).find((s) => s.name === 'agy-stdio').enabled, false)

  const agyRawAfterTog = JSON.parse(readFileSync(agyPath, 'utf8'))
  assert.equal(agyRawAfterTog.mcpServers['agy-stdio'].disabled, true)
  assert.equal(agyRawAfterTog.mcp, undefined, 'Antigravity must not write to Gemini mcp.excluded')

  // Toggle back to enabled
  const agyTogBack = toggleMCPServer({ tool: 'antigravity', scope: 'global', name: 'agy-stdio' }, true, options)
  assert.equal(agyTogBack.success, true)
  assert.equal(readMCPServersForTool('antigravity', 'global', options).find((s) => s.name === 'agy-stdio').enabled, true)
  const agyRawAfterTogBack = JSON.parse(readFileSync(agyPath, 'utf8'))
  assert.equal(agyRawAfterTogBack.mcpServers['agy-stdio'].disabled, undefined)
  console.log('PASS Antigravity Protocol')

  // C6: 7-Protocol Cross-Tool Preflight & Distribution
  console.log('Test C6: 7-Protocol Cross-Tool Preflight & Distribution...')
  const sseTargets = VALID_MCP_TOOLS.map((t) => ({ tool: t, scope: 'global' }))
  const ssePreflight = preflightMCPDistribution(
    { name: 'sse-check', transport: 'sse', url: 'https://sse.example.com' },
    sseTargets,
    options
  )
  assert.equal(ssePreflight.canDistribute, false)
  const codexPf = ssePreflight.targets.find((t) => t.tool === 'codex')
  assert.equal(codexPf.compatible, false)
  assert.ok(codexPf.reasons[0].includes('SSE'))

  const cursorPf = ssePreflight.targets.find((t) => t.tool === 'cursor')
  assert.equal(cursorPf.compatible, false)
  assert.ok(cursorPf.reasons[0].includes('SSE'))

  const allowedSseTools = ['claude-code', 'gemini', 'grok', 'antigravity']
  for (const tool of allowedSseTools) {
    const pf = ssePreflight.targets.find((t) => t.tool === tool)
    assert.equal(pf.compatible, true, `${tool} should support SSE`)
  }
  const opencodePf = ssePreflight.targets.find((t) => t.tool === 'opencode')
  assert.equal(opencodePf.compatible, false)
  assert.ok(opencodePf.reasons[0].includes('SSE'))

  // Distribute HTTP across all 7 tools
  const httpSource = {
    name: 'universal-service',
    transport: 'http',
    url: 'https://universal.api/mcp',
    headers: { 'X-Common': 'all' },
    enabled: true,
  }
  const httpTargets = VALID_MCP_TOOLS.map((t) => ({ tool: t, scope: 'global' }))
  const httpPf = preflightMCPDistribution(httpSource, httpTargets, options)
  assert.equal(httpPf.canDistribute, true)

  const httpDist = distributeMCPServer(
    httpSource,
    httpPf.targets.map((t) => ({ tool: t.tool, scope: t.scope, expectedRevision: t.currentRevision })),
    options
  )
  assert.equal(httpDist.overallSuccess, true)
  assert.equal(httpDist.results.length, 7)
  assert.ok(httpDist.results.every((r) => r.success))

  // Assert all 7 tool files
  assert.equal(
    JSON.parse(readFileSync(resolveMCPConfigPath('claude-code', 'global', options), 'utf8')).mcpServers['universal-service'].url,
    'https://universal.api/mcp'
  )
  assert.equal(
    JSON.parse(readFileSync(resolveMCPConfigPath('cursor', 'global', options), 'utf8')).mcpServers['universal-service'].url,
    'https://universal.api/mcp'
  )
  assert.equal(
    JSON.parse(readFileSync(resolveMCPConfigPath('gemini', 'global', options), 'utf8')).mcpServers['universal-service'].httpUrl,
    'https://universal.api/mcp'
  )
  assert.equal(
    parseToml(readFileSync(resolveMCPConfigPath('codex', 'global', options), 'utf8')).mcp_servers['universal-service'].url,
    'https://universal.api/mcp'
  )
  assert.equal(
    parseJsonc(readFileSync(resolveMCPConfigPath('opencode', 'global', options), 'utf8')).mcp.servers['universal-service'].url,
    'https://universal.api/mcp'
  )
  assert.equal(
    parseToml(readFileSync(resolveMCPConfigPath('grok', 'global', options), 'utf8')).mcp_servers['universal-service'].url,
    'https://universal.api/mcp'
  )
  assert.equal(
    JSON.parse(readFileSync(resolveMCPConfigPath('antigravity', 'global', options), 'utf8')).mcpServers['universal-service'].serverUrl,
    'https://universal.api/mcp'
  )

  // Project-specific target paths must also be used for the optimistic
  // revision check; this differs from the default workspace on purpose.
  const projectB = path.join(testRoot, 'project-b')
  mkdirSync(projectB, { recursive: true })
  const projectTarget = [{ tool: 'opencode', scope: 'project', projectWorkspace: projectB }]
  const projectSource = { name: 'project-service', transport: 'stdio', command: 'node', args: ['server.js'] }
  const projectPf = preflightMCPDistribution(projectSource, projectTarget, options)
  assert.equal(projectPf.canDistribute, true)
  const projectDist = distributeMCPServer(
    projectSource,
    projectPf.targets.map((t) => ({
      tool: t.tool,
      scope: t.scope,
      projectWorkspace: t.projectWorkspace,
      expectedRevision: t.currentRevision,
    })),
    options
  )
  assert.equal(projectDist.overallSuccess, true)
  assert.deepEqual(
    parseJsonc(readFileSync(resolveMCPConfigPath('opencode', 'project', { ...options, projectWorkspace: projectB }), 'utf8')).mcp.servers['project-service'].command,
    ['node', 'server.js']
  )

  const snapshot = await exportMCPProfileSnapshot(options)
  for (const t of VALID_MCP_TOOLS) {
    assert.ok(Array.isArray(snapshot.global[t]), `Snapshot global should have array for ${t}`)
    assert.ok(Array.isArray(snapshot.project[t]), `Snapshot project should have array for ${t}`)
  }
  console.log('PASS 7-Protocol Cross-Tool Preflight & Distribution')

  // C7: Central MCP Source Assets & Target Injection (OPC-56) with 7 Tools
  console.log('Test C7: Central MCP Source Assets & Target Injection with 7 Tools...')
  const centralServers = await readCentralMCPServers(options)
  assert.ok(centralServers.some((s) => s.name === 'universal-service'))

  const saveCentralRes = saveCentralMCPServer(
    {
      name: 'central-master',
      transport: 'stdio',
      command: 'echo',
      args: ['v1'],
    },
    options
  )
  assert.equal(saveCentralRes.success, true)

  const injGrok = injectMCPServerToTarget('central-master', { tool: 'grok', scope: 'global' }, options)
  assert.equal(injGrok.success, true)
  const injOpenCode = injectMCPServerToTarget('central-master', { tool: 'opencode', scope: 'project' }, options)
  assert.equal(injOpenCode.success, true)
  const injAgy = injectMCPServerToTarget('central-master', { tool: 'antigravity', scope: 'global' }, options)
  assert.equal(injAgy.success, true)

  assert.ok(parseToml(readFileSync(resolveMCPConfigPath('grok', 'global', options), 'utf8')).mcp_servers['central-master'])
  assert.ok(parseJsonc(readFileSync(resolveMCPConfigPath('opencode', 'project', options), 'utf8')).mcp.servers['central-master'])
  assert.ok(JSON.parse(readFileSync(resolveMCPConfigPath('antigravity', 'global', options), 'utf8')).mcpServers['central-master'])

  // Update central server and verify automatic sync to all 3 targets
  const updateCentralRes = saveCentralMCPServer(
    {
      name: 'central-master',
      transport: 'stdio',
      command: 'echo',
      args: ['v2-updated'],
    },
    options
  )
  assert.equal(updateCentralRes.success, true)
  assert.equal(updateCentralRes.syncResults?.length, 3)
  assert.ok(updateCentralRes.syncResults.every((sr) => sr.success))

  assert.deepEqual(
    parseToml(readFileSync(resolveMCPConfigPath('grok', 'global', options), 'utf8')).mcp_servers['central-master'].args,
    ['v2-updated']
  )
  assert.deepEqual(
    parseJsonc(readFileSync(resolveMCPConfigPath('opencode', 'project', options), 'utf8')).mcp.servers['central-master'].command,
    ['echo', 'v2-updated']
  )
  assert.deepEqual(
    JSON.parse(readFileSync(resolveMCPConfigPath('antigravity', 'global', options), 'utf8')).mcpServers['central-master'].args,
    ['v2-updated']
  )

  // Uninject from Grok
  const uninjGrok = uninjectMCPServerFromTarget('central-master', { tool: 'grok', scope: 'global' }, options)
  assert.equal(uninjGrok.success, true)
  assert.equal(parseToml(readFileSync(resolveMCPConfigPath('grok', 'global', options), 'utf8')).mcp_servers?.['central-master'], undefined)

  const stillInCentral = (await readCentralMCPServers(options)).find((s) => s.name === 'central-master')
  assert.ok(stillInCentral)
  assert.ok(JSON.parse(readFileSync(resolveMCPConfigPath('antigravity', 'global', options), 'utf8')).mcpServers['central-master'])

  // Delete central server completely
  const delCentralRes = deleteCentralMCPServer('central-master', options)
  assert.equal(delCentralRes.success, true)
  assert.equal((await readCentralMCPServers(options)).find((s) => s.name === 'central-master'), undefined)
  assert.equal(JSON.parse(readFileSync(resolveMCPConfigPath('antigravity', 'global', options), 'utf8')).mcpServers?.['central-master'], undefined)
  assert.equal(parseJsonc(readFileSync(resolveMCPConfigPath('opencode', 'project', options), 'utf8')).mcp?.servers?.['central-master'], undefined)
  console.log('PASS Central MCP Source Assets & Target Injection')

  // C8: Concurrency & Revision Conflict Guard across New Tools
  console.log('Test C8: Concurrency Guard Across OpenCode, Grok, and Antigravity...')
  for (const tool of ['opencode', 'grok', 'antigravity']) {
    const revBefore = computeServerRevision(tool, 'global', 'universal-service', options)
    assert.ok(revBefore)
    const configPath = resolveMCPConfigPath(tool, 'global', options)
    const current = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, current + '\n# external edit\n', 'utf8')

    const staleSave = saveMCPServer(
      { tool, scope: 'global', expectedRevision: revBefore },
      { name: 'universal-service', transport: 'http', url: 'https://new.url' },
      options
    )
    assert.equal(staleSave.success, false)
    assert.ok(staleSave.error?.includes('Revision conflict'))
  }
  console.log('PASS Concurrency Guard across New Tools')

  // C9: Transaction Rollback on Failure across New Tools
  console.log('Test C9: Transaction Rollback on Failure across OpenCode, Grok, and Antigravity...')
  for (const tool of ['opencode', 'grok', 'antigravity']) {
    const configPath = resolveMCPConfigPath(tool, 'global', options)
    const originalBytes = readFileSync(configPath, 'utf8')
    const failedSave = saveMCPServer(
      { tool, scope: 'global' },
      { name: 'rollback-test', transport: 'stdio', command: 'should-fail' },
      {
        ...options,
        beforeSecondWriteHook: () => {
          throw new Error('Simulated atomic write failure')
        },
      }
    )
    assert.equal(failedSave.success, false)
    assert.equal(readFileSync(configPath, 'utf8'), originalBytes, `${tool} must rollback completely on error`)
  }
  console.log('PASS Transaction Rollback across New Tools')

  console.log('\n=============================================')
  console.log('ALL MCP MANAGEMENT VERIFICATION CHECKS PASSED!')
  console.log('=============================================\n')
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}
