/**
 * Trace Application Updates Delivery Worker (OPC-53)
 *
 * Cloudflare Worker providing read-only, range-capable delivery of desktop update
 * artifacts from an R2 bucket binding (`TRACE_UPDATES`).
 *
 * Invariants:
 * - Read-only: GET and HEAD requests only; all other HTTP methods return 405 (Allow: GET, HEAD).
 * - Strict filename allowlist: Only Trace release artifacts (dmg, zip, exe, blockmap)
 *   and manifests (latest-mac.yml, latest.yml). Slashes/traversal/prefixes rejected with 404.
 * - Single Range request support (bytes=a-b, bytes=a-, bytes=-n) returning 206 Partial Content
 *   with Accept-Ranges, Content-Range, Content-Length.
 * - Unsatisfiable ranges return 416 Range Not Satisfiable.
 * - Malformed/multiple ranges fall back safely to 200 OK.
 * - HEAD requests NEVER construct or return a body stream.
 * - If-None-Match takes precedence, returning 304 Not Modified even if Range is present.
 * - If-Range mismatch returns full 200 OK body.
 * - Storage failures return 503 Service Unavailable without leaking internals.
 * - Zero bucket listing or write access.
 */

// =========================================================================
// Structural R2 & Worker Type Definitions (zero external dependencies)
// =========================================================================

export interface R2HttpMetadata {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  cacheExpiry?: Date
}

export interface R2Range {
  offset?: number
  length?: number
  suffix?: number
}

export interface R2GetOptions {
  onlyIf?: Headers | Record<string, string>
  range?: R2Range
}

export interface R2Object {
  key: string
  version: string
  size: number
  etag: string
  httpEtag: string
  uploaded: Date
  httpMetadata?: R2HttpMetadata
  customMetadata?: Record<string, string>
  range?: { offset: number; length: number }
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream
  bodyUsed: boolean
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  json<T>(): Promise<T>
  blob(): Promise<Blob>
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null>
}

export interface Env {
  TRACE_UPDATES: R2Bucket
}

// =========================================================================
// Filename Allowlist & Content-Type Mapping
// =========================================================================

export const ALLOWLIST_REGEX = /^(latest(-mac)?\.yml|Trace-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(mac-arm64\.(zip|dmg)|win-x64\.exe)(\.blockmap)?)$/
export const MANIFEST_REGEX = /^latest(-mac)?\.ya?ml$/i

const CONTENT_TYPES: Record<string, string> = {
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  zip: 'application/zip',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  blockmap: 'application/octet-stream',
}

export function getContentType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.blockmap')) {
    return 'application/octet-stream'
  }
  const ext = lower.split('.').pop() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

export function isManifest(filename: string): boolean {
  return MANIFEST_REGEX.test(filename)
}

// =========================================================================
// Single Range Header Parsing
// =========================================================================

export interface ParsedRange {
  start: number
  end: number
  length: number
}

/**
 * Parses a single Range header against the total size.
 * Returns ParsedRange, null if malformed/unsupported (fallback to 200), or 'unsatisfiable' for 416.
 */
export function parseSingleRange(rangeHeader: string, totalSize: number): ParsedRange | 'unsatisfiable' | null {
  if (totalSize <= 0) {
    return 'unsatisfiable'
  }

  const trimmed = rangeHeader.trim()
  if (!trimmed.startsWith('bytes=')) {
    return null
  }

  const specs = trimmed.slice(6).split(',')
  if (specs.length !== 1) {
    // Multiple ranges not supported; ignore safely and fall back to full 200
    return null
  }

  const spec = specs[0].trim()
  if (!/^(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(spec)) return null

  // Suffix range: bytes=-500
  if (spec.startsWith('-')) {
    const suffixLength = Number(spec.slice(1))
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null
    }
    const actualLength = Math.min(suffixLength, totalSize)
    const start = totalSize - actualLength
    const end = totalSize - 1
    return { start, end, length: actualLength }
  }

  const parts = spec.split('-')
  if (parts.length !== 2) {
    return null
  }

  const startStr = parts[0].trim()
  const endStr = parts[1].trim()

  const start = Number(startStr)
  if (!Number.isSafeInteger(start) || start < 0) {
    return null
  }

  // Open range: bytes=500-
  if (endStr === '') {
    if (start >= totalSize) {
      return 'unsatisfiable'
    }
    return {
      start,
      end: totalSize - 1,
      length: totalSize - start,
    }
  }

  // Closed range: bytes=500-999
  const end = Number(endStr)
  if (!Number.isSafeInteger(end) || end < start) {
    return null
  }

  if (start >= totalSize) {
    return 'unsatisfiable'
  }

  const actualEnd = Math.min(end, totalSize - 1)
  return {
    start,
    end: actualEnd,
    length: actualEnd - start + 1,
  }
}

// =========================================================================
// Main Worker Fetch Handler
// =========================================================================

async function handleRequest(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase()

    // 1. Enforce read-only access (GET and HEAD only)
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: {
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    }

    if (!env || !env.TRACE_UPDATES) {
      return new Response('Service Unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    let url: URL
    let rawPath: string
    try {
      url = new URL(request.url)
      rawPath = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad Request', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    // 2. Reject arbitrary path traversal or multiple slashes
    if (rawPath.includes('..') || rawPath.includes('\\') || rawPath.includes('//')) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    // 3. Handle /download/mac and /download/windows aliases
    if (rawPath === '/download/mac' || rawPath === '/download/windows') {
      return handleDownloadAlias(rawPath, env.TRACE_UPDATES)
    }

    // 4. Extract clean single filename (no directory prefixes allowed)
    const filename = rawPath.replace(/^\/+/, '')
    if (filename.includes('/') || !filename || !ALLOWLIST_REGEX.test(filename)) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    // 5. Query object metadata from R2
    let headObject: R2Object | null = null
    try {
      headObject = await env.TRACE_UPDATES.head(filename)
    } catch {
      return new Response('Service Unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    if (!headObject) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    const totalSize = headObject.size
    const rawEtag = headObject.httpEtag || headObject.etag
    const etag = rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`
    const isMutable = isManifest(filename)
    const cacheControl = isMutable
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=31536000, immutable'
    const contentType = getContentType(filename)

    const baseHeaders = new Headers()
    baseHeaders.set('Accept-Ranges', 'bytes')
    baseHeaders.set('ETag', etag)
    baseHeaders.set('Cache-Control', cacheControl)
    baseHeaders.set('Content-Type', contentType)
    baseHeaders.set('Last-Modified', headObject.uploaded.toUTCString())

    // 6. Conditional Request Precedence: If-None-Match -> 304 Not Modified
    // RFC 9110: If-None-Match MUST be evaluated before Range, returning 304 with null body.
    const ifNoneMatch = request.headers.get('If-None-Match')
    if (ifNoneMatch) {
      const tokens = ifNoneMatch.split(',').map((t) => t.trim())
      if (
        tokens.includes('*') ||
        tokens.some(token => token.replace(/^W\//, '') === etag) ||
        tokens.includes(rawEtag) ||
        tokens.includes(`"${rawEtag.replace(/"/g, '')}"`)
      ) {
        return new Response(null, {
          status: 304,
          headers: baseHeaders,
        })
      }
    }

    // 7. Evaluate Range Request & If-Range condition
    const rangeHeader = request.headers.get('Range')
    let parsedRange: ParsedRange | 'unsatisfiable' | null = null

    if (rangeHeader) {
      const ifRange = request.headers.get('If-Range')
      let ifRangeMatches = true

      if (ifRange) {
        const trimmed = ifRange.trim()
        const unquoted = trimmed.replace(/^"|"$/g, '')
        const etagUnquoted = etag.replace(/^"|"$/g, '')
        ifRangeMatches = trimmed === etag || unquoted === etagUnquoted || trimmed === headObject.uploaded.toUTCString()
      }

      // If If-Range mismatches, RFC 9110 requires ignoring Range and serving full 200
      if (ifRangeMatches) {
        parsedRange = parseSingleRange(rangeHeader, totalSize)
      }
    }

    // 416 Range Not Satisfiable
    if (parsedRange === 'unsatisfiable') {
      const headers = new Headers(baseHeaders)
      headers.set('Content-Range', `bytes */${totalSize}`)
      return new Response(null, {
        status: 416,
        headers,
      })
    }

    // 8. HEAD Method Response (NEVER construct or stream body)
    if (method === 'HEAD') {
      const headers = new Headers(baseHeaders)
      if (parsedRange) {
        headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`)
        headers.set('Content-Length', String(parsedRange.length))
        return new Response(null, { status: 206, headers })
      }
      headers.set('Content-Length', String(totalSize))
      return new Response(null, { status: 200, headers })
    }

    // 9. 206 Partial Content (GET with valid single range)
    if (parsedRange) {
      let objectBody: R2ObjectBody | R2Object | null = null
      try {
        objectBody = await env.TRACE_UPDATES.get(filename, {
          onlyIf: { etagMatches: headObject.etag },
          range: {
            offset: parsedRange.start,
            length: parsedRange.length,
          },
        })
      } catch {
        return new Response('Service Unavailable', { status: 503 })
      }

      if (!objectBody || !('body' in objectBody) || objectBody.etag !== headObject.etag) {
        return new Response('Not Found', { status: 404 })
      }

      const headers = new Headers(baseHeaders)
      headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`)
      headers.set('Content-Length', String(parsedRange.length))

      return new Response(objectBody.body, {
        status: 206,
        headers,
      })
    }

    // 10. Full 200 OK (GET without range, or range ignored via If-Range mismatch / multi-range)
    let objectBody: R2ObjectBody | R2Object | null = null
    try {
      objectBody = await env.TRACE_UPDATES.get(filename, { onlyIf: { etagMatches: headObject.etag } })
    } catch {
      return new Response('Service Unavailable', { status: 503 })
    }

    if (!objectBody || !('body' in objectBody) || objectBody.etag !== headObject.etag) {
      return new Response('Not Found', { status: 404 })
    }

    const headers = new Headers(baseHeaders)
    headers.set('Content-Length', String(totalSize))

    return new Response(objectBody.body, {
      status: 200,
      headers,
    })
  }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response
    try { response = await handleRequest(request, env) }
    catch { response = new Response('Service Unavailable', { status: 503 }) }
    if (response.status >= 400) response.headers.set('Cache-Control', 'no-store')
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
  },
}

/**
 * Handles /download/mac and /download/windows aliases by locating the target release artifact
 * specified in the platform manifest (latest-mac.yml or latest.yml).
 */
async function handleDownloadAlias(aliasPath: string, bucket: R2Bucket): Promise<Response> {
  const isMac = aliasPath === '/download/mac'
  const manifestKey = isMac ? 'latest-mac.yml' : 'latest.yml'

  let manifestObj: R2ObjectBody | R2Object | null = null
  try {
    manifestObj = await bucket.get(manifestKey)
  } catch {
    return new Response('Service Unavailable', { status: 503 })
  }

  if (!manifestObj || !('text' in manifestObj)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const manifestText = await manifestObj.text()
  let targetFile: string | null = null

  if (isMac) {
    const dmgMatch = /(?:url|path):\s*["']?(Trace-[^\s"']+\.dmg)["']?\s*(?:\r?\n|$)/.exec(manifestText)
    if (dmgMatch) {
      targetFile = dmgMatch[1]
    } else {
      const zipMatch = /(?:url|path):\s*["']?(Trace-[^\s"']+\.zip)["']?\s*(?:\r?\n|$)/.exec(manifestText)
      if (zipMatch) targetFile = zipMatch[1]
    }
  } else {
    const exeMatch = /(?:url|path):\s*["']?(Trace-[^\s"']+\.exe)["']?\s*(?:\r?\n|$)/.exec(manifestText)
    if (exeMatch) {
      targetFile = exeMatch[1]
    }
  }

  if (!targetFile || !ALLOWLIST_REGEX.test(targetFile)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  let targetExists: R2Object | null = null
  try {
    targetExists = await bucket.head(targetFile)
  } catch {
    return new Response('Service Unavailable', { status: 503 })
  }

  if (!targetExists) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `/${targetFile}`,
      'Cache-Control': 'no-cache, must-revalidate',
    },
  })
}
