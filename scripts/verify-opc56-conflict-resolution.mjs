import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  adoptMCPServer,
  injectMCPServerToTarget,
  readCentralMCPServers,
  readMCPServersForTool,
  resolveMCPConfigPath,
  resolveMCPConflict,
} from '../apps/desktop/electron/mcp-manager.ts'
import {
  discoverAllGlobalSkills,
  injectSkillToTarget,
  resolveSkillConflict,
} from '../apps/desktop/electron/skill-injection-manager.ts'
import { discoverProjectSkills } from '../apps/desktop/electron/project-skill-discovery.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-opc56-conflict-'))
const homeDir = path.join(root, 'home')
const traceHome = path.join(root, 'trace')
const options = { homeDir, traceHome }

const write = (filePath, content) => {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

const skillPath = path.join(homeDir, '.claude', 'skills', 'conflict-skill')
const centralSkillPath = path.join(traceHome, 'skills', 'conflict-skill')
const skillJsonPath = path.join(traceHome, 'skills', 'conflict-skill.json')
const skillRecord = {
  id: 'conflict-skill',
  name: 'Conflict Skill',
  description: 'central source',
  apps: ['AI Agent Runtime'],
  updatedLabel: 'test',
  pinned: false,
  sourceRuns: 0,
  versions: 1,
  workflow: { id: 'wf-conflict-skill', name: 'Conflict Skill', summary: 'test', repeatCount: 0, estimatedMinutes: 0, confidence: 0, nodes: [], edges: [] },
  targetTools: [],
  targetProjects: [],
  targetProjectPaths: [],
  skillMarkdown: '# Central Skill\n',
}

try {
  console.log('=== Trace OPC-56 Conflict Resolution Verification ===')

  // Skill: app-wins backs up the external directory, recreates the link, and
  // does not leave the target replaced when metadata persistence fails later.
  mkdirSync(centralSkillPath, { recursive: true })
  write(path.join(centralSkillPath, 'SKILL.md'), '# Central Skill\n')
  write(skillJsonPath, JSON.stringify(skillRecord, null, 2))
  assert.equal(injectSkillToTarget('conflict-skill', { scope: 'global', targetId: 'claude-global' }, options).success, true)
  unlinkSync(skillPath)
  write(path.join(skillPath, 'SKILL.md'), '# External Skill\n')
  assert.equal(discoverAllGlobalSkills(options).find((skill) => skill.id === 'conflict-skill')?.scopeStatus, '冲突')

  const skillAppWins = resolveSkillConflict({
    skillId: 'conflict-skill',
    target: { scope: 'global', toolId: 'claude-global' },
    strategy: 'use_app',
  }, options)
  assert.equal(skillAppWins.success, true, skillAppWins.error)
  assert.equal(lstatSync(skillPath).isSymbolicLink(), true)
  assert.ok(skillAppWins.backupPath && lstatSync(skillAppWins.backupPath).isDirectory())
  assert.equal(readFileSync(path.join(centralSkillPath, 'SKILL.md'), 'utf8'), '# Central Skill\n')

  // Skill: target-wins keeps the managed identity, backs up the old central
  // source, and imports the external target before relinking it.
  unlinkSync(skillPath)
  write(path.join(skillPath, 'SKILL.md'), '# Target Wins Skill\n')
  const skillTargetWins = resolveSkillConflict({
    skillId: 'conflict-skill',
    target: { scope: 'global', toolId: 'claude-global' },
    strategy: 'use_target',
  }, options)
  assert.equal(skillTargetWins.success, true, skillTargetWins.error)
  assert.equal(lstatSync(skillPath).isSymbolicLink(), true)
  assert.ok(skillTargetWins.backupPath && lstatSync(skillTargetWins.backupPath).isDirectory())
  assert.equal(readFileSync(path.join(centralSkillPath, 'SKILL.md'), 'utf8'), '# Target Wins Skill\n')

  // Skill: keep-external does not touch the target and only unassociates it.
  unlinkSync(skillPath)
  write(path.join(skillPath, 'SKILL.md'), '# Keep External Skill\n')
  const skillKeepExternal = resolveSkillConflict({
    skillId: 'conflict-skill',
    target: { scope: 'global', toolId: 'claude-global' },
    strategy: 'keep_external',
  }, options)
  assert.equal(skillKeepExternal.success, true, skillKeepExternal.error)
  assert.equal(lstatSync(skillPath).isDirectory(), true)
  assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# Keep External Skill\n')
  const savedSkill = JSON.parse(readFileSync(skillJsonPath, 'utf8'))
  assert.equal(savedSkill.targetTools.includes('claude-global'), false)

  // Broken links cannot be imported as target content, but app-wins can
  // safely replace the broken link while keeping it recoverable.
  rmSync(skillPath, { recursive: true, force: true })
  symlinkSync(path.join(root, 'missing-skill-target'), skillPath, 'dir')
  const brokenTargetWins = resolveSkillConflict({
    skillId: 'conflict-skill',
    target: { scope: 'global', toolId: 'claude-global' },
    strategy: 'use_target',
  }, options)
  assert.equal(brokenTargetWins.success, false)
  assert.equal(lstatSync(skillPath).isSymbolicLink(), true)
  const brokenAppWins = resolveSkillConflict({
    skillId: 'conflict-skill',
    target: { scope: 'global', toolId: 'claude-global' },
    strategy: 'use_app',
  }, options)
  assert.equal(brokenAppWins.success, true, brokenAppWins.error)
  assert.equal(lstatSync(skillPath).isSymbolicLink(), true)

  // Project discovery also surfaces a same-name ordinary directory or wrong
  // symlink as a conflict against the central Skill identity.
  const projectPath = path.join(root, 'project')
  const projectSkillPath = path.join(projectPath, '.agents', 'skills', 'conflict-skill')
  write(path.join(projectSkillPath, 'SKILL.md'), '# Project Conflict\n')
  const projectConflict = discoverProjectSkills(projectPath, traceHome).skills.find((skill) => skill.id === 'conflict-skill')
  assert.equal(projectConflict?.scopeStatus, '冲突')
  assert.equal(projectConflict?.targetBindings?.[0]?.status, 'conflict')
  const projectAppWins = resolveSkillConflict({
    skillId: 'conflict-skill',
    target: { scope: 'project', projectPath, relPath: '.agents/skills' },
    strategy: 'use_app',
  }, options)
  assert.equal(projectAppWins.success, true, projectAppWins.error)
  assert.equal(lstatSync(projectSkillPath).isSymbolicLink(), true)

  // MCP setup and adoption.
  const mcpPath = resolveMCPConfigPath('cursor', 'global', options)
  write(mcpPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    resolver: { command: 'node', args: ['central.js'], customField: 'preserve' },
  } }, null, 2))
  const adopted = adoptMCPServer({ tool: 'cursor', scope: 'global', name: 'resolver' }, options)
  assert.equal(adopted.success, true, adopted.error)
  assert.equal(injectMCPServerToTarget(adopted.server.id, { tool: 'claude-code', scope: 'global' }, options).success, true)

  // MCP: a stale expected hash is rejected before any write.
  write(mcpPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    resolver: { command: 'node', args: ['external-first.js'], customField: 'external' },
  } }, null, 2))
  await readCentralMCPServers(options)
  const stale = resolveMCPConflict({
    serverIdOrName: adopted.server.id,
    target: { tool: 'cursor', scope: 'global' },
    strategy: 'use_app',
    expectedTargetHash: 'stale-dialog-snapshot',
  }, options)
  assert.equal(stale.success, false)
  assert.deepEqual(readMCPServersForTool('cursor', 'global', options)[0].args, ['external-first.js'])

  // MCP: app-wins backs up the complete native file and uses the adapter's
  // revision guard while retaining unrelated config.
  const appWins = resolveMCPConflict({
    serverIdOrName: adopted.server.id,
    target: { tool: 'cursor', scope: 'global' },
    strategy: 'use_app',
  }, options)
  assert.equal(appWins.success, true, appWins.error)
  assert.ok(appWins.backupPath && existsSync(appWins.backupPath))
  const appWinsConfig = JSON.parse(readFileSync(mcpPath, 'utf8'))
  assert.equal(appWinsConfig.unrelated.keep, true)
  assert.deepEqual(appWinsConfig.mcpServers.resolver.args, ['central.js'])

  // MCP: target-wins updates only the central source and leaves another target
  // untouched (it will be surfaced as a separate conflict on next discovery).
  write(mcpPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    resolver: { command: 'node', args: ['target-wins.js'], customField: 'target' },
  } }, null, 2))
  await readCentralMCPServers(options)
  const targetWins = resolveMCPConflict({
    serverIdOrName: adopted.server.id,
    target: { tool: 'cursor', scope: 'global' },
    strategy: 'use_target',
  }, options)
  assert.equal(targetWins.success, true, targetWins.error)
  assert.ok(targetWins.backupPath && existsSync(targetWins.backupPath))
  assert.deepEqual(readMCPServersForTool('cursor', 'global', options)[0].args, ['target-wins.js'])
  assert.deepEqual(readMCPServersForTool('claude-code', 'global', options)[0].args, ['central.js'])
  const centralAfterTargetWins = (await readCentralMCPServers(options)).find((server) => server.id === adopted.server.id)
  assert.deepEqual(centralAfterTargetWins.args, ['target-wins.js'])

  // MCP: keep-external leaves the target byte-for-byte semantic entry and
  // removes only that target association from the central registry.
  write(mcpPath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
    resolver: { command: 'node', args: ['kept-external.js'], customField: 'keep' },
  } }, null, 2))
  await readCentralMCPServers(options)
  const keepMcp = resolveMCPConflict({
    serverIdOrName: adopted.server.id,
    target: { tool: 'cursor', scope: 'global' },
    strategy: 'keep_external',
  }, options)
  assert.equal(keepMcp.success, true, keepMcp.error)
  assert.deepEqual(readMCPServersForTool('cursor', 'global', options)[0].args, ['kept-external.js'])
  const centralAfterKeep = (await readCentralMCPServers(options)).find((server) => server.id === adopted.server.id)
  assert.equal(centralAfterKeep.targetAssociations.some((association) => association.tool === 'cursor'), false)
  assert.equal(centralAfterKeep.targetAssociations.some((association) => association.tool === 'claude-code'), true)

  console.log('PASS app-wins/target-wins/keep-external, backup safety, stale guards, and multi-target isolation')
} finally {
  rmSync(root, { recursive: true, force: true })
}
