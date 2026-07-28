import type { WorkflowDocument } from '@studio/shared/types.js'

export interface WorkflowOperationIdentity {
  readonly projectPath: string | undefined
  readonly workflowId: string
  readonly revision: number
  readonly editGeneration: number
}

export interface WorkflowOperationTicket extends WorkflowOperationIdentity {
  readonly epoch: number
  readonly kind: 'scope' | 'request'
  readonly match: 'scope' | 'document'
  readonly requestKey?: string
  readonly requestEpoch?: number
}

export type WorkflowDraftFlushResult =
  | { readonly status: 'applied' }
  | { readonly status: 'stale' }
  | { readonly status: 'flush-failed'; readonly error: unknown }

export type WorkflowDocumentFingerprint = (document: WorkflowDocument) => string

export interface WorkflowDocumentCapture {
  readonly document: WorkflowDocument
  readonly fingerprint: string
}

export interface WorkflowStoreCoordinator {
  beginScope(identity: WorkflowOperationIdentity, match?: WorkflowOperationTicket['match']): WorkflowOperationTicket
  beginRequest(
    identity: WorkflowOperationIdentity,
    match?: WorkflowOperationTicket['match'],
    requestKey?: string,
  ): WorkflowOperationTicket
  current(ticket: WorkflowOperationTicket, identity: WorkflowOperationIdentity | undefined): boolean
  commitIfCurrent(
    ticket: WorkflowOperationTicket,
    identity: WorkflowOperationIdentity | undefined,
    effect: () => void,
  ): boolean
  flushDraftThenCommit(
    ticket: WorkflowOperationTicket,
    getIdentity: () => WorkflowOperationIdentity | undefined,
    flushDraft: () => Promise<unknown>,
    effect: () => void,
  ): Promise<WorkflowDraftFlushResult>
}

const sameIdentity = (left: WorkflowOperationIdentity, right: WorkflowOperationIdentity): boolean =>
  left.projectPath === right.projectPath
  && left.workflowId === right.workflowId
  && left.revision === right.revision
  && left.editGeneration === right.editGeneration

const sameScope = (left: WorkflowOperationIdentity, right: WorkflowOperationIdentity): boolean =>
  left.projectPath === right.projectPath && left.workflowId === right.workflowId

export const createWorkflowStoreCoordinator = (): WorkflowStoreCoordinator => {
  let scopeEpoch = 0
  const requestEpochs = new Map<string, number>()

  const scopeTicket = (
    identity: WorkflowOperationIdentity,
    match: WorkflowOperationTicket['match'],
  ): WorkflowOperationTicket => ({
    ...identity,
    epoch: ++scopeEpoch,
    kind: 'scope',
    match,
  })

  const requestTicket = (
    identity: WorkflowOperationIdentity,
    match: WorkflowOperationTicket['match'],
    requestKey: string,
  ): WorkflowOperationTicket => {
    const requestEpoch = (requestEpochs.get(requestKey) ?? 0) + 1
    requestEpochs.set(requestKey, requestEpoch)
    return {
      ...identity,
      epoch: scopeEpoch,
      kind: 'request',
      match,
      requestKey,
      requestEpoch,
    }
  }

  const current = (
    ticket: WorkflowOperationTicket,
    identity: WorkflowOperationIdentity | undefined,
  ): boolean => identity !== undefined
    && ticket.epoch === scopeEpoch
    && (ticket.kind === 'scope'
      || (ticket.requestKey !== undefined
        && ticket.requestEpoch === requestEpochs.get(ticket.requestKey)))
    && (ticket.match === 'scope' ? sameScope(ticket, identity) : sameIdentity(ticket, identity))

  const commitIfCurrent = (
    ticket: WorkflowOperationTicket,
    identity: WorkflowOperationIdentity | undefined,
    effect: () => void,
  ): boolean => {
    if (!current(ticket, identity)) return false
    effect()
    return true
  }

  return {
    beginScope: (identity, match = 'document') => scopeTicket(identity, match),
    beginRequest: (identity, match = 'document', requestKey = 'document') =>
      requestTicket(identity, match, requestKey),
    current,
    commitIfCurrent,
    flushDraftThenCommit: async (ticket, getIdentity, flushDraft, effect) => {
      if (!current(ticket, getIdentity())) return { status: 'stale' }
      try {
        await flushDraft()
      } catch (error) {
        return current(ticket, getIdentity())
          ? { status: 'flush-failed', error }
          : { status: 'stale' }
      }
      return commitIfCurrent(ticket, getIdentity(), effect)
        ? { status: 'applied' }
        : { status: 'stale' }
    },
  }
}

export const captureWorkflowDocument = (
  document: WorkflowDocument,
  fingerprint: WorkflowDocumentFingerprint,
): WorkflowDocumentCapture => {
  const captured = structuredClone(document)
  return {
    document: captured,
    fingerprint: fingerprint(captured),
  }
}

export const matchesWorkflowDocumentCapture = (
  capture: WorkflowDocumentCapture,
  document: WorkflowDocument,
  fingerprint: WorkflowDocumentFingerprint,
): boolean => capture.fingerprint === fingerprint(document)
