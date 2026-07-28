import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowDocument } from '../../src/studio/shared/types.ts'
import {
  createWorkflowDocumentSession,
  type WorkflowDocumentPersistenceAdapter,
  type WorkflowDocumentScheduler,
} from '../../src/renderer/src/studio/renderer/session/workflow-document-session.ts'
import { mergeWorkflowDocumentProjection } from '../../src/renderer/src/studio/renderer/session/workflow-document-projection.ts'

const workflow = (id = 'workflow-a', revision = 5): WorkflowDocument => ({
  schemaVersion: 3,
  id,
  name: 'Original',
  revision,
  nodes: [],
  edges: [],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T01:00:00.000Z',
  metadata: { known: true },
  vendorExtension: { retained: 'yes' },
} as WorkflowDocument)

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class ManualScheduler implements WorkflowDocumentScheduler {
  #nextId = 0
  readonly callbacks = new Map<number, () => void>()

  setTimeout(callback: () => void): unknown {
    const id = ++this.#nextId
    this.callbacks.set(id, callback)
    return id
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number)
  }

  runLatest(): void {
    const latest = [...this.callbacks.entries()].at(-1)
    assert.ok(latest)
    this.callbacks.delete(latest[0])
    latest[1]()
  }
}

const adapter = (overrides: Partial<WorkflowDocumentPersistenceAdapter> = {}) => ({
  save: async (_scope, document) => ({ ...document, revision: document.revision + 1, updatedAt: '2026-07-21T02:00:00.000Z' }),
  saveDraft: async () => undefined,
  discardDraft: async () => undefined,
  ...overrides,
} satisfies WorkflowDocumentPersistenceAdapter)

test('unsaved edits preserve the formal revision, save timestamp, and unknown fields', () => {
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'P', workflowId: 'workflow-a' }, workflow())

  const edited = session.edit((current) => ({
    ...current,
    name: 'Edited',
    revision: 999,
    updatedAt: '2099-01-01T00:00:00.000Z',
  }))

  assert.equal(edited.name, 'Edited')
  assert.equal(edited.revision, 5)
  assert.equal(edited.updatedAt, '2026-07-21T01:00:00.000Z')
  assert.deepEqual((edited as WorkflowDocument & { vendorExtension: unknown }).vendorExtension, { retained: 'yes' })
  assert.deepEqual(session.getSnapshot(), {
    scope: { projectPath: 'P', workflowId: 'workflow-a' },
    document: edited,
    editGeneration: 1,
    savedGeneration: 0,
    dirty: true,
    saving: false,
    draftSaving: false,
    draftError: '',
  })
})

test('nested updatedAt fields remain semantic edits while the formal timestamp stays fixed', () => {
  const source: WorkflowDocument = {
    ...workflow(),
    nodes: [{
      id: 'node-a',
      type: 'vendor-node',
      name: 'Vendor node',
      position: { x: 0, y: 0 },
      parameters: { updatedAt: 'vendor-old' },
    }],
  }
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'P', workflowId: source.id }, source)

  const edited = session.edit((current) => ({
    ...current,
    nodes: current.nodes.map((node) => ({
      ...node,
      parameters: { ...node.parameters, updatedAt: 'vendor-new' },
    })),
  }))

  assert.equal(edited.nodes[0]?.parameters.updatedAt, 'vendor-new')
  assert.equal(edited.updatedAt, '2026-07-21T01:00:00.000Z')
  assert.equal(session.getSnapshot().editGeneration, 1)
  assert.equal(session.getSnapshot().dirty, true)
})

test('accepted save receipt rebases revision while edits made during save remain dirty', async () => {
  const pending = deferred<WorkflowDocument>()
  let submitted: WorkflowDocument | undefined
  const session = createWorkflowDocumentSession({
    adapter: adapter({
      save: async (_scope, document) => {
        submitted = document
        return pending.promise
      },
    }),
  })
  session.open({ projectPath: 'P', workflowId: 'workflow-a' }, workflow())
  session.edit((current) => ({ ...current, name: 'First edit' }))

  const saving = session.save()
  session.edit((current) => ({ ...current, name: 'Second edit' }))
  assert.equal(submitted?.name, 'First edit')
  pending.resolve({
    schemaVersion: 3,
    id: 'workflow-a',
    name: 'First edit',
    revision: 6,
    nodes: [],
    edges: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T02:00:00.000Z',
    metadata: { known: true },
  })

  const result = await saving
  if (result.status !== 'saved') assert.fail(`Expected a saved result, received ${result.status}`)
  assert.deepEqual(result.scope, { projectPath: 'P', workflowId: 'workflow-a' })
  assert.equal(result.appliedToSession, true)
  assert.equal(result.document.name, 'First edit')
  assert.equal(result.document.revision, 6)
  assert.equal(result.document.updatedAt, '2026-07-21T02:00:00.000Z')
  assert.deepEqual(
    (result.document as WorkflowDocument & { vendorExtension: unknown }).vendorExtension,
    { retained: 'yes' },
  )
  assert.equal('vendorExtension' in result.receipt, false)
  assert.equal(result.dirty, true)
  const current = session.getDocument()
  assert.equal(current?.name, 'Second edit')
  assert.equal(current?.revision, 6)
  assert.equal(current?.updatedAt, '2026-07-21T02:00:00.000Z')
  assert.equal(session.getSnapshot().dirty, true)
  assert.equal(session.getSnapshot().savedGeneration, 1)
  assert.equal(session.getSnapshot().editGeneration, 2)
})

test('an accepted save from an old scope returns its formal document without overwriting the current session', async () => {
  const pending = deferred<WorkflowDocument>()
  const session = createWorkflowDocumentSession({
    adapter: adapter({ save: async () => pending.promise }),
  })
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, workflow())
  session.edit((current) => ({ ...current, name: 'A edit' }))
  const saving = session.save()

  session.open({ projectPath: 'B', workflowId: 'workflow-b' }, workflow('workflow-b', 9))
  pending.resolve({ ...workflow('workflow-a'), revision: 6, updatedAt: '2026-07-21T02:00:00.000Z' })

  const result = await saving
  if (result.status !== 'saved') assert.fail(`Expected a saved result, received ${result.status}`)
  assert.deepEqual(result.scope, { projectPath: 'A', workflowId: 'workflow-a' })
  assert.equal(result.appliedToSession, false)
  assert.equal(result.dirty, false)
  assert.equal(result.receipt.revision, 6)
  assert.equal(result.document.name, 'A edit')
  assert.equal(result.document.revision, 6)
  assert.equal(session.getDocument()?.id, 'workflow-b')
  assert.equal(session.getDocument()?.revision, 9)
  assert.equal(session.getSnapshot().dirty, false)
})

test('an accepted A save can rebase a clean A to B to A session with the full formal document', async () => {
  const pending = deferred<WorkflowDocument>()
  const session = createWorkflowDocumentSession({
    adapter: adapter({ save: async () => pending.promise }),
  })
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, workflow())
  session.edit((current) => ({ ...current, name: 'Accepted A edit' }))
  const saving = session.save()

  session.open({ projectPath: 'B', workflowId: 'workflow-b' }, workflow('workflow-b', 9))
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, workflow())
  pending.resolve({
    ...workflow('workflow-a'),
    name: 'Schema receipt',
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
  })

  const result = await saving
  if (result.status !== 'saved') assert.fail(`Expected a saved result, received ${result.status}`)
  assert.equal(result.appliedToSession, false)
  assert.equal(session.rebaseAcceptedSave({ ...result.scope, projectPath: 'B' }, result.document), false)
  assert.equal(session.rebaseAcceptedSave(result.scope, { ...result.document, revision: 4 }), false)
  assert.equal(session.rebaseAcceptedSave(result.scope, result.document), true)
  assert.equal(session.getDocument()?.name, 'Accepted A edit')
  assert.equal(session.getDocument()?.revision, 6)
  assert.deepEqual(
    (session.getDocument() as WorkflowDocument & { vendorExtension: unknown }).vendorExtension,
    { retained: 'yes' },
  )
  assert.equal(session.getSnapshot().editGeneration, 0)
  assert.equal(session.getSnapshot().savedGeneration, 0)
  assert.equal(session.getSnapshot().dirty, false)
})

test('an accepted A save three-way rebases saved fields with a newer dirty A and reschedules its draft', async () => {
  const pending = deferred<WorkflowDocument>()
  const scheduler = new ManualScheduler()
  const drafts: WorkflowDocument[] = []
  const source: WorkflowDocument = {
    ...workflow(),
    nodes: [{
      id: 'prompt',
      type: 'text',
      name: 'Prompt',
      position: { x: 10, y: 20 },
      parameters: { text: 'before' },
    }],
  }
  const session = createWorkflowDocumentSession({
    adapter: adapter({
      save: async () => pending.promise,
      saveDraft: async (_scope, document) => { drafts.push(document) },
    }),
    scheduler,
  })
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, source)
  session.setDraftEnabled(true)
  session.edit((current) => ({
    ...current,
    metadata: { ...current.metadata, savedMetadata: 'accepted' },
    nodes: current.nodes.map((node) => node.id === 'prompt'
      ? { ...node, parameters: { ...node.parameters, text: 'saved prompt' } }
      : node),
  }))
  const saving = session.save()

  session.open({ projectPath: 'B', workflowId: 'workflow-b' }, workflow('workflow-b', 9))
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, source)
  session.edit((current) => ({ ...current, name: 'New dirty A edit' }))
  assert.equal(scheduler.callbacks.size, 1)
  pending.resolve({
    ...source,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
  })

  const result = await saving
  if (result.status !== 'saved') assert.fail(`Expected a saved result, received ${result.status}`)
  assert.equal(result.appliedToSession, false)
  assert.equal(session.rebaseAcceptedSave(result.scope, result.document), true)
  assert.equal(session.getDocument()?.name, 'New dirty A edit')
  assert.equal(session.getDocument()?.metadata?.savedMetadata, 'accepted')
  assert.equal(session.getDocument()?.nodes[0]?.parameters.text, 'saved prompt')
  assert.equal(session.getDocument()?.revision, 6)
  assert.equal(session.getDocument()?.updatedAt, '2026-07-21T02:00:00.000Z')
  assert.equal(session.getSnapshot().editGeneration, 1)
  assert.equal(session.getSnapshot().savedGeneration, 0)
  assert.equal(session.getSnapshot().dirty, true)
  assert.equal(scheduler.callbacks.size, 1)

  scheduler.runLatest()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.equal(drafts.at(-1)?.name, 'New dirty A edit')
  assert.equal(drafts.at(-1)?.metadata?.savedMetadata, 'accepted')
  assert.equal(drafts.at(-1)?.nodes[0]?.parameters.text, 'saved prompt')
  assert.equal(drafts.at(-1)?.revision, 6)
  assert.equal(drafts.at(-1)?.updatedAt, '2026-07-21T02:00:00.000Z')
})

test('three-way rebase removes dangling edges in the root workflow and shared subgraphs', () => {
  const graph = (id: string, nodeId: string): WorkflowDocument => ({
    ...workflow(id),
    nodes: [{
      id: nodeId,
      type: 'missing-plugin',
      name: nodeId,
      position: { x: 0, y: 0 },
      parameters: {},
    }],
  })
  const base: WorkflowDocument = {
    ...graph('workflow-a', 'root-base'),
    subgraphs: [{
      id: 'shared',
      name: 'Shared',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: graph('shared:body', 'nested-base'),
    }],
  }
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    nodes: [],
    subgraphs: current.subgraphs?.map((definition) => ({
      ...definition,
      workflow: { ...definition.workflow, nodes: [] },
    })),
  }))

  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    nodes: [...base.nodes, {
      id: 'root-formal',
      type: 'missing-plugin',
      name: 'root-formal',
      position: { x: 50, y: 0 },
      parameters: {},
    }],
    edges: [{
      id: 'root-edge',
      sourceNode: 'root-formal',
      sourceSocket: 'out',
      targetNode: 'root-base',
      targetSocket: 'in',
    }],
    subgraphs: base.subgraphs?.map((definition) => ({
      ...definition,
      workflow: {
        ...definition.workflow,
        nodes: [...definition.workflow.nodes, {
          id: 'nested-formal',
          type: 'missing-plugin',
          name: 'nested-formal',
          position: { x: 50, y: 0 },
          parameters: {},
        }],
        edges: [{
          id: 'nested-edge',
          sourceNode: 'nested-formal',
          sourceSocket: 'out',
          targetNode: 'nested-base',
          targetSocket: 'in',
        }],
      },
    })),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  const rebased = session.getDocument()
  assert.deepEqual(rebased?.nodes.map((node) => node.id), ['root-formal'])
  assert.deepEqual(rebased?.edges, [])
  assert.deepEqual(rebased?.subgraphs?.[0]?.workflow.nodes.map((node) => node.id), ['nested-formal'])
  assert.deepEqual(rebased?.subgraphs?.[0]?.workflow.edges, [])
})

test('three-way rebase removes root and nested instances whose shared definition was deleted locally', () => {
  const body = (id: string): WorkflowDocument => ({
    ...workflow(id),
    nodes: [],
    edges: [],
  })
  const removedDefinition = {
    id: 'removed',
    name: 'Removed',
    version: 1,
    description: '',
    tags: [],
    inputs: [],
    outputs: [],
    workflow: body('removed:body'),
  }
  const containerDefinition = {
    id: 'container',
    name: 'Container',
    version: 1,
    description: '',
    tags: [],
    inputs: [],
    outputs: [],
    workflow: body('container:body'),
  }
  const base: WorkflowDocument = {
    ...body('workflow-a'),
    subgraphs: [removedDefinition, containerDefinition],
  }
  const instance = (id: string) => ({
    id,
    type: 'subgraph:removed',
    name: 'Removed instance',
    position: { x: 0, y: 0 },
    parameters: {},
    subgraph: { definitionId: 'removed', definitionVersion: 1 },
  })
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    subgraphs: current.subgraphs?.filter((definition) => definition.id !== 'removed'),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    nodes: [instance('root-instance')],
    subgraphs: base.subgraphs?.map((definition) => definition.id === 'container'
      ? {
          ...definition,
          workflow: {
            ...definition.workflow,
            nodes: [instance('nested-instance')],
            edges: [{
              id: 'nested-incident-edge',
              sourceNode: 'nested-instance',
              sourceSocket: 'out',
              targetNode: 'nested-instance',
              targetSocket: 'in',
            }],
          },
        }
      : definition),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  const rebased = session.getDocument()
  assert.deepEqual(rebased?.subgraphs?.map((definition) => definition.id), ['container'])
  assert.deepEqual(rebased?.nodes, [])
  assert.deepEqual(rebased?.edges, [])
  assert.deepEqual(rebased?.subgraphs?.[0]?.workflow.nodes, [])
  assert.deepEqual(rebased?.subgraphs?.[0]?.workflow.edges, [])
})

test('concurrent root and shared-subgraph edge edits keep the local valid edge set atomic', () => {
  const graph = (id: string): WorkflowDocument => ({
    ...workflow(id),
    nodes: ['a', 'b'].map((nodeId, index) => ({
      id: nodeId,
      type: 'missing-plugin',
      name: nodeId,
      position: { x: index * 50, y: 0 },
      parameters: {},
    })),
    edges: [],
  })
  const edge = (id: string, sourceNode: string, targetNode: string) => ({
    id,
    sourceNode,
    sourceSocket: 'out',
    targetNode,
    targetSocket: 'in',
  })
  const base: WorkflowDocument = {
    ...graph('workflow-a'),
    subgraphs: [{
      id: 'shared',
      name: 'Shared',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: graph('shared:body'),
    }],
  }
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    edges: [edge('local-root', 'a', 'b')],
    subgraphs: current.subgraphs?.map((definition) => ({
      ...definition,
      workflow: { ...definition.workflow, edges: [edge('local-nested', 'a', 'b')] },
    })),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    edges: [edge('formal-root', 'b', 'a')],
    subgraphs: base.subgraphs?.map((definition) => ({
      ...definition,
      workflow: { ...definition.workflow, edges: [edge('formal-nested', 'b', 'a')] },
    })),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  assert.deepEqual(session.getDocument()?.edges.map((item) => item.id), ['local-root'])
  assert.deepEqual(session.getDocument()?.subgraphs?.[0]?.workflow.edges.map((item) => item.id), ['local-nested'])
})

test('concurrent independent root and shared-subgraph edge edits preserve both additions', () => {
  const graph = (id: string): WorkflowDocument => ({
    ...workflow(id),
    nodes: ['a', 'b', 'c', 'd'].map((nodeId, index) => ({
      id: nodeId,
      type: 'missing-plugin',
      name: nodeId,
      position: { x: index * 50, y: 0 },
      parameters: {},
    })),
    edges: [],
  })
  const edge = (id: string, sourceNode: string, targetNode: string) => ({
    id,
    sourceNode,
    sourceSocket: 'out',
    targetNode,
    targetSocket: 'in',
  })
  const base: WorkflowDocument = {
    ...graph('workflow-a'),
    subgraphs: [{
      id: 'shared',
      name: 'Shared',
      version: 1,
      description: '',
      tags: [],
      inputs: [],
      outputs: [],
      workflow: graph('shared:body'),
    }],
  }
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    edges: [edge('local-root', 'a', 'b')],
    subgraphs: current.subgraphs?.map((definition) => ({
      ...definition,
      workflow: { ...definition.workflow, edges: [edge('local-nested', 'a', 'b')] },
    })),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    edges: [edge('formal-root', 'c', 'd')],
    subgraphs: base.subgraphs?.map((definition) => ({
      ...definition,
      workflow: { ...definition.workflow, edges: [edge('formal-nested', 'c', 'd')] },
    })),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  assert.deepEqual(session.getDocument()?.edges.map((item) => item.id), ['local-root', 'formal-root'])
  assert.deepEqual(session.getDocument()?.subgraphs?.[0]?.workflow.edges.map((item) => item.id), ['local-nested', 'formal-nested'])
})

test('concurrent shared-subgraph interface edits keep the local port collection atomic', () => {
  const internalNode = {
    id: 'internal',
    type: 'missing-plugin',
    name: 'Internal',
    position: { x: 0, y: 0 },
    parameters: {},
  }
  const definition = {
    id: 'shared',
    name: 'Shared',
    version: 1,
    description: '',
    tags: [],
    inputs: [],
    outputs: [],
    workflow: { ...workflow('shared:body'), nodes: [internalNode] },
  }
  const base: WorkflowDocument = { ...workflow(), subgraphs: [definition] }
  const port = (id: string) => ({
    id,
    name: 'same-name',
    dataType: 'text' as const,
    internalNodeId: 'internal',
    internalSocket: 'input',
    required: false,
  })
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    subgraphs: current.subgraphs?.map((item) => ({ ...item, inputs: [port('local-port')] })),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    subgraphs: base.subgraphs?.map((item) => ({ ...item, inputs: [port('formal-port')] })),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  assert.deepEqual(session.getDocument()?.subgraphs?.[0]?.inputs.map((item) => item.id), ['local-port'])
})

test('concurrent independent shared-subgraph interface edits preserve both ports', () => {
  const internalNode = {
    id: 'internal',
    type: 'missing-plugin',
    name: 'Internal',
    position: { x: 0, y: 0 },
    parameters: {},
  }
  const definition = {
    id: 'shared',
    name: 'Shared',
    version: 1,
    description: '',
    tags: [],
    inputs: [],
    outputs: [],
    workflow: { ...workflow('shared:body'), nodes: [internalNode] },
  }
  const base: WorkflowDocument = { ...workflow(), subgraphs: [definition] }
  const port = (id: string, name: string) => ({
    id,
    name,
    dataType: 'text' as const,
    internalNodeId: 'internal',
    internalSocket: 'input',
    required: false,
  })
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    subgraphs: current.subgraphs?.map((item) => ({ ...item, inputs: [port('local-port', 'local')] })),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    subgraphs: base.subgraphs?.map((item) => ({ ...item, inputs: [port('formal-port', 'formal')] })),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  assert.deepEqual(session.getDocument()?.subgraphs?.[0]?.inputs.map((item) => item.id), ['local-port', 'formal-port'])
})

test('concurrent cross-direction subgraph interface edits keep a duplicate port ID local', () => {
  const internalNode = {
    id: 'internal',
    type: 'missing-plugin',
    name: 'Internal',
    position: { x: 0, y: 0 },
    parameters: {},
  }
  const definition = {
    id: 'shared',
    name: 'Shared',
    version: 1,
    description: '',
    tags: [],
    inputs: [],
    outputs: [],
    workflow: { ...workflow('shared:body'), nodes: [internalNode] },
  }
  const base: WorkflowDocument = { ...workflow(), subgraphs: [definition] }
  const port = (name: string, internalSocket: string) => ({
    id: 'shared-port-id',
    name,
    dataType: 'text' as const,
    internalNodeId: 'internal',
    internalSocket,
    required: false,
  })
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    subgraphs: current.subgraphs?.map((item) => ({ ...item, inputs: [port('local-input', 'input')] })),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    subgraphs: base.subgraphs?.map((item) => ({ ...item, outputs: [port('formal-output', 'output')] })),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  assert.deepEqual(session.getDocument()?.subgraphs?.[0]?.inputs.map((item) => item.id), ['shared-port-id'])
  assert.deepEqual(session.getDocument()?.subgraphs?.[0]?.outputs, [])
})

test('concurrent definition dependencies keep local references and remove formal references that close a cycle', () => {
  const definition = (id: string) => ({
    id,
    name: id,
    version: 1,
    description: '',
    tags: [],
    inputs: [],
    outputs: [],
    workflow: { ...workflow(`${id}:body`), nodes: [], edges: [] },
  })
  const instance = (id: string, definitionId: string) => ({
    id,
    type: `subgraph:${definitionId}`,
    name: definitionId,
    position: { x: 0, y: 0 },
    parameters: {},
    subgraph: { definitionId, definitionVersion: 1 },
  })
  const base: WorkflowDocument = { ...workflow(), subgraphs: [definition('left'), definition('right')] }
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  session.open({ projectPath: 'A', workflowId: base.id }, base)
  session.edit((current) => ({
    ...current,
    subgraphs: current.subgraphs?.map((item) => item.id === 'left'
      ? { ...item, workflow: { ...item.workflow, nodes: [instance('local-right', 'right')] } }
      : item),
  }))
  const formal: WorkflowDocument = {
    ...base,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
    subgraphs: base.subgraphs?.map((item) => item.id === 'right'
      ? { ...item, workflow: { ...item.workflow, nodes: [instance('formal-left', 'left')] } }
      : item),
  }

  assert.equal(session.rebaseAcceptedSave({ projectPath: 'A', workflowId: base.id }, formal), true)
  const definitions = session.getDocument()?.subgraphs ?? []
  assert.deepEqual(definitions.find((item) => item.id === 'left')?.workflow.nodes.map((node) => node.id), ['local-right'])
  assert.deepEqual(definitions.find((item) => item.id === 'right')?.workflow.nodes, [])
})

test('draft debounce persists only the latest generation and keeps the disk revision stable', async () => {
  const scheduler = new ManualScheduler()
  const drafts: WorkflowDocument[] = []
  const session = createWorkflowDocumentSession({
    adapter: adapter({ saveDraft: async (_scope, document) => { drafts.push(document) } }),
    scheduler,
    draftDelayMs: 900,
  })
  session.open({ projectPath: 'P', workflowId: 'workflow-a' }, workflow())
  session.setDraftEnabled(true)
  session.edit((current) => ({ ...current, name: 'First edit' }))
  session.edit((current) => ({ ...current, name: 'Latest edit' }))

  assert.equal(scheduler.callbacks.size, 1)
  scheduler.runLatest()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))

  assert.equal(drafts.length, 1)
  assert.equal(drafts[0]?.name, 'Latest edit')
  assert.equal(drafts[0]?.revision, 5)
  assert.equal(drafts[0]?.updatedAt, '2026-07-21T01:00:00.000Z')
})

test('an offline quick-start scope owns edits without attempting persistence', async () => {
  let calls = 0
  const session = createWorkflowDocumentSession({
    adapter: adapter({
      save: async (_scope, document) => { calls += 1; return document },
      saveDraft: async () => { calls += 1 },
    }),
  })
  session.open({ workflowId: 'workflow-a' }, workflow())
  session.setDraftEnabled(true)
  session.edit((current) => ({ ...current, name: 'Offline edit' }))

  assert.equal(session.getSnapshot().dirty, true)
  assert.equal(session.getSnapshot().draftSaving, false)
  assert.deepEqual(await session.save(), { status: 'unavailable' })
  assert.equal(await session.flushDraft(), false)
  assert.equal(calls, 0)
})

test('a failed advisory draft discard cannot turn an accepted formal save into failure', async () => {
  const discarded = deferred<void>()
  const session = createWorkflowDocumentSession({
    adapter: adapter({ discardDraft: async () => discarded.promise }),
  })
  session.open({ projectPath: 'P', workflowId: 'workflow-a' }, workflow())
  session.edit((current) => ({ ...current, name: 'Saved edit' }))

  const result = await session.save()
  assert.equal(result.status, 'saved')
  assert.equal(session.getDocument()?.revision, 6)
  assert.equal(session.getSnapshot().dirty, false)

  discarded.reject(new Error('draft file is locked'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(session.getSnapshot().draftError, /正式版本已保存.*draft file is locked/u)
})

test('overlapping A to B to A saves retain an older accepted field as dirty until it is persisted', async () => {
  const firstReceipt = deferred<WorkflowDocument>()
  const secondReceipt = deferred<WorkflowDocument>()
  const submissions: WorkflowDocument[] = []
  const session = createWorkflowDocumentSession({
    adapter: adapter({
      save: async (_scope, document) => {
        submissions.push(document)
        if (submissions.length === 1) return firstReceipt.promise
        if (submissions.length === 2) return secondReceipt.promise
        return {
          ...document,
          revision: document.revision + 1,
          updatedAt: '2026-07-21T04:00:00.000Z',
        }
      },
    }),
  })
  const original = workflow()
  session.open({ projectPath: 'A', workflowId: original.id }, original)
  session.edit((current) => ({
    ...current,
    metadata: { ...current.metadata, oldAccepted: true },
  }))
  const firstSave = session.save()

  session.open({ projectPath: 'B', workflowId: 'workflow-b' }, workflow('workflow-b', 9))
  session.open({ projectPath: 'A', workflowId: original.id }, original)
  session.edit((current) => ({ ...current, name: 'Newer save' }))
  const secondSave = session.save()
  const firstSubmission = submissions[0]
  const secondSubmission = submissions[1]
  assert.ok(firstSubmission)
  assert.ok(secondSubmission)
  assert.equal(firstSubmission.metadata?.oldAccepted, true)
  assert.equal(secondSubmission.metadata?.oldAccepted, undefined)

  firstReceipt.resolve({
    ...firstSubmission,
    revision: 6,
    updatedAt: '2026-07-21T02:00:00.000Z',
  })
  const firstResult = await firstSave
  if (firstResult.status !== 'saved') assert.fail(`Expected a saved result, received ${firstResult.status}`)
  assert.equal(firstResult.appliedToSession, false)
  assert.equal(session.rebaseAcceptedSave(firstResult.scope, firstResult.document), true)
  assert.equal(session.getDocument()?.metadata?.oldAccepted, true)
  assert.equal(session.getDocument()?.name, 'Newer save')

  secondReceipt.resolve({
    ...secondSubmission,
    revision: 7,
    updatedAt: '2026-07-21T03:00:00.000Z',
  })
  const secondResult = await secondSave
  if (secondResult.status !== 'saved') assert.fail(`Expected a saved result, received ${secondResult.status}`)
  assert.equal(secondResult.appliedToSession, true)
  assert.equal(secondResult.dirty, true)
  assert.equal(session.getDocument()?.metadata?.oldAccepted, true)
  assert.equal(session.getSnapshot().editGeneration, 1)
  assert.equal(session.getSnapshot().savedGeneration, 1)
  assert.equal(session.getSnapshot().dirty, true)

  const finalSave = await session.save()
  if (finalSave.status !== 'saved') assert.fail(`Expected a saved result, received ${finalSave.status}`)
  const finalSubmission = submissions[2]
  assert.ok(finalSubmission)
  assert.equal(finalSubmission.metadata?.oldAccepted, true)
  assert.equal(session.getSnapshot().dirty, false)
})

test('an old-scope draft write does not mark a later A to B to A scope as saving', async () => {
  const oldWrite = deferred<void>()
  const scheduler = new ManualScheduler()
  let draftCalls = 0
  const session = createWorkflowDocumentSession({
    adapter: adapter({
      saveDraft: async () => {
        draftCalls += 1
        if (draftCalls === 1) await oldWrite.promise
      },
    }),
    scheduler,
  })
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, workflow())
  session.setDraftEnabled(true)
  session.edit((current) => ({ ...current, name: 'Old A edit' }))
  scheduler.runLatest()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.equal(session.getSnapshot().draftSaving, true)

  session.open({ projectPath: 'B', workflowId: 'workflow-b' }, workflow('workflow-b'))
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, workflow())
  assert.equal(session.getSnapshot().draftSaving, false)

  oldWrite.resolve()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.equal(session.getSnapshot().draftSaving, false)
  assert.equal(session.getDocument()?.name, 'Original')
})

test('a queued draft discard is skipped after the workflow scope changes', async () => {
  const oldWrite = deferred<void>()
  const scheduler = new ManualScheduler()
  let discardCalls = 0
  const session = createWorkflowDocumentSession({
    adapter: adapter({
      saveDraft: async () => oldWrite.promise,
      discardDraft: async () => { discardCalls += 1 },
    }),
    scheduler,
  })
  session.open({ projectPath: 'A', workflowId: 'workflow-a' }, workflow())
  session.setDraftEnabled(true)
  session.edit((current) => ({ ...current, name: 'A draft' }))
  scheduler.runLatest()
  await new Promise<void>((resolve) => queueMicrotask(resolve))

  const discard = session.discardDraft()
  session.open({ projectPath: 'B', workflowId: 'workflow-b' }, workflow('workflow-b'))
  oldWrite.resolve()

  assert.equal(await discard, false)
  assert.equal(discardCalls, 0)
  assert.equal(session.getDocument()?.id, 'workflow-b')
})

test('renderer-only preview and runtime changes do not advance the edit generation', () => {
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  const source: WorkflowDocument = {
    ...workflow(),
    nodes: [{
      id: 'node-a',
      type: 'missing-plugin',
      name: 'Node A',
      position: { x: 10, y: 20 },
      parameters: { value: 'same' },
    }],
  }
  session.open({ projectPath: 'P', workflowId: source.id }, source)
  session.edit((current) => mergeWorkflowDocumentProjection(current, {
    root: {
      id: 'root',
      label: current.name,
      nodes: [{
        id: 'node-a',
        type: 'studio',
        position: { x: 10, y: 20 },
        data: {
          label: 'Node A',
          nodeType: 'missing-plugin',
          category: 'Missing',
          description: '',
          inputs: [],
          outputs: [],
          parameters: { value: 'same' },
          accent: 'control',
          status: 'running',
          runtimeMs: 120,
          previewUrl: 'studio-asset://renderer-only',
        },
      }],
      edges: [],
    },
  }))

  assert.equal(session.getSnapshot().editGeneration, 0)
  assert.equal(session.getSnapshot().dirty, false)
})

test('applying an old undo snapshot after save keeps the accepted formal version', async () => {
  const session = createWorkflowDocumentSession({ adapter: adapter() })
  const oldSnapshot = workflow()
  session.open({ projectPath: 'P', workflowId: oldSnapshot.id }, oldSnapshot)
  session.edit((current) => ({ ...current, name: 'Saved content' }))
  const saved = await session.save()
  assert.equal(saved.status, 'saved')
  assert.equal(session.getDocument()?.revision, 6)

  session.edit(() => ({ ...oldSnapshot, name: 'Undo content' }))
  assert.equal(session.getDocument()?.name, 'Undo content')
  assert.equal(session.getDocument()?.revision, 6)
  assert.equal(session.getDocument()?.createdAt, '2026-07-21T00:00:00.000Z')
  assert.equal(session.getDocument()?.updatedAt, '2026-07-21T02:00:00.000Z')
  assert.equal(session.getSnapshot().dirty, true)
})
