import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  StudioAccountProviderAdapter,
  type StudioImageCapabilitySource,
  type StudioProviderSnapshotSource,
  type StudioAccountRelay
} from '../../src/main/studio/account-providers.ts'
import { StudioProviderSnapshotStore } from '../../src/main/studio/provider-snapshot-store.ts'
import { ProviderStore } from '../../src/main/studio/providers.ts'
import { RelayServiceError } from '../../src/main/services/relay-service.ts'
import type { OpenAiProviderDescriptor } from '../../src/studio/shared/types.ts'

function createRelay(overrides: Partial<StudioAccountRelay> = {}): StudioAccountRelay {
  return {
    serverOrigin: 'https://relay.example.test',
    getAuthenticationState: () => ({ authenticated: true, device_id: 'device-test' }),
    ensureAuthenticatedSession: async () => ({ authenticated: true, device_id: 'device-test' }),
    getTokenBackedUserGroups: async () => ({
      default: { ratio: 1, desc: '默认分组' },
      image: { ratio: 0.8, desc: '图像分组' }
    }),
    getUserModels: async () => ['gpt-5.6-sol', 'gpt-image-2'],
    getUserModelsForGroup: async () => ['gpt-5.6-sol', 'gpt-image-2'],
    getEligibleModelIdsForGroup: async (_groupId, modelIds) => [...modelIds],
    getPricing: async () => ({
      data: [
        {
          model_name: 'gpt-5.6-sol',
          quota_type: 0,
          model_ratio: 1,
          model_price: 0,
          owner_by: 'openai',
          completion_ratio: 1,
          enable_groups: ['default', 'image'],
          supported_endpoint_types: ['openai-response']
        },
        {
          model_name: 'gpt-image-2',
          quota_type: 0,
          model_ratio: 1,
          model_price: 0,
          owner_by: 'openai',
          completion_ratio: 1,
          enable_groups: ['default', 'image'],
          supported_endpoint_types: ['image-generation']
        }
      ],
      supported_endpoint: {
        'image-generation': { path: '/v1/custom/images/generations', method: 'POST' }
      }
    }),
    getSelectedModelAccessCredentials: async () => ({
      baseUrl: 'https://relay.example.test/v1',
      apiKey: 'test-key-main-only',
      tokenId: 7
    }),
    ...overrides
  }
}

function confirmedImageCapabilities(
  entries: readonly { readonly groupId: string; readonly modelId: string; readonly imageGenerationPath?: string }[]
): StudioImageCapabilitySource {
  return {
    list: async () => entries.map((entry) => ({
      groupId: entry.groupId,
      modelId: entry.modelId,
      imageGenerationPath: entry.imageGenerationPath ?? '/v1/images/generations',
      confirmedAt: 500,
      expiresAt: 5_000,
    }))
  }
}

function cachedImageProvider(
  groupId = 'image',
  models: readonly string[] = ['gpt-image-2'],
): OpenAiProviderDescriptor {
  return {
    id: `account-group-${createHash('sha256').update(groupId).digest('hex').slice(0, 24)}`,
    name: groupId,
    kind: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    defaultModel: models[0]!,
    timeoutMs: 300_000,
    maxImageBytes: 104_857_600,
    proxyMode: 'system',
    hasSecret: true,
    maskedSecret: '账户会话',
    managedBy: 'ai-terminal-account',
    groupId,
    availableModels: [...models],
    imageGenerationPath: '/v1/images/generations',
    imageEditPath: '/v1/images/edits',
  }
}

test('Studio keeps the last valid provider columns when a catalog endpoint is temporarily unavailable', async () => {
  const cached = [cachedImageProvider('image', ['gpt-image-2-2k'])]
  let snapshotLoads = 0
  let credentialRequests = 0
  const snapshots: StudioProviderSnapshotSource = {
    load: async () => {
      snapshotLoads += 1
      return cached
    },
    save: async () => undefined,
  }
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => {
      throw new RelayServiceError('remote_unavailable')
    },
    getSelectedModelAccessCredentials: async () => {
      credentialRequests += 1
      return { baseUrl: 'https://relay.example.test/v1', apiKey: 'must-not-load', tokenId: 7 }
    },
  }), () => 1_000, undefined, snapshots)

  const providers = await adapter.list()
  assert.equal(snapshotLoads, 1)
  assert.deepEqual(providers.map((provider) => provider.groupId), ['image'])
  assert.deepEqual(providers[0]?.availableModels, ['gpt-image-2-2k'])

  await assert.rejects(
    adapter.credentials(cached[0]!.id, 'gpt-image-2-2k'),
    (error: unknown) => error instanceof RelayServiceError && error.code === 'remote_unavailable',
  )
  assert.equal(credentialRequests, 0)
})

test('Studio never falls back to a provider snapshot after authentication is lost', async () => {
  let snapshotLoads = 0
  const snapshots: StudioProviderSnapshotSource = {
    load: async () => {
      snapshotLoads += 1
      return [cachedImageProvider()]
    },
    save: async () => undefined,
  }
  const signedOut = new StudioAccountProviderAdapter(createRelay({
    getAuthenticationState: () => ({ authenticated: false, device_id: null }),
    ensureAuthenticatedSession: async () => ({ authenticated: false, device_id: null }),
  }), () => 1_000, undefined, snapshots)
  assert.deepEqual(await signedOut.list(), [])
  assert.equal(snapshotLoads, 0)

  const expired = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => {
      throw new RelayServiceError('authentication_required')
    },
  }), () => 1_000, undefined, snapshots)
  await assert.rejects(
    expired.list(),
    (error: unknown) => error instanceof RelayServiceError && error.code === 'authentication_required',
  )
  assert.equal(snapshotLoads, 0)
})

test('a successful Studio catalog refresh replaces the fallback provider snapshot', async () => {
  let unavailable = false
  let snapshot: readonly OpenAiProviderDescriptor[] | undefined = [cachedImageProvider('old-image', ['old-image-model'])]
  let snapshotSaves = 0
  const snapshots: StudioProviderSnapshotSource = {
    load: async () => snapshot,
    save: async (providers) => {
      snapshotSaves += 1
      snapshot = structuredClone(providers)
    },
  }
  const relay = createRelay({
    getTokenBackedUserGroups: async () => {
      if (unavailable) throw new RelayServiceError('remote_unavailable')
      return { image: { ratio: 1, desc: '图像分组' } }
    },
  })
  const adapter = new StudioAccountProviderAdapter(relay, () => 1_000, undefined, snapshots)

  const refreshed = await adapter.list()
  assert.equal(snapshotSaves, 1)
  assert.deepEqual(refreshed.map((provider) => provider.groupId), ['image'])
  assert.deepEqual(refreshed[0]?.availableModels, ['gpt-image-2'])

  unavailable = true
  const fallback = await adapter.list()
  assert.deepEqual(fallback, refreshed)
  assert.equal(snapshotSaves, 1)
})

test('Studio provider snapshots validate schema, server binding, TTL, and omit unknown secret fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-terminal-studio-provider-snapshot-'))
  const filePath = join(directory, 'providers.json')
  let now = 1_000
  try {
    const store = new StudioProviderSnapshotStore('https://relay.example.test', filePath, () => now)
    const providerWithSecret = {
      ...cachedImageProvider(),
      apiKey: 'snapshot-secret-must-not-persist',
    } as unknown as OpenAiProviderDescriptor
    await store.save([providerWithSecret])

    const serialized = await readFile(filePath, 'utf8')
    assert.equal(serialized.includes('snapshot-secret-must-not-persist'), false)
    assert.deepEqual((await store.load())?.map((provider) => provider.groupId), ['image'])

    const otherServer = new StudioProviderSnapshotStore('https://other.example.test', filePath, () => now)
    assert.equal(await otherServer.load(), undefined)

    const tampered = JSON.parse(serialized) as { providers: Array<Record<string, unknown>> }
    tampered.providers[0]!.apiKey = 'disk-injected-secret'
    await writeFile(filePath, JSON.stringify(tampered), 'utf8')
    assert.equal(await store.load(), undefined)

    await store.save([cachedImageProvider()])
    now += 24 * 60 * 60 * 1_000 + 1
    assert.equal(await store.load(), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('account groups become renderer-safe Studio providers without credentials', async () => {
  const adapter = new StudioAccountProviderAdapter(createRelay(), () => 1_000)
  const providers = await adapter.list()

  assert.equal(providers.length, 2)
  assert.deepEqual(providers.map((provider) => provider.groupId), ['default', 'image'])
  for (const provider of providers) {
    assert.match(provider.id, /^account-group-[a-f0-9]{24}$/)
    assert.equal(provider.managedBy, 'ai-terminal-account')
    assert.equal(provider.defaultModel, 'gpt-image-2')
    assert.deepEqual(provider.availableModels, ['gpt-image-2'])
    assert.equal(provider.imageGenerationPath, '/v1/custom/images/generations')
    assert.equal(provider.imageEditPath, '/v1/custom/images/edits')
    assert.equal(JSON.stringify(provider).includes('test-key-main-only'), false)
  }
})

test('Studio refreshes an expired account session before listing providers', async () => {
  let refreshes = 0
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getAuthenticationState: () => ({ authenticated: false, device_id: null }),
    ensureAuthenticatedSession: async () => {
      refreshes += 1
      return { authenticated: true, device_id: 'device-refreshed' }
    }
  }))

  const providers = await adapter.list()
  assert.equal(refreshes, 1)
  assert.deepEqual(providers.map((provider) => provider.groupId), ['default', 'image'])
})

test('Studio provider store exposes only account-managed NewAPI groups', async () => {
  const accountProvider: OpenAiProviderDescriptor = {
    id: 'account-group-test',
    name: 'Account group',
    kind: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    defaultModel: 'gpt-image-2',
    timeoutMs: 300_000,
    maxImageBytes: 104_857_600,
    proxyMode: 'system',
    hasSecret: true,
    maskedSecret: '账户会话',
    managedBy: 'ai-terminal-account',
    groupId: 'default',
    availableModels: ['gpt-image-2'],
  }
  const legacyProvider: OpenAiProviderDescriptor = {
    ...accountProvider,
    id: 'legacy-provider',
    name: 'Legacy provider',
    managedBy: undefined,
  }
  const store = new ProviderStore('unused-account-only-state', {
    owns: (providerId) => providerId === accountProvider.id,
    list: async () => [legacyProvider, accountProvider],
    descriptor: async (providerId) => providerId === accountProvider.id ? accountProvider : undefined,
    credentials: async () => ({ descriptor: accountProvider, apiKey: 'test-key-main-only' }),
  })

  assert.deepEqual((await store.list()).map((provider) => provider.id), [accountProvider.id])
  assert.equal((await store.descriptor(accountProvider.id)).managedBy, 'ai-terminal-account')
  assert.equal((await store.credentials(accountProvider.id, 'gpt-image-2')).descriptor.id, accountProvider.id)
  assert.equal(await store.canPersistSecrets(), false)

  await assert.rejects(
    store.upsert({
      id: 'legacy-provider',
      name: 'Legacy provider',
      kind: 'openai-compatible',
      baseUrl: 'https://legacy.example.test/v1',
      defaultModel: 'gpt-image-2',
      timeoutMs: 300_000,
      maxImageBytes: 104_857_600,
      proxyMode: 'system',
      secretUpdate: 'must-not-be-persisted',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'studio-account-provider-required',
  )
  await assert.rejects(
    store.descriptor(legacyProvider.id),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'studio-account-provider-required',
  )
  await assert.rejects(
    store.credentials(legacyProvider.id, 'gpt-image-2'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'studio-account-provider-required',
  )
  await assert.rejects(
    store.delete(legacyProvider.id),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'studio-account-provider-required',
  )
  await assert.rejects(
    store.delete(accountProvider.id),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'managed-provider-read-only',
  )
})

test('Studio derives every group catalog from the exact online group membership', async () => {
  const groupRequests: string[] = []
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({
      default: { ratio: 1 },
      vip: { ratio: 2 },
      auto: { ratio: 'auto' }
    }),
    getUserModels: async () => [
      'image-default',
      'image-vip',
      'image-shared',
      'chat-only'
    ],
    getUserModelsForGroup: async (groupId) => {
      groupRequests.push(groupId)
      return {
        default: ['image-default', 'image-shared'],
        vip: ['image-vip', 'image-shared'],
        auto: ['image-default', 'image-shared'],
      }[groupId] ?? []
    },
    getPricing: async () => ({
      data: [
        {
          model_name: 'image-default', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'test', completion_ratio: 1, enable_groups: ['default'],
          supported_endpoint_types: ['image-generation']
        },
        {
          model_name: 'image-vip', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'test', completion_ratio: 1, enable_groups: ['vip'],
          supported_endpoint_types: ['image-generation']
        },
        {
          model_name: 'image-shared', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'test', completion_ratio: 1, enable_groups: ['all'],
          supported_endpoint_types: ['image-generation']
        },
        {
          model_name: 'chat-only', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'test', completion_ratio: 1, enable_groups: ['default', 'vip'],
          supported_endpoint_types: ['openai']
        }
      ],
      auto_groups: ['default']
    })
  }))

  const providers = await adapter.list()
  const modelsByGroup = Object.fromEntries(providers.map((provider) => [
    provider.groupId,
    provider.availableModels
  ]))

  assert.deepEqual(modelsByGroup, {
    default: ['image-default', 'image-shared'],
    vip: ['image-vip', 'image-shared'],
    auto: ['image-default', 'image-vip', 'image-shared']
  })
  assert.deepEqual([...groupRequests].sort(), ['default', 'vip'])
})

test('future image model names remain visible only when the server declares the Images endpoint', async () => {
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({ image: { ratio: 1 } }),
    getUserModels: async () => ['grok-image-future', 'gemini-image-future', 'grok-name-chat-only'],
    getUserModelsForGroup: async () => ['grok-image-future', 'gemini-image-future', 'grok-name-chat-only'],
    getPricing: async () => ({
      data: [
        {
          model_name: 'grok-image-future', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'xai', completion_ratio: 1, enable_groups: ['image'],
          supported_endpoint_types: ['image-generation']
        },
        {
          model_name: 'gemini-image-future', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'google', completion_ratio: 1, enable_groups: ['image'],
          supported_endpoint_types: ['image-generation']
        },
        {
          model_name: 'grok-name-chat-only', quota_type: 0, model_ratio: 1, model_price: 0,
          owner_by: 'xai', completion_ratio: 1, enable_groups: ['image'],
          supported_endpoint_types: ['openai']
        }
      ],
      supported_endpoint: {
        'image-generation': { path: '/v1/images/generations', method: 'POST' }
      }
    })
  }))

  const [provider] = await adapter.list()
  assert.ok(provider)
  assert.deepEqual(provider.availableModels, ['grok-image-future', 'gemini-image-future'])
  assert.equal(provider.imageGenerationPath, '/v1/images/generations')
})

test('Studio trusts the concrete group model endpoint for membership while pricing supplies endpoint metadata', async () => {
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({ vip: { ratio: 1 } }),
    getUserModels: async () => ['stale-group-model'],
    getUserModelsForGroup: async () => ['stale-group-model'],
    getPricing: async () => ({
      data: [{
        model_name: 'stale-group-model', quota_type: 0, model_ratio: 1, model_price: 0,
        owner_by: 'test', completion_ratio: 1, enable_groups: ['legacy-group'],
        supported_endpoint_types: ['image-generation']
      }]
    })
  }))
  const providers = await adapter.list()
  assert.deepEqual(providers.map((provider) => provider.groupId), ['vip'])
  assert.deepEqual(providers[0]?.availableModels, ['stale-group-model'])
})

test('account provider credentials are selected by exact group and model only in Main', async () => {
  const selections: unknown[] = []
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getSelectedModelAccessCredentials: async (selection) => {
      selections.push(selection)
      return {
        baseUrl: 'https://relay.example.test/v1',
        apiKey: 'test-key-main-only',
        tokenId: 9
      }
    }
  }), () => 1_000)
  const provider = (await adapter.list()).find((item) => item.groupId === 'image')
  assert.ok(provider)

  const credentials = await adapter.credentials(provider.id, 'gpt-image-2')
  assert.deepEqual(selections, [{ groupId: 'image', modelId: 'gpt-image-2' }])
  assert.equal(credentials.apiKey, 'test-key-main-only')
  assert.equal(JSON.stringify(credentials.descriptor).includes(credentials.apiKey), false)
})

test('Studio exposes only image-generation models allowed by a usable token in that exact group', async () => {
  const eligibilityCalls: Array<{ groupId: string; modelIds: readonly string[] }> = []
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({
      default: { ratio: 1 },
      image: { ratio: 1 }
    }),
    getEligibleModelIdsForGroup: async (groupId, modelIds) => {
      eligibilityCalls.push({ groupId, modelIds: [...modelIds] })
      return groupId === 'image' ? [...modelIds] : []
    }
  }))

  const providers = await adapter.list()

  assert.deepEqual(providers.map((provider) => provider.groupId), ['image'])
  assert.deepEqual(providers[0]?.availableModels, ['gpt-image-2'])
  assert.deepEqual(eligibilityCalls, [
    { groupId: 'default', modelIds: ['gpt-5.6-sol', 'gpt-image-2'] },
    { groupId: 'image', modelIds: ['gpt-5.6-sol', 'gpt-image-2'] }
  ])
})

test('Studio never scans account groups that are not backed by a usable token', async () => {
  const requestedGroups: string[] = []
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({ image: { ratio: 1 } }),
    getUserModelsForGroup: async (groupId) => {
      requestedGroups.push(groupId)
      return ['gpt-image-2']
    }
  }))

  const providers = await adapter.list()

  assert.deepEqual(providers.map((provider) => provider.groupId), ['image'])
  assert.deepEqual(requestedGroups, ['image'])
})

test('Studio revalidates token eligibility before retrieving a model key', async () => {
  let eligibilityChecks = 0
  let credentialRequests = 0
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({ image: { ratio: 1 } }),
    getEligibleModelIdsForGroup: async (_groupId, modelIds) => {
      eligibilityChecks += 1
      return eligibilityChecks === 1 ? [...modelIds] : []
    },
    getSelectedModelAccessCredentials: async () => {
      credentialRequests += 1
      return {
        baseUrl: 'https://relay.example.test/v1',
        apiKey: 'must-not-be-retrieved',
        tokenId: 99
      }
    }
  }), () => 1_000)
  const [provider] = await adapter.list()
  assert.ok(provider)

  await assert.rejects(
    adapter.credentials(provider.id, 'gpt-image-2'),
    /已不在该分组的联网目录中.*没有可用令牌/u
  )
  assert.equal(credentialRequests, 0)
})

test('Studio publishes same-group confirmed image models and marks them as confirmation-only', async () => {
  const imageModels = ['gpt-image-2-high', 'gpt-image-2-2k', 'gpt-image-2-4k']
  const selections: unknown[] = []
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({ '生图': { ratio: 1, desc: '图片分组' } }),
    getUserModels: async () => imageModels,
    getUserModelsForGroup: async () => imageModels,
    getEligibleModelIdsForGroup: async (_groupId, modelIds) => [...modelIds],
    getPricing: async () => ({
      data: imageModels.map((model) => ({
        model_name: model,
        quota_type: 0,
        model_ratio: 1,
        model_price: 0,
        owner_by: 'openai',
        completion_ratio: 1,
        enable_groups: ['生图'],
        supported_endpoint_types: ['openai'],
      })),
    }),
    getSelectedModelAccessCredentials: async (selection) => {
      selections.push(selection)
      return {
        baseUrl: 'https://relay.example.test/v1',
        apiKey: 'test-key-main-only',
        tokenId: 13,
      }
    },
  }), () => 1_000, confirmedImageCapabilities(imageModels.map((modelId) => ({
    groupId: '生图',
    modelId,
  }))))

  const [provider] = await adapter.list()
  assert.ok(provider)
  assert.deepEqual(provider.availableModels, imageModels)
  assert.deepEqual(provider.confirmedOnlyModels, imageModels)
  assert.equal(provider.defaultModel, 'gpt-image-2-2k')
  assert.equal(provider.imageGenerationPath, '/v1/images/generations')

  const credentials = await adapter.credentials(provider.id, 'gpt-image-2-4k')
  assert.equal(credentials.apiKey, 'test-key-main-only')
  assert.deepEqual(selections, [{ groupId: '生图', modelId: 'gpt-image-2-4k' }])
})

test('signed-out and unknown account groups fail closed', async () => {
  const signedOut = new StudioAccountProviderAdapter(createRelay({
    getAuthenticationState: () => ({ authenticated: false, device_id: null }),
    ensureAuthenticatedSession: async () => ({ authenticated: false, device_id: null })
  }))
  assert.deepEqual(await signedOut.list(), [])
  await assert.rejects(
    signedOut.credentials(`account-group-${'a'.repeat(24)}`, 'gpt-image-2'),
    /重新登录/u
  )

  const active = new StudioAccountProviderAdapter(createRelay())
  await assert.rejects(
    active.credentials(`account-group-${'f'.repeat(24)}`, 'gpt-image-2'),
    /不存在或已发生变化/u
  )
})

test('account Studio rejects an online Chat model without an image declaration or same-group confirmation', async () => {
  const adapter = new StudioAccountProviderAdapter(createRelay())
  const provider = (await adapter.list())[0]
  assert.ok(provider)
  assert.deepEqual(provider.availableModels, ['gpt-image-2'])
  await assert.rejects(
    adapter.credentials(provider.id, 'gpt-5.6-sol'),
    /没有声明或确认图片生成能力/u
  )
})

test('Studio confirmations never cross groups or survive an endpoint-path change', async () => {
  const relay = createRelay({
    getTokenBackedUserGroups: async () => ({ image: { ratio: 1 }, chat: { ratio: 1 } }),
    getUserModels: async () => ['future-image'],
    getUserModelsForGroup: async () => ['future-image'],
    getPricing: async () => ({
      data: [{
        model_name: 'future-image', quota_type: 0, model_ratio: 1, model_price: 0,
        owner_by: 'test', completion_ratio: 1, enable_groups: ['image', 'chat'],
        supported_endpoint_types: ['openai']
      }],
      supported_endpoint: {
        'image-generation': { path: '/v1/current/images/generations', method: 'POST' }
      }
    })
  })
  const adapter = new StudioAccountProviderAdapter(relay, () => 1_000, confirmedImageCapabilities([
    { groupId: 'image', modelId: 'future-image', imageGenerationPath: '/v1/current/images/generations' },
    { groupId: 'chat', modelId: 'future-image', imageGenerationPath: '/v1/old/images/generations' },
  ]))

  const providers = await adapter.list()
  assert.deepEqual(providers.map((provider) => provider.groupId), ['image'])
  assert.deepEqual(providers[0]?.availableModels, ['future-image'])
  assert.deepEqual(providers[0]?.confirmedOnlyModels, ['future-image'])
})

test('Studio omits token-backed groups that contain conversation models only', async () => {
  const adapter = new StudioAccountProviderAdapter(createRelay({
    getTokenBackedUserGroups: async () => ({ chat: { ratio: 1 } }),
    getUserModels: async () => ['gpt-5.6-sol'],
    getUserModelsForGroup: async () => ['gpt-5.6-sol'],
    getPricing: async () => ({
      data: [{
        model_name: 'gpt-5.6-sol', quota_type: 0, model_ratio: 1, model_price: 0,
        owner_by: 'openai', completion_ratio: 1, enable_groups: ['chat'],
        supported_endpoint_types: ['openai-response']
      }]
    })
  }))

  assert.deepEqual(await adapter.list(), [])
})

test('account Studio fails closed for unsupported or unsafe image route metadata', async () => {
  const unsupportedMethod = new StudioAccountProviderAdapter(createRelay({
    getPricing: async () => ({
      ...(await createRelay().getPricing()),
      supported_endpoint: {
        'image-generation': { path: '/v1/images/generations', method: 'GET' }
      }
    })
  }))
  await assert.rejects(unsupportedMethod.list(), /请求方法不受支持/u)

  const unsafePath = new StudioAccountProviderAdapter(createRelay({
    getPricing: async () => ({
      ...(await createRelay().getPricing()),
      supported_endpoint: {
        'image-generation': { path: '/../images/generations', method: 'POST' }
      }
    })
  }))
  await assert.rejects(unsafePath.list(), /路径无效/u)

  const nonDerivableEditPath = new StudioAccountProviderAdapter(createRelay({
    getPricing: async () => ({
      ...(await createRelay().getPricing()),
      supported_endpoint: {
        'image-generation': { path: '/v1/custom/generate-image', method: 'POST' }
      }
    })
  }))
  const [generationOnly] = await nonDerivableEditPath.list()
  assert.equal(generationOnly?.imageGenerationPath, '/v1/custom/generate-image')
  assert.equal(generationOnly?.imageEditPath, undefined)
})
