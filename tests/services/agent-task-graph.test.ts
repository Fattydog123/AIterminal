import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from '../../src/shared/contracts.ts'
import {
  AGENT_TASK_GRAPH_TOOL,
  AgentTaskGraph,
  AgentTaskGraphError,
  type AgentTaskExecutionContext,
  type AgentTaskGraphOptions,
  type AgentTaskWorktreeAdapter
} from '../../src/main/services/agent-task-graph.ts'

const workspaceToken = `ws_${'w'.repeat(43)}`
const workspaceProjectId = `project:workspace:${'p'.repeat(43)}`
const isolatedToken = `ws_${'i'.repeat(43)}`
const isolatedProjectId = `project:workspace:${'q'.repeat(43)}`

function graphOptions(
  events: AgentEvent[],
  execute: AgentTaskGraphOptions['execute'],
  overrides: Partial<AgentTaskGraphOptions> = {}
): AgentTaskGraphOptions {
  return {
    turnId: 'turn:graph-test',
    rootWorkspace: {
      taskId: 'task:graph-root',
      projectId: workspaceProjectId,
      workspaceToken
    },
    ownerWebContentsId: 7,
    approvalMode: 'auto',
    apiKey: 'sk-graph-test-secret-123456',
    signal: new AbortController().signal,
    allowWorktreeWrites: true,
    execute,
    onEvent: (event) => events.push(event),
    ...overrides
  }
}

test('legacy task entries schedule up to five nodes with a central concurrency limit and exact lifecycle', async () => {
  const events: AgentEvent[] = []
  let active = 0
  let maximumActive = 0
  const graph = new AgentTaskGraph(graphOptions(events, async (context) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    assert.equal(context.claimModelRound(), true)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    active -= 1
    return { ok: true, code: 'completed', output: `completed ${context.id}` }
  }))

  const output = JSON.parse(await graph.run({
    tasks: Array.from({ length: 5 }, (_, index) => ({ task: `Inspect module ${index + 1}.` }))
  })) as { ok: boolean; tasks: Array<{ id: string; agent_id: string }> }

  assert.equal(output.ok, true)
  assert.equal(output.tasks.length, 5)
  assert.deepEqual(output.tasks.map((task) => task.id), [
    'task-1-1', 'task-1-2', 'task-1-3', 'task-1-4', 'task-1-5'
  ])
  assert.deepEqual(output.tasks.map((task) => task.agent_id), [
    'subagent:1:1', 'subagent:1:2', 'subagent:1:3', 'subagent:1:4', 'subagent:1:5'
  ])
  assert.equal(maximumActive, 3)
  const lifecycle = events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => event.type === 'subagent-status'
  )
  for (const agentId of output.tasks.map((task) => task.agent_id)) {
    assert.deepEqual(
      lifecycle.filter((event) => event.agentId === agentId).map((event) => event.status),
      ['queued', 'running', 'completed']
    )
  }
  const taskSchema = AGENT_TASK_GRAPH_TOOL.parameters.properties.tasks as Record<string, unknown>
  assert.equal(taskSchema.maxItems, 5)
})

test('stable ids form an acyclic dependency graph and dependency output reaches the next role', async () => {
  const events: AgentEvent[] = []
  const executionOrder: string[] = []
  const graph = new AgentTaskGraph(graphOptions(events, async (context) => {
    executionOrder.push(context.id)
    if (context.id === 'implement') assert.match(context.prompt, /exploration evidence/u)
    if (context.id === 'review') assert.match(context.prompt, /implementation evidence/u)
    return {
      ok: true,
      code: 'completed',
      output: context.id === 'explore'
        ? 'exploration evidence'
        : context.id === 'implement'
          ? 'implementation evidence'
          : 'review evidence'
    }
  }))

  const output = JSON.parse(await graph.run({
    tasks: [
      { id: 'review', task: 'Review the result.', role: 'reviewer', depends_on: ['implement'] },
      { id: 'implement', task: 'Describe the implementation.', role: 'implementer', depends_on: ['explore'] },
      { id: 'explore', task: 'Inspect the existing design.', role: 'explorer' }
    ]
  })) as { ok: boolean }

  assert.equal(output.ok, true)
  assert.deepEqual(executionOrder, ['explore', 'implement', 'review'])
  const lifecycle = events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => event.type === 'subagent-status'
  )
  assert.deepEqual(
    lifecycle.filter((event) => event.agentId === 'subagent:1:review').map((event) => event.status),
    ['queued', 'running', 'completed']
  )

  const invalidEvents: AgentEvent[] = []
  const invalidGraph = new AgentTaskGraph(graphOptions(invalidEvents, async () => ({
    ok: true,
    code: 'completed',
    output: 'unreachable'
  })))
  await assert.rejects(
    invalidGraph.run({
      tasks: [
        { id: 'a', task: 'A.', depends_on: ['b'] },
        { id: 'b', task: 'B.', depends_on: ['a'] }
      ]
    }),
    (error: unknown) => error instanceof AgentTaskGraphError && error.code === 'invalid_tool_call'
  )
  assert.equal(invalidEvents.length, 0)
})

test('worktree-write fails explicitly without an adapter and never executes against the source workspace', async () => {
  const events: AgentEvent[] = []
  let executions = 0
  const graph = new AgentTaskGraph(graphOptions(events, async () => {
    executions += 1
    return { ok: true, code: 'completed', output: 'unreachable' }
  }))

  const output = JSON.parse(await graph.run({
    tasks: [{
      id: 'implementation',
      task: 'Implement the requested change.',
      role: 'implementer',
      mode: 'worktree-write'
    }]
  })) as { ok: boolean; tasks: Array<{ code: string; output: string }> }

  assert.equal(output.ok, false)
  assert.equal(output.tasks[0]?.code, 'worktree_unavailable')
  assert.match(output.tasks[0]?.output ?? '', /source workspace was not modified/u)
  assert.equal(executions, 0)
  const lifecycle = events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => event.type === 'subagent-status'
  )
  assert.deepEqual(lifecycle.map((event) => event.status), ['queued', 'running', 'failed'])
})

test('worktree adapter supplies a distinct token and project before an implementer can execute', async () => {
  const events: AgentEvent[] = []
  const requests: Parameters<AgentTaskWorktreeAdapter['createIsolatedWorkspace']>[0][] = []
  const worktrees: AgentTaskWorktreeAdapter = {
    async createIsolatedWorkspace(input) {
      requests.push(input)
      return {
        taskId: 'task:isolated-child',
        projectId: isolatedProjectId,
        workspaceToken: isolatedToken,
        worktreeId: 'worktree:test'
      }
    }
  }
  const graph = new AgentTaskGraph(graphOptions(events, async (context) => {
    assert.equal(context.mode, 'worktree-write')
    assert.equal(context.workspace.isolated, true)
    assert.equal(context.workspace.workspaceToken, isolatedToken)
    assert.notEqual(context.workspace.workspaceToken, workspaceToken)
    return { ok: true, code: 'completed', output: 'isolated implementation complete' }
  }, { worktrees }))

  const output = JSON.parse(await graph.run({
    tasks: [{
      id: 'implementation',
      task: 'Implement the requested change.',
      role: 'implementer',
      mode: 'worktree-write'
    }]
  })) as { ok: boolean }

  assert.equal(output.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.source.workspaceToken, workspaceToken)
})

test('nested delegation yields the shared permit, stops at depth two, and shares central budgets', async () => {
  const events: AgentEvent[] = []
  const contexts: AgentTaskExecutionContext[] = []
  const graph = new AgentTaskGraph(graphOptions(events, async (context) => {
    contexts.push(context)
    assert.equal(context.claimModelRound(), true)
    if (context.depth === 1) {
      const nested = JSON.parse(await context.delegate({
        tasks: [{ id: 'nested', task: 'Inspect the nested concern.' }]
      })) as { ok: boolean }
      assert.equal(nested.ok, true)
      assert.equal(context.claimModelRound(), false)
      return { ok: true, code: 'completed', output: 'parent complete' }
    }
    assert.equal(context.depth, 2)
    assert.equal(context.canDelegate, false)
    assert.equal(context.claimToolCalls(2), true)
    assert.equal(context.claimToolCalls(1), false)
    await assert.rejects(
      context.delegate({ tasks: [{ task: 'Too deep.' }] }),
      (error: unknown) => error instanceof AgentTaskGraphError && error.code === 'invalid_tool_call'
    )
    return { ok: true, code: 'completed', output: 'nested complete' }
  }, {
    limits: { maxConcurrent: 1, maxModelRounds: 2, maxToolCalls: 2, maxDepth: 2 }
  }))

  const output = JSON.parse(await graph.run({
    tasks: [{ id: 'parent', task: 'Coordinate the investigation.' }]
  })) as { ok: boolean }

  assert.equal(output.ok, true)
  assert.deepEqual(contexts.map((context) => context.depth), [1, 2])
  const nestedEvents = events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => (
      event.type === 'subagent-status' && event.agentId === 'subagent:2:nested'
    )
  )
  assert.equal(nestedEvents.every((event) => event.parentAgentId === 'subagent:1:parent'), true)
  assert.deepEqual(nestedEvents.map((event) => event.status), ['queued', 'running', 'completed'])
})

test('cancellation reaches an active node and publishes one terminal state', async () => {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  let started!: () => void
  const active = new Promise<void>((resolve) => { started = resolve })
  const graph = new AgentTaskGraph(graphOptions(events, async (context) => {
    started()
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
    return { ok: true, code: 'completed', output: 'unreachable' }
  }, { signal: controller.signal }))

  const running = graph.run({ tasks: [{ task: 'Wait until cancelled.' }] })
  await active
  controller.abort()
  await assert.rejects(
    running,
    (error: unknown) => error instanceof AgentTaskGraphError && error.code === 'cancelled'
  )
  const lifecycle = events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => event.type === 'subagent-status'
  )
  assert.deepEqual(lifecycle.map((event) => event.status), ['queued', 'running', 'cancelled'])
})
