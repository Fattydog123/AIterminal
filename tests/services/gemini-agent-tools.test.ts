import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GeminiContentClient,
  GeminiContentClientError,
  type GeminiContentStreamEvent,
  type GeminiContentToolCall
} from '../../src/main/services/gemini-content-client.ts'

const CREDENTIALS = {
  baseUrl: 'https://relay.example.test/v1',
  apiKey: 'test-gemini-key'
}

function sse(...events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })
}

const READ_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read one workspace file.',
    parameters: {
      type: 'object',
      properties: { relative_path: { type: 'string' } },
      required: ['relative_path'],
      additionalProperties: false
    }
  }
}

const SEARCH_FILES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_files',
    description: 'Search workspace files.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    }
  }
}

test('streamWithTools uses native Gemini declarations and replays functionCall/functionResponse history', async () => {
  const thoughtSignature = Buffer.from('test thought signature').toString('base64')
  let observedUrl = ''
  let observedInit: RequestInit | undefined
  const events: GeminiContentStreamEvent[] = []
  const client = new GeminiContentClient({
    fetcher: (async (input, init) => {
      observedUrl = String(input)
      observedInit = init
      return sse(
        JSON.stringify({
          responseId: 'gemini_agent_1',
          candidates: [{
            index: 0,
            content: { role: 'model', parts: [{ text: 'I will search. ' }] }
          }]
        }),
        JSON.stringify({
          responseId: 'gemini_agent_1',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  id: 'call_search_2',
                  name: 'search_files',
                  args: { z: 2, nested: { z: 2, a: 1 }, a: 1 }
                },
                thoughtSignature
              }]
            }
          }]
        })
      )
    }) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'server-confirmed-gemini-route',
    endpointPath: '/v1beta/models/{model}:generateContent',
    instructions: 'Use workspace tools only when needed.',
    messages: [
      { role: 'user', content: 'Read package metadata.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_read_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"relative_path":"package.json"}'
          },
          thoughtSignature
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        name: 'read_file',
        content: '{"name":"ai-terminal-electron"}'
      },
      { role: 'assistant', content: 'The package metadata was read.' },
      { role: 'user', content: 'Find its tests.' }
    ],
    tools: [READ_FILE_TOOL, SEARCH_FILES_TOOL],
    temperature: 0.2,
    topP: 0.9,
    topK: 20,
    maxOutputTokens: 2048
  }, {
    onEvent: (event) => events.push(event)
  })

  assert.equal(
    observedUrl,
    'https://relay.example.test/v1beta/models/server-confirmed-gemini-route:streamGenerateContent?alt=sse'
  )
  assert.equal(observedInit?.method, 'POST')
  assert.equal(observedInit?.redirect, 'manual')
  assert.equal(new Headers(observedInit?.headers).get('authorization'), `Bearer ${CREDENTIALS.apiKey}`)
  assert.equal(new Headers(observedInit?.headers).get('x-goog-api-key'), CREDENTIALS.apiKey)
  assert.deepEqual(JSON.parse(String(observedInit?.body)), {
    contents: [
      { role: 'user', parts: [{ text: 'Read package metadata.' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_read_1',
            name: 'read_file',
            args: { relative_path: 'package.json' }
          },
          thoughtSignature
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_read_1',
            name: 'read_file',
            response: { output: '{"name":"ai-terminal-electron"}' }
          }
        }]
      },
      { role: 'model', parts: [{ text: 'The package metadata was read.' }] },
      { role: 'user', parts: [{ text: 'Find its tests.' }] }
    ],
    systemInstruction: { parts: [{ text: 'Use workspace tools only when needed.' }] },
    tools: [{
      functionDeclarations: [
        {
          name: 'read_file',
          description: 'Read one workspace file.',
          parameters: {
            type: 'object',
            properties: { relative_path: { type: 'string' } },
            required: ['relative_path']
          }
        },
        {
          name: 'search_files',
          description: 'Search workspace files.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }
      ]
    }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      maxOutputTokens: 2048
    }
  })
  assert.deepEqual(events, [{ type: 'response.output_text.delta', delta: 'I will search. ' }])
  assert.deepEqual(result, {
    responseId: 'gemini_agent_1',
    outputText: 'I will search. ',
    toolCalls: [{
      id: 'call_search_2',
      type: 'function',
      function: {
        name: 'search_files',
        arguments: '{"a":1,"nested":{"a":1,"z":2},"z":2}'
      },
      thoughtSignature
    }],
    hasToolCalls: true
  })
})

test('Gemini native requests carry both relay bearer and Google API-key headers', async () => {
  let observedHeaders: Headers | undefined
  const client = new GeminiContentClient({
    fetcher: (async (_input, init) => {
      observedHeaders = new Headers(init?.headers)
      return sse(JSON.stringify({
        responseId: 'gemini_auth_headers',
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }]
      }))
    }) as typeof fetch
  })

  await client.stream(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [{ role: 'user', content: 'Reply.' }]
  })

  assert.equal(observedHeaders?.get('authorization'), `Bearer ${CREDENTIALS.apiKey}`)
  assert.equal(observedHeaders?.get('x-goog-api-key'), CREDENTIALS.apiKey)
})

test('Gemini replays independent thought parts and their signatures across a tool continuation', async () => {
  const thoughtSignature = Buffer.from('independent thought signature').toString('base64')
  let requestCount = 0
  let continuationBody: Record<string, unknown> | undefined
  const client = new GeminiContentClient({
    fetcher: (async (_input, init) => {
      requestCount += 1
      if (requestCount === 1) {
        return sse(JSON.stringify({
          responseId: 'gemini_thought_tool',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                {
                  thought: true,
                  text: 'private planning text',
                  thoughtSignature
                },
                {
                  functionCall: {
                    id: 'call_read_thought',
                    name: 'read_file',
                    args: { relative_path: 'README.md' }
                  },
                  thoughtSignature
                }
              ]
            }
          }]
        }))
      }
      continuationBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse(JSON.stringify({
        responseId: 'gemini_thought_tool',
        candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }]
      }))
    }) as typeof fetch
  })

  const first = await client.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [{ role: 'user', content: 'Read README.' }],
    tools: [READ_FILE_TOOL]
  })
  assert.deepEqual(first.assistantContent, [
    { type: 'thought', text: 'private planning text', thoughtSignature },
    {
      type: 'function_call',
      toolCall: {
        id: 'call_read_thought',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"relative_path":"README.md"}'
        },
        thoughtSignature
      }
    }
  ])

  await client.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [
      { role: 'user', content: 'Read README.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: first.toolCalls,
        assistantContent: first.assistantContent
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_thought',
        name: 'read_file',
        content: 'README contents'
      }
    ],
    tools: [READ_FILE_TOOL]
  })

  const contents = continuationBody?.contents as Array<Record<string, unknown>>
  assert.deepEqual(contents[1], {
    role: 'model',
    parts: [
      { thought: true, text: 'private planning text', thoughtSignature },
      {
        functionCall: {
          id: 'call_read_thought',
          name: 'read_file',
          args: { relative_path: 'README.md' }
        },
        thoughtSignature
      }
    ]
  })
  assert.deepEqual(contents[2], {
    role: 'user',
    parts: [{
      functionResponse: {
        id: 'call_read_thought',
        name: 'read_file',
        response: { output: 'README contents' }
      }
    }]
  })
})

test('streamWithTools completes a plain native text response without a functionCall', async () => {
  const client = new GeminiContentClient({
    fetcher: (async () => sse(
      JSON.stringify({
        responseId: 'gemini_text_1',
        candidates: [{ content: { role: 'model', parts: [{ text: 'Online text' }] } }]
      }),
      '[DONE]'
    )) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [{ role: 'user', content: 'Reply with text.' }],
    tools: [READ_FILE_TOOL]
  })

  assert.deepEqual(result, {
    responseId: 'gemini_text_1',
    outputText: 'Online text',
    toolCalls: [],
    hasToolCalls: false
  })
})

test('a functionCall without an upstream id receives a safe replayable id', async () => {
  let calls = 0
  let replayBody: unknown
  const client = new GeminiContentClient({
    fetcher: (async (_input, init) => {
      calls += 1
      if (calls === 1) {
        return sse(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: {} } }] } }]
        }))
      }
      replayBody = JSON.parse(String(init?.body))
      return sse(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Done' }] } }]
      }))
    }) as typeof fetch
  })

  const first = await client.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [{ role: 'user', content: 'Read a file.' }],
    tools: [READ_FILE_TOOL]
  })
  assert.match(first.toolCalls[0]?.id ?? '', /^gemini_call_[A-Za-z0-9_-]{24}$/u)

  const returnedCall = first.toolCalls[0] as GeminiContentToolCall
  await client.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [
      { role: 'user', content: 'Read a file.' },
      { role: 'assistant', content: '', tool_calls: [returnedCall] },
      {
        role: 'tool',
        tool_call_id: returnedCall.id,
        name: returnedCall.function.name,
        content: 'result'
      }
    ],
    tools: [READ_FILE_TOOL]
  })

  const replayContents = (replayBody as { contents: Array<{ parts: unknown[] }> }).contents
  assert.deepEqual(replayContents[1], {
    role: 'model',
    parts: [{
      functionCall: { name: 'read_file', args: {} }
    }]
  })
  assert.deepEqual(replayContents[2], {
    role: 'user',
    parts: [{
      functionResponse: {
        name: 'read_file',
        response: { output: 'result' }
      }
    }]
  })
})

test('tool history and schemas fail closed before any request when unsafe or mismatched', async () => {
  let fetchCalls = 0
  const client = new GeminiContentClient({
    fetcher: (async () => {
      fetchCalls += 1
      return sse('[DONE]')
    }) as typeof fetch
  })

  const mismatchedHistory = client.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [
      { role: 'user', content: 'Read.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'search_files', content: 'wrong tool' }
    ],
    tools: [READ_FILE_TOOL, SEARCH_FILES_TOOL]
  })
  await assert.rejects(
    mismatchedHistory,
    (error: unknown) => error instanceof GeminiContentClientError && error.code === 'invalid_input'
  )

  const hostileParameters = JSON.parse('{"type":"object","__proto__":{"polluted":true}}') as Record<string, unknown>
  await assert.rejects(
    client.streamWithTools(CREDENTIALS, {
      model: 'confirmed-route-model',
      messages: [{ role: 'user', content: 'Test.' }],
      tools: [{
        type: 'function',
        function: { name: 'read_file', parameters: hostileParameters }
      }]
    }),
    (error: unknown) => error instanceof GeminiContentClientError && error.code === 'invalid_input'
  )
  assert.equal(fetchCalls, 0)
})

test('undeclared and oversized remote functionCall arguments are rejected with bounded errors', async () => {
  const cases: Array<{ functionCall: unknown; code: GeminiContentClientError['code'] }> = [
    {
      functionCall: { id: 'call_unknown', name: 'not_declared', args: {} },
      code: 'invalid_response'
    },
    {
      functionCall: { id: 'call_large', name: 'read_file', args: { value: 'x'.repeat(256 * 1024) } },
      code: 'response_too_large'
    }
  ]

  for (const item of cases) {
    const client = new GeminiContentClient({
      fetcher: (async () => sse(JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: item.functionCall }] } }]
      }))) as typeof fetch
    })
    await assert.rejects(
      client.streamWithTools(CREDENTIALS, {
        model: 'confirmed-route-model',
        messages: [{ role: 'user', content: 'Use a tool.' }],
        tools: [READ_FILE_TOOL]
      }),
      (error: unknown) => error instanceof GeminiContentClientError && error.code === item.code
    )
  }
})

test('streamWithTools forwards cancellation and never preserves raw upstream failures', async () => {
  let forwardedSignal: AbortSignal | null = null
  const cancellingClient = new GeminiContentClient({
    fetcher: ((_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? null
      return new Promise<Response>((_resolve, reject) => {
        forwardedSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        )
      })
    }) as typeof fetch
  })
  const controller = new AbortController()
  const pending = cancellingClient.streamWithTools(CREDENTIALS, {
    model: 'confirmed-route-model',
    messages: [{ role: 'user', content: 'Wait.' }],
    tools: [READ_FILE_TOOL]
  }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof GeminiContentClientError && error.code === 'cancelled'
  )
  assert.equal(forwardedSignal?.aborted, true)

  const failingClient = new GeminiContentClient({
    fetcher: (async () => {
      throw new Error(`upstream exposed ${CREDENTIALS.apiKey} C:\\private\\workspace`)
    }) as typeof fetch
  })
  await assert.rejects(
    failingClient.streamWithTools(CREDENTIALS, {
      model: 'confirmed-route-model',
      messages: [{ role: 'user', content: 'Test.' }],
      tools: [READ_FILE_TOOL]
    }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiContentClientError)
      assert.equal(error.code, 'network_error')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /test-gemini|private|example\.test/u)
      return true
    }
  )
})
