import type {
  ApiResult,
  ApprovalResolveInput,
  ConversationSnapshot,
  GeneratedImageData,
  TaskSummary,
  TurnCancelInput,
  TurnStartInput,
  TurnStartResult,
} from '../../../shared/contracts.ts'
import { SmoothTextStream } from '../smooth-text-stream.ts'
import type {
  ConversationSessionAdapter,
  ConversationSessionEnvironment,
  ConversationTurnEvent,
} from './conversation-session.ts'

export type ConversationRuntime = 'desktop' | 'preview' | 'disconnected'

const PREVIEW_RESPONSE = [
  '测试预览已接收请求。',
  '\n\n桌面版会在这里持续显示模型回复、工具执行状态与审批进度。',
  '\n\n当前页面运行在 UI 预览环境，没有连接真实模型服务。',
] as const

export function createConversationSessionAdapter(runtime: ConversationRuntime): ConversationSessionAdapter {
  if (runtime === 'desktop') return createDesktopAdapter()
  if (runtime === 'preview') return new PreviewConversationAdapter()
  return createDisconnectedAdapter()
}

export function createConversationSessionEnvironment(): ConversationSessionEnvironment {
  const reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return {
    now: () => Date.now(),
    createStartRequestId: () => `start:${uuidV4()}`,
    createMessageId: () => `message:${uuidV4()}`,
    createTextStream: (deliver) => new SmoothTextStream(deliver, { reducedMotion }),
    createImageUrl: createGeneratedImageObjectUrl,
    revokeImageUrl: (url) => URL.revokeObjectURL(url),
  }
}

function createDesktopAdapter(): ConversationSessionAdapter {
  return {
    createConversation: (input) => window.onekey.conversation.create(input),
    loadConversation: (taskId) => window.onekey.conversation.load({ taskId }),
    importConversation: (taskId, workspaceToken, mode) => window.onekey.conversation.import({
      taskId,
      ...(workspaceToken === undefined ? {} : { workspaceToken }),
      ...(mode === undefined ? {} : { mode }),
    }),
    compactConversation: (input) => window.onekey.conversation.compact(input),
    setConversationArchived: (input) => window.onekey.conversation.setArchived(input),
    renameConversation: (input) => window.onekey.conversation.rename(input),
    deleteConversation: (taskId) => window.onekey.conversation.delete({ taskId }),
    startTurn: (input) => window.onekey.turn.start(input),
    cancelTurn: (input) => window.onekey.turn.cancel(input),
    resolveApproval: (input) => window.onekey.approval.resolve(input),
    readImage: (imageToken) => window.onekey.image.read({ imageToken }),
    subscribeTurnEvents: (listener) => window.onekey.onAgentEvent((event) => {
      if (event.type !== 'terminal-output') listener(event)
    }),
  }
}

type PreviewTurn = {
  readonly requestId: string
  readonly turnId: string
  readonly timers: Set<number>
  terminal: boolean
}

class PreviewConversationAdapter implements ConversationSessionAdapter {
  readonly #listeners = new Set<(event: ConversationTurnEvent) => void>()
  readonly #turns = new Map<string, PreviewTurn>()
  readonly #requestTurns = new Map<string, string>()

  createConversation(input: { title?: string; mode: 'chat' | 'agent' }): Promise<ApiResult<TaskSummary>> {
    const timestamp = new Date().toISOString()
    return Promise.resolve(success({
      id: `preview-task:${uuidV4()}`,
      projectId: 'preview',
      title: input.title?.trim() || (input.mode === 'agent' ? '新 Agent 任务' : '新 Chat'),
      mode: input.mode,
      updatedAt: timestamp,
      archivedAt: null,
      status: 'idle',
    }))
  }

  loadConversation(taskId: string): Promise<ApiResult<ConversationSnapshot>> {
    return Promise.resolve(success({
      task: {
        id: taskId,
        projectId: 'preview',
        title: '测试预览任务',
        mode: 'agent',
        updatedAt: new Date().toISOString(),
        archivedAt: null,
        status: 'idle',
      },
      messages: [],
      events: [],
    }))
  }

  setConversationArchived(input: { taskId: string; archived: boolean }): Promise<ApiResult<TaskSummary>> {
    return Promise.resolve(success({
      id: input.taskId,
      projectId: 'preview',
      title: '测试预览任务',
      mode: 'agent',
      updatedAt: new Date().toISOString(),
      archivedAt: input.archived ? new Date().toISOString() : null,
      status: 'idle',
    }))
  }

  renameConversation(input: { taskId: string; title: string }): Promise<ApiResult<TaskSummary>> {
    return Promise.resolve(success({
      id: input.taskId,
      projectId: 'preview',
      title: input.title,
      mode: 'agent',
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      status: 'idle',
    }))
  }

  deleteConversation(_taskId: string): Promise<ApiResult<null>> {
    return Promise.resolve(success(null))
  }

  compactConversation(_input: import('../../../shared/contracts.ts').ConversationCompactInput): Promise<ApiResult<import('../../../shared/contracts.ts').ConversationCompactResult>> {
    return Promise.resolve(success({
      compacted: false,
      removedMessages: 0,
      snapshot: {
        task: {
          id: 'preview-task:compact',
          projectId: 'preview',
          title: '测试预览任务',
          mode: 'agent',
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          status: 'idle',
        },
        messages: [],
        events: [],
      },
    }))
  }

  startTurn(input: TurnStartInput): Promise<ApiResult<TurnStartResult>> {
    const turnId = `preview-turn:${uuidV4()}`
    const turn: PreviewTurn = {
      requestId: input.requestId,
      turnId,
      timers: new Set(),
      terminal: false,
    }
    this.#turns.set(turnId, turn)
    this.#requestTurns.set(input.requestId, turnId)
    this.#emit({ type: 'turn-status', turnId, status: 'queued', message: '请求已进入测试预览队列' })
    this.#schedule(turn, 140, () => {
      this.#emit({ type: 'turn-status', turnId, status: 'running', message: '正在生成测试预览回复' })
    })
    PREVIEW_RESPONSE.forEach((text, index) => {
      this.#schedule(turn, 320 + index * 260, () => {
        this.#emit({ type: 'assistant-delta', turnId, text })
      })
    })
    this.#schedule(turn, 1_160, () => this.#finish(turn, 'completed'))
    return Promise.resolve(success({ turnId }))
  }

  cancelTurn(input: TurnCancelInput): Promise<ApiResult<null>> {
    const turnId = 'turnId' in input ? input.turnId : this.#requestTurns.get(input.requestId)
    const turn = turnId ? this.#turns.get(turnId) : undefined
    if (!turn || turn.terminal) {
      return Promise.resolve(failure('not_found', '测试预览请求已经结束。'))
    }
    this.#finish(turn, 'cancelled', '测试预览请求已停止。')
    return Promise.resolve(success(null))
  }

  resolveApproval(_input: ApprovalResolveInput): Promise<ApiResult<null>> {
    return Promise.resolve(success(null))
  }

  readImage(_imageToken: string): Promise<ApiResult<GeneratedImageData>> {
    return Promise.resolve(failure('not_found', '测试预览没有可读取的生成图片。'))
  }

  subscribeTurnEvents(listener: (event: ConversationTurnEvent) => void): () => void {
    this.#listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.#listeners.delete(listener)
    }
  }

  #schedule(turn: PreviewTurn, delayMs: number, action: () => void): void {
    const timer = globalThis.setTimeout(() => {
      turn.timers.delete(timer)
      if (!turn.terminal) action()
    }, delayMs)
    turn.timers.add(timer)
  }

  #finish(
    turn: PreviewTurn,
    status: Extract<ConversationTurnEvent, { type: 'turn-status' }>['status'],
    message?: string,
  ): void {
    if (turn.terminal) return
    turn.terminal = true
    for (const timer of turn.timers) globalThis.clearTimeout(timer)
    turn.timers.clear()
    this.#emit({ type: 'turn-status', turnId: turn.turnId, status, ...(message ? { message } : {}) })
    this.#turns.delete(turn.turnId)
    this.#requestTurns.delete(turn.requestId)
  }

  #emit(event: ConversationTurnEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

function createDisconnectedAdapter(): ConversationSessionAdapter {
  const disconnected = <T>(): Promise<ApiResult<T>> => Promise.resolve(
    failure('not_ready', '请使用桌面客户端连接模型服务。'),
  )
  return {
    createConversation: () => disconnected(),
    loadConversation: () => disconnected(),
    compactConversation: () => disconnected(),
    setConversationArchived: () => disconnected(),
    renameConversation: () => disconnected(),
    deleteConversation: () => disconnected(),
    startTurn: () => disconnected(),
    cancelTurn: () => disconnected(),
    resolveApproval: () => disconnected(),
    readImage: () => disconnected(),
    subscribeTurnEvents: () => () => undefined,
  }
}

function createGeneratedImageObjectUrl(value: GeneratedImageData): string | null {
  if (
    !value ||
    typeof value !== 'object' ||
    value.mimeType !== 'image/png' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 8 ||
    value.byteLength > 12 * 1024 * 1024 ||
    typeof value.dataBase64 !== 'string' ||
    value.dataBase64.length < 12 ||
    value.dataBase64.length > 16 * 1024 * 1024 ||
    value.dataBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.dataBase64)
  ) {
    return null
  }
  try {
    const binary = globalThis.atob(value.dataBase64)
    if (binary.length !== value.byteLength) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (!pngSignature.every((byte, index) => bytes[index] === byte)) return null
    return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
  } catch {
    return null
  }
}

function uuidV4(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function failure<T>(code: 'not_found' | 'not_ready', message: string): ApiResult<T> {
  return { ok: false, error: { code, message, retryable: code === 'not_ready' } }
}
