import type { EdgeChange, NodeChange } from '@xyflow/react'
import { autoLayoutWorkflowNodes } from '../../../../../studio/core/autoLayout.js'
import { WorkflowEditor } from '../../../../../studio/core/editor.js'
import { applyLinearValues, validateLinearView, type LinearViewDefinition } from '../../../../../studio/core/linearView.js'
import { defaultRegistry, registryWithSubgraphs } from '../../../../../studio/core/registry.js'
import {
  inspectStudioReadiness,
  type StudioReadinessProvider,
  type StudioReadinessReport,
  type StudioRepairAction,
} from '../../../../../studio/core/studioReadiness.js'
import { convertSelectionToSubgraph, validateSubgraphLibrary } from '../../../../../studio/core/subgraphs.js'
import { validateWorkflow } from '../../../../../studio/core/workflow.js'
import type {
  NodeDefinition,
  NodePresentation,
  SubgraphDefinition,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../../../../../studio/shared/types.js'
import type { CanvasNodeData, CanvasPort, GraphDocument, StudioFlowEdge, StudioFlowNode } from '../types.js'
import { applyEdgeChanges, applyNodeChanges } from '../workflow/flowChanges.js'
import {
  mergeWorkflowDocumentProjection,
  preserveWorkflowGraphRuntime,
  setWorkflowLinearView,
} from './workflow-document-projection.js'
import {
  createWorkflowDocumentSession,
  type PersistedWorkflowDocumentScope,
  type WorkflowDocumentPersistenceAdapter,
  type WorkflowDocumentSaveResult,
  type WorkflowDocumentScheduler,
  type WorkflowDocumentScope,
  type WorkflowDocumentSession,
  type WorkflowDocumentSessionSnapshot,
} from './workflow-document-session.js'

const remoteImageNodeTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])

export interface WorkflowEditorLinearProjection {
  readonly definition: LinearViewDefinition
  readonly values: Readonly<Record<string, string | number>>
  readonly source: 'fallback' | 'saved'
}

export type WorkflowEditorSessionSnapshot = WorkflowDocumentSessionSnapshot & {
  readonly graphs: Readonly<Record<string, GraphDocument>>
  readonly linear: WorkflowEditorLinearProjection | undefined
  readonly readiness: StudioReadinessReport | undefined
  readonly history: {
    readonly canUndo: boolean
    readonly canRedo: boolean
  }
}

export interface WorkflowEditorContext {
  readonly graphId: string
  readonly selectedNodeId?: string
}

export interface WorkflowEditorNodeUpdate {
  readonly nodeId: string
  readonly name?: string
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly annotation?: string
  readonly bypassed?: boolean
  readonly collapsed?: boolean
  readonly debugOverride?: { readonly action: 'pin' | 'mock'; readonly value: unknown } | null
}

export interface WorkflowEditorImagePreview {
  readonly url?: string
  readonly width?: number
  readonly height?: number
  readonly error?: string
}

type WorkflowEditorRuntimeData = Partial<Pick<CanvasNodeData,
  'status' | 'runtimeMs' | 'cacheHit' | 'dispatchState' | 'previewUrl' | 'previewPaths' |
  'previewUrls' | 'previewRunId' | 'previewWidth' | 'previewHeight' | 'previewLoading' |
  'previewError' | 'previewTone'>>

interface WorkflowEditorRuntimeNodeUpdate {
  readonly graphId: string
  readonly nodeId: string
  readonly selected?: boolean
  readonly measured?: StudioFlowNode['measured']
  readonly dragging?: boolean
  readonly data: WorkflowEditorRuntimeData
}

export interface WorkflowEditorClipboardPayload {
  readonly kind: 'ai-terminal/studio-nodes'
  readonly version: 1
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
}

export function parseWorkflowClipboardPayload(text: string): WorkflowEditorClipboardPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const payload = parsed as Partial<WorkflowEditorClipboardPayload>
    if (payload.kind !== 'ai-terminal/studio-nodes' || payload.version !== 1) return undefined
    if (!Array.isArray(payload.nodes) || payload.nodes.length === 0 || !Array.isArray(payload.edges)) return undefined
    return payload as WorkflowEditorClipboardPayload
  } catch {
    return undefined
  }
}

export type WorkflowEditorArrangement =
  | 'align-left'
  | 'align-right'
  | 'align-top'
  | 'align-bottom'
  | 'align-center-horizontal'
  | 'align-center-vertical'
  | 'distribute-horizontal'
  | 'distribute-vertical'

export type WorkflowEditorCommand =
  | {
      readonly kind: 'document/replace'
      readonly document: WorkflowDocument
      readonly reason: 'history' | 'run-snapshot' | 'draft-recovery'
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/apply-node-changes'
      readonly graphId: string
      readonly changes: readonly NodeChange<StudioFlowNode>[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/apply-edge-changes'
      readonly graphId: string
      readonly changes: readonly EdgeChange<StudioFlowEdge>[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/connect'
      readonly graphId: string
      readonly sourceNode: string
      readonly sourceSocket: string
      readonly targetNode: string
      readonly targetSocket: string
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/add-node'
      readonly graphId: string
      readonly nodeType: string
      readonly position: { readonly x: number; readonly y: number }
      readonly generationBinding?: { readonly providerId: string; readonly model: string }
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/remove-nodes'
      readonly graphId: string
      readonly nodeIds: readonly string[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/add-compatible-node'
      readonly graphId: string
      readonly nodeType: string
      readonly position: { readonly x: number; readonly y: number }
      readonly sourceNode: string
      readonly sourceSocket: string
      readonly generationBinding?: { readonly providerId: string; readonly model: string }
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/add-subgraph-instance'
      readonly graphId: string
      readonly definitionId: string
      readonly position: { readonly x: number; readonly y: number }
      readonly source?: { readonly nodeId: string; readonly socket: string }
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/auto-layout'
      readonly graphId: string
      readonly nodeIds?: readonly string[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/arrange-selection'
      readonly graphId: string
      readonly nodeIds: readonly string[]
      readonly arrangement: WorkflowEditorArrangement
      /** Measured canvas sizes; edge-based alignments fall back to positions when absent. */
      readonly sizes?: Readonly<Record<string, { readonly width: number; readonly height: number }>>
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/resize-frame'
      readonly graphId: string
      readonly nodeId: string
      readonly width: number
      readonly height: number
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/update-nodes'
      readonly graphId: string
      readonly updates: readonly WorkflowEditorNodeUpdate[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/bind-generation-provider'
      readonly providerId: string
      readonly model: string
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/duplicate-nodes'
      readonly graphId: string
      readonly nodeIds: readonly string[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/paste-nodes'
      readonly graphId: string
      readonly payload: WorkflowEditorClipboardPayload
      readonly position?: { readonly x: number; readonly y: number }
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/convert-selection-to-subgraph'
      readonly graphId: string
      readonly nodeIds: readonly string[]
      readonly definitionId: string
      readonly name: string
      readonly description?: string
      readonly tags?: readonly string[]
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/insert-inpaint-chain'
      readonly prompt: string
      readonly sourcePath: string
      readonly maskPath: string
      readonly providerId: string
      readonly model: string
      readonly size: string
      readonly inputFidelity: 'low' | 'high'
      readonly assetTitle: string
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/import-project-image'
      readonly graphId: string
      readonly path: string
      readonly position: { readonly x: number; readonly y: number }
      readonly preview?: WorkflowEditorImagePreview
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'canvas/set-project-image'
      readonly graphId: string
      readonly nodeId: string
      readonly parameter: string
      readonly path: string
      readonly preview?: WorkflowEditorImagePreview
      readonly context?: WorkflowEditorContext
    }
  | { readonly kind: 'canvas/project-runtime'; readonly nodes: readonly WorkflowEditorRuntimeNodeUpdate[] }
  | { readonly kind: 'linear/set-value'; readonly fieldId: string; readonly value: string | number; readonly context?: WorkflowEditorContext }
  | {
      readonly kind: 'linear/set-values'
      readonly values: Readonly<Record<string, string | number>>
      readonly context?: WorkflowEditorContext
    }
  | {
      readonly kind: 'linear/set-field'
      readonly graphId: string
      readonly nodeId: string
      readonly parameter: string
      readonly label: string
      readonly exposed: boolean
      readonly context?: WorkflowEditorContext
    }
  | { readonly kind: 'history/undo'; readonly context?: WorkflowEditorContext }
  | { readonly kind: 'history/redo'; readonly context?: WorkflowEditorContext }
  | { readonly kind: 'readiness/set-providers'; readonly providers: readonly StudioReadinessProvider[] }
  | { readonly kind: 'readiness/repair'; readonly action: StudioRepairAction }

type WorkflowRuntimeProjectionCommand = Extract<WorkflowEditorCommand, { readonly kind: 'canvas/project-runtime' }>

export const createWorkflowRuntimeProjectionCommand = (
  graphs: Readonly<Record<string, GraphDocument>>,
): WorkflowRuntimeProjectionCommand => ({
  kind: 'canvas/project-runtime',
  nodes: Object.entries(graphs).flatMap(([graphId, graph]) => graph.nodes.map((node) => ({
    graphId,
    nodeId: node.id,
    ...(node.selected === undefined ? {} : { selected: node.selected }),
    ...(node.measured === undefined ? {} : { measured: node.measured }),
    ...(node.dragging === undefined ? {} : { dragging: node.dragging }),
    data: {
      status: node.data.status,
      ...(node.data.runtimeMs === undefined ? {} : { runtimeMs: node.data.runtimeMs }),
      ...(node.data.cacheHit === undefined ? {} : { cacheHit: node.data.cacheHit }),
      ...(node.data.dispatchState === undefined ? {} : { dispatchState: node.data.dispatchState }),
      ...(node.data.previewUrl === undefined ? {} : { previewUrl: node.data.previewUrl }),
      ...(node.data.previewPaths === undefined ? {} : { previewPaths: node.data.previewPaths }),
      ...(node.data.previewUrls === undefined ? {} : { previewUrls: node.data.previewUrls }),
      ...(node.data.previewRunId === undefined ? {} : { previewRunId: node.data.previewRunId }),
      ...(node.data.previewWidth === undefined ? {} : { previewWidth: node.data.previewWidth }),
      ...(node.data.previewHeight === undefined ? {} : { previewHeight: node.data.previewHeight }),
      ...(node.data.previewLoading === undefined ? {} : { previewLoading: node.data.previewLoading }),
      ...(node.data.previewError === undefined ? {} : { previewError: node.data.previewError }),
      ...(node.data.previewTone === undefined ? {} : { previewTone: node.data.previewTone }),
    },
  }))),
})

export type WorkflowEditorEffect =
  | { readonly kind: 'request-project'; readonly suggestedName: string }
  | {
      readonly kind: 'focus-canvas'
      readonly graphId: string
      readonly nodeId?: string
      readonly purpose: 'inspect' | 'connect'
    }
  | {
      readonly kind: 'request-local-image'
      readonly graphId: string
      readonly nodeId: string
      readonly parameter: string
    }

export interface WorkflowEditorTransition {
  readonly snapshot: WorkflowEditorSessionSnapshot
  /** True only when the canonical Workflow document changed. */
  readonly documentChanged: boolean
  /** UI work that cannot be completed inside the editor session. */
  readonly effect?: WorkflowEditorEffect
}

export interface WorkflowEditorSession {
  open(scope: WorkflowDocumentScope, document: WorkflowDocument, options?: { readonly dirty?: boolean }): void
  close(): void
  dispatch(command: WorkflowEditorCommand): WorkflowEditorTransition
  save(): Promise<WorkflowDocumentSaveResult>
  acceptFormalDocument(scope: PersistedWorkflowDocumentScope, document: WorkflowDocument): boolean
  flushDraft(): Promise<boolean>
  discardDraft(): Promise<boolean>
  getSnapshot(): WorkflowEditorSessionSnapshot
  getClipboardPayload(graphId: string, nodeIds: readonly string[]): WorkflowEditorClipboardPayload | undefined
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface CreateWorkflowEditorSessionOptions {
  readonly persistence: WorkflowDocumentPersistenceAdapter
  readonly scheduler?: WorkflowDocumentScheduler
  readonly draftDelayMs?: number
  readonly draftEnabled?: boolean
  readonly readinessProviders?: readonly StudioReadinessProvider[]
}

const clone = <T>(value: T): T => structuredClone(value)

const definitionPorts = (
  ports: NodeDefinition['inputs'] | NodeDefinition['outputs'],
): readonly CanvasPort[] => Object.values(ports).map((port) => ({
  id: port.id,
  label: port.label,
  dataType: port.dataType,
  required: port.required,
}))

const debugDataFromNode = (node: WorkflowNode): Partial<CanvasNodeData> => {
  const override = node.presentation?.debugOverride
  if (!override) return {}
  return {
    ...(override.action === 'pin' ? { pinned: true } : { mocked: true }),
    debugOutput: clone(override.value),
  }
}

const canvasPresentation = (presentation: NodePresentation | undefined): Partial<CanvasNodeData> => ({
  ...(presentation?.annotation ? { annotation: presentation.annotation } : {}),
  ...(presentation?.collapsed !== undefined ? { collapsed: presentation.collapsed } : {}),
  ...(presentation?.bypassed !== undefined ? { bypassed: presentation.bypassed } : {}),
  ...(presentation ? { rawPresentation: clone(presentation) } : {}),
})

const knownNode = (node: WorkflowNode): StudioFlowNode => {
  const definition = defaultRegistry.get(node.type)
  const framePresentation = node.type === 'frame'
    ? {
        width: typeof node.presentation?.width === 'number' ? node.presentation.width : 520,
        height: typeof node.presentation?.height === 'number' ? node.presentation.height : 320,
        ...(node.presentation ?? {}),
      }
    : undefined
  return {
    id: node.id,
    type: 'studio',
    position: clone(node.position),
    ...(framePresentation ? {
      style: { width: framePresentation.width, height: framePresentation.height },
      zIndex: -10,
    } : {}),
    data: {
      label: node.name,
      nodeType: node.type,
      category: definition.category,
      description: definition.description,
      inputs: definitionPorts(definition.inputs),
      outputs: definitionPorts(definition.outputs),
      parameters: clone(node.parameters),
      accent: definition.accent,
      status: 'idle',
      ...debugDataFromNode(node),
      ...canvasPresentation(node.presentation),
      ...(framePresentation ? { rawPresentation: clone(framePresentation) } : {}),
    },
  }
}

const missingNode = (
  node: WorkflowNode,
  inputSockets: readonly string[] = [],
  outputSockets: readonly string[] = [],
): StudioFlowNode => ({
  id: node.id,
  type: 'studio',
  position: clone(node.position),
  data: {
    label: node.name,
    nodeType: node.type,
    category: '缺失插件',
    description: '当前安全模式下以占位节点打开；原始参数已保留。',
    inputs: (inputSockets.length > 0 ? [...new Set(inputSockets)] : ['input'])
      .map((id) => ({ id, label: inputSockets.length > 0 ? id : '保留输入', dataType: 'any' as const })),
    outputs: (outputSockets.length > 0 ? [...new Set(outputSockets)] : ['output'])
      .map((id) => ({ id, label: outputSockets.length > 0 ? id : '保留输出', dataType: 'any' as const })),
    parameters: clone(node.parameters),
    accent: 'control',
    status: 'error',
    ...debugDataFromNode(node),
    ...canvasPresentation(node.presentation),
  },
})

const subgraphNode = (
  node: WorkflowNode,
  graphId: string,
  definition: SubgraphDefinition | undefined,
): StudioFlowNode => ({
  id: node.id,
  type: 'studio',
  position: clone(node.position),
  data: {
    label: node.name,
    nodeType: node.type,
    category: '子图',
    description: definition?.description || '双击进入类型化子图。',
    inputs: (definition?.inputs ?? []).map((port) => ({
      id: port.name,
      label: port.name,
      dataType: port.dataType,
      required: port.required,
    })),
    outputs: (definition?.outputs ?? []).map((port) => ({
      id: port.name,
      label: port.name,
      dataType: port.dataType,
      required: port.required,
    })),
    parameters: clone(node.parameters),
    accent: 'control',
    status: definition ? 'idle' : 'error',
    ...debugDataFromNode(node),
    subgraphId: `${graphId}/${node.id}`,
    subgraphDefinitionId: node.subgraph?.definitionId,
    subgraphDefinitionVersion: node.subgraph?.definitionVersion,
    ...canvasPresentation(node.presentation),
  },
})

const frameDimension = (node: StudioFlowNode, key: 'width' | 'height', fallback: number): number => {
  const presentation = node.data.rawPresentation?.[key]
  if (typeof presentation === 'number' && Number.isFinite(presentation)) return presentation
  const style = node.style?.[key]
  if (typeof style === 'number' && Number.isFinite(style)) return style
  return fallback
}

const applyCollapsedFrames = (nodes: readonly StudioFlowNode[]): readonly StudioFlowNode[] => {
  const frames = nodes.filter((node) => node.data.nodeType === 'frame' && node.data.collapsed)
  return nodes.map((node) => {
    if (node.data.nodeType === 'frame') return node.hidden ? { ...node, hidden: false } : node
    const hidden = frames.some((frame) => {
      const width = frameDimension(frame, 'width', 520)
      const height = frameDimension(frame, 'height', 320)
      return node.position.x >= frame.position.x
        && node.position.x <= frame.position.x + width
        && node.position.y >= frame.position.y
        && node.position.y <= frame.position.y + height
    })
    return node.hidden === hidden ? node : { ...node, hidden }
  })
}

const projectWorkflowGraphs = (workflow: WorkflowDocument): Readonly<Record<string, GraphDocument>> => {
  const definitions = workflow.subgraphs ?? []
  const byDefinition = new Map(definitions.map((definition) => [definition.id, definition]))
  const graphs: Record<string, GraphDocument> = {}

  const build = (
    document: WorkflowDocument,
    graphId: string,
    label: string,
    parentId: string | undefined,
    owner: Pick<GraphDocument, 'definitionId' | 'definitionVersion' | 'instanceNodeId'>,
    stack: readonly string[],
  ): void => {
    const inputSockets = new Map<string, string[]>()
    const outputSockets = new Map<string, string[]>()
    document.edges.forEach((edge) => {
      inputSockets.set(edge.targetNode, [...(inputSockets.get(edge.targetNode) ?? []), edge.targetSocket])
      outputSockets.set(edge.sourceNode, [...(outputSockets.get(edge.sourceNode) ?? []), edge.sourceSocket])
    })
    const rawNodes = document.nodes.map((node): StudioFlowNode => {
      if (node.type.startsWith('subgraph:') && node.subgraph) {
        return subgraphNode(node, graphId, byDefinition.get(node.subgraph.definitionId))
      }
      try {
        return knownNode(node)
      } catch {
        return missingNode(node, inputSockets.get(node.id), outputSockets.get(node.id))
      }
    })
    const nodes = applyCollapsedFrames(rawNodes)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const edges = document.edges.map((edge): StudioFlowEdge => {
      const source = byId.get(edge.sourceNode)
      const port = source?.data.outputs.find((output) => output.id === edge.sourceSocket)
      return {
        id: edge.id,
        source: edge.sourceNode,
        sourceHandle: `out:${edge.sourceSocket}`,
        target: edge.targetNode,
        targetHandle: `in:${edge.targetSocket}`,
        type: 'exposure',
        data: {
          dataType: port?.dataType ?? 'any',
          ...(edge.presentation ? { presentation: clone(edge.presentation) } : {}),
        },
      }
    })
    graphs[graphId] = {
      id: graphId,
      label,
      ...(parentId ? { parentId } : {}),
      ...owner,
      nodes,
      edges,
    }
    document.nodes.forEach((node) => {
      if (!node.subgraph || !node.type.startsWith('subgraph:')) return
      const definition = byDefinition.get(node.subgraph.definitionId)
      if (!definition || stack.includes(definition.id)) return
      build(
        definition.workflow,
        `${graphId}/${node.id}`,
        definition.name,
        graphId,
        {
          definitionId: definition.id,
          definitionVersion: definition.version,
          instanceNodeId: node.id,
        },
        [...stack, definition.id],
      )
    })
  }

  build(workflow, 'root', workflow.name, undefined, {}, [])
  return graphs
}

const fallbackLinearDefinition = (workflow: WorkflowDocument): LinearViewDefinition => {
  const textNode = workflow.nodes.find((node) => node.type === 'text')
  const generationNode = workflow.nodes.find((node) => node.type === 'image_generation')
  const fields = [
    ...(textNode && 'text' in textNode.parameters ? [{
      id: 'prompt',
      nodeId: textNode.id,
      parameter: 'text',
      label: '提示词',
      group: '画面描述',
      description: '描述内容、氛围和关键限制。',
      order: 10,
    }] : []),
    ...(generationNode ? [
      { id: 'model', nodeId: generationNode.id, parameter: 'model', label: '模型', group: '生成设置', order: 20 },
      { id: 'size', nodeId: generationNode.id, parameter: 'size', label: '尺寸', group: '生成设置', order: 30 },
      { id: 'seed', nodeId: generationNode.id, parameter: 'seed', label: 'Seed', group: '生成设置', order: 40 },
      { id: 'count', nodeId: generationNode.id, parameter: 'count', label: '候选数量', group: '生成设置', order: 50 },
    ].filter((field) => field.parameter in generationNode.parameters) : []),
  ]
  return {
    id: 'default',
    title: `${workflow.name} · 生成面板`,
    description: '作者只公开必要参数；普通用户无需进入复杂画布。',
    fields,
  }
}

const linearProjection = (workflow: WorkflowDocument): WorkflowEditorLinearProjection => {
  let definition = fallbackLinearDefinition(workflow)
  let source: WorkflowEditorLinearProjection['source'] = 'fallback'
  const saved = workflow.metadata?.linearView
  if (saved && typeof saved === 'object') {
    try {
      definition = validateLinearView(workflow, saved as LinearViewDefinition)
      source = 'saved'
    } catch {
      // An invalid saved projection never blocks opening the canonical document.
    }
  }
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const values = Object.fromEntries(definition.fields.flatMap((field) => {
    const value = nodes.get(field.nodeId)?.parameters[field.parameter]
    return typeof value === 'string' || typeof value === 'number' ? [[field.id, value] as const] : []
  }))
  return { definition, values, source }
}

const stableAction = (action: StudioRepairAction): string => JSON.stringify(
  Object.fromEntries(Object.entries(action).sort(([left], [right]) => left.localeCompare(right))),
)

interface WorkflowEditorHistoryEntry {
  readonly document: WorkflowDocument
  readonly context: WorkflowEditorContext
}

const appendHistory = (
  stack: readonly WorkflowEditorHistoryEntry[],
  entry: WorkflowEditorHistoryEntry,
): readonly WorkflowEditorHistoryEntry[] => [...stack.slice(-79), entry]

class WorkflowEditorSessionImplementation implements WorkflowEditorSession {
  readonly #documents: WorkflowDocumentSession
  readonly #editor = new WorkflowEditor()
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribeDocument: () => void

  #providers: readonly StudioReadinessProvider[]
  #runtimeGraphs: Readonly<Record<string, GraphDocument>> = {}
  #undoStack: readonly WorkflowEditorHistoryEntry[] = []
  #redoStack: readonly WorkflowEditorHistoryEntry[] = []
  #pendingDragSnapshot: WorkflowEditorHistoryEntry | undefined
  #snapshot!: WorkflowEditorSessionSnapshot
  #disposed = false

  constructor(options: CreateWorkflowEditorSessionOptions) {
    this.#providers = clone(options.readinessProviders ?? [])
    this.#documents = createWorkflowDocumentSession({
      adapter: options.persistence,
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.draftDelayMs === undefined ? {} : { draftDelayMs: options.draftDelayMs }),
    })
    this.#unsubscribeDocument = this.#documents.subscribe(() => this.#synchronize())
    this.#documents.setDraftEnabled(options.draftEnabled ?? true)
    this.#synchronize()
  }

  open(scope: WorkflowDocumentScope, document: WorkflowDocument, options: { readonly dirty?: boolean } = {}): void {
    this.#assertLive()
    this.#runtimeGraphs = {}
    this.#resetHistory()
    this.#documents.open(scope, document, options)
  }

  close(): void {
    if (this.#disposed) return
    this.#runtimeGraphs = {}
    this.#resetHistory()
    this.#documents.close()
  }

  dispatch(command: WorkflowEditorCommand): WorkflowEditorTransition {
    this.#assertLive()
    switch (command.kind) {
      case 'document/replace': {
        const before = this.#historyEntry(command.context)
        const changed = this.#replaceDocument(command.document, [])
        if (changed) {
          this.#recordHistory(before)
          this.#publish()
        }
        return this.#transition(changed)
      }
      case 'canvas/apply-node-changes':
        return this.#applyCanvasNodeChanges(command)
      case 'canvas/apply-edge-changes':
        return this.#applyCanvasEdgeChanges(command)
      case 'canvas/connect':
        return this.#connect(command)
      case 'canvas/add-node':
        return this.#addNode(command)
      case 'canvas/remove-nodes':
        return this.#removeNodes(command)
      case 'canvas/add-compatible-node':
        return this.#addCompatibleNode(command)
      case 'canvas/add-subgraph-instance':
        return this.#addSubgraphInstance(command)
      case 'canvas/auto-layout':
        return this.#autoLayout(command)
      case 'canvas/arrange-selection':
        return this.#arrangeSelection(command)
      case 'canvas/resize-frame':
        return this.#resizeFrame(command)
      case 'canvas/update-nodes':
        return this.#updateNodes(command)
      case 'canvas/bind-generation-provider':
        return this.#bindGenerationProvider(command)
      case 'canvas/duplicate-nodes':
        return this.#duplicateNodes(command)
      case 'canvas/paste-nodes':
        return this.#pasteNodes(command)
      case 'canvas/convert-selection-to-subgraph':
        return this.#convertSelectionToSubgraph(command)
      case 'canvas/insert-inpaint-chain':
        return this.#insertInpaintChain(command)
      case 'canvas/import-project-image':
        return this.#importProjectImage(command)
      case 'canvas/set-project-image':
        return this.#setProjectImage(command)
      case 'canvas/project-runtime':
        return this.#projectRuntime(command.nodes)
      case 'linear/set-value':
        return this.#recordedTransition(command.context, () => this.#setLinearValue(command.fieldId, command.value))
      case 'linear/set-values':
        return this.#recordedTransition(command.context, () => this.#setLinearValues(command.values))
      case 'linear/set-field':
        return this.#recordedTransition(command.context, () => this.#setLinearField(command))
      case 'history/undo':
        return this.#restoreHistory('undo', command.context)
      case 'history/redo':
        return this.#restoreHistory('redo', command.context)
      case 'readiness/set-providers':
        this.#providers = clone(command.providers)
        this.#publish()
        return this.#transition(false)
      case 'readiness/repair':
        return this.#repair(command.action)
    }
  }

  save = (): Promise<WorkflowDocumentSaveResult> => this.#documents.save()

  acceptFormalDocument(scope: PersistedWorkflowDocumentScope, document: WorkflowDocument): boolean {
    this.#assertLive()
    return this.#documents.rebaseAcceptedSave(scope, document)
  }

  flushDraft = (): Promise<boolean> => this.#documents.flushDraft()

  discardDraft = (): Promise<boolean> => this.#documents.discardDraft()

  getSnapshot = (): WorkflowEditorSessionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#assertLive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribeDocument()
    this.#documents.dispose()
    this.#listeners.clear()
    this.#runtimeGraphs = {}
    this.#resetHistory()
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('Workflow 编辑会话已关闭')
  }

  #requireDocument(): WorkflowDocument {
    const document = this.#documents.getSnapshot().document
    if (!document) throw new Error('Workflow 编辑会话尚未打开')
    return document
  }

  #transition(documentChanged: boolean, effect?: WorkflowEditorEffect): WorkflowEditorTransition {
    return {
      snapshot: this.#snapshot,
      documentChanged,
      ...(effect ? { effect } : {}),
    }
  }

  #resetHistory(): void {
    this.#undoStack = []
    this.#redoStack = []
    this.#pendingDragSnapshot = undefined
  }

  #normalizedContext(context?: WorkflowEditorContext): WorkflowEditorContext {
    const graphId = context?.graphId && this.#snapshot.graphs[context.graphId] ? context.graphId : 'root'
    return {
      graphId,
      ...(context?.selectedNodeId ? { selectedNodeId: context.selectedNodeId } : {}),
    }
  }

  #historyEntry(context?: WorkflowEditorContext): WorkflowEditorHistoryEntry {
    return {
      document: clone(this.#requireDocument()),
      context: this.#normalizedContext(context),
    }
  }

  #recordHistory(entry: WorkflowEditorHistoryEntry): void {
    this.#undoStack = appendHistory(this.#undoStack, entry)
    this.#redoStack = []
    this.#pendingDragSnapshot = undefined
  }

  #recordedTransition(
    context: WorkflowEditorContext | undefined,
    mutation: () => boolean,
    effect?: (snapshot: WorkflowEditorSessionSnapshot) => WorkflowEditorEffect | undefined,
  ): WorkflowEditorTransition {
    const before = this.#historyEntry(context)
    const changed = mutation()
    if (changed) {
      this.#recordHistory(before)
      this.#publish()
    }
    return this.#transition(changed, changed ? effect?.(this.#snapshot) : undefined)
  }

  #restoreHistory(
    direction: 'undo' | 'redo',
    context?: WorkflowEditorContext,
  ): WorkflowEditorTransition {
    const source = direction === 'undo' ? this.#undoStack : this.#redoStack
    const target = source.at(-1)
    if (!target) return this.#transition(false)
    const current = this.#historyEntry(context)
    const changed = this.#replaceDocument(target.document, [])
    if (direction === 'undo') {
      this.#undoStack = source.slice(0, -1)
      this.#redoStack = appendHistory(this.#redoStack, current)
    } else {
      this.#redoStack = source.slice(0, -1)
      this.#undoStack = appendHistory(this.#undoStack, current)
    }
    this.#pendingDragSnapshot = undefined
    this.#publish()
    return this.#transition(changed, {
      kind: 'focus-canvas',
      graphId: this.#snapshot.graphs[target.context.graphId] ? target.context.graphId : 'root',
      ...(target.context.selectedNodeId ? { nodeId: target.context.selectedNodeId } : {}),
      purpose: 'inspect',
    })
  }

  #graph(graphId: string): GraphDocument {
    const graph = this.#snapshot.graphs[graphId]
    if (!graph) throw new Error(`Workflow 画布不存在：${graphId}`)
    return graph
  }

  #editGraph(
    graphId: string,
    mutator: (workflow: WorkflowDocument) => WorkflowDocument,
    options: {
      readonly runtimeGraph?: GraphDocument
      readonly removedLinearNodeIds?: readonly string[]
    } = {},
  ): boolean {
    const graph = this.#graph(graphId)
    const previousRuntime = this.#runtimeGraphs
    if (options.runtimeGraph) {
      this.#runtimeGraphs = {
        ...this.#runtimeGraphs,
        [graphId]: this.#normalizeGraph(graph, options.runtimeGraph),
      }
    }
    const before = this.#documents.getSnapshot()
    try {
      this.#documents.edit((document) => {
        let candidate: WorkflowDocument
        if (graphId === 'root') {
          candidate = mutator(document)
        } else {
          const definitionId = graph.definitionId
          if (!definitionId) throw new Error(`Workflow 子图作用域无效：${graphId}`)
          const definitions = document.subgraphs ?? []
          const definition = definitions.find((item) => item.id === definitionId)
          if (!definition) throw new Error(`Workflow 子图定义不存在：${definitionId}`)
          const scoped = {
            ...clone(definition.workflow),
            subgraphs: clone(definitions),
          }
          const edited = mutator(scoped)
          candidate = {
            ...document,
            subgraphs: definitions.map((item) => item.id === definitionId ? {
              ...item,
              workflow: {
                ...edited,
                subgraphs: clone(definition.workflow.subgraphs ?? []),
              },
            } : item),
          }
        }
        return this.#withoutLinearBindings(
          document,
          candidate,
          graphId === 'root' ? options.removedLinearNodeIds ?? [] : [],
        )
      })
    } catch (error) {
      this.#runtimeGraphs = previousRuntime
      throw error
    }
    const changed = before !== this.#documents.getSnapshot()
    if (!changed) this.#synchronize()
    return changed
  }

  #projectRuntimeGraph(graphId: string, graph: GraphDocument): void {
    const current = this.#graph(graphId)
    this.#runtimeGraphs = {
      ...this.#runtimeGraphs,
      [graphId]: this.#normalizeGraph(current, graph),
    }
    this.#publish()
  }

  #projectRuntime(nodes: readonly WorkflowEditorRuntimeNodeUpdate[]): WorkflowEditorTransition {
    const projected = projectWorkflowGraphs(this.#requireDocument())
    const updates = new Map<string, WorkflowEditorRuntimeNodeUpdate>()
    for (const update of nodes) {
      const graph = projected[update.graphId]
      if (!graph) throw new Error(`Workflow 运行时画布不存在：${update.graphId}`)
      if (!graph.nodes.some((node) => node.id === update.nodeId)) {
        throw new Error(`Workflow 运行时节点不存在：${update.graphId}/${update.nodeId}`)
      }
      const key = `${update.graphId}\u0000${update.nodeId}`
      if (updates.has(key)) throw new Error(`Workflow 运行时节点更新重复：${update.graphId}/${update.nodeId}`)
      updates.set(key, clone(update))
    }
    this.#runtimeGraphs = Object.fromEntries(Object.entries(projected).map(([graphId, graph]) => [graphId, {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const update = updates.get(`${graphId}\u0000${node.id}`)
        if (!update) return node
        const data = Object.fromEntries(Object.entries(update.data).filter(([, value]) => value !== undefined))
        return {
          ...node,
          ...(update.selected === undefined ? {} : { selected: update.selected }),
          ...(update.measured === undefined ? {} : { measured: clone(update.measured) }),
          ...(update.dragging === undefined ? {} : { dragging: update.dragging }),
          data: { ...node.data, ...data },
        }
      }),
    }]))
    this.#publish()
    return this.#transition(false)
  }

  #applyCanvasNodeChanges(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/apply-node-changes' }>,
  ): WorkflowEditorTransition {
    const graph = this.#graph(command.graphId)
    const startsDrag = command.changes.some((change) => change.type === 'position' && change.dragging === true)
    const endsDrag = command.changes.some((change) => change.type === 'position' && change.dragging === false)
    const instantMutation = command.changes.some((change) => change.type === 'remove'
      || change.type === 'add'
      || change.type === 'replace'
      || (change.type === 'position' && change.dragging === undefined))
    const semanticMutation = command.changes.some((change) => change.type === 'remove'
      || change.type === 'add'
      || change.type === 'replace'
      || (change.type === 'position' && change.dragging !== true))
    if (startsDrag && !this.#pendingDragSnapshot) {
      this.#pendingDragSnapshot = this.#historyEntry(command.context)
    }
    const nextGraph = {
      ...graph,
      nodes: applyCollapsedFrames(applyNodeChanges(command.changes, graph.nodes)),
    }
    if (!semanticMutation) {
      this.#projectRuntimeGraph(command.graphId, nextGraph)
      return this.#transition(false)
    }

    const history = endsDrag && this.#pendingDragSnapshot
      ? this.#pendingDragSnapshot
      : instantMutation ? this.#historyEntry(command.context) : undefined
    const projectionOnly = command.changes.some((change) => change.type === 'add' || change.type === 'replace')
    const removedNodeIds = command.changes.flatMap((change) => change.type === 'remove' ? [change.id] : [])
    let changed = false
    try {
      if (projectionOnly) {
        changed = this.#commitGraph(command.graphId, nextGraph, removedNodeIds)
      } else {
        const positions = Object.fromEntries(command.changes.flatMap((change) => {
          if (change.type !== 'position' || change.dragging === true) return []
          const node = nextGraph.nodes.find((candidate) => candidate.id === change.id)
          return node ? [[node.id, clone(node.position)] as const] : []
        }))
        changed = this.#editGraph(command.graphId, (workflow) => {
          let next = workflow
          if (removedNodeIds.length > 0) next = this.#editor.removeNodes(next, removedNodeIds)
          if (Object.keys(positions).length > 0) next = this.#editor.moveNodes(next, positions)
          return next
        }, {
          runtimeGraph: nextGraph,
          removedLinearNodeIds: removedNodeIds,
        })
      }
    } finally {
      if (endsDrag) this.#pendingDragSnapshot = undefined
    }
    if (changed && history) {
      this.#recordHistory(history)
      this.#publish()
    }
    return this.#transition(changed)
  }

  #applyCanvasEdgeChanges(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/apply-edge-changes' }>,
  ): WorkflowEditorTransition {
    const graph = this.#graph(command.graphId)
    const mutation = command.changes.some((change) => change.type !== 'select')
    const nextGraph = { ...graph, edges: applyEdgeChanges(command.changes, graph.edges) }
    if (!mutation) {
      this.#projectRuntimeGraph(command.graphId, nextGraph)
      return this.#transition(false)
    }
    const history = this.#historyEntry(command.context)
    const projectionOnly = command.changes.some((change) => change.type === 'add' || change.type === 'replace')
    const removedEdgeIds = command.changes.flatMap((change) => change.type === 'remove' ? [change.id] : [])
    const changed = projectionOnly
      ? this.#commitGraph(command.graphId, nextGraph)
      : this.#editGraph(command.graphId, (workflow) => this.#editor.removeEdges(workflow, removedEdgeIds), {
          runtimeGraph: nextGraph,
        })
    if (changed) {
      this.#recordHistory(history)
      this.#publish()
    }
    return this.#transition(changed)
  }

  #connect(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/connect' }>,
  ): WorkflowEditorTransition {
    const graph = this.#graph(command.graphId)
    const duplicate = graph.edges.some((edge) => edge.source === command.sourceNode
      && edge.sourceHandle?.replace(/^out:/, '') === command.sourceSocket
      && edge.target === command.targetNode
      && edge.targetHandle?.replace(/^in:/, '') === command.targetSocket)
    if (duplicate) return this.#transition(false)
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) =>
      this.#editor.connect(workflow, {
        sourceNode: command.sourceNode,
        sourceSocket: command.sourceSocket,
        targetNode: command.targetNode,
        targetSocket: command.targetSocket,
      })))
  }

  #addNode(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/add-node' }>,
  ): WorkflowEditorTransition {
    let addedNodeId: string | undefined
    return this.#recordedTransition(
      command.context,
      () => this.#editGraph(command.graphId, (workflow) => {
        const generationBinding = remoteImageNodeTypes.has(command.nodeType) ? command.generationBinding : undefined
        const added = this.#addConfiguredNode(workflow, command.nodeType, command.position, generationBinding
          ? { parameters: generationBinding }
          : undefined)
        addedNodeId = added.nodeId
        return added.workflow
      }),
      () => addedNodeId
        ? { kind: 'focus-canvas', graphId: command.graphId, nodeId: addedNodeId, purpose: 'inspect' }
        : undefined,
    )
  }

  #removeNodes(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/remove-nodes' }>,
  ): WorkflowEditorTransition {
    const existing = new Set(this.#graph(command.graphId).nodes.map((node) => node.id))
    const nodeIds = [...new Set(command.nodeIds)].filter((nodeId) => existing.has(nodeId))
    if (nodeIds.length === 0) return this.#transition(false)
    return this.#recordedTransition(command.context, () => this.#editGraph(
      command.graphId,
      (workflow) => this.#editor.removeNodes(workflow, nodeIds),
      { removedLinearNodeIds: nodeIds },
    ))
  }

  #addCompatibleNode(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/add-compatible-node' }>,
  ): WorkflowEditorTransition {
    let addedNodeId: string | undefined
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      const registry = registryWithSubgraphs(defaultRegistry, workflow.subgraphs ?? [])
      const source = workflow.nodes.find((node) => node.id === command.sourceNode)
      if (!source) throw new Error(`来源节点不存在：${command.sourceNode}`)
      const output = registry.get(source.type).outputs[command.sourceSocket]
      if (!output) throw new Error(`来源端口不存在：${command.sourceNode}.${command.sourceSocket}`)
      const targetDefinition = registry.get(command.nodeType)
      const input = Object.values(targetDefinition.inputs).find((port) => registry.compatible(output.dataType, port.dataType))
      if (!input) throw new Error('所选节点没有兼容输入')
      const generationBinding = remoteImageNodeTypes.has(command.nodeType) ? command.generationBinding : undefined
      const added = this.#addConfiguredNode(workflow, command.nodeType, command.position, generationBinding
        ? { parameters: generationBinding }
        : undefined)
      addedNodeId = added.nodeId
      return this.#editor.connect(added.workflow, {
        sourceNode: command.sourceNode,
        sourceSocket: command.sourceSocket,
        targetNode: added.nodeId,
        targetSocket: input.id,
      })
    }), () => addedNodeId ? {
      kind: 'focus-canvas',
      graphId: command.graphId,
      nodeId: addedNodeId,
      purpose: 'inspect',
    } : undefined)
  }

  #addSubgraphInstance(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/add-subgraph-instance' }>,
  ): WorkflowEditorTransition {
    let addedNodeId: string | undefined
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      const definition = (workflow.subgraphs ?? []).find((item) => item.id === command.definitionId)
      if (!definition) throw new Error(`子图库中不存在该定义：${command.definitionId}`)
      const nodeId = crypto.randomUUID()
      addedNodeId = nodeId
      const node: WorkflowNode = {
        id: nodeId,
        type: `subgraph:${definition.id}`,
        name: definition.name,
        position: clone(command.position),
        parameters: {},
        subgraph: { definitionId: definition.id, definitionVersion: definition.version },
      }
      let candidate = validateWorkflow({
        ...workflow,
        nodes: [...workflow.nodes, node],
      })
      if (!command.source) return candidate
      const registry = registryWithSubgraphs(defaultRegistry, candidate.subgraphs ?? [])
      const source = candidate.nodes.find((item) => item.id === command.source?.nodeId)
      if (!source) throw new Error(`来源节点不存在：${command.source.nodeId}`)
      const output = registry.get(source.type).outputs[command.source.socket]
      if (!output) throw new Error(`来源端口不存在：${command.source.nodeId}.${command.source.socket}`)
      const input = definition.inputs.find((port) => registry.compatible(output.dataType, port.dataType))
      if (!input) throw new Error('所选子图没有兼容输入')
      candidate = this.#editor.connect(candidate, {
        sourceNode: source.id,
        sourceSocket: output.id,
        targetNode: nodeId,
        targetSocket: input.name,
      })
      return candidate
    }), () => addedNodeId ? {
      kind: 'focus-canvas',
      graphId: command.graphId,
      nodeId: addedNodeId,
      purpose: 'inspect',
    } : undefined)
  }

  #autoLayout(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/auto-layout' }>,
  ): WorkflowEditorTransition {
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      const positions = autoLayoutWorkflowNodes(workflow.nodes, workflow.edges, {
        ...(command.nodeIds ? { nodeIds: command.nodeIds } : {}),
      })
      return this.#editor.moveNodes(workflow, positions)
    }))
  }

  #arrangeSelection(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/arrange-selection' }>,
  ): WorkflowEditorTransition {
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      const selected = workflow.nodes.filter((node) => command.nodeIds.includes(node.id))
      if (selected.length < 2) return workflow
      const width = (node: WorkflowNode): number => command.sizes?.[node.id]?.width ?? 0
      const height = (node: WorkflowNode): number => command.sizes?.[node.id]?.height ?? 0
      const positions: Record<string, { x: number; y: number }> = {}
      if (command.arrangement === 'align-left') {
        const x = Math.min(...selected.map((node) => node.position.x))
        for (const node of selected) positions[node.id] = { x, y: node.position.y }
      } else if (command.arrangement === 'align-right') {
        const edge = Math.max(...selected.map((node) => node.position.x + width(node)))
        for (const node of selected) positions[node.id] = { x: Math.round(edge - width(node)), y: node.position.y }
      } else if (command.arrangement === 'align-top') {
        const y = Math.min(...selected.map((node) => node.position.y))
        for (const node of selected) positions[node.id] = { x: node.position.x, y }
      } else if (command.arrangement === 'align-bottom') {
        const edge = Math.max(...selected.map((node) => node.position.y + height(node)))
        for (const node of selected) positions[node.id] = { x: node.position.x, y: Math.round(edge - height(node)) }
      } else if (command.arrangement === 'align-center-horizontal') {
        const centers = selected.map((node) => node.position.x + (width(node) / 2))
        const center = (Math.min(...centers) + Math.max(...centers)) / 2
        for (const node of selected) positions[node.id] = { x: Math.round(center - (width(node) / 2)), y: node.position.y }
      } else if (command.arrangement === 'align-center-vertical') {
        const centers = selected.map((node) => node.position.y + (height(node) / 2))
        const center = (Math.min(...centers) + Math.max(...centers)) / 2
        for (const node of selected) positions[node.id] = { x: node.position.x, y: Math.round(center - (height(node) / 2)) }
      } else {
        const horizontal = command.arrangement === 'distribute-horizontal'
        const ordered = [...selected].sort((left, right) => horizontal
          ? left.position.x - right.position.x
          : left.position.y - right.position.y)
        const first = horizontal ? ordered[0]!.position.x : ordered[0]!.position.y
        const last = horizontal ? ordered.at(-1)!.position.x : ordered.at(-1)!.position.y
        const gap = ordered.length > 1 ? (last - first) / (ordered.length - 1) : 0
        ordered.forEach((node, index) => {
          positions[node.id] = horizontal
            ? { x: Math.round(first + (gap * index)), y: node.position.y }
            : { x: node.position.x, y: Math.round(first + (gap * index)) }
        })
      }
      return this.#editor.moveNodes(workflow, positions)
    }))
  }

  #resizeFrame(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/resize-frame' }>,
  ): WorkflowEditorTransition {
    const graph = this.#graph(command.graphId)
    const frame = graph.nodes.find((node) => node.id === command.nodeId && node.data.nodeType === 'frame')
    if (!frame) return this.#transition(false)
    const width = Math.max(240, Math.min(2400, Math.round(command.width)))
    const height = Math.max(120, Math.min(1600, Math.round(command.height)))
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) =>
      this.#editor.resizeCanvasItem(workflow, command.nodeId, { width, height })))
  }

  #applyNodeUpdate(node: WorkflowNode, update: WorkflowEditorNodeUpdate): WorkflowNode {
    const presentation = { ...(node.presentation ?? {}) } as Record<string, unknown>
    const changesPresentation = update.annotation !== undefined
      || update.bypassed !== undefined
      || update.collapsed !== undefined
      || update.debugOverride !== undefined
    if (update.annotation !== undefined) presentation.annotation = update.annotation
    if (update.bypassed !== undefined) presentation.bypassed = update.bypassed
    if (update.collapsed !== undefined) presentation.collapsed = update.collapsed
    if (update.debugOverride === null) delete presentation.debugOverride
    else if (update.debugOverride !== undefined) presentation.debugOverride = clone(update.debugOverride)
    const nextPresentation = changesPresentation
      ? Object.keys(presentation).length > 0 ? presentation as NodePresentation : undefined
      : node.presentation
    return {
      ...node,
      ...(update.name === undefined ? {} : { name: update.name }),
      ...(update.parameters === undefined ? {} : {
        parameters: { ...node.parameters, ...clone(update.parameters) },
      }),
      ...(nextPresentation ? { presentation: nextPresentation } : { presentation: undefined }),
    }
  }

  #updateNodes(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/update-nodes' }>,
  ): WorkflowEditorTransition {
    if (command.updates.length === 0) return this.#transition(false)
    const duplicate = command.updates.find((update, index) =>
      command.updates.findIndex((candidate) => candidate.nodeId === update.nodeId) !== index)
    if (duplicate) throw new Error(`节点更新重复：${duplicate.nodeId}`)
    return this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      let next = workflow
      for (const update of command.updates) {
        next = this.#editor.updateNode(next, update.nodeId, (node) => this.#applyNodeUpdate(node, update))
      }
      return next
    }))
  }

  #bindGenerationProvider(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/bind-generation-provider' }>,
  ): WorkflowEditorTransition {
    const updateBody = (workflow: WorkflowDocument): WorkflowDocument => ({
      ...workflow,
      nodes: workflow.nodes.map((node) => remoteImageNodeTypes.has(node.type) ? {
        ...node,
        parameters: { ...node.parameters, providerId: command.providerId, model: command.model },
      } : node),
    })
    return this.#recordedTransition(command.context, () => this.#edit((document) => ({
      ...updateBody(document),
      ...(document.subgraphs ? {
        subgraphs: document.subgraphs.map((definition) => ({
          ...definition,
          workflow: updateBody(definition.workflow),
        })),
      } : {}),
    })))
  }

  #duplicateNodes(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/duplicate-nodes' }>,
  ): WorkflowEditorTransition {
    const graph = this.#graph(command.graphId)
    const selected = [...new Set(command.nodeIds)].filter((nodeId) => graph.nodes.some((node) => node.id === nodeId))
    if (selected.length === 0) return this.#transition(false)
    const ids = new Set(selected)
    const replacements = new Map<string, string>(selected.map((nodeId) => [nodeId, crypto.randomUUID()]))
    const changed = this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      const copies = workflow.nodes.filter((node) => ids.has(node.id)).map((node) => ({
        ...clone(node),
        id: replacements.get(node.id) as string,
        position: { x: node.position.x + 42, y: node.position.y + 42 },
      }))
      const copiedEdges = workflow.edges.filter((edge) => ids.has(edge.sourceNode) && ids.has(edge.targetNode)).map((edge) => ({
        ...clone(edge),
        id: crypto.randomUUID(),
        sourceNode: replacements.get(edge.sourceNode) as string,
        targetNode: replacements.get(edge.targetNode) as string,
      }))
      return validateWorkflow({
        ...workflow,
        nodes: [...workflow.nodes, ...copies],
        edges: [...workflow.edges, ...copiedEdges],
      })
    }), () => {
      const nodeId = replacements.get(selected[0] as string)
      return nodeId ? { kind: 'focus-canvas', graphId: command.graphId, nodeId, purpose: 'inspect' } : undefined
    })
    if (changed.documentChanged) {
      const duplicated = new Set(replacements.values())
      const current = this.#graph(command.graphId)
      this.#runtimeGraphs = {
        ...this.#runtimeGraphs,
        [command.graphId]: {
          ...current,
          nodes: current.nodes.map((node) => ({
            ...node,
            selected: duplicated.has(node.id),
          })),
        },
      }
      this.#publish()
      return { ...changed, snapshot: this.#snapshot }
    }
    return changed
  }

  getClipboardPayload = (graphId: string, nodeIds: readonly string[]): WorkflowEditorClipboardPayload | undefined => {
    const ids = new Set(nodeIds)
    if (ids.size === 0) return undefined
    const document = this.#documents.getSnapshot().document
    if (!document) return undefined
    let workflow: { readonly nodes: readonly WorkflowNode[]; readonly edges: readonly WorkflowEdge[] }
    if (graphId === 'root') {
      workflow = document
    } else {
      const definitionId = this.#graph(graphId).definitionId
      const definition = document.subgraphs?.find((item) => item.id === definitionId)
      if (!definition) return undefined
      workflow = definition.workflow
    }
    const nodes = workflow.nodes.filter((node) => ids.has(node.id)).map((node) => clone(node))
    if (nodes.length === 0) return undefined
    const edges = workflow.edges
      .filter((edge) => ids.has(edge.sourceNode) && ids.has(edge.targetNode))
      .map((edge) => clone(edge))
    return { kind: 'ai-terminal/studio-nodes', version: 1, nodes, edges }
  }

  #pasteNodes(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/paste-nodes' }>,
  ): WorkflowEditorTransition {
    const payloadNodes = command.payload.nodes
    if (payloadNodes.length === 0) return this.#transition(false)
    const replacements = new Map<string, string>(payloadNodes.map((node) => [node.id, crypto.randomUUID()]))
    const anchorX = Math.min(...payloadNodes.map((node) => node.position.x))
    const anchorY = Math.min(...payloadNodes.map((node) => node.position.y))
    const offsetX = command.position ? command.position.x - anchorX : 42
    const offsetY = command.position ? command.position.y - anchorY : 42
    let firstNodeId: string | undefined
    const changed = this.#recordedTransition(command.context, () => this.#editGraph(command.graphId, (workflow) => {
      const copies = payloadNodes.map((node) => ({
        ...clone(node),
        id: replacements.get(node.id) as string,
        position: {
          x: Math.round(node.position.x + offsetX),
          y: Math.round(node.position.y + offsetY),
        },
      }))
      firstNodeId = copies[0]?.id
      const copiedEdges = command.payload.edges
        .filter((edge) => replacements.has(edge.sourceNode) && replacements.has(edge.targetNode))
        .map((edge) => ({
          ...clone(edge),
          id: crypto.randomUUID(),
          sourceNode: replacements.get(edge.sourceNode) as string,
          targetNode: replacements.get(edge.targetNode) as string,
        }))
      return validateWorkflow({
        ...workflow,
        nodes: [...workflow.nodes, ...copies],
        edges: [...workflow.edges, ...copiedEdges],
      })
    }), () => firstNodeId
      ? { kind: 'focus-canvas', graphId: command.graphId, nodeId: firstNodeId, purpose: 'inspect' }
      : undefined)
    if (changed.documentChanged) {
      const pasted = new Set(replacements.values())
      const current = this.#graph(command.graphId)
      this.#runtimeGraphs = {
        ...this.#runtimeGraphs,
        [command.graphId]: {
          ...current,
          nodes: current.nodes.map((node) => ({
            ...node,
            selected: pasted.has(node.id),
          })),
        },
      }
      this.#publish()
      return { ...changed, snapshot: this.#snapshot }
    }
    return changed
  }

  #convertSelectionToSubgraph(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/convert-selection-to-subgraph' }>,
  ): WorkflowEditorTransition {
    const nodeIds = [...new Set(command.nodeIds)]
    if (nodeIds.length === 0) return this.#transition(false)
    let instanceNodeId: string | undefined
    return this.#recordedTransition(command.context, () => {
      const graph = this.#graph(command.graphId)
      const current = this.#requireDocument()
      const conversion = {
        definitionId: command.definitionId,
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.tags === undefined ? {} : { tags: command.tags }),
      }
      if (command.graphId === 'root') {
        const result = convertSelectionToSubgraph(current, nodeIds, conversion)
        instanceNodeId = result.instance.id
        return this.#edit((document) => this.#withoutLinearBindings(document, result.workflow, nodeIds))
      }
      const definitionId = graph.definitionId
      const parent = current.subgraphs?.find((definition) => definition.id === definitionId)
      if (!parent) throw new Error('当前面包屑指向的子图定义不存在')
      const result = convertSelectionToSubgraph(
        { ...parent.workflow, subgraphs: current.subgraphs ?? [] },
        nodeIds,
        conversion,
      )
      instanceNodeId = result.instance.id
      const updatedParent = {
        ...parent,
        workflow: { ...result.workflow, subgraphs: [] },
      }
      const library = (result.workflow.subgraphs ?? []).map((definition) =>
        definition.id === updatedParent.id ? updatedParent : definition)
      validateSubgraphLibrary(library)
      return this.#edit((document) => ({ ...document, subgraphs: library }))
    }, () => instanceNodeId ? {
      kind: 'focus-canvas',
      graphId: command.graphId,
      nodeId: instanceNodeId,
      purpose: 'inspect',
    } : undefined)
  }

  #addConfiguredNode(
    workflow: WorkflowDocument,
    nodeType: string,
    position: { readonly x: number; readonly y: number },
    update?: Omit<WorkflowEditorNodeUpdate, 'nodeId'>,
  ): { readonly workflow: WorkflowDocument; readonly nodeId: string } {
    const before = new Set(workflow.nodes.map((node) => node.id))
    let next = this.#editor.addNode(workflow, nodeType, position)
    const nodeId = next.nodes.find((node) => !before.has(node.id))?.id
    if (!nodeId) throw new Error(`节点添加失败：${nodeType}`)
    if (update) {
      next = this.#editor.updateNode(next, nodeId, (node) => this.#applyNodeUpdate(node, { nodeId, ...update }))
    }
    return { workflow: next, nodeId }
  }

  #insertInpaintChain(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/insert-inpaint-chain' }>,
  ): WorkflowEditorTransition {
    let editNodeId: string | undefined
    return this.#recordedTransition(command.context, () => this.#editGraph('root', (workflow) => {
      const startX = Math.max(0, ...workflow.nodes.map((node) => node.position.x)) + 360
      const prompt = this.#addConfiguredNode(workflow, 'text', { x: startX, y: 40 }, {
        name: '局部重绘提示词',
        parameters: { text: command.prompt },
      })
      const source = this.#addConfiguredNode(prompt.workflow, 'project_image', { x: startX, y: 250 }, {
        name: `源图 · ${command.assetTitle}`,
        parameters: { path: command.sourcePath },
      })
      const mask = this.#addConfiguredNode(source.workflow, 'project_image', { x: startX, y: 470 }, {
        name: '局部重绘蒙版',
        parameters: { path: command.maskPath },
      })
      const edit = this.#addConfiguredNode(mask.workflow, 'image_inpaint', { x: startX + 360, y: 220 }, {
        name: `重绘 · ${command.assetTitle}`,
        parameters: {
          providerId: command.providerId,
          model: command.model,
          size: command.size,
          quality: 'high',
          count: 1,
          maskPath: command.maskPath,
          inputFidelity: command.inputFidelity,
          background: 'opaque',
          outputFormat: 'png',
        },
      })
      editNodeId = edit.nodeId
      const preview = this.#addConfiguredNode(edit.workflow, 'image_preview', { x: startX + 720, y: 240 }, {
        name: '重绘候选预览',
      })
      let next = this.#editor.connect(preview.workflow, {
        sourceNode: prompt.nodeId,
        sourceSocket: 'text',
        targetNode: edit.nodeId,
        targetSocket: 'prompt',
      })
      next = this.#editor.connect(next, {
        sourceNode: source.nodeId,
        sourceSocket: 'image',
        targetNode: edit.nodeId,
        targetSocket: 'image',
      })
      next = this.#editor.connect(next, {
        sourceNode: mask.nodeId,
        sourceSocket: 'image',
        targetNode: edit.nodeId,
        targetSocket: 'mask',
      })
      return this.#editor.connect(next, {
        sourceNode: edit.nodeId,
        sourceSocket: 'images',
        targetNode: preview.nodeId,
        targetSocket: 'images',
      })
    }), () => editNodeId ? {
      kind: 'focus-canvas',
      graphId: 'root',
      nodeId: editNodeId,
      purpose: 'inspect',
    } : undefined)
  }

  #setImagePreviewRuntime(
    graphId: string,
    nodeId: string,
    preview: WorkflowEditorImagePreview | undefined,
  ): void {
    const graph = this.#graph(graphId)
    this.#runtimeGraphs = {
      ...this.#runtimeGraphs,
      [graphId]: {
        ...graph,
        nodes: graph.nodes.map((node) => node.id === nodeId ? {
          ...node,
          data: {
            ...node.data,
            previewUrl: preview?.url,
            previewWidth: preview?.width,
            previewHeight: preview?.height,
            previewLoading: false,
            previewError: preview?.error,
          },
        } : node),
      },
    }
    this.#publish()
  }

  #importProjectImage(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/import-project-image' }>,
  ): WorkflowEditorTransition {
    let nodeId: string | undefined
    return this.#recordedTransition(command.context, () => {
      const changed = this.#editGraph(command.graphId, (workflow) => {
        const added = this.#addConfiguredNode(workflow, 'project_image', command.position, {
          parameters: { path: command.path },
        })
        nodeId = added.nodeId
        return added.workflow
      })
      if (changed && nodeId) this.#setImagePreviewRuntime(command.graphId, nodeId, command.preview)
      return changed
    }, () => nodeId ? {
      kind: 'focus-canvas',
      graphId: command.graphId,
      nodeId,
      purpose: 'inspect',
    } : undefined)
  }

  #setProjectImage(
    command: Extract<WorkflowEditorCommand, { readonly kind: 'canvas/set-project-image' }>,
  ): WorkflowEditorTransition {
    return this.#recordedTransition(command.context, () => {
      const changed = this.#editGraph(command.graphId, (workflow) => this.#editor.updateNode(
        workflow,
        command.nodeId,
        (node) => {
          if (!(command.parameter in node.parameters)) {
            throw new Error(`图片参数不存在：${command.nodeId}.${command.parameter}`)
          }
          return {
            ...node,
            parameters: { ...node.parameters, [command.parameter]: command.path },
          }
        },
      ))
      if (changed) this.#setImagePreviewRuntime(command.graphId, command.nodeId, command.preview)
      return changed
    })
  }

  #edit(mutator: (document: WorkflowDocument) => WorkflowDocument): boolean {
    const before = this.#documents.getSnapshot()
    this.#documents.edit(mutator)
    return before !== this.#documents.getSnapshot()
  }

  #replaceDocument(document: WorkflowDocument, removedLinearNodeIds: readonly string[]): boolean {
    const current = this.#requireDocument()
    if (document.id !== current.id) throw new Error('替换文档不属于当前 Workflow 作用域')
    return this.#edit((active) => this.#withoutLinearBindings(
      active,
      { ...clone(document), subgraphs: document.subgraphs === undefined ? undefined : clone(document.subgraphs) },
      removedLinearNodeIds,
    ))
  }

  #commitGraph(
    graphId: string,
    incoming: GraphDocument,
    removedLinearNodeIds: readonly string[] = [],
  ): boolean {
    return this.#commitProjection(
      { ...this.#snapshot.graphs, [graphId]: incoming },
      graphId,
      removedLinearNodeIds,
    )
  }

  #commitProjection(
    incomingGraphs: Readonly<Record<string, GraphDocument>>,
    preferredGraphId: string,
    removedLinearNodeIds: readonly string[],
  ): boolean {
    if (!this.#snapshot.graphs[preferredGraphId]) {
      throw new Error(`Workflow 画布不存在：${preferredGraphId}`)
    }
    const unknownGraphId = Object.keys(incomingGraphs).find((graphId) => !this.#snapshot.graphs[graphId])
    if (unknownGraphId) throw new Error(`Workflow 画布不属于当前文档：${unknownGraphId}`)
    const candidate = Object.fromEntries(Object.entries(this.#snapshot.graphs).map(([graphId, current]) => {
      const incoming = incomingGraphs[graphId] ?? current
      return [graphId, this.#normalizeGraph(current, incoming)]
    }))
    const previousRuntime = this.#runtimeGraphs
    this.#runtimeGraphs = candidate
    const before = this.#documents.getSnapshot()
    try {
      this.#documents.edit((document) => {
        const merged = mergeWorkflowDocumentProjection(document, candidate, preferredGraphId)
        return this.#withoutLinearBindings(document, merged, removedLinearNodeIds)
      })
    } catch (error) {
      this.#runtimeGraphs = previousRuntime
      throw error
    }
    const changed = before !== this.#documents.getSnapshot()
    if (!changed) this.#synchronize()
    return changed
  }

  #normalizeGraph(current: GraphDocument, incoming: GraphDocument): GraphDocument {
    if (incoming.id !== current.id) throw new Error('Workflow 画布 ID 与目标作用域不一致')
    const {
      parentId: _incomingParentId,
      definitionId: _incomingDefinitionId,
      definitionVersion: _incomingDefinitionVersion,
      instanceNodeId: _incomingInstanceNodeId,
      ...semanticGraph
    } = clone(incoming)
    const graph: GraphDocument = {
      ...semanticGraph,
      id: current.id,
      ...(current.parentId ? { parentId: current.parentId } : {}),
      ...(current.definitionId ? { definitionId: current.definitionId } : {}),
      ...(current.definitionVersion === undefined ? {} : { definitionVersion: current.definitionVersion }),
      ...(current.instanceNodeId ? { instanceNodeId: current.instanceNodeId } : {}),
    }
    return graph
  }

  #withoutLinearBindings(
    current: WorkflowDocument,
    candidate: WorkflowDocument,
    removedNodeIds: readonly string[],
  ): WorkflowDocument {
    if (removedNodeIds.length === 0 || current.metadata?.linearView === undefined) return candidate
    const removed = new Set(removedNodeIds)
    const definition = linearProjection(current).definition
    const fields = definition.fields.filter((field) => !removed.has(field.nodeId))
    if (fields.length === definition.fields.length) return candidate
    return setWorkflowLinearView(candidate, validateLinearView(candidate, { ...definition, fields }))
  }

  #setLinearValue(fieldId: string, value: string | number): boolean {
    const projection = this.#snapshot.linear
    if (!projection?.definition.fields.some((field) => field.id === fieldId)) {
      throw new Error(`Linear View 字段不存在：${fieldId}`)
    }
    return this.#edit((document) => applyLinearValues(document, projection.definition, { [fieldId]: value }))
  }

  #setLinearValues(values: Readonly<Record<string, string | number>>): boolean {
    const projection = this.#snapshot.linear
    if (!projection) throw new Error('Workflow 编辑会话尚未打开')
    return this.#edit((document) => applyLinearValues(document, projection.definition, values))
  }

  #setLinearField(command: Extract<WorkflowEditorCommand, { readonly kind: 'linear/set-field' }>): boolean {
    if (command.graphId !== 'root') throw new Error('请返回主工作流后再配置 Linear View 公开参数')
    const document = this.#requireDocument()
    const node = document.nodes.find((candidate) => candidate.id === command.nodeId)
    if (!node || !(command.parameter in node.parameters)) throw new Error('要公开的节点参数不存在')
    const projection = this.#snapshot.linear as WorkflowEditorLinearProjection
    const existing = projection.definition.fields.find((field) =>
      field.nodeId === command.nodeId && field.parameter === command.parameter)
    let fields = [...projection.definition.fields]
    if (!command.exposed) {
      if (!existing) return false
      fields = fields.filter((field) => field.id !== existing.id)
    } else {
      if (existing) return false
      const preferred = node.type === 'text' && command.parameter === 'text' ? 'prompt' : command.parameter
      const safePreferred = preferred.replace(/[^A-Za-z0-9_.-]/g, '_') || `field_${fields.length + 1}`
      let id = safePreferred
      let suffix = 2
      while (fields.some((field) => field.id === id)) {
        id = `${safePreferred}_${suffix}`
        suffix += 1
      }
      fields.push({
        id,
        nodeId: node.id,
        parameter: command.parameter,
        label: command.label.trim() || command.parameter,
        group: node.type === 'text' ? '画面描述' : defaultRegistry.has(node.type)
          ? defaultRegistry.get(node.type).category
          : '公开参数',
        order: Math.max(0, ...fields.map((field) => field.order)) + 10,
      })
    }
    const definition = validateLinearView(document, { ...projection.definition, fields })
    return this.#edit((current) => setWorkflowLinearView(current, definition))
  }

  #repair(action: StudioRepairAction): WorkflowEditorTransition {
    const report = this.#snapshot.readiness
    if (!report?.issues.some((issue) => stableAction(issue.action) === stableAction(action))) {
      throw new Error('该 Workflow 修复项已过期，请重新检查当前状态')
    }
    if (action.kind === 'remove-edge') {
      const graphId = action.graphId ?? 'root'
      const graph = this.#snapshot.graphs[graphId]
      if (!graph) throw new Error(`Workflow 画布不存在：${graphId}`)
      if (!graph.edges.some((edge) => edge.id === action.edgeId)) return this.#transition(false)
      return this.#transition(this.#commitGraph(graphId, {
        ...graph,
        edges: graph.edges.filter((edge) => edge.id !== action.edgeId),
      }))
    }
    if (action.kind === 'create-project') {
      return this.#transition(false, { kind: 'request-project', suggestedName: this.#requireDocument().name })
    }
    if (action.kind === 'import-local-image') {
      return this.#transition(false, {
        kind: 'request-local-image',
        graphId: action.graphId ?? 'root',
        nodeId: action.nodeId,
        parameter: action.parameter ?? 'path',
      })
    }
    return this.#transition(false, {
      kind: 'focus-canvas',
      graphId: action.graphId ?? 'root',
      ...(action.nodeId === '$workflow' ? {} : { nodeId: action.nodeId }),
      purpose: action.kind === 'connect-input' ? 'connect' : 'inspect',
    })
  }

  #synchronize(): void {
    const document = this.#documents.getSnapshot().document
    this.#runtimeGraphs = document
      ? preserveWorkflowGraphRuntime(projectWorkflowGraphs(document), this.#runtimeGraphs)
      : {}
    this.#publish()
  }

  #publish(): void {
    if (this.#disposed) return
    const documentSnapshot = this.#documents.getSnapshot()
    const document = documentSnapshot.document
    this.#snapshot = Object.freeze({
      ...documentSnapshot,
      graphs: this.#runtimeGraphs,
      linear: document ? linearProjection(document) : undefined,
      readiness: document ? inspectStudioReadiness({
        ...(documentSnapshot.scope?.projectPath ? { projectPath: documentSnapshot.scope.projectPath } : {}),
        workflow: document,
        providers: this.#providers,
      }) : undefined,
      history: {
        canUndo: this.#undoStack.length > 0,
        canRedo: this.#redoStack.length > 0,
      },
    })
    for (const listener of this.#listeners) listener()
  }
}

export const createWorkflowEditorSession = (
  options: CreateWorkflowEditorSessionOptions,
): WorkflowEditorSession => new WorkflowEditorSessionImplementation(options)
