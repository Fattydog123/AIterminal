import type { Edge, Node } from '@xyflow/react'
import type { NodePresentation, NodeStatus, RunDispatchState, SocketDataType } from '@studio/shared/types.js'

export type PageId = 'workflow' | 'assets' | 'queue' | 'runs' | 'settings'
export type WorkflowView = 'canvas' | 'linear'
export type BottomPanelId = 'live'
export type ModalId = 'command' | 'project-picker' | 'prompt-matrix' | 'compare' | 'mask' | 'run-confirm' | 'workflow-templates' | 'draft-recovery' | 'workflow-history' | 'none'

export interface CanvasPort extends Record<string, unknown> {
  readonly id: string
  readonly label: string
  readonly dataType: SocketDataType
  readonly required?: boolean
}

export interface CanvasNodeData extends Record<string, unknown> {
  readonly label: string
  readonly nodeType: string
  readonly category: string
  readonly description: string
  readonly inputs: readonly CanvasPort[]
  readonly outputs: readonly CanvasPort[]
  readonly parameters: Readonly<Record<string, unknown>>
  readonly accent: 'text' | 'image' | 'utility' | 'control'
  readonly status: NodeStatus
  readonly runtimeMs?: number
  readonly cacheHit?: boolean
  readonly annotation?: string
  readonly bypassed?: boolean
  readonly collapsed?: boolean
  readonly pinned?: boolean
  readonly mocked?: boolean
  readonly debugOutput?: unknown
  readonly subgraphId?: string
  readonly subgraphDefinitionId?: string
  readonly subgraphDefinitionVersion?: number
  /** Renderer-only signed URL. Never persisted into the workflow document. */
  readonly previewUrl?: string | undefined
  /** Renderer-only project-relative result paths. Never persisted into the workflow document. */
  readonly previewPaths?: readonly string[] | undefined
  /** Renderer-only signed result URLs, index-aligned with previewPaths. Never persisted. */
  readonly previewUrls?: readonly string[] | undefined
  /** Identifies the run that currently owns previewPaths/previewUrls. Never persisted. */
  readonly previewRunId?: string | undefined
  readonly previewWidth?: number | undefined
  readonly previewHeight?: number | undefined
  readonly previewLoading?: boolean | undefined
  readonly previewError?: string | undefined
  readonly previewTone?: 'copper' | 'jade' | 'blue' | 'mono'
  readonly rawPresentation?: NodePresentation
}

export interface ExposureEdgeData extends Record<string, unknown> {
  readonly dataType: SocketDataType
  readonly active?: boolean
  readonly label?: string
  readonly presentation?: Readonly<Record<string, unknown>>
}

export type StudioFlowNode = Node<CanvasNodeData, 'studio'>
export type StudioFlowEdge = Edge<ExposureEdgeData, 'exposure'>

export interface GraphDocument {
  readonly id: string
  readonly label: string
  readonly parentId?: string
  readonly definitionId?: string
  readonly definitionVersion?: number
  readonly instanceNodeId?: string
  readonly nodes: readonly StudioFlowNode[]
  readonly edges: readonly StudioFlowEdge[]
}

export interface QueueItem {
  readonly id: string
  readonly title: string
  readonly workflow: string
  readonly provider: string
  readonly status: 'queued' | 'running' | 'success' | 'error' | 'billing-unknown'
  readonly progress: number
  readonly createdAt: string
  readonly cost?: number
  readonly message: string
  readonly dispatchState?: RunDispatchState
  readonly persistentStatus?: 'pending' | 'running' | 'paused'
  readonly canResume?: boolean
  readonly canRemove?: boolean
  readonly blockedReason?: string
  readonly attempt?: number
}

export interface AssetItem {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly revisedPrompt?: string
  readonly model: string
  readonly providerId?: string
  readonly nodeId?: string
  readonly workflow: string
  readonly createdAt: string
  readonly createdAtIso?: string
  readonly favorite: boolean
  readonly decision: 'pending' | 'adopted' | 'rejected'
  readonly candidateGroup: string
  readonly parentId?: string
  readonly operation: 'generate' | 'edit' | 'inpaint' | 'outpaint'
  readonly tags: readonly string[]
  readonly tone: 'copper' | 'jade' | 'blue' | 'mono' | 'rose' | 'violet'
  readonly size: string
  readonly seed?: number
  readonly previewUrl?: string
  readonly previewPath?: string
  readonly relativePath?: string
}

export interface BoardItem {
  readonly id: string
  readonly name: string
  readonly count: number
  readonly kind: 'board' | 'smart'
  readonly rule?: string
  readonly builtin?: boolean
  readonly description?: string
  readonly assetIds?: readonly string[]
  readonly favorite?: boolean
  readonly models?: readonly string[]
  readonly workflowIds?: readonly string[]
  readonly tags?: readonly string[]
  readonly dateFrom?: string
  readonly dateTo?: string
}

export interface ProviderItem {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly model: string
  readonly kind: 'openai-compatible' | 'comfyui'
  readonly status: 'connected' | 'untested' | 'error'
  readonly hasSecret: boolean
  /** Models discovered by the latest non-billing connection probe in this app session. */
  readonly models?: readonly string[]
  /** Exact models limited to the minimal Images request proven by confirmation. */
  readonly confirmedOnlyModels?: readonly string[]
  /** Last non-billing probe result, retained in the current app session for repair guidance. */
  readonly lastProbeMessage?: string
  readonly latencyMs?: number
  readonly timeoutMs?: number
  readonly maxImageBytes?: number
  readonly proxyMode?: 'system' | 'direct'
  readonly managedBy?: 'ai-terminal-account'
  readonly groupId?: string
  readonly description?: string
}

export interface TimelineStage {
  readonly id: string
  readonly label: '排队' | 'Provider' | '下载' | '解码' | '落盘'
  readonly durationMs: number
  readonly status: 'success' | 'running' | 'pending' | 'error' | 'cache'
}
