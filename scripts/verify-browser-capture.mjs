import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  sanitizeBrowserBody,
  sanitizeBrowserHeaders,
  sanitizeBrowserUrl,
} from '../apps/desktop/electron/browser-capture-privacy.ts'
import { CaptureRepository, inferWorkflow } from '../apps/desktop/electron/capture-repository.ts'

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'trace-browser-capture-test-'))
const sessionId = 'browser-integration-session'
const base = Date.now()

const headers = sanitizeBrowserHeaders({
  Authorization: 'Bearer top-secret',
  Cookie: 'session=private',
  'Content-Type': 'application/json',
  'X-Shop-Id': 'shop-42',
})
const body = sanitizeBrowserBody(JSON.stringify({
  productId: 123,
  price: 99,
  password: 'should-never-persist',
  nested: { csrfToken: 'also-private' },
}), headers)
const requestUrl = sanitizeBrowserUrl('https://admin.example.com/api/products/123?token=private&locale=zh-CN#editor')

assert.equal(headers.authorization, '${secret:authorization}')
assert.equal(headers.cookie, '${secret:cookie}')
assert.equal(headers['x-shop-id'], 'shop-42')
assert.ok(body?.includes('"price":99'))
assert.ok(body?.includes('${secret:password}'))
assert.ok(!body?.includes('should-never-persist'))
assert.ok(!requestUrl.includes('private'))
assert.ok(!requestUrl.includes('#editor'))

const event = (offset, eventType, extra = {}) => ({
  id: `${sessionId}-${offset}-${eventType}`,
  occurredAt: new Date(base + offset).toISOString(),
  sessionId,
  applicationId: 'trace.browser',
  applicationName: 'Trace Browser',
  source: eventType.startsWith('network-') ? 'browser-network' : 'browser-dom',
  eventType,
  attributes: {},
  ...extra,
})

const events = [
  event(0, 'browser-navigation', { page: { url: 'https://admin.example.com/products/123' } }),
  event(500, 'browser-click', {
    target: { role: 'button', identifier: 'button[data-testid="save-product"]' },
    page: { url: 'https://admin.example.com/products/123' },
  }),
  event(650, 'network-request', {
    page: { url: 'https://admin.example.com/products/123' },
    network: {
      phase: 'request',
      requestId: 'request-1',
      method: 'PATCH',
      url: requestUrl,
      resourceType: 'Fetch',
      initiatorEventId: `${sessionId}-500-browser-click`,
      headers,
      postData: body,
    },
  }),
  event(900, 'network-response', {
    page: { url: 'https://admin.example.com/products/123' },
    network: {
      phase: 'response',
      requestId: 'request-1',
      method: 'PATCH',
      url: requestUrl,
      resourceType: 'Fetch',
      headers: { 'content-type': 'application/json' },
      status: 200,
    },
  }),
]

try {
  const inferred = inferWorkflow(sessionId, events, 'completed')
  assert.ok(inferred)
  assert.equal(inferred.capture?.scenario, 'browser')
  const httpNode = inferred.nodes.find((node) => node.kind === 'http')
  assert.ok(httpNode?.http)
  assert.equal(httpNode.http.method, 'PATCH')
  assert.equal(httpNode.http.expectedStatus, 200)
  assert.equal(httpNode.http.headers.authorization, '${secret:authorization}')
  assert.ok(httpNode.http.body?.includes('"productId":123'))

  const repository = new CaptureRepository({ getRootPath: () => temporaryRoot })
  repository.handleBrowserCaptureEnvelope({
    protocolVersion: 1,
    type: 'status',
    timestamp: new Date(base).toISOString(),
    payload: {
      protocolVersion: 1,
      scenario: 'browser',
      state: 'capturing',
      sessionId,
      eventCount: 0,
      requestCount: 0,
      timestamp: new Date(base).toISOString(),
    },
  })
  for (const payload of events) {
    repository.handleBrowserCaptureEnvelope({
      protocolVersion: 1,
      type: 'capture-event',
      timestamp: payload.occurredAt,
      payload,
    })
  }
  repository.handleBrowserCaptureEnvelope({
    protocolVersion: 1,
    type: 'status',
    timestamp: new Date(base + 1_000).toISOString(),
    payload: {
      protocolVersion: 1,
      scenario: 'browser',
      state: 'idle',
      eventCount: events.length,
      requestCount: 1,
      timestamp: new Date(base + 1_000).toISOString(),
    },
  })

  const workflows = repository.loadWorkflows()
  assert.equal(workflows.length, 1)
  assert.equal(workflows[0].capture?.scenario, 'browser')
  assert.ok(workflows[0].nodes.some((node) => node.kind === 'http'))

  const captureFile = path.join(temporaryRoot, 'captures', readdirSync(path.join(temporaryRoot, 'captures'))[0])
  const persisted = readFileSync(captureFile, 'utf8')
  assert.ok(!persisted.includes('top-secret'))
  assert.ok(!persisted.includes('should-never-persist'))
  assert.ok(persisted.includes('${secret:authorization}'))

  console.log(`Browser capture OK: ${events.length} events -> ${inferred.nodes.length} steps -> 1 replayable HTTP node`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
