import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createConversationSession,
  type ConversationSessionAdapter,
  type ConversationSessionEnvironment,
  type ConversationTextStream,
  type ConversationTurnEvent,
  type ConversationTurnLaunch,
} from '../../src/renderer/src/conversation/conversation-session.ts'
import type {
  ApiResult,
  ApprovalResolveInput,
  ConversationCompactInput,
  ConversationCompactResult,
  ConversationCreateInput,
  ConversationSetArchivedInput,
  ConversationSnapshot,
  GeneratedImageData,
  ProjectSummary,
  TaskSummary,
  TurnCancelInput,
  TurnStartInput,
  TurnStartResult,
  WorkspaceMode,
} from '../../src/shared/contracts.ts'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })

class FakeAdapter implements ConversationSessionAdapter {
  readonly listeners = new Set<(event: ConversationTurnEvent) => void>()
  readonly starts: TurnStartInput[] = []
  readonly cancels: TurnCancelInput[] = []
  readonly approvals: ApprovalResolveInput[] = []
  readonly archiveInputs: ConversationSetArchivedInput[] = []
  readonly deletedTaskIds: string[] = []
  readonly loadInputs: string[] = []
  readonly compactInputs: ConversationCompactInput[] = []
  subscribeCalls = 0
  unsubscribeCalls = 0
  createResult: Promise<ApiResult<TaskSummary>> = Promise.resolve(ok(task('task:00000000-0000-4000-8000-000000000099')))
  loadResult: Promise<ApiResult<ConversationSnapshot>> = Promise.resolve(ok({
    task: task('task:00000000-0000-4000-8000-000000000001'),
    messages: [],
    events: [],
  }))
  startResult: Promise<ApiResult<TurnStartResult>> = Promise.resolve(ok({ turnId: 'turn:1' }))
  cancelResult: Promise<ApiResult<null>> = Promise.resolve(ok(null))
  approvalResult: Promise<ApiResult<null>> = Promise.resolve(ok(null))
  imageResult: Promise<ApiResult<GeneratedImageData>> = Promise.resolve(ok({
    mimeType: 'image/png',
    byteLength: 3,
    dataBase64: 'YWJj',
  }))
  compactResult: Promise<ApiResult<ConversationCompactResult>> = Promise.resolve(ok({
    compacted: false,
    removedMessages: 0,
    snapshot: {
      task: task('task:00000000-0000-4000-8000-000000000001'),
      messages: [],
      events: [],
    },
  }))

  createConversation(_input: ConversationCreateInput): Promise<ApiResult<TaskSummary>> {
    return this.createResult
  }

  loadConversation(taskId: string): Promise<ApiResult<ConversationSnapshot>> {
    this.loadInputs.push(taskId)
    return this.loadResult
  }

  compactConversation(input: ConversationCompactInput): Promise<ApiResult<ConversationCompactResult>> {
    this.compactInputs.push(input)
    return this.compactResult
  }

  setConversationArchived(input: ConversationSetArchivedInput): Promise<ApiResult<TaskSummary>> {
    this.archiveInputs.push(input)
    return Promise.resolve(ok({
      ...task(input.taskId),
      archivedAt: input.archived ? '2026-07-26T00:00:00.000Z' : null,
    }))
  }

  deleteConversation(taskId: string): Promise<ApiResult<null>> {
    this.deletedTaskIds.push(taskId)
    return Promise.resolve(ok(null))
  }

  startTurn(input: TurnStartInput): Promise<ApiResult<TurnStartResult>> {
    this.starts.push(input)
    return this.startResult
  }

  cancelTurn(input: TurnCancelInput): Promise<ApiResult<null>> {
    this.cancels.push(input)
    return this.cancelResult
  }

  resolveApproval(input: ApprovalResolveInput): Promise<ApiResult<null>> {
    this.approvals.push(input)
    return this.approvalResult
  }

  readImage(_imageToken: string): Promise<ApiResult<GeneratedImageData>> {
    return this.imageResult
  }

  subscribeTurnEvents(listener: (event: ConversationTurnEvent) => void): () => void {
    this.subscribeCalls += 1
    this.listeners.add(listener)
    return () => {
      this.unsubscribeCalls += 1
      this.listeners.delete(listener)
    }
  }

  emit(event: ConversationTurnEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

class ImmediateTextStream implements ConversationTextStream {
  readonly #deliver: (text: string) => void
  #buffer = ''

  constructor(deliver: (text: string) => void) {
    this.#deliver = deliver
  }

  push(text: string): void {
    this.#buffer += text
    this.flush()
  }

  flush(): void {
    const text = this.#buffer
    this.#buffer = ''
    if (text) this.#deliver(text)
  }

  discard(): void {
    this.#buffer = ''
  }
}

function createHarness(
  runtime: 'desktop' | 'preview' = 'preview',
  onModeChange?: (mode: WorkspaceMode) => void,
) {
  const adapter = new FakeAdapter()
  const createdUrls: string[] = []
  const revokedUrls: string[] = []
  const modeChanges: WorkspaceMode[] = []
  let id = 0
  let now = Date.parse('2026-07-21T00:00:00.000Z')
  const environment: ConversationSessionEnvironment = {
    now: () => {
      now += 1
      return now
    },
    createStartRequestId: () => `request:${++id}`,
    createMessageId: () => `message:${++id}`,
    createTextStream: (deliver) => new ImmediateTextStream(deliver),
    createImageUrl: () => {
      const url = `blob:test-${createdUrls.length + 1}`
      createdUrls.push(url)
      return url
    },
    revokeImageUrl: (url) => revokedUrls.push(url),
  }
  const controller = createConversationSession({
    runtime,
    adapter,
    environment,
    initialMode: 'agent',
    onModeChange: (mode) => {
      modeChanges.push(mode)
      onModeChange?.(mode)
    },
  })
  controller.connect()
  return { adapter, controller, createdUrls, revokedUrls, modeChanges }
}

test('isolates snapshot subscriber failures so actions and later subscribers still complete', () => {
  const { controller } = createHarness()
  let laterNotifications = 0

  controller.subscribe(() => {
    throw new Error('broken snapshot subscriber')
  })
  controller.subscribe(() => {
    laterNotifications += 1
  })

  assert.doesNotThrow(() => controller.actions.setNotice('联网状态已更新'))
  assert.equal(laterNotifications, 1)
  assert.equal(controller.getSnapshot().notice, '联网状态已更新')

  assert.doesNotThrow(() => controller.actions.clearNotice())
  assert.equal(laterNotifications, 2)
  assert.equal(controller.getSnapshot().notice, '')
})

test('detaches an active Agent turn without cancelling Main and opens a fresh local task', async () => {
  const { adapter, controller } = createHarness()

  assert.equal(await controller.actions.send(launch()), true)
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: '仍在后台处理' })
  assert.equal(controller.getSnapshot().turnState, 'active')

  assert.equal(controller.actions.detachTurn(), true)
  assert.equal(controller.getSnapshot().turnState, 'idle')
  assert.equal(controller.getSnapshot().running, false)
  assert.equal(controller.getSnapshot().selectedTaskId, '')
  assert.equal(controller.getSnapshot().backendTaskId, '')
  assert.equal(controller.getSnapshot().title, '新 Agent 任务')
  assert.deepEqual(controller.getSnapshot().messages, [])
  assert.deepEqual(adapter.cancels, [])

  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })
  assert.equal(controller.getSnapshot().turnState, 'idle')
  controller.dispose()
  assert.deepEqual(adapter.cancels, [])
})

test('isolates mode-change observer failures across new, activate, and send transitions', async () => {
  const { adapter, controller, modeChanges } = createHarness('preview', () => {
    throw new Error('broken mode observer')
  })
  let notifications = 0
  controller.subscribe(() => {
    notifications += 1
  })

  let changed = false
  assert.doesNotThrow(() => {
    changed = controller.actions.newTask('chat')
  })

  assert.equal(changed, true)
  assert.equal(notifications, 1)
  assert.equal(controller.getSnapshot().title, '新 Chat')

  assert.equal(await controller.actions.activateTask({
    id: 'local-agent-task',
    title: '本地 Agent 任务',
    mode: 'agent',
  }), true)
  assert.equal(controller.getSnapshot().selectedTaskId, 'local-agent-task')
  assert.equal(controller.getSnapshot().title, '本地 Agent 任务')

  assert.equal(await controller.actions.send(launch('切换到 Chat', '切换到 Chat', 'chat')), true)
  assert.equal(adapter.starts.length, 1)
  assert.equal(controller.getSnapshot().turnState, 'active')
  assert.deepEqual(modeChanges, ['chat', 'agent', 'chat'])
})

function launch(
  visiblePrompt = '界面显示内容',
  transportPrompt = '[context]\n实际发送内容',
  mode: WorkspaceMode = 'agent',
): ConversationTurnLaunch {
  return {
    visiblePrompt,
    transportPrompt,
    request: {
      mode,
      profileHandle: 'profile:test',
      groupId: null,
      modelId: 'model-test',
      reasoning: 'high',
      approvalMode: 'request',
      ...(mode === 'agent' ? { workspaceToken: 'workspace:test' } : {}),
      attachmentTokens: [],
      webSearch: false,
      imageGeneration: false,
      localSubagents: false,
    },
  }
}

function compactionInput(): Omit<ConversationCompactInput, 'taskId'> {
  return {
    profileHandle: 'profile:test',
    groupId: 'group-test',
    modelId: 'model-test',
    reasoning: 'high',
  }
}

function task(id: string, mode: WorkspaceMode = 'agent', title = '历史任务'): TaskSummary {
  return {
    id,
    projectId: 'project:test',
    title,
    mode,
    updatedAt: '2026-07-21T00:00:00.000Z',
    archivedAt: null,
    status: 'idle',
  }
}

function projectWith(...tasks: TaskSummary[]): ProjectSummary[] {
  return [{ id: 'project:test', name: '测试项目', tasks }]
}

async function microtask(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('buffers events emitted before turn.start resolves and keeps visible and transport prompts separate', async () => {
  const { adapter, controller } = createHarness()
  const pendingStart = deferred<ApiResult<TurnStartResult>>()
  adapter.startResult = pendingStart.promise

  const sending = controller.actions.send(launch())
  assert.equal(controller.getSnapshot().turnState, 'starting')
  assert.equal(controller.getSnapshot().messages[0]?.content, '界面显示内容')
  assert.equal(adapter.starts[0]?.prompt, '[context]\n实际发送内容')

  adapter.emit({ type: 'turn-status', turnId: 'turn:early', status: 'queued' })
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:early', text: '提前到达' })
  pendingStart.resolve(ok({ turnId: 'turn:early' }))

  assert.equal(await sending, true)
  assert.equal(controller.getSnapshot().turnState, 'active')
  assert.equal(controller.getSnapshot().messages[1]?.content, '提前到达')
  adapter.emit({ type: 'turn-status', turnId: 'turn:early', status: 'completed' })
  assert.equal(controller.getSnapshot().messages[1]?.status, 'complete')
})

test('provider history supports overlay archive and list removal while staying read-only for content', async () => {
  const { adapter, controller } = createHarness('desktop')
  const codexTask: TaskSummary = {
    ...task('codex:00000000-0000-4000-8000-000000000001'),
    projectId: 'project:codex-history',
    readOnly: true,
    source: { provider: 'codex', id: '00000000-0000-4000-8000-000000000001' },
  }
  adapter.loadResult = Promise.resolve(ok({
    task: codexTask,
    messages: [],
    events: [],
  }))

  await controller.actions.initialize({
    projects: [{ id: 'project:codex-history', name: 'Codex 历史', tasks: [codexTask] }],
    activeTaskId: codexTask.id,
  })
  assert.equal(controller.getSnapshot().selectedTaskReadOnly, true)

  // Sending directly into read-only history is still refused (import path owns that).
  assert.equal(await controller.actions.send(launch()), false)
  const readOnlyTask = {
    id: codexTask.id,
    title: codexTask.title,
    mode: codexTask.mode,
    readOnly: true,
    source: { provider: 'codex', id: '00000000-0000-4000-8000-000000000001' },
  } as const

  // Renaming would require writing the provider's own data: still blocked.
  assert.deepEqual(await controller.actions.renameTask(readOnlyTask, '新名字'), {
    ok: false,
    message: '外部历史不能重命名。',
  })

  // Compaction still requires importing into a local task first.
  assert.deepEqual(await controller.actions.compact(compactionInput()), {
    ok: false,
    compacted: false,
    message: '请先发送一条消息，将外部历史导入后再压缩。',
  })

  // Archive routes through the app-local overlay in main. Archiving the
  // selected task also rolls the selection over to a fresh local task.
  assert.deepEqual(await controller.actions.setArchived(readOnlyTask, true), {
    ok: true,
    message: '会话已归档。',
  })
  assert.deepEqual(adapter.archiveInputs, [{ taskId: codexTask.id, archived: true }])

  // "Delete" hides the entry from this app; the wording says the source stays.
  assert.deepEqual(await controller.actions.deleteTask(readOnlyTask), {
    ok: true,
    message: '已从列表移除；外部源数据未改动。',
  })
  assert.deepEqual(adapter.deletedTaskIds, [codexTask.id])
  assert.equal(adapter.starts.length, 0)
})

test('non-Codex provider history is loaded and imported into a writable local task before the next turn', async () => {
  const { adapter, controller } = createHarness('desktop')
  const providerTask: TaskSummary = {
    ...task('gemini:00000000-0000-4000-8000-000000000002'),
    projectId: 'project:gemini-history',
    readOnly: true,
    source: { provider: 'gemini', id: '00000000-0000-4000-8000-000000000002' },
  }
  const importedTask: TaskSummary = {
    ...task('task:00000000-0000-4000-8000-000000000003'),
    projectId: 'project:workspace:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    source: providerTask.source,
  }
  const importedSnapshot: ConversationSnapshot = {
    task: importedTask,
    messages: [{
      id: 'message:00000000-0000-4000-8000-000000000004',
      role: 'user',
      content: 'Original Gemini request',
      status: 'complete',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }],
    events: [],
  }
  let importedTaskId = ''
  ;(adapter as ConversationSessionAdapter & {
    importConversation: (
      taskId: string,
      workspaceToken?: string,
      mode?: WorkspaceMode,
    ) => Promise<ApiResult<ConversationSnapshot>>
  }).importConversation = async (taskId, workspaceToken, mode) => {
    assert.equal(taskId, providerTask.id)
    assert.equal(workspaceToken, 'workspace:test')
    assert.equal(mode, 'agent')
    importedTaskId = importedTask.id
    return ok(importedSnapshot)
  }
  adapter.loadResult = Promise.resolve(ok({ task: providerTask, messages: [], events: [] }))

  await controller.actions.initialize({
    projects: [{ id: 'project:gemini-history', name: 'Gemini 历史', tasks: [providerTask] }],
    activeTaskId: providerTask.id,
  })
  assert.equal(adapter.loadInputs[0], providerTask.id)
  assert.equal(await controller.actions.send(launch('Continue Gemini', 'Continue Gemini')), true)
  assert.equal(importedTaskId, importedTask.id)
  assert.equal(adapter.starts[0]?.taskId, importedTask.id)
  assert.equal(controller.getSnapshot().selectedTaskId, importedTask.id)
  assert.equal(controller.getSnapshot().selectedTaskReadOnly, false)
  assert.equal(controller.getSnapshot().messages[0]?.content, 'Original Gemini request')
})

test('Codex provider rows load and import into a writable Agent task', async () => {
  const { adapter, controller } = createHarness('desktop')
  const codexId = '00000000-0000-4000-8000-000000000010'
  const providerTask: TaskSummary = {
    ...task(`codex:${codexId}`),
    projectId: 'project:codex-history',
    source: { provider: 'codex', id: codexId },
    readOnly: true,
  }
  const importedTask: TaskSummary = {
    ...task('task:00000000-0000-4000-8000-000000000011'),
    projectId: 'project:workspace:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    source: providerTask.source,
  }
  const sourceSnapshot: ConversationSnapshot = {
    task: providerTask,
    messages: [{
      id: 'codex-message:1',
      role: 'user',
      content: 'Original Codex request',
      status: 'complete',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }],
    events: [],
  }
  const importedSnapshot: ConversationSnapshot = {
    task: importedTask,
    messages: sourceSnapshot.messages.map((message) => ({
      ...message,
      id: 'message:00000000-0000-4000-8000-000000000012',
    })),
    events: [],
  }
  adapter.loadResult = Promise.resolve(ok(sourceSnapshot))
  let importArgs: { taskId: string; workspaceToken?: string; mode?: WorkspaceMode } | null = null
  ;(adapter as ConversationSessionAdapter).importConversation = async (taskId, workspaceToken, mode) => {
    importArgs = {
      taskId,
      ...(workspaceToken === undefined ? {} : { workspaceToken }),
      ...(mode === undefined ? {} : { mode }),
    }
    return ok(importedSnapshot)
  }

  await controller.actions.initialize({
    projects: [{ id: 'project:codex-history', name: 'Codex 历史', tasks: [providerTask] }],
    activeTaskId: providerTask.id,
  })
  assert.deepEqual(adapter.loadInputs, [providerTask.id])
  assert.equal(controller.getSnapshot().messages[0]?.content, 'Original Codex request')

  assert.equal(await controller.actions.send(launch('Continue Codex')), true)
  assert.deepEqual(importArgs, {
    taskId: providerTask.id,
    workspaceToken: 'workspace:test',
    mode: 'agent',
  })
  assert.equal(adapter.starts[0]?.taskId, importedTask.id)
  assert.equal(controller.getSnapshot().selectedTaskReadOnly, false)
})

test('provider history can be imported as Chat without a workspace token', async () => {
  const { adapter, controller } = createHarness('desktop')
  const sourceId = `source_${'b'.repeat(43)}`
  const providerTask: TaskSummary = {
    ...task(`grok:${sourceId}`),
    projectId: 'project:grok-history',
    source: { provider: 'grok', id: sourceId },
    readOnly: true,
  }
  const importedTask: TaskSummary = {
    ...task('task:00000000-0000-4000-8000-000000000013', 'chat'),
    projectId: 'project:local-history',
    source: providerTask.source,
  }
  const importedSnapshot: ConversationSnapshot = {
    task: importedTask,
    messages: [{
      id: 'message:00000000-0000-4000-8000-000000000014',
      role: 'user',
      content: 'Original Grok request',
      status: 'complete',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }],
    events: [],
  }
  adapter.loadResult = Promise.resolve(ok({ task: providerTask, messages: [], events: [] }))
  let importArgs: { taskId: string; workspaceToken?: string; mode?: WorkspaceMode } | null = null
  ;(adapter as ConversationSessionAdapter).importConversation = async (taskId, workspaceToken, mode) => {
    importArgs = {
      taskId,
      ...(workspaceToken === undefined ? {} : { workspaceToken }),
      ...(mode === undefined ? {} : { mode }),
    }
    return ok(importedSnapshot)
  }

  await controller.actions.initialize({
    projects: [{ id: 'project:grok-history', name: 'Grok 历史', tasks: [providerTask] }],
    activeTaskId: providerTask.id,
  })
  assert.equal(controller.actions.switchMode('chat'), true)
  assert.equal(controller.getSnapshot().selectedTaskId, providerTask.id)
  assert.equal(await controller.actions.send(launch('Continue Grok in Chat', 'Continue Grok in Chat', 'chat')), true)
  assert.deepEqual(importArgs, { taskId: providerTask.id, mode: 'chat' })
  assert.equal(adapter.starts[0]?.mode, 'chat')
  assert.equal('workspaceToken' in (adapter.starts[0] ?? {}), false)
  assert.equal(controller.getSnapshot().selectedTaskId, importedTask.id)
  assert.equal(controller.getSnapshot().selectedTaskReadOnly, false)
})

test('projects an explicit Agent budget handoff as a one-click resumable turn and clears it on the next send', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: '已保留当前工作区结果。' })
  adapter.emit({
    type: 'turn-status',
    turnId: 'turn:1',
    status: 'completed',
    continuation: 'agent-execution',
  })

  let snapshot = controller.getSnapshot()
  assert.equal(snapshot.running, false)
  assert.equal(snapshot.messages[1]?.status, 'complete')
  assert.equal(snapshot.resumableAgentTurn, true)

  adapter.startResult = Promise.resolve(ok({ turnId: 'turn:2' }))
  assert.equal(await controller.actions.send(launch('继续执行', '检查工作区后继续执行')), true)
  snapshot = controller.getSnapshot()
  assert.equal(snapshot.running, true)
  assert.equal(snapshot.resumableAgentTurn, false)
})

test('Agent exposes the real queued, running, response, and neutral terminal execution track', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  const assistantId = controller.getSnapshot().messages[1]?.id
  assert.ok(assistantId)

  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'queued' })
  adapter.emit({
    type: 'turn-status',
    turnId: 'turn:1',
    status: 'running',
    message: '正在接收模型回答。',
  })
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: '真实回答' })
  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })

  assert.deepEqual(
    controller.getSnapshot().executionTracks[assistantId]?.map(({ kind, label, status }) => ({
      kind,
      label,
      status,
    })),
    [
      { kind: 'status', label: '请求已提交', status: 'completed' },
      { kind: 'status', label: '请求已发送，等待模型响应', status: 'completed' },
      { kind: 'status', label: '正在接收模型回答。', status: 'completed' },
      { kind: 'status', label: '正在生成回复', status: 'completed' },
      { kind: 'terminal', label: '本轮已完成', status: 'completed' },
    ],
  )
})

test('Agent projects independent subagent lifecycle events into the execution track', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  const assistantId = controller.getSnapshot().messages[1]?.id
  assert.ok(assistantId)

  adapter.emit({
    type: 'subagent-status',
    turnId: 'turn:1',
    agentId: 'subagent:1:1',
    parentAgentId: 'root:turn:1',
    label: '子智能体 1',
    detail: '检查项目结构',
    status: 'queued',
  })
  adapter.emit({
    type: 'subagent-status',
    turnId: 'turn:1',
    agentId: 'subagent:1:1',
    parentAgentId: 'root:turn:1',
    label: '子智能体 1',
    detail: '检查项目结构',
    status: 'running',
  })
  adapter.emit({
    type: 'subagent-status',
    turnId: 'turn:1',
    agentId: 'subagent:1:1',
    parentAgentId: 'root:turn:1',
    label: '子智能体 1',
    detail: '检查项目结构',
    status: 'completed',
  })

  const subagent = controller.getSnapshot().executionTracks[assistantId]?.find(
    (entry) => entry.kind === 'subagent',
  )
  assert.deepEqual(subagent && {
    id: subagent.id,
    kind: subagent.kind,
    label: subagent.label,
    detail: subagent.detail,
    status: subagent.status,
  }, {
    id: 'subagent:subagent:1:1',
    kind: 'subagent',
    label: '子智能体 1',
    detail: '检查项目结构',
    status: 'completed',
  })
})

test('Chat exposes a complete execution track without requiring tool events', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(controller.actions.newTask('chat'), true)
  assert.equal(await controller.actions.send(launch('Chat 问题', 'Chat 问题', 'chat')), true)
  const assistantId = controller.getSnapshot().messages[1]?.id
  assert.ok(assistantId)

  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'queued' })
  adapter.emit({
    type: 'turn-status',
    turnId: 'turn:1',
    status: 'running',
    message: '正在接收模型回答。',
  })
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: 'Chat 真实回答' })
  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })

  assert.deepEqual(
    controller.getSnapshot().executionTracks[assistantId]?.map(({ kind, label, status }) => ({
      kind,
      label,
      status,
    })),
    [
      { kind: 'status', label: '请求已提交', status: 'completed' },
      { kind: 'status', label: '请求已发送，等待模型响应', status: 'completed' },
      { kind: 'status', label: '正在接收模型回答。', status: 'completed' },
      { kind: 'status', label: '正在生成回复', status: 'completed' },
      { kind: 'terminal', label: '本轮已完成', status: 'completed' },
    ],
  )
})

test('surfaces Main turn-admission errors and rolls back optimistic messages', async () => {
  const { adapter, controller } = createHarness()
  adapter.startResult = Promise.resolve({
    ok: false,
    error: {
      code: 'invalid_input',
      message: 'The selected model capabilities are not in the confirmed catalog.',
      retryable: false,
    },
  })

  assert.equal(await controller.actions.send(launch()), false)

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.notice, 'The selected model capabilities are not in the confirmed catalog.')
  assert.equal(snapshot.turnState, 'idle')
  assert.deepEqual(snapshot.messages, [])
  assert.equal(adapter.starts.length, 1)
})

test('ignores foreign events and every late event after a terminal status', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)

  adapter.emit({ type: 'assistant-delta', turnId: 'turn:foreign', text: '污染' })
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: '最终内容' })
  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: '迟到污染' })
  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'cancelled' })

  const assistant = controller.getSnapshot().messages[1]
  assert.equal(assistant?.content, '最终内容')
  assert.equal(assistant?.status, 'complete')
  assert.equal(controller.getSnapshot().turnState, 'idle')
})

test('cancels a pending start by requestId then falls back to turnId if start succeeds', async () => {
  const { adapter, controller } = createHarness()
  const pendingStart = deferred<ApiResult<TurnStartResult>>()
  adapter.startResult = pendingStart.promise

  const sending = controller.actions.send(launch())
  await controller.actions.stop()
  assert.deepEqual(adapter.cancels, [{ requestId: 'request:1' }])

  adapter.emit({ type: 'turn-status', turnId: 'turn:late-start', status: 'queued' })
  adapter.emit({
    type: 'tool-status',
    turnId: 'turn:late-start',
    callId: 'call:late',
    label: '迟到工具状态',
    status: 'running',
  })

  pendingStart.resolve(ok({ turnId: 'turn:late-start' }))
  assert.equal(await sending, true)
  assert.deepEqual(adapter.cancels, [
    { requestId: 'request:1' },
    { turnId: 'turn:late-start' },
  ])
  assert.equal(controller.getSnapshot().turnState, 'active')
  assert.equal(controller.getSnapshot().activity?.phase, 'stopping')
  assert.match(controller.getSnapshot().notice, /取消/u)
})

test('terminal event remains authoritative when an in-flight cancel completes late', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  const pendingCancel = deferred<ApiResult<null>>()
  adapter.cancelResult = pendingCancel.promise

  const stopping = controller.actions.stop()
  adapter.emit({ type: 'assistant-delta', turnId: 'turn:1', text: '已保存' })
  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })
  pendingCancel.resolve({
    ok: false,
    error: { code: 'runtime_error', message: '迟到的停止错误', retryable: true },
  })
  await stopping

  assert.equal(controller.getSnapshot().turnState, 'idle')
  assert.equal(controller.getSnapshot().messages[1]?.status, 'complete')
  assert.notEqual(controller.getSnapshot().notice, '迟到的停止错误')
})

test('a delayed history load cannot overwrite a newer task activation', async () => {
  const { adapter, controller, modeChanges } = createHarness('desktop')
  const oldTask = task('task:00000000-0000-4000-8000-000000000001', 'agent', '旧历史')
  const pendingLoad = deferred<ApiResult<ConversationSnapshot>>()
  adapter.loadResult = pendingLoad.promise

  const initializing = controller.actions.initialize({ projects: projectWith(oldTask), activeTaskId: oldTask.id })
  assert.equal(controller.getSnapshot().loadingHistory, true)
  assert.equal(controller.actions.newTask('chat'), true)
  pendingLoad.resolve(ok({
    task: oldTask,
    messages: [{
      id: 'old-message',
      role: 'assistant',
      content: '不应覆盖',
      status: 'complete',
      createdAt: oldTask.updatedAt,
      updatedAt: oldTask.updatedAt,
    }],
    events: [],
  }))
  await initializing

  assert.equal(controller.getSnapshot().selectedTaskId, '')
  assert.equal(controller.getSnapshot().title, '新 Chat')
  assert.deepEqual(controller.getSnapshot().messages, [])
  assert.deepEqual(modeChanges, ['agent', 'chat'])
})

test('send is rejected while history for the selected task is still loading', async () => {
  const { adapter, controller } = createHarness('desktop')
  const oldTask = task('task:00000000-0000-4000-8000-000000000001')
  const pendingLoad = deferred<ApiResult<ConversationSnapshot>>()
  adapter.loadResult = pendingLoad.promise

  const initializing = controller.actions.initialize({ projects: projectWith(oldTask), activeTaskId: oldTask.id })
  assert.equal(await controller.actions.send(launch()), false)
  assert.deepEqual(adapter.starts, [])
  assert.match(controller.getSnapshot().notice, /仍在加载/u)

  assert.equal(controller.actions.newTask('agent'), true)
  pendingLoad.resolve(ok({ task: oldTask, messages: [], events: [] }))
  await initializing
})

test('an older approval response cannot clear a newer approval request', async () => {
  const { adapter, controller } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  const pendingApproval = deferred<ApiResult<null>>()
  adapter.approvalResult = pendingApproval.promise

  adapter.emit({
    type: 'approval-request',
    turnId: 'turn:1',
    approvalId: 'approval:old',
    label: '旧操作',
    risk: 'low',
    expiresAt: '2026-07-21T00:10:00.000Z',
  })
  const resolving = controller.actions.resolveApproval('allow_once')
  adapter.emit({
    type: 'approval-request',
    turnId: 'turn:1',
    approvalId: 'approval:new',
    label: '新操作',
    risk: 'medium',
    expiresAt: '2026-07-21T00:10:00.000Z',
  })
  pendingApproval.resolve({
    ok: false,
    error: { code: 'runtime_error', message: '旧审批失败，不得显示', retryable: true },
  })
  await resolving

  assert.equal(controller.getSnapshot().pendingApproval?.approvalId, 'approval:new')
  assert.equal(controller.getSnapshot().resolvingApproval, false)
  assert.notEqual(controller.getSnapshot().notice, '旧审批失败，不得显示')
})

test('a delayed image read cannot contaminate a new task', async () => {
  const { adapter, controller, createdUrls, revokedUrls } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  const pendingImage = deferred<ApiResult<GeneratedImageData>>()
  adapter.imageResult = pendingImage.promise

  adapter.emit({
    type: 'image-result',
    turnId: 'turn:1',
    imageToken: 'image:late',
    mimeType: 'image/png',
    byteLength: 3,
  })
  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })
  assert.equal(controller.actions.newTask('agent'), true)
  pendingImage.resolve(ok({ mimeType: 'image/png', byteLength: 3, dataBase64: 'YWJj' }))
  await microtask()

  assert.deepEqual(controller.getSnapshot().generatedImages, {})
  assert.deepEqual(createdUrls, [])
  assert.deepEqual(revokedUrls, [])
})

test('generated image object URLs are revoked exactly once across reset and dispose', async () => {
  const { adapter, controller, createdUrls, revokedUrls } = createHarness()
  assert.equal(await controller.actions.send(launch()), true)
  adapter.emit({
    type: 'image-result',
    turnId: 'turn:1',
    imageToken: 'image:ready',
    mimeType: 'image/png',
    byteLength: 3,
  })
  await microtask()
  assert.deepEqual(createdUrls, ['blob:test-1'])

  adapter.emit({ type: 'turn-status', turnId: 'turn:1', status: 'completed' })
  assert.equal(controller.actions.newTask('agent'), true)
  assert.equal(controller.actions.resetForWorkspace('agent'), true)
  controller.dispose()
  controller.dispose()

  assert.deepEqual(revokedUrls, ['blob:test-1'])
})

test('compact applies the Main model summary snapshot and publishes a visible compression state', async () => {
  const { adapter, controller } = createHarness('desktop')
  const taskId = 'task:00000000-0000-4000-8000-000000000001'
  await controller.actions.initialize({ projects: projectWith(task(taskId)), activeTaskId: taskId })
  const summary = '[Context Compaction] 已完成模型路由和持久化；下一步继续验证。'
  adapter.compactResult = Promise.resolve(ok({
    compacted: true,
    removedMessages: 8,
    snapshot: {
      task: task(taskId),
      messages: [{
        id: 'message:00000000-0000-4000-8000-000000000010',
        role: 'user',
        content: summary,
        status: 'complete',
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      }],
      events: [],
    },
  }))

  const result = await controller.actions.compact(compactionInput())
  const snapshot = controller.getSnapshot()
  assert.deepEqual(result, {
    ok: true,
    compacted: true,
    message: '上下文已压缩，已用模型摘要替换 8 条早期消息。',
  })
  assert.deepEqual(adapter.compactInputs, [{ taskId, ...compactionInput() }])
  assert.equal(snapshot.contextSummary, summary)
  assert.equal(snapshot.messages.length, 1)
  assert.equal(snapshot.messages[0]?.content, snapshot.contextSummary)
})

test('compact keeps the existing transcript when Main reports that no compaction is needed', async () => {
  const { adapter, controller } = createHarness('desktop')
  const taskId = 'task:00000000-0000-4000-8000-000000000001'
  await controller.actions.initialize({ projects: projectWith(task(taskId)), activeTaskId: taskId })
  const before = controller.getSnapshot().messages
  const result = await controller.actions.compact(compactionInput())
  assert.deepEqual(result, { ok: true, compacted: false, message: '当前对话还很短，不需要压缩。' })
  assert.deepEqual(controller.getSnapshot().messages, before)
})

test('connect is idempotent and disconnect permits exactly one fresh subscription', () => {
  const { adapter, controller } = createHarness()
  controller.connect()
  assert.equal(adapter.subscribeCalls, 1)
  assert.equal(adapter.listeners.size, 1)

  controller.disconnect()
  controller.disconnect()
  assert.equal(adapter.unsubscribeCalls, 1)
  assert.equal(adapter.listeners.size, 0)

  controller.connect()
  assert.equal(adapter.subscribeCalls, 2)
  assert.equal(adapter.listeners.size, 1)
  controller.dispose()
  assert.equal(adapter.unsubscribeCalls, 2)
})

test('dispose during conversation creation invalidates the continuation before turn start', async () => {
  const { adapter, controller } = createHarness('desktop')
  const pendingCreate = deferred<ApiResult<TaskSummary>>()
  adapter.createResult = pendingCreate.promise

  const sending = controller.actions.send(launch())
  controller.dispose()
  assert.deepEqual(adapter.cancels, [{ requestId: 'request:1' }])

  pendingCreate.resolve(ok(task('task:00000000-0000-4000-8000-000000000001')))
  assert.equal(await sending, false)
  assert.deepEqual(adapter.starts, [])
})

test('dispose during turn start cancels both the pending request and a late active turn', async () => {
  const { adapter, controller } = createHarness()
  const pendingStart = deferred<ApiResult<TurnStartResult>>()
  adapter.startResult = pendingStart.promise

  const sending = controller.actions.send(launch())
  controller.dispose()
  assert.deepEqual(adapter.cancels, [{ requestId: 'request:1' }])

  pendingStart.resolve(ok({ turnId: 'turn:detached' }))
  assert.equal(await sending, false)
  assert.deepEqual(adapter.cancels, [
    { requestId: 'request:1' },
    { turnId: 'turn:detached' },
  ])
})
