import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConversationMessageDto, ConversationSnapshot } from '../../src/shared/contracts.ts'
import {
  CONTEXT_SUMMARY_PREFIX,
  ConversationCompactionError,
  ConversationCompactionService,
  type ConversationCompactionRoute,
} from '../../src/main/services/conversation-compaction-service.ts'
import type { ConversationMessageReplaceInput } from '../../src/main/services/conversation-history-service.ts'

const taskId = 'task:00000000-0000-4000-8000-000000000001'
const timestamp = '2026-07-26T00:00:00.000Z'

class FakeHistory {
  readonly replacements: ConversationMessageReplaceInput[] = []
  messages: ConversationMessageDto[] = Array.from({ length: 8 }, (_, index) => ({
    id: `message:00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index % 2 === 0 ? '用户要求' : '完成结果'} ${index + 1}`,
    status: 'complete',
    createdAt: timestamp,
    updatedAt: timestamp,
  }))

  async load(): Promise<ConversationSnapshot> {
    return {
      task: {
        id: taskId,
        projectId: 'project:test',
        title: '压缩测试',
        mode: 'agent',
        updatedAt: timestamp,
        archivedAt: null,
        status: 'idle',
      },
      messages: this.messages.map((message) => ({ ...message })),
      events: [],
    }
  }

  async replaceMessages(input: ConversationMessageReplaceInput): Promise<void> {
    this.replacements.push({ taskId: input.taskId, messages: input.messages.map((message) => ({ ...message })) })
    this.messages = input.messages.map((message, index) => ({
      id: `message:00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      role: message.role,
      content: message.content,
      status: 'complete',
      createdAt: timestamp,
      updatedAt: timestamp,
    }))
  }
}

const route = (endpointType: ConversationCompactionRoute['endpointType']): ConversationCompactionRoute => ({
  model: 'opaque-model',
  credentials: { baseUrl: 'https://relay.example.test/v1', apiKey: 'sk-test-secret' },
  endpointType,
  endpointPath: endpointType === 'gemini'
    ? '/v1beta/models/{model}:streamGenerateContent'
    : endpointType === 'anthropic'
      ? '/v1/messages'
      : endpointType === 'openai-response'
        ? '/v1/responses'
        : '/v1/chat/completions',
  wireMode: 'standard',
  reasoning: 'high',
})

test('explicit compaction routes through each confirmed protocol and persists one canonical summary', async () => {
  for (const endpointType of ['openai-response', 'openai', 'anthropic', 'gemini'] as const) {
    const history = new FakeHistory()
    const calls: string[] = []
    const service = new ConversationCompactionService({
      history,
      responses: { stream: async () => { calls.push('openai-response'); return response('模型生成的结构化摘要，保留关键要求与剩余待办。') } },
      chatCompletions: { stream: async () => { calls.push('openai'); return textResponse('模型生成的结构化摘要，保留关键要求与剩余待办。') } },
      anthropic: { stream: async () => { calls.push('anthropic'); return textResponse('模型生成的结构化摘要，保留关键要求与剩余待办。') } },
      gemini: { stream: async () => { calls.push('gemini'); return textResponse('模型生成的结构化摘要，保留关键要求与剩余待办。') } },
    })

    const result = await service.compact(taskId, route(endpointType), { force: true })

    assert.equal(result.compacted, true)
    assert.deepEqual(calls, [endpointType])
    assert.equal(history.replacements.length, 1)
    assert.match(history.replacements[0]!.messages[0]!.content, new RegExp(`^${escapeRegex(CONTEXT_SUMMARY_PREFIX)}`, 'u'))
    assert.equal(history.replacements[0]!.messages.some((message) => message.content.includes('sk-test-secret')), false)
    assert.equal(result.snapshot.messages[0]?.content, history.replacements[0]!.messages[0]!.content)
  }
})

test('short history returns its persisted snapshot without issuing a model request or rewriting messages', async () => {
  const history = new FakeHistory()
  history.messages = history.messages.slice(0, 3)
  let calls = 0
  const service = new ConversationCompactionService({
    history,
    responses: { stream: async () => { calls += 1; return response('unexpected summary output') } },
    chatCompletions: { stream: async () => { calls += 1; return textResponse('unexpected summary output') } },
    anthropic: { stream: async () => { calls += 1; return textResponse('unexpected summary output') } },
    gemini: { stream: async () => { calls += 1; return textResponse('unexpected summary output') } },
  })

  const result = await service.compact(taskId, route('openai-response'), { force: true })

  assert.deepEqual({ compacted: result.compacted, removedMessages: result.removedMessages }, {
    compacted: false,
    removedMessages: 0,
  })
  assert.equal(calls, 0)
  assert.equal(history.replacements.length, 0)
  assert.equal(result.snapshot.messages.length, 3)
})

function response(outputText: string) {
  return { responseId: 'response-test', outputText, toolCalls: [] }
}

function textResponse(outputText: string) {
  return { responseId: 'response-test', outputText }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

test('a turn admitted during summarization aborts the rewrite and leaves history untouched', async () => {
  const history = new FakeHistory()
  let turnActive = false
  const service = new ConversationCompactionService({
    history,
    responses: {
      stream: async () => {
        // The turn starts while the summary request is in flight.
        turnActive = true
        return response('模型生成的结构化摘要，保留关键要求与剩余待办。')
      },
    },
    chatCompletions: { stream: async () => textResponse('unused') },
    anthropic: { stream: async () => textResponse('unused') },
    gemini: { stream: async () => textResponse('unused') },
  })

  await assert.rejects(
    service.compact(taskId, route('openai-response'), {
      force: true,
      confirmStillSafe: () => !turnActive,
    }),
    (error: unknown) => error instanceof ConversationCompactionError && error.code === 'superseded'
  )
  assert.equal(history.replacements.length, 0)
})

test('automatic (non-force) compaction acts only when history nears the agent context ceiling', async () => {
  // Below the 0.9MB threshold: nothing happens and no model request is made.
  const shortHistory = new FakeHistory()
  let calls = 0
  const idle = new ConversationCompactionService({
    history: shortHistory,
    responses: { stream: async () => { calls += 1; return response('unexpected') } },
    chatCompletions: { stream: async () => { calls += 1; return textResponse('unexpected') } },
    anthropic: { stream: async () => { calls += 1; return textResponse('unexpected') } },
    gemini: { stream: async () => { calls += 1; return textResponse('unexpected') } },
  })
  const skipped = await idle.compact(taskId, route('openai-response'))
  assert.equal(skipped.compacted, false)
  assert.equal(calls, 0)
  assert.equal(shortHistory.replacements.length, 0)

  // Above the threshold: history is summarized without force.
  const longHistory = new FakeHistory()
  longHistory.messages = Array.from({ length: 12 }, (_, index) => ({
    id: `message:00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index % 2 === 0 ? '用户' : '助手'}${'长内容'.repeat(30_000)}`,
    status: 'complete',
    createdAt: timestamp,
    updatedAt: timestamp,
  }))
  const active = new ConversationCompactionService({
    history: longHistory,
    responses: { stream: async () => response('模型生成的结构化摘要，保留关键要求与剩余待办。') },
    chatCompletions: { stream: async () => textResponse('unused') },
    anthropic: { stream: async () => textResponse('unused') },
    gemini: { stream: async () => textResponse('unused') },
  })
  const compacted = await active.compact(taskId, route('openai-response'))
  assert.equal(compacted.compacted, true)
  assert.equal(longHistory.replacements.length, 1)
  assert.match(longHistory.replacements[0]!.messages[0]!.content, /^\[Context Compaction\] /u)
})
