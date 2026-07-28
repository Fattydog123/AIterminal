import type { AgentEvent, ApprovalMode } from '../../shared/contracts.ts'
import {
  containsSensitiveCredential,
  redactCredentialContent,
  redactSensitiveContent
} from '../security/redaction.ts'
import type {
  ResponsesFunctionToolDefinition,
  ResponsesJsonObject
} from './responses-client.ts'

const MAX_TASKS_PER_BATCH = 5
const MAX_TASK_PATHS = 12
const MAX_TASK_BYTES = 8 * 1024
const MAX_PATH_BYTES = 4 * 1024
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_STATUS_DETAIL_BYTES = 512
const MAX_TASK_OUTPUT_BYTES = 64 * 1024
const MAX_BATCH_OUTPUT_BYTES = 320 * 1024
const MAX_DEPENDENCY_CONTEXT_BYTES = 96 * 1024
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const WORKSPACE_PROJECT_PATTERN = /^project:workspace:[A-Za-z0-9_-]{43}$/u
const EXPLICIT_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

const DEFAULT_LIMITS: Readonly<AgentTaskGraphLimits> = Object.freeze({
  maxConcurrent: 3,
  maxModelRounds: 40,
  maxToolCalls: 60,
  maxDepth: 2
})

export type AgentTaskRole = 'explorer' | 'implementer' | 'reviewer'
export type AgentTaskMode = 'read' | 'worktree-write'

export interface AgentTaskGraphLimits {
  readonly maxConcurrent: number
  readonly maxModelRounds: number
  readonly maxToolCalls: number
  readonly maxDepth: number
}

export interface AgentTaskWorkspace {
  readonly taskId: string
  readonly projectId: string
  readonly workspaceToken: string
  readonly isolated: boolean
}

export interface AgentTaskWorktreeRequest {
  readonly source: AgentTaskWorkspace
  readonly rootTaskId: string
  readonly agentId: string
  readonly task: string
  readonly ownerWebContentsId: number
  readonly signal: AbortSignal
}

export interface AgentTaskWorktreeResult {
  readonly taskId: string
  readonly projectId: string
  readonly workspaceToken: string
  readonly worktreeId?: string
}

/**
 * Main owns this adapter because it is the only tier that can materialize a
 * managed worktree and issue an owner-bound workspace token for it.
 */
export interface AgentTaskWorktreeAdapter {
  createIsolatedWorkspace(input: AgentTaskWorktreeRequest): Promise<AgentTaskWorktreeResult>
}

export type AgentTaskExecutionResultCode =
  | 'completed'
  | 'empty_response'
  | 'invalid_response'
  | 'tool_failed'
  | 'model_limit'
  | 'tool_limit'
  | 'dependency_failed'
  | 'worktree_unavailable'
  | 'failed'
  | 'cancelled'

export interface AgentTaskExecutionResult {
  readonly ok: boolean
  readonly code: AgentTaskExecutionResultCode
  readonly output: string
}

export interface AgentTaskExecutionContext {
  readonly id: string
  readonly agentId: string
  readonly parentAgentId: string
  readonly role: AgentTaskRole
  readonly mode: AgentTaskMode
  readonly depth: number
  readonly position: number
  readonly prompt: string
  readonly workspace: AgentTaskWorkspace
  readonly signal: AbortSignal
  readonly canDelegate: boolean
  claimModelRound(): boolean
  claimToolCalls(count: number): boolean
  delegate(argumentsValue: ResponsesJsonObject): Promise<string>
}

export interface AgentTaskGraphOptions {
  readonly turnId: string
  readonly rootWorkspace: Omit<AgentTaskWorkspace, 'isolated'>
  readonly ownerWebContentsId: number
  readonly approvalMode: ApprovalMode
  readonly apiKey: string
  readonly signal: AbortSignal
  readonly allowWorktreeWrites: boolean
  readonly worktrees?: AgentTaskWorktreeAdapter
  readonly limits?: Partial<AgentTaskGraphLimits>
  readonly execute: (context: AgentTaskExecutionContext) => Promise<AgentTaskExecutionResult>
  readonly onEvent: (event: AgentEvent) => void
}

export type AgentTaskGraphErrorCode = 'invalid_configuration' | 'invalid_tool_call' | 'cancelled'

export class AgentTaskGraphError extends Error {
  readonly code: AgentTaskGraphErrorCode

  constructor(code: AgentTaskGraphErrorCode) {
    const message = code === 'invalid_configuration'
      ? 'The Agent task graph configuration is invalid.'
      : code === 'invalid_tool_call'
        ? 'The model proposed an invalid Agent task graph.'
        : 'The Agent task graph was cancelled.'
    super(message)
    this.name = 'AgentTaskGraphError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

// Responses strict schemas require every property in `required`. Keep this
// non-strict so legacy { task, paths } entries and optional DAG fields coexist.
export const AGENT_TASK_GRAPH_TOOL: ResponsesFunctionToolDefinition = Object.freeze({
  type: 'function',
  name: 'delegate_tasks',
  description: 'Run one to five bounded Agent tasks as a dependency graph. Read tasks inspect the current workspace; worktree-write tasks edit only a managed isolated worktree.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TASKS_PER_BATCH,
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'A stable identifier used by depends_on. Use letters, numbers, dot, underscore, or hyphen.'
            },
            task: {
              type: 'string',
              description: 'A focused task with a concrete expected result.'
            },
            role: {
              type: 'string',
              enum: ['explorer', 'implementer', 'reviewer'],
              description: 'The task role. Reviewer tasks are always read-only.'
            },
            mode: {
              type: 'string',
              enum: ['read', 'worktree-write'],
              description: 'Use worktree-write only for changes that must be isolated from the source workspace.'
            },
            depends_on: {
              type: 'array',
              maxItems: MAX_TASKS_PER_BATCH - 1,
              items: { type: 'string' },
              description: 'Stable ids in this batch that must complete successfully first.'
            },
            paths: {
              type: 'array',
              maxItems: MAX_TASK_PATHS,
              items: {
                type: 'string',
                description: 'A file or directory path to prioritize. Absolute paths are available only for System Full Access read tasks.'
              }
            }
          },
          required: ['task'],
          additionalProperties: false
        }
      }
    },
    required: ['tasks'],
    additionalProperties: false
  }
})

interface ParsedTask {
  readonly id: string
  readonly explicitId: boolean
  readonly task: string
  readonly role: AgentTaskRole
  readonly mode: AgentTaskMode
  readonly dependsOn: readonly string[]
  readonly paths: readonly string[]
  readonly position: number
  readonly agentId: string
}

interface BatchContext {
  readonly parentAgentId: string
  readonly parentDepth: number
  readonly workspace: AgentTaskWorkspace
  readonly writesAllowed: boolean
}

interface TaskResult extends AgentTaskExecutionResult {
  readonly id: string
  readonly agentId: string
  readonly role: AgentTaskRole
  readonly mode: AgentTaskMode
  readonly position: number
}

type LifecycleStatus = Extract<AgentEvent, { type: 'subagent-status' }>['status']

export class AgentTaskGraph {
  readonly #turnId: string
  readonly #rootTaskId: string
  readonly #rootWorkspace: AgentTaskWorkspace
  readonly #ownerWebContentsId: number
  readonly #approvalMode: ApprovalMode
  readonly #apiKey: string
  readonly #signal: AbortSignal
  readonly #allowWorktreeWrites: boolean
  readonly #worktrees: AgentTaskWorktreeAdapter | undefined
  readonly #limits: Readonly<AgentTaskGraphLimits>
  readonly #execute: AgentTaskGraphOptions['execute']
  readonly #onEvent: AgentTaskGraphOptions['onEvent']
  readonly #permits: PermitPool
  readonly #usedParents = new Set<string>()
  readonly #explicitTaskIds = new Set<string>()
  #batchSequence = 0
  #modelRoundsRemaining: number
  #toolCallsRemaining: number

  constructor(options: AgentTaskGraphOptions) {
    const limits = normalizeLimits(options?.limits)
    if (
      !isRecord(options) ||
      typeof options.turnId !== 'string' ||
      options.turnId.length < 1 ||
      !isRecord(options.rootWorkspace) ||
      typeof options.rootWorkspace.taskId !== 'string' ||
      options.rootWorkspace.taskId.length < 1 ||
      typeof options.rootWorkspace.projectId !== 'string' ||
      !WORKSPACE_PROJECT_PATTERN.test(options.rootWorkspace.projectId) ||
      typeof options.rootWorkspace.workspaceToken !== 'string' ||
      !WORKSPACE_TOKEN_PATTERN.test(options.rootWorkspace.workspaceToken) ||
      !Number.isSafeInteger(options.ownerWebContentsId) ||
      options.ownerWebContentsId <= 0 ||
      !['request', 'auto', 'full'].includes(options.approvalMode) ||
      typeof options.apiKey !== 'string' ||
      !isAbortSignal(options.signal) ||
      typeof options.allowWorktreeWrites !== 'boolean' ||
      (options.worktrees !== undefined && typeof options.worktrees.createIsolatedWorkspace !== 'function') ||
      typeof options.execute !== 'function' ||
      typeof options.onEvent !== 'function' ||
      limits === null
    ) {
      throw new AgentTaskGraphError('invalid_configuration')
    }
    this.#turnId = options.turnId
    this.#rootTaskId = options.rootWorkspace.taskId
    this.#rootWorkspace = Object.freeze({ ...options.rootWorkspace, isolated: false })
    this.#ownerWebContentsId = options.ownerWebContentsId
    this.#approvalMode = options.approvalMode
    this.#apiKey = options.apiKey
    this.#signal = options.signal
    this.#allowWorktreeWrites = options.allowWorktreeWrites
    this.#worktrees = options.worktrees
    this.#limits = limits
    this.#execute = options.execute
    this.#onEvent = options.onEvent
    this.#permits = new PermitPool(options.approvalMode === 'request' ? 1 : limits.maxConcurrent)
    this.#modelRoundsRemaining = limits.maxModelRounds
    this.#toolCallsRemaining = limits.maxToolCalls
  }

  async run(argumentsValue: ResponsesJsonObject): Promise<string> {
    return await this.#runBatch(argumentsValue, {
      parentAgentId: `root:${this.#turnId}`,
      parentDepth: 0,
      workspace: this.#rootWorkspace,
      writesAllowed: this.#allowWorktreeWrites
    })
  }

  async #runBatch(argumentsValue: ResponsesJsonObject, context: BatchContext): Promise<string> {
    if (context.parentDepth >= this.#limits.maxDepth) {
      throw new AgentTaskGraphError('invalid_tool_call')
    }
    this.#batchSequence += 1
    const batchSequence = this.#batchSequence
    const batchCallId = `subagent:batch:${batchSequence}`
    if (this.#usedParents.has(context.parentAgentId)) {
      this.#emit({
        type: 'tool-status',
        turnId: this.#turnId,
        callId: batchCallId,
        label: '多智能体任务',
        status: 'failed'
      })
      return this.#formatBatchFailure('batch_limit')
    }

    const tasks = this.#parseProposal(argumentsValue, batchSequence)
    this.#usedParents.add(context.parentAgentId)
    for (const task of tasks) {
      if (task.explicitId) this.#explicitTaskIds.add(task.id)
    }

    this.#emit({
      type: 'turn-status',
      turnId: this.#turnId,
      status: 'running',
      message: tasks.every((task) => task.mode === 'read')
        ? '正在执行并行只读任务。'
        : '正在执行隔离的多智能体任务。'
    })
    this.#emit({
      type: 'tool-status',
      turnId: this.#turnId,
      callId: batchCallId,
      label: tasks.every((task) => task.mode === 'read') ? '并行只读任务' : '多智能体任务',
      status: 'running'
    })

    const lifecycles = new Map(tasks.map((task) => [
      task.id,
      new TaskLifecycle(task, context.parentAgentId, this.#turnId, this.#apiKey, this.#onEvent)
    ]))
    for (const lifecycle of lifecycles.values()) lifecycle.queue()

    const taskById = new Map(tasks.map((task) => [task.id, task]))
    const executions = new Map<string, Promise<TaskResult>>()
    const executeTask = (task: ParsedTask): Promise<TaskResult> => {
      const existing = executions.get(task.id)
      if (existing) return existing
      const operation = this.#runTask(
        task,
        context,
        task.dependsOn.map((dependencyId) => executeTask(taskById.get(dependencyId)!)),
        lifecycles.get(task.id)!
      )
      executions.set(task.id, operation)
      return operation
    }

    const results = await Promise.all(tasks.map((task) => executeTask(task)))
    const allSucceeded = results.every((result) => result.ok)
    this.#emit({
      type: 'tool-status',
      turnId: this.#turnId,
      callId: batchCallId,
      label: tasks.every((task) => task.mode === 'read') ? '并行只读任务' : '多智能体任务',
      status: allSucceeded ? 'completed' : 'failed'
    })
    if (this.#signal.aborted) throw new AgentTaskGraphError('cancelled')
    return this.#formatBatchResult(results)
  }

  async #runTask(
    task: ParsedTask,
    batch: BatchContext,
    dependencyOperations: readonly Promise<TaskResult>[],
    lifecycle: TaskLifecycle
  ): Promise<TaskResult> {
    const dependencies = await Promise.all(dependencyOperations)
    let permit: Permit | null = null
    try {
      permit = await this.#permits.acquire(this.#signal)
      lifecycle.start()
      if (this.#signal.aborted) {
        lifecycle.finish('cancelled')
        return taskResult(task, false, 'cancelled', 'The task was cancelled.')
      }
      if (dependencies.some((dependency) => !dependency.ok)) {
        lifecycle.finish('failed')
        return taskResult(
          task,
          false,
          'dependency_failed',
          'A required dependency did not complete successfully, so this task was not executed.'
        )
      }

      const workspace = task.mode === 'worktree-write'
        ? await this.#createWorktreeWorkspace(task, batch)
        : batch.workspace
      if (!workspace) {
        lifecycle.finish('failed')
        return taskResult(
          task,
          false,
          'worktree_unavailable',
          this.#worktrees
            ? 'An isolated worktree could not be created. The source workspace was not modified.'
            : 'Isolated worktree execution is not configured. The source workspace was not modified.'
        )
      }

      const depth = batch.parentDepth + 1
      const canDelegate = depth < this.#limits.maxDepth && task.role !== 'reviewer'
      const delegate = async (argumentsValue: ResponsesJsonObject): Promise<string> => {
        if (!canDelegate) throw new AgentTaskGraphError('invalid_tool_call')
        permit?.release()
        permit = null
        try {
          return await this.#runBatch(argumentsValue, {
            parentAgentId: task.agentId,
            parentDepth: depth,
            workspace,
            writesAllowed: batch.writesAllowed
          })
        } finally {
          if (!this.#signal.aborted) permit = await this.#permits.acquire(this.#signal)
        }
      }

      const execution = await this.#execute({
        id: task.id,
        agentId: task.agentId,
        parentAgentId: batch.parentAgentId,
        role: task.role,
        mode: task.mode,
        depth,
        position: task.position,
        prompt: formatTaskPrompt(task, dependencies, workspace, this.#apiKey),
        workspace,
        signal: this.#signal,
        canDelegate,
        claimModelRound: () => this.#claimModelRound(),
        claimToolCalls: (count) => this.#claimToolCalls(count),
        delegate
      })
      const normalized = normalizeExecutionResult(execution, this.#apiKey, this.#approvalMode === 'full')
      lifecycle.finish(normalized.ok ? 'completed' : normalized.code === 'cancelled' ? 'cancelled' : 'failed')
      return { ...taskResult(task, normalized.ok, normalized.code, normalized.output) }
    } catch (error) {
      permit?.release()
      permit = null
      const cancelled = this.#signal.aborted ||
        (error instanceof AgentTaskGraphError && error.code === 'cancelled')
      lifecycle.finish(cancelled ? 'cancelled' : 'failed')
      return taskResult(
        task,
        false,
        cancelled ? 'cancelled' : 'failed',
        cancelled
          ? 'The task was cancelled.'
          : 'The task failed safely. No raw diagnostic details were exposed.'
      )
    } finally {
      permit?.release()
    }
  }

  async #createWorktreeWorkspace(
    task: ParsedTask,
    batch: BatchContext
  ): Promise<AgentTaskWorkspace | null> {
    if (!batch.writesAllowed || !this.#worktrees) return null
    try {
      const isolated = await this.#worktrees.createIsolatedWorkspace({
        source: batch.workspace,
        rootTaskId: this.#rootTaskId,
        agentId: task.agentId,
        task: task.task,
        ownerWebContentsId: this.#ownerWebContentsId,
        signal: this.#signal
      })
      if (
        !isRecord(isolated) ||
        typeof isolated.taskId !== 'string' ||
        isolated.taskId.length < 1 ||
        typeof isolated.projectId !== 'string' ||
        !WORKSPACE_PROJECT_PATTERN.test(isolated.projectId) ||
        typeof isolated.workspaceToken !== 'string' ||
        !WORKSPACE_TOKEN_PATTERN.test(isolated.workspaceToken) ||
        isolated.taskId === batch.workspace.taskId ||
        isolated.projectId === batch.workspace.projectId ||
        isolated.workspaceToken === batch.workspace.workspaceToken ||
        isolated.taskId === this.#rootWorkspace.taskId ||
        isolated.projectId === this.#rootWorkspace.projectId ||
        isolated.workspaceToken === this.#rootWorkspace.workspaceToken ||
        (isolated.worktreeId !== undefined && typeof isolated.worktreeId !== 'string')
      ) return null
      return Object.freeze({
        taskId: isolated.taskId,
        projectId: isolated.projectId,
        workspaceToken: isolated.workspaceToken,
        isolated: true
      })
    } catch {
      return null
    }
  }

  #parseProposal(argumentsValue: ResponsesJsonObject, batchSequence: number): readonly ParsedTask[] {
    if (
      !isRecord(argumentsValue) ||
      !hasExactKeys(argumentsValue, ['tasks']) ||
      !Array.isArray(argumentsValue.tasks) ||
      argumentsValue.tasks.length < 1 ||
      argumentsValue.tasks.length > MAX_TASKS_PER_BATCH
    ) throw new AgentTaskGraphError('invalid_tool_call')

    let argumentBytes = 0
    const tasks = argumentsValue.tasks.map((rawTask, position): ParsedTask => {
      if (!isPlainDataRecord(rawTask)) throw new AgentTaskGraphError('invalid_tool_call')
      const allowedKeys = new Set(['id', 'task_id', 'task', 'role', 'mode', 'depends_on', 'paths'])
      if (Object.keys(rawTask).some((key) => !allowedKeys.has(key))) {
        throw new AgentTaskGraphError('invalid_tool_call')
      }
      if (Object.hasOwn(rawTask, 'id') && Object.hasOwn(rawTask, 'task_id')) {
        throw new AgentTaskGraphError('invalid_tool_call')
      }
      const explicitIdValue = Object.hasOwn(rawTask, 'id') ? rawTask.id : rawTask.task_id
      const explicitId = explicitIdValue !== undefined
      if (explicitId && (
        typeof explicitIdValue !== 'string' ||
        !EXPLICIT_TASK_ID_PATTERN.test(explicitIdValue)
      )) throw new AgentTaskGraphError('invalid_tool_call')
      const id = explicitId ? String(explicitIdValue) : `task-${batchSequence}-${position + 1}`
      if (
        typeof rawTask.task !== 'string' ||
        rawTask.task.length < 1 ||
        rawTask.task !== rawTask.task.trim() ||
        CONTROL_CHARACTER_PATTERN.test(rawTask.task) ||
        Buffer.byteLength(rawTask.task, 'utf8') > MAX_TASK_BYTES ||
        containsUnsafeTaskText(rawTask.task, this.#apiKey, this.#approvalMode === 'full')
      ) throw new AgentTaskGraphError('invalid_tool_call')
      argumentBytes += Buffer.byteLength(rawTask.task, 'utf8')

      const role = rawTask.role ?? 'explorer'
      const mode = rawTask.mode ?? 'read'
      if (!['explorer', 'implementer', 'reviewer'].includes(String(role)) ||
        !['read', 'worktree-write'].includes(String(mode)) ||
        (role === 'reviewer' && mode !== 'read')) {
        throw new AgentTaskGraphError('invalid_tool_call')
      }
      const dependsOn = parseDependencies(rawTask.depends_on)
      const paths = parsePaths(
        rawTask.paths,
        this.#apiKey,
        this.#approvalMode === 'full' && mode === 'read'
      )
      for (const path of paths) argumentBytes += Buffer.byteLength(path, 'utf8')
      for (const dependency of dependsOn) argumentBytes += Buffer.byteLength(dependency, 'utf8')
      if (argumentBytes > MAX_ARGUMENT_BYTES) throw new AgentTaskGraphError('invalid_tool_call')
      return Object.freeze({
        id,
        explicitId,
        task: rawTask.task,
        role: role as AgentTaskRole,
        mode: mode as AgentTaskMode,
        dependsOn,
        paths,
        position,
        agentId: `subagent:${batchSequence}:${explicitId ? id : position + 1}`
      })
    })

    const ids = new Set(tasks.map((task) => task.id))
    if (ids.size !== tasks.length) throw new AgentTaskGraphError('invalid_tool_call')
    if (tasks.some((task) => task.explicitId && this.#explicitTaskIds.has(task.id))) {
      throw new AgentTaskGraphError('invalid_tool_call')
    }
    for (const task of tasks) {
      if (task.dependsOn.includes(task.id) || task.dependsOn.some((id) => !ids.has(id))) {
        throw new AgentTaskGraphError('invalid_tool_call')
      }
    }
    assertAcyclic(tasks)
    return Object.freeze(tasks)
  }

  #claimModelRound(): boolean {
    if (this.#modelRoundsRemaining < 1 || this.#signal.aborted) return false
    this.#modelRoundsRemaining -= 1
    return true
  }

  #claimToolCalls(count: number): boolean {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > this.#toolCallsRemaining ||
      this.#signal.aborted
    ) return false
    this.#toolCallsRemaining -= count
    return true
  }

  #formatBatchResult(results: readonly TaskResult[]): string {
    const payload = JSON.stringify({
      ok: results.every((result) => result.ok),
      tasks: results.map((result) => ({
        index: result.position + 1,
        id: result.id,
        agent_id: result.agentId,
        role: result.role,
        mode: result.mode,
        ok: result.ok,
        code: result.code,
        output: result.output
      }))
    })
    return boundUtf8Text(
      redactTaskContent(payload, this.#apiKey, this.#approvalMode === 'full'),
      MAX_BATCH_OUTPUT_BYTES,
      '\n[subagent batch output truncated by local limit]'
    )
  }

  #formatBatchFailure(code: 'batch_limit'): string {
    return redactTaskContent(JSON.stringify({
      ok: false,
      code,
      tasks: [],
      output: 'Each agent may submit one task batch.'
    }), this.#apiKey, false)
  }

  #emit(event: AgentEvent): void {
    try {
      this.#onEvent(event)
    } catch {
      // Event delivery cannot alter graph scheduling or workspace isolation.
    }
  }
}

class TaskLifecycle {
  readonly #task: ParsedTask
  readonly #parentAgentId: string
  readonly #turnId: string
  readonly #apiKey: string
  readonly #emit: (event: AgentEvent) => void
  #state: 'new' | 'queued' | 'running' | 'terminal' = 'new'

  constructor(
    task: ParsedTask,
    parentAgentId: string,
    turnId: string,
    apiKey: string,
    emit: (event: AgentEvent) => void
  ) {
    this.#task = task
    this.#parentAgentId = parentAgentId
    this.#turnId = turnId
    this.#apiKey = apiKey
    this.#emit = emit
  }

  queue(): void {
    if (this.#state !== 'new') return
    this.#state = 'queued'
    this.#publish('queued')
  }

  start(): void {
    if (this.#state !== 'queued') return
    this.#state = 'running'
    this.#publish('running')
  }

  finish(status: Extract<LifecycleStatus, 'completed' | 'failed' | 'cancelled'>): void {
    if (this.#state === 'queued') this.start()
    if (this.#state !== 'running') return
    this.#state = 'terminal'
    this.#publish(status)
  }

  #publish(status: LifecycleStatus): void {
    const roleLabel: Readonly<Record<AgentTaskRole, string>> = {
      explorer: '探索子任务',
      implementer: '实现子任务',
      reviewer: '审查子任务'
    }
    const legacyLabel = !this.#task.explicitId && this.#task.role === 'explorer' && this.#task.mode === 'read'
      ? `只读子任务 ${this.#task.position + 1}`
      : `${roleLabel[this.#task.role]} ${this.#task.id}`
    this.#emit({
      type: 'subagent-status',
      turnId: this.#turnId,
      agentId: this.#task.agentId,
      parentAgentId: this.#parentAgentId,
      label: legacyLabel,
      detail: boundUtf8Text(
        redactTaskContent(this.#task.task.replace(/\s+/gu, ' ').trim(), this.#apiKey, false),
        MAX_STATUS_DETAIL_BYTES,
        '...'
      ),
      status
    })
  }
}

class Permit {
  readonly #releaseOperation: () => void
  #released = false

  constructor(releaseOperation: () => void) {
    this.#releaseOperation = releaseOperation
  }

  release(): void {
    if (this.#released) return
    this.#released = true
    this.#releaseOperation()
  }
}

interface PermitWaiter {
  readonly signal: AbortSignal
  readonly resolve: (permit: Permit) => void
  readonly reject: (error: AgentTaskGraphError) => void
  readonly abort: () => void
}

class PermitPool {
  #available: number
  readonly #waiters: PermitWaiter[] = []

  constructor(size: number) {
    this.#available = size
  }

  async acquire(signal: AbortSignal): Promise<Permit> {
    if (signal.aborted) throw new AgentTaskGraphError('cancelled')
    if (this.#available > 0) {
      this.#available -= 1
      return new Permit(() => this.#release())
    }
    return await new Promise<Permit>((resolve, reject) => {
      const waiter: PermitWaiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          reject(new AgentTaskGraphError('cancelled'))
        }
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  #release(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.signal.aborted) {
        waiter.reject(new AgentTaskGraphError('cancelled'))
        continue
      }
      waiter.resolve(new Permit(() => this.#release()))
      return
    }
    this.#available += 1
  }
}

function taskResult(
  task: ParsedTask,
  ok: boolean,
  code: AgentTaskExecutionResultCode,
  output: string
): TaskResult {
  return {
    id: task.id,
    agentId: task.agentId,
    role: task.role,
    mode: task.mode,
    position: task.position,
    ok,
    code,
    output
  }
}

function normalizeExecutionResult(
  result: AgentTaskExecutionResult,
  apiKey: string,
  preserveLocalPaths: boolean
): AgentTaskExecutionResult {
  if (
    !isRecord(result) ||
    typeof result.ok !== 'boolean' ||
    !isExecutionResultCode(result.code) ||
    typeof result.output !== 'string'
  ) {
    return {
      ok: false,
      code: 'invalid_response',
      output: 'The task executor returned an invalid result.'
    }
  }
  return {
    ok: result.ok && result.code === 'completed',
    code: result.code,
    output: boundUtf8Text(
      redactTaskContent(result.output, apiKey, preserveLocalPaths),
      MAX_TASK_OUTPUT_BYTES,
      '\n[subagent output truncated by local limit]'
    )
  }
}

function isExecutionResultCode(value: unknown): value is AgentTaskExecutionResultCode {
  return typeof value === 'string' && [
    'completed',
    'empty_response',
    'invalid_response',
    'tool_failed',
    'model_limit',
    'tool_limit',
    'dependency_failed',
    'worktree_unavailable',
    'failed',
    'cancelled'
  ].includes(value)
}

function parseDependencies(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_TASKS_PER_BATCH - 1) {
    throw new AgentTaskGraphError('invalid_tool_call')
  }
  const dependencies = value.map((item): string => {
    if (typeof item !== 'string' || !EXPLICIT_TASK_ID_PATTERN.test(item)) {
      throw new AgentTaskGraphError('invalid_tool_call')
    }
    return item
  })
  if (new Set(dependencies).size !== dependencies.length) {
    throw new AgentTaskGraphError('invalid_tool_call')
  }
  return Object.freeze(dependencies)
}

function parsePaths(value: unknown, apiKey: string, systemReadAccess: boolean): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_TASK_PATHS) {
    throw new AgentTaskGraphError('invalid_tool_call')
  }
  return Object.freeze(value.map((item): string => {
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item !== item.trim() ||
      Buffer.byteLength(item, 'utf8') > MAX_PATH_BYTES
    ) throw new AgentTaskGraphError('invalid_tool_call')
    const path = normalizeTaskPath(item, systemReadAccess)
    if (containsUnsafeTaskText(path, apiKey, systemReadAccess)) {
      throw new AgentTaskGraphError('invalid_tool_call')
    }
    return path
  }))
}

function normalizeTaskPath(value: string, systemReadAccess: boolean): string {
  if (
    value.length > 4_096 ||
    value.includes('\0') ||
    /[\r\n]/u.test(value)
  ) throw new AgentTaskGraphError('invalid_tool_call')
  if (systemReadAccess) return value.replaceAll('\\', '/')
  if (value === '.') return '.'
  if (/^[A-Za-z]:/u.test(value) || /^[/\\]/u.test(value) || value.includes(':')) {
    throw new AgentTaskGraphError('invalid_tool_call')
  }
  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => (
    !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ')
  ))) throw new AgentTaskGraphError('invalid_tool_call')
  return segments.join('/')
}

function containsUnsafeTaskText(value: string, apiKey: string, systemAccess: boolean): boolean {
  if ((apiKey.length > 0 && value.includes(apiKey)) || containsSensitiveCredential(value, [apiKey])) {
    return true
  }
  if (!systemAccess) {
    return containsAbsolutePathReference(value) || redactTaskContent(value, apiKey, false) !== value
  }
  return /(?:\[|<)\s*(?:system|developer|assistant)\s*(?:\]|>)/iu.test(value) ||
    /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/iu.test(value)
}

function containsAbsolutePathReference(value: string): boolean {
  return /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/u.test(value) ||
    /\\\\[^\s]/u.test(value) ||
    /(?:^|[^A-Za-z0-9_\\])\\(?!\\)/u.test(value) ||
    /(?:^|[\s("'=\[{])\/(?![/*])/u.test(value)
}

function assertAcyclic(tasks: readonly ParsedTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const states = new Map<string, 'visiting' | 'visited'>()
  const visit = (task: ParsedTask): void => {
    const state = states.get(task.id)
    if (state === 'visiting') throw new AgentTaskGraphError('invalid_tool_call')
    if (state === 'visited') return
    states.set(task.id, 'visiting')
    for (const dependency of task.dependsOn) visit(byId.get(dependency)!)
    states.set(task.id, 'visited')
  }
  for (const task of tasks) visit(task)
}

function formatTaskPrompt(
  task: ParsedTask,
  dependencies: readonly TaskResult[],
  workspace: AgentTaskWorkspace,
  apiKey: string
): string {
  const paths = task.paths.length > 0
    ? `\n\nPrioritize these ${workspace.isolated ? 'isolated workspace-relative' : 'workspace-relative'} paths:\n${task.paths.map((path) => `- ${path}`).join('\n')}`
    : ''
  const dependencyContext = dependencies.length > 0
    ? `\n\nCompleted dependency results:\n${dependencies.map((dependency) => (
        `- ${dependency.id} (${dependency.role}, ${dependency.code}): ${dependency.output}`
      )).join('\n')}`
    : ''
  return boundUtf8Text(
    redactTaskContent([
      `Act as the ${task.role} for the focused task below.`,
      task.mode === 'worktree-write'
        ? 'Make changes only in the managed isolated workspace. Never target the source workspace.'
        : 'Inspect using only the advertised read-only tools.',
      `Return a concise evidence-based result with ${workspace.isolated ? 'isolated workspace-relative' : 'workspace-relative'} references.`,
      '',
      `Task: ${task.task}${paths}${dependencyContext}`
    ].join('\n'), apiKey, false),
    MAX_TASK_BYTES + MAX_DEPENDENCY_CONTEXT_BYTES,
    '\n[dependency context truncated by local limit]'
  )
}

function normalizeLimits(value: Partial<AgentTaskGraphLimits> | undefined): Readonly<AgentTaskGraphLimits> | null {
  if (value !== undefined && (!isRecord(value) || Object.keys(value).some((key) => ![
    'maxConcurrent', 'maxModelRounds', 'maxToolCalls', 'maxDepth'
  ].includes(key)))) return null
  const merged = { ...DEFAULT_LIMITS, ...value }
  if (
    !Number.isSafeInteger(merged.maxConcurrent) || merged.maxConcurrent < 1 || merged.maxConcurrent > 5 ||
    !Number.isSafeInteger(merged.maxModelRounds) || merged.maxModelRounds < 1 || merged.maxModelRounds > 200 ||
    !Number.isSafeInteger(merged.maxToolCalls) || merged.maxToolCalls < 1 || merged.maxToolCalls > 500 ||
    !Number.isSafeInteger(merged.maxDepth) || merged.maxDepth < 1 || merged.maxDepth > 2
  ) return null
  return Object.freeze(merged)
}

function redactTaskContent(raw: string, apiKey: string, preserveLocalPaths: boolean): string {
  const withoutCurrentApiKey = apiKey ? raw.replaceAll(apiKey, '<redacted>') : raw
  let safe = preserveLocalPaths
    ? redactCredentialContent(withoutCurrentApiKey)
    : redactSensitiveContent(withoutCurrentApiKey)
  while (apiKey && safe.includes(apiKey)) safe = safe.replaceAll(apiKey, '')
  return safe
}

function boundUtf8Text(value: string, maximumBytes: number, suffix: string): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  let end = Math.max(0, maximumBytes - suffixBytes)
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => Object.hasOwn(descriptor, 'value')
  )
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!isRecord(value)) return false
  return typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
}
