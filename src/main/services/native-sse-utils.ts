import { normalizeEndpoint } from '../security/consent-store.ts'
import { containsSensitiveCredential } from '../security/redaction.ts'

/**
 * Small, transport-agnostic helpers used by the native Anthropic and Gemini
 * adapters.  The existing OpenAI clients intentionally keep their own error
 * classes; this module only owns stream framing and URL/path validation.
 */

export type NativeSseProtocolErrorCode =
  | 'event_too_large'
  | 'invalid_response'
  | 'response_too_large'

export class NativeSseProtocolError extends Error {
  readonly code: NativeSseProtocolErrorCode

  constructor(code: NativeSseProtocolErrorCode) {
    super(code === 'event_too_large'
      ? 'A model stream event exceeded the safety limit.'
      : code === 'response_too_large'
        ? 'The model response exceeded the safety limit.'
        : 'The model endpoint returned an invalid stream.')
    this.name = 'NativeSseProtocolError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface NativeSseEvent {
  event: string
  data: string
}

export interface ConsumeNativeSseOptions {
  maxResponseBytes: number
  maxEventBytes: number
  requireCompletion: boolean
  onEvent: (event: NativeSseEvent) => boolean | void | Promise<boolean | void>
}

/**
 * Consume an SSE response without ever retaining an unbounded line/event.
 * `onEvent` is responsible for protocol-specific JSON validation.  A native
 * Gemini stream may legitimately end at EOF, while Anthropic requires an
 * explicit message_stop; callers select that with `requireCompletion`.
 */
export async function consumeNativeSse(
  body: ReadableStream<Uint8Array>,
  options: ConsumeNativeSseOptions
): Promise<{ eventCount: number; completed: boolean }> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new NativeSseParser(options.maxEventBytes)
  const reader = body.getReader()
  let responseBytes = 0
  let eventCount = 0
  let completed = false

  const processEvents = async (events: readonly NativeSseEvent[]): Promise<void> => {
    for (const event of events) {
      eventCount += 1
      if (await options.onEvent(event)) parser.markCompletion()
    }
  }

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new NativeSseProtocolError('invalid_response')
      responseBytes += next.value.byteLength
      if (responseBytes > options.maxResponseBytes) {
        throw new NativeSseProtocolError('response_too_large')
      }
      let decoded: string
      try {
        decoded = decoder.decode(next.value, { stream: true })
      } catch {
        throw new NativeSseProtocolError('invalid_response')
      }
      await processEvents(parser.push(decoded))
    }

    let tail: string
    try {
      tail = decoder.decode()
    } catch {
      throw new NativeSseProtocolError('invalid_response')
    }
    await processEvents(parser.finish(tail))
    completed = parser.sawCompletion
    if (options.requireCompletion && !completed) {
      throw new NativeSseProtocolError('invalid_response')
    }
    return { eventCount, completed }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Reader cleanup is best effort and must not expose stream internals.
    }
  }
}

/** A bounded WHATWG SSE parser.  Unknown fields are ignored per the SSE spec. */
export class NativeSseParser {
  #buffer = ''
  #eventName = 'message'
  #dataLines: string[] = []
  #eventBytes = 0
  #sawCompletion = false
  readonly #maxEventBytes: number

  constructor(maxEventBytes: number) {
    this.#maxEventBytes = maxEventBytes
  }

  get sawCompletion(): boolean {
    return this.#sawCompletion
  }

  markCompletion(): void {
    this.#sawCompletion = true
  }

  push(text: string): NativeSseEvent[] {
    this.#buffer += text
    this.#assertBounded()
    return this.#drain(false)
  }

  finish(text: string): NativeSseEvent[] {
    this.#buffer += text
    return this.#drain(true)
  }

  #drain(final: boolean): NativeSseEvent[] {
    const events: NativeSseEvent[] = []
    let consumed = 0
    while (true) {
      const lineEnd = firstLineEnding(this.#buffer, consumed)
      if (lineEnd < 0) break
      // A CR at the end of a non-final chunk may be the first half of CRLF.
      if (!final && this.#buffer[lineEnd] === '\r' && lineEnd === this.#buffer.length - 1) break
      const delimiterLength = this.#buffer[lineEnd] === '\r' && this.#buffer[lineEnd + 1] === '\n' ? 2 : 1
      const line = this.#buffer.slice(consumed, lineEnd)
      this.#eventBytes += Buffer.byteLength(line, 'utf8') + delimiterLength
      if (this.#eventBytes > this.#maxEventBytes) {
        throw new NativeSseProtocolError('event_too_large')
      }
      this.#processLine(line, events)
      consumed = lineEnd + delimiterLength
    }
    if (consumed > 0) this.#buffer = this.#buffer.slice(consumed)
    this.#assertBounded()

    if (final) {
      if (this.#buffer.length > 0) {
        const line = this.#buffer
        this.#buffer = ''
        this.#eventBytes += Buffer.byteLength(line, 'utf8')
        if (this.#eventBytes > this.#maxEventBytes) {
          throw new NativeSseProtocolError('event_too_large')
        }
        this.#processLine(line, events)
      }
      // A non-empty data field is only complete after a blank line.  This
      // rejects a truncated final event instead of silently accepting it.
      if (this.#dataLines.length > 0 || this.#eventBytes > 0) {
        throw new NativeSseProtocolError('invalid_response')
      }
    }
    return events
  }

  #processLine(line: string, events: NativeSseEvent[]): void {
    if (line === '') {
      if (this.#dataLines.length > 0) {
        events.push({ event: this.#eventName, data: this.#dataLines.join('\n') })
      }
      this.#eventName = 'message'
      this.#dataLines = []
      this.#eventBytes = 0
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.#eventName = value || 'message'
    else if (field === 'data') this.#dataLines.push(value)
  }

  #assertBounded(): void {
    if (this.#eventBytes + Buffer.byteLength(this.#buffer, 'utf8') > this.#maxEventBytes) {
      throw new NativeSseProtocolError('event_too_large')
    }
  }
}

export function normalizeNativeBaseUrl(value: unknown): string {
  let normalized: string
  try {
    normalized = normalizeEndpoint(value)
  } catch {
    throw new Error('invalid_endpoint')
  }
  const endpoint = new URL(normalized)
  if (endpoint.search || endpoint.hash) throw new Error('invalid_endpoint')
  return normalized.replace(/\/+$/u, '')
}

/**
 * Validate a caller-provided endpoint path.  Query strings are allowed only
 * for non-sensitive protocol switches (Gemini uses `alt=sse`); credentials
 * and fragments are always rejected.
 */
export function normalizeNativePath(value: unknown, allowTemplate = false): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    /[\u0000-\u0020\u007f\\#]/u.test(value)
  ) throw new Error('invalid_endpoint')
  if (containsSensitiveCredential(value)) throw new Error('invalid_endpoint')
  const question = value.indexOf('?')
  const pathname = question < 0 ? value : value.slice(0, question)
  const query = question < 0 ? '' : value.slice(question + 1)
  if (question >= 0 && (query.length < 1 || query.includes('?'))) throw new Error('invalid_endpoint')
  if (!pathname || pathname.includes('//')) throw new Error('invalid_endpoint')
  if (!allowTemplate && /[{}]/u.test(pathname)) throw new Error('invalid_endpoint')
  if (allowTemplate) {
    const templateCount = (pathname.match(/\{model\}/gu) ?? []).length
    if (templateCount > 1 || /[{}]/u.test(pathname.replaceAll('{model}', ''))) throw new Error('invalid_endpoint')
  }
  for (const segment of pathname.split('/')) {
    if (segment === '.' || segment === '..' || /%2e/i.test(segment)) throw new Error('invalid_endpoint')
  }
  if (query) {
    for (const pair of query.split('&')) {
      if (pair.length < 1) throw new Error('invalid_endpoint')
      const equals = pair.indexOf('=')
      const key = equals < 0 ? pair : pair.slice(0, equals)
      const valuePart = equals < 0 ? '' : pair.slice(equals + 1)
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || /(?:key|token|secret|auth|password|credential|cookie|session)/iu.test(key)) {
        throw new Error('invalid_endpoint')
      }
      if (valuePart.length > 256 || /[\u0000-\u0020\u007f]/u.test(valuePart)) throw new Error('invalid_endpoint')
    }
  }
  return value
}

/** Join a safe path to a normalized API root without allowing `..` escapes. */
export function joinNativeEndpoint(baseUrl: string, path: string): string {
  const normalizedBaseUrl = normalizeNativeBaseUrl(baseUrl)
  const normalizedPath = normalizeNativePath(path)
  const base = new URL(normalizedBaseUrl)
  const question = normalizedPath.indexOf('?')
  const pathname = question < 0 ? normalizedPath : normalizedPath.slice(0, question)
  const query = question < 0 ? '' : normalizedPath.slice(question + 1)
  const basePath = base.pathname.replace(/\/+$/u, '')
  const pathIsAlreadyRooted = basePath.length > 0 &&
    (pathname === basePath || pathname.startsWith(`${basePath}/`))
  const baseVersion = basePath.match(/\/(v[1-9][0-9]*(?:beta)?)$/iu)
  const pathRepeatsBaseVersion = baseVersion !== null &&
    (pathname === `/${baseVersion[1]}` || pathname.startsWith(`/${baseVersion[1]}/`))
  base.pathname = pathIsAlreadyRooted
    ? pathname
    : pathRepeatsBaseVersion
      ? `${basePath.slice(0, -baseVersion[0].length)}${pathname}`
      : `${basePath}/${pathname.replace(/^\/+/, '')}`
  base.search = query ? `?${query}` : ''
  base.hash = ''
  return base.toString()
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasOnlyKeys<K extends string>(value: unknown, allowedKeys: readonly K[]): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const allowed = new Set<string>(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

export function hasExactKeys<K extends string>(value: unknown, expectedKeys: readonly K[]): value is Record<K, unknown> {
  if (!hasOnlyKeys(value, expectedKeys)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}

export function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const signal = value as Partial<AbortSignal>
  return typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
}

export function configurationInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('invalid_configuration')
  }
  return value
}

export async function discardNativeResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Never read rejected response bodies: they can contain secrets.
  }
}

export function firstLineEnding(text: string, start: number): number {
  const carriageReturn = text.indexOf('\r', start)
  const lineFeed = text.indexOf('\n', start)
  if (carriageReturn < 0) return lineFeed
  if (lineFeed < 0) return carriageReturn
  return Math.min(carriageReturn, lineFeed)
}
