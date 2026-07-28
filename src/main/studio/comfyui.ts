import { isIP } from 'node:net'
import { session } from 'electron'
import { z } from 'zod'
import { inspectComfyApiWorkflow, type ComfyApiWorkflow } from '../../studio/core/comfyWorkflow.js'
import { StudioError, assertNoSecretFields, asStudioError } from './errors.js'
import { detectImage, readBoundedResponse, type ProviderImage } from './network.js'

export interface ComfyUiOptions {
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly maxImageBytes?: number
  readonly proxyMode?: 'system' | 'direct'
  readonly signal?: AbortSignal
  readonly onPhase?: (phase: 'download' | 'decode', state: 'start' | 'finish') => void
  readonly onDispatch?: () => void | Promise<void>
  readonly onJob?: (job: ComfyJobHandle) => void | Promise<void>
  readonly onProgress?: (event: ComfyProgressEvent) => void
  readonly webSocketFactory?: (url: string) => ComfyWebSocketConnection
}

export interface ComfyWebSocketConnection {
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  close(): void
}

export interface ComfyProgressEvent {
  readonly type: string
  readonly promptId: string
  readonly nodeId?: string
  readonly value?: number
  readonly maximum?: number
}

export interface ComfyOutputReference {
  readonly filename: string
  readonly subfolder: string
  readonly type: string
}

export interface ComfyUploadInput {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mediaType: ProviderImage['mediaType']
  readonly subfolder?: string
  readonly overwrite?: boolean
}

export interface ComfyMaskUploadInput extends ComfyUploadInput {
  readonly original: ComfyOutputReference
}

export interface ComfyWorkflowCapabilityValidation {
  readonly workflow: ComfyApiWorkflow
  readonly nodeTypes: readonly string[]
  readonly serverNodeTypeCount: number
}

export interface ComfyJobHandle {
  readonly promptId: string
  readonly clientId: string
  readonly queueNumber?: number
}

export interface ComfyQueueSnapshot {
  readonly runningPromptIds: readonly string[]
  readonly pendingPromptIds: readonly string[]
}

export interface ComfyRecoveredJob {
  readonly promptId: string
  readonly state: 'running' | 'pending' | 'succeeded' | 'failed' | 'unknown'
  readonly references: readonly ComfyOutputReference[]
}

export interface ComfyExecutionResult {
  readonly job: ComfyJobHandle
  readonly images: readonly ProviderImage[]
}

const privateIpv4 = (host: string): boolean => {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = parts
  if (first === 10 || first === 127) return true
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return true
  return first === 192 && second === 168
}

const privateHttpHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) === 4) return privateIpv4(host)
  if (isIP(host) === 6) return /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host)
  return false
}

export const normalizeComfyBaseUrl = (baseUrl: string): string => {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch (error) {
    throw new StudioError('comfy-url-invalid', 'ComfyUI 地址无效', 'not_sent', error)
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && privateHttpHost(parsed.hostname))) {
    throw new StudioError('comfy-url-protocol', 'ComfyUI 必须使用 HTTPS；仅 localhost、回环或私网 IP 字面量允许 HTTP')
  }
  if (parsed.username || parsed.password || parsed.search) {
    throw new StudioError('comfy-url-credentials', 'ComfyUI 地址不能包含凭据、查询参数或 API Key')
  }
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/(?:prompt|view|history(?:\/[^/]+)?)\/?$/i, '') || '/'
  return parsed.toString().replace(/\/$/, '')
}

const endpoint = (options: ComfyUiOptions, route: string, query?: Readonly<Record<string, string>>): string => {
  const result = new URL(normalizeComfyBaseUrl(options.baseUrl))
  result.pathname = `${result.pathname.replace(/\/$/, '')}${route}`.replace(/\/{2,}/g, '/')
  result.search = ''
  Object.entries(query ?? {}).forEach(([key, value]) => result.searchParams.set(key, value))
  return result.toString()
}

const webSocketEndpoint = (options: ComfyUiOptions, clientId: string): string => {
  const result = new URL(endpoint(options, '/ws', { clientId }))
  result.protocol = result.protocol === 'http:' ? 'ws:' : 'wss:'
  return result.toString()
}

const fetchSession = async (options: ComfyUiOptions): Promise<Electron.Session> => {
  if (options.proxyMode !== 'direct') return session.defaultSession
  const directSession = session.fromPartition('aistudio-comfy-direct', { cache: false })
  await directSession.setProxy({ mode: 'direct' })
  return directSession
}

const effectiveSignal = (options: ComfyUiOptions): AbortSignal => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
}

const request = async (
  options: ComfyUiOptions,
  route: string,
  init: RequestInit,
  sideEffecting = false,
  uncertainDispatchState: 'sent' | 'billing_unknown' = 'billing_unknown',
): Promise<Response> => {
  let dispatched = false
  try {
    if (options.signal?.aborted) throw new StudioError('comfy-cancelled', 'ComfyUI 请求已取消', 'not_sent')
    const target = endpoint(options, route)
    const targetSession = await fetchSession(options)
    if (sideEffecting) {
      try { await options.onDispatch?.() } catch (error) {
        if (error instanceof StudioError) throw error
        throw new StudioError('dispatch-journal-failed', '无法写入派发日志，已阻止 ComfyUI 远程请求', 'not_sent', error)
      }
    }
    dispatched = true
    return await targetSession.fetch(target, { ...init, signal: effectiveSignal(options) })
  } catch (error) {
    if (error instanceof StudioError) throw error
    const cancelled = options.signal?.aborted === true
    throw new StudioError(
      cancelled ? 'comfy-cancelled' : 'comfy-network-error',
      cancelled ? 'ComfyUI 请求已取消' : '无法连接远程 ComfyUI',
      sideEffecting && dispatched ? uncertainDispatchState : 'not_sent',
      error,
    )
  }
}

const boundedJson = async (
  response: Response,
  maximumBytes = 16 * 1024 * 1024,
  invalidJsonDispatchState: 'not_sent' | 'sent' | 'billing_unknown' = 'sent',
): Promise<unknown> => {
  const bytes = await readBoundedResponse(response, maximumBytes)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new StudioError('comfy-invalid-json', 'ComfyUI 返回了无效 JSON', invalidJsonDispatchState, error)
  }
}

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const validReference = (reference: ComfyOutputReference): boolean =>
  Boolean(reference.filename.trim())
  && reference.filename.length <= 1024
  && reference.subfolder.length <= 1024
  && Boolean(reference.type.trim())
  && reference.type.length <= 80
  && !/[\u0000-\u001f]/.test(`${reference.filename}${reference.subfolder}${reference.type}`)

const validateUploadPath = (filename: string, subfolder: string): void => {
  if (!filename.trim() || filename !== filename.trim() || filename.length > 255 || filename === '.' || filename === '..'
    || /[\\/\u0000-\u001f]/.test(filename)) {
    throw new StudioError('comfy-upload-filename-invalid', 'ComfyUI 上传文件名无效')
  }
  if (subfolder !== subfolder.trim() || subfolder.length > 1024 || subfolder.startsWith('/') || subfolder.endsWith('/')
    || /[\\\u0000-\u001f]/.test(subfolder)
    || (subfolder && subfolder.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new StudioError('comfy-upload-subfolder-invalid', 'ComfyUI 上传子目录无效')
  }
}

const validatePromptId = (promptId: string): void => {
  if (!promptId.trim() || promptId.length > 256 || /[\u0000-\u001f]/.test(promptId)) {
    throw new StudioError('comfy-prompt-id-invalid', 'ComfyUI prompt_id 无效')
  }
}

const queuePromptIds = (value: unknown, field: 'queue_running' | 'queue_pending'): readonly string[] => {
  const entries = recordValue(value)?.[field]
  if (!Array.isArray(entries) || entries.length > 10_000) {
    throw new StudioError('comfy-queue-invalid', `ComfyUI /queue ${field} 响应无效`)
  }
  const result: string[] = []
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[1] !== 'string') throw new StudioError('comfy-queue-invalid', 'ComfyUI /queue 项目无效')
    validatePromptId(entry[1])
    result.push(entry[1])
  }
  return result
}

const delay = async (milliseconds: number, signal: AbortSignal | undefined): Promise<void> => {
  if (signal?.aborted) throw new StudioError('comfy-cancelled', 'ComfyUI 任务等待已取消', 'billing_unknown')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new StudioError('comfy-cancelled', 'ComfyUI 任务等待已取消', 'billing_unknown'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal) {
      setTimeout(() => signal.removeEventListener('abort', abort), milliseconds + 1)
    }
  })
}

const outputReferences = (history: unknown, promptId: string): {
  readonly references: readonly ComfyOutputReference[]
  readonly completed: boolean
  readonly failed: boolean
} => {
  const root = recordValue(history) ?? {}
  const entry = recordValue(root[promptId])
  if (!entry) return { references: [], completed: false, failed: false }
  const outputs = recordValue(entry.outputs) ?? {}
  const references: ComfyOutputReference[] = []
  const seen = new Set<string>()
  for (const output of Object.values(outputs)) {
    const images = recordValue(output)?.images
    if (!Array.isArray(images)) continue
    for (const candidate of images) {
      const image = recordValue(candidate)
      if (!image || typeof image.filename !== 'string' || !image.filename.trim()) continue
      const filename = image.filename.trim()
      const subfolder = typeof image.subfolder === 'string' ? image.subfolder.trim() : ''
      const type = typeof image.type === 'string' ? image.type.trim() : 'output'
      if (filename.length > 1024 || subfolder.length > 1024 || type.length > 80
        || /[\u0000-\u001f]/.test(`${filename}${subfolder}${type}`)) {
        throw new StudioError('comfy-output-reference-invalid', 'ComfyUI 返回了过长或含控制字符的输出引用', 'sent')
      }
      const reference = {
        filename,
        subfolder,
        type,
      }
      const key = `${reference.type}\u0000${reference.subfolder}\u0000${reference.filename}`
      if (seen.has(key)) continue
      seen.add(key)
      references.push(reference)
      if (references.length > 100) throw new StudioError('comfy-too-many-images', 'ComfyUI 单次任务返回图片超过 100 张', 'sent')
    }
  }
  const status = recordValue(entry.status)
  const statusText = typeof status?.status_str === 'string' ? status.status_str.toLowerCase() : ''
  const completed = status?.completed === true || statusText === 'success'
  const failed = ['error', 'failed'].includes(statusText)
  return { references, completed, failed }
}

export class ComfyUiAdapter {
  readonly #options: ComfyUiOptions
  readonly #jobs = new Map<string, ComfyJobHandle>()

  constructor(options: ComfyUiOptions) {
    this.#options = { ...options, baseUrl: normalizeComfyBaseUrl(options.baseUrl) }
  }

  async probe(): Promise<string> {
    for (const route of ['/system_stats', '/object_info'] as const) {
      const response = await request(this.#options, route, { method: 'GET', headers: { Accept: 'application/json' } })
      if (response.ok) {
        await boundedJson(response, route === '/object_info' ? 32 * 1024 * 1024 : 4 * 1024 * 1024, 'not_sent')
        return route
      }
      await response.body?.cancel().catch(() => undefined)
      if (response.status !== 404 && response.status !== 405) {
        throw new StudioError('comfy-probe-failed', `ComfyUI ${route} 探测返回 HTTP ${response.status}`)
      }
    }
    throw new StudioError('comfy-probe-failed', 'ComfyUI 未提供 /system_stats 或 /object_info')
  }

  async objectInfo(): Promise<Readonly<Record<string, unknown>>> {
    const response = await request(this.#options, '/object_info', { method: 'GET', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new StudioError('comfy-object-info-failed', `ComfyUI /object_info 返回 HTTP ${response.status}`)
    const value = recordValue(await boundedJson(response, 32 * 1024 * 1024, 'not_sent'))
    if (!value || Object.keys(value).length > 50_000) throw new StudioError('comfy-object-info-invalid', 'ComfyUI /object_info 响应无效')
    return value
  }

  async validateWorkflowCapabilities(input: unknown): Promise<ComfyWorkflowCapabilityValidation> {
    let inspection
    try {
      inspection = inspectComfyApiWorkflow(input)
    } catch (error) {
      throw new StudioError('comfy-workflow-invalid', error instanceof Error ? error.message : 'ComfyUI API Workflow 无效', 'not_sent', error)
    }
    const info = await this.objectInfo()
    const missing = inspection.nodeTypes.filter((classType) => !recordValue(info[classType]))
    if (missing.length > 0) {
      throw new StudioError(
        'comfy-object-info-missing-nodes',
        `远程 ComfyUI 缺少 Workflow 所需节点：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` 等 ${missing.length} 项` : ''}`,
      )
    }
    return { workflow: inspection.workflow, nodeTypes: inspection.nodeTypes, serverNodeTypeCount: Object.keys(info).length }
  }

  async uploadImage(input: ComfyUploadInput): Promise<ComfyOutputReference> {
    return this.#upload('/upload/image', input)
  }

  async uploadMask(input: ComfyMaskUploadInput): Promise<ComfyOutputReference> {
    if (!validReference(input.original) || input.original.type !== 'input') {
      throw new StudioError('comfy-mask-original-invalid', 'ComfyUI 蒙版 original_ref 无效')
    }
    try {
      validateUploadPath(input.original.filename, input.original.subfolder)
    } catch (error) {
      throw new StudioError('comfy-mask-original-invalid', 'ComfyUI 蒙版 original_ref 无效', 'not_sent', error)
    }
    return this.#upload('/upload/mask', { ...input, subfolder: input.subfolder ?? 'clipspace' }, input.original)
  }

  async #upload(
    route: '/upload/image' | '/upload/mask',
    input: ComfyUploadInput,
    original?: ComfyOutputReference,
  ): Promise<ComfyOutputReference> {
    const subfolder = input.subfolder?.trim() ?? ''
    validateUploadPath(input.filename, subfolder)
    const maximum = this.#options.maxImageBytes ?? 64 * 1024 * 1024
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > maximum) {
      throw new StudioError('comfy-upload-size-invalid', `ComfyUI 上传图片必须小于 ${maximum} 字节`)
    }
    if (detectImage(input.bytes) !== input.mediaType) throw new StudioError('comfy-upload-media-type-mismatch', 'ComfyUI 上传图片 MIME 与内容不一致')
    const form = new FormData()
    const blobBytes = new Uint8Array(input.bytes.byteLength)
    blobBytes.set(input.bytes)
    form.append('image', new Blob([blobBytes.buffer], { type: input.mediaType }), input.filename)
    form.append('type', 'input')
    form.append('overwrite', input.overwrite ? 'true' : 'false')
    if (subfolder) form.append('subfolder', subfolder)
    if (original) form.append('original_ref', JSON.stringify(original))
    const response = await request(this.#options, route, { method: 'POST', body: form, headers: { Accept: 'application/json' } }, true, 'sent')
    if (!response.ok) throw new StudioError('comfy-upload-failed', `ComfyUI ${route} 返回 HTTP ${response.status}`, 'sent')
    const value = recordValue(await boundedJson(response, 2 * 1024 * 1024))
    const filename = typeof value?.name === 'string' ? value.name : typeof value?.filename === 'string' ? value.filename : ''
    const uploaded: ComfyOutputReference = {
      filename,
      subfolder: typeof value?.subfolder === 'string' ? value.subfolder : '',
      type: typeof value?.type === 'string' ? value.type : 'input',
    }
    try {
      if (!validReference(uploaded) || uploaded.type !== 'input') throw new Error('upload response is not an input reference')
      validateUploadPath(uploaded.filename, uploaded.subfolder)
    } catch (error) {
      throw new StudioError('comfy-upload-invalid-response', `ComfyUI ${route} 响应缺少有效文件引用`, 'sent', error)
    }
    return uploaded
  }

  async submitJob(prompt: Readonly<Record<string, unknown>>, clientId: string = crypto.randomUUID()): Promise<ComfyJobHandle> {
    assertNoSecretFields(prompt, '$.prompt')
    if (!clientId.trim() || clientId.length > 256 || /[\u0000-\u001f]/.test(clientId)) {
      throw new StudioError('comfy-client-id-invalid', 'ComfyUI client_id 无效')
    }
    let body: string
    try {
      body = JSON.stringify({ prompt, client_id: clientId })
    } catch (error) {
      throw new StudioError('comfy-prompt-serialize-failed', 'ComfyUI API Workflow 无法序列化', 'not_sent', error)
    }
    if (Buffer.byteLength(body, 'utf8') > 16 * 1024 * 1024) {
      throw new StudioError('comfy-prompt-too-large', 'ComfyUI API Workflow JSON 超过 16 MiB')
    }
    const response = await request(this.#options, '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    }, true)
    if (!response.ok) throw new StudioError('comfy-submit-failed', `ComfyUI /prompt 返回 HTTP ${response.status}`, 'sent')
    try {
      const value = z.object({
        prompt_id: z.string().min(1).max(256),
        number: z.number().int().nonnegative().optional(),
      }).parse(await boundedJson(response))
      validatePromptId(value.prompt_id)
      const job: ComfyJobHandle = {
        promptId: value.prompt_id,
        clientId,
        ...(value.number !== undefined ? { queueNumber: value.number } : {}),
      }
      this.#jobs.delete(job.promptId)
      this.#jobs.set(job.promptId, job)
      while (this.#jobs.size > 1_000) {
        const oldest = this.#jobs.keys().next().value as string | undefined
        if (!oldest) break
        this.#jobs.delete(oldest)
      }
      return job
    } catch (error) {
      if (error instanceof StudioError) throw error
      throw new StudioError('comfy-submit-invalid-response', 'ComfyUI 已接收请求，但 /prompt 响应缺少有效 prompt_id', 'sent', error)
    }
  }

  async submit(prompt: Readonly<Record<string, unknown>>, clientId: string = crypto.randomUUID()): Promise<string> {
    return (await this.submitJob(prompt, clientId)).promptId
  }

  trackedJob(promptId: string): ComfyJobHandle | undefined {
    const job = this.#jobs.get(promptId)
    return job ? { ...job } : undefined
  }

  async queue(): Promise<ComfyQueueSnapshot> {
    const response = await request(this.#options, '/queue', { method: 'GET', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new StudioError('comfy-queue-failed', `ComfyUI /queue 返回 HTTP ${response.status}`)
    const value = await boundedJson(response, 32 * 1024 * 1024, 'not_sent')
    return {
      runningPromptIds: queuePromptIds(value, 'queue_running'),
      pendingPromptIds: queuePromptIds(value, 'queue_pending'),
    }
  }

  async deleteQueued(promptIds: readonly string[]): Promise<void> {
    const unique = [...new Set(promptIds)]
    if (unique.length === 0 || unique.length > 100 || unique.length !== promptIds.length) {
      throw new StudioError('comfy-queue-delete-invalid', 'ComfyUI 队列删除必须包含 1–100 个不重复 prompt_id')
    }
    unique.forEach(validatePromptId)
    const response = await request(this.#options, '/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ delete: unique }),
    }, true, 'sent')
    if (!response.ok) throw new StudioError('comfy-queue-delete-failed', `ComfyUI /queue 删除返回 HTTP ${response.status}`, 'sent')
    await response.body?.cancel().catch(() => undefined)
  }

  async interrupt(promptId: string): Promise<void> {
    validatePromptId(promptId)
    const queue = await this.queue()
    if (!queue.runningPromptIds.includes(promptId)) {
      throw new StudioError('comfy-interrupt-not-running', `ComfyUI prompt_id 当前未在运行：${promptId}`)
    }
    const response = await request(this.#options, '/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    }, true, 'sent')
    if (!response.ok) throw new StudioError('comfy-interrupt-failed', `ComfyUI /interrupt 返回 HTTP ${response.status}`, 'sent')
    await response.body?.cancel().catch(() => undefined)
  }

  async history(promptId: string): Promise<unknown> {
    validatePromptId(promptId)
    const response = await request(this.#options, `/history/${encodeURIComponent(promptId)}`, { method: 'GET' })
    if (!response.ok) throw new StudioError('comfy-history-failed', `ComfyUI /history 返回 HTTP ${response.status}`)
    return z.record(z.string(), z.unknown()).parse(await boundedJson(response, 32 * 1024 * 1024, 'not_sent'))
  }

  async recover(promptId: string): Promise<ComfyRecoveredJob> {
    validatePromptId(promptId)
    const history = await this.history(promptId)
    const output = outputReferences(history, promptId)
    if (output.failed) return { promptId, state: 'failed', references: output.references }
    if (output.completed) return { promptId, state: 'succeeded', references: output.references }
    if (recordValue(recordValue(history)?.[promptId])) return { promptId, state: 'running', references: output.references }
    const queue = await this.queue()
    if (queue.runningPromptIds.includes(promptId)) return { promptId, state: 'running', references: [] }
    if (queue.pendingPromptIds.includes(promptId)) return { promptId, state: 'pending', references: [] }
    return { promptId, state: 'unknown', references: [] }
  }

  async #waitViaWebSocket(promptId: string, clientId: string): Promise<void> {
    validatePromptId(promptId)
    if (!clientId.trim() || clientId.length > 256 || /[\u0000-\u001f]/.test(clientId)) {
      throw new StudioError('comfy-client-id-invalid', 'ComfyUI client_id 无效')
    }
    const createSocket = this.#options.webSocketFactory
      ?? ((url: string) => new WebSocket(url) as unknown as ComfyWebSocketConnection)
    await new Promise<void>((resolve, reject) => {
      let socket: ComfyWebSocketConnection
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#options.signal?.removeEventListener('abort', abort)
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        try { socket.close() } catch { /* best effort */ }
        if (error) reject(error)
        else resolve()
      }
      const abort = (): void => finish(new StudioError('comfy-cancelled', 'ComfyUI 任务等待已取消；远程仍可能继续执行', 'billing_unknown'))
      const timer = setTimeout(() => finish(new StudioError('comfy-ws-timeout', 'ComfyUI WebSocket 等待超时', 'billing_unknown')), this.#options.timeoutMs ?? 120_000)
      try {
        socket = createSocket(webSocketEndpoint(this.#options, clientId))
      } catch (error) {
        clearTimeout(timer)
        reject(new StudioError('comfy-ws-connect-failed', '无法创建 ComfyUI WebSocket', 'billing_unknown', error))
        return
      }
      this.#options.signal?.addEventListener('abort', abort, { once: true })
      socket.onerror = () => finish(new StudioError('comfy-ws-error', 'ComfyUI WebSocket 连接失败', 'billing_unknown'))
      socket.onclose = () => finish(new StudioError('comfy-ws-closed', 'ComfyUI WebSocket 在任务完成前关闭', 'billing_unknown'))
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) return
        let message: Readonly<Record<string, unknown>> | undefined
        try { message = recordValue(JSON.parse(event.data) as unknown) } catch { return }
        const type = typeof message?.type === 'string' ? message.type : ''
        const data = recordValue(message?.data)
        const eventPromptId = typeof data?.prompt_id === 'string' ? data.prompt_id : ''
        if (!type || eventPromptId !== promptId) return
        const progress: ComfyProgressEvent = {
          type,
          promptId,
          ...(typeof data?.node === 'string' ? { nodeId: data.node } : {}),
          ...(typeof data?.value === 'number' && Number.isFinite(data.value) ? { value: data.value } : {}),
          ...(typeof data?.max === 'number' && Number.isFinite(data.max) ? { maximum: data.max } : {}),
        }
        try { this.#options.onProgress?.(progress) } catch { /* observer errors cannot change execution */ }
        if (type === 'execution_error' || type === 'execution_interrupted') {
          finish(new StudioError('comfy-execution-failed', 'ComfyUI 工作流执行失败', 'sent'))
        } else if ((type === 'executing' && data?.node === null) || type === 'execution_success') {
          finish()
        }
      }
    })
  }

  async waitForOutputs(promptId: string, clientId?: string): Promise<readonly ComfyOutputReference[]> {
    if (clientId && this.#options.proxyMode !== 'direct') {
      try {
        await this.#waitViaWebSocket(promptId, clientId)
        const history = await this.history(promptId)
        const output = outputReferences(history, promptId)
        if (output.failed) throw new StudioError('comfy-execution-failed', 'ComfyUI 工作流执行失败', 'sent')
        if (output.completed && output.references.length > 0) return output.references
        if (output.completed) throw new StudioError('comfy-no-images', 'ComfyUI 工作流已完成，但没有 image 输出', 'sent')
      } catch (error) {
        const studioError = asStudioError(error, 'comfy-ws-error')
        if (this.#options.signal?.aborted || studioError.code === 'comfy-cancelled'
          || studioError.code === 'comfy-execution-failed' || studioError.code === 'comfy-no-images') throw studioError
        // WebSocket is an acceleration path; transport/protocol failures fall back to authoritative history polling.
      }
    }
    const deadline = Date.now() + (this.#options.timeoutMs ?? 120_000)
    while (Date.now() < deadline) {
      if (this.#options.signal?.aborted) throw new StudioError('comfy-cancelled', 'ComfyUI 任务已取消；远端仍可能继续执行', 'billing_unknown')
      let history: unknown
      try {
        history = await this.history(promptId)
      } catch (error) {
        const studioError = asStudioError(error, 'comfy-history-failed')
        throw new StudioError(studioError.code, studioError.message, 'billing_unknown', studioError)
      }
      const output = outputReferences(history, promptId)
      if (output.failed) throw new StudioError('comfy-execution-failed', 'ComfyUI 工作流执行失败', 'sent')
      if (output.references.length > 0 && output.completed) return output.references
      if (output.completed) throw new StudioError('comfy-no-images', 'ComfyUI 工作流已完成，但没有 image 输出', 'sent')
      await delay(750, this.#options.signal)
    }
    throw new StudioError('comfy-timeout', '等待 ComfyUI 输出超时；远端任务可能仍在运行', 'billing_unknown')
  }

  async view(reference: ComfyOutputReference): Promise<ProviderImage> {
    if (!validReference(reference)) {
      throw new StudioError('comfy-output-reference-invalid', 'ComfyUI 输出引用无效', 'sent')
    }
    this.#options.onPhase?.('download', 'start')
    let bytes: Uint8Array
    try {
      const targetSession = await fetchSession(this.#options)
      const response = await targetSession.fetch(endpoint(this.#options, '/view', {
        filename: reference.filename,
        subfolder: reference.subfolder,
        type: reference.type,
      }), {
        method: 'GET',
        signal: effectiveSignal(this.#options),
      })
      if (!response.ok) throw new StudioError('comfy-view-failed', `ComfyUI /view 返回 HTTP ${response.status}`, 'sent')
      const maximum = this.#options.maxImageBytes ?? 64 * 1024 * 1024
      const contentType = String(response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (!['', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/octet-stream', 'binary/octet-stream'].includes(contentType ?? '')) {
        throw new StudioError('comfy-invalid-content-type', 'ComfyUI /view 返回了非图片内容', 'sent')
      }
      bytes = await readBoundedResponse(response, maximum)
    } catch (error) {
      if (error instanceof StudioError) throw error
      throw new StudioError('comfy-view-network-error', '读取 ComfyUI 图片失败', 'sent', error)
    } finally {
      this.#options.onPhase?.('download', 'finish')
    }
    this.#options.onPhase?.('decode', 'start')
    try {
      return { bytes, mediaType: detectImage(bytes) }
    } finally {
      this.#options.onPhase?.('decode', 'finish')
    }
  }

  async executeTracked(
    prompt: Readonly<Record<string, unknown>>,
    maximumImages = 10,
    clientId: string = crypto.randomUUID(),
  ): Promise<ComfyExecutionResult> {
    if (!Number.isSafeInteger(maximumImages) || maximumImages < 1 || maximumImages > 100) {
      throw new StudioError('comfy-image-count-invalid', 'ComfyUI 图片数量必须为 1–100')
    }
    const validation = await this.validateWorkflowCapabilities(prompt)
    const job = await this.submitJob(validation.workflow, clientId)
    await this.#options.onJob?.(job)
    const references = (await this.waitForOutputs(job.promptId, job.clientId)).slice(0, maximumImages)
    const images: ProviderImage[] = []
    for (const reference of references) images.push(await this.view(reference))
    return { job, images }
  }

  async execute(prompt: Readonly<Record<string, unknown>>, maximumImages = 10): Promise<readonly ProviderImage[]> {
    return (await this.executeTracked(prompt, maximumImages)).images
  }
}
