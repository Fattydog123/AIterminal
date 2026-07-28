import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createJiti } from 'jiti'

import type { WorkflowDocument, WorkflowNode } from '../../src/studio/shared/types.ts'

const loadRunner = async () => {
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })
  return jiti.import<typeof import('../../src/main/studio/runner.ts')>(
    '../../src/main/studio/runner.ts',
  )
}

const imageNode = (type = 'image_generation'): WorkflowNode => ({
  id: 'image-node',
  type,
  name: 'Image node',
  position: { x: 0, y: 0 },
  parameters: {
    providerId: 'account-group-test',
    model: 'gpt-image-2-2k',
    size: '1024x1024',
    quality: 'high',
    count: 2,
    responseFormat: 'url',
    outputFormat: 'webp',
    outputCompression: 82,
    background: 'opaque',
    moderation: 'low',
    extra: { style: 'flat', custom_flag: true },
    seed: 41,
  },
})

test('confirmed-only generation sends exactly the minimal request that was verified', async () => {
  const { buildImageNodeRequest } = await loadRunner()

  assert.deepEqual(
    buildImageNodeRequest(imageNode(), 'gpt-image-2-2k', 'Draw a terminal.', true),
    {
      model: 'gpt-image-2-2k',
      prompt: 'Draw a terminal.',
      count: 2,
    },
  )
})

test('server-declared image models retain explicit generation parameters', async () => {
  const { buildImageNodeRequest } = await loadRunner()

  assert.deepEqual(
    buildImageNodeRequest(imageNode(), 'gpt-image-2-2k', 'Draw a terminal.', false),
    {
      model: 'gpt-image-2-2k',
      prompt: 'Draw a terminal.',
      count: 2,
      extra: { style: 'flat', custom_flag: true },
      size: '1024x1024',
      quality: 'high',
      responseFormat: 'url',
      outputFormat: 'webp',
      outputCompression: 82,
      background: 'opaque',
      moderation: 'low',
    },
  )
})

test('confirmed-only edit operations fail before credentials or provider dispatch', async () => {
  const { WorkflowRunner } = await loadRunner()
  let credentialCalls = 0
  const descriptor = {
    id: 'account-group-test',
    name: 'Image group',
    kind: 'openai-compatible' as const,
    baseUrl: 'https://relay.example.test/v1',
    defaultModel: 'gpt-image-2-2k',
    timeoutMs: 300_000,
    maxImageBytes: 104_857_600,
    proxyMode: 'system' as const,
    hasSecret: true,
    maskedSecret: '账户会话',
    managedBy: 'ai-terminal-account' as const,
    confirmedOnlyModels: ['gpt-image-2-2k'],
  }
  const runner = new WorkflowRunner(
    {
      summary: async () => ({ id: 'project-confirmed-only' }),
      upsertQueuedRun: async (_projectPath: string, item: unknown) => item,
      upsertTask: async (_projectPath: string, task: unknown) => task,
      removeQueuedRun: async () => true,
    } as never,
    {
      descriptor: async () => descriptor,
      credentials: async () => {
        credentialCalls += 1
        throw new Error('credentials must not be reached')
      },
    } as never,
    () => undefined,
  )
  const workflow: WorkflowDocument = {
    schemaVersion: 3,
    id: 'confirmed-only-edit-workflow',
    name: 'Confirmed-only edit',
    revision: 0,
    nodes: [
      {
        id: 'source-node',
        type: 'project_image',
        name: 'Source image',
        position: { x: 0, y: 0 },
        parameters: { path: 'assets/imports/source.png' },
      },
      {
        id: 'prompt-node',
        type: 'text',
        name: 'Prompt',
        position: { x: 0, y: 160 },
        parameters: { text: 'Edit the image.' },
      },
      imageNode('image_edit'),
    ],
    edges: [
      {
        id: 'source-to-image',
        sourceNode: 'source-node',
        sourceSocket: 'image',
        targetNode: 'image-node',
        targetSocket: 'image',
      },
      {
        id: 'prompt-to-image',
        sourceNode: 'prompt-node',
        sourceSocket: 'text',
        targetNode: 'image-node',
        targetSocket: 'prompt',
      },
    ],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  }
  const overrides = {
    'source-node': {
      action: 'mock' as const,
      value: { image: 'assets/imports/source.png' },
    },
  }
  const plan = runner.prepare({ projectPath: 'C:\\test-project', workflow, overrides })

  const result = await runner.start({ projectPath: 'C:\\test-project', workflow, planId: plan.id, overrides })

  assert.equal(result.status, 'failed')
  assert.equal(result.dispatchState, 'not_sent')
  assert.equal(result.error?.code, 'confirmed-image-edit-unavailable')
  assert.equal(credentialCalls, 0)
})
