import type { WorkflowDocument, WorkflowEdge, WorkflowNode } from '@studio/shared/types.js'
import type { CanvasNodeData, GraphDocument, StudioFlowEdge, StudioFlowNode } from '../types.js'

type MutableRecord = Record<string, unknown>

const clone = <T>(value: T): T => structuredClone(value)

const runtimeNodeDataKeys = [
  'status', 'runtimeMs', 'cacheHit', 'dispatchState', 'previewUrl', 'previewPaths', 'previewUrls',
  'previewRunId', 'previewWidth', 'previewHeight', 'previewLoading', 'previewError', 'previewTone',
] as const

export const resetWorkflowNodeRuntime = (data: CanvasNodeData): CanvasNodeData => {
  const semanticData = Object.fromEntries(Object.entries(data).filter(([key]) =>
    !(runtimeNodeDataKeys as readonly string[]).includes(key))) as unknown as CanvasNodeData
  return {
    ...semanticData,
    parameters: clone(data.parameters),
    status: 'idle',
  }
}

export const preserveWorkflowGraphRuntime = (
  projectedGraphs: Readonly<Record<string, GraphDocument>>,
  runtimeGraphs?: Readonly<Record<string, GraphDocument>>,
): Readonly<Record<string, GraphDocument>> => {
  if (!runtimeGraphs) return projectedGraphs
  return Object.fromEntries(Object.entries(projectedGraphs).map(([graphId, graph]) => {
    const runtimeNodes = new Map((runtimeGraphs[graphId]?.nodes ?? []).map((node) => [node.id, node]))
    return [graphId, {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const runtime = runtimeNodes.get(node.id)
        if (!runtime) return node
        const runtimeData = Object.fromEntries(runtimeNodeDataKeys.flatMap((key) =>
          runtime.data[key] === undefined ? [] : [[key, runtime.data[key]]]))
        return {
          ...node,
          ...(runtime.selected === undefined ? {} : { selected: runtime.selected }),
          ...(runtime.measured === undefined ? {} : { measured: runtime.measured }),
          ...(runtime.dragging === undefined ? {} : { dragging: runtime.dragging }),
          data: { ...node.data, ...runtimeData },
        }
      }),
    }]
  }))
}

const nodePresentation = (
  current: WorkflowNode | undefined,
  node: StudioFlowNode,
): WorkflowNode['presentation'] | undefined => {
  const presentation: MutableRecord = {
    ...(current?.presentation ?? {}),
    ...(node.data.rawPresentation ?? {}),
  }
  delete presentation.annotation
  delete presentation.collapsed
  delete presentation.bypassed
  delete presentation.debugOverride

  if (node.data.annotation !== undefined) presentation.annotation = node.data.annotation
  if (node.data.collapsed !== undefined) presentation.collapsed = node.data.collapsed
  if (node.data.bypassed !== undefined) presentation.bypassed = node.data.bypassed
  if (node.data.pinned || node.data.mocked) {
    presentation.debugOverride = {
      action: node.data.pinned ? 'pin' : 'mock',
      value: clone(node.data.debugOutput),
    }
  }

  return Object.keys(presentation).length > 0
    ? presentation as WorkflowNode['presentation']
    : undefined
}

const mergeNode = (current: WorkflowNode | undefined, node: StudioFlowNode): WorkflowNode => {
  const { presentation: _presentation, subgraph: _subgraph, ...retained } = current ?? ({} as WorkflowNode)
  const presentation = nodePresentation(current, node)
  const definitionId = node.data.subgraphDefinitionId
  const definitionVersion = node.data.subgraphDefinitionVersion
  return {
    ...retained,
    id: node.id,
    type: node.data.nodeType,
    name: node.data.label,
    position: { ...(current?.position ?? {}), x: node.position.x, y: node.position.y },
    parameters: { ...(current?.parameters ?? {}), ...clone(node.data.parameters) },
    ...(presentation ? { presentation } : {}),
    ...(definitionId && definitionVersion ? {
      subgraph: { ...(current?.subgraph ?? {}), definitionId, definitionVersion },
    } : {}),
  } as WorkflowNode
}

const mergeEdge = (current: WorkflowEdge | undefined, edge: StudioFlowEdge): WorkflowEdge | undefined => {
  if (!edge.sourceHandle || !edge.targetHandle) return undefined
  const presentation = current?.presentation || edge.data?.presentation
    ? { ...(current?.presentation ?? {}), ...(edge.data?.presentation ?? {}) }
    : undefined
  const { presentation: _presentation, ...retained } = current ?? ({} as WorkflowEdge)
  return {
    ...retained,
    id: edge.id,
    sourceNode: edge.source,
    sourceSocket: edge.sourceHandle.replace(/^out:/, ''),
    targetNode: edge.target,
    targetSocket: edge.targetHandle.replace(/^in:/, ''),
    ...(presentation ? { presentation: clone(presentation) } : {}),
  } as WorkflowEdge
}

export const mergeGraphProjection = (
  document: WorkflowDocument,
  graph: GraphDocument,
): WorkflowDocument => {
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]))
  const edgesById = new Map(document.edges.map((edge) => [edge.id, edge]))
  return {
    ...document,
    name: graph.label,
    nodes: graph.nodes.map((node) => mergeNode(nodesById.get(node.id), node)),
    edges: graph.edges.flatMap((edge) => {
      const merged = mergeEdge(edgesById.get(edge.id), edge)
      return merged ? [merged] : []
    }),
  }
}

export const mergeWorkflowDocumentProjection = (
  document: WorkflowDocument,
  graphs: Readonly<Record<string, GraphDocument>>,
  preferredGraphId?: string,
): WorkflowDocument => {
  const root = graphs.root
  if (!root) return document
  const preferredGraph = preferredGraphId ? graphs[preferredGraphId] : undefined
  const subgraphs = document.subgraphs?.map((definition) => {
    const graph = preferredGraph?.definitionId === definition.id
      ? preferredGraph
      : Object.values(graphs).find((candidate) => candidate.definitionId === definition.id)
    if (!graph) return definition
    return {
      ...definition,
      name: graph.label,
      workflow: mergeGraphProjection(definition.workflow, {
        ...graph,
        label: `${graph.label} / Body`,
      }),
    }
  })
  return {
    ...mergeGraphProjection(document, root),
    ...(subgraphs ? { subgraphs } : {}),
  }
}

export const setWorkflowLinearView = (
  document: WorkflowDocument,
  definition: unknown,
): WorkflowDocument => ({
  ...document,
  metadata: {
    ...(document.metadata ?? {}),
    linearView: clone(definition),
  },
})
