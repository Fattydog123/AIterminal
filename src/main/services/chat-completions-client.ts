import { normalizeEndpoint } from '../security/consent-store.ts'
import { containsSensitiveCredential } from '../security/redaction.ts'
import type { ReasoningEffort } from '../../shared/contracts.ts'
import { joinNativeEndpoint, normalizeNativePath } from './native-sse-utils.ts'
import {
  isReasoningEffort,
  mapReasoningEffortForWire
} from './reasoning-protocol.ts'
import type {
  ResponsesMessage,
  ResponsesUserContentPart
} from './responses-client.ts'

/** Credentials for a NewAPI/OpenAI-compatible Chat Completions endpoint. */
export interface ChatCompletionsCredentials {
  baseUrl: string
  apiKey: string
}

/**
 * The message shape intentionally mirrors the existing Responses client. This
 * lets the turn services share their bounded history snapshot without making
 * the Chat Completions transport aware of tool or continuation state.
 */
export type ChatCompletionsMessage = ResponsesMessage

export interface ChatCompletionsStreamRequest {
  model: string
  messages: readonly ChatCompletionsMessage[]
  endpointPath?: string
  system?: string
  instructions?: string
  reasoning?: ReasoningEffort
}

export type ChatCompletionsStreamEvent =
  | { type: 'response.output_text.delta'; delta: string }

export interface ChatCompletionsStreamResult {
  responseId: string | null
  outputText: string
}

export interface ChatCompletionsStreamOptions {
  signal?: AbortSignal
  onEvent?: (event: ChatCompletionsStreamEvent) => void | Promise<void>
}

// ── Agent tool-calling extension ──────────────────────────────────────────────

/** A tool definition in OpenAI Chat Completions function-calling format. */
export interface ChatCompletionsToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** A completed tool call returned by the model after streaming finishes. */
export interface ChatCompletionsToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Validated identity retained when a streamed tool call has malformed JSON
 * arguments. The raw argument text is intentionally never retained.
 */
export interface ChatCompletionsRecoverableToolCall {
  readonly id: string
  readonly name: string
}

/** A "tool" role message carrying the result of one tool call. */
export interface ChatCompletionsToolResultMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** An assistant message that may contain both text and/or tool calls. */
export interface ChatCompletionsAssistantWithToolsMessage {
  role: 'assistant'
  content: string
  tool_calls: readonly ChatCompletionsToolCall[]
}

export interface ChatCompletionsStreamWithToolsRequest {
  model: string
  messages: readonly (ChatCompletionsMessage | ChatCompletionsToolResultMessage | ChatCompletionsAssistantWithToolsMessage)[]
  tools: readonly ChatCompletionsToolDefinition[]
  endpointPath?: string
  instructions?: string
  reasoning?: ReasoningEffort
}

export interface ChatCompletionsStreamWithToolsResult {
  responseId: string | null
  outputText: string
  /** Non-empty when the model issued function calls that need to be executed. */
  toolCalls: ChatCompletionsToolCall[]
  /** True when the model called tools and is waiting for results. */
  hasToolCalls: boolean
}

export interface ChatCompletionsStreamWithToolsOptions {
  signal?: AbortSignal
  onEvent?: (event: ChatCompletionsStreamEvent) => void | Promise<void>
}

export interface ChatCompletionsClientOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  maxEventBytes?: number
  maxOutputTextBytes?: number
}

export type ChatCompletionsClientErrorCode =
  | 'invalid_configuration'
  | 'invalid_endpoint'
  | 'invalid_credential'
  | 'invalid_input'
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'redirect_rejected'
  | 'remote_rejected'
  | 'response_too_large'
  | 'event_too_large'
  | 'invalid_response'
  | 'remote_error'
  | 'consumer_error'

export type ChatCompletionsRemoteFailure =
  | 'authorization'
  | 'chat_completions_unsupported'
  | 'content_filtered'
  | 'rate_limited'
  | 'server_error'
  | 'request_rejected'

const ERROR_DETAILS: Readonly<Record<ChatCompletionsClientErrorCode, {
  message: string
  retryable: boolean
}>> = {
  invalid_configuration: { message: 'The Chat Completions client configuration is invalid.', retryable: false },
  invalid_endpoint: { message: 'The confirmed model endpoint is invalid.', retryable: false },
  invalid_credential: { message: 'The model credential is invalid.', retryable: false },
  invalid_input: { message: 'The model request is invalid.', retryable: false },
  cancelled: { message: 'The model request was cancelled.', retryable: false },
  timeout: { message: 'The model request timed out.', retryable: true },
  network_error: { message: 'The confirmed model endpoint could not be reached.', retryable: true },
  redirect_rejected: { message: 'The model endpoint attempted a redirect.', retryable: false },
  remote_rejected: { message: 'The model endpoint rejected the request.', retryable: false },
  response_too_large: { message: 'The model response exceeded the safety limit.', retryable: false },
  event_too_large: { message: 'A model stream event exceeded the safety limit.', retryable: false },
  invalid_response: { message: 'The model endpoint returned an invalid stream.', retryable: false },
  remote_error: { message: 'The model endpoint reported a stream failure.', retryable: true },
  consumer_error: { message: 'The model stream could not be delivered safely.', retryable: false }
}

export class ChatCompletionsClientError extends Error {
  readonly code: ChatCompletionsClientErrorCode
  readonly retryable: boolean
  readonly remoteFailure?: ChatCompletionsRemoteFailure
  readonly recoverableToolCalls?: readonly ChatCompletionsRecoverableToolCall[]

  constructor(
    code: ChatCompletionsClientErrorCode,
    retryable?: boolean,
    remoteFailure?: ChatCompletionsRemoteFailure,
    recoverableToolCalls?: readonly ChatCompletionsRecoverableToolCall[]
  ) {
    const detail = ERROR_DETAILS[code]
    super(detail.message)
    this.name = 'ChatCompletionsClientError'
    this.code = code
    this.retryable = retryable ?? detail.retryable
    this.remoteFailure = code === 'remote_rejected' && isRemoteFailure(remoteFailure)
      ? remoteFailure
      : undefined
    this.recoverableToolCalls = code === 'invalid_response'
      ? normalizeRecoverableToolCalls(recoverableToolCalls)
      : undefined
    // Do not retain a fetch/stream error stack: it can contain URLs, headers,
    // local paths, or upstream response text.
    this.stack = `${this.name}: ${this.message}`
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024
const DEFAULT_MAX_OUTPUT_TEXT_BYTES = 16 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_TEXT_BYTES = 16 * 1024 * 1024
const MAX_API_KEY_LENGTH = 32_768
const MAX_MODEL_LENGTH = 256
const MAX_MESSAGES = 128
const MAX_MESSAGE_CHARACTERS = 256 * 1024
const MAX_INSTRUCTIONS_CHARACTERS = 256 * 1024
const MAX_INPUT_BYTES = 18 * 1024 * 1024
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024
const MAX_DATA_URL_CHARACTERS = 17 * 1024 * 1024
const MAX_RESPONSE_ID_LENGTH = 256
const MAX_TOOL_CALL_ID_LENGTH = 256
const MAX_TOOL_NAME_LENGTH = 256
const MAX_TOOL_CALLS_PER_MESSAGE = 32
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u
const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant'])
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const TOOL_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
  // xAI documents end_turn as a possible Chat Completions finish reason.
  'end_turn'
])

/**
 * Normalize an already-authorized model API root. Query strings, fragments,
 * embedded credentials, non-loopback HTTP, and unsafe endpoint schemes are
 * rejected by normalizeEndpoint; the transport appends the fixed path below.
 */
export function normalizeChatCompletionsBaseUrl(value: unknown): string {
  let normalized: string
  try {
    normalized = normalizeEndpoint(value)
  } catch {
    throw new ChatCompletionsClientError('invalid_endpoint')
  }
  const endpoint = new URL(normalized)
  if (endpoint.search || endpoint.hash) throw new ChatCompletionsClientError('invalid_endpoint')
  return normalized.replace(/\/+$/u, '')
}

export function buildChatCompletionsRequestUrl(
  baseUrl: unknown,
  endpointPath: unknown = '/chat/completions'
): string {
  try {
    const normalizedBaseUrl = normalizeChatCompletionsBaseUrl(baseUrl)
    const normalizedPath = normalizeNativePath(endpointPath)
    if (normalizedPath.includes('?')) throw new Error('invalid_endpoint')
    return joinNativeEndpoint(normalizedBaseUrl, normalizedPath)
  } catch (error) {
    if (error instanceof ChatCompletionsClientError) throw error
    throw new ChatCompletionsClientError('invalid_endpoint')
  }
}

export class OpenAICompatibleChatCompletionsClient {
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxEventBytes: number
  readonly #maxOutputTextBytes: number

  constructor(options: ChatCompletionsClientOptions = {}) {
    const candidate: unknown = options
    if (!hasOnlyKeys(candidate, [
      'fetcher',
      'timeoutMs',
      'maxResponseBytes',
      'maxEventBytes',
      'maxOutputTextBytes'
    ])) throw new ChatCompletionsClientError('invalid_configuration')
    if (candidate.fetcher !== undefined && typeof candidate.fetcher !== 'function') {
      throw new ChatCompletionsClientError('invalid_configuration')
    }
    this.#timeoutMs = configurationInteger(candidate.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 10 * 60_000)
    this.#maxResponseBytes = configurationInteger(
      candidate.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      256,
      MAX_RESPONSE_BYTES
    )
    this.#maxEventBytes = configurationInteger(
      candidate.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      64,
      MAX_EVENT_BYTES
    )
    this.#maxOutputTextBytes = configurationInteger(
      candidate.maxOutputTextBytes,
      DEFAULT_MAX_OUTPUT_TEXT_BYTES,
      64,
      MAX_OUTPUT_TEXT_BYTES
    )
    if (this.#maxEventBytes > this.#maxResponseBytes || this.#maxOutputTextBytes > this.#maxResponseBytes) {
      throw new ChatCompletionsClientError('invalid_configuration')
    }
    this.#fetcher = (candidate.fetcher as typeof fetch | undefined) ?? globalThis.fetch
    if (typeof this.#fetcher !== 'function') throw new ChatCompletionsClientError('invalid_configuration')
  }

  async stream(
    credentials: ChatCompletionsCredentials,
    request: ChatCompletionsStreamRequest,
    options: ChatCompletionsStreamOptions = {}
  ): Promise<ChatCompletionsStreamResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequest(request)
    const normalizedOptions = normalizeStreamOptions(options)
    const requestBody = serializeRequest(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new ChatCompletionsClientError('invalid_input')
    }
    if (normalizedOptions.signal?.aborted) throw new ChatCompletionsClientError('cancelled')

    const requestUrl = buildChatCompletionsRequestUrl(
      normalizedCredentials.baseUrl,
      normalizedRequest.endpointPath
    )
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = (): void => controller.abort()
    normalizedOptions.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)

    try {
      const response = await this.#fetcher(requestUrl, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${normalizedCredentials.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('remote_rejected', retryable, remoteFailure)
      }

      const contentLength = response.headers.get('content-length')
      if (
        contentLength !== null &&
        /^\d+$/u.test(contentLength) &&
        Number(contentLength) > this.#maxResponseBytes
      ) {
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('remote_rejected', false, 'chat_completions_unsupported')
      }

      return await consumeResponseStream(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        maxOutputTextBytes: this.#maxOutputTextBytes,
        explicitSecrets: [normalizedCredentials.apiKey],
        onEvent: normalizedOptions.onEvent
      })
    } catch (error) {
      if (normalizedOptions.signal?.aborted) throw new ChatCompletionsClientError('cancelled')
      if (timedOut) throw new ChatCompletionsClientError('timeout')
      if (error instanceof ChatCompletionsClientError) throw error
      // Fetch and stream errors may contain the endpoint, headers, local paths,
      // or response details. Never preserve the raw error or its stack.
      throw new ChatCompletionsClientError('network_error')
    } finally {
      clearTimeout(timeout)
      normalizedOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  /**
   * Stream a Chat Completions request that may include tool definitions.
   * Unlike `stream()`, this method accepts tool_calls in the response and
   * returns them as structured `ChatCompletionsToolCall` objects for the
   * Agent function-calling loop to execute and send back.
   */
  async streamWithTools(
    credentials: ChatCompletionsCredentials,
    request: ChatCompletionsStreamWithToolsRequest,
    options: ChatCompletionsStreamWithToolsOptions = {}
  ): Promise<ChatCompletionsStreamWithToolsResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequestWithTools(request)
    const requestBody = serializeRequestWithTools(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new ChatCompletionsClientError('invalid_input')
    }
    const signal = isAbortSignal(options.signal) ? options.signal : undefined
    if (signal?.aborted) throw new ChatCompletionsClientError('cancelled')

    const requestUrl = buildChatCompletionsRequestUrl(
      normalizedCredentials.baseUrl,
      normalizedRequest.endpointPath
    )
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = (): void => controller.abort()
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)

    try {
      const response = await this.#fetcher(requestUrl, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${normalizedCredentials.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('remote_rejected', retryable, remoteFailure)
      }

      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardResponseBody(response)
        throw new ChatCompletionsClientError('remote_rejected', false, 'chat_completions_unsupported')
      }

      return await consumeToolResponseStream(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        maxOutputTextBytes: this.#maxOutputTextBytes,
        explicitSecrets: [normalizedCredentials.apiKey],
        onEvent: options.onEvent
      })
    } catch (error) {
      if (signal?.aborted) throw new ChatCompletionsClientError('cancelled')
      if (timedOut) throw new ChatCompletionsClientError('timeout')
      if (error instanceof ChatCompletionsClientError) throw error
      throw new ChatCompletionsClientError('network_error')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

interface NormalizedRequest {
  model: string
  messages: ChatMessage[]
  endpointPath: string
  reasoning?: ReasoningEffort
}

interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' | 'original' } }

function normalizeCredentials(value: unknown): ChatCompletionsCredentials {
  try {
    if (!hasExactKeys(value, ['baseUrl', 'apiKey'])) throw new ChatCompletionsClientError('invalid_credential')
    const baseUrl = normalizeChatCompletionsBaseUrl(value.baseUrl)
    if (
      typeof value.apiKey !== 'string' ||
      value.apiKey.length < 1 ||
      value.apiKey.length > MAX_API_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(value.apiKey)
    ) throw new ChatCompletionsClientError('invalid_credential')
    return { baseUrl, apiKey: value.apiKey }
  } catch (error) {
    if (error instanceof ChatCompletionsClientError) throw error
    throw new ChatCompletionsClientError('invalid_credential')
  }
}

function normalizeRequest(value: unknown): NormalizedRequest {
  try {
    if (!hasOnlyKeys(value, ['model', 'messages', 'endpointPath', 'system', 'instructions', 'reasoning'])) invalidInput()
    if (
      typeof value.model !== 'string' ||
      value.model.length < 1 ||
      value.model.length > MAX_MODEL_LENGTH ||
      !MODEL_PATTERN.test(value.model)
    ) invalidInput()

    const messagesValue = value.messages
    if (!Array.isArray(messagesValue) || messagesValue.length < 1 || messagesValue.length > MAX_MESSAGES) {
      invalidInput()
    }
    const messages = messagesValue.map((message) => normalizeMessage(message))
    const endpointPath = normalizeChatCompletionsPath(value.endpointPath)
    const systemParts: string[] = []
    for (const key of ['system', 'instructions'] as const) {
      const item = value[key]
      if (item === undefined) continue
      if (
        typeof item !== 'string' ||
        item.length < 1 ||
        item.length > MAX_INSTRUCTIONS_CHARACTERS ||
        item.includes('\0')
      ) invalidInput()
      systemParts.push(item)
    }
    if (systemParts.length > 0) {
      messages.unshift({ role: 'system', content: systemParts.join('\n\n') })
    }

    let reasoning: ReasoningEffort | undefined
    if (value.reasoning !== undefined) {
      if (!isReasoningEffort(value.reasoning)) invalidInput()
      // "auto" is the service's local default and is not sent as a remote
      // parameter because many OpenAI-compatible gateways reject it.
      if (value.reasoning !== 'auto') reasoning = value.reasoning
    }

    const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8')
    if (bytes > MAX_INPUT_BYTES) invalidInput()
    return { model: value.model, messages, endpointPath, ...(reasoning === undefined ? {} : { reasoning }) }
  } catch (error) {
    if (error instanceof ChatCompletionsClientError) throw error
    throw new ChatCompletionsClientError('invalid_input')
  }
}

function normalizeChatCompletionsPath(value: unknown = '/chat/completions'): string {
  try {
    const path = normalizeNativePath(value)
    if (path.includes('?')) throw new Error('invalid_endpoint')
    return path
  } catch {
    throw new ChatCompletionsClientError('invalid_endpoint')
  }
}

function normalizeMessage(value: unknown): ChatMessage {
  if (!hasExactKeys(value, ['role', 'content'])) invalidInput()
  if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role)) invalidInput()
  const role = value.role === 'developer' ? 'system' : value.role as ChatMessage['role']
  const content = value.content
  if (typeof content === 'string') {
    if (content.length < 1 || content.length > MAX_MESSAGE_CHARACTERS || content.includes('\0')) invalidInput()
    return { role, content }
  }
  if (!Array.isArray(content) || content.length < 1 || content.length > 17) invalidInput()
  const normalizedParts = content.map((part) => normalizeContentPart(part))
  if (!normalizedParts.some((part) => part.type === 'text')) invalidInput()
  return { role, content: normalizedParts }
}

function normalizeContentPart(value: unknown): ChatContentPart {
  if (!isPlainRecord(value) || typeof value.type !== 'string') invalidInput()
  if (value.type === 'input_text') {
    if (!hasExactKeys(value, ['type', 'text'])) invalidInput()
    if (
      typeof value.text !== 'string' ||
      value.text.length < 1 ||
      value.text.length > MAX_MESSAGE_CHARACTERS ||
      value.text.includes('\0')
    ) invalidInput()
    return { type: 'text', text: value.text }
  }
  if (value.type === 'input_image') {
    if (!hasOnlyKeys(value, ['type', 'image_url', 'detail'])) invalidInput()
    if (typeof value.image_url !== 'string') invalidInput()
    validateImageDataUrl(value.image_url)
    let detail: Extract<ChatContentPart, { type: 'image_url' }>['image_url']['detail']
    if (value.detail !== undefined) {
      if (!['auto', 'low', 'high', 'original'].includes(String(value.detail))) invalidInput()
      detail = value.detail as Extract<ChatContentPart, { type: 'image_url' }>['image_url']['detail']
    }
    return {
      type: 'image_url',
      image_url: { url: value.image_url, ...(detail === undefined ? {} : { detail }) }
    }
  }
  // input_file cannot be represented by the Chat Completions contract without
  // silently changing semantics, so fail closed rather than dropping it.
  invalidInput()
}

function validateImageDataUrl(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > MAX_DATA_URL_CHARACTERS ||
    !value.startsWith('data:')
  ) invalidInput()
  const separator = value.indexOf(';base64,')
  if (separator < 6) invalidInput()
  const mime = value.slice(5, separator).toLowerCase()
  if (!IMAGE_MIME_TYPES.has(mime) || value.slice(5, separator) !== mime) invalidInput()
  const encoded = value.slice(separator + 8)
  if (
    encoded.length < 4 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) invalidInput()
}

function serializeRequest(request: NormalizedRequest): string {
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.reasoning === undefined
      ? {}
      : { reasoning_effort: mapReasoningEffortForWire(request.reasoning, 'chat-completions') })
  })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new ChatCompletionsClientError('invalid_input')
  }
  return body
}

interface ConsumeOptions {
  maxResponseBytes: number
  maxEventBytes: number
  maxOutputTextBytes: number
  explicitSecrets: readonly string[]
  onEvent?: (event: ChatCompletionsStreamEvent) => void | Promise<void>
}

async function consumeResponseStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeOptions
): Promise<ChatCompletionsStreamResult> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new SseParser(options.maxEventBytes)
  const reader = body.getReader()
  let responseBytes = 0
  let outputBytes = 0
  let outputText = ''
  let responseId: string | null = null
  let completed = false

  const processEvents = async (events: readonly RawSseEvent[]): Promise<void> => {
    for (const event of events) {
      if (completed) {
        // Anything other than comments after [DONE] is malformed and could
        // otherwise be mistaken for a second completion.
        throw new ChatCompletionsClientError('invalid_response')
      }
      if (event.data === '[DONE]') {
        completed = true
        continue
      }
      if (event.data.length > options.maxEventBytes) throw new ChatCompletionsClientError('event_too_large')
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        throw new ChatCompletionsClientError('invalid_response')
      }
      if (!isPlainRecord(payload)) throw new ChatCompletionsClientError('invalid_response')
      if (Object.hasOwn(payload, 'error')) {
        throw new ChatCompletionsClientError('remote_error')
      }
      const id = normalizeResponseId(payload.id)
      if (id !== null) {
        if (responseId !== null && responseId !== id) throw new ChatCompletionsClientError('invalid_response')
        responseId = id
      }
      if (payload.object !== undefined && payload.object !== 'chat.completion.chunk') {
        throw new ChatCompletionsClientError('invalid_response')
      }
      if (!Array.isArray(payload.choices)) throw new ChatCompletionsClientError('invalid_response')
      for (const choice of payload.choices) {
        if (!isPlainRecord(choice)) throw new ChatCompletionsClientError('invalid_response')
        if (choice.index !== 0) throw new ChatCompletionsClientError('invalid_response')
        if (
          choice.finish_reason === 'tool_calls' ||
          choice.finish_reason === 'function_call'
        ) throw new ChatCompletionsClientError('invalid_response')
        if (choice.finish_reason === 'content_filter') {
          throw new ChatCompletionsClientError('remote_rejected', false, 'content_filtered')
        }
        if (choice.delta === undefined || choice.delta === null) continue
        if (!isPlainRecord(choice.delta)) throw new ChatCompletionsClientError('invalid_response')
        if (Object.hasOwn(choice.delta, 'tool_calls') || Object.hasOwn(choice.delta, 'function_call')) {
          throw new ChatCompletionsClientError('invalid_response')
        }
        if (choice.delta.content === undefined || choice.delta.content === null) continue
        if (typeof choice.delta.content !== 'string' || choice.delta.content.includes('\0')) {
          throw new ChatCompletionsClientError('invalid_response')
        }
        const delta = choice.delta.content
        outputBytes += Buffer.byteLength(delta, 'utf8')
        if (outputBytes > options.maxOutputTextBytes) throw new ChatCompletionsClientError('response_too_large')
        outputText += delta
        await deliverEvent(options.onEvent, { type: 'response.output_text.delta', delta })
      }
    }
  }

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new ChatCompletionsClientError('invalid_response')
      responseBytes += next.value.byteLength
      if (responseBytes > options.maxResponseBytes) throw new ChatCompletionsClientError('response_too_large')
      let decoded: string
      try {
        decoded = decoder.decode(next.value, { stream: true })
      } catch {
        throw new ChatCompletionsClientError('invalid_response')
      }
      await processEvents(parser.push(decoded))
    }
    let tail: string
    try {
      tail = decoder.decode()
    } catch {
      throw new ChatCompletionsClientError('invalid_response')
    }
    await processEvents(parser.finish(tail))
    if (!completed) throw new ChatCompletionsClientError('invalid_response')
    return { responseId, outputText }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Reader cleanup is best effort and must not expose stream internals.
    }
  }
}

interface RawSseEvent {
  event: string
  data: string
}

class SseParser {
  #buffer = ''
  #eventName = 'message'
  #dataLines: string[] = []
  #eventBytes = 0
  readonly #maxEventBytes: number

  constructor(maxEventBytes: number) {
    this.#maxEventBytes = maxEventBytes
  }

  push(text: string): RawSseEvent[] {
    this.#buffer += text
    this.#assertBounded()
    return this.#drain(false)
  }

  finish(text: string): RawSseEvent[] {
    this.#buffer += text
    return this.#drain(true)
  }

  #drain(final: boolean): RawSseEvent[] {
    const events: RawSseEvent[] = []
    let consumed = 0
    while (true) {
      const lineEnd = firstLineEnding(this.#buffer, consumed)
      if (lineEnd < 0) break
      if (!final && this.#buffer[lineEnd] === '\r' && lineEnd === this.#buffer.length - 1) break
      const delimiterLength = this.#buffer[lineEnd] === '\r' && this.#buffer[lineEnd + 1] === '\n' ? 2 : 1
      const line = this.#buffer.slice(consumed, lineEnd)
      const bytes = Buffer.byteLength(line, 'utf8') + delimiterLength
      this.#eventBytes += bytes
      if (this.#eventBytes > this.#maxEventBytes) throw new ChatCompletionsClientError('event_too_large')
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
        if (this.#eventBytes > this.#maxEventBytes) throw new ChatCompletionsClientError('event_too_large')
        this.#processLine(line, events)
      }
      // A data event is only complete after a blank line. Treat a truncated
      // final event as invalid instead of accepting a partial response.
      if (this.#dataLines.length > 0 || this.#eventBytes > 0) {
        throw new ChatCompletionsClientError('invalid_response')
      }
    }
    return events
  }

  #processLine(line: string, events: RawSseEvent[]): void {
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
      throw new ChatCompletionsClientError('event_too_large')
    }
  }
}

async function deliverEvent(
  consumer: ChatCompletionsStreamOptions['onEvent'],
  event: ChatCompletionsStreamEvent
): Promise<void> {
  if (!consumer) return
  try {
    await consumer(event)
  } catch {
    throw new ChatCompletionsClientError('consumer_error')
  }
}

function normalizeResponseId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_RESPONSE_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) throw new ChatCompletionsClientError('invalid_response')
  return value
}

function classifyRemoteFailure(status: number): ChatCompletionsRemoteFailure {
  if (status === 401 || status === 403) return 'authorization'
  if (status === 405) return 'chat_completions_unsupported'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'server_error'
  return 'request_rejected'
}

function isRemoteFailure(value: unknown): value is ChatCompletionsRemoteFailure {
  return value === 'authorization' ||
    value === 'chat_completions_unsupported' ||
    value === 'content_filtered' ||
    value === 'rate_limited' ||
    value === 'server_error' ||
    value === 'request_rejected'
}

function normalizeStreamOptions(value: unknown): ChatCompletionsStreamOptions {
  if (!hasOnlyKeys(value, ['signal', 'onEvent'])) throw new ChatCompletionsClientError('invalid_configuration')
  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw new ChatCompletionsClientError('invalid_configuration')
  }
  if (value.onEvent !== undefined && typeof value.onEvent !== 'function') {
    throw new ChatCompletionsClientError('invalid_configuration')
  }
  return value as ChatCompletionsStreamOptions
}

function configurationInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ChatCompletionsClientError('invalid_configuration')
  }
  return value
}

function invalidInput(): never {
  throw new ChatCompletionsClientError('invalid_input')
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Do not read or retain rejected response bodies: they can contain secrets.
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const signal = value as Partial<AbortSignal>
  return typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys<K extends string>(value: unknown, allowedKeys: readonly K[]): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const allowed = new Set<string>(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

// ── streamWithTools helpers ───────────────────────────────────────────────────

interface NormalizedRequestWithTools {
  model: string
  messages: NormalizedToolMessage[]
  tools: ChatCompletionsToolDefinition[]
  endpointPath: string
  reasoning?: ReasoningEffort
}

type NormalizedToolMessage =
  | ChatMessage
  | ChatCompletionsToolResultMessage
  | ChatCompletionsAssistantWithToolsMessage

function normalizeRequestWithTools(value: unknown): NormalizedRequestWithTools {
  try {
    if (!hasOnlyKeys(value, [
      'model',
      'messages',
      'tools',
      'endpointPath',
      'instructions',
      'reasoning'
    ])) invalidInput()
    if (
      typeof value.model !== 'string' ||
      value.model.length < 1 ||
      value.model.length > MAX_MODEL_LENGTH ||
      !MODEL_PATTERN.test(value.model)
    ) invalidInput()

    if (
      !Array.isArray(value.messages) ||
      value.messages.length < 1 ||
      value.messages.length > MAX_MESSAGES
    ) invalidInput()
    const messages = value.messages.map(normalizeMessageWithTools)

    if (!Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 128) invalidInput()
    const tools = value.tools.map(normalizeToolDefinition)
    const endpointPath = normalizeChatCompletionsPath(value.endpointPath)

    if (value.instructions !== undefined) {
      if (
        typeof value.instructions !== 'string' ||
        value.instructions.length < 1 ||
        value.instructions.length > MAX_INSTRUCTIONS_CHARACTERS ||
        value.instructions.includes('\0') ||
        messages.length >= MAX_MESSAGES
      ) invalidInput()
      messages.unshift({ role: 'system', content: value.instructions })
    }
    validateToolMessageSequence(messages)

    let reasoning: ReasoningEffort | undefined
    if (value.reasoning !== undefined) {
      if (!isReasoningEffort(value.reasoning)) invalidInput()
      if (value.reasoning !== 'auto') reasoning = value.reasoning
    }

    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > MAX_INPUT_BYTES) invalidInput()
    return {
      model: value.model,
      messages,
      tools,
      endpointPath,
      ...(reasoning === undefined ? {} : { reasoning })
    }
  } catch (error) {
    if (error instanceof ChatCompletionsClientError) throw error
    throw new ChatCompletionsClientError('invalid_input')
  }
}

function normalizeToolDefinition(value: unknown): ChatCompletionsToolDefinition {
  if (
    !hasExactKeys(value, ['type', 'function']) ||
    value.type !== 'function' ||
    !hasOnlyKeys(value.function, ['name', 'description', 'parameters']) ||
    typeof value.function.name !== 'string' ||
    value.function.name.length < 1 ||
    value.function.name.length > MAX_TOOL_NAME_LENGTH ||
    value.function.name.includes('\0') ||
    (value.function.description !== undefined && (
      typeof value.function.description !== 'string' ||
      value.function.description.length > MAX_MESSAGE_CHARACTERS ||
      value.function.description.includes('\0')
    )) ||
    (value.function.parameters !== undefined && !isPlainRecord(value.function.parameters))
  ) invalidInput()
  return {
    type: 'function',
    function: {
      name: value.function.name,
      ...(value.function.description !== undefined
        ? { description: value.function.description }
        : {}),
      ...(value.function.parameters !== undefined
        ? { parameters: value.function.parameters as Record<string, unknown> }
        : {})
    }
  }
}

function normalizeMessageWithTools(value: unknown): NormalizedToolMessage {
  if (!isPlainRecord(value)) invalidInput()
  if (value.role === 'tool') {
    if (
      !hasExactKeys(value, ['role', 'tool_call_id', 'content']) ||
      !isSafeToolCallId(value.tool_call_id) ||
      typeof value.content !== 'string' ||
      value.content.length > MAX_INPUT_BYTES ||
      value.content.includes('\0')
    ) invalidInput()
    return {
      role: 'tool',
      tool_call_id: value.tool_call_id,
      content: value.content
    }
  }

  if (Object.hasOwn(value, 'tool_calls')) {
    if (
      !hasExactKeys(value, ['role', 'content', 'tool_calls']) ||
      value.role !== 'assistant' ||
      typeof value.content !== 'string' ||
      value.content.length > MAX_INPUT_BYTES ||
      value.content.includes('\0') ||
      !Array.isArray(value.tool_calls) ||
      value.tool_calls.length < 1 ||
      value.tool_calls.length > MAX_TOOL_CALLS_PER_MESSAGE
    ) invalidInput()
    return {
      role: 'assistant',
      content: value.content,
      tool_calls: value.tool_calls.map(normalizeToolCall)
    }
  }

  return normalizeMessage(value)
}

function normalizeToolCall(value: unknown): ChatCompletionsToolCall {
  if (
    !hasExactKeys(value, ['id', 'type', 'function']) ||
    !isSafeToolCallId(value.id) ||
    value.type !== 'function' ||
    !hasExactKeys(value.function, ['name', 'arguments']) ||
    typeof value.function.name !== 'string' ||
    value.function.name.length < 1 ||
    value.function.name.length > MAX_TOOL_NAME_LENGTH ||
    value.function.name.includes('\0') ||
    typeof value.function.arguments !== 'string' ||
    value.function.arguments.length > MAX_INPUT_BYTES ||
    value.function.arguments.includes('\0')
  ) invalidInput()
  try {
    JSON.parse(value.function.arguments)
  } catch {
    invalidInput()
  }
  return {
    id: value.id,
    type: 'function',
    function: {
      name: value.function.name,
      arguments: value.function.arguments
    }
  }
}

function validateToolMessageSequence(messages: readonly NormalizedToolMessage[]): void {
  const pendingCallIds = new Set<string>()
  for (const message of messages) {
    if ('tool_calls' in message) {
      if (pendingCallIds.size > 0) invalidInput()
      for (const toolCall of message.tool_calls) {
        if (pendingCallIds.has(toolCall.id)) invalidInput()
        pendingCallIds.add(toolCall.id)
      }
      continue
    }
    if (message.role === 'tool') {
      if (!pendingCallIds.delete(message.tool_call_id)) invalidInput()
      continue
    }
    if (pendingCallIds.size > 0) invalidInput()
  }
  if (pendingCallIds.size > 0) invalidInput()
}

function isSafeToolCallId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOOL_CALL_ID_LENGTH &&
    !value.includes('\0')
}

function normalizeRecoverableToolCalls(
  value: unknown
): readonly ChatCompletionsRecoverableToolCall[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    return undefined
  }
  const seenIds = new Set<string>()
  const normalized: ChatCompletionsRecoverableToolCall[] = []
  for (const item of value) {
    if (
      !isPlainRecord(item) ||
      !isSafeToolCallId(item.id) ||
      seenIds.has(item.id) ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > MAX_TOOL_NAME_LENGTH ||
      item.name.includes('\0')
    ) {
      return undefined
    }
    seenIds.add(item.id)
    normalized.push({ id: item.id, name: item.name })
  }
  return Object.freeze(normalized)
}

function serializeRequestWithTools(request: NormalizedRequestWithTools): string {
  let body: string
  try {
    body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.reasoning === undefined
        ? {}
        : { reasoning_effort: mapReasoningEffortForWire(request.reasoning, 'chat-completions') })
    })
  } catch {
    throw new ChatCompletionsClientError('invalid_input')
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new ChatCompletionsClientError('invalid_input')
  }
  return body
}

interface ConsumeToolOptions {
  maxResponseBytes: number
  maxEventBytes: number
  maxOutputTextBytes: number
  explicitSecrets: readonly string[]
  onEvent?: (event: ChatCompletionsStreamEvent) => void | Promise<void>
}

/** Accumulator for a single streaming tool_call (built up from delta chunks). */
interface ToolCallAccumulator {
  id: string
  name: string | null
  argumentChunks: string[]
}

async function consumeToolResponseStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeToolOptions
): Promise<ChatCompletionsStreamWithToolsResult> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new SseParser(options.maxEventBytes)
  const reader = body.getReader()
  let responseBytes = 0
  let outputBytes = 0
  let outputText = ''
  let responseId: string | null = null
  let completed = false
  let receivedTerminalChoice = false
  let receivedUsageChunk = false
  const toolAccumulators = new Map<number, ToolCallAccumulator>()

  const processEvents = async (events: readonly RawSseEvent[]): Promise<void> => {
    for (const event of events) {
      if (completed) throw new ChatCompletionsClientError('invalid_response')
      if (event.data === '[DONE]') {
        completed = true
        continue
      }
      if (event.data.length > options.maxEventBytes) throw new ChatCompletionsClientError('event_too_large')
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        throw new ChatCompletionsClientError('invalid_response')
      }
      if (!isPlainRecord(payload)) throw new ChatCompletionsClientError('invalid_response')
      if (Object.hasOwn(payload, 'error')) throw new ChatCompletionsClientError('remote_error')

      const id = normalizeResponseId(payload.id)
      if (id !== null) {
        if (responseId !== null && responseId !== id) throw new ChatCompletionsClientError('invalid_response')
        responseId = id
      }
      if (!Array.isArray(payload.choices)) throw new ChatCompletionsClientError('invalid_response')
      if (payload.choices.length > 1) throw new ChatCompletionsClientError('invalid_response')
      if (payload.choices.length === 0) {
        if (
          !receivedTerminalChoice ||
          receivedUsageChunk ||
          !isPlainRecord(payload.usage)
        ) throw new ChatCompletionsClientError('invalid_response')
        receivedUsageChunk = true
        continue
      }
      for (const choice of payload.choices) {
        if (!isPlainRecord(choice)) throw new ChatCompletionsClientError('invalid_response')
        if (receivedTerminalChoice) throw new ChatCompletionsClientError('invalid_response')
        if (choice.index !== undefined && choice.index !== 0) {
          throw new ChatCompletionsClientError('invalid_response')
        }
        if (
          choice.finish_reason !== undefined &&
          choice.finish_reason !== null &&
          choice.finish_reason !== '' &&
          (typeof choice.finish_reason !== 'string' || !TOOL_FINISH_REASONS.has(choice.finish_reason))
        ) throw new ChatCompletionsClientError('invalid_response')
        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          receivedTerminalChoice = true
        }
        if (choice.delta === undefined || choice.delta === null) continue
        if (!isPlainRecord(choice.delta)) throw new ChatCompletionsClientError('invalid_response')

        // Collect text content delta
        if (choice.delta.content !== undefined && choice.delta.content !== null) {
          if (typeof choice.delta.content !== 'string' || choice.delta.content.includes('\0')) {
            throw new ChatCompletionsClientError('invalid_response')
          }
          const delta = choice.delta.content
          outputBytes += Buffer.byteLength(delta, 'utf8')
          if (outputBytes > options.maxOutputTextBytes) throw new ChatCompletionsClientError('response_too_large')
          outputText += delta
          await deliverEvent(options.onEvent, { type: 'response.output_text.delta', delta })
        }

        // Collect tool_calls deltas
        if (Object.hasOwn(choice.delta, 'function_call')) {
          throw new ChatCompletionsClientError('invalid_response')
        }
        if (Object.hasOwn(choice.delta, 'tool_calls') && !Array.isArray(choice.delta.tool_calls)) {
          throw new ChatCompletionsClientError('invalid_response')
        }
        if (Array.isArray(choice.delta.tool_calls)) {
          if (choice.delta.tool_calls.length > MAX_TOOL_CALLS_PER_MESSAGE) {
            throw new ChatCompletionsClientError('invalid_response')
          }
          for (const tc of choice.delta.tool_calls) {
            if (!isPlainRecord(tc)) throw new ChatCompletionsClientError('invalid_response')
            let idx: number
            if (tc.index === undefined) {
              if (choice.delta.tool_calls.length !== 1 || toolAccumulators.size > 1) {
                throw new ChatCompletionsClientError('invalid_response')
              }
              idx = toolAccumulators.size === 1
                ? toolAccumulators.keys().next().value as number
                : 0
            } else {
              if (
                typeof tc.index !== 'number' ||
                !Number.isSafeInteger(tc.index) ||
                tc.index < 0 ||
                tc.index >= MAX_TOOL_CALLS_PER_MESSAGE
              ) throw new ChatCompletionsClientError('invalid_response')
              idx = tc.index
            }
            if (tc.type !== undefined && tc.type !== 'function') {
              throw new ChatCompletionsClientError('invalid_response')
            }
            let acc = toolAccumulators.get(idx)
            if (!acc) {
              // NewAPI's Responses-to-Chat adapter can emit argument data
              // before it learns the tool name. The safe id still establishes
              // the accumulator; a unique non-empty name is required later.
              if (!isSafeToolCallId(tc.id)) {
                throw new ChatCompletionsClientError('invalid_response')
              }
              if (!isPlainRecord(tc.function)) {
                throw new ChatCompletionsClientError('invalid_response')
              }
              const rawName = tc.function.name
              if (
                rawName !== undefined && (
                  typeof rawName !== 'string' ||
                  rawName.length > MAX_TOOL_NAME_LENGTH ||
                  rawName.includes('\0')
                )
              ) throw new ChatCompletionsClientError('invalid_response')
              acc = {
                id: tc.id,
                name: typeof rawName === 'string' && rawName.length > 0 ? rawName : null,
                argumentChunks: []
              }
              if (
                acc.name === null &&
                (!Object.hasOwn(tc.function, 'arguments') ||
                  typeof tc.function.arguments !== 'string' ||
                  tc.function.arguments.includes('\0'))
              ) {
                throw new ChatCompletionsClientError('invalid_response')
              }
              toolAccumulators.set(idx, acc)
            }
            if (tc.id !== undefined && tc.id !== '' && tc.id !== acc.id) {
              throw new ChatCompletionsClientError('invalid_response')
            }
            if (tc.function !== undefined && !isPlainRecord(tc.function)) {
              throw new ChatCompletionsClientError('invalid_response')
            }
            if (isPlainRecord(tc.function)) {
              if (tc.function.name !== undefined) {
                if (
                  typeof tc.function.name !== 'string' ||
                  tc.function.name.length > MAX_TOOL_NAME_LENGTH ||
                  tc.function.name.includes('\0') ||
                  (tc.function.name.length > 0 && acc.name !== null && tc.function.name !== acc.name)
                ) throw new ChatCompletionsClientError('invalid_response')
                if (tc.function.name.length > 0 && acc.name === null) {
                  acc.name = tc.function.name
                }
              }
              if (tc.function.arguments !== undefined) {
                if (
                  typeof tc.function.arguments !== 'string' ||
                  tc.function.arguments.includes('\0')
                ) throw new ChatCompletionsClientError('invalid_response')
                acc.argumentChunks.push(tc.function.arguments)
              }
            }
          }
        }
      }
    }
  }

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new ChatCompletionsClientError('invalid_response')
      responseBytes += next.value.byteLength
      if (responseBytes > options.maxResponseBytes) throw new ChatCompletionsClientError('response_too_large')
      let decoded: string
      try { decoded = decoder.decode(next.value, { stream: true }) } catch { throw new ChatCompletionsClientError('invalid_response') }
      await processEvents(parser.push(decoded))
    }
    let tail: string
    try { tail = decoder.decode() } catch { throw new ChatCompletionsClientError('invalid_response') }
    await processEvents(parser.finish(tail))
    if (!completed && !receivedTerminalChoice) throw new ChatCompletionsClientError('invalid_response')

    const orderedAccumulators = [...toolAccumulators.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => acc)
    const completedAccumulators = orderedAccumulators.map((acc) => {
      if (acc.name === null) throw new ChatCompletionsClientError('invalid_response')
      return { ...acc, name: acc.name }
    })
    const malformedToolCalls: ChatCompletionsRecoverableToolCall[] = []
    for (const acc of completedAccumulators) {
      const args = acc.argumentChunks.join('')
      try {
        JSON.parse(args || '{}')
      } catch {
        // Keep only identities that were validated while parsing the stream.
        // The Agent can return a fixed tool_failed result without echoing or
        // executing the malformed argument text.
        malformedToolCalls.push({ id: acc.id, name: acc.name })
      }
    }
    if (malformedToolCalls.length > 0) {
      throw new ChatCompletionsClientError(
        'invalid_response',
        undefined,
        undefined,
        malformedToolCalls
      )
    }
    const toolCalls: ChatCompletionsToolCall[] = completedAccumulators.map((acc) => ({
      id: acc.id,
      type: 'function',
      function: { name: acc.name, arguments: acc.argumentChunks.join('') }
    }))
    return { responseId, outputText, toolCalls, hasToolCalls: toolCalls.length > 0 }
  } finally {
    try { reader.releaseLock() } catch { /* best effort */ }
  }
}

function hasExactKeys<K extends string>(value: unknown, expectedKeys: readonly K[]): value is Record<K, unknown> {
  if (!hasOnlyKeys(value, expectedKeys)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}

function firstLineEnding(text: string, start: number): number {
  const carriageReturn = text.indexOf('\r', start)
  const lineFeed = text.indexOf('\n', start)
  if (carriageReturn < 0) return lineFeed
  if (lineFeed < 0) return carriageReturn
  return Math.min(carriageReturn, lineFeed)
}
