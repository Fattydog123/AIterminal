import assert from 'node:assert/strict'
import test from 'node:test'
import type { StudioBridge } from '../../src/studio/shared/contracts.ts'
import type { RunPlan, RunResult, WorkflowDocument } from '../../src/studio/shared/types.ts'
import {
  PromptMatrixSessionController,
  type PreparedPromptMatrixSession,
} from '../../src/renderer/src/studio/renderer/session/StudioSession.ts'

type PrepareInput = Parameters<StudioBridge['prepareRun']>[0]
type StartInput = Parameters<StudioBridge['startRun']>[0]

const workflow = (id: string, name: string): WorkflowDocument => ({
  schemaVersion: 3,
  id,
  name,
  revision: 5,
  nodes: [{
    id: 'node',
    type: 'text',
    name: 'Prompt',
    position: { x: 0, y: 0 },
    parameters: { text: name },
  }],
  edges: [],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T01:00:00.000Z',
})

const planFor = (input: PrepareInput, index: number): RunPlan => ({
  id: `plan-${index}`,
  workflowId: input.workflow.id,
  taskCount: 1,
  remoteTaskCount: 1,
  nodes: [{ nodeId: 'node', action: 'execute', reason: 'test' }],
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

class FakeBridge implements Pick<StudioBridge, 'prepareRun' | 'startRun'> {
  readonly prepared: PrepareInput[] = []
  readonly started: StartInput[] = []
  prepareHandler: ((input: PrepareInput) => Promise<RunPlan>) | undefined
  startHandler: ((input: StartInput) => Promise<RunResult>) | undefined

  async prepareRun(input: PrepareInput): Promise<RunPlan> {
    this.prepared.push(structuredClone(input))
    return this.prepareHandler?.(input) ?? planFor(input, this.prepared.length)
  }

  async startRun(input: StartInput): Promise<RunResult> {
    this.started.push(structuredClone(input))
    return this.startHandler?.(input) ?? {
      runId: input.planId,
      status: 'succeeded',
      dispatchState: 'sent',
      outputs: {},
    }
  }
}

test('Prompt Matrix confirmation dispatches only the frozen workflows, targets, and overrides', async () => {
  const bridge = new FakeBridge()
  const controller = new PromptMatrixSessionController()
  const first = workflow('workflow-a', 'Frozen first')
  const second = workflow('workflow-a', 'Frozen second')
  const overrides = {
    node: { action: 'mock' as const, value: { marker: 'frozen' } },
  }
  const prepared = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:frozen',
    sourceGeneration: 4,
    workflows: [first, second],
    targetNodeIds: ['node', 'node'],
    overrides,
  })

  ;(first as { name: string }).name = 'Live first'
  ;(overrides.node.value as { marker: string }).marker = 'live'
  let accepted: PreparedPromptMatrixSession | undefined
  const settled = await controller.confirm({
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:frozen',
    sourceGeneration: 4,
    prepareGeneration: prepared.prepareGeneration,
  }, (snapshot) => { accepted = snapshot })

  assert.equal(accepted?.runs.length, 2)
  assert.equal(accepted?.targetNodeIds.length, 1)
  assert.equal(settled.every((item) => item.status === 'fulfilled'), true)
  assert.deepEqual(bridge.started.map((input) => input.workflow.name), ['Frozen first', 'Frozen second'])
  assert.deepEqual(bridge.started.map((input) => input.targetNodeIds), [['node'], ['node']])
  assert.deepEqual(bridge.started.map((input) => input.overrides), [
    { node: { action: 'mock', value: { marker: 'frozen' } } },
    { node: { action: 'mock', value: { marker: 'frozen' } } },
  ])
})

test('Prompt Matrix rejects changed source and stale generations before any startRun', async () => {
  const bridge = new FakeBridge()
  const controller = new PromptMatrixSessionController()
  const prepared = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:prepared',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'Frozen')],
    targetNodeIds: [],
    overrides: {},
  })

  await assert.rejects(
    controller.confirm({
      projectPath: 'P',
      workflowFingerprint: 'fingerprint:changed',
      sourceGeneration: 4,
      prepareGeneration: prepared.prepareGeneration,
    }),
    /画布.*发生变化/u,
  )
  await assert.rejects(
    controller.confirm({
      projectPath: 'P',
      workflowFingerprint: 'fingerprint:prepared',
      sourceGeneration: 4,
      prepareGeneration: prepared.prepareGeneration + 1,
    }),
    /计划不存在.*更新/u,
  )
  assert.deepEqual(bridge.started, [])
})

test('Prompt Matrix rejects a changed source generation before any startRun', async () => {
  const bridge = new FakeBridge()
  const controller = new PromptMatrixSessionController()
  const prepared = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:stable-content',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'Frozen')],
    targetNodeIds: [],
    overrides: {},
  })

  await assert.rejects(
    controller.confirm({
      projectPath: 'P',
      workflowFingerprint: 'fingerprint:stable-content',
      sourceGeneration: 5,
      prepareGeneration: prepared.prepareGeneration,
    }),
    /已被编辑/u,
  )
  assert.deepEqual(bridge.started, [])
})

test('a newer Prompt Matrix prepare invalidates an older asynchronous prepare', async () => {
  const bridge = new FakeBridge()
  const firstPlan = deferred<RunPlan>()
  let prepareCalls = 0
  bridge.prepareHandler = async (input) => {
    prepareCalls += 1
    return prepareCalls === 1 ? firstPlan.promise : planFor(input, prepareCalls)
  }
  const controller = new PromptMatrixSessionController()
  const older = controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:older',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'Older')],
    targetNodeIds: [],
    overrides: {},
  })
  await Promise.resolve()
  const newer = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:newer',
    sourceGeneration: 5,
    workflows: [workflow('workflow-a', 'Newer')],
    targetNodeIds: [],
    overrides: {},
  })
  firstPlan.resolve(planFor({ projectPath: 'P', workflow: workflow('workflow-a', 'Older') }, 1))

  await assert.rejects(older, /更新的 Prompt Matrix 预检/u)
  await controller.confirm({
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:newer',
    sourceGeneration: 5,
    prepareGeneration: newer.prepareGeneration,
  })
  assert.deepEqual(bridge.started.map((input) => input.workflow.name), ['Newer'])
})

test('Prompt Matrix dispatches every frozen plan when one bridge call throws synchronously', async () => {
  const preparedInputs: PrepareInput[] = []
  const startedPlanIds: string[] = []
  const bridge: Pick<StudioBridge, 'prepareRun' | 'startRun'> = {
    async prepareRun(input) {
      preparedInputs.push(structuredClone(input))
      return planFor(input, preparedInputs.length)
    },
    startRun(input) {
      startedPlanIds.push(input.planId)
      if (input.planId === 'plan-1') throw new Error('first dispatch failed before returning a promise')
      return Promise.resolve({
        runId: input.planId,
        status: 'succeeded',
        dispatchState: 'sent',
        outputs: {},
      })
    },
  }
  const controller = new PromptMatrixSessionController()
  const prepared = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:partial-dispatch',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'First'), workflow('workflow-a', 'Second')],
    targetNodeIds: [],
    overrides: {},
  })

  const settled = await controller.confirm({
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:partial-dispatch',
    sourceGeneration: 4,
    prepareGeneration: prepared.prepareGeneration,
  })

  assert.deepEqual(startedPlanIds, ['plan-1', 'plan-2'])
  assert.equal(settled[0]?.status, 'rejected')
  assert.equal(settled[1]?.status, 'fulfilled')
})

test('Prompt Matrix confirmation consumes the frozen session before dispatch', async () => {
  const bridge = new FakeBridge()
  const controller = new PromptMatrixSessionController()
  const prepared = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:single-dispatch',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'Frozen')],
    targetNodeIds: [],
    overrides: {},
  })
  const confirmation = {
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:single-dispatch',
    sourceGeneration: 4,
    prepareGeneration: prepared.prepareGeneration,
  }

  await Promise.all([
    controller.confirm(confirmation),
    assert.rejects(controller.confirm(confirmation), /计划不存在.*更新/u),
  ])
  assert.equal(bridge.started.length, 1)
})

test('Prompt Matrix retains its own preflight input when a bridge mutates its arguments', async () => {
  const bridge = new FakeBridge()
  bridge.prepareHandler = async (input) => {
    const mutable = input as unknown as {
      workflow: { name: string }
      targetNodeIds?: string[]
      overrides?: { node?: { value?: { marker?: string } } }
    }
    mutable.workflow.name = 'Bridge-mutated workflow'
    mutable.targetNodeIds?.push('bridge-node')
    if (mutable.overrides?.node?.value) mutable.overrides.node.value.marker = 'bridge-mutated override'
    return planFor(input, bridge.prepared.length)
  }
  const controller = new PromptMatrixSessionController()
  const prepared = await controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:isolated-preflight',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'Frozen')],
    targetNodeIds: ['node'],
    overrides: { node: { action: 'mock', value: { marker: 'frozen' } } },
  })

  await controller.confirm({
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:isolated-preflight',
    sourceGeneration: 4,
    prepareGeneration: prepared.prepareGeneration,
  })

  assert.equal(bridge.started[0]?.workflow.name, 'Frozen')
  assert.deepEqual(bridge.started[0]?.targetNodeIds, ['node'])
  assert.deepEqual(bridge.started[0]?.overrides, {
    node: { action: 'mock', value: { marker: 'frozen' } },
  })
})

test('clearing Prompt Matrix preflight rejects an in-flight plan before confirmation', async () => {
  const bridge = new FakeBridge()
  const pendingPlan = deferred<RunPlan>()
  let prepareInput: PrepareInput | undefined
  bridge.prepareHandler = async (input) => {
    prepareInput = input
    return pendingPlan.promise
  }
  const controller = new PromptMatrixSessionController()
  const preparing = controller.prepare({
    bridge,
    projectPath: 'P',
    workflowFingerprint: 'fingerprint:cleared',
    sourceGeneration: 4,
    workflows: [workflow('workflow-a', 'Frozen')],
    targetNodeIds: [],
    overrides: {},
  })

  await Promise.resolve()
  controller.clear()
  pendingPlan.resolve(planFor(prepareInput!, 1))

  await assert.rejects(preparing, /更新的 Prompt Matrix 预检/u)
  assert.deepEqual(bridge.started, [])
})
