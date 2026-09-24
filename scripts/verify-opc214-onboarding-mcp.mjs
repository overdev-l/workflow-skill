import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  scanGlobalMcpCandidates,
  scanProjectMcpCandidates,
  migrateMcpCandidates,
  extractSecretFieldPaths,
  MCP_SECRET_KEY_REGEX,
} from '../apps/desktop/electron/onboarding-manager.ts'

import {
  storeMcpSecret,
  readMcpSecret,
  deleteMcpSecret,
  isKeychainAvailable,
  formatMcpKeychainAccount,
  setMcpKeychainBackend,
  setMcpSpawnRunner,
} from '../apps/desktop/electron/mcp-secret-store.ts'

import {
  getCentralMCPRegistryPath,
  loadCentralMCPRegistry,
} from '../apps/desktop/electron/mcp-manager.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-opc214-mcp-verify-'))
const homeDir = path.join(root, 'home')
const traceHome = path.join(root, 'trace')
const projectPath = path.join(root, 'project')

const write = (filePath, content) => {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

// In-memory mock keychain store
class MockKeychainBackend {
  constructor(available = true) {
    this.available = available
    this.storeMap = new Map()
    this.history = []
  }

  isAvailable() {
    return this.available
  }

  store(account, plaintext) {
    if (!this.available) {
      throw new Error('macOS Keychain service unavailable (mock)')
    }
    this.history.push({ action: 'store', account, plaintext })
    this.storeMap.set(account, plaintext)
  }

  read(account) {
    if (!this.available) {
      return undefined
    }
    this.history.push({ action: 'read', account })
    return this.storeMap.get(account)
  }

  delete(account) {
    this.history.push({ action: 'delete', account })
    this.storeMap.delete(account)
  }
}

try {
  console.log('=== Trace OPC-214 Onboarding MCP Scanning, Keychain & Migration Verification ===')

  const options = { homeDir, traceHome }

  // -------------------------------------------------------------------------
  // Test 1: Credential Identification Rules & Unit Tests
  // -------------------------------------------------------------------------
  console.log('--- Test 1: Secret Key Pattern & Field Path Extraction ---')

  assert.ok(MCP_SECRET_KEY_REGEX.test('OPENAI_API_KEY'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('apiKey'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('GITHUB_TOKEN'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('authToken'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('CLIENT_SECRET'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('DB_PASSWORD'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('aws_credentials'))
  assert.ok(MCP_SECRET_KEY_REGEX.test('Authorization'))
  assert.ok(!MCP_SECRET_KEY_REGEX.test('PORT'))
  assert.ok(!MCP_SECRET_KEY_REGEX.test('NODE_ENV'))
  assert.ok(!MCP_SECRET_KEY_REGEX.test('DEBUG'))
  assert.ok(!MCP_SECRET_KEY_REGEX.test('DATABASE_HOST'))

  const sampleServer = {
    env: {
      API_KEY: 'secret1',
      PORT: '3000',
      GITHUB_TOKEN: 'secret2',
    },
    headers: {
      Authorization: 'Bearer secret3',
      'Content-Type': 'application/json',
    },
    envHeaders: {
      X_API_SECRET: 'secret4',
    },
    url: 'https://example.com/mcp?token=secret5&filter=all',
  }

  const extractedPaths = extractSecretFieldPaths(sampleServer)
  assert.deepEqual(extractedPaths, [
    'env.API_KEY',
    'env.GITHUB_TOKEN',
    'envHeaders.X_API_SECRET',
    'headers.Authorization',
    'url.token',
  ])
  console.log('PASS Test 1: Secret field paths correctly extracted')

  // -------------------------------------------------------------------------
  // Test 2: mcp-secret-store Keychain Store & Fallback Behavior
  // -------------------------------------------------------------------------
  console.log('--- Test 2: mcp-secret-store Keychain Storage & Non-degradation ---')

  const mockBackend = new MockKeychainBackend(true)
  setMcpKeychainBackend(mockBackend)

  const accountName = formatMcpKeychainAccount('srv-1', 'env.API_KEY')
  assert.equal(accountName, 'trace:mcp:srv-1:env.API_KEY')

  // Normal store
  const secretRef = storeMcpSecret('srv-1', 'env.API_KEY', 'my-super-secret-pw')
  assert.equal(secretRef.location, 'keychain')
  assert.equal(secretRef.keychainAccount, 'trace:mcp:srv-1:env.API_KEY')
  assert.equal(secretRef.value, undefined, 'Plaintext value must not be present in keychain ref')

  // Normal read
  const retrieved = readMcpSecret(secretRef)
  assert.equal(retrieved, 'my-super-secret-pw')

  // Delete
  deleteMcpSecret(secretRef)
  assert.equal(readMcpSecret(secretRef), undefined)

  // Explicit failure when Keychain unavailable (MUST NOT silently degrade to plaintext)
  const unavailableBackend = new MockKeychainBackend(false)
  setMcpKeychainBackend(unavailableBackend)

  assert.throws(
    () => storeMcpSecret('srv-fail', 'env.TOKEN', 'plaintext-secret'),
    /Keychain is not available/i,
    'Store must throw explicit error when Keychain is unavailable'
  )
  console.log('PASS Test 2: mcp-secret-store stores, reads, and rejects unavailable without plaintext degradation')

  // -------------------------------------------------------------------------
  // Test 2b: Default Backend Zero-Plaintext in Spawn Argv Verification
  // -------------------------------------------------------------------------
  console.log('--- Test 2b: defaultBackend store MUST NOT leak plaintext secret in child process argv ---')
  setMcpKeychainBackend(null) // activate defaultBackend
  let recordedSpawn = null
  setMcpSpawnRunner((cmd, args, opts) => {
    recordedSpawn = { cmd, args, opts }
    return { status: 0, stdout: '', stderr: '' }
  })

  const sensitiveSecret = 'top-secret-password-xyz-12345'
  storeMcpSecret('srv-security-check', 'env.API_KEY', sensitiveSecret)

  assert.ok(recordedSpawn, 'defaultBackend must call spawn runner')
  assert.equal(recordedSpawn.cmd, '/usr/bin/security')
  assert.ok(
    !recordedSpawn.args.includes(sensitiveSecret),
    'Plaintext secret must not be an element of child process argv'
  )
  assert.ok(
    !recordedSpawn.args.some((arg) => typeof arg === 'string' && arg.includes(sensitiveSecret)),
    'Plaintext secret must not appear inside any child process argv argument'
  )
  assert.ok(
    recordedSpawn.opts?.input && !recordedSpawn.args.includes('-w'),
    'Secret must be passed via stdin input rather than argv -w'
  )
  setMcpSpawnRunner(null)
  console.log('PASS Test 2b: defaultBackend securely transmits secret via stdin without argv leakage')

  // -------------------------------------------------------------------------
  // Test 2c: Rejection of newlines/control characters in account without spawn calls
  // -------------------------------------------------------------------------
  console.log('--- Test 2c: Account with newline rejected before child process spawn ---')
  setMcpKeychainBackend(null) // activate defaultBackend
  let spawnCalls = 0
  setMcpSpawnRunner((cmd, args, opts) => {
    spawnCalls++
    return { status: 0, stdout: '', stderr: '' }
  })

  assert.throws(
    () => storeMcpSecret('srv\ninjection', 'env.API_KEY', 'my-secret'),
    /control character|newline/i,
    'storeMcpSecret must throw error when account contains newline'
  )
  assert.equal(spawnCalls, 0, 'No spawn call must occur when account contains newline')

  assert.throws(
    () => storeMcpSecret('srv-normal', 'env.KEY\rwith\rCR', 'my-secret'),
    /control character|newline/i,
    'storeMcpSecret must throw error when account contains carriage return'
  )
  assert.equal(spawnCalls, 0, 'No spawn call must occur when account contains carriage return')

  setMcpSpawnRunner(null)
  console.log('PASS Test 2c: Account with newline rejected before any spawn call')

  // Restore working mock backend for migration tests
  const testBackend = new MockKeychainBackend(true)
  setMcpKeychainBackend(testBackend)

  // -------------------------------------------------------------------------
  // Test 3: Setup Multi-Tool Mock Configs & Candidate Scanning
  // -------------------------------------------------------------------------
  console.log('--- Test 3: Global MCP Candidate Scanning & Deduplication ---')

  // Tool 1: Claude Code (~/.claude.json)
  write(
    path.join(homeDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'shared-service': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: {
            API_KEY: 'claude-secret-123',
            DEBUG: '1',
          },
        },
        'claude-only': {
          command: 'uvx',
          args: ['mcp-server-git'],
          env: {
            GITHUB_TOKEN: 'ghp-secret-456',
          },
        },
      },
    }, null, 2)
  )

  // Tool 2: Cursor (~/.cursor/mcp.json)
  // Contains duplicate 'shared-service' with SAME transport (stdio)
  // and remote server 'cursor-remote'
  write(
    path.join(homeDir, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'shared-service': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: {
            API_KEY: 'cursor-duplicate-token',
          },
        },
        'cursor-remote': {
          url: 'https://api.cursor.com/sse?token=cursor-query-token',
        },
      },
    }, null, 2)
  )

  // Tool 3: Codex (~/.codex/config.toml)
  write(
    path.join(homeDir, '.codex', 'config.toml'),
    `
[mcp_servers.codex-tool]
command = "python"
args = ["-m", "codex_mcp"]

[mcp_servers.codex-tool.env]
CODEX_SECRET = "codex-secret-789"
NORMAL_VAR = "hello"
`
  )

  // Pre-seed central library with an already-managed server
  write(
    path.join(traceHome, 'mcp-central.json'),
    JSON.stringify({
      'pre-managed-server': {
        id: 'pre-managed-server',
        name: 'pre-managed-server',
        transport: 'stdio',
        command: 'echo',
        enabled: true,
        ownership: 'app',
      },
    }, null, 2)
  )

  // Tool 4: Grok (~/.grok/config.toml) with pre-managed-server
  write(
    path.join(homeDir, '.grok', 'config.toml'),
    `
[mcp_servers.pre-managed-server]
command = "echo"
`
  )

  // Execute scanGlobalMcpCandidates
  const candidates = scanGlobalMcpCandidates(options)
  console.log('Discovered candidates:', candidates.map((c) => ({
    name: c.serverName,
    tool: c.sourceToolId,
    transport: c.transport,
    secrets: c.secretFieldPaths,
    alreadyManaged: c.alreadyManaged,
  })))

  // Assert deduplication: 'shared-service' appeared in both claude-code and cursor, must appear only ONCE
  const sharedCandidates = candidates.filter((c) => c.serverName === 'shared-service')
  assert.equal(sharedCandidates.length, 1, 'Duplicate shared-service must be deduplicated into 1 candidate')
  assert.equal(sharedCandidates[0].sourceToolId, 'claude-code', 'First source tool must be recorded')
  assert.equal(sharedCandidates[0].hasSecrets, true)
  assert.ok(sharedCandidates[0].secretFieldPaths.includes('env.API_KEY'))
  assert.equal(sharedCandidates[0].alreadyManaged, false)

  // Assert claude-only
  const claudeOnly = candidates.find((c) => c.serverName === 'claude-only')
  assert.ok(claudeOnly)
  assert.equal(claudeOnly.sourceToolId, 'claude-code')
  assert.deepEqual(claudeOnly.secretFieldPaths, ['env.GITHUB_TOKEN'])
  assert.equal(claudeOnly.alreadyManaged, false)

  // Assert cursor-remote
  const cursorRemote = candidates.find((c) => c.serverName === 'cursor-remote')
  assert.ok(cursorRemote)
  assert.equal(cursorRemote.sourceToolId, 'cursor')
  assert.ok(cursorRemote.secretFieldPaths.includes('url.token'))
  assert.equal(cursorRemote.alreadyManaged, false)

  // Assert codex-tool
  const codexTool = candidates.find((c) => c.serverName === 'codex-tool')
  assert.ok(codexTool)
  assert.equal(codexTool.sourceToolId, 'codex')
  assert.deepEqual(codexTool.secretFieldPaths, ['env.CODEX_SECRET'])
  assert.equal(codexTool.alreadyManaged, false)

  // Assert pre-managed-server flagged as alreadyManaged
  const preManaged = candidates.find((c) => c.serverName === 'pre-managed-server')
  assert.ok(preManaged)
  assert.equal(preManaged.alreadyManaged, true, 'Pre-existing server in mcp-central.json must have alreadyManaged=true')

  console.log('PASS Test 3: scanGlobalMcpCandidates aggregation, deduplication, and credential detection verified')

  // -------------------------------------------------------------------------
  // Test 4: Project MCP Candidate Scanning
  // -------------------------------------------------------------------------
  console.log('--- Test 4: Project MCP Candidate Scanning ---')

  write(
    path.join(projectPath, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'project-local-mcp': {
          command: 'node',
          args: ['./mcp-server.js'],
          env: {
            PROJECT_API_KEY: 'proj-secret-key',
          },
        },
      },
    }, null, 2)
  )

  const projectCandidates = scanProjectMcpCandidates(projectPath, options)
  assert.equal(projectCandidates.length, 1)
  assert.equal(projectCandidates[0].serverName, 'project-local-mcp')
  assert.equal(projectCandidates[0].sourceToolId, 'claude-code')
  assert.deepEqual(projectCandidates[0].secretFieldPaths, ['env.PROJECT_API_KEY'])
  assert.equal(projectCandidates[0].alreadyManaged, false)

  // Non-existent project path returns empty array safely
  const emptyProjectCandidates = scanProjectMcpCandidates(path.join(root, 'non-existent'), options)
  assert.deepEqual(emptyProjectCandidates, [])

  console.log('PASS Test 4: scanProjectMcpCandidates verified')

  // -------------------------------------------------------------------------
  // Test 5: Candidate Migration to Central Registry & Zero-Plaintext Assertion
  // -------------------------------------------------------------------------
  console.log('--- Test 5: migrateMcpCandidates with Keychain Storage & Zero Plaintext in JSON ---')

  const migrationResults = await migrateMcpCandidates(
    ['shared-service', 'claude-only', 'cursor-remote', 'pre-managed-server'],
    options
  )

  console.log('Migration results:', migrationResults)
  assert.equal(migrationResults.length, 4)

  // pre-managed-server must be skipped and ok=true
  const resPre = migrationResults.find((r) => r.serverId === 'pre-managed-server')
  assert.ok(resPre)
  assert.equal(resPre.ok, true)
  assert.equal(resPre.secretsStored, 0)

  // shared-service must succeed
  const resShared = migrationResults.find((r) => r.serverId === 'shared-service')
  assert.ok(resShared)
  assert.equal(resShared.ok, true, resShared.error)
  assert.equal(resShared.secretsStored, 1)

  // claude-only must succeed
  const resClaude = migrationResults.find((r) => r.serverId === 'claude-only')
  assert.ok(resClaude)
  assert.equal(resClaude.ok, true, resClaude.error)
  assert.equal(resClaude.secretsStored, 1)

  // cursor-remote must succeed
  const resCursor = migrationResults.find((r) => r.serverId === 'cursor-remote')
  assert.ok(resCursor)
  assert.equal(resCursor.ok, true, resCursor.error)
  assert.equal(resCursor.secretsStored, 1)

  // Verify Central Library JSON contents
  const centralJsonPath = path.join(traceHome, 'mcp-central.json')
  const centralJsonContent = readFileSync(centralJsonPath, 'utf8')
  const parsedCentral = JSON.parse(centralJsonContent)

  console.log('Verifying zero plaintext secrets in central JSON...')
  // ABSOLUTE ASSERTIONS: Central JSON must NEVER contain plaintext secrets!
  assert.ok(!centralJsonContent.includes('claude-secret-123'), 'Plaintext claude-secret-123 leaked into central JSON!')
  assert.ok(!centralJsonContent.includes('cursor-duplicate-token'), 'Plaintext cursor-duplicate-token leaked into central JSON!')
  assert.ok(!centralJsonContent.includes('ghp-secret-456'), 'Plaintext ghp-secret-456 leaked into central JSON!')
  assert.ok(!centralJsonContent.includes('cursor-query-token'), 'Plaintext cursor-query-token leaked into central JSON!')

  // Check secretRefs in parsed central records
  const centralShared = parsedCentral['shared-service']
  assert.ok(centralShared)
  assert.equal(centralShared.ownership, 'app')
  assert.equal(centralShared.env?.API_KEY, undefined, 'API_KEY must be removed from plaintext env')
  assert.equal(centralShared.env?.DEBUG, '1', 'Non-sensitive env DEBUG must be retained')
  assert.ok(centralShared.secretRefs)
  assert.equal(centralShared.secretRefs['env.API_KEY']?.location, 'keychain')
  assert.equal(centralShared.secretRefs['env.API_KEY']?.keychainAccount, 'trace:mcp:shared-service:env.API_KEY')

  // Verify that secrets can be read back from the Keychain
  const restoredSharedSecret = readMcpSecret(centralShared.secretRefs['env.API_KEY'])
  assert.equal(restoredSharedSecret, 'claude-secret-123')

  // Check cursor-remote url sanitized
  const centralCursor = parsedCentral['cursor-remote']
  assert.ok(centralCursor)
  assert.ok(!centralCursor.url.includes('cursor-query-token'), 'URL query secret leaked into central url field')
  assert.ok(centralCursor.secretRefs?.['url.token'])
  const restoredCursorToken = readMcpSecret(centralCursor.secretRefs['url.token'])
  assert.equal(restoredCursorToken, 'cursor-query-token')

  console.log('PASS Test 5: All secrets safely stored in Keychain, central JSON has zero plaintext')

  // -------------------------------------------------------------------------
  // Test 6: Failure Isolation & Keychain Unavailability Safety
  // -------------------------------------------------------------------------
  console.log('--- Test 6: Keychain Failure Safety & No Half-Plaintext Records ---')

  // Introduce a broken Keychain backend
  const brokenBackend = new MockKeychainBackend(false)
  setMcpKeychainBackend(brokenBackend)

  // Try migrating codex-tool while Keychain is broken
  const brokenMigration = await migrateMcpCandidates(['codex-tool'], options)
  assert.equal(brokenMigration.length, 1)
  assert.equal(brokenMigration[0].ok, false, 'Must report ok=false when Keychain fails')
  assert.ok(brokenMigration[0].error, 'Must provide error message')

  // Verify that codex-tool was NOT written to mcp-central.json
  const centralAfterFailure = JSON.parse(readFileSync(centralJsonPath, 'utf8'))
  assert.equal(centralAfterFailure['codex-tool'], undefined, 'Failed server must NOT be written as half-plaintext record')

  console.log('PASS Test 6: Failure isolation and atomic rollback on Keychain failure verified')

  console.log('=== All OPC-214 Onboarding MCP Verification Checks Passed Successfully! ===')
} finally {
  // Reset store backend
  setMcpKeychainBackend(null)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}
