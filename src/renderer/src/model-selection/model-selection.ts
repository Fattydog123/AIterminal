import type {
  ApiResult,
  ModelDescriptor,
  ModelEndpointTransport,
  ModelEndpointType,
  ModelListInput,
  ModelWireMode,
  ReasoningEffort,
  RemoteRelayOverviewDto,
  RemoteRelayTokenPageDto,
  WorkspaceMode,
} from '../../../shared/contracts.ts'
import { isModelDelegationCompatible } from '../../../shared/contracts.ts'
import { WZH_RELAY_PROFILE_HANDLE } from '../../../shared/server-config.ts'
import { relayAccountName } from '../relay-identity.ts'

export type ModelCatalogState = 'preview' | 'idle' | 'loading' | 'remote' | 'error'
export type ModelCapability = 'webSearch' | 'imageGeneration' | 'localSubagents'

export interface ModelOption {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly wireMode: ModelWireMode
  readonly endpointTypes: readonly ModelEndpointType[]
  readonly endpointTransport: ModelEndpointTransport
  readonly reasoning: readonly ReasoningEffort[]
  readonly subagents: boolean
  readonly localSubagentsAllowed: boolean
  readonly webSearchAllowed: boolean
  readonly imageGenerationAllowed: boolean
}

export interface RelayGroupOption {
  readonly id: string
  readonly ratio: number | string | null
  readonly description: string | null
}

export interface ReasoningOption {
  readonly effort: ReasoningEffort
  readonly label: string
}

export interface ModelSelectionSnapshot {
  readonly mode: WorkspaceMode
  readonly groups: readonly RelayGroupOption[]
  readonly groupId: string
  readonly models: readonly ModelOption[]
  readonly selectedModel: ModelOption | null
  readonly accountName: string
  readonly catalog: {
    readonly state: ModelCatalogState
    readonly message: string
    readonly connected: boolean
    readonly connectionLabel: string
  }
  readonly reasoning: {
    readonly effort: ReasoningEffort
    readonly label: string
    readonly options: readonly ReasoningOption[]
    readonly notice: string
  }
  readonly capabilities: {
    readonly webSearch: CapabilitySelection
    readonly imageGeneration: CapabilitySelection & { readonly locked: boolean }
    readonly localSubagents: CapabilitySelection
    readonly notice: string
  }
}

interface CapabilitySelection {
  readonly enabled: boolean
  readonly available: boolean
}

export type ModelSelectionBootstrap =
  | {
      readonly models: readonly ModelDescriptor[]
      readonly activeModelId: string
      readonly reasoning: ReasoningEffort
      readonly profileHandle: string
      readonly profileHasKey: boolean
    }
  | { readonly error: string }

export interface ModelSelectionAdapter {
  getOverview(): Promise<ApiResult<RemoteRelayOverviewDto>>
  listTokens(): Promise<ApiResult<RemoteRelayTokenPageDto>>
  listModels(input: ModelListInput): Promise<ApiResult<ModelDescriptor[]>>
}

export interface ModelSelectionActions {
  initialize(input: ModelSelectionBootstrap): Promise<void>
  selectMode(mode: WorkspaceMode): Promise<void>
  selectGroup(groupId: string): Promise<void>
  selectModel(modelId: string): void
  selectReasoning(effort: ReasoningEffort): void
  setCapability(capability: ModelCapability, enabled: boolean): void
  refreshCatalog(): Promise<{ ok: boolean; message: string }>
  syncAccount(): Promise<void>
  reloadAccount(): Promise<void>
}

export interface ModelSelectionController {
  readonly actions: ModelSelectionActions
  getSnapshot(): ModelSelectionSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface CreateModelSelectionOptions {
  readonly runtime: 'desktop' | 'preview' | 'disconnected'
  readonly adapter?: ModelSelectionAdapter
}

interface MutableModelSelectionState {
  mode: WorkspaceMode
  rawGroups: RelayGroupOption[]
  groups: RelayGroupOption[]
  accountGroupId: string | null
  groupId: string
  models: ModelOption[]
  selectedModelId: string
  accountName: string
  catalogState: ModelCatalogState
  catalogMessage: string
  confirmedMode: WorkspaceMode | null
  confirmedGroupId: string | null | undefined
  reasoning: ReasoningEffort
  reasoningNotice: string
  webSearch: boolean
  imageGeneration: boolean
  localSubagents: boolean
  profileHandle: string
  profileHasKey: boolean
  accountCatalogFingerprint: string
  tokenCatalogFingerprint: string
}

const REASONING_OPTIONS: readonly ReasoningOption[] = Object.freeze([
  { effort: 'auto', label: 'Auto' },
  { effort: 'none', label: 'None' },
  { effort: 'minimal', label: 'Minimal' },
  { effort: 'light', label: 'Light' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra High' },
  { effort: 'max', label: 'Max' },
  { effort: 'ultra', label: 'Ultra' },
])

const PREVIEW_GROUPS: RelayGroupOption[] = [
  { id: 'auto', ratio: '自动', description: '自动选择可用渠道' },
  { id: 'default', ratio: 1, description: '默认分组' },
]

const PREVIEW_MODELS: ModelOption[] = [
  { id: 'gpt-5.6-sol-ultra', name: 'GPT-5.6 Sol Ultra', detail: 'Responses · 并行子任务 · 视觉 · 工具', wireMode: 'standard', endpointTypes: ['openai-response'], endpointTransport: 'responses', reasoning: ['auto', 'light', 'medium', 'high', 'xhigh', 'max', 'ultra'], subagents: true, localSubagentsAllowed: true, webSearchAllowed: true, imageGenerationAllowed: true },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', detail: 'Responses Lite · 编程与长任务', wireMode: 'lite', endpointTypes: ['openai-response'], endpointTransport: 'responses', reasoning: ['auto', 'light', 'medium', 'high', 'xhigh'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: false, imageGenerationAllowed: false },
  { id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', detail: 'Responses · 软件工程', wireMode: 'standard', endpointTypes: ['openai-response'], endpointTransport: 'responses', reasoning: ['auto', 'light', 'medium', 'high', 'xhigh'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: true, imageGenerationAllowed: false },
  { id: 'gpt-5.4', name: 'GPT-5.4', detail: 'Responses · 通用推理', wireMode: 'standard', endpointTypes: ['openai-response'], endpointTransport: 'responses', reasoning: ['auto', 'light', 'medium', 'high'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: false, imageGenerationAllowed: false },
  { id: 'o4-mini', name: 'o4-mini', detail: 'Responses · 快速推理', wireMode: 'standard', endpointTypes: ['openai-response'], endpointTransport: 'responses', reasoning: ['auto', 'light', 'medium', 'high'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: false, imageGenerationAllowed: false },
]

function reasoningLabel(effort: ReasoningEffort): string {
  return REASONING_OPTIONS.find((option) => option.effort === effort)?.label ?? 'Auto'
}

function modelEndpointTypeLabel(endpointType: ModelEndpointType, wireMode: ModelWireMode): string | null {
  if (endpointType === 'openai') return 'Chat Completions'
  if (endpointType === 'openai-response') return wireMode === 'lite' ? 'Responses Lite' : 'Responses'
  if (endpointType === 'openai-response-compact') return 'Responses Compact'
  if (endpointType === 'anthropic') return 'Anthropic Messages'
  if (endpointType === 'gemini') return 'Gemini'
  if (endpointType === 'image-generation') return 'Images'
  return null
}

function modelTransportLabel(transport: ModelEndpointTransport): string {
  if (transport === 'chat-completions') return 'Chat Completions'
  if (transport === 'responses') return 'Responses'
  if (transport === 'anthropic') return 'Anthropic Messages'
  if (transport === 'gemini') return 'Gemini'
  if (transport === 'images') return 'Images'
  if (transport === 'responses-compact') return 'Responses Compact'
  return '接口未接通'
}

function modelProtocolSummary(
  endpointTypes: readonly ModelEndpointType[],
  preferredTransport: ModelEndpointTransport,
  wireMode: ModelWireMode,
): string {
  const labels = endpointTypes
    .map((endpointType) => modelEndpointTypeLabel(endpointType, wireMode))
    .filter((label): label is string => Boolean(label))
  return labels.length > 0 ? [...new Set(labels)].join(' / ') : modelTransportLabel(preferredTransport)
}

function toModelOptions(models: readonly ModelDescriptor[]): ModelOption[] {
  return models.map((entry) => {
    const delegationCompatible = isModelDelegationCompatible(entry)
    return {
      id: entry.id,
      name: entry.label,
      detail: [
        modelProtocolSummary(entry.endpointTypes, entry.preferredChatTransport, entry.wireMode),
        delegationCompatible ? '自动子智能体' : '',
        entry.capabilities.imageInput ? '视觉' : '',
        entry.capabilities.toolUse ? '工具' : '',
        entry.capabilities.webSearch ? '联网' : '',
      ].filter(Boolean).join(' · ') || (
        entry.source === 'remote' && entry.declaredCapabilities !== undefined
          ? '能力由 endpoint 在请求时验证'
          : '对话'
      ),
      wireMode: entry.wireMode,
      endpointTypes: [...entry.endpointTypes],
      endpointTransport: entry.preferredChatTransport,
      reasoning: [...entry.reasoning],
      subagents: entry.capabilities.subagents,
      localSubagentsAllowed: delegationCompatible,
      webSearchAllowed: entry.capabilities.webSearch,
      imageGenerationAllowed: entry.capabilities.imageGeneration,
    }
  })
}

function sortGroups(overview: RemoteRelayOverviewDto): RelayGroupOption[] {
  const accountGroup = overview.account.group
  return [...overview.groups]
    .sort((left, right) => {
      const priority = (id: string): number => id === accountGroup ? 0 : id === 'auto' ? 1 : 2
      return priority(left.id) - priority(right.id) || left.id.localeCompare(right.id)
    })
    .map((group) => ({ ...group }))
}

function accountCatalogFingerprint(overview: RemoteRelayOverviewDto): string {
  return JSON.stringify({
    accountId: overview.account.id,
    accountGroup: overview.account.group,
    groups: [...overview.groups]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((group) => [group.id, group.ratio, group.description]),
    models: [...overview.models].sort((left, right) => left.localeCompare(right)),
  })
}

function tokenCatalogFingerprint(page: RemoteRelayTokenPageDto): string {
  return JSON.stringify({
    total: page.total,
    items: [...page.items]
      .sort((left, right) => left.id - right.id)
      .map((token) => [
        token.id,
        token.status,
        token.group,
        token.modelLimits,
        token.unlimitedQuota,
        token.expiresAt,
      ]),
  })
}

function initialState(runtime: CreateModelSelectionOptions['runtime']): MutableModelSelectionState {
  const preview = runtime === 'preview'
  return {
    mode: 'agent',
    rawGroups: preview ? [...PREVIEW_GROUPS] : [],
    groups: preview ? [...PREVIEW_GROUPS] : [],
    accountGroupId: null,
    groupId: preview ? 'auto' : '',
    models: preview ? [...PREVIEW_MODELS] : [],
    selectedModelId: preview ? PREVIEW_MODELS[0]!.id : '',
    accountName: '',
    catalogState: preview ? 'preview' : 'idle',
    catalogMessage: runtime === 'desktop'
      ? '尚未读取模型目录。'
      : preview
        ? '测试预览未访问模型服务。'
        : '等待桌面客户端连接账户。',
    confirmedMode: null,
    confirmedGroupId: undefined,
    reasoning: preview ? 'ultra' : 'auto',
    reasoningNotice: '',
    webSearch: true,
    imageGeneration: false,
    localSubagents: false,
    profileHandle: '',
    profileHasKey: false,
    accountCatalogFingerprint: '',
    tokenCatalogFingerprint: '',
  }
}

class ModelSelectionControllerImplementation implements ModelSelectionController {
  readonly actions: ModelSelectionActions
  private readonly runtime: CreateModelSelectionOptions['runtime']
  private readonly adapter: ModelSelectionAdapter | undefined
  private readonly listeners = new Set<() => void>()
  private state: MutableModelSelectionState
  private snapshot!: ModelSelectionSnapshot
  private accountGeneration = 0
  private modeGeneration = 0
  private catalogGeneration = 0
  private accountRefreshesInFlight = 0
  private disposed = false

  constructor(options: CreateModelSelectionOptions) {
    this.runtime = options.runtime
    this.adapter = options.adapter
    this.state = initialState(options.runtime)
    this.actions = Object.freeze({
      initialize: (input: ModelSelectionBootstrap) => this.initialize(input),
      selectMode: (mode: WorkspaceMode) => this.selectMode(mode),
      selectGroup: (groupId: string) => this.selectGroup(groupId),
      selectModel: (modelId: string) => this.selectModel(modelId),
      selectReasoning: (effort: ReasoningEffort) => this.selectReasoning(effort),
      setCapability: (capability: ModelCapability, enabled: boolean) => this.setCapability(capability, enabled),
      refreshCatalog: () => this.refreshCatalog(),
      syncAccount: () => this.syncAccount(),
      reloadAccount: () => this.reloadAccount(),
    })
    this.publish()
  }

  getSnapshot = (): ModelSelectionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.accountGeneration += 1
    this.modeGeneration += 1
    this.catalogGeneration += 1
    this.listeners.clear()
  }

  private publish(): void {
    if (this.disposed) return
    const selectedModel = this.state.models.find((model) => model.id === this.state.selectedModelId) ?? null
    const catalogConfirmed = this.runtime === 'preview' || (
      this.state.catalogState === 'remote' &&
      this.state.confirmedMode === this.state.mode &&
      this.state.confirmedGroupId === this.state.groupId
    )
    if (selectedModel) {
      if (!selectedModel.reasoning.includes(this.state.reasoning)) {
        const unsupportedLabel = reasoningLabel(this.state.reasoning)
        this.state.reasoning = 'auto'
        this.state.reasoningNotice = `${selectedModel.name} 不支持 ${unsupportedLabel}，已改用 Auto。`
      }
      if (!selectedModel.webSearchAllowed) this.state.webSearch = false
      if (!selectedModel.imageGenerationAllowed) this.state.imageGeneration = false
      // Delegation is selected by the confirmed Agent model, never by a
      // renderer toggle. Keep the mutable field only as a compatibility
      // projection for older callers of this controller.
      this.state.localSubagents = this.state.mode === 'agent' &&
        catalogConfirmed &&
        selectedModel.localSubagentsAllowed
      if (selectedModel.endpointTransport === 'images') this.state.imageGeneration = true
    } else {
      this.state.localSubagents = false
    }

    const supportedReasoning = selectedModel?.reasoning ?? ['auto']
    const imagesOnly = selectedModel?.endpointTransport === 'images'
    const imageGenerationEnabled = Boolean(imagesOnly || this.state.imageGeneration)
    const compatibilityNotice = selectedModel?.wireMode === 'lite'
      ? '当前模型使用 Responses Lite，已关闭联网搜索和图片生成。需要这些能力时，请切换到支持它们的标准模型。'
      : imagesOnly
        ? '当前选择为 Images 模型，图片生成固定开启；Chat 附件入口已停用，参考图或图片编辑请转到 Studio。'
        : this.state.imageGeneration && selectedModel?.endpointTypes.includes('image-generation')
          ? `当前已开启图片生成，本轮将使用 Images；关闭后普通对话使用 ${modelTransportLabel(selectedModel.endpointTransport)}。`
          : ''
    const connected = this.state.catalogState === 'remote'
      && this.state.confirmedMode === this.state.mode
      && this.state.confirmedGroupId === this.state.groupId
    const connectionLabel = this.runtime !== 'desktop'
      ? this.runtime === 'preview' ? '测试预览' : '需要桌面客户端'
      : connected
        ? '模型已连接'
        : this.state.catalogState === 'loading'
          ? '正在读取可用模型'
          : this.state.catalogState === 'error'
            ? '模型服务暂不可用'
            : '模型未就绪'

    this.snapshot = {
      mode: this.state.mode,
      groups: [...this.state.groups],
      groupId: this.state.groupId,
      models: [...this.state.models],
      selectedModel,
      accountName: this.state.accountName,
      catalog: {
        state: this.state.catalogState,
        message: this.state.catalogMessage,
        connected,
        connectionLabel,
      },
      reasoning: {
        effort: this.state.reasoning,
        label: reasoningLabel(this.state.reasoning),
        options: REASONING_OPTIONS.filter((option) => supportedReasoning.includes(option.effort)),
        notice: this.state.reasoningNotice,
      },
      capabilities: {
        webSearch: {
          enabled: this.state.webSearch,
          available: selectedModel?.webSearchAllowed ?? false,
        },
        imageGeneration: {
          enabled: imageGenerationEnabled,
          available: selectedModel?.imageGenerationAllowed ?? false,
          locked: imagesOnly,
        },
        localSubagents: {
          enabled: this.state.localSubagents,
          available: this.state.mode === 'agent' &&
            catalogConfirmed &&
            (selectedModel?.localSubagentsAllowed ?? false),
        },
        notice: compatibilityNotice,
      },
    }
    for (const listener of this.listeners) listener()
  }

  private async initialize(input: ModelSelectionBootstrap): Promise<void> {
    if ('error' in input) {
      this.accountGeneration += 1
      this.modeGeneration += 1
      this.catalogGeneration += 1
      this.state.rawGroups = []
      this.state.groups = []
      this.state.models = []
      this.state.selectedModelId = ''
      this.state.accountName = ''
      this.state.profileHandle = ''
      this.state.profileHasKey = false
      this.state.confirmedMode = null
      this.state.confirmedGroupId = undefined
      this.state.catalogState = 'error'
      this.state.catalogMessage = input.error
      this.publish()
      return
    }
    this.state.profileHandle = input.profileHandle
    this.state.profileHasKey = input.profileHasKey
    this.state.models = toModelOptions(input.models)
    this.state.selectedModelId = this.state.models.some((model) => model.id === input.activeModelId)
      ? input.activeModelId
      : this.state.models[0]?.id ?? ''
    this.state.reasoning = input.reasoning
    this.state.reasoningNotice = ''
    this.state.catalogState = 'idle'
    this.state.catalogMessage = input.profileHasKey
      ? '正在读取可用分组和模型。'
      : '尚未登录账户。'
    if (input.profileHandle !== WZH_RELAY_PROFILE_HANDLE || !input.profileHasKey) {
      this.accountGeneration += 1
      this.modeGeneration += 1
      this.catalogGeneration += 1
      this.state.rawGroups = []
      this.state.groups = []
      this.state.models = []
      this.state.selectedModelId = ''
      this.state.accountName = ''
      this.state.confirmedMode = null
      this.state.confirmedGroupId = undefined
    }
    this.publish()
    if (input.profileHandle === WZH_RELAY_PROFILE_HANDLE && input.profileHasKey) {
      await this.reloadAccount()
    }
  }

  private async selectMode(mode: WorkspaceMode): Promise<void> {
    if (mode === this.state.mode || this.disposed) return
    this.modeGeneration += 1
    this.catalogGeneration += 1
    this.state.mode = mode
    this.state.groups = []
    this.state.models = []
    this.state.selectedModelId = ''
    this.state.confirmedMode = null
    this.state.confirmedGroupId = undefined
    this.state.catalogState = 'idle'
    this.state.catalogMessage = `正在读取 ${mode === 'agent' ? 'Agent' : 'Chat'} 模式的可用模型。`
    this.publish()
    if (this.isRemoteReady() && this.state.rawGroups.length > 0) await this.loadModeGroups()
  }

  private async selectGroup(groupId: string): Promise<void> {
    if (
      this.disposed
      || groupId === this.state.groupId
      || !this.state.groups.some((group) => group.id === groupId)
    ) return
    this.state.groupId = groupId
    this.state.models = []
    this.state.selectedModelId = ''
    this.state.confirmedMode = null
    this.state.confirmedGroupId = undefined
    this.state.catalogState = 'idle'
    this.state.catalogMessage = `正在读取 ${groupId} 分组的可用模型。`
    this.publish()
    await this.refreshCatalog()
  }

  private selectModel(modelId: string): void {
    if (!this.state.models.some((model) => model.id === modelId)) return
    this.state.selectedModelId = modelId
    this.publish()
  }

  private selectReasoning(effort: ReasoningEffort): void {
    this.state.reasoning = effort
    this.state.reasoningNotice = ''
    this.publish()
  }

  private setCapability(capability: ModelCapability, enabled: boolean): void {
    const selectedModel = this.state.models.find((model) => model.id === this.state.selectedModelId)
    if (capability === 'webSearch') {
      if (!enabled || selectedModel?.webSearchAllowed) this.state.webSearch = enabled
    } else if (capability === 'imageGeneration') {
      if (selectedModel?.endpointTransport !== 'images' && (!enabled || selectedModel?.imageGenerationAllowed)) {
        this.state.imageGeneration = enabled
      }
    } else if (capability === 'localSubagents') {
      // Kept for backwards-compatible action payloads. The value is ignored;
      // publish() derives the projection from the confirmed Agent model.
    }
    this.publish()
  }

  private isRemoteReady(): boolean {
    return this.runtime === 'desktop'
      && this.adapter !== undefined
      && this.state.profileHandle === WZH_RELAY_PROFILE_HANDLE
      && this.state.profileHasKey
  }

  private selectPreferredGroup(groups: readonly RelayGroupOption[]): string {
    return [
      this.state.groupId,
      this.state.accountGroupId,
      'auto',
      ...groups.map((group) => group.id),
    ].find((groupId): groupId is string => (
      groupId !== null && groups.some((group) => group.id === groupId)
    )) ?? ''
  }

  private applyCatalog(groupId: string, descriptors: readonly ModelDescriptor[], mode: WorkspaceMode): void {
    const options = toModelOptions(descriptors)
    this.state.groupId = groupId
    this.state.models = options
    this.state.selectedModelId = options.some((model) => model.id === this.state.selectedModelId)
      ? this.state.selectedModelId
      : options[0]?.id ?? ''
    this.state.confirmedMode = mode
    this.state.confirmedGroupId = groupId
    this.state.catalogState = 'remote'
    this.state.catalogMessage = `已读取 ${groupId} 分组的 ${options.length} 个模型。`
    this.publish()
  }

  private async syncAccount(): Promise<void> {
    if (!this.isRemoteReady() || this.accountRefreshesInFlight > 0) return
    this.accountRefreshesInFlight += 1
    const generation = ++this.accountGeneration
    try {
      const tokenResult = await this.adapter!.listTokens()
      if (this.disposed || generation !== this.accountGeneration || !tokenResult.ok) return
      const nextTokenFingerprint = tokenCatalogFingerprint(tokenResult.value)
      if (
        nextTokenFingerprint === this.state.tokenCatalogFingerprint &&
        this.state.catalogState !== 'error'
      ) return

      const result = await this.adapter!.getOverview()
      if (this.disposed || generation !== this.accountGeneration || !result.ok) return

      const fingerprint = accountCatalogFingerprint(result.value)
      const groups = sortGroups(result.value)
      this.state.accountName = relayAccountName(result.value.account)
      this.state.accountGroupId = result.value.account.group
      this.state.accountCatalogFingerprint = fingerprint
      this.state.rawGroups = groups
      this.state.groupId = this.selectPreferredGroup(groups)
      if (groups.length === 0) {
        this.state.tokenCatalogFingerprint = nextTokenFingerprint
        this.modeGeneration += 1
        this.catalogGeneration += 1
        this.state.groups = []
        this.state.models = []
        this.state.selectedModelId = ''
        this.state.confirmedMode = null
        this.state.confirmedGroupId = undefined
        this.state.catalogState = 'error'
        this.state.catalogMessage = '当前账户没有由有效访问令牌支持的接入分组，请先创建或启用令牌。'
        this.publish()
        return
      }
      if (await this.loadModeGroups()) {
        this.state.tokenCatalogFingerprint = nextTokenFingerprint
      }
    } catch {
      // Background synchronization is best-effort. Keep the last confirmed
      // selection intact and let the next focus or explicit refresh retry.
    } finally {
      this.accountRefreshesInFlight -= 1
    }
  }

  private async reloadAccount(): Promise<void> {
    this.accountRefreshesInFlight += 1
    try {
      await this.reloadAccountNow()
    } finally {
      this.accountRefreshesInFlight -= 1
    }
  }

  private async reloadAccountNow(): Promise<void> {
    this.accountGeneration += 1
    this.modeGeneration += 1
    this.catalogGeneration += 1
    const generation = this.accountGeneration
    this.state.rawGroups = []
    this.state.groups = []
    this.state.models = []
    this.state.selectedModelId = ''
    this.state.confirmedMode = null
    this.state.confirmedGroupId = undefined
    if (!this.isRemoteReady()) {
      this.state.accountName = ''
      this.state.catalogState = this.runtime === 'preview' ? 'preview' : 'error'
      this.state.catalogMessage = this.runtime === 'desktop'
        ? '请先登录账户。'
        : this.runtime === 'preview'
          ? '测试预览不允许访问模型服务。'
          : '请使用桌面客户端连接模型服务。'
      this.publish()
      return
    }

    this.state.catalogState = 'loading'
    this.state.catalogMessage = '正在读取可用分组和模型。'
    this.publish()
    try {
      const [result, tokenResult] = await Promise.all([
        this.adapter!.getOverview(),
        this.adapter!.listTokens(),
      ])
      if (this.disposed || generation !== this.accountGeneration) return
      if (!result.ok) {
        this.state.catalogState = 'error'
        this.state.catalogMessage = result.error.message
        this.publish()
        return
      }
      const groups = sortGroups(result.value)
      this.state.accountName = relayAccountName(result.value.account)
      this.state.accountGroupId = result.value.account.group
      this.state.accountCatalogFingerprint = accountCatalogFingerprint(result.value)
      const nextTokenFingerprint = tokenResult.ok
        ? tokenCatalogFingerprint(tokenResult.value)
        : null
      if (nextTokenFingerprint !== null) {
        this.state.tokenCatalogFingerprint = nextTokenFingerprint
      }
      this.state.rawGroups = groups
      this.state.groupId = this.selectPreferredGroup(groups)
      if (groups.length === 0) {
        if (nextTokenFingerprint !== null) {
          this.state.tokenCatalogFingerprint = nextTokenFingerprint
        }
        this.state.catalogState = 'error'
        this.state.catalogMessage = '当前账户没有由有效访问令牌支持的接入分组，请先创建或启用令牌。'
        this.publish()
        return
      }
      await this.loadModeGroups()
    } catch {
      if (this.disposed || generation !== this.accountGeneration) return
      this.state.catalogState = 'error'
      this.state.catalogMessage = '账户分组暂时无法读取，请重试。'
      this.publish()
    }
  }

  private async loadModeGroups(): Promise<boolean> {
    if (!this.isRemoteReady() || this.state.rawGroups.length === 0) return false
    const generation = ++this.modeGeneration
    this.catalogGeneration += 1
    const requestMode = this.state.mode
    const requestedGroupId = this.selectPreferredGroup(this.state.rawGroups)
    const primary = this.state.rawGroups.find((group) => group.id === requestedGroupId)
    const catalogs = new Map<string, readonly ModelDescriptor[]>()
    const eligibleGroups: RelayGroupOption[] = []
    const failedGroupIds: string[] = []
    this.state.groups = []
    this.state.confirmedMode = null
    this.state.confirmedGroupId = undefined
    this.state.catalogState = 'loading'
    this.state.catalogMessage = `正在检查 ${requestMode === 'agent' ? 'Agent' : 'Chat'} 模式的可用分组。`
    this.publish()

    const load = async (groupId: string): Promise<readonly ModelDescriptor[]> => {
      const result = await this.adapter!.listModels({
        profileHandle: WZH_RELAY_PROFILE_HANDLE,
        mode: requestMode,
        groupId,
      })
      if (!result.ok) throw new Error('model catalog unavailable')
      return result.value
    }
    const stale = (): boolean => this.disposed
      || generation !== this.modeGeneration
      || requestMode !== this.state.mode

    if (primary) {
      try {
        const models = await load(primary.id)
        if (stale()) return false
        if (models.length > 0) {
          catalogs.set(primary.id, models)
          eligibleGroups.push(primary)
          this.state.groups = [primary]
          this.applyCatalog(primary.id, models, requestMode)
        }
      } catch {
        if (stale()) return false
        failedGroupIds.push(primary.id)
        this.state.groups = [primary]
        this.state.groupId = primary.id
        this.state.models = []
        this.state.selectedModelId = ''
        this.state.confirmedMode = requestMode
        this.state.confirmedGroupId = primary.id
        this.state.catalogState = 'error'
        this.state.catalogMessage = '当前分组的模型目录暂时无法读取，请重试。'
        this.publish()
      }
    }

    for (const group of this.state.rawGroups) {
      if (group.id === primary?.id) continue
      try {
        const models = await load(group.id)
        if (stale()) return false
        if (models.length > 0) {
          catalogs.set(group.id, models)
          eligibleGroups.push(group)
        }
      } catch {
        if (stale()) return false
        failedGroupIds.push(group.id)
      }
    }
    if (stale()) return false

    const eligibleGroupIds = new Set(eligibleGroups.map((group) => group.id))
    const failedGroupIdSet = new Set(failedGroupIds)
    // A temporary catalog failure must not remove a token-backed group from
    // the selector. Keep it available for an explicit retry, while successful
    // empty catalogs remain hidden because they are ineligible for this mode.
    this.state.groups = this.state.rawGroups.filter((group) => (
      eligibleGroupIds.has(group.id) || failedGroupIdSet.has(group.id)
    ))
    if (primary && failedGroupIdSet.has(primary.id)) {
      this.state.groupId = primary.id
      this.state.models = []
      this.state.selectedModelId = ''
      this.state.confirmedMode = requestMode
      this.state.confirmedGroupId = primary.id
      this.state.catalogState = 'error'
      this.state.catalogMessage = '当前分组的模型目录暂时无法读取，请重试。'
      this.publish()
      return false
    }
    const preferredGroupId = [
      requestedGroupId,
      this.state.accountGroupId,
      'auto',
      ...eligibleGroups.map((group) => group.id),
    ].find((groupId): groupId is string => (
      groupId !== null && eligibleGroups.some((group) => group.id === groupId)
    ))
    if (!preferredGroupId) {
      this.state.groupId = ''
      this.state.models = []
      this.state.selectedModelId = ''
      this.state.confirmedMode = requestMode
      this.state.confirmedGroupId = null
      this.state.catalogState = 'error'
      this.state.catalogMessage = failedGroupIds.length > 0
        ? '当前模式没有可用分组，部分分组暂时无法读取。'
        : `当前模式没有可用的${requestMode === 'agent' ? ' Agent' : ' Chat'}分组。`
      this.publish()
      return false
    }

    this.applyCatalog(preferredGroupId, catalogs.get(preferredGroupId) ?? [], requestMode)
    return failedGroupIds.length === 0
  }

  private async refreshCatalog(): Promise<{ ok: boolean; message: string }> {
    if (!this.isRemoteReady()) {
      const message = this.runtime === 'preview'
        ? '测试预览不允许访问模型服务。'
        : this.runtime === 'desktop'
          ? '请先登录账户。'
          : '请使用桌面客户端连接模型服务。'
      this.state.catalogState = this.runtime === 'preview' ? 'preview' : 'error'
      this.state.catalogMessage = message
      this.publish()
      return { ok: false, message }
    }
    const requestGroupId = this.state.groupId
    if (!requestGroupId) {
      const message = '尚未读取可用接入分组，请稍后重试。'
      this.state.catalogState = 'error'
      this.state.catalogMessage = message
      this.publish()
      return { ok: false, message }
    }

    const generation = ++this.catalogGeneration
    this.modeGeneration += 1
    const requestMode = this.state.mode
    const requestProfileHandle = this.state.profileHandle
    this.state.catalogState = 'loading'
    this.state.confirmedMode = null
    this.state.confirmedGroupId = undefined
    this.state.catalogMessage = '等待 endpoint 批准并读取模型目录...'
    this.publish()
    try {
      const result = await this.adapter!.listModels({
        profileHandle: requestProfileHandle,
        mode: requestMode,
        groupId: requestGroupId,
      })
      if (
        this.disposed
        || generation !== this.catalogGeneration
        || requestMode !== this.state.mode
        || requestGroupId !== this.state.groupId
      ) return { ok: false, message: '模型目录选择已变化。' }
      if (!result.ok) {
        this.state.models = []
        this.state.selectedModelId = ''
        this.state.catalogState = 'error'
        this.state.catalogMessage = result.error.message
        this.publish()
        return { ok: false, message: result.error.message }
      }
      if (result.value.length === 0) {
        const message = requestMode === 'agent'
          ? '当前分组没有可运行的 Agent 模型，请切换到支持对话接口的分组。'
          : '当前分组没有声明客户端已支持的对话或图片接口。'
        this.state.models = []
        this.state.selectedModelId = ''
        this.state.catalogState = 'error'
        this.state.catalogMessage = message
        this.publish()
        return { ok: false, message }
      }
      this.applyCatalog(requestGroupId, result.value, requestMode)
      return { ok: true, message: this.state.catalogMessage }
    } catch {
      if (this.disposed || generation !== this.catalogGeneration) {
        return { ok: false, message: '模型目录选择已变化。' }
      }
      const message = '模型目录请求未完成，请重试。'
      this.state.catalogState = 'error'
      this.state.catalogMessage = message
      this.publish()
      return { ok: false, message }
    }
  }
}

export function createModelSelectionController(options: CreateModelSelectionOptions): ModelSelectionController {
  if (options.runtime === 'desktop' && !options.adapter) {
    throw new Error('desktop model selection requires an adapter')
  }
  return new ModelSelectionControllerImplementation(options)
}
