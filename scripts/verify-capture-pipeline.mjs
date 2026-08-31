import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CaptureRepository, inferWorkflow } from '../apps/desktop/electron/capture-repository.ts'

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'trace-capture-test-'))

function sessionEvents(sessionId, base) {
  const event = (offset, eventType, extra = {}) => ({
    id: `${sessionId}-${offset}-${eventType}`,
    occurredAt: new Date(base + offset).toISOString(),
    sessionId,
    applicationId: 'com.apple.Safari',
    applicationName: 'Safari',
    eventType,
    modifiers: 0,
    attributes: {},
    ...extra,
  })
  return [
    event(0, 'application-activated'),
    event(10, 'mouse-left-down', { target: { role: 'AXButton', identifier: 'submit' } }),
    event(7_000, 'scroll', { target: { role: 'AXScrollArea' } }),
    event(7_200, 'scroll', { target: { role: 'AXScrollArea' } }),
    event(8_000, 'key-down', { keyCode: 0, target: { role: 'AXTextField' } }),
    event(8_100, 'key-down', { keyCode: 1, target: { role: 'AXTextField' } }),
  ]
}

function completedStatus(eventCount, timestamp) {
  return {
    protocolVersion: 1,
    type: 'status',
    timestamp,
    payload: {
      protocolVersion: 1,
      recorderVersion: 'test',
      platform: process.platform === 'win32' ? 'windows' : 'macos',
      state: 'idle',
      eventCount,
      frameCount: 0,
      recordedBytes: 0,
      permissions: { screenRecording: true, accessibility: true },
      timestamp,
    },
  }
}

try {
  const firstEvents = sessionEvents('integration-session-1', Date.now())
  const inferred = inferWorkflow('integration-session-1', firstEvents, 'completed')
  if (!inferred || inferred.nodes.length !== 5 || !inferred.nodes.some((node) => node.kind === 'wait')) {
    throw new Error(`Unexpected inference result: ${JSON.stringify(inferred)}`)
  }

  const repository = new CaptureRepository({ getRootPath: () => temporaryRoot })
  for (let index = 1; index <= 2; index += 1) {
    const sessionId = `integration-session-${index}`
    const events = sessionEvents(sessionId, Date.now() + index * 20_000)
    for (const payload of events) {
      repository.handleRecorderEnvelope({
        protocolVersion: 1,
        type: 'capture-event',
        timestamp: payload.occurredAt,
        payload,
      })
    }
    repository.handleRecorderEnvelope(completedStatus(
      events.length,
      new Date(Date.now() + index * 20_000 + 9_000).toISOString(),
    ))
  }

  const workflows = repository.loadWorkflows()
  const recentEvents = repository.loadRecentEvents(20)
  const captureFiles = readdirSync(path.join(temporaryRoot, 'captures'))
  const workflowFiles = readdirSync(path.join(temporaryRoot, 'workflows')).filter((name) => !name.startsWith('.'))
  if (workflows.length !== 2 || workflows.some((workflow) => workflow.repeatCount !== 1)) {
    throw new Error(`Session workflow isolation failed: ${JSON.stringify(workflows)}`)
  }
  const sessionIds = new Set(workflows.map((workflow) => workflow.capture?.sessionIds[0]))
  if (sessionIds.size !== 2) {
    throw new Error(`Expected one workflow per capture session: ${JSON.stringify(workflows)}`)
  }
  if (captureFiles.length !== 2 || workflowFiles.length !== 2) {
    throw new Error(`Persistence failed: ${captureFiles.length} captures / ${workflowFiles.length} workflows`)
  }
  if (recentEvents.length !== 12 || recentEvents[0].sessionId !== 'integration-session-2') {
    throw new Error(`Recent event loading failed: ${JSON.stringify(recentEvents.slice(0, 2))}`)
  }
  for (const filename of captureFiles) {
    const rawLines = readFileSync(path.join(temporaryRoot, 'captures', filename), 'utf8').trim().split(/\r?\n/)
    if (rawLines.length !== firstEvents.length) {
      throw new Error(`Expected ${firstEvents.length} raw events in ${filename}, got ${rawLines.length}`)
    }
  }
  const edited = {
    ...workflows[0],
    name: 'Edited Safari workflow',
    nodes: workflows[0].nodes.map((node, index) => index === 0 ? { ...node, label: 'Edited first step' } : node),
  }
  if (!repository.updateWorkflow(edited)) {
    throw new Error('Workflow update failed')
  }
  const persistedEdit = repository.loadWorkflows().find((workflow) => workflow.id === edited.id)
  if (persistedEdit?.name !== edited.name || persistedEdit.nodes[0]?.label !== 'Edited first step') {
    throw new Error(`Workflow edit did not persist: ${JSON.stringify(persistedEdit)}`)
  }
  if (!repository.dismissWorkflow(workflows[0].id) || repository.loadWorkflows().length !== 1) {
    throw new Error('Persistent dismiss failed')
  }
  repository.shutdown()
  console.log(`Capture pipeline OK: 2 sessions -> 2 editable workflows -> ${inferred.nodes.length} inferred nodes`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
