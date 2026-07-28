import type { StudioBridge } from '../studio/shared/contracts'

export const API_SCHEMA_VERSION = 1 as const

export type WorkspaceMode = 'chat' | 'agent'
export type ModelWireMode = 'standard' | 'lite'
/**
 * Endpoint kinds published by NewAPI.  The final two values are retained as
 * declarations so a catalog can explain why a model is unavailable, but they
 * are not selectable conversation transports in this release.
 */
export const MODEL_ENDPOINT_TYPES = Object.freeze([
  'openai',
  'openai-response',
  'openai-response-compact',
  'anthropic',
  'gemini',
  'image-generation',
  'embeddings',
  'openai-video'
] as const)
export type ModelEndpointType = (typeof MODEL_ENDPOINT_TYPES)[number]

export const MODEL_CONVERSATION_ENDPOINT_TYPES = Object.freeze([
  'openai',
  'openai-response',
  'openai-response-compact',
  'anthropic',
  'gemini'
] as const)

export const MODEL_AGENT_ENDPOINT_TYPES = Object.freeze([
  'openai-response',
  'openai',
  'anthropic',
  'gemini'
] as const satisfies readonly ModelEndpointType[])
export type ModelAgentEndpointType = (typeof MODEL_AGENT_ENDPOINT_TYPES)[number]

export function declaredModelAgentEndpoints(
  endpoints: readonly ModelEndpointType[]
): ModelAgentEndpointType[] {
  return endpoints.filter((endpoint): endpoint is ModelAgentEndpointType => (
    (MODEL_AGENT_ENDPOINT_TYPES as readonly ModelEndpointType[]).includes(endpoint)
  ))
}

export type ModelEndpointTransport =
  | 'chat-completions'
  | 'responses'
  | 'responses-compact'
  | 'anthropic'
  | 'gemini'
  | 'images'
  | 'unsupported'

export function isModelEndpointType(value: unknown): value is ModelEndpointType {
  return typeof value === 'string' &&
    (MODEL_ENDPOINT_TYPES as readonly string[]).includes(value)
}

export function modelEndpointTransport(
  endpoint: ModelEndpointType | null,
  options: { compactSupported?: boolean } = {}
): ModelEndpointTransport {
  if (endpoint === 'openai') return 'chat-completions'
  if (endpoint === 'openai-response') return 'responses'
  if (endpoint === 'openai-response-compact') {
    return options.compactSupported === true ? 'responses-compact' : 'unsupported'
  }
  if (endpoint === 'anthropic') return 'anthropic'
  if (endpoint === 'gemini') return 'gemini'
  if (endpoint === 'image-generation') return 'images'
  return 'unsupported'
}

export function preferredModelEndpoint(
  endpoints: readonly ModelEndpointType[],
  options: { compactSupported?: boolean } = {}
): ModelEndpointType | null {
  // NewAPI returns endpoint types in the provider's supported order. Keep
  // that order for conversation transports instead of imposing a global
  // protocol preference (for example, forcing an Anthropic channel through
  // Chat Completions). Image-only and non-conversation declarations are
  // considered only after a usable conversation endpoint is absent.
  const conversationEndpoint = endpoints.find((endpoint) => {
    if (endpoint === 'openai-response-compact') return options.compactSupported === true
    return endpoint === 'openai-response' ||
      endpoint === 'openai' ||
      endpoint === 'anthropic' ||
      endpoint === 'gemini'
  })
  if (conversationEndpoint !== undefined) return conversationEndpoint
  if (endpoints.includes('image-generation')) return 'image-generation'
  return endpoints.find((endpoint) => (
    endpoint === 'openai-response-compact' ||
    endpoint === 'embeddings' ||
    endpoint === 'openai-video'
  )) ?? null
}

/**
 * Select an endpoint from the server-declared endpoint list.
 *
 * The model ID is retained in the signature for compatibility with older
 * callers, but it is deliberately ignored. NewAPI model names are opaque and
 * must never be used to guess a wire protocol.
 */
export function inferPreferredEndpointForModel(
  _modelId: string,
  endpoints: readonly ModelEndpointType[],
  options: { compactSupported?: boolean } = {}
): ModelEndpointType | null {
  return preferredModelEndpoint(endpoints, options)
}

export type ApprovalMode = 'request' | 'auto' | 'full'
export type ReasoningEffort =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'light'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'
export type ExplicitReasoningEffort = Exclude<ReasoningEffort, 'auto'>
export type ReasoningBudgetByEffort = Partial<Record<ExplicitReasoningEffort, number>>
export type ModelReasoningProtocol =
  | {
      type: 'anthropic-adaptive'
    }
  | {
      type: 'anthropic-budget'
      budgets: ReasoningBudgetByEffort
    }
  | {
      type: 'gemini-level'
      includeThoughts?: boolean
    }
  | {
      type: 'gemini-budget'
      budgets: ReasoningBudgetByEffort
      includeThoughts?: boolean
    }
export type RuntimeStatus = 'mock' | 'starting' | 'ready' | 'degraded' | 'stopped'

// Capability metadata is intentionally renderer-safe. Main-process discovery
// never exposes absolute paths, manifest bodies, scripts, or credentials.
export type CapabilityScope = 'builtin' | 'user' | 'workspace'
export type CapabilityPermission = 'read' | 'write' | 'execute' | 'network' | 'approval'
export type CapabilityAvailability = 'ready' | 'requires-approval' | 'not-ready'
export type CapabilityDiscoveryCategory = 'skills' | 'plugins'
export type CapabilityCommandId =
  | 'plan'
  | 'goal'
  | 'compact'
  | 'memories'
  | 'init'
  | 'review'
  | 'status'
  | 'diff'
  | 'commit'

export interface CapabilityCommandDescriptor {
  id: CapabilityCommandId
  name: string
  description: string
  aliases: string[]
  scope: 'builtin'
  permissions: CapabilityPermission[]
  safe: boolean
  availability: CapabilityAvailability
}

export interface SkillDescriptor {
  id: string
  grantHandle: string
  name: string
  description: string
  scope: 'user' | 'workspace'
  relativePath: string
  permissions: CapabilityPermission[]
}

export interface PluginDescriptor {
  id: string
  grantHandle: string
  name: string
  description: string
  version: string
  scope: 'user' | 'workspace'
  relativePath: string
  permissions: CapabilityPermission[]
  enabled: boolean
}

export interface CapabilityCatalog {
  commands: CapabilityCommandDescriptor[]
  skills: SkillDescriptor[]
  plugins: PluginDescriptor[]
  session?: CapabilitySessionState
}

export interface CapabilityListInput {
  workspaceToken?: string
  category?: CapabilityDiscoveryCategory
}

export interface CapabilityExecuteInput {
  id: string
  args?: string
  workspaceToken?: string
  grantHandle?: string
  draftHandle?: string
  projectInitAction?: 'commit' | 'discard'
}

export interface CapabilityGoalState {
  text: string
  status: 'active' | 'paused' | 'cleared'
}

export interface CapabilitySessionState {
  planMode: boolean
  memoriesEnabled: boolean
  goal?: CapabilityGoalState
}

export interface CapabilityExecuteResult {
  id: string
  status: 'completed' | 'preview' | 'requires-approval' | 'not-ready'
  message: string
  plan?: string[]
  goal?: CapabilityGoalState
  instructions?: string
  session?: CapabilitySessionState
  projectInit?: ProjectInitCapabilityResult
  reviewHandle?: string
}

export type ProjectInitCapabilityResult =
  | {
      state: 'preview'
      draftHandle: string
      relativePath: 'AGENTS.md'
      content: string
      contentSha256: string
      target: 'create' | 'replace'
      expiresAt: number
    }
  | {
      state: 'committed'
      relativePath: 'AGENTS.md'
      revision: string
      replaced: boolean
    }

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const RELAY_GROUP_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/u

export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value)
}

export function isValidRelayGroupId(value: unknown): value is string {
  return typeof value === 'string' && RELAY_GROUP_ID_PATTERN.test(value)
}

export interface SafeError {
  code:
    | 'cancelled'
    | 'conflict'
    | 'denied'
    | 'invalid_input'
    | 'not_found'
    | 'not_ready'
    | 'runtime_error'
  message: string
  retryable: boolean
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SafeError }

export interface PublicAccessProfile {
  credentialHandle: string
  name: string
  description: string
  baseUrl: string
  hasKey: boolean
  isCurrent: boolean
  targets: Array<'codex' | 'claude-desktop' | 'claude-code'>
}

export interface ModelCapabilities {
  attachments: boolean
  imageInput: boolean
  imageGeneration: boolean
  subagents: boolean
  toolUse: boolean
  webSearch: boolean
}

export interface ModelDescriptor {
  id: string
  label: string
  provider: 'openai-compatible' | 'anthropic-compatible' | 'gemini-compatible' | 'unsupported'
  wireMode: ModelWireMode
  declaredWireMode?: ModelWireMode
  /** Endpoint kinds accepted by this model, after the bounded allowlist. */
  endpointTypes: ModelEndpointType[]
  /** Present when the remote response explicitly declared endpoint kinds. */
  declaredEndpointTypes?: ModelEndpointType[]
  /** The endpoint selected for a normal Chat/Studio request, if any. */
  preferredChatEndpoint: ModelEndpointType | null
  /**
   * Endpoint selected for Agent when the relay publishes an explicit provider
   * contract that differs from the Chat preference. Undefined means Agent
   * should retain the declared endpoint order.
   */
  preferredAgentEndpoint?: ModelAgentEndpointType | null
  /** Transport selected from preferredChatEndpoint; unsupported is fail-closed. */
  preferredChatTransport: ModelEndpointTransport
  trustedOwner?: 'codex'
  modes: WorkspaceMode[]
  reasoning: ReasoningEffort[]
  // Remote catalogs set this only when the server explicitly publishes a
  // reasoning list. Missing means the endpoint must decide when a turn runs.
  declaredReasoning?: ReasoningEffort[]
  // Native Anthropic/Gemini reasoning fields are emitted only when the server
  // explicitly declares one of these bounded strategies.
  reasoningProtocol?: ModelReasoningProtocol
  // Keeps the bounded server declaration even when Chat selects a different
  // preferred endpoint. Agent fallback candidates project it independently.
  declaredReasoningProtocol?: ModelReasoningProtocol
  capabilities: ModelCapabilities
  // Remote catalogs set this to only the booleans explicitly returned by the server.
  // If this object is absent, capabilities is an authoritative local descriptor.
  declaredCapabilities?: Partial<ModelCapabilities>
  source: 'mock' | 'remote'
}

export function isModelReasoningExplicitlyUnsupported(
  model: Pick<ModelDescriptor, 'reasoning' | 'declaredReasoning'>,
  effort: ReasoningEffort
): boolean {
  const declared = model.declaredReasoning
  return declared === undefined
    ? !model.reasoning.includes(effort)
    : !declared.includes(effort)
}

export function isModelCapabilityExplicitlyUnsupported(
  model: Pick<ModelDescriptor, 'capabilities' | 'declaredCapabilities'>,
  capability: keyof ModelCapabilities
): boolean {
  return model.declaredCapabilities === undefined
    ? model.capabilities[capability] === false
    : model.declaredCapabilities[capability] === false
}

export function isModelCapabilityExplicitlySupported(
  model: Pick<ModelDescriptor, 'capabilities' | 'declaredCapabilities'>,
  capability: keyof ModelCapabilities
): boolean {
  return model.declaredCapabilities === undefined
    ? model.capabilities[capability] === true
    : model.declaredCapabilities[capability] === true
}

/**
 * Whether a confirmed remote model can receive the protocol-neutral
 * `delegate_tasks` tool.  Delegation is an Agent capability, not a user
 * preference: an absent `subagents` declaration is intentionally treated as
 * compatible when the server has declared a usable Agent endpoint and tool
 * use has not been explicitly disabled.
 */
export function isModelDelegationCompatible(
  model: Pick<
    ModelDescriptor,
    'source' | 'endpointTypes' | 'capabilities' | 'declaredCapabilities'
  >,
): boolean {
  return model.source === 'remote' &&
    declaredModelAgentEndpoints(model.endpointTypes).length > 0 &&
    model.capabilities.toolUse &&
    model.declaredCapabilities?.toolUse !== false &&
    model.declaredCapabilities?.subagents !== false
}

export interface TaskSummary {
  id: string
  projectId: string
  title: string
  mode: WorkspaceMode
  updatedAt: string
  archivedAt: string | null
  status: 'idle' | 'running' | 'waiting-approval' | 'failed'
  readOnly?: boolean
  /**
   * Identifies an imported conversation without exposing provider credentials
   * or a provider-specific file path. The local task remains the writable
   * owner of any subsequent turns.
   */
  source?: ConversationSourceRef
}

export type ConversationSourceProvider = 'codex' | 'grok' | 'claude' | 'gemini' | 'other'

export interface ConversationSourceRef {
  provider: ConversationSourceProvider
  id: string
}

export interface ProjectSummary {
  id: string
  name: string
  tasks: TaskSummary[]
}

export interface BootstrapPayload {
  schemaVersion: typeof API_SCHEMA_VERSION
  app: {
    name: string
    version: string
    platform: 'win32' | 'darwin' | 'linux'
    preview: boolean
  }
  runtime: {
    status: RuntimeStatus
    protocolVersion: number
    message: string
  }
  security: {
    rendererHasNodeAccess: false
    rendererNetworkAccess: false
    secretsExposedToRenderer: false
    endpointConsentRequired: true
    localToolConsentRequired: true
  }
  defaults: {
    mode: WorkspaceMode
    approvalMode: ApprovalMode
    reasoning: ReasoningEffort
    webSearch: boolean
    imageGeneration: boolean
    activeProfileHandle: string
    activeModelId: string
  }
  profiles: PublicAccessProfile[]
  models: ModelDescriptor[]
  projects: ProjectSummary[]
  activeTaskId: string
}

export interface WorkspaceSelection {
  workspaceToken: string
  displayName: string
}

export type AgentWorkspaceOrigin = 'projectless' | 'selected'

export interface AgentWorkspaceSelection extends WorkspaceSelection {
  origin: AgentWorkspaceOrigin
}

export interface AgentWorkspaceProvisionInput {
  prompt?: string
}

export interface AgentWorkspaceTaskInput {
  taskId: string
}

export interface AgentWorkspaceRememberInput extends AgentWorkspaceTaskInput {
  workspaceToken: string
}

export const WORKSPACE_OPENER_IDS = Object.freeze([
  'vscode',
  'visual-studio',
  'cursor',
  'github-desktop',
  'explorer',
  'terminal',
  'wsl',
  'pycharm'
] as const)

export type WorkspaceOpenerId = (typeof WORKSPACE_OPENER_IDS)[number]
export type WorkspaceOpenerKind = 'editor' | 'git' | 'file-manager' | 'terminal'

export function isWorkspaceOpenerId(value: unknown): value is WorkspaceOpenerId {
  return typeof value === 'string' && (WORKSPACE_OPENER_IDS as readonly string[]).includes(value)
}

export interface WorkspaceOpenerDescriptor {
  id: WorkspaceOpenerId
  label: string
  kind: WorkspaceOpenerKind
}

export interface WorkspaceOpenerListInput {
  workspaceToken: string
  confirmation: 'detect'
}

export interface WorkspaceOpenerListResult {
  openers: WorkspaceOpenerDescriptor[]
  launchToken: string
}

export interface WorkspaceOpenInput {
  workspaceToken: string
  openerId: WorkspaceOpenerId
  launchToken: string
  confirmation: 'open_once'
}

export interface WorkspaceOpenResult {
  openerId: WorkspaceOpenerId
}

export interface AttachmentSelection {
  attachmentToken: string
  displayName: string
  mediaKind: 'image' | 'document' | 'text' | 'other'
}

export interface ConversationCreateInput {
  title?: string
  mode: WorkspaceMode
  workspaceToken?: string
}

export interface ConversationRenameInput {
  taskId: string
  title: string
}

export interface ConversationRef {
  taskId: string
}

export interface ConversationForkInput extends ConversationRef {
  /** Current opaque workspace grant. Main still resolves the durable task binding. */
  workspaceToken?: string
  /** Agent forks isolate file state by default; false explicitly keeps one workspace. */
  isolateFiles?: boolean
  /**
   * Optional complete message to fork from: the branch keeps history up to and
   * including it, leaving any divergent tail behind on the source task.
   */
  anchorMessageId?: string
}

export interface ConversationSetArchivedInput extends ConversationRef {
  archived: boolean
}

export interface ConversationSnapshot {
  task: TaskSummary
  messages: ConversationMessageDto[]
  events: AgentEvent[]
}

export interface ConversationImportInput {
  /** Task id exposed by a supported external conversation-history adapter. */
  taskId: string
  workspaceToken?: string
  /**
   * Local mode for the imported copy. Omitted for backwards compatibility
   * and defaults to Agent, which is how provider history was previously
   * resumed.
   */
  mode?: WorkspaceMode
}

export interface ConversationCompactInput extends ConversationRef {
  profileHandle: string
  groupId: string | null
  modelId: string
  reasoning: ReasoningEffort
}

export interface ConversationCompactResult {
  compacted: boolean
  removedMessages: number
  snapshot: ConversationSnapshot
}

/**
 * Marks the single canonical user message that carries a model-generated context
 * summary. Main writes it, the renderer detects it to present a compaction event
 * instead of a message the user appears to have typed.
 */
export const CONTEXT_COMPACTION_PREFIX = '[Context Compaction] '

export type ConversationMessageStatus = 'streaming' | 'complete' | 'cancelled' | 'failed'

export interface ConversationMessageDto {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: ConversationMessageStatus
  createdAt: string
  updatedAt: string
  /**
   * Human-readable label of the model that produced an assistant message
   * (e.g. "GPT-5.6 Sol Ultra"). Stored at generation time so the attribution
   * survives model-catalog changes. Absent on user messages and on assistant
   * messages persisted before this field existed.
   */
  model?: string
}

export interface ModelListInput {
  profileHandle: string
  mode: WorkspaceMode
  groupId: string | null
}

export interface TurnStartInput {
  requestId: string
  taskId: string
  mode: WorkspaceMode
  prompt: string
  profileHandle: string
  groupId: string | null
  modelId: string
  reasoning: ReasoningEffort
  approvalMode: ApprovalMode
  workspaceToken?: string
  reviewHandle?: string
  attachmentTokens: string[]
  webSearch: boolean
  imageGeneration: boolean
  /**
   * Deprecated compatibility field. Agent delegation is selected by Main from
   * the confirmed model catalog; callers must not use this as a user switch.
   */
  localSubagents?: boolean
  contextMessageLimit?: number
}

export interface TurnStartResult {
  turnId: string
}

export interface GeneratedImageRef {
  imageToken: string
  mimeType: 'image/png'
  byteLength: number
}

export interface GeneratedImageData {
  mimeType: 'image/png'
  byteLength: number
  dataBase64: string
}

export type TurnCancelInput =
  | { requestId: string; turnId?: never }
  | { turnId: string; requestId?: never }

/** An option decision answers an ask_user question; the rest settle tool approvals. */
export type ApprovalDecision =
  | 'allow_once'
  | 'allow_session'
  | 'deny'
  | 'option:0'
  | 'option:1'
  | 'option:2'
  | 'option:3'

export interface ApprovalResolveInput {
  approvalId: string
  decision: ApprovalDecision
}

/** One session-scoped approval grant; the id is opaque and only supports revocation. */
export interface ApprovalSessionScopeDto {
  id: string
  toolName: string
  operation: 'read' | 'enumerate' | 'search' | 'write' | 'open' | 'execute'
  risk: 'low' | 'medium' | 'high'
}

export interface WorkspaceFileInput {
  workspaceToken: string
  relativePath: string
  /** 1-based first line to return. Omit to read from the start. */
  startLine?: number
  /** Maximum number of lines to return from startLine. Omit to read to the end. */
  lineCount?: number
}

export interface WorkspaceWriteInput extends WorkspaceFileInput {
  content: string
  expectedRevision?: string
}

export interface WorkspaceFileResult {
  relativePath: string
  content: string
  revision: string
  truncated: boolean
}

export interface WorkspaceDirectoryInput {
  workspaceToken: string
  relativePath: string
}

export interface WorkspaceDirectoryEntry {
  relativePath: string
  kind: 'file' | 'directory'
}

export interface WorkspaceDirectoryResult {
  entries: WorkspaceDirectoryEntry[]
  truncated: boolean
}

export interface GitFileSummary {
  relativePath: string
  additions: number
  deletions: number
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
}

export interface GitSummary {
  branch: string
  additions: number
  deletions: number
  files: GitFileSummary[]
}

/**
 * Diff comparison base. 'current' compares the working tree against HEAD
 * (uncommitted changes only); 'main' compares against the merge-base with the
 * main branch (everything the current branch changed), falling back to HEAD
 * when no main branch exists.
 */
export type GitDiffBase = 'current' | 'main'

export interface WorkspaceGitRevertInput {
  workspaceToken: string
  relativePaths: string[]
  taskId: string
}

export interface WorkspaceGitRevertResult {
  reverted: string[]
  failed: { relativePath: string; message: string }[]
}

export interface WorkspaceGitRevertHunkInput {
  workspaceToken: string
  relativePath: string
  hunkText: string
  taskId: string
}

export type WorkspaceEnvironmentState = 'ready' | 'not-repository' | 'unavailable'

export interface WorkspaceEnvironmentSnapshot {
  state: WorkspaceEnvironmentState
  branch: string | null
  additions: number
  deletions: number
  changedFiles: number
  clean: boolean
}

export interface WorkspaceCheckpointSummary {
  id: string
  label: string
  createdAt: string
}

export type WorkspaceWorktreeKind = 'git-worktree' | 'workspace-copy'
export type WorkspaceWorktreeStatus = 'ready' | 'applied' | 'discarded' | 'missing'

export interface WorkspaceWorktreeSummary {
  id: string
  sourceTaskId: string
  targetTaskId: string
  kind: WorkspaceWorktreeKind
  status: WorkspaceWorktreeStatus
  changedFiles: number | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceChangeState {
  taskId: string
  checkpoints: WorkspaceCheckpointSummary[]
  worktrees: WorkspaceWorktreeSummary[]
}

export interface WorkspaceCheckpointCreateInput extends ConversationRef {
  label?: string
}

export interface WorkspaceRewindInput extends ConversationRef {
  checkpointId: string
}

export interface WorkspaceWorktreeMutationInput extends ConversationRef {
  worktreeId: string
}

export interface TerminalStartInput {
  workspaceToken: string
  columns: number
  rows: number
}

export interface TerminalInput {
  terminalId: string
  data: string
}

export interface TerminalResizeInput {
  terminalId: string
  columns: number
  rows: number
}

export interface TerminalRef {
  terminalId: string
}

export interface SaveProfileInput {
  credentialHandle?: string
  name: string
  description?: string
  baseUrl: string
  apiKey?: string
  targets: PublicAccessProfile['targets']
}

export interface ProfileRef {
  credentialHandle: string
}

export interface IntegrationRef {
  integrationId: 'codex' | 'claude-desktop' | 'claude-code'
}

export interface IntegrationStatus {
  integrationId: IntegrationRef['integrationId']
  installed: boolean
  configured: boolean
  statusText: string
}

// The Main process maps server-shaped responses into these bounded,
// renderer-safe values before crossing the IPC boundary.
export interface RemoteRelayConnectionDto {
  endpoint: string
  endpointConsent: {
    status: 'required' | 'confirmed'
    endpointLabel: string
  }
  authenticated: boolean
  deviceId: string | null
}

export interface RemoteRelayConnectInput {
  endpoint: string
  confirmation: 'connect'
}

export interface RemoteRelayDeviceAuthorizationDto {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresAt: string
  intervalSeconds: number
}

export type RemoteRelayDeviceAuthorizationPollDto =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'slow_down'; retryAfterSeconds: number }
  | { status: 'authenticated'; deviceId: string }
  | { status: 'expired' }
  | { status: 'denied' }

export interface RemoteRelayOverviewDto {
  account: {
    id: number
    username: string | null
    displayName: string
    email: string | null
    group: string | null
    status: number | null
    role: number | null
  }
  quota: {
    total: number | null
    used: number | null
    remaining: number | null
  }
  requestCount: number | null
  groups: Array<{
    id: string
    ratio: number | string | null
    description: string | null
  }>
  models: string[]
  updatedAt: string
}

export type RemoteRelayQuotaDisplayType = 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM'

export interface RemoteRelayBillingConfigDto {
  quotaPerUnit: number
  displayInCurrency: boolean
  quotaDisplayType: RemoteRelayQuotaDisplayType
  usdExchangeRate: number
  customCurrencySymbol: string
  customCurrencyExchangeRate: number
}

export type RemoteRelayTokenStatus = 'active' | 'disabled' | 'unavailable'

export interface RemoteRelayTokenDto {
  id: number
  name: string
  maskedKey: string
  status: RemoteRelayTokenStatus
  remainQuota: number | null
  usedQuota: number | null
  unlimitedQuota: boolean | null
  group: string | null
  modelLimits: string | null
  createdAt: string | null
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface RemoteRelayTokenPageDto {
  page: number
  pageSize: number
  total: number
  items: RemoteRelayTokenDto[]
}

export interface RemoteRelayUsageInput {
  from: string
  to: string
}

export interface RemoteRelayUsageRecordDto {
  createdAt: string
  requests: number
  quota: number
  tokenUsed: number
  modelName: string
}

export interface RemoteRelayUsageDto {
  range: {
    from: string
    to: string
  }
  totals: {
    requests: number
    quota: number
    tokenUsed: number
  }
  records: RemoteRelayUsageRecordDto[]
}

export interface RemoteRelayPricingModelDto {
  modelName: string
  description: string | null
  owner: string
  quotaType: number
  modelRatio: number
  modelPrice: number
  completionRatio: number
  cacheRatio: number | null
  imageRatio: number | null
  enabledGroups: string[]
  endpointTypes: string[]
  billingMode: string | null
}

export interface RemoteRelayPricingDto {
  models: RemoteRelayPricingModelDto[]
  groupRatios: Readonly<Record<string, number>>
  pricingVersion: string | null
}

export interface RemoteRelayUpdateTokenStatusInput {
  tokenId: number
  status: 'active' | 'disabled'
}

export interface RemoteRelayTokenMutationDto {
  tokenId: number
  status: 'active' | 'disabled' | 'revoked'
}

export interface RemoteRelayRevokeTokenInput {
  tokenId: number
  confirmation: 'revoke'
}

export interface RemoteRelayRedeemInput {
  code: string
}

export interface RemoteRelayRedeemResultDto {
  creditedQuota: number
}

export interface RemoteRelayPollInput {
  sessionId: string
}

export type AgentEvent =
  | {
      type: 'turn-status'
      turnId: string
      status: 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled'
      message?: string
      continuation?: 'agent-execution'
    }
  | { type: 'assistant-delta'; turnId: string; text: string }
  | ({ type: 'image-result'; turnId: string } & GeneratedImageRef)
  | { type: 'tool-status'; turnId: string; callId: string; label: string; status: 'running' | 'completed' | 'failed' }
  | {
      type: 'subagent-status'
      turnId: string
      agentId: string
      parentAgentId: string
      label: string
      detail?: string
      status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    }
  | { type: 'approval-request'; turnId: string; approvalId: string; label: string; detail?: string; risk: 'low' | 'medium' | 'high'; allowSessionScope?: boolean; expiresAt: string; question?: { options: string[] } }
  | { type: 'terminal-output'; terminalId: string; data: string }
  | { type: 'usage'; turnId: string; promptTokens: number; completionTokens: number; totalTokens: number }

export interface RendererApi {
  studio: StudioBridge
  app: {
    getBootstrap(): Promise<ApiResult<BootstrapPayload>>
  }
  window: {
    minimize(): Promise<ApiResult<null>>
    toggleMaximize(): Promise<ApiResult<null>>
    close(): Promise<ApiResult<null>>
    quit(): Promise<ApiResult<null>>
  }
  dialog: {
    selectWorkspace(): Promise<ApiResult<WorkspaceSelection | null>>
    selectAttachments(): Promise<ApiResult<AttachmentSelection[]>>
    pasteImage(): Promise<ApiResult<AttachmentSelection[]>>
    // Accepts renderer File objects; typed as unknown because the shared
    // contracts compile without DOM libs in the main-process project.
    registerDroppedFiles(files: readonly unknown[]): Promise<ApiResult<AttachmentSelection[]>>
  }
  conversation: {
    list(): Promise<ApiResult<ProjectSummary[]>>
    create(input: ConversationCreateInput): Promise<ApiResult<TaskSummary>>
    load(input: ConversationRef): Promise<ApiResult<ConversationSnapshot>>
    import(input: ConversationImportInput): Promise<ApiResult<ConversationSnapshot>>
    compact(input: ConversationCompactInput): Promise<ApiResult<ConversationCompactResult>>
    rename(input: ConversationRenameInput): Promise<ApiResult<TaskSummary>>
    fork(input: ConversationForkInput): Promise<ApiResult<TaskSummary>>
    search(input: { query: string }): Promise<ApiResult<TaskSummary[]>>
    setArchived(input: ConversationSetArchivedInput): Promise<ApiResult<TaskSummary>>
    delete(input: ConversationRef): Promise<ApiResult<null>>
  }
  models: {
    list(input: ModelListInput): Promise<ApiResult<ModelDescriptor[]>>
  }
  capabilities: {
    list(input?: CapabilityListInput): Promise<ApiResult<CapabilityCatalog>>
    execute(input: CapabilityExecuteInput): Promise<ApiResult<CapabilityExecuteResult>>
  }
  turn: {
    start(input: TurnStartInput): Promise<ApiResult<TurnStartResult>>
    cancel(input: TurnCancelInput): Promise<ApiResult<null>>
  }
  approval: {
    resolve(input: ApprovalResolveInput): Promise<ApiResult<null>>
    listSessionScopes(): Promise<ApiResult<ApprovalSessionScopeDto[]>>
    revokeSessionScope(input: { id: string }): Promise<ApiResult<null>>
  }
  image: {
    read(input: { imageToken: string }): Promise<ApiResult<GeneratedImageData>>
  }
  workspace: {
    provision(input?: AgentWorkspaceProvisionInput): Promise<ApiResult<AgentWorkspaceSelection>>
    restore(input: AgentWorkspaceTaskInput): Promise<ApiResult<AgentWorkspaceSelection | null>>
    remember(input: AgentWorkspaceRememberInput): Promise<ApiResult<null>>
    listOpeners(input: WorkspaceOpenerListInput): Promise<ApiResult<WorkspaceOpenerListResult>>
    open(input: WorkspaceOpenInput): Promise<ApiResult<WorkspaceOpenResult>>
    environment(input: { workspaceToken: string }): Promise<ApiResult<WorkspaceEnvironmentSnapshot>>
    changes(input: ConversationRef): Promise<ApiResult<WorkspaceChangeState>>
    checkpoint(input: WorkspaceCheckpointCreateInput): Promise<ApiResult<WorkspaceChangeState>>
    rewind(input: WorkspaceRewindInput): Promise<ApiResult<WorkspaceChangeState>>
    worktreeApply(input: WorkspaceWorktreeMutationInput): Promise<ApiResult<WorkspaceChangeState>>
    worktreeDiscard(input: WorkspaceWorktreeMutationInput): Promise<ApiResult<WorkspaceChangeState>>
    listDirectory(input: WorkspaceDirectoryInput): Promise<ApiResult<WorkspaceDirectoryResult>>
    readFile(input: WorkspaceFileInput): Promise<ApiResult<WorkspaceFileResult>>
    writeFile(input: WorkspaceWriteInput): Promise<ApiResult<WorkspaceFileResult>>
    gitSummary(input: { workspaceToken: string; base?: GitDiffBase }): Promise<ApiResult<GitSummary>>
    gitDiff(input: { workspaceToken: string; base?: GitDiffBase }): Promise<ApiResult<{ patch: string; truncated: boolean }>>
    gitRevert(input: WorkspaceGitRevertInput): Promise<ApiResult<WorkspaceGitRevertResult>>
    gitRevertHunk(input: WorkspaceGitRevertHunkInput): Promise<ApiResult<{ relativePath: string }>>
    gitCommit(input: { workspaceToken: string; message: string }): Promise<ApiResult<{ output: string }>>
  }
  terminal: {
    start(input: TerminalStartInput): Promise<ApiResult<TerminalRef>>
    input(input: TerminalInput): Promise<ApiResult<null>>
    resize(input: TerminalResizeInput): Promise<ApiResult<null>>
    stop(input: TerminalRef): Promise<ApiResult<null>>
  }
  profile: {
    listPublic(): Promise<ApiResult<PublicAccessProfile[]>>
    save(input: SaveProfileInput): Promise<ApiResult<PublicAccessProfile>>
    delete(input: ProfileRef): Promise<ApiResult<null>>
    apply(input: ProfileRef & { target: PublicAccessProfile['targets'][number] }): Promise<ApiResult<null>>
    restore(input: { target: PublicAccessProfile['targets'][number] }): Promise<ApiResult<null>>
  }
  integration: {
    status(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    diagnose(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    install(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    relaunch(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    restore(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
  }
  relay: {
    getConnection(): Promise<ApiResult<RemoteRelayConnectionDto>>
    connect(input: RemoteRelayConnectInput): Promise<ApiResult<RemoteRelayConnectionDto>>
    startDeviceAuthorization(): Promise<ApiResult<RemoteRelayDeviceAuthorizationDto>>
    openDeviceAuthorization(input: RemoteRelayPollInput): Promise<ApiResult<null>>
    pollDeviceAuthorization(input: RemoteRelayPollInput): Promise<ApiResult<RemoteRelayDeviceAuthorizationPollDto>>
    signOut(): Promise<ApiResult<null>>
    getOverview(): Promise<ApiResult<RemoteRelayOverviewDto>>
    getBillingConfig(): Promise<ApiResult<RemoteRelayBillingConfigDto>>
    listTokens(): Promise<ApiResult<RemoteRelayTokenPageDto>>
    updateTokenStatus(input: RemoteRelayUpdateTokenStatusInput): Promise<ApiResult<RemoteRelayTokenMutationDto>>
    revokeToken(input: RemoteRelayRevokeTokenInput): Promise<ApiResult<RemoteRelayTokenMutationDto>>
    listUsage(input: RemoteRelayUsageInput): Promise<ApiResult<RemoteRelayUsageDto>>
    listPricing(): Promise<ApiResult<RemoteRelayPricingDto>>
    redeem(input: RemoteRelayRedeemInput): Promise<ApiResult<RemoteRelayRedeemResultDto>>
  }
  link: {
    openExternal(url: string): Promise<ApiResult<null>>
  }
  background: {
    list(): Promise<ApiResult<BackgroundTaskDto[]>>
    submit(input: BackgroundTaskSubmitInput): Promise<ApiResult<BackgroundTaskDto>>
    followUp(input: BackgroundTaskTurnInput): Promise<ApiResult<BackgroundTaskDto>>
    resume(input: BackgroundTaskTurnInput): Promise<ApiResult<BackgroundTaskDto>>
    cancel(id: string): Promise<ApiResult<null>>
  }
  browser: {
    navigate(url: string): Promise<ApiResult<BrowserControlResultDto>>
    screenshot(): Promise<ApiResult<BrowserControlResultDto>>
    content(): Promise<ApiResult<BrowserControlResultDto & { content?: string }>>
    close(): Promise<ApiResult<null>>
  }
  screen: {
    capture(displayId?: number): Promise<ApiResult<ScreenCaptureResultDto>>
    displays(): Promise<ApiResult<{ ok: boolean; displays?: Array<{ id: number; label: string; width: number; height: number }> }>>
  }
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
}

export interface BrowserControlResultDto {
  ok: boolean
  title?: string
  url?: string
  screenshot?: string
  error?: string
}

export interface ScreenCaptureResultDto {
  ok: boolean
  screenshot?: string
  width?: number
  height?: number
  error?: string
}

export interface BackgroundTaskDto {
  id: string
  taskId: string
  title: string
  status: 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  createdAt: string
  updatedAt: string
  turnId?: string
  queuedFollowUps: number
  events: BackgroundTaskEventDto[]
  result?: string
  error?: string
}

export interface BackgroundTaskEventDto {
  id: string
  createdAt: string
  kind: 'status' | 'tool' | 'subagent' | 'approval' | 'usage'
  label: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
}

export interface BackgroundTaskSubmitInput {
  taskId: string
  title: string
}

export interface BackgroundTaskTurnInput {
  id: string
  turn: TurnStartInput
}
