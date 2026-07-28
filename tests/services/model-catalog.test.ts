import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeModelEndpointTypes,
  modelCatalogFromIds,
  ModelCatalogError,
  normalizeModelEndpointTypes,
  RemoteModelCatalogService,
  normalizeModelEndpoint
} from '../../src/main/services/model-catalog.ts'
import {
  buildRelayGroupModelCatalog,
  relayGroupModelIds,
  relayGroupModelIdsForEndpoint,
  relayModelIdsForEndpoint
} from '../../src/main/services/relay-model-catalog.ts'
import type { RelayPricingDto } from '../../src/main/services/relay-service.ts'
import {
  ConfirmedModelCatalogStore,
  type ConfirmedModelCatalog
} from '../../src/main/services/confirmed-model-catalog-store.ts'
import {
  isModelCapabilityExplicitlySupported,
  isModelCapabilityExplicitlyUnsupported,
  isModelReasoningExplicitlyUnsupported,
  isValidModelId
} from '../../src/shared/contracts.ts'

function pricingModel(
  modelName: string,
  enableGroups: readonly string[],
  endpointTypes: readonly string[]
): RelayPricingDto['data'][number] {
  return {
    model_name: modelName,
    quota_type: 0,
    model_ratio: 1,
    model_price: 0,
    owner_by: 'test',
    completion_ratio: 1,
    enable_groups: enableGroups,
    supported_endpoint_types: endpointTypes
  }
}

function confirmedCatalog(
  profileHandle: string,
  mode: 'chat' | 'agent',
  groupId: string,
  generation: number
): ConfirmedModelCatalog {
  return {
    profileHandle,
    mode,
    groupId,
    generation,
    models: [],
    endpointRoutes: {}
  }
}

test('model endpoint accepts HTTPS and loopback HTTP but rejects credential-bearing URLs', () => {
  assert.equal(normalizeModelEndpoint('https://example.test/v1/'), 'https://example.test/v1')
  assert.equal(normalizeModelEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
  assert.throws(() => normalizeModelEndpoint('http://example.test/v1'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpoint('https://user:secret@example.test/v1'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpoint('https://example.test/v1?token=secret'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpoint('https://example.test/v1#secret'), ModelCatalogError)
})

test('model ids use the same bounded grammar as turn start requests', () => {
  assert.equal(isValidModelId('provider/model:variant_1.2-3'), true)
  assert.equal(isValidModelId('-leading-separator'), false)
  assert.equal(isValidModelId('contains space'), false)
  assert.equal(isValidModelId('\u6a21\u578b'), false)
  assert.equal(isValidModelId(`m${'x'.repeat(256)}`), false)
})

test('models without endpoint metadata default to Agent-capable Chat Completions and never infer protocol from the id', () => {
  const models = modelCatalogFromIds(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol'], 'agent')
  assert.deepEqual(models.map((model) => model.id), ['gpt-5.6-luna', 'gpt-5.6-sol'])
  assert.ok(models.every((model) => model.source === 'remote'))
  assert.ok(models.every((model) => (
    model.modes.length === 2 && model.modes.includes('chat') && model.modes.includes('agent')
  )))
  assert.ok(models.every((model) => model.endpointTypes.length === 1 && model.endpointTypes[0] === 'openai'))
  assert.ok(models.every((model) => model.declaredEndpointTypes === undefined))
  assert.ok(models.every((model) => model.preferredChatEndpoint === 'openai'))
  assert.ok(models.every((model) => model.preferredChatTransport === 'chat-completions'))
  assert.ok(models.every((model) => model.wireMode === 'standard'))
  assert.ok(models.every((model) => model.capabilities.webSearch === false))
  assert.throws(() => modelCatalogFromIds(['contains space'], 'chat'), ModelCatalogError)
})

test('relay catalogs use exact group ids and server endpoint declarations without model-name inference', () => {
  const pricing: RelayPricingDto = {
    data: [
      pricingModel('chat-model', ['default'], ['openai']),
      pricingModel('responses-model', ['default', 'vip'], ['openai-response']),
      pricingModel('claude-looking-gpt', ['vip'], ['anthropic']),
      pricingModel('gemini-model', ['vip'], ['gemini']),
      pricingModel('claude-looks-openai', ['vip'], ['openai', 'anthropic']),
      pricingModel('gemini-looks-anthropic', ['vip'], ['anthropic', 'gemini']),
      pricingModel('image-2', ['vip'], ['image-generation']),
      pricingModel('auto-image', ['image'], ['image-generation']),
      pricingModel('all-image', ['all'], ['image-generation']),
      pricingModel('future-model', ['vip'], ['future-protocol'])
    ],
    auto_groups: ['default', 'image']
  }
  const accountModels = [
    'chat-model',
    'responses-model',
    'claude-looking-gpt',
    'gemini-model',
    'claude-looks-openai',
    'gemini-looks-anthropic',
    'image-2',
    'auto-image',
    'all-image',
    'future-model',
    'missing-endpoint-metadata'
  ]

  assert.deepEqual(relayGroupModelIds(accountModels, pricing, 'vip'), [
    'responses-model',
    'claude-looking-gpt',
    'gemini-model',
    'claude-looks-openai',
    'gemini-looks-anthropic',
    'image-2',
    'all-image',
    'future-model'
  ])
  assert.deepEqual(relayGroupModelIdsForEndpoint(accountModels, pricing, 'vip', 'image-generation'), [
    'image-2',
    'all-image'
  ])
  assert.deepEqual(relayGroupModelIdsForEndpoint(accountModels, pricing, 'auto', 'image-generation'), [
    'auto-image',
    'all-image'
  ])
  assert.deepEqual(relayModelIdsForEndpoint(
    ['image-2', 'chat-model'],
    pricing,
    'image-generation'
  ), ['image-2'])

  const chatCatalog = buildRelayGroupModelCatalog({
    groupModelIds: [
      'responses-model',
      'claude-looking-gpt',
      'gemini-model',
      'claude-looks-openai',
      'gemini-looks-anthropic',
      'image-2',
      'future-model',
      'missing-endpoint-metadata'
    ],
    pricing,
    remoteModels: [],
    mode: 'chat'
  })
  assert.deepEqual(chatCatalog.map((model) => model.id), [
    'claude-looking-gpt',
    'claude-looks-openai',
    'gemini-looks-anthropic',
    'gemini-model',
    'responses-model'
  ])
  assert.equal(chatCatalog.find((model) => model.id === 'claude-looking-gpt')?.preferredChatTransport, 'anthropic')
  assert.equal(chatCatalog.find((model) => model.id === 'claude-looks-openai')?.preferredChatTransport, 'chat-completions')
  assert.equal(chatCatalog.find((model) => model.id === 'gemini-looks-anthropic')?.preferredChatTransport, 'anthropic')
  assert.equal(chatCatalog.some((model) => model.id === 'image-2'), false)

  const agentCatalog = buildRelayGroupModelCatalog({
    groupModelIds: accountModels,
    pricing,
    remoteModels: [],
    mode: 'agent'
  })
  assert.deepEqual(agentCatalog.map((model) => model.id), [
    'chat-model',
    'claude-looking-gpt',
    'claude-looks-openai',
    'gemini-looks-anthropic',
    'gemini-model',
    'responses-model'
  ])
})

test('relay Agent catalogs exclude models whose remote catalog explicitly disables tool use', () => {
  const pricing: RelayPricingDto = {
    data: [
      pricingModel('tool-capable', ['default'], ['openai-response']),
      pricingModel('tool-disabled', ['default'], ['openai-response'])
    ]
  }
  const remoteModels = modelCatalogFromIds(['tool-capable', 'tool-disabled'], 'agent').map((model) => (
    model.id === 'tool-disabled'
      ? {
          ...model,
          capabilities: { ...model.capabilities, toolUse: false },
          declaredCapabilities: { ...model.declaredCapabilities, toolUse: false }
        }
      : model
  ))

  const chatCatalog = buildRelayGroupModelCatalog({
    groupModelIds: ['tool-capable', 'tool-disabled'],
    pricing,
    remoteModels,
    mode: 'chat'
  })
  const agentCatalog = buildRelayGroupModelCatalog({
    groupModelIds: ['tool-capable', 'tool-disabled'],
    pricing,
    remoteModels,
    mode: 'agent'
  })

  assert.deepEqual(chatCatalog.map((model) => model.id), ['tool-capable', 'tool-disabled'])
  assert.deepEqual(agentCatalog.map((model) => model.id), ['tool-capable'])
})

test('relay catalogs apply exact official reasoning profiles from explicit vendor metadata', () => {
  const withVendor = (
    modelName: string,
    vendorId: number,
    endpointTypes: readonly string[]
  ): RelayPricingDto['data'][number] => ({
    ...pricingModel(modelName, ['default'], endpointTypes),
    owner_by: '',
    vendor_id: vendorId
  })
  const pricing: RelayPricingDto = {
    vendors: [
      { id: 1, name: 'OpenAI' },
      { id: 2, name: 'Anthropic' },
      { id: 4, name: 'xAI' },
      { id: 8, name: 'Google' }
    ],
    data: [
      withVendor('gpt-5.6-sol', 1, ['openai']),
      withVendor('gpt-5.6-luna', 1, ['openai-response']),
      withVendor('gpt-5.6-sol-copy', 1, ['openai']),
      withVendor('claude-opus-4-8', 2, ['anthropic', 'openai']),
      withVendor('claude-haiku-4-5-20251001', 2, ['anthropic']),
      withVendor('grok-4.3', 4, ['openai', 'openai-response']),
      withVendor('grok-4.5', 4, ['openai', 'openai-response']),
      withVendor('grok-4.20-multi-agent', 4, ['openai']),
      withVendor('gemini-3.5-flash', 8, ['gemini']),
      withVendor('gemini-2.5-pro', 8, ['gemini']),
      withVendor('gemini-2.5-flash', 8, ['gemini']),
      withVendor('gemini-2.5-flash-lite', 8, ['gemini'])
    ]
  }
  const modelIds = pricing.data.map((model) => model.model_name)
  const models = buildRelayGroupModelCatalog({
    groupModelIds: modelIds,
    pricing,
    remoteModels: [],
    mode: 'chat'
  })
  const byId = new Map(models.map((model) => [model.id, model] as const))

  assert.deepEqual(byId.get('gpt-5.6-sol')?.reasoning, [
    'auto', 'light', 'medium', 'high', 'xhigh', 'max', 'ultra'
  ])
  assert.deepEqual(byId.get('gpt-5.6-luna')?.reasoning, [
    'auto', 'light', 'medium', 'high', 'xhigh', 'max'
  ])
  assert.deepEqual(byId.get('grok-4.5')?.reasoning, [
    'auto', 'light', 'medium', 'high', 'xhigh'
  ])
  assert.equal(byId.get('grok-4.5')?.preferredChatEndpoint, 'openai')
  assert.equal(byId.get('grok-4.5')?.preferredAgentEndpoint, 'openai-response')
  assert.equal(byId.get('grok-4.3')?.preferredAgentEndpoint, 'openai-response')
  assert.equal(byId.get('gpt-5.6-sol')?.preferredAgentEndpoint, undefined)
  assert.deepEqual(byId.get('grok-4.3')?.reasoning, [
    'auto', 'none', 'light', 'medium', 'high', 'xhigh'
  ])
  assert.deepEqual(byId.get('grok-4.20-multi-agent')?.reasoning, ['auto'])
  assert.equal(byId.get('grok-4.20-multi-agent')?.reasoningProtocol, undefined)
  assert.deepEqual(byId.get('claude-opus-4-8')?.reasoning, [
    'auto', 'light', 'medium', 'high', 'xhigh', 'max'
  ])
  assert.deepEqual(byId.get('claude-opus-4-8')?.reasoningProtocol, {
    type: 'anthropic-adaptive'
  })
  assert.deepEqual(byId.get('gemini-3.5-flash')?.reasoning, [
    'auto', 'minimal', 'light', 'medium', 'high'
  ])
  assert.deepEqual(byId.get('gemini-3.5-flash')?.reasoningProtocol, {
    type: 'gemini-level'
  })
  assert.deepEqual(byId.get('gemini-2.5-pro')?.reasoning, [
    'auto', 'light', 'medium', 'high'
  ])
  assert.deepEqual(byId.get('gemini-2.5-pro')?.reasoningProtocol, {
    type: 'gemini-budget',
    budgets: { light: 1_024, medium: 8_192, high: 32_768 }
  })
  assert.deepEqual(byId.get('gemini-2.5-flash')?.reasoning, [
    'auto', 'none', 'light', 'medium', 'high'
  ])
  assert.deepEqual(byId.get('gemini-2.5-flash')?.reasoningProtocol, {
    type: 'gemini-budget',
    budgets: { none: 0, light: 1_024, medium: 8_192, high: 24_576 }
  })
  assert.deepEqual(byId.get('gemini-2.5-flash-lite')?.reasoning, [
    'auto', 'none', 'light', 'medium', 'high'
  ])
  assert.deepEqual(byId.get('claude-haiku-4-5-20251001')?.reasoning, ['auto'])
  assert.deepEqual(byId.get('gpt-5.6-sol-copy')?.reasoning, ['auto'])

  const original = modelCatalogFromIds(['gpt-5.6-sol'], 'chat')[0]!
  const remoteLimited = {
    ...original,
    reasoning: ['auto', 'high'] as Array<'auto' | 'high'>,
    declaredReasoning: ['auto', 'high'] as Array<'auto' | 'high'>
  }
  const remoteWins = buildRelayGroupModelCatalog({
    groupModelIds: ['gpt-5.6-sol'],
    pricing,
    remoteModels: [remoteLimited],
    mode: 'chat'
  })
  assert.deepEqual(remoteWins[0]?.reasoning, ['auto', 'high'])

  const remoteProtocolOnly = {
    ...mergeModelEndpointTypes(
      modelCatalogFromIds(['gemini-3.5-flash'], 'chat')[0]!,
      ['gemini']
    ),
    reasoningProtocol: {
      type: 'gemini-level',
      includeThoughts: false
    } as const
  }
  const protocolWins = buildRelayGroupModelCatalog({
    groupModelIds: ['gemini-3.5-flash'],
    pricing,
    remoteModels: [remoteProtocolOnly],
    mode: 'chat'
  })
  assert.deepEqual(protocolWins[0]?.reasoning, [
    'auto', 'minimal', 'light', 'medium', 'high'
  ])
  assert.deepEqual(protocolWins[0]?.reasoningProtocol, {
    type: 'gemini-level',
    includeThoughts: false
  })
})

test('token status changes invalidate every confirmed catalog for the relay profile', () => {
  const store = new ConfirmedModelCatalogStore()
  const relayProfile = 'relay-account'
  const otherProfile = 'other-account'
  const staleChat = confirmedCatalog(relayProfile, 'chat', 'default', 0)
  const staleAgent = confirmedCatalog(relayProfile, 'agent', 'vip', 0)
  const unrelated = confirmedCatalog(otherProfile, 'chat', 'default', 0)
  store.set(staleChat)
  store.set(staleAgent)
  store.set(unrelated)

  // Active, disabled, and revoked token mutations all take this same invalidation path.
  store.invalidateProfile(relayProfile)
  assert.equal(store.generation(relayProfile), 1)
  assert.equal(store.get(relayProfile, 'chat', 'default'), undefined)
  assert.equal(store.get(relayProfile, 'agent', 'vip'), undefined)
  assert.equal(store.isCurrent(staleChat), false)
  assert.equal(store.isCurrent(staleAgent), false)
  assert.equal(store.get(otherProfile, 'chat', 'default'), unrelated)
  assert.equal(store.isCurrent(unrelated), true)

  const refreshed = confirmedCatalog(relayProfile, 'agent', 'default', 1)
  store.set(refreshed)
  assert.equal(store.isCurrent(refreshed), true)

  store.invalidateProfile(relayProfile)
  store.invalidateProfile(relayProfile)
  assert.equal(store.generation(relayProfile), 3)
  assert.equal(store.isCurrent(refreshed), false)
})

test('endpoint declarations are read from top-level and metadata variants with strict routing', async () => {
  const service = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-5.6-sol' },
        {
          id: 'responses-model',
          supported_endpoint_types: ['openai-response'],
          capabilities: { webSearch: true, imageGeneration: true }
        },
        {
          id: 'metadata-model',
          metadata: { supportedEndpointTypes: ['openai'] }
        },
        {
          id: 'multi-model',
          endpointTypes: ['image-generation', 'openai', 'openai-response', 'openai'],
          metadata: { supported_endpoint_types: ['anthropic'] }
        },
        { id: 'anthropic-model', endpoint_types: ['anthropic'] },
        { id: 'gemini-model', metadata: { endpoint_types: ['gemini'] } },
        { id: 'image-2', supported_endpoint_types: ['image-generation'] },
        { id: 'compact-only', supported_endpoint_types: ['openai-response-compact'] },
        { id: 'non-chat', supported_endpoint_types: ['embeddings', 'openai-video'] },
        { id: 'future-protocol', supported_endpoint_types: ['future-protocol'] },
        { id: 'explicit-lite', supported_endpoint_types: ['openai-response'], use_responses_lite: true }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  })

  const models = await service.list(
    { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
    'agent'
  )
  const byId = new Map(models.map((model) => [model.id, model]))

  assert.equal(byId.get('gpt-5.6-sol')?.preferredChatTransport, 'chat-completions')
  assert.equal(byId.get('responses-model')?.preferredChatEndpoint, 'openai-response')
  assert.equal(byId.get('responses-model')?.preferredChatTransport, 'responses')
  assert.deepEqual(byId.get('responses-model')?.modes, ['chat', 'agent'])
  assert.equal(byId.get('responses-model')?.capabilities.toolUse, true)
  assert.equal(byId.get('responses-model')?.capabilities.webSearch, true)
  assert.equal(byId.get('metadata-model')?.preferredChatTransport, 'chat-completions')

  const multi = byId.get('multi-model')!
  assert.deepEqual(multi.endpointTypes, ['image-generation', 'openai', 'openai-response', 'anthropic'])
  assert.equal(multi.preferredChatEndpoint, 'openai')
  assert.equal(multi.preferredChatTransport, 'chat-completions')
  assert.equal(multi.capabilities.imageGeneration, true)
  assert.equal(multi.provider, 'openai-compatible')

  assert.equal(byId.get('anthropic-model')?.provider, 'anthropic-compatible')
  assert.equal(byId.get('anthropic-model')?.preferredChatTransport, 'anthropic')
  assert.deepEqual(byId.get('anthropic-model')?.modes, ['chat', 'agent'])
  assert.equal(byId.get('anthropic-model')?.capabilities.toolUse, true)
  assert.equal(byId.get('gemini-model')?.provider, 'gemini-compatible')
  assert.equal(byId.get('gemini-model')?.preferredChatTransport, 'gemini')
  assert.deepEqual(byId.get('gemini-model')?.modes, ['chat', 'agent'])
  assert.equal(byId.get('gemini-model')?.capabilities.toolUse, true)

  const image = byId.get('image-2')!
  assert.equal(image.preferredChatEndpoint, 'image-generation')
  assert.equal(image.preferredChatTransport, 'images')
  assert.deepEqual(image.modes, [])
  assert.equal(image.capabilities.imageGeneration, true)

  const compact = byId.get('compact-only')!
  assert.equal(compact.preferredChatEndpoint, 'openai-response-compact')
  assert.equal(compact.preferredChatTransport, 'unsupported')
  assert.deepEqual(compact.modes, [])
  assert.equal(compact.provider, 'unsupported')

  assert.deepEqual(byId.get('non-chat')?.endpointTypes, ['embeddings', 'openai-video'])
  assert.equal(byId.get('non-chat')?.preferredChatTransport, 'unsupported')
  assert.deepEqual(byId.get('future-protocol')?.endpointTypes, [])
  assert.equal(byId.get('future-protocol')?.declaredEndpointTypes?.length, 0)
  assert.equal(byId.get('future-protocol')?.preferredChatTransport, 'unsupported')
  assert.equal(byId.get('explicit-lite')?.wireMode, 'lite')
})

test('malformed endpoint declarations fail closed and endpoint pricing can replace the implicit default', () => {
  assert.deepEqual(normalizeModelEndpointTypes(['openai', 'openai', 'future']), ['openai'])
  assert.deepEqual(normalizeModelEndpointTypes([]), [])
  assert.throws(() => normalizeModelEndpointTypes('openai'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpointTypes(['openai', 1]), ModelCatalogError)

  const original = modelCatalogFromIds(['gpt-5.6-sol'], 'chat')[0]!
  const merged = mergeModelEndpointTypes(original, ['openai-response', 'image-generation'])
  assert.deepEqual(original.endpointTypes, ['openai'])
  assert.deepEqual(merged.endpointTypes, ['openai-response', 'image-generation'])
  assert.deepEqual(merged.declaredEndpointTypes, ['openai-response', 'image-generation'])
  assert.equal(merged.preferredChatEndpoint, 'openai-response')
  assert.equal(merged.preferredChatTransport, 'responses')
  assert.deepEqual(merged.modes, ['chat', 'agent'])
  assert.equal(merged.capabilities.toolUse, true)
  assert.equal(merged.capabilities.imageGeneration, true)

  const union = mergeModelEndpointTypes(merged, ['anthropic'])
  assert.deepEqual(union.endpointTypes, ['openai-response', 'image-generation', 'anthropic'])
  assert.equal(union.preferredChatTransport, 'responses')

  const unavailable = mergeModelEndpointTypes(original, ['future-protocol'])
  assert.deepEqual(unavailable.endpointTypes, [])
  assert.equal(unavailable.preferredChatTransport, 'unsupported')
  assert.deepEqual(unavailable.modes, [])
})

test('conflicting or malformed wire mode declarations fail closed', async () => {
  const conflicting = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [{
        id: 'conflicting-model',
        wire_mode: 'responses',
        use_responses_lite: true
      }]
    }), { status: 200 })) as typeof fetch
  })
  await assert.rejects(
    conflicting.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'invalid_response'
  )

  const malformed = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [{ id: 'malformed-model', use_responses_lite: 'true' }]
    }), { status: 200 })) as typeof fetch
  })
  await assert.rejects(
    malformed.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'invalid_response'
  )
})

test('remote catalog returns only submit-safe ids and only declared capabilities', async () => {
  const marker = 'test-key-never-returned'
  let observedUrl = ''
  let observedAuthorization = ''
  let observedRedirect = ''
  const service = new RemoteModelCatalogService({
    fetcher: (async (input, init) => {
      observedUrl = String(input)
      observedAuthorization = new Headers(init?.headers).get('authorization') ?? ''
      observedRedirect = init?.redirect ?? ''
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol-ultra' },
          { id: 'embedding-model' },
          { id: 'gpt-5.6-sol-ultra' },
          { id: ' contains-space ' },
          {
            id: 'server-declared-model',
            supported_endpoint_types: ['openai-response'],
            reasoning: ['none', 'minimal', 'low', 'high', 'ultra', 'high', 'unsupported'],
            capabilities: {
              subagents: true,
              toolUse: false,
              webSearch: true,
              attachments: 'true'
            }
          },
          {
            id: 'supported-levels-model',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast' },
              { effort: 'xhigh', description: 'Deep' },
              { reasoningEffort: 'max', description: 'Codex v2 shape' },
              { effort: 'unsupported', description: 'Ignored' }
            ]
          }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })

  const models = await service.list(
    { baseUrl: 'https://example.test/v1', apiKey: marker },
    'agent'
  )

  assert.equal(observedUrl, 'https://example.test/v1/models')
  assert.equal(observedAuthorization, `Bearer ${marker}`)
  assert.equal(observedRedirect, 'manual')
  assert.deepEqual(models.map((model) => model.id), [
    'embedding-model',
    'gpt-5.6-sol-ultra',
    'server-declared-model',
    'supported-levels-model'
  ])
  assert.deepEqual(models[1]?.reasoning, ['auto'])
  assert.equal(models[1]?.wireMode, 'standard')
  assert.deepEqual(models[1]?.endpointTypes, ['openai'])
  assert.equal(models[1]?.preferredChatTransport, 'chat-completions')
  assert.equal(models[1]?.declaredReasoning, undefined)
  assert.equal(models[1]?.capabilities.subagents, false)
  assert.deepEqual(models[1]?.declaredCapabilities, {})
  assert.equal(isModelCapabilityExplicitlyUnsupported(models[1]!, 'toolUse'), false)
  assert.equal(isModelCapabilityExplicitlySupported(models[1]!, 'subagents'), false)
  assert.equal(isModelReasoningExplicitlyUnsupported(models[1]!, 'ultra'), true)
  assert.deepEqual(models[2]?.reasoning, ['auto', 'none', 'minimal', 'light', 'high', 'ultra'])
  assert.deepEqual(models[2]?.declaredReasoning, ['auto', 'none', 'minimal', 'light', 'high', 'ultra'])
  assert.equal(isModelReasoningExplicitlyUnsupported(models[2]!, 'medium'), true)
  assert.equal(models[2]?.capabilities.subagents, true)
  assert.deepEqual(models[2]?.endpointTypes, ['openai-response'])
  assert.deepEqual(models[2]?.modes, ['chat', 'agent'])
  assert.equal(models[2]?.wireMode, 'standard')
  assert.equal(models[2]?.capabilities.toolUse, false)
  assert.equal(models[2]?.capabilities.webSearch, true)
  assert.equal(models[2]?.capabilities.attachments, false)
  assert.deepEqual(models[2]?.declaredCapabilities, {
    subagents: true,
    toolUse: false,
    webSearch: true
  })
  assert.equal(isModelCapabilityExplicitlyUnsupported(models[2]!, 'toolUse'), true)
  assert.equal(isModelCapabilityExplicitlySupported(models[2]!, 'subagents'), true)
  assert.equal(isModelCapabilityExplicitlyUnsupported(models[2]!, 'attachments'), false)
  assert.deepEqual(models[3]?.reasoning, ['auto', 'light', 'xhigh', 'max'])
  assert.deepEqual(models[3]?.declaredReasoning, ['auto', 'light', 'xhigh', 'max'])
  assert.doesNotMatch(JSON.stringify(models), new RegExp(marker))
})

test('remote catalog projects bounded Anthropic and Gemini reasoning protocol metadata', async () => {
  const service = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [
        {
          id: 'anthropic-adaptive-model',
          supported_endpoint_types: ['anthropic'],
          reasoning: ['low', 'high', 'max', 'ultra'],
          reasoning_protocol: { type: 'anthropic-adaptive' }
        },
        {
          id: 'anthropic-budget-model',
          supported_endpoint_types: ['anthropic'],
          reasoning_protocol: {
            type: 'anthropic-budget',
            budgets: { low: 1_024, high: 8_192 }
          }
        },
        {
          id: 'gemini-level-model',
          supported_endpoint_types: ['gemini'],
          metadata: {
            reasoning: ['minimal', 'low', 'medium', 'high', 'ultra'],
            reasoning_protocol: {
              type: 'gemini-level',
              include_thoughts: false
            }
          }
        },
        {
          id: 'gemini-budget-model',
          supported_endpoint_types: ['gemini'],
          reasoning: ['none', 'low', 'medium', 'high'],
          reasoning_protocol: {
            type: 'gemini-budget',
            budgets: { none: 0, light: 512, high: 4_096 },
            includeThoughts: true
          }
        },
        {
          id: 'openai-capability-alias-model',
          supported_endpoint_types: ['openai-response'],
          capabilities: {
            supportedReasoningEfforts: ['none', 'low', 'xhigh']
          }
        },
        {
          id: 'gemini-nested-reasoning-model',
          supported_endpoint_types: ['gemini'],
          metadata: {
            reasoning: {
              levels: [{ level: 'minimal' }, { id: 'high' }, { value: 'unsupported' }],
              protocol: { type: 'gemini-level', include_thoughts: true }
            }
          }
        },
        {
          id: 'responses-effort-schema-model',
          supported_endpoint_types: ['openai-response'],
          metadata: {
            reasoning: {
              effort: { enum: ['NONE', 'LOW', 'Extra High'] }
            }
          }
        },
        {
          id: 'chat-effort-alias-model',
          supported_endpoint_types: ['openai'],
          capabilities: {
            reasoningEffort: {
              allowed_values: ['minimal', 'medium', 'HIGH']
            }
          }
        },
        {
          id: 'anthropic-output-config-model',
          supported_endpoint_types: ['anthropic'],
          metadata: {
            output_config: {
              effort: { values: ['LOW', 'MAX'] }
            },
            reasoning_protocol: { type: 'anthropic_adaptive' }
          }
        },
        {
          id: 'gemini-thinking-level-model',
          supported_endpoint_types: ['gemini'],
          metadata: {
            generationConfig: {
              thinkingConfig: {
                thinkingLevel: { oneOf: [{ const: 'MINIMAL' }, { const: 'HIGH' }] }
              }
            },
            reasoningProtocol: { type: 'gemini_level' }
          }
        },
        {
          id: 'unknown-reasoning-metadata-model',
          supported_endpoint_types: ['openai-response'],
          reasoning_effort: 'high',
          metadata: {
            vendor_reasoning_mode: ['turbo']
          }
        }
      ]
    }), { status: 200 })) as typeof fetch
  })

  const models = await service.list(
    { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
    'chat'
  )
  const byId = new Map(models.map((model) => [model.id, model]))
  assert.deepEqual(byId.get('anthropic-adaptive-model')?.reasoning, [
    'auto',
    'light',
    'high',
    'max'
  ])
  assert.deepEqual(byId.get('anthropic-adaptive-model')?.reasoningProtocol, {
    type: 'anthropic-adaptive'
  })
  assert.deepEqual(byId.get('anthropic-budget-model')?.reasoning, [
    'auto',
    'light',
    'high'
  ])
  assert.deepEqual(byId.get('anthropic-budget-model')?.reasoningProtocol, {
    type: 'anthropic-budget',
    budgets: { light: 1_024, high: 8_192 }
  })
  assert.deepEqual(byId.get('gemini-level-model')?.reasoning, [
    'auto',
    'minimal',
    'light',
    'medium',
    'high'
  ])
  assert.deepEqual(byId.get('gemini-level-model')?.reasoningProtocol, {
    type: 'gemini-level',
    includeThoughts: false
  })
  assert.deepEqual(byId.get('gemini-budget-model')?.reasoning, [
    'auto',
    'none',
    'light',
    'high'
  ])
  assert.deepEqual(byId.get('gemini-budget-model')?.reasoningProtocol, {
    type: 'gemini-budget',
    budgets: { none: 0, light: 512, high: 4_096 },
    includeThoughts: true
  })
  assert.deepEqual(byId.get('openai-capability-alias-model')?.reasoning, [
    'auto',
    'none',
    'light',
    'xhigh'
  ])
  assert.deepEqual(byId.get('gemini-nested-reasoning-model')?.reasoning, [
    'auto',
    'minimal',
    'high'
  ])
  assert.deepEqual(byId.get('gemini-nested-reasoning-model')?.reasoningProtocol, {
    type: 'gemini-level',
    includeThoughts: true
  })
  assert.deepEqual(byId.get('responses-effort-schema-model')?.reasoning, [
    'auto',
    'none',
    'light',
    'xhigh'
  ])
  assert.deepEqual(byId.get('chat-effort-alias-model')?.reasoning, [
    'auto',
    'minimal',
    'medium',
    'high'
  ])
  assert.deepEqual(byId.get('anthropic-output-config-model')?.reasoning, [
    'auto',
    'light',
    'max'
  ])
  assert.deepEqual(byId.get('anthropic-output-config-model')?.reasoningProtocol, {
    type: 'anthropic-adaptive'
  })
  assert.deepEqual(byId.get('gemini-thinking-level-model')?.reasoning, [
    'auto',
    'minimal',
    'high'
  ])
  assert.deepEqual(byId.get('gemini-thinking-level-model')?.reasoningProtocol, {
    type: 'gemini-level'
  })
  assert.deepEqual(byId.get('unknown-reasoning-metadata-model')?.reasoning, ['auto'])
  assert.equal(byId.get('unknown-reasoning-metadata-model')?.declaredReasoning, undefined)
})

test('remote catalog preserves native reasoning metadata while projecting the preferred Chat endpoint', async () => {
  const service = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [{
        id: 'multi-endpoint-model',
        supported_endpoint_types: ['openai', 'anthropic'],
        reasoning: ['low', 'high', 'ultra'],
        reasoning_protocol: { type: 'anthropic-adaptive' }
      }]
    }), { status: 200 })) as typeof fetch
  })

  const [model] = await service.list(
    { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
    'chat'
  )
  assert.equal(model?.preferredChatEndpoint, 'openai')
  assert.equal(model?.preferredChatTransport, 'chat-completions')
  assert.equal(model?.reasoningProtocol, undefined)
  assert.deepEqual(model?.declaredReasoningProtocol, {
    type: 'anthropic-adaptive'
  })
  assert.deepEqual(model?.reasoning, ['auto', 'light', 'high', 'ultra'])
})

test('remote catalog rejects mismatched or malformed reasoning protocol declarations', async () => {
  for (const row of [
    {
      id: 'mismatched-protocol',
      supported_endpoint_types: ['openai'],
      reasoning_protocol: { type: 'gemini-level' }
    },
    {
      id: 'invalid-budget',
      supported_endpoint_types: ['anthropic'],
      reasoning_protocol: {
        type: 'anthropic-budget',
        budgets: { high: -1 }
      }
    },
    {
      id: 'unknown-protocol-field',
      supported_endpoint_types: ['gemini'],
      reasoning_protocol: {
        type: 'gemini-level',
        guessed_from_model_name: true
      }
    },
    {
      id: 'too-many-reasoning-levels',
      supported_endpoint_types: ['openai-response'],
      supported_reasoning_efforts: Array.from({ length: 33 }, () => 'high')
    }
  ]) {
    const service = new RemoteModelCatalogService({
      fetcher: (async () => new Response(JSON.stringify({ data: [row] }), {
        status: 200
      })) as typeof fetch
    })
    await assert.rejects(
      service.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
      (error: unknown) =>
        error instanceof ModelCatalogError && error.code === 'invalid_response'
    )
  }
})

test('remote errors discard bodies and never surface a key or response content', async () => {
  const marker = 'private-test-key'
  const service = new RemoteModelCatalogService({
    fetcher: (async () => new Response(
      JSON.stringify({ error: `upstream echoed ${marker}` }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch
  })

  await assert.rejects(
    service.list({ baseUrl: 'https://example.test/v1', apiKey: marker }, 'chat'),
    (error: unknown) => {
      assert.ok(error instanceof ModelCatalogError)
      assert.equal(error.code, 'remote_rejected')
      assert.doesNotMatch(error.message, new RegExp(marker))
      assert.doesNotMatch(error.message, /upstream echoed/)
      return true
    }
  )
})

test('catalog response size and shape are bounded', async () => {
  const tooLarge = new RemoteModelCatalogService({
    maxResponseBytes: 1024,
    fetcher: (async () => new Response('x'.repeat(1025), {
      status: 200,
      headers: { 'content-length': '1025' }
    })) as typeof fetch
  })
  await assert.rejects(
    tooLarge.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'response_too_large'
  )

  const invalid = new RemoteModelCatalogService({
    fetcher: (async () => new Response('{not json', { status: 200 })) as typeof fetch
  })
  await assert.rejects(
    invalid.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'invalid_response'
  )
})
