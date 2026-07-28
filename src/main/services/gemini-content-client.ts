import { randomBytes } from 'node:crypto'

import { containsSensitiveCredential } from '../security/redaction.ts'
import type {
  ModelReasoningProtocol,
  ReasoningEffort
} from '../../shared/contracts.ts'
import type {
  ResponsesJsonObject,
  ResponsesJsonValue,
  ResponsesMessage
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

type GeminiReasoningProtocol = Extract<
  ModelReasoningProtocol,
  { type: 'gemini-level' | 'gemini-budget' }
>

export interface GeminiContentCredentials {
  baseUrl: string
  apiKey: string
}

export type GeminiContentMessage = ResponsesMessage

export interface GeminiContentStreamRequest {
  model: string
  messages: readonly GeminiContentMessage[]
  endpointPath?: string
  system?: string
  instructions?: string
  reasoning?: ReasoningEffort
  reasoningProtocol?: GeminiReasoningProtocol
  temperature?: number
  topP?: number
  top_p?: number
  topK?: number
  top_k?: number
  maxOutputTokens?: number
  max_output_tokens?: number
}

export type GeminiContentStreamEvent = {
  type: 'response.output_text.delta'
  delta: string
}

export interface GeminiContentStreamResult {
  responseId: string | null
  outputText: string
}

export interface GeminiContentStreamOptions {
  signal?: AbortSignal
  onEvent?: (event: GeminiContentStreamEvent) => void | Promise<void>
}

/** OpenAI-shaped at the service boundary; serialized as Gemini functionDeclarations. */
export interface GeminiContentToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** A completed native Gemini functionCall normalized for the Agent loop. */
export interface GeminiContentToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** Canonical JSON for a bounded object, never a partial stream fragment. */
    arguments: string
  }
  /** Gemini 3 requires this opaque value to be replayed with the functionCall. */
  thoughtSignature?: string
}

export interface GeminiContentToolResultMessage {
  role: 'tool'
  tool_call_id: string
  name: string
  content: string
}

export interface GeminiContentAssistantWithToolsMessage {
  role: 'assistant'
  content: string
  tool_calls: readonly GeminiContentToolCall[]
  /**
   * Optional native model parts retained for a tool continuation.  Gemini
   * can put a thought/signature in a separate part before the function call;
   * reducing that response to `content` + `tool_calls` loses the opaque
   * signature and causes the next GenerateContent request to be rejected.
   */
  assistantContent?: readonly GeminiContentAssistantContentPart[]
}

export type GeminiContentAssistantContentPart =
  | {
      type: 'text'
      text: string
      thoughtSignature?: string
    }
  | {
      type: 'thought'
      text: string
      thoughtSignature?: string
    }
  | {
      type: 'function_call'
      toolCall: GeminiContentToolCall
    }

export interface GeminiContentStreamWithToolsRequest {
  model: string
  messages: readonly (
    | GeminiContentMessage
    | GeminiContentToolResultMessage
    | GeminiContentAssistantWithToolsMessage
  )[]
  tools: readonly GeminiContentToolDefinition[]
  endpointPath?: string
  instructions?: string
  reasoning?: ReasoningEffort
  reasoningProtocol?: GeminiReasoningProtocol
  temperature?: number
  topP?: number
  top_p?: number
  topK?: number
  top_k?: number
  maxOutputTokens?: number
  max_output_tokens?: number
}

export interface GeminiContentStreamWithToolsResult extends GeminiContentStreamResult {
  toolCalls: GeminiContentToolCall[]
  hasToolCalls: boolean
  /** Present when native assistant parts (for example thought signatures)
   * must be replayed on the next tool round. */
  assistantContent?: GeminiContentAssistantContentPart[]
}

export type GeminiContentStreamWithToolsOptions = GeminiContentStreamOptions

export interface GeminiContentClientOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  maxEventBytes?: number
  maxOutputTextBytes?: number
  /** A safe path or `{model}` template supplied by a relay route descriptor. */
  path?: string
  endpointPath?: string
}

export type GeminiContentClientErrorCode =
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

export type GeminiContentRemoteFailure =
  | 'authorization'
  | 'gemini_generate_content_unsupported'
  | 'rate_limited'
  | 'server_error'
  | 'request_rejected'

const ERROR_DETAILS: Readonly<Record<GeminiContentClientErrorCode, {
  message: string
  retryable: boolean
}>> = {
  invalid_configuration: { message: 'The Gemini content client configuration is invalid.', retryable: false },
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

export class GeminiContentClientError extends Error {
  readonly code: GeminiContentClientErrorCode
  readonly retryable: boolean
  readonly remoteFailure?: GeminiContentRemoteFailure

  constructor(
    code: GeminiContentClientErrorCode,
    retryable?: boolean,
    remoteFailure?: GeminiContentRemoteFailure
  ) {
    const detail = ERROR_DETAILS[code]
    super(detail.message)
    this.name = 'GeminiContentClientError'
    this.code = code
    this.retryable = retryable ?? detail.retryable
    this.remoteFailure = code === 'remote_rejected' && isRemoteFailure(remoteFailure)
      ? remoteFailure
      : undefined
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
const MAX_TEMPERATURE = 2
const MAX_TOP_P = 1
const MAX_TOP_K = 1_000_000
const MAX_OUTPUT_TOKENS = 1_000_000
const MAX_FUNCTION_TOOLS = 32
const MAX_FUNCTION_TOOL_CALLS = 32
const MAX_FUNCTION_NAME_LENGTH = 128
const MAX_FUNCTION_DESCRIPTION_CHARACTERS = 4 * 1024
const MAX_FUNCTION_SCHEMA_BYTES = 128 * 1024
const MAX_FUNCTION_ARGUMENT_BYTES = 256 * 1024
const MAX_TOTAL_FUNCTION_ARGUMENT_BYTES = 2 * 1024 * 1024
const MAX_FUNCTION_OUTPUT_CHARACTERS = 512 * 1024
const MAX_CALL_ID_LENGTH = 256
const MAX_THOUGHT_SIGNATURE_CHARACTERS = 512 * 1024
const MAX_JSON_DEPTH = 16
const MAX_JSON_NODES = 20_000
const MAX_JSON_KEY_LENGTH = 128
const MAX_JSON_STRING_CHARACTERS = 256 * 1024
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const GENERATED_CALL_ID_PREFIX = 'gemini_call_'
const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant'])
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const GEMINI_SCHEMA_KEYS = new Set([
  'anyOf',
  'default',
  'description',
  'enum',
  'example',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'nullable',
  'pattern',
  'properties',
  'propertyOrdering',
  'required',
  'title',
  'type'
])
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const FILE_MIME_TYPES = new Set([
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

/**
 * Default to Google's native v1beta path.  NewAPI deployments commonly use a
 * `/v1` API root, so that suffix is replaced by `/v1beta` rather than blindly
 * producing `/v1/v1beta`.  A relay-provided `path` always wins.
 */
export function normalizeGeminiContentBaseUrl(value: unknown): string {
  try {
    return normalizeNativeBaseUrl(value)
  } catch {
    throw new GeminiContentClientError('invalid_endpoint')
  }
}

export function normalizeGeminiContentPath(value: unknown): string {
  try {
    const path = normalizeNativePath(value, true)
    const question = path.indexOf('?')
    if (question >= 0 && path.slice(question + 1) !== 'alt=sse') throw new Error('invalid_endpoint')
    return path
  } catch {
    throw new GeminiContentClientError('invalid_endpoint')
  }
}

export function defaultGeminiContentPath(baseUrl: string, model: string): string {
  const encodedModel = encodeURIComponent(model)
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/u, '')
  const template = `/v1beta/models/${encodedModel}:streamGenerateContent?alt=sse`
  if (pathname.endsWith('/v1beta')) return `/models/${encodedModel}:streamGenerateContent?alt=sse`
  // NewAPI's documented root is /v1; native Gemini is exposed at /v1beta.
  if (pathname.endsWith('/v1')) return template
  return template
}

export function buildGeminiContentRequestUrl(
  baseUrl: unknown,
  model: unknown,
  endpointPath?: unknown
): string {
  try {
    const normalizedBaseUrl = normalizeGeminiContentBaseUrl(baseUrl)
    if (
      typeof model !== 'string' ||
      model.length < 1 ||
      model.length > MAX_MODEL_LENGTH ||
      !MODEL_PATTERN.test(model)
    ) throw new Error('invalid_endpoint')
    const path = endpointPath === undefined
      ? defaultGeminiContentPath(normalizedBaseUrl, model)
      : endpointPath
    return joinGeminiEndpoint(
      normalizedBaseUrl,
      toStreamingGeminiContentPath(path, model)
    )
  } catch (error) {
    if (error instanceof GeminiContentClientError) throw error
    throw new GeminiContentClientError('invalid_endpoint')
  }
}

export class GeminiContentClient {
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxEventBytes: number
  readonly #maxOutputTextBytes: number
  readonly #path?: string

  constructor(options: GeminiContentClientOptions = {}) {
    const candidate: unknown = options
    if (!hasOnlyKeys(candidate, [
      'fetcher',
      'timeoutMs',
      'maxResponseBytes',
      'maxEventBytes',
      'maxOutputTextBytes',
      'path',
      'endpointPath'
    ])) throw new GeminiContentClientError('invalid_configuration')
    if (candidate.fetcher !== undefined && typeof candidate.fetcher !== 'function') {
      throw new GeminiContentClientError('invalid_configuration')
    }
    try {
      this.#timeoutMs = configurationInteger(candidate.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 10 * 60_000)
      this.#maxResponseBytes = configurationInteger(candidate.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 256, MAX_RESPONSE_BYTES)
      this.#maxEventBytes = configurationInteger(candidate.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 64, MAX_EVENT_BYTES)
      this.#maxOutputTextBytes = configurationInteger(candidate.maxOutputTextBytes, DEFAULT_MAX_OUTPUT_TEXT_BYTES, 64, MAX_OUTPUT_TEXT_BYTES)
      if (this.#maxEventBytes > this.#maxResponseBytes || this.#maxOutputTextBytes > this.#maxResponseBytes) {
        throw new GeminiContentClientError('invalid_configuration')
      }
      if (candidate.path !== undefined && candidate.endpointPath !== undefined && candidate.path !== candidate.endpointPath) {
        throw new GeminiContentClientError('invalid_configuration')
      }
      const path = candidate.path ?? candidate.endpointPath
      this.#path = path === undefined ? undefined : normalizeGeminiContentPath(path)
    } catch (error) {
      if (error instanceof GeminiContentClientError) throw error
      throw new GeminiContentClientError('invalid_configuration')
    }
    this.#fetcher = (candidate.fetcher as typeof fetch | undefined) ?? globalThis.fetch
    if (typeof this.#fetcher !== 'function') throw new GeminiContentClientError('invalid_configuration')
  }

  async stream(
    credentials: GeminiContentCredentials,
    request: GeminiContentStreamRequest,
    options: GeminiContentStreamOptions = {}
  ): Promise<GeminiContentStreamResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequest(request)
    const normalizedOptions = normalizeStreamOptions(options)
    const requestBody = serializeRequest(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new GeminiContentClientError('invalid_input')
    }
    if (normalizedOptions.signal?.aborted) throw new GeminiContentClientError('cancelled')

    const requestUrl = buildGeminiContentRequestUrl(
      normalizedCredentials.baseUrl,
      normalizedRequest.model,
      normalizedRequest.endpointPath ?? this.#path
    )
    if (containsSensitiveCredential(requestUrl, [normalizedCredentials.apiKey])) {
      throw new GeminiContentClientError('invalid_endpoint')
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
          // Google-native GenerateContent uses this header.  The relay still
          // authenticates the Bearer token above; sending both keeps direct
          // Gemini and NewAPI-compatible routes on the same adapter.
          'x-goog-api-key': normalizedCredentials.apiKey
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (response.status >= 300 && response.status < 400) {
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('remote_rejected', retryable, remoteFailure)
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > this.#maxResponseBytes) {
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('remote_rejected', false, 'gemini_generate_content_unsupported')
      }

      let responseId: string | null = null
      let outputText = ''
      let outputBytes = 0
      let sawPayload = false
      let completed = false
      await consumeNativeSse(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        requireCompletion: false,
        onEvent: async (event) => {
          if (completed) throw new GeminiContentClientError('invalid_response')
          if (event.data === '[DONE]') {
            completed = true
            return true
          }
          if (event.data.length > this.#maxEventBytes) throw new GeminiContentClientError('event_too_large')
          let payload: unknown
          try {
            payload = JSON.parse(event.data)
          } catch {
            throw new GeminiContentClientError('invalid_response')
          }
          if (!isPlainRecord(payload)) throw new GeminiContentClientError('invalid_response')
          sawPayload = true
          if (event.event === 'error' || event.event === 'ERROR') throw new GeminiContentClientError('remote_error')
          if (Object.hasOwn(payload, 'error')) throw new GeminiContentClientError('remote_error')
          const id = normalizeResponseId(payload.responseId ?? payload.response_id ?? payload.id)
          if (id !== null) responseId = assertSameResponseId(responseId, id)
          if (payload.candidates === undefined) {
            if (payload.usageMetadata !== undefined || payload.promptFeedback !== undefined) return false
            throw new GeminiContentClientError('invalid_response')
          }
          if (!Array.isArray(payload.candidates)) throw new GeminiContentClientError('invalid_response')
          for (const [candidatePosition, candidate] of payload.candidates.entries()) {
            if (!isPlainRecord(candidate)) throw new GeminiContentClientError('invalid_response')
            const candidateIndex = candidate.index === undefined ? candidatePosition : candidate.index
            if (typeof candidateIndex !== 'number' || !Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
              throw new GeminiContentClientError('invalid_response')
            }
            // The shared turn contract represents one assistant stream.  Do
            // not concatenate alternate candidates into that single answer.
            if (candidateIndex !== 0) continue
            if (candidate.content === undefined) continue
            if (!isPlainRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
              throw new GeminiContentClientError('invalid_response')
            }
            for (const part of candidate.content.parts) {
              if (!isPlainRecord(part)) throw new GeminiContentClientError('invalid_response')
              if (part.thought !== undefined && typeof part.thought !== 'boolean') {
                throw new GeminiContentClientError('invalid_response')
              }
              if (part.thought === true) continue
              if (part.text === undefined) continue
              if (typeof part.text !== 'string' || part.text.includes('\0')) throw new GeminiContentClientError('invalid_response')
              if (part.text.length < 1) continue
              if (containsSensitiveCredential(part.text, [normalizedCredentials.apiKey])) {
                throw new GeminiContentClientError('invalid_response')
              }
              outputBytes += Buffer.byteLength(part.text, 'utf8')
              if (outputBytes > this.#maxOutputTextBytes) throw new GeminiContentClientError('response_too_large')
              outputText += part.text
              await deliverEvent(normalizedOptions.onEvent, { type: 'response.output_text.delta', delta: part.text })
            }
          }
          return false
        }
      })
      if (!sawPayload) throw new GeminiContentClientError('invalid_response')
      return { responseId, outputText }
    } catch (error) {
      if (normalizedOptions.signal?.aborted) throw new GeminiContentClientError('cancelled')
      if (timedOut) throw new GeminiContentClientError('timeout')
      if (error instanceof GeminiContentClientError) throw error
      if (error instanceof NativeSseProtocolError) throw new GeminiContentClientError(error.code)
      throw new GeminiContentClientError('network_error')
    } finally {
      clearTimeout(timeout)
      normalizedOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  /**
   * Stream native GenerateContent with client-side function declarations.
   * Gemini wire parts are normalized to the same tool-call shape used by the
   * Agent loop, while Gemini-only thought signatures remain replayable.
   */
  async streamWithTools(
    credentials: GeminiContentCredentials,
    request: GeminiContentStreamWithToolsRequest,
    options: GeminiContentStreamWithToolsOptions = {}
  ): Promise<GeminiContentStreamWithToolsResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequestWithTools(request)
    const normalizedOptions = normalizeStreamOptions(options)
    const requestBody = serializeRequestWithTools(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new GeminiContentClientError('invalid_input')
    }
    if (normalizedOptions.signal?.aborted) throw new GeminiContentClientError('cancelled')

    const requestUrl = buildGeminiContentRequestUrl(
      normalizedCredentials.baseUrl,
      normalizedRequest.model,
      normalizedRequest.endpointPath ?? this.#path
    )
    if (containsSensitiveCredential(requestUrl, [normalizedCredentials.apiKey])) {
      throw new GeminiContentClientError('invalid_endpoint')
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
          'x-goog-api-key': normalizedCredentials.apiKey
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (response.status >= 300 && response.status < 400) {
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('remote_rejected', retryable, remoteFailure)
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > this.#maxResponseBytes) {
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardNativeResponseBody(response)
        throw new GeminiContentClientError('remote_rejected', false, 'gemini_generate_content_unsupported')
      }

      return await consumeGeminiToolResponseStream(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        maxOutputTextBytes: this.#maxOutputTextBytes,
        explicitSecrets: [normalizedCredentials.apiKey],
        allowedToolNames: new Set(normalizedRequest.tools.map((tool) => tool.name)),
        onEvent: normalizedOptions.onEvent
      })
    } catch (error) {
      if (normalizedOptions.signal?.aborted) throw new GeminiContentClientError('cancelled')
      if (timedOut) throw new GeminiContentClientError('timeout')
      if (error instanceof GeminiContentClientError) throw error
      if (error instanceof NativeSseProtocolError) throw new GeminiContentClientError(error.code)
      throw new GeminiContentClientError('network_error')
    } finally {
      clearTimeout(timeout)
      normalizedOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

export const OpenAICompatibleGeminiContentClient = GeminiContentClient

interface NormalizedRequest {
  model: string
  contents: GeminiContent[]
  endpointPath?: string
  systemInstruction?: GeminiSystemInstruction
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  reasoning?: ReasoningEffort
  reasoningProtocol?: GeminiReasoningProtocol
}

interface NormalizedRequestWithTools extends NormalizedRequest {
  tools: NormalizedGeminiFunctionDeclaration[]
}

interface NormalizedGeminiFunctionDeclaration {
  name: string
  description?: string
  parameters: ResponsesJsonObject
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiSystemInstruction {
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | {
      functionCall: {
        id?: string
        name: string
        args: ResponsesJsonObject
      }
      thoughtSignature?: string
    }
  | {
      functionResponse: {
        id?: string
        name: string
        response: { output: string }
      }
    }

function normalizeCredentials(value: unknown): GeminiContentCredentials {
  try {
    if (!hasExactKeys(value, ['baseUrl', 'apiKey'])) throw new GeminiContentClientError('invalid_credential')
    const baseUrl = normalizeGeminiContentBaseUrl(value.baseUrl)
    if (
      typeof value.apiKey !== 'string' ||
      value.apiKey.length < 1 ||
      value.apiKey.length > MAX_API_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(value.apiKey)
    ) throw new GeminiContentClientError('invalid_credential')
    return { baseUrl, apiKey: value.apiKey }
  } catch (error) {
    if (error instanceof GeminiContentClientError) throw error
    throw new GeminiContentClientError('invalid_credential')
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
      'temperature',
      'topP',
      'top_p',
      'topK',
      'top_k',
      'maxOutputTokens',
      'max_output_tokens'
    ])) invalidInput()
    if (typeof value.model !== 'string' || value.model.length < 1 || value.model.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(value.model)) invalidInput()
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) invalidInput()
    const endpointPath = value.endpointPath === undefined
      ? undefined
      : normalizeGeminiContentPath(value.endpointPath)

    const systemParts: GeminiPart[] = []
    for (const item of [value.system, value.instructions]) {
      if (item === undefined) continue
      if (typeof item !== 'string' || item.length < 1 || item.length > MAX_INSTRUCTIONS_CHARACTERS || item.includes('\0')) invalidInput()
      systemParts.push({ text: item })
    }
    const contents: GeminiContent[] = []
    for (const messageValue of value.messages) {
      if (!hasExactKeys(messageValue, ['role', 'content'])) invalidInput()
      if (typeof messageValue.role !== 'string' || !MESSAGE_ROLES.has(messageValue.role)) invalidInput()
      const role = messageValue.role as ResponsesMessage['role']
      const parts = normalizeContent(messageValue.content)
      if (role === 'system' || role === 'developer') systemParts.push(...parts)
      else contents.push({ role: role === 'assistant' ? 'model' : 'user', parts })
    }
    if (contents.length < 1) invalidInput()
    const temperature = normalizeOptionalNumber(value.temperature, 0, MAX_TEMPERATURE)
    const topP = normalizeAliasedNumber(value.topP, value.top_p, 0, MAX_TOP_P)
    const topK = normalizeAliasedInteger(value.topK, value.top_k, 0, MAX_TOP_K)
    const maxOutputTokens = normalizeAliasedInteger(value.maxOutputTokens, value.max_output_tokens, 0, MAX_OUTPUT_TOKENS)
    if (value.reasoning !== undefined && !isReasoningEffort(value.reasoning)) invalidInput()
    const reasoningProtocol = normalizeGeminiReasoningProtocol(value.reasoningProtocol)
    assertGeminiReasoningCompatible(value.reasoning, reasoningProtocol)
    const inputBytes = Buffer.byteLength(JSON.stringify({ contents, systemInstruction: systemParts }), 'utf8')
    if (inputBytes > MAX_INPUT_BYTES) invalidInput()
    return {
      model: value.model,
      contents,
      ...(endpointPath === undefined ? {} : { endpointPath }),
      ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(topK === undefined ? {} : { topK }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
      ...(reasoningProtocol === undefined ? {} : { reasoningProtocol })
    }
  } catch (error) {
    if (error instanceof GeminiContentClientError) throw error
    throw new GeminiContentClientError('invalid_input')
  }
}

function normalizeRequestWithTools(value: unknown): NormalizedRequestWithTools {
  try {
    if (!hasOnlyKeys(value, [
      'model',
      'messages',
      'tools',
      'endpointPath',
      'instructions',
      'reasoning',
      'reasoningProtocol',
      'temperature',
      'topP',
      'top_p',
      'topK',
      'top_k',
      'maxOutputTokens',
      'max_output_tokens'
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

    const tools = normalizeGeminiFunctionTools(value.tools)
    const allowedToolNames = new Set(tools.map((tool) => tool.name))
    const endpointPath = value.endpointPath === undefined
      ? undefined
      : normalizeGeminiContentPath(value.endpointPath)
    const systemParts: GeminiPart[] = []
    if (value.instructions !== undefined) {
      if (
        typeof value.instructions !== 'string' ||
        value.instructions.length < 1 ||
        value.instructions.length > MAX_INSTRUCTIONS_CHARACTERS ||
        value.instructions.includes('\0')
      ) invalidInput()
      systemParts.push({ text: value.instructions })
    }

    const contents: GeminiContent[] = []
    const pendingCalls = new Map<string, { name: string; wireId?: string }>()
    const seenCallIds = new Set<string>()
    let historicalCallCount = 0
    let previousWasToolResult = false

    for (const messageValue of value.messages) {
      if (!isPlainRecord(messageValue) || typeof messageValue.role !== 'string') invalidInput()

      if (messageValue.role === 'tool') {
        if (!hasExactKeys(messageValue, ['role', 'tool_call_id', 'name', 'content'])) invalidInput()
        const callId = normalizeCallId(messageValue.tool_call_id, 'invalid_input')
        const name = normalizeFunctionName(messageValue.name, 'invalid_input')
        const pendingCall = pendingCalls.get(callId)
        if (!allowedToolNames.has(name) || pendingCall?.name !== name) invalidInput()
        if (
          typeof messageValue.content !== 'string' ||
          messageValue.content.length > MAX_FUNCTION_OUTPUT_CHARACTERS ||
          messageValue.content.includes('\0')
        ) invalidInput()
        pendingCalls.delete(callId)
        const resultPart: GeminiPart = {
          functionResponse: {
            name,
            response: { output: messageValue.content },
            ...(pendingCall.wireId === undefined ? {} : { id: pendingCall.wireId })
          }
        }
        const previous = contents.at(-1)
        if (previousWasToolResult && previous?.role === 'user') previous.parts.push(resultPart)
        else contents.push({ role: 'user', parts: [resultPart] })
        previousWasToolResult = true
        continue
      }

      if (messageValue.role === 'assistant' && Object.hasOwn(messageValue, 'tool_calls')) {
        if (!hasOnlyKeys(messageValue, ['role', 'content', 'tool_calls', 'assistantContent'])) invalidInput()
        if (pendingCalls.size > 0) invalidInput()
        if (
          typeof messageValue.content !== 'string' ||
          messageValue.content.length > MAX_MESSAGE_CHARACTERS ||
          messageValue.content.includes('\0') ||
          !Array.isArray(messageValue.tool_calls) ||
          messageValue.tool_calls.length < 1 ||
          messageValue.tool_calls.length > MAX_FUNCTION_TOOL_CALLS
        ) invalidInput()
        historicalCallCount += messageValue.tool_calls.length
        if (historicalCallCount > MAX_FUNCTION_TOOL_CALLS) invalidInput()

        const calls: Array<{
          id: string
          name: string
          arguments: ResponsesJsonObject
          thoughtSignature?: string
        }> = []
        for (const callValue of messageValue.tool_calls) {
          const call = normalizeHistoricalToolCall(callValue, allowedToolNames)
          if (seenCallIds.has(call.id)) invalidInput()
          seenCallIds.add(call.id)
          calls.push(call)
          const wireId = isGeneratedToolCallId(call.id) ? undefined : call.id
          pendingCalls.set(call.id, {
            name: call.name,
            ...(wireId === undefined ? {} : { wireId })
          })
        }
        const parts = messageValue.assistantContent === undefined
          ? defaultAssistantToolParts(messageValue.content, calls)
          : normalizeAssistantToolParts(messageValue.assistantContent, messageValue.content, calls)
        contents.push({ role: 'model', parts })
        previousWasToolResult = false
        continue
      }

      if (pendingCalls.size > 0 || !hasExactKeys(messageValue, ['role', 'content'])) invalidInput()
      if (!MESSAGE_ROLES.has(messageValue.role)) invalidInput()
      const role = messageValue.role as ResponsesMessage['role']
      const parts = normalizeContent(messageValue.content)
      if (role === 'system' || role === 'developer') systemParts.push(...parts)
      else contents.push({ role: role === 'assistant' ? 'model' : 'user', parts })
      previousWasToolResult = false
    }

    if (pendingCalls.size > 0 || contents.length < 1) invalidInput()
    const temperature = normalizeOptionalNumber(value.temperature, 0, MAX_TEMPERATURE)
    const topP = normalizeAliasedNumber(value.topP, value.top_p, 0, MAX_TOP_P)
    const topK = normalizeAliasedInteger(value.topK, value.top_k, 0, MAX_TOP_K)
    const maxOutputTokens = normalizeAliasedInteger(
      value.maxOutputTokens,
      value.max_output_tokens,
      0,
      MAX_OUTPUT_TOKENS
    )
    if (value.reasoning !== undefined && !isReasoningEffort(value.reasoning)) invalidInput()
    const reasoningProtocol = normalizeGeminiReasoningProtocol(value.reasoningProtocol)
    assertGeminiReasoningCompatible(value.reasoning, reasoningProtocol)

    const inputBytes = Buffer.byteLength(JSON.stringify({
      contents,
      systemInstruction: systemParts,
      tools
    }), 'utf8')
    if (inputBytes > MAX_INPUT_BYTES) invalidInput()
    return {
      model: value.model,
      contents,
      tools,
      ...(endpointPath === undefined ? {} : { endpointPath }),
      ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(topK === undefined ? {} : { topK }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
      ...(reasoningProtocol === undefined ? {} : { reasoningProtocol })
    }
  } catch (error) {
    if (error instanceof GeminiContentClientError) throw error
    throw new GeminiContentClientError('invalid_input')
  }
}

function normalizeGeminiFunctionTools(value: unknown): NormalizedGeminiFunctionDeclaration[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FUNCTION_TOOLS) invalidInput()
  const names = new Set<string>()
  return value.map((toolValue) => {
    if (
      !hasExactKeys(toolValue, ['type', 'function']) ||
      toolValue.type !== 'function' ||
      !hasOnlyKeys(toolValue.function, ['name', 'description', 'parameters']) ||
      !Object.hasOwn(toolValue.function, 'name')
    ) invalidInput()
    const name = normalizeFunctionName(toolValue.function.name, 'invalid_input')
    if (names.has(name)) invalidInput()
    names.add(name)
    let description: string | undefined
    if (toolValue.function.description !== undefined) {
      if (
        typeof toolValue.function.description !== 'string' ||
        toolValue.function.description.length < 1 ||
        toolValue.function.description.length > MAX_FUNCTION_DESCRIPTION_CHARACTERS ||
        toolValue.function.description.includes('\0')
      ) invalidInput()
      description = toolValue.function.description
    }
    const parameters = projectGeminiSchema(normalizeBoundedJsonObject(
      toolValue.function.parameters ?? { type: 'object', properties: {} },
      'invalid_input',
      MAX_FUNCTION_SCHEMA_BYTES
    ))
    if (parameters.type !== 'object') invalidInput()
    return {
      name,
      ...(description === undefined ? {} : { description }),
      parameters
    }
  })
}

function normalizeHistoricalToolCall(
  value: unknown,
  allowedToolNames: ReadonlySet<string>
): { id: string; name: string; arguments: ResponsesJsonObject; thoughtSignature?: string } {
  if (
    !hasOnlyKeys(value, ['id', 'type', 'function', 'thoughtSignature']) ||
    !Object.hasOwn(value, 'id') ||
    !Object.hasOwn(value, 'type') ||
    !Object.hasOwn(value, 'function') ||
    value.type !== 'function' ||
    !hasExactKeys(value.function, ['name', 'arguments'])
  ) invalidInput()
  const id = normalizeCallId(value.id, 'invalid_input')
  const name = normalizeFunctionName(value.function.name, 'invalid_input')
  if (!allowedToolNames.has(name) || typeof value.function.arguments !== 'string') invalidInput()
  let parsedArguments: unknown
  try {
    parsedArguments = JSON.parse(value.function.arguments)
  } catch {
    invalidInput()
  }
  const args = normalizeBoundedJsonObject(parsedArguments, 'invalid_input', MAX_FUNCTION_ARGUMENT_BYTES)
  const thoughtSignature = normalizeThoughtSignature(value.thoughtSignature, 'invalid_input')
  return {
    id,
    name,
    arguments: args,
    ...(thoughtSignature === undefined ? {} : { thoughtSignature })
  }
}

type NormalizedHistoricalToolCall = ReturnType<typeof normalizeHistoricalToolCall>

/**
 * Builds the legacy model history shape used when no private native parts
 * were returned by Gemini.  Keeping this path stable avoids adding private
 * reasoning fields to ordinary requests.
 */
function defaultAssistantToolParts(
  content: string,
  calls: readonly NormalizedHistoricalToolCall[]
): GeminiPart[] {
  const parts: GeminiPart[] = []
  if (content.length > 0) parts.push({ text: content })
  for (const call of calls) {
    const wireId = isGeneratedToolCallId(call.id) ? undefined : call.id
    parts.push({
      functionCall: {
        name: call.name,
        args: call.arguments,
        ...(wireId === undefined ? {} : { id: wireId })
      },
      ...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature })
    })
  }
  return parts
}

/**
 * Validates and converts the private assistant parts captured from a native
 * Gemini response.  The visible text must still agree with `content`, while
 * thought text/signatures remain confined to the Main-process request body.
 */
function normalizeAssistantToolParts(
  value: unknown,
  content: string,
  calls: readonly NormalizedHistoricalToolCall[]
): GeminiPart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FUNCTION_TOOL_CALLS * 3) invalidInput()
  const callsById = new Map(calls.map((call) => [call.id, call]))
  const seenCallIds = new Set<string>()
  const parts: GeminiPart[] = []
  let visibleText = ''

  for (const partValue of value) {
    if (!isPlainRecord(partValue) || typeof partValue.type !== 'string') invalidInput()
    if (partValue.type === 'text' || partValue.type === 'thought') {
      if (!hasOnlyKeys(partValue, ['type', 'text', 'thoughtSignature']) || typeof partValue.text !== 'string') {
        invalidInput()
      }
      if (
        partValue.text.length > MAX_MESSAGE_CHARACTERS ||
        partValue.text.includes('\0')
      ) invalidInput()
      const thoughtSignature = normalizeThoughtSignature(partValue.thoughtSignature, 'invalid_input')
      if (partValue.type === 'thought') {
        if (partValue.text.length > 0) {
          visibleText += ''
        }
        parts.push({
          text: partValue.text,
          thought: true,
          ...(thoughtSignature === undefined ? {} : { thoughtSignature })
        })
      } else {
        visibleText += partValue.text
        parts.push({
          text: partValue.text,
          ...(thoughtSignature === undefined ? {} : { thoughtSignature })
        })
      }
      continue
    }
    if (partValue.type !== 'function_call' || !hasExactKeys(partValue, ['type', 'toolCall'])) invalidInput()
    const call = normalizeHistoricalToolCall(partValue.toolCall, new Set(calls.map((item) => item.name)))
    const expected = callsById.get(call.id)
    if (
      expected === undefined ||
      seenCallIds.has(call.id) ||
      expected.name !== call.name ||
      canonicalJson(expected.arguments) !== canonicalJson(call.arguments) ||
      expected.thoughtSignature !== call.thoughtSignature
    ) invalidInput()
    seenCallIds.add(call.id)
    const wireId = isGeneratedToolCallId(call.id) ? undefined : call.id
    parts.push({
      functionCall: {
        name: call.name,
        args: call.arguments,
        ...(wireId === undefined ? {} : { id: wireId })
      },
      ...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature })
    })
  }

  if (visibleText !== content || seenCallIds.size !== calls.length) invalidInput()
  return parts
}

function toStreamingGeminiContentPath(value: unknown, model: string): string {
  let path = normalizeGeminiContentPath(value)
    .replaceAll('{model}', encodeURIComponent(model))
  path = normalizeGeminiContentPath(path)
  const question = path.indexOf('?')
  let pathname = question < 0 ? path : path.slice(0, question)
  const query = question < 0 ? '' : path.slice(question + 1)
  if (pathname.endsWith(':generateContent')) {
    pathname = `${pathname.slice(0, -':generateContent'.length)}:streamGenerateContent`
  }
  if (pathname.endsWith(':streamGenerateContent')) {
    return normalizeGeminiContentPath(`${pathname}?alt=sse`)
  }
  return normalizeGeminiContentPath(query ? `${pathname}?${query}` : pathname)
}

function normalizeContent(value: unknown): GeminiPart[] {
  if (typeof value === 'string') {
    if (value.length < 1 || value.length > MAX_MESSAGE_CHARACTERS || value.includes('\0')) invalidInput()
    return [{ text: value }]
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 17) invalidInput()
  return value.map((part) => normalizePart(part))
}

function normalizePart(value: unknown): GeminiPart {
  if (!isPlainRecord(value) || typeof value.type !== 'string') invalidInput()
  if (value.type === 'input_text') {
    if (!hasExactKeys(value, ['type', 'text']) || typeof value.text !== 'string') invalidInput()
    if (value.text.length < 1 || value.text.length > MAX_MESSAGE_CHARACTERS || value.text.includes('\0')) invalidInput()
    return { text: value.text }
  }
  if (value.type === 'input_image') {
    if (!hasOnlyKeys(value, ['type', 'image_url', 'detail']) || typeof value.image_url !== 'string') invalidInput()
    const source = parseDataUrl(value.image_url, IMAGE_MIME_TYPES)
    if (value.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(String(value.detail))) invalidInput()
    return { inlineData: { mimeType: source.mimeType, data: source.base64 } }
  }
  if (value.type === 'input_file') {
    if (!hasOnlyKeys(value, ['type', 'filename', 'file_data', 'detail']) ||
      typeof value.filename !== 'string' || !ATTACHMENT_NAME_PATTERN.test(value.filename) || typeof value.file_data !== 'string') invalidInput()
    const source = parseDataUrl(value.file_data, FILE_MIME_TYPES)
    if (value.detail !== undefined && !['auto', 'low', 'high'].includes(String(value.detail))) invalidInput()
    return { inlineData: { mimeType: source.mimeType, data: source.base64 } }
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
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function normalizeGeminiReasoningProtocol(
  value: unknown
): GeminiReasoningProtocol | undefined {
  if (value === undefined) return undefined
  if (
    !isModelReasoningProtocol(value) ||
    (value.type !== 'gemini-level' && value.type !== 'gemini-budget')
  ) {
    invalidInput()
  }
  return cloneModelReasoningProtocol(value) as GeminiReasoningProtocol
}

function assertGeminiReasoningCompatible(
  effort: ReasoningEffort | undefined,
  protocol: GeminiReasoningProtocol | undefined
): void {
  if (effort === undefined || effort === 'auto' || protocol === undefined) return
  if (protocol.type === 'gemini-level') {
    if (!isReasoningEffortRepresentable(effort, 'gemini-level')) invalidInput()
    return
  }
  if (reasoningBudgetForEffort(protocol, effort) === undefined) invalidInput()
}

function geminiThinkingConfig(
  request: Pick<NormalizedRequest, 'reasoning' | 'reasoningProtocol'>
): Record<string, unknown> | undefined {
  if (
    request.reasoning === undefined ||
    request.reasoning === 'auto' ||
    request.reasoningProtocol === undefined
  ) {
    return undefined
  }
  const includeThoughts = request.reasoningProtocol.includeThoughts
  if (request.reasoningProtocol.type === 'gemini-level') {
    const thinkingLevel = mapReasoningEffortForWire(request.reasoning, 'gemini-level')
    if (thinkingLevel === undefined) invalidInput()
    return {
      thinkingLevel,
      ...(includeThoughts === undefined ? {} : { includeThoughts })
    }
  }
  const thinkingBudget = reasoningBudgetForEffort(
    request.reasoningProtocol,
    request.reasoning
  )
  if (thinkingBudget === undefined) invalidInput()
  return {
    thinkingBudget,
    ...(includeThoughts === undefined ? {} : { includeThoughts })
  }
}

function serializeRequest(request: NormalizedRequest): string {
  const thinkingConfig = geminiThinkingConfig(request)
  const generationConfig = {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.topK === undefined ? {} : { topK: request.topK }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(thinkingConfig === undefined ? {} : { thinkingConfig })
  }
  const body = JSON.stringify({
    contents: request.contents,
    ...(request.systemInstruction === undefined ? {} : { systemInstruction: request.systemInstruction }),
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig })
  })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) throw new GeminiContentClientError('invalid_input')
  return body
}

function serializeRequestWithTools(request: NormalizedRequestWithTools): string {
  const thinkingConfig = geminiThinkingConfig(request)
  const generationConfig = {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.topK === undefined ? {} : { topK: request.topK }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(thinkingConfig === undefined ? {} : { thinkingConfig })
  }
  const body = JSON.stringify({
    contents: request.contents,
    ...(request.systemInstruction === undefined ? {} : { systemInstruction: request.systemInstruction }),
    tools: [{ functionDeclarations: request.tools }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig })
  })
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    throw new GeminiContentClientError('invalid_input')
  }
  return body
}

interface ConsumeGeminiToolResponseOptions {
  maxResponseBytes: number
  maxEventBytes: number
  maxOutputTextBytes: number
  explicitSecrets: readonly string[]
  allowedToolNames: ReadonlySet<string>
  onEvent?: GeminiContentStreamOptions['onEvent']
}

async function consumeGeminiToolResponseStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeGeminiToolResponseOptions
): Promise<GeminiContentStreamWithToolsResult> {
  let responseId: string | null = null
  let outputText = ''
  let outputBytes = 0
  let argumentBytes = 0
  let thoughtBytes = 0
  let sawPayload = false
  let completed = false
  const toolCalls: GeminiContentToolCall[] = []
  const callIds = new Set<string>()
  const assistantContent: GeminiContentAssistantContentPart[] = []
  let hasIndependentThought = false

  await consumeNativeSse(body, {
    maxResponseBytes: options.maxResponseBytes,
    maxEventBytes: options.maxEventBytes,
    requireCompletion: false,
    onEvent: async (event) => {
      if (completed) throw new GeminiContentClientError('invalid_response')
      if (event.data === '[DONE]') {
        completed = true
        return true
      }
      if (event.data.length > options.maxEventBytes) throw new GeminiContentClientError('event_too_large')
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        throw new GeminiContentClientError('invalid_response')
      }
      if (!isPlainRecord(payload)) throw new GeminiContentClientError('invalid_response')
      sawPayload = true
      if (event.event === 'error' || event.event === 'ERROR') {
        throw new GeminiContentClientError('remote_error')
      }
      if (Object.hasOwn(payload, 'error')) throw new GeminiContentClientError('remote_error')
      const id = normalizeResponseId(payload.responseId ?? payload.response_id ?? payload.id)
      if (id !== null) responseId = assertSameResponseId(responseId, id)
      if (payload.candidates === undefined) {
        if (payload.usageMetadata !== undefined || payload.promptFeedback !== undefined) return false
        throw new GeminiContentClientError('invalid_response')
      }
      if (!Array.isArray(payload.candidates)) throw new GeminiContentClientError('invalid_response')

      for (const [candidatePosition, candidate] of payload.candidates.entries()) {
        if (!isPlainRecord(candidate)) throw new GeminiContentClientError('invalid_response')
        const candidateIndex = candidate.index === undefined ? candidatePosition : candidate.index
        if (typeof candidateIndex !== 'number' || !Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
          throw new GeminiContentClientError('invalid_response')
        }
        if (candidateIndex !== 0 || candidate.content === undefined) continue
        if (!isPlainRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
          throw new GeminiContentClientError('invalid_response')
        }
        if (candidate.content.role !== undefined && candidate.content.role !== 'model') {
          throw new GeminiContentClientError('invalid_response')
        }

        for (const part of candidate.content.parts) {
          if (!isPlainRecord(part)) throw new GeminiContentClientError('invalid_response')
          if (part.thought !== undefined && typeof part.thought !== 'boolean') {
            throw new GeminiContentClientError('invalid_response')
          }
          const hasText = Object.hasOwn(part, 'text')
          const hasFunctionCall = Object.hasOwn(part, 'functionCall')
          if (hasText && hasFunctionCall) throw new GeminiContentClientError('invalid_response')
          if (
            Object.hasOwn(part, 'functionResponse') ||
            Object.hasOwn(part, 'executableCode') ||
            Object.hasOwn(part, 'codeExecutionResult') ||
            Object.hasOwn(part, 'toolCall') ||
            Object.hasOwn(part, 'toolResponse')
          ) throw new GeminiContentClientError('invalid_response')

          const thoughtSignature = normalizeThoughtSignature(part.thoughtSignature, 'invalid_response')
          if (
            thoughtSignature !== undefined &&
            containsSensitiveCredential(thoughtSignature, options.explicitSecrets)
          ) throw new GeminiContentClientError('invalid_response')
          if (part.thought === true) {
            if (hasFunctionCall) throw new GeminiContentClientError('invalid_response')
            if (hasText && typeof part.text !== 'string') {
              throw new GeminiContentClientError('invalid_response')
            }
            const thoughtText = hasText ? part.text as string : ''
            if (thoughtText.includes('\0')) throw new GeminiContentClientError('invalid_response')
            if (containsSensitiveCredential(thoughtText, options.explicitSecrets)) {
              throw new GeminiContentClientError('invalid_response')
            }
            thoughtBytes += Buffer.byteLength(thoughtText, 'utf8')
            if (thoughtBytes > MAX_TOTAL_FUNCTION_ARGUMENT_BYTES) {
              throw new GeminiContentClientError('response_too_large')
            }
            assistantContent.push({
              type: 'thought',
              text: thoughtText,
              ...(thoughtSignature === undefined ? {} : { thoughtSignature })
            })
            hasIndependentThought = true
            continue
          }

          if (hasText) {
            if (typeof part.text !== 'string' || part.text.includes('\0')) {
              throw new GeminiContentClientError('invalid_response')
            }
            if (part.text.length > 0) {
              if (containsSensitiveCredential(part.text, options.explicitSecrets)) {
                throw new GeminiContentClientError('invalid_response')
              }
              outputBytes += Buffer.byteLength(part.text, 'utf8')
              if (outputBytes > options.maxOutputTextBytes) {
                throw new GeminiContentClientError('response_too_large')
              }
              outputText += part.text
              await deliverEvent(options.onEvent, {
                type: 'response.output_text.delta',
                delta: part.text
              })
            }
            assistantContent.push({
              type: 'text',
              text: part.text,
              ...(thoughtSignature === undefined ? {} : { thoughtSignature })
            })
          }

          if (hasFunctionCall) {
            if (toolCalls.length >= MAX_FUNCTION_TOOL_CALLS) {
              throw new GeminiContentClientError('response_too_large')
            }
            const toolCall = normalizeRemoteFunctionCall(
              part.functionCall,
              thoughtSignature,
              options.allowedToolNames,
              callIds
            )
            argumentBytes += Buffer.byteLength(toolCall.function.arguments, 'utf8')
            if (argumentBytes > MAX_TOTAL_FUNCTION_ARGUMENT_BYTES) {
              throw new GeminiContentClientError('response_too_large')
            }
            if (containsSensitiveCredential(toolCall.function.arguments, options.explicitSecrets)) {
              throw new GeminiContentClientError('invalid_response')
            }
            callIds.add(toolCall.id)
            toolCalls.push(toolCall)
            assistantContent.push({ type: 'function_call', toolCall })
          }
        }
      }
      return false
    }
  })

  if (!sawPayload) throw new GeminiContentClientError('invalid_response')
  return {
    responseId,
    outputText,
    toolCalls,
    hasToolCalls: toolCalls.length > 0,
    ...(toolCalls.length > 0 && hasIndependentThought ? { assistantContent } : {})
  }
}

function normalizeRemoteFunctionCall(
  value: unknown,
  thoughtSignature: string | undefined,
  allowedToolNames: ReadonlySet<string>,
  existingCallIds: ReadonlySet<string>
): GeminiContentToolCall {
  if (
    !hasOnlyKeys(value, ['id', 'name', 'args']) ||
    !Object.hasOwn(value, 'name')
  ) throw new GeminiContentClientError('invalid_response')
  const name = normalizeFunctionName(value.name, 'invalid_response')
  if (!allowedToolNames.has(name)) throw new GeminiContentClientError('invalid_response')
  const args = normalizeBoundedJsonObject(
    value.args ?? {},
    'invalid_response',
    MAX_FUNCTION_ARGUMENT_BYTES
  )
  const id = value.id === undefined
    ? generateToolCallId(existingCallIds)
    : normalizeCallId(value.id, 'invalid_response')
  if (existingCallIds.has(id)) throw new GeminiContentClientError('invalid_response')
  return {
    id,
    type: 'function',
    function: { name, arguments: canonicalJson(args) },
    ...(thoughtSignature === undefined ? {} : { thoughtSignature })
  }
}

function generateToolCallId(existingCallIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `${GENERATED_CALL_ID_PREFIX}${randomBytes(18).toString('base64url')}`
    if (!existingCallIds.has(candidate)) return candidate
  }
  throw new GeminiContentClientError('invalid_response')
}

function joinGeminiEndpoint(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/u, '')
  // A native Gemini path is rooted at the origin's /v1beta namespace.  When
  // the caller supplied NewAPI's /v1 root, replace that namespace instead of
  // producing the invalid /v1/v1beta combination.
  if (basePath.endsWith('/v1') && path.startsWith('/v1beta/')) {
    const prefix = basePath.slice(0, -3)
    const question = path.indexOf('?')
    base.pathname = `${prefix}${question < 0 ? path : path.slice(0, question)}`
    base.search = question < 0 ? '' : `?${path.slice(question + 1)}`
    base.hash = ''
    return base.toString()
  }
  return joinNativeEndpoint(baseUrl, path)
}

function normalizeResponseId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_RESPONSE_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new GeminiContentClientError('invalid_response')
  }
  return value
}

function assertSameResponseId(previous: string | null, next: string): string {
  if (previous !== null && previous !== next) throw new GeminiContentClientError('invalid_response')
  return next
}

function normalizeStreamOptions(value: unknown): GeminiContentStreamOptions {
  if (!hasOnlyKeys(value, ['signal', 'onEvent'])) throw new GeminiContentClientError('invalid_configuration')
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw new GeminiContentClientError('invalid_configuration')
  if (value.onEvent !== undefined && typeof value.onEvent !== 'function') throw new GeminiContentClientError('invalid_configuration')
  return value as GeminiContentStreamOptions
}

async function deliverEvent(
  consumer: GeminiContentStreamOptions['onEvent'],
  event: GeminiContentStreamEvent
): Promise<void> {
  if (!consumer) return
  try {
    await consumer(event)
  } catch {
    throw new GeminiContentClientError('consumer_error')
  }
}

function normalizeAliasedInteger(camel: unknown, snake: unknown, minimum: number, maximum: number): number | undefined {
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

function classifyRemoteFailure(status: number): GeminiContentRemoteFailure {
  if (status === 401 || status === 403) return 'authorization'
  if (status === 405) return 'gemini_generate_content_unsupported'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'server_error'
  return 'request_rejected'
}

function isRemoteFailure(value: unknown): value is GeminiContentRemoteFailure {
  return value === 'authorization' ||
    value === 'gemini_generate_content_unsupported' ||
    value === 'rate_limited' ||
    value === 'server_error' ||
    value === 'request_rejected'
}

/** Project standard JSON Schema onto the fields accepted by Gemini Schema. */
function projectGeminiSchema(value: ResponsesJsonObject): ResponsesJsonObject {
  const projected: ResponsesJsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue
    if (key === 'properties') {
      if (!isPlainRecord(child)) invalidInput()
      const properties: ResponsesJsonObject = {}
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        if (!isPlainRecord(propertySchema)) invalidInput()
        properties[propertyName] = projectGeminiSchema(propertySchema as ResponsesJsonObject)
      }
      projected.properties = properties
      continue
    }
    if (key === 'items') {
      if (!isPlainRecord(child)) invalidInput()
      projected.items = projectGeminiSchema(child as ResponsesJsonObject)
      continue
    }
    if (key === 'anyOf') {
      if (!Array.isArray(child)) invalidInput()
      projected.anyOf = child.map((item) => {
        if (!isPlainRecord(item)) invalidInput()
        return projectGeminiSchema(item as ResponsesJsonObject)
      })
      continue
    }
    projected[key] = child
  }
  return projected
}

function isGeneratedToolCallId(value: string): boolean {
  return value.startsWith(GENERATED_CALL_ID_PREFIX) &&
    /^[A-Za-z0-9_-]{24}$/u.test(value.slice(GENERATED_CALL_ID_PREFIX.length))
}

function normalizeFunctionName(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_FUNCTION_NAME_LENGTH ||
    !FUNCTION_NAME_PATTERN.test(value)
  ) throw new GeminiContentClientError(errorCode)
  return value
}

function normalizeCallId(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_CALL_ID_LENGTH ||
    !CALL_ID_PATTERN.test(value)
  ) throw new GeminiContentClientError(errorCode)
  return value
}

function normalizeThoughtSignature(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_THOUGHT_SIGNATURE_CHARACTERS ||
    /[^\x20-\x7e]/u.test(value)
  ) throw new GeminiContentClientError(errorCode)
  return value
}

function normalizeBoundedJsonObject(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response',
  maxBytes: number
): ResponsesJsonObject {
  const budget = { nodes: 0 }
  const fail = (oversized = false): never => {
    if (oversized && errorCode === 'invalid_response') {
      throw new GeminiContentClientError('response_too_large')
    }
    throw new GeminiContentClientError(errorCode)
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

function canonicalJson(value: ResponsesJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`
}

function invalidInput(): never {
  throw new GeminiContentClientError('invalid_input')
}
