import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExternalProviderHistoryError,
  ExternalProviderHistoryService,
  type ExternalHistoryProvider
} from '../../src/main/services/external-provider-history-service.ts'

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111'
const GEMINI_SESSION = '22222222-2222-4222-8222-222222222222'
const GROK_SESSION = '33333333-3333-4333-8333-333333333333'

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ai-terminal-external-history-'))

  const claudeProject = join(home, '.claude', 'projects', 'C--Work--ClaudeApp')
  await mkdir(claudeProject, { recursive: true })
  await writeJsonLines(join(claudeProject, `${CLAUDE_SESSION}.jsonl`), [
    {
      type: 'user',
      isMeta: true,
      sessionId: CLAUDE_SESSION,
      timestamp: '2026-07-20T01:00:00.000Z',
      cwd: 'C:\\Work\\ClaudeApp',
      uuid: 'meta-user',
      message: { role: 'user', content: 'Hidden metadata password=secret-value' }
    },
    {
      type: 'user',
      sessionId: CLAUDE_SESSION,
      timestamp: '2026-07-20T01:01:00.000Z',
      cwd: 'C:\\Work\\ClaudeApp',
      uuid: 'visible-user',
      message: {
        role: 'user',
        content: 'Inspect C:\\Work\\ClaudeApp\\src and use api_key=sk-1234567890.'
      }
    },
    {
      type: 'assistant',
      sessionId: CLAUDE_SESSION,
      timestamp: '2026-07-20T01:02:00.000Z',
      cwd: 'C:\\Work\\ClaudeApp',
      uuid: 'assistant-fragment-1',
      message: {
        id: 'msg-claude-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'First visible fragment.' }]
      }
    },
    {
      type: 'assistant',
      sessionId: CLAUDE_SESSION,
      timestamp: '2026-07-20T01:02:01.000Z',
      cwd: 'C:\\Work\\ClaudeApp',
      uuid: 'assistant-fragment-2',
      message: {
        id: 'msg-claude-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'read_file', input: { path: 'private.txt' } },
          { type: 'text', text: 'Second visible fragment.' }
        ]
      }
    },
    {
      type: 'user',
      isSidechain: true,
      sessionId: CLAUDE_SESSION,
      timestamp: '2026-07-20T01:03:00.000Z',
      uuid: 'hidden-sidechain',
      message: { role: 'user', content: 'Hidden sidechain text.' }
    },
    {
      type: 'user',
      sessionId: CLAUDE_SESSION,
      timestamp: '2026-07-20T01:04:00.000Z',
      uuid: 'tool-result',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'Hidden tool output.' }]
      }
    }
  ])

  const geminiProject = join(home, '.gemini', 'tmp', 'project-hash')
  const geminiChats = join(geminiProject, 'chats')
  await mkdir(geminiChats, { recursive: true })
  await writeFile(join(geminiProject, '.project_root'), 'C:\\Work\\GeminiApp\n', 'utf8')
  await writeJsonLines(join(geminiChats, 'session-2026-07-21T12-00-fixture.jsonl'), [
    {
      sessionId: GEMINI_SESSION,
      projectHash: 'project-hash',
      startTime: '2026-07-21T12:00:00.000Z',
      lastUpdated: '2026-07-21T12:03:00.000Z',
      kind: 'main'
    },
    {
      type: 'user',
      id: 'gemini-user',
      timestamp: '2026-07-21T12:01:00.000Z',
      content: [{ type: 'text', text: 'Review the Gemini workspace.' }]
    },
    {
      type: 'gemini',
      id: 'gemini-answer',
      timestamp: '2026-07-21T12:02:00.000Z',
      content: 'Gemini visible answer.',
      thoughts: ['hidden thought'],
      toolCalls: [{ name: 'read_file', args: { path: 'secret.txt' } }]
    },
    {
      type: 'gemini',
      id: 'gemini-answer',
      timestamp: '2026-07-21T12:02:00.000Z',
      content: 'Gemini visible answer.'
    },
    { $set: { 'messages.0.tokens.total': 10 } }
  ])

  const grokProject = join(home, '.grok', 'sessions', 'C%3A%5CWork%5CGrokApp')
  const grokSession = join(grokProject, GROK_SESSION)
  await mkdir(grokSession, { recursive: true })
  await writeJsonLines(join(grokSession, 'chat_history.jsonl'), [
    { type: 'system', content: 'Hidden system prompt.' },
    { type: 'user', synthetic_reason: 'system_reminder', content: 'Hidden synthetic reminder.' },
    { type: 'user', content: '<user_info>Hidden account context.</user_info>' },
    {
      type: 'user',
      content: [
        { type: 'input_text', text: '<system-reminder>Hidden workspace context.</system-reminder>' },
        { type: 'input_text', text: '<user_info>Hidden environment context.</user_info>' },
      ],
    },
    { type: 'user', content: [{ type: 'text', text: 'Check the Grok project.' }] },
    { type: 'user', content: 'Explain the literal <system-reminder> tag to me.' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Hidden reasoning.' }] },
    { type: 'assistant', content: 'Grok visible answer.' },
    { type: 'tool_result', tool_call_id: 'call-1', content: 'Hidden tool output.' },
    { type: 'assistant', content: '' }
  ])

  return home
}

async function writeJsonLines(filePath: string, values: readonly unknown[]): Promise<void> {
  await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}

test('lists Claude, Gemini, and Grok sessions without exposing source paths', async (t) => {
  const home = await fixtureHome()
  t.after(async () => await rm(home, { recursive: true, force: true }))
  const history = new ExternalProviderHistoryService({ homeDirectory: home })

  const result = await history.listThreads()

  assert.equal(result.truncated, false)
  assert.equal(result.threads.length, 3)
  assert.deepEqual(
    new Set(result.threads.map((thread) => thread.provider)),
    new Set<ExternalHistoryProvider>(['claude', 'gemini', 'grok'])
  )
  for (const thread of result.threads) {
    assert.match(thread.id, /^source_[A-Za-z0-9_-]{43}$/u)
    assert.ok(thread.createdAt > 0)
    assert.ok(thread.updatedAt >= thread.createdAt)
    assert.doesNotMatch(JSON.stringify(thread), /ai-terminal-external-history|C:\\Work|secret-value|sk-123/u)
  }
  assert.equal(result.threads.find((thread) => thread.provider === 'claude')?.cwdDisplayName, 'ClaudeApp')
  assert.equal(result.threads.find((thread) => thread.provider === 'gemini')?.cwdDisplayName, 'GeminiApp')
  assert.equal(result.threads.find((thread) => thread.provider === 'grok')?.cwdDisplayName, 'GrokApp')
})

test('reads only visible messages and coalesces provider update records', async (t) => {
  const home = await fixtureHome()
  t.after(async () => await rm(home, { recursive: true, force: true }))
  const history = new ExternalProviderHistoryService({ homeDirectory: home })
  const listed = await history.listThreads()

  const snapshots = await Promise.all(listed.threads.map(async (thread) => (
    await history.readThread(thread.provider, thread.id)
  )))
  const claude = snapshots.find((snapshot) => snapshot.thread.provider === 'claude')!
  const gemini = snapshots.find((snapshot) => snapshot.thread.provider === 'gemini')!
  const grok = snapshots.find((snapshot) => snapshot.thread.provider === 'grok')!

  assert.deepEqual(claude.messages.map((message) => message.role), ['user', 'assistant'])
  assert.match(claude.messages[0]!.text, /Inspect <local-path>/u)
  assert.match(claude.messages[0]!.text, /<redacted>/u)
  assert.doesNotMatch(claude.messages[0]!.text, /sk-1234567890|api_key=/u)
  assert.equal(
    claude.messages[1]!.text,
    'First visible fragment.\n\nSecond visible fragment.'
  )
  assert.doesNotMatch(JSON.stringify(claude), /Hidden metadata|Hidden sidechain|Hidden tool output/u)

  assert.deepEqual(gemini.messages, [
    { role: 'user', text: 'Review the Gemini workspace.' },
    { role: 'assistant', text: 'Gemini visible answer.' }
  ])
  assert.doesNotMatch(JSON.stringify(gemini), /hidden thought|secret\.txt/u)

  assert.deepEqual(grok.messages, [
    {
      role: 'user',
      text: 'Check the Grok project.\n\nExplain the literal <system-reminder> tag to me.'
    },
    { role: 'assistant', text: 'Grok visible answer.' }
  ])
  assert.doesNotMatch(
    JSON.stringify(grok),
    /Hidden system|Hidden synthetic|Hidden account|Hidden workspace|Hidden environment|Hidden reasoning|Hidden tool output/u
  )
})

test('discovers Grok ULID session directories used by current CLI builds', async (t) => {
  const home = await fixtureHome()
  t.after(async () => await rm(home, { recursive: true, force: true }))

  const project = join(home, '.grok', 'sessions', 'C%3A%5CWork%5CGrokApp')
  const ulid = '01J3NDE7Y8Q4K6M2P9R5T7V8X0'
  const session = join(project, ulid)
  await mkdir(session, { recursive: true })
  await writeJsonLines(join(session, 'chat_history.jsonl'), [
    { type: 'user', content: 'ULID session request' },
    { type: 'assistant', content: 'ULID session response' },
  ])

  const history = new ExternalProviderHistoryService({ homeDirectory: home })
  const listed = await history.listThreads({ provider: 'grok' })
  assert.equal(listed.threads.length, 2)

  const snapshot = await history.readThread(
    'grok',
    listed.threads.find((thread) => thread.title === 'ULID session request')!.id,
  )
  assert.deepEqual(snapshot.messages, [
    { role: 'user', text: 'ULID session request' },
    { role: 'assistant', text: 'ULID session response' },
  ])
})

test('rejects unknown providers and opaque ids with fixed path-free errors', async (t) => {
  const home = await fixtureHome()
  t.after(async () => await rm(home, { recursive: true, force: true }))
  const history = new ExternalProviderHistoryService({ homeDirectory: home })

  await assert.rejects(
    history.readThread('claude', '../private'),
    errorWithCode('invalid_input')
  )
  await assert.rejects(
    history.readThread('claude', `source_${'a'.repeat(43)}`),
    errorWithCode('unavailable')
  )
  await assert.rejects(
    history.listThreads({ provider: 'other' as ExternalHistoryProvider }),
    errorWithCode('invalid_input')
  )
})

function errorWithCode(code: ExternalProviderHistoryError['code']): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ExternalProviderHistoryError)
    assert.equal(error.code, code)
    assert.doesNotMatch(error.stack ?? '', /ai-terminal-external-history|C:\\/u)
    return true
  }
}
