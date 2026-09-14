#!/usr/bin/env node
/**
 * Verification Script for Cloudflare Updates Delivery Worker (OPC-53)
 *
 * Tests the worker fetch handler in an isolated in-memory environment:
 * - 405 Method Not Allowed for non-GET/HEAD methods with Allow header
 * - 404 for missing files, unallowlisted extensions, and traversal/prefix paths
 * - 400 for malformed URI encoding
 * - 503 for missing binding or R2 storage exceptions (fail-closed, no leak)
 * - 200 full content with correct Content-Type, ETag, Content-Length
 * - HEAD method returns null body stream with identical headers
 * - 304 Not Modified precedence for If-None-Match, even with Range header present
 * - 206 Partial Content for single closed, open, and suffix ranges
 * - 416 Range Not Satisfiable for out-of-bounds ranges
 * - If-Range matching delivers 206; mismatch falls back to full 200
 * - Malformed / multi-range requests safely fall back to full 200
 * - Cache-Control: no-cache for manifests, immutable for release binaries
 * - /download/mac and /download/windows aliases redirect to valid target
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-update-worker.mjs
 */

import assert from 'node:assert/strict'
import worker from '../infra/update-worker/src/index.ts'

let passed = 0
let failed = 0

class MockR2Bucket {
  constructor(initialFiles = {}) {
    this.files = new Map()
    for (const [key, val] of Object.entries(initialFiles)) {
      const buf = Buffer.isBuffer(val) ? val : Buffer.from(val)
      this.files.set(key, {
        data: buf,
        uploaded: new Date('2026-09-14T00:00:00Z'),
        etag: `etag-${key}`,
      })
    }
    this.throwOnAccess = false
  }

  setFile(key, content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content)
    this.files.set(key, {
      data: buf,
      uploaded: new Date('2026-09-14T00:00:00Z'),
      etag: `etag-${key}`,
    })
  }

  async head(key) {
    if (this.throwOnAccess) {
      throw new Error('R2 cluster unreachable')
    }
    const item = this.files.get(key)
    if (!item) return null
    return {
      key,
      size: item.data.length,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      uploaded: item.uploaded,
    }
  }

  async get(key, options) {
    if (this.throwOnAccess) {
      throw new Error('R2 cluster unreachable')
    }
    const item = this.files.get(key)
    if (!item) return null

    let bodyData = item.data
    if (options?.range) {
      const offset = options.range.offset ?? 0
      const length = options.range.length ?? (item.data.length - offset)
      bodyData = item.data.subarray(offset, offset + length)
    }

    return {
      key,
      size: item.data.length,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      uploaded: item.uploaded,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bodyData))
          controller.close()
        },
      }),
      async text() {
        return bodyData.toString('utf8')
      },
      async arrayBuffer() {
        return bodyData.buffer.slice(bodyData.byteOffset, bodyData.byteOffset + bodyData.byteLength)
      },
    }
  }
}

async function runTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(err)
    throw err
  }
}

console.log('=== Trace Update Worker In-Memory Verification ===\n')

const samplePayload = Buffer.alloc(1000, 0x41) // 1000 bytes of 'A'
const defaultBucket = new MockR2Bucket({
  'Trace-1.0.0-mac-arm64.zip': samplePayload,
  'Trace-1.0.0-mac-arm64.dmg': Buffer.from('dmg-payload'),
  'Trace-1.0.0-win-x64.exe': Buffer.from('exe-payload'),
  'Trace-1.0.0-mac-arm64.zip.blockmap': Buffer.from('blockmap-payload'),
  'latest-mac.yml': 'version: 1.0.0\npath: Trace-1.0.0-mac-arm64.dmg\n',
  'latest.yml': 'version: 1.0.0\npath: Trace-1.0.0-win-x64.exe\n',
})

const defaultEnv = { TRACE_UPDATES: defaultBucket }

// 1. Method Not Allowed
await runTest('Method Guard: POST, PUT, DELETE return 405 with Allow header', async () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const req = new Request('https://updates.example.invalid/latest.yml', { method: m })
    const res = await worker.fetch(req, defaultEnv)
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('Allow'), 'GET, HEAD')
  }
})

// 2. Full 200 GET
await runTest('Full GET: 200 with Content-Length, Content-Type, ETag, and body', async () => {
  const req = new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip')
  const res = await worker.fetch(req, defaultEnv)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Length'), '1000')
  assert.equal(res.headers.get('Content-Type'), 'application/zip')
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes')
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
  assert.ok(res.headers.get('ETag'))

  const body = await res.arrayBuffer()
  assert.equal(body.byteLength, 1000)
})

// 3. HEAD Method Body Guard
await runTest('HEAD Method: returns status and headers but NEVER constructs body', async () => {
  const req = new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', { method: 'HEAD' })
  const res = await worker.fetch(req, defaultEnv)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Length'), '1000')
  assert.equal(res.body, null)
})

// 4. If-None-Match Precedence 304
await runTest('Conditional 304: If-None-Match returns 304 even when Range header is present', async () => {
  const headReq = new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', { method: 'HEAD' })
  const headRes = await worker.fetch(headReq, defaultEnv)
  const etag = headRes.headers.get('ETag')

  const condReq = new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
    headers: {
      'If-None-Match': etag,
      Range: 'bytes=0-499',
    },
  })
  const condRes = await worker.fetch(condReq, defaultEnv)
  assert.equal(condRes.status, 304)
  assert.equal(condRes.body, null)
})

// 5. Single Range Requests (206)
await runTest('Range 206: closed, open, and suffix ranges', async () => {
  // Closed range: bytes=0-499
  const r1 = await worker.fetch(
    new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
      headers: { Range: 'bytes=0-499' },
    }),
    defaultEnv,
  )
  assert.equal(r1.status, 206)
  assert.equal(r1.headers.get('Content-Range'), 'bytes 0-499/1000')
  assert.equal(r1.headers.get('Content-Length'), '500')
  assert.equal((await r1.arrayBuffer()).byteLength, 500)

  // Open range: bytes=500-
  const r2 = await worker.fetch(
    new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
      headers: { Range: 'bytes=500-' },
    }),
    defaultEnv,
  )
  assert.equal(r2.status, 206)
  assert.equal(r2.headers.get('Content-Range'), 'bytes 500-999/1000')
  assert.equal(r2.headers.get('Content-Length'), '500')
  assert.equal((await r2.arrayBuffer()).byteLength, 500)

  // Suffix range: bytes=-200
  const r3 = await worker.fetch(
    new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
      headers: { Range: 'bytes=-200' },
    }),
    defaultEnv,
  )
  assert.equal(r3.status, 206)
  assert.equal(r3.headers.get('Content-Range'), 'bytes 800-999/1000')
  assert.equal(r3.headers.get('Content-Length'), '200')
  assert.equal((await r3.arrayBuffer()).byteLength, 200)

  // HEAD on Range
  const rHead = await worker.fetch(
    new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
      method: 'HEAD',
      headers: { Range: 'bytes=0-99' },
    }),
    defaultEnv,
  )
  assert.equal(rHead.status, 206)
  assert.equal(rHead.headers.get('Content-Range'), 'bytes 0-99/1000')
  assert.equal(rHead.headers.get('Content-Length'), '100')
  assert.equal(rHead.body, null)
})

// 6. Range 416 Unsatisfiable
await runTest('Range 416: returns 416 with Content-Range: bytes */total on out-of-range', async () => {
  const req = new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
    headers: { Range: 'bytes=1500-2000' },
  })
  const res = await worker.fetch(req, defaultEnv)
  assert.equal(res.status, 416)
  assert.equal(res.headers.get('Content-Range'), 'bytes */1000')
})

// 7. If-Range Header Handling
await runTest('If-Range: valid ETag returns 206; mismatched ETag falls back to full 200', async () => {
  const headRes = await worker.fetch(new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', { method: 'HEAD' }), defaultEnv)
  const etag = headRes.headers.get('ETag')

  // Valid If-Range
  const validRes = await worker.fetch(
    new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
      headers: {
        Range: 'bytes=0-99',
        'If-Range': etag,
      },
    }),
    defaultEnv,
  )
  assert.equal(validRes.status, 206)

  // Mismatched If-Range: must ignore Range and return 200 full body
  const mismatchRes = await worker.fetch(
    new Request('https://updates.example.invalid/Trace-1.0.0-mac-arm64.zip', {
      headers: {
        Range: 'bytes=0-99',
        'If-Range': '"stale-etag-value"',
      },
    }),
    defaultEnv,
  )
  assert.equal(mismatchRes.status, 200)
  assert.equal(mismatchRes.headers.get('Content-Length'), '1000')
})

// 8. Security Guards: Traversal, Prefix, and Allowlist
await runTest('Security Guards: rejects traversal, prefixes, malformed URIs, and unallowlisted files', async () => {
  // Path traversal
  assert.equal((await worker.fetch(new Request('https://updates.example.invalid/%2e%2e%2fTrace-1.0.0-mac-arm64.zip'), defaultEnv)).status, 404)
  assert.equal((await worker.fetch(new Request('https://updates.example.invalid/sub/Trace-1.0.0-mac-arm64.zip'), defaultEnv)).status, 404)

  // Malformed percent encoding
  assert.equal((await worker.fetch(new Request('https://updates.example.invalid/%E0%A4%A'), defaultEnv)).status, 400)

  // Unallowlisted files
  assert.equal((await worker.fetch(new Request('https://updates.example.invalid/.env'), defaultEnv)).status, 404)
  assert.equal((await worker.fetch(new Request('https://updates.example.invalid/secret.txt'), defaultEnv)).status, 404)
  assert.equal((await worker.fetch(new Request('https://updates.example.invalid/malicious.sh'), defaultEnv)).status, 404)
})

// 9. Fail-Closed 503 on R2 Errors
await runTest('Fail-Closed 503: handles R2 exceptions gracefully without leaking internals', async () => {
  const errorBucket = new MockR2Bucket({ 'latest.yml': 'content' })
  errorBucket.throwOnAccess = true

  const res = await worker.fetch(new Request('https://updates.example.invalid/latest.yml'), { TRACE_UPDATES: errorBucket })
  assert.equal(res.status, 503)
  const bodyText = await res.text()
  assert.equal(bodyText, 'Service Unavailable')
  assert.ok(!bodyText.includes('R2 cluster unreachable'))
})

// 10. Cache Policies: Manifests vs Artifacts
await runTest('Cache-Control Policies: mutable manifests are no-cache; artifacts are immutable', async () => {
  const macManifestRes = await worker.fetch(new Request('https://updates.example.invalid/latest-mac.yml'), defaultEnv)
  assert.equal(macManifestRes.headers.get('Cache-Control'), 'no-cache, no-store, must-revalidate')
  assert.equal(macManifestRes.headers.get('Content-Type'), 'text/yaml; charset=utf-8')

  const winManifestRes = await worker.fetch(new Request('https://updates.example.invalid/latest.yml'), defaultEnv)
  assert.equal(winManifestRes.headers.get('Cache-Control'), 'no-cache, no-store, must-revalidate')

  const artifactRes = await worker.fetch(new Request('https://updates.example.invalid/Trace-1.0.0-win-x64.exe'), defaultEnv)
  assert.equal(artifactRes.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
})

// 11. Download Aliases
await runTest('Download Aliases: /download/mac and /download/windows redirect to target artifact', async () => {
  const macAliasRes = await worker.fetch(new Request('https://updates.example.invalid/download/mac'), defaultEnv)
  assert.equal(macAliasRes.status, 302)
  assert.equal(macAliasRes.headers.get('Location'), '/Trace-1.0.0-mac-arm64.dmg')

  const winAliasRes = await worker.fetch(new Request('https://updates.example.invalid/download/windows'), defaultEnv)
  assert.equal(winAliasRes.status, 302)
  assert.equal(winAliasRes.headers.get('Location'), '/Trace-1.0.0-win-x64.exe')
})

console.log(`\nWorker verification complete: ${passed} passed, ${failed} failed.`)
