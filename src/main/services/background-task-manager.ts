import { randomUUID } from 'node:crypto'

import type {
  AgentEvent,
  ApiResult,
  BackgroundTaskDto,
  BackgroundTaskEventDto,
  TurnStartInput,
  TurnStartResult
} from '../../shared/contracts.ts'
import { redactSensitiveText } from '../security/redaction.ts'

const DOCUMENT_FORMAT = 'ai-terminal.agent-task-supervisor'
const DOCUMENT_VERSION = 1
const MAX_DOCUMENT_BYTES = 1024 * 1024
const MAX_TASKS = 256
const MAX_EVENTS = 80
const MAX_QUEUED_FOLLOW_UPS = 8
const TASK_ID_PATTERN = /^task:[0-9a-f-]{36}$/u
const BACKGROUND_ID_PATTERN = /^bg_[0-9a-f-]{36}$/u

export interface BackgroundTaskStorage {
  read(): Promise<string | null>
  write(serializedDocument: string): Promise<void>
}

export interface AgentTaskSupervisorRuntime {
  startTurn(input: TurnStartInput): Promise<ApiResult<TurnStartResult>>
  cancelPendingStart(requestId: string): boolean
  cancelTurn(turnId: string): boolean
}

export interface BackgroundTaskManagerOptions {
  readonly storage: BackgroundTaskStorage
  readonly clock?: () => number
  readonly onTaskComplete?: (task: BackgroundTaskDto) => void
  readonly onTaskFailed?: (task: BackgroundTaskDto) => void
  readonly onTaskChanged?: (task: BackgroundTaskDto) => void
}

export type AgentTaskSupervisorErrorCode =
  | 'invalid_options'
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'storage_error'
  | 'corrupt_data'

const ERROR_MESSAGES: Readonly<Record<AgentTaskSupervisorErrorCode, string>> = Object.freeze({
  invalid_options: 'The Agent task supervisor is not configured correctly.',
  invalid_input: 'The background Agent request is invalid.',
  not_found: 'The background Agent task was not found.',
  conflict: 'The background Agent task cannot perform that action now.',
  storage_error: 'Background Agent task state could not be stored.',
  corrupt_data: 'Stored background Agent task state is invalid.'
})

export class AgentTaskSupervisorError extends Error {
  readonly code: AgentTaskSupervisorErrorCode

  constructor(code: AgentTaskSupervisorErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'AgentTaskSupervisorError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

interface StoredBackgroundTask extends BackgroundTaskDto {}

interface SupervisorDocument {
  readonly format: typeof DOCUMENT_FORMAT
  readonly version: typeof DOCUMENT_VERSION
  tasks: StoredBackgroundTask[]
}

/**
 * Owns the lifecycle of detached Agent turns. The interface stays small while
 * persistence, event journals, queued follow-ups, restart recovery and
 * cancellation remain local to one module.
 */
export class AgentTaskSupervisor {
  readonly #storage: BackgroundTaskStorage
  readonly #clock: () => number
  readonly #onTaskComplete?: (task: BackgroundTaskDto) => void
  readonly #onTaskFailed?: (task: BackgroundTaskDto) => void
  readonly #onTaskChanged?: (task: BackgroundTaskDto) => void
  readonly #pendingTurns = new Map<string, TurnStartInput[]>()
  readonly #startingRequests = new Map<string, string>()
  #runtime: AgentTaskSupervisorRuntime | null = null
  #document: SupervisorDocument | null = null
  #operationTail: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(options: BackgroundTaskManagerOptions) {
    if (
      !isRecord(options) ||
      typeof options.storage?.read !== 'function' ||
      typeof options.storage?.write !== 'function' ||
      (options.clock !== undefined && typeof options.clock !== 'function') ||
      (options.onTaskComplete !== undefined && typeof options.onTaskComplete !== 'function') ||
      (options.onTaskFailed !== undefined && typeof options.onTaskFailed !== 'function') ||
      (options.onTaskChanged !== undefined && typeof options.onTaskChanged !== 'function')
    ) throw new AgentTaskSupervisorError('invalid_options')
    this.#storage = options.storage
    this.#clock = options.clock ?? Date.now
    this.#onTaskComplete = options.onTaskComplete
    this.#onTaskFailed = options.onTaskFailed
    this.#onTaskChanged = options.onTaskChanged
  }

  connect(runtime: AgentTaskSupervisorRuntime): void {
    if (
      this.#disposed ||
      !isRecord(runtime) ||
      typeof runtime.startTurn !== 'function' ||
      typeof runtime.cancelPendingStart !== 'function' ||
      typeof runtime.cancelTurn !== 'function'
    ) throw new AgentTaskSupervisorError('invalid_options')
    this.#runtime = runtime
  }

  async attach(taskId: string, title: string, turnId: string): Promise<BackgroundTaskDto> {
    validateTaskIdentity(taskId, title)
    if (!isTurnId(turnId)) throw new AgentTaskSupervisorError('invalid_input')
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const existing = document.tasks.find((task) => task.turnId === turnId)
      if (existing) return cloneTask(existing)
      const sameTask = document.tasks.find((task) =>
        task.taskId === taskId && isActiveStatus(task.status)
      )
      if (sameTask) throw new AgentTaskSupervisorError('conflict')
      const timestamp = this.#timestamp()
      const task: StoredBackgroundTask = {
        id: `bg_${randomUUID()}`,
        taskId,
        title: normalizeTitle(title),
        status: 'running',
        createdAt: timestamp,
        updatedAt: timestamp,
        turnId,
        queuedFollowUps: 0,
        events: [{
          id: `event:${randomUUID()}`,
          createdAt: timestamp,
          kind: 'status',
          label: '已转到后台继续运行',
          status: 'running'
        }]
      }
      document.tasks.push(task)
      trimTasks(document)
      await this.#persistDocument(document)
      this.#notifyChanged(task)
      return cloneTask(task)
    })
  }

  async list(): Promise<BackgroundTaskDto[]> {
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      return document.tasks
        .map(cloneTask)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    })
  }

  async followUp(id: string, turn: TurnStartInput): Promise<BackgroundTaskDto> {
    validateBackgroundId(id)
    validateQueuedTurn(turn)
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const task = findTask(document, id)
      if (task.taskId !== turn.taskId || task.status === 'cancelled') {
        throw new AgentTaskSupervisorError('conflict')
      }
      const queue = this.#pendingTurns.get(id) ?? []
      if (queue.length >= MAX_QUEUED_FOLLOW_UPS) throw new AgentTaskSupervisorError('conflict')
      queue.push(structuredClone(turn))
      this.#pendingTurns.set(id, queue)
      task.queuedFollowUps = queue.length
      task.updatedAt = this.#timestamp()
      appendEvent(task, {
        kind: 'status',
        label: '已排队一条后续消息',
        status: 'waiting'
      }, task.updatedAt)
      await this.#persistDocument(document)
      this.#notifyChanged(task)
      if (!isActiveStatus(task.status)) void this.#startNext(id).catch(() => undefined)
      return cloneTask(task)
    })
  }

  async resume(id: string, turn: TurnStartInput): Promise<BackgroundTaskDto> {
    validateBackgroundId(id)
    validateQueuedTurn(turn)
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const task = findTask(document, id)
      if (task.taskId !== turn.taskId || isActiveStatus(task.status)) {
        throw new AgentTaskSupervisorError('conflict')
      }
      this.#pendingTurns.set(id, [structuredClone(turn)])
      task.queuedFollowUps = 1
      task.status = 'queued'
      task.turnId = undefined
      task.error = undefined
      task.result = undefined
      task.updatedAt = this.#timestamp()
      appendEvent(task, {
        kind: 'status',
        label: '已请求继续任务',
        status: 'waiting'
      }, task.updatedAt)
      await this.#persistDocument(document)
      this.#notifyChanged(task)
      void this.#startNext(id).catch(() => undefined)
      return cloneTask(task)
    })
  }

  async cancel(id: string): Promise<boolean> {
    validateBackgroundId(id)
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const task = document.tasks.find((candidate) => candidate.id === id)
      if (!task || !isActiveStatus(task.status)) return false
      if (task.turnId) this.#runtime?.cancelTurn(task.turnId)
      else {
        const requestId = this.#startingRequests.get(id)
        if (requestId) this.#runtime?.cancelPendingStart(requestId)
      }
      this.#pendingTurns.delete(id)
      this.#startingRequests.delete(id)
      task.queuedFollowUps = 0
      task.status = 'cancelled'
      task.updatedAt = this.#timestamp()
      appendEvent(task, {
        kind: 'status',
        label: '任务已停止',
        status: 'cancelled'
      }, task.updatedAt)
      await this.#persistDocument(document)
      this.#notifyChanged(task)
      return true
    })
  }

  handleEvent(event: AgentEvent): void {
    if (this.#disposed || event.type === 'terminal-output') return
    void this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const task = document.tasks.find((candidate) => candidate.turnId === event.turnId)
      if (!task) return
      const timestamp = this.#timestamp()
      const journal = projectEvent(event)
      if (journal) appendEvent(task, journal, timestamp)
      if (event.type === 'turn-status') {
        if (event.status === 'queued' || event.status === 'running') task.status = event.status
        else if (event.status === 'waiting-approval') task.status = 'waiting-approval'
        else if (event.status === 'completed') {
          task.status = 'completed'
          task.result = event.message ? boundedLabel(event.message) : '任务已完成'
        } else if (event.status === 'failed') {
          task.status = 'failed'
          task.error = event.message ? boundedLabel(event.message) : '任务未完成'
        } else task.status = 'cancelled'
      } else if (event.type === 'approval-request') {
        task.status = 'waiting-approval'
      } else if (event.type === 'tool-status' && task.status === 'waiting-approval') {
        task.status = 'running'
      }
      task.updatedAt = timestamp
      const terminal = !isActiveStatus(task.status)
      await this.#persistDocument(document)
      this.#notifyChanged(task)
      if (terminal) {
        if (task.status === 'completed') this.#notifyComplete(task)
        else if (task.status === 'failed') this.#notifyFailed(task)
        if ((this.#pendingTurns.get(task.id)?.length ?? 0) > 0) {
          void this.#startNext(task.id).catch(() => undefined)
        }
      }
    }).catch(() => undefined)
  }

  dispose(): void {
    this.#disposed = true
    this.#runtime = null
    this.#pendingTurns.clear()
    this.#startingRequests.clear()
  }

  async #startNext(id: string): Promise<void> {
    if (this.#disposed || !this.#runtime) return
    const next = await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const task = findTask(document, id)
      if (isActiveStatus(task.status) && task.turnId !== undefined) return null
      const queue = this.#pendingTurns.get(id) ?? []
      const turn = queue.shift()
      if (!turn) return null
      this.#pendingTurns.set(id, queue)
      task.queuedFollowUps = queue.length
      task.status = 'queued'
      task.turnId = undefined
      task.result = undefined
      task.error = undefined
      task.updatedAt = this.#timestamp()
      this.#startingRequests.set(id, turn.requestId)
      await this.#persistDocument(document)
      this.#notifyChanged(task)
      return turn
    })
    if (!next) return
    const result = await this.#runtime.startTurn(next).catch(() => null)
    await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const task = findTask(document, id)
      if (this.#startingRequests.get(id) === next.requestId) this.#startingRequests.delete(id)
      task.updatedAt = this.#timestamp()
      if (task.status === 'cancelled') {
        if (result?.ok) this.#runtime?.cancelTurn(result.value.turnId)
        return
      }
      if (result?.ok) {
        task.turnId = result.value.turnId
        task.status = 'running'
        appendEvent(task, { kind: 'status', label: '后续消息已开始', status: 'running' }, task.updatedAt)
      } else {
        task.status = 'interrupted'
        task.error = result && !result.ok ? boundedLabel(result.error.message) : '任务恢复失败'
        appendEvent(task, { kind: 'status', label: task.error, status: 'failed' }, task.updatedAt)
      }
      await this.#persistDocument(document)
      this.#notifyChanged(task)
    })
  }

  async #loadDocument(): Promise<SupervisorDocument> {
    if (this.#document) return this.#document
    let serialized: string | null
    try {
      serialized = await this.#storage.read()
    } catch {
      throw new AgentTaskSupervisorError('storage_error')
    }
    const document = serialized === null ? emptyDocument() : parseDocument(serialized)
    let recovered = false
    const timestamp = this.#timestamp()
    for (const task of document.tasks) {
      if (!isActiveStatus(task.status)) continue
      task.status = 'interrupted'
      task.turnId = undefined
      task.queuedFollowUps = 0
      task.updatedAt = timestamp
      appendEvent(task, {
        kind: 'status',
        label: '应用上次关闭时任务仍在运行，可继续执行',
        status: 'waiting'
      }, timestamp)
      recovered = true
    }
    this.#document = document
    if (recovered) await this.#persistDocument(document)
    return document
  }

  async #persistDocument(document: SupervisorDocument): Promise<void> {
    const serialized = JSON.stringify(document)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new AgentTaskSupervisorError('storage_error')
    }
    try {
      await this.#storage.write(serialized)
      this.#document = document
    } catch {
      throw new AgentTaskSupervisorError('storage_error')
    }
  }

  #timestamp(): string {
    const value = this.#clock()
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new AgentTaskSupervisorError('invalid_options')
    }
    return new Date(value).toISOString()
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  #notifyChanged(task: StoredBackgroundTask): void {
    try { this.#onTaskChanged?.(cloneTask(task)) } catch { /* observer isolation */ }
  }

  #notifyComplete(task: StoredBackgroundTask): void {
    try { this.#onTaskComplete?.(cloneTask(task)) } catch { /* observer isolation */ }
  }

  #notifyFailed(task: StoredBackgroundTask): void {
    try { this.#onTaskFailed?.(cloneTask(task)) } catch { /* observer isolation */ }
  }
}

/** Backwards-compatible export while callers migrate to the deeper name. */
export { AgentTaskSupervisor as BackgroundTaskManager }

function projectEvent(event: Exclude<AgentEvent, { type: 'terminal-output' }>): Omit<BackgroundTaskEventDto, 'id' | 'createdAt'> | null {
  switch (event.type) {
    case 'turn-status':
      return {
        kind: 'status',
        label: boundedLabel(event.message ?? turnStatusLabel(event.status)),
        status: event.status === 'waiting-approval'
          ? 'waiting'
          : event.status === 'queued' || event.status === 'running'
            ? 'running'
            : event.status === 'completed' ? 'completed'
              : event.status === 'cancelled' ? 'cancelled' : 'failed'
      }
    case 'tool-status':
      return {
        kind: 'tool',
        label: boundedLabel(event.label),
        status: event.status
      }
    case 'subagent-status':
      return {
        kind: 'subagent',
        label: boundedLabel(event.detail ? `${event.label} · ${event.detail}` : event.label),
        status: event.status === 'queued' || event.status === 'running'
          ? 'running'
          : event.status
      }
    case 'approval-request':
      return { kind: 'approval', label: boundedLabel(event.label), status: 'waiting' }
    case 'usage':
      return { kind: 'usage', label: `本轮使用 ${event.totalTokens} tokens`, status: 'completed' }
    case 'assistant-delta':
    case 'image-result':
      return null
  }
}

function appendEvent(
  task: StoredBackgroundTask,
  event: Omit<BackgroundTaskEventDto, 'id' | 'createdAt'>,
  createdAt: string
): void {
  task.events = [...task.events, { id: `event:${randomUUID()}`, createdAt, ...event }].slice(-MAX_EVENTS)
}

function turnStatusLabel(status: Extract<AgentEvent, { type: 'turn-status' }>['status']): string {
  if (status === 'queued') return '任务已排队'
  if (status === 'running') return 'Agent 正在工作'
  if (status === 'waiting-approval') return '等待操作确认'
  if (status === 'completed') return '任务已完成'
  if (status === 'cancelled') return '任务已停止'
  return '任务未完成'
}

function parseDocument(serialized: string): SupervisorDocument {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new AgentTaskSupervisorError('corrupt_data')
  }
  let parsed: unknown
  try { parsed = JSON.parse(serialized) } catch { throw new AgentTaskSupervisorError('corrupt_data') }
  if (
    !isRecord(parsed) ||
    parsed.format !== DOCUMENT_FORMAT ||
    parsed.version !== DOCUMENT_VERSION ||
    !Array.isArray(parsed.tasks) ||
    parsed.tasks.length > MAX_TASKS
  ) throw new AgentTaskSupervisorError('corrupt_data')
  const tasks = parsed.tasks.map(parseTask)
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new AgentTaskSupervisorError('corrupt_data')
  }
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, tasks }
}

function parseTask(value: unknown): StoredBackgroundTask {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' || !BACKGROUND_ID_PATTERN.test(value.id) ||
    typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId) ||
    typeof value.title !== 'string' || value.title.length === 0 || value.title.length > 200 ||
    !isBackgroundStatus(value.status) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
    (value.turnId !== undefined && !isTurnId(value.turnId)) ||
    !Number.isSafeInteger(value.queuedFollowUps) || Number(value.queuedFollowUps) < 0 ||
    Number(value.queuedFollowUps) > MAX_QUEUED_FOLLOW_UPS ||
    !Array.isArray(value.events) || value.events.length > MAX_EVENTS ||
    (value.result !== undefined && typeof value.result !== 'string') ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) throw new AgentTaskSupervisorError('corrupt_data')
  return {
    id: value.id,
    taskId: value.taskId,
    title: value.title,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.turnId ? { turnId: value.turnId } : {}),
    queuedFollowUps: Number(value.queuedFollowUps),
    events: value.events.map(parseEvent),
    ...(value.result === undefined ? {} : { result: boundedLabel(value.result) }),
    ...(value.error === undefined ? {} : { error: boundedLabel(value.error) })
  }
}

function parseEvent(value: unknown): BackgroundTaskEventDto {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' || !/^event:[0-9a-f-]{36}$/u.test(value.id) ||
    !isTimestamp(value.createdAt) ||
    (value.kind !== 'status' && value.kind !== 'tool' && value.kind !== 'subagent' && value.kind !== 'approval' && value.kind !== 'usage') ||
    typeof value.label !== 'string' || value.label.length === 0 || value.label.length > 500 ||
    (value.status !== 'running' && value.status !== 'waiting' && value.status !== 'completed' && value.status !== 'failed' && value.status !== 'cancelled')
  ) throw new AgentTaskSupervisorError('corrupt_data')
  return {
    id: value.id,
    createdAt: value.createdAt,
    kind: value.kind,
    label: value.label,
    status: value.status
  }
}

function emptyDocument(): SupervisorDocument {
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, tasks: [] }
}

function findTask(document: SupervisorDocument, id: string): StoredBackgroundTask {
  const task = document.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new AgentTaskSupervisorError('not_found')
  return task
}

function trimTasks(document: SupervisorDocument): void {
  if (document.tasks.length <= MAX_TASKS) return
  const terminal = document.tasks
    .filter((task) => !isActiveStatus(task.status))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  while (document.tasks.length > MAX_TASKS && terminal.length > 0) {
    const remove = terminal.shift()!
    document.tasks = document.tasks.filter((task) => task.id !== remove.id)
  }
  if (document.tasks.length > MAX_TASKS) throw new AgentTaskSupervisorError('conflict')
}

function cloneTask(task: StoredBackgroundTask): BackgroundTaskDto {
  return structuredClone(task)
}

function validateTaskIdentity(taskId: unknown, title: unknown): void {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId) || typeof title !== 'string') {
    throw new AgentTaskSupervisorError('invalid_input')
  }
  normalizeTitle(title)
}

function validateBackgroundId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !BACKGROUND_ID_PATTERN.test(value)) {
    throw new AgentTaskSupervisorError('invalid_input')
  }
}

function validateQueuedTurn(turn: unknown): asserts turn is TurnStartInput {
  if (
    !isRecord(turn) ||
    typeof turn.taskId !== 'string' || !TASK_ID_PATTERN.test(turn.taskId) ||
    typeof turn.requestId !== 'string' || !/^request_[A-Za-z0-9_-]{32}$/u.test(turn.requestId) ||
    turn.mode !== 'agent' ||
    typeof turn.prompt !== 'string' || turn.prompt.length === 0 || turn.prompt.length > 256 * 1024
  ) throw new AgentTaskSupervisorError('invalid_input')
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0 || normalized.length > 200) {
    throw new AgentTaskSupervisorError('invalid_input')
  }
  return normalized
}

function boundedLabel(value: string): string {
  const redacted = redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return (redacted || '状态已更新').slice(0, 500)
}

function isTurnId(value: unknown): value is string {
  return typeof value === 'string' && /^turn_[A-Za-z0-9_-]{32}$/u.test(value)
}

function isActiveStatus(status: BackgroundTaskDto['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting-approval'
}

function isBackgroundStatus(value: unknown): value is BackgroundTaskDto['status'] {
  return value === 'queued' || value === 'running' || value === 'waiting-approval' ||
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted'
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
