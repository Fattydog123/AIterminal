import type { NodeDefinition, WorkflowDocument, WorkflowEdge, WorkflowNode } from '../shared/types.js'
import { parseWorkflowDocument } from './migrations.js'
import { NodeRegistry, defaultRegistry, registryWithSubgraphs } from './registry.js'
import { validateSubgraphLibrary } from './subgraphs.js'

export interface WorkflowIssue {
  readonly code: string
  readonly message: string
  readonly nodeId?: string
  readonly edgeId?: string
}

export class WorkflowValidationError extends Error {
  constructor(readonly issues: readonly WorkflowIssue[]) {
    super(issues.map((issue) => issue.message).join('\n'))
    this.name = 'WorkflowValidationError'
  }
}

export interface WorkflowInspectionOptions {
  /** Editing permits temporarily unconnected nodes; execution preflight does not. */
  readonly requireConnectedInputs?: boolean
}

export const createWorkflow = (name = '未命名工作流'): WorkflowDocument => {
  const now = new Date().toISOString()
  return {
    schemaVersion: 3,
    id: crypto.randomUUID(),
    name,
    revision: 0,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    metadata: {},
    presentation: {},
    subgraphs: [],
  }
}

export const inspectWorkflow = (
  value: unknown,
  registry: NodeRegistry = defaultRegistry,
  options: WorkflowInspectionOptions = {},
): readonly WorkflowIssue[] => {
  let workflow: WorkflowDocument
  try {
    workflow = parseWorkflowDocument(value)
  } catch (error) {
    return [{ code: 'schema', message: error instanceof Error ? error.message : '工作流格式无效' }]
  }
  const issues: WorkflowIssue[] = []
  let effectiveRegistry = registry
  try {
    validateSubgraphLibrary(workflow.subgraphs ?? [], registry)
    effectiveRegistry = registryWithSubgraphs(registry, workflow.subgraphs ?? [])
  } catch (error) {
    issues.push({ code: 'subgraph', message: error instanceof Error ? error.message : '子图定义无效' })
  }
  const nodeById = new Map<string, WorkflowNode>()
  const edgeIds = new Set<string>()
  const targetSockets = new Set<string>()

  for (const node of workflow.nodes) {
    if (nodeById.has(node.id)) issues.push({ code: 'duplicate-node', message: `节点 ID 重复：${node.id}`, nodeId: node.id })
    nodeById.set(node.id, node)
    try {
      effectiveRegistry.get(node.type)
    } catch {
      issues.push({ code: 'missing-node-type', message: `缺少节点类型：${node.type}`, nodeId: node.id })
    }
    if (node.type.startsWith('subgraph:')) {
      const definitionId = node.type.slice('subgraph:'.length)
      const definition = (workflow.subgraphs ?? []).find((item) => item.id === definitionId)
      if (!node.subgraph || node.subgraph.definitionId !== definitionId) {
        issues.push({ code: 'subgraph-reference', message: `子图实例引用无效：${node.id}`, nodeId: node.id })
      } else if (definition && node.subgraph.definitionVersion !== definition.version) {
        issues.push({ code: 'subgraph-version', message: `子图实例版本锁定不匹配：${node.id}`, nodeId: node.id })
      }
    }
    if (node.presentation?.bypassed) {
      try {
        if (!effectiveRegistry.bypassRoute(node.type)) {
          issues.push({ code: 'invalid-bypass', message: `节点不能旁路：${node.type}`, nodeId: node.id })
        }
      } catch {
        // The missing-node issue above is more useful than a second bypass error.
      }
    }
  }

  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) issues.push({ code: 'duplicate-edge', message: `连线 ID 重复：${edge.id}`, edgeId: edge.id })
    edgeIds.add(edge.id)
    const sourceNode = nodeById.get(edge.sourceNode)
    const targetNode = nodeById.get(edge.targetNode)
    if (!sourceNode || !targetNode) {
      issues.push({ code: 'missing-node', message: `连线 ${edge.id} 引用了不存在的节点`, edgeId: edge.id })
      continue
    }
    let sourcePort
    let targetPort
    try {
      sourcePort = effectiveRegistry.get(sourceNode.type).outputs[edge.sourceSocket]
      targetPort = effectiveRegistry.get(targetNode.type).inputs[edge.targetSocket]
    } catch {
      continue
    }
    if (!sourcePort || !targetPort) {
      issues.push({ code: 'missing-port', message: `连线 ${edge.id} 引用了不存在的端口`, edgeId: edge.id })
      continue
    }
    if (!effectiveRegistry.compatible(sourcePort.dataType, targetPort.dataType)) {
      issues.push({ code: 'type-mismatch', message: `${sourcePort.dataType} 不能连接到 ${targetPort.dataType}`, edgeId: edge.id })
    }
    const targetKey = `${edge.targetNode}:${edge.targetSocket}`
    if (!targetPort.multiple && targetSockets.has(targetKey)) {
      issues.push({ code: 'duplicate-input', message: `输入端口只能连接一次：${targetKey}`, edgeId: edge.id })
    }
    targetSockets.add(targetKey)
  }

  if (options.requireConnectedInputs) {
    for (const node of workflow.nodes) {
      let definition: NodeDefinition
      try {
        definition = effectiveRegistry.get(node.type)
      } catch {
        continue
      }
      for (const input of Object.values(definition.inputs)) {
        if (input.required && !targetSockets.has(`${node.id}:${input.id}`)) {
          issues.push({
            code: 'missing-required-input',
            message: `必填输入尚未连接：${node.name}.${input.label}`,
            nodeId: node.id,
          })
        }
      }
      for (const group of definition.requiredInputGroups ?? []) {
        if (!group.some((inputId) => targetSockets.has(`${node.id}:${inputId}`))) {
          const labels = group.map((inputId) => definition.inputs[inputId]?.label ?? inputId).join(' / ')
          issues.push({
            code: 'missing-required-input-group',
            message: `至少连接一个输入：${node.name}.${labels}`,
            nodeId: node.id,
          })
        }
      }
    }
  }

  try {
    topologicalOrder(workflow.nodes, workflow.edges)
  } catch (error) {
    issues.push({ code: 'cycle', message: error instanceof Error ? error.message : '工作流包含循环' })
  }
  return issues
}

export const validateExecutableWorkflow = (
  value: unknown,
  registry: NodeRegistry = defaultRegistry,
): WorkflowDocument => {
  const parsed = parseWorkflowDocument(value)
  const issues = inspectWorkflow(parsed, registry, { requireConnectedInputs: true })
  if (issues.length > 0) throw new WorkflowValidationError(issues)
  return parsed
}

export const validateWorkflow = (
  value: unknown,
  registry: NodeRegistry = defaultRegistry,
): WorkflowDocument => {
  const parsed = parseWorkflowDocument(value)
  const issues = inspectWorkflow(parsed, registry)
  if (issues.length > 0) throw new WorkflowValidationError(issues)
  return parsed
}

export const topologicalOrder = (
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): readonly string[] => {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
  edges.forEach((edge) => {
    if (!indegree.has(edge.sourceNode) || !indegree.has(edge.targetNode)) return
    indegree.set(edge.targetNode, (indegree.get(edge.targetNode) ?? 0) + 1)
    outgoing.get(edge.sourceNode)?.push(edge.targetNode)
  })
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const result: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    if (!id) continue
    result.push(id)
    outgoing.get(id)?.forEach((targetId) => {
      const next = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, next)
      if (next === 0) queue.push(targetId)
    })
  }
  if (result.length !== nodes.length) throw new Error('工作流包含循环，无法执行')
  return result
}
