import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = process.argv.includes('--release')
const command = process.platform === 'darwin'
  ? ['swift', ['build', '--package-path', 'recorders/macos', ...(release ? ['-c', 'release'] : [])]]
  : process.platform === 'win32'
    ? ['dotnet', ['build', 'recorders/windows/WorkflowRecorder/WorkflowRecorder.csproj', ...(release ? ['-c', 'Release'] : [])]]
    : undefined

if (!command) {
  console.error(`Trace recorder is not available for ${process.platform}`)
  process.exit(1)
}

const result = spawnSync(command[0], command[1], { cwd: root, stdio: 'inherit' })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
