import type {
  StudioCopilotNodeTarget,
  StudioCopilotOperation,
} from '../../../../../studio/shared/contracts.js'
import type { WorkflowDocument } from '../../../../../studio/shared/types.js'
import { defaultRegistry } from '../../../../../studio/core/registry.js'
import type {
  WorkflowEditorCommand,
  WorkflowEditorContext,
  WorkflowEditorSessionSnapshot,
  WorkflowEditorTransition,
} from './workflow-editor-session.js'

const remoteImageNodeTypes = new Set([
  'image_generation',
  'image_edit',
  'image_inpaint',
  'image_outpaint',
])

export interface StudioCopilotOperationDispatcher {
  dispatch(command: WorkflowEditorCommand): WorkflowEditorTransition
}

export interface ApplyStudioCopilotOperationsInput {
  readonly operations: readonly StudioCopilotOperation[]
  readonly graphId: string
  readonly context?: WorkflowEditorContext
  readonly generationBinding?: { readonly providerId: string; readonly model: string }
}

export interface AppliedStudioCopilotOperations {
  readonly snapshot: WorkflowEditorSessionSnapshot
  readonly changedOperations: number
  readonly addedNodeIds: Readonly<Record<string, string>>
  readonly selectedNodeId?: string
}

const resolveTarget = (
  target: StudioCopilotNodeTarget,
  refs: ReadonlyMap<string, string>,
): string => {
  if ('nodeId' in target) return target.nodeId
  const nodeId = refs.get(target.ref)
  if (!nodeId) throw new Error(`计划引用的新节点不存在：${target.ref}`)
  return nodeId
}

export const applyStudioCopilotOperations = (
  dispatcher: StudioCopilotOperationDispatcher,
  input: ApplyStudioCopilotOperationsInput,
): AppliedStudioCopilotOperations => {
  const refs = new Map<string, string>()
  let snapshot: WorkflowEditorSessionSnapshot | undefined
  let changedOperations = 0
  let selectedNodeId = input.context?.selectedNodeId

  const dispatch = (command: WorkflowEditorCommand): WorkflowEditorTransition => {
    const transition = dispatcher.dispatch(command)
    snapshot = transition.snapshot
    if (transition.documentChanged) changedOperations += 1
    if (transition.effect?.kind === 'focus-canvas') selectedNodeId = transition.effect.nodeId
    return transition
  }

  for (const operation of input.operations) {
    if (operation.kind === 'add-node') {
      if (refs.has(operation.ref)) throw new Error(`计划中的新节点引用重复：${operation.ref}`)
      const added = dispatch({
        kind: 'canvas/add-node',
        graphId: input.graphId,
        nodeType: operation.nodeType,
        position: operation.position,
        ...(remoteImageNodeTypes.has(operation.nodeType) && input.generationBinding
          ? { generationBinding: input.generationBinding }
          : {}),
        ...(input.context ? { context: input.context } : {}),
      })
      const nodeId = added.effect?.kind === 'focus-canvas' ? added.effect.nodeId : undefined
      if (!nodeId) throw new Error(`计划没有为新节点 ${operation.ref} 返回有效 ID`)
      refs.set(operation.ref, nodeId)
      if (operation.name !== undefined || operation.parameters !== undefined || operation.annotation !== undefined) {
        dispatch({
          kind: 'canvas/update-nodes',
          graphId: input.graphId,
          updates: [{
            nodeId,
            ...(operation.name === undefined ? {} : { name: operation.name }),
            ...(operation.parameters === undefined ? {} : { parameters: operation.parameters }),
            ...(operation.annotation === undefined ? {} : { annotation: operation.annotation }),
          }],
          context: { graphId: input.graphId, selectedNodeId: nodeId },
        })
      }
      continue
    }
    if (operation.kind === 'update-node') {
      const nodeId = resolveTarget(operation.target, refs)
      dispatch({
        kind: 'canvas/update-nodes',
        graphId: input.graphId,
        updates: [{
          nodeId,
          ...(operation.name === undefined ? {} : { name: operation.name }),
          ...(operation.parameters === undefined ? {} : { parameters: operation.parameters }),
          ...(operation.annotation === undefined ? {} : { annotation: operation.annotation }),
          ...(operation.bypassed === undefined ? {} : { bypassed: operation.bypassed }),
          ...(operation.collapsed === undefined ? {} : { collapsed: operation.collapsed }),
        }],
        ...(input.context ? { context: input.context } : {}),
      })
      continue
    }
    if (operation.kind === 'remove-node') {
      dispatch({
        kind: 'canvas/remove-nodes',
        graphId: input.graphId,
        nodeIds: [resolveTarget(operation.target, refs)],
        ...(input.context ? { context: input.context } : {}),
      })
      continue
    }
    if (operation.kind === 'connect') {
      dispatch({
        kind: 'canvas/connect',
        graphId: input.graphId,
        sourceNode: resolveTarget(operation.source, refs),
        sourceSocket: operation.sourceSocket,
        targetNode: resolveTarget(operation.target, refs),
        targetSocket: operation.targetSocket,
        ...(input.context ? { context: input.context } : {}),
      })
      continue
    }
    dispatch({
      kind: 'canvas/auto-layout',
      graphId: input.graphId,
      ...(operation.nodes ? {
        nodeIds: operation.nodes.map((target) => resolveTarget(target, refs)),
      } : {}),
      ...(input.context ? { context: input.context } : {}),
    })
  }

  if (!snapshot) throw new Error('工作流计划没有可应用的操作')
  return {
    snapshot,
    changedOperations,
    addedNodeIds: Object.freeze(Object.fromEntries(refs)),
    ...(selectedNodeId ? { selectedNodeId } : {}),
  }
}

const targetLabel = (
  target: StudioCopilotNodeTarget,
  workflow: WorkflowDocument,
): string => {
  if ('ref' in target) return `新节点 ${target.ref}`
  return workflow.nodes.find((node) => node.id === target.nodeId)?.name ?? target.nodeId
}

const nodeTypeLabel = (nodeType: string): string => {
  try {
    return defaultRegistry.get(nodeType).title
  } catch {
    return '新节点'
  }
}

export const describeStudioCopilotOperation = (
  operation: StudioCopilotOperation,
  workflow: WorkflowDocument,
): string => {
  if (operation.kind === 'add-node') {
    const title = operation.name ?? nodeTypeLabel(operation.nodeType)
    return `添加“${title}”节点`
  }
  if (operation.kind === 'update-node') {
    return `调整“${targetLabel(operation.target, workflow)}”`
  }
  if (operation.kind === 'remove-node') {
    return `移除“${targetLabel(operation.target, workflow)}”`
  }
  if (operation.kind === 'connect') {
    return `连接“${targetLabel(operation.source, workflow)}”到“${targetLabel(operation.target, workflow)}”`
  }
  return operation.nodes?.length
    ? `整理 ${operation.nodes.length} 个节点`
    : '自动整理画布'
}

export const describeStudioCopilotOperationDetail = (
  operation: StudioCopilotOperation,
): string => {
  if (operation.kind === 'add-node') return nodeTypeLabel(operation.nodeType)
  if (operation.kind === 'update-node') return '调整节点'
  if (operation.kind === 'remove-node') return '移除节点'
  if (operation.kind === 'connect') return `连接端口 ${operation.sourceSocket} → ${operation.targetSocket}`
  return operation.nodes?.length ? '整理所选节点' : '整理整个画布'
}
