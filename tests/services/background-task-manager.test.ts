import assert from 'node:assert/strict'
import test from 'node:test'

import type { TurnStartInput } from '../../src/shared/contracts.ts'
import {
  AgentTaskSupervisor,
  type BackgroundTaskStorage
} from '../../src/main/services/background-task-manager.ts'

const TASK_ID = 'task:11111111-1111-4111-8111-111111111111'
const TURN_ONE = `turn_${'a'.repeat(32)}`
const TURN_TWO = `turn_${'b'.repeat(32)}`

class MemoryStorage implements BackgroundTaskStorage {
  value: string | null = null

  async read(): Promise<string | null> {
    return this.value
  }

  async write(value: string): Promise<void> {
    this.value = value
  }
}

function tickingClock(): () => number {
  let current = Date.parse('2026-07-26T00:00:00.000Z')
  return () => current++
}

function turn(prompt = 'Continue the task'): TurnStartInput {
  return {
    requestId: `request_${'c'.repeat(32)}`,
    taskId: TASK_ID,
    mode: 'agent',
    prompt,
    profileHandle: 'relay-profile',
    groupId: 'group-1',
    modelId: 'model-1',
    reasoning: 'high',
    approvalMode: 'full',
    workspaceToken: 'workspace-token',
    attachmentTokens: [],
    webSearch: false,
    imageGeneration: false,
    localSubagents: false
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for the background task transition.')
}

test('attached Agent events are journaled and the terminal state is persisted', async () => {
  const storage = new MemoryStorage()
  const completed: string[] = []
  const supervisor = new AgentTaskSupervisor({
    storage,
    clock: tickingClock(),
    onTaskComplete: (task) => completed.push(task.id)
  })

  const attached = await supervisor.attach(TASK_ID, 'Build calculator', TURN_ONE)
  supervisor.handleEvent({
    type: 'tool-status',
    turnId: TURN_ONE,
    callId: 'call-1',
    label: 'Writing calculator files',
    status: 'completed'
  })
  supervisor.handleEvent({
    type: 'turn-status',
    turnId: TURN_ONE,
    status: 'completed',
    message: 'Calculator completed'
  })

  const [task] = await supervisor.list()
  assert.equal(task?.id, attached.id)
  assert.equal(task?.status, 'completed')
  assert.equal(task?.result, 'Calculator completed')
  assert.deepEqual(task?.events.map((event) => event.kind), ['status', 'tool', 'status'])
  assert.deepEqual(completed, [attached.id])

  supervisor.dispose()
  const restored = new AgentTaskSupervisor({ storage, clock: tickingClock() })
  assert.equal((await restored.list())[0]?.status, 'completed')
})

test('cancel delegates to the active Agent runtime and keeps the record', async () => {
  const cancelled: string[] = []
  const supervisor = new AgentTaskSupervisor({
    storage: new MemoryStorage(),
    clock: tickingClock()
  })
  supervisor.connect({
    startTurn: async () => ({ ok: true, value: { turnId: TURN_TWO } }),
    cancelPendingStart: () => false,
    cancelTurn: (turnId) => {
      cancelled.push(turnId)
      return true
    }
  })
  const attached = await supervisor.attach(TASK_ID, 'Cancelable task', TURN_ONE)

  assert.equal(await supervisor.cancel(attached.id), true)
  assert.equal(await supervisor.cancel(attached.id), false)
  assert.deepEqual(cancelled, [TURN_ONE])
  const [task] = await supervisor.list()
  assert.equal(task?.status, 'cancelled')
  assert.equal(task?.events.at(-1)?.status, 'cancelled')
})

test('a queued follow-up starts through the connected admission runtime after completion', async () => {
  const started: TurnStartInput[] = []
  const supervisor = new AgentTaskSupervisor({
    storage: new MemoryStorage(),
    clock: tickingClock()
  })
  supervisor.connect({
    startTurn: async (input) => {
      started.push(input)
      return { ok: true, value: { turnId: TURN_TWO } }
    },
    cancelPendingStart: () => false,
    cancelTurn: () => false
  })
  const attached = await supervisor.attach(TASK_ID, 'Follow-up task', TURN_ONE)
  const next = turn('Apply the final polish')

  const queued = await supervisor.followUp(attached.id, next)
  assert.equal(queued.queuedFollowUps, 1)
  supervisor.handleEvent({ type: 'turn-status', turnId: TURN_ONE, status: 'completed' })
  await waitFor(() => started.length === 1)

  assert.deepEqual(started, [next])
  const [task] = await supervisor.list()
  assert.equal(task?.status, 'running')
  assert.equal(task?.turnId, TURN_TWO)
  assert.equal(task?.queuedFollowUps, 0)
})

test('cancelling during admission cancels both the pending start and a late Agent turn', async () => {
  const pendingCancellations: string[] = []
  const turnCancellations: string[] = []
  const started: TurnStartInput[] = []
  let releaseStart: (() => void) | undefined
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
  const supervisor = new AgentTaskSupervisor({
    storage: new MemoryStorage(),
    clock: tickingClock()
  })
  supervisor.connect({
    startTurn: async (input) => {
      started.push(input)
      await startGate
      return { ok: true, value: { turnId: TURN_TWO } }
    },
    cancelPendingStart: (requestId) => {
      pendingCancellations.push(requestId)
      return true
    },
    cancelTurn: (turnId) => {
      turnCancellations.push(turnId)
      return true
    }
  })
  const attached = await supervisor.attach(TASK_ID, 'Admission cancellation', TURN_ONE)
  const next = turn('Do not resurrect this turn')
  await supervisor.followUp(attached.id, next)
  supervisor.handleEvent({ type: 'turn-status', turnId: TURN_ONE, status: 'completed' })
  await waitFor(() => started.length === 1)

  assert.equal(await supervisor.cancel(attached.id), true)
  assert.deepEqual(pendingCancellations, [next.requestId])
  releaseStart?.()
  await waitFor(() => turnCancellations.length === 1)

  assert.deepEqual(turnCancellations, [TURN_TWO])
  assert.equal((await supervisor.list())[0]?.status, 'cancelled')
})

test('restart recovery marks active work interrupted and resume starts a fresh turn', async () => {
  const storage = new MemoryStorage()
  const first = new AgentTaskSupervisor({ storage, clock: tickingClock() })
  const attached = await first.attach(TASK_ID, 'Recoverable task', TURN_ONE)
  first.dispose()

  const started: TurnStartInput[] = []
  const recovered = new AgentTaskSupervisor({ storage, clock: tickingClock() })
  recovered.connect({
    startTurn: async (input) => {
      started.push(input)
      return { ok: true, value: { turnId: TURN_TWO } }
    },
    cancelPendingStart: () => false,
    cancelTurn: () => false
  })
  assert.equal((await recovered.list())[0]?.status, 'interrupted')

  const resumed = await recovered.resume(attached.id, turn('Resume after restart'))
  assert.equal(resumed.status, 'queued')
  assert.equal(resumed.turnId, undefined)
  await waitFor(() => started.length === 1)
  const [running] = await recovered.list()
  assert.equal(running?.status, 'running')
  assert.equal(running?.turnId, TURN_TWO)

  recovered.dispose()
  const restartedAgain = new AgentTaskSupervisor({ storage, clock: tickingClock() })
  const [interruptedAgain] = await restartedAgain.list()
  assert.equal(interruptedAgain?.status, 'interrupted')
  assert.equal(interruptedAgain?.queuedFollowUps, 0)
})
