const MAX_BODY_LENGTH = 32_768
const SENSITIVE_KEY = /(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|csrf|xsrf|session|api[-_]?key|private[-_]?key|credit[-_]?card|card[-_]?number|cvv|cvc)/i

function secretReference(key: string) {
  return `\${secret:${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}}`
}

export function normalizeBrowserCaptureUrl(value: string) {
  const candidate = value.trim()
  if (!candidate) throw new Error('请输入要捕捉的网页地址')
  const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(candidate) ? candidate : `https://${candidate}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('浏览器捕捉仅支持 HTTP 或 HTTPS 地址')
  }
  return parsed.toString()
}

export function sanitizeBrowserUrl(value: string) {
  try {
    const url = new URL(value)
    for (const [key] of url.searchParams) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, secretReference(key))
    }
    url.hash = ''
    return url.toString()
  } catch {
    return value.slice(0, 2_048)
  }
}

export function sanitizeBrowserHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.toLowerCase()
    const stringValue = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '')
    result[key] = SENSITIVE_KEY.test(key) ? secretReference(key) : stringValue.slice(0, 4_096)
  }
  return result
}

function redactStructuredValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return secretReference(key)
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactStructuredValue(childValue, childKey),
      ]),
    )
  }
  return value
}

export function sanitizeBrowserBody(postData: unknown, headers: Record<string, string>) {
  if (typeof postData !== 'string' || !postData) return undefined
  const contentType = headers['content-type']?.toLowerCase() ?? ''
  if (contentType.includes('multipart/form-data')) return '[multipart body omitted]'

  if (contentType.includes('application/json') || /^[\s]*[\[{]/.test(postData)) {
    try {
      return JSON.stringify(redactStructuredValue(JSON.parse(postData))).slice(0, MAX_BODY_LENGTH)
    } catch {
      return '[invalid JSON body omitted]'
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(postData)
    for (const [key] of form) {
      if (SENSITIVE_KEY.test(key)) form.set(key, secretReference(key))
    }
    return form.toString().slice(0, MAX_BODY_LENGTH)
  }

  return `[request body omitted: ${contentType || 'unknown content type'}]`
}
