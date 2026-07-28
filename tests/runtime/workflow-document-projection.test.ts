import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowDocument } from '../../src/studio/shared/types.ts'
import type { GraphDocument, StudioFlowEdge, StudioFlowNode } from '../../src/renderer/src/studio/renderer/types.ts'
import {
  mergeWorkflowDocumentProjection,
  preserveWorkflowGraphRuntime,
  resetWorkflowNodeRuntime,
  setWorkflowLinearView,
} from '../../src/renderer/src/studio/renderer/session/workflow-document-projection.ts'

const node = (overrides: Partial<StudioFlowNode> = {}): StudioFlowNode => ({
  id: 'node-a',
  type: 'studio',
  position: { x: 30, y: 40 },
  data: {
    label: 'Edited node',
    nodeType: 'missing-plugin',
    category: 'Missing',
    description: '',
    inputs: [],
    outputs: [],
    parameters: { prompt: 'after', vendorParameter: true },
    accent: 'control',
    status: 'running',
    previewUrl: 'studio-asset://renderer-only',
    rawPresentation: { annotation: 'before', vendorPresentation: 'retained' } as never,
  },
  ...overrides,
})

const edge = (): StudioFlowEdge => ({
  id: 'edge-a',
  source: 'node-a',
  sourceHandle: 'out:value',
  target: 'node-b',
  targetHandle: 'in:value',
  type: 'exposure',
  data: { dataType: 'any', presentation: { color: 'green' } },
})

const document = (): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-a',
  name: 'Before',
  revision: 7,
  nodes: [{
    id: 'node-a',
    type: 'missing-plugin',
    name: 'Before node',
    position: { x: 1, y: 2 },
    parameters: { prompt: 'before' },
    presentation: { annotation: 'before', vendorPresentation: 'retained' },
    vendorNodeField: { retained: true },
  } as never, {
    id: 'node-b',
    type: 'missing-plugin',
    name: 'Target',
    position: { x: 100, y: 2 },
    parameters: {},
  }],
  edges: [{
    id: 'edge-a',
    sourceNode: 'node-a',
    sourceSocket: 'old',
    targetNode: 'node-b',
    targetSocket: 'old',
    presentation: { color: 'red', vendorEdgePresentation: true },
    vendorEdgeField: 'retained',
  } as never],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T01:00:00.000Z',
  metadata: { vendorMetadata: true },
  presentation: { vendorWorkflowPresentation: true },
  vendorWorkflowField: 'retained',
} as WorkflowDocument)

test('ID merge preserves unknown workflow, node, edge, and presentation fields', () => {
  const graphs: Readonly<Record<string, GraphDocument>> = {
    root: {
      id: 'root',
      label: 'After',
      nodes: [node(), node({ id: 'node-b', position: { x: 100, y: 2 }, data: { ...node().data, label: 'Target', parameters: {} } })],
      edges: [edge()],
    },
  }
  const merged = mergeWorkflowDocumentProjection(document(), graphs)

  assert.equal(merged.name, 'After')
  assert.equal(merged.revision, 7)
  assert.equal(merged.updatedAt, '2026-07-21T01:00:00.000Z')
  assert.equal((merged as WorkflowDocument & { vendorWorkflowField: string }).vendorWorkflowField, 'retained')
  assert.equal((merged.nodes[0] as WorkflowDocument['nodes'][number] & { vendorNodeField: unknown }).vendorNodeField !== undefined, true)
  assert.equal((merged.nodes[0]?.presentation as Record<string, unknown>).vendorPresentation, 'retained')
  assert.equal((merged.edges[0] as WorkflowDocument['edges'][number] & { vendorEdgeField: string }).vendorEdgeField, 'retained')
  assert.deepEqual(merged.edges[0]?.presentation, { color: 'green', vendorEdgePresentation: true })
  assert.equal(JSON.stringify(merged).includes('studio-asset://'), false)
  assert.equal(JSON.stringify(merged).includes('running'), false)
})

test('subgraph projection preserves definition and body extensions', () => {
  const base = document() as WorkflowDocument & Record<string, unknown>
  const withSubgraph = {
    ...base,
    subgraphs: [{
      id: 'shared',
      name: 'Shared',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: { ...document(), id: 'shared:body', name: 'Shared / Body', vendorBodyField: true },
      vendorDefinitionField: true,
    }],
  } as WorkflowDocument
  const graphs: Readonly<Record<string, GraphDocument>> = {
    root: { id: 'root', label: 'Before', nodes: [], edges: [] },
    'root/instance': {
      id: 'root/instance',
      label: 'Shared edited',
      parentId: 'root',
      definitionId: 'shared',
      definitionVersion: 1,
      instanceNodeId: 'instance',
      nodes: [node()],
      edges: [],
    },
  }
  const merged = mergeWorkflowDocumentProjection(withSubgraph, graphs)
  const definition = merged.subgraphs?.[0] as NonNullable<WorkflowDocument['subgraphs']>[number] & { vendorDefinitionField: boolean }
  assert.equal(definition.vendorDefinitionField, true)
  assert.equal((definition.workflow as WorkflowDocument & { vendorBodyField: boolean }).vendorBodyField, true)
  assert.equal(definition.workflow.revision, 7)
  assert.equal(definition.workflow.updatedAt, '2026-07-21T01:00:00.000Z')
})

test('preferred shared-subgraph instance supplies semantics without dropping extensions', () => {
  const base = document() as WorkflowDocument & Record<string, unknown>
  const withSubgraph = {
    ...base,
    subgraphs: [{
      id: 'shared',
      name: 'Shared',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: { ...document(), id: 'shared:body', name: 'Shared / Body', vendorBodyField: true },
      vendorDefinitionField: true,
    }],
  } as WorkflowDocument
  const graphs: Readonly<Record<string, GraphDocument>> = {
    root: { id: 'root', label: 'Before', nodes: [], edges: [] },
    'root/first': {
      id: 'root/first',
      label: 'First instance',
      parentId: 'root',
      definitionId: 'shared',
      definitionVersion: 1,
      instanceNodeId: 'first',
      nodes: [node({ data: { ...node().data, parameters: { prompt: 'first' } } })],
      edges: [],
    },
    'root/second': {
      id: 'root/second',
      label: 'Second instance',
      parentId: 'root',
      definitionId: 'shared',
      definitionVersion: 1,
      instanceNodeId: 'second',
      nodes: [node({ data: { ...node().data, parameters: { prompt: 'second' } } })],
      edges: [],
    },
  }

  const merged = mergeWorkflowDocumentProjection(withSubgraph, graphs, 'root/second')
  const definition = merged.subgraphs?.[0] as NonNullable<WorkflowDocument['subgraphs']>[number] & {
    vendorDefinitionField: boolean
  }
  const body = definition.workflow as WorkflowDocument & { vendorBodyField: boolean }
  const mergedNode = body.nodes[0] as WorkflowDocument['nodes'][number] & { vendorNodeField: unknown }

  assert.equal(definition.name, 'Second instance')
  assert.equal(body.name, 'Second instance / Body')
  assert.equal(body.nodes[0]?.parameters.prompt, 'second')
  assert.equal(definition.vendorDefinitionField, true)
  assert.equal(body.vendorBodyField, true)
  assert.deepEqual(mergedNode.vendorNodeField, { retained: true })
})

test('nested edits from a second shared instance remain definition-scoped and path-free', () => {
  const nestedInstanceDocumentNode = {
    id: 'nested-instance',
    type: 'subgraph:nested',
    name: 'Nested instance',
    position: { x: 20, y: 30 },
    parameters: {},
    subgraph: { definitionId: 'nested', definitionVersion: 1 },
    vendorNestedInstanceField: true,
  } as WorkflowDocument['nodes'][number]
  const outerBody = {
    ...document(),
    id: 'outer:body',
    name: 'Outer / Body',
    nodes: [nestedInstanceDocumentNode],
    edges: [],
    vendorOuterBodyField: true,
  } as WorkflowDocument
  const nestedBody = {
    ...document(),
    id: 'nested:body',
    name: 'Nested / Body',
    nodes: [document().nodes[0]],
    edges: [],
    vendorNestedBodyField: true,
  } as WorkflowDocument
  const source = {
    ...document(),
    nodes: [],
    edges: [],
    subgraphs: [{
      id: 'outer',
      name: 'Outer',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: outerBody,
      vendorOuterDefinitionField: true,
    }, {
      id: 'nested',
      name: 'Nested',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: nestedBody,
      vendorNestedDefinitionField: true,
    }],
  } as WorkflowDocument
  const nestedInstance = (graphPath: string): StudioFlowNode => node({
    id: 'nested-instance',
    data: {
      ...node().data,
      label: 'Nested instance',
      nodeType: 'subgraph:nested',
      parameters: {},
      subgraphId: `${graphPath}/nested-instance`,
      subgraphDefinitionId: 'nested',
      subgraphDefinitionVersion: 1,
    },
  })
  const nestedGraph = (id: string, prompt: string): GraphDocument => ({
    id,
    label: 'Nested',
    parentId: id.slice(0, id.lastIndexOf('/')),
    definitionId: 'nested',
    definitionVersion: 1,
    instanceNodeId: 'nested-instance',
    nodes: [node({ data: { ...node().data, parameters: { prompt } } })],
    edges: [],
  })
  const graphs: Readonly<Record<string, GraphDocument>> = {
    root: { id: 'root', label: source.name, nodes: [], edges: [] },
    'root/first': {
      id: 'root/first',
      label: 'Outer',
      parentId: 'root',
      definitionId: 'outer',
      definitionVersion: 1,
      instanceNodeId: 'first',
      nodes: [nestedInstance('root/first')],
      edges: [],
    },
    'root/second': {
      id: 'root/second',
      label: 'Outer',
      parentId: 'root',
      definitionId: 'outer',
      definitionVersion: 1,
      instanceNodeId: 'second',
      nodes: [nestedInstance('root/second')],
      edges: [],
    },
    'root/first/nested-instance': nestedGraph('root/first/nested-instance', 'first nested edit'),
    'root/second/nested-instance': nestedGraph('root/second/nested-instance', 'second nested edit'),
  }

  const merged = mergeWorkflowDocumentProjection(source, graphs, 'root/second/nested-instance')
  const outer = merged.subgraphs?.find((definition) => definition.id === 'outer')
  const nested = merged.subgraphs?.find((definition) => definition.id === 'nested')

  assert.equal(nested?.workflow.nodes[0]?.parameters.prompt, 'second nested edit')
  assert.equal((outer?.workflow as WorkflowDocument & { vendorOuterBodyField: boolean }).vendorOuterBodyField, true)
  assert.equal((nested?.workflow as WorkflowDocument & { vendorNestedBodyField: boolean }).vendorNestedBodyField, true)
  assert.equal((outer?.workflow.nodes[0] as WorkflowDocument['nodes'][number] & {
    vendorNestedInstanceField: boolean
  }).vendorNestedInstanceField, true)
  assert.deepEqual(outer?.workflow.nodes[0]?.subgraph, { definitionId: 'nested', definitionVersion: 1 })
  assert.equal(JSON.stringify(merged).includes('root/second/nested-instance'), false)
  assert.equal(JSON.stringify(merged).includes('subgraphId'), false)
})

test('fallback Linear View is not persisted unless the author changes the definition', () => {
  const unchanged = mergeWorkflowDocumentProjection(document(), {
    root: { id: 'root', label: 'Before', nodes: [], edges: [] },
  })
  assert.equal(unchanged.metadata?.linearView, undefined)

  const edited = setWorkflowLinearView(unchanged, { id: 'linear', fields: [] })
  assert.deepEqual(edited.metadata?.linearView, { id: 'linear', fields: [] })
  assert.equal(edited.metadata?.vendorMetadata, true)
})

test('canonical graph projection replaces stale semantics while preserving only renderer runtime', () => {
  const projectedNode = node({
    data: {
      ...node().data,
      label: 'Accepted formal node',
      parameters: { prompt: 'accepted formal prompt' },
      status: 'idle',
    },
  })
  const runtimeNode = node({
    selected: true,
    dragging: true,
    data: {
      ...node().data,
      label: 'Stale canvas node',
      parameters: { prompt: 'stale canvas prompt' },
      status: 'running',
      runtimeMs: 420,
      previewUrl: 'studio-asset://runtime-preview',
    },
  })
  const graphs = preserveWorkflowGraphRuntime(
    { root: { id: 'root', label: 'Accepted formal workflow', nodes: [projectedNode], edges: [] } },
    { root: { id: 'root', label: 'Stale canvas workflow', nodes: [runtimeNode], edges: [] } },
  )
  const reconciled = graphs.root?.nodes[0]

  assert.equal(graphs.root?.label, 'Accepted formal workflow')
  assert.equal(reconciled?.data.label, 'Accepted formal node')
  assert.deepEqual(reconciled?.data.parameters, { prompt: 'accepted formal prompt' })
  assert.equal(reconciled?.data.status, 'running')
  assert.equal(reconciled?.data.runtimeMs, 420)
  assert.equal(reconciled?.data.previewUrl, 'studio-asset://runtime-preview')
  assert.equal(reconciled?.selected, true)
  assert.equal(reconciled?.dragging, true)
})

test('duplicated node data drops runtime and clones semantic parameters', () => {
  const source = node().data
  const duplicated = resetWorkflowNodeRuntime(source)

  assert.equal(duplicated.status, 'idle')
  assert.equal(duplicated.previewUrl, undefined)
  assert.notEqual(duplicated.parameters, source.parameters)
  assert.deepEqual(duplicated.parameters, source.parameters)
})
