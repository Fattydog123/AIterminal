import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AnthropicMessagesClient,
  AnthropicMessagesClientError,
  type AnthropicMessagesStreamWithToolsRequest,
  type AnthropicMessagesStreamEvent
} from '../../src/main/services/anthropic-messages-client.ts'
import {
  GeminiContentClient,
  GeminiContentClientError,
  type GeminiContentStreamEvent
} from '../../src/main/services/gemini-content-client.ts'

const credentials = { baseUrl: 'https://relay.example.test/v1', apiKey: 'unit-test-key-never-logged' }

function responseFromSse(wire: string, contentType = 'text/event-stream'): Response {
  return new Response(wire, { status: 200, headers: { 'content-type': contentType } })
}

function chunkedFetcher(response: Response, chunks: number[] = []): {
  fetcher: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    if (chunks.length === 0) return response
    const bytes = new TextEncoder().encode(await response.text())
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0
        for (const size of chunks) {
          controller.enqueue(bytes.slice(offset, offset + size))
          offset += size
        }
        if (offset < bytes.length) controller.enqueue(bytes.slice(offset))
        controller.close()
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetcher, calls }
}

test('Anthropic Messages maps shared messages and emits normalized deltas', async () => {
  const wire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_native_1"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const { fetcher, calls } = chunkedFetcher(responseFromSse(wire), [1, 2, 5, 3, 8])
  const events: AnthropicMessagesStreamEvent[] = []
  const client = new AnthropicMessagesClient({ fetcher })
  const result = await client.stream(credentials, {
    model: 'claude-native',
    system: 'Be concise',
    instructions: 'Use plain text',
    messages: [
      { role: 'developer', content: 'Do not reveal credentials.' },
      { role: 'user', content: [
        { type: 'input_text', text: 'hello' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAA==' }
      ] }
    ]
  }, {
    signal: new AbortController().signal,
    onEvent: (event) => { events.push(event) }
  })

  assert.deepEqual(result, { responseId: 'msg_native_1', outputText: 'hello world' })
  assert.deepEqual(events, [
    { type: 'response.output_text.delta', delta: 'hello ' },
    { type: 'response.output_text.delta', delta: 'world' }
  ])
  assert.equal(calls[0]?.url, 'https://relay.example.test/v1/messages')
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal((calls[0]?.init.headers as Record<string, string>)['anthropic-version'], '2023-06-01')
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-api-key'], credentials.apiKey)
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${credentials.apiKey}`)
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 4096)
  assert.equal(body.system, 'Be concise\n\nUse plain text\n\nDo not reveal credentials.')
  assert.deepEqual((body.messages as Array<Record<string, unknown>>)[0]?.content, [
    { type: 'text', text: 'hello' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAAAAAAAAAAAAAAAAAAAA==' } }
  ])
})

test('Anthropic emits adaptive or budget thinking only from explicit protocol metadata', async () => {
  const wire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_reasoning"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const bodies: Array<Record<string, unknown>> = []
  const client = new AnthropicMessagesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responseFromSse(wire)
    }) as typeof fetch
  })

  await client.stream(credentials, {
    model: 'anthropic-adaptive',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'max',
    reasoningProtocol: { type: 'anthropic-adaptive' }
  })
  await client.stream(credentials, {
    model: 'anthropic-budget',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'high',
    reasoningProtocol: {
      type: 'anthropic-budget',
      budgets: { high: 8_192 }
    }
  })
  await client.stream(credentials, {
    model: 'anthropic-undeclared',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'high'
  })

  assert.deepEqual(bodies[0]?.thinking, { type: 'adaptive' })
  assert.deepEqual(bodies[0]?.output_config, { effort: 'max' })
  assert.deepEqual(bodies[1]?.thinking, { type: 'enabled', budget_tokens: 8_192 })
  assert.equal(bodies[1]?.max_tokens, 9_216)
  assert.equal(Object.hasOwn(bodies[1] ?? {}, 'output_config'), false)
  assert.equal(Object.hasOwn(bodies[2] ?? {}, 'thinking'), false)
  assert.equal(Object.hasOwn(bodies[2] ?? {}, 'output_config'), false)
})

test('Anthropic rejects an effort its adaptive protocol cannot represent before fetch', async () => {
  const client = new AnthropicMessagesClient({
    fetcher: (async () => {
      throw new Error('fetch must not run')
    }) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, {
      model: 'anthropic-adaptive',
      messages: [{ role: 'user', content: 'reason' }],
      reasoning: 'ultra',
      reasoningProtocol: { type: 'anthropic-adaptive' }
    }),
    (error: unknown) =>
      error instanceof AnthropicMessagesClientError && error.code === 'invalid_input'
  )
})

test('Anthropic rejects an unrepresentable adaptive effort for tool streaming before fetch', async () => {
  const client = new AnthropicMessagesClient({
    fetcher: (async () => {
      throw new Error('fetch must not run')
    }) as typeof fetch
  })

  await assert.rejects(
    client.streamWithTools(credentials, {
      model: 'anthropic-adaptive',
      messages: [{ role: 'user', content: 'Use a tool.' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }],
      reasoning: 'ultra',
      reasoningProtocol: { type: 'anthropic-adaptive' }
    }),
    (error: unknown) =>
      error instanceof AnthropicMessagesClientError && error.code === 'invalid_input'
  )
})

test('Anthropic sends a declared Ultra budget as numeric thinking tokens', async () => {
  let body: Record<string, unknown> | undefined
  const client = new AnthropicMessagesClient({
    fetcher: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return responseFromSse([
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_ultra_budget"}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n'
      ].join(''))
    }) as typeof fetch
  })

  await client.stream(credentials, {
    model: 'anthropic-budget',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'ultra',
    reasoningProtocol: {
      type: 'anthropic-budget',
      budgets: { ultra: 8_192 }
    }
  })

  assert.deepEqual(body?.thinking, { type: 'enabled', budget_tokens: 8_192 })
  assert.equal(Object.hasOwn(body ?? {}, 'output_config'), false)
})

test('Anthropic rejects redirects and malformed/incomplete streams without leaking details', async () => {
  const redirectClient = new AnthropicMessagesClient({
    fetcher: (async () => new Response(null, { status: 302, headers: { location: 'https://secret.example/' } })) as typeof fetch
  })
  await assert.rejects(
    redirectClient.stream(credentials, { model: 'claude', messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof AnthropicMessagesClientError && error.code === 'redirect_rejected' && !error.message.includes('secret')
  )

  const malformed = new AnthropicMessagesClient({
    fetcher: (async () => responseFromSse('event: message_stop\ndata: {bad}\n\n')) as typeof fetch
  })
  await assert.rejects(
    malformed.stream(credentials, { model: 'claude', messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof AnthropicMessagesClientError && error.code === 'invalid_response'
  )
})

test('Anthropic Messages streams native tool_use calls and serializes tool_result history', async () => {
  const wire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_agent_1"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking."}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_read_2","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"relativePath\\":\\""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"README.md\\"}"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const { fetcher, calls } = chunkedFetcher(responseFromSse(wire), [1, 3, 2, 7, 5])
  const events: AnthropicMessagesStreamEvent[] = []
  const client = new AnthropicMessagesClient({ fetcher })
  const request: AnthropicMessagesStreamWithToolsRequest = {
    model: 'claude-native',
    instructions: 'Use workspace tools.',
    messages: [
      { role: 'user', content: 'Read the project.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_list_1', name: 'list_directory', input: { relativePath: '.' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_list_1', content: '["README.md"]' }]
      }
    ],
    tools: [
      {
        name: 'list_directory',
        description: 'List a directory.',
        input_schema: {
          type: 'object',
          properties: { relativePath: { type: 'string' } },
          required: ['relativePath']
        }
      },
      {
        name: 'read_file',
        input_schema: {
          type: 'object',
          properties: { relativePath: { type: 'string' } },
          required: ['relativePath']
        }
      }
    ]
  }

  const result = await client.streamWithTools(credentials, request, {
    onEvent: (event) => { events.push(event) }
  })

  assert.deepEqual(result, {
    responseId: 'msg_agent_1',
    outputText: 'Checking.',
    toolCalls: [{ id: 'toolu_read_2', name: 'read_file', input: { relativePath: 'README.md' } }],
    hasToolCalls: true,
    assistantContent: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_read_2', name: 'read_file', input: { relativePath: 'README.md' } }
    ]
  })
  assert.deepEqual(events, [{ type: 'response.output_text.delta', delta: 'Checking.' }])
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-api-key'], credentials.apiKey)
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${credentials.apiKey}`)
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.equal(body.stream, true)
  assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true })
  assert.deepEqual(body.tools, request.tools)
  assert.deepEqual(body.messages, request.messages)
  assert.equal(body.system, request.instructions)
})

test('Anthropic Messages replays a tool continuation after an empty streamed text block', async () => {
  const toolWire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_empty_text_tool"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_empty_text_write","name":"write_file","input":{"relative_path":"result.html","content":"ok"}}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const finalWire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_empty_text_final"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  const client = new AnthropicMessagesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responseFromSse(call++ === 0 ? toolWire : finalWire)
    }) as typeof fetch
  })
  const tools = [{
    name: 'write_file',
    input_schema: {
      type: 'object',
      properties: {
        relative_path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['relative_path', 'content']
    }
  }]

  const first = await client.streamWithTools(credentials, {
    model: 'claude-native',
    messages: [{ role: 'user', content: 'Create the file.' }],
    tools
  })
  const second = await client.streamWithTools(credentials, {
    model: 'claude-native',
    messages: [
      { role: 'user', content: 'Create the file.' },
      { role: 'assistant', content: first.assistantContent },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_empty_text_write',
          content: 'Workspace file written.'
        }]
      }
    ],
    tools
  })

  assert.deepEqual(first.assistantContent, [{
    type: 'tool_use',
    id: 'toolu_empty_text_write',
    name: 'write_file',
    input: { relative_path: 'result.html', content: 'ok' }
  }])
  assert.equal(second.outputText, 'Done.')
  assert.equal(bodies.length, 2)
})

test('Anthropic preserves bounded thinking blocks by source index for a tool continuation', async () => {
  const toolWire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_thinking_tool"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_thinking_read","name":"read_file","input":{"relative_path":"README.md"}}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":2}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"first "}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thought"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"thinking"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-redacted-block"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"Visible."}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":3}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const finalWire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_thinking_final"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  const client = new AnthropicMessagesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responseFromSse(call++ === 0 ? toolWire : finalWire)
    }) as typeof fetch
  })
  const events: AnthropicMessagesStreamEvent[] = []
  const tools = [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }]
  const first = await client.streamWithTools(credentials, {
    model: 'claude-native',
    messages: [{ role: 'user', content: 'Read the project.' }],
    tools
  }, { onEvent: (event) => { events.push(event) } })

  assert.deepEqual(first.assistantContent, [
    { type: 'thinking', thinking: 'first thought', signature: 'signed-thinking' },
    { type: 'redacted_thinking', data: 'opaque-redacted-block' },
    {
      type: 'tool_use',
      id: 'toolu_thinking_read',
      name: 'read_file',
      input: { relative_path: 'README.md' }
    },
    { type: 'text', text: 'Visible.' }
  ])
  assert.equal(first.outputText, 'Visible.')
  assert.deepEqual(events, [{ type: 'response.output_text.delta', delta: 'Visible.' }])

  const second = await client.streamWithTools(credentials, {
    model: 'claude-native',
    messages: [
      { role: 'user', content: 'Read the project.' },
      { role: 'assistant', content: first.assistantContent },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_thinking_read',
          content: 'safe result'
        }]
      }
    ],
    tools
  })
  const continuedMessages = bodies[1]?.messages as Array<Record<string, unknown>>
  assert.deepEqual(continuedMessages[1]?.content, first.assistantContent)
  assert.deepEqual(second.assistantContent, [{ type: 'text', text: 'Done.' }])
})

test('Anthropic Messages tool stream fails closed on duplicate calls, unknown deltas, and unsafe input', async () => {
  const baseEvents = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_agent_bad"}}\n\n'
  ].join('')
  const endings = [
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')
  const duplicateCalls = `${baseEvents}${[
    0,
    1
  ].map((index) => [
    'event: content_block_start\n',
    `data: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"toolu_duplicate","name":"read_file","input":{}}}\n\n`,
    'event: content_block_delta\n',
    `data: {"type":"content_block_delta","index":${index},"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n`,
    'event: content_block_stop\n',
    `data: {"type":"content_block_stop","index":${index}}\n\n`
  ].join('')).join('')}${endings}`
  const unknownDelta = `${baseEvents}${[
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"future_tool_delta","value":"{}"}}\n\n'
  ].join('')}`
  const emptyCallId = `${baseEvents}${[
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"","name":"read_file","input":{}}}\n\n'
  ].join('')}`
  const missingThinkingSignature = `${baseEvents}${[
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"bounded thought"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('')}`
  const malformedRedactedThinking = `${baseEvents}${[
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque","unexpected":true}}\n\n'
  ].join('')}`
  const request: AnthropicMessagesStreamWithToolsRequest = {
    model: 'claude-native',
    messages: [{ role: 'user', content: 'Read a file.' }],
    tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }]
  }

  for (const wire of [
    duplicateCalls,
    unknownDelta,
    emptyCallId,
    missingThinkingSignature,
    malformedRedactedThinking
  ]) {
    const client = new AnthropicMessagesClient({
      fetcher: (async () => responseFromSse(wire)) as typeof fetch
    })
    await assert.rejects(
      client.streamWithTools(credentials, request),
      (error: unknown) => error instanceof AnthropicMessagesClientError && error.code === 'invalid_response'
    )
  }

  const unsafeInput = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
  await assert.rejects(
    new AnthropicMessagesClient().streamWithTools(credentials, {
      ...request,
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_history', name: 'read_file', input: unsafeInput }]
      }]
    }),
    (error: unknown) => error instanceof AnthropicMessagesClientError && error.code === 'invalid_input'
  )
})

test('Anthropic Messages tool stream cancellation and failures are sanitized', async () => {
  let forwardedSignal: AbortSignal | null = null
  const secret = credentials.apiKey
  const client = new AnthropicMessagesClient({
    fetcher: ((_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? null
      return new Promise<Response>((_resolve, reject) => {
        forwardedSignal?.addEventListener(
          'abort',
          () => reject(new Error(`aborted with ${secret} C:\\private\\workspace`)),
          { once: true }
        )
      })
    }) as typeof fetch
  })
  const controller = new AbortController()
  const pending = client.streamWithTools(credentials, {
    model: 'claude-native',
    messages: [{ role: 'user', content: 'Wait.' }],
    tools: [{ name: 'wait', input_schema: { type: 'object', properties: {} } }]
  }, { signal: controller.signal })
  controller.abort()

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AnthropicMessagesClientError)
    assert.equal(error.code, 'cancelled')
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /unit-test-key|private|workspace/u)
    return true
  })
  assert.equal(forwardedSignal?.aborted, true)

  const failureClient = new AnthropicMessagesClient({
    fetcher: (async () => {
      throw new Error(`upstream exposed ${secret} C:\\private\\workspace`)
    }) as typeof fetch
  })
  await assert.rejects(
    failureClient.streamWithTools(credentials, {
      model: 'claude-native',
      messages: [{ role: 'user', content: 'Fail safely.' }],
      tools: [{ name: 'wait', input_schema: { type: 'object', properties: {} } }]
    }),
    (error: unknown) => {
      assert.ok(error instanceof AnthropicMessagesClientError)
      assert.equal(error.code, 'network_error')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /unit-test-key|private|workspace|example\.test/u)
      return true
    }
  )
})

test('Anthropic Messages tool arguments have a hard byte limit', async () => {
  const oversizedArguments = `{"value":"${'x'.repeat(256 * 1024)}"}`
  const wire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_agent_large"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_large","name":"large_tool","input":{}}}\n\n',
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: oversizedArguments } })}\n\n`
  ].join('')
  const client = new AnthropicMessagesClient({
    fetcher: (async () => responseFromSse(wire)) as typeof fetch
  })
  await assert.rejects(
    client.streamWithTools(credentials, {
      model: 'claude-native',
      messages: [{ role: 'user', content: 'Call the tool.' }],
      tools: [{ name: 'large_tool', input_schema: { type: 'object', properties: {} } }]
    }),
    (error: unknown) => error instanceof AnthropicMessagesClientError && error.code === 'response_too_large'
  )
})

test('Anthropic thinking signatures have a cumulative byte limit', async () => {
  const signatureChunk = 's'.repeat(140 * 1024)
  const wire = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_thinking_large"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"bounded"}}\n\n',
    'event: content_block_delta\n',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: signatureChunk }
    })}\n\n`,
    'event: content_block_delta\n',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: signatureChunk }
    })}\n\n`
  ].join('')
  const client = new AnthropicMessagesClient({
    fetcher: (async () => responseFromSse(wire)) as typeof fetch
  })

  await assert.rejects(
    client.streamWithTools(credentials, {
      model: 'claude-native',
      messages: [{ role: 'user', content: 'Use a tool.' }],
      tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }]
    }),
    (error: unknown) => error instanceof AnthropicMessagesClientError && error.code === 'response_too_large'
  )
})

test('Gemini GenerateContent uses native v1beta SSE and maps text/images/files', async () => {
  const wire = [
    'data: {"responseId":"gem_native_1","candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":" Gemini"}]}}]}\n\n'
  ].join('')
  const { fetcher, calls } = chunkedFetcher(responseFromSse(wire), [2, 1, 7, 4])
  const events: GeminiContentStreamEvent[] = []
  const client = new GeminiContentClient({ fetcher })
  const result = await client.stream(credentials, {
    model: 'gemini-2.5-pro',
    instructions: 'Answer briefly',
    messages: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'describe this' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAAAAAAAAAAAAAAAAAAAA==' },
        { type: 'input_file', filename: 'attachment-1.pdf', file_data: 'data:application/pdf;base64,AAAAAAAAAAAAAAAAAAAAAA==' }
      ]
    }]
  }, {
    signal: new AbortController().signal,
    onEvent: (event) => { events.push(event) }
  })
  assert.deepEqual(result, { responseId: 'gem_native_1', outputText: 'hello Gemini' })
  assert.deepEqual(events, [
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.output_text.delta', delta: ' Gemini' }
  ])
  assert.equal(calls[0]?.url, 'https://relay.example.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Answer briefly' }] })
  const parts = ((body.contents as Array<Record<string, unknown>>)[0]?.parts) as unknown[]
  assert.deepEqual(parts, [
    { text: 'describe this' },
    { inlineData: { mimeType: 'image/jpeg', data: 'AAAAAAAAAAAAAAAAAAAAAA==' } },
    { inlineData: { mimeType: 'application/pdf', data: 'AAAAAAAAAAAAAAAAAAAAAA==' } }
  ])
  assert.equal(new URL(calls[0]?.url ?? '').searchParams.has('key'), false)
})

test('Gemini emits level or budget thinkingConfig only from explicit protocol metadata', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new GeminiContentClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return responseFromSse(
        'data: {"responseId":"gem_reasoning","candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'
      )
    }) as typeof fetch
  })

  await client.stream(credentials, {
    model: 'gemini-level',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'medium',
    reasoningProtocol: {
      type: 'gemini-level',
      includeThoughts: false
    }
  })
  await client.stream(credentials, {
    model: 'gemini-budget',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'high',
    reasoningProtocol: {
      type: 'gemini-budget',
      budgets: { high: 4_096 }
    }
  })
  await client.stream(credentials, {
    model: 'gemini-undeclared',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'high'
  })

  const generationConfigs = bodies.map((body) =>
    body.generationConfig as Record<string, unknown> | undefined
  )
  assert.deepEqual(generationConfigs[0]?.thinkingConfig, {
    thinkingLevel: 'MEDIUM',
    includeThoughts: false
  })
  assert.deepEqual(generationConfigs[1]?.thinkingConfig, {
    thinkingBudget: 4_096
  })
  assert.equal(generationConfigs[2], undefined)
})

test('Gemini rejects an effort its level protocol cannot represent before fetch', async () => {
  const client = new GeminiContentClient({
    fetcher: (async () => {
      throw new Error('fetch must not run')
    }) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, {
      model: 'gemini-level',
      messages: [{ role: 'user', content: 'reason' }],
      reasoning: 'ultra',
      reasoningProtocol: { type: 'gemini-level' }
    }),
    (error: unknown) =>
      error instanceof GeminiContentClientError && error.code === 'invalid_input'
  )
})

test('Gemini rejects an unrepresentable level effort for tool streaming before fetch', async () => {
  const client = new GeminiContentClient({
    fetcher: (async () => {
      throw new Error('fetch must not run')
    }) as typeof fetch
  })

  await assert.rejects(
    client.streamWithTools(credentials, {
      model: 'gemini-level',
      messages: [{ role: 'user', content: 'Use a tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          parameters: { type: 'object', properties: {} }
        }
      }],
      reasoning: 'ultra',
      reasoningProtocol: { type: 'gemini-level' }
    }),
    (error: unknown) =>
      error instanceof GeminiContentClientError && error.code === 'invalid_input'
  )
})

test('Gemini sends a declared Ultra budget as a numeric thinking budget', async () => {
  let body: Record<string, unknown> | undefined
  const client = new GeminiContentClient({
    fetcher: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return responseFromSse(
        'data: {"responseId":"gem_ultra_budget","candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'
      )
    }) as typeof fetch
  })

  await client.stream(credentials, {
    model: 'gemini-budget',
    messages: [{ role: 'user', content: 'reason' }],
    reasoning: 'ultra',
    reasoningProtocol: {
      type: 'gemini-budget',
      budgets: { ultra: 8_192 },
      includeThoughts: false
    }
  })

  const generationConfig = body?.generationConfig as Record<string, unknown> | undefined
  assert.deepEqual(generationConfig?.thinkingConfig, {
    thinkingBudget: 8_192,
    includeThoughts: false
  })
})

test('Gemini accepts a relay path template and maps HTTP failures to safe codes', async () => {
  const calls: string[] = []
  const client = new GeminiContentClient({
    path: '/custom/models/{model}:streamGenerateContent?alt=sse',
    fetcher: (async (url) => {
      calls.push(String(url))
      return new Response(null, { status: 405 })
    }) as typeof fetch
  })
  await assert.rejects(
    client.stream(credentials, { model: 'gemini-custom', messages: [{ role: 'user', content: 'x' }] }),
    (error: unknown) => error instanceof GeminiContentClientError &&
      error.code === 'remote_rejected' && error.remoteFailure === 'gemini_generate_content_unsupported'
  )
  assert.equal(calls[0], 'https://relay.example.test/v1/custom/models/gemini-custom:streamGenerateContent?alt=sse')
})

test('native adapters reject non-loopback HTTP, query credentials, and oversized output', async () => {
  await assert.rejects(
    new AnthropicMessagesClient().stream(
      { baseUrl: 'http://remote.example/v1', apiKey: 'key' },
      { model: 'claude', messages: [{ role: 'user', content: 'x' }] }
    ),
    AnthropicMessagesClientError
  )
  await assert.rejects(
    new GeminiContentClient().stream(
      { baseUrl: 'https://relay.example/v1?token=not-allowed', apiKey: 'key' },
      { model: 'gemini', messages: [{ role: 'user', content: 'x' }] }
    ),
    GeminiContentClientError
  )
})
