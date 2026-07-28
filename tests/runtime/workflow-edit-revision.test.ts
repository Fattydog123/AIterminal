import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { WorkflowDocument } from '../../src/studio/shared/types.ts'
import type { LinearViewDefinition } from '../../src/studio/core/linearView.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/src/studio/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { insertCompatibleNode } = await import('../../src/studio/core/compatibleNodes.ts')
const { WorkflowEditor } = await import('../../src/studio/core/editor.ts')
const { applyLinearValues } = await import('../../src/studio/core/linearView.ts')
const { convertSelectionToSubgraph } = await import('../../src/studio/core/subgraphs.ts')

const timestamp = '2026-07-21T01:00:00.000Z'

const workflow = (): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-a',
  name: 'Revision fixture',
  revision: 17,
  nodes: [{
    id: 'source',
    type: 'text',
    name: 'Source',
    position: { x: 10, y: 20 },
    parameters: { text: 'before' },
    vendorNodeField: 'retained',
  } as WorkflowDocument['nodes'][number]],
  edges: [],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: timestamp,
  metadata: { vendorMetadata: true },
  vendorWorkflowField: 'retained',
} as WorkflowDocument)

const assertFormalVersionStable = (document: WorkflowDocument): void => {
  assert.equal(document.revision, 17)
  assert.equal(document.updatedAt, timestamp)
  assert.equal((document as WorkflowDocument & { vendorWorkflowField: string }).vendorWorkflowField, 'retained')
}

test('WorkflowEditor mutations preserve the formal disk version', () => {
  const edited = new WorkflowEditor().moveNodes(workflow(), { source: { x: 80, y: 90 } })
  assert.deepEqual(edited.nodes[0]?.position, { x: 80, y: 90 })
  assertFormalVersionStable(edited)
})

test('compatible-node insertion preserves the formal disk version', () => {
  const edited = insertCompatibleNode(
    workflow(),
    { direction: 'from-output', nodeId: 'source', socketId: 'text' },
    { nodeType: 'prompt_template', socketId: 'input', position: { x: 200, y: 20 } },
    { nodeId: 'template', edgeId: 'source-template', timestamp: '2099-01-01T00:00:00.000Z' },
  )
  assert.equal(edited.nodes.length, 2)
  assert.equal(edited.edges.length, 1)
  assertFormalVersionStable(edited)
})

test('Linear View parameter edits preserve the formal disk version', () => {
  const definition: LinearViewDefinition = {
    id: 'linear',
    title: 'Linear',
    description: '',
    fields: [{ id: 'prompt', nodeId: 'source', parameter: 'text', label: 'Prompt', group: 'Input', order: 1 }],
  }
  const edited = applyLinearValues(workflow(), definition, { prompt: 'after' })
  assert.equal(edited.nodes[0]?.parameters.text, 'after')
  assertFormalVersionStable(edited)
})

test('subgraph conversion changes content without pretending to save the root document', () => {
  const edited = convertSelectionToSubgraph(workflow(), ['source'], {
    definitionId: 'selection',
    name: 'Selection',
    instanceNodeId: 'selection-instance',
    timestamp: '2099-01-01T00:00:00.000Z',
  }).workflow
  assert.equal(edited.nodes[0]?.id, 'selection-instance')
  assert.equal(edited.subgraphs?.length, 1)
  assertFormalVersionStable(edited)
})
