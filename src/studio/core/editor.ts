import type { Point, WorkflowDocument, WorkflowEdge, WorkflowNode } from '../shared/types.js'
import { NodeRegistry, defaultRegistry, registryWithSubgraphs } from './registry.js'
import { validateWorkflow } from './workflow.js'

const revised = (
  workflow: WorkflowDocument,
  change: Pick<WorkflowDocument, 'nodes' | 'edges'>,
): WorkflowDocument => ({
  ...workflow,
  ...change,
})

export class WorkflowEditor {
  constructor(readonly registry: NodeRegistry = defaultRegistry) {}

  private registryFor(workflow: WorkflowDocument): NodeRegistry {
    return registryWithSubgraphs(this.registry, workflow.subgraphs ?? [])
  }

  addNode(workflow: WorkflowDocument, type: string, position: Point): WorkflowDocument {
    const definition = this.registryFor(workflow).get(type)
    const parameters = Object.fromEntries(definition.parameters.map((parameter) => [parameter.id, parameter.defaultValue]))
    const node: WorkflowNode = {
      id: crypto.randomUUID(),
      type,
      name: definition.title,
      position,
      parameters,
    }
    const candidate = revised(workflow, { nodes: [...workflow.nodes, node], edges: workflow.edges })
    validateWorkflow(candidate, this.registry)
    return candidate
  }

  updateNode(
    workflow: WorkflowDocument,
    nodeId: string,
    updater: (node: WorkflowNode) => WorkflowNode,
  ): WorkflowDocument {
    let found = false
    const nodes = workflow.nodes.map((node) => {
      if (node.id !== nodeId) return node
      found = true
      return updater(node)
    })
    if (!found) throw new Error(`节点不存在：${nodeId}`)
    const candidate = revised(workflow, { nodes, edges: workflow.edges })
    validateWorkflow(candidate, this.registry)
    return candidate
  }

  moveNodes(workflow: WorkflowDocument, positions: Readonly<Record<string, Point>>): WorkflowDocument {
    return revised(workflow, {
      nodes: workflow.nodes.map((node) => {
        const position = positions[node.id]
        return position ? { ...node, position } : node
      }),
      edges: workflow.edges,
    })
  }

  removeNodes(workflow: WorkflowDocument, nodeIds: readonly string[]): WorkflowDocument {
    const removed = new Set(nodeIds)
    return revised(workflow, {
      nodes: workflow.nodes.filter((node) => !removed.has(node.id)),
      edges: workflow.edges.filter((edge) => !removed.has(edge.sourceNode) && !removed.has(edge.targetNode)),
    })
  }

  connect(
    workflow: WorkflowDocument,
    input: Omit<WorkflowEdge, 'id'>,
  ): WorkflowDocument {
    if (input.sourceNode === input.targetNode) throw new Error('节点不能连接到自身')
    const source = workflow.nodes.find((node) => node.id === input.sourceNode)
    const target = workflow.nodes.find((node) => node.id === input.targetNode)
    if (!source || !target) throw new Error('连线节点不存在')
    const registry = this.registryFor(workflow)
    const sourcePort = registry.get(source.type).outputs[input.sourceSocket]
    const targetPort = registry.get(target.type).inputs[input.targetSocket]
    if (!sourcePort || !targetPort) throw new Error('连线端口不存在')
    if (!registry.compatible(sourcePort.dataType, targetPort.dataType)) {
      throw new Error(`${sourcePort.dataType} 不能连接到 ${targetPort.dataType}`)
    }
    const withoutPrevious = targetPort.multiple
      ? workflow.edges
      : workflow.edges.filter(
          (edge) => edge.targetNode !== input.targetNode || edge.targetSocket !== input.targetSocket,
        )
    const candidate = revised(workflow, {
      nodes: workflow.nodes,
      edges: [...withoutPrevious, { ...input, id: crypto.randomUUID() }],
    })
    validateWorkflow(candidate, this.registry)
    return candidate
  }

  removeEdges(workflow: WorkflowDocument, edgeIds: readonly string[]): WorkflowDocument {
    const removed = new Set(edgeIds)
    return revised(workflow, {
      nodes: workflow.nodes,
      edges: workflow.edges.filter((edge) => !removed.has(edge.id)),
    })
  }

  setBypassed(workflow: WorkflowDocument, nodeId: string, bypassed: boolean): WorkflowDocument {
    const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new Error(`节点不存在：${nodeId}`)
    if (bypassed && !this.registryFor(workflow).bypassRoute(node.type)) throw new Error(`节点不能旁路：${node.type}`)
    return this.updateNode(workflow, nodeId, (current) => ({
      ...current,
      presentation: { ...current.presentation, bypassed },
    }))
  }

  setAnnotation(workflow: WorkflowDocument, nodeId: string, annotation: string): WorkflowDocument {
    const value = annotation.trim()
    return this.updateNode(workflow, nodeId, (current) => {
      const presentation = { ...current.presentation }
      if (value) presentation.annotation = value
      else delete presentation.annotation
      return { ...current, presentation }
    })
  }

  setCollapsed(workflow: WorkflowDocument, nodeId: string, collapsed: boolean): WorkflowDocument {
    return this.updateNode(workflow, nodeId, (current) => ({
      ...current,
      presentation: { ...current.presentation, collapsed },
    }))
  }

  resizeCanvasItem(
    workflow: WorkflowDocument,
    nodeId: string,
    size: { readonly width: number; readonly height: number },
  ): WorkflowDocument {
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 120 || size.height < 60) {
      throw new Error('画布项目尺寸无效')
    }
    return this.updateNode(workflow, nodeId, (current) => ({
      ...current,
      presentation: { ...current.presentation, width: size.width, height: size.height },
    }))
  }
}
