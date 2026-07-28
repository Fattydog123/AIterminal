import { join } from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'

import { app, session } from 'electron'

import { createElectronSafeStorageCipher, SecureStore } from '../../src/main/security/secure-store.ts'
import { SecureRelayCredentialStorage } from '../../src/main/services/relay-credential-storage.ts'
import { RelayService } from '../../src/main/services/relay-service.ts'
import { buildImagesGenerationRequestUrl } from '../../src/main/services/images-client.ts'
import { StudioAccountProviderAdapter } from '../../src/main/studio/account-providers.ts'
import { StudioImageCapabilityStore } from '../../src/main/studio/image-capability-store.ts'
import { imageDimensions, generateImages } from '../../src/main/studio/network.ts'
import type { OpenAiProviderDescriptor } from '../../src/studio/shared/types.ts'

const USER_DATA_PATH = process.env.AI_TERMINAL_DIAGNOSTIC_USER_DATA_PATH?.trim()
  || 'C:\\Users\\zz182\\AppData\\Roaming\\ai-terminal'
const TARGET_MODEL = process.argv[2]?.trim() || 'gpt-image-2-high'
const REQUEST_VARIANT = process.argv[3] === 'minimal' || process.argv[3] === 'stream'
  ? process.argv[3]
  : 'full'
const IMAGE_ENDPOINT = /\/images\/generations(?:\?|$)/u
const RESULT_PATH = join(process.cwd(), 'output', 'live-studio-generation-diagnostic.jsonl')

interface HttpObservation {
  status?: number
  networkError?: string
  completed: boolean
}

const observation: HttpObservation = { completed: false }

const safeError = (error: unknown): Readonly<Record<string, unknown>> => {
  const value = error instanceof Error ? error : undefined
  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : undefined
  const message = value?.message ?? ''
  return Object.freeze({
    name: value?.name ?? 'UnknownError',
    code: typeof record?.code === 'string' ? record.code : 'unknown',
    dispatchState: typeof record?.dispatchState === 'string' ? record.dispatchState : 'unknown',
    messageKind: message.startsWith('接口请求失败：')
      ? 'http-error'
      : message.includes('连接中断')
        ? 'network-interrupted'
        : message.includes('超时')
          ? 'timeout'
          : 'other',
    messageLength: message.length,
    recommendsBalancedSibling: message.includes('gpt-image-2-2k'),
  })
}

const print = (stage: string, data: Readonly<Record<string, unknown>>): void => {
  const line = `${JSON.stringify({ stage, ...data })}\n`
  appendFileSync(RESULT_PATH, line, { encoding: 'utf8' })
  process.stdout.write(line)
}

const streamedImage = (encoded: string): { bytes: Buffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } => {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { bytes, mediaType: 'image/png' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, mediaType: 'image/jpeg' }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { bytes, mediaType: 'image/webp' }
  }
  throw new Error('streamed-image-invalid')
}

const redactedHttpFailure = async (response: Response): Promise<Readonly<Record<string, unknown>>> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? null
  const text = (await response.text()).slice(0, 262_144)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return Object.freeze({
      status: response.status,
      contentType,
      bodyKind: text ? 'non-json' : 'empty',
      bodyLength: text.length,
    })
  }
  const root = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  const nested = typeof root?.error === 'object' && root.error !== null
    ? root.error as Record<string, unknown>
    : undefined
  const message = typeof nested?.message === 'string'
    ? nested.message
    : typeof root?.message === 'string'
      ? root.message
      : ''
  const normalizedMessage = message.toLowerCase()
  return Object.freeze({
    status: response.status,
    contentType,
    bodyKind: 'json',
    rootKeys: root ? Object.keys(root).sort() : [],
    errorKeys: nested ? Object.keys(nested).sort() : [],
    errorType: typeof nested?.type === 'string' ? nested.type : null,
    errorCode: typeof nested?.code === 'string' ? nested.code : null,
    errorParam: typeof nested?.param === 'string' ? nested.param : null,
    messageLength: message.length,
    mentionsStream: normalizedMessage.includes('stream'),
    mentionsPartialImages: normalizedMessage.includes('partial_images') || normalizedMessage.includes('partial images'),
    mentionsUnsupported: normalizedMessage.includes('unsupported') || normalizedMessage.includes('not support'),
    mentionsInvalid: normalizedMessage.includes('invalid'),
  })
}

const generateStreamingImage = async (
  descriptor: OpenAiProviderDescriptor,
  apiKey: string,
): Promise<Readonly<Record<string, unknown>>> => {
  const startedAt = Date.now()
  print('dispatch', { sent: true, endpointKind: 'images-generations-stream' })
  const response = await session.defaultSession.fetch(buildImagesGenerationRequestUrl(
    descriptor.baseUrl,
    descriptor.imageGenerationPath,
  ), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TARGET_MODEL,
      prompt: 'A small blue circle centered on a plain white background.',
      n: 1,
      stream: true,
      partial_images: 1,
    }),
  })
  if (!response.ok) {
    print('http-failure', await redactedHttpFailure(response))
    throw new Error(`stream-http-${response.status}`)
  }
  if (!response.body) throw new Error('stream-body-missing')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let firstEventMs: number | undefined
  let partialCount = 0
  let finalImage: ReturnType<typeof streamedImage> | undefined
  const eventTypes: string[] = []
  while (true) {
    const next = await reader.read()
    pending += decoder.decode(next.value, { stream: !next.done }).replaceAll('\r\n', '\n')
    if (pending.length > 160_000_000) throw new Error('stream-response-too-large')
    let boundary = pending.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      const data = frame.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data && data !== '[DONE]') {
        const event = JSON.parse(data) as Record<string, unknown>
        const type = typeof event.type === 'string' ? event.type : 'unknown'
        if (firstEventMs === undefined) firstEventMs = Date.now() - startedAt
        eventTypes.push(type)
        if (type === 'image_generation.partial_image') partialCount += 1
        if (type === 'image_generation.completed' && typeof event.b64_json === 'string') {
          finalImage = streamedImage(event.b64_json)
        }
      }
      boundary = pending.indexOf('\n\n')
    }
    if (next.done) break
  }
  if (!finalImage) throw new Error('stream-completed-image-missing')
  return Object.freeze({
    elapsedMs: Date.now() - startedAt,
    firstEventMs: firstEventMs ?? null,
    httpStatus: response.status,
    contentType: response.headers.get('content-type')?.split(';', 1)[0] ?? null,
    partialCount,
    eventTypes,
    mediaType: finalImage.mediaType,
    byteLength: finalImage.bytes.byteLength,
    dimensions: imageDimensions(finalImage.bytes, finalImage.mediaType) ?? null,
  })
}

async function run(): Promise<void> {
  writeFileSync(RESULT_PATH, '', { encoding: 'utf8' })
  app.setPath('userData', USER_DATA_PATH)
  await app.whenReady()

  session.defaultSession.webRequest.onCompleted({ urls: ['https://*/*'] }, (details) => {
    if (!IMAGE_ENDPOINT.test(details.url)) return
    observation.status = details.statusCode
    observation.completed = true
  })
  session.defaultSession.webRequest.onErrorOccurred({ urls: ['https://*/*'] }, (details) => {
    if (!IMAGE_ENDPOINT.test(details.url)) return
    observation.networkError = details.error
  })

  const cipher = await createElectronSafeStorageCipher()
  const relayStrings = new SecureStore({
    filePath: join(USER_DATA_PATH, 'secure', 'relay-device-credential.json'),
    purpose: 'relay-device-credential',
    cipher,
  })
  const relay = new RelayService({
    credentialStorage: new SecureRelayCredentialStorage(relayStrings),
  })
  relay.confirmEndpoint(relay.serverOrigin)

  try {
    const imageCapabilities = new StudioImageCapabilityStore(
      relay.serverOrigin,
      Date.now,
      join(USER_DATA_PATH, 'studio', 'state', 'image-capabilities.json'),
    )
    const adapter = new StudioAccountProviderAdapter(relay, Date.now, imageCapabilities)
    const providers = await adapter.list()
    const provider = providers.find((item) => item.availableModels?.includes(TARGET_MODEL))
    if (!provider) {
    print('catalog', {
      ok: false,
      authenticated: relay.getAuthenticationState().authenticated,
      providerCount: providers.length,
      targetModelPresent: false,
      })
      process.exitCode = 2
      return
    }
    print('catalog', {
      ok: true,
      providerCount: providers.length,
      groupModelCount: provider.availableModels?.length ?? 0,
      providerDefaultModel: provider.defaultModel,
      targetModelPresent: true,
      endpointKind: 'images-generations',
      requestVariant: REQUEST_VARIANT,
    })

    const credentials = await adapter.credentials(provider.id, TARGET_MODEL)
    const phases: string[] = []
    const startedAt = Date.now()
    try {
      if (REQUEST_VARIANT === 'stream') {
        const result = await generateStreamingImage(credentials.descriptor, credentials.apiKey)
        print('result', { ok: true, ...result })
        return
      }
      const images = await generateImages({
        descriptor: credentials.descriptor,
        apiKey: credentials.apiKey,
        ensureEndpointConsent: async () => undefined,
        onDispatch: () => print('dispatch', { sent: true, endpointKind: 'images-generations' }),
        onPhase: (phase, state) => { phases.push(`${phase}:${state}`) },
      }, REQUEST_VARIANT === 'minimal'
        ? {
            model: TARGET_MODEL,
            prompt: 'A small blue circle centered on a plain white background.',
            count: 1,
          }
        : {
            model: TARGET_MODEL,
            prompt: 'A small blue circle centered on a plain white background.',
            count: 1,
            size: '1024x1024',
            quality: 'high',
            outputFormat: 'png',
            outputCompression: 100,
            background: 'auto',
            moderation: 'auto',
          })
      const first = images[0]
      print('result', {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        httpStatus: observation.status ?? null,
        imageCount: images.length,
        mediaType: first?.mediaType ?? null,
        byteLength: first?.bytes.byteLength ?? 0,
        dimensions: first ? imageDimensions(first.bytes, first.mediaType) ?? null : null,
        phases,
      })
    } catch (error) {
      print('result', {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        httpStatus: observation.status ?? null,
        networkError: observation.networkError ?? null,
        transportCompleted: observation.completed,
        ...safeError(error),
        phases,
      })
      process.exitCode = 1
    }
  } finally {
    await relay.shutdown()
  }
}

void run()
  .catch((error: unknown) => {
    print('harness-error', safeError(error))
    process.exitCode = 3
  })
  .finally(() => app.quit())
