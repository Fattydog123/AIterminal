import assert from 'node:assert/strict'
import test from 'node:test'

import {
  StudioSessionController,
  type StudioSessionAdapter,
} from '../../src/renderer/src/studio/renderer/session/StudioSession.ts'
import type { StudioBridge } from '../../src/studio/shared/contracts.ts'
import type { RunPlan, RunResult, WorkflowDocument } from '../../src/studio/shared/types.ts'

type PrepareInput = Parameters<StudioBridge['prepareRun']>[0]
type StartInput = Parameters<StudioBridge['startRun']>[0]

const NOW = '2026-07-22T00:00:00.000Z'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const workflow = (name = 'Frozen workflow'): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-a',
  name,
  revision: 5,
  nodes: [{
    id: 'node-a',
    type: 'text',
    name: 'Prompt',
    position: { x: 0, y: 0 },
    parameters: { text: name },
  }],
  edges: [],
  createdAt: NOW,
  updatedAt: NOW,
})

const planFor = (input: PrepareInput): RunPlan => ({
  id: 'run-a',
  workflowId: input.workflow.id,
  taskCount: 1,
  remoteTaskCount: 1,
  nodes: [{ nodeId: 'node-a', action: 'execute', reason: 'test' }],
})

const result = (status: RunResult['status'] = 'succeeded'): RunResult => ({
  runId: 'run-a',
  status,
  dispatchState: status === 'cancelled' ? 'not_sent' : 'sent',
  outputs: status === 'succeeded' ? { 'node-a': { image: 'asset:test' } } : {},
})

class FakeStudioSessionAdapter implements StudioSessionAdapter {
  readonly prepared: PrepareInput[] = []
  readonly started: StartInput[] = []
  readonly cancelled: string[] = []
  readonly listeners = new Set<(event: unknown) => void>()
  startResult: Promise<RunResult> = Promise.resolve(result())
  cancelResult: Promise<boolean> = Promise.resolve(true)
  prepareHandler: ((input: PrepareInput) => Promise<RunPlan>) | undefined
  subscribeCalls = 0
  unsubscribeCalls = 0

  async prepareRun(input: PrepareInput): Promise<RunPlan> {
    this.prepared.push(structuredClone(input))
    return this.prepareHandler?.(input) ?? planFor(input)
  }

  startRun(input: StartInput): Promise<RunResult> {
    this.started.push(structuredClone(input))
    return this.startResult
  }

  cancelRun(input: { readonly runId: string }): Promise<boolean> {
    this.cancelled.push(input.runId)
    return this.cancelResult
  }

  onRunEvent(listener: (event: unknown) => void): () => void {
    this.subscribeCalls += 1
    this.listeners.add(listener)
    return () => {
      this.unsubscribeCalls += 1
      this.listeners.delete(listener)
    }
  }

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event)
  }
}

const prepare = (
  controller: StudioSessionController,
  bridge: FakeStudioSessionAdapter,
  source = workflow(),
  overrides = { 'node-a': { action: 'mock' as const, value: { marker: 'frozen' } } },
) => controller.prepare({
  bridge,
  projectPath: 'P',
  workflow: source,
  workflowFingerprint: 'fingerprint:a',
  targetNodeIds: ['node-a', 'node-a'],
  overrides,
})

test('Studio Run Session freezes confirmation inputs and reduces validated feedback through its interface', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const pendingStart = deferred<RunResult>()
  bridge.startResult = pendingStart.promise
  const controller = new StudioSessionController()
  const source = workflow()
  const overrides = { 'node-a': { action: 'mock' as const, value: { marker: 'frozen' } } }
  const notifications: number[] = []
  controller.subscribe(() => notifications.push(controller.getSnapshot().sequence))

  const prepared = await prepare(controller, bridge, source, overrides)
  ;(source as { name: string }).name = 'Live workflow'
  overrides['node-a'].value.marker = 'live'
  const confirming = controller.confirm({ projectPath: 'P', workflowFingerprint: 'fingerprint:a' })

  assert.equal(bridge.subscribeCalls, 1)
  assert.equal(bridge.started[0]?.workflow.name, 'Frozen workflow')
  assert.deepEqual(bridge.started[0]?.targetNodeIds, ['node-a'])
  assert.deepEqual(bridge.started[0]?.overrides, {
    'node-a': { action: 'mock', value: { marker: 'frozen' } },
  })
  assert.deepEqual(controller.getSnapshot().activeRunIds, [prepared.plan.id])
  assert.equal(controller.getSnapshot().runs[0]?.phase, 'starting')

  bridge.emit({ type: 'run-queued', runId: 'run-a', workflowId: 'workflow-a', createdAt: NOW })
  bridge.emit({ type: 'run-started', runId: 'run-a', workflowId: 'workflow-a', createdAt: NOW })
  bridge.emit({
    type: 'run-progress',
    runId: 'run-a',
    workflowId: 'workflow-a',
    nodeId: 'node-a',
    nodeStatus: 'running',
    overallProgress: 0.42,
    message: '正在生成',
  })
  assert.equal(controller.getSnapshot().runs[0]?.phase, 'running')
  assert.equal(controller.getSnapshot().runs[0]?.projection.progress, 42)
  assert.equal(controller.getSnapshot().runs[0]?.projection.node?.nodeId, 'node-a')

  bridge.emit({ type: 'run-finished', result: result('succeeded') })
  const terminalSequence = controller.getSnapshot().sequence
  pendingStart.resolve(result('cancelled'))
  assert.equal((await confirming).status, 'succeeded')

  const terminal = controller.getSnapshot().runs[0]
  assert.equal(controller.getSnapshot().sequence, terminalSequence)
  assert.equal(controller.getSnapshot().latestFeedback?.source, 'event')
  assert.equal(terminal?.phase, 'terminal')
  assert.equal(terminal?.terminalAuthority, 'run-event')
  assert.equal(terminal?.projection.result?.status, 'succeeded')
  assert.deepEqual(controller.getSnapshot().activeRunIds, [])
  bridge.emit({
    type: 'run-progress',
    runId: 'run-a',
    workflowId: 'workflow-a',
    overallProgress: 0.99,
    message: '迟到反馈',
  })
  assert.equal(controller.getSnapshot().sequence, terminalSequence)
  assert.equal(notifications.at(-1), terminalSequence)
  bridge.emit({
    type: 'persistent-queue-warning',
    runId: 'run-a',
    workflowId: 'workflow-a',
    message: '运行已完成，但持久队列清理失败',
  })
  const terminalWithDiagnostic = controller.getSnapshot().runs[0]
  assert.equal(controller.getSnapshot().sequence, terminalSequence + 1)
  assert.equal(terminalWithDiagnostic?.phase, 'terminal')
  assert.equal(terminalWithDiagnostic?.projection.result?.status, 'succeeded')
  assert.equal(terminalWithDiagnostic?.projection.diagnostic?.kind, 'persistent-queue-warning')
})

test('a terminal run event remains authoritative when startRun rejects late', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const pendingStart = deferred<RunResult>()
  bridge.startResult = pendingStart.promise
  const controller = new StudioSessionController()
  await prepare(controller, bridge)
  const confirming = controller.confirm({ projectPath: 'P', workflowFingerprint: 'fingerprint:a' })

  bridge.emit({ type: 'run-finished', result: result('succeeded') })
  const terminalSequence = controller.getSnapshot().sequence
  pendingStart.reject(new Error('迟到的启动错误'))

  assert.equal((await confirming).status, 'succeeded')
  const terminal = controller.getSnapshot().runs[0]
  assert.equal(controller.getSnapshot().sequence, terminalSequence)
  assert.equal(controller.getSnapshot().latestFeedback?.source, 'event')
  assert.equal(terminal?.phase, 'terminal')
  assert.equal(terminal?.terminalAuthority, 'run-event')
  assert.equal(terminal?.projection.result?.status, 'succeeded')
})

test('a terminal run event remains authoritative when cancellation settles late', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const pendingStart = deferred<RunResult>()
  const pendingCancel = deferred<boolean>()
  bridge.startResult = pendingStart.promise
  bridge.cancelResult = pendingCancel.promise
  const controller = new StudioSessionController()
  await prepare(controller, bridge)
  const confirming = controller.confirm({ projectPath: 'P', workflowFingerprint: 'fingerprint:a' })

  const firstCancel = controller.cancel('run-a')
  const duplicateCancel = controller.cancel('run-a')
  assert.strictEqual(duplicateCancel, firstCancel)
  await Promise.resolve()
  assert.deepEqual(bridge.cancelled, ['run-a'])
  assert.equal(controller.getSnapshot().runs[0]?.cancellation, 'requesting')

  bridge.emit({ type: 'run-cancel-requested', runId: 'run-a', createdAt: NOW })
  bridge.emit({ type: 'run-finished', result: result('succeeded') })
  pendingCancel.reject(new Error('迟到的取消错误'))
  assert.equal(await firstCancel, true)
  pendingStart.resolve(result('succeeded'))
  await confirming

  const terminal = controller.getSnapshot().runs[0]
  assert.equal(terminal?.phase, 'terminal')
  assert.equal(terminal?.terminalAuthority, 'run-event')
  assert.equal(terminal?.projection.message, '运行完成')
  assert.equal(terminal?.projection.result?.status, 'succeeded')
})

test('a cancel-requested event remains authoritative when cancel transport rejects before final result', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const pendingStart = deferred<RunResult>()
  const pendingCancel = deferred<boolean>()
  bridge.startResult = pendingStart.promise
  bridge.cancelResult = pendingCancel.promise
  const controller = new StudioSessionController()
  await prepare(controller, bridge)
  const confirming = controller.confirm({ projectPath: 'P', workflowFingerprint: 'fingerprint:a' })

  const cancelling = controller.cancel('run-a')
  await Promise.resolve()
  bridge.emit({ type: 'run-cancel-requested', runId: 'run-a', createdAt: NOW })
  pendingCancel.reject(new Error('迟到的取消传输错误'))

  assert.equal(await cancelling, true)
  const awaitingTerminal = controller.getSnapshot().runs[0]
  assert.equal(awaitingTerminal?.phase, 'cancelling')
  assert.equal(awaitingTerminal?.cancellation, 'requested')
  assert.equal(awaitingTerminal?.projection.message, '正在取消；已派发请求可能无法撤回')

  pendingStart.resolve(result('cancelled'))
  await confirming
})

test('accepted cancellation stays non-terminal until Main supplies the final result', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const pendingStart = deferred<RunResult>()
  bridge.startResult = pendingStart.promise
  const controller = new StudioSessionController()
  await prepare(controller, bridge)
  const confirming = controller.confirm({ projectPath: 'P', workflowFingerprint: 'fingerprint:a' })

  bridge.emit({
    type: 'run-progress',
    runId: 'run-a',
    workflowId: 'workflow-a',
    nodeId: 'node-a',
    nodeStatus: 'running',
    overallProgress: 0.2,
    message: '节点正在运行',
  })
  assert.equal(controller.getSnapshot().runs[0]?.projection.node?.nodeId, 'node-a')
  assert.equal(await controller.cancel('run-a'), true)
  assert.equal(controller.getSnapshot().runs[0]?.phase, 'cancelling')
  assert.equal(controller.getSnapshot().runs[0]?.cancellation, 'requested')
  assert.equal(controller.getSnapshot().runs[0]?.projection.result, undefined)
  assert.equal(controller.getSnapshot().runs[0]?.projection.node, undefined)
  assert.equal(await controller.cancel('run-a'), true)
  assert.deepEqual(bridge.cancelled, ['run-a'])

  pendingStart.resolve(result('cancelled'))
  await confirming
  const terminal = controller.getSnapshot().runs[0]
  assert.equal(terminal?.phase, 'terminal')
  assert.equal(terminal?.terminalAuthority, 'start-result')
  assert.equal(terminal?.projection.result?.status, 'cancelled')
})

test('connect owns one event adapter subscription and tracks externally-started runs', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const controller = new StudioSessionController()
  controller.connect(bridge)
  controller.connect(bridge)
  assert.equal(bridge.subscribeCalls, 1)

  bridge.emit({ type: 'invalid-event', privateValue: 'ignored' })
  assert.equal(controller.getSnapshot().sequence, 0)
  bridge.emit({ type: 'run-queued', runId: 'external-run', workflowId: 'workflow-a', createdAt: NOW })
  assert.deepEqual(controller.getSnapshot().activeRunIds, ['external-run'])
  assert.equal(controller.getSnapshot().runs[0]?.phase, 'queued')
  assert.equal(await controller.cancel('external-run'), true)
  assert.deepEqual(bridge.cancelled, ['external-run'])

  controller.disconnect()
  assert.equal(bridge.unsubscribeCalls, 1)
  const sequence = controller.getSnapshot().sequence
  bridge.emit({ type: 'run-finished', result: { ...result(), runId: 'external-run' } })
  assert.equal(controller.getSnapshot().sequence, sequence)
  await assert.rejects(controller.cancel('unknown-run'), /运行桥尚未连接/u)
})

test('clear invalidates an in-flight preflight and dispose rejects later work', async () => {
  const bridge = new FakeStudioSessionAdapter()
  const pendingPlan = deferred<RunPlan>()
  bridge.prepareHandler = async () => pendingPlan.promise
  const controller = new StudioSessionController()
  const preparing = prepare(controller, bridge)
  await Promise.resolve()
  controller.clear()
  pendingPlan.resolve(planFor(bridge.prepared[0]!))

  await assert.rejects(preparing, /更新的执行预检/u)
  controller.dispose()
  assert.equal(bridge.unsubscribeCalls, 1)
  await assert.rejects(prepare(controller, bridge), /已经释放/u)
  await assert.rejects(controller.cancel('run-a'), /已经释放/u)
})
