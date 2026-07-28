import type {
  ApiResult,
  ModelDescriptor,
  ModelEndpointType,
  TurnStartInput,
  TurnStartResult,
  WorkspaceMode,
} from '../../shared/contracts.ts'
import {
  declaredModelAgentEndpoints,
  isModelDelegationCompatible,
  isModelCapabilityExplicitlyUnsupported,
  isModelReasoningExplicitlyUnsupported,
  isValidModelId,
  isValidRelayGroupId,
  preferredModelEndpoint,
} from '../../shared/contracts.ts'
import { WZH_RELAY_PROFILE_HANDLE } from '../../shared/server-config.ts'
import { failure } from '../security/redaction.ts'
import { PendingTurnStarts, isTurnStartRequestId } from '../runtime/pending-turn-starts.ts'
import {
  AgentTurnService,
  type AgentEndpointCandidate,
  type AgentEndpointType,
} from './agent-turn-service.ts'
import { AttachmentInputService, type PreparedAttachmentInput } from './attachment-input-service.ts'
import { buildAnthropicMessagesRequestUrl } from './anthropic-messages-client.ts'
import { ChatTurnService } from './chat-turn-service.ts'
import { ConfirmedModelCatalogStore, type ConfirmedModelCatalog } from './confirmed-model-catalog-store.ts'
import { buildGeminiContentRequestUrl } from './gemini-content-client.ts'
import { buildImagesGenerationRequestUrl } from './images-client.ts'
import { RelayServiceError, type RelayModelAccessCredentials } from './relay-service.ts'
import {
  cloneModelReasoningProtocol,
  isReasoningEffort,
  reasoningProtocolForEndpoint,
} from './reasoning-protocol.ts'
import { buildResponsesRequestUrl } from './responses-client.ts'
import { SelectionTokenStore, type ResolvedWorkspaceRecord } from './selection-token-store.ts'
import { buildChatCompletionsRequestUrl } from './chat-completions-client.ts'
import type {
  ConversationCompactionEndpoint,
  ConversationCompactionService,
} from './conversation-compaction-service.ts'
import type { ExtensionHost } from './extension-host.ts'

type EndpointConsent = (mode: WorkspaceMode, requestUrl: string) => Promise<unknown>

export interface TurnAdmissionServiceOptions {
  readonly ownerWebContentsId: number
  readonly catalogs: ConfirmedModelCatalogStore
  readonly selections: Pick<SelectionTokenStore, 'describeAttachment' | 'resolveWorkspace'>
  readonly attachments: Pick<AttachmentInputService, 'prepare'>
  readonly resolveCredentials: (
    profileHandle: string,
    groupId: string,
    modelId: string,
  ) => Promise<Readonly<RelayModelAccessCredentials>>
  readonly ensureEndpoint: EndpointConsent
  readonly extensions: Pick<ExtensionHost, 'consumeReviewMode' | 'getPlanMode'>
  readonly chatTurns: Pick<ChatTurnService, 'start' | 'cancel'>
  readonly agentTurns: Pick<AgentTurnService, 'start' | 'cancel'>
  /** Optional pre-turn history compaction; absent in tests that don't exercise it. */
  readonly compaction?: Pick<ConversationCompactionService, 'compact'>
  readonly workspaceProjectId: (workspace: Pick<ResolvedWorkspaceRecord, 'device' | 'inode'>) => string
}

/**
 * Admits a renderer turn only after its confirmed model catalog, local grants,
 * endpoint consent, and one-time inputs still agree. It deliberately returns
 * no credential, absolute workspace path, attachment body, or abort signal.
 */
export class TurnAdmissionService {
  readonly #ownerWebContentsId: number
  readonly #catalogs: ConfirmedModelCatalogStore
  readonly #selections: Pick<SelectionTokenStore, 'describeAttachment' | 'resolveWorkspace'>
  readonly #attachments: Pick<AttachmentInputService, 'prepare'>
  readonly #resolveCredentials: TurnAdmissionServiceOptions['resolveCredentials']
  readonly #ensureEndpoint: EndpointConsent
  readonly #extensions: TurnAdmissionServiceOptions['extensions']
  readonly #chatTurns: TurnAdmissionServiceOptions['chatTurns']
  readonly #agentTurns: TurnAdmissionServiceOptions['agentTurns']
  readonly #compaction: TurnAdmissionServiceOptions['compaction']
  readonly #workspaceProjectId: TurnAdmissionServiceOptions['workspaceProjectId']
  readonly #pendingStarts = new PendingTurnStarts()

  constructor(options: TurnAdmissionServiceOptions) {
    this.#ownerWebContentsId = options.ownerWebContentsId
    this.#catalogs = options.catalogs
    this.#selections = options.selections
    this.#attachments = options.attachments
    this.#resolveCredentials = options.resolveCredentials
    this.#ensureEndpoint = options.ensureEndpoint
    this.#extensions = options.extensions
    this.#chatTurns = options.chatTurns
    this.#agentTurns = options.agentTurns
    this.#compaction = options.compaction
    this.#workspaceProjectId = options.workspaceProjectId
  }

  async start(rawInput: unknown): Promise<ApiResult<TurnStartResult>> {
    const parsed = validateTurnStartInput(rawInput)
    if (!parsed.ok) return parsed.result
    const turn = parsed.value
    const preflight = this.#preflight(turn)
    if (!preflight.ok) return preflight.result

    const signal = this.#pendingStarts.begin(turn.requestId)
    try {
      return await this.#startAdmitted(turn, preflight, signal)
    } catch (error) {
      if (signal.aborted) return failure('cancelled', 'Turn start was cancelled.')
      throw error
    } finally {
      this.#pendingStarts.finish(turn.requestId, signal)
    }
  }

  cancelPendingStart(requestId: unknown): ApiResult<null> {
    if (!isTurnStartRequestId(requestId)) {
      return failure('invalid_input', 'Turn cancellation input is invalid.')
    }
    if (!this.#pendingStarts.cancel(requestId)) {
      return failure('not_found', 'No pending turn start was found.')
    }
    return success(null)
  }

  abortPendingStarts(): void {
    this.#pendingStarts.abortAll()
  }

  #preflight(turn: TurnStartInput): AdmissionPreflight | AdmissionFailure {
    if (turn.profileHandle !== WZH_RELAY_PROFILE_HANDLE) {
      return rejected('denied', 'Chat 和 Agent 仅支持当前账户的模型。')
    }

    const reviewRequested = turn.mode === 'agent' && isCodeReviewPrompt(turn.prompt)
    if (
      reviewRequested &&
      (
        turn.reviewHandle === undefined ||
        turn.attachmentTokens.length > 0 ||
        turn.webSearch ||
        turn.imageGeneration ||
        turn.localSubagents
      )
    ) {
      return rejected(
        'invalid_input',
        'Code review requires its exact one-time authorization and cannot use attachments, web, images, or subagents.',
      )
    }
    if (!reviewRequested && turn.reviewHandle !== undefined) {
      return rejected('invalid_input', 'A code review authorization can only be used with /review in Agent mode.')
    }
    if (turn.groupId === null) {
      return rejected('invalid_input', '接入分组与模型渠道不匹配。')
    }

    const catalog = this.#catalogs.get(turn.profileHandle, turn.mode, turn.groupId)
    if (!catalog) {
      return rejected(
        'denied',
        `Refresh the confirmed model catalog before starting ${turn.mode === 'agent' ? 'Agent' : 'Chat'}.`,
      )
    }
    const model = catalog.models.find(
      (candidate) => candidate.id === turn.modelId && candidate.modes.includes(turn.mode),
    )
    if (
      model &&
      turn.mode === 'agent' &&
      !model.endpointTypes.some(isAgentEndpointType)
    ) {
      return rejected(
        'invalid_input',
        '当前模型没有声明客户端已接通的 Agent 工具接口，请切换到兼容模型。',
      )
    }
    if (
      model &&
      turn.mode === 'chat' &&
      (
        model.preferredChatEndpoint === null ||
        model.preferredChatTransport === 'unsupported' ||
        model.preferredChatTransport === 'responses-compact'
      )
    ) {
      return rejected('invalid_input', '当前模型声明的接口尚未接通，不能发送本轮请求。')
    }
    if (model?.preferredChatTransport === 'images' && !turn.imageGeneration) {
      return rejected('invalid_input', '这是图片模型，请先开启图片生成后再运行。')
    }
    if (
      model &&
      turn.imageGeneration &&
      model.endpointTypes.includes('image-generation') &&
      turn.attachmentTokens.length > 0
    ) {
      return rejected(
        'invalid_input',
        'Chat 的 Images 生成不会忽略附件；需要参考图或编辑图片时请在 Studio 使用图片编辑节点。',
      )
    }

    const attachmentKinds = turn.attachmentTokens.map((token) =>
      this.#selections.describeAttachment(token, this.#ownerWebContentsId)?.mediaKind ?? null,
    )
    if (attachmentKinds.some((kind) => kind === null)) {
      return rejected('denied', '所选附件授权无效或已过期，请重新选择。')
    }
    if (model?.wireMode === 'lite' && (turn.webSearch || turn.imageGeneration)) {
      return rejected(
        'invalid_input',
        'Responses Lite 模型暂不支持托管联网搜索或图片生成。请关闭这些能力，或切换到支持它们的标准模型。',
      )
    }
    if (
      !model ||
      isModelReasoningExplicitlyUnsupported(model, turn.reasoning) ||
      (turn.webSearch && !model.capabilities.webSearch) ||
      (turn.attachmentTokens.length > 0 && isModelCapabilityExplicitlyUnsupported(model, 'attachments')) ||
      (attachmentKinds.includes('image') && isModelCapabilityExplicitlyUnsupported(model, 'imageInput')) ||
      (turn.imageGeneration && !model.capabilities.imageGeneration) ||
      (turn.mode === 'agent' && isModelCapabilityExplicitlyUnsupported(model, 'toolUse'))
    ) {
      return rejected('invalid_input', 'The selected model capabilities are not in the confirmed catalog.')
    }

    return {
      ok: true,
      catalog,
      model,
      reviewRequested,
    }
  }

  async #startAdmitted(
    turn: TurnStartInput,
    preflight: AdmittedPreflight,
    signal: AbortSignal,
  ): Promise<ApiResult<TurnStartResult>> {
    let workspaceToken: string | undefined
    let workspace: ResolvedWorkspaceRecord | undefined
    if (turn.mode === 'agent') {
      if (!turn.workspaceToken) {
        return failure('invalid_input', 'Agent 请求需要选择一个本地工作区。')
      }
      const resolvedWorkspace = await this.#selections.resolveWorkspace(
        turn.workspaceToken,
        this.#ownerWebContentsId,
      )
      this.#pendingStarts.assertActive(signal)
      if (!resolvedWorkspace) {
        return failure('denied', '所选工作区授权无效或已过期，请重新选择。')
      }
      workspace = resolvedWorkspace
      workspaceToken = workspace.workspaceToken
    }

    const credentials = await this.#resolveCredentials(turn.profileHandle, turn.groupId!, turn.modelId)
    this.#pendingStarts.assertActive(signal)
    if (!this.#catalogs.isCurrent(preflight.catalog)) {
      return catalogChanged()
    }

    const endpointType: ModelEndpointType = turn.mode === 'agent'
      ? inferAgentEndpointType(preflight.model)
      : turn.imageGeneration && preflight.model.endpointTypes.includes('image-generation')
        ? 'image-generation'
        : preflight.model.preferredChatEndpoint!
    const endpointRoute = preflight.catalog.endpointRoutes[endpointType]
    if (endpointRoute && endpointRoute.method !== 'POST') {
      return failure('not_ready', '当前模型接口声明的请求方法尚不受支持。')
    }
    const endpointPath = endpointRoute?.path
    const endpointCandidates: AgentEndpointCandidate[] | undefined = turn.mode === 'agent'
      ? orderedAgentEndpointTypes(preflight.model).flatMap((candidateType) => {
          const route = preflight.catalog.endpointRoutes[candidateType]
          if (route && route.method !== 'POST') return []
          const candidateReasoningProtocol = reasoningProtocolForEndpoint(
            preflight.model.declaredReasoningProtocol ?? preflight.model.reasoningProtocol,
            candidateType,
          )
          const candidate: AgentEndpointCandidate = {
            endpointType: candidateType,
            ...(route?.path === undefined ? {} : { endpointPath: route.path }),
            ...(candidateReasoningProtocol === undefined ? {} : {
              reasoningProtocol: cloneModelReasoningProtocol(candidateReasoningProtocol),
            }),
          }
          // Validate every fallback route before the Agent owns the credential.
          buildConfirmedModelRequestUrl(
            credentials.baseUrl,
            candidate.endpointType,
            turn.modelId,
            candidate.endpointPath,
          )
          return [candidate]
        })
      : undefined
    const requestUrl = buildConfirmedModelRequestUrl(
      credentials.baseUrl,
      endpointType,
      turn.modelId,
      endpointPath,
    )
    await this.#ensureEndpoint(turn.mode, requestUrl)
    this.#pendingStarts.assertActive(signal)
    if (!this.#catalogs.isCurrent(preflight.catalog)) {
      return catalogChanged()
    }

    const preparedAttachments = turn.attachmentTokens.length > 0
      ? await this.#attachments.prepare(turn.attachmentTokens, this.#ownerWebContentsId, { signal })
      : emptyPreparedAttachments()
    this.#pendingStarts.assertActive(signal)
    if (!this.#catalogs.isCurrent(preflight.catalog)) {
      return catalogChanged()
    }

    const reviewMode = preflight.reviewRequested && workspace !== undefined
      ? this.#extensions.consumeReviewMode(this.#ownerWebContentsId, {
          absolutePath: workspace.absolutePath,
          device: workspace.device,
          inode: workspace.inode,
        }, turn.reviewHandle)
      : false
    if (preflight.reviewRequested && !reviewMode) {
      return failure('denied', 'Select /review again for this authorized workspace before starting review.')
    }

    // Pre-turn auto-compaction: when history nears the context ceiling,
    // replace the oldest messages with a model summary before they silently
    // fall off the context selector. Agent and chat turns both participate;
    // review turns send only the prompt and never read history, so they skip
    // it. Best-effort by design: a failed or skipped compaction must never
    // block the turn itself. The endpoint route reuses the turn's own
    // already-consented request target.
    const compactionEndpoint = !reviewMode && this.#compaction
      ? turn.mode === 'agent'
        ? inferAgentEndpointType(preflight.model)
        : chatCompactionEndpoint(preflight.model.preferredChatTransport)
      : null
    if (compactionEndpoint !== null && this.#compaction) {
      try {
        await this.#compaction.compact(turn.taskId, {
          model: turn.modelId,
          credentials: { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey },
          endpointType: compactionEndpoint,
          ...(endpointPath === undefined ? {} : { endpointPath }),
          wireMode: preflight.model.wireMode,
          reasoning: turn.reasoning,
          ...(preflight.model.reasoningProtocol === undefined
            ? {}
            : { reasoningProtocol: preflight.model.reasoningProtocol }),
        }, { signal })
      } catch {
        // The context selector still bounds what is sent without a summary.
      }
      this.#pendingStarts.assertActive(signal)
      if (!this.#catalogs.isCurrent(preflight.catalog)) {
        return catalogChanged()
      }
    }

    const started = turn.mode === 'agent'
      ? await this.#agentTurns.start({
          taskId: turn.taskId,
          prompt: reviewMode ? codeReviewPrompt(turn.prompt) : turn.prompt,
          credentials: { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey },
          model: turn.modelId,
          modelLabel: preflight.model.label,
          endpointType: inferAgentEndpointType(preflight.model),
          ...(endpointPath === undefined ? {} : { endpointPath }),
          ...(endpointCandidates === undefined ? {} : { endpointCandidates }),
          wireMode: preflight.model.wireMode,
          modelCapabilities: Object.freeze({ ...preflight.model.capabilities }),
          reasoning: turn.reasoning,
          ...(preflight.model.reasoningProtocol === undefined
            ? {}
            : { reasoningProtocol: preflight.model.reasoningProtocol }),
          webSearch: turn.webSearch,
          imageGeneration: turn.imageGeneration,
          attachments: preparedAttachments.parts,
          approvalMode: turn.approvalMode,
          // The confirmed model owns delegation availability. The legacy
          // localSubagents request field is intentionally ignored so a model
          // can decide to call delegate_tasks without a renderer switch.
          subagentsEnabled: isModelDelegationCompatible(preflight.model) && !reviewMode,
          workspaceToken: workspaceToken!,
          workspaceProjectId: this.#workspaceProjectId(workspace!),
          workspaceIdentity: {
            absolutePath: workspace!.absolutePath,
            device: workspace!.device,
            inode: workspace!.inode,
          },
          ownerWebContentsId: this.#ownerWebContentsId,
          planMode: this.#extensions.getPlanMode(this.#ownerWebContentsId),
          reviewMode,
          ...(turn.contextMessageLimit === undefined
            ? {}
            : { contextMessageLimit: turn.contextMessageLimit }),
        }, { signal })
      : await this.#chatTurns.start({
          taskId: turn.taskId,
          prompt: turn.prompt,
          credentials: { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey },
          model: turn.modelId,
          modelLabel: preflight.model.label,
          endpointType: preflight.model.preferredChatEndpoint!,
          endpointTransport: preflight.model.preferredChatTransport,
          endpointTypes: preflight.model.endpointTypes,
          ...(endpointPath === undefined ? {} : { endpointPath }),
          wireMode: preflight.model.wireMode,
          modelCapabilities: Object.freeze({ ...preflight.model.capabilities }),
          reasoning: turn.reasoning,
          ...(preflight.model.reasoningProtocol === undefined
            ? {}
            : { reasoningProtocol: preflight.model.reasoningProtocol }),
          webSearch: turn.webSearch,
          imageGeneration: turn.imageGeneration,
          attachments: preparedAttachments.parts,
          ownerWebContentsId: this.#ownerWebContentsId,
          ...(turn.contextMessageLimit === undefined
            ? {}
            : { contextMessageLimit: turn.contextMessageLimit }),
        }, { signal })
    if (signal.aborted) {
      if (turn.mode === 'agent') this.#agentTurns.cancel(started.turnId)
      else this.#chatTurns.cancel(started.turnId)
      return failure('cancelled', 'Turn start was cancelled.')
    }
    return success(started)
  }
}

type AdmittedPreflight = {
  readonly ok: true
  readonly catalog: ConfirmedModelCatalog
  readonly model: ModelDescriptor
  readonly reviewRequested: boolean
}

type AdmissionFailure = {
  readonly ok: false
  readonly result: ApiResult<never>
}

type AdmissionPreflight = AdmittedPreflight | AdmissionFailure

const success = <T>(value: T): ApiResult<T> => ({ ok: true, value })

const rejected = (code: Parameters<typeof failure>[0], message: string): AdmissionFailure => ({
  ok: false,
  result: failure(code, message),
})

const catalogChanged = (): ApiResult<never> =>
  failure('conflict', 'The confirmed model catalog changed. Refresh before retrying.')

const emptyPreparedAttachments = (): PreparedAttachmentInput => ({
  parts: [],
  count: 0,
  totalBytes: 0,
})

export function validateTurnStartInput(input: unknown):
  | { ok: true; value: TurnStartInput }
  | AdmissionFailure {
  const allowedKeys = [
    'requestId',
    'taskId',
    'mode',
    'prompt',
    'profileHandle',
    'groupId',
    'modelId',
    'reasoning',
    'approvalMode',
    'workspaceToken',
    'reviewHandle',
    'attachmentTokens',
    'webSearch',
    'imageGeneration',
    'localSubagents',
    'contextMessageLimit',
  ] as const
  const requiredKeys = allowedKeys.filter(
    (key) =>
      key !== 'workspaceToken' &&
      key !== 'reviewHandle' &&
      key !== 'localSubagents' &&
      key !== 'contextMessageLimit',
  )
  if (
    !hasOnlyAllowedKeys(input, allowedKeys) ||
    !requiredKeys.every((key) => Object.hasOwn(input, key)) ||
    !isTurnStartRequestId(input.requestId) ||
    typeof input.taskId !== 'string' ||
    typeof input.prompt !== 'string' ||
    input.prompt.length < 1 ||
    input.prompt.length > 256 * 1024 ||
    Buffer.byteLength(input.prompt, 'utf8') > 256 * 1024 ||
    input.prompt.includes('\0') ||
    typeof input.profileHandle !== 'string' ||
    input.profileHandle.length > 128 ||
    (input.groupId !== null && !isValidRelayGroupId(input.groupId)) ||
    !isValidModelId(input.modelId) ||
    (input.mode !== 'chat' && input.mode !== 'agent') ||
    !isReasoningEffort(input.reasoning) ||
    !['request', 'auto', 'full'].includes(String(input.approvalMode)) ||
    typeof input.webSearch !== 'boolean' ||
    typeof input.imageGeneration !== 'boolean' ||
    (input.localSubagents !== undefined && typeof input.localSubagents !== 'boolean') ||
    (input.contextMessageLimit !== undefined &&
      (!Number.isSafeInteger(input.contextMessageLimit) ||
        Number(input.contextMessageLimit) < 2 ||
        Number(input.contextMessageLimit) > 24)) ||
    (input.workspaceToken !== undefined && typeof input.workspaceToken !== 'string') ||
    (input.reviewHandle !== undefined &&
      (typeof input.reviewHandle !== 'string' || !/^review_[A-Za-z0-9_-]{43}$/u.test(input.reviewHandle))) ||
    !Array.isArray(input.attachmentTokens) ||
    input.attachmentTokens.length > 16 ||
    input.attachmentTokens.some((token) => typeof token !== 'string' || token.length > 256)
  ) {
    return rejected('invalid_input', 'Chat 请求无效。')
  }
  if (input.mode === 'chat' && input.workspaceToken !== undefined) {
    return rejected('invalid_input', 'Chat 模式不能绑定本地工作区。')
  }
  if (input.mode === 'chat' && input.reviewHandle !== undefined) {
    return rejected('invalid_input', 'Chat mode cannot consume a code review authorization.')
  }
  if (input.mode === 'chat' && input.localSubagents === true) {
    return rejected('invalid_input', 'Chat 模式不能启动并行子任务。')
  }

  return {
    ok: true,
    value: {
      requestId: input.requestId,
      taskId: input.taskId,
      mode: input.mode,
      prompt: input.prompt,
      profileHandle: input.profileHandle,
      groupId: input.groupId,
      modelId: input.modelId,
      reasoning: input.reasoning as TurnStartInput['reasoning'],
      approvalMode: input.approvalMode as TurnStartInput['approvalMode'],
      ...(input.workspaceToken === undefined ? {} : { workspaceToken: input.workspaceToken }),
      ...(input.reviewHandle === undefined ? {} : { reviewHandle: input.reviewHandle }),
      attachmentTokens: [...input.attachmentTokens] as string[],
      webSearch: input.webSearch,
      imageGeneration: input.imageGeneration,
      localSubagents: input.localSubagents === true,
      ...(input.contextMessageLimit === undefined
        ? {}
        : { contextMessageLimit: Number(input.contextMessageLimit) }),
    },
  }
}

function isAgentEndpointType(value: ModelEndpointType): value is AgentEndpointType {
  return value === 'openai-response' ||
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'gemini'
}

function inferAgentEndpointType(model: Pick<ModelDescriptor, 'endpointTypes' | 'preferredAgentEndpoint'>): AgentEndpointType {
  const endpointType = orderedAgentEndpointTypes(model)[0] ?? preferredModelEndpoint(model.endpointTypes)
  if (endpointType !== null && isAgentEndpointType(endpointType)) return endpointType
  throw new Error('The confirmed model has no supported Agent endpoint.')
}

/**
 * Chat history compacts through the same transport the chat turn itself uses.
 * Image and unsupported transports return null: those turns either carry no
 * compactable history route or were already rejected during preflight.
 */
function chatCompactionEndpoint(
  transport: ModelDescriptor['preferredChatTransport']
): ConversationCompactionEndpoint | null {
  switch (transport) {
    case 'responses': return 'openai-response'
    case 'chat-completions': return 'openai'
    case 'anthropic': return 'anthropic'
    case 'gemini': return 'gemini'
    default: return null
  }
}

/**
 * Keep the server declaration order for fallbacks, but honor an explicit
 * provider contract for the primary Agent protocol (for example xAI uses
 * Responses even when NewAPI lists Chat Completions first).
 */
function orderedAgentEndpointTypes(
  model: Pick<ModelDescriptor, 'endpointTypes' | 'preferredAgentEndpoint'>
): AgentEndpointType[] {
  const declared = declaredModelAgentEndpoints(model.endpointTypes)
  const preferred = model.preferredAgentEndpoint
  if (preferred === undefined || preferred === null || !declared.includes(preferred)) {
    return declared
  }
  return [preferred, ...declared.filter((candidate) => candidate !== preferred)]
}

function buildConfirmedModelRequestUrl(
  baseUrl: string,
  endpointType: ModelEndpointType,
  model: string,
  endpointPath?: string,
): string {
  switch (endpointType) {
    case 'openai':
      return buildChatCompletionsRequestUrl(baseUrl, endpointPath)
    case 'openai-response':
      return buildResponsesRequestUrl(baseUrl, endpointPath)
    case 'anthropic':
      return buildAnthropicMessagesRequestUrl(baseUrl, endpointPath)
    case 'gemini':
      return buildGeminiContentRequestUrl(baseUrl, model, endpointPath)
    case 'image-generation':
      return buildImagesGenerationRequestUrl(baseUrl, endpointPath)
    case 'openai-response-compact':
    case 'embeddings':
    case 'openai-video':
      throw new RelayServiceError('invalid_configuration')
  }
}

function isCodeReviewPrompt(value: string): boolean {
  return /^\/review(?:\s|$)/iu.test(value.trimStart())
}

function codeReviewPrompt(value: string): string {
  const focus = value.trimStart().replace(/^\/review(?:\s+|$)/iu, '').trim()
  return [
    'Review the current authorized workspace changes.',
    'Start by requesting the bounded Git diff, then inspect only the minimum additional files needed.',
    focus ? `User focus: ${focus}` : '',
  ].filter(Boolean).join('\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyAllowedKeys<K extends string>(
  value: unknown,
  allowedKeys: readonly K[],
): value is Record<K, unknown> {
  return isObject(value) && Object.keys(value).every((key) => allowedKeys.includes(key as K))
}
