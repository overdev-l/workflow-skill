import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.env.TRACE_RECORDER_PATH || (process.platform === 'darwin'
  ? path.join(root, 'recorders/macos/.build/debug/workflow-recorder-macos')
  : process.platform === 'win32'
    ? path.join(root, 'recorders/windows/WorkflowRecorder/bin/Debug/net8.0-windows10.0.19041.0/WorkflowRecorder.exe')
    : '')

if (!executable || !existsSync(executable)) {
  console.error('Native recorder is not built. Run pnpm build:recorder first.')
  process.exit(1)
}

const child = spawn(executable, ['serve'], { cwd: path.dirname(executable), stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
let verified = false

const timeout = setTimeout(() => {
  console.error('Recorder handshake timed out.')
  child.kill()
  process.exitCode = 1
}, 8_000)

child.stderr.pipe(process.stderr)
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const envelope = JSON.parse(line)
    if (envelope.protocolVersion !== 1) throw new Error('Unexpected protocol version')
    if (!verified && envelope.type === 'status') {
      verified = true
      console.log(`Recorder handshake OK: ${envelope.payload.platform} ${envelope.payload.recorderVersion}`)
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      child.stdin.end()
    }
  }
})
child.on('error', (error) => {
  clearTimeout(timeout)
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  clearTimeout(timeout)
  if (!verified || code !== 0) process.exitCode = 1
})
