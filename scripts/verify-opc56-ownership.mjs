import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  adoptMCPServer,
  computeMCPTargetHash,
  uninjectMCPServerFromTarget,
  readCentralMCPServers,
  readMCPServersForTool,
  saveCentralMCPServer,
  resolveMCPConfigPath,
} from '../apps/desktop/electron/mcp-manager.ts'
import {
  adoptSkillAsset,
  discoverAllGlobalSkills,
  disconnectSkillTarget,
} from '../apps/desktop/electron/skill-injection-manager.ts'
import { discoverProjectSkills } from '../apps/desktop/electron/project-skill-discovery.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-opc56-ownership-'))
const homeDir = path.join(root, 'home')
const traceHome = path.join(root, 'trace')
const projectPath = path.join(root, 'project')

const write = (filePath, content) => {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

try {
  console.log('=== Trace OPC-56 Ownership & Adoption Verification ===')

  // External global Skill is discovered without being silently imported.
  const globalSkillPath = path.join(homeDir, '.claude', 'skills', 'external-skill')
  write(path.join(globalSkillPath, 'SKILL.md'), `---\nname: External Skill\ndescription: discovered outside Trace\n---\n\n# External Skill\n`)
  const discoveredGlobal = discoverAllGlobalSkills({ homeDir, traceHome })
  const externalGlobal = discoveredGlobal.find((skill) => skill.name === 'External Skill')
  assert.equal(externalGlobal?.ownership, 'external')
  assert.equal(externalGlobal?.scopeStatus, '外部持有')
  assert.equal(existsSync(path.join(traceHome, 'skills', 'external-skill.json')), false)

  const adoptedGlobal = adoptSkillAsset(
    { type: 'global', toolId: 'claude-global', skillId: 'external-skill' },
    { homeDir, traceHome },
  )
  assert.equal(adoptedGlobal.success, true, adoptedGlobal.error)
  assert.equal(adoptedGlobal.skill?.ownership, 'app')
  assert.equal(lstatSync(globalSkillPath).isSymbolicLink(), true)
  assert.equal(existsSync(path.join(traceHome, 'skills', 'external-skill', 'SKILL.md')), true)

  const afterGlobalAdoption = discoverAllGlobalSkills({ homeDir, traceHome })
  const managedGlobal = afterGlobalAdoption.find((skill) => skill.id === 'external-skill')
  assert.equal(managedGlobal?.ownership, 'app')
  assert.equal(managedGlobal?.scopeStatus, '全局软链')
  assert.ok(managedGlobal?.targetBindings?.some((binding) => binding.status === 'linked'))

  const globalDisconnect = disconnectSkillTarget(
    'external-skill',
    { scope: 'global', targetId: 'claude-global' },
    { homeDir, traceHome },
  )
  assert.equal(globalDisconnect.success, true, globalDisconnect.error)
  assert.equal(existsSync(globalSkillPath), false)
  assert.equal(existsSync(path.join(traceHome, 'skills', 'external-skill', 'SKILL.md')), true)

  // Project Skill adoption also replaces the physical directory with a link.
  const projectSkillPath = path.join(projectPath, '.cursor', 'skills', 'project-skill')
  write(path.join(projectSkillPath, 'SKILL.md'), '# Project Skill\n\nproject-owned\n')
  const discoveredProject = discoverProjectSkills(projectPath, traceHome)
  assert.equal(discoveredProject.skills[0]?.ownership, 'external')
  const adoptedProject = adoptSkillAsset(
    { type: 'project', toolId: 'cursor', projectPath, relPath: '.cursor/skills', skillId: 'project-skill' },
    { homeDir, traceHome },
  )
  assert.equal(adoptedProject.success, true, adoptedProject.error)
  assert.equal(lstatSync(projectSkillPath).isSymbolicLink(), true)
  const projectDisconnect = disconnectSkillTarget(
    adoptedProject.skill.id,
    { scope: 'project', projectPath, relPath: '.cursor/skills' },
    { homeDir, traceHome },
  )
  assert.equal(projectDisconnect.success, true, projectDisconnect.error)
  assert.equal(existsSync(projectSkillPath), false)
  assert.equal(existsSync(path.join(traceHome, 'skills', adoptedProject.skill.id, 'SKILL.md')), true)

  // External MCP is read-only until adoption; adoption keeps the native config
  // untouched, then disconnect removes only the managed entry.
  const mcpConfigPath = resolveMCPConfigPath('cursor', 'global', { homeDir, traceHome })
  write(mcpConfigPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    external: { command: 'node', args: ['server.js'], customField: 'preserve-me' },
  } }, null, 2))
  const externalMcp = (await readCentralMCPServers({ homeDir, traceHome })).find((server) => server.id === 'external:cursor:global:external')
  assert.equal(externalMcp?.ownership, 'external')
  const adoptedMcp = adoptMCPServer(
    { tool: 'cursor', scope: 'global', name: 'external' },
    { homeDir, traceHome },
  )
  assert.equal(adoptedMcp.success, true, adoptedMcp.error)
  const untouchedConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
  assert.equal(untouchedConfig.unrelated.keep, true)
  assert.equal(untouchedConfig.mcpServers.external.customField, 'preserve-me')

  const managedMcp = (await readCentralMCPServers({ homeDir, traceHome })).find((server) => server.id === adoptedMcp.server.id)
  assert.equal(managedMcp?.ownership, 'app')
  assert.equal(managedMcp?.targetAssociations?.length, 1)
  assert.equal(managedMcp?.targetAssociations?.[0].targetHash, computeMCPTargetHash(readMCPServersForTool('cursor', 'global', { homeDir, traceHome })[0]))

  // An external edit is surfaced as a conflict and cannot be overwritten by a
  // later central save.
  write(mcpConfigPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    external: { command: 'node', args: ['changed.js'], customField: 'external-edit' },
  } }, null, 2))
  const centralBeforeConflict = (await readCentralMCPServers({ homeDir, traceHome })).find((server) => server.id === adoptedMcp.server.id)
  const conflictSave = saveCentralMCPServer({ ...centralBeforeConflict, command: 'node', args: ['central-edit.js'] }, { homeDir, traceHome })
  assert.equal(conflictSave.success, true)
  assert.equal(conflictSave.syncResults?.some((result) => result.success === false), true)
  assert.deepEqual(readMCPServersForTool('cursor', 'global', { homeDir, traceHome })[0].args, ['changed.js'])

  const mcpDisconnect = uninjectMCPServerFromTarget(
    adoptedMcp.server.id,
    { tool: 'cursor', scope: 'global' },
    { homeDir, traceHome },
  )
  assert.equal(mcpDisconnect.success, false, 'conflicted target must not be deleted silently')

  // Resolve the conflict by restoring the last managed target snapshot, then
  // disconnect while retaining central source.
  write(mcpConfigPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    external: { command: 'node', args: ['server.js'], customField: 'preserve-me' },
  } }, null, 2))
  const resolvedDisconnect = uninjectMCPServerFromTarget(
    adoptedMcp.server.id,
    { tool: 'cursor', scope: 'global' },
    { homeDir, traceHome },
  )
  assert.equal(resolvedDisconnect.success, true, resolvedDisconnect.error)
  assert.equal(readMCPServersForTool('cursor', 'global', { homeDir, traceHome }).some((server) => server.name === 'external'), false)
  assert.equal(existsSync(path.join(traceHome, 'mcp-central.json')), true)

  console.log('PASS ownership badges data, explicit Skill/MCP adoption, conflict guard, rollback-safe disconnect')
} finally {
  rmSync(root, { recursive: true, force: true })
}
