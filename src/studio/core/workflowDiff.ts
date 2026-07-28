import type { WorkflowDocument, WorkflowEdge, WorkflowNode } from '../shared/types.js'

export interface WorkflowChange {
  readonly kind: 'added' | 'removed' | 'changed'
  readonly path: string
  readonly label: string
  readonly before?: unknown
  readonly after?: unknown
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]))
  }
  return false
}

const cloned = (value: unknown): unknown => value === undefined ? undefined : structuredClone(value)

const parameterChanges = (before: WorkflowNode, after: WorkflowNode): readonly WorkflowChange[] => {
  const keys = [...new Set([...Object.keys(before.parameters), ...Object.keys(after.parameters)])].sort()
  return keys.flatMap((key): readonly WorkflowChange[] => {
    const left = before.parameters[key]
    const right = after.parameters[key]
    if (equal(left, right)) return []
    const base = { path: `nodes.${after.id}.parameters.${key}`, label: `${after.name} / ${key}` }
    if (left === undefined) return [{ ...base, kind: 'added', after: cloned(right) }]
    if (right === undefined) return [{ ...base, kind: 'removed', before: cloned(left) }]
    return [{ ...base, kind: 'changed', before: cloned(left), after: cloned(right) }]
  })
}

const edgeValue = (edge: WorkflowEdge): string => `${edge.sourceSocket} → ${edge.targetSocket}`
const edgeLabel = (edge: WorkflowEdge, prefix: string): string => `${prefix}：${edge.sourceNode} → ${edge.targetNode}`

export const diffWorkflows = (
  before: WorkflowDocument,
  after: WorkflowDocument,
  limit = 10_000,
): readonly WorkflowChange[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('工作流差异上限必须是正整数')
  const changes: WorkflowChange[] = []
  const append = (change: WorkflowChange): void => {
    if (changes.length >= limit) throw new Error(`工作流差异超过安全上限 ${limit}`)
    changes.push(change)
  }
  if (before.name !== after.name) append({ kind: 'changed', path: 'name', label: '工作流名称', before: before.name, after: after.name })

  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))
  for (const node of before.nodes) {
    const edited = afterNodes.get(node.id)
    if (!edited) continue
    if (node.type !== edited.type) append({ kind: 'changed', path: `nodes.${node.id}.type`, label: `${edited.name} / 节点类型`, before: node.type, after: edited.type })
    if (node.name !== edited.name) append({ kind: 'changed', path: `nodes.${node.id}.name`, label: `${node.name} / 名称`, before: node.name, after: edited.name })
    parameterChanges(node, edited).forEach(append)
  }
  for (const node of after.nodes) {
    if (!beforeNodes.has(node.id)) append({ kind: 'added', path: `nodes.${node.id}`, label: `新增节点：${node.name}`, after: node.type })
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) append({ kind: 'removed', path: `nodes.${node.id}`, label: `删除节点：${node.name}`, before: node.type })
  }

  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]))
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]))
  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id)
    if (!previous) {
      append({ kind: 'added', path: `edges.${edge.id}`, label: edgeLabel(edge, '新增连线'), after: edgeValue(edge) })
    } else if (!equal(previous, edge)) {
      append({ kind: 'changed', path: `edges.${edge.id}`, label: edgeLabel(edge, '修改连线'), before: edgeValue(previous), after: edgeValue(edge) })
    }
  }
  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) append({ kind: 'removed', path: `edges.${edge.id}`, label: edgeLabel(edge, '删除连线'), before: edgeValue(edge) })
  }
  return changes
}
