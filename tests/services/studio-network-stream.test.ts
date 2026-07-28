import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createJiti } from 'jiti'

import type { OpenAiProviderDescriptor } from '../../src/studio/shared/types.ts'

const electronStubPath = fileURLToPath(new URL('../security/fixtures/electron-main-stub.ts', import.meta.url))
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlJv1sAAAAASUVORK5CYII='

const descriptor = (maximumImageBytes = 1_048_576): OpenAiProviderDescriptor => ({
  id: 'account-group-stream-test',
  name: 'Stream test group',
  kind: 'openai-compatible',
  baseUrl: 'https://relay.example.test/v1',
  defaultModel: 'gpt-image-2-2k',
  timeoutMs: 30_000,
  maxImageBytes: maximumImageBytes,
  proxyMode: 'system',
  hasSecret: true,
  maskedSecret: 'Account session',
  managedBy: 'ai-terminal-account',
  imageGenerationPath: '/v1/images/generations',
  availableModels: ['gpt-image-2-2k'],
})

const loadNetwork = async (fetcher: (url: string, init: RequestInit) => Promise<Response>) => {
  const jiti = createJiti(import.meta.url, {
    alias: { electron: electronStubPath },
    fsCache: false,
    moduleCache: true,
  })
  const electron = await jiti.import<typeof import('../security/fixtures/electron-main-stub.ts')>(
    electronStubPath,
  )
  Object.assign(electron.session, {
    defaultSession: { fetch: fetcher },
    fromPartition: () => ({
      setProxy: async () => undefined,
      fetch: fetcher,
    }),
  })
  return jiti.import<typeof import('../../src/main/studio/network.ts')>(
    '../../src/main/studio/network.ts',
  )
}

const streamResponse = (chunks: readonly Uint8Array[], contentType = 'text/event-stream; charset=utf-8'): Response => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  }),
  { status: 200, headers: { 'Content-Type': contentType } },
)

const splitEveryByte = (value: string): readonly Uint8Array[] => {
  const bytes = new TextEncoder().encode(value)
  return [...bytes].map((byte) => Uint8Array.of(byte))
}

const event = (type: string, payload: Readonly<Record<string, unknown>>, newline = '\r\n'): string => [
  `event: ${type}`,
  `data: ${JSON.stringify({ type, ...payload })}`,
  '',
  '',
].join(newline)

const assertStudioError = (code: string, dispatchState: string) => (error: unknown): boolean => {
  const value = error as { code?: unknown; dispatchState?: unknown }
  assert.equal(value.code, code)
  assert.equal(value.dispatchState, dispatchState)
  return true
}

test('GPT Image generation requests SSE and decodes only the completed image across CRLF byte splits', async () => {
  const requests: { url: string; init: RequestInit }[] = []
  const phases: string[] = []
  let dispatches = 0
  const wire = [
    ': keepalive\r\n\r\n',
    event('image_generation.partial_image', { partial_image_index: 0, b64_json: pngBase64 }),
    event('image_generation.completed', { b64_json: pngBase64, revised_prompt: 'Refined prompt' }),
  ].join('')
  const network = await loadNetwork(async (url, init) => {
    requests.push({ url, init })
    return streamResponse(splitEveryByte(wire))
  })

  const images = await network.generateImages({
    descriptor: descriptor(),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
    onDispatch: () => { dispatches += 1 },
    onPhase: (phase, state) => { phases.push(`${phase}:${state}`) },
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Draw one pixel.',
    count: 1,
    quality: 'high',
    outputFormat: 'png',
  })

  assert.equal(requests.length, 1)
  assert.equal(dispatches, 1)
  assert.equal(requests[0]?.url, 'https://relay.example.test/v1/images/generations')
  const headers = new Headers(requests[0]?.init.headers)
  assert.equal(headers.get('accept'), 'text/event-stream')
  assert.equal(headers.get('content-type'), 'application/json')
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    model: 'gpt-image-2-2k',
    prompt: 'Draw one pixel.',
    quality: 'high',
    n: 1,
    output_format: 'png',
    stream: true,
    partial_images: 1,
  })
  assert.equal(images.length, 1)
  assert.equal(images[0]?.mediaType, 'image/png')
  assert.equal(images[0]?.revisedPrompt, 'Refined prompt')
  assert.deepEqual(phases, ['decode:start', 'decode:finish'])
})

test('GPT Image accepts a non-SSE JSON response without a second request', async () => {
  let requests = 0
  const network = await loadNetwork(async () => {
    requests += 1
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  const images = await network.generateImages({
    descriptor: descriptor(),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Return JSON despite stream negotiation.',
    count: 1,
  })

  assert.equal(requests, 1)
  assert.equal(images[0]?.mediaType, 'image/png')
})

test('GPT Image falls back once when a compatible server explicitly rejects stream fields', async () => {
  const requests: RequestInit[] = []
  let dispatches = 0
  const network = await loadNetwork(async (_url, init) => {
    requests.push(init)
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          param: 'partial_images',
          message: 'partial_images is not supported by this Images endpoint',
        },
      }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  const images = await network.generateImages({
    descriptor: descriptor(),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
    onDispatch: () => { dispatches += 1 },
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Use the legacy JSON protocol.',
    count: 1,
  })

  assert.equal(requests.length, 2)
  assert.equal(dispatches, 1)
  const firstBody = JSON.parse(String(requests[0]?.body)) as Record<string, unknown>
  const secondBody = JSON.parse(String(requests[1]?.body)) as Record<string, unknown>
  assert.equal(firstBody.stream, true)
  assert.equal(firstBody.partial_images, 1)
  assert.equal('stream' in secondBody, false)
  assert.equal('partial_images' in secondBody, false)
  assert.equal(new Headers(requests[0]?.headers).get('accept'), 'text/event-stream')
  assert.equal(new Headers(requests[1]?.headers).get('accept'), 'application/json')
  assert.equal(images[0]?.mediaType, 'image/png')
})

test('GPT Image does not retry a generic validation error that happens to mention a stream', async () => {
  let requests = 0
  const network = await loadNetwork(async () => {
    requests += 1
    return new Response(JSON.stringify({
      error: { message: 'prompt is invalid while stream mode is enabled' },
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  await assert.rejects(network.generateImages({
    descriptor: descriptor(),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Do not retry this request.',
    count: 1,
  }), assertStudioError('provider-http-error', 'sent'))

  assert.equal(requests, 1)
})

test('GPT Image rejects an SSE stream without a completed event', async () => {
  const network = await loadNetwork(async () => streamResponse(splitEveryByte(
    event('image_generation.partial_image', { partial_image_index: 0, b64_json: pngBase64 }, '\n'),
  )))

  await assert.rejects(network.generateImages({
    descriptor: descriptor(),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Never complete.',
    count: 1,
  }), assertStudioError('provider-stream-incomplete', 'sent'))
})

test('GPT Image bounds SSE bytes before accepting an oversized event', async () => {
  const oversized = event('image_generation.partial_image', {
    partial_image_index: 0,
    b64_json: 'A'.repeat(2_100_000),
  })
  const network = await loadNetwork(async () => streamResponse([new TextEncoder().encode(oversized)]))

  await assert.rejects(network.generateImages({
    descriptor: descriptor(64),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Bound the stream.',
    count: 1,
  }), assertStudioError('response-too-large', 'sent'))
})

test('GPT Image surfaces HTTP errors after exactly one dispatched request', async () => {
  let requests = 0
  let dispatches = 0
  const network = await loadNetwork(async () => {
    requests += 1
    return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), {
      status: 503,
      statusText: 'Unavailable',
      headers: { 'Content-Type': 'application/json' },
    })
  })

  await assert.rejects(network.generateImages({
    descriptor: descriptor(),
    apiKey: 'stream-test-key',
    ensureEndpointConsent: async () => undefined,
    onDispatch: () => { dispatches += 1 },
  }, {
    model: 'gpt-image-2-2k',
    prompt: 'Do not retry.',
    count: 1,
  }), assertStudioError('provider-http-error', 'sent'))

  assert.equal(requests, 1)
  assert.equal(dispatches, 1)
})
