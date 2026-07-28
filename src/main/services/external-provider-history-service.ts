import { createHash } from 'node:crypto'
import { constants as fsConstants, type Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ConversationSourceProvider } from '../../shared/contracts.ts'
import { conversationTitleFromText } from '../../shared/conversation-title.ts'
import { redactSensitiveContent } from '../security/redaction.ts'

const PROVIDERS = Object.freeze(['claude', 'gemini', 'grok'] as const)
const DEFAULT_MAX_THREADS = 200
const DEFAULT_MAX_CANDIDATES = 1_000
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_TOTAL_SCAN_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_MESSAGES = 2_000
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024
const DEFAULT_MAX_TOTAL_MESSAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_TITLE_CHARACTERS = 160
const MAX_PROJECT_DISPLAY_CHARACTERS = 120
const SOURCE_ID_PATTERN = /^source_[A-Za-z0-9_-]{43}$/u
// Grok session directories are opaque provider IDs. Current CLI builds use
// ULIDs (for example `019f...`), while older builds used UUIDs. Keep the
// segment path-safe without assuming one identifier shape.
const GROK_SESSION_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export type ExternalHistoryProvider = Extract<
  ConversationSourceProvider,
  'claude' | 'gemini' | 'grok'
>

export type ExternalProviderHistoryErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'unavailable'
  | 'corrupt_data'
  | 'limit_exceeded'
  | 'read_failed'

const ERROR_MESSAGES: Readonly<Record<ExternalProviderHistoryErrorCode, string>> = Object.freeze({
  invalid_configuration: 'External conversation history is not configured.',
  invalid_input: 'External conversation history request is invalid.',
  unavailable: 'External conversation history is unavailable.',
  corrupt_data: 'External conversation history contains invalid data.',
  limit_exceeded: 'External conversation history exceeded a configured limit.',
  read_failed: 'External conversation history could not be read.'
})

export class ExternalProviderHistoryError extends Error {
  readonly code: ExternalProviderHistoryErrorCode

  constructor(code: ExternalProviderHistoryErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ExternalProviderHistoryError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface ExternalHistoryThreadSummary {
  readonly provider: ExternalHistoryProvider
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly cwdDisplayName: string
}

export interface ExternalHistoryMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface ExternalHistoryThreadList {
  readonly threads: readonly ExternalHistoryThreadSummary[]
  readonly truncated: boolean
}

export interface ExternalHistoryThreadSnapshot {
  readonly thread: ExternalHistoryThreadSummary
  readonly messages: readonly ExternalHistoryMessage[]
  readonly truncated: boolean
}

export interface ExternalProviderHistoryOptions {
  readonly homeDirectory: string
  readonly maxThreads?: number
  readonly maxCandidates?: number
  readonly maxFileBytes?: number
  readonly maxTotalScanBytes?: number
  readonly maxLineBytes?: number
  readonly maxMessages?: number
  readonly maxMessageBytes?: number
  readonly maxTotalMessageBytes?: number
  readonly maxTitleCharacters?: number
}

interface HistoryLimits {
  readonly maxThreads: number
  readonly maxCandidates: number
  readonly maxFileBytes: number
  readonly maxTotalScanBytes: number
  readonly maxLineBytes: number
  readonly maxMessages: number
  readonly maxMessageBytes: number
  readonly maxTotalMessageBytes: number
  readonly maxTitleCharacters: number
}

interface HistorySourceFile {
  readonly provider: ExternalHistoryProvider
  readonly id: string
  readonly absolutePath: string
  readonly rootPath: string
  readonly cwdDisplayName: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly size: number
}

interface ParsedHistory {
  readonly messages: readonly ExternalHistoryMessage[]
  readonly title: string
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly cwdDisplayName?: string
  readonly truncated: boolean
}

interface MutableMessage {
  role: ExternalHistoryMessage['role']
  text: string
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export class ExternalProviderHistoryService {
  readonly #homeDirectory: string
  readonly #limits: HistoryLimits
  readonly #sources = new Map<string, HistorySourceFile>()

  constructor(options: ExternalProviderHistoryOptions) {
    assertMainProcess()
    if (!isPlainRecord(options) || !hasOnlyKeys(options, [
      'homeDirectory',
      'maxThreads',
      'maxCandidates',
      'maxFileBytes',
      'maxTotalScanBytes',
      'maxLineBytes',
      'maxMessages',
      'maxMessageBytes',
      'maxTotalMessageBytes',
      'maxTitleCharacters'
    ])) {
      throw new ExternalProviderHistoryError('invalid_configuration')
    }
    if (
      typeof options.homeDirectory !== 'string' ||
      !isAbsolute(options.homeDirectory) ||
      options.homeDirectory.length > 4_096 ||
      /[\r\n\0]/u.test(options.homeDirectory)
    ) {
      throw new ExternalProviderHistoryError('invalid_configuration')
    }
    this.#homeDirectory = resolve(options.homeDirectory)
    this.#limits = Object.freeze({
      maxThreads: positiveLimit(options.maxThreads, DEFAULT_MAX_THREADS),
      maxCandidates: positiveLimit(options.maxCandidates, DEFAULT_MAX_CANDIDATES),
      maxFileBytes: positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
      maxTotalScanBytes: positiveLimit(options.maxTotalScanBytes, DEFAULT_MAX_TOTAL_SCAN_BYTES),
      maxLineBytes: positiveLimit(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES),
      maxMessages: positiveLimit(options.maxMessages, DEFAULT_MAX_MESSAGES),
      maxMessageBytes: positiveLimit(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
      maxTotalMessageBytes: positiveLimit(
        options.maxTotalMessageBytes,
        DEFAULT_MAX_TOTAL_MESSAGE_BYTES
      ),
      maxTitleCharacters: positiveLimit(
        options.maxTitleCharacters,
        DEFAULT_MAX_TITLE_CHARACTERS
      )
    })
  }

  async listThreads(
    options: { readonly provider?: ExternalHistoryProvider } = {}
  ): Promise<ExternalHistoryThreadList> {
    if (!isPlainRecord(options) || !hasOnlyKeys(options, ['provider'])) {
      throw new ExternalProviderHistoryError('invalid_input')
    }
    if (options.provider !== undefined && !isExternalHistoryProvider(options.provider)) {
      throw new ExternalProviderHistoryError('invalid_input')
    }

    const providers = options.provider === undefined ? PROVIDERS : [options.provider]
    const threads: ExternalHistoryThreadSummary[] = []
    let truncated = false
    this.#sources.clear()

    for (const provider of providers) {
      const scanned = await this.#scanProvider(provider)
      truncated ||= scanned.truncated
      for (const source of scanned.sources) {
        if (threads.length >= this.#limits.maxThreads) {
          truncated = true
          break
        }
        let parsed: ParsedHistory
        try {
          parsed = await this.#parseSource(source)
        } catch {
          continue
        }
        const thread = toThreadSummary(source, parsed)
        threads.push(thread)
        this.#sources.set(sourceKey(provider, source.id), source)
      }
    }

    threads.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    return { threads: Object.freeze(threads), truncated }
  }

  async readThread(
    provider: ExternalHistoryProvider,
    sourceId: string
  ): Promise<ExternalHistoryThreadSnapshot> {
    if (!isExternalHistoryProvider(provider) || !SOURCE_ID_PATTERN.test(sourceId)) {
      throw new ExternalProviderHistoryError('invalid_input')
    }

    let source = this.#sources.get(sourceKey(provider, sourceId))
    if (source === undefined) {
      const scanned = await this.#scanProvider(provider)
      source = scanned.sources.find((candidate) => candidate.id === sourceId)
      if (source !== undefined) this.#sources.set(sourceKey(provider, source.id), source)
    }
    if (source === undefined) throw new ExternalProviderHistoryError('unavailable')

    const parsed = await this.#parseSource(source)
    return {
      thread: toThreadSummary(source, parsed),
      messages: parsed.messages,
      truncated: parsed.truncated
    }
  }

  async #scanProvider(provider: ExternalHistoryProvider): Promise<{
    sources: readonly HistorySourceFile[]
    truncated: boolean
  }> {
    const rootPath = providerRoot(this.#homeDirectory, provider)
    const root = await inspectDirectory(rootPath)
    if (root === null) return { sources: [], truncated: false }

    const candidates = provider === 'claude'
      ? await scanClaudeSources(root.absolutePath, this.#limits.maxCandidates)
      : provider === 'gemini'
        ? await scanGeminiSources(root.absolutePath, this.#limits.maxCandidates)
        : await scanGrokSources(root.absolutePath, this.#limits.maxCandidates)
    const sources: HistorySourceFile[] = []
    let aggregateBytes = 0
    let truncated = candidates.truncated

    for (const candidate of candidates.files) {
      if (sources.length >= this.#limits.maxThreads) {
        truncated = true
        break
      }
      const inspected = await inspectSourceFile(root.absolutePath, candidate.absolutePath)
      if (inspected === null || inspected.size > this.#limits.maxFileBytes) continue
      if (aggregateBytes + inspected.size > this.#limits.maxTotalScanBytes) {
        truncated = true
        break
      }
      aggregateBytes += inspected.size
      const id = sourceId(provider, inspected.absolutePath)
      sources.push(Object.freeze({
        provider,
        id,
        absolutePath: inspected.absolutePath,
        rootPath: root.absolutePath,
        cwdDisplayName: safeDisplayName(candidate.cwdDisplayName, providerLabel(provider)),
        createdAt: Math.max(0, Math.floor(inspected.createdAt)),
        updatedAt: Math.max(0, Math.floor(inspected.updatedAt)),
        size: inspected.size
      }))
    }
    sources.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    return { sources: Object.freeze(sources), truncated }
  }

  async #parseSource(source: HistorySourceFile): Promise<ParsedHistory> {
    const text = await readBoundedUtf8File(source, this.#limits)
    const records = parseJsonLines(text, this.#limits.maxLineBytes)
    if (source.provider === 'claude') return parseClaudeHistory(records, source, this.#limits)
    if (source.provider === 'gemini') return parseGeminiHistory(records, source, this.#limits)
    return parseGrokHistory(records, source, this.#limits)
  }
}

async function scanClaudeSources(rootPath: string, maxCandidates: number): Promise<{
  files: readonly { absolutePath: string; cwdDisplayName: string }[]
  truncated: boolean
}> {
  const projects = await inspectDirectory(join(rootPath, 'projects'))
  if (projects === null) return { files: [], truncated: false }
  const files: Array<{ absolutePath: string; cwdDisplayName: string }> = []
  let truncated = false
  for (const project of await safeDirectoryEntries(projects.absolutePath)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectPath = join(projects.absolutePath, project.name)
    const directory = await inspectDirectory(projectPath)
    if (directory === null) continue
    for (const entry of await safeDirectoryEntries(directory.absolutePath)) {
      if (files.length >= maxCandidates) {
        truncated = true
        break
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}\.jsonl$/iu.test(entry.name)) {
        continue
      }
      files.push({
        absolutePath: join(directory.absolutePath, entry.name),
        cwdDisplayName: decodeProjectDisplayName(project.name)
      })
    }
    if (truncated) break
  }
  return { files: Object.freeze(files), truncated }
}

async function scanGeminiSources(rootPath: string, maxCandidates: number): Promise<{
  files: readonly { absolutePath: string; cwdDisplayName: string }[]
  truncated: boolean
}> {
  const tmp = await inspectDirectory(join(rootPath, 'tmp'))
  if (tmp === null) return { files: [], truncated: false }
  const files: Array<{ absolutePath: string; cwdDisplayName: string }> = []
  let truncated = false
  for (const project of await safeDirectoryEntries(tmp.absolutePath)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectPath = join(tmp.absolutePath, project.name)
    const projectDirectory = await inspectDirectory(projectPath)
    if (projectDirectory === null) continue
    const cwdDisplayName = await geminiProjectDisplayName(projectDirectory.absolutePath, project.name)
    const chats = await inspectDirectory(join(projectDirectory.absolutePath, 'chats'))
    if (chats === null) continue
    for (const entry of await safeDirectoryEntries(chats.absolutePath)) {
      if (files.length >= maxCandidates) {
        truncated = true
        break
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !/^session-[^\\/]{1,200}\.jsonl$/u.test(entry.name)) {
        continue
      }
      files.push({ absolutePath: join(chats.absolutePath, entry.name), cwdDisplayName })
    }
    if (truncated) break
  }
  return { files: Object.freeze(files), truncated }
}

async function scanGrokSources(rootPath: string, maxCandidates: number): Promise<{
  files: readonly { absolutePath: string; cwdDisplayName: string }[]
  truncated: boolean
}> {
  const sessions = await inspectDirectory(join(rootPath, 'sessions'))
  if (sessions === null) return { files: [], truncated: false }
  const files: Array<{ absolutePath: string; cwdDisplayName: string }> = []
  let truncated = false
  for (const project of await safeDirectoryEntries(sessions.absolutePath)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectPath = join(sessions.absolutePath, project.name)
    const projectDirectory = await inspectDirectory(projectPath)
    if (projectDirectory === null) continue
    for (const session of await safeDirectoryEntries(projectDirectory.absolutePath)) {
      if (files.length >= maxCandidates) {
        truncated = true
        break
      }
      if (
        !session.isDirectory() ||
        session.isSymbolicLink() ||
        !GROK_SESSION_SEGMENT_PATTERN.test(session.name)
      ) {
        continue
      }
      files.push({
        absolutePath: join(projectDirectory.absolutePath, session.name, 'chat_history.jsonl'),
        cwdDisplayName: decodeProjectDisplayName(project.name)
      })
    }
    if (truncated) break
  }
  return { files: Object.freeze(files), truncated }
}

function parseClaudeHistory(
  records: readonly unknown[],
  source: HistorySourceFile,
  limits: HistoryLimits
): ParsedHistory {
  const messages: MutableMessage[] = []
  const keyed = new Map<string, { index: number; fragments: Set<string> }>()
  let createdAt: number | undefined
  let updatedAt: number | undefined
  let cwdDisplayName: string | undefined

  records.forEach((record, recordIndex) => {
    if (!isPlainRecord(record) || (record.type !== 'user' && record.type !== 'assistant')) return
    if (record.isMeta === true || record.isSidechain === true || !isPlainRecord(record.message)) return
    const role = record.message.role
    if (role !== 'user' && role !== 'assistant') return
    const text = visibleText(record.message.content)
    if (!text) return
    const timestamp = parseTimestamp(record.timestamp)
    if (timestamp !== undefined) {
      createdAt = createdAt === undefined ? timestamp : Math.min(createdAt, timestamp)
      updatedAt = updatedAt === undefined ? timestamp : Math.max(updatedAt, timestamp)
    }
    if (cwdDisplayName === undefined && typeof record.cwd === 'string') {
      cwdDisplayName = localPathDisplayName(record.cwd)
    }

    const identity = typeof record.message.id === 'string' && record.message.id.length <= 256
      ? `${role}:${record.message.id}`
      : typeof record.uuid === 'string' && record.uuid.length <= 256
        ? `${role}:${record.uuid}`
        : `${role}:line:${recordIndex}`
    appendKeyedMessage(messages, keyed, identity, role, text, limits)
  })

  return finalizeParsedHistory(messages, source, limits, {
    createdAt,
    updatedAt,
    cwdDisplayName
  })
}

function parseGeminiHistory(
  records: readonly unknown[],
  source: HistorySourceFile,
  limits: HistoryLimits
): ParsedHistory {
  const messages: MutableMessage[] = []
  const keyed = new Map<string, { index: number; fragments: Set<string> }>()
  let createdAt: number | undefined
  let updatedAt: number | undefined

  records.forEach((record, recordIndex) => {
    if (!isPlainRecord(record)) return
    if (record.kind === 'main') {
      const started = parseTimestamp(record.startTime)
      const last = parseTimestamp(record.lastUpdated)
      if (started !== undefined) createdAt = started
      if (last !== undefined) updatedAt = last
      return
    }
    const role = record.type === 'user'
      ? 'user'
      : record.type === 'gemini'
        ? 'assistant'
        : null
    if (role === null) return
    const text = visibleText(record.content)
    if (!text) return
    const timestamp = parseTimestamp(record.timestamp)
    if (timestamp !== undefined) {
      createdAt = createdAt === undefined ? timestamp : Math.min(createdAt, timestamp)
      updatedAt = updatedAt === undefined ? timestamp : Math.max(updatedAt, timestamp)
    }
    const identity = typeof record.id === 'string' && record.id.length <= 256
      ? `${role}:${record.id}`
      : `${role}:line:${recordIndex}`
    appendKeyedMessage(messages, keyed, identity, role, text, limits)
  })

  return finalizeParsedHistory(messages, source, limits, { createdAt, updatedAt })
}

function parseGrokHistory(
  records: readonly unknown[],
  source: HistorySourceFile,
  limits: HistoryLimits
): ParsedHistory {
  const messages: MutableMessage[] = []
  records.forEach((record) => {
    if (!isPlainRecord(record) || (record.type !== 'user' && record.type !== 'assistant')) return
    // Grok writes system reminders as synthetic user records. They are
    // internal context, not user prompts, and must never appear in the
    // imported transcript.
    if (
      record.synthetic_reason === true ||
      (typeof record.synthetic_reason === 'string' && record.synthetic_reason.trim() !== '')
    ) return
    const text = visibleText(record.content)
    if (!text) return
    // Current Grok CLI builds also persist injected environment context as
    // ordinary `type: user` rows without `synthetic_reason`. These complete
    // XML-like blocks are provider metadata, not user-authored conversation.
    // Match only a whole sequence of the two known wrapper blocks so a real
    // prompt that merely mentions either tag is still retained.
    if (record.type === 'user' && isGrokInternalContextText(text)) return
    appendCoalescedMessage(messages, record.type, text, limits)
  })
  return finalizeParsedHistory(messages, source, limits)
}

function isGrokInternalContextText(value: string): boolean {
  let remaining = value.trim()
  if (!remaining) return false
  let matched = false
  const block = /^<(user_info|system-reminder)>[\s\S]*?<\/\1>\s*/iu
  while (remaining) {
    const current = block.exec(remaining)
    if (!current) return false
    matched = true
    remaining = remaining.slice(current[0].length)
  }
  return matched
}

function appendKeyedMessage(
  messages: MutableMessage[],
  keyed: Map<string, { index: number; fragments: Set<string> }>,
  identity: string,
  role: ExternalHistoryMessage['role'],
  rawText: string,
  limits: HistoryLimits
): void {
  const text = normalizeVisibleText(rawText, limits.maxMessageBytes)
  if (!text) return
  const current = keyed.get(identity)
  if (current === undefined) {
    if (messages.length >= limits.maxMessages) return
    messages.push({ role, text })
    keyed.set(identity, { index: messages.length - 1, fragments: new Set([text]) })
    return
  }
  if (current.fragments.has(text)) return
  const message = messages[current.index]
  if (!message || message.role !== role) return
  const combined = normalizeVisibleText(`${message.text}\n\n${text}`, limits.maxMessageBytes)
  if (!combined) return
  current.fragments.add(text)
  message.text = combined
}

function appendCoalescedMessage(
  messages: MutableMessage[],
  role: ExternalHistoryMessage['role'],
  rawText: string,
  limits: HistoryLimits
): void {
  const text = normalizeVisibleText(rawText, limits.maxMessageBytes)
  if (!text) return
  const previous = messages.at(-1)
  if (previous?.role === role) {
    if (previous.text === text || previous.text.endsWith(`\n\n${text}`)) return
    const combined = normalizeVisibleText(`${previous.text}\n\n${text}`, limits.maxMessageBytes)
    if (combined) previous.text = combined
    return
  }
  if (messages.length < limits.maxMessages) messages.push({ role, text })
}

function finalizeParsedHistory(
  messages: readonly MutableMessage[],
  source: HistorySourceFile,
  limits: HistoryLimits,
  metadata: {
    readonly createdAt?: number
    readonly updatedAt?: number
    readonly cwdDisplayName?: string
  } = {}
): ParsedHistory {
  const bounded: ExternalHistoryMessage[] = []
  let bytes = 0
  let truncated = messages.length > limits.maxMessages
  for (const message of messages.slice(0, limits.maxMessages)) {
    const messageBytes = Buffer.byteLength(message.text, 'utf8')
    if (bytes + messageBytes > limits.maxTotalMessageBytes) {
      truncated = true
      break
    }
    bytes += messageBytes
    bounded.push(Object.freeze({ role: message.role, text: message.text }))
  }
  const firstUser = bounded.find((message) => message.role === 'user')?.text
  const title = titleFromText(firstUser, limits.maxTitleCharacters) ?? `${providerLabel(source.provider)} 历史任务`
  return {
    messages: Object.freeze(bounded),
    title,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    cwdDisplayName: metadata.cwdDisplayName,
    truncated
  }
}

function visibleText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const fragments: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      fragments.push(item)
      continue
    }
    if (!isPlainRecord(item)) continue
    if (
      item.type !== undefined &&
      item.type !== 'text' &&
      item.type !== 'input_text' &&
      item.type !== 'output_text'
    ) {
      continue
    }
    if (typeof item.text === 'string') fragments.push(item.text)
  }
  return fragments.length > 0 ? fragments.join('\n') : null
}

async function readBoundedUtf8File(
  source: HistorySourceFile,
  limits: HistoryLimits
): Promise<string> {
  const inspected = await inspectSourceFile(source.rootPath, source.absolutePath)
  if (inspected === null) throw new ExternalProviderHistoryError('unavailable')
  if (inspected.size > limits.maxFileBytes) throw new ExternalProviderHistoryError('limit_exceeded')

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(inspected.absolutePath, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size !== inspected.size || opened.size > limits.maxFileBytes) {
      throw new ExternalProviderHistoryError('read_failed')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (chunk.bytesRead <= 0) break
      offset += chunk.bytesRead
    }
    if (offset !== bytes.length) throw new ExternalProviderHistoryError('read_failed')
    return utf8Decoder.decode(bytes)
  } catch (error) {
    if (error instanceof ExternalProviderHistoryError) throw error
    throw new ExternalProviderHistoryError('read_failed')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseJsonLines(text: string, maxLineBytes: number): readonly unknown[] {
  const records: unknown[] = []
  for (const rawLine of text.split(/\r?\n/gu)) {
    if (!rawLine.trim()) continue
    if (Buffer.byteLength(rawLine, 'utf8') > maxLineBytes) {
      throw new ExternalProviderHistoryError('limit_exceeded')
    }
    try {
      records.push(JSON.parse(rawLine) as unknown)
    } catch {
      throw new ExternalProviderHistoryError('corrupt_data')
    }
  }
  return Object.freeze(records)
}

function normalizeVisibleText(value: string, maxBytes: number): string | null {
  if (/\0/u.test(value)) return null
  const normalized = redactSensitiveContent(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
  if (!normalized) return null
  return truncateUtf8(normalized, maxBytes)
}

function titleFromText(value: string | undefined, maxCharacters: number): string | null {
  if (value === undefined || !value.trim()) return null
  return conversationTitleFromText(value, '', maxCharacters) || null
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const suffix = '...'
  let output = ''
  let bytes = Buffer.byteLength(suffix, 'utf8')
  for (const character of value) {
    const next = Buffer.byteLength(character, 'utf8')
    if (bytes + next > maxBytes) break
    output += character
    bytes += next
  }
  return `${output}${suffix}`
}

function toThreadSummary(
  source: HistorySourceFile,
  parsed: ParsedHistory
): ExternalHistoryThreadSummary {
  const createdAt = parsed.createdAt ?? source.createdAt
  const updatedAt = Math.max(parsed.updatedAt ?? source.updatedAt, createdAt)
  return Object.freeze({
    provider: source.provider,
    id: source.id,
    title: parsed.title,
    createdAt,
    updatedAt,
    cwdDisplayName: safeDisplayName(
      parsed.cwdDisplayName ?? source.cwdDisplayName,
      providerLabel(source.provider)
    )
  })
}

function providerRoot(homeDirectory: string, provider: ExternalHistoryProvider): string {
  return join(homeDirectory, `.${provider}`)
}

function sourceId(provider: ExternalHistoryProvider, absolutePath: string): string {
  return `source_${createHash('sha256')
    .update('ai-terminal.external-history.v1\0', 'utf8')
    .update(provider, 'utf8')
    .update('\0', 'utf8')
    .update(absolutePath, 'utf8')
    .digest('base64url')}`
}

function sourceKey(provider: ExternalHistoryProvider, id: string): string {
  return `${provider}:${id}`
}

function providerLabel(provider: ExternalHistoryProvider): string {
  if (provider === 'claude') return 'Claude'
  if (provider === 'gemini') return 'Gemini'
  return 'Grok'
}

function decodeProjectDisplayName(value: string): string {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    // Keep the bounded directory name when it is not URI encoded.
  }
  const pathName = localPathDisplayName(decoded)
  if (pathName && pathName !== decoded) return pathName
  const segments = decoded.split(/(?:--|[\\/])/u).filter(Boolean)
  return safeDisplayName(segments.at(-1) ?? decoded, '历史工作区')
}

function localPathDisplayName(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/u, '')
  if (!normalized) return ''
  return safeDisplayName(basename(normalized), '')
}

async function geminiProjectDisplayName(projectPath: string, fallback: string): Promise<string> {
  const projectRootFile = await inspectSourceFile(projectPath, join(projectPath, '.project_root'))
  if (projectRootFile === null || projectRootFile.size > 4_096) {
    return safeDisplayName(fallback, 'Gemini')
  }
  try {
    const source: HistorySourceFile = {
      provider: 'gemini',
      id: sourceId('gemini', projectRootFile.absolutePath),
      absolutePath: projectRootFile.absolutePath,
      rootPath: projectPath,
      cwdDisplayName: '',
      createdAt: projectRootFile.createdAt,
      updatedAt: projectRootFile.updatedAt,
      size: projectRootFile.size
    }
    const content = await readBoundedUtf8File(source, {
      maxThreads: 1,
      maxCandidates: 1,
      maxFileBytes: 4_096,
      maxTotalScanBytes: 4_096,
      maxLineBytes: 4_096,
      maxMessages: 1,
      maxMessageBytes: 4_096,
      maxTotalMessageBytes: 4_096,
      maxTitleCharacters: 120
    })
    return safeDisplayName(localPathDisplayName(content), fallback)
  } catch {
    return safeDisplayName(fallback, 'Gemini')
  }
}

function safeDisplayName(value: string, fallback: string): string {
  const normalized = redactSensitiveContent(value)
    .replace(/[\r\n\0]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) return fallback
  return normalized.length <= MAX_PROJECT_DISPLAY_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_PROJECT_DISPLAY_CHARACTERS - 3)}...`
}

async function inspectDirectory(absolutePath: string): Promise<{
  readonly absolutePath: string
} | null> {
  try {
    const stats = await stat(absolutePath, { bigint: false })
    if (!stats.isDirectory()) return null
    const canonical = resolve(await realpath(absolutePath))
    if (!samePath(canonical, absolutePath)) return null
    return { absolutePath: canonical }
  } catch {
    return null
  }
}

async function safeDirectoryEntries(absolutePath: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(absolutePath, { withFileTypes: true })
  } catch {
    return []
  }
}

async function inspectSourceFile(rootPath: string, absolutePath: string): Promise<{
  readonly absolutePath: string
  readonly size: number
  readonly createdAt: number
  readonly updatedAt: number
} | null> {
  try {
    const canonicalRoot = resolve(await realpath(rootPath))
    const target = resolve(absolutePath)
    if (!isInsideRoot(canonicalRoot, target)) return null
    const stats = await stat(target, { bigint: false })
    if (!stats.isFile() || stats.size < 0 || !Number.isSafeInteger(stats.size)) return null
    const canonicalTarget = resolve(await realpath(target))
    if (!samePath(canonicalTarget, target) || !isInsideRoot(canonicalRoot, canonicalTarget)) return null
    return {
      absolutePath: canonicalTarget,
      size: stats.size,
      createdAt: Number.isFinite(stats.birthtimeMs) ? stats.birthtimeMs : stats.mtimeMs,
      updatedAt: stats.mtimeMs
    }
  } catch {
    return null
  }
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value < 10_000_000_000 ? value * 1_000 : value
  }
  if (typeof value !== 'string' || value.length < 4 || value.length > 80) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function positiveLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExternalProviderHistoryError('invalid_configuration')
  }
  return value as number
}

function isExternalHistoryProvider(value: unknown): value is ExternalHistoryProvider {
  return value === 'claude' || value === 'gemini' || value === 'grok'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') {
    throw new ExternalProviderHistoryError('invalid_configuration')
  }
}
