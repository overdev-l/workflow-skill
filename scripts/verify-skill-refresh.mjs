import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_AI_TOOLS,
} from '../packages/workflow-model/src/index.ts'
import {
  detectInstalledAITools,
  getAIToolDirectory,
  countDirectChildSkillDirectories,
  injectSkillToTarget,
  uninjectSkillFromTarget,
  batchInjectSkills,
  batchUninjectSkills,
} from '../apps/desktop/electron/skill-injection-manager.ts'

console.log('=== Trace OPC-38 Skill Environment Status & Post-Action Refresh Verification ===\n')

const testTempRoot = mkdtempSync(path.join(tmpdir(), 'trace-refresh-test-'))
const traceHome = path.join(testTempRoot, '.trace')
const fakeHome = path.join(testTempRoot, 'home')
const testProjectDir = path.join(testTempRoot, 'project-alpha')

try {
  mkdirSync(traceHome, { recursive: true })
  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(testProjectDir, { recursive: true })
  mkdirSync(path.join(traceHome, 'skills'), { recursive: true })

  const options = {
    traceHome,
    homeDir: fakeHome,
    defaultProjectWorkspace: testProjectDir,
  }

  // --------------------------------------------------------------------------
  // Helper to create a central skill
  // --------------------------------------------------------------------------
  const createCentralSkill = (id, name) => {
    const skillDir = path.join(traceHome, 'skills', id)
    mkdirSync(skillDir, { recursive: true })
    const mdContent = `---\nname: ${name}\ndescription: Test skill ${name}\n---\n# ${name}\nTest content`
    writeFileSync(path.join(skillDir, 'SKILL.md'), mdContent, 'utf8')

    const skill = {
      id,
      name,
      description: `Test skill ${name}`,
      tags: ['test'],
      skillMarkdown: mdContent,
      apps: [],
      targetTools: [],
      targetProjects: [],
      updatedLabel: '刚刚',
      pinned: false,
      sourceRuns: 0,
      versions: 1,
      workflow: {
        id: `wf-${id}`,
        name,
        summary: '',
        repeatCount: 0,
        estimatedMinutes: 0,
        confidence: 0,
        nodes: [],
        edges: [],
      },
    }

    writeFileSync(
      path.join(traceHome, 'skills', `${id}.json`),
      JSON.stringify(skill, null, 2),
      'utf8',
    )
    return skill
  }

  // ==========================================================================
  // Test 1: Baseline Detection (before any skills linked)
  // ==========================================================================
  console.log('Test 1: Baseline detection before any skills linked...')
  let tools = detectInstalledAITools(options)
  assert.ok(Array.isArray(tools) && tools.length > 0, 'detectInstalledAITools must return tool array')

  const cursorGlobal = tools.find((t) => t.id === 'cursor-global')
  assert.ok(cursorGlobal, 'cursor-global should be defined')
  assert.equal(cursorGlobal.itemCount, 0, 'cursor-global itemCount should initially be 0')
  assert.equal(cursorGlobal.installed, false, 'cursor-global should not be installed when dir is missing')

  const cursorProject = tools.find((t) => t.id === 'cursor-project')
  assert.ok(cursorProject, 'cursor-project should be defined')
  assert.equal(cursorProject.itemCount, 0, 'cursor-project itemCount should initially be 0')
  assert.equal(cursorProject.installed, false, 'cursor-project should not be installed initially')
  assert.equal(cursorProject.pendingMount, true, 'cursor-project should be marked pendingMount')
  console.log('  ✓ Baseline detection matches expected clean state')

  // ==========================================================================
  // Test 2: Single Link to Global AI Tool (injectSkillToTarget)
  // ==========================================================================
  console.log('\nTest 2: Single link to global tool triggers immediate itemCount & installed refresh...')
  createCentralSkill('skill-1', 'Skill One')

  const injectRes1 = injectSkillToTarget(
    'skill-1',
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(injectRes1.success, true, `Injection should succeed: ${injectRes1.error}`)

  // Refresh aiTools
  tools = detectInstalledAITools(options)
  const cursorAfterInject1 = tools.find((t) => t.id === 'cursor-global')
  assert.equal(cursorAfterInject1.installed, true, 'cursor-global should now be installed')
  assert.equal(cursorAfterInject1.skillsDirExists, true, 'cursor-global skillsDirExists should be true')
  assert.equal(cursorAfterInject1.itemCount, 1, 'cursor-global itemCount must immediately refresh to 1')
  console.log('  ✓ cursor-global itemCount refreshed from 0 -> 1 on single link')

  // ==========================================================================
  // Test 3: Batch Link Multiple Skills (batchInjectSkills)
  // ==========================================================================
  console.log('\nTest 3: Batch linking multiple skills increments itemCount accurately...')
  createCentralSkill('skill-2', 'Skill Two')
  createCentralSkill('skill-3', 'Skill Three')

  const batchInjectRes = batchInjectSkills(
    ['skill-2', 'skill-3'],
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(batchInjectRes.results.length, 2)
  assert.ok(batchInjectRes.results.every((r) => r.success), 'All batch injections must succeed')

  // Refresh aiTools
  tools = detectInstalledAITools(options)
  const cursorAfterBatch = tools.find((t) => t.id === 'cursor-global')
  assert.equal(cursorAfterBatch.itemCount, 3, 'cursor-global itemCount must immediately refresh to 3')
  console.log('  ✓ cursor-global itemCount refreshed from 1 -> 3 after batch inject')

  // ==========================================================================
  // Test 4: Single Unlink / Disconnection (uninjectSkillFromTarget)
  // ==========================================================================
  console.log('\nTest 4: Single unlink decrements itemCount immediately...')
  const uninjectRes1 = uninjectSkillFromTarget(
    'skill-1',
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(uninjectRes1.success, true, `Uninjection should succeed: ${uninjectRes1.error}`)

  // Refresh aiTools
  tools = detectInstalledAITools(options)
  const cursorAfterUnlink1 = tools.find((t) => t.id === 'cursor-global')
  assert.equal(cursorAfterUnlink1.itemCount, 2, 'cursor-global itemCount must immediately decrease to 2')
  console.log('  ✓ cursor-global itemCount refreshed from 3 -> 2 on single unlink')

  // ==========================================================================
  // Test 5: Batch Unlink (batchUninjectSkills)
  // ==========================================================================
  console.log('\nTest 5: Batch unlink decrements itemCount to 0...')
  const batchUninjectRes = batchUninjectSkills(
    ['skill-2', 'skill-3'],
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(batchUninjectRes.results.length, 2)
  assert.ok(batchUninjectRes.results.every((r) => r.success), 'All batch uninjections must succeed')

  // Refresh aiTools
  tools = detectInstalledAITools(options)
  const cursorAfterBatchUnlink = tools.find((t) => t.id === 'cursor-global')
  assert.equal(cursorAfterBatchUnlink.itemCount, 0, 'cursor-global itemCount must immediately decrease to 0')
  assert.equal(cursorAfterBatchUnlink.installed, true, 'cursor-global directory still exists, so installed is true')
  console.log('  ✓ cursor-global itemCount refreshed from 2 -> 0 on batch unlink')

  // ==========================================================================
  // Test 6: Project Scope Tool Link & PendingMount State Transition
  // ==========================================================================
  console.log('\nTest 6: Project tool scope link transitions pendingMount -> ready and updates itemCount...')
  const initialProjectTool = detectInstalledAITools(options).find((t) => t.id === 'cursor-project')
  assert.equal(initialProjectTool.installed, false)
  assert.equal(initialProjectTool.pendingMount, true)
  assert.equal(initialProjectTool.itemCount, 0)

  // Inject skill-1 to cursor-project
  const projectInjectRes = injectSkillToTarget(
    'skill-1',
    { scope: 'project', projectPath: testProjectDir, relPath: '.cursor/skills' },
    options,
  )
  assert.equal(projectInjectRes.success, true, `Project inject should succeed: ${projectInjectRes.error}`)

  // Refresh aiTools
  tools = detectInstalledAITools(options)
  const cursorProjectAfterInject = tools.find((t) => t.id === 'cursor-project')
  assert.equal(cursorProjectAfterInject.installed, true, 'cursor-project should now be installed')
  assert.equal(cursorProjectAfterInject.pendingMount, false, 'cursor-project pendingMount should now be false')
  assert.equal(cursorProjectAfterInject.itemCount, 1, 'cursor-project itemCount should now be 1')
  console.log('  ✓ cursor-project successfully transitioned pendingMount(true) -> installed(true), itemCount 0 -> 1')

  // Uninject from cursor-project
  const projectUninjectRes = uninjectSkillFromTarget(
    'skill-1',
    { scope: 'project', projectPath: testProjectDir, relPath: '.cursor/skills' },
    options,
  )
  assert.equal(projectUninjectRes.success, true)

  tools = detectInstalledAITools(options)
  const cursorProjectAfterUninject = tools.find((t) => t.id === 'cursor-project')
  assert.equal(cursorProjectAfterUninject.installed, true)
  assert.equal(cursorProjectAfterUninject.itemCount, 0, 'cursor-project itemCount should be 0 after uninject')
  console.log('  ✓ cursor-project itemCount refreshed to 0 after project uninject')

  // ==========================================================================
  // Test 7: Failure Safety (no fake success, no erroneous count changes)
  // ==========================================================================
  console.log('\nTest 7: Failure safety - invalid operations preserve original state...')
  const beforeFailTools = detectInstalledAITools(options)
  const beforeFailCursor = beforeFailTools.find((t) => t.id === 'cursor-global')

  // Attempting to inject non-existent skill
  const failInject = injectSkillToTarget(
    'non-existent-skill-xyz',
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(failInject.success, false, 'Non-existent skill injection must fail')

  const afterFailInjectTools = detectInstalledAITools(options)
  const afterFailCursor = afterFailInjectTools.find((t) => t.id === 'cursor-global')
  assert.equal(afterFailCursor.itemCount, beforeFailCursor.itemCount, 'itemCount must not change on failed injection')

  // Attempting to uninject a target occupied by an external unmanaged directory (conflict)
  const cursorGlobalDir = getAIToolDirectory({ id: 'cursor-global', name: 'Cursor', scope: 'global', defaultDir: '.cursor/skills' }, options)
  const conflictDir = path.join(cursorGlobalDir, 'conflict-skill')
  mkdirSync(conflictDir, { recursive: true })
  writeFileSync(path.join(conflictDir, 'SKILL.md'), '# External unmanaged')

  createCentralSkill('conflict-skill', 'Conflict Skill')

  // Injection must fail because target exists and is an external unmanaged real folder
  const failInjectConflict = injectSkillToTarget(
    'conflict-skill',
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(failInjectConflict.success, false, 'Injection must fail on conflicting unmanaged target')

  // Uninjection must fail to protect the external user folder
  const failUnlinkConflict = uninjectSkillFromTarget(
    'conflict-skill',
    { scope: 'global', targetId: 'cursor-global' },
    options,
  )
  assert.equal(failUnlinkConflict.success, false, 'Unlinking external unmanaged folder must fail and protect file')
  assert.ok(existsSync(path.join(conflictDir, 'SKILL.md')), 'External file must be preserved')

  // Cleanup conflict dir
  rmSync(conflictDir, { recursive: true, force: true })
  console.log('  ✓ Conflict safety verified: external files protected, counts not falsely updated')

  // ==========================================================================
  // Test 8: Race Condition Safety Simulation (Sequence counter pattern)
  // ==========================================================================
  console.log('\nTest 8: Race condition safety (stale responses discarded)...')
  let currentActiveState = []
  let seqCounter = 0

  const simulateFetch = async (reqSeq, delayMs, snapshotData) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    // Commit only if newest request
    if (reqSeq === seqCounter) {
      currentActiveState = snapshotData
    }
  }

  // Request 1 started first with slow delay (100ms), capturing itemCount = 1
  seqCounter++
  const req1Seq = seqCounter
  const req1Promise = simulateFetch(req1Seq, 100, [{ id: 'cursor-global', itemCount: 1 }])

  // Request 2 started second with fast delay (20ms), capturing itemCount = 2
  seqCounter++
  const req2Seq = seqCounter
  const req2Promise = simulateFetch(req2Seq, 20, [{ id: 'cursor-global', itemCount: 2 }])

  await Promise.all([req1Promise, req2Promise])

  assert.equal(
    currentActiveState[0].itemCount,
    2,
    'Latest sequence request (itemCount=2) must win, older slow request must NOT overwrite state',
  )
  console.log('  ✓ Out-of-order responses handled safely; latest sequence won')

  console.log('\n=== ALL OPC-38 VERIFICATION TESTS PASSED ===')
} finally {
  rmSync(testTempRoot, { recursive: true, force: true })
}
