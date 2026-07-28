import type {
  NodeDefinition,
  Point,
  SubgraphDefinition,
  SubgraphInstanceReference,
  SubgraphPort,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../shared/types.js'
import { parseWorkflowDocument } from './migrations.js'
import { NodeRegistry, defaultRegistry, registryWithSubgraphs } from './registry.js'

export class SubgraphError extends Error {
  override readonly name = 'SubgraphError'
}

export interface SubgraphConversionResult {
  readonly workflow: WorkflowDocument
  readonly definition: SubgraphDefinition
  readonly instance: WorkflowNode
}

export interface SubgraphBreadcrumb {
  readonly depth: number
  readonly instanceNodeId?: string
  readonly definitionId?: string
  readonly label: string
  readonly workflow: WorkflowDocument
}

const instanceReference = (node: WorkflowNode): SubgraphInstanceReference | undefined => {
  if (!node.type.startsWith('subgraph:')) return undefined
  if (!node.subgraph) throw new SubgraphError(`子图实例缺少引用：${node.id}`)
  return node.subgraph
}

const definitionMap = (definitions: readonly SubgraphDefinition[]): ReadonlyMap<string, SubgraphDefinition> => {
  const map = new Map<string, SubgraphDefinition>()
  for (const definition of definitions) {
    if (map.has(definition.id)) throw new SubgraphError(`子图定义 ID 重复：${definition.id}`)
    map.set(definition.id, definition)
  }
  return map
}

const assertPort = (
  port: SubgraphPort,
  direction: 'input' | 'output',
  definition: SubgraphDefinition,
  registry: NodeRegistry,
): void => {
  const node = definition.workflow.nodes.find((item) => item.id === port.internalNodeId)
  if (!node) throw new SubgraphError(`子图端口引用了不存在的节点：${definition.id}.${port.name}`)
  const nodeDefinition = registry.get(node.type)
  const internal = direction === 'input'
    ? nodeDefinition.inputs[port.internalSocket]
    : nodeDefinition.outputs[port.internalSocket]
  if (!internal) throw new SubgraphError(`子图端口引用了不存在的内部端口：${definition.id}.${port.name}`)
  if (internal.dataType !== port.dataType) {
    throw new SubgraphError(`子图端口类型与内部端口不一致：${definition.id}.${port.name}`)
  }
}

const validateGraphBody = (workflow: WorkflowDocument, registry: NodeRegistry, owner: string): void => {
  const nodes = new Map<string, WorkflowNode>()
  for (const node of workflow.nodes) {
    if (nodes.has(node.id)) throw new SubgraphError(`子图 ${owner} 内部节点 ID 重复：${node.id}`)
    registry.get(node.type)
    nodes.set(node.id, node)
  }
  const edgeIds = new Set<string>()
  const occupiedInputs = new Set<string>()
  const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(workflow.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) throw new SubgraphError(`子图 ${owner} 内部连线 ID 重复：${edge.id}`)
    edgeIds.add(edge.id)
    const sourceNode = nodes.get(edge.sourceNode)
    const targetNode = nodes.get(edge.targetNode)
    if (!sourceNode || !targetNode) throw new SubgraphError(`子图 ${owner} 的连线引用了不存在的节点：${edge.id}`)
    const source = registry.get(sourceNode.type).outputs[edge.sourceSocket]
    const target = registry.get(targetNode.type).inputs[edge.targetSocket]
    if (!source || !target) throw new SubgraphError(`子图 ${owner} 的连线引用了不存在的端口：${edge.id}`)
    if (!registry.compatible(source.dataType, target.dataType)) {
      throw new SubgraphError(`子图 ${owner} 的端口类型不兼容：${edge.id}`)
    }
    const targetKey = `${edge.targetNode}\u0000${edge.targetSocket}`
    if (!target.multiple && occupiedInputs.has(targetKey)) {
      throw new SubgraphError(`子图 ${owner} 的单值输入被重复连接：${edge.targetNode}.${edge.targetSocket}`)
    }
    occupiedInputs.add(targetKey)
    indegree.set(edge.targetNode, (indegree.get(edge.targetNode) ?? 0) + 1)
    outgoing.get(edge.sourceNode)?.push(edge.targetNode)
  }
  const queue = workflow.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  let visited = 0
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]
    if (!nodeId) continue
    visited += 1
    for (const targetId of outgoing.get(nodeId) ?? []) {
      const next = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, next)
      if (next === 0) queue.push(targetId)
    }
  }
  if (visited !== workflow.nodes.length) throw new SubgraphError(`子图 ${owner} 内部工作流包含循环`)
}

export const validateSubgraphLibrary = (
  definitions: readonly SubgraphDefinition[],
  baseRegistry: NodeRegistry = defaultRegistry,
): readonly SubgraphDefinition[] => {
  const byId = definitionMap(definitions)
  const registry = registryWithSubgraphs(baseRegistry, definitions)
  for (const definition of definitions) {
    if (!definition.id.trim() || !definition.name.trim()) throw new SubgraphError('子图 ID 和名称不能为空')
    if (!Number.isInteger(definition.version) || definition.version < 1) throw new SubgraphError('子图版本必须为正整数')
    const inputNames = new Set<string>()
    const outputNames = new Set<string>()
    const portIds = new Set<string>()
    for (const [ports, direction, names] of [
      [definition.inputs, 'input', inputNames],
      [definition.outputs, 'output', outputNames],
    ] as const) {
      for (const port of ports) {
        if (!port.id.trim() || !port.name.trim()) throw new SubgraphError('子图端口 ID 和名称不能为空')
        if (names.has(port.name) || portIds.has(port.id)) throw new SubgraphError(`子图端口重复：${definition.id}.${port.name}`)
        names.add(port.name)
        portIds.add(port.id)
        assertPort(port, direction, definition, registry)
      }
    }
    validateGraphBody(parseWorkflowDocument(definition.workflow), registry, definition.id)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (definitionId: string): void => {
    if (visiting.has(definitionId)) throw new SubgraphError(`子图存在递归引用：${definitionId}`)
    if (visited.has(definitionId)) return
    const definition = byId.get(definitionId)
    if (!definition) throw new SubgraphError(`缺少子图定义：${definitionId}`)
    visiting.add(definitionId)
    for (const node of definition.workflow.nodes) {
      const reference = instanceReference(node)
      if (reference) {
        const child = byId.get(reference.definitionId)
        if (!child) throw new SubgraphError(`子图 ${definitionId} 引用了缺失的 ${reference.definitionId}`)
        if (child.version !== reference.definitionVersion) {
          throw new SubgraphError(`子图 ${reference.definitionId} 版本锁定不匹配`)
        }
        visit(reference.definitionId)
      }
    }
    visiting.delete(definitionId)
    visited.add(definitionId)
  }
  for (const definition of definitions) visit(definition.id)
  return definitions
}

export const upsertSubgraphDefinition = (
  definitions: readonly SubgraphDefinition[],
  next: SubgraphDefinition,
  registry: NodeRegistry = defaultRegistry,
): readonly SubgraphDefinition[] => {
  const previous = definitions.find((item) => item.id === next.id)
  if (previous && next.version <= previous.version) {
    throw new SubgraphError(`子图 ${next.id} 的新版本必须高于 ${previous.version}`)
  }
  const result = previous
    ? definitions.map((item) => item.id === next.id ? next : item)
    : [...definitions, next]
  validateSubgraphLibrary(result, registry)
  return result
}

const safePortName = (value: string, used: Set<string>): string => {
  const stem = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'port'
  let candidate = stem
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${stem}_${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

const boundaryPort = (
  definitionId: string,
  direction: 'input' | 'output',
  index: number,
  name: string,
  nodeId: string,
  socketId: string,
  nodeDefinition: NodeDefinition,
): SubgraphPort => {
  const internal = direction === 'input'
    ? nodeDefinition.inputs[socketId]
    : nodeDefinition.outputs[socketId]
  if (!internal) throw new SubgraphError(`无法公开内部端口：${nodeId}.${socketId}`)
  return {
    id: `${definitionId}:${direction}:${index + 1}`,
    name,
    dataType: internal.dataType,
    internalNodeId: nodeId,
    internalSocket: socketId,
    required: internal.required,
    ...(internal.multiple === undefined ? {} : { multiple: internal.multiple }),
  }
}

export const convertSelectionToSubgraph = (
  workflow: WorkflowDocument,
  selectedNodeIds: readonly string[],
  input: {
    readonly definitionId: string
    readonly name: string
    readonly description?: string
    readonly tags?: readonly string[]
    readonly instanceNodeId?: string
    readonly timestamp?: string
  },
  baseRegistry: NodeRegistry = defaultRegistry,
): SubgraphConversionResult => {
  const selected = new Set(selectedNodeIds)
  if (selected.size === 0) throw new SubgraphError('至少选择一个节点才能创建子图')
  if (!input.definitionId.trim() || !input.name.trim()) throw new SubgraphError('子图 ID 和名称不能为空')
  if ((workflow.subgraphs ?? []).some((item) => item.id === input.definitionId)) {
    throw new SubgraphError(`子图定义已存在：${input.definitionId}`)
  }
  const registry = registryWithSubgraphs(baseRegistry, workflow.subgraphs ?? [])
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  for (const nodeId of selected) {
    if (!byId.has(nodeId)) throw new SubgraphError(`选择的节点不存在：${nodeId}`)
  }
  const internalNodes = workflow.nodes.filter((node) => selected.has(node.id)).map((node) => structuredClone(node))
  const internalEdges = workflow.edges.filter((edge) => selected.has(edge.sourceNode) && selected.has(edge.targetNode)).map((edge) => structuredClone(edge))
  const incoming = workflow.edges.filter((edge) => !selected.has(edge.sourceNode) && selected.has(edge.targetNode))
  const outgoing = workflow.edges.filter((edge) => selected.has(edge.sourceNode) && !selected.has(edge.targetNode))

  const inputNames = new Set<string>()
  const inputs: SubgraphPort[] = []
  const inputByEdge = new Map<string, SubgraphPort>()
  for (const edge of incoming) {
    const target = byId.get(edge.targetNode)
    if (!target) throw new SubgraphError(`边界目标节点不存在：${edge.targetNode}`)
    const name = safePortName(`${target.name}_${edge.targetSocket}`, inputNames)
    const exposed = boundaryPort(
      input.definitionId,
      'input',
      inputs.length,
      name,
      target.id,
      edge.targetSocket,
      registry.get(target.type),
    )
    inputs.push(exposed)
    inputByEdge.set(edge.id, exposed)
  }

  const outputNames = new Set<string>()
  const outputs: SubgraphPort[] = []
  const outputByEndpoint = new Map<string, SubgraphPort>()
  for (const edge of outgoing) {
    const endpoint = `${edge.sourceNode}\u0000${edge.sourceSocket}`
    if (outputByEndpoint.has(endpoint)) continue
    const source = byId.get(edge.sourceNode)
    if (!source) throw new SubgraphError(`边界源节点不存在：${edge.sourceNode}`)
    const name = safePortName(`${source.name}_${edge.sourceSocket}`, outputNames)
    const exposed = boundaryPort(
      input.definitionId,
      'output',
      outputs.length,
      name,
      source.id,
      edge.sourceSocket,
      registry.get(source.type),
    )
    outputs.push(exposed)
    outputByEndpoint.set(endpoint, exposed)
  }

  const timestamp = input.timestamp ?? new Date().toISOString()
  const body: WorkflowDocument = {
    schemaVersion: 3,
    id: `${input.definitionId}:body`,
    name: `${input.name.trim()} / Body`,
    revision: 0,
    nodes: internalNodes,
    edges: internalEdges,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
    presentation: {},
    subgraphs: [],
  }
  const definition: SubgraphDefinition = {
    id: input.definitionId,
    name: input.name.trim(),
    version: 1,
    description: input.description?.trim() ?? '',
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    inputs,
    outputs,
    workflow: body,
  }
  const positions: Point[] = internalNodes.map((node) => node.position)
  const instance: WorkflowNode = {
    id: input.instanceNodeId ?? crypto.randomUUID(),
    type: `subgraph:${definition.id}`,
    name: definition.name,
    position: {
      x: positions.reduce((total, point) => total + point.x, 0) / positions.length,
      y: positions.reduce((total, point) => total + point.y, 0) / positions.length,
    },
    parameters: {},
    subgraph: { definitionId: definition.id, definitionVersion: definition.version },
  }
  if (workflow.nodes.some((node) => node.id === instance.id && !selected.has(node.id))) {
    throw new SubgraphError(`子图实例节点 ID 重复：${instance.id}`)
  }
  const firstSelectedIndex = workflow.nodes.findIndex((node) => selected.has(node.id))
  const remaining = workflow.nodes.filter((node) => !selected.has(node.id))
  const insertionIndex = workflow.nodes.slice(0, firstSelectedIndex).filter((node) => !selected.has(node.id)).length
  const nodes = [...remaining.slice(0, insertionIndex), instance, ...remaining.slice(insertionIndex)]
  const edges: WorkflowEdge[] = []
  for (const edge of workflow.edges) {
    if (selected.has(edge.sourceNode) && selected.has(edge.targetNode)) continue
    const exposedInput = inputByEdge.get(edge.id)
    if (exposedInput) {
      edges.push({ ...edge, targetNode: instance.id, targetSocket: exposedInput.name })
      continue
    }
    if (selected.has(edge.sourceNode)) {
      const exposedOutput = outputByEndpoint.get(`${edge.sourceNode}\u0000${edge.sourceSocket}`)
      if (!exposedOutput) throw new SubgraphError(`无法重写子图输出：${edge.id}`)
      edges.push({ ...edge, sourceNode: instance.id, sourceSocket: exposedOutput.name })
      continue
    }
    edges.push(edge)
  }
  const nextWorkflow: WorkflowDocument = {
    ...workflow,
    nodes,
    edges,
    subgraphs: [...(workflow.subgraphs ?? []), definition],
  }
  validateSubgraphLibrary(nextWorkflow.subgraphs ?? [], baseRegistry)
  return { workflow: nextWorkflow, definition, instance }
}

interface ExpandedGraph {
  readonly nodes: readonly WorkflowNode[]
  readonly edges: readonly WorkflowEdge[]
  readonly inputs: ReadonlyMap<string, readonly [string, string]>
  readonly outputs: ReadonlyMap<string, readonly [string, string]>
}

const scoped = (prefix: string, id: string): string => `${prefix}${id}`

const expand = (
  workflow: WorkflowDocument,
  definitions: ReadonlyMap<string, SubgraphDefinition>,
  prefix: string,
  boundary: SubgraphDefinition | undefined,
  stack: readonly string[],
): ExpandedGraph => {
  const regularIds = new Map<string, string>()
  const instances = new Map<string, ExpandedGraph>()
  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []
  for (const node of workflow.nodes) {
    const reference = instanceReference(node)
    if (!reference) {
      const nextId = scoped(prefix, node.id)
      regularIds.set(node.id, nextId)
      nodes.push({ ...structuredClone(node), id: nextId })
      continue
    }
    if (stack.includes(reference.definitionId)) {
      throw new SubgraphError(`子图递归展开：${[...stack, reference.definitionId].join(' -> ')}`)
    }
    const definition = definitions.get(reference.definitionId)
    if (!definition) throw new SubgraphError(`缺少子图定义：${reference.definitionId}`)
    if (definition.version !== reference.definitionVersion) {
      throw new SubgraphError(`子图 ${reference.definitionId} 的实例版本与定义不匹配`)
    }
    const child = expand(
      definition.workflow,
      definitions,
      `${scoped(prefix, node.id)}__`,
      definition,
      [...stack, reference.definitionId],
    )
    instances.set(node.id, child)
    nodes.push(...child.nodes)
    edges.push(...child.edges)
  }
  for (const edge of workflow.edges) {
    const sourceInstance = instances.get(edge.sourceNode)
    const targetInstance = instances.get(edge.targetNode)
    const source = sourceInstance?.outputs.get(edge.sourceSocket)
      ?? (regularIds.has(edge.sourceNode) ? [regularIds.get(edge.sourceNode) as string, edge.sourceSocket] as const : undefined)
    const target = targetInstance?.inputs.get(edge.targetSocket)
      ?? (regularIds.has(edge.targetNode) ? [regularIds.get(edge.targetNode) as string, edge.targetSocket] as const : undefined)
    if (!source) throw new SubgraphError(`未知子图输出：${edge.sourceNode}.${edge.sourceSocket}`)
    if (!target) throw new SubgraphError(`未知子图输入：${edge.targetNode}.${edge.targetSocket}`)
    edges.push({
      ...structuredClone(edge),
      id: scoped(prefix, edge.id),
      sourceNode: source[0],
      sourceSocket: source[1],
      targetNode: target[0],
      targetSocket: target[1],
    })
  }
  const inputs = new Map<string, readonly [string, string]>()
  const outputs = new Map<string, readonly [string, string]>()
  for (const port of boundary?.inputs ?? []) {
    const endpoint = instances.get(port.internalNodeId)?.inputs.get(port.internalSocket)
      ?? (regularIds.has(port.internalNodeId)
        ? [regularIds.get(port.internalNodeId) as string, port.internalSocket] as const
        : undefined)
    if (!endpoint) throw new SubgraphError(`子图公开输入无效：${boundary?.id}.${port.name}`)
    inputs.set(port.name, endpoint)
  }
  for (const port of boundary?.outputs ?? []) {
    const endpoint = instances.get(port.internalNodeId)?.outputs.get(port.internalSocket)
      ?? (regularIds.has(port.internalNodeId)
        ? [regularIds.get(port.internalNodeId) as string, port.internalSocket] as const
        : undefined)
    if (!endpoint) throw new SubgraphError(`子图公开输出无效：${boundary?.id}.${port.name}`)
    outputs.set(port.name, endpoint)
  }
  return { nodes, edges, inputs, outputs }
}

export const flattenSubgraphs = (
  workflow: WorkflowDocument,
  baseRegistry: NodeRegistry = defaultRegistry,
): WorkflowDocument => {
  const definitions = workflow.subgraphs ?? []
  validateSubgraphLibrary(definitions, baseRegistry)
  const expanded = expand(workflow, definitionMap(definitions), '', undefined, [])
  return {
    ...workflow,
    nodes: expanded.nodes,
    edges: expanded.edges,
    subgraphs: [],
  }
}

export const subgraphBreadcrumbs = (
  root: WorkflowDocument,
  instancePath: readonly string[],
): readonly SubgraphBreadcrumb[] => {
  const definitions = definitionMap(root.subgraphs ?? [])
  const result: SubgraphBreadcrumb[] = [{ depth: 0, label: root.name, workflow: root }]
  let current = root
  for (const [index, instanceNodeId] of instancePath.entries()) {
    const node = current.nodes.find((item) => item.id === instanceNodeId)
    if (!node) throw new SubgraphError(`面包屑路径节点不存在：${instanceNodeId}`)
    const reference = instanceReference(node)
    if (!reference) throw new SubgraphError(`面包屑路径不是子图实例：${instanceNodeId}`)
    const definition = definitions.get(reference.definitionId)
    if (!definition) throw new SubgraphError(`面包屑路径子图缺失：${reference.definitionId}`)
    current = definition.workflow
    result.push({
      depth: index + 1,
      instanceNodeId,
      definitionId: definition.id,
      label: definition.name,
      workflow: current,
    })
  }
  return result
}
