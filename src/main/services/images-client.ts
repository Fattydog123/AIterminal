import { normalizeEndpoint } from '../security/consent-store.ts'
import { containsSensitiveCredential } from '../security/redaction.ts'
import type { ResponsesGeneratedImage } from './responses-client.ts'
import { joinNativeEndpoint, normalizeNativePath } from './native-sse-utils.ts'

/** Credentials for an already confirmed OpenAI-compatible Images endpoint. */
export interface ImagesCredentials {
  baseUrl: string
  apiKey: string
}

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp'
export type ImageBackground = 'transparent' | 'opaque' | 'auto'
export type ImageModeration = 'low' | 'auto'

export const OPENAI_IMAGES_ENDPOINT_PROTOCOL = 'openai-images' as const
export type ImagesEndpointProtocol = typeof OPENAI_IMAGES_ENDPOINT_PROTOCOL

/**
 * Resolve an image transport only from a bounded server endpoint declaration.
 * Model IDs are intentionally absent: native provider protocols need their own
 * future declaration and transport instead of being guessed from a name.
 */
export function imagesEndpointProtocolForDeclaredType(value: unknown): ImagesEndpointProtocol | null {
  return value === 'image-generation' ? OPENAI_IMAGES_ENDPOINT_PROTOCOL : null
}

/** A deliberately small scalar extension surface for provider-specific fields. */
export type ImageRequestExtraValue = string | number | boolean
export type ImageRequestExtra = Readonly<Record<string, ImageRequestExtraValue>>

export interface ImageGenerationRequest {
  model: string
  prompt: string
  endpointPath?: string
  n?: number
  size?: string
  quality?: string
  outputFormat?: ImageOutputFormat
  outputCompression?: number
  background?: ImageBackground
  moderation?: ImageModeration
  extra?: ImageRequestExtra
}

/**
 * An edit source is supplied as bytes or as a data URL. Local paths are not
 * accepted here: callers must read and authorize local files before crossing
 * this transport boundary.
 */
export interface ImageInput {
  bytes?: Uint8Array | ArrayBuffer
  dataUrl?: string
  mimeType?: ImageMimeType
  filename?: string
}

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ImageEditRequest extends ImageGenerationRequest {
  image: ImageInput | readonly ImageInput[]
  mask?: ImageInput
  inputFidelity?: 'low' | 'high'
}

export interface ImagesResult {
  readonly generatedImages: readonly ResponsesGeneratedImage[]
}

export type ImagesGenerationRequest = ImageGenerationRequest
export type ImagesEditRequest = ImageEditRequest
export type ImagesGeneratedImage = ResponsesGeneratedImage
export type ImagesResponse = ImagesResult

export interface ImagesClientOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  maxImageBytes?: number
}

export interface ImagesRequestOptions {
  signal?: AbortSignal
}

export type ImagesClientErrorCode =
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
  | 'invalid_response'
  | 'unsupported_image_format'

export type ImagesRemoteFailure =
  | 'authorization'
  | 'rate_limited'
  | 'server_error'
  | 'request_rejected'

const ERROR_DETAILS: Readonly<Record<ImagesClientErrorCode, {
  message: string
  retryable: boolean
}>> = {
  invalid_configuration: { message: 'The Images client configuration is invalid.', retryable: false },
  invalid_endpoint: { message: 'The confirmed image endpoint is invalid.', retryable: false },
  invalid_credential: { message: 'The image credential is invalid.', retryable: false },
  invalid_input: { message: 'The image request is invalid.', retryable: false },
  cancelled: { message: 'The image request was cancelled.', retryable: false },
  timeout: { message: 'The image request timed out.', retryable: true },
  network_error: { message: 'The confirmed image endpoint could not be reached.', retryable: true },
  redirect_rejected: { message: 'The image endpoint attempted a redirect.', retryable: false },
  remote_rejected: { message: 'The image endpoint rejected the request.', retryable: false },
  response_too_large: { message: 'The image response exceeded the safety limit.', retryable: false },
  invalid_response: { message: 'The image endpoint returned an invalid response.', retryable: false },
  unsupported_image_format: { message: 'The image endpoint returned a format that cannot be stored safely.', retryable: false }
}

export class ImagesClientError extends Error {
  readonly code: ImagesClientErrorCode
  readonly retryable: boolean
  readonly remoteFailure?: ImagesRemoteFailure

  constructor(code: ImagesClientErrorCode, retryable?: boolean, remoteFailure?: ImagesRemoteFailure) {
    const detail = ERROR_DETAILS[code]
    super(detail.message)
    this.name = 'ImagesClientError'
    this.code = code
    this.retryable = retryable ?? detail.retryable
    this.remoteFailure = code === 'remote_rejected' && isRemoteFailure(remoteFailure)
      ? remoteFailure
      : undefined
    // Do not retain transport errors, response bodies, URLs, or credentials.
    this.stack = `${this.name}: ${this.message}`
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_API_KEY_LENGTH = 32_768
const MAX_MODEL_LENGTH = 256
const MAX_PROMPT_CHARACTERS = 256_000
const MAX_SIZE_LENGTH = 64
const MAX_QUALITY_LENGTH = 64
const MAX_EXTRA_FIELDS = 24
const MAX_EXTRA_STRING_LENGTH = 4_096
const MAX_FILENAME_LENGTH = 128
const MAX_IMAGES_PER_REQUEST = 4
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const SAFE_PARAMETER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/x-]{0,63}$/u
const QUALITY_VALUES = new Set([
  'auto', 'low', 'medium', 'high', 'standard', 'hd', 'draft', 'fast', 'normal', 'ultra'
])
const RESERVED_EXTRA_KEYS = new Set([
  'model', 'prompt', 'n', 'size', 'quality', 'response_format', 'output_format',
  'output_compression', 'background', 'moderation', 'stream', 'image', 'image[]',
  'mask', 'input_fidelity'
])
const SENSITIVE_EXTRA_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|passwd|secret|token|private[_-]?key|access[_-]?token)/iu
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const WEBP_RIFF = Buffer.from('RIFF')
const WEBP_WEBP = Buffer.from('WEBP')

/** Normalize an already authorized model API root. */
export function normalizeImagesBaseUrl(value: unknown): string {
  let normalized: string
  try {
    normalized = normalizeEndpoint(value)
  } catch {
    throw new ImagesClientError('invalid_endpoint')
  }
  const endpoint = new URL(normalized)
  if (endpoint.search || endpoint.hash) throw new ImagesClientError('invalid_endpoint')
  return normalized.replace(/\/+$/u, '')
}

export function buildImagesGenerationRequestUrl(baseUrl: unknown, endpointPath?: unknown): string {
  return buildImagesRequestUrl(baseUrl, endpointPath, '/images/generations')
}

export function buildImagesEditRequestUrl(baseUrl: unknown, endpointPath?: unknown): string {
  return buildImagesRequestUrl(baseUrl, endpointPath, '/images/edits')
}

export class OpenAICompatibleImagesClient {
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxImageBytes: number

  constructor(options: ImagesClientOptions = {}) {
    const candidate: unknown = options
    if (!hasOnlyKeys(candidate, ['fetcher', 'timeoutMs', 'maxResponseBytes', 'maxImageBytes'])) {
      throw new ImagesClientError('invalid_configuration')
    }
    if (candidate.fetcher !== undefined && typeof candidate.fetcher !== 'function') {
      throw new ImagesClientError('invalid_configuration')
    }
    this.#timeoutMs = configurationInteger(candidate.timeoutMs, DEFAULT_TIMEOUT_MS, 10, MAX_TIMEOUT_MS)
    this.#maxResponseBytes = configurationInteger(
      candidate.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES
    )
    this.#maxImageBytes = configurationInteger(
      candidate.maxImageBytes,
      DEFAULT_MAX_IMAGE_BYTES,
      1_024,
      MAX_IMAGE_BYTES
    )
    if (this.#maxImageBytes > this.#maxResponseBytes) throw new ImagesClientError('invalid_configuration')
    this.#fetcher = (candidate.fetcher as typeof fetch | undefined) ?? globalThis.fetch
    if (typeof this.#fetcher !== 'function') throw new ImagesClientError('invalid_configuration')
  }

  async generate(
    credentials: ImagesCredentials,
    request: ImageGenerationRequest,
    options: ImagesRequestOptions = {}
  ): Promise<ImagesResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeGenerationRequest(request)
    const requestBody = serializeGenerationRequest(normalizedRequest)
    if (containsSensitiveCredential(requestBody, [normalizedCredentials.apiKey])) {
      throw new ImagesClientError('invalid_input')
    }
    return this.#sendJson(
      normalizedCredentials,
      buildImagesGenerationRequestUrl(normalizedCredentials.baseUrl, normalizedRequest.endpointPath),
      requestBody,
      options
    )
  }

  /** Alias matching the endpoint name used in API documentation. */
  async generations(
    credentials: ImagesCredentials,
    request: ImageGenerationRequest,
    options: ImagesRequestOptions = {}
  ): Promise<ImagesResult> {
    return this.generate(credentials, request, options)
  }

  async edit(
    credentials: ImagesCredentials,
    request: ImageEditRequest,
    options: ImagesRequestOptions = {}
  ): Promise<ImagesResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = await normalizeEditRequest(request, this.#maxImageBytes)
    const form = serializeEditRequest(normalizedRequest)
    // Check textual fields before dispatch. Binary data is not converted to a
    // string, avoiding accidental logging or credential matching on image bytes.
    const textualRequest = JSON.stringify({
      model: normalizedRequest.model,
      prompt: normalizedRequest.prompt,
      extra: normalizedRequest.extra,
      filenames: normalizedRequest.images.map((image) => image.filename),
      maskFilename: normalizedRequest.mask?.filename
    })
    if (containsSensitiveCredential(textualRequest, [normalizedCredentials.apiKey])) {
      throw new ImagesClientError('invalid_input')
    }
    return this.#sendMultipart(
      normalizedCredentials,
      buildImagesEditRequestUrl(normalizedCredentials.baseUrl, normalizedRequest.endpointPath),
      form,
      options
    )
  }

  /** Alias matching the endpoint name used in API documentation. */
  async edits(
    credentials: ImagesCredentials,
    request: ImageEditRequest,
    options: ImagesRequestOptions = {}
  ): Promise<ImagesResult> {
    return this.edit(credentials, request, options)
  }

  async #sendJson(
    credentials: NormalizedCredentials,
    requestUrl: string,
    body: string,
    options: ImagesRequestOptions
  ): Promise<ImagesResult> {
    return this.#send(requestUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json'
      },
      body
    }, options)
  }

  async #sendMultipart(
    credentials: NormalizedCredentials,
    requestUrl: string,
    body: FormData,
    options: ImagesRequestOptions
  ): Promise<ImagesResult> {
    return this.#send(requestUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`
      },
      body
    }, options)
  }

  async #send(
    requestUrl: string,
    init: RequestInit,
    options: ImagesRequestOptions
  ): Promise<ImagesResult> {
    const signal = normalizeRequestOptions(options)
    if (signal?.aborted) throw new ImagesClientError('cancelled')
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = (): void => controller.abort()
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)
    timeout.unref?.()

    try {
      const response = await this.#fetcher(requestUrl, {
        ...init,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new ImagesClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(response.status)
        await discardResponseBody(response)
        throw new ImagesClientError('remote_rejected', retryable, remoteFailure)
      }
      const declaredLength = response.headers.get('content-length')
      if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > this.#maxResponseBytes) {
        await discardResponseBody(response)
        throw new ImagesClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== undefined && contentType !== '' && contentType !== 'application/json' && !contentType.endsWith('+json')) {
        await discardResponseBody(response)
        throw new ImagesClientError('invalid_response')
      }
      const bytes = await readBoundedResponse(response, this.#maxResponseBytes)
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch {
        throw new ImagesClientError('invalid_response')
      }
      return parseImagesResponse(payload, this.#maxImageBytes)
    } catch (error) {
      if (signal?.aborted) throw new ImagesClientError('cancelled')
      if (timedOut) throw new ImagesClientError('timeout')
      if (error instanceof ImagesClientError) throw error
      throw new ImagesClientError('network_error')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

interface NormalizedCredentials {
  baseUrl: string
  apiKey: string
}

interface NormalizedGenerationRequest extends ImageGenerationRequest {
  n: number
  extra: ImageRequestExtra
  imageFamily: boolean
}

interface NormalizedImageInput {
  bytes: Uint8Array
  mimeType: ImageMimeType
  filename: string
}

interface NormalizedEditRequest extends NormalizedGenerationRequest {
  images: readonly NormalizedImageInput[]
  mask?: NormalizedImageInput
  inputFidelity?: 'low' | 'high'
}

function normalizeCredentials(value: unknown): NormalizedCredentials {
  try {
    if (!hasExactKeys(value, ['baseUrl', 'apiKey'])) throw new ImagesClientError('invalid_credential')
    const baseUrl = normalizeImagesBaseUrl(value.baseUrl)
    if (
      typeof value.apiKey !== 'string' ||
      value.apiKey.length < 1 ||
      value.apiKey.length > MAX_API_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(value.apiKey)
    ) throw new ImagesClientError('invalid_credential')
    return { baseUrl, apiKey: value.apiKey }
  } catch (error) {
    if (error instanceof ImagesClientError) throw error
    throw new ImagesClientError('invalid_credential')
  }
}

function normalizeGenerationRequest(value: unknown): NormalizedGenerationRequest {
  try {
    if (!hasOnlyKeys(value, [
      'model', 'prompt', 'n', 'size', 'quality', 'outputFormat', 'outputCompression',
      'background', 'moderation', 'extra', 'endpointPath'
    ])) invalidInput()
    if (
      typeof value.model !== 'string' ||
      value.model.length < 1 ||
      value.model.length > MAX_MODEL_LENGTH ||
      !MODEL_PATTERN.test(value.model)
    ) invalidInput()
    if (
      typeof value.prompt !== 'string' ||
      value.prompt.length < 1 ||
      value.prompt.length > MAX_PROMPT_CHARACTERS ||
      value.prompt.includes('\0')
    ) invalidInput()
    const n = value.n === undefined ? 1 : value.n
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_IMAGES_PER_REQUEST) invalidInput()
    const size = optionalSafeParameter(value.size, MAX_SIZE_LENGTH)
    const quality = optionalSafeParameter(value.quality, MAX_QUALITY_LENGTH)
    if (quality !== undefined && !QUALITY_VALUES.has(quality.toLowerCase()) && !SAFE_PARAMETER_PATTERN.test(quality)) invalidInput()
    if (value.outputFormat !== undefined && !isOutputFormat(value.outputFormat)) invalidInput()
    if (
      value.outputCompression !== undefined &&
      (typeof value.outputCompression !== 'number' || !Number.isSafeInteger(value.outputCompression) ||
        value.outputCompression < 0 || value.outputCompression > 100)
    ) invalidInput()
    if (value.background !== undefined && !isBackground(value.background)) invalidInput()
    if (value.moderation !== undefined && !isModeration(value.moderation)) invalidInput()
    const extra = normalizeExtra(value.extra)
    const endpointPath = value.endpointPath === undefined
      ? undefined
      : normalizeImagesPath(value.endpointPath)
    const imageFamily = isImageFamilyModel(value.model)
    // GPT Image contracts do not accept seed. It is only allowed as an
    // extension for legacy providers, and never inferred from endpoint type.
    if (imageFamily && Object.keys(extra).some((key) => key.toLowerCase() === 'seed')) invalidInput()
    if (isImage2Model(value.model) && value.prompt.length > 32_000) invalidInput()
    if (isImage2Model(value.model) && value.background === 'transparent') invalidInput()
    if (value.outputCompression !== undefined && (value.outputFormat ?? 'png') === 'png') invalidInput()
    const bodySize = Buffer.byteLength(JSON.stringify({ model: value.model, prompt: value.prompt, n, extra }), 'utf8')
    if (bodySize > MAX_REQUEST_BODY_BYTES) invalidInput()
    return {
      model: value.model,
      prompt: value.prompt,
      n,
      ...(endpointPath === undefined ? {} : { endpointPath }),
      ...(size === undefined ? {} : { size }),
      ...(quality === undefined ? {} : { quality }),
      ...(value.outputFormat === undefined ? {} : { outputFormat: value.outputFormat }),
      ...(value.outputCompression === undefined ? {} : { outputCompression: value.outputCompression }),
      ...(value.background === undefined ? {} : { background: value.background }),
      ...(value.moderation === undefined ? {} : { moderation: value.moderation }),
      extra,
      imageFamily
    }
  } catch (error) {
    if (error instanceof ImagesClientError) throw error
    throw new ImagesClientError('invalid_input')
  }
}

async function normalizeEditRequest(value: unknown, maxImageBytes: number): Promise<NormalizedEditRequest> {
  try {
    if (!hasOnlyKeys(value, [
      'model', 'prompt', 'n', 'size', 'quality', 'outputFormat', 'outputCompression',
      'background', 'moderation', 'extra', 'endpointPath', 'image', 'mask', 'inputFidelity'
    ])) invalidInput()
    const common = normalizeGenerationRequest({
      model: value.model,
      prompt: value.prompt,
      ...(value.endpointPath === undefined ? {} : { endpointPath: value.endpointPath }),
      ...(value.n === undefined ? {} : { n: value.n }),
      ...(value.size === undefined ? {} : { size: value.size }),
      ...(value.quality === undefined ? {} : { quality: value.quality }),
      ...(value.outputFormat === undefined ? {} : { outputFormat: value.outputFormat }),
      ...(value.outputCompression === undefined ? {} : { outputCompression: value.outputCompression }),
      ...(value.background === undefined ? {} : { background: value.background }),
      ...(value.moderation === undefined ? {} : { moderation: value.moderation }),
      ...(value.extra === undefined ? {} : { extra: value.extra })
    })
    if (value.inputFidelity !== undefined && value.inputFidelity !== 'low' && value.inputFidelity !== 'high') invalidInput()
    if (isImage2Model(common.model) && value.inputFidelity !== undefined) invalidInput()
    const rawImages = Array.isArray(value.image) ? value.image : [value.image]
    if (rawImages.length < 1 || rawImages.length > MAX_IMAGES_PER_REQUEST) invalidInput()
    const images = await Promise.all(rawImages.map((item) => normalizeImageInput(item, maxImageBytes)))
    const mask = value.mask === undefined ? undefined : await normalizeImageInput(value.mask, maxImageBytes)
    if (mask && mask.mimeType !== 'image/png') invalidInput()
    if (mask && isImage2Model(common.model) && images.some((image) => image.mimeType !== mask.mimeType)) invalidInput()
    return {
      ...common,
      images,
      ...(mask === undefined ? {} : { mask }),
      ...(value.inputFidelity === undefined ? {} : { inputFidelity: value.inputFidelity })
    }
  } catch (error) {
    if (error instanceof ImagesClientError) throw error
    throw new ImagesClientError('invalid_input')
  }
}

function serializeGenerationRequest(request: NormalizedGenerationRequest): string {
  const body: Record<string, unknown> = {
    ...request.extra,
    model: request.model,
    prompt: request.prompt,
    n: request.n,
    ...(request.size === undefined ? {} : { size: request.size }),
    ...(request.quality === undefined ? {} : { quality: request.quality })
  }
  if (request.imageFamily) {
    // GPT Image 2 requires output_format and returns base64. PNG is the only
    // result format accepted by ImageResultStore; other formats are still sent
    // when explicitly requested and are rejected during response validation.
    body.output_format = request.outputFormat ?? 'png'
    if (request.outputCompression !== undefined && body.output_format !== 'png') {
      body.output_compression = request.outputCompression
    }
    if (request.background !== undefined) body.background = request.background
    if (request.moderation !== undefined) body.moderation = request.moderation
  } else {
    // Force base64 for legacy OpenAI-compatible providers. We never follow a
    // remote URL from an image response, which avoids a second SSRF surface.
    body.response_format = 'b64_json'
  }
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BODY_BYTES) invalidInput()
  return serialized
}

function serializeEditRequest(request: NormalizedEditRequest): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(request.extra)) form.set(key, String(value))
  form.set('model', request.model)
  form.set('prompt', request.prompt)
  form.set('n', String(request.n))
  if (request.size !== undefined) form.set('size', request.size)
  if (request.quality !== undefined) form.set('quality', request.quality)
  if (request.imageFamily) {
    form.set('output_format', request.outputFormat ?? 'png')
    if (request.outputCompression !== undefined && request.outputFormat !== 'png') {
      form.set('output_compression', String(request.outputCompression))
    }
    if (request.background !== undefined) form.set('background', request.background)
    if (request.moderation !== undefined) form.set('moderation', request.moderation)
  } else if (request.inputFidelity !== undefined) {
    form.set('input_fidelity', request.inputFidelity)
  }
  const imageField = request.imageFamily && request.images.length > 0 ? 'image[]' : 'image'
  for (const image of request.images) {
    const imageBuffer = Uint8Array.from(image.bytes).buffer as ArrayBuffer
    const blob = new Blob([imageBuffer], { type: image.mimeType })
    form.append(imageField, blob, image.filename)
  }
  if (request.mask) {
    const maskBuffer = Uint8Array.from(request.mask.bytes).buffer as ArrayBuffer
    const blob = new Blob([maskBuffer], { type: request.mask.mimeType })
    form.append('mask', blob, request.mask.filename)
  }
  return form
}

async function normalizeImageInput(value: unknown, maxImageBytes: number): Promise<NormalizedImageInput> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['bytes', 'dataUrl', 'mimeType', 'filename'])) invalidInput()
  if (value.bytes !== undefined && value.dataUrl !== undefined) invalidInput()
  let bytes: Uint8Array
  if (value.dataUrl !== undefined) {
    if (typeof value.dataUrl !== 'string') invalidInput()
    bytes = decodeImageDataUrl(value.dataUrl, maxImageBytes)
  } else if (value.bytes instanceof Uint8Array) {
    if (value.bytes.byteLength > maxImageBytes) invalidInput()
    bytes = Uint8Array.from(value.bytes)
  } else if (value.bytes instanceof ArrayBuffer) {
    if (value.bytes.byteLength > maxImageBytes) invalidInput()
    bytes = new Uint8Array(value.bytes.slice(0))
  } else {
    invalidInput()
  }
  if (bytes.byteLength < 12 || bytes.byteLength > maxImageBytes) invalidInput()
  const detected = detectImageMime(bytes)
  if (value.mimeType !== undefined && value.mimeType !== detected) invalidInput()
  const filename = normalizeFilename(value.filename, detected)
  return { bytes, mimeType: detected, filename }
}

function parseImagesResponse(value: unknown, maxImageBytes: number): ImagesResult {
  if (!isPlainRecord(value) || !Array.isArray(value.data) || value.data.length < 1 || value.data.length > MAX_IMAGES_PER_REQUEST) {
    throw new ImagesClientError('invalid_response')
  }
  const generatedImages: ResponsesGeneratedImage[] = []
  for (const item of value.data) {
    if (!isPlainRecord(item)) throw new ImagesClientError('invalid_response')
    let data: unknown = item.b64_json
    if (data === undefined) data = item.url
    if (typeof data !== 'string') throw new ImagesClientError('invalid_response')
    try {
      const png = decodePngData(data, maxImageBytes)
      generatedImages.push(Object.freeze({
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`
      }))
    } catch (error) {
      if (error instanceof ImagesClientError) throw error
      throw new ImagesClientError('invalid_response')
    }
  }
  return Object.freeze({ generatedImages: Object.freeze(generatedImages) })
}

function decodePngData(value: string, maxImageBytes: number): Buffer {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value)
  const encoded = match?.[2] ?? value
  if (
    encoded.length < 12 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) throw new ImagesClientError('invalid_response')
  if (match && match[1] !== undefined && match[1].toLowerCase() !== 'image/png') {
    throw new ImagesClientError('unsupported_image_format')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > maxImageBytes || bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (looksLikeNonPng(bytes)) throw new ImagesClientError('unsupported_image_format')
    throw new ImagesClientError('invalid_response')
  }
  if (bytes.toString('base64') !== encoded) throw new ImagesClientError('invalid_response')
  return bytes
}

function decodeImageDataUrl(value: string, maxImageBytes: number): Uint8Array {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value)
  if (!match || !['image/png', 'image/jpeg', 'image/webp'].includes(match[1]!.toLowerCase())) invalidInput()
  const encoded = match[2]!
  if (encoded.length > Math.ceil(maxImageBytes / 3) * 4 + 4) invalidInput()
  if (encoded.length < 16 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) invalidInput()
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > maxImageBytes || bytes.toString('base64') !== encoded) invalidInput()
  const detected = detectImageMime(bytes)
  if (detected !== match[1]!.toLowerCase()) invalidInput()
  return bytes
}

function detectImageMime(bytes: Uint8Array): ImageMimeType {
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((byte, index) => byte === PNG_SIGNATURE[index])) return 'image/png'
  if (bytes.length >= 3 && bytes.subarray(0, 3).every((byte, index) => byte === JPEG_SIGNATURE[index])) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.subarray(0, 4).every((byte, index) => byte === WEBP_RIFF[index]) && bytes.subarray(8, 12).every((byte, index) => byte === WEBP_WEBP[index])) return 'image/webp'
  invalidInput()
}

function looksLikeNonPng(bytes: Uint8Array): boolean {
  return (bytes.length >= 3 && bytes.subarray(0, 3).every((byte, index) => byte === JPEG_SIGNATURE[index])) ||
    (bytes.length >= 12 && bytes.subarray(0, 4).every((byte, index) => byte === WEBP_RIFF[index]) && bytes.subarray(8, 12).every((byte, index) => byte === WEBP_WEBP[index]))
}

function normalizeFilename(value: unknown, mimeType: ImageMimeType): string {
  if (value === undefined) return `image.${mimeType.slice('image/'.length)}`
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_FILENAME_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) || value.includes('..')) invalidInput()
  return value
}

function normalizeExtra(value: unknown): ImageRequestExtra {
  if (value === undefined) return Object.freeze({})
  if (!isPlainRecord(value)) invalidInput()
  const entries = Object.entries(value)
  if (entries.length > MAX_EXTRA_FIELDS) invalidInput()
  const normalized: Record<string, ImageRequestExtraValue> = {}
  for (const [key, item] of entries) {
    const lower = key.toLowerCase()
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || RESERVED_EXTRA_KEYS.has(lower) || SENSITIVE_EXTRA_KEY.test(key)) invalidInput()
    if (typeof item === 'string') {
      if (item.length > MAX_EXTRA_STRING_LENGTH || item.includes('\0')) invalidInput()
      normalized[key] = item
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) invalidInput()
      normalized[key] = item
    } else if (typeof item === 'boolean') {
      normalized[key] = item
    } else invalidInput()
  }
  return Object.freeze(normalized)
}

function optionalSafeParameter(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !SAFE_PARAMETER_PATTERN.test(value)) invalidInput()
  return value
}

function isImageFamilyModel(model: string): boolean {
  // Model names only select the parameter shape (GPT Image contracts); the
  // endpoint itself is selected by supported_endpoint_types in the catalog.
  return /^(?:gpt-)?image-/iu.test(model.trim())
}

function isImage2Model(model: string): boolean {
  return /^(?:gpt-)?image-2(?:$|-)/iu.test(model.trim())
}

function isOutputFormat(value: unknown): value is ImageOutputFormat {
  return value === 'png' || value === 'jpeg' || value === 'webp'
}

function isBackground(value: unknown): value is ImageBackground {
  return value === 'transparent' || value === 'opaque' || value === 'auto'
}

function isModeration(value: unknown): value is ImageModeration {
  return value === 'low' || value === 'auto'
}

function normalizeImagesPath(value: unknown): string {
  try {
    const path = normalizeNativePath(value)
    if (path.includes('?')) throw new Error('invalid_endpoint')
    return path
  } catch {
    throw new ImagesClientError('invalid_endpoint')
  }
}

function buildImagesRequestUrl(
  baseUrl: unknown,
  endpointPath: unknown,
  defaultSuffix: '/images/generations' | '/images/edits'
): string {
  try {
    const normalizedBaseUrl = normalizeImagesBaseUrl(baseUrl)
    const basePath = new URL(normalizedBaseUrl).pathname.replace(/\/+$/u, '')
    const path = endpointPath === undefined
      ? `${/(?:^|\/)v1$/iu.test(basePath) ? '' : '/v1'}${defaultSuffix}`
      : normalizeImagesPath(endpointPath)
    return joinNativeEndpoint(normalizedBaseUrl, normalizeImagesPath(path))
  } catch (error) {
    if (error instanceof ImagesClientError) throw error
    throw new ImagesClientError('invalid_endpoint')
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new ImagesClientError('invalid_response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new ImagesClientError('invalid_response')
      total += next.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new ImagesClientError('response_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* best effort */ }
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function discardResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* never expose remote body */ }
}

function classifyRemoteFailure(status: number): ImagesRemoteFailure {
  if (status === 401 || status === 403) return 'authorization'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'server_error'
  return 'request_rejected'
}

function isRemoteFailure(value: unknown): value is ImagesRemoteFailure {
  return value === 'authorization' || value === 'rate_limited' || value === 'server_error' || value === 'request_rejected'
}

function normalizeRequestOptions(value: unknown): AbortSignal | undefined {
  if (!hasOnlyKeys(value, ['signal'])) throw new ImagesClientError('invalid_configuration')
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw new ImagesClientError('invalid_configuration')
  return value.signal as AbortSignal | undefined
}

function configurationInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ImagesClientError('invalid_configuration')
  }
  return value
}

function invalidInput(): never {
  throw new ImagesClientError('invalid_input')
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isObjectLike(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function hasExactKeys<K extends string>(value: unknown, expectedKeys: readonly K[]): value is Record<K, unknown> {
  if (!hasOnlyKeys(value, expectedKeys)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}
