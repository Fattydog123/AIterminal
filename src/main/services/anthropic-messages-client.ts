import { containsSensitiveCredential } from '../security/redaction.ts'
import type {
  ModelReasoningProtocol,
  ReasoningEffort
} from '../../shared/contracts.ts'
import type {
  ResponsesInputFileContent,
  ResponsesInputImageContent,
  ResponsesJsonObject,
  ResponsesJsonValue,
  ResponsesMessage,
  ResponsesUserContentPart
} from './responses-client.ts'
import {
  NativeSseProtocolError,
  consumeNativeSse,
  configurationInteger,
  discardNativeResponseBody,
  hasExactKeys,
  hasOnlyKeys,
  isAbortSignal,
  isPlainRecord,
  joinNativeEndpoint,
  normalizeNativeBaseUrl,
  normalizeNativePath
} from './native-sse-utils.ts'
import {
  cloneModelReasoningProtocol,
  isModelReasoningProtocol,
  isReasoningEffort,
  isReasoningEffortRepresentable,
  mapReasoningEffortForWire,
  reasoningBudgetForEffort
} from './reasoning-protocol.ts'

type AnthropicReasoningProtocol = Extract<
  ModelReasoningProtocol,
  { type: 'anthropic-adaptive' | 'anthropic-budget' }
>

/** Credentials for a NewAPI/native Anthropic Messages endpoint. */
export interface AnthropicMessagesCredentials {
  baseUrl: string
  apiKey: string
}

/** The transport intentionally accepts the shared Responses history shape. */
export type AnthropicMessagesMessage = ResponsesMessage

export interface AnthropicMessagesStreamRequest {
  model: string
  messages: readonly AnthropicMessagesMessage[]
  /** Request-level relay path. When present, it overrides the client default. */
  endpointPath?: string
  system?: string
  instructions?: string
  reasoning?: ReasoningEffort
  reasoningProtocol?: AnthropicReasoningProtocol
  maxTokens?: number
  /** Raw Anthropic spelling is accepted for route adapters that pass it through. */
  max_tokens?: number
  temperature?: number
  topP?: number
  top_p?: number
  topK?: number
  top_k?: number
  stopSequences?: readonly string[]
  stop_sequences?: readonly string[]
}

export type AnthropicMessagesStreamEvent = {
  type: 'response.output_text.delta'
  delta: string
}

export interface AnthropicMessagesStreamResult {
  responseId: string | null
  outputText: string
}

export interface AnthropicMessagesStreamOptions {
  signal?: AbortSignal
  onEvent?: (event: AnthropicMessagesStreamEvent) => void | Promise<void>
}

// Native Anthropic tool-calling types. These remain transport-specific so the
// Agent runtime can adapt them without weakening the shared renderer contract.
export interface AnthropicMessagesToolDefinition {
  name: string
  description?: string
  input_schema: ResponsesJsonObject
}

export interface AnthropicMessagesTextContentBlock {
  type: 'text'
  text: string
}

export interface AnthropicMessagesThinkingContentBlock {
  type: 'thinking'
  thinking: string
  signature: string
}

export interface AnthropicMessagesRedactedThinkingContentBlock {
  type: 'redacted_thinking'
  data: string
}

export interface AnthropicMessagesToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: ResponsesJsonObject
}

export interface AnthropicMessagesToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AnthropicMessagesAssistantContentBlock =
  | AnthropicMessagesTextContentBlock
  | AnthropicMessagesThinkingContentBlock
  | AnthropicMessagesRedactedThinkingContentBlock
  | AnthropicMessagesToolUseContentBlock

export type AnthropicMessagesAgentContentPart =
  | ResponsesUserContentPart
  | AnthropicMessagesAssistantContentBlock
  | AnthropicMessagesToolResultContentBlock

export interface AnthropicMessagesAgentMessage {
  role: 'system' | 'developer' | 'user' | 'assistant'
  content: string | readonly AnthropicMessagesAgentContentPart[]
}

export interface AnthropicMessagesStreamWithToolsRequest {
  model: string
  messages: readonly AnthropicMessagesAgentMessage[]
  tools: readonly AnthropicMessagesToolDefinition[]
  endpointPath?: string
  system?: string
  instructions?: string
  reasoning?: ReasoningEffort
  reasoningProtocol?: AnthropicReasoningProtocol
  maxTokens?: number
  max_tokens?: number
  temperature?: number
  topP?: number
  top_p?: number
  topK?: number
  top_k?: number
  stopSequences?: readonly string[]
  stop_sequences?: readonly string[]
}

export interface AnthropicMessagesToolCall {
  id: string
  name: string
  input: ResponsesJsonObject
}

export interface AnthropicMessagesStreamWithToolsResult extends AnthropicMessagesStreamResult {
  toolCalls: AnthropicMessagesToolCall[]
  hasToolCalls: boolean
  assistantContent: AnthropicMessagesAssistantContentBlock[]
}

export type AnthropicMessagesStreamWithToolsOptions = AnthropicMessagesStreamOptions

export interface AnthropicMessagesClientOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  maxEventBytes?: number
  maxOutputTextBytes?: number
  /** Safe path relative to the confirmed API root. Defaults to `/messages`. */
  path?: string
  /** Alias useful when a relay returns `supported_endpoint` path metadata. */
  endpointPath?: string
}

export type AnthropicMessagesClientErrorCode =
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

export type AnthropicMessagesRemoteFailure =
  | 'authorization'
  | 'anthropic_messages_unsupported'
  | 'rate_limited'
  | 'server_error'
  | 'request_rejected'

const ERROR_DETAILS: Readonly<Record<AnthropicMessagesClientErrorCode, {
  message: string
  retryable: boolean
}>> = {
  invalid_configuration: { message: 'The Anthropic Messages client configuration is invalid.', retryable: false },
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

export class AnthropicMessagesClientError extends Error {
  readonly code: AnthropicMessagesClientErrorCode
  readonly retryable: boolean
  readonly remoteFailure?: AnthropicMessagesRemoteFailure

  constructor(
    code: AnthropicMessagesClientErrorCode,
    retryable?: boolean,
    remoteFailure?: AnthropicMessagesRemoteFailure
  ) {
    const detail = ERROR_DETAILS[code]
    super(detail.message)
    this.name = 'AnthropicMessagesClientError'
    this.code = code
    this.retryable = retryable ?? detail.retryable
    this.remoteFailure = code === 'remote_rejected' && isRemoteFailure(remoteFailure)
      ? remoteFailure
      : undefined
    // Do not retain upstream errors, response text, URLs, or headers in a
    // stack: any of them may contain credentials or user content.
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
const MAX_STOP_SEQUENCES = 16
const MAX_STOP_SEQUENCE_LENGTH = 256
const MAX_FUNCTION_TOOLS = 32
const MAX_FUNCTION_TOOL_CALLS = 32
const MAX_CONTENT_BLOCKS = 96
const MAX_FUNCTION_NAME_LENGTH = 64
const MAX_FUNCTION_DESCRIPTION_CHARACTERS = 4 * 1024
const MAX_FUNCTION_SCHEMA_BYTES = 128 * 1024
const MAX_FUNCTION_ARGUMENT_BYTES = 256 * 1024
const MAX_FUNCTION_OUTPUT_CHARACTERS = 512 * 1024
const MAX_CALL_ID_LENGTH = 256
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 20_000
const MAX_JSON_KEY_LENGTH = 256
const MAX_JSON_STRING_CHARACTERS = 512 * 1024
const MAX_TEMPERATURE = 2
const MAX_TOP_K = 1_000_000
const MAX_TOP_P = 1
const MAX_TOKENS = 1_000_000
const DEFAULT_MAX_TOKENS = 4_096
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u
const CALL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u
const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant'])
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/yaml'
])
const ATTACHMENT_NAME_PATTERN =
  /^attachment-[1-9][0-9]?\.(?:png|jpg|jpeg|webp|gif|pdf|txt|md|csv|json|html|xml|yaml|yml)$/u

export function normalizeAnthropicMessagesBaseUrl(value: unknown): string {
  try {
    return normalizeNativeBaseUrl(value)
  } catch {
    throw new AnthropicMessagesClientError('invalid_endpoint')
  }
}

export function normalizeAnthropicMessagesPath(value: unknown = '/messages'): string {
  try {
    const path = normalizeNativePath(value)
    if (path.includes('?')) throw new Error('invalid_endpoint')
    return path
  } catch {
    throw new AnthropicMessagesClientError('invalid_endpoint')
  }
}

export function buildAnthropicMessagesRequestUrl(
  baseUrl: unknown,
  endpointPath: unknown = '/messages'
): string {
  try {
    return joinNativeEndpoint(
      normalizeAnthropicMessagesBaseUrl(baseUrl),
      normalizeAnthropicMessagesPath(endpointPath)
    )
  } catch (error) {
    if (error instanceof AnthropicMessagesClientError) throw error
    throw new AnthropicMessagesClientError('invalid_endpoint')
  }
}

export class AnthropicMessagesClient {
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxEventBytes: number
  readonly #maxOutputTextBytes: number
  readonly #path: string

  constructor(options: AnthropicMessagesClientOptions = {}) {
    const candidate: unknown = options
    if (!hasOnlyKeys(candidate, [
      'fetcher',
      'timeoutMs',
      'maxResponseBytes',
      'maxEventBytes',
      'maxOutputTextBytes',
      'path',
      'endpointPath'
    ])) throw new AnthropicMessagesClientError('invalid_configuration')
    if (candidate.fetcher !== undefined && typeof candidate.fetcher !== 'function') {
      throw new AnthropicMessagesClientError('invalid_configuration')
    }
    try {
      this.#timeoutMs = configurationInteger(candidate.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 10 * 60_000)
      this.#maxResponseBytes = configurationInteger(
        candidate.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        256,
        MAX_RESPONSE_BYTES
      )
      this.#maxEventBytes = configurationInteger(candidate.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 64, MAX_EVENT_BYTES)
      this.#maxOutputTextBytes = configurationInteger(
        candidate.maxOutputTextBytes,
        DEFAULT_MAX_OUTPUT_TEXT_BYTES,
        64,
        MAX_OUTPUT_TEXT_BYTES
      )
      if (this.#maxEventBytes > this.#maxResponseBytes || this.#maxOutputTextBytes > this.#maxResponseBytes) {
        throw new AnthropicMessagesClientError('invalid_configuration')
      }
      const path = candidate.path ?? candidate.endpointPath ?? '/messages'
      if (candidate.path !== undefined && candidate.endpointPath !== undefined && candidate.path !== candidate.endpointPath) {
        throw new AnthropicMessagesClientError('invalid_configuration')
      }
      this.#path = normalizeAnthropicMessagesPath(path)
    } catch (error) {
      if (error instanceof AnthropicMessagesClientError) throw error
      throw new AnthropicMessagesClientError('invalid_configuration')
    }
    this.#fetcher = (candidate.fetcher as typeof fetch | undefined) ?? globalThis.fetch
    if (typeof this.#fetcher !== 'function') throw new AnthropicMessagesClientError('invalid_configuration')
  }

  async stream(
    credentials: AnthropicMessagesCredentials,
    request: AnthropicMessagesStreamRequest,
    options: AnthropicMessagesStreamOptions = {}
  ): Promise<AnthropicMessagesStreamResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequest(request)
    const normalizedOptions = normalizeStreamOptions(options)
    const requestBody = serializeRequest(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new AnthropicMessagesClientError('invalid_input')
    }
    if (normalizedOptions.signal?.aborted) throw new AnthropicMessagesClientError('cancelled')

    const requestUrl = buildAnthropicMessagesRequestUrl(
      normalizedCredentials.baseUrl,
      normalizedRequest.endpointPath ?? this.#path
    )
    if (containsSensitiveCredential(requestUrl, [normalizedCredentials.apiKey])) {
      throw new AnthropicMessagesClientError('invalid_endpoint')
    }

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
          'Content-Type': 'application/json',
          'x-api-key': normalizedCredentials.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (response.status >= 300 && response.status < 400) {
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('remote_rejected', retryable, remoteFailure)
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > this.#maxResponseBytes) {
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('remote_rejected', false, 'anthropic_messages_unsupported')
      }

      let responseId: string | null = null
      let outputText = ''
      let outputBytes = 0
      let completed = false
      const consumed = await consumeNativeSse(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        requireCompletion: true,
        onEvent: async (event) => {
          if (completed) throw new AnthropicMessagesClientError('invalid_response')
          if (event.data === '[DONE]') {
            completed = true
            return true
          }
          if (event.data.length > this.#maxEventBytes) throw new AnthropicMessagesClientError('event_too_large')
          let payload: unknown
          try {
            payload = JSON.parse(event.data)
          } catch {
            throw new AnthropicMessagesClientError('invalid_response')
          }
          if (!isPlainRecord(payload)) throw new AnthropicMessagesClientError('invalid_response')
          const eventType = typeof payload.type === 'string' ? payload.type : event.event
          if (eventType === 'error' || Object.hasOwn(payload, 'error')) {
            throw new AnthropicMessagesClientError('remote_error')
          }
          if (eventType === 'message_start') {
            const message = isPlainRecord(payload.message) ? payload.message : null
            const id = normalizeResponseId(message?.id)
            if (id !== null) responseId = assertSameResponseId(responseId, id)
            return false
          }
          if (eventType === 'content_block_delta') {
            if (!isPlainRecord(payload.delta) || typeof payload.delta.type !== 'string') {
              throw new AnthropicMessagesClientError('invalid_response')
            }
            if (payload.delta.type === 'thinking_delta' || payload.delta.type === 'signature_delta') return false
            if (payload.delta.type !== 'text_delta') throw new AnthropicMessagesClientError('invalid_response')
            const delta = payload.delta.text
            if (typeof delta !== 'string' || delta.length < 1 || delta.includes('\0')) {
              throw new AnthropicMessagesClientError('invalid_response')
            }
            if (containsSensitiveCredential(delta, [normalizedCredentials.apiKey])) {
              throw new AnthropicMessagesClientError('invalid_response')
            }
            outputBytes += Buffer.byteLength(delta, 'utf8')
            if (outputBytes > this.#maxOutputTextBytes) throw new AnthropicMessagesClientError('response_too_large')
            outputText += delta
            await deliverEvent(normalizedOptions.onEvent, { type: 'response.output_text.delta', delta })
            return false
          }
          if (eventType === 'message_stop') {
            completed = true
            return true
          }
          if (
            eventType === 'message_delta' ||
            eventType === 'content_block_start' ||
            eventType === 'content_block_stop' ||
            eventType === 'ping'
          ) return false
          throw new AnthropicMessagesClientError('invalid_response')
        }
      })
      if (consumed.eventCount < 1) throw new AnthropicMessagesClientError('invalid_response')
      return { responseId, outputText }
    } catch (error) {
      if (normalizedOptions.signal?.aborted) throw new AnthropicMessagesClientError('cancelled')
      if (timedOut) throw new AnthropicMessagesClientError('timeout')
      if (error instanceof AnthropicMessagesClientError) throw error
      if (error instanceof NativeSseProtocolError) {
        throw new AnthropicMessagesClientError(error.code)
      }
      throw new AnthropicMessagesClientError('network_error')
    } finally {
      clearTimeout(timeout)
      normalizedOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  /** Stream a native Anthropic Messages turn that may return local tool calls. */
  async streamWithTools(
    credentials: AnthropicMessagesCredentials,
    request: AnthropicMessagesStreamWithToolsRequest,
    options: AnthropicMessagesStreamWithToolsOptions = {}
  ): Promise<AnthropicMessagesStreamWithToolsResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequestWithTools(request)
    const normalizedOptions = normalizeStreamOptions(options)
    const requestBody = serializeRequestWithTools(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new AnthropicMessagesClientError('invalid_input')
    }
    if (normalizedOptions.signal?.aborted) throw new AnthropicMessagesClientError('cancelled')

    const requestUrl = buildAnthropicMessagesRequestUrl(
      normalizedCredentials.baseUrl,
      normalizedRequest.endpointPath ?? this.#path
    )
    if (containsSensitiveCredential(requestUrl, [normalizedCredentials.apiKey])) {
      throw new AnthropicMessagesClientError('invalid_endpoint')
    }

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
          'Content-Type': 'application/json',
          'x-api-key': normalizedCredentials.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (response.status >= 300 && response.status < 400) {
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('remote_rejected', retryable, remoteFailure)
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > this.#maxResponseBytes) {
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardNativeResponseBody(response)
        throw new AnthropicMessagesClientError('remote_rejected', false, 'anthropic_messages_unsupported')
      }

      return await consumeAnthropicToolResponseStream(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        maxOutputTextBytes: this.#maxOutputTextBytes,
        allowedToolNames: new Set(normalizedRequest.tools.map((tool) => tool.name)),
        explicitSecrets: [normalizedCredentials.apiKey],
        signal: normalizedOptions.signal,
        onEvent: normalizedOptions.onEvent
      })
    } catch (error) {
      if (normalizedOptions.signal?.aborted) throw new AnthropicMessagesClientError('cancelled')
      if (timedOut) throw new AnthropicMessagesClientError('timeout')
      if (error instanceof AnthropicMessagesClientError) throw error
      if (error instanceof NativeSseProtocolError) {
        throw new AnthropicMessagesClientError(error.code)
      }
      throw new AnthropicMessagesClientError('network_error')
    } finally {
      clearTimeout(timeout)
      normalizedOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

/** Name retained for callers that distinguish OpenAI-compatible adapters. */
export const OpenAICompatibleAnthropicMessagesClient = AnthropicMessagesClient

interface NormalizedRequest {
  model: string
  messages: AnthropicMessage[]
  endpointPath?: string
  system?: string
  maxTokens: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: string[]
  reasoning?: ReasoningEffort
  reasoningProtocol?: AnthropicReasoningProtocol
}

interface NormalizedRequestWithTools {
  model: string
  messages: AnthropicMessage[]
  tools: AnthropicMessagesToolDefinition[]
  endpointPath?: string
  system?: string
  maxTokens: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: string[]
  reasoning?: ReasoningEffort
  reasoningProtocol?: AnthropicReasoningProtocol
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentPart[]
}

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; title?: string; source: { type: 'base64'; media_type: string; data: string } }
  | AnthropicMessagesThinkingContentBlock
  | AnthropicMessagesRedactedThinkingContentBlock
  | AnthropicMessagesToolUseContentBlock
  | AnthropicMessagesToolResultContentBlock

function normalizeCredentials(value: unknown): AnthropicMessagesCredentials {
  try {
    if (!hasExactKeys(value, ['baseUrl', 'apiKey'])) throw new AnthropicMessagesClientError('invalid_credential')
    const baseUrl = normalizeAnthropicMessagesBaseUrl(value.baseUrl)
    if (
      typeof value.apiKey !== 'string' ||
      value.apiKey.length < 1 ||
      value.apiKey.length > MAX_API_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(value.apiKey)
    ) throw new AnthropicMessagesClientError('invalid_credential')
    return { baseUrl, apiKey: value.apiKey }
  } catch (error) {
    if (error instanceof AnthropicMessagesClientError) throw error
    throw new AnthropicMessagesClientError('invalid_credential')
  }
}

function normalizeRequest(value: unknown): NormalizedRequest {
  try {
    if (!hasOnlyKeys(value, [
      'model',
      'messages',
      'endpointPath',
      'system',
      'instructions',
      'reasoning',
      'reasoningProtocol',
      'maxTokens',
      'max_tokens',
      'temperature',
      'topP',
      'top_p',
      'topK',
      'top_k',
      'stopSequences',
      'stop_sequences'
    ])) invalidInput()
    if (
      typeof value.model !== 'string' ||
      value.model.length < 1 ||
      value.model.length > MAX_MODEL_LENGTH ||
      !MODEL_PATTERN.test(value.model)
    ) invalidInput()
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) invalidInput()
    const endpointPath = value.endpointPath === undefined
      ? undefined
      : normalizeAnthropicMessagesPath(value.endpointPath)

    const systemParts: string[] = []
    const explicitSystem = value.system
    const instructions = value.instructions
    for (const item of [explicitSystem, instructions]) {
      if (item === undefined) continue
      if (typeof item !== 'string' || item.length < 1 || item.length > MAX_INSTRUCTIONS_CHARACTERS || item.includes('\0')) {
        invalidInput()
      }
      systemParts.push(item)
    }
    const messages: AnthropicMessage[] = []
    for (const messageValue of value.messages) {
      if (!hasExactKeys(messageValue, ['role', 'content'])) invalidInput()
      if (typeof messageValue.role !== 'string' || !MESSAGE_ROLES.has(messageValue.role)) invalidInput()
      const role = messageValue.role as ResponsesMessage['role']
      if (role === 'system' || role === 'developer') {
        systemParts.push(normalizeSystemContent(messageValue.content))
      } else {
        messages.push({ role, content: normalizeContent(messageValue.content) })
      }
    }
    if (messages.length < 1) invalidInput()
    const maxTokens = normalizeAliasedInteger(value.maxTokens, value.max_tokens, DEFAULT_MAX_TOKENS, 1, MAX_TOKENS)
    const temperature = normalizeOptionalNumber(value.temperature, 0, MAX_TEMPERATURE)
    const topP = normalizeAliasedNumber(value.topP, value.top_p, 0, MAX_TOP_P)
    const topK = normalizeOptionalAliasedInteger(value.topK, value.top_k, 1, MAX_TOP_K)
    const stopSequences = normalizeStopSequences(value.stopSequences ?? value.stop_sequences)
    if (value.reasoning !== undefined && !isReasoningEffort(value.reasoning)) invalidInput()
    const reasoningProtocol = normalizeAnthropicReasoningProtocol(value.reasoningProtocol)
    assertAnthropicReasoningCompatible(value.reasoning, reasoningProtocol)
    const inputBytes = Buffer.byteLength(JSON.stringify({ messages, system: systemParts }), 'utf8')
    if (inputBytes > MAX_INPUT_BYTES) invalidInput()
    return {
      model: value.model,
      messages,
      ...(endpointPath === undefined ? {} : { endpointPath }),
      ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
      maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(topK === undefined ? {} : { topK }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
      ...(reasoningProtocol === undefined ? {} : { reasoningProtocol })
    }
  } catch (error) {
    if (error instanceof AnthropicMessagesClientError) throw error
    throw new AnthropicMessagesClientError('invalid_input')
  }
}

function normalizeRequestWithTools(value: unknown): NormalizedRequestWithTools {
  try {
    if (!hasOnlyKeys(value, [
      'model',
      'messages',
      'tools',
      'endpointPath',
      'system',
      'instructions',
      'reasoning',
      'reasoningProtocol',
      'maxTokens',
      'max_tokens',
      'temperature',
      'topP',
      'top_p',
      'topK',
      'top_k',
      'stopSequences',
      'stop_sequences'
    ])) invalidInput()
    if (
      typeof value.model !== 'string' ||
      value.model.length < 1 ||
      value.model.length > MAX_MODEL_LENGTH ||
      !MODEL_PATTERN.test(value.model)
    ) invalidInput()
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) {
      invalidInput()
    }
    const tools = normalizeToolDefinitions(value.tools)
    const allowedToolNames = new Set(tools.map((tool) => tool.name))
    const endpointPath = value.endpointPath === undefined
      ? undefined
      : normalizeAnthropicMessagesPath(value.endpointPath)

    const systemParts: string[] = []
    for (const item of [value.system, value.instructions]) {
      if (item === undefined) continue
      if (typeof item !== 'string' || item.length < 1 || item.length > MAX_INSTRUCTIONS_CHARACTERS || item.includes('\0')) {
        invalidInput()
      }
      systemParts.push(item)
    }

    const historyToolUses = new Map<string, string>()
    const historyToolResults = new Set<string>()
    const messages: AnthropicMessage[] = []
    for (const messageValue of value.messages) {
      if (!hasExactKeys(messageValue, ['role', 'content'])) invalidInput()
      if (typeof messageValue.role !== 'string' || !MESSAGE_ROLES.has(messageValue.role)) invalidInput()
      const role = messageValue.role as ResponsesMessage['role']
      if (role === 'system' || role === 'developer') {
        systemParts.push(normalizeSystemContent(messageValue.content))
        continue
      }
      messages.push({
        role,
        content: normalizeAgentContent(
          messageValue.content,
          role,
          allowedToolNames,
          historyToolUses,
          historyToolResults
        )
      })
    }
    if (messages.length < 1 || historyToolUses.size !== historyToolResults.size) invalidInput()
    for (const callId of historyToolUses.keys()) {
      if (!historyToolResults.has(callId)) invalidInput()
    }

    const maxTokens = normalizeAliasedInteger(value.maxTokens, value.max_tokens, DEFAULT_MAX_TOKENS, 1, MAX_TOKENS)
    const temperature = normalizeOptionalNumber(value.temperature, 0, MAX_TEMPERATURE)
    const topP = normalizeAliasedNumber(value.topP, value.top_p, 0, MAX_TOP_P)
    const topK = normalizeOptionalAliasedInteger(value.topK, value.top_k, 1, MAX_TOP_K)
    const stopSequences = normalizeStopSequences(value.stopSequences ?? value.stop_sequences)
    if (value.reasoning !== undefined && !isReasoningEffort(value.reasoning)) invalidInput()
    const reasoningProtocol = normalizeAnthropicReasoningProtocol(value.reasoningProtocol)
    assertAnthropicReasoningCompatible(value.reasoning, reasoningProtocol)
    const inputBytes = Buffer.byteLength(JSON.stringify({ messages, system: systemParts, tools }), 'utf8')
    if (inputBytes > MAX_INPUT_BYTES) invalidInput()
    return {
      model: value.model,
      messages,
      tools,
      ...(endpointPath === undefined ? {} : { endpointPath }),
      ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
      maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(topK === undefined ? {} : { topK }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
      ...(reasoningProtocol === undefined ? {} : { reasoningProtocol })
    }
  } catch (error) {
    if (error instanceof AnthropicMessagesClientError) throw error
    throw new AnthropicMessagesClientError('invalid_input')
  }
}

function normalizeToolDefinitions(value: unknown): AnthropicMessagesToolDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FUNCTION_TOOLS) invalidInput()
  const names = new Set<string>()
  return value.map((item) => {
    if (
      !hasOnlyKeys(item, ['name', 'description', 'input_schema']) ||
      !Object.hasOwn(item, 'name') ||
      !Object.hasOwn(item, 'input_schema')
    ) invalidInput()
    const name = normalizeToolName(item.name, 'invalid_input')
    if (names.has(name)) invalidInput()
    names.add(name)
    let description: string | undefined
    if (item.description !== undefined) {
      if (
        typeof item.description !== 'string' ||
        item.description.length < 1 ||
        item.description.length > MAX_FUNCTION_DESCRIPTION_CHARACTERS ||
        item.description.includes('\0')
      ) invalidInput()
      description = item.description
    }
    const inputSchema = normalizeBoundedJsonObject(item.input_schema, 'invalid_input', MAX_FUNCTION_SCHEMA_BYTES)
    if (inputSchema.type !== 'object') invalidInput()
    return {
      name,
      ...(description === undefined ? {} : { description }),
      input_schema: inputSchema
    }
  })
}

function normalizeAgentContent(
  value: unknown,
  role: 'user' | 'assistant',
  allowedToolNames: ReadonlySet<string>,
  historyToolUses: Map<string, string>,
  historyToolResults: Set<string>
): string | AnthropicContentPart[] {
  if (typeof value === 'string') {
    if (value.length < 1 || value.length > MAX_MESSAGE_CHARACTERS || value.includes('\0')) invalidInput()
    return value
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTENT_BLOCKS) invalidInput()
  return value.map((part) => {
    if (!isPlainRecord(part) || typeof part.type !== 'string') invalidInput()
    if (part.type === 'input_text' || part.type === 'input_image' || part.type === 'input_file') {
      if (role !== 'user') invalidInput()
      return normalizeContentPart(part)
    }
    if (part.type === 'text') {
      if (!hasExactKeys(part, ['type', 'text']) || typeof part.text !== 'string') invalidInput()
      if (part.text.length < 1 || part.text.length > MAX_MESSAGE_CHARACTERS || part.text.includes('\0')) invalidInput()
      return { type: 'text' as const, text: part.text }
    }
    if (part.type === 'thinking') {
      if (
        role !== 'assistant' ||
        !hasExactKeys(part, ['type', 'thinking', 'signature']) ||
        typeof part.thinking !== 'string' ||
        part.thinking.includes('\0') ||
        Buffer.byteLength(part.thinking, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES ||
        typeof part.signature !== 'string' ||
        part.signature.length < 1 ||
        part.signature.includes('\0') ||
        Buffer.byteLength(part.signature, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES
      ) invalidInput()
      return {
        type: 'thinking' as const,
        thinking: part.thinking,
        signature: part.signature
      }
    }
    if (part.type === 'redacted_thinking') {
      if (
        role !== 'assistant' ||
        !hasExactKeys(part, ['type', 'data']) ||
        typeof part.data !== 'string' ||
        part.data.length < 1 ||
        part.data.includes('\0') ||
        Buffer.byteLength(part.data, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES
      ) invalidInput()
      return { type: 'redacted_thinking' as const, data: part.data }
    }
    if (part.type === 'tool_use') {
      if (role !== 'assistant' || !hasExactKeys(part, ['type', 'id', 'name', 'input'])) invalidInput()
      const id = normalizeToolCallId(part.id, 'invalid_input')
      const name = normalizeToolName(part.name, 'invalid_input')
      if (!allowedToolNames.has(name) || historyToolUses.has(id)) invalidInput()
      const input = normalizeBoundedJsonObject(part.input, 'invalid_input', MAX_FUNCTION_ARGUMENT_BYTES)
      historyToolUses.set(id, name)
      return { type: 'tool_use' as const, id, name, input }
    }
    if (part.type === 'tool_result') {
      if (
        role !== 'user' ||
        !hasOnlyKeys(part, ['type', 'tool_use_id', 'content', 'is_error']) ||
        !Object.hasOwn(part, 'tool_use_id') ||
        !Object.hasOwn(part, 'content')
      ) invalidInput()
      const toolUseId = normalizeToolCallId(part.tool_use_id, 'invalid_input')
      if (!historyToolUses.has(toolUseId) || historyToolResults.has(toolUseId)) invalidInput()
      if (
        typeof part.content !== 'string' ||
        part.content.length > MAX_FUNCTION_OUTPUT_CHARACTERS ||
        part.content.includes('\0') ||
        (part.is_error !== undefined && typeof part.is_error !== 'boolean')
      ) invalidInput()
      historyToolResults.add(toolUseId)
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseId,
        content: part.content,
        ...(part.is_error === undefined ? {} : { is_error: part.is_error })
      }
    }
    invalidInput()
  })
}

function normalizeSystemContent(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length < 1 || value.length > MAX_MESSAGE_CHARACTERS || value.includes('\0')) invalidInput()
    return value
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 17) invalidInput()
  const text: string[] = []
  for (const part of value) {
    if (!hasExactKeys(part, ['type', 'text']) || part.type !== 'input_text' || typeof part.text !== 'string') invalidInput()
    if (part.text.length < 1 || part.text.length > MAX_MESSAGE_CHARACTERS || part.text.includes('\0')) invalidInput()
    text.push(part.text)
  }
  return text.join('\n')
}

function normalizeContent(value: unknown): string | AnthropicContentPart[] {
  if (typeof value === 'string') {
    if (value.length < 1 || value.length > MAX_MESSAGE_CHARACTERS || value.includes('\0')) invalidInput()
    return value
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 17) invalidInput()
  return value.map((part) => normalizeContentPart(part))
}

function normalizeContentPart(value: unknown): AnthropicContentPart {
  if (!isPlainRecord(value) || typeof value.type !== 'string') invalidInput()
  if (value.type === 'input_text') {
    if (!hasExactKeys(value, ['type', 'text']) || typeof value.text !== 'string') invalidInput()
    if (value.text.length < 1 || value.text.length > MAX_MESSAGE_CHARACTERS || value.text.includes('\0')) invalidInput()
    return { type: 'text', text: value.text }
  }
  if (value.type === 'input_image') {
    if (!hasOnlyKeys(value, ['type', 'image_url', 'detail']) || typeof value.image_url !== 'string') invalidInput()
    const source = parseDataUrl(value.image_url, IMAGE_MIME_TYPES)
    if (value.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(String(value.detail))) invalidInput()
    return {
      type: 'image',
      source: { type: 'base64', media_type: source.mimeType, data: source.base64 }
    }
  }
  if (value.type === 'input_file') {
    if (!hasOnlyKeys(value, ['type', 'filename', 'file_data', 'detail']) ||
      typeof value.filename !== 'string' || !ATTACHMENT_NAME_PATTERN.test(value.filename) ||
      typeof value.file_data !== 'string') invalidInput()
    const source = parseDataUrl(value.file_data, DOCUMENT_MIME_TYPES)
    if (value.detail !== undefined && !['auto', 'low', 'high'].includes(String(value.detail))) invalidInput()
    return {
      type: 'document',
      title: value.filename,
      source: { type: 'base64', media_type: source.mimeType, data: source.base64 }
    }
  }
  invalidInput()
}

function parseDataUrl(value: string, allowedMimes: ReadonlySet<string>): { mimeType: string; base64: string } {
  if (value.length < 32 || value.length > MAX_DATA_URL_CHARACTERS || !value.startsWith('data:')) invalidInput()
  const separator = value.indexOf(';base64,')
  if (separator < 6) invalidInput()
  const mimeType = value.slice(5, separator).toLowerCase()
  const base64 = value.slice(separator + 8)
  if (!allowedMimes.has(mimeType) || value.slice(5, separator) !== mimeType || !isCanonicalBase64(base64)) invalidInput()
  return { mimeType, base64 }
}

function isCanonicalBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function normalizeAnthropicReasoningProtocol(
  value: unknown
): AnthropicReasoningProtocol | undefined {
  if (value === undefined) return undefined
  if (
    !isModelReasoningProtocol(value) ||
    (value.type !== 'anthropic-adaptive' && value.type !== 'anthropic-budget')
  ) {
    invalidInput()
  }
  return cloneModelReasoningProtocol(value) as AnthropicReasoningProtocol
}

function assertAnthropicReasoningCompatible(
  effort: ReasoningEffort | undefined,
  protocol: AnthropicReasoningProtocol | undefined
): void {
  if (effort === undefined || effort === 'auto' || protocol === undefined) return
  if (protocol.type === 'anthropic-adaptive') {
    if (!isReasoningEffortRepresentable(effort, 'anthropic-adaptive')) invalidInput()
    return
  }
  if (reasoningBudgetForEffort(protocol, effort) === undefined) invalidInput()
}

function anthropicReasoningFields(
  request: Pick<NormalizedRequest, 'reasoning' | 'reasoningProtocol' | 'maxTokens'>
): {
  maxTokens: number
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number }
  outputConfig?: { effort: string }
} {
  if (
    request.reasoning === undefined ||
    request.reasoning === 'auto' ||
    request.reasoningProtocol === undefined
  ) {
    return { maxTokens: request.maxTokens }
  }
  if (request.reasoningProtocol.type === 'anthropic-adaptive') {
    const effort = mapReasoningEffortForWire(request.reasoning, 'anthropic-adaptive')
    if (effort === undefined) invalidInput()
    return {
      maxTokens: request.maxTokens,
      thinking: { type: 'adaptive' },
      outputConfig: { effort }
    }
  }

  const budget = reasoningBudgetForEffort(request.reasoningProtocol, request.reasoning)
  if (budget === undefined || budget >= MAX_TOKENS) invalidInput()
  const maxTokens = Math.max(request.maxTokens, budget + 1_024)
  if (maxTokens > MAX_TOKENS) invalidInput()
  return {
    maxTokens,
    thinking: { type: 'enabled', budget_tokens: budget }
  }
}

function serializeRequest(request: NormalizedRequest): string {
  const reasoning = anthropicReasoningFields(request)
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    max_tokens: reasoning.maxTokens,
    stream: true,
    ...(reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking }),
    ...(reasoning.outputConfig === undefined ? {} : { output_config: reasoning.outputConfig }),
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.topK === undefined ? {} : { top_k: request.topK }),
    ...(request.stopSequences === undefined ? {} : { stop_sequences: request.stopSequences })
  })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) throw new AnthropicMessagesClientError('invalid_input')
  return body
}

function serializeRequestWithTools(request: NormalizedRequestWithTools): string {
  const reasoning = anthropicReasoningFields(request)
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    max_tokens: reasoning.maxTokens,
    stream: true,
    tools: request.tools,
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    ...(reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking }),
    ...(reasoning.outputConfig === undefined ? {} : { output_config: reasoning.outputConfig }),
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.topK === undefined ? {} : { top_k: request.topK }),
    ...(request.stopSequences === undefined ? {} : { stop_sequences: request.stopSequences })
  })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new AnthropicMessagesClientError('invalid_input')
  }
  return body
}

interface ConsumeAnthropicToolStreamOptions {
  maxResponseBytes: number
  maxEventBytes: number
  maxOutputTextBytes: number
  allowedToolNames: ReadonlySet<string>
  explicitSecrets: readonly string[]
  signal?: AbortSignal
  onEvent?: (event: AnthropicMessagesStreamEvent) => void | Promise<void>
}

type AnthropicToolStreamBlock =
  | { kind: 'text'; stopped: boolean; chunks: string[] }
  | {
      kind: 'tool_use'
      stopped: boolean
      id: string
      name: string
      initialInput: ResponsesJsonObject
      argumentChunks: string[]
      argumentBytes: number
    }
  | {
      kind: 'thinking'
      stopped: boolean
      thinkingChunks: string[]
      thinkingBytes: number
      thinkingSensitiveTail: string
      signatureChunks: string[]
      signatureBytes: number
      signatureSensitiveTail: string
    }
  | { kind: 'redacted_thinking'; stopped: boolean; data: string }

async function consumeAnthropicToolResponseStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeAnthropicToolStreamOptions
): Promise<AnthropicMessagesStreamWithToolsResult> {
  let responseId: string | null = null
  let outputText = ''
  let outputBytes = 0
  let sensitiveTail = ''
  let messageStarted = false
  let completed = false
  let stopReason: string | null = null
  const blocks = new Map<number, AnthropicToolStreamBlock>()
  const toolCallIds = new Set<string>()

  const sensitiveTailLength = Math.max(0, ...options.explicitSecrets.map((secret) => secret.length - 1))
  const appendText = async (
    block: Extract<AnthropicToolStreamBlock, { kind: 'text' }>,
    delta: string
  ): Promise<void> => {
    if (delta.length < 1 || delta.includes('\0')) invalidResponse()
    const inspection = sensitiveTail + delta
    if (containsSensitiveCredential(inspection, options.explicitSecrets)) invalidResponse()
    sensitiveTail = sensitiveTailLength === 0 ? '' : inspection.slice(-sensitiveTailLength)
    outputBytes += Buffer.byteLength(delta, 'utf8')
    if (outputBytes > options.maxOutputTextBytes) responseTooLarge()
    block.chunks.push(delta)
    outputText += delta
    await deliverEvent(options.onEvent, { type: 'response.output_text.delta', delta })
  }

  const consumed = await consumeNativeSse(body, {
    maxResponseBytes: options.maxResponseBytes,
    maxEventBytes: options.maxEventBytes,
    requireCompletion: true,
    onEvent: async (event) => {
      if (options.signal?.aborted) throw new AnthropicMessagesClientError('cancelled')
      if (completed) invalidResponse()
      if (event.data === '[DONE]') {
        completed = true
        return true
      }
      if (event.data.length > options.maxEventBytes) {
        throw new AnthropicMessagesClientError('event_too_large')
      }
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        invalidResponse()
      }
      if (!isPlainRecord(payload)) invalidResponse()
      const eventType = typeof payload.type === 'string' ? payload.type : event.event
      if (eventType === 'error' || Object.hasOwn(payload, 'error')) {
        throw new AnthropicMessagesClientError('remote_error')
      }
      if (eventType === 'ping') return false

      if (eventType === 'message_start') {
        if (messageStarted || blocks.size > 0) invalidResponse()
        messageStarted = true
        const message = isPlainRecord(payload.message) ? payload.message : null
        const id = normalizeResponseId(message?.id)
        if (id !== null) responseId = assertSameResponseId(responseId, id)
        return false
      }
      if (!messageStarted) invalidResponse()

      if (eventType === 'content_block_start') {
        const index = normalizeContentBlockIndex(payload.index)
        if (blocks.has(index) || blocks.size >= MAX_CONTENT_BLOCKS) invalidResponse()
        if (!isPlainRecord(payload.content_block) || typeof payload.content_block.type !== 'string') {
          invalidResponse()
        }
        const block = payload.content_block
        if (block.type === 'text') {
          if (!hasExactKeys(block, ['type', 'text']) || typeof block.text !== 'string' || block.text.includes('\0')) {
            invalidResponse()
          }
          const textBlock: Extract<AnthropicToolStreamBlock, { kind: 'text' }> = {
            kind: 'text',
            stopped: false,
            chunks: []
          }
          blocks.set(index, textBlock)
          if (block.text.length > 0) await appendText(textBlock, block.text)
          return false
        }
        if (block.type === 'tool_use') {
          if (
            !hasExactKeys(block, ['type', 'id', 'name', 'input']) ||
            toolCallIds.size >= MAX_FUNCTION_TOOL_CALLS
          ) invalidResponse()
          const id = normalizeToolCallId(block.id, 'invalid_response')
          const name = normalizeToolName(block.name, 'invalid_response')
          if (!options.allowedToolNames.has(name) || toolCallIds.has(id)) invalidResponse()
          const initialInput = normalizeBoundedJsonObject(
            block.input,
            'invalid_response',
            MAX_FUNCTION_ARGUMENT_BYTES
          )
          toolCallIds.add(id)
          blocks.set(index, {
            kind: 'tool_use',
            stopped: false,
            id,
            name,
            initialInput,
            argumentChunks: [],
            argumentBytes: 0
          })
          return false
        }
        if (block.type === 'thinking') {
          if (!hasOnlyKeys(block, ['type', 'thinking', 'signature'])) invalidResponse()
          const initialThinking = block.thinking ?? ''
          const initialSignature = block.signature ?? ''
          if (
            typeof initialThinking !== 'string' ||
            initialThinking.includes('\0') ||
            Buffer.byteLength(initialThinking, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES ||
            typeof initialSignature !== 'string' ||
            initialSignature.includes('\0') ||
            Buffer.byteLength(initialSignature, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES ||
            containsSensitiveCredential(initialThinking, options.explicitSecrets) ||
            containsSensitiveCredential(initialSignature, options.explicitSecrets)
          ) invalidResponse()
          blocks.set(index, {
            kind: 'thinking',
            stopped: false,
            thinkingChunks: initialThinking ? [initialThinking] : [],
            thinkingBytes: Buffer.byteLength(initialThinking, 'utf8'),
            thinkingSensitiveTail: sensitiveTailLength === 0
              ? ''
              : initialThinking.slice(-sensitiveTailLength),
            signatureChunks: initialSignature ? [initialSignature] : [],
            signatureBytes: Buffer.byteLength(initialSignature, 'utf8'),
            signatureSensitiveTail: sensitiveTailLength === 0
              ? ''
              : initialSignature.slice(-sensitiveTailLength)
          })
          return false
        }
        if (block.type === 'redacted_thinking') {
          if (
            !hasExactKeys(block, ['type', 'data']) ||
            typeof block.data !== 'string' ||
            block.data.length < 1 ||
            block.data.includes('\0') ||
            Buffer.byteLength(block.data, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES ||
            containsSensitiveCredential(block.data, options.explicitSecrets)
          ) invalidResponse()
          blocks.set(index, { kind: 'redacted_thinking', stopped: false, data: block.data })
          return false
        }
        invalidResponse()
      }

      if (eventType === 'content_block_delta') {
        const index = normalizeContentBlockIndex(payload.index)
        const block = blocks.get(index)
        if (!block || block.stopped || !isPlainRecord(payload.delta) || typeof payload.delta.type !== 'string') {
          invalidResponse()
        }
        const delta = payload.delta
        if (delta.type === 'text_delta') {
          if (block.kind !== 'text' || !hasExactKeys(delta, ['type', 'text']) || typeof delta.text !== 'string') {
            invalidResponse()
          }
          await appendText(block, delta.text)
          return false
        }
        if (delta.type === 'input_json_delta') {
          if (
            block.kind !== 'tool_use' ||
            !hasExactKeys(delta, ['type', 'partial_json']) ||
            typeof delta.partial_json !== 'string' ||
            delta.partial_json.includes('\0')
          ) invalidResponse()
          const bytes = Buffer.byteLength(delta.partial_json, 'utf8')
          block.argumentBytes += bytes
          if (block.argumentBytes > MAX_FUNCTION_ARGUMENT_BYTES) responseTooLarge()
          block.argumentChunks.push(delta.partial_json)
          return false
        }
        if (delta.type === 'thinking_delta') {
          if (
            block.kind !== 'thinking' ||
            !hasExactKeys(delta, ['type', 'thinking']) ||
            typeof delta.thinking !== 'string' ||
            delta.thinking.includes('\0')
          ) invalidResponse()
          const inspection = block.thinkingSensitiveTail + delta.thinking
          if (containsSensitiveCredential(inspection, options.explicitSecrets)) invalidResponse()
          block.thinkingSensitiveTail = sensitiveTailLength === 0
            ? ''
            : inspection.slice(-sensitiveTailLength)
          block.thinkingBytes += Buffer.byteLength(delta.thinking, 'utf8')
          if (block.thinkingBytes > MAX_FUNCTION_ARGUMENT_BYTES) responseTooLarge()
          block.thinkingChunks.push(delta.thinking)
          return false
        }
        if (delta.type === 'signature_delta') {
          if (
            block.kind !== 'thinking' ||
            !hasExactKeys(delta, ['type', 'signature']) ||
            typeof delta.signature !== 'string' ||
            delta.signature.includes('\0')
          ) invalidResponse()
          const inspection = block.signatureSensitiveTail + delta.signature
          if (containsSensitiveCredential(inspection, options.explicitSecrets)) invalidResponse()
          block.signatureSensitiveTail = sensitiveTailLength === 0
            ? ''
            : inspection.slice(-sensitiveTailLength)
          block.signatureBytes += Buffer.byteLength(delta.signature, 'utf8')
          if (block.signatureBytes > MAX_FUNCTION_ARGUMENT_BYTES) responseTooLarge()
          block.signatureChunks.push(delta.signature)
          return false
        }
        if (delta.type === 'citations_delta') {
          if (block.kind !== 'text' || !isPlainRecord(delta.citation)) invalidResponse()
          return false
        }
        invalidResponse()
      }

      if (eventType === 'content_block_stop') {
        const index = normalizeContentBlockIndex(payload.index)
        const block = blocks.get(index)
        if (!block || block.stopped) invalidResponse()
        block.stopped = true
        return false
      }
      if (eventType === 'message_delta') {
        if (!isPlainRecord(payload.delta)) invalidResponse()
        if (Object.hasOwn(payload.delta, 'stop_reason')) {
          const nextStopReason = payload.delta.stop_reason
          if (
            typeof nextStopReason !== 'string' ||
            nextStopReason.length < 1 ||
            nextStopReason.length > 64 ||
            !/^[A-Za-z0-9_-]+$/u.test(nextStopReason) ||
            (stopReason !== null && stopReason !== nextStopReason)
          ) invalidResponse()
          stopReason = nextStopReason
        }
        return false
      }
      if (eventType === 'message_stop') {
        if ([...blocks.values()].some((block) => !block.stopped)) invalidResponse()
        completed = true
        return true
      }
      invalidResponse()
    }
  })

  if (options.signal?.aborted) throw new AnthropicMessagesClientError('cancelled')
  if (consumed.eventCount < 1 || !messageStarted || !completed) invalidResponse()
  if ([...blocks.values()].some((block) => !block.stopped)) invalidResponse()

  const toolCalls: AnthropicMessagesToolCall[] = []
  const assistantContent: AnthropicMessagesAssistantContentBlock[] = []
  for (const [, block] of [...blocks.entries()].sort((left, right) => left[0] - right[0])) {
    if (block.kind === 'text') {
      const text = block.chunks.join('')
      // Some NewAPI-compatible streams open and close an empty text block
      // before a tool_use block. Empty Anthropic text blocks are not valid in
      // replayed message history, and carry no continuation state to retain.
      if (text.length > 0) assistantContent.push({ type: 'text', text })
      continue
    }
    if (block.kind === 'thinking') {
      const thinking = block.thinkingChunks.join('')
      const signature = block.signatureChunks.join('')
      if (signature.length < 1) invalidResponse()
      assistantContent.push({ type: 'thinking', thinking, signature })
      continue
    }
    if (block.kind === 'redacted_thinking') {
      assistantContent.push({ type: 'redacted_thinking', data: block.data })
      continue
    }
    const argumentText = block.argumentChunks.join('')
    let input: ResponsesJsonObject
    if (argumentText.length > 0) {
      if (Object.keys(block.initialInput).length > 0) invalidResponse()
      if (containsSensitiveCredential(argumentText, options.explicitSecrets)) invalidResponse()
      let parsed: unknown
      try {
        parsed = JSON.parse(argumentText)
      } catch {
        invalidResponse()
      }
      input = normalizeBoundedJsonObject(parsed, 'invalid_response', MAX_FUNCTION_ARGUMENT_BYTES)
    } else {
      input = structuredClone(block.initialInput)
    }
    if (containsSensitiveCredential(JSON.stringify(input), options.explicitSecrets)) invalidResponse()
    const toolUse = { type: 'tool_use' as const, id: block.id, name: block.name, input }
    assistantContent.push(toolUse)
    toolCalls.push({ id: toolUse.id, name: toolUse.name, input: toolUse.input })
  }
  if (toolCalls.length > 0 && stopReason !== null && stopReason !== 'tool_use') invalidResponse()
  if (toolCalls.length === 0 && stopReason === 'tool_use') invalidResponse()
  return {
    responseId,
    outputText,
    toolCalls,
    hasToolCalls: toolCalls.length > 0,
    assistantContent
  }
}

function normalizeContentBlockIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= MAX_CONTENT_BLOCKS) {
    invalidResponse()
  }
  return Number(value)
}

function normalizeToolCallId(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_CALL_ID_LENGTH ||
    !CALL_ID_PATTERN.test(value)
  ) throw new AnthropicMessagesClientError(errorCode)
  return value
}

function normalizeToolName(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_FUNCTION_NAME_LENGTH ||
    !FUNCTION_NAME_PATTERN.test(value)
  ) throw new AnthropicMessagesClientError(errorCode)
  return value
}

function normalizeBoundedJsonObject(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response',
  maxBytes: number
): ResponsesJsonObject {
  const budget = { nodes: 0 }
  const fail = (oversized = false): never => {
    if (oversized && errorCode === 'invalid_response') responseTooLarge()
    throw new AnthropicMessagesClientError(errorCode)
  }
  const visit = (item: unknown, depth: number): ResponsesJsonValue => {
    budget.nodes += 1
    if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) fail(true)
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail()
      return item
    }
    if (typeof item === 'string') {
      if (item.length > MAX_JSON_STRING_CHARACTERS) fail(true)
      if (item.includes('\0')) fail()
      return item
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    if (!isPlainRecord(item)) fail()
    const record = item as Record<string, unknown>
    const output: ResponsesJsonObject = {}
    for (const ownKey of Reflect.ownKeys(record)) {
      if (typeof ownKey !== 'string') fail()
      const key = ownKey as string
      if (key.length > MAX_JSON_KEY_LENGTH || FORBIDDEN_JSON_KEYS.has(key)) fail()
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      output[key] = visit((descriptor as PropertyDescriptor & { value: unknown }).value, depth + 1)
    }
    return output
  }
  const normalized = visit(value, 0)
  if (!isPlainRecord(normalized)) fail()
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxBytes) fail(true)
  return normalized as ResponsesJsonObject
}

function normalizeStopSequences(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_STOP_SEQUENCES) invalidInput()
  const output = value.map((item) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > MAX_STOP_SEQUENCE_LENGTH || item.includes('\0')) invalidInput()
    return item
  })
  return output
}

function normalizeAliasedInteger(
  camel: unknown,
  snake: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (camel !== undefined && snake !== undefined && camel !== snake) invalidInput()
  const value = camel ?? snake
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalidInput()
  return value
}

function normalizeOptionalAliasedInteger(
  camel: unknown,
  snake: unknown,
  minimum: number,
  maximum: number
): number | undefined {
  if (camel !== undefined && snake !== undefined && camel !== snake) invalidInput()
  const value = camel ?? snake
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalidInput()
  return value
}

function normalizeAliasedNumber(camel: unknown, snake: unknown, minimum: number, maximum: number): number | undefined {
  if (camel !== undefined && snake !== undefined && camel !== snake) invalidInput()
  const value = camel ?? snake
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalidInput()
  return value
}

function normalizeOptionalNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalidInput()
  return value
}

function normalizeStreamOptions(value: unknown): AnthropicMessagesStreamOptions {
  if (!hasOnlyKeys(value, ['signal', 'onEvent'])) throw new AnthropicMessagesClientError('invalid_configuration')
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw new AnthropicMessagesClientError('invalid_configuration')
  if (value.onEvent !== undefined && typeof value.onEvent !== 'function') throw new AnthropicMessagesClientError('invalid_configuration')
  return value as AnthropicMessagesStreamOptions
}

async function deliverEvent(
  consumer: AnthropicMessagesStreamOptions['onEvent'],
  event: AnthropicMessagesStreamEvent
): Promise<void> {
  if (!consumer) return
  try {
    await consumer(event)
  } catch {
    throw new AnthropicMessagesClientError('consumer_error')
  }
}

function normalizeResponseId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_RESPONSE_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new AnthropicMessagesClientError('invalid_response')
  }
  return value
}

function assertSameResponseId(previous: string | null, next: string): string {
  if (previous !== null && previous !== next) throw new AnthropicMessagesClientError('invalid_response')
  return next
}

function classifyRemoteFailure(status: number): AnthropicMessagesRemoteFailure {
  if (status === 401 || status === 403) return 'authorization'
  if (status === 405) return 'anthropic_messages_unsupported'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'server_error'
  return 'request_rejected'
}

function isRemoteFailure(value: unknown): value is AnthropicMessagesRemoteFailure {
  return value === 'authorization' ||
    value === 'anthropic_messages_unsupported' ||
    value === 'rate_limited' ||
    value === 'server_error' ||
    value === 'request_rejected'
}

function invalidResponse(): never {
  throw new AnthropicMessagesClientError('invalid_response')
}

function responseTooLarge(): never {
  throw new AnthropicMessagesClientError('response_too_large')
}

function invalidInput(): never {
  throw new AnthropicMessagesClientError('invalid_input')
}
