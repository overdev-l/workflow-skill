import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addProject, removeProject, listProjects, listManagedProjects, setActiveProject, getActiveProject } from '../apps/desktop/electron/project-manager.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'trace-opc64-'))
const store = path.join(root, 'store')
const first = path.join(root, 'first')
const second = path.join(root, 'second')
try {
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(path.join(first, 'source.txt'), 'keep source')
  writeFileSync(path.join(first, 'AGENTS.md'), 'keep injected rules')
  assert.equal(addProject(first, store).success, true)
  const id = listProjects(store)[0].id
  assert.equal(addProject(path.join(first, '..', 'first'), store).success, true)
  assert.equal(listManagedProjects(store).length, 1, 'Equivalent paths deduplicate')
  assert.equal(listProjects(store)[0].id, id, 'Project identity stays stable')
  assert.equal(addProject(second, store).success, true)
  assert.equal(setActiveProject(id, store).success, true)
  assert.equal(getActiveProject(store).id, id)
  assert.equal(JSON.parse(readFileSync(path.join(store, 'config.json'), 'utf8')).projects.length, 2)
  rmSync(second, { recursive: true })
  assert.equal(listManagedProjects(store).find(p => p.path === second).status, 'missing')
  assert.equal(listProjects(store).length, 1, 'Missing directories are not injection targets')
  assert.equal(setActiveProject(second, store).success, false)
  writeFileSync(second, 'a file is not a project directory')
  assert.equal(listManagedProjects(store).find(p => p.path === second).status, 'missing')
  assert.equal(addProject(second, store).success, false)
  assert.equal(removeProject(id, store).success, true)
  assert.equal(readFileSync(path.join(first, 'source.txt'), 'utf8'), 'keep source')
  assert.equal(readFileSync(path.join(first, 'AGENTS.md'), 'utf8'), 'keep injected rules')
  assert.equal(listManagedProjects(store).length, 1, 'Removed project stays removed on reread')
  assert.equal(removeProject(second, store).success, true)
  assert.deepEqual(listManagedProjects(store), [])
  assert.equal(getActiveProject(store), null)
  const legacyStore = path.join(root, 'legacy-store')
  mkdirSync(legacyStore)
  writeFileSync(path.join(legacyStore, 'config.json'), JSON.stringify({projectWorkspace: first}))
  const legacy = listManagedProjects(legacyStore)[0]
  assert.ok(legacy.id.startsWith('legacy-'))
  assert.equal(removeProject(first, legacyStore).success, true)
  assert.deepEqual(listManagedProjects(legacyStore), [], 'Removing a legacy project by path cannot resurrect it')
  console.log('PASS OPC-64: dedup, stable identity, persistence, selection, invalid directories, and non-destructive removal')
} finally {
  rmSync(root, { recursive: true, force: true })
}
