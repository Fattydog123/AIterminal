import type {
  ConversationMessageDto,
  ConversationSnapshot,
  ModelEndpointType,
  ModelReasoningProtocol,
  ModelWireMode,
  ReasoningEffort,
} from '../../shared/contracts.ts'
import { CONTEXT_COMPACTION_PREFIX } from '../../shared/contracts.ts'
import { redactCredentialContent } from '../security/redaction.ts'
import type {
  ConversationHistoryImportMessage,
  ConversationHistoryService,
} from './conversation-history-service.ts'
import type { OpenAICompatibleResponsesClient, ResponsesCredentials, ResponsesMessage } from './responses-client.ts'
import type { OpenAICompatibleChatCompletionsClient } from './chat-completions-client.ts'
import type { AnthropicMessagesClient } from './anthropic-messages-client.ts'
import type { GeminiContentClient } from './gemini-content-client.ts'

const MIN_COMPLETE_MESSAGES = 4
const RECENT_CONTEXT_BYTES = 80_000
// The agent context selector drops the oldest messages beyond 1MB
// (MAX_CONTEXT_BYTES in agent-turn-service). Automatic compaction fires just
// below that line so history is summarized before it silently falls off.
const AUTO_COMPACTION_THRESHOLD_BYTES = Math.floor(1024 * 1024 * 0.9)
const MAX_SUMMARY_SOURCE_BYTES = 768 * 1024
const MAX_SUMMARY_MESSAGE_BYTES = 96 * 1024
export const CONTEXT_SUMMARY_PREFIX = CONTEXT_COMPACTION_PREFIX

export type ConversationCompactionEndpoint = Extract<
  ModelEndpointType,
  'openai-response' | 'openai' | 'anthropic' | 'gemini'
>

export interface ConversationCompactionRoute {
  readonly model: string
  readonly credentials: ResponsesCredentials
  readonly endpointType: ConversationCompactionEndpoint
  readonly endpointPath?: string
  readonly wireMode: ModelWireMode
  readonly reasoning: ReasoningEffort
  readonly reasoningProtocol?: ModelReasoningProtocol
}

export interface ConversationCompactionResult {
  readonly compacted: boolean
  readonly removedMessages: number
  readonly snapshot: ConversationSnapshot
}

export interface ConversationCompactionServiceOptions {
  readonly history: Pick<ConversationHistoryService, 'load' | 'replaceMessages'>
  readonly responses: Pick<OpenAICompatibleResponsesClient, 'stream'>
  readonly chatCompletions: Pick<OpenAICompatibleChatCompletionsClient, 'stream'>
  readonly anthropic: Pick<AnthropicMessagesClient, 'stream'>
  readonly gemini: Pick<GeminiContentClient, 'stream'>
  readonly onConversationUpdated?: (taskId: string) => void | Promise<void>
}

/** Main is the sole owner of model-routed conversation compaction and persistence. */
export class ConversationCompactionService {
  readonly #history: ConversationCompactionServiceOptions['history']
  readonly #responses: ConversationCompactionServiceOptions['responses']
  readonly #chatCompletions: ConversationCompactionServiceOptions['chatCompletions']
  readonly #anthropic: ConversationCompactionServiceOptions['anthropic']
  readonly #gemini: ConversationCompactionServiceOptions['gemini']
  readonly #onConversationUpdated: ConversationCompactionServiceOptions['onConversationUpdated']

  constructor(options: ConversationCompactionServiceOptions) {
    this.#history = options.history
    this.#responses = options.responses
    this.#chatCompletions = options.chatCompletions
    this.#anthropic = options.anthropic
    this.#gemini = options.gemini
    this.#onConversationUpdated = options.onConversationUpdated
  }

  async compact(
    taskId: string,
    route: ConversationCompactionRoute,
    options: {
      readonly signal?: AbortSignal
      readonly force?: boolean
      /**
       * Invoked after the summarization request returns and before history is
       * rewritten. The model call takes seconds; a turn admitted meanwhile
       * appends messages that a replace would clobber. Returning false aborts
       * the compaction without touching history.
       */
      readonly confirmStillSafe?: () => boolean
    } = {},
  ): Promise<ConversationCompactionResult> {
    const snapshot = await this.#history.load(taskId)
    const plan = planCompaction(snapshot.messages, options.force === true)
    if (!plan) return { compacted: false, removedMessages: 0, snapshot }

    const summary = await this.#summarize(plan.summarySource, route, options.signal)
    const persistedSummary = boundedSummary(summary, route.credentials.apiKey)
    if (!persistedSummary) throw new ConversationCompactionError('empty_summary')
    if (options.confirmStillSafe?.() === false) throw new ConversationCompactionError('superseded')

    const replacement: ConversationHistoryImportMessage[] = [
      { role: 'user', content: `${CONTEXT_SUMMARY_PREFIX}${persistedSummary}` },
      ...plan.recentMessages.map(({ role, content }) => ({ role, content })),
    ]
    await this.#history.replaceMessages({ taskId, messages: replacement })
    await this.#notifyConversationUpdated(taskId)
    return {
      compacted: true,
      removedMessages: plan.summarySource.length,
      snapshot: await this.#history.load(taskId),
    }
  }

  async #summarize(
    source: readonly ConversationMessageDto[],
    route: ConversationCompactionRoute,
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = compactionPrompt(source)
    const messages: readonly ResponsesMessage[] = [{ role: 'user', content: prompt }]
    const reasoning = route.reasoning === 'auto' ? undefined : route.reasoning
    switch (route.endpointType) {
      case 'openai-response':
        return (await this.#responses.stream(route.credentials, {
          model: route.model,
          messages,
          wireMode: route.wireMode,
          ...(route.endpointPath === undefined ? {} : { endpointPath: route.endpointPath }),
          reasoning,
        }, { signal })).outputText
      case 'openai':
        return (await this.#chatCompletions.stream(route.credentials, {
          model: route.model,
          messages,
          ...(route.endpointPath === undefined ? {} : { endpointPath: route.endpointPath }),
          reasoning,
        }, { signal })).outputText
      case 'anthropic':
        return (await this.#anthropic.stream(route.credentials, {
          model: route.model,
          messages,
          ...(route.endpointPath === undefined ? {} : { endpointPath: route.endpointPath }),
          reasoning,
          reasoningProtocol: anthropicReasoningProtocol(route.reasoningProtocol),
        }, { signal })).outputText
      case 'gemini':
        return (await this.#gemini.stream(route.credentials, {
          model: route.model,
          messages,
          ...(route.endpointPath === undefined ? {} : { endpointPath: route.endpointPath }),
          reasoning,
          reasoningProtocol: geminiReasoningProtocol(route.reasoningProtocol),
        }, { signal })).outputText
    }
  }

  async #notifyConversationUpdated(taskId: string): Promise<void> {
    try {
      await this.#onConversationUpdated?.(taskId)
    } catch {
      // Encrypted history remains authoritative when the optional workspace export fails.
    }
  }
}

export class ConversationCompactionError extends Error {
  readonly code: 'empty_summary' | 'superseded'

  constructor(code: 'empty_summary' | 'superseded') {
    super(code === 'superseded'
      ? 'A turn started while the summary was being generated; history was left untouched.'
      : 'The selected model returned no usable context summary.')
    this.name = 'ConversationCompactionError'
    this.code = code
  }
}

function planCompaction(
  messages: readonly ConversationMessageDto[],
  force: boolean,
): { readonly summarySource: ConversationMessageDto[]; readonly recentMessages: ConversationMessageDto[] } | null {
  const complete = messages.filter((message) => message.status === 'complete' && message.content.trim())
  if (complete.length < MIN_COMPLETE_MESSAGES) return null
  if (!force) {
    // Automatic (pre-turn) compaction only acts when history approaches the
    // agent context ceiling; explicit /compact always makes progress.
    const totalBytes = complete.reduce(
      (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
      0,
    )
    if (totalBytes < AUTO_COMPACTION_THRESHOLD_BYTES) return null
  }

  const recentMessages: ConversationMessageDto[] = []
  let recentBytes = 0
  for (let index = complete.length - 1; index >= 0; index -= 1) {
    const message = complete[index]!
    const bytes = Buffer.byteLength(message.content, 'utf8')
    if (recentMessages.length >= 2 && recentBytes + bytes > RECENT_CONTEXT_BYTES) break
    recentMessages.unshift(message)
    recentBytes += bytes
  }
  let sourceEnd = complete.length - recentMessages.length
  // Explicit /compact must still make progress for many short messages.
  if (force && sourceEnd < 2 && complete.length > 4) {
    sourceEnd = complete.length - 4
    recentMessages.splice(0, recentMessages.length, ...complete.slice(sourceEnd))
  }
  const summarySource = complete.slice(0, sourceEnd)
  return summarySource.length >= 2 ? { summarySource, recentMessages } : null
}

function compactionPrompt(source: readonly ConversationMessageDto[]): string {
  const header = [
    'Create a concise structured handoff summary for the next model continuing this conversation.',
    'Preserve current progress, key decisions, user requirements, unresolved work, and exact facts needed to continue.',
    'Do not add facts, credentials, private reasoning, or commentary about the summarization process.',
    '',
    'Conversation to summarize:',
  ].join('\n')
  const chunks = [header]
  let bytes = Buffer.byteLength(header, 'utf8')
  for (const message of source) {
    const entry = `\n${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`
    const entryBytes = Buffer.byteLength(entry, 'utf8')
    if (bytes + entryBytes > MAX_SUMMARY_SOURCE_BYTES) break
    chunks.push(entry)
    bytes += entryBytes
  }
  return chunks.join('')
}

function boundedSummary(raw: string, apiKey: string): string | null {
  const safe = redactCredentialContent(apiKey ? raw.replaceAll(apiKey, '<redacted>') : raw).trim()
  if (safe.length < 20 || safe.includes('\0')) return null
  if (Buffer.byteLength(safe, 'utf8') <= MAX_SUMMARY_MESSAGE_BYTES) return safe
  let end = Math.min(safe.length, MAX_SUMMARY_MESSAGE_BYTES)
  while (end > 0 && Buffer.byteLength(safe.slice(0, end), 'utf8') > MAX_SUMMARY_MESSAGE_BYTES) end -= 1
  const bounded = safe.slice(0, end).trimEnd()
  return bounded.length >= 20 ? `${bounded}\n\n[摘要已按上下文上限截断]` : null
}

function anthropicReasoningProtocol(
  value: ModelReasoningProtocol | undefined,
): Extract<ModelReasoningProtocol, { type: 'anthropic-adaptive' | 'anthropic-budget' }> | undefined {
  return value?.type === 'anthropic-adaptive' || value?.type === 'anthropic-budget' ? value : undefined
}

function geminiReasoningProtocol(
  value: ModelReasoningProtocol | undefined,
): Extract<ModelReasoningProtocol, { type: 'gemini-level' | 'gemini-budget' }> | undefined {
  return value?.type === 'gemini-level' || value?.type === 'gemini-budget' ? value : undefined
}
