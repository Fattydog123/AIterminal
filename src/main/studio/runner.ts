import { createHash } from 'node:crypto'
import path from 'node:path'
import { lstat, realpath, rm } from 'node:fs/promises'
import { createExecutionPlan, materializeOverrideOutputs, type NodeOverride } from '../../studio/core/executionPlan.js'
import {
  applyComfyWorkflowBindings,
  parseComfyBindingMap,
  type ComfyBindingMap,
  type ComfyBindingValues,
  type ComfyInputReference,
} from '../../studio/core/comfyWorkflow.js'
import { isGptImageModel, supportsImageInputFidelity, supportsImageSeed } from '../../studio/core/imageModels.js'
import { defaultRegistry } from '../../studio/core/registry.js'
import { flattenSubgraphs } from '../../studio/core/subgraphs.js'
import { canonicalJson } from '../../studio/core/canonicalJson.js'
import type {
  ExecutionTimelineEvent,
  GeneratedAsset,
  ImageEditRequest,
  ImageGenerationRequest,
  ProviderDescriptor,
  RunPlan,
  RunDispatchState,
  RunRecordMatrixMetadata,
  RunRecordPlan,
  RunRecordProviderBinding,
  RunRecordRemoteJob,
  RunResult,
  TaskRecord,
  WorkflowDocument,
  WorkflowNode,
} from '../../studio/shared/types.js'
import { ComfyUiAdapter } from './comfyui.js'
import { StudioError, asStudioError, assertNoSecretFields, redactValue } from './errors.js'
import { atomicWriteFile, atomicWriteJson, ensureDirectory, safeFilename } from './filesystem.js'
import { editImages, generateImages, imageDimensions, loadLocalImage, type ProviderImage, type ProviderRequestContext } from './network.js'
import { ProjectStore, type PersistentRunQueueItem } from './projects.js'
import { ProviderStore } from './providers.js'

export interface PrepareRunInput {
  readonly projectPath: string
  readonly workflow: WorkflowDocument
  readonly targetNodeIds?: readonly string[]
  readonly overrides?: Readonly<Record<string, NodeOverride>>
}

export interface StartRunInput extends PrepareRunInput {
  readonly planId: string
}

type Emit = (event: unknown) => void
type EnsureEndpointConsent = (endpoint: string) => Promise<void>
type NodeOutputs = Readonly<Record<string, unknown>>
interface MutableTimelineEvent {
  id: string
  runId: string
  nodeId: string
  phase: ExecutionTimelineEvent['phase']
  startedAt: string
  finishedAt?: string
  durationMs?: number
  cacheHit?: boolean
  errorCode?: string
}

interface PreparedRun {
  readonly plan: RunPlan
  readonly projectPath: string
  readonly workflowHash: string
  readonly executionInputHash: string
  readonly sourceWorkflow: WorkflowDocument
  readonly targetNodeIds: readonly string[]
  readonly flattenedWorkflow: WorkflowDocument
  readonly overrides: Readonly<Record<string, NodeOverride>>
  readonly cacheKeys: Readonly<Record<string, string>>
  readonly cachedOutputs: Readonly<Record<string, NodeOutputs>>
  readonly expiresAt: number
}

interface RunRecordEvidence {
  readonly workflowSnapshot: WorkflowDocument
  readonly workflowHash: string
  readonly targetNodeIds: readonly string[]
  readonly overrides: Readonly<Record<string, NodeOverride>>
  readonly plan: RunRecordPlan
  readonly providerBindings: Map<string, RunRecordProviderBinding>
  readonly matrix?: RunRecordMatrixMetadata
  readonly remoteJobs: RunRecordRemoteJob[]
}

interface QueuedRun {
  readonly id: string
  readonly controller: AbortController
  readonly queuedAt: string
  readonly projectPath: string
  readonly item: PersistentRunQueueItem
  readonly execute: (queuedAt: string, dequeuedAt: string) => Promise<RunResult>
  readonly resolve: (value: RunResult) => void
}

const workflowHash = (workflow: WorkflowDocument): string =>
  createHash('sha256').update(canonicalJson(workflow)).digest('hex')

const executionInputHash = (
  targetNodeIds: readonly string[] | undefined,
  overrides: Readonly<Record<string, NodeOverride>> | undefined,
): string => createHash('sha256').update(JSON.stringify(canonicalValue({
  targetNodeIds: targetNodeIds ?? [],
  overrides: overrides ?? {},
}))).digest('hex')

const strongestDispatchState = (...states: readonly (RunDispatchState | undefined)[]): RunDispatchState => {
  if (states.includes('billing_unknown')) return 'billing_unknown'
  if (states.includes('sent')) return 'sent'
  return 'not_sent'
}

const redactPersistentText = (value: string): string => value
  .replace(/\b(?:sk|sess|key)-[a-z0-9_-]{8,}\b/gi, '[REDACTED]')
  .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, '[REDACTED]')
  .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, '$1[REDACTED]')

const redactPersistentValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactPersistentText(value)
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(redactPersistentValue)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPersistentValue(item)]))
}

const recordMatrixMetadata = (workflow: WorkflowDocument): RunRecordMatrixMetadata | undefined => {
  const raw = objectValue(objectValue(workflow.metadata).promptMatrix)
  const batchId = typeof raw.batchId === 'string' ? raw.batchId.trim() : ''
  const index = Number(raw.index)
  const taskCount = Number(raw.taskCount)
  if (!batchId || batchId.length > 160 || !Number.isSafeInteger(index) || index < 1 || !Number.isSafeInteger(taskCount) || taskCount < 1) {
    return undefined
  }
  const parameters: Record<string, string | number | boolean | null> = {}
  const parameterNames = new Set(['text', 'prompt', 'model', 'size', 'seed'])
  for (const node of flattenSubgraphs(workflow).nodes) {
    for (const [name, value] of Object.entries(node.parameters)) {
      if (!parameterNames.has(name) || !['string', 'number', 'boolean'].includes(typeof value)) continue
      if (typeof value === 'number' && !Number.isFinite(value)) continue
      parameters[`${node.id}.${name}`] = value as string | number | boolean
    }
  }
  const explicitParameters = objectValue(raw.parameters)
  for (const [name, value] of Object.entries(explicitParameters)) {
    if (!name || name.length > 320 || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    parameters[name] = value as string | number | boolean | null
  }
  const estimatedCost = Number(raw.userEstimatedCostPerImage)
  return {
    batchId,
    index,
    taskCount,
    ...(Number.isFinite(estimatedCost) && estimatedCost >= 0 ? { userEstimatedCostPerImage: estimatedCost } : {}),
    parameters,
  }
}

const cancelledResult = (runId: string): RunResult => ({
  runId,
  status: 'cancelled',
  dispatchState: 'not_sent',
  outputs: {},
  error: { code: 'run-cancelled', message: '运行已取消', billingUnknown: false, dispatchState: 'not_sent' },
})

const objectValue = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {}

const comfyBindingMap = (node: WorkflowNode): ComfyBindingMap | undefined => {
  const raw = node.parameters.comfyBindings
  if (raw === undefined || raw === ''
    || (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0)) return undefined
  try {
    return parseComfyBindingMap(raw)
  } catch (error) {
    throw new StudioError('comfy-binding-invalid', error instanceof Error ? error.message : 'ComfyUI 多参数绑定无效', 'not_sent', error)
  }
}

const comfyPromptGraph = (
  node: WorkflowNode,
  prompt: string,
  bindingValues: ComfyBindingValues,
  bindings: ComfyBindingMap | undefined,
): Readonly<Record<string, unknown>> => {
  const raw = node.parameters.comfyPrompt
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.length > 16 * 1024 * 1024) throw new StudioError('comfy-prompt-too-large', 'ComfyUI API Workflow JSON 超过 16 MiB')
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new StudioError('comfy-prompt-invalid-json', 'ComfyUI API Workflow 不是有效 JSON', 'not_sent', error)
    }
  }
  const graph = structuredClone(objectValue(value)) as Record<string, unknown>
  const entries = Object.entries(graph)
  if (entries.length === 0 || entries.length > 5_000) {
    throw new StudioError('comfy-prompt-required', 'ComfyUI Provider 需要 1–5000 个节点的 API-format Workflow JSON')
  }
  for (const [nodeId, candidate] of entries) {
    const record = objectValue(candidate)
    if (
      typeof record.class_type !== 'string'
      || !record.class_type.trim()
      || typeof record.inputs !== 'object'
      || record.inputs === null
      || Array.isArray(record.inputs)
    ) {
      throw new StudioError('comfy-prompt-invalid-node', `ComfyUI API Workflow 节点 ${nodeId} 缺少 class_type 或 inputs`)
    }
  }
  const bindingNodeId = stringParameter(node, 'comfyPromptNodeId').trim()
  if (bindingNodeId) {
    const bindingNode = objectValue(graph[bindingNodeId]) as Record<string, unknown>
    if (!bindingNode.class_type) throw new StudioError('comfy-prompt-binding-node', `ComfyUI 提示词绑定节点不存在：${bindingNodeId}`)
    const inputName = stringParameter(node, 'comfyPromptInput', 'text').trim() || 'text'
    bindingNode.inputs = { ...objectValue(bindingNode.inputs), [inputName]: prompt }
    graph[bindingNodeId] = bindingNode
  }
  if (!bindings) return graph
  try {
    return applyComfyWorkflowBindings(graph, bindings, bindingValues)
  } catch (error) {
    throw new StudioError('comfy-binding-invalid', error instanceof Error ? error.message : 'ComfyUI 多参数绑定无效', 'not_sent', error)
  }
}

const stringParameter = (node: WorkflowNode, name: string, fallback = ''): string => {
  const value = node.parameters[name]
  return typeof value === 'string' ? value : fallback
}

const integerParameter = (node: WorkflowNode, name: string, fallback: number, minimum: number, maximum: number): number => {
  const value = Number(node.parameters[name] ?? fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new StudioError('invalid-node-parameter', `${node.name} 的参数 ${name} 必须是 ${minimum}–${maximum} 的整数`)
  }
  return value
}

const firstImagePath = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const path = firstImagePath(item)
      if (path) return path
    }
  }
  return undefined
}

const imagePaths = (value: unknown, maximum = 16): readonly string[] => {
  const paths: string[] = []
  const visit = (candidate: unknown): void => {
    if (paths.length >= maximum) return
    if (typeof candidate === 'string') {
      const normalized = candidate.trim()
      if (normalized && !paths.includes(normalized)) paths.push(normalized)
      return
    }
    if (Array.isArray(candidate)) candidate.forEach(visit)
  }
  visit(value)
  return paths
}

const mediaExtension = (mediaType: ProviderImage['mediaType']): string => ({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})[mediaType]

const hasComfyBinding = (bindings: ComfyBindingMap | undefined, kind: 'image' | 'mask'): boolean =>
  (bindings?.[kind]?.length ?? 0) > 0

const comfyUploadReference = (filename: string, subfolder: string): ComfyInputReference => ({
  filename,
  subfolder,
  type: 'input',
})

const comfyUploadFilename = (
  runId: string,
  nodeId: string,
  kind: 'image' | 'mask',
  mediaType: ProviderImage['mediaType'],
): string => `${safeFilename(`studio-${runId.slice(0, 12)}-${nodeId}-${kind}`, `studio-${kind}`)}.${mediaExtension(mediaType)}`

const comfyUploadSubfolder = (runId: string): string => `studio/${safeFilename(runId, 'run').slice(0, 64)}`

const cacheableNodeTypes = new Set(['text', 'prompt_template', 'text_join', 'reroute'])
const remoteImageNodeTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])

const accountProviderRequiredError = (): StudioError => new StudioError(
  'studio-account-provider-required',
  'Studio 远程图像节点只能使用当前登录账号的接入分组，请重新选择账号分组',
  'not_sent',
)

export const isRemoteImageNodeType = (nodeType: string): boolean => remoteImageNodeTypes.has(nodeType)

export const assertStudioAccountProvider = (
  descriptor: Pick<ProviderDescriptor, 'managedBy'> | undefined,
): void => {
  if (descriptor?.managedBy !== 'ai-terminal-account') throw accountProviderRequiredError()
}

const isConfirmedOnlyImageModel = (descriptor: ProviderDescriptor, model: string): boolean => (
  descriptor.kind === 'openai-compatible'
  && descriptor.confirmedOnlyModels?.includes(model) === true
)

const assertConfirmedOnlyImageOperation = (node: WorkflowNode, confirmedOnly: boolean): void => {
  if (!confirmedOnly || node.type === 'image_generation') return
  throw new StudioError(
    'confirmed-image-edit-unavailable',
    '该模型仅通过文生图接口确认，服务端尚未声明图片编辑接口；请求未发送',
    'not_sent',
  )
}

export const buildImageNodeRequest = (
  node: WorkflowNode,
  model: string,
  prompt: string,
  confirmedOnly: boolean,
): ImageGenerationRequest => {
  assertConfirmedOnlyImageOperation(node, confirmedOnly)
  const count = integerParameter(node, 'count', 1, 1, 10)
  if (confirmedOnly) return { model, prompt, count }

  const size = stringParameter(node, 'size').trim()
  const quality = stringParameter(node, 'quality').trim()
  const requestedFormat = node.parameters.responseFormat
  const outputFormat = (['png', 'jpeg', 'webp'] as const).find((value) => value === node.parameters.outputFormat)
  const background = (['auto', 'opaque', 'transparent'] as const).find((value) => value === node.parameters.background)
  const moderation = (['low', 'auto'] as const).find((value) => value === node.parameters.moderation)
  const configuredOutputCompression = Number(node.parameters.outputCompression)
  const configuredExtra = objectValue(node.parameters.extra) as Readonly<Record<string, string | number | boolean>>
  const configuredSeed = Number(node.parameters.seed)
  if (isGptImageModel(model) && Object.keys(configuredExtra).some((key) => key.toLowerCase() === 'seed')) {
    throw new StudioError('gpt-image-seed-unsupported', 'GPT Image 系列不支持 seed；请从节点 extra 中删除 seed')
  }
  return {
    model,
    prompt,
    count,
    extra: {
      ...configuredExtra,
      ...(supportsImageSeed(model) && Number.isSafeInteger(configuredSeed) && configuredSeed >= 0 ? { seed: configuredSeed } : {}),
    },
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    ...(requestedFormat === 'url' || requestedFormat === 'b64_json' ? { responseFormat: requestedFormat } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(outputFormat && Number.isSafeInteger(configuredOutputCompression) && configuredOutputCompression >= 0 && configuredOutputCompression <= 100
      ? { outputCompression: configuredOutputCompression }
      : {}),
    ...(background ? { background } : {}),
    ...(moderation ? { moderation } : {}),
  }
}

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]))
}

const deterministicCacheKeys = (workflow: WorkflowDocument): Readonly<Record<string, string>> => {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]))
  const memo = new Map<string, string | undefined>()
  const visiting = new Set<string>()
  const keyFor = (nodeId: string): string | undefined => {
    if (memo.has(nodeId)) return memo.get(nodeId)
    const node = nodes.get(nodeId)
    if (!node || !cacheableNodeTypes.has(node.type) || visiting.has(nodeId)) {
      memo.set(nodeId, undefined)
      return undefined
    }
    visiting.add(nodeId)
    const incoming = workflow.edges
      .filter((edge) => edge.targetNode === nodeId)
      .sort((left, right) => `${left.targetSocket}\u0000${left.sourceNode}\u0000${left.sourceSocket}`.localeCompare(`${right.targetSocket}\u0000${right.sourceNode}\u0000${right.sourceSocket}`))
    const dependencies: { readonly targetSocket: string; readonly sourceSocket: string; readonly sourceKey: string }[] = []
    for (const edge of incoming) {
      const sourceKey = keyFor(edge.sourceNode)
      if (!sourceKey) {
        visiting.delete(nodeId)
        memo.set(nodeId, undefined)
        return undefined
      }
      dependencies.push({ targetSocket: edge.targetSocket, sourceSocket: edge.sourceSocket, sourceKey })
    }
    visiting.delete(nodeId)
    const key = createHash('sha256').update(JSON.stringify(canonicalValue({
      type: node.type,
      parameters: node.parameters,
      bypassed: node.presentation?.bypassed === true,
      dependencies,
    }))).digest('hex')
    memo.set(nodeId, key)
    return key
  }
  workflow.nodes.forEach((node) => keyFor(node.id))
  return Object.fromEntries([...memo].flatMap(([nodeId, key]) => key ? [[nodeId, key] as const] : []))
}

export class WorkflowRunner {
  readonly #prepared = new Map<string, PreparedRun>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #pending: QueuedRun[] = []
  readonly #persistentItems = new Map<string, PersistentRunQueueItem>()
  readonly #nodeCache = new Map<string, NodeOutputs>()
  #running = false
  #shuttingDown = false

  constructor(
    private readonly projects: ProjectStore,
    private readonly providers: ProviderStore,
    private readonly emit: Emit,
    private readonly ensureEndpointConsent: EnsureEndpointConsent = async () => {
      throw new StudioError(
        'studio-endpoint-consent-unavailable',
        '图片接口确认不可用，已阻止远程请求',
        'not_sent',
      )
    },
  ) {}

  prepare(input: PrepareRunInput): RunPlan {
    if (this.#shuttingDown) throw new StudioError('runtime-shutting-down', 'Studio 运行时正在安全退出')
    this.#prunePlans()
    const overrides = structuredClone(input.overrides ?? {})
    assertNoSecretFields(input.workflow)
    assertNoSecretFields(overrides)
    const flattenedWorkflow = flattenSubgraphs(input.workflow)
    const flattenedIds = new Set(flattenedWorkflow.nodes.map((node) => node.id))
    const invalidOverride = Object.keys(overrides).find((nodeId) => !flattenedIds.has(nodeId))
    if (invalidOverride) {
      throw new StudioError('subgraph-override-unsupported', `不能直接 Pin/Mock 子图外壳：${invalidOverride}；请进入子图选择内部节点`)
    }
    for (const targetNodeId of input.targetNodeIds ?? []) {
      if (flattenedIds.has(targetNodeId)) continue
      const original = input.workflow.nodes.find((node) => node.id === targetNodeId)
      if (original?.type.startsWith('subgraph:')) {
        throw new StudioError('subgraph-target-unsupported', `不能直接只运行子图外壳：${targetNodeId}；请进入子图选择内部节点`)
      }
      throw new StudioError('target-node-not-found', `目标节点不存在：${targetNodeId}`)
    }
    const flattenedTargets = input.targetNodeIds
    const cacheKeys = deterministicCacheKeys(flattenedWorkflow)
    const cachedOutputs: Record<string, NodeOutputs> = {}
    for (const [nodeId, key] of Object.entries(cacheKeys)) {
      const cached = this.#readNodeCache(key)
      if (cached) cachedOutputs[nodeId] = cached
    }
    const plan = createExecutionPlan(flattenedWorkflow, flattenedTargets, overrides, new Set(Object.keys(cachedOutputs)))
    this.#prepared.set(plan.id, {
      plan,
      projectPath: path.resolve(input.projectPath),
      workflowHash: workflowHash(input.workflow),
      executionInputHash: executionInputHash(input.targetNodeIds, input.overrides),
      sourceWorkflow: structuredClone(input.workflow),
      targetNodeIds: [...(input.targetNodeIds ?? [])],
      flattenedWorkflow,
      overrides,
      cacheKeys,
      cachedOutputs,
      expiresAt: Date.now() + 15 * 60_000,
    })
    while (this.#prepared.size > 256) {
      const oldest = this.#prepared.keys().next().value as string | undefined
      if (!oldest) break
      this.#prepared.delete(oldest)
    }
    return plan
  }

  async start(input: StartRunInput): Promise<RunResult> {
    if (this.#shuttingDown) throw new StudioError('runtime-shutting-down', 'Studio 运行时正在安全退出')
    const prepared = this.#consumePrepared(input)
    return this.#enqueuePreparedRun({
      runId: input.planId,
      prepared,
      workflow: input.workflow,
      targetNodeIds: input.targetNodeIds,
      controller: new AbortController(),
    })
  }

  async resumePersistent(
    projectPath: string,
    itemId: string,
    consentedWorkflow: WorkflowDocument,
  ): Promise<RunResult> {
    if (this.#shuttingDown) throw new StudioError('runtime-shutting-down', 'Studio 运行时正在安全退出')
    const consentedWorkflowHash = workflowHash(consentedWorkflow)
    if (this.#controllers.has(itemId)) {
      throw new StudioError('run-already-active', '该持久任务已在恢复或执行')
    }
    const controller = new AbortController()
    this.#controllers.set(itemId, controller)
    try {
      const resolvedProjectPath = path.resolve(projectPath)
      const item = (await this.projects.listQueuedRuns(resolvedProjectPath)).find((candidate) => candidate.id === itemId)
      if (!item) throw new StudioError('persistent-run-not-found', `持久运行项不存在：${itemId}`)
      if (workflowHash(item.workflow) !== consentedWorkflowHash) {
        throw new StudioError(
          'persistent-run-consent-stale',
          '持久任务在账号分组接口确认后已发生变化，请重新确认后再恢复',
          'not_sent',
        )
      }
      if (item.status === 'running') {
        throw new StudioError('persistent-run-already-running', '该持久任务仍标记为运行中，已阻止重复派发')
      }
      const dispatchState = item.dispatchState ?? (item.status === 'pending' ? 'not_sent' : 'billing_unknown')
      if (dispatchState !== 'not_sent') {
        throw new StudioError(
          'persistent-run-unsafe-retry',
          '该任务可能已发送至 Provider，为避免重复扣费已禁止恢复；请核对 Provider 记录后新建运行',
          dispatchState,
        )
      }
      const prepareInput: PrepareRunInput = {
        projectPath: resolvedProjectPath,
        workflow: item.workflow,
        targetNodeIds: item.targetNodeIds,
        overrides: item.overrides,
      }
      const plan = this.prepare(prepareInput)
      const startInput: StartRunInput = { ...prepareInput, planId: plan.id }
      const prepared = this.#consumePrepared(startInput)
      return await this.#enqueuePreparedRun({
        runId: item.id,
        prepared,
        workflow: item.workflow,
        targetNodeIds: item.targetNodeIds,
        controller,
        existingItem: item,
      })
    } catch (error) {
      if (this.#controllers.get(itemId) === controller) this.#controllers.delete(itemId)
      this.#persistentItems.delete(itemId)
      throw error
    }
  }

  #consumePrepared(input: StartRunInput): PreparedRun {
    this.#prunePlans()
    assertNoSecretFields(input.workflow)
    assertNoSecretFields(input.overrides ?? {})
    const prepared = this.#prepared.get(input.planId)
    if (!prepared || prepared.expiresAt < Date.now()) throw new StudioError('run-plan-expired', '执行计划已过期，请重新预检')
    if (prepared.projectPath !== path.resolve(input.projectPath)
      || prepared.workflowHash !== workflowHash(input.workflow)
      || prepared.executionInputHash !== executionInputHash(input.targetNodeIds, input.overrides)) {
      throw new StudioError('run-plan-changed', '项目、工作流、目标节点或 Pin/Mock 已在预检后发生变化，请重新预检')
    }
    this.#prepared.delete(input.planId)
    return prepared
  }

  async #enqueuePreparedRun(input: {
    readonly runId: string
    readonly prepared: PreparedRun
    readonly workflow: WorkflowDocument
    readonly targetNodeIds: readonly string[] | undefined
    readonly controller: AbortController
    readonly existingItem?: PersistentRunQueueItem
  }): Promise<RunResult> {
    await this.#assertManagedImageProviders(input.prepared.flattenedWorkflow)
    // The renderer already owns the one-shot plan id before awaiting startRun,
    // so using it as the run handle makes cancellation possible immediately.
    const runId = input.runId
    const controller = input.controller
    const prepared = input.prepared
    const queuedAt = new Date().toISOString()
    const activeController = this.#controllers.get(runId)
    if (activeController && activeController !== controller) {
      throw new StudioError('run-already-active', '该运行已在恢复或执行')
    }
    this.#controllers.set(runId, controller)
    let persistentItem: PersistentRunQueueItem
    try {
      const project = await this.projects.summary(prepared.projectPath)
      persistentItem = await this.projects.upsertQueuedRun(prepared.projectPath, {
        schemaVersion: 1,
        id: runId,
        projectId: project.id,
        workflowId: input.workflow.id,
        status: 'pending',
        priority: input.existingItem?.priority ?? 0,
        createdAt: input.existingItem?.createdAt ?? queuedAt,
        updatedAt: queuedAt,
        workflow: structuredClone(input.workflow),
        targetNodeIds: [...(input.targetNodeIds ?? [])],
        overrides: structuredClone(prepared.overrides),
        attempt: input.existingItem?.attempt ?? 0,
        dispatchState: 'not_sent',
        remoteJobs: [],
      })
      this.#persistentItems.set(runId, persistentItem)
    } catch (error) {
      this.#controllers.delete(runId)
      this.#persistentItems.delete(runId)
      throw error
    }
    if (controller.signal.aborted) {
      try { await this.projects.removeQueuedRun(prepared.projectPath, runId) } finally {
        this.#controllers.delete(runId)
        this.#persistentItems.delete(runId)
      }
      const cancelled = cancelledResult(runId)
      this.emitSafe({ type: 'run-finished', result: cancelled })
      return cancelled
    }
    this.emitSafe({ type: 'run-queued', runId, workflowId: input.workflow.id, createdAt: queuedAt })
    const result = new Promise<RunResult>((resolve) => {
      this.#pending.push({
        id: runId,
        controller,
        queuedAt,
        projectPath: prepared.projectPath,
        item: persistentItem,
        resolve,
        execute: (runQueuedAt, dequeuedAt) => this.#execute(runId, prepared, prepared.flattenedWorkflow, controller.signal, runQueuedAt, dequeuedAt),
      })
    })
    void this.#pump()
    return result
  }

  async #assertManagedImageProviders(workflow: WorkflowDocument): Promise<void> {
    const providerIds = new Set<string>()
    for (const node of workflow.nodes) {
      if (!isRemoteImageNodeType(node.type)) continue
      const providerId = stringParameter(node, 'providerId').trim()
      if (!providerId) assertStudioAccountProvider(undefined)
      providerIds.add(providerId)
    }
    await Promise.all([...providerIds].map(async (providerId) => {
      const descriptor = await this.providers.descriptor(providerId)
      assertStudioAccountProvider(descriptor)
    }))
  }

  cancel(runId: string): boolean {
    const controller = this.#controllers.get(runId)
    if (!controller) return false
    controller.abort(new Error('user-cancelled'))
    this.emitSafe({ type: 'run-cancel-requested', runId, createdAt: new Date().toISOString() })
    const pendingIndex = this.#pending.findIndex((job) => job.id === runId)
    if (pendingIndex >= 0) {
      const [job] = this.#pending.splice(pendingIndex, 1)
      if (job) {
        void (async () => {
          let cleanupWarning: StudioError | undefined
          try {
            await this.projects.removeQueuedRun(job.projectPath, job.id)
          } catch (error) {
            cleanupWarning = asStudioError(error, 'run-queue-remove-failed')
          } finally {
            this.#controllers.delete(job.id)
            this.#persistentItems.delete(job.id)
          }
          const result = cancelledResult(job.id)
          this.emitSafe({ type: 'run-finished', result })
          if (cleanupWarning) {
            this.emitSafe({ type: 'persistent-queue-warning', runId: job.id, workflowId: job.item.workflowId, message: cleanupWarning.message })
          }
          job.resolve(result)
        })()
      }
    }
    return true
  }

  async shutdown(): Promise<void> {
    if (!this.#shuttingDown) {
      this.#shuttingDown = true
      this.#prepared.clear()
      for (const runId of [...this.#controllers.keys()]) this.cancel(runId)
    }
    const deadline = Date.now() + 4_500
    while ((this.#running || this.#controllers.size > 0) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }

  async #pump(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#pending.length > 0) {
        const job = this.#pending.shift()
        if (!job) continue
        let result: RunResult
        let enteredRunningState = false
        try {
          const dequeuedAt = new Date().toISOString()
          const runningItem = await this.projects.upsertQueuedRun(job.projectPath, {
            ...job.item,
            status: 'running',
            attempt: job.item.attempt + 1,
            updatedAt: dequeuedAt,
          })
          this.#persistentItems.set(job.id, runningItem)
          enteredRunningState = true
          result = await job.execute(job.queuedAt, dequeuedAt)
        } catch (error) {
          const studioError = asStudioError(error, 'run-queue-failed')
          result = {
            runId: job.id,
            status: job.controller.signal.aborted ? 'cancelled' : 'failed',
            dispatchState: studioError.dispatchState,
            outputs: {},
            error: {
              code: studioError.code,
              message: studioError.message,
              billingUnknown: studioError.dispatchState === 'billing_unknown',
              dispatchState: studioError.dispatchState,
            },
          }
          this.emitSafe({ type: 'run-finished', result })
        }
        if (enteredRunningState) {
          try {
            await this.projects.removeQueuedRun(job.projectPath, job.id)
          } catch (error) {
            const studioError = asStudioError(error, 'run-queue-remove-failed')
            this.emitSafe({ type: 'persistent-queue-warning', runId: job.id, workflowId: job.item.workflowId, message: studioError.message })
          }
        }
        this.#controllers.delete(job.id)
        this.#persistentItems.delete(job.id)
        job.resolve(result)
      }
    } finally {
      this.#running = false
    }
  }

  async #execute(
    runId: string,
    prepared: PreparedRun,
    workflow: WorkflowDocument,
    signal: AbortSignal,
    queuedAt: string,
    dequeuedAt: string,
  ): Promise<RunResult> {
    const runCreatedAt = queuedAt
    const evidence = this.#createRunRecordEvidence(prepared)
    const queueEvent: ExecutionTimelineEvent = {
      id: crypto.randomUUID(),
      runId,
      nodeId: '$run',
      phase: 'queue',
      startedAt: queuedAt,
      finishedAt: dequeuedAt,
      durationMs: Math.max(0, Date.parse(dequeuedAt) - Date.parse(queuedAt)),
    }
    const timeline: ExecutionTimelineEvent[] = [queueEvent]
    this.emitSafe({ type: 'timeline', workflowId: workflow.id, event: queueEvent })
    const project = await this.projects.summary(prepared.projectPath)
    const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]))
    const outputs = new Map<string, NodeOutputs>()
    const failedNodes = new Set<string>()
    let firstFailure: StudioError | undefined
    let runDispatchState: RunDispatchState = 'not_sent'
    const updateDispatchState = (state: RunDispatchState): void => {
      const next = strongestDispatchState(runDispatchState, state)
      if (next === runDispatchState) return
      runDispatchState = next
      this.emitSafe({ type: 'run-dispatch', runId, workflowId: workflow.id, dispatchState: next, createdAt: new Date().toISOString() })
    }
    this.emitSafe({ type: 'run-started', runId, workflowId: workflow.id, createdAt: dequeuedAt })

    try {
      if (signal.aborted) throw new StudioError('run-cancelled', '运行已取消')
      const planNodeCount = Math.max(1, prepared.plan.nodes.length)
      for (const [planIndex, planned] of prepared.plan.nodes.entries()) {
        if (signal.aborted) throw new StudioError('run-cancelled', '运行已取消')
        const node = nodeById.get(planned.nodeId)
        if (!node) throw new StudioError('node-not-found', `执行计划引用了不存在的节点：${planned.nodeId}`)
        if (planned.action === 'pin' || planned.action === 'mock') {
          outputs.set(node.id, materializeOverrideOutputs(node, prepared.overrides[node.id]?.value))
          this.emitSafe({ type: 'run-progress', runId, workflowId: workflow.id, nodeId: node.id, nodeStatus: 'succeeded', overallProgress: (planIndex + 1) / planNodeCount, message: `${planned.action === 'pin' ? 'Pin' : 'Mock'}：${node.name}` })
          continue
        }
        if (planned.action === 'cache') {
          const cached = prepared.cachedOutputs[node.id]
          if (cached) {
            outputs.set(node.id, structuredClone(cached))
            const cacheEvent = this.#startTimeline(timeline, runId, node.id, 'queue')
            cacheEvent.cacheHit = true
            this.#finishTimeline(cacheEvent)
            this.emitSafe({ type: 'timeline', workflowId: workflow.id, event: cacheEvent })
            this.emitSafe({ type: 'run-progress', runId, workflowId: workflow.id, overallProgress: (planIndex + 1) / planNodeCount, message: `缓存命中：${node.name}` })
            continue
          }
        }
        let task = this.#newTask(runId, project.id, workflow.id, node.id)
        await this.projects.upsertTask(prepared.projectPath, task)
        const failedDependency = workflow.edges
          .filter((edge) => edge.targetNode === node.id)
          .map((edge) => edge.sourceNode)
          .find((sourceId) => failedNodes.has(sourceId))
        if (failedDependency) {
          failedNodes.add(node.id)
          await this.#updateTask(prepared.projectPath, task, 'failed', 1, `因上游节点 ${failedDependency} 失败而跳过`, (planIndex + 1) / planNodeCount)
          continue
        }
        const queueEvent = this.#startTimeline(timeline, runId, node.id, 'queue')
        this.#finishTimeline(queueEvent)
        this.emitSafe({ type: 'timeline', workflowId: workflow.id, event: queueEvent })
        task = await this.#updateTask(prepared.projectPath, task, 'running', 0.05, '正在执行', (planIndex + 0.05) / planNodeCount)
        try {
          const inputs = this.#inputs(workflow, node, outputs)
          const value = await this.#executeNode(runId, prepared.projectPath, project.id, workflow.id, node, inputs, timeline, signal, async () => {
            if (task.dispatchState === 'sent' || task.dispatchState === 'billing_unknown') return
            await this.#markPersistentDispatch(prepared.projectPath, runId, 'sent')
            task = await this.#updateTask(
              prepared.projectPath,
              task,
              'running',
              Math.max(task.progress, 0.1),
              '请求已提交到 Provider 传输层',
              (planIndex + 0.1) / planNodeCount,
              'sent',
            )
            updateDispatchState('sent')
          }, evidence)
          outputs.set(node.id, value)
          if (planned.action === 'execute' && defaultRegistry.get(node.type).cachePolicy === 'side-effecting') {
            updateDispatchState('sent')
            if (task.dispatchState === 'not_sent') {
              task = await this.#updateTask(prepared.projectPath, task, 'running', Math.max(task.progress, 0.1), 'Provider 已返回结果', (planIndex + 0.9) / planNodeCount, 'sent')
            }
          }
          const cacheKey = prepared.cacheKeys[node.id]
          if (cacheKey) this.#writeNodeCache(cacheKey, value)
          task = await this.#updateTask(prepared.projectPath, task, 'succeeded', 1, '完成', (planIndex + 1) / planNodeCount)
        } catch (error) {
          const studioError = asStudioError(error, 'node-execution-failed')
          updateDispatchState(studioError.dispatchState)
          const status = signal.aborted ? 'cancelled' : studioError.dispatchState === 'billing_unknown' ? 'billing-unknown' : 'failed'
          task = await this.#updateTask(
            prepared.projectPath,
            task,
            status,
            1,
            studioError.message,
            (planIndex + 1) / planNodeCount,
            strongestDispatchState(task.dispatchState, studioError.dispatchState),
          )
          if (signal.aborted) throw studioError
          failedNodes.add(node.id)
          if (!firstFailure || studioError.dispatchState === 'billing_unknown') firstFailure = studioError
        }
      }
      if (firstFailure) throw firstFailure
      const publicOutputs = Object.fromEntries(outputs)
      await this.#recordRunSafely(prepared.projectPath, runId, workflow.id, 'succeeded', runDispatchState, runCreatedAt, timeline, evidence)
      const result: RunResult = { runId, status: 'succeeded', dispatchState: runDispatchState, outputs: publicOutputs }
      this.emitSafe({ type: 'run-finished', result })
      return result
    } catch (error) {
      const studioError = asStudioError(error, 'run-failed')
      const cancelled = signal.aborted
      const dispatchState = strongestDispatchState(runDispatchState, studioError.dispatchState)
      const result: RunResult = {
        runId,
        status: cancelled ? 'cancelled' : 'failed',
        dispatchState,
        outputs: Object.fromEntries(outputs),
        error: {
          code: studioError.code,
          message: studioError.message,
          billingUnknown: dispatchState === 'billing_unknown',
          dispatchState,
        },
      }
      await this.#recordRunSafely(prepared.projectPath, runId, workflow.id, result.status, dispatchState, runCreatedAt, timeline, evidence, result.error)
      this.emitSafe({ type: 'run-finished', result })
      return result
    }
  }

  #inputs(workflow: WorkflowDocument, node: WorkflowNode, outputs: ReadonlyMap<string, NodeOutputs>): NodeOutputs {
    const values: Record<string, unknown> = {}
    for (const edge of workflow.edges.filter((item) => item.targetNode === node.id)) {
      const output = outputs.get(edge.sourceNode)?.[edge.sourceSocket]
      if (output === undefined) continue
      const current = values[edge.targetSocket]
      values[edge.targetSocket] = current === undefined ? output : [...(Array.isArray(current) ? current : [current]), output]
    }
    return values
  }

  async #executeNode(
    runId: string,
    projectPath: string,
    projectId: string,
    workflowId: string,
    node: WorkflowNode,
    inputs: NodeOutputs,
    timeline: ExecutionTimelineEvent[],
    signal: AbortSignal,
    onDispatch: () => Promise<void>,
    evidence: RunRecordEvidence,
  ): Promise<NodeOutputs> {
    if (node.presentation?.bypassed) {
      const route = defaultRegistry.bypassRoute(node.type)
      if (!route) throw new StudioError('unsafe-bypass', `节点 ${node.name} 不能安全 Bypass`)
      return { [route[1]]: inputs[route[0]] }
    }
    switch (node.type) {
      case 'text': return { text: stringParameter(node, 'text') }
      case 'prompt_template': {
        const input = String(inputs.input ?? '')
        return { text: stringParameter(node, 'template', '{input}').replaceAll('{input}', input) }
      }
      case 'text_join': return { text: [inputs.a, inputs.b].filter((value) => value !== undefined && value !== '').join(stringParameter(node, 'separator', ', ')) }
      case 'reroute': return { output: inputs.input }
      case 'project_image': {
        const relativePath = stringParameter(node, 'path')
        await loadLocalImage(await this.projects.resolveExistingAsset(projectPath, relativePath), 512 * 1024 * 1024)
        return { image: relativePath, images: [relativePath] }
      }
      case 'image_preview': return { images: inputs.images }
      case 'frame':
      case 'note': return {}
      case 'image_generation':
      case 'image_edit':
      case 'image_inpaint':
      case 'image_outpaint':
        return this.#executeImageNode(runId, projectPath, projectId, workflowId, node, inputs, timeline, signal, onDispatch, evidence)
      default: throw new StudioError('unsupported-node', `主进程尚不支持执行节点：${node.type}`)
    }
  }

  async #executeImageNode(
    runId: string,
    projectPath: string,
    projectId: string,
    workflowId: string,
    node: WorkflowNode,
    inputs: NodeOutputs,
    timeline: ExecutionTimelineEvent[],
    signal: AbortSignal,
    onDispatch: () => Promise<void>,
    evidence: RunRecordEvidence,
  ): Promise<NodeOutputs> {
    const providerId = stringParameter(node, 'providerId')
    const descriptor = await this.providers.descriptor(providerId)
    assertStudioAccountProvider(descriptor)
    const prompt = String(inputs.prompt ?? stringParameter(node, 'prompt')).trim()
    if (!prompt) throw new StudioError('prompt-required', `${node.name} 缺少提示词`)
    const configuredModel = stringParameter(node, 'model', descriptor.defaultModel).trim()
    const model = configuredModel || descriptor.defaultModel.trim()
    assertConfirmedOnlyImageOperation(node, isConfirmedOnlyImageModel(descriptor, model))
    const credentials = await this.providers.credentials(providerId, model)
    const request = buildImageNodeRequest(
      node,
      model,
      prompt,
      isConfirmedOnlyImageModel(credentials.descriptor, model),
    )
    evidence.providerBindings.set(node.id, {
      nodeId: node.id,
      providerId,
      providerKind: credentials.descriptor.kind,
      model,
    })
    const requestedCandidateGroupId = stringParameter(node, 'candidateGroupId').trim()
    if (requestedCandidateGroupId && !/^[a-zA-Z0-9_-]{1,160}$/.test(requestedCandidateGroupId)) {
      throw new StudioError('candidate-group-id-invalid', '候选组 ID 只能包含 1–160 个字母、数字、下划线或连字符')
    }
    const configuredSeed = Number(node.parameters.seed)
    const size = request.size?.trim() ?? ''
    const providerEvent = this.#startTimeline(timeline, runId, node.id, 'provider')
    const phaseEvents = new Map<string, ExecutionTimelineEvent>()
    const onPhase: ProviderRequestContext['onPhase'] = (phase, state) => {
        if (state === 'start') {
          const event = this.#startTimeline(timeline, runId, node.id, phase)
          phaseEvents.set(phase, event)
          this.emitSafe({ type: 'timeline', workflowId, event })
        } else {
          const event = phaseEvents.get(phase)
          if (event) {
            this.#finishTimeline(event)
            this.emitSafe({ type: 'timeline', workflowId, event })
          }
        }
      }
    let images: readonly ProviderImage[]
    let parentAsset: GeneratedAsset | undefined
    try {
      if (!('apiKey' in credentials)) {
        if (node.type !== 'image_generation') {
          throw new StudioError('comfy-edit-unsupported', '远程 ComfyUI Provider 当前只接受 image_generation；编辑/重绘/扩图请在 Comfy API Workflow 内完成')
        }
        const bindings = comfyBindingMap(node)
        const bindsImage = hasComfyBinding(bindings, 'image')
        const bindsMask = hasComfyBinding(bindings, 'mask')
        if (inputs.referenceImages !== undefined && !bindsImage && !bindsMask) {
          throw new StudioError('comfy-reference-images-unsupported', 'ComfyUI 不会静默上传参考图；请在远端 Workflow 中配置 LoadImage 或显式资产适配器')
        }
        const sizeMatch = /^(\d+)x(\d+)$/.exec(size)
        const primitiveBindings: ComfyBindingValues = {
          text: prompt,
          model,
          ...(Number.isSafeInteger(configuredSeed) && configuredSeed >= 0 ? { seed: configuredSeed } : {}),
          ...(sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : {}),
        }
        const validationBindings: ComfyBindingValues = {
          ...primitiveBindings,
          ...(bindsImage ? { image: comfyUploadReference('source.png', 'studio/validation') } : {}),
          ...(bindsMask ? { mask: comfyUploadReference('mask.png', 'studio/validation') } : {}),
        }
        let promptGraph = comfyPromptGraph(node, prompt, validationBindings, bindings)
        const sourcePath = firstImagePath(inputs.image)
          ?? firstImagePath(inputs.images)
          ?? firstImagePath(inputs.referenceImages)
        const maskPath = firstImagePath(inputs.mask) ?? (stringParameter(node, 'maskPath') || undefined)
        if ((bindsImage || bindsMask) && !sourcePath) {
          throw new StudioError('comfy-source-image-required', 'ComfyUI 图片/蒙版绑定需要连接一张项目内源图片')
        }
        if (bindsMask && !maskPath) {
          throw new StudioError('comfy-mask-required', 'ComfyUI mask 绑定需要连接蒙版或配置项目内蒙版路径')
        }
        const source = (bindsImage || bindsMask) && sourcePath
          ? await loadLocalImage(await this.projects.resolveExistingAsset(projectPath, sourcePath), credentials.descriptor.maxImageBytes)
          : undefined
        const mask = bindsMask && maskPath
          ? await loadLocalImage(await this.projects.resolveExistingAsset(projectPath, maskPath), credentials.descriptor.maxImageBytes)
          : undefined
        if (signal.aborted) throw new StudioError('comfy-cancelled', 'ComfyUI 图片上传已取消')
        const adapter = new ComfyUiAdapter({
          baseUrl: credentials.descriptor.baseUrl,
          timeoutMs: credentials.descriptor.timeoutMs,
          maxImageBytes: credentials.descriptor.maxImageBytes,
          proxyMode: credentials.descriptor.proxyMode,
          signal,
          onPhase,
          onDispatch,
          onJob: async (job) => {
            const remoteJob: RunRecordRemoteJob = {
              nodeId: node.id,
              providerId,
              providerKind: 'comfyui',
              promptIdHash: createHash('sha256').update(job.promptId).digest('hex'),
              promptIdSuffix: job.promptId.slice(-4),
              ...(job.queueNumber === undefined ? {} : { queueNumber: job.queueNumber }),
            }
            if (!evidence.remoteJobs.some((candidate) => candidate.nodeId === remoteJob.nodeId && candidate.promptIdHash === remoteJob.promptIdHash)) {
              evidence.remoteJobs.push(remoteJob)
            }
            await this.#markPersistentRemoteJob(projectPath, runId, remoteJob)
            this.emitSafe({ type: 'comfy-job', runId, workflowId, nodeId: node.id, job })
          },
          onProgress: (event) => this.emitSafe({ type: 'comfy-progress', runId, workflowId, nodeId: node.id, event }),
        })
        let imageReference: ComfyInputReference | undefined
        let maskReference: ComfyInputReference | undefined
        const uploadSubfolder = comfyUploadSubfolder(runId)
        if (bindsImage || bindsMask) {
          if (!source) throw new StudioError('comfy-source-image-required', 'ComfyUI 图片/蒙版绑定缺少源图片')
          const uploaded = await adapter.uploadImage({
            bytes: source.bytes,
            mediaType: source.mediaType,
            filename: comfyUploadFilename(runId, node.id, 'image', source.mediaType),
            subfolder: uploadSubfolder,
          })
          imageReference = comfyUploadReference(uploaded.filename, uploaded.subfolder)
        }
        if (bindsMask) {
          if (!mask || !imageReference) throw new StudioError('comfy-mask-required', 'ComfyUI mask 绑定缺少蒙版或源图片')
          const uploaded = await adapter.uploadMask({
            bytes: mask.bytes,
            mediaType: mask.mediaType,
            filename: comfyUploadFilename(runId, node.id, 'mask', mask.mediaType),
            subfolder: uploadSubfolder,
            original: imageReference,
          })
          maskReference = comfyUploadReference(uploaded.filename, uploaded.subfolder)
        }
        if (imageReference || maskReference) {
          promptGraph = comfyPromptGraph(node, prompt, {
            ...primitiveBindings,
            ...(bindsImage && imageReference ? { image: imageReference } : {}),
            ...(bindsMask && maskReference ? { mask: maskReference } : {}),
          }, bindings)
        }
        const execution = await adapter.executeTracked(promptGraph, request.count)
        images = execution.images
      } else {
        const context: ProviderRequestContext = {
          descriptor: credentials.descriptor,
          apiKey: credentials.apiKey,
          ensureEndpointConsent: this.ensureEndpointConsent,
          signal,
          onPhase,
          onDispatch,
        }
        if (node.type === 'image_generation') {
          const referencePaths = imagePaths(inputs.referenceImages)
          if (referencePaths.length === 0) {
            images = await generateImages(context, request)
          } else {
            const assets = await this.projects.listAssets(projectPath)
            parentAsset = assets.find((asset) => asset.relativePath === referencePaths[0])
            const references = await Promise.all(referencePaths.map(async (relativePath) => (
              loadLocalImage(
                await this.projects.resolveExistingAsset(projectPath, relativePath),
                credentials.descriptor.maxImageBytes,
              )
            )))
            const editRequest: ImageEditRequest = {
              ...request,
              sourceAssetPath: referencePaths[0]!,
              operation: 'edit',
              ...(supportsImageInputFidelity(request.model) ? { inputFidelity: 'high' as const } : {}),
            }
            images = await editImages(context, editRequest, references)
          }
        } else {
          const operation: ImageEditRequest['operation'] = node.type === 'image_edit'
            ? 'edit'
            : node.type === 'image_inpaint'
              ? 'inpaint'
              : 'outpaint'
          const sourcePath = firstImagePath(inputs.image) ?? firstImagePath(inputs.images)
          if (!sourcePath) throw new StudioError('source-image-required', `${node.name} 缺少源图片`)
          const maskPath = firstImagePath(inputs.mask) ?? (stringParameter(node, 'maskPath') || undefined)
          parentAsset = (await this.projects.listAssets(projectPath)).find((asset) => asset.relativePath === sourcePath)
          const source = await loadLocalImage(await this.projects.resolveExistingAsset(projectPath, sourcePath), credentials.descriptor.maxImageBytes)
          const mask = maskPath ? await loadLocalImage(await this.projects.resolveExistingAsset(projectPath, maskPath), credentials.descriptor.maxImageBytes) : undefined
          const editRequest: ImageEditRequest = {
            ...request,
            sourceAssetPath: sourcePath,
            operation,
            ...(supportsImageInputFidelity(request.model)
              ? { inputFidelity: node.parameters.inputFidelity === 'low' ? 'low' as const : 'high' as const }
              : {}),
            ...(maskPath ? { maskAssetPath: maskPath } : {}),
          }
          images = await editImages(context, editRequest, source, mask)
        }
      }
    } catch (error) {
      providerEvent.errorCode = asStudioError(error).code
      throw error
    } finally {
      this.#finishTimeline(providerEvent)
      this.emitSafe({ type: 'timeline', workflowId, event: providerEvent })
    }

    const persistEvent = this.#startTimeline(timeline, runId, node.id, 'persist')
    const writtenFiles: string[] = []
    try {
      const now = new Date().toISOString()
      const candidateGroupId = (parentAsset?.candidateGroupId ?? requestedCandidateGroupId) || crypto.randomUUID()
      const assets: GeneratedAsset[] = []
      for (const [index, image] of images.entries()) {
        const dimensions = imageDimensions(image.bytes, image.mediaType)
        const extension = mediaExtension(image.mediaType)
        const fileName = safeFilename(`${Date.now()}-${node.name}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`)
        const relativePath = `outputs/${fileName}.${extension}`
        const outputPath = await this.projects.resolveOutputAsset(projectPath, relativePath)
        await atomicWriteFile(outputPath, image.bytes)
        writtenFiles.push(outputPath)
        assets.push({
          id: crypto.randomUUID(), projectId, workflowId, nodeId: node.id, relativePath,
          prompt, providerId, model: request.model, createdAt: now, favorite: false,
          ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
          decision: 'pending', candidateGroupId,
          ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
          ...(parentAsset ? { parentAssetId: parentAsset.id } : {}),
          operation: node.type === 'image_generation' ? 'generate' : node.type === 'image_edit' ? 'edit' : node.type === 'image_inpaint' ? 'inpaint' : 'outpaint',
          tags: [],
        })
      }
      await this.projects.appendAssets(projectPath, assets)
      const relativePaths = assets.map((asset) => asset.relativePath)
      return { image: relativePaths[0], images: relativePaths }
    } catch (error) {
      await Promise.all(writtenFiles.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)))
      throw new StudioError('persist-failed', '远端图片已生成，但本地落盘或作品登记失败', 'sent', error)
    } finally {
      this.#finishTimeline(persistEvent)
      this.emitSafe({ type: 'timeline', workflowId, event: persistEvent })
    }
  }

  #newTask(runId: string, projectId: string, workflowId: string, nodeId: string): TaskRecord {
    const now = new Date().toISOString()
    return { id: crypto.randomUUID(), runId, projectId, workflowId, nodeId, status: 'pending', dispatchState: 'not_sent', progress: 0, message: '等待执行', createdAt: now, updatedAt: now }
  }

  async #updateTask(
    projectPath: string,
    task: TaskRecord,
    status: TaskRecord['status'],
    progress: number,
    message: string,
    overallProgress: number,
    dispatchState?: RunDispatchState,
  ): Promise<TaskRecord> {
    const updated: TaskRecord = {
      ...task,
      status,
      progress,
      message,
      ...(dispatchState ? { dispatchState } : {}),
      updatedAt: new Date().toISOString(),
    }
    await this.projects.upsertTask(projectPath, updated)
    this.emitSafe({ type: 'task', runId: task.runId, overallProgress, task: updated })
    return updated
  }

  #startTimeline(
    target: ExecutionTimelineEvent[],
    runId: string,
    nodeId: string,
    phase: ExecutionTimelineEvent['phase'],
  ): MutableTimelineEvent {
    const event = { id: crypto.randomUUID(), runId, nodeId, phase, startedAt: new Date().toISOString() }
    target.push(event)
    return event
  }

  #createRunRecordEvidence(prepared: PreparedRun): RunRecordEvidence {
    const workflowSnapshot = redactPersistentValue(structuredClone(prepared.sourceWorkflow)) as WorkflowDocument
    const overrides = redactPersistentValue(structuredClone(prepared.overrides)) as Readonly<Record<string, NodeOverride>>
    assertNoSecretFields(workflowSnapshot)
    assertNoSecretFields(overrides)
    const plan: RunRecordPlan = {
      taskCount: prepared.plan.taskCount,
      remoteTaskCount: prepared.plan.remoteTaskCount,
      ...(prepared.plan.estimatedCost === undefined ? {} : { estimatedCost: prepared.plan.estimatedCost }),
      nodes: structuredClone(prepared.plan.nodes),
    }
    const nodeById = new Map(prepared.flattenedWorkflow.nodes.map((node) => [node.id, node]))
    const providerBindings = new Map<string, RunRecordProviderBinding>()
    for (const planned of prepared.plan.nodes) {
      const node = nodeById.get(planned.nodeId)
      if (!node || !isRemoteImageNodeType(node.type)) continue
      providerBindings.set(node.id, {
        nodeId: node.id,
        providerId: stringParameter(node, 'providerId'),
        model: stringParameter(node, 'model'),
      })
    }
    const matrix = recordMatrixMetadata(workflowSnapshot)
    return {
      workflowSnapshot,
      workflowHash: createHash('sha256').update(canonicalJson(workflowSnapshot)).digest('hex'),
      targetNodeIds: [...prepared.targetNodeIds],
      overrides,
      plan,
      providerBindings,
      ...(matrix ? { matrix } : {}),
      remoteJobs: [],
    }
  }

  async #markPersistentDispatch(projectPath: string, runId: string, dispatchState: RunDispatchState): Promise<void> {
    const current = this.#persistentItems.get(runId)
    if (!current) throw new StudioError('run-queue-item-missing', '持久运行队列项丢失，已阻止远程派发')
    const updated = await this.projects.upsertQueuedRun(projectPath, {
      ...current,
      dispatchState: strongestDispatchState(current.dispatchState, dispatchState),
      updatedAt: new Date().toISOString(),
    })
    this.#persistentItems.set(runId, updated)
  }

  async #markPersistentRemoteJob(projectPath: string, runId: string, remoteJob: RunRecordRemoteJob): Promise<void> {
    const current = this.#persistentItems.get(runId)
    if (!current) throw new StudioError('run-queue-item-missing', '持久运行队列项丢失，ComfyUI 任务标识无法写入恢复日志', 'billing_unknown')
    const remoteJobs = [...(current.remoteJobs ?? [])]
    if (!remoteJobs.some((candidate) => candidate.nodeId === remoteJob.nodeId && candidate.promptIdHash === remoteJob.promptIdHash)) {
      remoteJobs.push(remoteJob)
    }
    try {
      const updated = await this.projects.upsertQueuedRun(projectPath, {
        ...current,
        dispatchState: strongestDispatchState(current.dispatchState, 'sent'),
        remoteJobs,
        updatedAt: new Date().toISOString(),
      })
      this.#persistentItems.set(runId, updated)
    } catch (error) {
      throw new StudioError('run-remote-job-journal-failed', 'ComfyUI 已接收任务，但本地无法持久化其脱敏标识；请人工核对远程队列', 'billing_unknown', error)
    }
  }

  #finishTimeline(event: { startedAt: string; finishedAt?: string; durationMs?: number }): void {
    event.finishedAt = new Date().toISOString()
    event.durationMs = Math.max(0, Date.parse(event.finishedAt) - Date.parse(event.startedAt))
  }

  async #writeRunRecord(
    projectPath: string,
    runId: string,
    workflowId: string,
    status: RunResult['status'],
    dispatchState: RunDispatchState,
    createdAt: string,
    events: readonly ExecutionTimelineEvent[],
    evidence: RunRecordEvidence,
    error?: RunResult['error'],
  ): Promise<void> {
    const projectRoot = path.resolve(projectPath)
    const studioDirectory = path.join(projectRoot, '.studio')
    const studioDetails = await lstat(studioDirectory)
    if (studioDetails.isSymbolicLink() || !studioDetails.isDirectory()) {
      throw new StudioError('run-directory-symlink', '运行记录父目录不能是符号链接或普通文件')
    }
    const [realProject, realStudio] = await Promise.all([realpath(projectRoot), realpath(studioDirectory)])
    const studioRelative = path.relative(realProject, realStudio)
    if (studioRelative.startsWith('..') || path.isAbsolute(studioRelative)) {
      throw new StudioError('run-directory-outside-project', '运行记录父目录逃逸项目边界')
    }
    const directory = path.join(studioDirectory, 'runs')
    try {
      const details = await lstat(directory)
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new StudioError('run-directory-symlink', '运行记录目录不能是符号链接或普通文件')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await ensureDirectory(directory)
    }
    const realDirectory = await realpath(directory)
    // Reject a directory swapped for a junction outside the project before writing.
    const relative = path.relative(realProject, realDirectory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new StudioError('run-directory-outside-project', '运行记录目录逃逸项目边界')
    const base = redactValue({
      schemaVersion: 1,
      runId,
      workflowId,
      status,
      dispatchState,
      createdAt,
      events,
      error,
      environment: { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node },
    }) as Readonly<Record<string, unknown>>
    const record = {
      ...base,
      workflowSnapshot: evidence.workflowSnapshot,
      workflowHash: evidence.workflowHash,
      targetNodeIds: evidence.targetNodeIds,
      overrides: redactPersistentValue(evidence.overrides),
      plan: redactPersistentValue(evidence.plan),
      providerBindings: redactPersistentValue([...evidence.providerBindings.values()]),
      ...(evidence.matrix ? { matrix: redactPersistentValue(evidence.matrix) } : {}),
      remoteJobs: evidence.remoteJobs,
    }
    assertNoSecretFields(record)
    await atomicWriteJson(path.join(directory, `${runId}.json`), record)
  }

  async #recordRunSafely(
    projectPath: string,
    runId: string,
    workflowId: string,
    status: RunResult['status'],
    dispatchState: RunDispatchState,
    createdAt: string,
    events: readonly ExecutionTimelineEvent[],
    evidence: RunRecordEvidence,
    error?: RunResult['error'],
  ): Promise<void> {
    try {
      await this.#writeRunRecord(projectPath, runId, workflowId, status, dispatchState, createdAt, events, evidence, error)
    } catch (recordError) {
      const studioError = asStudioError(recordError, 'run-record-write-failed')
      this.emitSafe({
        type: 'run-record-warning',
        runId,
        workflowId,
        createdAt: new Date().toISOString(),
        message: `执行结果已确定，但运行记录写入失败：${studioError.message}`,
      })
    }
  }

  private emitSafe(event: unknown): void {
    try { this.emit(redactValue(event)) } catch { /* renderer event delivery must never change execution outcome */ }
  }

  #readNodeCache(key: string): NodeOutputs | undefined {
    const value = this.#nodeCache.get(key)
    if (!value) return undefined
    this.#nodeCache.delete(key)
    this.#nodeCache.set(key, value)
    return structuredClone(value)
  }

  #writeNodeCache(key: string, value: NodeOutputs): void {
    try {
      if (JSON.stringify(value).length > 256 * 1024) return
      this.#nodeCache.delete(key)
      this.#nodeCache.set(key, structuredClone(value))
      while (this.#nodeCache.size > 256) {
        const oldest = this.#nodeCache.keys().next().value as string | undefined
        if (!oldest) break
        this.#nodeCache.delete(oldest)
      }
    } catch {
      // Non-serializable values are valid transient outputs but never cacheable.
    }
  }

  #prunePlans(): void {
    const now = Date.now()
    for (const [id, value] of this.#prepared) if (value.expiresAt < now) this.#prepared.delete(id)
  }
}
