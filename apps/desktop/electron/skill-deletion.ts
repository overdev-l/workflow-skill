import { lstatSync, rmSync, unlinkSync } from 'node:fs'
import type { DeleteSkillMode } from '@workflow-skill/workflow-model'

export type TrashItem = (targetPath: string) => Promise<void>

export async function removeSkillAssetPath(
  targetPath: string,
  mode: DeleteSkillMode,
  trashItem: TrashItem,
) {
  let targetStat
  try {
    targetStat = lstatSync(targetPath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  if (targetStat.isSymbolicLink()) {
    unlinkSync(targetPath)
    return
  }

  if (mode === 'trash') {
    await trashItem(targetPath)
    return
  }

  rmSync(targetPath, { recursive: targetStat.isDirectory(), force: true })
}

export async function deleteSkillPaths(
  targetPaths: Iterable<string>,
  mode: DeleteSkillMode,
  trashItem: TrashItem,
) {
  for (const targetPath of new Set(targetPaths)) {
    await removeSkillAssetPath(targetPath, mode, trashItem)
  }
}
