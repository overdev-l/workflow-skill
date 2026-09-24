import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  scanGlobalSkillCandidates,
  scanProjectSkillCandidates,
  migrateSkillCandidates,
  isSkillAlreadyLinked,
} from '../apps/desktop/electron/onboarding-manager.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-opc214-verify-'))
const homeDir = path.join(root, 'home')
const traceHome = path.join(root, 'trace')
const projectPath = path.join(root, 'project')

const write = (filePath, content) => {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

const symlinkDir = (dest, source) => {
  mkdirSync(path.dirname(dest), { recursive: true })
  symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir')
}

try {
  console.log('=== Trace OPC-214 Onboarding Skills Scanning & Migration Verification ===')

  const options = { homeDir, traceHome }

  // 1. Setup Global skills
  // Tool 1: agents-global (~/.agents/skills) -> skill1 (normal external)
  const agentsSkill1 = path.join(homeDir, '.agents', 'skills', 'skill-alpha')
  write(path.join(agentsSkill1, 'SKILL.md'), '---\nname: Skill Alpha\ndescription: alpha\n---\n# Skill Alpha\n')

  // Tool 2: codex-global (~/.codex/skills) -> skill2 (conflicting with central)
  const codexSkill2 = path.join(homeDir, '.codex', 'skills', 'skill-beta')
  write(path.join(codexSkill2, 'SKILL.md'), '---\nname: Skill Beta (Local)\ndescription: beta local\n---\n# Skill Beta Local\n')

  // Pre-seed central library with an existing skill-beta having DIFFERENT content
  const centralSkillBeta = path.join(traceHome, 'skills', 'skill-beta')
  write(path.join(centralSkillBeta, 'SKILL.md'), '---\nname: Skill Beta (Central)\ndescription: beta central\n---\n# Skill Beta Central\n')
  write(
    path.join(traceHome, 'skills', 'skill-beta.json'),
    JSON.stringify({
      id: 'skill-beta',
      name: 'Skill Beta (Central)',
      description: 'beta central',
      ownership: 'app',
    }, null, 2)
  )

  // Tool 3: claude-global (~/.claude/skills) -> skill3 (already linked to central)
  const centralSkillGamma = path.join(traceHome, 'skills', 'skill-gamma')
  write(path.join(centralSkillGamma, 'SKILL.md'), '---\nname: Skill Gamma\ndescription: gamma\n---\n# Skill Gamma\n')
  write(
    path.join(traceHome, 'skills', 'skill-gamma.json'),
    JSON.stringify({
      id: 'skill-gamma',
      name: 'Skill Gamma',
      description: 'gamma',
      ownership: 'app',
    }, null, 2)
  )
  const claudeSkill3 = path.join(homeDir, '.claude', 'skills', 'skill-gamma')
  symlinkDir(claudeSkill3, centralSkillGamma)

  // Tool 4: gemini-global (NOT in ONBOARDING_GLOBAL_SKILL_SOURCE_TOOL_IDS -> MUST BE IGNORED)
  const geminiSkill = path.join(homeDir, '.gemini', 'antigravity', 'skills', 'skill-gemini')
  write(path.join(geminiSkill, 'SKILL.md'), '---\nname: Gemini Skill\n---\n# Gemini\n')

  // --- Test 1: scanGlobalSkillCandidates ---
  console.log('Testing scanGlobalSkillCandidates...')
  const globalCandidates = scanGlobalSkillCandidates(options)
  console.log('Found global candidates:', globalCandidates.map(c => ({ id: c.skillName, tool: c.sourceToolId, linked: c.alreadyLinked, conflict: c.conflictsWithCentralId })))

  // Must only return candidates from agents-global, codex-global, claude-global
  assert.equal(globalCandidates.length, 3, 'Should only return 3 candidates, ignoring gemini')
  assert.ok(globalCandidates.every(c => ['agents-global', 'codex-global', 'claude-global'].includes(c.sourceToolId)))

  // Check alpha
  const alpha = globalCandidates.find(c => c.skillName === 'Skill Alpha')
  assert.ok(alpha)
  assert.equal(alpha.sourceToolId, 'agents-global')
  assert.equal(alpha.sourceLabel, 'agents')
  assert.equal(alpha.alreadyLinked, false)
  assert.equal(alpha.conflictsWithCentralId, undefined)

  // Check beta (conflicts with central)
  const beta = globalCandidates.find(c => c.sourceToolId === 'codex-global')
  assert.ok(beta)
  assert.equal(beta.sourceLabel, 'codex')
  assert.equal(beta.alreadyLinked, false)
  assert.equal(beta.conflictsWithCentralId, 'skill-beta')

  // Check gamma (already linked)
  const gamma = globalCandidates.find(c => c.skillName === 'Skill Gamma')
  assert.ok(gamma)
  assert.equal(gamma.sourceToolId, 'claude-global')
  assert.equal(gamma.sourceLabel, 'claude')
  assert.equal(gamma.alreadyLinked, true)
  assert.equal(gamma.conflictsWithCentralId, undefined)

  // --- Test 2: scanProjectSkillCandidates ---
  console.log('Testing scanProjectSkillCandidates...')
  const projectSkill1 = path.join(projectPath, '.agents', 'skills', 'proj-skill-1')
  write(path.join(projectSkill1, 'SKILL.md'), '---\nname: Project Skill 1\n---\n# Proj 1\n')

  const projectSkill2 = path.join(projectPath, '.claude', 'skills', 'proj-skill-2')
  write(path.join(projectSkill2, 'SKILL.md'), '---\nname: Project Skill 2\n---\n# Proj 2\n')

  const projectCandidates = scanProjectSkillCandidates(projectPath, options)
  console.log('Found project candidates:', projectCandidates.map(c => ({ name: c.skillName, tool: c.sourceToolId, label: c.sourceLabel })))
  assert.equal(projectCandidates.length, 2)
  assert.ok(projectCandidates.some(c => c.skillName === 'Project Skill 1' && c.sourceToolId === 'agents' && c.sourceLabel === 'agents'))
  assert.ok(projectCandidates.some(c => c.skillName === 'Project Skill 2' && c.sourceToolId === 'claude' && c.sourceLabel === 'claude'))

  // Non-existent project
  const emptyCandidates = scanProjectSkillCandidates(path.join(root, 'non-existent'), options)
  assert.deepEqual(emptyCandidates, [])

  // --- Test 3: migrateSkillCandidates ---
  console.log('Testing migrateSkillCandidates...')

  // Case A: normal migration of agentsSkill1
  const migrationRes1 = await migrateSkillCandidates(
    [{ absolutePath: agentsSkill1 }],
    options
  )
  assert.equal(migrationRes1.length, 1)
  assert.equal(migrationRes1[0].ok, true, migrationRes1[0].error)
  assert.equal(migrationRes1[0].centralId, 'skill-alpha')
  // Verify agentsSkill1 is now a symlink pointing to central
  assert.ok(lstatSync(agentsSkill1).isSymbolicLink())
  assert.ok(existsSync(path.join(traceHome, 'skills', 'skill-alpha', 'SKILL.md')))

  // Case B: rename strategy on conflicting codexSkill2
  const migrationRes2 = await migrateSkillCandidates(
    [{ absolutePath: codexSkill2, conflictStrategy: 'rename' }],
    options
  )
  assert.equal(migrationRes2.length, 1)
  assert.equal(migrationRes2[0].ok, true, migrationRes2[0].error)
  assert.equal(migrationRes2[0].centralId, 'skill-beta-1', 'Should increment to skill-beta-1')
  assert.ok(existsSync(path.join(traceHome, 'skills', 'skill-beta-1', 'SKILL.md')))
  assert.ok(lstatSync(codexSkill2).isSymbolicLink())

  // Case C: already linked skill (claudeSkill3) - idempotent
  const migrationRes3 = await migrateSkillCandidates(
    [{ absolutePath: claudeSkill3 }],
    options
  )
  assert.equal(migrationRes3.length, 1)
  assert.equal(migrationRes3[0].ok, true)
  assert.equal(migrationRes3[0].centralId, 'skill-gamma')

  // Case D: project skill migration with use_app conflict strategy
  // Let's create a conflicting project skill
  const projConflict = path.join(projectPath, '.agents', 'skills', 'skill-beta')
  write(path.join(projConflict, 'SKILL.md'), '---\nname: Project Beta Divergent\n---\n# Divergent\n')
  const migrationRes4 = await migrateSkillCandidates(
    [{ absolutePath: projConflict, conflictStrategy: 'use_app' }],
    options
  )
  assert.equal(migrationRes4.length, 1)
  assert.equal(migrationRes4[0].ok, true, migrationRes4[0].error)
  assert.equal(migrationRes4[0].centralId, 'skill-beta')
  assert.ok(lstatSync(projConflict).isSymbolicLink())

  // Case E: error isolation - one invalid path doesn't fail others
  const migrationRes5 = await migrateSkillCandidates(
    [
      { absolutePath: path.join(root, 'invalid', 'path') },
      { absolutePath: projectSkill1 },
    ],
    options
  )
  assert.equal(migrationRes5.length, 2)
  assert.equal(migrationRes5[0].ok, false)
  assert.ok(migrationRes5[0].error)
  assert.equal(migrationRes5[1].ok, true)
  assert.equal(migrationRes5[1].centralId, 'proj-skill-1')

  // Case F: use_target overwrites the central library with the on-disk version
  const centralShared = path.join(traceHome, 'skills', 'shared-skill')
  write(path.join(centralShared, 'SKILL.md'), '---\nname: Shared (Central)\n---\n# Central version\n')
  write(
    path.join(traceHome, 'skills', 'shared-skill.json'),
    JSON.stringify({ id: 'shared-skill', name: 'Shared (Central)', ownership: 'app' }, null, 2)
  )
  const sharedTarget = path.join(homeDir, '.agents', 'skills', 'shared-skill')
  write(path.join(sharedTarget, 'SKILL.md'), '---\nname: Shared (Local)\n---\n# Local version\n')

  const migrationRes6 = await migrateSkillCandidates(
    [{ absolutePath: sharedTarget, conflictStrategy: 'use_target' }],
    options
  )
  assert.equal(migrationRes6[0].ok, true, migrationRes6[0].error)
  assert.equal(migrationRes6[0].centralId, 'shared-skill')
  assert.match(
    readFileSync(path.join(centralShared, 'SKILL.md'), 'utf8'),
    /Local version/,
    'use_target must overwrite the central library with the on-disk version'
  )
  assert.ok(lstatSync(sharedTarget).isSymbolicLink())

  // Case G: a directory name that is not already normalized must still honour the
  // chosen strategy. The central library keys on normalizeSkillId(name), so
  // `Code.Review` lives at `code-review`; picking use_app must keep the central
  // version rather than silently falling back to a renamed import.
  const centralCodeReview = path.join(traceHome, 'skills', 'code-review')
  write(path.join(centralCodeReview, 'SKILL.md'), '---\nname: Code Review (Central)\n---\n# Central version\n')
  write(
    path.join(traceHome, 'skills', 'code-review.json'),
    JSON.stringify({ id: 'code-review', name: 'Code Review (Central)', ownership: 'app' }, null, 2)
  )
  const unnormalizedTarget = path.join(homeDir, '.agents', 'skills', 'Code.Review')
  write(path.join(unnormalizedTarget, 'SKILL.md'), '---\nname: Code Review (Local)\n---\n# Local version\n')

  const scannedUnnormalized = scanGlobalSkillCandidates(options).find(
    (c) => c.absolutePath === unnormalizedTarget
  )
  assert.ok(scannedUnnormalized)
  assert.equal(scannedUnnormalized.conflictsWithCentralId, 'code-review')

  const migrationRes7 = await migrateSkillCandidates(
    [{ absolutePath: unnormalizedTarget, conflictStrategy: 'use_app' }],
    options
  )
  assert.equal(migrationRes7[0].ok, true, migrationRes7[0].error)
  assert.equal(migrationRes7[0].centralId, 'code-review')
  assert.match(
    readFileSync(path.join(centralCodeReview, 'SKILL.md'), 'utf8'),
    /Central version/,
    'use_app must preserve the central version'
  )
  assert.ok(
    !existsSync(path.join(traceHome, 'skills', 'code-review-1')),
    'use_app must not silently degrade into a renamed import'
  )
  assert.ok(lstatSync(unnormalizedTarget).isSymbolicLink())
  assert.equal(
    path.basename(realpathSync(unnormalizedTarget)),
    'code-review',
    'target must link to the central id, not to a suffixed copy'
  )

  // Case H: use_target on a non-normalized directory name
  const centralDeploy = path.join(traceHome, 'skills', 'deploy-flow')
  write(path.join(centralDeploy, 'SKILL.md'), '---\nname: Deploy (Central)\n---\n# Central version\n')
  write(
    path.join(traceHome, 'skills', 'deploy-flow.json'),
    JSON.stringify({ id: 'deploy-flow', name: 'Deploy (Central)', ownership: 'app' }, null, 2)
  )
  const deployTarget = path.join(homeDir, '.codex', 'skills', 'Deploy Flow')
  write(path.join(deployTarget, 'SKILL.md'), '---\nname: Deploy (Local)\n---\n# Local version\n')

  const migrationRes8 = await migrateSkillCandidates(
    [{ absolutePath: deployTarget, conflictStrategy: 'use_target' }],
    options
  )
  assert.equal(migrationRes8[0].ok, true, migrationRes8[0].error)
  assert.equal(migrationRes8[0].centralId, 'deploy-flow')
  assert.match(readFileSync(path.join(centralDeploy, 'SKILL.md'), 'utf8'), /Local version/)

  // Case I: scanning alone must never touch the filesystem, so a skipped step
  // (which only records onboarding state) leaves every candidate untouched.
  const untouched = path.join(homeDir, '.claude', 'skills', 'never-migrated')
  write(path.join(untouched, 'SKILL.md'), '---\nname: Never Migrated\n---\n# Untouched\n')
  scanGlobalSkillCandidates(options)
  scanProjectSkillCandidates(projectPath, options)
  assert.ok(lstatSync(untouched).isDirectory() && !lstatSync(untouched).isSymbolicLink())
  assert.ok(!existsSync(path.join(traceHome, 'skills', 'never-migrated')))

  console.log('=== All OPC-214 Onboarding Verification Checks Passed Successfully! ===')
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}
