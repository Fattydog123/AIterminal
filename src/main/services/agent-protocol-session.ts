import type {
  ModelAgentEndpointType,
  ModelReasoningProtocol,
  ModelWireMode,
  ReasoningEffort
} from '../../shared/contracts.ts'
import {
  AnthropicMessagesClient,
  AnthropicMessagesClientError,
  type AnthropicMessagesAgentMessage,
  type AnthropicMessagesToolDefinition,
  type AnthropicMessagesToolResultContentBlock
} from './anthropic-messages-client.ts'
import {
  ChatCompletionsClientError,
  OpenAICompatibleChatCompletionsClient,
  type ChatCompletionsAssistantWithToolsMessage,
  type ChatCompletionsRecoverableToolCall,
  type ChatCompletionsToolCall,
  type ChatCompletionsToolDefinition,
  type ChatCompletionsToolResultMessage
} from './chat-completions-client.ts'
import {
  GeminiContentClient,
  GeminiContentClientError,
  type GeminiContentAssistantWithToolsMessage,
  type GeminiContentMessage,
  type GeminiContentToolDefinition,
  type GeminiContentToolResultMessage
} from './gemini-content-client.ts'
import {
  generateResponsesPromptCacheKey,
  OpenAICompatibleResponsesClient,
  ResponsesClientError,
  type ResponsesContinuationCapsule,
  type ResponsesCredentials,
  type ResponsesFunctionCallOutputInput,
  type ResponsesFunctionToolCall,
  type ResponsesFunctionToolDefinition,
  type ResponsesGeneratedImage,
  type ResponsesInputItem,
  type ResponsesJsonObject,
  type ResponsesMessage
} from './responses-client.ts'
import { reasoningProtocolForEndpoint } from './reasoning-protocol.ts'

/** Server-declared endpoint types with a native Agent tool loop. */
export type AgentProtocolEndpointType = ModelAgentEndpointType

export interface AgentProtocolEndpointCandidate {
  readonly endpointType: AgentProtocolEndpointType
  readonly endpointPath?: string
  readonly reasoningProtocol?: ModelReasoningProtocol
}

export interface AgentProtocolSessionClients {
  readonly responses: Pick<OpenAICompatibleResponsesClient, 'stream'>
  readonly chatCompletions: Pick<OpenAICompatibleChatCompletionsClient, 'streamWithTools'>
  readonly anthropic: Pick<AnthropicMessagesClient, 'streamWithTools'>
  readonly gemini: Pick<GeminiContentClient, 'streamWithTools'>
}

/**
 * Static, Main-process-only facts for one provider conversation. The caller
 * selects the tools and instructions from the already admitted Agent turn;
 * the session hides each provider's continuation representation.
 */
export interface AgentProtocolSessionInput {
  readonly endpointType: AgentProtocolEndpointType
  readonly credentials: ResponsesCredentials
  readonly model: string
  readonly endpointPath?: string
  readonly wireMode: ModelWireMode
  readonly reasoning: ReasoningEffort
  readonly reasoningProtocol?: ModelReasoningProtocol
  readonly webSearch: boolean
  readonly imageGeneration: boolean
  readonly instructions: string
  readonly tools: readonly ResponsesFunctionToolDefinition[]
  readonly initialModelInput: readonly ResponsesInputItem[]
  readonly onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void
}

export interface AgentProtocolToolOutput {
  readonly toolCall: ResponsesFunctionToolCall
  readonly output: string
}

export interface AgentProtocolRound {
  readonly toolCalls: readonly ResponsesFunctionToolCall[]
  readonly generatedImages?: readonly ResponsesGeneratedImage[]
}

/**
 * The protocol seam used by the Agent turn runtime. A caller only advances a
 * round and supplies verified tool outputs; Responses capsules and native
 * provider message histories remain implementation details here.
 */
export interface AgentProtocolSession {
  readonly endpointType: AgentProtocolEndpointType
  next(signal: AbortSignal, onDelta: (delta: string) => void): Promise<AgentProtocolRound>
  acceptToolOutputs(outputs: readonly AgentProtocolToolOutput[]): void
  isCancellation(error: unknown): boolean
}

export interface CreateAgentProtocolSessionOptions {
  readonly clients: AgentProtocolSessionClients
  readonly input: AgentProtocolSessionInput
  /** Keeps malformed provider tool data on the Agent runtime's fixed error path. */
  readonly invalidToolCall: () => Error
}

export interface CreateDeclaredAgentProtocolSessionOptions {
  readonly clients: AgentProtocolSessionClients
  readonly input: Omit<AgentProtocolSessionInput, 'endpointType' | 'endpointPath'>
  readonly candidates: readonly AgentProtocolEndpointCandidate[]
  /** Keeps malformed provider tool data on the Agent runtime's fixed error path. */
  readonly invalidToolCall: () => Error
}

export function createAgentProtocolSession(
  options: CreateAgentProtocolSessionOptions
): AgentProtocolSession {
  switch (options.input.endpointType) {
    case 'openai-response':
      return new ResponsesProtocolSession(options.clients.responses, options.input, options.invalidToolCall)
    case 'openai':
      return new ChatCompletionsProtocolSession(
        options.clients.chatCompletions,
        options.input,
        options.invalidToolCall
      )
    case 'anthropic':
      return new AnthropicProtocolSession(options.clients.anthropic, options.input, options.invalidToolCall)
    case 'gemini':
      return new GeminiProtocolSession(options.clients.gemini, options.input, options.invalidToolCall)
  }
}

/**
 * Tries only server-declared Agent endpoints, in declaration order. Switching
 * is permitted only before a provider has returned a tool call. Failed
 * first-round text is buffered and discarded so protocols can never mix one
 * assistant message.
 */
export function createDeclaredAgentProtocolSession(
  options: CreateDeclaredAgentProtocolSessionOptions
): AgentProtocolSession {
  if (options.candidates.length < 1 || options.candidates.length > 4) {
    throw options.invalidToolCall()
  }
  const seen = new Set<AgentProtocolEndpointType>()
  const { reasoningProtocol: turnReasoningProtocol, ...sharedInput } = options.input
  const sessions = options.candidates.map((candidate) => {
    if (seen.has(candidate.endpointType)) throw options.invalidToolCall()
    seen.add(candidate.endpointType)
    const candidateReasoningProtocol = candidate.reasoningProtocol ?? reasoningProtocolForEndpoint(
      turnReasoningProtocol,
      candidate.endpointType
    )
    return createAgentProtocolSession({
      clients: options.clients,
      input: {
        ...sharedInput,
        endpointType: candidate.endpointType,
        ...(candidate.endpointPath === undefined ? {} : { endpointPath: candidate.endpointPath }),
        ...(candidateReasoningProtocol === undefined
          ? {}
          : { reasoningProtocol: candidateReasoningProtocol })
      },
      invalidToolCall: options.invalidToolCall
    })
  })
  return sessions.length === 1
    ? sessions[0]!
    : new DeclaredEndpointProtocolSession(sessions)
}

class DeclaredEndpointProtocolSession implements AgentProtocolSession {
  readonly #sessions: readonly AgentProtocolSession[]
  #index = 0
  #locked = false

  constructor(sessions: readonly AgentProtocolSession[]) {
    this.#sessions = sessions
  }

  get endpointType(): AgentProtocolEndpointType {
    return this.#active.endpointType
  }

  async next(
    signal: AbortSignal,
    onDelta: (delta: string) => void
  ): Promise<AgentProtocolRound> {
    while (true) {
      const bufferedDeltas: string[] = []
      try {
        const result = await this.#active.next(signal, (delta) => bufferedDeltas.push(delta))
        if (result.toolCalls.length > 0) this.#locked = true
        for (const delta of bufferedDeltas) onDelta(delta)
        return result
      } catch (error) {
        if (
          this.#locked ||
          this.#active.isCancellation(error) ||
          !isNegotiableProtocolFailure(error) ||
          this.#index + 1 >= this.#sessions.length
        ) throw error
        this.#index += 1
      }
    }
  }

  acceptToolOutputs(outputs: readonly AgentProtocolToolOutput[]): void {
    this.#locked = true
    this.#active.acceptToolOutputs(outputs)
  }

  isCancellation(error: unknown): boolean {
    return this.#active.isCancellation(error)
  }

  get #active(): AgentProtocolSession {
    return this.#sessions[this.#index]!
  }
}

function isNegotiableProtocolFailure(error: unknown): boolean {
  if (error instanceof ResponsesClientError) {
    if (error.code === 'remote_rejected' && (
      error.remoteFailure === 'responses_unsupported' ||
      error.remoteFailure === 'tool_incompatible'
    )) return true
    if (error.code === 'invalid_response' || error.code === 'redirect_rejected') return true
  }
  if (error instanceof ChatCompletionsClientError) {
    return error.code === 'remote_rejected' &&
      error.remoteFailure === 'chat_completions_unsupported'
  }
  if (error instanceof AnthropicMessagesClientError) {
    return error.code === 'remote_rejected' &&
      error.remoteFailure === 'anthropic_messages_unsupported'
  }
  if (error instanceof GeminiContentClientError) {
    return error.code === 'remote_rejected' &&
      error.remoteFailure === 'gemini_generate_content_unsupported'
  }
  return false
}

class ResponsesProtocolSession implements AgentProtocolSession {
  readonly endpointType = 'openai-response' as const
  readonly #client: Pick<OpenAICompatibleResponsesClient, 'stream'>
  readonly #input: AgentProtocolSessionInput
  readonly #invalidToolCall: () => Error
  readonly #promptCacheKey = generateResponsesPromptCacheKey()
  #continuation: ResponsesContinuationCapsule | undefined
  #pendingOutputs: readonly ResponsesFunctionCallOutputInput[] = []
  #awaitingContinuation: ResponsesContinuationCapsule | undefined

  constructor(
    client: Pick<OpenAICompatibleResponsesClient, 'stream'>,
    input: AgentProtocolSessionInput,
    invalidToolCall: () => Error
  ) {
    this.#client = client
    this.#input = input
    this.#invalidToolCall = invalidToolCall
  }

  async next(signal: AbortSignal, onDelta: (delta: string) => void): Promise<AgentProtocolRound> {
    if (this.#awaitingContinuation !== undefined) throw this.#invalidToolCall()
    const result = await this.#client.stream(
      this.#input.credentials,
      {
        model: this.#input.model,
        wireMode: this.#input.wireMode,
        ...(this.#input.endpointPath === undefined ? {} : { endpointPath: this.#input.endpointPath }),
        promptCacheKey: this.#promptCacheKey,
        ...(this.#continuation === undefined
          ? { messages: this.#input.initialModelInput }
          : { continuation: { capsule: this.#continuation, outputs: this.#pendingOutputs } }),
        instructions: this.#input.instructions,
        reasoning: this.#input.reasoning === 'auto' ? undefined : this.#input.reasoning,
        webSearch: this.#input.webSearch,
        ...(this.#input.imageGeneration ? { imageGeneration: true } : {}),
        tools: this.#input.tools
      },
      {
        signal,
        onEvent: (event) => {
          if (event.type === 'response.output_text.delta') onDelta(event.delta)
          if (event.type === 'response.usage') this.#input.onUsage?.(event)
        }
      }
    )
    if (result.toolCalls.length > 0) {
      if (!result.continuation) throw this.#invalidToolCall()
      this.#awaitingContinuation = result.continuation
    }
    return {
      toolCalls: result.toolCalls,
      ...(result.generatedImages === undefined ? {} : { generatedImages: result.generatedImages })
    }
  }

  acceptToolOutputs(outputs: readonly AgentProtocolToolOutput[]): void {
    const continuation = this.#awaitingContinuation
    if (continuation === undefined) throw this.#invalidToolCall()
    this.#continuation = continuation
    this.#pendingOutputs = Object.freeze(outputs.map(({ toolCall, output }) => ({
      type: 'function_call_output' as const,
      call_id: toolCall.callId,
      output
    })))
    this.#awaitingContinuation = undefined
  }

  isCancellation(error: unknown): boolean {
    return error instanceof ResponsesClientError && error.code === 'cancelled'
  }
}

interface MessageToolRound<TMessage> {
  readonly toolCalls: readonly ResponsesFunctionToolCall[]
  readonly assistantMessage?: TMessage
}

type StreamMessageRound<TMessage> = (
  history: readonly TMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void
) => Promise<MessageToolRound<TMessage>>

class MessageProtocolSession<TMessage> implements AgentProtocolSession {
  readonly endpointType: AgentProtocolEndpointType = 'openai'
  readonly #messages: TMessage[]
  readonly #streamRound: StreamMessageRound<TMessage>
  readonly #toolResultMessages: (outputs: readonly AgentProtocolToolOutput[]) => readonly TMessage[]
  readonly #isCancellation: (error: unknown) => boolean
  readonly #invalidToolCall: () => Error
  #awaitingToolOutputs = false

  constructor(
    messages: TMessage[],
    streamRound: StreamMessageRound<TMessage>,
    toolResultMessages: (outputs: readonly AgentProtocolToolOutput[]) => readonly TMessage[],
    isCancellation: (error: unknown) => boolean,
    invalidToolCall: () => Error
  ) {
    this.#messages = messages
    this.#streamRound = streamRound
    this.#toolResultMessages = toolResultMessages
    this.#isCancellation = isCancellation
    this.#invalidToolCall = invalidToolCall
  }

  async next(signal: AbortSignal, onDelta: (delta: string) => void): Promise<AgentProtocolRound> {
    if (this.#awaitingToolOutputs) throw this.#invalidToolCall()
    const result = await this.#streamRound(this.#messages, signal, onDelta)
    if (result.toolCalls.length > 0) {
      if (result.assistantMessage === undefined) throw this.#invalidToolCall()
      this.#messages.push(result.assistantMessage)
      this.#awaitingToolOutputs = true
    }
    return { toolCalls: result.toolCalls }
  }

  acceptToolOutputs(outputs: readonly AgentProtocolToolOutput[]): void {
    if (!this.#awaitingToolOutputs) throw this.#invalidToolCall()
    this.#messages.push(...this.#toolResultMessages(outputs))
    this.#awaitingToolOutputs = false
  }

  isCancellation(error: unknown): boolean {
    return this.#isCancellation(error)
  }
}

class ChatCompletionsProtocolSession extends MessageProtocolSession<ChatAgentMessage> {
  readonly endpointType = 'openai' as const

  constructor(
    client: Pick<OpenAICompatibleChatCompletionsClient, 'streamWithTools'>,
    input: AgentProtocolSessionInput,
    invalidToolCall: () => Error
  ) {
    const tools = input.tools.map(responseToolToChatCompletions)
    const messages: ChatAgentMessage[] = [
      { role: 'system', content: input.instructions },
      ...initialConversationMessages(input.initialModelInput).map((message) => ({
        role: message.role,
        content: message.content
      }))
    ]
    super(
      messages,
      async (history, signal, onDelta) => {
        const result = await client.streamWithTools(
          input.credentials,
          {
            model: input.model,
            messages: history,
            tools,
            ...(input.endpointPath === undefined ? {} : { endpointPath: input.endpointPath }),
            instructions: undefined,
            reasoning: input.reasoning === 'auto' ? undefined : input.reasoning
          },
          {
            signal,
            onEvent: (event) => {
              if (event.type === 'response.output_text.delta') onDelta(event.delta)
            }
          }
        ).catch((error: unknown) => {
          const recoverableToolCalls = recoverableChatToolCalls(error)
          if (recoverableToolCalls === undefined) throw error
          return {
            responseId: null,
            outputText: '',
            toolCalls: recoverableToolCalls.map(({ id, name }) => ({
              id,
              type: 'function' as const,
              function: { name, arguments: '{}' }
            })),
            hasToolCalls: true
          }
        })
        assertMessageToolCallFlag(result.hasToolCalls, result.toolCalls.length, invalidToolCall)
        const seenCallIds = new Set<string>()
        const historyToolCalls: ChatCompletionsToolCall[] = []
        const toolCalls: ResponsesFunctionToolCall[] = []
        for (const toolCall of result.toolCalls) {
          if (!isSafeChatToolCall(toolCall) || seenCallIds.has(toolCall.id)) {
            throw invalidToolCall()
          }
          seenCallIds.add(toolCall.id)
          let argumentsValue: ResponsesJsonObject
          let historyArguments = toolCall.function.arguments
          try {
            argumentsValue = parseMessageToolArguments(toolCall.function.arguments, invalidToolCall)
          } catch {
            argumentsValue = {}
            historyArguments = '{}'
          }
          historyToolCalls.push({
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.function.name, arguments: historyArguments }
          })
          toolCalls.push({
            callId: toolCall.id,
            name: toolCall.function.name,
            arguments: argumentsValue
          })
        }
        return {
          toolCalls,
          ...(toolCalls.length === 0 ? {} : {
            assistantMessage: {
              role: 'assistant',
              content: result.outputText,
              tool_calls: historyToolCalls
            } satisfies ChatCompletionsAssistantWithToolsMessage
          })
        }
      },
      (outputs) => outputs.map(({ toolCall, output }) => ({
        role: 'tool',
        tool_call_id: toolCall.callId,
        content: output
      } satisfies ChatCompletionsToolResultMessage)),
      (error) => error instanceof ChatCompletionsClientError && error.code === 'cancelled',
      invalidToolCall
    )
  }
}

class AnthropicProtocolSession extends MessageProtocolSession<AnthropicMessagesAgentMessage> {
  readonly endpointType = 'anthropic' as const

  constructor(
    client: Pick<AnthropicMessagesClient, 'streamWithTools'>,
    input: AgentProtocolSessionInput,
    invalidToolCall: () => Error
  ) {
    const tools: AnthropicMessagesToolDefinition[] = input.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.parameters ?? { type: 'object', properties: {} }
    }))
    const messages: AnthropicMessagesAgentMessage[] = initialConversationMessages(input.initialModelInput)
      .map((message) => ({ role: message.role, content: message.content }))
    super(
      messages,
      async (history, signal, onDelta) => {
        const result = await client.streamWithTools(
          input.credentials,
          {
            model: input.model,
            messages: history,
            tools,
            ...(input.endpointPath === undefined ? {} : { endpointPath: input.endpointPath }),
            instructions: input.instructions,
            reasoning: input.reasoning === 'auto' ? undefined : input.reasoning,
            reasoningProtocol: anthropicReasoningProtocol(input.reasoningProtocol)
          },
          {
            signal,
            onEvent: (event) => {
              if (event.type === 'response.output_text.delta') onDelta(event.delta)
            }
          }
        )
        assertMessageToolCallFlag(result.hasToolCalls, result.toolCalls.length, invalidToolCall)
        const toolCalls = result.toolCalls.map((toolCall): ResponsesFunctionToolCall => ({
          callId: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.input
        }))
        return {
          toolCalls,
          ...(toolCalls.length === 0 ? {} : {
            assistantMessage: { role: 'assistant', content: result.assistantContent }
          })
        }
      },
      (outputs): readonly AnthropicMessagesAgentMessage[] => [{
        role: 'user',
        content: outputs.map(({ toolCall, output }): AnthropicMessagesToolResultContentBlock => ({
          type: 'tool_result',
          tool_use_id: toolCall.callId,
          content: output
        }))
      }],
      (error) => error instanceof AnthropicMessagesClientError && error.code === 'cancelled',
      invalidToolCall
    )
  }
}

class GeminiProtocolSession extends MessageProtocolSession<GeminiAgentMessage> {
  readonly endpointType = 'gemini' as const

  constructor(
    client: Pick<GeminiContentClient, 'streamWithTools'>,
    input: AgentProtocolSessionInput,
    invalidToolCall: () => Error
  ) {
    const tools: GeminiContentToolDefinition[] = input.tools.map(responseToolToChatCompletions)
    const messages: GeminiAgentMessage[] = initialConversationMessages(input.initialModelInput)
      .map((message) => ({ role: message.role, content: message.content }))
    super(
      messages,
      async (history, signal, onDelta) => {
        const result = await client.streamWithTools(
          input.credentials,
          {
            model: input.model,
            messages: history,
            tools,
            ...(input.endpointPath === undefined ? {} : { endpointPath: input.endpointPath }),
            instructions: input.instructions,
            reasoning: input.reasoning === 'auto' ? undefined : input.reasoning,
            reasoningProtocol: geminiReasoningProtocol(input.reasoningProtocol)
          },
          {
            signal,
            onEvent: (event) => {
              if (event.type === 'response.output_text.delta') onDelta(event.delta)
            }
          }
        )
        assertMessageToolCallFlag(result.hasToolCalls, result.toolCalls.length, invalidToolCall)
        const toolCalls = result.toolCalls.map((toolCall): ResponsesFunctionToolCall => ({
          callId: toolCall.id,
          name: toolCall.function.name,
          arguments: parseMessageToolArguments(toolCall.function.arguments, invalidToolCall)
        }))
        return {
          toolCalls,
          ...(toolCalls.length === 0 ? {} : {
            assistantMessage: {
              role: 'assistant',
              content: result.outputText,
              tool_calls: result.toolCalls,
              ...(result.assistantContent === undefined
                ? {}
                : { assistantContent: result.assistantContent })
            } satisfies GeminiContentAssistantWithToolsMessage
          })
        }
      },
      (outputs) => outputs.map(({ toolCall, output }) => ({
        role: 'tool',
        tool_call_id: toolCall.callId,
        name: toolCall.name,
        content: output
      } satisfies GeminiContentToolResultMessage)),
      (error) => error instanceof GeminiContentClientError && error.code === 'cancelled',
      invalidToolCall
    )
  }
}

type ChatAgentMessage =
  | ChatCompletionsAssistantWithToolsMessage
  | ChatCompletionsToolResultMessage
  | ResponsesMessage

type GeminiAgentMessage =
  | GeminiContentMessage
  | GeminiContentAssistantWithToolsMessage
  | GeminiContentToolResultMessage

type AgentConversationMessage = Omit<ResponsesMessage, 'role'> & {
  readonly role: 'user' | 'assistant'
}

const MAX_MESSAGE_TOOL_CALL_ID_LENGTH = 256
const MAX_MESSAGE_TOOL_NAME_LENGTH = 256
const MAX_MESSAGE_TOOL_ARGUMENT_CHARACTERS = 18 * 1024 * 1024

function initialConversationMessages(items: readonly ResponsesInputItem[]): AgentConversationMessage[] {
  return items.filter((item): item is AgentConversationMessage => (
    'role' in item && (item.role === 'user' || item.role === 'assistant')
  ))
}

function recoverableChatToolCalls(
  error: unknown
): readonly ChatCompletionsRecoverableToolCall[] | undefined {
  if (!(error instanceof ChatCompletionsClientError) || error.code !== 'invalid_response') {
    return undefined
  }
  const calls = error.recoverableToolCalls
  return calls === undefined || calls.length < 1 ? undefined : calls
}

function isSafeChatToolCall(value: unknown): value is ChatCompletionsToolCall {
  try {
    if (value === null || typeof value !== 'object') return false
    const candidate = value as { id?: unknown; type?: unknown; function?: unknown }
    if (
      typeof candidate.id !== 'string' ||
      candidate.id.length < 1 ||
      candidate.id.length > MAX_MESSAGE_TOOL_CALL_ID_LENGTH ||
      candidate.id.includes('\0') ||
      candidate.type !== 'function' ||
      candidate.function === null ||
      typeof candidate.function !== 'object'
    ) return false
    const fn = candidate.function as { name?: unknown; arguments?: unknown }
    return typeof fn.name === 'string' &&
      fn.name.length > 0 &&
      fn.name.length <= MAX_MESSAGE_TOOL_NAME_LENGTH &&
      !fn.name.includes('\0') &&
      typeof fn.arguments === 'string' &&
      fn.arguments.length <= MAX_MESSAGE_TOOL_ARGUMENT_CHARACTERS &&
      !fn.arguments.includes('\0')
  } catch {
    return false
  }
}

function parseMessageToolArguments(
  value: string,
  invalidToolCall: () => Error
): ResponsesJsonObject {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidToolCall()
    }
    return parsed as ResponsesJsonObject
  } catch {
    throw invalidToolCall()
  }
}

function assertMessageToolCallFlag(
  hasToolCalls: boolean,
  count: number,
  invalidToolCall: () => Error
): void {
  if (hasToolCalls !== (count > 0)) throw invalidToolCall()
}

function responseToolToChatCompletions(tool: ResponsesFunctionToolDefinition): ChatCompletionsToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters as Record<string, unknown> })
    }
  }
}

function anthropicReasoningProtocol(
  value: ModelReasoningProtocol | undefined
): Extract<ModelReasoningProtocol, { type: 'anthropic-adaptive' | 'anthropic-budget' }> | undefined {
  return value?.type === 'anthropic-adaptive' || value?.type === 'anthropic-budget'
    ? value
    : undefined
}

function geminiReasoningProtocol(
  value: ModelReasoningProtocol | undefined
): Extract<ModelReasoningProtocol, { type: 'gemini-level' | 'gemini-budget' }> | undefined {
  return value?.type === 'gemini-level' || value?.type === 'gemini-budget'
    ? value
    : undefined
}
