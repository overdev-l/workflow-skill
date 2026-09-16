import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  adoptAllSkills,
  buildSkillAdoptionPlan,
  disconnectSkillTarget,
  discoverAllGlobalSkills,
} from '../apps/desktop/electron/skill-injection-manager.ts'
import { discoverProjectSkills } from '../apps/desktop/electron/project-skill-discovery.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-opc69-adoption-'))
const homeDir = path.join(root, 'home')
const traceHome = path.join(root, 'trace')
const projectPath = path.join(root, 'project')
const sourcePath = path.join(homeDir, '.agents', 'skills', 'shared-skill')

const write = (filePath, content) => {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

const link = (target, source) => {
  mkdirSync(path.dirname(target), { recursive: true })
  symlinkSync(source, target, 'dir')
}

try {
  console.log('=== Trace OPC-69 Skill Adoption Verification ===')

  write(path.join(sourcePath, 'SKILL.md'), '---\nname: Shared Skill\ndescription: shared\n---\n\n# Shared Skill\n')
  write(path.join(sourcePath, 'scripts', 'run.js'), 'export default true\n')
  link(path.join(homeDir, '.claude', 'skills', 'shared-skill'), sourcePath)
  link(path.join(projectPath, '.agents', 'skills', 'shared-skill'), sourcePath)

  const options = { homeDir, traceHome, projectPaths: [projectPath] }
  const plan = buildSkillAdoptionPlan(options)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].targets.length, 3)
  assert.equal(plan.items[0].status, 'ready')
  assert.equal(plan.adoptableTargets, 3)

  const adopted = adoptAllSkills(options)
  assert.equal(adopted.success, true, adopted.results.map((item) => item.error).join('; '))
  assert.equal(adopted.adoptedCount, 1)
  assert.equal(adopted.linkedTargetCount, 3)
  assert.equal(adopted.failedCount, 0)

  const centralFolder = path.join(traceHome, 'skills', adopted.results[0].skillId)
  for (const target of [
    path.join(homeDir, '.agents', 'skills', 'shared-skill'),
    path.join(homeDir, '.claude', 'skills', 'shared-skill'),
    path.join(projectPath, '.agents', 'skills', 'shared-skill'),
  ]) {
    assert.equal(lstatSync(target).isSymbolicLink(), true)
    assert.equal(realpathSync(target), realpathSync(centralFolder))
    assert.equal(path.resolve(path.dirname(target), readlinkSync(target)), path.resolve(centralFolder))
  }
  assert.equal(existsSync(path.join(centralFolder, 'scripts', 'run.js')), true)
  const trashEntries = readdirSync(path.join(traceHome, '.trash'))
  assert.ok(trashEntries.length >= 1)
  assert.ok(trashEntries.some((entry) => existsSync(path.join(traceHome, '.trash', entry, 'SKILL.md'))))
  const discoveredAfterAdoption = discoverAllGlobalSkills(options).find((skill) => skill.id === adopted.results[0].skillId)
  assert.equal(discoveredAfterAdoption?.ownership, 'app')
  assert.equal(discoveredAfterAdoption?.scopeStatus, '全局软链')

  // Disconnecting one scope/target does not disturb the other global or
  // project links, and the central asset remains available.
  const disconnected = disconnectSkillTarget(
    adopted.results[0].skillId,
    { scope: 'global', targetId: 'agents-global' },
    options,
  )
  assert.equal(disconnected.success, true, disconnected.error)
  assert.equal(existsSync(path.join(homeDir, '.agents', 'skills', 'shared-skill')), false)
  assert.equal(lstatSync(path.join(homeDir, '.claude', 'skills', 'shared-skill')).isSymbolicLink(), true)
  assert.equal(lstatSync(path.join(projectPath, '.agents', 'skills', 'shared-skill')).isSymbolicLink(), true)
  assert.equal(existsSync(path.join(centralFolder, 'SKILL.md')), true)

  // A project copy with identical content is also shown as one managed asset,
  // not as a second conflict row (including macOS /var -> /private/var paths).
  const projectCopy = path.join(projectPath, '.claude', 'skills', 'shared-skill')
  cpSync(centralFolder, projectCopy, { recursive: true })
  const discoveredProject = discoverProjectSkills(projectPath, traceHome)
  const projectManaged = discoveredProject.skills.find((skill) => skill.id === adopted.results[0].skillId)
  assert.equal(discoveredProject.skills.filter((skill) => skill.id === adopted.results[0].skillId).length, 1)
  assert.equal(projectManaged?.scopeStatus, '待接管')
  assert.ok(projectManaged?.targetBindings?.some((binding) => binding.status === 'external'))
  rmSync(projectCopy, { recursive: true, force: true })

  // Re-running the migration sees only already-managed links and is a no-op.
  const secondPlan = buildSkillAdoptionPlan(options)
  assert.equal(secondPlan.totalTargets, 0)
  const repeated = adoptAllSkills(options)
  assert.equal(repeated.success, true)
  assert.equal(repeated.adoptedCount, 0)

  // A same-name, different-content source is surfaced for explicit handling.
  const divergent = path.join(homeDir, '.trae', 'skills', 'shared-skill')
  write(path.join(divergent, 'SKILL.md'), '# Divergent Shared Skill\n')
  const conflictPlan = buildSkillAdoptionPlan(options)
  assert.equal(conflictPlan.items.length, 1)
  assert.equal(conflictPlan.items[0].status, 'conflict')
  assert.equal(conflictPlan.conflictTargets, 1)
  const conflictRun = adoptAllSkills(options)
  assert.equal(conflictRun.skippedCount, 1)
  assert.equal(lstatSync(divergent).isDirectory(), true)
  assert.equal(existsSync(path.join(traceHome, 'skills', 'shared-skill-1')), false)

  const discovered = discoverAllGlobalSkills(options).find((skill) => skill.id === adopted.results[0].skillId)
  assert.equal(discovered?.ownership, 'app')
  assert.equal(discovered?.scopeStatus, '冲突')
  assert.ok(discovered?.targetBindings?.some((binding) => binding.status === 'conflict'))

  console.log('OPC-69 adoption checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
