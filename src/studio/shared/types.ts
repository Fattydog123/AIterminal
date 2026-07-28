export const socketDataTypes = [
  'text',
  'image',
  'images',
  'number',
  'boolean',
  'any',
] as const

export type SocketDataType = (typeof socketDataTypes)[number]
export type NodeStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'cancelled'
export type CachePolicy = 'pure' | 'side-effecting'
export type CandidateDecision = 'pending' | 'adopted' | 'rejected'
export type ImageOperation = 'generate' | 'edit' | 'inpaint' | 'outpaint'
export type DesktopPlatform = 'win32' | 'darwin' | 'linux'

export interface Point {
  readonly x: number
  readonly y: number
}

export interface NodePresentation {
  readonly annotation?: string
  readonly collapsed?: boolean
  readonly bypassed?: boolean
  readonly width?: number
  readonly height?: number
  readonly color?: string
  readonly debugOverride?: {
    readonly action: 'pin' | 'mock'
    readonly value: unknown
  }
}

export interface WorkflowNode {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly position: Point
  readonly parameters: Readonly<Record<string, unknown>>
  readonly presentation?: NodePresentation
  readonly subgraph?: SubgraphInstanceReference
}

export interface WorkflowEdge {
  readonly id: string
  readonly sourceNode: string
  readonly sourceSocket: string
  readonly targetNode: string
  readonly targetSocket: string
  readonly presentation?: Readonly<Record<string, unknown>>
}

export interface SubgraphPort {
  readonly id: string
  readonly name: string
  readonly dataType: SocketDataType
  readonly internalNodeId: string
  readonly internalSocket: string
  readonly required: boolean
  readonly multiple?: boolean
}

export interface SubgraphInstanceReference {
  readonly definitionId: string
  readonly definitionVersion: number
}

export interface SubgraphDefinition {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly description: string
  readonly tags: readonly string[]
  readonly inputs: readonly SubgraphPort[]
  readonly outputs: readonly SubgraphPort[]
  readonly workflow: WorkflowDocument
}

export interface WorkflowDocument {
  readonly schemaVersion: 3
  readonly id: string
  readonly name: string
  /** Formal on-disk CAS revision. Unsaved editor changes must preserve it. */
  readonly revision: number
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
  readonly createdAt: string
  /** Timestamp of the accepted formal save, not an in-memory edit clock. */
  readonly updatedAt: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly presentation?: Readonly<Record<string, unknown>>
  readonly subgraphs?: readonly SubgraphDefinition[]
}

export interface PortDefinition {
  readonly id: string
  readonly label: string
  readonly dataType: SocketDataType
  readonly required: boolean
  readonly multiple?: boolean
}

export type ParameterCondition =
  | { readonly parameter: string; readonly operator: 'equals' | 'not-equals'; readonly value: string | number | boolean }
  | { readonly parameter: string; readonly operator: 'in' | 'not-in'; readonly values: readonly (string | number | boolean)[] }
  | { readonly parameter: string; readonly operator: 'truthy' | 'falsy' }

export type ParameterCapabilityKey = 'generation' | 'editing' | 'referenceImages' | 'seed' | 'size' | 'outputFormat'

export interface ParameterCapabilityHint {
  readonly capability: ParameterCapabilityKey
  readonly unsupportedBehavior?: 'disable' | 'hide'
  readonly message?: string
}

export interface ParameterDefinition {
  readonly id: string
  readonly label: string
  readonly kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'path'
  readonly defaultValue: unknown
  readonly options?: readonly { readonly label: string; readonly value: string }[]
  readonly secret?: boolean
  readonly placeholder?: string
  readonly help?: string
  readonly example?: string
  readonly required?: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly condition?: ParameterCondition
  readonly capabilityHint?: ParameterCapabilityHint
}

export interface NodeDefinition {
  readonly type: string
  readonly title: string
  readonly category: string
  readonly description: string
  readonly inputs: Readonly<Record<string, PortDefinition>>
  readonly outputs: Readonly<Record<string, PortDefinition>>
  /** Every group requires at least one connected input. */
  readonly requiredInputGroups?: readonly (readonly string[])[]
  readonly parameters: readonly ParameterDefinition[]
  readonly cachePolicy: CachePolicy
  readonly accent: 'text' | 'image' | 'utility' | 'control'
}

interface ProviderDescriptorBase {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly defaultModel: string
  readonly timeoutMs: number
  readonly maxImageBytes: number
  readonly proxyMode: 'system' | 'direct'
  readonly managedBy?: 'ai-terminal-account'
  readonly groupId?: string
  readonly availableModels?: readonly string[]
  readonly description?: string
}

export interface OpenAiProviderDescriptor extends ProviderDescriptorBase {
  readonly kind: 'openai-compatible'
  readonly hasSecret: boolean
  readonly maskedSecret: string
  /** Models enabled only by an exact successful minimal Images generation confirmation. */
  readonly confirmedOnlyModels?: readonly string[]
  /** Main-validated route published by the logged-in NewAPI account. */
  readonly imageGenerationPath?: string
  /** Main-derived edit route using the exact prefix of imageGenerationPath. */
  readonly imageEditPath?: string
}

export interface ComfyUiProviderDescriptor extends ProviderDescriptorBase {
  readonly kind: 'comfyui'
  readonly hasSecret: false
  readonly maskedSecret: ''
}

export type ProviderDescriptor = OpenAiProviderDescriptor | ComfyUiProviderDescriptor

export interface StudioImageCapabilityProof {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly byteLength: number
}

interface ProviderDraftBase {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly defaultModel: string
  readonly timeoutMs: number
  readonly maxImageBytes: number
  readonly proxyMode: 'system' | 'direct'
}

export interface OpenAiProviderDraft extends ProviderDraftBase {
  readonly kind: 'openai-compatible'
  /** undefined keeps the previous secret; an empty string clears it. */
  readonly secretUpdate?: string
}

export interface ComfyUiProviderDraft extends ProviderDraftBase {
  readonly kind: 'comfyui'
}

export type ProviderDraft = OpenAiProviderDraft | ComfyUiProviderDraft

/**
 * Secret-free description of a Provider import waiting for explicit approval.
 * The API key remains in the Electron main process and is never exposed here.
 */
export interface ProviderImportPreview {
  readonly requestId: string
  readonly source: 'aiterminal-link' | 'legacy-profile'
  readonly mode: 'create' | 'update'
  readonly targetProviderId: string
  readonly name: string
  readonly baseUrl: string
  readonly defaultModel: string
  readonly hasSecret: true
  readonly expiresAt: string
}

export type ProviderImportEvent =
  | { readonly kind: 'request'; readonly preview: ProviderImportPreview }
  | { readonly kind: 'error'; readonly message: string }

export interface ImageGenerationRequest {
  readonly model: string
  readonly prompt: string
  readonly size?: string
  readonly quality?: string
  readonly count: number
  readonly responseFormat?: 'url' | 'b64_json'
  readonly outputFormat?: 'png' | 'jpeg' | 'webp'
  readonly outputCompression?: number
  readonly background?: 'transparent' | 'opaque' | 'auto'
  readonly moderation?: 'low' | 'auto'
  readonly extra?: Readonly<Record<string, string | number | boolean>>
}

export interface ImageEditRequest extends ImageGenerationRequest {
  readonly sourceAssetPath: string
  readonly maskAssetPath?: string
  readonly operation: Exclude<ImageOperation, 'generate'>
  readonly inputFidelity?: 'low' | 'high'
}

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly updatedAt: string
  readonly workflowCount: number
  readonly assetCount: number
}

export interface GeneratedAsset {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly nodeId: string
  readonly relativePath: string
  readonly thumbnailPath?: string
  readonly prompt: string
  readonly revisedPrompt?: string
  readonly providerId: string
  readonly model: string
  readonly width?: number
  readonly height?: number
  readonly seed?: number
  readonly createdAt: string
  readonly favorite: boolean
  readonly decision: CandidateDecision
  readonly candidateGroupId: string
  readonly parentAssetId?: string
  readonly operation: ImageOperation
  readonly tags: readonly string[]
}

export interface Board {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly assetIds: readonly string[]
}

export interface SmartCollection {
  readonly id: string
  readonly name: string
  readonly favorite?: boolean
  readonly models: readonly string[]
  readonly workflowIds: readonly string[]
  readonly tags: readonly string[]
  readonly dateFrom?: string
  readonly dateTo?: string
}

export interface CollectionSnapshot {
  readonly schemaVersion: 1
  readonly boards: readonly Board[]
  readonly smartCollections: readonly SmartCollection[]
}

export type PluginPermissionName = 'network' | 'project-read' | 'project-write' | 'clipboard' | 'shell'

export interface PluginManifestRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly hostVersion: string
  readonly description?: string
  readonly entryPoint?: string
  readonly permissions: readonly PluginPermissionName[]
  readonly nodeTypes: readonly string[]
  readonly dependencies: Readonly<Record<string, string>>
}

export interface ProjectPluginRecord {
  readonly manifest: PluginManifestRecord
  readonly enabled: boolean
  readonly versionLock: string
  readonly grantedPermissions: readonly PluginPermissionName[]
}

export interface ParameterPresetRecord {
  readonly id: string
  readonly name: string
  readonly modelPatterns: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
  readonly tags: readonly string[]
}

export interface TaskRecord {
  readonly id: string
  readonly runId?: string
  readonly projectId: string
  readonly workflowId: string
  readonly nodeId: string
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'billing-unknown'
  readonly dispatchState?: RunDispatchState
  readonly progress: number
  readonly message: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ExecutionTimelineEvent {
  readonly id: string
  readonly runId: string
  readonly nodeId: string
  readonly phase: 'queue' | 'provider' | 'download' | 'decode' | 'persist'
  readonly startedAt: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly cacheHit?: boolean
  readonly errorCode?: string
}

export interface RunPlanNode {
  readonly nodeId: string
  readonly action: 'execute' | 'pin' | 'mock' | 'cache' | 'bypass'
  readonly reason: string
}

export interface RunPlan {
  readonly id: string
  readonly workflowId: string
  readonly taskCount: number
  readonly remoteTaskCount: number
  readonly estimatedCost?: number
  readonly nodes: readonly RunPlanNode[]
}

export type RunDispatchState = 'not_sent' | 'sent' | 'billing_unknown'

export interface RunResult {
  readonly runId: string
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly dispatchState?: RunDispatchState
  readonly outputs: Readonly<Record<string, unknown>>
  readonly error?: { readonly code: string; readonly message: string; readonly billingUnknown: boolean; readonly dispatchState?: RunDispatchState }
}

export interface RunRecordPlan {
  readonly taskCount: number
  readonly remoteTaskCount: number
  readonly estimatedCost?: number
  readonly nodes: readonly RunPlanNode[]
}

export interface RunRecordProviderBinding {
  readonly nodeId: string
  readonly providerId: string
  readonly providerKind?: ProviderDescriptor['kind']
  readonly model: string
}

export interface RunRecordMatrixMetadata {
  readonly batchId: string
  readonly index: number
  readonly taskCount: number
  readonly userEstimatedCostPerImage?: number
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>
}

export interface RunRecordRemoteJob {
  readonly nodeId: string
  readonly providerId: string
  readonly providerKind: 'comfyui'
  /** SHA-256 of the ComfyUI prompt_id. The original identifier is never persisted. */
  readonly promptIdHash: string
  /** At most the final four characters, for matching against an operator's ComfyUI history. */
  readonly promptIdSuffix: string
  readonly queueNumber?: number
}

export interface RunRecordSummary {
  readonly schemaVersion: 1
  readonly runId: string
  readonly workflowId: string
  readonly status: RunResult['status']
  readonly dispatchState?: RunDispatchState
  readonly createdAt: string
  readonly events: readonly ExecutionTimelineEvent[]
  readonly error?: NonNullable<RunResult['error']>
  readonly environment: Readonly<Record<string, string>>
  /** Optional only for reading records written by versions before reproducibility snapshots. */
  readonly workflowSnapshot?: WorkflowDocument
  readonly workflowHash?: string
  readonly targetNodeIds?: readonly string[]
  readonly overrides?: Readonly<Record<string, { readonly action: 'pin' | 'mock'; readonly value: unknown }>>
  readonly plan?: RunRecordPlan
  readonly providerBindings?: readonly RunRecordProviderBinding[]
  readonly matrix?: RunRecordMatrixMetadata
  readonly remoteJobs?: readonly RunRecordRemoteJob[]
}

export interface DiagnosticBundle {
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly appVersion: string
  readonly projectId: string
  readonly workflowId?: string
  readonly runId?: string
  readonly status?: RunResult['status']
  readonly dispatchState?: RunDispatchState
  readonly error?: NonNullable<RunResult['error']>
  readonly events: readonly ExecutionTimelineEvent[]
  readonly environment: Readonly<Record<string, string | number | boolean>>
}

export interface AppBootstrap {
  readonly version: string
  readonly platform: DesktopPlatform
  readonly projects: readonly ProjectSummary[]
  readonly providers: readonly ProviderDescriptor[]
  readonly recentProjectPath?: string
}
