import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

import type { ModelDescriptor } from '../../src/shared/contracts.ts'
import type {
  StudioCopilotCompletionRequest,
  StudioCopilotServiceOptions,
} from '../../src/main/studio/studio-copilot-service.ts'
import type { RelayPricingDto, RelayPricingModelDto } from '../../src/main/services/relay-service.ts'
import type { ProviderDescriptor, WorkflowDocument } from '../../src/studio/shared/types.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const {
  NativeStudioCopilotModelAdapter,
  StudioCopilotService,
} = await import('../../src/main/studio/studio-copilot-service.ts')

const timestamp = '2026-07-26T00:00:00.000Z'

const workflow = (): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-copilot',
  name: 'Copilot fixture',
  revision: 3,
  nodes: [{
    id: 'generate',
    type: 'image_generation',
    name: 'Generate image',
    position: { x: 420, y: 80 },
    parameters: {
      providerId: 'account:image',
      model: 'image-model',
      size: '1024x1024',
      quality: '',
      seed: 0,
      count: 1,
    },
  }],
  edges: [],
  createdAt: timestamp,
  updatedAt: timestamp,
})

const provider = (groupId: string): ProviderDescriptor => ({
  id: 'account:image',
  name: 'Account image group',
  kind: 'openai-compatible',
  baseUrl: 'https://relay.example.test/v1',
  defaultModel: 'image-model',
  timeoutMs: 60_000,
  maxImageBytes: 64 * 1024 * 1024,
  proxyMode: 'system',
  hasSecret: true,
  maskedSecret: '********',
  managedBy: 'ai-terminal-account',
  groupId,
})

const pricingModel = (
  modelName: string,
  groupId: string,
  endpointTypes: readonly string[],
): RelayPricingModelDto => ({
  model_name: modelName,
  quota_type: 0,
  model_ratio: 1,
  model_price: 0,
  owner_by: 'remote',
  completion_ratio: 1,
  enable_groups: [groupId],
  supported_endpoint_types: endpointTypes,
})

interface HarnessOptions {
  readonly providerGroup: string
  readonly groups: Readonly<Record<string, readonly string[]>>
  readonly pricing: RelayPricingDto
  readonly output: string
  readonly remoteModels?: readonly ModelDescriptor[]
}

const harness = (options: HarnessOptions) => {
  const groupCatalogReads: string[] = []
  const credentialSelections: Array<{ groupId: string; modelId?: string }> = []
  const events: string[] = []
  const completions: StudioCopilotCompletionRequest[] = []
  const groupDescriptions = Object.fromEntries(
    Object.keys(options.groups).map((groupId) => [groupId, { desc: groupId }]),
  )
  const relay: StudioCopilotServiceOptions['relay'] = {
    getTokenBackedUserGroups: async () => groupDescriptions,
    getUserModels: async () => Object.values(options.groups).flat(),
    getUserModelsForGroup: async (groupId) => {
      groupCatalogReads.push(groupId)
      return [...(options.groups[groupId] ?? [])]
    },
    getPricing: async () => options.pricing,
    getEligibleModelIdsForGroup: async (_groupId, modelIds) => [...modelIds],
    getSelectedModelAccessCredentials: async (selection) => {
      credentialSelections.push({
        groupId: selection.groupId,
        ...(selection.modelId === undefined ? {} : { modelId: selection.modelId }),
      })
      events.push(`credentials:${selection.groupId}:${selection.modelId ?? ''}`)
      return {
        baseUrl: `https://${encodeURIComponent(selection.groupId)}.example.test/v1`,
        apiKey: 'test-key-main-only',
        tokenId: credentialSelections.length,
      }
    },
  }
  const service = new StudioCopilotService({
    relay,
    modelCatalog: { list: async () => [...(options.remoteModels ?? [])] },
    providers: { descriptor: async () => provider(options.providerGroup) },
    adapter: {
      complete: async (request) => {
        events.push(`complete:${request.endpointType}:${request.endpointPath}`)
        completions.push(request)
        return options.output
      },
    },
    ensureEndpointConsent: async (endpoint) => {
      events.push(`consent:${endpoint}`)
    },
  })
  return { service, groupCatalogReads, credentialSelections, events, completions }
}

const validFencedPlan = `\`\`\`json
{
  "summary": "Add a prompt and align the workflow",
  "operations": [
    {
      "kind": "add-node",
      "ref": "promptNode",
      "nodeType": "text",
      "position": { "x": 40, "y": 80 },
      "parameters": { "text": "A detailed portrait" }
    },
    {
      "kind": "connect",
      "source": { "ref": "promptNode" },
      "sourceSocket": "text",
      "target": { "nodeId": "generate" },
      "targetSocket": "prompt"
    },
    { "kind": "auto-layout" }
  ]
}
\`\`\``

test('Studio Copilot keeps the selected group and uses only its declared POST route', async () => {
  const current = harness({
    providerGroup: 'current',
    groups: {
      current: ['gemini-model'],
      fallback: ['openai-model'],
    },
    pricing: {
      data: [
        pricingModel('gemini-model', 'current', ['gemini']),
        pricingModel('openai-model', 'fallback', ['openai']),
      ],
      supported_endpoint: {
        gemini: { path: '/v1beta/models/{model}:streamGenerateContent', method: 'POST' },
        openai: { path: '/v1/chat/completions', method: 'POST' },
      },
    },
    output: validFencedPlan,
  })

  const result = await current.service.plan({
    providerId: 'account:image',
    workflow: workflow(),
    instruction: 'Add a prompt node and connect it.',
  })

  assert.equal(result.groupId, 'current')
  assert.equal(result.model, 'gemini-model')
  assert.deepEqual(result.operations.map((operation) => operation.kind), [
    'add-node',
    'connect',
    'auto-layout',
  ])
  assert.deepEqual(current.groupCatalogReads, ['current'])
  assert.equal(current.completions[0]?.endpointType, 'gemini')
  assert.equal(current.completions[0]?.endpointPath, '/v1beta/models/{model}:streamGenerateContent')
  assert.deepEqual(current.events, [
    'credentials:current:gemini-model',
    'consent:https://current.example.test/v1beta/models/gemini-model:streamGenerateContent',
    'complete:gemini:/v1beta/models/{model}:streamGenerateContent',
  ])
})

test('Studio Copilot falls back from an image-only selected group to a real token conversation group', async () => {
  const current = harness({
    providerGroup: 'images',
    groups: {
      images: ['image-model'],
      chat: ['chat-model'],
    },
    pricing: {
      data: [
        pricingModel('image-model', 'images', ['image-generation']),
        pricingModel('chat-model', 'chat', ['openai']),
      ],
      supported_endpoint: {
        'image-generation': { path: '/v1/images/generations', method: 'POST' },
        openai: { path: '/v1/chat/completions', method: 'POST' },
      },
    },
    output: JSON.stringify({
      summary: 'Align the workflow',
      operations: [{ kind: 'auto-layout' }],
    }),
  })

  const result = await current.service.plan({
    providerId: 'account:image',
    workflow: workflow(),
    instruction: 'Align the workflow.',
  })

  assert.equal(result.groupId, 'chat')
  assert.equal(result.model, 'chat-model')
  assert.deepEqual(current.groupCatalogReads, ['images', 'chat'])
  assert.deepEqual(current.credentialSelections, [
    { groupId: 'images', modelId: 'image-model' },
    { groupId: 'chat', modelId: 'chat-model' },
  ])
  assert.equal(current.completions[0]?.endpointType, 'openai')
})

test('Studio Copilot rejects route mutation and plans that cannot apply to the workflow', async () => {
  const base = {
    providerGroup: 'chat',
    groups: { chat: ['chat-model'] },
    pricing: {
      data: [pricingModel('chat-model', 'chat', ['openai'])],
      supported_endpoint: {
        openai: { path: '/v1/chat/completions', method: 'POST' },
      },
    },
  } as const
  const routeMutation = harness({
    ...base,
    output: JSON.stringify({
      summary: 'Change the route',
      operations: [{
        kind: 'add-node',
        ref: 'promptNode',
        nodeType: 'text',
        position: { x: 0, y: 0 },
        parameters: { providerId: 'other-group' },
      }],
    }),
  })

  await assert.rejects(
    routeMutation.service.plan({
      providerId: 'account:image',
      workflow: workflow(),
      instruction: 'Change the route.',
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'studio-copilot-invalid-response'
    ),
  )

  const unknownNode = harness({
    ...base,
    output: JSON.stringify({
      summary: 'Add an unknown node',
      operations: [{
        kind: 'add-node',
        ref: 'unknownNode',
        nodeType: 'not_registered',
        position: { x: 0, y: 0 },
      }],
    }),
  })
  await assert.rejects(
    unknownNode.service.plan({
      providerId: 'account:image',
      workflow: workflow(),
      instruction: 'Add the node.',
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'studio-copilot-invalid-operations'
    ),
  )
})

test('native Studio Copilot adapter preserves the selected protocol client', async () => {
  const calls: string[] = []
  const client = (name: string) => ({
    stream: async () => {
      calls.push(name)
      return { outputText: `${name}-output` }
    },
  })
  const adapter = new NativeStudioCopilotModelAdapter({
    responses: client('responses') as never,
    chatCompletions: client('chat') as never,
    anthropic: client('anthropic') as never,
    gemini: client('gemini') as never,
  })
  const model: ModelDescriptor = {
    id: 'declared-model',
    label: 'declared-model',
    provider: 'openai-compatible',
    wireMode: 'standard',
    endpointTypes: ['openai-response', 'openai', 'anthropic', 'gemini'],
    declaredEndpointTypes: ['openai-response', 'openai', 'anthropic', 'gemini'],
    preferredChatEndpoint: 'openai-response',
    preferredChatTransport: 'responses',
    modes: ['chat'],
    reasoning: ['auto'],
    capabilities: {
      attachments: false,
      imageInput: false,
      imageGeneration: false,
      subagents: false,
      toolUse: false,
      webSearch: false,
    },
    source: 'remote',
  }

  for (const [endpointType, expected] of [
    ['openai-response', 'responses'],
    ['openai', 'chat'],
    ['anthropic', 'anthropic'],
    ['gemini', 'gemini'],
  ] as const) {
    const output = await adapter.complete({
      credentials: {
        baseUrl: 'https://relay.example.test/v1',
        apiKey: 'test-key-main-only',
        tokenId: 1,
      },
      model,
      endpointType,
      endpointPath: '/declared/path',
      systemPrompt: 'System',
      userPrompt: 'User',
    })
    assert.equal(output, `${expected}-output`)
  }
  assert.deepEqual(calls, ['responses', 'chat', 'anthropic', 'gemini'])
})
