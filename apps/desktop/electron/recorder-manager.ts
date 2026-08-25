import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  RecorderCommand,
  RecorderEnvelope,
  RecorderStatus,
} from '@workflow-skill/capture-protocol'

export interface SystemSettingsWindowSnapshot {
  visible: boolean
  frame?: { x: number; y: number; width: number; height: number }
}

const unavailableStatus = (): RecorderStatus => ({
  protocolVersion: 1,
  recorderVersion: 'unavailable',
  platform: process.platform === 'win32' ? 'windows' : 'macos',
  state: 'interrupted',
  eventCount: 0,
  frameCount: 0,
  recordedBytes: 0,
  permissions: { screenRecording: false, accessibility: false },
  timestamp: new Date().toISOString(),
})

export class NativeRecorderManager extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private stdoutBuffer = ''
  private status: RecorderStatus = unavailableStatus()
  private stopping = false
  private auxiliaryChildren = new Set<ChildProcessWithoutNullStreams>()

  getStatus() {
    return this.status
  }

  start() {
    if (this.child) return
    const executable = this.resolveExecutable()
    if (!executable) {
      this.emitEnvelope({
        protocolVersion: 1,
        type: 'error',
        timestamp: new Date().toISOString(),
        payload: {
          code: 'recorder_binary_missing',
          message: `No native recorder is available for ${process.platform}`,
          recoverable: false,
        },
      })
      return
    }

    this.stopping = false
    const child = spawn(executable, ['serve'], {
      cwd: path.dirname(executable),
      env: { ...process.env, TRACE_PARENT_PID: String(process.pid) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.readStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (message: string) => {
      this.emit('diagnostic', message.trim())
    })
    child.on('error', (error) => {
      this.emitRecorderError('recorder_spawn_failed', error.message, false)
    })
    child.on('exit', (code, signal) => {
      this.child = undefined
      if (!this.stopping) {
        this.status = { ...this.status, state: 'interrupted', timestamp: new Date().toISOString() }
        this.emitRecorderError(
          'recorder_exited',
          `Native recorder exited (${signal ?? code ?? 'unknown'})`,
          true,
        )
        this.emitEnvelope({
          protocolVersion: 1,
          type: 'status',
          timestamp: this.status.timestamp,
          payload: this.status,
        })
      }
    })
  }

  command(command: RecorderCommand & { ownerWindowHandle?: string }) {
    if (!this.child) this.start()
    if (!this.child?.stdin.writable) return this.status
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
    return this.status
  }

  shutdown() {
    this.stopping = true
    for (const child of this.auxiliaryChildren) child.kill('SIGTERM')
    this.auxiliaryChildren.clear()
    if (!this.child) return
    if (this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      this.child.stdin.end()
    }
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM')
    }, 1_500).unref()
  }

  watchSystemSettingsWindow(listener: (snapshot: SystemSettingsWindowSnapshot) => void) {
    if (process.platform !== 'darwin') return () => undefined
    const executable = this.resolveExecutable()
    if (!executable) return () => undefined

    const child = spawn(executable, ['watch-system-settings'], {
      cwd: path.dirname(executable),
      env: { ...process.env, TRACE_PARENT_PID: String(process.pid) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.auxiliaryChildren.add(child)
    let buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          listener(JSON.parse(line) as SystemSettingsWindowSnapshot)
        } catch (error) {
          this.emit('diagnostic', `Invalid System Settings window snapshot: ${String(error)}`)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (message: string) => this.emit('diagnostic', message.trim()))
    child.on('exit', () => this.auxiliaryChildren.delete(child))

    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      this.auxiliaryChildren.delete(child)
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }

  showPermisoOverlay(
    panel: 'accessibility' | 'screenRecording',
    appBundlePath?: string,
    sourceFrame?: { x: number; y: number; width: number; height: number },
  ) {
    if (process.platform !== 'darwin') return
    this.closePermisoOverlay()
    const executable = this.resolveExecutable()
    if (!executable) return

    const args = ['permiso', panel]
    if (appBundlePath) {
      args.push('--app-path', appBundlePath)
    }
    if (sourceFrame) {
      args.push(
        '--source-x', String(sourceFrame.x),
        '--source-y', String(sourceFrame.y),
        '--source-w', String(sourceFrame.width),
        '--source-h', String(sourceFrame.height),
      )
    }

    const child = spawn(executable, args, {
      cwd: path.dirname(executable),
      env: { ...process.env, TRACE_PARENT_PID: String(process.pid) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.auxiliaryChildren.add(child)
    child.on('exit', () => this.auxiliaryChildren.delete(child))
  }

  closePermisoOverlay() {
    for (const child of this.auxiliaryChildren) {
      if (child.spawnargs.includes('permiso')) {
        this.auxiliaryChildren.delete(child)
        if (child.exitCode === null) child.kill('SIGTERM')
      }
    }
  }

  private readStdout(chunk: string) {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const envelope = JSON.parse(line) as RecorderEnvelope
        if (envelope.protocolVersion !== 1) {
          this.emitRecorderError('protocol_mismatch', 'Unsupported recorder protocol version', false)
          continue
        }
        if (envelope.type === 'status') {
          this.status = envelope.payload
        } else if (envelope.type === 'frame-sample') {
          this.status = {
            ...this.status,
            frameCount: envelope.payload.frameNumber,
            timestamp: envelope.timestamp,
          }
        } else if (envelope.type === 'capture-event') {
          this.status = {
            ...this.status,
            eventCount: this.status.eventCount + 1,
            activeApplication: envelope.payload.applicationId ?? this.status.activeApplication,
            timestamp: envelope.timestamp,
          }
        }
        this.emitEnvelope(envelope)
      } catch (error) {
        this.emitRecorderError(
          'invalid_recorder_message',
          error instanceof Error ? error.message : 'Recorder emitted invalid JSON',
          true,
        )
      }
    }
  }

  private emitEnvelope(envelope: RecorderEnvelope) {
    this.emit('message', envelope)
  }

  private emitRecorderError(code: string, message: string, recoverable: boolean) {
    this.emitEnvelope({
      protocolVersion: 1,
      type: 'error',
      timestamp: new Date().toISOString(),
      payload: { code, message, recoverable },
    })
  }

  private resolveExecutable() {
    const override = process.env.TRACE_RECORDER_PATH
    if (override && existsSync(override)) return override

    const recorderName = process.platform === 'darwin'
      ? 'workflow-recorder-macos'
      : process.platform === 'win32'
        ? 'WorkflowRecorder.exe'
        : undefined
    if (!recorderName) return undefined

    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'recorders', recorderName)]
      : process.platform === 'darwin'
        ? [
            path.resolve(app.getAppPath(), '../../recorders/macos/.build/debug', recorderName),
            path.resolve(app.getAppPath(), '../../recorders/macos/.build/release', recorderName),
          ]
        : [
            path.resolve(app.getAppPath(), '../../recorders/windows/WorkflowRecorder/bin/Debug/net8.0-windows10.0.19041.0', recorderName),
            path.resolve(app.getAppPath(), '../../recorders/windows/WorkflowRecorder/bin/Release/net8.0-windows10.0.19041.0', recorderName),
          ]
    return candidates.find(existsSync)
  }
}
