import type { WorkflowDocument, WorkflowNode } from '../shared/types.js'

export interface LinearField {
  readonly id: string
  readonly nodeId: string
  readonly parameter: string
  readonly label: string
  readonly group: string
  readonly description?: string
  readonly order: number
}

export interface LinearViewDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly fields: readonly LinearField[]
}

export const validateLinearView = (
  workflow: WorkflowDocument,
  definition: LinearViewDefinition,
): LinearViewDefinition => {
  if (!definition.id.trim() || !definition.title.trim()) throw new Error('Linear View ID 和标题不能为空')
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const fieldIds = new Set<string>()
  const bindings = new Set<string>()
  definition.fields.forEach((field) => {
    if (fieldIds.has(field.id)) throw new Error(`公开参数 ID 重复：${field.id}`)
    fieldIds.add(field.id)
    if (!field.label.trim() || !field.group.trim() || !Number.isFinite(field.order)) throw new Error(`公开参数配置无效：${field.id}`)
    const node = nodes.get(field.nodeId)
    if (!node) throw new Error(`公开参数节点不存在：${field.nodeId}`)
    if (!(field.parameter in node.parameters)) throw new Error(`公开参数不存在：${field.nodeId}.${field.parameter}`)
    const binding = `${field.nodeId}\u0000${field.parameter}`
    if (bindings.has(binding)) throw new Error(`参数被重复公开：${field.nodeId}.${field.parameter}`)
    bindings.add(binding)
  })
  return definition
}

export const applyLinearValues = (
  workflow: WorkflowDocument,
  definition: LinearViewDefinition,
  values: Readonly<Record<string, unknown>>,
): WorkflowDocument => {
  validateLinearView(workflow, definition)
  if (Object.keys(values).length === 0) return workflow
  const fieldById = new Map(definition.fields.map((field) => [field.id, field]))
  const updates = new Map<string, Record<string, unknown>>()
  Object.entries(values).forEach(([fieldId, value]) => {
    const field = fieldById.get(fieldId)
    if (!field) throw new Error(`未公开的参数：${fieldId}`)
    const update = updates.get(field.nodeId) ?? {}
    update[field.parameter] = structuredClone(value)
    updates.set(field.nodeId, update)
  })
  const nodes: WorkflowNode[] = workflow.nodes.map((node) => {
    const update = updates.get(node.id)
    return update ? { ...node, parameters: { ...node.parameters, ...update } } : node
  })
  return { ...workflow, nodes }
}
