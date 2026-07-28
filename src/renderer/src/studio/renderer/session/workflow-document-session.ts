import type { SubgraphDefinition, SubgraphPort, WorkflowDocument, WorkflowEdge } from '@studio/shared/types.js'

export interface WorkflowDocumentScope {
  readonly projectPath?: string
  readonly workflowId: string
}

export interface PersistedWorkflowDocumentScope extends WorkflowDocumentScope {
  readonly projectPath: string
}

export interface WorkflowDocumentPersistenceAdapter {
  save(scope: PersistedWorkflowDocumentScope, workflow: WorkflowDocument): Promise<WorkflowDocument>
  saveDraft(scope: PersistedWorkflowDocumentScope, workflow: WorkflowDocument): Promise<void>
  discardDraft(scope: PersistedWorkflowDocumentScope): Promise<void>
}

export interface WorkflowDocumentScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WorkflowDocumentSessionSnapshot {
  readonly scope: WorkflowDocumentScope | undefined
  readonly document: WorkflowDocument | undefined
  readonly editGeneration: number
  readonly savedGeneration: number
  readonly dirty: boolean
  readonly saving: boolean
  readonly draftSaving: boolean
  readonly draftError: string
}

export type WorkflowDocumentSaveResult =
  | { readonly status: 'clean' | 'unavailable' }
  | {
      readonly status: 'saved'
      readonly scope: PersistedWorkflowDocumentScope
      readonly receipt: WorkflowDocument
      /** The accepted submitted document, excluding edits made after this save began. */
      readonly document: WorkflowDocument
      readonly appliedToSession: boolean
      /** Meaningful only when appliedToSession is true. */
      readonly dirty: boolean
    }

export interface WorkflowDocumentSession {
  open(scope: WorkflowDocumentScope, document: WorkflowDocument, options?: { readonly dirty?: boolean }): void
  close(): void
  edit(mutator: (document: WorkflowDocument) => WorkflowDocument): WorkflowDocument
  save(): Promise<WorkflowDocumentSaveResult>
  rebaseAcceptedSave(scope: PersistedWorkflowDocumentScope, formalDocument: WorkflowDocument): boolean
  flushDraft(): Promise<boolean>
  discardDraft(): Promise<boolean>
  setDraftEnabled(enabled: boolean): void
  getDocument(): WorkflowDocument | undefined
  getSnapshot(): WorkflowDocumentSessionSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface CreateWorkflowDocumentSessionOptions {
  readonly adapter: WorkflowDocumentPersistenceAdapter
  readonly scheduler?: WorkflowDocumentScheduler
  readonly draftDelayMs?: number
}

type SaveTicket = {
  readonly scopeEpoch: number
  readonly generation: number
  readonly scope: PersistedWorkflowDocumentScope
  readonly document: WorkflowDocument
}

const defaultScheduler: WorkflowDocumentScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

const cloneScope = (scope: WorkflowDocumentScope): WorkflowDocumentScope => ({ ...scope })
const persistedScope = (scope: WorkflowDocumentScope | undefined): PersistedWorkflowDocumentScope | undefined =>
  scope?.projectPath ? { projectPath: scope.projectPath, workflowId: scope.workflowId } : undefined
const cloneDocument = (document: WorkflowDocument): WorkflowDocument => structuredClone(document)

const absent = Symbol('absent')
type MergeValue = unknown | typeof absent

const isRecord = (value: MergeValue): value is Readonly<Record<string, unknown>> =>
  value !== absent && typeof value === 'object' && value !== null && !Array.isArray(value)

const equalValue = (left: MergeValue, right: MergeValue): boolean => {
  if (left === absent || right === absent) return left === right
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equalValue(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && equalValue(left[key], right[key]))
  }
  return false
}

const cloneValue = (value: MergeValue): MergeValue => value === absent ? absent : structuredClone(value)

const idRecord = (value: unknown): value is Readonly<Record<string, unknown>> & { readonly id: string } =>
  isRecord(value) && typeof value.id === 'string' && value.id.length > 0

const mergeValue = (base: MergeValue, local: MergeValue, formal: MergeValue): MergeValue => {
  if (equalValue(local, base)) return cloneValue(formal)
  if (equalValue(formal, base)) return cloneValue(local)
  if (local === absent) return absent
  if (formal === absent) return cloneValue(local)

  if (isRecord(base) && isRecord(local) && isRecord(formal)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(formal)])
    return Object.fromEntries([...keys].flatMap((key) => {
      const merged = mergeValue(
        Object.hasOwn(base, key) ? base[key] : absent,
        Object.hasOwn(local, key) ? local[key] : absent,
        Object.hasOwn(formal, key) ? formal[key] : absent,
      )
      return merged === absent ? [] : [[key, merged]]
    }))
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(formal)) {
    const allItems = [...base, ...local, ...formal]
    if (allItems.length > 0 && allItems.every(idRecord)) {
      const baseById = new Map(base.map((item) => [item.id, item]))
      const localById = new Map(local.map((item) => [item.id, item]))
      const formalById = new Map(formal.map((item) => [item.id, item]))
      const ids = [...local.map((item) => item.id), ...formal.map((item) => item.id)]
        .filter((id, index, items) => items.indexOf(id) === index)
      return ids.flatMap((id) => {
        const merged = mergeValue(
          baseById.get(id) ?? absent,
          localById.get(id) ?? absent,
          formalById.get(id) ?? absent,
        )
        return merged === absent ? [] : [merged]
      })
    }
  }

  // A same-field conflict is resolved in favor of the current local edit.
  return cloneValue(local)
}

const repairGraphReferences = (
  document: WorkflowDocument,
  definitionVersions: ReadonlyMap<string, number>,
): WorkflowDocument => {
  const nodes = document.nodes.filter((node) => {
    if (!node.type.startsWith('subgraph:')) return true
    const reference = node.subgraph
    return reference !== undefined
      && node.type === `subgraph:${reference.definitionId}`
      && definitionVersions.get(reference.definitionId) === reference.definitionVersion
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = document.edges.filter((edge) => nodeIds.has(edge.sourceNode) && nodeIds.has(edge.targetNode))
  if (nodes.length === document.nodes.length && edges.length === document.edges.length) return document
  return { ...document, nodes, edges }
}

const repairWorkflowReferences = (document: WorkflowDocument): WorkflowDocument => {
  const definitions = document.subgraphs ?? []
  const definitionVersions = new Map(definitions.map((definition) => [definition.id, definition.version]))
  const subgraphs = document.subgraphs?.map((definition) => {
    const workflow = repairGraphReferences(definition.workflow, definitionVersions)
    return workflow === definition.workflow ? definition : { ...definition, workflow }
  })
  const subgraphsChanged = subgraphs?.some((definition, index) => definition !== document.subgraphs?.[index]) ?? false
  const rootWithRepairedSubgraphs = subgraphsChanged ? {
    ...document,
    subgraphs,
  } : document
  return repairGraphReferences(rootWithRepairedSubgraphs, definitionVersions)
}

const hasConcurrentCollectionChanges = <T>(
  base: readonly T[],
  local: readonly T[],
  formal: readonly T[],
): boolean => !equalValue(base, local) && !equalValue(base, formal) && !equalValue(local, formal)

const hasGraphStructuralConflict = (
  nodes: WorkflowDocument['nodes'],
  edges: readonly WorkflowEdge[],
): boolean => {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edgeIds = new Set<string>()
  const occupiedInputs = new Set<string>()
  const indegree = new Map([...nodeIds].map((nodeId) => [nodeId, 0]))
  const outgoing = new Map([...nodeIds].map((nodeId) => [nodeId, [] as string[]]))

  for (const edge of edges) {
    if (edgeIds.has(edge.id)) return true
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.sourceNode) || !nodeIds.has(edge.targetNode)) continue

    // The session intentionally does not own the node registry. For a concurrent
    // merge, an occupied endpoint is therefore treated as a structural conflict;
    // the normal editor still decides whether an individual input is multi-value.
    const targetKey = `${edge.targetNode}\u0000${edge.targetSocket}`
    if (occupiedInputs.has(targetKey)) return true
    occupiedInputs.add(targetKey)
    indegree.set(edge.targetNode, (indegree.get(edge.targetNode) ?? 0) + 1)
    outgoing.get(edge.sourceNode)?.push(edge.targetNode)
  }

  const pending = [...nodeIds].filter((nodeId) => indegree.get(nodeId) === 0)
  let visited = 0
  for (let index = 0; index < pending.length; index += 1) {
    const nodeId = pending[index]
    if (!nodeId) continue
    visited += 1
    for (const targetId of outgoing.get(nodeId) ?? []) {
      const next = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, next)
      if (next === 0) pending.push(targetId)
    }
  }
  return visited !== nodeIds.size
}

const hasSubgraphInterfaceConflict = (
  inputs: readonly SubgraphPort[],
  outputs: readonly SubgraphPort[],
): boolean => {
  const portIds = new Set<string>()
  const inputNames = new Set<string>()
  const outputNames = new Set<string>()
  for (const [ports, names] of [[inputs, inputNames], [outputs, outputNames]] as const) {
    for (const port of ports) {
      if (portIds.has(port.id) || names.has(port.name)) return true
      portIds.add(port.id)
      names.add(port.name)
    }
  }
  return false
}

const hasConcurrentSubgraphInterfaceChanges = (
  base: Pick<SubgraphDefinition, 'inputs' | 'outputs'>,
  local: Pick<SubgraphDefinition, 'inputs' | 'outputs'>,
  formal: Pick<SubgraphDefinition, 'inputs' | 'outputs'>,
): boolean => {
  const baseInterface = { inputs: base.inputs, outputs: base.outputs }
  const localInterface = { inputs: local.inputs, outputs: local.outputs }
  const formalInterface = { inputs: formal.inputs, outputs: formal.outputs }
  return !equalValue(baseInterface, localInterface)
    && !equalValue(baseInterface, formalInterface)
    && !equalValue(localInterface, formalInterface)
}

const stabilizeConcurrentStructure = (
  base: WorkflowDocument,
  local: WorkflowDocument,
  formal: WorkflowDocument,
  merged: WorkflowDocument,
): WorkflowDocument => {
  const edges = hasConcurrentCollectionChanges(base.edges, local.edges, formal.edges)
    && hasGraphStructuralConflict(merged.nodes, merged.edges)
    ? structuredClone(local.edges)
    : merged.edges
  const baseDefinitions = new Map((base.subgraphs ?? []).map((definition) => [definition.id, definition]))
  const localDefinitions = new Map((local.subgraphs ?? []).map((definition) => [definition.id, definition]))
  const formalDefinitions = new Map((formal.subgraphs ?? []).map((definition) => [definition.id, definition]))
  const subgraphs = merged.subgraphs?.map((definition) => {
    const baseDefinition = baseDefinitions.get(definition.id)
    const localDefinition = localDefinitions.get(definition.id)
    const formalDefinition = formalDefinitions.get(definition.id)
    if (!baseDefinition || !localDefinition || !formalDefinition) return definition
    const interfaceChangedConcurrently = hasConcurrentSubgraphInterfaceChanges(
      baseDefinition,
      localDefinition,
      formalDefinition,
    )
    const preserveLocalInterface = interfaceChangedConcurrently
      && hasSubgraphInterfaceConflict(definition.inputs, definition.outputs)
    const inputs = preserveLocalInterface ? structuredClone(localDefinition.inputs) : definition.inputs
    const outputs = preserveLocalInterface ? structuredClone(localDefinition.outputs) : definition.outputs
    const workflow = stabilizeConcurrentStructure(
      baseDefinition.workflow,
      localDefinition.workflow,
      formalDefinition.workflow,
      definition.workflow,
    )
    return workflow === definition.workflow && inputs === definition.inputs && outputs === definition.outputs
      ? definition
      : { ...definition, inputs, outputs, workflow }
  })
  const edgesChanged = edges !== merged.edges
  const subgraphsChanged = subgraphs?.some((definition, index) => definition !== merged.subgraphs?.[index]) ?? false
  if (!edgesChanged && !subgraphsChanged) return merged
  return {
    ...merged,
    ...(edgesChanged ? { edges } : {}),
    ...(subgraphsChanged ? { subgraphs } : {}),
  }
}

const removeRecursiveSubgraphInstances = (
  document: WorkflowDocument,
  local: WorkflowDocument,
): WorkflowDocument => {
  const definitions = document.subgraphs ?? []
  const localDefinitions = new Map((local.subgraphs ?? []).map((definition) => [definition.id, definition]))
  const dependencies = definitions.flatMap((definition, definitionIndex) => {
    const localNodes = new Map((localDefinitions.get(definition.id)?.workflow.nodes ?? []).map((node) => [node.id, node]))
    return definition.workflow.nodes.flatMap((node, nodeIndex) => {
      const reference = node.type.startsWith('subgraph:') ? node.subgraph : undefined
      if (!reference) return []
      const localNode = localNodes.get(node.id)
      const existsLocally = localNode?.type === node.type && equalValue(localNode.subgraph ?? absent, reference)
      return [{
        ownerId: definition.id,
        targetId: reference.definitionId,
        nodeId: node.id,
        existsLocally,
        order: definitionIndex * 5_000 + nodeIndex,
      }]
    })
  }).sort((left, right) => Number(right.existsLocally) - Number(left.existsLocally) || left.order - right.order)

  const adjacency = new Map(definitions.map((definition) => [definition.id, new Set<string>()]))
  const removals = new Map<string, Set<string>>()
  const reaches = (start: string, target: string): boolean => {
    const pending = [start]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()
      if (!current || visited.has(current)) continue
      if (current === target) return true
      visited.add(current)
      pending.push(...(adjacency.get(current) ?? []))
    }
    return false
  }

  for (const dependency of dependencies) {
    if (dependency.ownerId === dependency.targetId || reaches(dependency.targetId, dependency.ownerId)) {
      const removed = removals.get(dependency.ownerId) ?? new Set<string>()
      removed.add(dependency.nodeId)
      removals.set(dependency.ownerId, removed)
      continue
    }
    adjacency.get(dependency.ownerId)?.add(dependency.targetId)
  }
  if (removals.size === 0) return document

  return {
    ...document,
    subgraphs: definitions.map((definition) => {
      const removed = removals.get(definition.id)
      if (!removed || removed.size === 0) return definition
      const nodes = definition.workflow.nodes.filter((node) => !removed.has(node.id))
      const nodeIds = new Set(nodes.map((node) => node.id))
      const edges = definition.workflow.edges.filter((edge) =>
        nodeIds.has(edge.sourceNode) && nodeIds.has(edge.targetNode))
      return { ...definition, workflow: { ...definition.workflow, nodes, edges } }
    }),
  }
}

const rebaseWorkflowDocument = (
  base: WorkflowDocument,
  local: WorkflowDocument,
  formal: WorkflowDocument,
): WorkflowDocument => {
  const merged = mergeValue(base, local, formal)
  if (!isRecord(merged)) throw new Error('Workflow 三方重基线失败')
  const mergedDocument = {
    ...merged,
    id: formal.id,
    revision: formal.revision,
    createdAt: formal.createdAt,
    updatedAt: formal.updatedAt,
  } as unknown as WorkflowDocument
  const stabilized = stabilizeConcurrentStructure(base, local, formal, mergedDocument)
  return removeRecursiveSubgraphInstances(repairWorkflowReferences(stabilized), local)
}

export const workflowDocumentFingerprint = (document: WorkflowDocument): string => {
  const { updatedAt: _formalUpdatedAt, ...content } = document
  return JSON.stringify(content) ?? ''
}

const editedDocument = (current: WorkflowDocument, candidate: WorkflowDocument): WorkflowDocument => ({
  ...current,
  ...candidate,
  id: current.id,
  revision: current.revision,
  createdAt: current.createdAt,
  updatedAt: current.updatedAt,
})

const applySaveReceipt = (current: WorkflowDocument, receipt: WorkflowDocument): WorkflowDocument => ({
  ...current,
  revision: receipt.revision,
  createdAt: receipt.createdAt,
  updatedAt: receipt.updatedAt,
})

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '草稿保存失败'

class WorkflowDocumentSessionImplementation implements WorkflowDocumentSession {
  readonly #adapter: WorkflowDocumentPersistenceAdapter
  readonly #scheduler: WorkflowDocumentScheduler
  readonly #draftDelayMs: number
  readonly #listeners = new Set<() => void>()

  #scope: WorkflowDocumentScope | undefined
  #document: WorkflowDocument | undefined
  #baseline: WorkflowDocument | undefined
  #snapshot!: WorkflowDocumentSessionSnapshot
  #scopeEpoch = 0
  #editGeneration = 0
  #savedGeneration = 0
  #saving = false
  #draftEnabled = false
  #draftTimer: unknown
  readonly #draftWritesByEpoch = new Map<number, number>()
  #draftError = ''
  #disposed = false
  #savePromise: Promise<WorkflowDocumentSaveResult> | undefined
  #draftQueue: Promise<void> = Promise.resolve()

  constructor(options: CreateWorkflowDocumentSessionOptions) {
    this.#adapter = options.adapter
    this.#scheduler = options.scheduler ?? defaultScheduler
    this.#draftDelayMs = options.draftDelayMs ?? 900
    this.#publish()
  }

  open(scope: WorkflowDocumentScope, document: WorkflowDocument, options: { readonly dirty?: boolean } = {}): void {
    if (this.#disposed) return
    if (document.id !== scope.workflowId) throw new Error('Workflow scope 与文档 ID 不一致')
    this.#scopeEpoch += 1
    this.#cancelDraftTimer()
    this.#scope = cloneScope(scope)
    this.#document = cloneDocument(document)
    this.#baseline = cloneDocument(document)
    this.#editGeneration = options.dirty ? 1 : 0
    this.#savedGeneration = 0
    this.#saving = false
    this.#savePromise = undefined
    this.#draftError = ''
    if (options.dirty) this.#scheduleDraft()
    this.#publish()
  }

  close(): void {
    if (this.#disposed) return
    this.#scopeEpoch += 1
    this.#cancelDraftTimer()
    this.#scope = undefined
    this.#document = undefined
    this.#baseline = undefined
    this.#editGeneration = 0
    this.#savedGeneration = 0
    this.#saving = false
    this.#savePromise = undefined
    this.#draftError = ''
    this.#publish()
  }

  edit(mutator: (document: WorkflowDocument) => WorkflowDocument): WorkflowDocument {
    const current = this.#document
    if (this.#disposed || !current) throw new Error('Workflow 文档会话尚未打开')
    const candidate = editedDocument(current, mutator(current))
    if (workflowDocumentFingerprint(candidate) === workflowDocumentFingerprint(current)) return current
    this.#document = candidate
    this.#editGeneration += 1
    this.#draftError = ''
    this.#scheduleDraft()
    this.#publish()
    return candidate
  }

  rebaseAcceptedSave(scope: PersistedWorkflowDocumentScope, formalDocument: WorkflowDocument): boolean {
    const currentScope = persistedScope(this.#scope)
    const current = this.#document
    const baseline = this.#baseline
    if (this.#disposed || !currentScope || !current || !baseline
      || currentScope.projectPath !== scope.projectPath
      || currentScope.workflowId !== scope.workflowId
      || formalDocument.id !== scope.workflowId
      || !Number.isSafeInteger(formalDocument.revision)
      || formalDocument.revision < current.revision) return false

    this.#cancelDraftTimer()
    if (this.#dirty()) {
      this.#document = rebaseWorkflowDocument(baseline, current, formalDocument)
      this.#baseline = cloneDocument(formalDocument)
      this.#scheduleDraft()
    } else {
      this.#document = cloneDocument(formalDocument)
      this.#baseline = cloneDocument(formalDocument)
    }
    this.#publish()
    return true
  }

  save(): Promise<WorkflowDocumentSaveResult> {
    if (this.#disposed || !persistedScope(this.#scope) || !this.#document) return Promise.resolve({ status: 'unavailable' })
    if (!this.#dirty()) return Promise.resolve({ status: 'clean' })
    if (this.#savePromise) return this.#savePromise

    const ticket = this.#ticket()
    this.#saving = true
    this.#publish()
    const request = this.#adapter.save(ticket.scope, cloneDocument(ticket.document))
      .then((receipt): WorkflowDocumentSaveResult => {
        if (receipt.id !== ticket.document.id) throw new Error('保存回执不属于当前 Workflow')
        if (!Number.isSafeInteger(receipt.revision) || receipt.revision < ticket.document.revision) {
          throw new Error('保存回执包含无效 revision')
        }
        const formalDocument = applySaveReceipt(ticket.document, receipt)
        const appliedToSession = this.#isCurrent(ticket)
        let dirty = false
        if (appliedToSession) {
          const current = this.#document as WorkflowDocument
          this.#document = rebaseWorkflowDocument(ticket.document, current, formalDocument)
          this.#baseline = cloneDocument(formalDocument)
          this.#savedGeneration = ticket.generation
          this.#saving = false
          this.#savePromise = undefined
          this.#cancelDraftTimer()
          dirty = this.#dirty()
          if (dirty) this.#scheduleDraft()
          else {
            void this.#enqueueDraft(
              async () => this.#adapter.discardDraft(ticket.scope),
              ticket.scopeEpoch,
              false,
            ).catch((error: unknown) => {
              if (this.#isCurrent(ticket)) {
                this.#draftError = `正式版本已保存；草稿清理失败：${errorMessage(error)}`
                this.#publish()
              }
            })
          }
          this.#publish()
        }
        return {
          status: 'saved',
          scope: { ...ticket.scope },
          receipt: cloneDocument(receipt),
          document: cloneDocument(formalDocument),
          appliedToSession,
          dirty,
        }
      })
      .catch((error: unknown) => {
        if (this.#isCurrent(ticket)) {
          this.#saving = false
          this.#savePromise = undefined
          this.#publish()
        }
        throw error
      })
    this.#savePromise = request
    return request
  }

  async flushDraft(): Promise<boolean> {
    if (this.#disposed || !this.#draftEnabled || !persistedScope(this.#scope) || !this.#document || !this.#dirty()) return false
    this.#cancelDraftTimer()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ticket = this.#ticket()
      await this.#enqueueDraft(
        () => this.#adapter.saveDraft(ticket.scope, cloneDocument(ticket.document)),
        ticket.scopeEpoch,
        true,
      )
      if (!this.#isCurrent(ticket) || !this.#dirty()) return true
      if (ticket.generation === this.#editGeneration) return true
    }
    throw new Error('画布仍在持续变化；请停止输入后重试，以免遗漏最后一段草稿')
  }

  async discardDraft(): Promise<boolean> {
    const persisted = persistedScope(this.#scope)
    if (this.#disposed || !persisted) return false
    this.#cancelDraftTimer()
    const scope = { ...persisted }
    const epoch = this.#scopeEpoch
    await this.#enqueueDraft(async () => {
      if (this.#scopeEpoch !== epoch) return
      await this.#adapter.discardDraft(scope)
    }, epoch, false)
    return this.#scopeEpoch === epoch
  }

  setDraftEnabled(enabled: boolean): void {
    if (this.#disposed || enabled === this.#draftEnabled) return
    this.#draftEnabled = enabled
    if (!enabled) this.#cancelDraftTimer()
    else if (this.#dirty()) this.#scheduleDraft()
    this.#publish()
  }

  getDocument = (): WorkflowDocument | undefined => this.#document

  getSnapshot = (): WorkflowDocumentSessionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#scopeEpoch += 1
    this.#cancelDraftTimer()
    this.#listeners.clear()
  }

  #ticket(): SaveTicket {
    return {
      scopeEpoch: this.#scopeEpoch,
      generation: this.#editGeneration,
      scope: { ...(persistedScope(this.#scope) as PersistedWorkflowDocumentScope) },
      document: cloneDocument(this.#document as WorkflowDocument),
    }
  }

  #dirty(): boolean {
    return this.#document !== undefined && (
      this.#editGeneration !== this.#savedGeneration
      || (this.#baseline !== undefined
        && !equalValue(this.#document, this.#baseline))
    )
  }

  #isCurrent(ticket: SaveTicket): boolean {
    return !this.#disposed
      && ticket.scopeEpoch === this.#scopeEpoch
      && ticket.scope.workflowId === this.#scope?.workflowId
      && ticket.scope.projectPath === this.#scope.projectPath
  }

  #scheduleDraft(): void {
    this.#cancelDraftTimer()
    if (!this.#draftEnabled || !persistedScope(this.#scope) || !this.#document || !this.#dirty()) return
    const ticket = this.#ticket()
    this.#draftTimer = this.#scheduler.setTimeout(() => {
      this.#draftTimer = undefined
      if (!this.#isCurrent(ticket) || ticket.generation !== this.#editGeneration || !this.#dirty()) {
        this.#publish()
        return
      }
      void this.#enqueueDraft(
        () => this.#adapter.saveDraft(ticket.scope, cloneDocument(ticket.document)),
        ticket.scopeEpoch,
        true,
      ).catch(() => undefined)
      this.#publish()
    }, this.#draftDelayMs)
  }

  #cancelDraftTimer(): void {
    if (this.#draftTimer === undefined) return
    this.#scheduler.clearTimeout(this.#draftTimer)
    this.#draftTimer = undefined
  }

  #enqueueDraft(operation: () => Promise<void>, scopeEpoch: number, reportError: boolean): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.#disposed) return
      this.#draftWritesByEpoch.set(scopeEpoch, (this.#draftWritesByEpoch.get(scopeEpoch) ?? 0) + 1)
      if (scopeEpoch === this.#scopeEpoch) this.#publish()
      try {
        await operation()
        if (scopeEpoch === this.#scopeEpoch && reportError) this.#draftError = ''
      } catch (error) {
        if (scopeEpoch === this.#scopeEpoch && reportError) {
          this.#draftError = errorMessage(error)
          this.#publish()
        }
        throw error
      } finally {
        const remaining = (this.#draftWritesByEpoch.get(scopeEpoch) ?? 1) - 1
        if (remaining > 0) this.#draftWritesByEpoch.set(scopeEpoch, remaining)
        else this.#draftWritesByEpoch.delete(scopeEpoch)
        if (scopeEpoch === this.#scopeEpoch) this.#publish()
      }
    }
    const result = this.#draftQueue.then(run, run)
    this.#draftQueue = result.catch(() => undefined)
    return result
  }

  #publish(): void {
    if (this.#disposed) return
    this.#snapshot = Object.freeze({
      scope: this.#scope ? Object.freeze(cloneScope(this.#scope)) : undefined,
      document: this.#document,
      editGeneration: this.#editGeneration,
      savedGeneration: this.#savedGeneration,
      dirty: this.#dirty(),
      saving: this.#saving,
      draftSaving: this.#draftTimer !== undefined || (this.#draftWritesByEpoch.get(this.#scopeEpoch) ?? 0) > 0,
      draftError: this.#draftError,
    })
    for (const listener of this.#listeners) listener()
  }
}

export const createWorkflowDocumentSession = (
  options: CreateWorkflowDocumentSessionOptions,
): WorkflowDocumentSession => new WorkflowDocumentSessionImplementation(options)
