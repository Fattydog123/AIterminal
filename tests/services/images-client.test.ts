import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildImagesEditRequestUrl,
  buildImagesGenerationRequestUrl,
  imagesEndpointProtocolForDeclaredType,
  ImagesClientError,
  OpenAICompatibleImagesClient,
  normalizeImagesBaseUrl
} from '../../src/main/services/images-client.ts'
import {
  isGptImage2Model,
  isGptImageModel,
  supportsImageInputFidelity,
  supportsImageSeed,
  usesImageArrayFormField
} from '../../src/studio/core/imageModels.ts'
import { providerCapabilityProfile } from '../../src/studio/core/providerCapabilities.ts'

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('generated-image-client-test')
])
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('generated-image-client-test'),
  Buffer.from([0xff, 0xd9])
])
const CREDENTIALS = {
  baseUrl: 'https://images.example.test/v1',
  apiKey: 'sk-test-images-12345678'
}

function responseWithImage(bytes = PNG): Response {
  return new Response(JSON.stringify({
    data: [{ b64_json: bytes.toString('base64'), revised_prompt: 'safe revision' }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('generates through the Images endpoint and returns ImageResultStore-compatible PNG data', async () => {
  let requestUrl = ''
  let requestInit: RequestInit | undefined
  const client = new OpenAICompatibleImagesClient({
    fetcher: (async (input, init) => {
      requestUrl = String(input)
      requestInit = init
      return responseWithImage()
    }) as typeof fetch
  })

  const result = await client.generate(CREDENTIALS, {
    model: 'gpt-image-2',
    prompt: 'Draw a quiet terminal workspace.',
    n: 1,
    size: '1024x1024',
    quality: 'high',
    outputFormat: 'png',
    background: 'opaque',
    moderation: 'auto',
    extra: { user: 'desktop-client' }
  })

  assert.equal(requestUrl, 'https://images.example.test/v1/images/generations')
  assert.equal(requestInit?.method, 'POST')
  assert.equal(requestInit?.redirect, 'manual')
  assert.equal(requestInit?.credentials, 'omit')
  assert.equal(new Headers(requestInit?.headers).get('authorization'), `Bearer ${CREDENTIALS.apiKey}`)
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    user: 'desktop-client',
    model: 'gpt-image-2',
    prompt: 'Draw a quiet terminal workspace.',
    n: 1,
    size: '1024x1024',
    quality: 'high',
    output_format: 'png',
    background: 'opaque',
    moderation: 'auto'
  })
  assert.deepEqual(result, {
    generatedImages: [{
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`
    }]
  })
})

test('treats image-2 and gpt-image-2 as the same Image 2 request contract', async () => {
  const bodies = new Map<string, Record<string, unknown>>()
  const client = new OpenAICompatibleImagesClient({
    fetcher: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.set(String(body.model), body)
      return responseWithImage()
    }) as typeof fetch
  })

  for (const model of ['image-2', 'gpt-image-2']) {
    assert.equal(isGptImage2Model(model), true)
    assert.equal(isGptImageModel(model), true)
    assert.equal(supportsImageSeed(model), false)
    assert.equal(supportsImageInputFidelity(model), false)
    assert.equal(usesImageArrayFormField(model), true)
    assert.deepEqual(providerCapabilityProfile({ kind: 'openai-compatible', model }), {
      generation: 'supported',
      editing: 'supported',
      referenceImages: 'supported',
      seed: 'unsupported',
      size: 'supported',
      outputFormat: 'supported',
      sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
      outputFormats: ['png', 'jpeg', 'webp'],
    })
    await client.generate(CREDENTIALS, { model, prompt: 'Draw the same contract.' })
  }

  for (const body of bodies.values()) {
    assert.equal(body.output_format, 'png')
    assert.equal(body.response_format, undefined)
  }

  // Provider names are opaque. Future Grok/Gemini transports must be selected
  // from a server declaration, not guessed from a model ID.
  for (const opaqueModel of ['grok-image-future', 'gemini-image-future']) {
    assert.equal(isGptImage2Model(opaqueModel), false)
    assert.equal(isGptImageModel(opaqueModel), false)
    assert.equal(supportsImageSeed(opaqueModel), false)
    assert.equal(providerCapabilityProfile({ kind: 'openai-compatible', model: opaqueModel }).seed, 'unsupported')
  }
})

test('selects the image wire protocol only from the server endpoint declaration', () => {
  assert.equal(imagesEndpointProtocolForDeclaredType('image-generation'), 'openai-images')
  assert.equal(imagesEndpointProtocolForDeclaredType('gemini'), null)
  assert.equal(imagesEndpointProtocolForDeclaredType('grok-image-future'), null)
  assert.equal(imagesEndpointProtocolForDeclaredType('gemini-image-future'), null)
})

test('defaults generic OpenAI-compatible image models to base64 and appends v1 to an origin', async () => {
  let requestUrl = ''
  let body: Record<string, unknown> = {}
  const client = new OpenAICompatibleImagesClient({
    fetcher: (async (input, init) => {
      requestUrl = String(input)
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return responseWithImage()
    }) as typeof fetch
  })

  await client.generations(
    { baseUrl: 'https://gateway.example.test', apiKey: CREDENTIALS.apiKey },
    { model: 'provider-image-model', prompt: 'A dashboard.', extra: { seed: 42 } }
  )

  assert.equal(requestUrl, 'https://gateway.example.test/v1/images/generations')
  assert.equal(body.response_format, 'b64_json')
  assert.equal(body.seed, 42)
  assert.equal(body.output_format, undefined)
})

test('uses confirmed generation and edit paths while rejecting unsafe route metadata', async () => {
  const requestUrls: string[] = []
  const client = new OpenAICompatibleImagesClient({
    fetcher: (async (input) => {
      requestUrls.push(String(input))
      return responseWithImage()
    }) as typeof fetch
  })

  await client.generate(CREDENTIALS, {
    model: 'gpt-image-2',
    prompt: 'Use the confirmed route.',
    endpointPath: '/v1/custom/images/generations'
  })
  await client.edit(CREDENTIALS, {
    model: 'gpt-image-1',
    prompt: 'Use the confirmed edit route.',
    endpointPath: '/v1/custom/images/edits',
    image: { bytes: PNG, mimeType: 'image/png', filename: 'source.png' }
  })

  assert.deepEqual(requestUrls, [
    'https://images.example.test/v1/custom/images/generations',
    'https://images.example.test/v1/custom/images/edits'
  ])
  assert.equal(
    buildImagesGenerationRequestUrl(CREDENTIALS.baseUrl, '/v1/images/generations'),
    'https://images.example.test/v1/images/generations'
  )
  assert.equal(
    buildImagesEditRequestUrl(CREDENTIALS.baseUrl, '/v1/images/edits'),
    'https://images.example.test/v1/images/edits'
  )
  for (const unsafePath of [
    '/../images/generations',
    '/%2e%2e/images/generations',
    '/images/generations?api_key=secret',
    '//outside.example.test/images/generations'
  ]) {
    assert.throws(
      () => buildImagesGenerationRequestUrl(CREDENTIALS.baseUrl, unsafePath),
      (error: unknown) => error instanceof ImagesClientError && error.code === 'invalid_endpoint'
    )
  }
})

test('serializes image-family edits as bounded multipart image arrays', async () => {
  let requestUrl = ''
  let body: FormData | undefined
  const client = new OpenAICompatibleImagesClient({
    fetcher: (async (input, init) => {
      requestUrl = String(input)
      body = init?.body as FormData
      return responseWithImage()
    }) as typeof fetch
  })

  const result = await client.edits(CREDENTIALS, {
    model: 'gpt-image-1',
    prompt: 'Add a small status icon.',
    image: {
      bytes: PNG,
      mimeType: 'image/png',
      filename: 'source.png'
    },
    inputFidelity: 'high',
    outputFormat: 'png'
  })

  assert.equal(requestUrl, 'https://images.example.test/v1/images/edits')
  assert.ok(body instanceof FormData)
  assert.equal(body.get('model'), 'gpt-image-1')
  assert.equal(body.get('prompt'), 'Add a small status icon.')
  assert.equal(body.get('output_format'), 'png')
  assert.equal(body.get('input_fidelity'), null)
  assert.equal(body.getAll('image[]').length, 1)
  assert.deepEqual(result.generatedImages[0], {
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${PNG.toString('base64')}`
  })
})

test('rejects unsafe inputs before dispatch', async () => {
  let calls = 0
  const client = new OpenAICompatibleImagesClient({
    fetcher: (async () => {
      calls += 1
      return responseWithImage()
    }) as typeof fetch
  })

  for (const request of [
    { model: 'gpt-image-2', prompt: 'x', extra: { seed: 1 } },
    { model: 'gpt-image-2', prompt: 'x', outputCompression: 80 },
    { model: 'gpt-image-2', prompt: 'x', background: 'transparent' },
    { model: 'gpt-image-2', prompt: 'x', extra: { api_key: 'not-allowed' } },
    { model: 'gpt-image-2', prompt: CREDENTIALS.apiKey }
  ]) {
    await assert.rejects(
      client.generate(CREDENTIALS, request as never),
      (error: unknown) => error instanceof ImagesClientError && error.code === 'invalid_input'
    )
  }
  await assert.rejects(
    client.generate(
      { baseUrl: 'http://remote.example.test/v1', apiKey: CREDENTIALS.apiKey },
      { model: 'gpt-image-2', prompt: 'x' }
    ),
    (error: unknown) => error instanceof ImagesClientError && error.code === 'invalid_endpoint'
  )
  assert.equal(calls, 0)
})

test('rejects redirects, oversized responses, and non-PNG result bytes without exposing bodies', async () => {
  const rawSecret = 'sk-upstream-secret-should-never-escape'
  const redirectClient = new OpenAICompatibleImagesClient({
    fetcher: (async () => new Response(rawSecret, {
      status: 307,
      headers: { Location: `https://redirect.example.test/?token=${rawSecret}` }
    })) as typeof fetch
  })
  await assert.rejects(
    redirectClient.generate(CREDENTIALS, { model: 'gpt-image-2', prompt: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof ImagesClientError)
      assert.equal(error.code, 'redirect_rejected')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /upstream-secret|redirect\.example/)
      return true
    }
  )

  const oversizedClient = new OpenAICompatibleImagesClient({
    maxResponseBytes: 1_024,
    maxImageBytes: 1_024,
    fetcher: (async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1025' }
    })) as typeof fetch
  })
  await assert.rejects(
    oversizedClient.generate(CREDENTIALS, { model: 'gpt-image-2', prompt: 'x' }),
    (error: unknown) => error instanceof ImagesClientError && error.code === 'response_too_large'
  )

  const jpegClient = new OpenAICompatibleImagesClient({
    fetcher: (async () => responseWithImage(JPEG)) as typeof fetch
  })
  await assert.rejects(
    jpegClient.generate(CREDENTIALS, {
      model: 'gpt-image-2',
      prompt: 'x',
      outputFormat: 'jpeg',
      outputCompression: 80
    }),
    (error: unknown) => error instanceof ImagesClientError && error.code === 'unsupported_image_format'
  )
})

test('classifies remote failures, caller cancellation, and timeout with sanitized errors', async () => {
  const rejected = new OpenAICompatibleImagesClient({
    fetcher: (async () => new Response('sk-private-upstream-body', { status: 429 })) as typeof fetch
  })
  await assert.rejects(
    rejected.generate(CREDENTIALS, { model: 'gpt-image-2', prompt: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof ImagesClientError)
      assert.equal(error.code, 'remote_rejected')
      assert.equal(error.retryable, true)
      assert.equal(error.remoteFailure, 'rate_limited')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /private-upstream/)
      return true
    }
  )

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  let cancellationCalls = 0
  const cancelled = new OpenAICompatibleImagesClient({
    fetcher: (async () => {
      cancellationCalls += 1
      return responseWithImage()
    }) as typeof fetch
  })
  await assert.rejects(
    cancelled.generate(CREDENTIALS, { model: 'gpt-image-2', prompt: 'x' }, { signal: alreadyAborted.signal }),
    (error: unknown) => error instanceof ImagesClientError && error.code === 'cancelled'
  )
  assert.equal(cancellationCalls, 0)

  const timedOut = new OpenAICompatibleImagesClient({
    timeoutMs: 10,
    fetcher: ((_, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('sk-network-secret-12345678')), { once: true })
    })) as typeof fetch
  })
  await assert.rejects(
    timedOut.generate(CREDENTIALS, { model: 'gpt-image-2', prompt: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof ImagesClientError)
      assert.equal(error.code, 'timeout')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /network-secret/)
      return true
    }
  )
})

test('normalizes HTTPS and loopback roots but rejects query-bearing endpoints', () => {
  assert.equal(normalizeImagesBaseUrl('https://images.example.test/v1/'), 'https://images.example.test/v1')
  assert.equal(normalizeImagesBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
  assert.throws(
    () => normalizeImagesBaseUrl('https://images.example.test/v1?region=test'),
    (error: unknown) => error instanceof ImagesClientError && error.code === 'invalid_endpoint'
  )
})
