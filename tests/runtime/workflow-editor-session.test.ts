import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { WorkflowDocument } from '../../src/studio/shared/types.ts'
import type { WorkflowDocumentPersistenceAdapter } from '../../src/renderer/src/studio/renderer/session/workflow-document-session.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { createWorkflowEditorSession, createWorkflowRuntimeProjectionCommand } = await import(
  '../../src/renderer/src/studio/renderer/session/workflow-editor-session.ts'
)

const timestamp = '2026-07-21T01:00:00.000Z'

const workflow = (): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-a',
  name: 'Editor fixture',
  revision: 7,
  nodes: [{
    id: 'prompt',
    type: 'text',
    name: 'Prompt',
    position: { x: 10, y: 20 },
    parameters: { text: 'before' },
  }, {
    id: 'source-image',
    type: 'project_image',
    name: 'Source image',
    position: { x: 10, y: 180 },
    parameters: { path: 'assets/imports/source.png' },
  }, {
    id: 'generate',
    type: 'image_generation',
    name: 'Generate',
    position: { x: 420, y: 40 },
    parameters: {
      providerId: 'account',
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: '',
      seed: 0,
      count: 1,
    },
  }],
  edges: [{
    id: 'prompt-edge',
    sourceNode: 'prompt',
    sourceSocket: 'text',
    targetNode: 'generate',
    targetSocket: 'prompt',
  }, {
    id: 'reference-edge',
    sourceNode: 'source-image',
    sourceSocket: 'images',
    targetNode: 'generate',
    targetSocket: 'referenceImages',
  }],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: timestamp,
  metadata: { vendorMetadata: true },
})

const provider = {
  id: 'account',
  kind: 'openai-compatible' as const,
  hasSecret: true,
  defaultModel: 'gpt-image-2',
  managedBy: 'ai-terminal-account' as const,
}

const persistence = (
  overrides: Partial<WorkflowDocumentPersistenceAdapter> = {},
): WorkflowDocumentPersistenceAdapter => ({
  save: async (_scope, document) => ({ ...document, revision: document.revision + 1, updatedAt: '2026-07-21T02:00:00.000Z' }),
  saveDraft: async () => undefined,
  discardDraft: async () => undefined,
  ...overrides,
})

const openedSession = (options: { readonly projectPath?: string; readonly model?: string } = {}) => {
  const document = workflow()
  const selectedModel = options.model ?? provider.defaultModel
  const openedDocument: WorkflowDocument = selectedModel === provider.defaultModel
    ? document
    : {
        ...document,
        nodes: document.nodes.map((node) => node.id === 'generate'
          ? { ...node, parameters: { ...node.parameters, model: selectedModel } }
          : node),
      }
  const session = createWorkflowEditorSession({
    persistence: persistence(),
    readinessProviders: [{ ...provider, defaultModel: selectedModel }],
    draftEnabled: false,
  })
  session.open({
    ...(options.projectPath === undefined ? { projectPath: 'P' } : options.projectPath ? { projectPath: options.projectPath } : {}),
    workflowId: 'workflow-a',
  }, openedDocument)
  return session
}

test('one interface owns the canonical document and derives Canvas, Linear, and readiness projections', () => {
  const session = openedSession()
  const snapshot = session.getSnapshot()

  assert.equal('edit' in session, false)
  assert.equal(snapshot.document?.id, 'workflow-a')
  assert.equal(snapshot.graphs.root?.nodes.length, 3)
  assert.equal(snapshot.linear?.source, 'fallback')
  assert.equal(snapshot.linear?.values.prompt, 'before')
  assert.equal(snapshot.document?.metadata?.linearView, undefined)
  assert.equal(snapshot.readiness?.issues.some((issue) => issue.code === 'generation-reference-images-unsupported'), false)
})

test('bounded node updates change canonical semantics while renderer runtime stays out of the document', () => {
  const session = openedSession()
  session.dispatch({
    kind: 'canvas/project-runtime',
    nodes: [{
      graphId: 'root',
      nodeId: 'prompt',
      selected: true,
      data: { status: 'running', runtimeMs: 42, previewUrl: 'studio-asset://runtime-only' },
    }],
  })
  const result = session.dispatch({
    kind: 'canvas/update-nodes',
    graphId: 'root',
    updates: [{ nodeId: 'prompt', parameters: { text: 'after' } }],
    context: { graphId: 'root', selectedNodeId: 'prompt' },
  })

  assert.equal(result.documentChanged, true)
  assert.equal(result.snapshot.document?.nodes.find((node) => node.id === 'prompt')?.parameters.text, 'after')
  assert.equal(result.snapshot.document?.revision, 7)
  assert.equal(result.snapshot.document?.updatedAt, timestamp)
  assert.equal(JSON.stringify(result.snapshot.document).includes('studio-asset://runtime-only'), false)
  assert.equal(result.snapshot.graphs.root?.nodes.find((node) => node.id === 'prompt')?.data.status, 'running')
  assert.equal(result.snapshot.graphs.root?.nodes.find((node) => node.id === 'prompt')?.selected, true)
})

test('new remote image nodes inherit the top-level generation binding in the same edit', () => {
  const session = openedSession()
  const added = session.dispatch({
    kind: 'canvas/add-node',
    graphId: 'root',
    nodeType: 'image_edit',
    position: { x: 700, y: 320 },
    generationBinding: { providerId: 'account', model: 'gpt-image-2' },
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  const nodeId = added.effect?.kind === 'focus-canvas' ? added.effect.nodeId : undefined
  assert.ok(nodeId)
  const node = added.snapshot.document?.nodes.find((candidate) => candidate.id === nodeId)
  assert.equal(node?.parameters.providerId, 'account')
  assert.equal(node?.parameters.model, 'gpt-image-2')

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root', selectedNodeId: nodeId } })
  assert.equal(undone.snapshot.document?.nodes.some((candidate) => candidate.id === nodeId), false)
})

test('runtime projection changes do not dirty or mutate the canonical Workflow', () => {
  const session = openedSession()
  const before = session.getSnapshot()
  const result = session.dispatch({
    kind: 'canvas/project-runtime',
    nodes: [{
      graphId: 'root',
      nodeId: 'prompt',
      selected: true,
      data: { status: 'success', runtimeMs: 88 },
    }],
  })

  assert.equal(result.documentChanged, false)
  assert.equal(result.snapshot.editGeneration, 0)
  assert.equal(result.snapshot.dirty, false)
  assert.equal(result.snapshot.document?.nodes[0]?.parameters.text, 'before')
  assert.equal(result.snapshot.graphs.root?.nodes[0]?.data.runtimeMs, 88)
})

test('runtime projection command exposes only the renderer runtime allowlist', () => {
  const session = openedSession()
  const before = session.getSnapshot()
  const root = before.graphs.root
  assert.ok(root)

  const command = createWorkflowRuntimeProjectionCommand({
    root: {
      ...root,
      label: 'stale Store label',
      nodes: root.nodes.map((node) => node.id === 'prompt' ? {
        ...node,
        position: { x: 900, y: 800 },
        selected: true,
        data: {
          ...node.data,
          label: 'stale Store node',
          parameters: { text: 'stale Store prompt' },
          status: 'running',
          runtimeMs: 17,
          previewUrl: 'studio-asset://runtime-preview',
        },
      } : node),
    },
  })
  const runtimeUpdate = command.nodes.find((node) => node.nodeId === 'prompt')
  assert.ok(runtimeUpdate)
  assert.deepEqual(Object.keys(runtimeUpdate.data).sort(), ['previewUrl', 'runtimeMs', 'status'])
  assert.equal('label' in runtimeUpdate.data, false)
  assert.equal('parameters' in runtimeUpdate.data, false)
  assert.equal('position' in runtimeUpdate, false)

  const result = session.dispatch(command)
  const canonical = result.snapshot.document?.nodes.find((node) => node.id === 'prompt')
  const projected = result.snapshot.graphs.root?.nodes.find((node) => node.id === 'prompt')
  assert.equal(result.documentChanged, false)
  assert.equal(canonical?.parameters.text, 'before')
  assert.deepEqual(canonical?.position, { x: 10, y: 20 })
  assert.equal(projected?.data.label, 'Prompt')
  assert.deepEqual(projected?.position, { x: 10, y: 20 })
  assert.equal(projected?.data.runtimeMs, 17)
  assert.equal(projected?.selected, true)
})

test('document replacement keeps formal identity fields owned by the session', () => {
  const session = openedSession()
  const replacement = structuredClone(session.getSnapshot().document as WorkflowDocument)
  replacement.name = 'History replacement'
  replacement.revision = 99
  replacement.createdAt = '2099-01-01T00:00:00.000Z'
  replacement.updatedAt = '2099-01-01T01:00:00.000Z'

  const result = session.dispatch({
    kind: 'document/replace',
    document: replacement,
    reason: 'history',
  })

  assert.equal(result.documentChanged, true)
  assert.equal(result.snapshot.document?.name, 'History replacement')
  assert.equal(result.snapshot.document?.revision, 7)
  assert.equal(result.snapshot.document?.createdAt, '2026-07-21T00:00:00.000Z')
  assert.equal(result.snapshot.document?.updatedAt, timestamp)
})

test('Linear commands mutate through field bindings and persist author exposure only on request', () => {
  const session = openedSession()

  const valueResult = session.dispatch({ kind: 'linear/set-value', fieldId: 'prompt', value: 'linear edit' })
  assert.equal(valueResult.snapshot.document?.nodes.find((node) => node.id === 'prompt')?.parameters.text, 'linear edit')
  assert.equal(valueResult.snapshot.document?.metadata?.linearView, undefined)

  const fieldResult = session.dispatch({
    kind: 'linear/set-field',
    graphId: 'root',
    nodeId: 'generate',
    parameter: 'quality',
    label: 'Quality',
    exposed: true,
  })
  assert.equal(fieldResult.documentChanged, true)
  assert.equal(fieldResult.snapshot.linear?.source, 'saved')
  assert.equal(fieldResult.snapshot.linear?.definition.fields.some((field) =>
    field.nodeId === 'generate' && field.parameter === 'quality'), true)
  assert.throws(() => session.dispatch({
    kind: 'linear/set-field',
    graphId: 'root/nested',
    nodeId: 'generate',
    parameter: 'quality',
    label: 'Quality',
    exposed: false,
  }), /返回主工作流/)
})

test('typed node removal clears its persisted Linear binding', () => {
  const session = openedSession()
  session.dispatch({
    kind: 'linear/set-field',
    graphId: 'root',
    nodeId: 'source-image',
    parameter: 'path',
    label: 'Source image',
    exposed: true,
  })
  const result = session.dispatch({
    kind: 'canvas/remove-nodes',
    graphId: 'root',
    nodeIds: ['source-image'],
    context: { graphId: 'root', selectedNodeId: 'source-image' },
  })

  assert.equal(result.documentChanged, true)
  assert.equal(result.snapshot.document?.nodes.some((node) => node.id === 'source-image'), false)
  assert.equal(result.snapshot.linear?.source, 'saved')
  assert.equal(result.snapshot.linear?.definition.fields.some((field) => field.nodeId === 'source-image'), false)
  assert.equal(result.snapshot.document?.metadata?.linearView !== undefined, true)
})

test('Canvas commands use one editor owner for add, connect, remove, undo, and redo', () => {
  const session = openedSession()
  const added = session.dispatch({
    kind: 'canvas/add-node',
    graphId: 'root',
    nodeType: 'text',
    position: { x: 80, y: 360 },
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  assert.equal(added.documentChanged, true)
  assert.equal(added.effect?.kind, 'focus-canvas')
  const addedId = added.effect?.kind === 'focus-canvas' ? added.effect.nodeId : undefined
  assert.ok(addedId)
  assert.deepEqual(added.snapshot.document?.nodes.find((node) => node.id === addedId)?.position, { x: 80, y: 360 })
  assert.equal(added.snapshot.history.canUndo, true)

  const connected = session.dispatch({
    kind: 'canvas/connect',
    graphId: 'root',
    sourceNode: addedId,
    sourceSocket: 'text',
    targetNode: 'generate',
    targetSocket: 'prompt',
    context: { graphId: 'root', selectedNodeId: addedId },
  })
  assert.equal(connected.documentChanged, true)
  assert.equal(connected.snapshot.document?.edges.some((edge) =>
    edge.sourceNode === addedId && edge.targetNode === 'generate' && edge.targetSocket === 'prompt'), true)
  assert.equal(connected.snapshot.document?.edges.some((edge) => edge.id === 'prompt-edge'), false)

  const removed = session.dispatch({
    kind: 'canvas/remove-nodes',
    graphId: 'root',
    nodeIds: [addedId],
    context: { graphId: 'root', selectedNodeId: addedId },
  })
  assert.equal(removed.snapshot.document?.nodes.some((node) => node.id === addedId), false)
  assert.equal(removed.snapshot.document?.edges.some((edge) => edge.sourceNode === addedId), false)

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root' } })
  assert.equal(undone.snapshot.document?.nodes.some((node) => node.id === addedId), true)
  assert.deepEqual(undone.effect, { kind: 'focus-canvas', graphId: 'root', nodeId: addedId, purpose: 'inspect' })
  assert.equal(undone.snapshot.history.canRedo, true)

  const redone = session.dispatch({ kind: 'history/redo', context: { graphId: 'root' } })
  assert.equal(redone.snapshot.document?.nodes.some((node) => node.id === addedId), false)
  assert.equal(redone.snapshot.history.canUndo, true)
})

test('React Flow drag changes become one canonical move and one history entry', () => {
  const session = openedSession()
  const context = { graphId: 'root', selectedNodeId: 'prompt' } as const

  const started = session.dispatch({
    kind: 'canvas/apply-node-changes',
    graphId: 'root',
    changes: [{ type: 'position', id: 'prompt', position: { x: 30, y: 40 }, dragging: true }],
    context,
  })
  assert.equal(started.documentChanged, false)
  assert.equal(started.snapshot.document?.nodes.find((node) => node.id === 'prompt')?.position.x, 10)
  assert.equal(started.snapshot.graphs.root?.nodes.find((node) => node.id === 'prompt')?.position.x, 30)
  assert.equal(started.snapshot.history.canUndo, false)

  session.dispatch({
    kind: 'canvas/apply-node-changes',
    graphId: 'root',
    changes: [{ type: 'position', id: 'prompt', position: { x: 70, y: 80 }, dragging: true }],
    context,
  })
  const ended = session.dispatch({
    kind: 'canvas/apply-node-changes',
    graphId: 'root',
    changes: [{ type: 'position', id: 'prompt', position: { x: 110, y: 120 }, dragging: false }],
    context,
  })
  assert.deepEqual(ended.snapshot.document?.nodes.find((node) => node.id === 'prompt')?.position, { x: 110, y: 120 })
  assert.equal(ended.snapshot.editGeneration, 1)
  assert.equal(ended.snapshot.history.canUndo, true)

  const undone = session.dispatch({ kind: 'history/undo', context })
  assert.deepEqual(undone.snapshot.document?.nodes.find((node) => node.id === 'prompt')?.position, { x: 10, y: 20 })
  assert.equal(undone.snapshot.history.canUndo, false)
  assert.equal(undone.snapshot.history.canRedo, true)
})

test('React Flow edge removals cross the same history interface', () => {
  const session = openedSession()
  const removed = session.dispatch({
    kind: 'canvas/apply-edge-changes',
    graphId: 'root',
    changes: [{ type: 'remove', id: 'reference-edge' }],
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  assert.equal(removed.snapshot.document?.edges.some((edge) => edge.id === 'reference-edge'), false)
  assert.equal(removed.snapshot.history.canUndo, true)

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root' } })
  assert.equal(undone.snapshot.document?.edges.some((edge) => edge.id === 'reference-edge'), true)
})

test('bounded layout, node data, and Frame resize commands share one history owner', () => {
  const session = openedSession()
  const beforePositions = Object.fromEntries((session.getSnapshot().document?.nodes ?? []).map((node) => [node.id, node.position]))
  const layout = session.dispatch({
    kind: 'canvas/auto-layout',
    graphId: 'root',
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  assert.equal(layout.documentChanged, true)
  assert.equal(layout.snapshot.document?.nodes.some((node) =>
    node.position.x !== beforePositions[node.id]?.x || node.position.y !== beforePositions[node.id]?.y), true)

  const updated = session.dispatch({
    kind: 'canvas/update-nodes',
    graphId: 'root',
    updates: [{
      nodeId: 'prompt',
      name: 'Renamed prompt',
      parameters: { text: 'bounded update' },
      annotation: 'kept with the Workflow',
    }],
    context: { graphId: 'root', selectedNodeId: 'prompt' },
  })
  const prompt = updated.snapshot.document?.nodes.find((node) => node.id === 'prompt')
  assert.equal(prompt?.name, 'Renamed prompt')
  assert.equal(prompt?.parameters.text, 'bounded update')
  assert.equal(prompt?.presentation?.annotation, 'kept with the Workflow')

  const added = session.dispatch({
    kind: 'canvas/add-node',
    graphId: 'root',
    nodeType: 'frame',
    position: { x: 0, y: 0 },
    context: { graphId: 'root' },
  })
  const frameId = added.effect?.kind === 'focus-canvas' ? added.effect.nodeId : undefined
  assert.ok(frameId)
  const resized = session.dispatch({
    kind: 'canvas/resize-frame',
    graphId: 'root',
    nodeId: frameId,
    width: 20,
    height: 9_000,
    context: { graphId: 'root', selectedNodeId: frameId },
  })
  const frame = resized.snapshot.document?.nodes.find((node) => node.id === frameId)
  assert.equal(frame?.presentation?.width, 240)
  assert.equal(frame?.presentation?.height, 1600)

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root', selectedNodeId: frameId } })
  assert.equal(undone.snapshot.document?.nodes.find((node) => node.id === frameId)?.presentation?.width, undefined)
  const redone = session.dispatch({ kind: 'history/redo', context: { graphId: 'root', selectedNodeId: frameId } })
  assert.equal(redone.snapshot.document?.nodes.find((node) => node.id === frameId)?.presentation?.height, 1600)
})

test('selection arrangement aligns and distributes only the requested nodes as undoable edits', () => {
  const session = openedSession()
  const distributed = session.dispatch({
    kind: 'canvas/arrange-selection',
    graphId: 'root',
    nodeIds: ['prompt', 'source-image', 'generate'],
    arrangement: 'distribute-vertical',
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  const distributedNodes = distributed.snapshot.document?.nodes ?? []
  assert.equal(distributed.documentChanged, true)
  assert.deepEqual(Object.fromEntries(distributedNodes.map((node) => [node.id, node.position.y])), {
    prompt: 20,
    'source-image': 180,
    generate: 100,
  })

  const aligned = session.dispatch({
    kind: 'canvas/arrange-selection',
    graphId: 'root',
    nodeIds: ['prompt', 'source-image', 'generate'],
    arrangement: 'align-left',
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  assert.deepEqual(aligned.snapshot.document?.nodes.map((node) => node.position.x), [10, 10, 10])

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root', selectedNodeId: 'generate' } })
  assert.deepEqual(undone.snapshot.document?.nodes.map((node) => node.position.x), [10, 10, 420])
  assert.deepEqual(undone.snapshot.document?.nodes.map((node) => node.position.y), [20, 180, 100])
})

test('subgraph conversion is a typed editor command and remains one undoable edit', () => {
  const session = openedSession()
  const converted = session.dispatch({
    kind: 'canvas/convert-selection-to-subgraph',
    graphId: 'root',
    nodeIds: ['source-image'],
    definitionId: 'source_group',
    name: 'Source group',
    description: 'Typed conversion fixture',
    tags: ['test'],
    context: { graphId: 'root', selectedNodeId: 'source-image' },
  })
  assert.equal(converted.documentChanged, true)
  assert.equal(converted.snapshot.document?.subgraphs?.some((definition) => definition.id === 'source_group'), true)
  const instanceId = converted.effect?.kind === 'focus-canvas' ? converted.effect.nodeId : undefined
  assert.ok(instanceId)
  assert.equal(converted.snapshot.document?.nodes.find((node) => node.id === instanceId)?.type, 'subgraph:source_group')
  assert.equal(converted.snapshot.document?.nodes.some((node) => node.id === 'source-image'), false)

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root', selectedNodeId: instanceId } })
  assert.equal(undone.snapshot.document?.nodes.some((node) => node.id === 'source-image'), true)
  assert.equal(undone.snapshot.document?.subgraphs?.length ?? 0, 0)
  const redone = session.dispatch({ kind: 'history/redo', context: { graphId: 'root', selectedNodeId: 'source-image' } })
  assert.equal(redone.snapshot.document?.nodes.some((node) => node.type === 'subgraph:source_group'), true)
})

test('the inpaint fragment command inserts and undoes one validated five-node chain', () => {
  const session = openedSession()
  const before = session.getSnapshot().document as WorkflowDocument
  const inserted = session.dispatch({
    kind: 'canvas/insert-inpaint-chain',
    prompt: 'replace the doorway light',
    sourcePath: 'assets/imports/source.png',
    maskPath: 'assets/masks/source-mask.png',
    providerId: 'account',
    model: 'gpt-image-2',
    size: '1024x1024',
    inputFidelity: 'high',
    assetTitle: 'Source image',
    context: { graphId: 'root', selectedNodeId: 'generate' },
  })
  assert.equal(inserted.documentChanged, true)
  assert.equal((inserted.snapshot.document?.nodes.length ?? 0) - before.nodes.length, 5)
  assert.equal((inserted.snapshot.document?.edges.length ?? 0) - before.edges.length, 4)
  const editNodeId = inserted.effect?.kind === 'focus-canvas' ? inserted.effect.nodeId : undefined
  assert.ok(editNodeId)
  assert.equal(inserted.snapshot.document?.nodes.find((node) => node.id === editNodeId)?.type, 'image_inpaint')

  const undone = session.dispatch({ kind: 'history/undo', context: { graphId: 'root', selectedNodeId: editNodeId } })
  assert.equal(undone.snapshot.document?.nodes.length, before.nodes.length)
  assert.equal(undone.snapshot.document?.edges.length, before.edges.length)
  assert.equal(undone.snapshot.history.canRedo, true)
})

test('readiness repairs reject stale actions, remove invalid edges, and return explicit UI effects', () => {
  const session = openedSession({ model: 'dall-e-3' })
  const issue = session.getSnapshot().readiness?.issues.find((candidate) =>
    candidate.code === 'generation-reference-images-unsupported')
  assert.ok(issue)
  assert.equal(issue.action.kind, 'remove-edge')

  const repaired = session.dispatch({ kind: 'readiness/repair', action: issue.action })
  assert.equal(repaired.documentChanged, true)
  assert.equal(repaired.snapshot.document?.edges.some((edge) => edge.id === 'reference-edge'), false)
  assert.equal(repaired.snapshot.readiness?.issues.some((candidate) =>
    candidate.code === 'generation-reference-images-unsupported'), false)
  assert.throws(() => session.dispatch({ kind: 'readiness/repair', action: issue.action }), /已过期/)

  const unscoped = openedSession({ projectPath: '' })
  const projectIssue = unscoped.getSnapshot().readiness?.issues.find((candidate) => candidate.code === 'project-required')
  assert.ok(projectIssue)
  const requested = unscoped.dispatch({ kind: 'readiness/repair', action: projectIssue.action })
  assert.deepEqual(requested.effect, { kind: 'request-project', suggestedName: 'Editor fixture' })
  assert.equal(requested.documentChanged, false)
})

test('save remains behind the editor interface and refreshes every derived projection from the accepted receipt', async () => {
  let submitted: WorkflowDocument | undefined
  const session = createWorkflowEditorSession({
    persistence: persistence({
      save: async (_scope, document) => {
        submitted = structuredClone(document)
        return { ...document, revision: 8, updatedAt: '2026-07-21T02:00:00.000Z' }
      },
    }),
    readinessProviders: [provider],
    draftEnabled: false,
  })
  session.open({ projectPath: 'P', workflowId: 'workflow-a' }, workflow())
  session.dispatch({
    kind: 'canvas/project-runtime',
    nodes: [{
      graphId: 'root',
      nodeId: 'prompt',
      selected: true,
      data: { status: 'success', runtimeMs: 91, previewUrl: 'studio-asset://saved-runtime' },
    }],
  })
  session.dispatch({ kind: 'linear/set-value', fieldId: 'prompt', value: 'saved edit' })

  const result = await session.save()

  assert.equal(result.status, 'saved')
  assert.equal(submitted?.nodes.find((node) => node.id === 'prompt')?.parameters.text, 'saved edit')
  assert.equal(session.getSnapshot().document?.revision, 8)
  assert.equal(session.getSnapshot().linear?.values.prompt, 'saved edit')
  assert.equal(session.getSnapshot().dirty, false)
  const promptNode = session.getSnapshot().graphs.root?.nodes.find((node) => node.id === 'prompt')
  assert.equal(promptNode?.selected, true)
  assert.equal(promptNode?.data.status, 'success')
  assert.equal(promptNode?.data.runtimeMs, 91)
  assert.equal(promptNode?.data.previewUrl, 'studio-asset://saved-runtime')
})
