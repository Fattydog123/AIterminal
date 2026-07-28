import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ModelDescriptor,
  TurnStartInput,
} from '../../src/shared/contracts.ts'
import { WZH_RELAY_PROFILE_HANDLE } from '../../src/shared/server-config.ts'
import type { AgentTurnService } from '../../src/main/services/agent-turn-service.ts'
import type { ChatTurnService } from '../../src/main/services/chat-turn-service.ts'
import { ConfirmedModelCatalogStore } from '../../src/main/services/confirmed-model-catalog-store.ts'
import type { RelayModelAccessCredentials } from '../../src/main/services/relay-service.ts'
import type { ResolvedWorkspaceRecord } from '../../src/main/services/selection-token-store.ts'
import { RemoteModelCatalogService } from '../../src/main/services/model-catalog.ts'
import {
  TurnAdmissionService,
  type TurnAdmissionServiceOptions,
} from '../../src/main/services/turn-admission-service.ts'

type ChatStart = Parameters<ChatTurnService['start']>[0]
type AgentStart = Parameters<AgentTurnService['start']>[0]

const REQUEST_ONE = 'start:00000000-0000-4000-8000-000000000001'
const REQUEST_TWO = 'start:00000000-0000-4000-8000-000000000002'
const GROUP_ID = 'group-a'
const credentials: Readonly<RelayModelAccessCredentials> = {
  baseUrl: 'https://relay.example.test',
  apiKey: 'sk-test-key',
  tokenId: 7,
}

const model = (overrides: Partial<ModelDescriptor> = {}): ModelDescriptor => ({
  id: 'model-a',
  label: 'Model A',
  provider: 'openai-compatible',
  wireMode: 'standard',
  endpointTypes: ['openai'],
  preferredChatEndpoint: 'openai',
  preferredChatTransport: 'chat-completions',
  modes: ['chat', 'agent'],
  reasoning: ['auto', 'low'],
  capabilities: {
    attachments: true,
    imageInput: true,
    imageGeneration: true,
    subagents: true,
    toolUse: true,
    webSearch: true,
  },
  source: 'remote',
  ...overrides,
})

const turn = (overrides: Partial<TurnStartInput> = {}): TurnStartInput => ({
  requestId: REQUEST_ONE,
  taskId: 'task:admission',
  mode: 'chat',
  prompt: 'Hello',
  profileHandle: WZH_RELAY_PROFILE_HANDLE,
  groupId: GROUP_ID,
  modelId: 'model-a',
  reasoning: 'auto',
  approvalMode: 'auto',
  attachmentTokens: [],
  webSearch: false,
  imageGeneration: false,
  localSubagents: false,
  ...overrides,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function createHarness(options: {
  mode?: 'chat' | 'agent'
  model?: ModelDescriptor
  resolveCredentials?: TurnAdmissionServiceOptions['resolveCredentials']
  ensureEndpoint?: TurnAdmissionServiceOptions['ensureEndpoint']
  resolveWorkspace?: () => Promise<ResolvedWorkspaceRecord | null>
  consumeReviewMode?: () => boolean
  compaction?: TurnAdmissionServiceOptions['compaction']
} = {}) {
  const mode = options.mode ?? 'chat'
  const selectedModel = options.model ?? model(mode === 'agent'
    ? {
        endpointTypes: ['openai-response'],
        preferredChatEndpoint: 'openai-response',
        preferredChatTransport: 'responses',
      }
    : {})
  const catalogs = new ConfirmedModelCatalogStore()
  catalogs.set({
    profileHandle: WZH_RELAY_PROFILE_HANDLE,
    mode,
    groupId: GROUP_ID,
    generation: catalogs.generation(WZH_RELAY_PROFILE_HANDLE),
    models: [selectedModel],
    endpointRoutes: {
      openai: { path: '/v1/chat/completions', method: 'POST' },
      'openai-response': { path: '/v1/responses', method: 'POST' },
      anthropic: { path: '/v1/messages', method: 'POST' },
      gemini: { path: '/v1beta/models/{model}:streamGenerateContent', method: 'POST' },
    },
  })
  const chatStarts: ChatStart[] = []
  const agentStarts: AgentStart[] = []
  const calls: string[] = []
  let attachmentPrepared = 0
  let reviewConsumed = 0
  const workspace: ResolvedWorkspaceRecord = {
    workspaceToken: 'workspace-token',
    absolutePath: 'C:\\selected-workspace',
    ownerWebContentsId: 42,
    expiresAt: Date.now() + 60_000,
    device: 'device-a',
    inode: 'inode-a',
  }
  const service = new TurnAdmissionService({
    ownerWebContentsId: 42,
    catalogs,
    selections: {
      describeAttachment: (token) => token === 'attachment-token'
        ? { mediaKind: 'text' }
        : undefined,
      resolveWorkspace: async () => options.resolveWorkspace
        ? await options.resolveWorkspace()
        : workspace,
    },
    attachments: {
      prepare: async () => {
        attachmentPrepared += 1
        calls.push('attachments')
        return { parts: [], count: 0, totalBytes: 0 }
      },
    },
    resolveCredentials: async (...args) => {
      calls.push('credentials')
      return await (options.resolveCredentials?.(...args) ?? Promise.resolve(credentials))
    },
    ensureEndpoint: async (...args) => {
      calls.push('endpoint')
      return await (options.ensureEndpoint?.(...args) ?? Promise.resolve(undefined))
    },
    extensions: {
      consumeReviewMode: () => {
        reviewConsumed += 1
        return options.consumeReviewMode?.() ?? true
      },
      getPlanMode: () => true,
    },
    chatTurns: {
      start: async (input) => {
        chatStarts.push(input)
        return { turnId: 'chat-turn' }
      },
      cancel: () => true,
    },
    agentTurns: {
      start: async (input) => {
        agentStarts.push(input)
        return { turnId: 'agent-turn' }
      },
      cancel: () => true,
    },
    ...(options.compaction === undefined ? {} : {
      compaction: {
        compact: async (...args) => {
          calls.push('compaction')
          return await options.compaction!.compact(...args)
        },
      },
    }),
    workspaceProjectId: (identity) => `project:${identity.device}:${identity.inode}`,
  })
  return {
    service,
    catalogs,
    chatStarts,
    agentStarts,
    calls,
    get attachmentPrepared() { return attachmentPrepared },
    get reviewConsumed() { return reviewConsumed },
  }
}

test('admits a confirmed Chat request and exposes no credential in its result', async () => {
  const harness = createHarness()

  const result = await harness.service.start(turn())

  assert.deepEqual(result, { ok: true, value: { turnId: 'chat-turn' } })
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false)
  assert.equal(harness.agentStarts.length, 0)
  assert.equal(harness.chatStarts.length, 1)
  assert.equal(harness.chatStarts[0]?.endpointPath, '/v1/chat/completions')
  assert.deepEqual(harness.calls, ['credentials', 'endpoint'])
})

test('admits an Agent review only after resolving its selected workspace', async () => {
  const harness = createHarness({ mode: 'agent' })
  const result = await harness.service.start(turn({
    mode: 'agent',
    prompt: '/review inspect this change',
    workspaceToken: 'workspace-token',
    reviewHandle: `review_${'a'.repeat(43)}`,
  }))

  assert.equal(result.ok, true)
  assert.equal(harness.chatStarts.length, 0)
  assert.equal(harness.agentStarts.length, 1)
  assert.equal(harness.reviewConsumed, 1)
  assert.equal(harness.agentStarts[0]?.reviewMode, true)
  assert.equal(harness.agentStarts[0]?.planMode, true)
  assert.equal(harness.agentStarts[0]?.workspaceProjectId, 'project:device-a:inode-a')
  assert.match(harness.agentStarts[0]?.prompt ?? '', /^Review the current authorized workspace changes\./u)
})

test('routes Agent models only by NewAPI endpoint declarations, never by model names', async () => {
  const declared = [
    { id: 'grok-native-looking', supported_endpoint_types: ['anthropic'] },
    { id: 'qwen-native-looking', supported_endpoint_types: ['gemini'] },
    { id: 'deepseek-chat-looking', supported_endpoint_types: ['openai-response'] },
    { id: 'claude-native-looking', supported_endpoint_types: ['openai'] },
  ] as const
  const catalog = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({ data: declared }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
  })
  const models = await catalog.list(
    { baseUrl: 'https://relay.example.test', apiKey: 'sk-test-key' },
    'agent',
  )
  const expected = new Map([
    ['grok-native-looking', 'anthropic'],
    ['qwen-native-looking', 'gemini'],
    ['deepseek-chat-looking', 'openai-response'],
    ['claude-native-looking', 'openai'],
  ] as const)

  for (const selectedModel of models) {
    const harness = createHarness({ mode: 'agent', model: selectedModel })
    const result = await harness.service.start(turn({
      mode: 'agent',
      modelId: selectedModel.id,
      workspaceToken: 'workspace-token',
    }))

    assert.equal(result.ok, true)
    assert.equal(harness.agentStarts.length, 1)
    assert.equal(harness.agentStarts[0]?.endpointType, expected.get(selectedModel.id))
  }
})

test('routes an explicitly xAI Agent contract through Responses while preserving Chat preference', async () => {
  const selectedModel = model({
    id: 'grok-4.5',
    label: 'grok-4.5',
    endpointTypes: ['openai', 'openai-response'],
    declaredEndpointTypes: ['openai', 'openai-response'],
    preferredChatEndpoint: 'openai',
    preferredChatTransport: 'chat-completions',
    preferredAgentEndpoint: 'openai-response',
  })
  const harness = createHarness({ mode: 'agent', model: selectedModel })

  const result = await harness.service.start(turn({
    mode: 'agent',
    modelId: selectedModel.id,
    workspaceToken: 'workspace-token',
  }))

  assert.equal(result.ok, true)
  assert.equal(harness.agentStarts.length, 1)
  assert.equal(harness.agentStarts[0]?.endpointType, 'openai-response')
  assert.equal(harness.agentStarts[0]?.endpointPath, '/v1/responses')
  assert.deepEqual(harness.agentStarts[0]?.endpointCandidates, [
    { endpointType: 'openai-response', endpointPath: '/v1/responses' },
    { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
  ])

  const chatHarness = createHarness({ mode: 'chat', model: selectedModel })
  const chatResult = await chatHarness.service.start(turn({
    mode: 'chat',
    modelId: selectedModel.id,
  }))
  assert.equal(chatResult.ok, true)
  assert.equal(chatHarness.chatStarts[0]?.endpointType, 'openai')
  assert.equal(chatHarness.chatStarts[0]?.endpointPath, '/v1/chat/completions')
})

test('attaches a native reasoning protocol only to its matching Agent endpoint candidate', async () => {
  const selectedModel = model({
    id: 'mixed-anthropic-agent',
    label: 'mixed-anthropic-agent',
    endpointTypes: ['openai', 'anthropic'],
    declaredEndpointTypes: ['openai', 'anthropic'],
    preferredChatEndpoint: 'openai',
    preferredChatTransport: 'chat-completions',
    reasoning: ['auto', 'high', 'max'],
    ...({
      declaredReasoningProtocol: { type: 'anthropic-adaptive' },
    } as unknown as Partial<ModelDescriptor>),
  })
  const harness = createHarness({ mode: 'agent', model: selectedModel })

  const result = await harness.service.start(turn({
    mode: 'agent',
    modelId: selectedModel.id,
    reasoning: 'max',
    workspaceToken: 'workspace-token',
  }))

  assert.equal(result.ok, true)
  assert.deepEqual(harness.agentStarts[0]?.endpointCandidates, [
    { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
    {
      endpointType: 'anthropic',
      endpointPath: '/v1/messages',
      reasoningProtocol: { type: 'anthropic-adaptive' },
    },
  ])
  assert.equal(harness.agentStarts[0]?.reasoningProtocol, undefined)
})

test('automatically exposes delegation on Agent protocols without a user switch', async () => {
  const inferredModel = model({
    endpointTypes: ['openai'],
    preferredChatEndpoint: 'openai',
    preferredChatTransport: 'chat-completions',
    capabilities: { ...model().capabilities, subagents: false, toolUse: true },
  })
  const admitted = createHarness({ mode: 'agent', model: inferredModel })
  const admittedResult = await admitted.service.start(turn({
    mode: 'agent',
    workspaceToken: 'workspace-token',
    // Simulate an older renderer payload. Main must ignore this legacy value.
    localSubagents: false,
  }))

  assert.equal(admittedResult.ok, true)
  assert.equal(admitted.agentStarts[0]?.subagentsEnabled, true)

  const disabledModel = model({
    ...inferredModel,
    declaredCapabilities: { subagents: false },
  })
  const rejected = createHarness({ mode: 'agent', model: disabledModel })
  const rejectedResult = await rejected.service.start(turn({
    mode: 'agent',
    workspaceToken: 'workspace-token',
  }))

  assert.equal(rejectedResult.ok, true)
  assert.equal(rejected.agentStarts[0]?.subagentsEnabled, false)
})

test('rejects preflight failures before credentials, endpoint consent, attachments, or turn dispatch', async () => {
  const harness = createHarness()
  const result = await harness.service.start(turn({ profileHandle: 'profile:other' }))

  assert.equal(result.ok, false)
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.attachmentPrepared, 0)
  assert.equal(harness.chatStarts.length, 0)
  assert.equal(harness.agentStarts.length, 0)
})

test('owns review, group, model, capability, and Agent workspace admission', async (context) => {
  const cases: ReadonlyArray<{
    name: string
    harness: Parameters<typeof createHarness>[0]
    input: Partial<TurnStartInput>
  }> = [
    {
      name: 'review authorization',
      harness: { mode: 'agent' },
      input: { mode: 'agent', prompt: '/review inspect', workspaceToken: 'workspace-token' },
    },
    {
      name: 'group',
      harness: {},
      input: { groupId: null },
    },
    {
      name: 'model',
      harness: {},
      input: { modelId: 'unknown-model' },
    },
    {
      name: 'capability',
      harness: { model: model({ capabilities: { ...model().capabilities, webSearch: false } }) },
      input: { webSearch: true },
    },
    {
      name: 'Agent workspace',
      harness: { mode: 'agent' },
      input: { mode: 'agent' },
    },
  ]

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const harness = createHarness(entry.harness)
      const result = await harness.service.start(turn(entry.input))

      assert.equal(result.ok, false)
      assert.deepEqual(harness.calls, [])
      assert.equal(harness.chatStarts.length, 0)
      assert.equal(harness.agentStarts.length, 0)
    })
  }
})

test('rejects a catalog invalidated during credential resolution before endpoint consent or dispatch', async () => {
  let catalogs: ConfirmedModelCatalogStore | undefined
  const harness = createHarness({
    resolveCredentials: async () => {
      catalogs!.invalidateProfile(WZH_RELAY_PROFILE_HANDLE)
      return credentials
    },
  })
  catalogs = harness.catalogs

  const result = await harness.service.start(turn())

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'conflict',
      message: 'The confirmed model catalog changed. Refresh before retrying.',
      retryable: false,
    },
  })
  assert.deepEqual(harness.calls, ['credentials'])
  assert.equal(harness.chatStarts.length, 0)
})

test('rejects a catalog invalidated during endpoint consent before attachment preparation or dispatch', async () => {
  let catalogs: ConfirmedModelCatalogStore | undefined
  const harness = createHarness({
    ensureEndpoint: async () => { catalogs!.invalidateProfile(WZH_RELAY_PROFILE_HANDLE) },
  })
  catalogs = harness.catalogs

  const result = await harness.service.start(turn({ attachmentTokens: ['attachment-token'] }))

  assert.equal(result.ok, false)
  assert.deepEqual(harness.calls, ['credentials', 'endpoint'])
  assert.equal(harness.attachmentPrepared, 0)
  assert.equal(harness.chatStarts.length, 0)
})

test('prepares a one-time attachment only after endpoint consent succeeds', async () => {
  const harness = createHarness()

  const result = await harness.service.start(turn({ attachmentTokens: ['attachment-token'] }))

  assert.equal(result.ok, true)
  assert.deepEqual(harness.calls, ['credentials', 'endpoint', 'attachments'])
  assert.equal(harness.attachmentPrepared, 1)
})

test('requires the selected model to be declared for the requested mode', async () => {
  const harness = createHarness({ model: model({ modes: ['agent'] }) })

  const result = await harness.service.start(turn())

  assert.equal(result.ok, false)
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.chatStarts.length, 0)
})

test('cancels a pending admission before it can dispatch a turn', async () => {
  const credential = deferred<Readonly<RelayModelAccessCredentials>>()
  const harness = createHarness({ resolveCredentials: async () => credential.promise })
  const starting = harness.service.start(turn())

  await Promise.resolve()
  assert.deepEqual(harness.service.cancelPendingStart(REQUEST_ONE), { ok: true, value: null })
  credential.resolve(credentials)

  assert.deepEqual(await starting, {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'Turn start was cancelled.',
      retryable: false,
    },
  })
  assert.equal(harness.chatStarts.length, 0)
  assert.deepEqual(harness.service.cancelPendingStart(REQUEST_TWO), {
    ok: false,
    error: {
      code: 'not_found',
      message: 'No pending turn start was found.',
      retryable: false,
    },
  })
})

test('does not consume a review handle when endpoint consent fails first', async () => {
  const harness = createHarness({
    mode: 'agent',
    ensureEndpoint: async () => { throw new Error('consent dialog failed') },
  })

  await assert.rejects(harness.service.start(turn({
    mode: 'agent',
    prompt: '/review only after consent',
    workspaceToken: 'workspace-token',
    reviewHandle: `review_${'a'.repeat(43)}`,
  })), /consent dialog failed/u)
  assert.equal(harness.reviewConsumed, 0)
  assert.equal(harness.agentStarts.length, 0)
})

test('runs pre-turn compaction on the turn route and tolerates its failure', async () => {
  const compactionRoutes: unknown[] = []
  const snapshot = {
    task: {
      id: 'task:admission',
      projectId: 'project:device-a:inode-a',
      title: '压缩',
      mode: 'agent' as const,
      updatedAt: '2026-07-26T00:00:00.000Z',
      archivedAt: null,
      status: 'idle' as const,
    },
    messages: [],
    events: [],
  }
  const harness = createHarness({
    mode: 'agent',
    compaction: {
      compact: async (taskId, route) => {
        compactionRoutes.push({ taskId, route })
        return { compacted: false, removedMessages: 0, snapshot }
      },
    },
  })

  const result = await harness.service.start(turn({ mode: 'agent', workspaceToken: 'workspace-token' }))

  assert.equal(result.ok, true)
  // Compaction runs after consent, strictly before the agent turn dispatch.
  assert.deepEqual(harness.calls, ['credentials', 'endpoint', 'compaction'])
  assert.equal(harness.agentStarts.length, 1)
  assert.deepEqual(compactionRoutes, [{
    taskId: 'task:admission',
    route: {
      model: 'model-a',
      credentials: { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey },
      endpointType: 'openai-response',
      endpointPath: '/v1/responses',
      wireMode: 'standard',
      reasoning: 'auto',
    },
  }])

  // A compaction failure must never block the turn itself.
  const failing = createHarness({
    mode: 'agent',
    compaction: { compact: async () => { throw new Error('summarization failed') } },
  })
  const tolerated = await failing.service.start(turn({ mode: 'agent', workspaceToken: 'workspace-token' }))
  assert.equal(tolerated.ok, true)
  assert.equal(failing.agentStarts.length, 1)
})

test('chat turns compact through the chat transport before dispatch', async () => {
  const compactionRoutes: unknown[] = []
  const snapshot = {
    task: {
      id: 'task:admission',
      projectId: 'project:device-a:inode-a',
      title: '压缩',
      mode: 'chat' as const,
      updatedAt: '2026-07-26T00:00:00.000Z',
      archivedAt: null,
      status: 'idle' as const,
    },
    messages: [],
    events: [],
  }
  const harness = createHarness({
    compaction: {
      compact: async (taskId, route) => {
        compactionRoutes.push({ taskId, route })
        return { compacted: false, removedMessages: 0, snapshot }
      },
    },
  })

  const result = await harness.service.start(turn({ mode: 'chat' }))

  assert.equal(result.ok, true)
  assert.deepEqual(harness.calls, ['credentials', 'endpoint', 'compaction'])
  assert.equal(harness.chatStarts.length, 1)
  assert.equal(compactionRoutes.length, 1)
  const routed = compactionRoutes[0] as { route: { endpointType: string } }
  // The default chat harness model prefers the chat-completions transport.
  assert.equal(routed.route.endpointType, 'openai')
})

test('review turns never trigger pre-turn compaction', async () => {
  let compactions = 0
  const harness = createHarness({
    mode: 'agent',
    compaction: {
      compact: async () => {
        compactions += 1
        throw new Error('unexpected')
      },
    },
  })
  const result = await harness.service.start(turn({
    mode: 'agent',
    prompt: '/review inspect this change',
    workspaceToken: 'workspace-token',
    reviewHandle: `review_${'a'.repeat(43)}`,
  }))

  assert.equal(result.ok, true)
  assert.equal(compactions, 0)
  assert.equal(harness.agentStarts.length, 1)
})
