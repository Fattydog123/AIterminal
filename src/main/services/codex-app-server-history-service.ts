import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { redactSensitiveContent } from '../security/redaction.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_LINE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_MAX_PAGES = 10
const DEFAULT_PAGE_SIZE = 50
const DEFAULT_MAX_THREADS = 200
const DEFAULT_MAX_MESSAGES = 2_000
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024
const DEFAULT_MAX_TOTAL_MESSAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_TITLE_CHARACTERS = 200
const DEFAULT_MAX_CWD_DISPLAY_NAME_CHARACTERS = 120
const MAX_OPAQUE_ID_CHARACTERS = 256
const MAX_CURSOR_CHARACTERS = 2_048

function defaultCodexCommand(): string {
  if (process.platform !== 'win32') return 'codex'

  const platformPackage = process.arch === 'arm64'
    ? { name: 'codex-win32-arm64', target: 'aarch64-pc-windows-msvc' }
    : process.arch === 'x64'
      ? { name: 'codex-win32-x64', target: 'x86_64-pc-windows-msvc' }
      : null
  if (platformPackage === null) return 'codex.exe'

  const packageRoots = new Set<string>()
  const managedPackageRoot = process.env.CODEX_MANAGED_PACKAGE_ROOT?.trim()
  if (managedPackageRoot) packageRoots.add(managedPackageRoot)

  const commandRoots = new Set<string>()
  const appData = process.env.APPDATA?.trim()
  if (appData) commandRoots.add(join(appData, 'npm'))
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const normalized = entry.trim().replace(/^"(.*)"$/u, '$1')
    if (normalized) commandRoots.add(normalized)
  }
  for (const root of commandRoots) {
    packageRoots.add(join(root, 'node_modules', '@openai', 'codex'))
  }

  for (const packageRoot of packageRoots) {
    const candidates = [
      join(
        packageRoot,
        'node_modules',
        '@openai',
        platformPackage.name,
        'vendor',
        platformPackage.target,
        'bin',
        'codex.exe'
      ),
      join(
        packageRoot,
        '..',
        platformPackage.name,
        'vendor',
        platformPackage.target,
        'bin',
        'codex.exe'
      )
    ]
    const executable = candidates.find((candidate) => existsSync(candidate))
    if (executable) return executable
  }

  return 'codex.exe'
}

export type CodexHistoryErrorCode =
  | 'invalid_configuration'
  | 'unavailable'
  | 'protocol_error'
  | 'request_failed'
  | 'timeout'
  | 'cancelled'
  | 'process_exited'
  | 'limit_exceeded'
  | 'invalid_input'

const ERROR_MESSAGES: Readonly<Record<CodexHistoryErrorCode, string>> = Object.freeze({
  invalid_configuration: 'Codex history is not configured.',
  unavailable: 'Codex history is unavailable.',
  protocol_error: 'Codex history returned an invalid response.',
  request_failed: 'Codex history could not complete the request.',
  timeout: 'Codex history request timed out.',
  cancelled: 'Codex history request was cancelled.',
  process_exited: 'Codex history service stopped unexpectedly.',
  limit_exceeded: 'Codex history exceeded a configured limit.',
  invalid_input: 'Codex history request is invalid.'
})

export class CodexHistoryError extends Error {
  readonly code: CodexHistoryErrorCode

  constructor(code: CodexHistoryErrorCode) {
    const message = ERROR_MESSAGES[code]
    super(message)
    this.name = 'CodexHistoryError'
    this.code = code
    this.stack = `CodexHistoryError: ${message}`
  }
}

export interface CodexHistoryThreadSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
  readonly cwdDisplayName: string
}

export interface CodexHistoryMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface CodexHistoryThreadList {
  readonly threads: readonly CodexHistoryThreadSummary[]
  readonly truncated: boolean
}

export interface CodexHistoryThreadSnapshot {
  readonly thread: CodexHistoryThreadSummary
  readonly messages: readonly CodexHistoryMessage[]
  readonly truncated: boolean
}

export type CodexHistoryAvailability =
  | { readonly available: true }
  | {
      readonly available: false
      readonly reason: Exclude<CodexHistoryErrorCode, 'cancelled' | 'invalid_input'>
    }

export interface CodexAppServerHistoryOptions {
  readonly command?: string
  readonly args?: readonly string[]
  readonly requestTimeoutMs?: number
  readonly maxResponseLineBytes?: number
  readonly maxRequestBytes?: number
  readonly maxPages?: number
  readonly pageSize?: number
  readonly maxThreads?: number
  readonly maxMessages?: number
  readonly maxMessageBytes?: number
  readonly maxTotalMessageBytes?: number
  readonly maxTitleCharacters?: number
  readonly maxCwdDisplayNameCharacters?: number
}

export interface CodexHistoryListOptions {
  readonly archived?: boolean
  readonly signal?: AbortSignal
}

export interface CodexHistoryReadOptions {
  readonly archived?: boolean
  readonly signal?: AbortSignal
}

interface ServiceLimits {
  readonly requestTimeoutMs: number
  readonly maxResponseLineBytes: number
  readonly maxRequestBytes: number
  readonly maxPages: number
  readonly pageSize: number
  readonly maxThreads: number
  readonly maxMessages: number
  readonly maxMessageBytes: number
  readonly maxTotalMessageBytes: number
  readonly maxTitleCharacters: number
  readonly maxCwdDisplayNameCharacters: number
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: CodexHistoryError) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal: AbortSignal | undefined
  readonly onAbort: (() => void) | undefined
}

interface TruncatedText {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

class BoundedJsonlDecoder {
  readonly maxLineBytes: number
  #pending = Buffer.alloc(0)

  constructor(maxLineBytes: number) {
    this.maxLineBytes = maxLineBytes
  }

  push(chunk: Buffer | Uint8Array): unknown[] {
    const input = Buffer.from(chunk)
    const values: unknown[] = []
    let start = 0

    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== 0x0a) continue
      const segment = input.subarray(start, index)
      if (this.#pending.length + segment.length > this.maxLineBytes) {
        this.#pending = Buffer.alloc(0)
        throw new CodexHistoryError('limit_exceeded')
      }
      const line = this.#pending.length === 0
        ? segment
        : Buffer.concat([this.#pending, segment], this.#pending.length + segment.length)
      this.#pending = Buffer.alloc(0)
      const value = decodeJsonLine(line)
      if (value !== undefined) values.push(value)
      start = index + 1
    }

    const tail = input.subarray(start)
    if (tail.length > 0) {
      if (this.#pending.length + tail.length > this.maxLineBytes) {
        this.#pending = Buffer.alloc(0)
        throw new CodexHistoryError('limit_exceeded')
      }
      this.#pending = this.#pending.length === 0
        ? Buffer.from(tail)
        : Buffer.concat([this.#pending, tail], this.#pending.length + tail.length)
    }
    return values
  }
}

export class CodexAppServerHistoryService {
  readonly #command: string
  readonly #args: readonly string[]
  readonly #limits: ServiceLimits
  readonly #pending = new Map<number, PendingRequest>()
  readonly #archivedByThreadId = new Map<string, boolean>()
  #child: ChildProcessWithoutNullStreams | null = null
  #initialized = false
  #starting: Promise<void> | null = null
  #nextRequestId = 1
  #disposed = false

  constructor(options: CodexAppServerHistoryOptions = {}) {
    assertMainProcess()
    const command = options.command ?? defaultCodexCommand()
    if (!isNonEmptyPlainString(command)) {
      throw new CodexHistoryError('invalid_configuration')
    }
    const args = options.args ?? ['app-server', '--stdio']
    if (
      !Array.isArray(args) ||
      args.length > 32 ||
      args.some((argument) => !isBoundedArgument(argument, 32_768))
    ) {
      throw new CodexHistoryError('invalid_configuration')
    }

    this.#command = command
    this.#args = Object.freeze([...args])
    this.#limits = Object.freeze({
      requestTimeoutMs: positiveLimit(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      maxResponseLineBytes: positiveLimit(
        options.maxResponseLineBytes,
        DEFAULT_MAX_RESPONSE_LINE_BYTES
      ),
      maxRequestBytes: positiveLimit(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES),
      maxPages: positiveLimit(options.maxPages, DEFAULT_MAX_PAGES),
      pageSize: positiveLimit(options.pageSize, DEFAULT_PAGE_SIZE),
      maxThreads: positiveLimit(options.maxThreads, DEFAULT_MAX_THREADS),
      maxMessages: positiveLimit(options.maxMessages, DEFAULT_MAX_MESSAGES),
      maxMessageBytes: positiveLimit(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
      maxTotalMessageBytes: positiveLimit(
        options.maxTotalMessageBytes,
        DEFAULT_MAX_TOTAL_MESSAGE_BYTES
      ),
      maxTitleCharacters: positiveLimit(
        options.maxTitleCharacters,
        DEFAULT_MAX_TITLE_CHARACTERS
      ),
      maxCwdDisplayNameCharacters: positiveLimit(
        options.maxCwdDisplayNameCharacters,
        DEFAULT_MAX_CWD_DISPLAY_NAME_CHARACTERS
      )
    })
  }

  async probe(options: { readonly signal?: AbortSignal } = {}): Promise<CodexHistoryAvailability> {
    try {
      await this.#ensureInitialized(options.signal)
      return { available: true }
    } catch (error) {
      const safeError = toCodexHistoryError(error, 'unavailable')
      if (safeError.code === 'cancelled') throw safeError
      return { available: false, reason: availabilityReason(safeError.code) }
    }
  }

  async listThreads(options: CodexHistoryListOptions = {}): Promise<CodexHistoryThreadList> {
    if (options.archived !== undefined && typeof options.archived !== 'boolean') {
      throw new CodexHistoryError('invalid_input')
    }
    throwIfAborted(options.signal)
    await this.#ensureInitialized(options.signal)

    const archived = options.archived ?? false
    const threads: CodexHistoryThreadSummary[] = []
    const threadIds = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    let truncated = false

    for (let page = 0; page < this.#limits.maxPages; page += 1) {
      const response = await this.#request('thread/list', {
        cursor,
        limit: this.#limits.pageSize,
        archived,
        useStateDbOnly: true
      }, options.signal)
      const parsed = parseThreadListResponse(response)
      let consumedItems = 0

      for (let index = 0; index < parsed.data.length; index += 1) {
        if (threads.length >= this.#limits.maxThreads) {
          truncated = true
          break
        }
        const summary = normalizeThreadSummary(parsed.data[index], archived, this.#limits)
        if (threadIds.has(summary.id)) throw new CodexHistoryError('protocol_error')
        threadIds.add(summary.id)
        threads.push(summary)
        this.#rememberArchivedState(summary.id, archived)
        consumedItems += 1
      }

      if (threads.length >= this.#limits.maxThreads) {
        if (parsed.nextCursor !== null || consumedItems < parsed.data.length) truncated = true
        break
      }
      if (parsed.nextCursor === null) break
      if (seenCursors.has(parsed.nextCursor) || parsed.nextCursor === cursor) {
        throw new CodexHistoryError('protocol_error')
      }
      seenCursors.add(parsed.nextCursor)
      cursor = parsed.nextCursor
      if (page + 1 >= this.#limits.maxPages) truncated = true
    }

    return { threads, truncated }
  }

  async readThread(
    threadId: string,
    options: CodexHistoryReadOptions = {}
  ): Promise<CodexHistoryThreadSnapshot> {
    if (!isOpaqueId(threadId)) throw new CodexHistoryError('invalid_input')
    if (options.archived !== undefined && typeof options.archived !== 'boolean') {
      throw new CodexHistoryError('invalid_input')
    }
    throwIfAborted(options.signal)
    await this.#ensureInitialized(options.signal)

    const response = await this.#request('thread/read', {
      threadId,
      includeTurns: true
    }, options.signal)
    if (!isRecord(response) || !isRecord(response.thread)) {
      throw new CodexHistoryError('protocol_error')
    }
    if (response.thread.id !== threadId || !Array.isArray(response.thread.turns)) {
      throw new CodexHistoryError('protocol_error')
    }

    const archived = options.archived ?? this.#archivedByThreadId.get(threadId) ?? false
    const thread = normalizeThreadSummary(response.thread, archived, this.#limits)
    const normalized = normalizeVisibleMessages(response.thread.turns, this.#limits)
    this.#rememberArchivedState(thread.id, archived)
    return { thread, messages: normalized.messages, truncated: normalized.truncated }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#terminate(new CodexHistoryError('cancelled'))
    this.#archivedByThreadId.clear()
  }

  async #ensureInitialized(signal: AbortSignal | undefined): Promise<void> {
    if (this.#disposed) throw new CodexHistoryError('invalid_configuration')
    throwIfAborted(signal)
    if (this.#initialized && this.#child !== null) return

    if (this.#starting === null) {
      const starting = this.#startAndInitialize(signal)
      this.#starting = starting
      void starting.finally(() => {
        if (this.#starting === starting) this.#starting = null
      }).catch(() => undefined)
    }
    await this.#awaitStarting(this.#starting, signal)
  }

  async #awaitStarting(starting: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await starting
      return
    }
    if (signal.aborted) {
      const error = new CodexHistoryError('cancelled')
      this.#terminate(error)
      throw error
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const error = new CodexHistoryError('cancelled')
        this.#terminate(error)
        reject(error)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      starting.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }

  async #startAndInitialize(signal: AbortSignal | undefined): Promise<void> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.#command, [...this.#args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      throw new CodexHistoryError('unavailable')
    }

    this.#child = child
    this.#initialized = false
    const decoder = new BoundedJsonlDecoder(this.#limits.maxResponseLineBytes)
    let spawned = false

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.#child !== child) return
      try {
        for (const value of decoder.push(chunk)) this.#handleMessage(child, value)
      } catch (error) {
        this.#terminate(toCodexHistoryError(error, 'protocol_error'))
      }
    })
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => {
      this.#failChild(child, new CodexHistoryError('process_exited'))
    })
    child.on('spawn', () => {
      spawned = true
    })
    child.on('error', () => {
      this.#failChild(
        child,
        new CodexHistoryError(spawned ? 'process_exited' : 'unavailable')
      )
    })
    child.on('exit', () => {
      this.#failChild(child, new CodexHistoryError('process_exited'))
    })

    try {
      await this.#waitForSpawn(child, signal)
      const initializeResult = await this.#requestOnChild(child, 'initialize', {
        clientInfo: { name: 'ai-terminal', title: 'AI Terminal', version: '0.1.0' },
        capabilities: {}
      }, signal)
      if (!isRecord(initializeResult)) throw new CodexHistoryError('protocol_error')
      this.#notify(child, 'initialized', {})
      if (this.#child !== child) throw new CodexHistoryError('process_exited')
      this.#initialized = true
    } catch (error) {
      const safeError = toCodexHistoryError(error, 'unavailable')
      if (this.#child === child) this.#terminate(safeError)
      throw safeError
    }
  }

  async #waitForSpawn(
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal | undefined
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: CodexHistoryError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.removeListener('spawn', onSpawn)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onSpawn = (): void => finish()
      const onError = (): void => finish(new CodexHistoryError('unavailable'))
      const onExit = (): void => finish(new CodexHistoryError('process_exited'))
      const onAbort = (): void => {
        const error = new CodexHistoryError('cancelled')
        this.#terminate(error)
        finish(error)
      }
      const timer = setTimeout(() => {
        const error = new CodexHistoryError('timeout')
        this.#terminate(error)
        finish(error)
      }, this.#limits.requestTimeoutMs)

      child.once('spawn', onSpawn)
      child.once('error', onError)
      child.once('exit', onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  async #request(method: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const child = this.#child
    if (!this.#initialized || child === null) throw new CodexHistoryError('process_exited')
    return await this.#requestOnChild(child, method, params, signal)
  }

  async #requestOnChild(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    throwIfAborted(signal)
    if (this.#child !== child) throw new CodexHistoryError('process_exited')
    const id = this.#nextRequestId
    this.#nextRequestId += 1
    if (!Number.isSafeInteger(id)) throw new CodexHistoryError('limit_exceeded')
    const encoded = encodeMessage({ id, method, params }, this.#limits.maxRequestBytes)

    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = signal === undefined
        ? undefined
        : (): void => this.#terminate(new CodexHistoryError('cancelled'))
      const timer = setTimeout(() => {
        this.#terminate(new CodexHistoryError('timeout'))
      }, this.#limits.requestTimeoutMs)
      this.#pending.set(id, { resolve, reject, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort!, { once: true })
      child.stdin.write(encoded, (error) => {
        if (error && this.#pending.has(id)) {
          this.#terminate(new CodexHistoryError('process_exited'))
        }
      })
    })
  }

  #notify(child: ChildProcessWithoutNullStreams, method: string, params: unknown): void {
    if (this.#child !== child) throw new CodexHistoryError('process_exited')
    const encoded = encodeMessage({ method, params }, this.#limits.maxRequestBytes)
    child.stdin.write(encoded, (error) => {
      if (error) this.#failChild(child, new CodexHistoryError('process_exited'))
    })
  }

  #handleMessage(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (this.#child !== child) return
    if (!isRecord(value)) {
      this.#terminate(new CodexHistoryError('protocol_error'))
      return
    }
    if (value.id === undefined) {
      if (typeof value.method !== 'string') {
        this.#terminate(new CodexHistoryError('protocol_error'))
      }
      return
    }
    if (!Number.isSafeInteger(value.id)) {
      this.#terminate(new CodexHistoryError('protocol_error'))
      return
    }
    const id = value.id as number
    const pending = this.#pending.get(id)
    if (pending === undefined) {
      this.#terminate(new CodexHistoryError('protocol_error'))
      return
    }
    const hasResult = Object.hasOwn(value, 'result')
    const hasError = Object.hasOwn(value, 'error')
    if (hasResult === hasError) {
      this.#terminate(new CodexHistoryError('protocol_error'))
      return
    }

    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
    if (hasError) pending.reject(new CodexHistoryError('request_failed'))
    else pending.resolve(value.result)
  }

  #failChild(child: ChildProcessWithoutNullStreams, error: CodexHistoryError): void {
    if (this.#child !== child) return
    this.#child = null
    this.#initialized = false
    this.#rejectPending(error)
  }

  #terminate(error: CodexHistoryError): void {
    const child = this.#child
    this.#child = null
    this.#initialized = false
    this.#rejectPending(error)
    if (child === null) return
    try {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill()
    } catch {
      // The child may already have exited; public errors stay fixed and path-free.
    }
  }

  #rejectPending(error: CodexHistoryError): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      if (pending.onAbort !== undefined) {
        pending.signal?.removeEventListener('abort', pending.onAbort)
      }
      pending.reject(error)
    }
  }

  #rememberArchivedState(threadId: string, archived: boolean): void {
    this.#archivedByThreadId.delete(threadId)
    this.#archivedByThreadId.set(threadId, archived)
    while (this.#archivedByThreadId.size > this.#limits.maxThreads) {
      const oldestThreadId = this.#archivedByThreadId.keys().next().value
      if (oldestThreadId === undefined) break
      this.#archivedByThreadId.delete(oldestThreadId)
    }
  }
}

function decodeJsonLine(lineWithOptionalCr: Buffer): unknown | undefined {
  const line = lineWithOptionalCr.at(-1) === 0x0d
    ? lineWithOptionalCr.subarray(0, lineWithOptionalCr.length - 1)
    : lineWithOptionalCr
  if (line.length === 0) return undefined
  try {
    return JSON.parse(utf8Decoder.decode(line)) as unknown
  } catch {
    throw new CodexHistoryError('protocol_error')
  }
}

function encodeMessage(value: unknown, maxBytes: number): Buffer {
  let encoded: Buffer
  try {
    encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  } catch {
    throw new CodexHistoryError('invalid_input')
  }
  if (encoded.length - 1 > maxBytes) throw new CodexHistoryError('limit_exceeded')
  return encoded
}

function parseThreadListResponse(value: unknown): {
  readonly data: readonly unknown[]
  readonly nextCursor: string | null
} {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new CodexHistoryError('protocol_error')
  }
  const nextCursor = value.nextCursor ?? null
  if (
    nextCursor !== null &&
    (!isBoundedPlainString(nextCursor, MAX_CURSOR_CHARACTERS) || nextCursor.length === 0)
  ) {
    throw new CodexHistoryError('protocol_error')
  }
  return { data: value.data, nextCursor }
}

function normalizeThreadSummary(
  value: unknown,
  archived: boolean,
  limits: ServiceLimits
): CodexHistoryThreadSummary {
  if (
    !isRecord(value) ||
    !isOpaqueId(value.id) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw new CodexHistoryError('protocol_error')
  }
  const titleSource = firstString(value.name, value.title, value.preview)
  return {
    id: value.id,
    title: normalizeDisplayText(titleSource, 'Untitled conversation', limits.maxTitleCharacters),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived,
    cwdDisplayName: normalizeCwdDisplayName(value.cwd, limits.maxCwdDisplayNameCharacters)
  }
}

function normalizeVisibleMessages(
  turns: readonly unknown[],
  limits: ServiceLimits
): { readonly messages: readonly CodexHistoryMessage[]; readonly truncated: boolean } {
  const messages: CodexHistoryMessage[] = []
  let totalBytes = 0
  let truncated = false

  for (const turn of turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      throw new CodexHistoryError('protocol_error')
    }
    for (const item of turn.items) {
      const visible = extractVisibleMessage(item)
      if (visible === null) continue
      const safeText = sanitizePublicText(visible.text).trim()
      if (safeText.length === 0) continue
      if (messages.length >= limits.maxMessages) {
        truncated = true
        continue
      }

      const perMessage = truncateUtf8(safeText, limits.maxMessageBytes)
      if (perMessage.truncated) truncated = true
      const remaining = limits.maxTotalMessageBytes - totalBytes
      if (remaining <= 0) {
        truncated = true
        continue
      }
      const withinTotal = truncateUtf8(perMessage.text, remaining)
      if (withinTotal.truncated) truncated = true
      if (withinTotal.text.length === 0) {
        truncated = true
        continue
      }
      messages.push({ role: visible.role, text: withinTotal.text })
      totalBytes += withinTotal.bytes
    }
  }
  return { messages, truncated }
}

function extractVisibleMessage(
  item: unknown
): { readonly role: CodexHistoryMessage['role']; readonly text: string } | null {
  if (!isRecord(item)) return null
  if (item.type === 'agentMessage') {
    return typeof item.text === 'string' ? { role: 'assistant', text: item.text } : null
  }
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return null
  const textParts: string[] = []
  for (const content of item.content) {
    if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
      textParts.push(content.text)
    }
  }
  return textParts.length === 0 ? null : { role: 'user', text: textParts.join('\n') }
}

function normalizeCwdDisplayName(value: unknown, maxCharacters: number): string {
  if (typeof value !== 'string') return 'Workspace'
  const withoutTrailingSeparators = value.replace(/[\\/]+$/g, '')
  const pieces = withoutTrailingSeparators.split(/[\\/]+/u)
  const finalPiece = pieces.at(-1) ?? ''
  return normalizeDisplayText(finalPiece, 'Workspace', maxCharacters)
}

function normalizeDisplayText(value: string | null, fallback: string, maxCharacters: number): string {
  if (value === null) return fallback
  const normalized = sanitizePublicText(value)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized.length === 0) return fallback
  return truncateCharacters(normalized, maxCharacters)
}

function sanitizePublicText(value: string): string {
  return redactSensitiveContent(value).replace(
    /\/{1,2}[^\s"'`,;)}\]<>]+/gu,
    (match: string, offset: number, source: string): string => {
      const precedingText = source.slice(0, offset)
      if (match.startsWith('//') && /(?:https?|wss?|ftp):$/iu.test(precedingText)) {
        return match
      }
      const previousCharacter = source[offset - 1]
      if (previousCharacter !== undefined && /[A-Za-z0-9._-]/u.test(previousCharacter)) {
        return match
      }
      return '<local-path>'
    }
  )
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value)
  return characters.length <= maxCharacters ? value : characters.slice(0, maxCharacters).join('')
}

function truncateUtf8(value: string, maxBytes: number): TruncatedText {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= maxBytes) return { text: value, bytes, truncated: false }
  const characters: string[] = []
  let usedBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (usedBytes + characterBytes > maxBytes) break
    characters.push(character)
    usedBytes += characterBytes
  }
  return { text: characters.join(''), bytes: usedBytes, truncated: true }
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new CodexHistoryError('invalid_configuration')
  }
  return result
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CodexHistoryError('cancelled')
}

function availabilityReason(
  code: CodexHistoryErrorCode
): Exclude<CodexHistoryErrorCode, 'cancelled' | 'invalid_input'> {
  if (code === 'cancelled' || code === 'invalid_input') return 'unavailable'
  return code
}

function toCodexHistoryError(
  error: unknown,
  fallback: CodexHistoryErrorCode
): CodexHistoryError {
  return error instanceof CodexHistoryError ? error : new CodexHistoryError(fallback)
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_OPAQUE_ID_CHARACTERS &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) &&
    redactSensitiveContent(value) === value
  )
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonEmptyPlainString(value: unknown): value is string {
  return isBoundedPlainString(value, 32_768) && value.length > 0
}

function isBoundedArgument(value: unknown, maxCharacters: number): value is string {
  return typeof value === 'string' && value.length <= maxCharacters && !value.includes('\u0000')
}

function isBoundedPlainString(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxCharacters &&
    !/[\u0000\r\n]/u.test(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') {
    throw new CodexHistoryError('invalid_configuration')
  }
}
