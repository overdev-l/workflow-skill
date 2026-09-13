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
  computeServerRevision,
  deleteMCPServer,
  distributeMCPServer,
  getDisabledRegistryPath,
  preflightMCPDistribution,
  readAllMCPServers,
  readMCPServersForTool,
  resolveMCPConfigPath,
  saveMCPServer,
  toggleMCPServer,
  validateServerName,
} from '../apps/desktop/electron/mcp-manager.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRequire = createRequire(path.join(__dirname, '../apps/desktop/package.json'))
const { parse: parseToml } = desktopRequire('smol-toml')
const { parseTOML } = desktopRequire('toml-eslint-parser')

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

  console.log('\n=============================================')
  console.log('ALL MCP MANAGEMENT VERIFICATION CHECKS PASSED!')
  console.log('=============================================\n')
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}
