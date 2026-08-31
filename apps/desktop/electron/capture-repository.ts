import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type {
  BrowserCaptureEnvelope,
  CaptureEvent,
  CaptureScenario,
  RecorderEnvelope,
  RecorderState,
} from '@workflow-skill/capture-protocol'
import type {
  CaptureWorkflowState,
  Workflow,
  WorkflowNode,
} from '@workflow-skill/workflow-model'

const MAX_INFERENCE_EVENTS = 5_000
const MAX_WORKFLOW_NODES = 80
const WAIT_THRESHOLD_MS = 5_000

interface CaptureSession {
  events: CaptureEvent[]
  state: CaptureWorkflowState
  scenario: CaptureScenario
}

interface DismissedWorkflowIndex {
  workflowIds: string[]
  sessionIds: string[]
}

interface InferenceNode extends WorkflowNode {
  occurredAt: number
  sourceType: 'application' | 'click' | 'typing' | 'shortcut' | 'scroll' | 'navigation' | 'browser-action' | 'network'
  sampleCount: number
  networkRequestId?: string
}

interface CaptureRepositoryOptions {
  getRootPath: () => string
  onWorkflowsChanged?: () => void
}

const macKeyNames: Record<number, string> = {
  0: 'A', 1: 'S', 2: 'D', 3: 'F', 4: 'H', 5: 'G', 6: 'Z', 7: 'X', 8: 'C', 9: 'V',
  11: 'B', 12: 'Q', 13: 'W', 14: 'E', 15: 'R', 16: 'Y', 17: 'T', 18: '1', 19: '2',
  20: '3', 21: '4', 22: '6', 23: '5', 24: '=', 25: '9', 26: '7', 27: '-', 28: '8',
  29: '0', 30: ']', 31: 'O', 32: 'U', 33: '[', 34: 'I', 35: 'P', 36: 'Enter',
  37: 'L', 38: 'J', 39: "'", 40: 'K', 41: ';', 42: '\\', 43: ',', 44: '/', 45: 'N',
  46: 'M', 47: '.', 48: 'Tab', 49: 'Space', 50: '`', 51: 'Delete', 53: 'Esc',
  123: '←', 124: '→', 125: '↓', 126: '↑',
}

const windowsKeyNames: Record<number, string> = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Esc', 32: 'Space', 33: 'PageUp',
  34: 'PageDown', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓', 46: 'Delete',
}

function hash(value: string, length = 20) {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function ensureDirectories(rootPath: string) {
  for (const directory of [rootPath, path.join(rootPath, 'captures'), path.join(rootPath, 'workflows')]) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  }
}

function captureFileKey(sessionId: string) {
  return hash(sessionId, 24)
}

function eventTimestamp(event: CaptureEvent) {
  const value = Date.parse(event.occurredAt)
  return Number.isFinite(value) ? value : Date.now()
}

function applicationName(event: CaptureEvent) {
  if (event.applicationName?.trim()) return event.applicationName.trim()
  if (event.applicationId?.trim()) return event.applicationId.split('.').pop() || event.applicationId
  return '当前应用'
}

function targetName(event: CaptureEvent) {
  const raw = event.target?.subrole || event.target?.role
  if (!raw) return '界面元素'
  const normalized = raw.replace(/^AX/, '').replace(/^ControlType\./, '').replace(/([a-z])([A-Z])/g, '$1 $2')
  const translated: Record<string, string> = {
    Button: '按钮', CheckBox: '复选框', ComboBox: '下拉框', Link: '链接', MenuItem: '菜单项',
    RadioButton: '单选项', SearchField: '搜索框', Slider: '滑块', Tab: '标签页',
    TextField: '输入框', Window: '窗口',
  }
  return translated[normalized] || normalized.toLowerCase()
}

function requestEndpoint(value: string) {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname}`
  } catch {
    return value
  }
}

function keyName(event: CaptureEvent) {
  const keyCode = event.keyCode
  if (keyCode === undefined) return '按键'
  if (process.platform === 'darwin') return macKeyNames[keyCode] || `Key ${keyCode}`
  return windowsKeyNames[keyCode]
    || (keyCode >= 48 && keyCode <= 90 ? String.fromCharCode(keyCode) : undefined)
    || `Key ${keyCode}`
}

function shortcutName(event: CaptureEvent) {
  const modifiers = event.modifiers ?? 0
  const parts: string[] = []
  // macOS CGEventFlags and Windows Forms Keys use different, overlapping masks.
  if (process.platform === 'darwin') {
    const hasCommand = (modifiers & (1 << 20)) !== 0
    const hasControl = (modifiers & (1 << 18)) !== 0
    if (!hasCommand && !hasControl) return undefined
    if (hasCommand) parts.push('⌘')
    if (hasControl) parts.push('⌃')
    if ((modifiers & (1 << 19)) !== 0) parts.push('⌥')
    if ((modifiers & (1 << 17)) !== 0) parts.push('⇧')
  } else {
    const hasControl = (modifiers & 0x20000) !== 0
    const hasAlt = (modifiers & 0x40000) !== 0
    if (!hasControl && !hasAlt) return undefined
    if (hasControl) parts.push('Ctrl+')
    if (hasAlt) parts.push('Alt+')
    if ((modifiers & 0x10000) !== 0) parts.push('Shift+')
  }
  return parts.length > 0 ? `${parts.join('')}${keyName(event)}` : undefined
}

function createInferenceNode(event: CaptureEvent): InferenceNode | undefined {
  const app = applicationName(event)
  const occurredAt = eventTimestamp(event)
  const target = targetName(event)
  const base = {
    id: '',
    app,
    occurredAt,
    sampleCount: 1,
  }

  if (event.eventType === 'browser-navigation' && event.page?.url) {
    return {
      ...base,
      label: `打开 ${requestEndpoint(event.page.url)}`,
      detail: '浏览器页面导航',
      kind: 'action',
      confidence: 98,
      sourceType: 'navigation',
    }
  }

  if (event.eventType === 'browser-click' || event.eventType === 'browser-change' || event.eventType === 'browser-submit') {
    const action = event.eventType === 'browser-change'
      ? '修改'
      : event.eventType === 'browser-submit'
        ? '提交'
        : '点击'
    return {
      ...base,
      label: `在浏览器中${action}${target}`,
      detail: event.target?.identifier ? `DOM 选择器：${event.target.identifier}` : `目标：${target}`,
      kind: 'action',
      confidence: event.target?.identifier ? 97 : 88,
      sourceType: 'browser-action',
    }
  }

  if (event.eventType === 'network-request' && event.network?.phase === 'request') {
    const method = event.network.method.toUpperCase()
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return undefined
    return {
      ...base,
      label: `${method} ${requestEndpoint(event.network.url)}`,
      detail: event.network.initiatorEventId ? '已关联到前序浏览器操作' : '检测到业务变更请求',
      kind: 'http',
      confidence: event.network.initiatorEventId ? 99 : 94,
      sourceType: 'network',
      networkRequestId: event.network.requestId,
      http: {
        method,
        url: event.network.url,
        headers: event.network.headers,
        body: event.network.postData,
        resourceType: event.network.resourceType,
      },
    }
  }

  if (event.eventType === 'application-activated') {
    return {
      ...base,
      label: `切换到 ${app}`,
      detail: '检测到前台应用切换',
      kind: 'action',
      confidence: 98,
      sourceType: 'application',
    }
  }

  if (event.eventType === 'scroll') {
    return {
      ...base,
      label: `在 ${app} 中滚动`,
      detail: `浏览 ${target}`,
      kind: 'action',
      confidence: event.target ? 92 : 84,
      sourceType: 'scroll',
    }
  }

  if (event.eventType === 'key-down') {
    const shortcut = shortcutName(event)
    if (shortcut) {
      return {
        ...base,
        label: `在 ${app} 中使用快捷键 ${shortcut}`,
        detail: `焦点位于${target}；未记录输入内容`,
        kind: 'action',
        confidence: event.target ? 94 : 88,
        sourceType: 'shortcut',
      }
    }
    return {
      ...base,
      label: `在 ${app} 中输入`,
      detail: `焦点位于${target}；输入内容未记录`,
      kind: 'action',
      confidence: event.target ? 90 : 82,
      sourceType: 'typing',
    }
  }

  if (event.eventType.startsWith('mouse-')) {
    const action = event.eventType === 'mouse-right-down'
      ? '右键点击'
      : Number(event.attributes.clickState) >= 2
        ? '双击'
        : '点击'
    return {
      ...base,
      label: `在 ${app} 中${action}${target}`,
      detail: event.target?.identifier ? `控件标识：${event.target.identifier}` : `目标：${target}`,
      kind: 'action',
      confidence: event.target ? 95 : 84,
      sourceType: 'click',
    }
  }

  return undefined
}

function compactEvents(events: CaptureEvent[]) {
  const nodes: InferenceNode[] = []

  for (const event of events.slice(-MAX_INFERENCE_EVENTS)) {
    if (event.eventType === 'network-response' && event.network?.phase === 'response') {
      const requestNode = [...nodes].reverse().find((node) => node.networkRequestId === event.network?.requestId)
      if (requestNode?.http && event.network.status !== undefined) {
        requestNode.http.expectedStatus = event.network.status
        requestNode.detail = `${requestNode.detail || '业务请求'}；响应 ${event.network.status}`
      }
      continue
    }
    const node = createInferenceNode(event)
    if (!node) continue
    const previous = nodes.at(-1)
    const elapsed = previous ? node.occurredAt - previous.occurredAt : Number.POSITIVE_INFINITY

    if (
      previous
      && previous.sourceType === node.sourceType
      && previous.app === node.app
      && ((node.sourceType === 'typing' && elapsed < 2_000) || (node.sourceType === 'scroll' && elapsed < 1_500))
    ) {
      previous.occurredAt = node.occurredAt
      previous.sampleCount += 1
      previous.detail = node.sourceType === 'typing'
        ? `${previous.sampleCount} 次按键；输入内容未记录`
        : `${previous.sampleCount} 次连续滚动`
      continue
    }

    if (previous?.sourceType === 'application' && node.sourceType === 'application' && previous.app === node.app) {
      previous.occurredAt = node.occurredAt
      continue
    }

    nodes.push(node)
  }

  return nodes.slice(-MAX_WORKFLOW_NODES)
}

export function inferWorkflow(
  sessionId: string,
  events: CaptureEvent[],
  state: CaptureWorkflowState,
): Workflow | undefined {
  const inferred = compactEvents(events)
  if (inferred.length < 2) return undefined

  const nodes: WorkflowNode[] = []
  let previousTime: number | undefined
  for (const node of inferred) {
    if (previousTime !== undefined && node.occurredAt - previousTime >= WAIT_THRESHOLD_MS) {
      const seconds = Math.max(5, Math.round((node.occurredAt - previousTime) / 1_000))
      nodes.push({
        id: `node-${nodes.length + 1}`,
        label: `等待 ${seconds} 秒`,
        detail: '两次操作之间的停顿',
        kind: 'wait',
        confidence: 100,
      })
    }
    nodes.push({
      id: `node-${nodes.length + 1}`,
      label: node.label,
      detail: node.detail,
      kind: node.kind,
      app: node.app,
      confidence: node.confidence,
      http: node.http,
    })
    previousTime = node.occurredAt
  }

  // A manually started capture is one workflow draft. Similar sessions must stay
  // independent so the user can edit and save each intent separately.
  const id = `workflow-${hash(sessionId, 16)}`
  const apps = Array.from(new Set(inferred.map((node) => node.app).filter(Boolean)))
  const actionCount = inferred.filter((node) => node.sourceType !== 'application').length
  const requestCount = inferred.filter((node) => node.sourceType === 'network').length
  const scenario: CaptureScenario = events.some((event) => event.source?.startsWith('browser')) ? 'browser' : 'desktop'
  const name = apps.length === 1
    ? `${apps[0]} 操作流程`
    : apps.length === 2
      ? `${apps[0]} → ${apps[1]} 工作流`
      : `${apps[0]} 等 ${apps.length} 个应用工作流`
  const startedAt = new Date(Math.min(...events.map(eventTimestamp))).toISOString()
  const updatedAt = new Date(Math.max(...events.map(eventTimestamp))).toISOString()
  const durationMs = Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt))
  const averageConfidence = Math.round(
    nodes.reduce((total, node) => total + node.confidence, 0) / Math.max(1, nodes.length),
  )

  return {
    id,
    name,
    summary: scenario === 'browser'
      ? `${actionCount} 个有效操作，包含 ${requestCount} 个可复现业务请求；敏感凭据已替换为运行时引用。`
      : `${actionCount} 个有效操作，涉及 ${apps.join('、')}；输入内容已隐藏，仅保留界面语义。`,
    repeatCount: 1,
    estimatedMinutes: Math.max(1, Math.ceil(durationMs / 60_000)),
    confidence: averageConfidence,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id })),
    capture: {
      sessionIds: [sessionId],
      startedAt,
      updatedAt,
      eventCount: events.length,
      state,
      scenario,
    },
  }
}

function isWorkflow(value: unknown): value is Workflow {
  if (!value || typeof value !== 'object') return false
  const workflow = value as Partial<Workflow>
  return typeof workflow.id === 'string'
    && typeof workflow.name === 'string'
    && Array.isArray(workflow.nodes)
    && Array.isArray(workflow.edges)
}

function stateFromRecorder(state: RecorderState): CaptureWorkflowState {
  if (state === 'observing') return 'recording'
  if (state === 'paused') return 'paused'
  if (state === 'interrupted') return 'interrupted'
  return 'completed'
}

export class CaptureRepository {
  private readonly getRootPath: () => string
  private readonly onWorkflowsChanged?: () => void
  private readonly sessions = new Map<string, CaptureSession>()
  private activeSessionIds: Partial<Record<CaptureScenario, string>> = {}

  constructor(options: CaptureRepositoryOptions) {
    this.getRootPath = options.getRootPath
    this.onWorkflowsChanged = options.onWorkflowsChanged
  }

  handleRecorderEnvelope(envelope: RecorderEnvelope) {
    this.handleCaptureEnvelope(envelope, 'desktop')
  }

  handleBrowserCaptureEnvelope(envelope: BrowserCaptureEnvelope) {
    this.handleCaptureEnvelope(envelope, 'browser')
  }

  private handleCaptureEnvelope(
    envelope: RecorderEnvelope | BrowserCaptureEnvelope,
    scenario: CaptureScenario,
  ) {
    if (envelope.type === 'capture-event') {
      this.activeSessionIds[scenario] = envelope.payload.sessionId
      this.persistEvent(envelope.payload, scenario)
      return
    }

    if (envelope.type !== 'status') return
    const nextState = scenario === 'browser'
      ? envelope.payload.state === 'capturing'
        ? 'recording'
        : envelope.payload.state === 'interrupted'
          ? 'interrupted'
          : 'completed'
      : stateFromRecorder(envelope.payload.state as RecorderState)
    if (envelope.payload.sessionId) this.activeSessionIds[scenario] = envelope.payload.sessionId
    const sessionId = envelope.payload.sessionId || this.activeSessionIds[scenario]
    if (!sessionId) return

    const session = this.getOrLoadSession(sessionId, true, scenario)
    session.state = nextState
    if (nextState !== 'recording') {
      this.flushSession(sessionId)
      if (nextState === 'completed' || nextState === 'interrupted') this.activeSessionIds[scenario] = undefined
    }
  }

  loadWorkflows() {
    this.rebuildStaleCaptureFiles()
    const workflows = this.readWorkflowFiles()
    const dismissed = this.readDismissedIndex()
    return workflows.filter((workflow) => {
      const sessionIds = workflow.capture?.sessionIds ?? []
      return !dismissed.workflowIds.includes(workflow.id)
        && !sessionIds.some((sessionId) => dismissed.sessionIds.includes(sessionId))
    }).sort((a, b) => {
      const aTime = Date.parse(a.capture?.updatedAt || '') || 0
      const bTime = Date.parse(b.capture?.updatedAt || '') || 0
      return bTime - aTime
    })
  }

  updateWorkflow(workflow: Workflow) {
    if (!isWorkflow(workflow) || workflow.nodes.length === 0) return false
    const nodeIds = new Set(workflow.nodes.map((node) => node.id))
    if (nodeIds.size !== workflow.nodes.length) return false
    if (workflow.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) return false

    const sessionId = workflow.capture?.sessionIds[0]
    if (!sessionId) return false
    const canonical: Workflow = {
      ...workflow,
      id: `workflow-${hash(sessionId, 16)}`,
      repeatCount: 1,
    }
    const root = this.getRootPath()
    ensureDirectories(root)
    this.writeJsonAtomically(
      path.join(root, 'workflows', `${captureFileKey(sessionId)}.json`),
      canonical,
    )
    this.onWorkflowsChanged?.()
    return true
  }

  loadRecentEvents(requestedLimit = 200) {
    const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    const root = this.getRootPath()
    ensureDirectories(root)
    const capturesDirectory = path.join(root, 'captures')
    const files = readdirSync(capturesDirectory)
      .filter((filename) => filename.endsWith('.ndjson'))
      .map((filename) => {
        const filePath = path.join(capturesDirectory, filename)
        try {
          return { filePath, modifiedAt: statSync(filePath).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is { filePath: string; modifiedAt: number } => Boolean(entry))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)

    const events: CaptureEvent[] = []
    for (const { filePath } of files) {
      try {
        const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/).slice(-limit)
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as CaptureEvent
            if (event?.id && event.sessionId && typeof event.eventType === 'string') events.push(event)
          } catch {}
        }
      } catch {}
      if (events.length >= limit * 2) break
    }

    return events
      .sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
      .slice(0, limit)
  }

  dismissWorkflow(workflowId: string) {
    if (!workflowId) return false
    const workflow = this.loadWorkflows().find((item) => item.id === workflowId)
    const dismissed = this.readDismissedIndex()
    dismissed.workflowIds = Array.from(new Set([...dismissed.workflowIds, workflowId]))
    dismissed.sessionIds = Array.from(new Set([
      ...dismissed.sessionIds,
      ...(workflow?.capture?.sessionIds ?? []),
    ]))
    this.writeDismissedIndex(dismissed)
    this.onWorkflowsChanged?.()
    return true
  }

  shutdown() {
    for (const [sessionId, session] of this.sessions) {
      if (session.state === 'recording') session.state = 'interrupted'
      this.flushSession(sessionId)
    }
  }

  private persistEvent(event: CaptureEvent, scenario: CaptureScenario) {
    const root = this.getRootPath()
    ensureDirectories(root)
    const filePath = path.join(root, 'captures', `${captureFileKey(event.sessionId)}.ndjson`)
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8')

    const session = this.getOrLoadSession(event.sessionId, false, scenario)
    session.state = 'recording'
    session.scenario = scenario
    session.events.push(event)
    if (session.events.length > MAX_INFERENCE_EVENTS) {
      session.events.splice(0, session.events.length - MAX_INFERENCE_EVENTS)
    }
  }

  private flushSession(sessionId: string) {
    const session = this.getOrLoadSession(sessionId)
    const workflow = inferWorkflow(sessionId, session.events, session.state)
    if (!workflow) return

    const root = this.getRootPath()
    ensureDirectories(root)
    const filePath = path.join(root, 'workflows', `${captureFileKey(sessionId)}.json`)
    this.writeJsonAtomically(filePath, workflow)
    this.onWorkflowsChanged?.()
  }

  private getOrLoadSession(sessionId: string, loadFromDisk = true, scenario: CaptureScenario = 'desktop') {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const session: CaptureSession = {
      events: loadFromDisk ? this.readCaptureEvents(sessionId) : [],
      state: 'recording',
      scenario,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  private readCaptureEvents(sessionId: string) {
    const filePath = path.join(this.getRootPath(), 'captures', `${captureFileKey(sessionId)}.ndjson`)
    if (!existsSync(filePath)) return []
    try {
      const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/).slice(-MAX_INFERENCE_EVENTS)
      const events: CaptureEvent[] = []
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as CaptureEvent
          if (event?.sessionId === sessionId && typeof event.eventType === 'string') events.push(event)
        } catch {}
      }
      return events
    } catch {
      return []
    }
  }

  private rebuildStaleCaptureFiles() {
    const root = this.getRootPath()
    ensureDirectories(root)
    const capturesDir = path.join(root, 'captures')
    for (const filename of readdirSync(capturesDir)) {
      if (!filename.endsWith('.ndjson')) continue
      const capturePath = path.join(capturesDir, filename)
      const workflowPath = path.join(root, 'workflows', `${path.basename(filename, '.ndjson')}.json`)
      try {
        if (existsSync(workflowPath) && statSync(workflowPath).mtimeMs >= statSync(capturePath).mtimeMs) continue
        const lines = readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).slice(-MAX_INFERENCE_EVENTS)
        const events: CaptureEvent[] = []
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as CaptureEvent
            if (event?.sessionId && typeof event.eventType === 'string') events.push(event)
          } catch {}
        }
        const sessionId = events[0]?.sessionId
        if (!sessionId) continue
        const workflow = inferWorkflow(sessionId, events, 'interrupted')
        if (workflow) this.writeJsonAtomically(workflowPath, workflow)
      } catch {}
    }
  }

  private readWorkflowFiles() {
    const root = this.getRootPath()
    ensureDirectories(root)
    const workflows: Workflow[] = []
    for (const filename of readdirSync(path.join(root, 'workflows'))) {
      if (!filename.endsWith('.json') || filename.startsWith('.')) continue
      try {
        const workflow = JSON.parse(readFileSync(path.join(root, 'workflows', filename), 'utf8')) as unknown
        if (isWorkflow(workflow)) {
          const sessionId = workflow.capture?.sessionIds[0]
          workflows.push(sessionId ? {
            ...workflow,
            id: `workflow-${hash(sessionId, 16)}`,
            repeatCount: 1,
          } : workflow)
        }
      } catch {}
    }
    return workflows
  }

  private readDismissedIndex(): DismissedWorkflowIndex {
    const filePath = path.join(this.getRootPath(), 'workflows', '.dismissed.json')
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DismissedWorkflowIndex>
      return {
        workflowIds: Array.isArray(parsed.workflowIds) ? parsed.workflowIds.filter((id): id is string => typeof id === 'string') : [],
        sessionIds: Array.isArray(parsed.sessionIds) ? parsed.sessionIds.filter((id): id is string => typeof id === 'string') : [],
      }
    } catch {
      return { workflowIds: [], sessionIds: [] }
    }
  }

  private writeDismissedIndex(index: DismissedWorkflowIndex) {
    const root = this.getRootPath()
    ensureDirectories(root)
    this.writeJsonAtomically(path.join(root, 'workflows', '.dismissed.json'), index)
  }

  private writeJsonAtomically(filePath: string, value: unknown) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temporaryPath, filePath)
  }
}
