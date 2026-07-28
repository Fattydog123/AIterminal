import assert from 'node:assert/strict'
import test from 'node:test'

import { presentAgentExecution } from '../../src/renderer/src/conversation/agent-execution-presentation.ts'
import type { AgentExecutionEntry } from '../../src/renderer/src/conversation/conversation-session.ts'

const entry = (patch: Partial<AgentExecutionEntry> & Pick<AgentExecutionEntry, 'id' | 'kind' | 'label'>): AgentExecutionEntry => ({
  status: 'completed',
  startedAt: 1_000,
  endedAt: 2_000,
  ...patch,
})

test('execution presentation collapses repeated generic statuses and keeps specific work', () => {
  const result = presentAgentExecution([
    entry({ id: 'status:1', kind: 'status', label: '子智能体正在处理任务。' }),
    entry({ id: 'tool:1', kind: 'tool', label: '读取项目文件' }),
    entry({ id: 'status:2', kind: 'status', label: '子智能体正在处理任务。' }),
    entry({ id: 'subagent:1', kind: 'subagent', label: '界面检查' }),
    entry({ id: 'terminal:1', kind: 'terminal', label: '本轮已完成' }),
  ])

  assert.ok(result)
  assert.equal(result.state, 'completed')
  assert.equal(result.total, 3)
  assert.equal(result.entries.filter((item) => item.kind === 'status').length, 1)
  assert.equal(result.subagents.total, 1)
  assert.equal(result.progress, 100)
})

test('execution presentation gives a waiting approval priority over background activity', () => {
  const result = presentAgentExecution([
    entry({ id: 'tool:1', kind: 'tool', label: '修改文件', status: 'running', endedAt: undefined }),
    entry({ id: 'approval:1', kind: 'approval', label: '确认操作', status: 'waiting', endedAt: undefined }),
  ])

  assert.ok(result)
  assert.equal(result.state, 'approval')
  assert.equal(result.primary.id, 'approval:1')
})

test('the terminal result stays authoritative over an earlier failed step', () => {
  const result = presentAgentExecution([
    entry({ id: 'tool:failed', kind: 'tool', label: '一次检查未通过', status: 'failed' }),
    entry({ id: 'terminal:completed', kind: 'terminal', label: '本轮已完成' }),
  ])

  assert.ok(result)
  assert.equal(result.state, 'completed')
  assert.equal(result.primary.id, 'terminal:completed')
})
