import type { EdgeChange, NodeChange } from '@xyflow/react'
import type { StudioFlowEdge, StudioFlowNode } from '../types.js'

export const applyNodeChanges = (
  changes: readonly NodeChange<StudioFlowNode>[],
  nodes: readonly StudioFlowNode[],
): StudioFlowNode[] => {
  const changesById = new Map<string, NodeChange<StudioFlowNode>[]>()
  const additions: Extract<NodeChange<StudioFlowNode>, { type: 'add' }>[] = []

  for (const change of changes) {
    if (change.type === 'add') {
      additions.push(change)
      continue
    }
    if (change.type === 'remove' || change.type === 'replace') {
      changesById.set(change.id, [change])
      continue
    }
    const queued = changesById.get(change.id)
    if (queued) queued.push(change)
    else changesById.set(change.id, [change])
  }

  const updated: StudioFlowNode[] = []
  for (const node of nodes) {
    const queued = changesById.get(node.id)
    const first = queued?.[0]
    if (!queued || !first) {
      updated.push(node)
      continue
    }
    if (first.type === 'remove') continue
    if (first.type === 'replace') {
      updated.push({ ...first.item })
      continue
    }

    const next = { ...node }
    for (const change of queued) {
      if (change.type === 'select') next.selected = change.selected
      if (change.type === 'position') {
        if (change.position !== undefined) next.position = change.position
        if (change.dragging !== undefined) next.dragging = change.dragging
      }
      if (change.type === 'dimensions') {
        if (change.dimensions !== undefined) {
          next.measured = { ...change.dimensions }
          if (change.setAttributes === true || change.setAttributes === 'width') next.width = change.dimensions.width
          if (change.setAttributes === true || change.setAttributes === 'height') next.height = change.dimensions.height
        }
        if (change.resizing !== undefined) next.resizing = change.resizing
      }
    }
    updated.push(next)
  }

  for (const addition of additions) {
    const item = { ...addition.item }
    if (addition.index === undefined) updated.push(item)
    else updated.splice(addition.index, 0, item)
  }
  return updated
}

export const applyEdgeChanges = (
  changes: readonly EdgeChange<StudioFlowEdge>[],
  edges: readonly StudioFlowEdge[],
): StudioFlowEdge[] => {
  const changesById = new Map<string, EdgeChange<StudioFlowEdge>[]>()
  const additions: Extract<EdgeChange<StudioFlowEdge>, { type: 'add' }>[] = []

  for (const change of changes) {
    if (change.type === 'add') {
      additions.push(change)
      continue
    }
    if (change.type === 'remove' || change.type === 'replace') {
      changesById.set(change.id, [change])
      continue
    }
    const queued = changesById.get(change.id)
    if (queued) queued.push(change)
    else changesById.set(change.id, [change])
  }

  const updated: StudioFlowEdge[] = []
  for (const edge of edges) {
    const queued = changesById.get(edge.id)
    const first = queued?.[0]
    if (!queued || !first) {
      updated.push(edge)
      continue
    }
    if (first.type === 'remove') continue
    if (first.type === 'replace') {
      updated.push({ ...first.item })
      continue
    }

    const next = { ...edge }
    for (const change of queued) {
      if (change.type === 'select') next.selected = change.selected
    }
    updated.push(next)
  }

  for (const addition of additions) {
    const item = { ...addition.item }
    if (addition.index === undefined) updated.push(item)
    else updated.splice(addition.index, 0, item)
  }
  return updated
}

const sameHandle = (left: string | null | undefined, right: string | null | undefined): boolean =>
  left === right || (!left && !right)

export const addEdge = (edge: StudioFlowEdge, edges: readonly StudioFlowEdge[]): StudioFlowEdge[] => {
  if (!edge.source || !edge.target) return [...edges]
  const duplicate = edges.some((current) =>
    current.source === edge.source &&
    current.target === edge.target &&
    sameHandle(current.sourceHandle, edge.sourceHandle) &&
    sameHandle(current.targetHandle, edge.targetHandle))
  if (duplicate) return [...edges]

  const { sourceHandle, targetHandle, ...rest } = edge
  return [
    ...edges,
    {
      ...rest,
      ...(sourceHandle === null ? {} : { sourceHandle }),
      ...(targetHandle === null ? {} : { targetHandle }),
    },
  ]
}
