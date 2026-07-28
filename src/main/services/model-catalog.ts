import type {
  ModelCapabilities,
  ModelDescriptor,
  ModelEndpointTransport,
  ModelEndpointType,
  ModelReasoningProtocol,
  ModelWireMode,
  ReasoningEffort,
  WorkspaceMode
} from '../../shared/contracts.ts'
import {
  isModelEndpointType,
  isValidModelId,
  MODEL_CONVERSATION_ENDPOINT_TYPES,
  modelEndpointTransport,
  preferredModelEndpoint
} from '../../shared/contracts.ts'
import {
  cloneModelReasoningProtocol,
  isModelReasoningProtocol,
  isReasoningEffortRepresentable,
  reasoningProtocolForEndpoint,
  type ReasoningWireTarget
} from './reasoning-protocol.ts'

const MAX_ENDPOINT_LENGTH = 2_048
const MAX_API_KEY_LENGTH = 32_768
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_MODEL_ROWS = 2_048
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ENDPOINT_TYPES = 32
const MAX_ENDPOINT_TYPE_LENGTH = 64
const MAX_REASONING_LEVELS = 32
const UNVERIFIED_REASONING: readonly ReasoningEffort[] = Object.freeze([
  'auto'
])
type CatalogErrorCode =
  | 'invalid_endpoint'
  | 'invalid_credential'
  | 'network_error'
  | 'timeout'
  | 'remote_rejected'
  | 'response_too_large'
  | 'invalid_response'

export class ModelCatalogError extends Error {
  readonly code: CatalogErrorCode
  readonly retryable: boolean

  constructor(code: CatalogErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ModelCatalogError'
    this.code = code
    this.retryable = retryable
  }
}

export interface ModelCatalogCredentials {
  baseUrl: string
  apiKey: string
}

export interface ModelCatalogOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
}

export class RemoteModelCatalogService {
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(options: ModelCatalogOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000)
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES
    )
  }

  async list(
    credentials: ModelCatalogCredentials,
    mode: WorkspaceMode
  ): Promise<ModelDescriptor[]> {
    const baseUrl = normalizeModelEndpoint(credentials.baseUrl)
    const apiKey = validateApiKey(credentials.apiKey)
    const requestUrl = `${baseUrl}/models`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()

    try {
      const response = await this.fetcher(requestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        redirect: 'manual',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new ModelCatalogError(
          'remote_rejected',
          '模型服务尝试重定向。请直接配置并确认最终 HTTPS endpoint。'
        )
      }
      if (!response.ok) {
        await discardResponseBody(response)
        throw remoteStatusError(response.status)
      }

      const payload = await readJsonResponse(response, this.maxResponseBytes)
      return parseModelCatalog(payload, mode)
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error
      if (controller.signal.aborted) {
        throw new ModelCatalogError('timeout', '读取模型目录超时，请重试。', true)
      }
      // Raw fetch failures can contain a URL, local path, or request metadata.
      throw new ModelCatalogError('network_error', '无法连接已确认的模型 endpoint。', true)
    } finally {
      clearTimeout(timer)
    }
  }
}

export function modelCatalogFromIds(
  ids: readonly string[],
  mode: WorkspaceMode
): ModelDescriptor[] {
  if (!Array.isArray(ids) || ids.length > MAX_MODEL_ROWS) {
    throw new ModelCatalogError('invalid_response', '账户模型目录条目超过安全数量限制。')
  }
  return parseModelCatalog([...ids], mode)
}

export function normalizeModelEndpoint(value: unknown): string {
  if (typeof value !== 'string') invalidEndpoint()
  const text = value.trim()
  if (!text || text.length > MAX_ENDPOINT_LENGTH || /[\r\n\0]/.test(text)) invalidEndpoint()

  let endpoint: URL
  try {
    endpoint = new URL(text)
  } catch {
    invalidEndpoint()
  }

  const hostname = endpoint.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (
    (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    invalidEndpoint()
  }

  const pathname = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = pathname || '/'
  return endpoint.toString().replace(/\/$/, '')
}

function invalidEndpoint(): never {
  throw new ModelCatalogError(
    'invalid_endpoint',
    '模型 endpoint 必须是无凭据、查询参数和片段的 HTTPS 地址；本机开发可使用 loopback HTTP。'
  )
}

function validateApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_API_KEY_LENGTH ||
    /[\r\n\0]/.test(value)
  ) {
    throw new ModelCatalogError('invalid_credential', 'API Key 无效。')
  }
  return value
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already rejected; body disposal is best-effort.
  }
}

function remoteStatusError(status: number): ModelCatalogError {
  if (status === 401 || status === 403) {
    return new ModelCatalogError('remote_rejected', 'API Key 无效或无权读取模型目录。')
  }
  if (status === 429 || status >= 500) {
    return new ModelCatalogError('remote_rejected', `模型服务暂时不可用（HTTP ${status}）。`, true)
  }
  return new ModelCatalogError('remote_rejected', `模型服务拒绝了目录请求（HTTP ${status}）。`)
}

async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponseBody(response)
    throw new ModelCatalogError('response_too_large', '模型目录响应超过安全大小限制。')
  }

  let bytes = 0
  const chunks: Uint8Array[] = []
  if (response.body) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new ModelCatalogError('response_too_large', '模型目录响应超过安全大小限制。')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error
    throw new ModelCatalogError('invalid_response', '模型目录响应不是有效 JSON。')
  }
}

function parseModelCatalog(payload: unknown, mode: WorkspaceMode): ModelDescriptor[] {
  const rows = modelRows(payload)
  if (rows.length > MAX_MODEL_ROWS) {
    throw new ModelCatalogError('invalid_response', '模型目录条目超过安全数量限制。')
  }

  const seen = new Set<string>()
  const models: ModelDescriptor[] = []
  for (const row of rows) {
    const id = modelId(row)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push(toDescriptor(id, row, mode))
  }
  if (models.length === 0) {
    throw new ModelCatalogError('invalid_response', '模型目录没有包含可用的模型 ID。')
  }
  return models.sort((left, right) => left.id.localeCompare(right.id))
}

function modelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isObject(payload)) {
    throw new ModelCatalogError('invalid_response', '模型目录响应结构无效。')
  }
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  throw new ModelCatalogError('invalid_response', '模型目录响应结构无效。')
}

function modelId(row: unknown): string | null {
  const raw = typeof row === 'string'
    ? row
    : isObject(row)
      ? row.id ?? row.name ?? row.model
      : null
  return isValidModelId(raw) ? raw : null
}

function toDescriptor(id: string, row: unknown, mode: WorkspaceMode): ModelDescriptor {
  const declaredCapabilities = readDeclaredCapabilities(row)
  const declaredReasoning = readDeclaredReasoning(row)
  const reasoningProtocol = readDeclaredReasoningProtocol(row)
  const declaredWireMode = readDeclaredWireMode(row)
  const declaredEndpointTypes = readDeclaredEndpointTypes(row)
  const trustedOwner = readTrustedOwner(row)
  const wireMode = declaredWireMode ?? 'standard'
  const endpointTypes = declaredEndpointTypes === undefined
    ? inferEndpointTypesFromModelId(id)
    : declaredEndpointTypes
  assertReasoningProtocolEndpoint(reasoningProtocol, endpointTypes)
  const selectedReasoningProtocol = reasoningProtocolForPreferredEndpoint(
    reasoningProtocol,
    endpointTypes
  )
  const effectiveReasoning = reasoningForProtocol(
    declaredReasoning,
    selectedReasoningProtocol,
    endpointTypes
  )
  return withEndpointDescriptor({
    id,
    label: id,
    wireMode,
    ...(declaredWireMode === undefined ? {} : { declaredWireMode }),
    endpointTypes: [...endpointTypes],
    ...(declaredEndpointTypes === undefined ? {} : {
      declaredEndpointTypes: [...declaredEndpointTypes]
    }),
    ...(trustedOwner === undefined ? {} : { trustedOwner }),
    reasoning: effectiveReasoning ?? [...UNVERIFIED_REASONING],
    ...(effectiveReasoning === undefined ? {} : { declaredReasoning: effectiveReasoning }),
    ...(reasoningProtocol === undefined
      ? {}
      : { declaredReasoningProtocol: cloneModelReasoningProtocol(reasoningProtocol) }),
    ...(selectedReasoningProtocol === undefined
      ? {}
      : { reasoningProtocol: cloneModelReasoningProtocol(selectedReasoningProtocol) }),
    capabilities: displayCapabilities(declaredCapabilities, wireMode, trustedOwner, endpointTypes),
    declaredCapabilities,
    source: 'remote'
  }, mode)
}

/**
 * Replace or merge endpoint declarations while preserving the descriptor's
 * renderer-safe shape. Pricing data is authoritative when /models omitted the
 * field (the descriptor then carries the implicit `openai` default); two
 * explicit declarations are conservatively merged so a model is never sent
 * through an endpoint it did not advertise.
 */
export function mergeModelEndpointTypes(
  model: ModelDescriptor,
  value: unknown,
  mode: WorkspaceMode = model.modes.includes('agent') ? 'agent' : 'chat'
): ModelDescriptor {
  const nextDeclared = normalizeModelEndpointTypes(value)
  const endpointTypes = model.declaredEndpointTypes === undefined
    ? nextDeclared
    : uniqueEndpointTypes([...model.declaredEndpointTypes, ...nextDeclared])
  return withEndpointDescriptor({
    ...model,
    endpointTypes: [...endpointTypes],
    declaredEndpointTypes: [...endpointTypes],
    capabilities: displayCapabilities(
      model.declaredCapabilities ?? {},
      model.wireMode,
      model.trustedOwner,
      endpointTypes
    )
  }, mode)
}

/**
 * Applies a versioned, trusted provider profile only when the remote model row
 * did not publish its own reasoning-strength declaration. A protocol-only
 * remote declaration remains authoritative, and endpoint compatibility is
 * still enforced by the same projection used for untrusted catalog metadata.
 */
export function applyTrustedModelReasoningProfile(
  model: ModelDescriptor,
  reasoning: readonly ReasoningEffort[],
  protocol?: ModelReasoningProtocol
): ModelDescriptor {
  if (model.declaredReasoning !== undefined) return model
  const declared = uniqueReasoning(['auto', ...reasoning])
  // A remote protocol-only declaration is still authoritative. The trusted
  // profile may fill in missing strengths, but it must not replace remote
  // protocol options such as Gemini's includeThoughts flag or token budgets.
  const protocolCandidate = model.declaredReasoningProtocol ?? model.reasoningProtocol ?? protocol
  if (protocolCandidate !== undefined) {
    assertReasoningProtocolEndpoint(protocolCandidate, model.endpointTypes)
  }
  const selectedProtocol = reasoningProtocolForPreferredEndpoint(
    protocolCandidate,
    model.endpointTypes
  )
  const effective = reasoningForProtocol(declared, selectedProtocol, model.endpointTypes)
  if (effective === undefined) return model
  return {
    ...model,
    reasoning: effective,
    declaredReasoning: effective,
    ...(protocolCandidate === undefined ? {} : {
      declaredReasoningProtocol: cloneModelReasoningProtocol(protocolCandidate)
    }),
    ...(selectedProtocol === undefined ? {} : {
      reasoningProtocol: cloneModelReasoningProtocol(selectedProtocol)
    })
  }
}

/**
 * Normalize a remote endpoint declaration. Unknown strings are deliberately
 * discarded rather than mapped to OpenAI. An explicit unknown-only list thus
 * produces an empty, unavailable descriptor instead of silently changing
 * protocol. Malformed list shapes fail closed.
 */
export function normalizeModelEndpointTypes(value: unknown): ModelEndpointType[] {
  if (!Array.isArray(value) || value.length > MAX_ENDPOINT_TYPES) {
    throw new ModelCatalogError('invalid_response', '模型目录端点类型声明无效。')
  }
  const normalized: ModelEndpointType[] = []
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length < 1 ||
      item.length > MAX_ENDPOINT_TYPE_LENGTH ||
      /[\r\n\0]/.test(item)
    ) {
      throw new ModelCatalogError('invalid_response', '模型目录端点类型声明无效。')
    }
    if (isModelEndpointType(item) && !normalized.includes(item)) normalized.push(item)
  }
  return normalized
}

function withEndpointDescriptor(
  descriptor: Omit<ModelDescriptor, 'provider' | 'preferredChatEndpoint' | 'preferredChatTransport' | 'modes'>,
  _requestedMode: WorkspaceMode
): ModelDescriptor {
  const endpointTypes = uniqueEndpointTypes(descriptor.endpointTypes)
  // Endpoint declarations from NewAPI are the only protocol authority. Model
  // IDs are opaque and must not influence transport selection.
  const preferredChatEndpoint = preferredModelEndpoint(endpointTypes)
  const preferredChatTransport = modelEndpointTransport(preferredChatEndpoint)
  const modes: WorkspaceMode[] = []
  // Images is a valid request transport, but it is not a conversation
  // endpoint. Keeping it out of the Chat/Agent mode list prevents image-only
  // groups from appearing in either composer; Studio owns image generation.
  const hasConversationEndpoint = endpointTypes.some((endpoint) => (
    (MODEL_CONVERSATION_ENDPOINT_TYPES as readonly string[]).includes(endpoint)
    && endpoint !== 'openai-response-compact'
  ))
  if (hasConversationEndpoint) modes.push('chat')
  // Agent mode is enabled only for transports with an implemented native tool
  // loop. Image-only, compact Responses, embeddings, and video remain excluded.
  const hasAgentTransport =
    endpointTypes.includes('openai-response') ||
    endpointTypes.includes('anthropic') ||
    endpointTypes.includes('gemini') ||
    (endpointTypes.includes('openai') &&
      !endpointTypes.includes('embeddings') &&
      !endpointTypes.includes('openai-video'))
  if (hasAgentTransport) modes.push('agent')

  return {
    ...descriptor,
    provider: providerForEndpoint(preferredChatEndpoint, preferredChatTransport),
    endpointTypes,
    preferredChatEndpoint,
    preferredChatTransport,
    modes
  }
}

function providerForEndpoint(
  endpoint: ModelEndpointType | null,
  transport: ModelEndpointTransport
): ModelDescriptor['provider'] {
  if (transport === 'unsupported') return 'unsupported'
  if (endpoint === 'anthropic') return 'anthropic-compatible'
  if (endpoint === 'gemini') return 'gemini-compatible'
  return 'openai-compatible'
}

function uniqueEndpointTypes(values: readonly ModelEndpointType[]): ModelEndpointType[] {
  return [...new Set(values)]
}

function inferEndpointTypesFromModelId(modelId: string): ModelEndpointType[] {
  const lower = modelId.toLowerCase()
  if (lower.startsWith('gemini-') || lower.includes('gemini')) return ['gemini']
  if (lower.startsWith('claude-') || lower.includes('claude')) return ['anthropic']
  return ['openai']
}

function readTrustedOwner(row: unknown): 'codex' | undefined {
  if (!isObject(row)) return undefined
  return row.owned_by === 'codex' ? 'codex' : undefined
}

function readDeclaredEndpointTypes(row: unknown): ModelEndpointType[] | undefined {
  if (!isObject(row)) return undefined
  const sources = [row, isObject(row.metadata) ? row.metadata : null]
  const declared: ModelEndpointType[] = []
  let present = false
  for (const source of sources) {
    if (!source) continue
    for (const field of [
      'supported_endpoint_types',
      'supportedEndpointTypes',
      'endpoint_types',
      'endpointTypes'
    ] as const) {
      if (!Object.hasOwn(source, field)) continue
      present = true
      declared.push(...normalizeModelEndpointTypes(source[field]))
    }
  }
  return present ? uniqueEndpointTypes(declared) : undefined
}

function readDeclaredWireMode(row: unknown): ModelWireMode | undefined {
  if (!isObject(row)) return undefined
  const sources = [row, isObject(row.metadata) ? row.metadata : null]
  let declared: ModelWireMode | undefined

  const merge = (candidate: ModelWireMode): void => {
    if (declared !== undefined && declared !== candidate) {
      throw new ModelCatalogError(
        'invalid_response',
        'The model catalog contains conflicting wire mode declarations.'
      )
    }
    declared = candidate
  }

  for (const source of sources) {
    if (!source) continue
    for (const field of ['wire_mode', 'wireMode'] as const) {
      if (!Object.hasOwn(source, field)) continue
      const value = source[field]
      const normalized = normalizeDeclaredWireMode(value)
      if (!normalized) {
        throw new ModelCatalogError(
          'invalid_response',
          'The model catalog contains an invalid wire mode declaration.'
        )
      }
      merge(normalized)
    }
    for (const field of ['use_responses_lite', 'useResponsesLite'] as const) {
      if (!Object.hasOwn(source, field)) continue
      const value = source[field]
      if (typeof value !== 'boolean') {
        throw new ModelCatalogError(
          'invalid_response',
          'The model catalog contains an invalid Responses Lite declaration.'
        )
      }
      merge(value ? 'lite' : 'standard')
    }
  }
  return declared
}

function normalizeDeclaredWireMode(value: unknown): ModelWireMode | null {
  if (value === 'lite' || value === 'responses_lite') return 'lite'
  if (value === 'standard' || value === 'responses') return 'standard'
  return null
}

function readDeclaredReasoning(row: unknown): ReasoningEffort[] | undefined {
  if (!isObject(row)) return undefined
  const candidates: unknown[] = []
  let declared = false
  const sources = [
    row,
    isObject(row.metadata) ? row.metadata : null,
    isObject(row.capabilities) ? row.capabilities : null
  ]
  for (const source of sources) {
    if (!source) continue
    for (const field of [
      'reasoning',
      'reasoning_effort',
      'reasoningEffort',
      'reasoning_efforts',
      'reasoningEfforts',
      'supported_reasoning_efforts',
      'supportedReasoningEfforts',
      'supported_efforts',
      'supportedEfforts'
    ] as const) {
      declared = appendReasoningDeclaration(candidates, source[field], true) || declared
    }
    for (const field of [
      'reasoning_levels',
      'reasoningLevels',
      'supported_reasoning_levels',
      'supportedReasoningLevels',
      'effort_levels',
      'effortLevels'
    ] as const) {
      declared = appendReasoningDeclaration(candidates, source[field], true) || declared
    }
    if (isObject(source.reasoning)) {
      for (const field of [
        'effort',
        'efforts',
        'levels',
        'supported_efforts',
        'supportedEfforts',
        'supported_levels',
        'supportedLevels'
      ] as const) {
        declared = appendReasoningDeclaration(
          candidates,
          source.reasoning[field],
          true
        ) || declared
      }
    }
    for (const outputConfig of [source.output_config, source.outputConfig]) {
      if (!isObject(outputConfig)) continue
      for (const field of ['effort', 'efforts', 'supported_efforts', 'supportedEfforts'] as const) {
        declared = appendReasoningDeclaration(candidates, outputConfig[field], true) || declared
      }
    }
    for (const thinkingConfig of reasoningThinkingConfigs(source)) {
      for (const field of [
        'thinking_level',
        'thinkingLevel',
        'levels',
        'supported_levels',
        'supportedLevels'
      ] as const) {
        declared = appendReasoningDeclaration(candidates, thinkingConfig[field], true) || declared
      }
    }
  }
  if (!declared) return undefined
  const explicit = candidates
    .map(normalizeReasoningEffort)
    .filter((value): value is ReasoningEffort => value !== null)
  return uniqueReasoning(['auto', ...explicit])
}

function appendReasoningDeclaration(
  output: unknown[],
  value: unknown,
  acceptLevelObjects = false
): boolean {
  if (Array.isArray(value)) {
    appendReasoningCandidates(output, value, acceptLevelObjects)
    return true
  }
  if (!isObject(value)) return false
  let declared = false
  for (const field of [
    'enum',
    'values',
    'options',
    'supported_values',
    'supportedValues',
    'allowed_values',
    'allowedValues',
    'oneOf',
    'anyOf'
  ] as const) {
    if (!Array.isArray(value[field])) continue
    appendReasoningCandidates(output, value[field], true)
    declared = true
  }
  return declared
}

function reasoningThinkingConfigs(source: Record<string, unknown>): Record<string, unknown>[] {
  const values: unknown[] = [source.thinking_config, source.thinkingConfig]
  for (const generationConfig of [source.generation_config, source.generationConfig]) {
    if (!isObject(generationConfig)) continue
    values.push(generationConfig.thinking_config, generationConfig.thinkingConfig)
  }
  return values.filter(isObject)
}

function appendReasoningCandidates(
  output: unknown[],
  values: readonly unknown[],
  acceptLevelObjects = false
): void {
  if (values.length > MAX_REASONING_LEVELS) {
    throw new ModelCatalogError('invalid_response', '模型目录推理强度声明无效。')
  }
  for (const value of values) {
    if (!acceptLevelObjects || !isObject(value)) {
      output.push(value)
      continue
    }
    for (const field of [
      'effort',
      'reasoning_effort',
      'reasoningEffort',
      'level',
      'value',
      'id',
      'const'
    ] as const) {
      if (!Object.hasOwn(value, field)) continue
      output.push(value[field])
      break
    }
  }
}

function readDeclaredReasoningProtocol(row: unknown): ModelReasoningProtocol | undefined {
  if (!isObject(row)) return undefined
  const sources = [
    row,
    isObject(row.metadata) ? row.metadata : null,
    isObject(row.capabilities) ? row.capabilities : null
  ]
  let declared: ModelReasoningProtocol | undefined
  for (const source of sources) {
    if (!source) continue
    const declarations: unknown[] = []
    for (const field of [
      'reasoning_protocol',
      'reasoningProtocol',
      'thinking_protocol',
      'thinkingProtocol'
    ] as const) {
      if (!Object.hasOwn(source, field)) continue
      declarations.push(source[field])
    }
    if (isObject(source.reasoning) && Object.hasOwn(source.reasoning, 'protocol')) {
      declarations.push(source.reasoning.protocol)
    }
    for (const declaration of declarations) {
      const value = normalizeReasoningProtocolDeclaration(declaration)
      if (
        declared !== undefined &&
        JSON.stringify(declared) !== JSON.stringify(value)
      ) {
        throw new ModelCatalogError(
          'invalid_response',
          'The model catalog contains conflicting reasoning protocol declarations.'
        )
      }
      declared = value
    }
  }
  return declared
}

function normalizeReasoningProtocolDeclaration(value: unknown): ModelReasoningProtocol {
  if (!isObject(value)) {
    throw new ModelCatalogError(
      'invalid_response',
      'The model catalog contains an invalid reasoning protocol declaration.'
    )
  }
  const normalized: Record<string, unknown> = { ...value }
  if (typeof normalized.type === 'string') {
    normalized.type = normalized.type.replaceAll('_', '-')
  }
  if (Object.hasOwn(normalized, 'include_thoughts')) {
    if (Object.hasOwn(normalized, 'includeThoughts')) {
      throw new ModelCatalogError(
        'invalid_response',
        'The model catalog contains an invalid reasoning protocol declaration.'
      )
    }
    normalized.includeThoughts = normalized.include_thoughts
    delete normalized.include_thoughts
  }
  if (Object.hasOwn(normalized, 'budgets')) {
    normalized.budgets = normalizeReasoningBudgetDeclaration(normalized.budgets)
  }
  if (!isModelReasoningProtocol(normalized)) {
    throw new ModelCatalogError(
      'invalid_response',
      'The model catalog contains an invalid reasoning protocol declaration.'
    )
  }
  return cloneModelReasoningProtocol(normalized)
}

function normalizeReasoningBudgetDeclaration(value: unknown): unknown {
  if (!isObject(value)) return value
  const normalized: Record<string, unknown> = {}
  for (const [key, budget] of Object.entries(value)) {
    const effort = normalizeReasoningEffort(key)
    const normalizedKey = effort === null || effort === 'auto' ? key : effort
    if (
      Object.hasOwn(normalized, normalizedKey) &&
      normalized[normalizedKey] !== budget
    ) {
      throw new ModelCatalogError(
        'invalid_response',
        'The model catalog contains conflicting reasoning budget declarations.'
      )
    }
    normalized[normalizedKey] = budget
  }
  return normalized
}

function reasoningForProtocol(
  declared: ReasoningEffort[] | undefined,
  protocol: ModelReasoningProtocol | undefined,
  endpointTypes: readonly ModelEndpointType[]
): ReasoningEffort[] | undefined {
  const preferredEndpoint = preferredModelEndpoint(endpointTypes)
  if (protocol?.type === 'anthropic-adaptive') {
    return filterRepresentableReasoning(declared, 'anthropic-adaptive')
  }
  if (protocol?.type === 'gemini-level') {
    return filterRepresentableReasoning(declared, 'gemini-level')
  }
  if (protocol?.type === 'anthropic-budget' || protocol?.type === 'gemini-budget') {
    const budgetEfforts = Object.keys(protocol.budgets) as Array<Exclude<ReasoningEffort, 'auto'>>
    if (declared === undefined) return uniqueReasoning(['auto', ...budgetEfforts])
    return declared.filter((effort) => effort === 'auto' || budgetEfforts.includes(effort))
  }

  if (preferredEndpoint === 'openai-response') {
    return filterRepresentableReasoning(declared, 'responses')
  }
  if (preferredEndpoint === 'openai') {
    return filterRepresentableReasoning(declared, 'chat-completions')
  }
  // Native Anthropic/Gemini reasoning requires an explicit matching strategy.
  // Images and unsupported endpoint kinds never receive reasoning fields.
  return undefined
}

function filterRepresentableReasoning(
  declared: ReasoningEffort[] | undefined,
  target: ReasoningWireTarget
): ReasoningEffort[] | undefined {
  return declared?.filter((effort) => isReasoningEffortRepresentable(effort, target))
}

function reasoningProtocolForPreferredEndpoint(
  protocol: ModelReasoningProtocol | undefined,
  endpointTypes: readonly ModelEndpointType[]
): ModelReasoningProtocol | undefined {
  if (protocol === undefined) return undefined
  const preferredEndpoint = preferredModelEndpoint(endpointTypes)
  if (preferredEndpoint === null) return undefined
  const selectedProtocol = reasoningProtocolForEndpoint(protocol, preferredEndpoint)
  if (selectedProtocol !== undefined) return selectedProtocol
  // A multi-endpoint row may describe native thinking for an endpoint that is
  // not selected by the server's ordering. Do not pass that protocol to the
  // selected OpenAI/native client, where it would invalidate the whole turn.
  return undefined
}

function assertReasoningProtocolEndpoint(
  protocol: ModelReasoningProtocol | undefined,
  endpointTypes: readonly ModelEndpointType[]
): void {
  if (protocol === undefined) return
  const endpoint = protocol.type.startsWith('anthropic-') ? 'anthropic' : 'gemini'
  if (!endpointTypes.includes(endpoint)) {
    throw new ModelCatalogError(
      'invalid_response',
      'The model catalog reasoning protocol does not match its declared endpoint type.'
    )
  }
}

function uniqueReasoning(values: ReasoningEffort[]): ReasoningEffort[] {
  return [...new Set(values)]
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, '_')
  if (normalized === 'low') return 'light'
  if (normalized === 'extra_high') return 'xhigh'
  return (
    normalized === 'auto' ||
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'light' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultra'
  ) ? normalized : null
}

function readDeclaredCapabilities(row: unknown): Partial<ModelCapabilities> {
  const explicit = isObject(row) && isObject(row.capabilities) ? row.capabilities : null
  const declared: Partial<ModelCapabilities> = {}
  const names: Array<keyof ModelCapabilities> = [
    'attachments',
    'imageInput',
    'imageGeneration',
    'subagents',
    'toolUse',
    'webSearch'
  ]
  for (const name of names) {
    if (!explicit || !Object.hasOwn(explicit, name)) continue
    const value = explicit?.[name]
    if (typeof value === 'boolean') declared[name] = value
  }
  return declared
}

function displayCapabilities(
  declared: Partial<ModelCapabilities>,
  wireMode: ModelWireMode,
  trustedOwner: 'codex' | undefined,
  endpointTypes: readonly ModelEndpointType[]
): ModelCapabilities {
  const liteTransport = wireMode === 'lite'
  const responsesTransport = endpointTypes.includes('openai-response')
  const anthropicTransport = endpointTypes.includes('anthropic')
  const geminiTransport = endpointTypes.includes('gemini')
  const openaiTransport = endpointTypes.includes('openai')
  const imagesTransport = endpointTypes.includes('image-generation')
  const toolCapableTransport = responsesTransport || anthropicTransport || geminiTransport || openaiTransport
  return {
    attachments: declared.attachments === true,
    imageInput: declared.imageInput === true,
    imageGeneration: !liteTransport && declared.imageGeneration !== false && (
      imagesTransport || (responsesTransport && declared.imageGeneration === true)
    ),
    subagents: responsesTransport && declared.subagents === true,
    toolUse: toolCapableTransport && declared.toolUse !== false,
    webSearch: responsesTransport && !liteTransport && (
      declared.webSearch ?? trustedOwner === 'codex'
    )
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
