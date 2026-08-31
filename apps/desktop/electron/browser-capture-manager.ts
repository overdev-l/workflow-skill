import { BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  BrowserCaptureCommand,
  BrowserCaptureEnvelope,
  BrowserCaptureStatus,
  CaptureEvent,
  NetworkCapture,
} from '@workflow-skill/capture-protocol'
import {
  normalizeBrowserCaptureUrl,
  sanitizeBrowserBody,
  sanitizeBrowserHeaders,
  sanitizeBrowserUrl,
} from './browser-capture-privacy'

const TRACE_BINDING = '__traceCaptureEvent'
const USER_EVENT_LINK_WINDOW_MS = 5_000
const CAPTURED_RESOURCE_TYPES = new Set(['Document', 'XHR', 'Fetch'])

interface BrowserDomPayload {
  kind?: string
  url?: string
  title?: string
  selector?: string
  role?: string
  subrole?: string
  label?: string
  tagName?: string
  inputType?: string
  x?: number
  y?: number
  bounds?: { x: number; y: number; width: number; height: number }
}

interface RequestMetadata {
  method: string
  url: string
  resourceType?: string
  documentUrl?: string
  occurredAt: number
}

const emptyStatus = (): BrowserCaptureStatus => ({
  protocolVersion: 1,
  scenario: 'browser',
  state: 'idle',
  eventCount: 0,
  requestCount: 0,
  timestamp: new Date().toISOString(),
})

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

const browserInstrumentation = `(() => {
  if (globalThis.__traceBrowserCaptureInstalled) return;
  globalThis.__traceBrowserCaptureInstalled = true;

  const escapePart = (value) => {
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (part) => String.fromCharCode(92) + part);
  };
  const elementFrom = (target) => target instanceof Element ? target : target && target.parentElement;
  const selectorFor = (element) => {
    if (!element) return '';
    if (element.id) return '#' + escapePart(element.id);
    for (const attribute of ['data-testid', 'data-test', 'data-qa']) {
      const value = element.getAttribute(attribute);
      if (value) return element.tagName.toLowerCase() + '[' + attribute + '=' + JSON.stringify(String(value)) + ']';
    }
    if (element.getAttribute('name')) {
      return element.tagName.toLowerCase() + '[name=' + JSON.stringify(String(element.getAttribute('name'))) + ']';
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const describe = (kind, rawTarget, sourceEvent) => {
    try {
      const element = elementFrom(rawTarget);
      if (!element || typeof globalThis[${JSON.stringify(TRACE_BINDING)}] !== 'function') return;
      const rect = element.getBoundingClientRect();
      const label = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.getAttribute('alt')
        || element.getAttribute('placeholder')
        || element.getAttribute('name')
        || String(element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160);
      globalThis[${JSON.stringify(TRACE_BINDING)}](JSON.stringify({
        kind,
        url: location.href,
        title: document.title,
        selector: selectorFor(element),
        role: element.getAttribute('role') || element.tagName.toLowerCase(),
        subrole: element instanceof HTMLInputElement ? element.type : undefined,
        label,
        tagName: element.tagName.toLowerCase(),
        inputType: element instanceof HTMLInputElement ? element.type : undefined,
        x: sourceEvent && typeof sourceEvent.clientX === 'number' ? sourceEvent.clientX : undefined,
        y: sourceEvent && typeof sourceEvent.clientY === 'number' ? sourceEvent.clientY : undefined,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }));
    } catch {}
  };
  document.addEventListener('click', (event) => describe('click', event.target, event), true);
  document.addEventListener('change', (event) => describe('change', event.target, event), true);
  document.addEventListener('submit', (event) => describe('submit', event.submitter || event.target, event), true);
})();`

export class BrowserCaptureManager extends EventEmitter {
  private browserWindow?: BrowserWindow
  private status: BrowserCaptureStatus = emptyStatus()
  private requestMetadata = new Map<string, RequestMetadata>()
  private lastUserEvent?: { id: string; occurredAt: number }
  private stopping = false

  getStatus() {
    return { ...this.status }
  }

  ownsWindow(window: BrowserWindow) {
    return this.browserWindow?.id === window.id
  }

  async command(command: BrowserCaptureCommand) {
    if (command.type === 'start') await this.start(command.sessionId, command.url)
    if (command.type === 'stop') await this.stop()
    if (command.type === 'status') this.emitStatus()
    return this.getStatus()
  }

  async shutdown() {
    await this.stop()
  }

  private async start(sessionId: string, rawUrl: string) {
    if (this.status.state === 'capturing') await this.stop()
    const url = normalizeBrowserCaptureUrl(rawUrl)
    this.stopping = false
    this.requestMetadata.clear()
    this.lastUserEvent = undefined
    this.status = {
      protocolVersion: 1,
      scenario: 'browser',
      state: 'capturing',
      sessionId,
      pageUrl: url,
      eventCount: 0,
      requestCount: 0,
      timestamp: new Date().toISOString(),
    }

    const captureWindow = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 520,
      title: 'Trace Browser Capture',
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: 'persist:trace-browser-capture',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.browserWindow = captureWindow
    captureWindow.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
      if (this.status.state === 'capturing') void captureWindow.loadURL(nextUrl)
      return { action: 'deny' }
    })
    captureWindow.once('ready-to-show', () => captureWindow.show())
    captureWindow.on('closed', () => {
      this.browserWindow = undefined
      if (!this.stopping && this.status.state === 'capturing') this.finish('idle')
    })
    captureWindow.webContents.on('page-title-updated', (_event, title) => {
      this.status = { ...this.status, pageTitle: title, timestamp: new Date().toISOString() }
    })
    captureWindow.webContents.on('render-process-gone', (_event, details) => {
      if (this.stopping) return
      this.emitError('browser_renderer_gone', `Browser capture renderer stopped: ${details.reason}`, true)
      this.finish('interrupted')
    })

    try {
      captureWindow.webContents.debugger.attach('1.3')
      captureWindow.webContents.debugger.on('message', (_event, method, params) => {
        void this.handleDebuggerMessage(method, params as Record<string, unknown>)
      })
      await captureWindow.webContents.debugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 10_000_000,
        maxResourceBufferSize: 1_000_000,
      })
      await captureWindow.webContents.debugger.sendCommand('Page.enable')
      await captureWindow.webContents.debugger.sendCommand('Runtime.enable')
      await captureWindow.webContents.debugger.sendCommand('Runtime.addBinding', { name: TRACE_BINDING })
      await captureWindow.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: browserInstrumentation,
      })
      await captureWindow.webContents.debugger.sendCommand('Runtime.evaluate', { expression: browserInstrumentation })
      this.emitStatus()
      await captureWindow.loadURL(url)
    } catch (error) {
      this.emitError(
        'browser_capture_start_failed',
        error instanceof Error ? error.message : 'Unable to start browser capture',
        true,
      )
      this.finish('interrupted')
      if (!captureWindow.isDestroyed()) captureWindow.close()
    }
  }

  private async stop() {
    if (this.status.state === 'idle' && !this.browserWindow) return
    this.stopping = true
    const captureWindow = this.browserWindow
    this.browserWindow = undefined
    if (captureWindow && !captureWindow.isDestroyed()) {
      if (captureWindow.webContents.debugger.isAttached()) captureWindow.webContents.debugger.detach()
      captureWindow.close()
    }
    this.finish('idle')
    this.stopping = false
  }

  private finish(state: 'idle' | 'interrupted') {
    this.requestMetadata.clear()
    this.lastUserEvent = undefined
    this.status = {
      ...this.status,
      state,
      sessionId: undefined,
      timestamp: new Date().toISOString(),
    }
    this.emitStatus()
  }

  private async handleDebuggerMessage(method: string, params: Record<string, unknown>) {
    if (this.status.state !== 'capturing' || !this.status.sessionId) return
    if (method === 'Runtime.bindingCalled') {
      if (params.name !== TRACE_BINDING || typeof params.payload !== 'string') return
      this.handleDomEvent(params.payload)
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as Record<string, unknown> | undefined
      if (!frame || frame.parentId || typeof frame.url !== 'string' || !/^https?:/i.test(frame.url)) return
      this.status = { ...this.status, pageUrl: frame.url, timestamp: new Date().toISOString() }
      this.emitCaptureEvent({
        eventType: 'browser-navigation',
        source: 'browser-dom',
        page: { url: sanitizeBrowserUrl(frame.url), frameId: typeof frame.id === 'string' ? frame.id : undefined },
        attributes: { url: sanitizeBrowserUrl(frame.url) },
      })
      return
    }
    if (method === 'Page.navigatedWithinDocument') {
      if (typeof params.url !== 'string') return
      this.status = { ...this.status, pageUrl: params.url, timestamp: new Date().toISOString() }
      this.emitCaptureEvent({
        eventType: 'browser-navigation',
        source: 'browser-dom',
        page: { url: sanitizeBrowserUrl(params.url), frameId: typeof params.frameId === 'string' ? params.frameId : undefined },
        attributes: { url: sanitizeBrowserUrl(params.url) },
      })
      return
    }
    if (method === 'Network.requestWillBeSent') this.handleNetworkRequest(params)
    if (method === 'Network.responseReceived') this.handleNetworkResponse(params)
  }

  private handleDomEvent(rawPayload: string) {
    let payload: BrowserDomPayload
    try {
      payload = JSON.parse(rawPayload) as BrowserDomPayload
    } catch {
      return
    }
    if (!payload.kind || !['click', 'change', 'submit'].includes(payload.kind)) return
    const eventId = randomUUID()
    const occurredAt = Date.now()
    this.lastUserEvent = { id: eventId, occurredAt }
    this.emitCaptureEvent({
      id: eventId,
      occurredAt: new Date(occurredAt).toISOString(),
      eventType: `browser-${payload.kind}`,
      source: 'browser-dom',
      pointer: typeof payload.x === 'number' && typeof payload.y === 'number'
        ? { x: payload.x, y: payload.y }
        : undefined,
      target: {
        role: payload.role,
        subrole: payload.subrole,
        identifier: payload.selector?.slice(0, 1_024),
        labelHash: payload.label ? sha256(payload.label) : undefined,
        bounds: payload.bounds,
      },
      page: {
        url: sanitizeBrowserUrl(payload.url || this.status.pageUrl || ''),
        titleHash: payload.title ? sha256(payload.title) : undefined,
      },
      attributes: {
        tagName: payload.tagName || '',
        inputType: payload.inputType || '',
      },
    })
  }

  private handleNetworkRequest(params: Record<string, unknown>) {
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
    const resourceType = typeof params.type === 'string' ? params.type : undefined
    const request = params.request as Record<string, unknown> | undefined
    if (!requestId || !request || !resourceType || !CAPTURED_RESOURCE_TYPES.has(resourceType)) return
    if (typeof request.url !== 'string' || !/^https?:/i.test(request.url)) return
    const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET'
    const headers = sanitizeBrowserHeaders(request.headers)
    const occurredAt = Date.now()
    const documentUrl = typeof params.documentURL === 'string' ? sanitizeBrowserUrl(params.documentURL) : undefined
    const initiator = params.initiator as Record<string, unknown> | undefined
    const linkedEvent = this.lastUserEvent && occurredAt - this.lastUserEvent.occurredAt <= USER_EVENT_LINK_WINDOW_MS
      ? this.lastUserEvent.id
      : undefined
    const network: NetworkCapture = {
      phase: 'request',
      requestId,
      method,
      url: sanitizeBrowserUrl(request.url),
      resourceType,
      documentUrl,
      initiatorType: typeof initiator?.type === 'string' ? initiator.type : undefined,
      initiatorEventId: linkedEvent,
      headers,
      postData: sanitizeBrowserBody(request.postData, headers),
    }
    this.requestMetadata.set(requestId, {
      method,
      url: network.url,
      resourceType,
      documentUrl,
      occurredAt,
    })
    this.status = { ...this.status, requestCount: this.status.requestCount + 1 }
    this.emitCaptureEvent({
      occurredAt: new Date(occurredAt).toISOString(),
      eventType: 'network-request',
      source: 'browser-network',
      page: { url: documentUrl || sanitizeBrowserUrl(this.status.pageUrl || request.url) },
      network,
      attributes: {
        method,
        host: new URL(request.url).host,
        resourceType,
      },
    })
  }

  private handleNetworkResponse(params: Record<string, unknown>) {
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
    const response = params.response as Record<string, unknown> | undefined
    if (!requestId || !response) return
    const request = this.requestMetadata.get(requestId)
    if (!request || typeof response.url !== 'string') return
    const status = typeof response.status === 'number' ? response.status : undefined
    const network: NetworkCapture = {
      phase: 'response',
      requestId,
      method: request.method,
      url: sanitizeBrowserUrl(response.url),
      resourceType: request.resourceType,
      documentUrl: request.documentUrl,
      headers: sanitizeBrowserHeaders(response.headers),
      status,
      statusText: typeof response.statusText === 'string' ? response.statusText.slice(0, 256) : undefined,
      mimeType: typeof response.mimeType === 'string' ? response.mimeType : undefined,
      fromDiskCache: response.fromDiskCache === true,
      fromServiceWorker: response.fromServiceWorker === true,
    }
    this.emitCaptureEvent({
      eventType: 'network-response',
      source: 'browser-network',
      page: { url: request.documentUrl || sanitizeBrowserUrl(this.status.pageUrl || response.url) },
      network,
      attributes: {
        method: request.method,
        status: status === undefined ? '' : String(status),
        mimeType: network.mimeType || '',
      },
    })
  }

  private emitCaptureEvent(event: Partial<CaptureEvent> & Pick<CaptureEvent, 'eventType' | 'attributes'>) {
    const sessionId = this.status.sessionId
    if (!sessionId) return
    const payload: CaptureEvent = {
      id: event.id || randomUUID(),
      occurredAt: event.occurredAt || new Date().toISOString(),
      sessionId,
      applicationId: 'trace.browser',
      applicationName: 'Trace Browser',
      eventType: event.eventType,
      pointer: event.pointer,
      target: event.target,
      source: event.source,
      page: event.page,
      network: event.network,
      attributes: event.attributes,
    }
    this.status = {
      ...this.status,
      eventCount: this.status.eventCount + 1,
      pageUrl: payload.page?.url || this.status.pageUrl,
      pageTitle: payload.page?.title || this.status.pageTitle,
      timestamp: payload.occurredAt,
    }
    this.emitEnvelope({ protocolVersion: 1, type: 'capture-event', timestamp: payload.occurredAt, payload })
  }

  private emitStatus() {
    this.emitEnvelope({
      protocolVersion: 1,
      type: 'status',
      timestamp: this.status.timestamp,
      payload: { ...this.status },
    })
  }

  private emitError(code: string, message: string, recoverable: boolean) {
    this.emitEnvelope({
      protocolVersion: 1,
      type: 'error',
      timestamp: new Date().toISOString(),
      payload: { code, message, recoverable },
    })
  }

  private emitEnvelope(envelope: BrowserCaptureEnvelope) {
    this.emit('message', envelope)
  }
}
