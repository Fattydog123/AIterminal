import type { WorkflowEdge, WorkflowNode } from '../shared/types.js'

export interface AutoLayoutOptions {
  readonly nodeIds?: readonly string[]
  readonly columnGap?: number
  readonly rowGap?: number
}

export type WorkflowNodePositions = Readonly<Record<string, Readonly<{ x: number; y: number }>>>

const annotations = new Set(['frame', 'note'])
const finiteGap = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 80 && value <= 2_000 ? value : fallback

/** A deterministic, dependency-aware layout. It intentionally leaves visual
 * annotation nodes untouched so an automatic tidy never destroys authored notes. */
export const autoLayoutWorkflowNodes = (
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  options: AutoLayoutOptions = {},
): WorkflowNodePositions => {
  if (nodes.length > 10_000 || edges.length > 100_000) throw new Error('工作流过大，已拒绝自动布局')
  const requested = options.nodeIds ? new Set(options.nodeIds) : undefined
  const scoped = nodes.filter((node) => !annotations.has(node.type) && (!requested || requested.has(node.id)))
  if (scoped.length === 0) return {}
  const byId = new Map(scoped.map((node) => [node.id, node]))
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(scoped.map((node) => [node.id, 0]))
  for (const edge of edges) {
    if (!byId.has(edge.sourceNode) || !byId.has(edge.targetNode)) continue
    const targets = outgoing.get(edge.sourceNode) ?? []
    if (!targets.includes(edge.targetNode)) {
      outgoing.set(edge.sourceNode, [...targets, edge.targetNode])
      indegree.set(edge.targetNode, (indegree.get(edge.targetNode) ?? 0) + 1)
    }
  }
  const compareNodes = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId) as WorkflowNode
    const right = byId.get(rightId) as WorkflowNode
    return left.position.y - right.position.y || left.position.x - right.position.x || left.id.localeCompare(right.id)
  }
  const ready = scoped.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort(compareNodes)
  const depth = new Map(scoped.map((node) => [node.id, 0]))
  const visited = new Set<string>()
  while (ready.length > 0) {
    const nodeId = ready.shift() as string
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    for (const targetId of [...(outgoing.get(nodeId) ?? [])].sort(compareNodes)) {
      depth.set(targetId, Math.max(depth.get(targetId) ?? 0, (depth.get(nodeId) ?? 0) + 1))
      const remaining = (indegree.get(targetId) ?? 1) - 1
      indegree.set(targetId, remaining)
      if (remaining === 0) {
        ready.push(targetId)
        ready.sort(compareNodes)
      }
    }
  }
  // Invalid cyclic imports are still laid out deterministically; validation will
  // continue to report the cycle instead of hanging the renderer.
  scoped.filter((node) => !visited.has(node.id)).sort((left, right) => compareNodes(left.id, right.id))
    .forEach((node) => depth.set(node.id, 0))

  const columns = new Map<number, WorkflowNode[]>()
  for (const node of scoped) columns.set(depth.get(node.id) ?? 0, [...(columns.get(depth.get(node.id) ?? 0) ?? []), node])
  const anchorX = Math.min(...scoped.map((node) => node.position.x))
  const anchorY = Math.min(...scoped.map((node) => node.position.y))
  const columnGap = finiteGap(options.columnGap, 360)
  const rowGap = finiteGap(options.rowGap, 250)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [column, columnNodes] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    columnNodes.sort((left, right) => compareNodes(left.id, right.id))
    columnNodes.forEach((node, row) => {
      positions[node.id] = { x: anchorX + column * columnGap, y: anchorY + row * rowGap }
    })
  }
  return positions
}
