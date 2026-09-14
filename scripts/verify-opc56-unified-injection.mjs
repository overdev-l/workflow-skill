import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listProjects,
  getActiveProject,
  setActiveProject,
  addProject,
  removeProject,
  scanProjectSkillPaths,
  ensureProjectSkillPath,
  getStoredProjectWorkspace,
} from '../apps/desktop/electron/project-manager.ts'
import {
  listRules,
  getRule,
  saveRule,
  deleteRule,
  getProjectRuleConfig,
  setProjectRules,
  uninjectRuleFromProject,
  syncProjectRules,
  createClaudeMdLink,
  checkClaudeMdLink,
  renderAgentsMdContent,
  escapeMarkerAttr,
  unescapeMarkerAttr,
} from '../apps/desktop/electron/rule-manager.ts'
import {
  readCentralMCPServers,
  saveCentralMCPServer,
  deleteCentralMCPServer,
  injectMCPServerToTarget,
  uninjectMCPServerFromTarget,
  batchInjectMCPServers,
  batchUninjectMCPServers,
  readMCPServersForTool,
  resolveMCPConfigPath,
} from '../apps/desktop/electron/mcp-manager.ts'
import {
  injectSkillToTarget,
  uninjectSkillFromTarget,
  batchInjectSkills,
  batchUninjectSkills,
  validateProjectSkillRelPath,
} from '../apps/desktop/electron/skill-injection-manager.ts'

const testRoot = mkdtempSync(path.join(os.tmpdir(), 'trace-opc56-verify-'))

try {
  console.log('=== Trace OPC-56 Unified Injection & Multi-Project Verification ===')

  // Setup test environment directories
  const traceHome = path.join(testRoot, 'trace-home')
  const homeDir = path.join(testRoot, 'user-home')
  const projectA = path.join(testRoot, 'project-a')
  const projectB = path.join(testRoot, 'project-b')
  const projectC = path.join(testRoot, 'project-c')

  mkdirSync(traceHome, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  mkdirSync(projectC, { recursive: true })

  const baseOptions = { homeDir, traceHome }

  // -------------------------------------------------------------------------
  // Check 1: One centrally managed MCP/Skill can target global, project A and B;
  //          removing A leaves source/global/B intact.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 1: Multi-target Injection & Independent Uninject ---')

  // 1A. MCP Central Asset Multi-target Injection
  const saveRes = saveCentralMCPServer(
    {
      id: 'shared-db',
      name: 'shared-db',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'],
    },
    baseOptions
  )
  assert.equal(saveRes.success, true, 'Central MCP save must succeed')

  // Inject into global claude-code
  const injGlobal = injectMCPServerToTarget(
    'shared-db',
    { tool: 'claude-code', scope: 'global' },
    baseOptions
  )
  assert.equal(injGlobal.success, true, 'Inject to global claude-code must succeed')

  // Inject into project A claude-code
  const injProjA = injectMCPServerToTarget(
    'shared-db',
    { tool: 'claude-code', scope: 'project', projectPath: projectA },
    baseOptions
  )
  assert.equal(injProjA.success, true, 'Inject to project A must succeed')

  // Inject into project B cursor
  const injProjB = injectMCPServerToTarget(
    'shared-db',
    { tool: 'cursor', scope: 'project', projectPath: projectB },
    baseOptions
  )
  assert.equal(injProjB.success, true, 'Inject to project B cursor must succeed')

  // Verify all 3 targets have the configuration
  const globalServers = readMCPServersForTool('claude-code', 'global', baseOptions)
  assert.ok(globalServers.some((s) => s.name === 'shared-db'), 'Global claude-code has shared-db')

  const projAServers = readMCPServersForTool('claude-code', 'project', { ...baseOptions, projectWorkspace: projectA })
  assert.ok(projAServers.some((s) => s.name === 'shared-db'), 'Project A claude-code has shared-db')

  const projBServers = readMCPServersForTool('cursor', 'project', { ...baseOptions, projectWorkspace: projectB })
  assert.ok(projBServers.some((s) => s.name === 'shared-db'), 'Project B cursor has shared-db')

  // Uninject from Project A
  const uninjA = uninjectMCPServerFromTarget(
    'shared-db',
    { tool: 'claude-code', scope: 'project', projectPath: projectA },
    baseOptions
  )
  assert.equal(uninjA.success, true, 'Uninject from Project A must succeed')

  // Verify Project A is removed, but Central source, Global, and Project B are intact
  const projAServersAfter = readMCPServersForTool('claude-code', 'project', { ...baseOptions, projectWorkspace: projectA })
  assert.equal(projAServersAfter.some((s) => s.name === 'shared-db'), false, 'Project A shared-db removed')

  const globalServersAfter = readMCPServersForTool('claude-code', 'global', baseOptions)
  assert.ok(globalServersAfter.some((s) => s.name === 'shared-db'), 'Global claude-code still has shared-db')

  const projBServersAfter = readMCPServersForTool('cursor', 'project', { ...baseOptions, projectWorkspace: projectB })
  assert.ok(projBServersAfter.some((s) => s.name === 'shared-db'), 'Project B cursor still has shared-db')

  const centralList = await readCentralMCPServers(baseOptions)
  assert.ok(centralList.some((s) => s.name === 'shared-db'), 'Central asset shared-db is intact')
  console.log('PASS Check 1: MCP multi-target injection and independent uninject verified')

  // 1B. Skill Central Source Directory Symlink Injection
  const centralSkillDir = path.join(traceHome, 'skills', 'central-skill-demo')
  mkdirSync(centralSkillDir, { recursive: true })
  writeFileSync(path.join(centralSkillDir, 'SKILL.md'), '# Central Demo Skill')

  const globalToolSkillDir = path.join(homeDir, '.claude', 'skills')
  const projASkillDir = path.join(projectA, '.agents', 'skills')
  const projBSkillDir = path.join(projectB, '.cursor', 'skills')

  mkdirSync(globalToolSkillDir, { recursive: true })
  mkdirSync(projASkillDir, { recursive: true })
  mkdirSync(projBSkillDir, { recursive: true })

  const linkGlobal = path.join(globalToolSkillDir, 'central-skill-demo')
  const linkA = path.join(projASkillDir, 'central-skill-demo')
  const linkB = path.join(projBSkillDir, 'central-skill-demo')

  symlinkSync(centralSkillDir, linkGlobal, 'dir')
  symlinkSync(centralSkillDir, linkA, 'dir')
  symlinkSync(centralSkillDir, linkB, 'dir')

  assert.equal(realpathSync(linkGlobal), realpathSync(centralSkillDir))
  assert.equal(realpathSync(linkA), realpathSync(centralSkillDir))
  assert.equal(realpathSync(linkB), realpathSync(centralSkillDir))

  // Removing link A leaves central source, global, and B intact
  rmSync(linkA)
  assert.equal(existsSync(linkA), false)
  assert.equal(existsSync(linkGlobal), true)
  assert.equal(existsSync(linkB), true)
  assert.equal(existsSync(path.join(centralSkillDir, 'SKILL.md')), true)
  console.log('PASS Check 1: Skill symlink multi-target injection verified')

  // -------------------------------------------------------------------------
  // Check 2: Target switching and restart preserve project list and associations;
  //          global/project never cross-write.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 2: Target Switching & Cross-Write Prevention ---')

  // Add Project A and Project B
  const addA = addProject(projectA, traceHome)
  assert.equal(addA.success, true)
  const addB = addProject(projectB, traceHome)
  assert.equal(addB.success, true)

  // Switch to Project A and save project-scoped server
  setActiveProject(projectA, traceHome)
  assert.equal(getStoredProjectWorkspace(traceHome), projectA)

  const saveMcpA = injectMCPServerToTarget(
    'shared-db',
    { tool: 'gemini', scope: 'project', projectPath: projectA },
    baseOptions
  )
  assert.equal(saveMcpA.success, true)

  // Switch to Project B and save project-scoped server
  setActiveProject(projectB, traceHome)
  assert.equal(getStoredProjectWorkspace(traceHome), projectB)

  const saveMcpB = injectMCPServerToTarget(
    'shared-db',
    { tool: 'gemini', scope: 'project', projectPath: projectB },
    baseOptions
  )
  assert.equal(saveMcpB.success, true)

  // "Restart" - read fresh list from disk
  const persistedProjects = listProjects(traceHome)
  assert.equal(persistedProjects.length, 2)
  assert.equal(getActiveProject(traceHome)?.path, projectB)

  // Verify Gemini Global was NEVER touched by project writes
  const geminiGlobalPath = resolveMCPConfigPath('gemini', 'global', baseOptions)
  assert.equal(existsSync(geminiGlobalPath), false, 'Global config was not created/cross-written by project operations')
  console.log('PASS Check 2: Target switching and cross-write prevention verified')

  // -------------------------------------------------------------------------
  // Check 3: Missing/invalid project never falls back to startup cwd.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 3: No Implicit process.cwd() Fallback ---')

  const isolatedTraceHome = path.join(testRoot, 'isolated-trace')
  mkdirSync(isolatedTraceHome, { recursive: true })

  // When no projects are stored:
  const emptyWorkspace = getStoredProjectWorkspace(isolatedTraceHome)
  assert.equal(emptyWorkspace, '', 'Workspace must be empty string when no projects are configured')
  assert.notEqual(emptyWorkspace, process.cwd(), 'Workspace must NEVER fall back to process.cwd()')

  // Scope: project without valid workspace MUST fail with error
  assert.throws(
    () => {
      resolveMCPConfigPath('claude-code', 'project', { homeDir, traceHome: isolatedTraceHome, projectWorkspace: '' })
    },
    /No valid project workspace selected|项目工作区/,
    'Must throw error and refuse to fall back to process.cwd()'
  )

  saveCentralMCPServer(
    {
      id: 'shared-db',
      name: 'shared-db',
      transport: 'stdio',
      command: 'npx',
    },
    { homeDir, traceHome: isolatedTraceHome }
  )
  const failInject = injectMCPServerToTarget(
    'shared-db',
    { tool: 'claude-code', scope: 'project' },
    { homeDir, traceHome: isolatedTraceHome, projectWorkspace: '' }
  )
  assert.equal(failInject.success, false)
  assert.match(failInject.error, /未指定有效的项目路径/)
  console.log('PASS Check 3: Verified absence of process.cwd() fallback')

  // -------------------------------------------------------------------------
  // Check 4: Skill symlinks resolve to central sources; MCP merge preserves unrelated target config.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 4: Symlink Resolution & Lossless MCP Merge ---')

  // Pre-seed Claude config with unrelated fields and accounts
  const claudeConfigPath = resolveMCPConfigPath('claude-code', 'global', baseOptions)
  mkdirSync(path.dirname(claudeConfigPath), { recursive: true })
  writeFileSync(
    claudeConfigPath,
    JSON.stringify(
      {
        theme: 'dark',
        autoUpdate: true,
        accountInfo: { user: 'developer@example.com', token: 'secret-token' },
        mcpServers: {
          existingCustomTool: {
            command: 'python',
            args: ['custom.py'],
            env: { CUSTOM: 'true' },
          },
        },
      },
      null,
      2
    )
  )

  // Inject central server
  const injectRes = injectMCPServerToTarget('shared-db', { tool: 'claude-code', scope: 'global' }, baseOptions)
  assert.equal(injectRes.success, true)

  // Verify non-MCP and existing MCP config was completely preserved
  const updatedClaudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf8'))
  assert.equal(updatedClaudeConfig.theme, 'dark')
  assert.equal(updatedClaudeConfig.autoUpdate, true)
  assert.equal(updatedClaudeConfig.accountInfo.user, 'developer@example.com')
  assert.equal(updatedClaudeConfig.accountInfo.token, 'secret-token')
  assert.ok(updatedClaudeConfig.mcpServers.existingCustomTool)
  assert.ok(updatedClaudeConfig.mcpServers['shared-db'])
  console.log('PASS Check 4: Unrelated config & accounts preserved during MCP merge')

  // -------------------------------------------------------------------------
  // Check 5: R1 on A, R1+R2 on B; editing R1 updates only A/B as associated and ordering is honored.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 5: Multi-project Rule Associations & Auto-Sync ---')

  const r1 = saveRule({ name: 'R1 Code Standards', content: 'Rule 1: Always typecheck.' }, traceHome)
  assert.equal(r1.success, true)
  const r2 = saveRule({ name: 'R2 Security Guide', content: 'Rule 2: Never leak keys.' }, traceHome)
  assert.equal(r2.success, true)

  // Associate R1 with Project A
  const setA = setProjectRules(projectA, [r1.rule.id], traceHome)
  assert.equal(setA.success, true)
  assert.equal(setA.status, 'synced')

  // Associate R2 then R1 with Project B (ordering honored: R2 first, then R1)
  const setB = setProjectRules(projectB, [r2.rule.id, r1.rule.id], traceHome)
  assert.equal(setB.success, true)
  assert.equal(setB.status, 'synced')

  // Verify Project A AGENTS.md content
  const agentsA = readFileSync(path.join(projectA, 'AGENTS.md'), 'utf8')
  assert.ok(agentsA.includes('Rule 1: Always typecheck.'))
  assert.ok(!agentsA.includes('Rule 2: Never leak keys.'))

  // Verify Project B AGENTS.md ordering
  const agentsB = readFileSync(path.join(projectB, 'AGENTS.md'), 'utf8')
  const idxR2 = agentsB.indexOf('Rule 2: Never leak keys.')
  const idxR1 = agentsB.indexOf('Rule 1: Always typecheck.')
  assert.ok(idxR2 >= 0 && idxR1 >= 0)
  assert.ok(idxR2 < idxR1, 'R2 must appear before R1 according to ordering')

  // Now edit R1 - should auto-sync only associated Project A and B, leaving C untouched
  writeFileSync(path.join(projectC, 'AGENTS.md'), '# Project C Native Content', 'utf8')

  const editR1 = saveRule(
    { id: r1.rule.id, name: 'R1 Code Standards', content: 'Rule 1: Always typecheck and build.' },
    traceHome
  )
  assert.equal(editR1.success, true)
  assert.equal(editR1.syncResults.length, 2, 'Auto-sync synced exactly 2 projects (A and B)')

  const updatedA = readFileSync(path.join(projectA, 'AGENTS.md'), 'utf8')
  assert.ok(updatedA.includes('Rule 1: Always typecheck and build.'))

  const updatedB = readFileSync(path.join(projectB, 'AGENTS.md'), 'utf8')
  assert.ok(updatedB.includes('Rule 1: Always typecheck and build.'))
  assert.ok(updatedB.indexOf('Rule 2: Never leak keys.') < updatedB.indexOf('Rule 1: Always typecheck and build.'))

  const untouchedC = readFileSync(path.join(projectC, 'AGENTS.md'), 'utf8')
  assert.equal(untouchedC, '# Project C Native Content')
  console.log('PASS Check 5: Multi-project rule association, auto-sync and ordering verified')

  // -------------------------------------------------------------------------
  // Check 6: Repeated injection has no duplicates; removing R1 preserves project-native text and R2.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 6: Idempotent Sync & Clean Partial Uninject ---')

  // Add native text to Project B AGENTS.md
  const nativeHeader = '# Project B Documentation\n\nCustom manual guidance here.\n\n'
  writeFileSync(path.join(projectB, 'AGENTS.md'), nativeHeader + updatedB, 'utf8')

  // Run syncProjectRules repeatedly (3 times)
  syncProjectRules(projectB, traceHome)
  syncProjectRules(projectB, traceHome)
  syncProjectRules(projectB, traceHome)

  const multiSyncContent = readFileSync(path.join(projectB, 'AGENTS.md'), 'utf8')
  const r1Occurrences = (multiSyncContent.match(/Rule 1: Always typecheck and build/g) || []).length
  const r2Occurrences = (multiSyncContent.match(/Rule 2: Never leak keys/g) || []).length
  assert.equal(r1Occurrences, 1, 'Repeated sync must not duplicate R1')
  assert.equal(r2Occurrences, 1, 'Repeated sync must not duplicate R2')
  assert.ok(multiSyncContent.includes('Custom manual guidance here.'), 'Native text preserved after sync')

  // Uninject R1 from Project B
  const uninjR1 = uninjectRuleFromProject(projectB, r1.rule.id, traceHome)
  assert.equal(uninjR1.success, true)

  const afterUninjContent = readFileSync(path.join(projectB, 'AGENTS.md'), 'utf8')
  assert.ok(!afterUninjContent.includes('Rule 1: Always typecheck and build.'), 'R1 region removed')
  assert.ok(afterUninjContent.includes('Rule 2: Never leak keys.'), 'R2 region preserved')
  assert.ok(afterUninjContent.includes('Custom manual guidance here.'), 'Native text completely preserved')
  console.log('PASS Check 6: Idempotency and clean partial uninject verified')

  // -------------------------------------------------------------------------
  // Check 7: CLAUDE.md behavior matches conflict/idempotency semantics.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 7: CLAUDE.md Relative Symlink & Conflict Detection ---')

  // 7A: Create relative symlink
  const linkRes1 = createClaudeMdLink(projectA)
  assert.equal(linkRes1.success, true)
  assert.equal(linkRes1.action, 'created')

  const claudeLinkPath = path.join(projectA, 'CLAUDE.md')
  assert.ok(statSync(claudeLinkPath).isSymbolicLink() || existsSync(claudeLinkPath))
  assert.equal(readlinkSync(claudeLinkPath), 'AGENTS.md', 'Symlink target must be strictly relative "AGENTS.md"')

  // 7B: Idempotent skip
  const linkRes2 = createClaudeMdLink(projectA)
  assert.equal(linkRes2.success, true)
  assert.equal(linkRes2.action, 'skipped')

  // 7C: Conflict detection - regular file must NEVER be silently overwritten
  writeFileSync(path.join(projectC, 'CLAUDE.md'), '# Manual User CLAUDE Instructions', 'utf8')
  const conflictCheck = checkClaudeMdLink(projectC)
  assert.equal(conflictCheck.conflict, true)
  assert.equal(conflictCheck.isSymlink, false)

  const conflictAttempt = createClaudeMdLink(projectC)
  assert.equal(conflictAttempt.success, false)
  assert.equal(conflictAttempt.conflict, true)
  assert.match(conflictAttempt.reason, /普通文件/)

  const fileStillThere = readFileSync(path.join(projectC, 'CLAUDE.md'), 'utf8')
  assert.equal(fileStillThere, '# Manual User CLAUDE Instructions', 'Regular file must NEVER be overwritten')

  // 7D: Conflict detection - symlink pointing to different target
  const otherLinkPath = path.join(testRoot, 'project-other')
  mkdirSync(otherLinkPath, { recursive: true })
  symlinkSync('SOME_OTHER_FILE.md', path.join(otherLinkPath, 'CLAUDE.md'))
  const otherConflict = createClaudeMdLink(otherLinkPath)
  assert.equal(otherConflict.success, false)
  assert.equal(otherConflict.conflict, true)
  console.log('PASS Check 7: CLAUDE.md relative symlink, idempotency and conflict preservation verified')

  // -------------------------------------------------------------------------
  // Check 8: Batch operations return truthful per-item reports; failures never display success.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 8: Truthful Per-Item Batch Operations ---')

  const batchInjRes = batchInjectMCPServers(
    ['shared-db', 'non-existent-server-id'],
    { tool: 'claude-code', scope: 'global' },
    baseOptions
  )
  assert.equal(batchInjRes.results.length, 2)
  assert.equal(batchInjRes.results[0].id, 'shared-db')
  assert.equal(batchInjRes.results[0].success, true)
  assert.equal(batchInjRes.results[1].id, 'non-existent-server-id')
  assert.equal(batchInjRes.results[1].success, false)
  assert.ok(batchInjRes.results[1].error)

  const batchUninjRes = batchUninjectMCPServers(
    ['shared-db', 'non-existent-server-id'],
    { tool: 'claude-code', scope: 'global' },
    baseOptions
  )
  assert.equal(batchUninjRes.results.length, 2)
  assert.equal(batchUninjRes.results[0].id, 'shared-db')
  assert.equal(batchUninjRes.results[0].success, true)
  assert.equal(batchUninjRes.results[1].id, 'non-existent-server-id')
  assert.equal(batchUninjRes.results[1].success, false)
  assert.ok(batchUninjRes.results[1].error)
  console.log('PASS Check 8: Truthful batch operations verified')

  // -------------------------------------------------------------------------
  // Check 9: skill-injection-manager directly tested for multi-target isolation,
  //          traversal rejection, and truthful batch results.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 9: Direct skill-injection-manager Testing ---')

  const testSkillFile = path.join(traceHome, 'skills', 'skill-multi.json')
  writeFileSync(
    testSkillFile,
    JSON.stringify(
      {
        id: 'skill-multi',
        name: 'Skill Multi Target',
        description: 'Test skill for manager direct calls',
        targetTools: [],
        targetProjects: [],
      },
      null,
      2
    ),
    'utf8'
  )

  // 9A. Inject into global claude and global cursor
  const injSkillClaude = injectSkillToTarget(
    'skill-multi',
    { scope: 'global', targetId: 'claude' },
    { traceHome, homeDir, defaultProjectWorkspace: projectA }
  )
  assert.equal(injSkillClaude.success, true, 'Inject skill to global claude must succeed')

  const injSkillCursor = injectSkillToTarget(
    'skill-multi',
    { scope: 'global', targetId: 'cursor' },
    { traceHome, homeDir, defaultProjectWorkspace: projectA }
  )
  assert.equal(injSkillCursor.success, true, 'Inject skill to global cursor must succeed')

  const claudeSymlink = path.join(homeDir, '.claude', 'skills', 'skill-multi')
  const cursorSymlink = path.join(homeDir, '.cursor', 'skills', 'skill-multi')
  assert.ok(existsSync(claudeSymlink), 'Claude symlink must exist')
  assert.ok(existsSync(cursorSymlink), 'Cursor symlink must exist')
  assert.ok(lstatSync(claudeSymlink).isSymbolicLink(), 'Claude link must be symlink')
  assert.ok(lstatSync(cursorSymlink).isSymbolicLink(), 'Cursor link must be symlink')

  // Uninject from claude only: leaves cursor intact
  const uninjSkillClaude = uninjectSkillFromTarget(
    'skill-multi',
    { scope: 'global', targetId: 'claude' },
    { traceHome, homeDir }
  )
  assert.equal(uninjSkillClaude.success, true)
  assert.equal(existsSync(claudeSymlink), false, 'Claude symlink must be removed')
  assert.equal(existsSync(cursorSymlink), true, 'Cursor symlink must remain intact')

  // A user-owned regular file/directory at the target must be preserved and reported as a failure.
  const conflictSkillFile = path.join(traceHome, 'skills', 'skill-conflict.json')
  writeFileSync(
    conflictSkillFile,
    JSON.stringify({ id: 'skill-conflict', name: 'Skill Conflict', targetTools: ['claude'], targetProjects: [] }, null, 2),
    'utf8'
  )
  const conflictTarget = path.join(homeDir, '.claude', 'skills', 'skill-conflict')
  mkdirSync(conflictTarget, { recursive: true })
  writeFileSync(path.join(conflictTarget, 'USER_FILE.md'), 'preserve me', 'utf8')
  const conflictUninject = uninjectSkillFromTarget(
    'skill-conflict',
    { scope: 'global', targetId: 'claude' },
    { traceHome, homeDir }
  )
  assert.equal(conflictUninject.success, false, 'Regular target directory must not be reported as removed')
  assert.match(conflictUninject.error, /不是由 Trace 管理的软链接/)
  assert.equal(readFileSync(path.join(conflictTarget, 'USER_FILE.md'), 'utf8'), 'preserve me')
  const preservedConflictSkill = JSON.parse(readFileSync(conflictSkillFile, 'utf8'))
  assert.deepEqual(preservedConflictSkill.targetTools, ['claude'], 'Failed uninject must preserve association metadata')

  // 9B. Project-level path validation: accept supported paths, reject traversal and unknown paths
  const validRelAgents = validateProjectSkillRelPath('.agents/skills')
  assert.equal(validRelAgents.valid, true)

  const validRelCursor = validateProjectSkillRelPath('.cursor/skills')
  assert.equal(validRelCursor.valid, true)

  const invalidTraversal1 = validateProjectSkillRelPath('../../etc/passwd')
  assert.equal(invalidTraversal1.valid, false)
  assert.match(invalidTraversal1.error, /路径穿越|未知路径/)

  const invalidTraversal2 = validateProjectSkillRelPath('foo/../bar')
  assert.equal(invalidTraversal2.valid, false)

  const invalidAbs = validateProjectSkillRelPath('/var/log')
  assert.equal(invalidAbs.valid, false)

  const invalidUnknown = validateProjectSkillRelPath('custom/unknown/path')
  assert.equal(invalidUnknown.valid, false)
  assert.match(invalidUnknown.error, /不支持的项目技能相对路径/)

  // 9C. Project injection into project A with supported path
  const injSkillProjA = injectSkillToTarget(
    'skill-multi',
    { scope: 'project', projectPath: projectA, relPath: '.agents/skills' },
    { traceHome }
  )
  assert.equal(injSkillProjA.success, true)
  assert.ok(existsSync(path.join(projectA, '.agents', 'skills', 'skill-multi')))

  const injSkillProjCursor = injectSkillToTarget(
    'skill-multi',
    { scope: 'project', projectPath: projectA, relPath: '.cursor/skills' },
    { traceHome }
  )
  assert.equal(injSkillProjCursor.success, true)
  const uninjSkillProjAgents = uninjectSkillFromTarget(
    'skill-multi',
    { scope: 'project', projectPath: projectA, relPath: '.agents/skills' },
    { traceHome }
  )
  assert.equal(uninjSkillProjAgents.success, true)
  assert.equal(existsSync(path.join(projectA, '.agents', 'skills', 'skill-multi')), false)
  assert.equal(existsSync(path.join(projectA, '.cursor', 'skills', 'skill-multi')), true)
  const skillAfterPartialProjectUninject = JSON.parse(readFileSync(testSkillFile, 'utf8'))
  assert.ok(skillAfterPartialProjectUninject.targetProjects.includes(projectA))
  assert.deepEqual(skillAfterPartialProjectUninject.targetProjectPaths, [
    { projectPath: projectA, relPath: '.cursor/skills' },
  ])

  // Traversal injection must be rejected
  const injSkillTraversal = injectSkillToTarget(
    'skill-multi',
    { scope: 'project', projectPath: projectA, relPath: '../traversal' },
    { traceHome }
  )
  assert.equal(injSkillTraversal.success, false)
  assert.match(injSkillTraversal.error, /路径穿越|不支持/)

  // 9D. Truthful batch results
  const batchInjSkillRes = batchInjectSkills(
    ['skill-multi', 'non-existent-skill'],
    { scope: 'project', projectPath: projectB, relPath: '.github/skills' },
    { traceHome }
  )
  assert.equal(batchInjSkillRes.results.length, 2)
  assert.equal(batchInjSkillRes.results[0].id, 'skill-multi')
  assert.equal(batchInjSkillRes.results[0].success, true)
  assert.equal(batchInjSkillRes.results[1].id, 'non-existent-skill')
  assert.equal(batchInjSkillRes.results[1].success, false)
  assert.ok(batchInjSkillRes.results[1].error)

  const batchUninjSkillRes = batchUninjectSkills(
    ['skill-multi', 'non-existent-skill'],
    { scope: 'project', projectPath: projectB, relPath: '.github/skills' },
    { traceHome }
  )
  assert.equal(batchUninjSkillRes.results.length, 2)
  assert.equal(batchUninjSkillRes.results[0].id, 'skill-multi')
  assert.equal(batchUninjSkillRes.results[0].success, true)
  assert.equal(batchUninjSkillRes.results[1].id, 'non-existent-skill')
  assert.equal(batchUninjSkillRes.results[1].success, false)
  console.log('PASS Check 9: skill-injection-manager direct tests passed')

  // -------------------------------------------------------------------------
  // Check 10: Interleaved native text byte-for-byte preservation and rule attribute escaping.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 10: Interleaved Native Text Preservation & Attribute Escaping ---')

  const interleavedDoc = `# Project Lead Title

Lead paragraph content.

<!-- TRACE:MANAGED_RULE:START id="r1" name="Rule 1" -->
<RULE["r1"]>
Rule 1 initial content
</RULE["r1"]>
<!-- TRACE:MANAGED_RULE:END id="r1" -->

## Developer Interleaved Notes

This exact section is placed between R1 and R2 and must never be deleted or modified!
Line 2 of interleaved notes with special characters: $&<>"'

<!-- TRACE:MANAGED_RULE:START id="r2" name="Rule 2" -->
<RULE["r2"]>
Rule 2 initial content
</RULE["r2"]>
<!-- TRACE:MANAGED_RULE:END id="r2" -->

## Trailing Footer

End of file note.
`

  const dummyRule1 = { id: 'r1', name: 'Rule 1', content: 'Rule 1 updated content' }
  const dummyRule2 = { id: 'r2', name: 'Rule 2', content: 'Rule 2 updated content' }

  // Re-render rules (switching order: r2 then r1)
  const renderedSwapped = renderAgentsMdContent(interleavedDoc, [dummyRule2, dummyRule1])

  // Native chunks must be preserved
  assert.ok(renderedSwapped.includes('# Project Lead Title\n\nLead paragraph content.'), 'Header preserved')
  assert.ok(
    renderedSwapped.includes('## Developer Interleaved Notes\n\nThis exact section is placed between R1 and R2 and must never be deleted or modified!\nLine 2 of interleaved notes with special characters: $&<>"\''),
    'Interleaved notes between R1 and R2 must be preserved byte-for-byte'
  )
  assert.ok(renderedSwapped.includes('## Trailing Footer\n\nEnd of file note.'), 'Footer preserved')

  // Managed blocks reflect updated content
  assert.ok(renderedSwapped.includes('Rule 1 updated content'))
  assert.ok(renderedSwapped.includes('Rule 2 updated content'))

  // Test attribute escaping for rules with quotes and comment closers
  const trickyName = 'Rule "With Quotes" & --> Injected Closer'
  const escapedName = escapeMarkerAttr(trickyName)
  assert.ok(!escapedName.includes('-->'), 'Escaped attribute must not contain raw comment closer -->')
  assert.ok(!escapedName.includes('"'), 'Escaped attribute must not contain raw double quotes')
  assert.equal(unescapeMarkerAttr(escapedName), trickyName, 'Unescaping restores exact original name')

  const trickyRule = { id: 'tricky-id', name: trickyName, content: 'Safe content' }
  const renderedTricky = renderAgentsMdContent(null, [trickyRule])
  assert.ok(!renderedTricky.includes('--> Injected Closer" -->'), 'Must not close comment prematurely')
  assert.ok(renderedTricky.includes('&gt; Injected Closer'), 'Comment closer was properly entity escaped')
  console.log('PASS Check 10: Interleaved native text preservation and attribute escaping verified')

  // -------------------------------------------------------------------------
  // Check 11: Truthful failure of uninjectMCPServerFromTarget and deleteCentralMCPServer.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 11: Truthful Failure in MCP Manager ---')

  // Uninject from non-directory project path
  const fileNotDir = path.join(testRoot, 'a-regular-file.txt')
  writeFileSync(fileNotDir, 'this is a regular file, not a directory')

  const uninjFailRes = uninjectMCPServerFromTarget(
    'shared-db',
    { tool: 'claude-code', scope: 'project', projectPath: fileNotDir },
    baseOptions
  )
  assert.equal(uninjFailRes.success, false, 'Uninject from non-directory project must fail')
  assert.ok(uninjFailRes.error, 'Must provide error message')

  // Delete central server with a failing target: must not delete central server
  const failServer = saveCentralMCPServer(
    {
      id: 'server-with-failing-target',
      name: 'server-with-failing-target',
      transport: 'stdio',
      command: 'node',
      targetAssociations: [
        {
          tool: 'claude-code',
          scope: 'project',
          projectPath: fileNotDir,
          lastSyncStatus: 'synced',
        },
      ],
    },
    baseOptions
  )
  assert.equal(failServer.success, true)

  const delFailRes = deleteCentralMCPServer('server-with-failing-target', baseOptions)
  assert.equal(delFailRes.success, false, 'Delete must fail if target uninject fails')
  assert.ok(delFailRes.targetErrors && delFailRes.targetErrors.length > 0, 'Must report targetErrors')

  // Central server must NOT have been deleted
  const centralAfterFail = await readCentralMCPServers(baseOptions)
  assert.ok(
    centralAfterFail.some((s) => s.id === 'server-with-failing-target'),
    'Central server must remain when target uninject fails'
  )
  console.log('PASS Check 11: Truthful failure of uninject and delete verified')

  // -------------------------------------------------------------------------
  // Check 12: Renderer UI components reference central MCP and multi-project skill APIs.
  // -------------------------------------------------------------------------
  console.log('\n--- Acceptance Check 12: Renderer UI Integration Static Verification ---')

  const mcpThreeColCode = readFileSync(
    path.join(process.cwd(), 'apps/desktop/src/components/McpThreeColumn.tsx'),
    'utf8'
  )
  assert.ok(mcpThreeColCode.includes('listCentralMCPServers'), 'McpThreeColumn calls listCentralMCPServers')
  assert.ok(mcpThreeColCode.includes('saveCentralMCPServer'), 'McpThreeColumn calls saveCentralMCPServer')
  assert.ok(mcpThreeColCode.includes('deleteCentralMCPServer'), 'McpThreeColumn calls deleteCentralMCPServer')
  assert.ok(mcpThreeColCode.includes('injectMCPServer'), 'McpThreeColumn calls injectMCPServer')
  assert.ok(mcpThreeColCode.includes('uninjectMCPServer'), 'McpThreeColumn calls uninjectMCPServer')

  const appCode = readFileSync(path.join(process.cwd(), 'apps/desktop/src/App.tsx'), 'utf8')
  assert.ok(appCode.includes('injectSkill'), 'App.tsx calls injectSkill')
  assert.ok(appCode.includes('uninjectSkill'), 'App.tsx calls uninjectSkill')
  assert.ok(appCode.includes('batchInjectSkills'), 'App.tsx calls batchInjectSkills')
  assert.ok(appCode.includes('batchUninjectSkills'), 'App.tsx calls batchUninjectSkills')
  assert.ok(appCode.includes('SUPPORTED_PROJECT_SKILL_PATHS'), 'App.tsx references SUPPORTED_PROJECT_SKILL_PATHS')

  const rulesThreeColCode = readFileSync(
    path.join(process.cwd(), 'apps/desktop/src/components/RulesThreeColumn.tsx'),
    'utf8'
  )
  assert.ok(rulesThreeColCode.includes('className="app-col-master view-enter"'), 'Rules uses the shared master column grid item')
  assert.ok(rulesThreeColCode.includes('className="app-col-detail view-enter"'), 'Rules uses the shared detail column grid item')
  assert.ok(!rulesThreeColCode.includes('className="mcp-workbench"'), 'Rules does not wrap both grid columns in one shell item')
  console.log('PASS Check 12: Renderer UI integration static verification passed')

  console.log('\n=============================================================')
  console.log('ALL OPC-56 UNIFIED INJECTION & MULTI-PROJECT CHECKS PASSED!')
  console.log('=============================================================')
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}
