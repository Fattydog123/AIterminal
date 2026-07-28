import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ApiResult,
  ModelDescriptor,
  ModelListInput,
  RemoteRelayOverviewDto,
} from '../../src/shared/contracts.ts'
import { WZH_RELAY_PROFILE_HANDLE } from '../../src/shared/server-config.ts'
import {
  createModelSelectionController,
  type ModelSelectionAdapter,
} from '../../src/renderer/src/model-selection/model-selection.ts'

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function failure(message: string): ApiResult<never> {
  return {
    ok: false,
    error: { code: 'runtime_error', message, retryable: true },
  }
}

function descriptor(
  id: string,
  overrides: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    id,
    label: id,
    provider: 'openai-compatible',
    wireMode: 'standard',
    endpointTypes: ['openai-response'],
    preferredChatEndpoint: 'openai-response',
    preferredChatTransport: 'responses',
    modes: ['chat', 'agent'],
    reasoning: ['auto', 'light', 'high', 'ultra'],
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
  }
}

function overview(groupIds: readonly string[], accountGroup = groupIds[0] ?? null): RemoteRelayOverviewDto {
  return {
    account: {
      id: 1,
      username: 'tester',
      displayName: 'Test User',
      email: null,
      group: accountGroup,
      status: 1,
      role: 1,
    },
    quota: { total: null, used: null, remaining: null },
    requestCount: 0,
    groups: groupIds.map((id) => ({ id, ratio: 1, description: null })),
    models: [],
    updatedAt: new Date(0).toISOString(),
  }
}

function bootstrap(models: readonly ModelDescriptor[], activeModelId = models[0]?.id ?? '') {
  return {
    models,
    activeModelId,
    reasoning: 'ultra' as const,
    profileHandle: WZH_RELAY_PROFILE_HANDLE,
    profileHasKey: true,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

function adapter(
  groups: readonly string[],
  listModels: (input: ModelListInput) => Promise<ApiResult<ModelDescriptor[]>>,
): ModelSelectionAdapter {
  return {
    getOverview: async () => success(overview(groups)),
    listTokens: async () => success({ page: 1, pageSize: 100, total: 0, items: [] }),
    listModels,
  }
}

test('selected group becomes usable before remaining catalogs finish', async () => {
  const otherCatalog = deferred<ApiResult<ModelDescriptor[]>>()
  const calls: string[] = []
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['selected', 'other'], async (input) => {
      calls.push(input.groupId ?? '')
      return input.groupId === 'selected'
        ? success([descriptor('selected-model')])
        : otherCatalog.promise
    }),
  })

  const initializing = controller.actions.initialize(bootstrap([descriptor('selected-model')]))
  await waitFor(() => calls.length === 2)
  assert.deepEqual(calls, ['selected', 'other'])
  assert.deepEqual(controller.getSnapshot().groups.map((group) => group.id), ['selected'])
  assert.equal(controller.getSnapshot().selectedModel?.id, 'selected-model')
  assert.equal(controller.getSnapshot().catalog.connected, true)

  otherCatalog.resolve(success([descriptor('other-model')]))
  await initializing
  assert.deepEqual(controller.getSnapshot().groups.map((group) => group.id), ['selected', 'other'])
  controller.dispose()
})

test('a token-backed Gemini group remains selectable after a temporary catalog failure', async () => {
  let geminiCalls = 0
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['default', 'gemini'], async (input) => {
      if (input.groupId === 'default') return success([descriptor('default-model')])
      geminiCalls += 1
      return geminiCalls === 1
        ? failure('temporary Gemini catalog failure')
        : success([descriptor('gemini-model', {
            provider: 'gemini-compatible',
            endpointTypes: ['gemini'],
            preferredChatEndpoint: 'gemini',
            preferredChatTransport: 'gemini',
          })])
    }),
  })

  await controller.actions.initialize(bootstrap([descriptor('default-model')]))
  assert.deepEqual(
    controller.getSnapshot().groups.map((group) => group.id),
    ['default', 'gemini'],
  )

  await controller.actions.selectGroup('gemini')
  assert.equal(geminiCalls, 2)
  assert.equal(controller.getSnapshot().groupId, 'gemini')
  assert.equal(controller.getSnapshot().selectedModel?.id, 'gemini-model')
  assert.equal(controller.getSnapshot().catalog.connected, true)
  controller.dispose()
})

test('selected group failure remains selected while other token-backed groups stay available', async () => {
  const calls: string[] = []
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['selected', 'fallback'], async (input) => {
      calls.push(input.groupId ?? '')
      return input.groupId === 'selected'
        ? failure('private upstream detail')
        : success([descriptor('fallback-model')])
    }),
  })

  await controller.actions.initialize(bootstrap([]))
  const snapshot = controller.getSnapshot()
  assert.deepEqual(calls, ['selected', 'fallback'])
  assert.deepEqual(snapshot.groups.map((group) => group.id), ['selected', 'fallback'])
  assert.equal(snapshot.groupId, 'selected')
  assert.equal(snapshot.catalog.state, 'error')
  assert.equal(snapshot.catalog.connected, false)
  assert.equal(snapshot.catalog.message.includes('private upstream detail'), false)

  await controller.actions.selectGroup('fallback')
  assert.deepEqual(calls, ['selected', 'fallback', 'fallback'])
  assert.equal(controller.getSnapshot().selectedModel?.id, 'fallback-model')
  assert.equal(controller.getSnapshot().catalog.connected, true)
  controller.dispose()
})

test('unchanged token metadata retries a previously failed selected catalog', async () => {
  let selectedCalls = 0
  const tokenPage = {
    page: 1,
    pageSize: 100,
    total: 1,
    items: [{
      id: 9,
      name: 'Gemini token',
      status: 'active' as const,
      unlimitedQuota: true,
      group: 'Gemini cil',
      modelLimits: '',
      expiresAt: null,
    }],
  }
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: {
      getOverview: async () => success(overview(['Gemini cil'])),
      listTokens: async () => success(tokenPage),
      listModels: async () => {
        selectedCalls += 1
        return selectedCalls === 1
          ? failure('temporary rate limit')
          : success([descriptor('gemini-model')])
      },
    },
  })

  await controller.actions.initialize(bootstrap([]))
  assert.equal(controller.getSnapshot().catalog.state, 'error')
  await controller.actions.syncAccount()

  assert.equal(selectedCalls, 2)
  assert.equal(controller.getSnapshot().selectedModel?.id, 'gemini-model')
  assert.equal(controller.getSnapshot().catalog.connected, true)
  controller.dispose()
})

test('late Agent catalog cannot overwrite a newer Chat selection', async () => {
  const agentCatalog = deferred<ApiResult<ModelDescriptor[]>>()
  const calls: string[] = []
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['default'], async (input) => {
      calls.push(input.mode)
      return input.mode === 'agent'
        ? agentCatalog.promise
        : success([descriptor('chat-model')])
    }),
  })

  const initializing = controller.actions.initialize(bootstrap([]))
  await waitFor(() => calls.includes('agent'))
  await controller.actions.selectMode('chat')
  assert.equal(controller.getSnapshot().mode, 'chat')
  assert.equal(controller.getSnapshot().selectedModel?.id, 'chat-model')
  assert.equal(controller.getSnapshot().catalog.connected, true)

  agentCatalog.resolve(success([descriptor('late-agent-model')]))
  await initializing
  assert.equal(controller.getSnapshot().mode, 'chat')
  assert.equal(controller.getSnapshot().selectedModel?.id, 'chat-model')
  controller.dispose()
})

test('group changes are disconnected until that exact catalog is confirmed', async () => {
  const refreshedBeta = deferred<ApiResult<ModelDescriptor[]>>()
  let betaCalls = 0
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['alpha', 'beta'], async (input) => {
      if (input.groupId === 'alpha') return success([descriptor('alpha-model')])
      betaCalls += 1
      return betaCalls === 1
        ? success([descriptor('beta-initial')])
        : refreshedBeta.promise
    }),
  })

  await controller.actions.initialize(bootstrap([descriptor('alpha-model')]))
  const selecting = controller.actions.selectGroup('beta')
  assert.equal(controller.getSnapshot().groupId, 'beta')
  assert.equal(controller.getSnapshot().catalog.state, 'loading')
  assert.equal(controller.getSnapshot().catalog.connected, false)

  refreshedBeta.resolve(success([descriptor('beta-refreshed')]))
  await selecting
  assert.equal(controller.getSnapshot().selectedModel?.id, 'beta-refreshed')
  assert.equal(controller.getSnapshot().catalog.connected, true)
  controller.dispose()
})

test('model changes reconcile reasoning and optional capabilities in one snapshot', async () => {
  const capable = descriptor('capable')
  const limited = descriptor('limited', {
    wireMode: 'lite',
    reasoning: ['auto', 'light'],
    capabilities: {
      attachments: true,
      imageInput: false,
      imageGeneration: false,
      subagents: false,
      toolUse: true,
      webSearch: false,
    },
    declaredCapabilities: { subagents: false },
  })
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['default'], async () => success([capable, limited])),
  })

  await controller.actions.initialize(bootstrap([capable, limited], capable.id))
  controller.actions.setCapability('webSearch', true)
  controller.actions.setCapability('imageGeneration', true)
  controller.actions.setCapability('localSubagents', true)
  controller.actions.selectModel(limited.id)

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.reasoning.effort, 'auto')
  assert.match(snapshot.reasoning.notice, /Ultra/)
  assert.deepEqual(snapshot.reasoning.options.map((option) => option.effort), ['auto', 'light'])
  assert.deepEqual(snapshot.capabilities.webSearch, { enabled: false, available: false })
  assert.deepEqual(snapshot.capabilities.imageGeneration, { enabled: false, available: false, locked: false })
  assert.deepEqual(snapshot.capabilities.localSubagents, { enabled: false, available: false })
  assert.match(snapshot.capabilities.notice, /Responses Lite/)

  controller.actions.selectReasoning('high')
  assert.equal(controller.getSnapshot().reasoning.effort, 'auto')
  assert.match(controller.getSnapshot().reasoning.notice, /High/)
  controller.actions.selectReasoning('light')
  assert.equal(controller.getSnapshot().reasoning.effort, 'light')
  assert.equal(controller.getSnapshot().reasoning.notice, '')
  controller.dispose()
})

test('local subagents follow every confirmed Agent tool protocol, not only Responses', async () => {
  const openAiAgent = descriptor('deepseek-agent', {
    endpointTypes: ['openai'],
    preferredChatEndpoint: 'openai',
    preferredChatTransport: 'chat-completions',
    capabilities: {
      ...descriptor('base').capabilities,
      subagents: false,
      toolUse: true,
    },
  })
  const explicitlyDisabled = descriptor('disabled-agent', {
    endpointTypes: ['anthropic'],
    preferredChatEndpoint: 'anthropic',
    preferredChatTransport: 'anthropic',
    declaredCapabilities: { subagents: false },
  })
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['default'], async () => success([openAiAgent, explicitlyDisabled])),
  })

  await controller.actions.initialize(bootstrap([openAiAgent, explicitlyDisabled], openAiAgent.id))
  assert.equal(controller.getSnapshot().capabilities.localSubagents.available, true)
  // Delegation is an Agent model capability. It is exposed without a user
  // toggle, and a legacy attempt to disable it must not change the projection.
  assert.equal(controller.getSnapshot().capabilities.localSubagents.enabled, true)
  controller.actions.setCapability('localSubagents', false)
  assert.equal(controller.getSnapshot().capabilities.localSubagents.enabled, true)

  controller.actions.selectModel(explicitlyDisabled.id)
  assert.deepEqual(controller.getSnapshot().capabilities.localSubagents, {
    enabled: false,
    available: false,
  })
  controller.dispose()
})

test('automatic delegation projection is isolated from Chat mode', async () => {
  const capable = descriptor('chat-capable-agent')
  const controller = createModelSelectionController({
    runtime: 'desktop',
    adapter: adapter(['default'], async () => success([capable])),
  })

  await controller.actions.initialize(bootstrap([capable]))
  assert.deepEqual(controller.getSnapshot().capabilities.localSubagents, {
    enabled: true,
    available: true,
  })

  await controller.actions.selectMode('chat')
  assert.deepEqual(controller.getSnapshot().capabilities.localSubagents, {
    enabled: false,
    available: false,
  })
  controller.dispose()
})
