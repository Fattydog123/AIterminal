import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  connectMcp,
  McpClientError,
  type McpClientErrorCode,
  type McpSession,
  type McpToolCallResult
} from '../../src/main/services/mcp-client.ts'

const STDIO_FIXTURE = String.raw`
const { spawn } = require('node:child_process')
const mode = process.argv[2]
let input = Buffer.alloc(0)
let initialized = false
const waiting = new Set()
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  windowsHide: true,
  stdio: 'ignore'
})

function encode(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (mode === 'content-length') {
    return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body])
  }
  return Buffer.concat([body, Buffer.from('\n')])
}

function send(value) {
  const wire = encode(value)
  const split = Math.max(1, Math.floor(wire.length / 3))
  process.stdout.write(wire.subarray(0, split))
  process.stdout.write(wire.subarray(split))
}

function takeMessages() {
  const messages = []
  while (input.length > 0) {
    while (input[0] === 10 || input[0] === 13) input = input.subarray(1)
    if (input.length === 0) break
    const newline = input.indexOf(10)
    if (newline < 0) break
    const first = input.subarray(0, newline).toString('ascii').trim()
    if (/^content-length\s*:/i.test(first)) {
      const headerEnd = input.indexOf('\r\n\r\n')
      if (headerEnd < 0) break
      const match = /^content-length\s*:\s*([0-9]+)\s*$/im.exec(input.subarray(0, headerEnd).toString('ascii'))
      if (!match) process.exit(70)
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (input.length < bodyStart + length) break
      messages.push(JSON.parse(input.subarray(bodyStart, bodyStart + length).toString('utf8')))
      input = input.subarray(bodyStart + length)
      continue
    }
    const line = input.subarray(0, newline).toString('utf8').replace(/\r$/, '')
    input = input.subarray(newline + 1)
    if (line) messages.push(JSON.parse(line))
  }
  return messages
}

function toolResult(text) {
  return { content: [{ type: 'text', text }] }
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fixture', version: '1.0.0' }
      }
    })
    return
  }
  if (message.method === 'notifications/initialized') {
    initialized = true
    process.stderr.write('api_key=sk-stdio-secret-123456\n')
    return
  }
  if (!initialized) process.exit(71)
  if (message.method === 'notifications/cancelled') {
    const requestId = message.params.requestId
    if (waiting.delete(requestId)) {
      setTimeout(() => send({ jsonrpc: '2.0', id: requestId, result: toolResult('late') }), 10)
    }
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo a value',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            additionalProperties: false
          }
        }]
      }
    })
    return
  }
  if (message.method !== 'tools/call') process.exit(72)
  const name = message.params.name
  if (name === 'wait') {
    waiting.add(message.id)
    return
  }
  if (name === 'log') {
    process.stderr.write('normal long-running diagnostic line\n'.repeat(40000), () => send({
      jsonrpc: '2.0',
      id: message.id,
      result: toolResult('logged')
    }))
    return
  }
  if (name === 'delay') {
    setTimeout(() => send({
      jsonrpc: '2.0',
      id: message.id,
      result: toolResult(String(message.params.arguments.value))
    }), 30)
    return
  }
  const text = name === 'pid'
    ? String(process.pid)
    : name === 'tree-pid'
      ? String(grandchild.pid)
      : String(message.params.arguments.value)
  send({ jsonrpc: '2.0', id: message.id, result: toolResult(text) })
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  for (const message of takeMessages()) handle(message)
})
`

async function createStdioFixture(
  t: TestContext,
  framing: 'newline' | 'content-length',
  onStderr?: (text: string) => void
): Promise<McpSession> {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-mcp-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const fixturePath = join(root, 'mcp-fixture.cjs')
  await fs.writeFile(fixturePath, STDIO_FIXTURE, 'utf8')
  return await connectMcp({
    transport: 'stdio',
    command: process.execPath,
    args: [fixturePath, framing],
    framing,
    requestTimeoutMs: 2_000,
    env: { MCP_FIXTURE_ALLOWED: 'true' },
    onStderr
  })
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: McpClientErrorCode
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof McpClientError)
    assert.equal(error.code, code)
    assert.equal(error.message, new McpClientError(code).message)
    assert.equal(error.stack, `McpClientError: ${error.message}`)
    assert.equal(error.stack.includes('sk-'), false)
    return true
  })
}

function toolText(result: McpToolCallResult): string {
  const block = result.content[0]
  assert.ok(block)
  assert.equal(block.type, 'text')
  assert.equal(typeof block.text, 'string')
  return block.text
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail('MCP fixture process was still alive after close')
}

test('newline stdio lists and calls tools, matches concurrent ids, aborts one call, and closes the process', async (t) => {
  const diagnostics: string[] = []
  const session = await createStdioFixture(t, 'newline', (text) => diagnostics.push(text))
  t.after(() => session.close())

  const tools = await session.listTools()
  assert.deepEqual(tools.map((tool) => tool.name), ['echo'])
  assert.equal(tools[0]?.inputSchema.type, 'object')

  const slow = session.callTool('delay', { value: 'slow' })
  const fast = session.callTool('echo', { value: 'fast' })
  assert.equal(toolText(await fast), 'fast')
  assert.equal(toolText(await slow), 'slow')

  const controller = new AbortController()
  const waiting = session.callTool('wait', {}, controller.signal)
  setTimeout(() => controller.abort(), 25)
  await rejectsWithCode(waiting, 'cancelled')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(toolText(await session.callTool('echo', { value: 'after-abort' })), 'after-abort')

  const pid = Number(toolText(await session.callTool('pid', {})))
  const treePid = Number(toolText(await session.callTool('tree-pid', {})))
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.ok(Number.isSafeInteger(treePid) && treePid > 0)
  await session.close()
  await waitForExit(pid)
  await waitForExit(treePid)
  await rejectsWithCode(session.listTools(), 'closed')

  assert.equal(diagnostics.some((text) => text.includes('<redacted>')), true)
  assert.equal(diagnostics.some((text) => text.includes('sk-stdio-secret-123456')), false)
})

test('content-length stdio framing works in both directions and bounds outbound JSON', async (t) => {
  const session = await createStdioFixture(t, 'content-length')
  t.after(() => session.close())

  assert.deepEqual((await session.listTools()).map((tool) => tool.name), ['echo'])
  assert.equal(toolText(await session.callTool('echo', { value: 'content-length-ok' })), 'content-length-ok')
  assert.equal(toolText(await session.callTool('log', {})), 'logged')
  await rejectsWithCode(
    session.callTool('echo', { value: 'x'.repeat(1024 * 1024) }),
    'limit_exceeded'
  )
  assert.equal(toolText(await session.callTool('echo', { value: 'still-open' })), 'still-open')
})

interface RecordedHttpRequest {
  readonly method: string
  readonly authorization: string | undefined
  readonly sessionId: string | undefined
  readonly protocolVersion: string | undefined
  readonly fixtureHeader: string | undefined
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return address.port
}

test('streamable HTTP refreshes authorization and parses JSON plus SSE data events', async (t) => {
  const requests: RecordedHttpRequest[] = []
  let sseClosed = false
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      if (request.method === 'DELETE') {
        requests.push({
          method: 'DELETE',
          authorization: request.headers.authorization,
          sessionId: request.headers['mcp-session-id'] as string | undefined,
          protocolVersion: request.headers['mcp-protocol-version'] as string | undefined,
          fixtureHeader: request.headers['x-fixture'] as string | undefined
        })
        response.writeHead(204)
        response.end()
        return
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({
        method: String(message.method),
        authorization: request.headers.authorization,
        sessionId: request.headers['mcp-session-id'] as string | undefined,
        protocolVersion: request.headers['mcp-protocol-version'] as string | undefined,
        fixtureHeader: request.headers['x-fixture'] as string | undefined
      })
      if (message.method === 'initialize') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'fixture-session'
        })
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'http-fixture', version: '1.0.0' }
          }
        }))
        return
      }
      if (message.method === 'notifications/initialized') {
        response.writeHead(202)
        response.end()
        return
      }
      if (message.method === 'tools/list') {
        response.on('close', () => {
          sseClosed = true
        })
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write('event: message\n')
        response.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n')
        response.write(`data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [{ name: 'http-echo', inputSchema: { type: 'object' } }]
          }
        })}\n\n`)
        return
      }
      const params = message.params as Record<string, unknown>
      if (params.name === 'http-wait') {
        setTimeout(() => {
          if (response.destroyed) return
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: 'late' }] }
          }))
        }, 100)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'HTTP_OK' }], structuredContent: { ok: true } }
      }))
    })
  })
  const port = await listen(server)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  let authorizationCalls = 0
  const session = await connectMcp({
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { 'x-fixture': 'true' },
    getAuthorizationHeader: async () => {
      authorizationCalls += 1
      return `Bearer fixture-token-${authorizationCalls}`
    },
    requestTimeoutMs: 2_000
  })
  t.after(() => session.close())

  assert.deepEqual((await session.listTools()).map((tool) => tool.name), ['http-echo'])
  await waitUntil(() => sseClosed)
  const controller = new AbortController()
  const waiting = session.callTool('http-wait', {}, controller.signal)
  setTimeout(() => controller.abort(), 25)
  await rejectsWithCode(waiting, 'cancelled')
  const result = await session.callTool('http-echo', { value: 'ignored' })
  assert.equal(toolText(result), 'HTTP_OK')
  assert.deepEqual(result.structuredContent, { ok: true })
  const closePending = session.callTool('http-wait', {})
  await waitUntil(() => requests.filter((request) => request.method === 'tools/call').length === 3)
  const closing = session.close()
  await rejectsWithCode(closePending, 'closed')
  await closing

  assert.equal(authorizationCalls, 7)
  assert.deepEqual(
    requests.map((request) => request.authorization),
    [
      'Bearer fixture-token-1',
      'Bearer fixture-token-2',
      'Bearer fixture-token-3',
      'Bearer fixture-token-4',
      'Bearer fixture-token-5',
      'Bearer fixture-token-6',
      'Bearer fixture-token-7'
    ]
  )
  assert.equal(requests[0]?.sessionId, undefined)
  assert.equal(requests.slice(1).every((request) => request.sessionId === 'fixture-session'), true)
  assert.equal(requests.slice(1).every((request) => request.protocolVersion === '2025-06-18'), true)
  assert.equal(requests.every((request) => request.fixtureHeader === 'true'), true)
  assert.equal(requests.at(-1)?.method, 'DELETE')

  await rejectsWithCode(session.callTool('http-echo', {}), 'closed')
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for the local MCP fixture')
}
