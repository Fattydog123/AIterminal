import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

import { createStudioBridge } from '../../src/preload/studio-bridge.ts'
import {
  channels,
  createStudioInvokeRegistrationTracker,
  studioEventOperationNames,
  studioInvokeOperationNames,
  studioOperationCatalog,
  studioOperationNames,
} from '../../src/studio/shared/ipc-channels.ts'
import { studioIpcTestHandlers } from '../security/fixtures/electron-main-stub.ts'

const electronStubPath = fileURLToPath(
  new URL('../security/fixtures/electron-main-stub.ts', import.meta.url),
)

test('Studio operation catalog owns unique operation, channel, and channel-key mappings', () => {
  const definitions = Object.values(studioOperationCatalog)

  assert.equal(new Set(studioOperationNames).size, studioOperationNames.length)
  assert.equal(new Set(definitions.map((definition) => definition.channel)).size, definitions.length)
  assert.equal(new Set(definitions.map((definition) => definition.channelKey)).size, definitions.length)
  for (const definition of definitions) {
    assert.equal(channels[definition.channelKey], definition.channel)
  }
})

test('Studio Copilot planning remains an input invocation in the canonical catalog', () => {
  assert.deepEqual(studioOperationCatalog.planWorkflow, {
    channelKey: 'workflowCopilotPlan',
    channel: 'studio:workflow:copilot:plan',
    kind: 'invoke-input',
  })
})

test('Studio Bridge is generated with every catalog operation and preserves invocation shape', async () => {
  const invokes: Array<{ channel: string; inputs: readonly unknown[] }> = []
  const subscriptions = new Map<string, (value: unknown) => void>()
  const unsubscribed: string[] = []
  const bridge = createStudioBridge({
    invoke: (channel, ...inputs) => {
      invokes.push({ channel, inputs })
      return Promise.resolve(undefined)
    },
    subscribe: (channel, listener) => {
      subscriptions.set(channel, listener)
      return () => { unsubscribed.push(channel) }
    },
  })
  const methods = bridge as unknown as Record<string, (...args: unknown[]) => unknown>

  assert.deepEqual(Object.keys(bridge), studioOperationNames)
  for (const operation of studioOperationNames) {
    const definition = studioOperationCatalog[operation]
    const method = methods[operation]
    assert.equal(typeof method, 'function')
    if (definition.kind === 'event') {
      const dispose = method(() => undefined) as () => void
      assert.equal(typeof dispose, 'function')
      dispose()
    } else if (definition.kind === 'invoke-no-input') {
      await method()
    } else {
      await method({ operation })
    }
  }

  const invokedDefinitions = studioOperationNames
    .map((operation) => ({ operation, definition: studioOperationCatalog[operation] }))
    .filter(({ definition }) => definition.kind !== 'event')
  assert.deepEqual(
    invokes.map(({ channel }) => channel),
    invokedDefinitions.map(({ definition }) => definition.channel),
  )
  assert.deepEqual(
    invokes.map(({ inputs }) => inputs.length),
    invokedDefinitions.map(({ definition }) => definition.kind === 'invoke-input' ? 1 : 0),
  )
  assert.deepEqual([...subscriptions.keys()], studioEventOperationNames.map(
    (operation) => studioOperationCatalog[operation].channel,
  ))
  assert.deepEqual(unsubscribed, [...subscriptions.keys()])
})

test('Studio operation classes keep no-input invocations and events explicit', () => {
  const noInputOperations = studioOperationNames.filter(
    (operation) => studioOperationCatalog[operation].kind === 'invoke-no-input',
  )

  assert.deepEqual(noInputOperations, [
    'bootstrap',
    'listProviders',
    'listProviderImports',
  ])
  assert.deepEqual(studioEventOperationNames, ['onRunEvent'])
  assert.equal(
    studioInvokeOperationNames.length + studioEventOperationNames.length,
    studioOperationNames.length,
  )
})

test('Studio invoke registration rejects duplicates and incomplete main adapters', () => {
  const incomplete = createStudioInvokeRegistrationTracker()
  incomplete.registerNoInput('bootstrap')
  assert.throws(() => incomplete.registerNoInput('bootstrap'), /more than once/u)
  assert.throws(() => incomplete.assertComplete(), /registration is incomplete/u)

  const complete = createStudioInvokeRegistrationTracker()
  for (const operation of studioInvokeOperationNames) {
    const definition = studioOperationCatalog[operation]
    if (definition.kind === 'invoke-no-input') complete.registerNoInput(operation)
    else complete.registerInput(operation)
  }
  assert.doesNotThrow(() => complete.assertComplete())
  assert.deepEqual(
    complete.registeredChannels(),
    studioInvokeOperationNames.map((operation) => studioOperationCatalog[operation].channel),
  )
})

test('Main Studio IPC adapter registers exactly the invoke catalog', async () => {
  studioIpcTestHandlers.clear()
  const jiti = createJiti(import.meta.url, {
    alias: { electron: electronStubPath },
    fsCache: false,
    moduleCache: false,
  })
  const { registerIpc } = await jiti.import<typeof import('../../src/main/studio/ipc.ts')>(
    '../../src/main/studio/ipc.ts',
  )
  const registration = registerIpc({} as never)

  try {
    assert.deepEqual(
      [...studioIpcTestHandlers.keys()].sort(),
      studioInvokeOperationNames.map((operation) => studioOperationCatalog[operation].channel).sort(),
    )
  } finally {
    registration.dispose()
  }
  assert.equal(studioIpcTestHandlers.size, 0)
})
