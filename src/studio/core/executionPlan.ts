import type { NodeDefinition, RunPlan, RunPlanNode, WorkflowDocument, WorkflowNode } from '../shared/types.js'
import { NodeRegistry, defaultRegistry, registryWithSubgraphs } from './registry.js'
import { topologicalOrder, validateWorkflow } from './workflow.js'

export type NodeOverride = { readonly action: 'pin' | 'mock'; readonly value: unknown }

const managedImagePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024) return false
  const normalized = value.replace(/\\/g, '/')
  return /^(?:assets|outputs)\//.test(normalized)
    && !normalized.split('/').includes('..')
    && !/^[a-zA-Z]:|^\//.test(value)
}

const assertOverrideValue = (definition: NodeDefinition, outputId: string, value: unknown): void => {
  const port = definition.outputs[outputId]
  if (!port) throw new Error(`固定输出端口不存在：${definition.title}.${outputId}`)
  if (value === undefined) throw new Error(`固定输出不能是 undefined：${definition.title}.${port.label}`)
  if (port.dataType === 'any') return
  if (port.dataType === 'text' && typeof value === 'string' && value.length <= 256_000) return
  if (port.dataType === 'number' && typeof value === 'number' && Number.isFinite(value)) return
  if (port.dataType === 'boolean' && typeof value === 'boolean') return
  if (port.dataType === 'image' && managedImagePath(value)) return
  if (port.dataType === 'images' && Array.isArray(value) && value.length <= 100 && value.every(managedImagePath)) return
  throw new Error(`固定输出类型不匹配：${definition.title}.${port.label} 需要 ${port.dataType}`)
}

export const materializeOverrideOutputs = (
  node: WorkflowNode,
  value: unknown,
  registry: NodeRegistry = defaultRegistry,
): Readonly<Record<string, unknown>> => {
  const definition = registry.get(node.type)
  const outputIds = Object.keys(definition.outputs)
  if (outputIds.length === 0) throw new Error(`节点没有可固定的输出：${node.name}`)
  const explicit = typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && outputIds.some((id) => Object.hasOwn(value, id))
  let outputs: Record<string, unknown>
  if (explicit) {
    const raw = value as Readonly<Record<string, unknown>>
    const unknown = Object.keys(raw).filter((key) => !outputIds.includes(key))
    if (unknown.length > 0) throw new Error(`固定输出包含未知端口：${unknown.join(', ')}`)
    outputs = Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, structuredClone(item)]))
  } else {
    const first = outputIds[0] as string
    outputs = { [first]: structuredClone(value) }
  }
  Object.entries(outputs).forEach(([outputId, item]) => assertOverrideValue(definition, outputId, item))
  return outputs
}

export const createExecutionPlan = (
  workflow: WorkflowDocument,
  targetNodeIds: readonly string[] | undefined,
  overrides: Readonly<Record<string, NodeOverride>> = {},
  cacheHits: ReadonlySet<string> = new Set(),
  registry: NodeRegistry = defaultRegistry,
  options: { readonly planId?: string; readonly estimatedCost?: number } = {},
): RunPlan => {
  if (workflow.nodes.some((node) => node.type.startsWith('subgraph:'))) {
    throw new Error('执行计划只接受已平铺工作流；请先调用 flattenSubgraphs')
  }
  validateWorkflow(workflow, registry)
  const effectiveRegistry = registryWithSubgraphs(registry, workflow.subgraphs ?? [])
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]))
  for (const nodeId of Object.keys(overrides)) {
    const node = nodeById.get(nodeId)
    if (!node) throw new Error(`调试覆盖节点不存在：${nodeId}`)
    const outputs = materializeOverrideOutputs(node, overrides[nodeId]?.value, effectiveRegistry)
    const usedOutput = workflow.edges
      .filter((edge) => edge.sourceNode === nodeId)
      .find((edge) => !Object.hasOwn(outputs, edge.sourceSocket))
    if (usedOutput) throw new Error(`固定输出缺少被使用端口：${node.name}.${usedOutput.sourceSocket}`)
  }
  const incoming = new Map<string, string[]>()
  const hasOutgoing = new Set<string>()
  workflow.edges.forEach((edge) => {
    incoming.set(edge.targetNode, [...(incoming.get(edge.targetNode) ?? []), edge.sourceNode])
    hasOutgoing.add(edge.sourceNode)
  })
  const roots = targetNodeIds?.length
    ? [...new Set(targetNodeIds)]
    : workflow.nodes.filter((node) => !hasOutgoing.has(node.id)).map((node) => node.id)
  const required = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId) continue
    const node = nodeById.get(nodeId)
    if (!node) throw new Error(`目标节点不存在：${nodeId}`)
    if (required.has(nodeId)) continue
    required.add(nodeId)
    const definition = effectiveRegistry.get(node.type)
    const dependencyCut = overrides[nodeId] !== undefined
      || (cacheHits.has(nodeId) && definition.cachePolicy === 'pure')
    if (!dependencyCut) stack.push(...(incoming.get(nodeId) ?? []))
  }
  const nodes: RunPlanNode[] = topologicalOrder(workflow.nodes, workflow.edges)
    .filter((nodeId) => required.has(nodeId))
    .map((nodeId) => {
      const override = overrides[nodeId]
      if (override) return { nodeId, action: override.action, reason: '用户固定调试输出' }
      const node = nodeById.get(nodeId)
      if (node?.presentation?.bypassed) {
        return { nodeId, action: 'bypass', reason: '节点已旁路，透传兼容输入' }
      }
      if (node && cacheHits.has(nodeId) && effectiveRegistry.get(node.type).cachePolicy === 'pure') {
        return { nodeId, action: 'cache', reason: '纯节点缓存命中' }
      }
      return { nodeId, action: 'execute', reason: '执行工作流节点' }
    })
  const connectedInputs = new Set(
    workflow.edges
      .filter((edge) => required.has(edge.sourceNode) && required.has(edge.targetNode))
      .map((edge) => `${edge.targetNode}\u0000${edge.targetSocket}`),
  )
  for (const planned of nodes) {
    if (!['execute', 'bypass'].includes(planned.action)) continue
    const node = nodeById.get(planned.nodeId)
    if (!node) continue
    const definition = effectiveRegistry.get(node.type)
    const requiredInputs = planned.action === 'bypass'
      ? [effectiveRegistry.bypassRoute(node.type)?.[0]].filter((value): value is string => Boolean(value))
      : Object.values(definition.inputs).filter((input) => input.required).map((input) => input.id)
    const missing = requiredInputs.find((inputId) => !connectedInputs.has(`${node.id}\u0000${inputId}`))
    if (missing) {
      const label = definition.inputs[missing]?.label ?? missing
      throw new Error(`必填输入尚未连接：${node.name}.${label}`)
    }
    if (planned.action === 'execute') {
      const missingGroup = (definition.requiredInputGroups ?? []).find((group) =>
        !group.some((inputId) => connectedInputs.has(`${node.id}\u0000${inputId}`)),
      )
      if (missingGroup) {
        const labels = missingGroup.map((inputId) => definition.inputs[inputId]?.label ?? inputId).join(' / ')
        throw new Error(`至少连接一个输入：${node.name}.${labels}`)
      }
    }
  }
  return {
    id: options.planId ?? crypto.randomUUID(),
    workflowId: workflow.id,
    taskCount: nodes.filter((node) => node.action === 'execute').length,
    remoteTaskCount: nodes.filter((planned) => {
      const node = nodeById.get(planned.nodeId)
      return planned.action === 'execute' && node !== undefined && effectiveRegistry.get(node.type).cachePolicy === 'side-effecting'
    }).length,
    ...(options.estimatedCost === undefined ? {} : { estimatedCost: options.estimatedCost }),
    nodes,
  }
}
