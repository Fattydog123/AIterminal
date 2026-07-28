import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChatCompletionsRequestUrl,
  ChatCompletionsClientError,
  OpenAICompatibleChatCompletionsClient
} from '../../src/main/services/chat-completions-client.ts'

const CREDENTIALS = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-chat-completions-test-only'
}

function sse(...events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })
}

test('streams OpenAI-compatible Chat Completions from the fixed endpoint', async () => {
  let observedUrl = ''
  let observedInit: RequestInit | undefined
  const events: string[] = []
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (input, init) => {
      observedUrl = String(input)
      observedInit = init
      return sse(
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
        }),
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }]
        }),
        JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }]
        }),
        '[DONE]'
      )
    }) as typeof fetch
  })

  const result = await client.stream(CREDENTIALS, {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'Say hello.' }],
    reasoning: 'high'
  }, {
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.delta)
  })

  assert.equal(observedUrl, 'https://example.test/v1/chat/completions')
  assert.equal(observedInit?.method, 'POST')
  assert.equal(observedInit?.redirect, 'manual')
  assert.equal(new Headers(observedInit?.headers).get('authorization'), `Bearer ${CREDENTIALS.apiKey}`)
  assert.deepEqual(JSON.parse(String(observedInit?.body)), {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'Say hello.' }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'high'
  })
  assert.deepEqual(events, ['Hello ', 'world'])
  assert.deepEqual(result, { responseId: 'chatcmpl_test', outputText: 'Hello world' })
})

test('maps display reasoning levels to bounded Chat Completions effort values', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sse(
        JSON.stringify({
          id: 'chatcmpl_reasoning',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]
        }),
        '[DONE]'
      )
    }) as typeof fetch
  })

  for (const reasoning of ['none', 'minimal', 'light', 'xhigh', 'max', 'ultra'] as const) {
    await client.stream(CREDENTIALS, {
      model: 'reasoning-model',
      messages: [{ role: 'user', content: 'reason' }],
      reasoning
    })
  }

  assert.deepEqual(
    bodies.map((body) => body.reasoning_effort),
    ['none', 'minimal', 'low', 'xhigh', 'max', 'max']
  )
})

test('maps Ultra to max for Chat Completions tool requests', async () => {
  let body: Record<string, unknown> | undefined
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse(
        JSON.stringify({
          id: 'chatcmpl_tool_ultra',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]
        }),
        '[DONE]'
      )
    }) as typeof fetch
  })

  await client.streamWithTools(CREDENTIALS, {
    model: 'reasoning-model',
    messages: [{ role: 'user', content: 'Use a tool if needed.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        parameters: { type: 'object', properties: {} }
      }
    }],
    reasoning: 'ultra'
  })

  assert.equal(body?.reasoning_effort, 'max')
})

test('uses a safe request endpointPath without duplicating v1 and rejects hostile paths', async () => {
  const endpointPath = '/v1/relay/chat/completions'
  const expectedUrl = 'https://example.test/v1/relay/chat/completions'
  assert.equal(buildChatCompletionsRequestUrl(CREDENTIALS.baseUrl, endpointPath), expectedUrl)

  let observedUrl = ''
  let calls = 0
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (input) => {
      calls += 1
      observedUrl = String(input)
      return sse('[DONE]')
    }) as typeof fetch
  })
  await client.stream(CREDENTIALS, {
    model: 'chat-model',
    messages: [{ role: 'user', content: 'test' }],
    endpointPath
  })
  assert.equal(observedUrl, expectedUrl)

  for (const path of [
    'https://other.example/v1/chat/completions',
    '//other.example/v1/chat/completions',
    '/../chat/completions',
    '/%2e%2e/chat/completions',
    '/v1/chat/completions#fragment',
    '/v1/chat/completions?token=not-allowed',
    '/v1/sk-credentialvalue/chat/completions'
  ]) {
    assert.throws(
      () => buildChatCompletionsRequestUrl(CREDENTIALS.baseUrl, path),
      (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'invalid_endpoint'
    )
  }
  await assert.rejects(
    client.stream(CREDENTIALS, {
      model: 'chat-model',
      messages: [{ role: 'user', content: 'test' }],
      endpointPath: '/../chat/completions'
    }),
    (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'invalid_endpoint'
  )
  assert.equal(calls, 1)
})

test('maps image content and rejects file content instead of dropping it', async () => {
  let body: unknown
  const image = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return sse('[DONE]')
    }) as typeof fetch
  })

  await client.stream(CREDENTIALS, {
    model: 'vision-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this image.' },
        { type: 'input_image', image_url: image, detail: 'high' }
      ]
    }]
  })
  assert.deepEqual((body as { messages: unknown[] }).messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Inspect this image.' },
      { type: 'image_url', image_url: { url: image, detail: 'high' } }
    ]
  }])

  await assert.rejects(
    client.stream(CREDENTIALS, {
      model: 'chat-model',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read this file.' },
          { type: 'input_file', filename: 'attachment-1.txt', file_data: 'data:text/plain;base64,dGVzdA==' }
        ]
      }]
    }),
    (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'invalid_input'
  )
})

test('fails closed on redirects, non-SSE responses, tool calls, and missing DONE', async () => {
  const cases: Array<{ response: Response; code: ChatCompletionsClientError['code'] }> = [
    { response: new Response(null, { status: 302, headers: { location: 'https://other.test/' } }), code: 'redirect_rejected' },
    { response: new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), code: 'remote_rejected' },
    {
      response: sse(JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'tool_calls' }]
      }), '[DONE]'),
      code: 'invalid_response'
    },
    {
      response: sse(JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }]
      })),
      code: 'invalid_response'
    }
  ]

  for (const item of cases) {
    const client = new OpenAICompatibleChatCompletionsClient({
      fetcher: (async () => item.response) as typeof fetch
    })
    await assert.rejects(
      client.stream(CREDENTIALS, {
        model: 'chat-model',
        messages: [{ role: 'user', content: 'test' }]
      }),
      (error: unknown) => error instanceof ChatCompletionsClientError && error.code === item.code
    )
  }
})

test('never preserves credentials or raw fetch failures in public errors', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => {
      throw new Error(`upstream exposed ${CREDENTIALS.apiKey} C:\\private\\path`)
    }) as typeof fetch
  })

  await assert.rejects(
    client.stream(CREDENTIALS, {
      model: 'chat-model',
      messages: [{ role: 'user', content: 'test' }]
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChatCompletionsClientError)
      assert.equal(error.code, 'network_error')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /sk-chat|private|example\.test/u)
      return true
    }
  )
})

test('a real AbortSignal cancels an active Agent Chat Completions request', async () => {
  let fetchCalls = 0
  let forwardedSignal: AbortSignal | null = null
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1
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

  const pending = client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Wait for cancellation.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        parameters: { type: 'object', properties: {} }
      }
    }]
  }, { signal: controller.signal })
  controller.abort()

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'cancelled'
  )
  assert.equal(fetchCalls, 1)
  assert.equal(forwardedSignal?.aborted, true)
})

test('serializes mixed assistant text and write_file calls across rounds without mutating caller history', async () => {
  const observedBodies: unknown[] = []
  let fetchCalls = 0
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (_input, init) => {
      fetchCalls += 1
      observedBodies.push(JSON.parse(String(init?.body)))
      if (fetchCalls === 1) {
        return sse(
          JSON.stringify({
            id: 'chatcmpl_write_round_1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
          }),
          JSON.stringify({
            id: 'chatcmpl_write_round_1',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: { content: 'The workspace is empty. I will create a calculator.' },
              finish_reason: null
            }]
          }),
          JSON.stringify({
            id: 'chatcmpl_write_round_1',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_write_1',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":"index.html",'
                  }
                }]
              },
              finish_reason: null
            }]
          }),
          JSON.stringify({
            id: 'chatcmpl_write_round_1',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: '"content":"<button>=</button>"}' }
                }]
              },
              finish_reason: null
            }]
          }),
          JSON.stringify({
            id: 'chatcmpl_write_round_1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          }),
          '[DONE]'
        )
      }
      return sse(
        JSON.stringify({
          id: 'chatcmpl_write_round_2',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
        delta: { content: 'The calculator is ready.' },
            finish_reason: 'stop'
          }]
        }),
        '[DONE]'
      )
    }) as typeof fetch
  })

  const instructions = 'Only call tools inside the authorized workspace.'
  const initialMessages = [
    { role: 'system' as const, content: instructions },
    { role: 'user' as const, content: 'Create a calculator.' }
  ]
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 file inside the selected workspace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  }]
  const initialMessagesBefore = structuredClone(initialMessages)
  const toolsBefore = structuredClone(tools)

  const first = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: initialMessages,
    tools
  })
  assert.equal(first.outputText, 'The workspace is empty. I will create a calculator.')
  assert.deepEqual(first.toolCalls, [{
    id: 'call_write_1',
    type: 'function',
    function: {
      name: 'write_file',
      arguments: '{"path":"index.html","content":"<button>=</button>"}'
    }
  }])

  const continuationMessages = [
    ...initialMessages,
    {
      role: 'assistant' as const,
      content: first.outputText,
      tool_calls: first.toolCalls
    },
    {
      role: 'tool' as const,
      tool_call_id: first.toolCalls[0]!.id,
      content: '{"ok":true}'
    }
  ]
  const continuationMessagesBefore = structuredClone(continuationMessages)
  const second = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: continuationMessages,
    tools
  })

  const expectedTools = structuredClone(tools)
  assert.deepEqual(observedBodies, [
    {
      model: 'agent-model',
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: 'Create a calculator.' }
      ],
      tools: expectedTools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true }
    },
    {
      model: 'agent-model',
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: 'Create a calculator.' },
        {
          role: 'assistant',
          content: 'The workspace is empty. I will create a calculator.',
          tool_calls: [{
            id: 'call_write_1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: '{"path":"index.html","content":"<button>=</button>"}'
            }
          }]
        },
        { role: 'tool', tool_call_id: 'call_write_1', content: '{"ok":true}' }
      ],
      tools: expectedTools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true }
    }
  ])
  assert.deepEqual(initialMessages, initialMessagesBefore)
  assert.deepEqual(continuationMessages, continuationMessagesBefore)
  assert.deepEqual(tools, toolsBefore)
  assert.deepEqual(second, {
    responseId: 'chatcmpl_write_round_2',
    outputText: 'The calculator is ready.',
    toolCalls: [],
    hasToolCalls: false
  })
})

test('prepends instructions from a copy instead of mutating caller history', async () => {
  let observedBody: unknown
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async (_input, init) => {
      observedBody = JSON.parse(String(init?.body))
      return sse('[DONE]')
    }) as typeof fetch
  })
  const messages = [{ role: 'user' as const, content: 'Inspect the workspace.' }]
  const messagesBefore = structuredClone(messages)

  await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages,
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }],
    instructions: 'Use only approved workspace tools.'
  })

  assert.deepEqual(observedBody, {
    model: 'agent-model',
    messages: [
      { role: 'system', content: 'Use only approved workspace tools.' },
      { role: 'user', content: 'Inspect the workspace.' }
    ],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
    stream_options: { include_usage: true }
  })
  assert.deepEqual(messages, messagesBefore)
})

test('rejects malformed continuation messages before contacting the endpoint', async () => {
  let fetchCalls = 0
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => {
      fetchCalls += 1
      return sse('[DONE]')
    }) as typeof fetch
  })
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'write_file',
      parameters: { type: 'object', properties: {} }
    }
  }]
  const malformedMessages: unknown[][] = [
    [{ role: 'tool', tool_call_id: '', content: '{"ok":true}' }],
    [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'write_file', arguments: 'not-json' }
      }]
    }],
    [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' }
      }],
      untrusted_extra_field: true
    }],
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: '{}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call_2', content: '{"ok":true}' }
    ]
  ]

  for (const messages of malformedMessages) {
    await assert.rejects(
      client.streamWithTools(CREDENTIALS, {
        model: 'agent-model',
        messages: messages as never,
        tools
      }),
      (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'invalid_input'
    )
  }
  assert.equal(fetchCalls, 0)
})

test('fails closed on malformed streamed tool metadata', async () => {
  const malformedResponses = [
    sse(JSON.stringify({
      choices: [{ index: 1, delta: { content: 'wrong choice' }, finish_reason: 'stop' }]
    }), '[DONE]'),
    sse(JSON.stringify({
      choices: [
        { index: 0, delta: { content: 'first' }, finish_reason: null },
        { index: 0, delta: { content: 'duplicate' }, finish_reason: 'stop' }
      ]
    }), '[DONE]'),
    sse(JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'unexpected_reason' }]
    }), '[DONE]'),
    ...[-1, 0.5, 32].map((index) => sse(JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: 'call_invalid_index',
            type: 'function',
            function: { name: 'write_file', arguments: '{}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }), '[DONE]')),
    sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_first',
                type: 'function',
                function: { name: 'write_file', arguments: '{}' }
              },
              {
                index: 1,
                id: 'call_second',
                type: 'function',
                function: { name: 'write_file', arguments: '{}' }
              }
            ]
          },
          finish_reason: null
        }]
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ function: { arguments: '' } }] },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    ),
    sse(JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'unsupported_tool_type',
            function: { name: 'write_file', arguments: '{}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }), '[DONE]'),
    sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'write_file', arguments: '{' }
            }]
          },
          finish_reason: null
        }]
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_changed',
              function: { arguments: '}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    ),
    sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_without_name',
              type: 'function',
              function: { arguments: '{}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    ),
    sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_without_name_or_arguments',
              type: 'function',
              function: {}
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    ),
    sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_conflicting_name',
              type: 'function',
              function: { name: 'write_file', arguments: '{' }
            }]
          },
          finish_reason: null
        }]
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'read_file', arguments: '}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    )
  ]
  const request = {
    model: 'agent-model',
    messages: [{ role: 'user' as const, content: 'Use a tool.' }],
    tools: [{
      type: 'function' as const,
      function: { name: 'write_file', parameters: { type: 'object', properties: {} } }
    }]
  }

  for (const response of malformedResponses) {
    const client = new OpenAICompatibleChatCompletionsClient({
      fetcher: (async () => response) as typeof fetch
    })
    await assert.rejects(
      client.streamWithTools(CREDENTIALS, request),
      (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'invalid_response'
    )
  }
})

test('retains only validated tool identity for malformed streamed arguments', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_malformed_args',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: '{"relative_path":"private.txt",'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    )) as typeof fetch
  })

  await assert.rejects(
    client.streamWithTools(CREDENTIALS, {
      model: 'agent-model',
      messages: [{ role: 'user', content: 'Use a tool.' }],
      tools: [{
        type: 'function',
        function: { name: 'write_file', parameters: { type: 'object', properties: {} } }
      }]
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChatCompletionsClientError)
      assert.equal(error.code, 'invalid_response')
      assert.deepEqual(error.recoverableToolCalls, [{
        id: 'call_malformed_args',
        name: 'write_file'
      }])
      assert.doesNotMatch(JSON.stringify(error), /private\.txt|relative_path/u)
      assert.doesNotMatch(String(error.stack), /private\.txt|relative_path/u)
      return true
    }
  )
})

test('accepts NewAPI tool argument chunks that arrive before the tool name', async () => {
  for (const firstFunction of [
    { arguments: '{"relative_path":"index.html","content":"ok"}' },
    { name: '', arguments: '{"relative_path":"index.html","content":"ok"}' }
  ]) {
    const client = new OpenAICompatibleChatCompletionsClient({
      fetcher: (async () => sse(
        JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_name_after_arguments',
                type: 'function',
                function: firstFunction
              }]
            },
            finish_reason: null
          }]
        }),
        JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_name_after_arguments',
                type: 'function',
                function: { name: 'write_file', arguments: '' }
              }]
            },
            finish_reason: null
          }]
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
        }),
        '[DONE]'
      )) as typeof fetch
    })

    const result = await client.streamWithTools(CREDENTIALS, {
      model: 'agent-model',
      messages: [{ role: 'user', content: 'Create the file.' }],
      tools: [{
        type: 'function',
        function: { name: 'write_file', parameters: { type: 'object', properties: {} } }
      }]
    })

    assert.deepEqual(result.toolCalls, [{
      id: 'call_name_after_arguments',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: '{"relative_path":"index.html","content":"ok"}'
      }
    }])
    assert.equal(result.hasToolCalls, true)
  }
})

test('ignores NewAPI empty tool names on later argument chunks', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_empty_later_name',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: '{"relative_path":"index.html",'
              }
            }]
          },
          finish_reason: null
        }]
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: '', arguments: '"content":"ok"}' }
            }]
          },
          finish_reason: null
        }]
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      }),
      '[DONE]'
    )) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Create the file.' }],
    tools: [{
      type: 'function',
      function: { name: 'write_file', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.deepEqual(result.toolCalls, [{
    id: 'call_empty_later_name',
    type: 'function',
    function: {
      name: 'write_file',
      arguments: '{"relative_path":"index.html","content":"ok"}'
    }
  }])
})

test('treats empty tool ids and names as continuation placeholders after a validated first chunk', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_empty_continuation_fields',
              type: 'function',
              function: { name: 'list_directory', arguments: '' }
            }]
          },
          finish_reason: ''
        }]
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: '',
              type: 'function',
              function: { name: '', arguments: '{"relativePath":"."}' }
            }]
          },
          finish_reason: ''
        }]
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }]
      }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
      }),
      '[DONE]'
    )) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'List the directory.' }],
    tools: [{
      type: 'function',
      function: { name: 'list_directory', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.deepEqual(result.toolCalls, [{
    id: 'call_empty_continuation_fields',
    type: 'function',
    function: { name: 'list_directory', arguments: '{"relativePath":"."}' }
  }])
})

test('accepts the xAI-documented end_turn finish reason', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(JSON.stringify({
      id: 'chatcmpl_end_turn',
      choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'end_turn' }]
    }), '[DONE]')) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Finish the turn.' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }]
  })
  assert.equal(result.outputText, 'Done.')
  assert.equal(result.hasToolCalls, false)
})

test('treats an empty interim finish reason as a non-terminal NewAPI placeholder', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: { role: 'assistant', reasoning_content: 'hidden' },
          finish_reason: ''
        }]
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }]
      }),
      '[DONE]'
    )) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Finish the turn.' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.equal(result.outputText, 'Done.')
  assert.equal(result.hasToolCalls, false)
})

test('accepts a single Chat Completions choice when its index is omitted', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(JSON.stringify({
      id: 'chatcmpl_choice_without_index',
      choices: [{ delta: { content: 'Ready.' }, finish_reason: 'stop' }]
    }), '[DONE]')) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Finish the turn.' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.equal(result.outputText, 'Ready.')
  assert.equal(result.hasToolCalls, false)
})

test('accepts omitted tool-call indexes only for one unambiguous streamed call', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              id: 'call_without_index',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":' }
            }]
          },
          finish_reason: null
        }]
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ function: { arguments: '"README.md"}' } }]
          },
          finish_reason: 'tool_calls'
        }]
      }),
      '[DONE]'
    )) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Read the file.' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.deepEqual(result.toolCalls, [{
    id: 'call_without_index',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' }
  }])
})

test('accepts EOF after a normal terminal finish reason without a DONE sentinel', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(JSON.stringify({
      id: 'chatcmpl_terminal_eof',
      choices: [{ index: 0, delta: { content: 'Complete.' }, finish_reason: 'stop' }]
    }))) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Finish the turn.' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.deepEqual(result, {
    responseId: 'chatcmpl_terminal_eof',
    outputText: 'Complete.',
    toolCalls: [],
    hasToolCalls: false
  })
})

test('accepts a usage-only chunk after the terminal choice', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }]
      }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
      }),
      '[DONE]'
    )) as typeof fetch
  })

  const result = await client.streamWithTools(CREDENTIALS, {
    model: 'agent-model',
    messages: [{ role: 'user', content: 'Finish the turn.' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
    }]
  })

  assert.equal(result.outputText, 'Done.')
})

test('rejects an empty choices chunk that is not a terminal usage chunk', async () => {
  const client = new OpenAICompatibleChatCompletionsClient({
    fetcher: (async () => sse(
      JSON.stringify({
        choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }]
      }),
      JSON.stringify({ choices: [] }),
      '[DONE]'
    )) as typeof fetch
  })

  await assert.rejects(
    client.streamWithTools(CREDENTIALS, {
      model: 'agent-model',
      messages: [{ role: 'user', content: 'Finish the turn.' }],
      tools: [{
        type: 'function',
        function: { name: 'read_file', parameters: { type: 'object', properties: {} } }
      }]
    }),
    (error: unknown) => error instanceof ChatCompletionsClientError && error.code === 'invalid_response'
  )
})
