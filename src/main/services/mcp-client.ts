import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

import { redactSensitiveContent } from '../security/redaction.ts'

const MCP_PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = Object.freeze({ name: 'ai-terminal', version: '0.1.2' })
const MAX_WIRE_BYTES = 1024 * 1024
const MAX_STDIO_HEADER_BYTES = 8 * 1024
const MAX_STDERR_DIAGNOSTIC_BYTES = 16 * 1024
const MAX_PENDING_REQUESTS = 256
const MAX_LIST_PAGES = 100
const MAX_TOOLS = 512
const MAX_TOOL_NAME_CHARACTERS = 256
const MAX_CURSOR_CHARACTERS = 2_048
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MIN_REQUEST_TIMEOUT_MS = 50
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000
const MAX_HTTP_CLOSE_TIMEOUT_MS = 5_000

const INHERITED_STDIO_ENVIRONMENT_KEYS = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL'
] as const)

export type McpClientErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'unavailable'
  | 'protocol_error'
  | 'request_failed'
  | 'timeout'
  | 'cancelled'
  | 'closed'
  | 'process_exited'
  | 'limit_exceeded'

const ERROR_MESSAGES: Readonly<Record<McpClientErrorCode, string>> = Object.freeze({
  invalid_configuration: 'MCP transport is not configured correctly.',
  invalid_input: 'MCP request input is invalid.',
  unavailable: 'MCP transport is unavailable.',
  protocol_error: 'MCP server returned an invalid protocol message.',
  request_failed: 'MCP server could not complete the request.',
  timeout: 'MCP request timed out.',
  cancelled: 'MCP request was cancelled.',
  closed: 'MCP session is closed.',
  process_exited: 'MCP server stopped unexpectedly.',
  limit_exceeded: 'MCP transport exceeded a configured limit.'
})

export class McpClientError extends Error {
  readonly code: McpClientErrorCode

  constructor(code: McpClientErrorCode) {
    const message = ERROR_MESSAGES[code]
    super(message)
    this.name = 'McpClientError'
    this.code = code
    this.stack = `McpClientError: ${message}`
  }
}

export interface McpStdioConfig {
  readonly transport: 'stdio'
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Explicit child-environment allowlist. The parent environment is not copied wholesale. */
  readonly env?: Readonly<Record<string, string>>
  readonly framing?: 'newline' | 'content-length'
  readonly requestTimeoutMs?: number
  /** Receives bounded, path- and credential-redacted stderr text. */
  readonly onStderr?: (redacted: string) => void
}

export interface McpHttpConfig {
  readonly transport: 'http'
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  /** Called before every POST so an OAuth owner can refresh its bearer value. */
  readonly getAuthorizationHeader?: () => Promise<string | undefined>
  readonly requestTimeoutMs?: number
}

export type McpConnectionConfig = McpStdioConfig | McpHttpConfig

export type McpTool = Readonly<Record<string, unknown>> & {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export type McpToolCallResult = Readonly<Record<string, unknown>> & {
  readonly content: readonly Readonly<Record<string, unknown>>[]
  readonly isError?: boolean
  readonly structuredContent?: unknown
}

export interface McpSession {
  listTools(signal?: AbortSignal): Promise<readonly McpTool[]>
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<McpToolCallResult>
  close(): Promise<void>
}

interface JsonRpcResponse {
  readonly id: number
  readonly result?: unknown
  readonly error?: Readonly<Record<string, unknown>>
}

interface PendingStdioRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: McpClientError) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal: AbortSignal | undefined
  readonly onAbort: (() => void) | undefined
}

interface NormalizedStdioConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly framing: 'newline' | 'content-length'
  readonly requestTimeoutMs: number
  readonly onStderr: ((redacted: string) => void) | undefined
  readonly explicitSecrets: readonly string[]
}

interface NormalizedHttpConfig {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly getAuthorizationHeader: (() => Promise<string | undefined>) | undefined
  readonly requestTimeoutMs: number
}

abstract class McpSessionBase implements McpSession {
  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    })
    if (!isRecord(result) || !isBoundedPlainString(result.protocolVersion, 64)) {
      throw new McpClientError('protocol_error')
    }
    this.didInitialize(result.protocolVersion)
    await this.notify('notifications/initialized', {})
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpTool[]> {
    throwIfAborted(signal)
    const tools: McpTool[] = []
    const names = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let totalBytes = 0

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.request(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        signal
      )
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new McpClientError('protocol_error')
      }
      for (const value of result.tools) {
        if (tools.length >= MAX_TOOLS) throw new McpClientError('limit_exceeded')
        const tool = normalizeTool(value)
        if (names.has(tool.name)) throw new McpClientError('protocol_error')
        names.add(tool.name)
        totalBytes += jsonByteLength(tool, 'protocol_error')
        if (totalBytes > MAX_WIRE_BYTES) throw new McpClientError('limit_exceeded')
        tools.push(tool)
      }

      const nextCursor = result.nextCursor
      if (nextCursor === undefined || nextCursor === null) return Object.freeze(tools)
      if (
        !isBoundedPlainString(nextCursor, MAX_CURSOR_CHARACTERS) ||
        nextCursor.length === 0 ||
        cursors.has(nextCursor)
      ) {
        throw new McpClientError('protocol_error')
      }
      cursors.add(nextCursor)
      cursor = nextCursor
    }
    throw new McpClientError('limit_exceeded')
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<McpToolCallResult> {
    if (
      !isBoundedPlainString(name, MAX_TOOL_NAME_CHARACTERS) ||
      name.length === 0 ||
      !isRecord(args)
    ) {
      throw new McpClientError('invalid_input')
    }
    throwIfAborted(signal)
    return normalizeToolCallResult(
      await this.request('tools/call', { name, arguments: args }, signal)
    )
  }

  abstract close(): Promise<void>

  protected abstract request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
  protected abstract notify(method: string, params: unknown): Promise<void>
  protected didInitialize(_protocolVersion: string): void {}
}

class StdioMcpSession extends McpSessionBase {
  readonly #config: NormalizedStdioConfig
  readonly #decoder = new StdioJsonRpcDecoder()
  readonly #pending = new Map<number, PendingStdioRequest>()
  readonly #ignoredResponseIds = new Set<number>()
  #child: ChildProcessWithoutNullStreams | null = null
  #nextRequestId = 1
  #terminalError: McpClientError | null = null
  #closed = false
  #closing: Promise<void> | null = null
  #stderrPending = Buffer.alloc(0)

  constructor(config: NormalizedStdioConfig) {
    super()
    this.#config = config
  }

  async start(): Promise<void> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.#config.command, [...this.#config.args], {
        cwd: this.#config.cwd,
        env: this.#config.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      this.#terminalError = new McpClientError('unavailable')
      throw this.#terminalError
    }

    this.#child = child
    child.stdout.on('data', (chunk: Buffer) => this.#handleStdout(child, chunk))
    child.stderr.on('data', (chunk: Buffer) => this.#handleStderr(child, chunk))
    child.stdin.on('error', () => this.#failAndTerminate(child, new McpClientError('process_exited')))
    child.on('error', () => this.#failAndTerminate(child, new McpClientError('unavailable')))
    child.on('exit', () => this.#handleExit(child))
    await this.#waitForSpawn(child)
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#terminalError = new McpClientError('closed')
      this.#rejectAll(this.#terminalError)
    }
    if (this.#closing !== null) return await this.#closing
    const child = this.#child
    this.#child = null
    this.#flushStderr()
    if (child === null) return
    this.#closing = terminateProcessTree(child, this.#config.env)
    try {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    } catch {
      // Tree termination remains authoritative.
    }
    await this.#closing
  }

  protected async request(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    throwIfAborted(signal)
    const child = this.#usableChild()
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new McpClientError('limit_exceeded')
    }
    const id = this.#allocateRequestId()
    const encoded = encodeJsonRpc({ jsonrpc: '2.0', id, method, params }, this.#config.framing)

    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = signal === undefined
        ? undefined
        : (): void => this.#cancelPending(id, new McpClientError('cancelled'))
      const timer = setTimeout(
        () => this.#cancelPending(id, new McpClientError('timeout')),
        this.#config.requestTimeoutMs
      )
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort!, { once: true })
      if (signal?.aborted) {
        onAbort?.()
        return
      }
      child.stdin.write(encoded, (error) => {
        if (error !== null && error !== undefined) {
          this.#failAndTerminate(child, new McpClientError('process_exited'))
        }
      })
    })
  }

  protected async notify(method: string, params: unknown): Promise<void> {
    const child = this.#usableChild()
    const encoded = encodeJsonRpc({ jsonrpc: '2.0', method, params }, this.#config.framing)
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(encoded, (error) => {
        if (error === null || error === undefined) {
          resolve()
          return
        }
        const safeError = new McpClientError('process_exited')
        this.#failAndTerminate(child, safeError)
        reject(safeError)
      })
    })
  }

  async #waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: McpClientError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('spawn', onSpawn)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onSpawn = (): void => finish()
      const onError = (): void => finish(new McpClientError('unavailable'))
      const onExit = (): void => finish(new McpClientError('process_exited'))
      const timer = setTimeout(
        () => finish(new McpClientError('timeout')),
        this.#config.requestTimeoutMs
      )
      timer.unref?.()
      child.once('spawn', onSpawn)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  }

  #handleStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.#child !== child) return
    try {
      for (const message of this.#decoder.push(chunk)) this.#handleMessage(child, message)
    } catch (error) {
      this.#failAndTerminate(child, toMcpClientError(error, 'protocol_error'))
    }
  }

  #handleMessage(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (this.#child !== child || !isRecord(value) || value.jsonrpc !== '2.0') {
      this.#failAndTerminate(child, new McpClientError('protocol_error'))
      return
    }

    const hasResult = Object.hasOwn(value, 'result')
    const hasError = Object.hasOwn(value, 'error')
    if (hasResult || hasError) {
      const response = parseJsonRpcResponse(value)
      if (this.#ignoredResponseIds.delete(response.id)) return
      const pending = this.#pending.get(response.id)
      if (pending === undefined) {
        this.#failAndTerminate(child, new McpClientError('protocol_error'))
        return
      }
      this.#pending.delete(response.id)
      clearTimeout(pending.timer)
      if (pending.onAbort !== undefined) {
        pending.signal?.removeEventListener('abort', pending.onAbort)
      }
      if (response.error !== undefined) pending.reject(new McpClientError('request_failed'))
      else pending.resolve(response.result)
      return
    }

    if (typeof value.method !== 'string') {
      this.#failAndTerminate(child, new McpClientError('protocol_error'))
      return
    }
    if (value.id !== undefined) this.#sendMethodNotFound(child, value.id)
  }

  #sendMethodNotFound(child: ChildProcessWithoutNullStreams, id: unknown): void {
    if (!isJsonRpcId(id)) {
      this.#failAndTerminate(child, new McpClientError('protocol_error'))
      return
    }
    let encoded: Buffer
    try {
      encoded = encodeJsonRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      }, this.#config.framing)
    } catch (error) {
      this.#failAndTerminate(child, toMcpClientError(error, 'protocol_error'))
      return
    }
    child.stdin.write(encoded, (error) => {
      if (error !== null && error !== undefined) {
        this.#failAndTerminate(child, new McpClientError('process_exited'))
      }
    })
  }

  #cancelPending(id: number, error: McpClientError): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.onAbort !== undefined) pending.signal?.removeEventListener('abort', pending.onAbort)
    this.#rememberIgnoredId(id)
    pending.reject(error)
    void this.notify('notifications/cancelled', {
      requestId: id,
      reason: error.code === 'timeout' ? 'timeout' : 'cancelled'
    }).catch(() => undefined)
  }

  #rememberIgnoredId(id: number): void {
    this.#ignoredResponseIds.add(id)
    while (this.#ignoredResponseIds.size > MAX_PENDING_REQUESTS) {
      const oldest = this.#ignoredResponseIds.values().next().value
      if (oldest === undefined) break
      this.#ignoredResponseIds.delete(oldest)
    }
  }

  #handleStderr(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.#child !== child) return
    const input = Buffer.from(chunk)
    let start = 0
    let newline = input.indexOf(0x0a, start)
    while (newline >= 0) {
      const segment = input.subarray(start, newline + 1)
      const lineBytes = this.#stderrPending.length + segment.length
      if (lineBytes > MAX_WIRE_BYTES) {
        this.#failAndTerminate(child, new McpClientError('limit_exceeded'))
        return
      }
      const line = this.#stderrPending.length === 0
        ? segment
        : Buffer.concat([this.#stderrPending, segment], lineBytes)
      this.#stderrPending = Buffer.alloc(0)
      this.#projectStderr(line)
      start = newline + 1
      newline = input.indexOf(0x0a, start)
    }
    const tail = input.subarray(start)
    if (this.#stderrPending.length + tail.length > MAX_WIRE_BYTES) {
      this.#failAndTerminate(child, new McpClientError('limit_exceeded'))
      return
    }
    if (tail.length > 0) {
      this.#stderrPending = this.#stderrPending.length === 0
        ? Buffer.from(tail)
        : Buffer.concat(
            [this.#stderrPending, tail],
            this.#stderrPending.length + tail.length
          )
    }
  }

  #flushStderr(): void {
    if (this.#stderrPending.length === 0) return
    this.#projectStderr(this.#stderrPending)
    this.#stderrPending = Buffer.alloc(0)
  }

  #projectStderr(data: Buffer): void {
    if (this.#config.onStderr === undefined) return
    const text = new TextDecoder('utf-8').decode(data)
    const redacted = truncateUtf8(redactStderr(text, this.#config.explicitSecrets), MAX_STDERR_DIAGNOSTIC_BYTES)
    try {
      this.#config.onStderr(redacted)
    } catch {
      // A diagnostic consumer cannot break the transport.
    }
  }

  #handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child) return
    this.#flushStderr()
    this.#child = null
    this.#terminalError = new McpClientError('process_exited')
    this.#rejectAll(this.#terminalError)
  }

  #failAndTerminate(child: ChildProcessWithoutNullStreams, error: McpClientError): void {
    if (this.#child !== child) return
    this.#child = null
    this.#terminalError = error
    this.#rejectAll(error)
    try {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    } catch {
      // Tree termination below remains authoritative.
    }
    this.#closing = terminateProcessTree(child, this.#config.env)
  }

  #rejectAll(error: McpClientError): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      if (pending.onAbort !== undefined) pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.reject(error)
    }
  }

  #usableChild(): ChildProcessWithoutNullStreams {
    if (this.#closed) throw new McpClientError('closed')
    if (this.#child !== null) return this.#child
    throw this.#terminalError ?? new McpClientError('process_exited')
  }

  #allocateRequestId(): number {
    const id = this.#nextRequestId
    this.#nextRequestId += 1
    if (!Number.isSafeInteger(id) || id <= 0) throw new McpClientError('limit_exceeded')
    return id
  }
}

interface ActiveHttpOperation {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly settle: () => void
  errorCode: McpClientErrorCode | null
}

class HttpMcpSession extends McpSessionBase {
  readonly #config: NormalizedHttpConfig
  readonly #active = new Map<number, ActiveHttpOperation>()
  #nextRequestId = 1
  #nextNotificationKey = -1
  #closed = false
  #closing = false
  #closingPromise: Promise<void> | null = null
  #sessionId: string | undefined
  #protocolVersion: string | undefined

  constructor(config: NormalizedHttpConfig) {
    super()
    this.#config = config
  }

  async close(): Promise<void> {
    if (this.#closed) return
    if (this.#closingPromise === null) {
      this.#closing = true
      this.#closingPromise = this.#closeTransport()
    }
    await this.#closingPromise
  }

  protected didInitialize(protocolVersion: string): void {
    this.#protocolVersion = protocolVersion
  }

  protected async request(
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    throwIfAborted(signal)
    if (this.#active.size >= MAX_PENDING_REQUESTS) throw new McpClientError('limit_exceeded')
    const id = this.#allocateRequestId()
    const response = await this.#post(
      id,
      { jsonrpc: '2.0', id, method, params },
      signal,
      false
    )
    return response
  }

  protected async notify(method: string, params: unknown): Promise<void> {
    const key = this.#nextNotificationKey
    this.#nextNotificationKey -= 1
    if (!Number.isSafeInteger(key)) throw new McpClientError('limit_exceeded')
    await this.#post(key, { jsonrpc: '2.0', method, params }, undefined, true)
  }

  async #post(
    operationKey: number,
    payload: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    notification: boolean
  ): Promise<unknown> {
    if (this.#closed || this.#closing) throw new McpClientError('closed')
    const body = encodeJsonBody(payload)
    let settleOperation: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      settleOperation = resolve
    })
    const operation: ActiveHttpOperation = {
      controller: new AbortController(),
      settled,
      settle: settleOperation,
      errorCode: null
    }
    this.#active.set(operationKey, operation)
    const abortWith = (code: McpClientErrorCode): void => {
      if (operation.errorCode !== null) return
      operation.errorCode = code
      operation.controller.abort()
    }
    const onAbort = (): void => abortWith('cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => abortWith('timeout'), this.#config.requestTimeoutMs)
    timer.unref?.()

    try {
      if (signal?.aborted) abortWith('cancelled')
      const headers = await this.#buildHeaders(operation.controller.signal, true)
      throwIfOperationAborted(operation)

      const response = await fetch(this.#config.url, {
        method: 'POST',
        headers,
        body,
        signal: operation.controller.signal,
        redirect: 'error'
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new McpClientError('request_failed')
      }
      this.#captureSessionId(response.headers)
      if (notification) {
        await response.body?.cancel()
        return undefined
      }
      const expectedId = operationKey
      const mediaType = responseMediaType(response.headers.get('content-type'))
      const matched = mediaType === 'text/event-stream'
        ? await readIncrementalSseResponse(response, expectedId, operation.controller.signal)
        : matchHttpResponse(
            decodeJsonHttpResponse(mediaType, await readBoundedResponse(response, operation.controller.signal)),
            expectedId
          )
      if (matched.error !== undefined) throw new McpClientError('request_failed')
      return matched.result
    } catch (error) {
      if (operation.errorCode !== null) throw new McpClientError(operation.errorCode)
      throw toMcpClientError(error, 'request_failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.#active.delete(operationKey)
      operation.settle()
    }
  }

  async #closeTransport(): Promise<void> {
    const active = [...this.#active.values()]
    for (const operation of active) {
      operation.errorCode = 'closed'
      operation.controller.abort()
    }
    await Promise.allSettled(active.map((operation) => operation.settled))
    this.#active.clear()

    const sessionId = this.#sessionId
    try {
      if (sessionId !== undefined) await this.#deleteSession(sessionId)
    } finally {
      this.#sessionId = undefined
      this.#closed = true
      this.#closing = false
    }
  }

  async #deleteSession(sessionId: string): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.#config.requestTimeoutMs, MAX_HTTP_CLOSE_TIMEOUT_MS)
    )
    timer.unref?.()
    try {
      const headers = await this.#buildHeaders(controller.signal, false)
      headers.set('mcp-session-id', sessionId)
      const response = await fetch(this.#config.url, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
        redirect: 'error'
      })
      await response.body?.cancel()
    } catch {
      // Session deletion is bounded and best effort; local close still completes.
    } finally {
      clearTimeout(timer)
    }
  }

  async #buildHeaders(signal: AbortSignal, includeContentType: boolean): Promise<Headers> {
    const headers = new Headers(this.#config.headers)
    headers.set('accept', 'application/json, text/event-stream')
    if (includeContentType) headers.set('content-type', 'application/json')
    if (this.#sessionId !== undefined) headers.set('mcp-session-id', this.#sessionId)
    if (this.#protocolVersion !== undefined) {
      headers.set('mcp-protocol-version', this.#protocolVersion)
    }
    if (this.#config.getAuthorizationHeader !== undefined) {
      const authorization = await awaitWithAbort(
        this.#config.getAuthorizationHeader(),
        signal
      )
      if (authorization !== undefined) {
        if (!isBoundedHeaderValue(authorization)) {
          throw new McpClientError('invalid_configuration')
        }
        headers.set('authorization', authorization)
      }
    }
    return headers
  }

  #captureSessionId(headers: Headers): void {
    const value = headers.get('mcp-session-id')
    if (value === null) return
    if (!isBoundedPlainString(value, 2_048) || value.length === 0) {
      throw new McpClientError('protocol_error')
    }
    if (this.#sessionId !== undefined && this.#sessionId !== value) {
      throw new McpClientError('protocol_error')
    }
    this.#sessionId = value
  }

  #allocateRequestId(): number {
    const id = this.#nextRequestId
    this.#nextRequestId += 1
    if (!Number.isSafeInteger(id) || id <= 0) throw new McpClientError('limit_exceeded')
    return id
  }
}

class StdioJsonRpcDecoder {
  #buffer = Buffer.alloc(0)

  push(chunk: Buffer | Uint8Array): unknown[] {
    const input = Buffer.from(chunk)
    this.#buffer = this.#buffer.length === 0
      ? input
      : Buffer.concat([this.#buffer, input], this.#buffer.length + input.length)
    const messages: unknown[] = []

    while (this.#buffer.length > 0) {
      while (this.#buffer[0] === 0x0a || this.#buffer[0] === 0x0d) {
        this.#buffer = this.#buffer.subarray(1)
      }
      if (this.#buffer.length === 0) break

      const firstNewline = this.#buffer.indexOf(0x0a)
      if (firstNewline < 0) {
        if (this.#buffer.length > MAX_WIRE_BYTES + MAX_STDIO_HEADER_BYTES) {
          throw new McpClientError('limit_exceeded')
        }
        break
      }
      const firstLine = this.#buffer.subarray(0, firstNewline).toString('ascii').trim()
      if (/^content-length\s*:/iu.test(firstLine)) {
        const separator = findHeaderSeparator(this.#buffer)
        if (separator === null) {
          if (this.#buffer.length > MAX_STDIO_HEADER_BYTES) {
            throw new McpClientError('protocol_error')
          }
          break
        }
        if (separator.headerBytes > MAX_STDIO_HEADER_BYTES) {
          throw new McpClientError('protocol_error')
        }
        const contentLength = parseContentLength(this.#buffer.subarray(0, separator.headerBytes))
        if (contentLength > MAX_WIRE_BYTES) throw new McpClientError('limit_exceeded')
        const bodyStart = separator.headerBytes + separator.separatorBytes
        if (this.#buffer.length < bodyStart + contentLength) break
        const body = this.#buffer.subarray(bodyStart, bodyStart + contentLength)
        this.#buffer = this.#buffer.subarray(bodyStart + contentLength)
        messages.push(parseJson(body))
        continue
      }

      if (firstNewline > MAX_WIRE_BYTES) throw new McpClientError('limit_exceeded')
      let line = this.#buffer.subarray(0, firstNewline)
      this.#buffer = this.#buffer.subarray(firstNewline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1)
      if (line.length > 0) messages.push(parseJson(line))
    }
    return messages
  }
}

export async function connectMcp(config: McpConnectionConfig): Promise<McpSession> {
  assertMainProcess()
  if (!isRecord(config)) throw new McpClientError('invalid_configuration')
  if (config.transport === 'stdio') {
    const session = new StdioMcpSession(normalizeStdioConfig(config as unknown as McpStdioConfig))
    try {
      await session.start()
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw toMcpClientError(error, 'unavailable')
    }
  }
  if (config.transport === 'http') {
    const session = new HttpMcpSession(normalizeHttpConfig(config as unknown as McpHttpConfig))
    try {
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw toMcpClientError(error, 'unavailable')
    }
  }
  throw new McpClientError('invalid_configuration')
}

/** Short transport-level alias used by the Extension Host. */
export const connect = connectMcp

function normalizeStdioConfig(config: McpStdioConfig): NormalizedStdioConfig {
  if (!isBoundedPlainString(config.command, 32_768) || config.command.length === 0) {
    throw new McpClientError('invalid_configuration')
  }
  const args = config.args ?? []
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    args.some((argument) => !isBoundedPlainString(argument, 32_768))
  ) {
    throw new McpClientError('invalid_configuration')
  }
  if (
    config.cwd !== undefined &&
    (!isBoundedPlainString(config.cwd, 32_768) || !isAbsolute(config.cwd))
  ) {
    throw new McpClientError('invalid_configuration')
  }
  if (config.framing !== undefined && !['newline', 'content-length'].includes(config.framing)) {
    throw new McpClientError('invalid_configuration')
  }
  if (config.onStderr !== undefined && typeof config.onStderr !== 'function') {
    throw new McpClientError('invalid_configuration')
  }
  const environment = buildStdioEnvironment(config.env)
  const explicitSecrets = Object.freeze([
    config.command,
    ...args,
    ...Object.values(environment).filter((value): value is string => typeof value === 'string')
  ])
  return Object.freeze({
    command: config.command,
    args: Object.freeze([...args]),
    cwd: config.cwd,
    env: environment,
    framing: config.framing ?? 'newline',
    requestTimeoutMs: normalizeTimeout(config.requestTimeoutMs),
    onStderr: config.onStderr,
    explicitSecrets
  })
}

function normalizeHttpConfig(config: McpHttpConfig): NormalizedHttpConfig {
  if (!isBoundedPlainString(config.url, 4_096) || config.url.length === 0) {
    throw new McpClientError('invalid_configuration')
  }
  let parsed: URL
  try {
    parsed = new URL(config.url)
  } catch {
    throw new McpClientError('invalid_configuration')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new McpClientError('invalid_configuration')
  }
  if (
    config.getAuthorizationHeader !== undefined &&
    typeof config.getAuthorizationHeader !== 'function'
  ) {
    throw new McpClientError('invalid_configuration')
  }
  const headers = normalizeHeaders(config.headers)
  return Object.freeze({
    url: parsed.toString(),
    headers,
    getAuthorizationHeader: config.getAuthorizationHeader,
    requestTimeoutMs: normalizeTimeout(config.requestTimeoutMs)
  })
}

function buildStdioEnvironment(
  configured: Readonly<Record<string, string>> | undefined
): NodeJS.ProcessEnv {
  if (configured !== undefined && !isRecord(configured)) {
    throw new McpClientError('invalid_configuration')
  }
  const entries = configured === undefined ? [] : Object.entries(configured)
  if (entries.length > 128) throw new McpClientError('invalid_configuration')
  const environment: NodeJS.ProcessEnv = {}
  for (const key of INHERITED_STDIO_ENVIRONMENT_KEYS) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || !isBoundedPlainString(value, 65_536)) {
      throw new McpClientError('invalid_configuration')
    }
    environment[key] = value
  }
  return Object.freeze(environment)
}

function normalizeHeaders(
  configured: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (configured !== undefined && !isRecord(configured)) {
    throw new McpClientError('invalid_configuration')
  }
  const entries = configured === undefined ? [] : Object.entries(configured)
  if (entries.length > 128) throw new McpClientError('invalid_configuration')
  const headers: Record<string, string> = {}
  const managed = new Set(['accept', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version'])
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase()
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(rawName) ||
      managed.has(name) ||
      !isBoundedHeaderValue(value)
    ) {
      throw new McpClientError('invalid_configuration')
    }
    headers[name] = value
  }
  return Object.freeze(headers)
}

function normalizeTool(value: unknown): McpTool {
  if (
    !isRecord(value) ||
    !isBoundedPlainString(value.name, MAX_TOOL_NAME_CHARACTERS) ||
    value.name.length === 0 ||
    !isRecord(value.inputSchema) ||
    (value.description !== undefined && !isBoundedPlainString(value.description, 65_536))
  ) {
    throw new McpClientError('protocol_error')
  }
  return Object.freeze({ ...value }) as McpTool
}

function normalizeToolCallResult(value: unknown): McpToolCallResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.content) ||
    value.content.some((item) => !isRecord(item)) ||
    (value.isError !== undefined && typeof value.isError !== 'boolean')
  ) {
    throw new McpClientError('protocol_error')
  }
  return Object.freeze({ ...value, content: Object.freeze([...value.content]) }) as McpToolCallResult
}

function parseJsonRpcResponse(value: Readonly<Record<string, unknown>>): JsonRpcResponse {
  if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new McpClientError('protocol_error')
  }
  const hasResult = Object.hasOwn(value, 'result')
  const hasError = Object.hasOwn(value, 'error')
  if (hasResult === hasError || (hasError && !isRecord(value.error))) {
    throw new McpClientError('protocol_error')
  }
  return hasError
    ? { id: value.id as number, error: value.error as Readonly<Record<string, unknown>> }
    : { id: value.id as number, result: value.result }
}

function encodeJsonRpc(
  value: Readonly<Record<string, unknown>>,
  framing: 'newline' | 'content-length'
): Buffer {
  const body = Buffer.from(encodeJsonBody(value), 'utf8')
  if (framing === 'newline') return Buffer.concat([body, Buffer.from('\n')])
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body], header.length + body.length)
}

function encodeJsonBody(value: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new McpClientError('invalid_input')
  }
  if (typeof encoded !== 'string') throw new McpClientError('invalid_input')
  if (Buffer.byteLength(encoded, 'utf8') > MAX_WIRE_BYTES) {
    throw new McpClientError('limit_exceeded')
  }
  return encoded
}

function jsonByteLength(value: unknown, fallback: McpClientErrorCode): number {
  try {
    const encoded = JSON.stringify(value)
    if (typeof encoded !== 'string') throw new McpClientError(fallback)
    return Buffer.byteLength(encoded, 'utf8')
  } catch (error) {
    throw toMcpClientError(error, fallback)
  }
}

function parseJson(bytes: Buffer): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return JSON.parse(text) as unknown
  } catch {
    throw new McpClientError('protocol_error')
  }
}

function findHeaderSeparator(buffer: Buffer): {
  readonly headerBytes: number
  readonly separatorBytes: number
} | null {
  const crlf = buffer.indexOf('\r\n\r\n')
  const lf = buffer.indexOf('\n\n')
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { headerBytes: crlf, separatorBytes: 4 }
  return { headerBytes: lf, separatorBytes: 2 }
}

function parseContentLength(headerBytes: Buffer): number {
  const lines = headerBytes.toString('ascii').split(/\r?\n/u)
  const lengths = lines
    .map((line) => /^content-length\s*:\s*([0-9]+)\s*$/iu.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
  if (lengths.length !== 1) throw new McpClientError('protocol_error')
  const length = Number(lengths[0])
  if (!Number.isSafeInteger(length) || length < 0) throw new McpClientError('protocol_error')
  return length
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new McpClientError('protocol_error')
    if (parsed > MAX_WIRE_BYTES) {
      await response.body?.cancel()
      throw new McpClientError('limit_exceeded')
    }
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new McpClientError('cancelled')
      const item = await reader.read()
      if (item.done) break
      const chunk = Buffer.from(item.value)
      total += chunk.length
      if (total > MAX_WIRE_BYTES) {
        await reader.cancel()
        throw new McpClientError('limit_exceeded')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function responseMediaType(contentType: string | null): 'application/json' | 'text/event-stream' {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'text/event-stream') return 'text/event-stream'
  if (mediaType === 'application/json' || mediaType?.endsWith('+json') === true) return 'application/json'
  throw new McpClientError('protocol_error')
}

function decodeJsonHttpResponse(
  mediaType: 'application/json' | 'text/event-stream',
  bytes: Buffer
): readonly unknown[] {
  if (mediaType !== 'application/json' || bytes.length === 0) {
    throw new McpClientError('protocol_error')
  }
  return [parseJson(bytes)]
}

function matchHttpResponse(messages: readonly unknown[], expectedId: number): JsonRpcResponse {
  let matched: JsonRpcResponse | undefined
  for (const message of messages) {
    const response = parseHttpStreamMessage(message)
    if (response === undefined) continue
    if (response.id !== expectedId || matched !== undefined) {
      throw new McpClientError('protocol_error')
    }
    matched = response
  }
  if (matched === undefined) throw new McpClientError('protocol_error')
  return matched
}

function parseHttpStreamMessage(message: unknown): JsonRpcResponse | undefined {
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    throw new McpClientError('protocol_error')
  }
  const hasResult = Object.hasOwn(message, 'result')
  const hasError = Object.hasOwn(message, 'error')
  if (!hasResult && !hasError) {
    if (typeof message.method !== 'string') throw new McpClientError('protocol_error')
    return undefined
  }
  return parseJsonRpcResponse(message)
}

async function readIncrementalSseResponse(
  response: Response,
  expectedId: number,
  signal: AbortSignal
): Promise<JsonRpcResponse> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new McpClientError('protocol_error')
    if (parsed > MAX_WIRE_BYTES) {
      await response.body?.cancel()
      throw new McpClientError('limit_exceeded')
    }
  }
  if (response.body === null) throw new McpClientError('protocol_error')

  const reader = response.body.getReader()
  const decoder = new IncrementalSseDecoder()
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw new McpClientError('cancelled')
      const item = await reader.read()
      const messages = item.done ? decoder.finish() : decoder.push(item.value)
      if (!item.done) {
        total += item.value.byteLength
        if (total > MAX_WIRE_BYTES) {
          void reader.cancel().catch(() => undefined)
          throw new McpClientError('limit_exceeded')
        }
      }
      for (const message of messages) {
        const matched = parseHttpStreamMessage(message)
        if (matched === undefined) continue
        if (matched.id !== expectedId) throw new McpClientError('protocol_error')
        void reader.cancel().catch(() => undefined)
        return matched
      }
      if (item.done) throw new McpClientError('protocol_error')
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

class IncrementalSseDecoder {
  #buffer = Buffer.alloc(0)
  #dataLines: string[] = []

  push(chunk: Buffer | Uint8Array): unknown[] {
    const input = Buffer.from(chunk)
    this.#buffer = this.#buffer.length === 0
      ? input
      : Buffer.concat([this.#buffer, input], this.#buffer.length + input.length)
    const messages: unknown[] = []
    let newline = this.#buffer.indexOf(0x0a)
    while (newline >= 0) {
      const line = this.#buffer.subarray(0, newline)
      this.#buffer = this.#buffer.subarray(newline + 1)
      const message = this.#consumeLine(line)
      if (message !== undefined) messages.push(message)
      newline = this.#buffer.indexOf(0x0a)
    }
    if (this.#buffer.length > MAX_WIRE_BYTES) throw new McpClientError('limit_exceeded')
    return messages
  }

  finish(): unknown[] {
    const messages: unknown[] = []
    if (this.#buffer.length > 0) {
      const message = this.#consumeLine(this.#buffer)
      if (message !== undefined) messages.push(message)
      this.#buffer = Buffer.alloc(0)
    }
    const trailing = this.#flushEvent()
    if (trailing !== undefined) messages.push(trailing)
    return messages
  }

  #consumeLine(lineWithOptionalCr: Buffer): unknown | undefined {
    const line = lineWithOptionalCr.at(-1) === 0x0d
      ? lineWithOptionalCr.subarray(0, lineWithOptionalCr.length - 1)
      : lineWithOptionalCr
    if (line.length === 0) return this.#flushEvent()
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(line)
    } catch {
      throw new McpClientError('protocol_error')
    }
    if (text.startsWith(':')) return undefined
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    if (field !== 'data') return undefined
    let value = colon < 0 ? '' : text.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.#dataLines.push(value)
    return undefined
  }

  #flushEvent(): unknown | undefined {
    if (this.#dataLines.length === 0) return undefined
    const data = this.#dataLines.join('\n')
    this.#dataLines = []
    if (data === '[DONE]') return undefined
    try {
      return JSON.parse(data) as unknown
    } catch {
      throw new McpClientError('protocol_error')
    }
  }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new McpClientError('cancelled')
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new McpClientError('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        reject(new McpClientError('request_failed'))
      }
    )
  })
}

function throwIfOperationAborted(operation: ActiveHttpOperation): void {
  if (operation.errorCode !== null) throw new McpClientError(operation.errorCode)
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR
    if (typeof systemRoot === 'string' && isAbsolute(systemRoot) && !/[\r\n\0]/u.test(systemRoot)) {
      try {
        const killer = spawn(
          join(systemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' }
        )
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try {
              child.kill('SIGKILL')
            } catch {
              // taskkill is the primary tree-wide termination mechanism.
            }
            resolve()
          }
          const timer = setTimeout(() => {
            try {
              killer.kill('SIGKILL')
            } catch {
              // The bounded wait remains authoritative.
            }
            finish()
          }, 2_000)
          timer.unref?.()
          killer.once('error', finish)
          killer.once('close', finish)
        })
        return
      } catch {
        // Direct termination below remains available.
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Fall through to the direct child handle.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The public close result is already fixed and path-free.
  }
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_REQUEST_TIMEOUT_MS ||
    timeout > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new McpClientError('invalid_configuration')
  }
  return timeout
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return `${encoded.subarray(0, end).toString('utf8')}...`
}

function redactStderr(value: string, explicitSecrets: readonly string[]): string {
  let redacted = redactSensitiveContent(value, explicitSecrets)
  for (const secret of explicitSecrets) {
    if (secret.length > 0 && secret.length < 4) redacted = redacted.replaceAll(secret, '<redacted>')
  }
  return redacted
}

function isBoundedHeaderValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16_384 && !/[\u0000\r\n]/u.test(value)
}

function isBoundedPlainString(value: unknown, maxCharacters: number): value is string {
  return typeof value === 'string' && value.length <= maxCharacters && !/[\u0000\r\n]/u.test(value)
}

function isJsonRpcId(value: unknown): value is string | number {
  return (
    (Number.isSafeInteger(value) && (value as number) >= 0) ||
    (isBoundedPlainString(value, 256) && value.length > 0)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new McpClientError('cancelled')
}

function toMcpClientError(error: unknown, fallback: McpClientErrorCode): McpClientError {
  return error instanceof McpClientError ? error : new McpClientError(fallback)
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') throw new McpClientError('invalid_configuration')
}
