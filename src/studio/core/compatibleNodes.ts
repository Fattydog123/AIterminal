import type {
  NodeDefinition,
  Point,
  SocketDataType,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../shared/types.js'
import { NodeRegistry, defaultRegistry } from './registry.js'
import { validateWorkflow } from './workflow.js'

export type LooseConnection =
  | {
      readonly direction: 'from-output'
      readonly nodeId: string
      readonly socketId: string
    }
  | {
      readonly direction: 'to-input'
      readonly nodeId: string
      readonly socketId: string
    }

export interface CompatibleNodeSuggestion {
  readonly nodeType: string
  readonly title: string
  readonly category: string
  readonly socketId: string
  readonly socketLabel: string
  readonly dataType: SocketDataType
  readonly exactType: boolean
  readonly sideEffecting: boolean
}

const looseType = (
  workflow: WorkflowDocument,
  loose: LooseConnection,
  registry: NodeRegistry,
): SocketDataType => {
  const node = workflow.nodes.find((item) => item.id === loose.nodeId)
  if (!node) throw new Error(`连线起点节点不存在：${loose.nodeId}`)
  const definition = registry.get(node.type)
  const port = loose.direction === 'from-output'
    ? definition.outputs[loose.socketId]
    : definition.inputs[loose.socketId]
  if (!port) throw new Error(`连线端口不存在：${loose.nodeId}.${loose.socketId}`)
  return port.dataType
}

export const compatibleNodeSuggestions = (
  workflow: WorkflowDocument,
  loose: LooseConnection,
  options: {
    readonly query?: string
    readonly includeSideEffecting?: boolean
    readonly limit?: number
  } = {},
  registry: NodeRegistry = defaultRegistry,
): readonly CompatibleNodeSuggestion[] => {
  const type = looseType(workflow, loose, registry)
  const query = options.query?.trim().toLocaleLowerCase() ?? ''
  const suggestions: CompatibleNodeSuggestion[] = []
  for (const definition of registry.list()) {
    if (!options.includeSideEffecting && definition.cachePolicy === 'side-effecting') continue
    if (query && !`${definition.title} ${definition.type} ${definition.category}`.toLocaleLowerCase().includes(query)) continue
    const sockets = loose.direction === 'from-output' ? definition.inputs : definition.outputs
    for (const socket of Object.values(sockets)) {
      const compatible = loose.direction === 'from-output'
        ? registry.compatible(type, socket.dataType)
        : registry.compatible(socket.dataType, type)
      if (!compatible) continue
      suggestions.push({
        nodeType: definition.type,
        title: definition.title,
        category: definition.category,
        socketId: socket.id,
        socketLabel: socket.label,
        dataType: socket.dataType,
        exactType: type === socket.dataType,
        sideEffecting: definition.cachePolicy === 'side-effecting',
      })
    }
  }
  return suggestions
    .sort((left, right) =>
      Number(right.exactType) - Number(left.exactType)
      || Number(left.sideEffecting) - Number(right.sideEffecting)
      || left.category.localeCompare(right.category, 'zh-CN')
      || left.title.localeCompare(right.title, 'zh-CN')
      || left.socketId.localeCompare(right.socketId),
    )
    .slice(0, Math.max(1, Math.trunc(options.limit ?? 50)))
}

const defaultNode = (
  definition: NodeDefinition,
  id: string,
  position: Point,
): WorkflowNode => ({
  id,
  type: definition.type,
  name: definition.title,
  position,
  parameters: Object.fromEntries(definition.parameters.map((item) => [item.id, structuredClone(item.defaultValue)])),
})

export const insertCompatibleNode = (
  workflow: WorkflowDocument,
  loose: LooseConnection,
  selection: { readonly nodeType: string; readonly socketId: string; readonly position: Point },
  dependencies: {
    readonly nodeId?: string
    readonly edgeId?: string
    readonly timestamp?: string
  } = {},
  registry: NodeRegistry = defaultRegistry,
): WorkflowDocument => {
  const definition = registry.get(selection.nodeType)
  const sourceType = looseType(workflow, loose, registry)
  const socket = loose.direction === 'from-output'
    ? definition.inputs[selection.socketId]
    : definition.outputs[selection.socketId]
  if (!socket) throw new Error(`候选节点端口不存在：${selection.nodeType}.${selection.socketId}`)
  const compatible = loose.direction === 'from-output'
    ? registry.compatible(sourceType, socket.dataType)
    : registry.compatible(socket.dataType, sourceType)
  if (!compatible) throw new Error(`${sourceType} 与 ${socket.dataType} 不兼容`)
  const nodeId = dependencies.nodeId ?? crypto.randomUUID()
  const edgeId = dependencies.edgeId ?? crypto.randomUUID()
  if (workflow.nodes.some((item) => item.id === nodeId)) throw new Error(`节点 ID 重复：${nodeId}`)
  if (workflow.edges.some((item) => item.id === edgeId)) throw new Error(`连线 ID 重复：${edgeId}`)
  const node = defaultNode(definition, nodeId, selection.position)
  const edge: WorkflowEdge = loose.direction === 'from-output'
    ? {
        id: edgeId,
        sourceNode: loose.nodeId,
        sourceSocket: loose.socketId,
        targetNode: nodeId,
        targetSocket: selection.socketId,
      }
    : {
        id: edgeId,
        sourceNode: nodeId,
        sourceSocket: selection.socketId,
        targetNode: loose.nodeId,
        targetSocket: loose.socketId,
      }
  const targetPort = loose.direction === 'from-output'
    ? socket
    : registry.get(workflow.nodes.find((item) => item.id === loose.nodeId)?.type ?? '').inputs[loose.socketId]
  const edges = targetPort?.multiple
    ? [...workflow.edges, edge]
    : [
        ...workflow.edges.filter((item) => item.targetNode !== edge.targetNode || item.targetSocket !== edge.targetSocket),
        edge,
      ]
  const candidate: WorkflowDocument = {
    ...workflow,
    nodes: [...workflow.nodes, node],
    edges,
  }
  validateWorkflow(candidate, registry)
  return candidate
}
