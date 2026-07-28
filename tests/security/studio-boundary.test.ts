import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

import { redactText } from '../../src/main/studio/errors.ts'
import { StudioPathTokenError, StudioPathTokenStore } from '../../src/main/studio/path-token-store.ts'
import type { WorkflowDocument } from '../../src/studio/shared/types.ts'
import { studioIpcTestHandlers } from './fixtures/electron-main-stub.ts'

const electronStubPath = fileURLToPath(new URL('./fixtures/electron-main-stub.ts', import.meta.url))

const imageWorkflow = (providerId: string, nodeType = 'image_generation'): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-account-provider-boundary',
  name: 'Account provider boundary',
  revision: 0,
  nodes: [
    {
      id: 'prompt-node',
      type: 'text',
      name: 'Prompt',
      position: { x: 0, y: 0 },
      parameters: { text: 'test prompt' },
    },
    {
      id: 'image-node',
      type: nodeType,
      name: 'Generate image',
      position: { x: 320, y: 0 },
      parameters: { providerId, model: 'gpt-image-2' },
    },
  ],
  edges: [{
    id: 'prompt-to-image',
    sourceNode: 'prompt-node',
    sourceSocket: 'text',
    targetNode: 'image-node',
    targetSocket: 'prompt',
  }],
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
})

const trustedInvokeEvent = {
  sender: {
    id: 17,
    mainFrame: { routingId: 23 },
  },
  senderFrame: {
    routingId: 23,
    url: 'http://127.0.0.1:5173/studio',
  },
}

test('Studio project grants reject raw paths and are revoked with the session', () => {
  const store = new StudioPathTokenStore()
  const absolutePath = 'C:\\Users\\example\\Pictures\\private-project'
  const token = store.issueProject(absolutePath)

  assert.match(token, /^studio-project:[A-Za-z0-9_-]{43}$/)
  assert.equal(store.issueProject(absolutePath), token)
  assert.throws(() => store.resolveProject(absolutePath), StudioPathTokenError)
  store.revokeAll()
  assert.throws(() => store.resolveProject(token), StudioPathTokenError)
})

test('Studio redaction removes credentials and absolute local paths', () => {
  const output = redactText(
    '读取失败：C:\\Users\\example\\Pictures\\secret.png Bearer sk-example12345678'
  )

  assert.equal(output.includes('example'), false)
  assert.equal(output.includes('secret.png'), false)
  assert.equal(output.includes('sk-example'), false)
  assert.match(output, /\[LOCAL_PATH\]/)
})

test('Studio provider IPC exposes and probes only logged-in NewAPI account groups', async () => {
  studioIpcTestHandlers.clear()
  const jiti = createJiti(import.meta.url, {
    alias: { electron: electronStubPath },
    fsCache: false,
    moduleCache: false,
  })
  const { registerIpc } = await jiti.import<typeof import('../../src/main/studio/ipc.ts')>(
    '../../src/main/studio/ipc.ts',
  )
  const accountProvider = {
    id: 'account-group-test',
    name: 'Account group',
    kind: 'openai-compatible' as const,
    baseUrl: 'https://relay.example.test/v1',
    defaultModel: 'gpt-image-2',
    timeoutMs: 300_000,
    maxImageBytes: 104_857_600,
    proxyMode: 'system' as const,
    hasSecret: true,
    maskedSecret: '账户会话',
    managedBy: 'ai-terminal-account' as const,
    groupId: 'default',
    availableModels: ['gpt-image-2'],
  }
  const legacyProvider = {
    ...accountProvider,
    id: 'legacy-provider',
    name: 'Legacy provider',
    managedBy: undefined,
  }
  let upsertCalls = 0
  let deleteCalls = 0
  let credentialCalls = 0
  let consentCalls = 0
  const registration = registerIpc({
    projects: {} as never,
    providers: {
      list: async () => [legacyProvider, accountProvider],
      upsert: async () => {
        upsertCalls += 1
        return legacyProvider
      },
      delete: async () => {
        deleteCalls += 1
        return true
      },
      descriptor: async (providerId: string) => providerId === accountProvider.id ? accountProvider : legacyProvider,
      credentials: async () => {
        credentialCalls += 1
        return { descriptor: accountProvider, apiKey: 'test-key-main-only' }
      },
    } as never,
    providerImports: { dismiss: () => true } as never,
    runner: {} as never,
    assets: {} as never,
    paths: {} as never,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 17 },
    }) as never,
    isSessionUnlocked: () => true,
    ensureEndpointConsent: async () => { consentCalls += 1 },
    allowedRendererOrigin: 'http://127.0.0.1:5173',
  })

  try {
    const bootstrap = studioIpcTestHandlers.get('studio:bootstrap')
    const list = studioIpcTestHandlers.get('studio:provider:list')
    const upsert = studioIpcTestHandlers.get('studio:provider:upsert')
    const remove = studioIpcTestHandlers.get('studio:provider:delete')
    const probe = studioIpcTestHandlers.get('studio:provider:probe')
    const importList = studioIpcTestHandlers.get('studio:provider:import:list')
    const importAccept = studioIpcTestHandlers.get('studio:provider:import:accept')
    assert.ok(bootstrap)
    assert.ok(list)
    assert.ok(upsert)
    assert.ok(remove)
    assert.ok(probe)
    assert.ok(importList)
    assert.ok(importAccept)

    assert.deepEqual((await bootstrap(trustedInvokeEvent) as { providers: unknown[] }).providers, [accountProvider])
    assert.deepEqual(await list(trustedInvokeEvent), [accountProvider])
    assert.deepEqual(await importList(trustedInvokeEvent), [])
    await assert.rejects(
      upsert(trustedInvokeEvent, {
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
      /\[studio-account-provider-required\]/u,
    )
    await assert.rejects(
      remove(trustedInvokeEvent, { providerId: legacyProvider.id }),
      /\[studio-account-provider-required\]/u,
    )
    await assert.rejects(
      probe(trustedInvokeEvent, { providerId: legacyProvider.id }),
      /\[studio-account-provider-required\]/u,
    )
    await assert.rejects(
      importAccept(trustedInvokeEvent, { requestId: 'legacy-import' }),
      /\[studio-account-provider-required\]/u,
    )
    assert.equal(upsertCalls, 0)
    assert.equal(deleteCalls, 0)
    assert.equal(credentialCalls, 0)
    assert.equal(consentCalls, 0)
  } finally {
    registration.dispose()
    studioIpcTestHandlers.clear()
  }
})

test('Studio dispatch rejects every legacy local image provider path before endpoint consent', async () => {
  studioIpcTestHandlers.clear()
  const jiti = createJiti(import.meta.url, {
    alias: { electron: electronStubPath },
    fsCache: false,
    moduleCache: false,
  })
  const { registerIpc } = await jiti.import<typeof import('../../src/main/studio/ipc.ts')>(
    '../../src/main/studio/ipc.ts',
  )
  let consentCalls = 0
  let startCalls = 0
  let resumeCalls = 0
  const persistentWorkflow = imageWorkflow('legacy-local-provider')
  const registration = registerIpc({
    projects: {
      listQueuedRuns: async () => [{ id: 'persistent-local-provider', workflow: persistentWorkflow }],
    } as never,
    providers: {
      descriptor: async () => ({
        id: 'legacy-local-provider',
        name: 'Legacy local provider',
        kind: 'openai-compatible',
        baseUrl: 'https://legacy-provider.example.test/v1',
        defaultModel: 'gpt-image-2',
        timeoutMs: 300_000,
        maxImageBytes: 100_000_000,
        proxyMode: 'system',
        hasSecret: true,
        maskedSecret: '********',
      }),
    } as never,
    providerImports: {} as never,
    runner: {
      start: async () => {
        startCalls += 1
        return { runId: 'plan-local-provider', status: 'succeeded', dispatchState: 'not_sent', outputs: {} }
      },
      resumePersistent: async () => {
        resumeCalls += 1
        return { runId: 'persistent-local-provider', status: 'succeeded', dispatchState: 'not_sent', outputs: {} }
      },
    } as never,
    assets: {} as never,
    paths: { resolveProject: () => 'C:\\test-project' } as never,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 17 },
    }) as never,
    isSessionUnlocked: () => true,
    ensureEndpointConsent: async () => { consentCalls += 1 },
    allowedRendererOrigin: 'http://127.0.0.1:5173',
  })

  try {
    const startHandler = studioIpcTestHandlers.get('studio:run:start')
    const resumeHandler = studioIpcTestHandlers.get('studio:run:persistent:resume')
    assert.ok(startHandler)
    assert.ok(resumeHandler)
    for (const nodeType of ['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint']) {
      await assert.rejects(
        startHandler(trustedInvokeEvent, {
          projectPath: 'studio-project:test',
          workflow: imageWorkflow('legacy-local-provider', nodeType),
          planId: `plan-${nodeType}`,
        }),
        /账号分组/u,
      )
    }
    await assert.rejects(
      resumeHandler(trustedInvokeEvent, {
        projectPath: 'studio-project:test',
        itemId: 'persistent-local-provider',
      }),
      /账号分组/u,
    )
    assert.equal(consentCalls, 0)
    assert.equal(startCalls, 0)
    assert.equal(resumeCalls, 0)
  } finally {
    registration.dispose()
    studioIpcTestHandlers.clear()
  }
})

test('Studio run start consents and runs with an AI-terminal account provider', async () => {
  studioIpcTestHandlers.clear()
  const jiti = createJiti(import.meta.url, {
    alias: { electron: electronStubPath },
    fsCache: false,
    moduleCache: false,
  })
  const { registerIpc } = await jiti.import<typeof import('../../src/main/studio/ipc.ts')>(
    '../../src/main/studio/ipc.ts',
  )
  const consentedEndpoints: string[][] = []
  let startCalls = 0
  const registration = registerIpc({
    projects: {} as never,
    providers: {
      descriptor: async () => ({
        id: 'account-group-test',
        name: 'Account group',
        kind: 'openai-compatible',
        baseUrl: 'https://relay.example.test/v1',
        defaultModel: 'gpt-image-2',
        timeoutMs: 300_000,
        maxImageBytes: 100_000_000,
        proxyMode: 'system',
        hasSecret: true,
        maskedSecret: '账户会话',
        managedBy: 'ai-terminal-account',
        imageGenerationPath: '/v1/custom/images/generations',
        imageEditPath: '/v1/custom/images/edits',
      }),
    } as never,
    providerImports: {} as never,
    runner: {
      start: async () => {
        startCalls += 1
        return { runId: 'plan-account-provider', status: 'succeeded', dispatchState: 'sent', outputs: {} }
      },
    } as never,
    assets: {} as never,
    paths: { resolveProject: () => 'C:\\test-project' } as never,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 17 },
    }) as never,
    isSessionUnlocked: () => true,
    ensureEndpointConsent: async (endpoints) => { consentedEndpoints.push([...endpoints]) },
    allowedRendererOrigin: 'http://127.0.0.1:5173',
  })

  try {
    const handler = studioIpcTestHandlers.get('studio:run:start')
    assert.ok(handler)
    const result = await handler(trustedInvokeEvent, {
      projectPath: 'studio-project:test',
      workflow: imageWorkflow('account-group-test'),
      planId: 'plan-account-provider',
    })
    await handler(trustedInvokeEvent, {
      projectPath: 'studio-project:test',
      workflow: imageWorkflow('account-group-test', 'image_edit'),
      planId: 'plan-account-provider-edit',
    })
    assert.deepEqual(result, {
      runId: 'plan-account-provider',
      status: 'succeeded',
      dispatchState: 'sent',
      outputs: {},
    })
    assert.deepEqual(consentedEndpoints, [
      ['https://relay.example.test/v1/custom/images/generations'],
      ['https://relay.example.test/v1/custom/images/edits'],
    ])
    assert.equal(startCalls, 2)
  } finally {
    registration.dispose()
    studioIpcTestHandlers.clear()
  }
})

test('Studio image editing fails closed when a custom generation route has no safe edit sibling', async () => {
  studioIpcTestHandlers.clear()
  const jiti = createJiti(import.meta.url, {
    alias: { electron: electronStubPath },
    fsCache: false,
    moduleCache: false,
  })
  const { registerIpc } = await jiti.import<typeof import('../../src/main/studio/ipc.ts')>(
    '../../src/main/studio/ipc.ts',
  )
  let consentCalls = 0
  let startCalls = 0
  const registration = registerIpc({
    projects: {} as never,
    providers: {
      descriptor: async () => ({
        id: 'account-group-generation-only',
        name: 'Generation-only account group',
        kind: 'openai-compatible',
        baseUrl: 'https://relay.example.test/v1',
        defaultModel: 'gpt-image-2',
        timeoutMs: 300_000,
        maxImageBytes: 100_000_000,
        proxyMode: 'system',
        hasSecret: true,
        maskedSecret: '账户会话',
        managedBy: 'ai-terminal-account',
        imageGenerationPath: '/v1/custom/generate-image',
      }),
    } as never,
    providerImports: {} as never,
    runner: {
      start: async () => {
        startCalls += 1
        return { runId: 'unexpected', status: 'succeeded', dispatchState: 'sent', outputs: {} }
      },
    } as never,
    assets: {} as never,
    paths: { resolveProject: () => 'C:\\test-project' } as never,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 17 },
    }) as never,
    isSessionUnlocked: () => true,
    ensureEndpointConsent: async () => { consentCalls += 1 },
    allowedRendererOrigin: 'http://127.0.0.1:5173',
  })

  try {
    const handler = studioIpcTestHandlers.get('studio:run:start')
    assert.ok(handler)
    await assert.rejects(
      handler(trustedInvokeEvent, {
        projectPath: 'studio-project:test',
        workflow: imageWorkflow('account-group-generation-only', 'image_edit'),
        planId: 'plan-generation-only-edit',
      }),
      /无法安全派生/u,
    )
    assert.equal(consentCalls, 0)
    assert.equal(startCalls, 0)
  } finally {
    registration.dispose()
    studioIpcTestHandlers.clear()
  }
})

test('WorkflowRunner rejects a legacy local image provider before queueing or reading credentials', async () => {
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })
  const { WorkflowRunner } = await jiti.import<typeof import('../../src/main/studio/runner.ts')>(
    '../../src/main/studio/runner.ts',
  )
  let projectCalls = 0
  let credentialCalls = 0
  const runner = new WorkflowRunner(
    {
      summary: async () => {
        projectCalls += 1
        throw new Error('project queue must not be reached')
      },
    } as never,
    {
      descriptor: async () => ({
        id: 'legacy-local-provider',
        name: 'Legacy local provider',
        kind: 'openai-compatible',
        baseUrl: 'https://legacy-provider.example.test/v1',
        defaultModel: 'gpt-image-2',
        timeoutMs: 300_000,
        maxImageBytes: 100_000_000,
        proxyMode: 'system',
        hasSecret: true,
        maskedSecret: '********',
      }),
      credentials: async () => {
        credentialCalls += 1
        throw new Error('credentials must not be reached')
      },
    } as never,
    () => undefined,
  )
  const workflow = imageWorkflow('legacy-local-provider')
  const plan = runner.prepare({ projectPath: 'C:\\test-project', workflow })

  await assert.rejects(
    runner.start({ projectPath: 'C:\\test-project', workflow, planId: plan.id }),
    /账号分组/u,
  )
  assert.equal(projectCalls, 0)
  assert.equal(credentialCalls, 0)
})

test('WorkflowRunner rechecks account provider ownership immediately before image execution', async () => {
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })
  const { WorkflowRunner } = await jiti.import<typeof import('../../src/main/studio/runner.ts')>(
    '../../src/main/studio/runner.ts',
  )
  let descriptorCalls = 0
  let credentialCalls = 0
  const runner = new WorkflowRunner(
    {
      summary: async () => ({ id: 'project-account-provider-boundary' }),
      upsertQueuedRun: async (_projectPath: string, item: unknown) => item,
      upsertTask: async (_projectPath: string, task: unknown) => task,
      removeQueuedRun: async () => true,
    } as never,
    {
      descriptor: async () => {
        descriptorCalls += 1
        return {
          id: 'account-group-test',
          name: 'Account group',
          kind: 'openai-compatible',
          baseUrl: 'https://relay.example.test/v1',
          defaultModel: 'gpt-image-2',
          timeoutMs: 300_000,
          maxImageBytes: 100_000_000,
          proxyMode: 'system',
          hasSecret: true,
          maskedSecret: '账户会话',
          ...(descriptorCalls === 1 ? { managedBy: 'ai-terminal-account' as const } : {}),
        }
      },
      credentials: async () => {
        credentialCalls += 1
        throw new Error('credentials must not be reached')
      },
    } as never,
    () => undefined,
  )
  const workflow = imageWorkflow('account-group-test')
  const plan = runner.prepare({ projectPath: 'C:\\test-project', workflow })

  const result = await runner.start({ projectPath: 'C:\\test-project', workflow, planId: plan.id })

  assert.equal(result.status, 'failed')
  assert.equal(result.dispatchState, 'not_sent')
  assert.equal(result.error?.code, 'studio-account-provider-required')
  assert.match(result.error?.message ?? '', /账号分组/u)
  assert.equal(descriptorCalls, 2)
  assert.equal(credentialCalls, 0)
})

test('WorkflowRunner confirms the refreshed exact image endpoint before dispatch', async () => {
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })
  const { WorkflowRunner } = await jiti.import<typeof import('../../src/main/studio/runner.ts')>(
    '../../src/main/studio/runner.ts',
  )
  const projectPath = await mkdtemp(join(tmpdir(), 'studio-endpoint-consent-'))
  const confirmedEndpoints: string[] = []
  let credentialCalls = 0
  const oldDescriptor = {
    id: 'account-group-test',
    name: 'Account group',
    kind: 'openai-compatible' as const,
    baseUrl: 'https://relay.example.test/v1',
    defaultModel: 'gpt-image-2',
    timeoutMs: 300_000,
    maxImageBytes: 100_000_000,
    proxyMode: 'system' as const,
    hasSecret: true,
    maskedSecret: '账户会话',
    managedBy: 'ai-terminal-account' as const,
    imageGenerationPath: '/v1/old/images/generations',
  }
  const runner = new WorkflowRunner(
    {
      summary: async () => ({ id: 'project-account-provider-boundary' }),
      upsertQueuedRun: async (_path: string, item: unknown) => item,
      upsertTask: async (_path: string, task: unknown) => task,
      removeQueuedRun: async () => true,
    } as never,
    {
      descriptor: async () => oldDescriptor,
      credentials: async () => {
        credentialCalls += 1
        return {
          descriptor: {
            ...oldDescriptor,
            imageGenerationPath: '/v1/refreshed/images/generations',
          },
          apiKey: 'test-key-never-sent',
        }
      },
    } as never,
    () => undefined,
    async (endpoint) => {
      confirmedEndpoints.push(endpoint)
      throw new Error('endpoint changed after initial consent')
    },
  )
  const workflow = imageWorkflow('account-group-test')
  const plan = runner.prepare({ projectPath, workflow })

  try {
    const result = await runner.start({ projectPath, workflow, planId: plan.id })

    assert.equal(result.status, 'failed')
    assert.equal(result.dispatchState, 'not_sent')
    assert.equal(result.error?.code, 'studio-endpoint-consent-denied')
    assert.equal(credentialCalls, 1)
    assert.deepEqual(confirmedEndpoints, [
      'https://relay.example.test/v1/refreshed/images/generations',
    ])
  } finally {
    await rm(projectPath, { recursive: true, force: true })
  }
})

test('WorkflowRunner rejects a persistent workflow changed after endpoint consent', async () => {
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })
  const { WorkflowRunner } = await jiti.import<typeof import('../../src/main/studio/runner.ts')>(
    '../../src/main/studio/runner.ts',
  )
  const consentedWorkflow = imageWorkflow('account-group-consented')
  const changedWorkflow = imageWorkflow('account-group-changed')
  let descriptorCalls = 0
  let projectCalls = 0
  let credentialCalls = 0
  const runner = new WorkflowRunner(
    {
      listQueuedRuns: async () => [{
        schemaVersion: 1,
        id: 'persistent-consent-race',
        projectId: 'project-account-provider-boundary',
        workflowId: changedWorkflow.id,
        status: 'paused',
        priority: 0,
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
        workflow: changedWorkflow,
        targetNodeIds: [],
        overrides: {},
        attempt: 0,
        dispatchState: 'not_sent',
        remoteJobs: [],
      }],
      summary: async () => {
        projectCalls += 1
        throw new Error('changed persistent workflow must not be queued')
      },
    } as never,
    {
      descriptor: async () => {
        descriptorCalls += 1
        return {
          id: 'account-group-changed',
          name: 'Changed account group',
          kind: 'openai-compatible',
          baseUrl: 'https://changed-relay.example.test/v1',
          defaultModel: 'gpt-image-2',
          timeoutMs: 300_000,
          maxImageBytes: 100_000_000,
          proxyMode: 'system',
          hasSecret: true,
          maskedSecret: '账户会话',
          managedBy: 'ai-terminal-account' as const,
        }
      },
      credentials: async () => {
        credentialCalls += 1
        throw new Error('credentials must not be reached')
      },
    } as never,
    () => undefined,
  )

  await assert.rejects(
    runner.resumePersistent('C:\\test-project', 'persistent-consent-race', consentedWorkflow),
    /确认后已发生变化/u,
  )
  assert.equal(descriptorCalls, 0)
  assert.equal(projectCalls, 0)
  assert.equal(credentialCalls, 0)
})
