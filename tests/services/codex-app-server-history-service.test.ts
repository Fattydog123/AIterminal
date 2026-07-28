import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexAppServerHistoryService,
  CodexHistoryError,
  type CodexHistoryErrorCode
} from '../../src/main/services/codex-app-server-history-service.ts'

function fakeServer(scriptBody: string): { command: string; args: readonly string[] } {
  const bootstrap = String.raw`
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let initialized = false
let listCalls = 0
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (initialized || message.id === undefined) process.exit(20)
    send({ id: message.id, result: { serverInfo: { name: 'fake-codex' } } })
    return
  }
  if (message.method === 'initialized') {
    initialized = true
    return
  }
  if (!initialized) process.exit(21)
  ${scriptBody}
})
`
  return { command: process.execPath, args: ['-e', bootstrap] }
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: CodexHistoryErrorCode
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CodexHistoryError)
    assert.equal(error.code, code)
    assert.equal(error.message, new CodexHistoryError(code).message)
    assert.equal(error.stack, `CodexHistoryError: ${error.message}`)
    assert.equal(error.stack.includes('C:\\'), false)
    return true
  })
}

test('initializes before paginating thread/list and returns path-safe summaries', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/list') process.exit(22)
  if (message.params.useStateDbOnly !== true || message.params.limit !== 1) process.exit(23)
  listCalls += 1
  if (listCalls === 1) {
    if (message.params.cursor !== null || message.params.archived !== false) process.exit(24)
    send({
      id: message.id,
      result: {
        data: [{
          id: 'thread-1',
          name: 'Plan for C:\\Users\\Alice\\private\\repo',
          preview: 'ignored preview',
          createdAt: 1710000000,
          updatedAt: 1710000100,
          cwd: 'C:\\Users\\Alice\\private\\repo'
        }],
        nextCursor: 'page-2'
      }
    })
    return
  }
  if (listCalls === 2) {
    if (message.params.cursor !== 'page-2') process.exit(25)
    send({
      id: message.id,
      result: {
        data: [{
          id: 'thread-2',
          name: null,
          preview: 'Second thread',
          createdAt: 1710000200,
          updatedAt: 1710000300,
          cwd: '/home/alice/project-two'
        }],
        nextCursor: null
      }
    })
    return
  }
  process.exit(26)
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    pageSize: 1,
    requestTimeoutMs: 2_000
  })
  t.after(() => service.dispose())

  const result = await service.listThreads()

  assert.equal(result.truncated, false)
  assert.deepEqual(result.threads, [
    {
      id: 'thread-1',
      title: 'Plan for <local-path>',
      createdAt: 1710000000,
      updatedAt: 1710000100,
      archived: false,
      cwdDisplayName: 'repo'
    },
    {
      id: 'thread-2',
      title: 'Second thread',
      createdAt: 1710000200,
      updatedAt: 1710000300,
      archived: false,
      cwdDisplayName: 'project-two'
    }
  ])
  for (const thread of result.threads) {
    assert.deepEqual(Object.keys(thread).sort(), [
      'archived',
      'createdAt',
      'cwdDisplayName',
      'id',
      'title',
      'updatedAt'
    ])
  }
  assert.equal(JSON.stringify(result).includes('C:\\Users'), false)
  assert.equal(JSON.stringify(result).includes('/home/alice'), false)
})

test('thread/read exposes only visible user text and agentMessage text', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/read') process.exit(30)
  if (message.params.threadId !== 'thread-visible' || message.params.includeTurns !== true) {
    process.exit(31)
  }
  send({
    id: message.id,
    result: {
      thread: {
        id: 'thread-visible',
        name: 'Inspect ' + String.fromCharCode(96) + '/opt/private/title.md' + String.fromCharCode(96),
        createdAt: 1711000000,
        updatedAt: 1711000100,
        cwd: 'C:\\Users\\Alice\\source\\project',
        turns: [{
          items: [
            {
              type: 'userMessage',
              content: [
                { type: 'text', text: 'Open C:\\Users\\Alice\\secret\\notes.txt' },
                { type: 'image', url: 'file:///C:/Users/Alice/secret.png' },
                { type: 'text', text: 'api_key=sk-1234567890' },
                {
                  type: 'text',
                  text: 'Read ' + String.fromCharCode(96) + '/opt/private/input.txt' + String.fromCharCode(96) + ', redirect >/etc/passwd, and mount //server/share. Keep https://example.com/docs.'
                }
              ]
            },
            { type: 'reasoning', summary: ['internal chain of thought'] },
            { type: 'commandExecution', command: 'type secret.txt', output: 'command secret' },
            { type: 'mcpToolCall', arguments: { password: 'tool-secret' } },
            { type: 'plan', text: 'hidden plan' },
            { type: 'unknownFutureItem', text: 'unknown secret' },
            {
              type: 'agentMessage',
              text: "Done in /home/alice/project; password='hunter2'"
            },
            { type: 'agentMessage', text: { unexpected: true } }
          ]
        }]
      }
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 2_000
  })
  t.after(() => service.dispose())

  const result = await service.readThread('thread-visible', { archived: true })

  assert.equal(result.thread.archived, true)
  assert.equal(result.thread.cwdDisplayName, 'project')
  assert.deepEqual(result.messages.map((item) => item.role), ['user', 'assistant'])
  assert.match(result.messages[0]!.text, /<local-path>/u)
  assert.match(result.messages[0]!.text, /api_key=<redacted>/u)
  assert.match(result.messages[0]!.text, /https:\/\/example\.com\/docs/u)
  assert.match(result.messages[1]!.text, /<local-path>/u)
  assert.match(result.messages[1]!.text, /password='<redacted>'/u)
  const serialized = JSON.stringify(result)
  for (const forbidden of [
    'C:\\Users',
    '/home/alice',
    '/opt/private',
    '/etc/passwd',
    '//server/share',
    'sk-1234567890',
    'hunter2',
    'internal chain of thought',
    'command secret',
    'tool-secret',
    'hidden plan',
    'unknown secret',
    'secret.png'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`)
  }
  for (const item of result.messages) {
    assert.deepEqual(Object.keys(item).sort(), ['role', 'text'])
  }
})

test('bounds archived-state memory and evicts the oldest thread metadata', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/read') process.exit(55)
  const threadId = message.params.threadId
  send({
    id: message.id,
    result: {
      thread: {
        id: threadId,
        name: threadId,
        createdAt: 1,
        updatedAt: 2,
        cwd: 'C:\\work\\' + threadId,
        turns: []
      }
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxThreads: 1,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  assert.equal((await service.readThread('thread-a', { archived: true })).thread.archived, true)
  assert.equal((await service.readThread('thread-b', { archived: false })).thread.archived, false)
  assert.equal((await service.readThread('thread-a')).thread.archived, false)
})

test('probe reports an unavailable executable without leaking spawn details', async () => {
  const service = new CodexAppServerHistoryService({
    command: 'C:\\definitely-missing\\codex-history-does-not-exist.exe',
    args: [],
    requestTimeoutMs: 500
  })
  try {
    assert.deepEqual(await service.probe(), { available: false, reason: 'unavailable' })
  } finally {
    service.dispose()
  }
})

test('reports a fixed process_exited error when app-server exits mid-request', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method === 'thread/list') process.exit(44)
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  await rejectsWithCode(service.listThreads(), 'process_exited')
})

test('times out a silent request and terminates the affected app-server', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method === 'thread/list') return
  process.exit(45)
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 40
  })
  t.after(() => service.dispose())

  await rejectsWithCode(service.listThreads(), 'timeout')
})

test('AbortSignal cancels a pending request with a fixed error', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method === 'thread/list') return
  process.exit(46)
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 2_000
  })
  t.after(() => service.dispose())
  const controller = new AbortController()
  const request = service.listThreads({ signal: controller.signal })
  setTimeout(() => controller.abort(), 25)

  await rejectsWithCode(request, 'cancelled')
  assert.deepEqual(await service.probe(), { available: true })
})

test('rejects malformed JSONL as a protocol error', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method === 'thread/list') {
    process.stdout.write(Buffer.from([123, 110, 111, 116, 45, 106, 115, 111, 110, 10]))
    return
  }
  process.exit(47)
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  await rejectsWithCode(service.listThreads(), 'protocol_error')
})

test('rejects an oversized response line before parsing it', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method === 'thread/list') {
    send({
      id: message.id,
      result: { data: [], nextCursor: null, padding: 'x'.repeat(2_000) }
    })
    return
  }
  process.exit(48)
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxResponseLineBytes: 256,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  await rejectsWithCode(service.listThreads(), 'limit_exceeded')
})

test('default input bound accepts a large official thread response and still truncates public text', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/read') process.exit(56)
  send({
    id: message.id,
    result: {
      thread: {
        id: 'large-official-thread',
        name: 'Large official thread',
        createdAt: 1,
        updatedAt: 2,
        cwd: 'C:\\work\\large',
        turns: [{ items: [
          { type: 'agentMessage', text: 'x'.repeat(9 * 1024 * 1024) }
        ] }]
      }
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 2_000
  })
  t.after(() => service.dispose())

  const result = await service.readThread('large-official-thread')
  assert.equal(result.messages.length, 1)
  assert.equal(Buffer.byteLength(result.messages[0]!.text, 'utf8'), 256 * 1024)
  assert.equal(result.truncated, true)
})

test('stops pagination at maxPages and marks the list truncated', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/list' || listCalls !== 0) process.exit(49)
  listCalls += 1
  send({
    id: message.id,
    result: {
      data: [{
        id: 'page-limit-thread',
        name: 'First page',
        createdAt: 1,
        updatedAt: 2,
        cwd: 'C:\\work\\first'
      }],
      nextCursor: 'more-pages'
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxPages: 1,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  const result = await service.listThreads()
  assert.equal(result.threads.length, 1)
  assert.equal(result.truncated, true)
})

test('stops at maxThreads even when a page contains more summaries', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/list') process.exit(50)
  send({
    id: message.id,
    result: {
      data: [
        { id: 'kept', name: 'Kept', createdAt: 1, updatedAt: 2, cwd: 'C:\\work\\kept' },
        { id: 'omitted', name: 'Omitted', createdAt: 1, updatedAt: 2, cwd: 'C:\\work\\omitted' }
      ],
      nextCursor: null
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxThreads: 1,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  const result = await service.listThreads()
  assert.deepEqual(result.threads.map((thread) => thread.id), ['kept'])
  assert.equal(result.truncated, true)
})

test('does not report truncation when the final page exactly fills maxThreads', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/list') process.exit(54)
  send({
    id: message.id,
    result: {
      data: [{
        id: 'exact-limit',
        name: 'Exact limit',
        createdAt: 1,
        updatedAt: 2,
        cwd: 'C:\\work\\exact'
      }],
      nextCursor: null
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxThreads: 1,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  const result = await service.listThreads()
  assert.equal(result.threads.length, 1)
  assert.equal(result.truncated, false)
})

test('rejects repeated pagination cursors instead of looping', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/list') process.exit(51)
  listCalls += 1
  send({
    id: message.id,
    result: {
      data: [{
        id: 'cursor-thread-' + listCalls,
        name: 'Cursor thread',
        createdAt: listCalls,
        updatedAt: listCalls,
        cwd: 'C:\\work\\cursor'
      }],
      nextCursor: 'same-cursor'
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  await rejectsWithCode(service.listThreads(), 'protocol_error')
})

test('message count and UTF-8 byte bounds truncate without splitting a character', async (t) => {
  const processOptions = fakeServer(String.raw`
  if (message.method !== 'thread/read') process.exit(52)
  send({
    id: message.id,
    result: {
      thread: {
        id: 'bounded-thread',
        name: 'Bounded',
        createdAt: 1,
        updatedAt: 2,
        cwd: 'C:\\work\\bounded',
        turns: [{ items: [
          { type: 'agentMessage', text: '你a好' },
          { type: 'userMessage', content: [{ type: 'text', text: 'second' }] }
        ] }]
      }
    }
  })
  `)
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxMessages: 1,
    maxMessageBytes: 4,
    maxTotalMessageBytes: 4,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  const result = await service.readThread('bounded-thread')
  assert.deepEqual(result.messages, [{ role: 'assistant', text: '你a' }])
  assert.equal(Buffer.byteLength(result.messages[0]!.text, 'utf8'), 4)
  assert.equal(result.truncated, true)
})

test('bounds outbound JSONL requests before writing to the process', async (t) => {
  const processOptions = fakeServer('process.exit(53)')
  const service = new CodexAppServerHistoryService({
    ...processOptions,
    maxRequestBytes: 8,
    requestTimeoutMs: 1_000
  })
  t.after(() => service.dispose())

  await rejectsWithCode(service.listThreads(), 'limit_exceeded')
})
