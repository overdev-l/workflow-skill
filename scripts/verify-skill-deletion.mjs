import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deleteSkillPaths } from '../apps/desktop/electron/skill-deletion.ts'

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'trace-delete-test-'))

try {
  const source = path.join(temporaryRoot, 'recoverable-skill')
  const metadata = path.join(temporaryRoot, 'recoverable-skill.json')
  const linked = path.join(temporaryRoot, 'recoverable-link')
  const fakeTrash = path.join(temporaryRoot, 'Trash')
  mkdirSync(source)
  mkdirSync(fakeTrash)
  writeFileSync(path.join(source, 'SKILL.md'), '# Recoverable')
  writeFileSync(metadata, '{}')
  symlinkSync(source, linked, 'dir')

  const trashedPaths = []
  await deleteSkillPaths([linked, source, metadata], 'trash', async (targetPath) => {
    const destination = path.join(fakeTrash, path.basename(targetPath))
    renameSync(targetPath, destination)
    trashedPaths.push(destination)
  })

  if (existsSync(linked) || existsSync(source) || existsSync(metadata)) {
    throw new Error('Trash mode left source paths behind')
  }
  if (
    trashedPaths.length !== 2
    || !existsSync(path.join(fakeTrash, 'recoverable-skill', 'SKILL.md'))
    || !existsSync(path.join(fakeTrash, 'recoverable-skill.json'))
  ) {
    throw new Error(`Trash mode did not preserve recoverable files: ${JSON.stringify(trashedPaths)}`)
  }

  const permanentSource = path.join(temporaryRoot, 'permanent-skill')
  const permanentMetadata = path.join(temporaryRoot, 'permanent-skill.json')
  mkdirSync(permanentSource)
  writeFileSync(path.join(permanentSource, 'SKILL.md'), '# Permanent')
  writeFileSync(permanentMetadata, '{}')

  await deleteSkillPaths([permanentSource, permanentMetadata], 'permanent', async () => {
    throw new Error('Permanent mode must not call trashItem')
  })
  if (existsSync(permanentSource) || existsSync(permanentMetadata)) {
    throw new Error('Permanent mode left files behind')
  }

  console.log('Skill deletion OK: links unlinked, Trash recoverable, permanent removal verified')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
