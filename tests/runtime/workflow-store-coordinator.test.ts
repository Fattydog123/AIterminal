import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowDocument } from '../../src/studio/shared/types.ts'
import { workflowDocumentFingerprint } from '../../src/renderer/src/studio/renderer/session/workflow-document-session.ts'
import {
  captureWorkflowDocument,
  createWorkflowStoreCoordinator,
  matchesWorkflowDocumentCapture,
  type WorkflowOperationIdentity,
} from '../../src/renderer/src/studio/renderer/session/workflow-store-coordinator.ts'

const identity = (
  workflowId: string,
  overrides: Partial<WorkflowOperationIdentity> = {},
): WorkflowOperationIdentity => ({
  projectPath: 'P',
  workflowId,
  revision: 5,
  editGeneration: 0,
  ...overrides,
})

const workflow = (id = 'workflow-a'): WorkflowDocument => ({
  schemaVersion: 3,
  id,
  name: 'Quick Start',
  revision: 5,
  nodes: [{
    id: 'prompt',
    type: 'text',
    name: 'Prompt',
    position: { x: 10, y: 20 },
    parameters: {
      text: 'before',
      vendorState: { updatedAt: '2026-07-21T00:30:00.000Z' },
    },
    vendorNodeExtension: { nested: { retained: true } },
  } as WorkflowDocument['nodes'][number]],
  edges: [],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T01:00:00.000Z',
  metadata: { vendorMetadata: { retained: true } },
  vendorWorkflowExtension: { nested: { retained: 'yes' } },
} as WorkflowDocument)

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('A -> B -> A rejects the old A draft receipt and accepts only the newest request', async () => {
  const coordinator = createWorkflowStoreCoordinator()
  let current = identity('workflow-a')
  coordinator.beginScope(current)

  const oldDraft = deferred<string>()
  const oldTicket = coordinator.beginRequest(current)
  let recovery: string | undefined
  const oldCompletion = oldDraft.promise.then((value) =>
    coordinator.commitIfCurrent(oldTicket, current, () => { recovery = value }))

  current = identity('workflow-b')
  coordinator.beginScope(current)
  current = identity('workflow-a')
  coordinator.beginScope(current)

  const newDraft = deferred<string>()
  const newTicket = coordinator.beginRequest(current)
  const newCompletion = newDraft.promise.then((value) =>
    coordinator.commitIfCurrent(newTicket, current, () => { recovery = value }))

  oldDraft.resolve('stale A draft')
  assert.equal(await oldCompletion, false)
  assert.equal(recovery, undefined)

  newDraft.resolve('current A draft')
  assert.equal(await newCompletion, true)
  assert.equal(recovery, 'current A draft')
})

test('A -> B -> A rejects a stale restore without changing document, history, or modal state', async () => {
  const coordinator = createWorkflowStoreCoordinator()
  let current = identity('workflow-a')
  coordinator.beginScope(current)

  const historic = deferred<string>()
  const restoreTicket = coordinator.beginRequest(current)
  let documentName = 'Current A'
  let undoCount = 0
  let modal = 'workflow-history'
  const completion = historic.promise.then((name) =>
    coordinator.commitIfCurrent(restoreTicket, current, () => {
      documentName = name
      undoCount += 1
      modal = 'none'
    }))

  current = identity('workflow-b')
  coordinator.beginScope(current)
  current = identity('workflow-a')
  coordinator.beginScope(current)

  historic.resolve('Historic A')
  assert.equal(await completion, false)
  assert.equal(documentName, 'Current A')
  assert.equal(undoCount, 0)
  assert.equal(modal, 'workflow-history')

  const currentTicket = coordinator.beginRequest(current)
  assert.equal(coordinator.commitIfCurrent(currentTicket, current, () => {
    documentName = 'Accepted historic A'
    undoCount += 1
    modal = 'none'
  }), true)
  assert.equal(documentName, 'Accepted historic A')
  assert.equal(undoCount, 1)
  assert.equal(modal, 'none')
})

test('same-scope responses are rejected after the formal revision or edit generation changes', () => {
  const revisionCoordinator = createWorkflowStoreCoordinator()
  const original = identity('workflow-a')
  const revisionTicket = revisionCoordinator.beginRequest(original)
  assert.equal(revisionCoordinator.current(revisionTicket, { ...original, revision: 6 }), false)

  const editCoordinator = createWorkflowStoreCoordinator()
  const editTicket = editCoordinator.beginRequest(original)
  assert.equal(editCoordinator.current(editTicket, { ...original, editGeneration: 1 }), false)
})

test('scope-only requests survive edits but not a scope round trip', () => {
  const coordinator = createWorkflowStoreCoordinator()
  const original = identity('workflow-a')
  const historyTicket = coordinator.beginRequest(original, 'scope')

  assert.equal(coordinator.current(historyTicket, { ...original, revision: 6, editGeneration: 3 }), true)
  coordinator.beginScope(identity('workflow-b'))
  coordinator.beginScope(original)
  assert.equal(coordinator.current(historyTicket, original), false)
})

test('independent request keys do not cancel each other within one scope', () => {
  const coordinator = createWorkflowStoreCoordinator()
  const original = identity('workflow-a')
  coordinator.beginScope(original)
  const draftTicket = coordinator.beginRequest(original, 'document', 'document')
  const historyTicket = coordinator.beginRequest(original, 'scope', 'history')

  assert.equal(coordinator.current(draftTicket, original), true)
  assert.equal(coordinator.current(historyTicket, original), true)

  const newerDraftTicket = coordinator.beginRequest(original, 'document', 'document')
  assert.equal(coordinator.current(draftTicket, original), false)
  assert.equal(coordinator.current(newerDraftTicket, original), true)
  assert.equal(coordinator.current(historyTicket, original), true)
})

test('save feedback survives edits but not a newer save or an A to B to A scope round trip', () => {
  const coordinator = createWorkflowStoreCoordinator()
  const original = identity('workflow-a')
  coordinator.beginScope(original)
  const oldFeedback = coordinator.beginRequest(original, 'scope', 'save-feedback')
  const edited = { ...original, editGeneration: 1 }

  assert.equal(coordinator.current(oldFeedback, edited), true)
  const newFeedback = coordinator.beginRequest(edited, 'scope', 'save-feedback')
  assert.equal(coordinator.current(oldFeedback, edited), false)
  assert.equal(coordinator.current(newFeedback, edited), true)

  coordinator.beginScope(identity('workflow-b'))
  coordinator.beginScope(edited)
  assert.equal(coordinator.current(newFeedback, edited), false)
})

test('a stale bootstrap checks its epoch before opening a workflow session', () => {
  const coordinator = createWorkflowStoreCoordinator()
  let current = identity('workflow-a')
  const bootstrapTicket = coordinator.beginScope(current)
  let sessionWorkflowId = 'workflow-a'
  let staleOpenCalls = 0

  current = identity('workflow-b')
  coordinator.beginScope(current)
  sessionWorkflowId = 'workflow-b'

  const applied = coordinator.commitIfCurrent(bootstrapTicket, current, () => {
    staleOpenCalls += 1
    sessionWorkflowId = 'workflow-a'
  })

  assert.equal(applied, false)
  assert.equal(staleOpenCalls, 0)
  assert.equal(sessionWorkflowId, 'workflow-b')
})

test('create, open, and switch transitions wait for draft flush and stop on flush failure', async (t) => {
  for (const action of ['create', 'open', 'switch'] as const) {
    await t.test(action, async () => {
      const coordinator = createWorkflowStoreCoordinator()
      const current = identity('workflow-a')
      const ticket = coordinator.beginScope(current)
      const flush = deferred<void>()
      const error = new Error(`${action} draft failed`)
      let destinationEffects = 0

      const transition = coordinator.flushDraftThenCommit(
        ticket,
        () => current,
        () => flush.promise,
        () => { destinationEffects += 1 },
      )

      assert.equal(destinationEffects, 0)
      flush.reject(error)
      const result = await transition
      assert.equal(result.status, 'flush-failed')
      if (result.status === 'flush-failed') assert.equal(result.error, error)
      assert.equal(destinationEffects, 0)
    })
  }

  await t.test('successful flush applies the destination exactly once', async () => {
    const coordinator = createWorkflowStoreCoordinator()
    const current = identity('workflow-a')
    const ticket = coordinator.beginScope(current)
    const flush = deferred<void>()
    let destinationEffects = 0
    const transition = coordinator.flushDraftThenCommit(
      ticket,
      () => current,
      () => flush.promise,
      () => { destinationEffects += 1 },
    )

    assert.equal(destinationEffects, 0)
    flush.resolve()
    assert.deepEqual(await transition, { status: 'applied' })
    assert.equal(destinationEffects, 1)
  })

  await t.test('a superseded transition ignores its later flush failure', async () => {
    const coordinator = createWorkflowStoreCoordinator()
    let current = identity('workflow-a')
    const oldTicket = coordinator.beginScope(current)
    const flush = deferred<void>()
    let destinationEffects = 0
    const transition = coordinator.flushDraftThenCommit(
      oldTicket,
      () => current,
      () => flush.promise,
      () => { destinationEffects += 1 },
    )

    current = identity('workflow-b')
    coordinator.beginScope(current)
    flush.reject(new Error('old scope failed late'))

    assert.deepEqual(await transition, { status: 'stale' })
    assert.equal(destinationEffects, 0)
  })
})

test('Quick Start capture is isolated, preserves extensions, and blocks changed chooser state', async () => {
  let current = workflow()
  const capture = captureWorkflowDocument(current, workflowDocumentFingerprint)
  const chooser = deferred<string>()
  let createCalls = 0

  assert.notEqual(capture.document, current)
  assert.notEqual(capture.document.nodes, current.nodes)
  assert.notEqual(capture.document.nodes[0]?.parameters, current.nodes[0]?.parameters)
  assert.deepEqual(
    (capture.document as WorkflowDocument & { vendorWorkflowExtension: unknown }).vendorWorkflowExtension,
    { nested: { retained: 'yes' } },
  )

  const changedCreation = (async () => {
    await chooser.promise
    if (!matchesWorkflowDocumentCapture(capture, current, workflowDocumentFingerprint)) return false
    createCalls += 1
    return true
  })()
  current = {
    ...current,
    nodes: current.nodes.map((node) => node.id === 'prompt'
      ? { ...node, parameters: { ...node.parameters, text: 'changed while choosing' } }
      : node),
  }
  chooser.resolve('C:\\Projects')

  assert.equal(await changedCreation, false)
  assert.equal(createCalls, 0)

  const stable = workflow()
  const stableCapture = captureWorkflowDocument(stable, workflowDocumentFingerprint)
  assert.equal(matchesWorkflowDocumentCapture(stableCapture, stable, workflowDocumentFingerprint), true)
  const initialWorkflow: WorkflowDocument = {
    ...stableCapture.document,
    revision: 0,
    createdAt: '2026-07-21T02:00:00.000Z',
    updatedAt: '2026-07-21T02:00:00.000Z',
  }
  createCalls += 1

  assert.equal(createCalls, 1)
  assert.notEqual(initialWorkflow, stable)
  assert.notEqual(initialWorkflow.nodes, stable.nodes)
  assert.equal(initialWorkflow.id, stable.id)
  assert.equal(initialWorkflow.revision, 0)
  assert.deepEqual(
    (initialWorkflow as WorkflowDocument & { vendorWorkflowExtension: unknown }).vendorWorkflowExtension,
    { nested: { retained: 'yes' } },
  )
  assert.deepEqual(
    (initialWorkflow.nodes[0] as WorkflowDocument['nodes'][number] & { vendorNodeExtension: unknown }).vendorNodeExtension,
    { nested: { retained: true } },
  )
})
