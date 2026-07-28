import type {
  AgentEvent,
  ApiResult,
  ApprovalResolveInput,
  ConversationCreateInput,
  ConversationCompactInput,
  ConversationCompactResult as ConversationCompactDto,
  ConversationMessageDto,
  ConversationRenameInput,
  ConversationSetArchivedInput,
  ConversationSnapshot,
  ConversationSourceRef,
  GeneratedImageData,
  ProjectSummary,
  TaskSummary,
  TurnCancelInput,
  TurnStartInput,
  TurnStartResult,
  WorkspaceMode,
} from '../../../shared/contracts.ts'
import { CONTEXT_COMPACTION_PREFIX } from '../../../shared/contracts.ts'
import { conversationTitleFromText } from '../../../shared/conversation-title.ts'

export type ConversationTurnEvent = Exclude<AgentEvent, { type: 'terminal-output' }>
export type ConversationTurnPhase = 'preparing' | 'queued' | 'thinking' | 'tool' | 'approval' | 'stopping'
export type AgentExecutionKind = 'status' | 'tool' | 'subagent' | 'approval' | 'terminal'
export type AgentExecutionStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface ConversationTurnActivity {
  readonly startedAt: number
  readonly phase: ConversationTurnPhase
  readonly detail: string
}

export interface AgentExecutionEntry {
  readonly id: string
  readonly kind: AgentExecutionKind
  readonly label: string
  readonly detail?: string
  readonly status: AgentExecutionStatus
  readonly startedAt: number
  readonly endedAt?: number
}

export interface ConversationTask {
  readonly id: string
  readonly title: string
  readonly mode: WorkspaceMode
  readonly archivedAt?: string | null
  readonly status?: 'running' | 'failed' | 'unread'
  readonly pinned?: boolean
  readonly readOnly?: boolean
  readonly source?: ConversationSourceRef
}

export interface ConversationTaskGroup {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly tasks: readonly ConversationTask[]
}

export type ConversationApproval = Extract<ConversationTurnEvent, { type: 'approval-request' }>

export interface ConversationSessionSnapshot {
  readonly taskGroups: readonly ConversationTaskGroup[]
  readonly selectedTaskId: string
  readonly title: string
  readonly backendTaskId: string
  readonly selectedTaskArchived: boolean
  readonly selectedTaskReadOnly: boolean
  readonly loadingHistory: boolean
  readonly messages: readonly ConversationMessageDto[]
  readonly executionTracks: Readonly<Record<string, readonly AgentExecutionEntry[]>>
  readonly generatedImages: Readonly<Record<string, readonly string[]>>
  readonly running: boolean
  readonly turnState: 'idle' | 'starting' | 'active'
  readonly activity: ConversationTurnActivity | null
  readonly notice: string
  readonly pendingApproval: ConversationApproval | null
  readonly resolvingApproval: boolean
  readonly historyActionTaskId: string
  readonly historyError: string
  readonly contextSummary: string
  readonly resumableAgentTurn: boolean
  readonly sessionTokens: number
}

export interface ConversationTurnLaunch {
  /** Text shown immediately in Renderer. */
  readonly visiblePrompt: string
  /** Fully prepared prompt sent to Main and persisted by the turn implementation. */
  readonly transportPrompt: string
  readonly request: Omit<TurnStartInput, 'requestId' | 'taskId' | 'prompt'>
  /**
   * Display label of the selected model, stamped on the optimistic assistant
   * message so attribution shows during streaming. Main persists the
   * authoritative label; on reload it comes from the stored message.
   */
  readonly modelLabel?: string
}

export interface ConversationActionResult {
  readonly ok: boolean
  readonly message: string
}

export interface ConversationCompactResult extends ConversationActionResult {
  readonly compacted: boolean
}

export interface ConversationSessionActions {
  initialize(input: { projects: readonly ProjectSummary[]; activeTaskId: string }): Promise<void>
  activateTask(task: ConversationTask): Promise<boolean>
  newTask(mode: WorkspaceMode): boolean
  /** Switch mode while retaining an external provider row for import. */
  switchMode(mode: WorkspaceMode): boolean
  resetForWorkspace(mode: WorkspaceMode): boolean
  send(launch: ConversationTurnLaunch): Promise<boolean>
  stop(): Promise<void>
  /** Release the active Agent turn from Renderer without cancelling it in Main. */
  detachTurn(): boolean
  resolveApproval(decision: ApprovalResolveInput['decision']): Promise<void>
  setArchived(task: ConversationTask, archived: boolean): Promise<ConversationActionResult>
  renameTask(task: ConversationTask, title: string): Promise<ConversationActionResult>
  deleteTask(task: ConversationTask): Promise<ConversationActionResult>
  compact(input: Omit<ConversationCompactInput, 'taskId'>): Promise<ConversationCompactResult>
  setNotice(message: string): void
  clearNotice(): void
  clearHistoryError(): void
}

export interface ConversationSessionController {
  readonly actions: ConversationSessionActions
  getSnapshot(): ConversationSessionSnapshot
  subscribe(listener: () => void): () => void
  connect(): void
  disconnect(): void
  dispose(): void
}

export interface ConversationSessionAdapter {
  createConversation(input: ConversationCreateInput): Promise<ApiResult<TaskSummary>>
  loadConversation(taskId: string): Promise<ApiResult<ConversationSnapshot>>
  /** Import a read-only provider task into the local writable history. */
  importConversation?(
    taskId: string,
    workspaceToken?: string,
    mode?: WorkspaceMode,
  ): Promise<ApiResult<ConversationSnapshot>>
  compactConversation(input: ConversationCompactInput): Promise<ApiResult<ConversationCompactDto>>
  setConversationArchived(input: ConversationSetArchivedInput): Promise<ApiResult<TaskSummary>>
  renameConversation(input: ConversationRenameInput): Promise<ApiResult<TaskSummary>>
  deleteConversation(taskId: string): Promise<ApiResult<null>>
  startTurn(input: TurnStartInput): Promise<ApiResult<TurnStartResult>>
  cancelTurn(input: TurnCancelInput): Promise<ApiResult<null>>
  resolveApproval(input: ApprovalResolveInput): Promise<ApiResult<null>>
  readImage(imageToken: string): Promise<ApiResult<GeneratedImageData>>
  subscribeTurnEvents(listener: (event: ConversationTurnEvent) => void): () => void
}

export interface ConversationTextStream {
  push(text: string): void
  flush(): void
  discard(): void
}

export interface ConversationSessionEnvironment {
  now(): number
  createStartRequestId(): string
  createMessageId(): string
  createTextStream(deliver: (text: string) => void): ConversationTextStream
  createImageUrl(image: GeneratedImageData): string | null
  revokeImageUrl(url: string): void
}

export interface CreateConversationSessionOptions {
  readonly runtime: 'desktop' | 'preview' | 'disconnected'
  readonly adapter: ConversationSessionAdapter
  readonly environment: ConversationSessionEnvironment
  readonly initialMode?: WorkspaceMode
  readonly onModeChange?: (mode: WorkspaceMode) => void
}

type ActiveTurn = {
  kind: 'active'
  requestId: string
  turnId: string
  assistantId: string
  mode: WorkspaceMode
  cancelling: boolean
  startedAt: number
}

type StartingTurn = {
  kind: 'starting'
  requestId: string
  userId: string
  assistantId: string
  mode: WorkspaceMode
  cancelRequested: boolean
  startedAt: number
}

type TurnState = { kind: 'idle' } | StartingTurn | ActiveTurn

const HISTORY_TASK_PATTERN = /^(?:task|codex):[0-9a-f-]{36}$/u
const MAX_BUFFERED_START_EVENTS = 256
const MAX_EXECUTION_ENTRIES = 64

const PREVIEW_TASK_GROUPS: readonly ConversationTaskGroup[] = Object.freeze([
  {
    id: 'terminal',
    name: 'AI终点站',
    path: 'desktop/OneKeyElectron',
    tasks: [
      { id: 'workspace-redesign', title: '完善 React 工作区', mode: 'agent', pinned: true },
      { id: 'security-boundary', title: '核对桌面端安全边界', mode: 'agent', status: 'unread' },
      { id: 'model-catalog', title: '接入动态模型目录', mode: 'chat' },
    ],
  },
  {
    id: 'server',
    name: 'wzh-server',
    path: 'services/new-api',
    tasks: [
      { id: 'endpoint-audit', title: '检查 Responses 与 Images', mode: 'agent', status: 'running' },
      { id: 'channel-config', title: '梳理模型通道配置', mode: 'chat' },
    ],
  },
  {
    id: 'notes',
    name: '产品笔记',
    path: 'design',
    tasks: [
      { id: 'release-plan', title: 'Electron 并行发布计划', mode: 'chat' },
    ],
  },
])

class ConversationSessionImplementation implements ConversationSessionController {
  readonly actions: ConversationSessionActions

  readonly #runtime: CreateConversationSessionOptions['runtime']
  readonly #adapter: ConversationSessionAdapter
  readonly #environment: ConversationSessionEnvironment
  readonly #onModeChange: (mode: WorkspaceMode) => void
  readonly #listeners = new Set<() => void>()
  readonly #imageUrls = new Set<string>()

  #snapshot!: ConversationSessionSnapshot
  #eventUnsubscribe: (() => void) | null = null
  #disposed = false
  #initialized = false
  #userActivated = false
  #activationEpoch = 0
  #imageEpoch = 0
  #approvalEpoch = 0
  #messageSequence = 0
  #executionSequence = 0
  #mode: WorkspaceMode
  #taskGroups: ConversationTaskGroup[]
  #selectedTaskId: string
  #title: string
  #backendTaskId: string
  #loadingHistory = false
  #messages: ConversationMessageDto[] = []
  #executionTracks: Record<string, AgentExecutionEntry[]> = {}
  #generatedImages: Record<string, string[]> = {}
  #turn: TurnState = { kind: 'idle' }
  #activity: ConversationTurnActivity | null = null
  #notice = ''
  #sessionTokens = 0
  #pendingApproval: ConversationApproval | null = null
  #resolvingApproval = false
  #historyActionTaskId = ''
  #historyError = ''
  #contextSummary = ''
  #resumableAgentTurn = false
  #bufferedStartEvents: ConversationTurnEvent[] = []
  #textStream: { assistantId: string; stream: ConversationTextStream } | null = null
  #agentResponseTurnId = ''

  constructor(options: CreateConversationSessionOptions) {
    this.#runtime = options.runtime
    this.#adapter = options.adapter
    this.#environment = options.environment
    this.#onModeChange = options.onModeChange ?? (() => undefined)
    this.#mode = options.initialMode ?? 'agent'
    this.#taskGroups = options.runtime === 'preview'
      ? PREVIEW_TASK_GROUPS.map(cloneTaskGroup)
      : []
    this.#selectedTaskId = options.runtime === 'preview' ? 'workspace-redesign' : ''
    this.#title = options.runtime === 'preview' ? '完善 React 工作区' : '新 Agent 任务'
    this.#backendTaskId = options.runtime === 'preview' ? 'workspace-redesign' : ''
    this.actions = Object.freeze<ConversationSessionActions>({
      initialize: (input) => this.#initialize(input),
      activateTask: (task) => this.#activateTask(task, true),
      newTask: (mode) => this.#newTask(mode, true, mode === 'agent' ? '新 Agent 任务' : '新 Chat'),
      switchMode: (mode) => this.#switchMode(mode),
      resetForWorkspace: (mode) => this.#newTask(mode, true, '新任务'),
      send: (launch) => this.#send(launch),
      stop: () => this.#stop(),
      detachTurn: () => this.#detachTurn(),
      resolveApproval: (decision) => this.#resolveApproval(decision),
      setArchived: (task, archived) => this.#setArchived(task, archived),
      renameTask: (task, title) => this.#renameTask(task, title),
      deleteTask: (task) => this.#deleteTask(task),
      compact: (input) => this.#compact(input),
      setNotice: (message) => this.#setNotice(message),
      clearNotice: () => this.#setNotice(''),
      clearHistoryError: () => this.#setHistoryError(''),
    })
    this.#publish()
  }

  getSnapshot = (): ConversationSessionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  connect(): void {
    if (this.#disposed || this.#eventUnsubscribe) return
    this.#eventUnsubscribe = this.#adapter.subscribeTurnEvents((event) => this.#receiveEvent(event))
  }

  disconnect(): void {
    this.#eventUnsubscribe?.()
    this.#eventUnsubscribe = null
  }

  dispose(): void {
    if (this.#disposed) return
    const turn = this.#turn
    this.disconnect()
    this.#disposed = true
    this.#turn = { kind: 'idle' }
    this.#activationEpoch += 1
    this.#imageEpoch += 1
    this.#approvalEpoch += 1
    this.#discardTextStream()
    this.#revokeAllImages()
    this.#bufferedStartEvents = []
    this.#listeners.clear()
    if (turn.kind === 'starting') this.#cancelDetachedTurn({ requestId: turn.requestId })
    else if (turn.kind === 'active') this.#cancelDetachedTurn({ turnId: turn.turnId })
  }

  async #initialize(input: { projects: readonly ProjectSummary[]; activeTaskId: string }): Promise<void> {
    if (this.#disposed) return
    this.#taskGroups = toConversationTaskGroups(input.projects)
    const activeTask = input.projects
      .flatMap((project) => project.tasks)
      .find((task) => task.id === input.activeTaskId)
    const shouldRestore = !this.#initialized && !this.#userActivated && activeTask !== undefined
    this.#initialized = true
    this.#publish()
    if (shouldRestore) await this.#activateTask(toConversationTask(activeTask), false)
  }

  async #activateTask(task: ConversationTask, userInitiated: boolean): Promise<boolean> {
    if (this.#disposed || this.#turn.kind !== 'idle') return false
    if (userInitiated) this.#userActivated = true
    this.#activationEpoch += 1
    const epoch = this.#activationEpoch
    this.#clearConversationContent()
    this.#selectedTaskId = task.id
    this.#title = task.title
    this.#mode = task.mode
    const loadableTask = isStoredConversationTask(task)
    this.#backendTaskId = this.#runtime === 'preview' || loadableTask ? task.id : ''
    this.#loadingHistory = false
    this.#notifyModeChange(task.mode)
    if (this.#runtime !== 'desktop' || !loadableTask) {
      this.#publish()
      return true
    }

    this.#loadingHistory = true
    this.#publish()
    try {
      const result = await this.#adapter.loadConversation(task.id)
      if (!this.#isCurrentActivation(epoch, task.id)) return false
      this.#loadingHistory = false
      if (!result.ok) {
        this.#notice = result.error.message
        this.#publish()
        return false
      }
      this.#upsertHistoryTask(result.value.task)
      this.#messages = result.value.messages.map((message) => ({ ...message }))
      this.#publish()
      return true
    } catch {
      if (!this.#isCurrentActivation(epoch, task.id)) return false
      this.#loadingHistory = false
      this.#notice = '无法加载会话历史，请重试。'
      this.#publish()
      return false
    }
  }

  #newTask(mode: WorkspaceMode, userInitiated: boolean, title: string): boolean {
    if (this.#disposed || this.#turn.kind !== 'idle') return false
    if (userInitiated) this.#userActivated = true
    this.#activationEpoch += 1
    this.#clearConversationContent()
    this.#selectedTaskId = ''
    this.#backendTaskId = ''
    this.#title = title
    this.#mode = mode
    this.#notifyModeChange(mode)
    this.#publish()
    return true
  }

  #switchMode(mode: WorkspaceMode): boolean {
    if (this.#disposed || this.#turn.kind !== 'idle') return false
    if (mode === this.#mode) return true
    const selectedTask = this.#taskGroups
      .flatMap((group) => group.tasks)
      .find((task) => task.id === this.#selectedTaskId)
    if (!selectedTask || !isProviderHistoryTask(selectedTask)) return false
    this.#mode = mode
    this.#notifyModeChange(mode)
    this.#publish()
    return true
  }

  async #send(launch: ConversationTurnLaunch): Promise<boolean> {
    if (this.#disposed || this.#turn.kind !== 'idle') return false
    this.#userActivated = true
    this.#notice = ''
    if (this.#loadingHistory) {
      this.#notice = '会话历史仍在加载，请稍候再发送。'
      this.#publish()
      return false
    }
    if (this.#isSelectedTaskArchived() && !this.#isSelectedTaskReadOnly()) {
      this.#notice = '该会话已归档，请先从任务菜单移出归档。'
      this.#publish()
      return false
    }
    if (this.#isSelectedTaskReadOnly()) {
      const sourceTaskId = this.#selectedTaskId
      const importConversation = this.#runtime === 'desktop'
        ? this.#adapter.importConversation
        : undefined
      const sourceTask = this.#taskGroups
        .flatMap((group) => group.tasks)
        .find((task) => task.id === sourceTaskId)
      if (!importConversation || !sourceTask || !isProviderHistoryTask(sourceTask)) {
        this.#notice = '这个历史任务暂时不能继续写入。'
        this.#publish()
        return false
      }
      try {
        const imported = await importConversation(
          sourceTaskId,
          launch.request.workspaceToken,
          launch.request.mode,
        )
        if (!imported.ok) {
          this.#notice = imported.error.message
          this.#publish()
          return false
        }
        if (imported.value.task.readOnly === true) {
          this.#notice = '历史任务导入后仍不可写，请新建本地任务。'
          this.#publish()
          return false
        }
        this.#upsertHistoryTask(imported.value.task)
        this.#selectedTaskId = imported.value.task.id
        this.#backendTaskId = imported.value.task.id
        this.#title = conversationTitleFromText(
          imported.value.task.title,
          imported.value.task.mode === 'agent' ? '新 Agent 任务' : '新 Chat',
        )
        this.#mode = imported.value.task.mode
        this.#messages = imported.value.messages.map((message) => ({ ...message }))
        this.#contextSummary = ''
        this.#notifyModeChange(imported.value.task.mode)
        this.#publish()
      } catch {
        this.#notice = '历史任务导入未完成，请重试。'
        this.#publish()
        return false
      }
    }

    if (launch.request.mode !== this.#mode) {
      this.#activationEpoch += 1
      this.#clearConversationContent()
      this.#selectedTaskId = ''
      this.#backendTaskId = ''
      this.#mode = launch.request.mode
      this.#title = launch.request.mode === 'agent' ? '新 Agent 任务' : '新 Chat'
      this.#notifyModeChange(launch.request.mode)
    }

    this.#resumableAgentTurn = false
    const requestId = this.#environment.createStartRequestId()
    const startedAt = this.#environment.now()
    const user = this.#createUiMessage('user', launch.visiblePrompt, 'complete')
    const assistant = this.#createUiMessage('assistant', '', 'streaming', launch.modelLabel)
    this.#turn = {
      kind: 'starting',
      requestId,
      userId: user.id,
      assistantId: assistant.id,
      mode: launch.request.mode,
      cancelRequested: false,
      startedAt,
    }
    this.#messages = [...this.#messages, user, assistant]
    this.#activity = { startedAt, phase: 'preparing', detail: '正在准备请求' }
    this.#bufferedStartEvents = []
    this.#publish()

    try {
      let taskId = launch.request.mode === this.#mode ? this.#backendTaskId : ''
      if (!taskId && this.#runtime === 'preview') {
        taskId = `preview-task:${this.#environment.createMessageId()}`
        this.#backendTaskId = taskId
      }
      if (!taskId) {
        const created = await this.#adapter.createConversation({
          title: conversationTitleFromText(
            launch.visiblePrompt,
            launch.request.mode === 'agent' ? '新 Agent 任务' : '新 Chat',
          ),
          mode: launch.request.mode,
          ...(launch.request.mode === 'agent' && launch.request.workspaceToken
            ? { workspaceToken: launch.request.workspaceToken }
            : {}),
        })
        if (!created.ok) {
          this.#failPendingStart(requestId, created.error.message)
          return false
        }
        taskId = created.value.id
        this.#backendTaskId = taskId
        this.#selectedTaskId = taskId
        this.#title = conversationTitleFromText(
          created.value.title,
          created.value.mode === 'agent' ? '新 Agent 任务' : '新 Chat',
        )
        this.#upsertHistoryTask(created.value)
      }

      const startingAfterCreate = this.#startingTurn(requestId)
      if (!startingAfterCreate) return false
      if (startingAfterCreate.cancelRequested) {
        this.#finishLocallyCancelledStart(requestId)
        return false
      }

      const started = await this.#adapter.startTurn({
        ...launch.request,
        requestId,
        taskId,
        prompt: launch.transportPrompt,
      })
      const startingAfterStart = this.#startingTurn(requestId)
      if (!startingAfterStart) {
        if (started.ok) this.#cancelDetachedTurn({ turnId: started.value.turnId })
        return false
      }
      if (!started.ok) {
        const message = startingAfterStart.cancelRequested || started.error.code === 'cancelled'
          ? '发送已取消，草稿已保留。'
          : started.error.message
        this.#failPendingStart(requestId, message)
        return false
      }

      const cancellationRequested = startingAfterStart.cancelRequested
      const active: ActiveTurn = {
        kind: 'active',
        requestId,
        turnId: started.value.turnId,
        assistantId: startingAfterStart.assistantId,
        mode: launch.request.mode,
        cancelling: cancellationRequested,
        startedAt,
      }
      this.#turn = active
      this.#agentResponseTurnId = ''
      this.#upsertExecution(active.assistantId, {
        id: `status:${active.turnId}:start`,
        kind: 'status',
        label: '请求已提交',
        status: 'running',
        startedAt,
      })
      this.#beginTextStream(active.assistantId)
      const buffered = this.#bufferedStartEvents
      this.#bufferedStartEvents = []
      this.#publish()
      for (const event of buffered) this.#applyEvent(event)

      if (cancellationRequested && this.#isActiveTurn(active.turnId)) {
        try {
          const cancelled = await this.#adapter.cancelTurn({ turnId: active.turnId })
          if (!cancelled.ok && this.#isActiveTurn(active.turnId)) {
            this.#markActiveCancelFailed(active.turnId, cancelled.error.message)
          }
        } catch {
          if (this.#isActiveTurn(active.turnId)) {
            this.#markActiveCancelFailed(active.turnId, '请求已经启动，但停止操作未完成，请再次停止。')
          }
        }
      }
      return true
    } catch {
      if (this.#startingTurn(requestId)) {
        this.#failPendingStart(requestId, '发送请求未完成，草稿未清除，请重试。')
      }
      return false
    }
  }

  async #stop(): Promise<void> {
    if (this.#disposed) return
    if (this.#turn.kind === 'starting') {
      if (this.#turn.cancelRequested) return
      const requestId = this.#turn.requestId
      this.#turn = { ...this.#turn, cancelRequested: true }
      this.#notice = '正在取消发送，等待启动流程安全结束…'
      this.#setActivityPhase('stopping', '正在取消发送并安全收尾')
      this.#publish()
      try {
        await this.#adapter.cancelTurn({ requestId })
      } catch {
        if (this.#startingTurn(requestId)) {
          this.#notice = '已记录取消请求，正在等待启动流程结束…'
          this.#publish()
        }
      }
      return
    }
    if (this.#turn.kind !== 'active' || this.#turn.cancelling) return
    const turnId = this.#turn.turnId
    this.#turn = { ...this.#turn, cancelling: true }
    this.#setActivityPhase('stopping', '正在停止并保存已接收内容')
    this.#publish()
    try {
      const result = await this.#adapter.cancelTurn({ turnId })
      if (!result.ok && this.#isActiveTurn(turnId)) {
        this.#markActiveCancelFailed(turnId, result.error.message)
        return
      }
      if (this.#isActiveTurn(turnId)) {
        this.#notice = '正在停止并保存已接收内容…'
        this.#setActivityPhase('stopping', '正在停止并保存已接收内容')
        this.#publish()
      }
    } catch {
      if (this.#isActiveTurn(turnId)) {
        this.#markActiveCancelFailed(turnId, '停止请求未完成，请再次点击停止。')
      }
    }
  }

  #detachTurn(): boolean {
    if (this.#disposed || this.#turn.kind !== 'active' || this.#turn.mode !== 'agent') return false
    this.#activationEpoch += 1
    this.#clearConversationContent()
    this.#selectedTaskId = ''
    this.#backendTaskId = ''
    this.#title = '新 Agent 任务'
    this.#publish()
    return true
  }

  async #resolveApproval(decision: ApprovalResolveInput['decision']): Promise<void> {
    const approval = this.#pendingApproval
    if (this.#disposed || !approval || this.#resolvingApproval) return
    const approvalEpoch = ++this.#approvalEpoch
    const assistantId = this.#turn.kind === 'active' ? this.#turn.assistantId : ''
    this.#resolvingApproval = true
    this.#publish()
    try {
      const result = await this.#adapter.resolveApproval({ approvalId: approval.approvalId, decision })
      if (approvalEpoch !== this.#approvalEpoch || this.#disposed) return
      if (!result.ok) {
        this.#notice = result.error.message
        this.#publish()
        return
      }
      this.#settleApprovalExecution(
        assistantId,
        approval.approvalId,
        decision === 'deny' ? 'cancelled' : 'completed',
      )
      if (this.#pendingApproval?.approvalId === approval.approvalId) this.#pendingApproval = null
      this.#publish()
    } catch {
      if (approvalEpoch === this.#approvalEpoch && !this.#disposed) {
        this.#notice = '批准请求未能安全提交，请重试。'
        this.#publish()
      }
    } finally {
      if (approvalEpoch === this.#approvalEpoch && !this.#disposed) {
        this.#resolvingApproval = false
        this.#publish()
      }
    }
  }

  async #setArchived(task: ConversationTask, archived: boolean): Promise<ConversationActionResult> {
    if (
      this.#disposed ||
      this.#historyActionTaskId ||
      task.status === 'running' ||
      (this.#turn.kind !== 'idle' && this.#selectedTaskId === task.id)
    ) {
      return { ok: false, message: '请先停止当前回答，再修改会话归档状态。' }
    }
    this.#historyActionTaskId = task.id
    this.#publish()
    try {
      // Provider history archives through the app-local overlay in main.
      if (this.#runtime === 'desktop' && isStoredConversationTask(task)) {
        const result = await this.#adapter.setConversationArchived({ taskId: task.id, archived })
        if (!result.ok) return { ok: false, message: result.error.message }
        this.#upsertHistoryTask(result.value)
      } else {
        this.#updateLocalTaskArchived(task.id, archived)
      }
      if (archived && this.#selectedTaskId === task.id) {
        this.#newTask(task.mode, true, task.mode === 'agent' ? '新 Agent 任务' : '新 Chat')
      }
      this.#publish()
      return { ok: true, message: archived ? '会话已归档。' : '会话已移出归档。' }
    } catch {
      return { ok: false, message: archived ? '归档未完成，请重试。' : '移出归档未完成，请重试。' }
    } finally {
      this.#historyActionTaskId = ''
      this.#publish()
    }
  }

  async #renameTask(task: ConversationTask, title: string): Promise<ConversationActionResult> {
    if (this.#isTaskReadOnly(task.id)) {
      return { ok: false, message: '外部历史不能重命名。' }
    }
    if (this.#disposed || this.#historyActionTaskId) {
      return { ok: false, message: '另一项会话操作仍在进行。' }
    }
    if (this.#turn.kind !== 'idle' && this.#selectedTaskId === task.id) {
      return { ok: false, message: '请先停止当前回答，再重命名会话。' }
    }
    this.#historyActionTaskId = task.id
    this.#publish()
    try {
      if (this.#runtime === 'desktop' && isHistoryTaskId(task.id)) {
        const result = await this.#adapter.renameConversation({ taskId: task.id, title })
        if (!result.ok) return { ok: false, message: result.error.message }
        this.#upsertHistoryTask(result.value)
      } else {
        this.#taskGroups = this.#taskGroups.map((group) => ({
          ...group,
          tasks: group.tasks.map((t) => t.id === task.id ? { ...t, title } : t),
        }))
      }
      if (this.#selectedTaskId === task.id) this.#title = title
      this.#publish()
      return { ok: true, message: '会话已重命名。' }
    } catch {
      return { ok: false, message: '重命名未完成，请重试。' }
    } finally {
      this.#historyActionTaskId = ''
      this.#publish()
    }
  }

  async #deleteTask(task: ConversationTask): Promise<ConversationActionResult> {
    if (this.#disposed || this.#historyActionTaskId) {
      return { ok: false, message: '另一项会话操作仍在进行。' }
    }
    if (this.#turn.kind !== 'idle' && this.#selectedTaskId === task.id) {
      this.#setHistoryError('请先停止当前回答，再删除该会话。')
      return { ok: false, message: this.#historyError }
    }
    this.#historyError = ''
    this.#historyActionTaskId = task.id
    this.#publish()
    try {
      // Provider history is hidden via the app-local overlay; source data stays.
      if (this.#runtime === 'desktop' && isStoredConversationTask(task)) {
        const result = await this.#adapter.deleteConversation(task.id)
        if (!result.ok) {
          this.#historyError = result.error.message
          this.#publish()
          return { ok: false, message: result.error.message }
        }
      }
      this.#taskGroups = this.#taskGroups
        .map((group) => ({ ...group, tasks: group.tasks.filter((item) => item.id !== task.id) }))
        .filter((group) => group.tasks.length > 0)
      if (this.#selectedTaskId === task.id) {
        this.#newTask(task.mode, true, task.mode === 'agent' ? '新 Agent 任务' : '新 Chat')
      }
      this.#historyError = ''
      this.#publish()
      return {
        ok: true,
        message: isProviderHistoryTask(task) ? '已从列表移除；外部源数据未改动。' : '会话已删除。',
      }
    } catch {
      this.#historyError = '删除未完成，请重试。'
      this.#publish()
      return { ok: false, message: this.#historyError }
    } finally {
      this.#historyActionTaskId = ''
      this.#publish()
    }
  }

  async #compact(input: Omit<ConversationCompactInput, 'taskId'>): Promise<ConversationCompactResult> {
    if (this.#isSelectedTaskReadOnly()) {
      return { ok: false, compacted: false, message: '请先发送一条消息，将外部历史导入后再压缩。' }
    }
    if (this.#disposed || this.#turn.kind !== 'idle' || this.#loadingHistory || !this.#backendTaskId) {
      return { ok: false, compacted: false, message: '请等待当前回答结束后再压缩上下文。' }
    }
    this.#notice = '正在由当前模型压缩上下文…'
    this.#publish()
    try {
      const result = await this.#adapter.compactConversation({ taskId: this.#backendTaskId, ...input })
      if (this.#disposed) return { ok: false, compacted: false, message: '压缩已取消。' }
      if (!result.ok) {
        this.#notice = result.error.message
        this.#publish()
        return { ok: false, compacted: false, message: result.error.message }
      }
      if (!result.value.compacted) {
        this.#notice = '当前对话还很短，不需要压缩。'
        this.#publish()
        return { ok: true, compacted: false, message: this.#notice }
      }
      this.#messages = result.value.snapshot.messages.map((message) => ({ ...message }))
      this.#contextSummary = this.#messages.find((message) => (
        message.role === 'user' && message.content.startsWith(CONTEXT_COMPACTION_PREFIX)
      ))?.content ?? CONTEXT_COMPACTION_PREFIX.trimEnd()
      this.#retainConversationArtifacts(new Set(this.#messages.map((message) => message.id)))
      this.#notice = `上下文已压缩，已用模型摘要替换 ${result.value.removedMessages} 条早期消息。`
      this.#publish()
      return { ok: true, compacted: true, message: this.#notice }
    } catch {
      if (this.#disposed) return { ok: false, compacted: false, message: '压缩已取消。' }
      this.#notice = '上下文压缩未完成，请重试。'
      this.#publish()
      return { ok: false, compacted: false, message: this.#notice }
    }
  }

  #receiveEvent(event: ConversationTurnEvent): void {
    if (this.#disposed) return
    if (this.#turn.kind === 'starting') {
      const previous = this.#bufferedStartEvents.at(-1)
      if (
        event.type === 'assistant-delta' &&
        previous?.type === 'assistant-delta' &&
        previous.turnId === event.turnId
      ) {
        this.#bufferedStartEvents = [
          ...this.#bufferedStartEvents.slice(0, -1),
          { ...previous, text: `${previous.text}${event.text}` },
        ]
      } else {
        this.#bufferedStartEvents = [...this.#bufferedStartEvents.slice(-(MAX_BUFFERED_START_EVENTS - 1)), event]
      }
      return
    }
    if (this.#turn.kind !== 'active') return
    this.#applyEvent(event)
  }

  #applyEvent(event: ConversationTurnEvent): void {
    if (this.#turn.kind !== 'active' || event.turnId !== this.#turn.turnId) return
    const active = this.#turn
    const now = this.#environment.now()
    if (event.type === 'approval-request') {
      const previousApproval = this.#pendingApproval
      if (previousApproval && previousApproval.approvalId !== event.approvalId) {
        this.#settleApprovalExecution(active.assistantId, previousApproval.approvalId, 'cancelled')
      }
      this.#approvalEpoch += 1
      this.#resolvingApproval = false
      this.#pendingApproval = event
      if (!active.cancelling) {
        this.#setActivityPhase('approval', event.question ? '等待你回答 Agent 的问题' : '等待你确认受控操作')
      }
      this.#upsertExecution(active.assistantId, {
        id: `approval:${event.approvalId}`,
        kind: 'approval',
        label: event.label,
        detail: `批准请求将在 ${executionClock(Date.parse(event.expiresAt))} 前有效`,
        status: 'waiting',
        startedAt: now,
      }, ['status'])
      this.#publish()
      return
    }
    if (event.type === 'image-result') {
      void this.#readGeneratedImage(event.imageToken, active.assistantId, this.#imageEpoch)
      return
    }
    if (event.type === 'subagent-status') {
      const status: AgentExecutionStatus = event.status === 'queued'
        ? 'waiting'
        : event.status
      this.#upsertExecution(active.assistantId, {
        id: `subagent:${event.agentId}`,
        kind: 'subagent',
        label: event.label,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        status,
        startedAt: now,
        ...(status === 'running' || status === 'waiting' ? {} : { endedAt: now }),
      })
      if (!active.cancelling && (status === 'running' || status === 'waiting')) {
        this.#setActivityPhase(
          status === 'running' ? 'tool' : 'queued',
          status === 'running' ? `${event.label}正在工作` : `${event.label}等待开始`,
        )
      }
      this.#publish()
      return
    }
    if (event.type === 'assistant-delta') {
      if (this.#agentResponseTurnId !== event.turnId) {
        this.#agentResponseTurnId = event.turnId
        this.#upsertExecution(active.assistantId, {
          id: `response:${event.turnId}`,
          kind: 'status',
          label: '正在生成回复',
          status: 'running',
          startedAt: now,
        }, ['status'])
      }
      if (this.#textStream?.assistantId !== active.assistantId) this.#beginTextStream(active.assistantId)
      this.#textStream?.stream.push(event.text)
      this.#publish()
      return
    }
    if (event.type === 'tool-status') {
      if (event.status !== 'running') this.#clearPendingApproval()
      this.#upsertExecution(active.assistantId, {
        id: `tool:${event.callId}`,
        kind: 'tool',
        label: event.label,
        status: event.status,
        startedAt: now,
        ...(event.status === 'running' ? {} : { endedAt: now }),
      }, event.status === 'running' ? ['status', 'approval'] : ['approval'], event.status === 'failed' ? 'failed' : 'completed')
      if (!active.cancelling) {
        this.#setActivityPhase(
          event.status === 'running' ? 'tool' : 'thinking',
          event.status === 'running' ? `正在执行：${event.label}` : '工具步骤已结束，正在整理结果',
        )
      }
      this.#publish()
      return
    }
    if (event.type === 'usage') {
      this.#sessionTokens += event.totalTokens
      this.#publish()
      return
    }
    if (event.status === 'queued' || event.status === 'running' || event.status === 'waiting-approval') {
      const phase: ConversationTurnPhase = event.status === 'queued'
        ? 'queued'
        : event.status === 'waiting-approval'
          ? 'approval'
          : 'thinking'
      const detail = event.message ?? (event.status === 'queued'
        ? '请求已发送，等待模型响应'
        : event.status === 'waiting-approval'
          ? '等待你批准下一步操作'
          : '正在分析并生成回答')
      if (!active.cancelling) this.#setActivityPhase(phase, detail)
      if (event.status !== 'waiting-approval') {
        this.#executionSequence += 1
        this.#upsertExecution(active.assistantId, {
          id: `status:${event.turnId}:${this.#executionSequence}`,
          kind: 'status',
          label: detail,
          status: event.status === 'queued' ? 'waiting' : 'running',
          startedAt: now,
        }, ['status'])
      }
      if (!active.cancelling) this.#notice = ''
      if (event.status !== 'waiting-approval') this.#clearPendingApproval()
      this.#publish()
      return
    }

    const messageStatus: ConversationMessageDto['status'] = event.status === 'completed'
      ? 'complete'
      : event.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
    this.#finishExecution(
      active.assistantId,
      event.turnId,
      messageStatus === 'complete' ? 'completed' : messageStatus,
      event.message,
    )
    this.#flushTextStream(active.assistantId)
    this.#messages = this.#messages.map((message) => message.id === active.assistantId
      ? { ...message, status: messageStatus, updatedAt: this.#timestamp() }
      : message)
    this.#resumableAgentTurn = event.status === 'completed' && event.continuation === 'agent-execution'
    this.#notice = event.message ?? ''
    this.#activity = null
    this.#pendingApproval = null
    this.#resolvingApproval = false
    this.#approvalEpoch += 1
    this.#agentResponseTurnId = ''
    this.#turn = { kind: 'idle' }
    this.#publish()
  }

  async #readGeneratedImage(imageToken: string, assistantId: string, imageEpoch: number): Promise<void> {
    try {
      const result = await this.#adapter.readImage(imageToken)
      if (this.#disposed || imageEpoch !== this.#imageEpoch || !this.#hasAssistant(assistantId)) return
      if (!result.ok) {
        this.#notice = result.error.message
        this.#publish()
        return
      }
      const source = this.#environment.createImageUrl(result.value)
      if (!source) {
        this.#notice = '生成图片未通过本地显示校验。'
        this.#publish()
        return
      }
      if (this.#disposed || imageEpoch !== this.#imageEpoch || !this.#hasAssistant(assistantId)) {
        this.#environment.revokeImageUrl(source)
        return
      }
      this.#imageUrls.add(source)
      this.#generatedImages = {
        ...this.#generatedImages,
        [assistantId]: [...(this.#generatedImages[assistantId] ?? []), source],
      }
      this.#publish()
    } catch {
      if (!this.#disposed && imageEpoch === this.#imageEpoch && this.#hasAssistant(assistantId)) {
        this.#notice = '生成图片读取未完成，请重试。'
        this.#publish()
      }
    }
  }

  #upsertExecution(
    assistantId: string,
    entry: AgentExecutionEntry,
    settleKinds: readonly AgentExecutionKind[] = [],
    settledStatus: Extract<AgentExecutionStatus, 'completed' | 'failed' | 'cancelled'> = 'completed',
  ): void {
    if (!assistantId) return
    const previous = this.#executionTracks[assistantId] ?? []
    const settled = previous.map((item) => (
      settleKinds.includes(item.kind) && (item.status === 'running' || item.status === 'waiting')
        ? { ...item, status: settledStatus, endedAt: entry.startedAt }
        : item
    ))
    const existingIndex = settled.findIndex((item) => item.id === entry.id)
    const next = existingIndex >= 0
      ? settled.map((item, index) => index === existingIndex
          ? { ...item, ...entry, startedAt: item.startedAt, endedAt: entry.endedAt }
          : item)
      : [...settled, entry]
    this.#executionTracks = { ...this.#executionTracks, [assistantId]: next.slice(-MAX_EXECUTION_ENTRIES) }
  }

  #finishExecution(
    assistantId: string,
    turnId: string,
    status: Extract<AgentExecutionStatus, 'completed' | 'failed' | 'cancelled'>,
    detail?: string,
  ): void {
    if (!assistantId) return
    const endedAt = this.#environment.now()
    const previous = this.#executionTracks[assistantId] ?? []
    const startedAt = previous[0]?.startedAt ?? endedAt
    const settled = previous.map((item) => (
      item.status === 'running' || item.status === 'waiting'
        ? { ...item, status, endedAt }
        : item
    ))
    const label = status === 'completed'
      ? '本轮已完成'
      : status === 'cancelled'
        ? '本轮已停止'
        : '本轮未完成'
    const terminal: AgentExecutionEntry = {
      id: `terminal:${turnId}`,
      kind: 'terminal',
      label,
      ...(detail ? { detail } : {}),
      status,
      startedAt,
      endedAt,
    }
    this.#executionTracks = {
      ...this.#executionTracks,
      [assistantId]: [...settled, terminal].slice(-MAX_EXECUTION_ENTRIES),
    }
  }

  #settleApprovalExecution(
    assistantId: string,
    approvalId: string,
    status: Extract<AgentExecutionStatus, 'completed' | 'failed' | 'cancelled'>,
  ): void {
    if (!assistantId) return
    const endedAt = this.#environment.now()
    const previous = this.#executionTracks[assistantId] ?? []
    this.#executionTracks = {
      ...this.#executionTracks,
      [assistantId]: previous.map((item) => item.id === `approval:${approvalId}`
        ? { ...item, status, endedAt }
        : item),
    }
  }

  #beginTextStream(assistantId: string): void {
    this.#discardTextStream()
    const stream = this.#environment.createTextStream((text) => {
      if (this.#disposed) return
      this.#messages = this.#messages.map((message) => message.id === assistantId
        ? { ...message, content: `${message.content}${text}`, updatedAt: this.#timestamp() }
        : message)
      this.#publish()
    })
    this.#textStream = { assistantId, stream }
  }

  #flushTextStream(assistantId: string): void {
    const active = this.#textStream
    if (!active || active.assistantId !== assistantId) return
    active.stream.flush()
    this.#textStream = null
  }

  #discardTextStream(): void {
    this.#textStream?.stream.discard()
    this.#textStream = null
  }

  #clearConversationContent(): void {
    this.#loadingHistory = false
    this.#messages = []
    this.#executionTracks = {}
    this.#contextSummary = ''
    this.#resumableAgentTurn = false
    this.#notice = ''
    this.#pendingApproval = null
    this.#resolvingApproval = false
    this.#approvalEpoch += 1
    this.#activity = null
    this.#turn = { kind: 'idle' }
    this.#bufferedStartEvents = []
    this.#agentResponseTurnId = ''
    this.#discardTextStream()
    this.#clearGeneratedImages()
  }

  #clearGeneratedImages(): void {
    this.#imageEpoch += 1
    this.#revokeAllImages()
    this.#generatedImages = {}
  }

  #retainConversationArtifacts(messageIds: ReadonlySet<string>): void {
    this.#executionTracks = Object.fromEntries(
      Object.entries(this.#executionTracks).filter(([assistantId]) => messageIds.has(assistantId)),
    )
    const retainedImages: Record<string, string[]> = {}
    for (const [assistantId, urls] of Object.entries(this.#generatedImages)) {
      if (messageIds.has(assistantId)) {
        retainedImages[assistantId] = urls
        continue
      }
      for (const url of urls) {
        if (!this.#imageUrls.delete(url)) continue
        this.#environment.revokeImageUrl(url)
      }
    }
    this.#generatedImages = retainedImages
  }

  #hasAssistant(assistantId: string): boolean {
    return this.#messages.some((message) => message.id === assistantId && message.role === 'assistant')
  }

  #clearPendingApproval(): void {
    if (!this.#pendingApproval && !this.#resolvingApproval) return
    this.#approvalEpoch += 1
    this.#pendingApproval = null
    this.#resolvingApproval = false
  }

  #revokeAllImages(): void {
    for (const url of this.#imageUrls) this.#environment.revokeImageUrl(url)
    this.#imageUrls.clear()
  }

  #createUiMessage(
    role: ConversationMessageDto['role'],
    content: string,
    status: ConversationMessageDto['status'],
    model?: string,
  ): ConversationMessageDto {
    this.#messageSequence += 1
    const timestamp = this.#timestamp()
    return {
      id: `${this.#environment.createMessageId()}:${this.#messageSequence}`,
      role,
      content,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(model === undefined ? {} : { model }),
    }
  }

  #upsertHistoryTask(task: TaskSummary): void {
    const nextTask = toConversationTask(task)
    const containingGroupIndex = this.#taskGroups.findIndex((group) =>
      group.tasks.some((item) => item.id === task.id))
    const projectGroupIndex = this.#taskGroups.findIndex((group) => group.id === task.projectId)
    const groupIndex = containingGroupIndex >= 0 ? containingGroupIndex : projectGroupIndex
    if (groupIndex < 0) {
      this.#taskGroups = [...this.#taskGroups, {
        id: task.projectId,
        name: '本地历史',
        path: '保存在此设备',
        tasks: [nextTask],
      }]
      return
    }
    this.#taskGroups = this.#taskGroups
      .map((group, index) => index === groupIndex
        ? { ...group, tasks: [nextTask, ...group.tasks.filter((item) => item.id !== task.id)] }
        : { ...group, tasks: group.tasks.filter((item) => item.id !== task.id) })
      .filter((group) => group.tasks.length > 0)
  }

  #updateLocalTaskArchived(taskId: string, archived: boolean): void {
    this.#taskGroups = this.#taskGroups.map((group) => ({
      ...group,
      tasks: group.tasks.map((task) => task.id === taskId
        ? { ...task, archivedAt: archived ? this.#timestamp() : null }
        : task),
    }))
  }

  #setActivityPhase(phase: ConversationTurnPhase, detail: string): void {
    this.#activity = {
      startedAt: this.#activity?.startedAt ?? this.#environment.now(),
      phase,
      detail,
    }
  }

  #startingTurn(requestId: string): StartingTurn | null {
    return !this.#disposed && this.#turn.kind === 'starting' && this.#turn.requestId === requestId
      ? this.#turn
      : null
  }

  #cancelDetachedTurn(input: TurnCancelInput): void {
    void this.#adapter.cancelTurn(input).catch(() => undefined)
  }

  #isActiveTurn(turnId: string): boolean {
    return this.#turn.kind === 'active' && this.#turn.turnId === turnId
  }

  #failPendingStart(requestId: string, message: string): void {
    const starting = this.#startingTurn(requestId)
    if (!starting) return
    this.#messages = this.#messages.filter(
      (entry) => entry.id !== starting.userId && entry.id !== starting.assistantId,
    )
    const { [starting.assistantId]: _discardedExecution, ...remainingExecution } = this.#executionTracks
    const { [starting.assistantId]: discardedImages, ...remainingImages } = this.#generatedImages
    for (const url of discardedImages ?? []) {
      if (!this.#imageUrls.delete(url)) continue
      this.#environment.revokeImageUrl(url)
    }
    this.#executionTracks = remainingExecution
    this.#generatedImages = remainingImages
    this.#turn = { kind: 'idle' }
    this.#activity = null
    this.#bufferedStartEvents = []
    this.#notice = message
    this.#publish()
  }

  #finishLocallyCancelledStart(requestId: string): void {
    this.#failPendingStart(requestId, '发送已取消，草稿已保留。')
  }

  #markActiveCancelFailed(turnId: string, message: string): void {
    if (this.#turn.kind !== 'active' || this.#turn.turnId !== turnId) return
    this.#turn = { ...this.#turn, cancelling: false }
    this.#notice = message
    this.#setActivityPhase('thinking', '停止未完成，仍在等待模型响应')
    this.#publish()
  }

  #isCurrentActivation(epoch: number, taskId: string): boolean {
    return !this.#disposed && epoch === this.#activationEpoch && this.#selectedTaskId === taskId
  }

  #isSelectedTaskArchived(): boolean {
    return this.#taskGroups.some((group) => group.tasks.some(
      (task) => task.id === this.#selectedTaskId && Boolean(task.archivedAt),
    ))
  }

  #isSelectedTaskReadOnly(): boolean {
    return this.#isTaskReadOnly(this.#selectedTaskId)
  }

  #isTaskReadOnly(taskId: string): boolean {
    return this.#taskGroups.some((group) => group.tasks.some(
      (task) => task.id === taskId && task.readOnly === true,
    ))
  }

  #timestamp(): string {
    return new Date(this.#environment.now()).toISOString()
  }

  #setNotice(message: string): void {
    if (this.#notice === message) return
    this.#notice = message
    this.#publish()
  }

  #setHistoryError(message: string): void {
    if (this.#historyError === message) return
    this.#historyError = message
    this.#publish()
  }

  #notifyModeChange(mode: WorkspaceMode): void {
    try {
      this.#onModeChange(mode)
    } catch {
      // External observers cannot roll back an already committed session transition.
    }
  }

  #publish(): void {
    if (this.#disposed) return
    this.#snapshot = {
      taskGroups: this.#taskGroups.map(cloneTaskGroup),
      selectedTaskId: this.#selectedTaskId,
      title: this.#title,
      backendTaskId: this.#backendTaskId,
      selectedTaskArchived: this.#isSelectedTaskArchived(),
      selectedTaskReadOnly: this.#isSelectedTaskReadOnly(),
      loadingHistory: this.#loadingHistory,
      messages: this.#messages.map((message) => ({ ...message })),
      executionTracks: cloneRecordArrays(this.#executionTracks),
      generatedImages: cloneRecordArrays(this.#generatedImages),
      running: this.#turn.kind !== 'idle',
      turnState: this.#turn.kind,
      activity: this.#activity ? { ...this.#activity } : null,
      notice: this.#notice,
      pendingApproval: this.#pendingApproval ? { ...this.#pendingApproval } : null,
      resolvingApproval: this.#resolvingApproval,
      historyActionTaskId: this.#historyActionTaskId,
      historyError: this.#historyError,
      contextSummary: this.#contextSummary,
      resumableAgentTurn: this.#resumableAgentTurn,
      sessionTokens: this.#sessionTokens,
    }
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // One view subscriber must not prevent the remaining views from updating.
      }
    }
  }
}

export function createConversationSession(options: CreateConversationSessionOptions): ConversationSessionController {
  return new ConversationSessionImplementation(options)
}

export function toConversationTaskGroups(projects: readonly ProjectSummary[]): ConversationTaskGroup[] {
  return projects
    .filter((project) => project.tasks.length > 0)
    .map((project) => ({
      id: project.id,
      name: project.name,
      path: providerHistoryLabel(project.id) ?? '保存在此设备',
      tasks: project.tasks.map(toConversationTask),
    }))
}

export function toConversationTask(task: TaskSummary): ConversationTask {
  return {
    id: task.id,
    title: conversationTitleFromText(task.title, task.mode === 'agent' ? '新 Agent 任务' : '新 Chat'),
    mode: task.mode,
    archivedAt: task.archivedAt ?? null,
    ...(task.readOnly === undefined ? {} : { readOnly: task.readOnly }),
    ...(task.source === undefined ? {} : { source: task.source }),
    status: task.status === 'running' || task.status === 'waiting-approval'
      ? 'running'
      : task.status === 'failed'
        ? 'failed'
        : undefined,
  }
}

function isHistoryTaskId(taskId: string): boolean {
  return HISTORY_TASK_PATTERN.test(taskId)
}

function isStoredConversationTask(task: ConversationTask): boolean {
  return isHistoryTaskId(task.id) || isProviderHistoryTask(task)
}

function isProviderHistoryTask(task: ConversationTask): boolean {
  const source = task.source
  if (
    task.readOnly !== true ||
    source === undefined ||
    source.provider === 'other'
  ) return false

  // Codex exposes UUID-backed rows as `codex:<uuid>`, while the other
  // adapters use `<provider>:<opaque-source-id>`. Keep the source reference
  // provider-neutral, but accept each adapter's stable public task ID.
  return source.provider === 'codex'
    ? task.id === `codex:${source.id}`
    : task.id === `${source.provider}:${source.id}`
}

function providerHistoryLabel(projectId: string): string | null {
  if (projectId === 'project:codex-history') return '来自 Codex'
  if (projectId === 'project:grok-history') return '来自 Grok'
  if (projectId === 'project:claude-history') return '来自 Claude'
  if (projectId === 'project:gemini-history') return '来自 Gemini'
  return null
}

function cloneTaskGroup(group: ConversationTaskGroup): ConversationTaskGroup {
  return { ...group, tasks: group.tasks.map((task) => ({ ...task })) }
}

function cloneRecordArrays<T>(value: Readonly<Record<string, readonly T[]>>): Record<string, T[]> {
  return Object.fromEntries(Object.entries(value).map(([key, entries]) => [key, [...entries]]))
}

function executionClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
