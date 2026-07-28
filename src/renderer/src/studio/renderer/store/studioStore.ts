import type { Connection, EdgeChange, NodeChange, XYPosition } from '@xyflow/react'
import { create } from 'zustand'
import { DEFAULT_IMAGE_MODEL, supportsImageSeed } from '@studio/core/imageModels.js'
import {
  inspectProviderConnectionCapability,
  inspectWorkflowProviderCapabilities,
  normalizeProviderModels,
} from '@studio/core/providerCapabilities.js'
import { defaultRegistry } from '@studio/core/registry.js'
import { createWorkflow as createCoreWorkflow } from '@studio/core/workflow.js'
import { createExecutionPlan, type NodeOverride } from '@studio/core/executionPlan.js'
import { planPromptMatrix } from '@studio/core/promptMatrix.js'
import { stackPresets, type PresetDiff } from '@studio/core/presets.js'
import type { LinearViewDefinition } from '@studio/core/linearView.js'
import type {
  StudioReadinessProvider,
  StudioReadinessReport,
  StudioRepairAction,
} from '@studio/core/studioReadiness.js'
import { diffWorkflows, type WorkflowChange } from '@studio/core/workflowDiff.js'
import { instantiateWorkflowTemplate, type WorkflowTemplateId } from '@studio/core/workflowTemplates.js'
import type {
  Board,
  CollectionSnapshot,
  GeneratedAsset,
  NodeDefinition,
  ProviderDescriptor,
  ProviderDraft,
  ProviderImportPreview,
  ProjectSummary,
  ProjectPluginRecord,
  ParameterPresetRecord,
  RunPlan,
  RunDispatchState,
  RunRecordSummary,
  RunResult,
  SmartCollection,
  SocketDataType,
  SubgraphDefinition,
  TaskRecord,
  WorkflowDocument,
  WorkflowNode,
} from '@studio/shared/types.js'
import type {
  PersistentRunSummary,
  StudioBridge,
  StudioCopilotOperation,
} from '@studio/shared/contracts.js'
import { flattenSubgraphs } from '@studio/core/subgraphs.js'
import {
  PromptMatrixSessionController,
  StudioSessionController,
  type PreparedPromptMatrixRun,
} from '../session/StudioSession.js'
import {
  workflowDocumentFingerprint,
} from '../session/workflow-document-session.js'
import {
  createWorkflowRuntimeProjectionCommand,
  createWorkflowEditorSession,
  parseWorkflowClipboardPayload,
  type WorkflowEditorArrangement,
  type WorkflowEditorClipboardPayload,
  type WorkflowEditorEffect,
  type WorkflowEditorSessionSnapshot,
} from '../session/workflow-editor-session.js'
import { applyStudioCopilotOperations } from '../session/studio-copilot-operations.js'
import {
  captureWorkflowDocument,
  createWorkflowStoreCoordinator,
  matchesWorkflowDocumentCapture,
  type WorkflowOperationIdentity,
  type WorkflowOperationTicket,
} from '../session/workflow-store-coordinator.js'
import { accountGroupLabel, accountProviders, isAiTerminalAccountProvider, providerModelOptions } from '../providerSelection.js'
import type {
  AssetItem,
  BoardItem,
  BottomPanelId,
  CanvasNodeData,
  CanvasPort,
  GraphDocument,
  ModalId,
  PageId,
  ProviderItem,
  QueueItem,
  StudioFlowEdge,
  StudioFlowNode,
  TimelineStage,
  WorkflowView,
} from '../types.js'
import { uiPreviewHarnessEnabled } from '../../../runtime-mode.js'

const uid = (): string => globalThis.crypto?.randomUUID?.() ?? `studio-${Date.now()}-${Math.random().toString(16).slice(2)}`

const definitionPorts = (ports: NodeDefinition['inputs'] | NodeDefinition['outputs']): readonly CanvasPort[] =>
  Object.values(ports).map((item) => ({
    id: item.id,
    label: item.label,
    dataType: item.dataType,
    required: item.required,
  }))

const makeNode = (
  id: string,
  type: string,
  position: XYPosition,
  overrides: Partial<CanvasNodeData> = {},
): StudioFlowNode => {
  const definition = defaultRegistry.get(type)
  const parameters = Object.fromEntries(definition.parameters.map((item) => [item.id, item.defaultValue]))
  const { parameters: overrideParameters, ...dataOverrides } = overrides
  const framePresentation = type === 'frame'
    ? {
        width: typeof dataOverrides.rawPresentation?.width === 'number' ? dataOverrides.rawPresentation.width : 520,
        height: typeof dataOverrides.rawPresentation?.height === 'number' ? dataOverrides.rawPresentation.height : 320,
        ...(dataOverrides.rawPresentation ?? {}),
      }
    : undefined
  return {
    id,
    type: 'studio',
    position,
    ...(framePresentation ? {
      style: { width: framePresentation.width, height: framePresentation.height },
      zIndex: -10,
    } : {}),
    data: {
      label: definition.title,
      nodeType: type,
      category: definition.category,
      description: definition.description,
      inputs: definitionPorts(definition.inputs),
      outputs: definitionPorts(definition.outputs),
      accent: definition.accent,
      status: 'idle',
      ...dataOverrides,
      ...(framePresentation ? { rawPresentation: framePresentation } : {}),
      parameters: { ...parameters, ...(overrideParameters ?? {}) },
    },
  }
}

const findFreeNodePosition = (nodes: readonly StudioFlowNode[]): XYPosition => {
  if (nodes.length === 0) return { x: 80, y: 120 }
  const startX = Math.min(...nodes.map((node) => node.position.x))
  const startY = Math.min(...nodes.map((node) => node.position.y))
  for (let row = 0; row < 100; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const candidate = { x: startX + column * 330, y: startY + row * 300 }
      const clear = nodes.every((node) =>
        Math.abs(node.position.x - candidate.x) >= 280
        || Math.abs(node.position.y - candidate.y) >= 250)
      if (clear) return candidate
    }
  }
  return { x: startX, y: startY + nodes.length * 300 }
}

const initialNodes: readonly StudioFlowNode[] = [
  makeNode('brief', 'text', { x: 40, y: 95 }, {
    label: '创意简报',
    parameters: { text: '雨夜里的未来主义茶室，电影级布光，细腻材质' },
    annotation: '只描述画面主体，不在这里写镜头参数。',
    status: 'success',
    runtimeMs: 2,
    cacheHit: true,
  }),
  makeNode('style', 'prompt_template', { x: 360, y: 38 }, {
    label: '电影质感模板',
    parameters: { template: '{input}, anamorphic lens, volumetric light, restrained palette' },
    status: 'success',
    runtimeMs: 5,
    cacheHit: true,
  }),
  makeNode('reference', 'project_image', { x: 365, y: 310 }, {
    label: '构图参考',
    parameters: { path: 'assets/reference/teahouse.png' },
    status: 'success',
    runtimeMs: 18,
    previewTone: 'mono',
  }),
  makeNode('generate', 'image_generation', { x: 720, y: 105 }, {
    label: '主视觉生成',
    parameters: {
      providerId: 'account-group-default',
      model: DEFAULT_IMAGE_MODEL,
      size: '1536x1024',
      quality: 'high',
      count: 4,
      seed: 842019,
    },
    status: 'running',
    dispatchState: 'sent',
    runtimeMs: 6340,
    previewTone: 'copper',
  }),
  makeNode('preview', 'image_preview', { x: 1080, y: 122 }, {
    label: '候选预览',
    status: 'queued',
    dispatchState: 'not_sent',
    pinned: true,
    previewTone: 'jade',
  }),
  makeNode('note', 'note', { x: 718, y: 430 }, {
    label: '交付检查',
    parameters: { text: '保留暗部层次；建筑线条不能弯曲；检查手部。' },
    status: 'idle',
    annotation: '评审前确认放大到 100%。',
  }),
]

const edge = (
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  dataType: SocketDataType,
  active = false,
): StudioFlowEdge => ({
  id,
  source,
  sourceHandle,
  target,
  targetHandle,
  type: 'exposure',
  data: { dataType, active },
})

const initialEdges: readonly StudioFlowEdge[] = [
  edge('e-brief-style', 'brief', 'out:text', 'style', 'in:input', 'text'),
  edge('e-style-generate', 'style', 'out:text', 'generate', 'in:prompt', 'text', true),
  edge('e-reference-generate', 'reference', 'out:image', 'generate', 'in:referenceImages', 'images', true),
  edge('e-generate-preview', 'generate', 'out:images', 'preview', 'in:images', 'images', true),
]

const queueSeed: readonly QueueItem[] = [
  {
    id: 'task-1042',
    title: '主视觉生成 · 4 张',
    workflow: '霓虹茶室 / 主线',
    provider: 'Studio API',
    status: 'running',
    progress: 68,
    createdAt: '14:32:08',
    message: '正在接收第 3/4 张图片',
  },
  {
    id: 'task-1041',
    title: '候选 B 局部重绘',
    workflow: '霓虹茶室 / 修订',
    provider: 'Remote ComfyUI',
    status: 'queued',
    progress: 0,
    createdAt: '14:31:44',
    message: '等待 GPU 队列',
  },
  {
    id: 'task-1040',
    title: '横版扩图',
    workflow: '品牌 KV / 导出',
    provider: 'Studio API',
    status: 'success',
    dispatchState: 'sent',
    progress: 100,
    createdAt: '14:27:16',
    message: '已保存至 outputs/2026-07-15',
  },
]

const assetsSeed: readonly AssetItem[] = [
  { id: 'a1', title: '霓虹茶室 · A', prompt: '未来主义茶室，雨夜，电影布光', model: 'gpt-image-1', workflow: '霓虹茶室', createdAt: '今天 14:31', favorite: true, decision: 'adopted', candidateGroup: 'tea-v4', operation: 'generate', tags: ['建筑', '雨夜', '主视觉'], tone: 'copper', size: '1536×1024', seed: 842019 },
  { id: 'a2', title: '霓虹茶室 · B', prompt: '未来主义茶室，雨夜，电影布光', model: 'gpt-image-1', workflow: '霓虹茶室', createdAt: '今天 14:31', favorite: false, decision: 'pending', candidateGroup: 'tea-v4', operation: 'generate', tags: ['建筑', '雨夜'], tone: 'jade', size: '1536×1024', seed: 842020 },
  { id: 'a3', title: '入口光影修订', prompt: '增强入口暖光，保持建筑结构', model: 'gpt-image-1', workflow: '霓虹茶室', createdAt: '今天 14:36', favorite: true, decision: 'pending', candidateGroup: 'tea-v4', parentId: 'a1', operation: 'inpaint', tags: ['修订', '暖光'], tone: 'rose', size: '1536×1024', seed: 842019 },
  { id: 'a4', title: '横版扩图', prompt: '向左右延展雨夜街景', model: 'gpt-image-1', workflow: '霓虹茶室', createdAt: '今天 14:41', favorite: false, decision: 'pending', candidateGroup: 'tea-v4', parentId: 'a3', operation: 'outpaint', tags: ['扩图', '横版'], tone: 'blue', size: '1792×1024', seed: 842019 },
  { id: 'a5', title: '茶具材质实验', prompt: '黑陶茶具，潮湿高光，静物摄影', model: 'flux-1.1-pro', workflow: '材质探索', createdAt: '昨天 21:08', favorite: false, decision: 'rejected', candidateGroup: 'material-v2', operation: 'generate', tags: ['材质', '静物'], tone: 'mono', size: '1024×1024', seed: 11387 },
  { id: 'a6', title: '品牌色方向', prompt: '青绿色与铜色品牌视觉，建筑摄影', model: 'sdxl-lightning', workflow: '品牌 KV', createdAt: '7月13日 09:24', favorite: true, decision: 'pending', candidateGroup: 'brand-v1', operation: 'generate', tags: ['品牌', '配色'], tone: 'violet', size: '1024×1024', seed: 99120 },
]

const localDateKey = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

const assetDateKey = (asset: AssetItem): string => asset.createdAtIso?.slice(0, 10)
  ?? (asset.createdAt.startsWith('今天') ? localDateKey() : '')

export const assetMatchesBoard = (asset: AssetItem, board: BoardItem | undefined): boolean => {
  if (!board || board.id === 'all') return true
  if (board.id === 'favorites') return asset.favorite
  if (board.id === 'today') return assetDateKey(asset) === localDateKey()
  if (board.id === 'approved') return asset.decision === 'adopted'
  if (board.kind === 'board') return board.assetIds?.includes(asset.id) ?? false
  if (board.favorite !== undefined && asset.favorite !== board.favorite) return false
  if ((board.models?.length ?? 0) > 0 && !board.models?.includes(asset.model)) return false
  if ((board.workflowIds?.length ?? 0) > 0 && !board.workflowIds?.includes(asset.workflow)) return false
  if ((board.tags?.length ?? 0) > 0 && !board.tags?.every((tag) => asset.tags.includes(tag))) return false
  const date = assetDateKey(asset)
  if (board.dateFrom && (!date || date < board.dateFrom)) return false
  if (board.dateTo && (!date || date > board.dateTo)) return false
  return true
}

const smartRuleLabel = (collection: SmartCollection): string => {
  const parts = [
    collection.favorite === undefined ? undefined : `favorite = ${String(collection.favorite)}`,
    collection.models.length > 0 ? `model ∈ ${collection.models.join(', ')}` : undefined,
    collection.workflowIds.length > 0 ? `workflow ∈ ${collection.workflowIds.join(', ')}` : undefined,
    collection.tags.length > 0 ? `tags ⊇ ${collection.tags.join(', ')}` : undefined,
    collection.dateFrom ? `date ≥ ${collection.dateFrom}` : undefined,
    collection.dateTo ? `date ≤ ${collection.dateTo}` : undefined,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '所有输出'
}

const buildBoardItems = (assets: readonly AssetItem[], snapshot: CollectionSnapshot): readonly BoardItem[] => {
  const definitions: readonly BoardItem[] = [
    { id: 'all', name: '全部作品', count: 0, kind: 'smart', rule: '所有输出', builtin: true },
    { id: 'favorites', name: '收藏', count: 0, kind: 'smart', rule: 'favorite = true', builtin: true },
    { id: 'today', name: '今日生成', count: 0, kind: 'smart', rule: 'date = today', builtin: true },
    { id: 'approved', name: '已采用候选', count: 0, kind: 'smart', rule: 'decision = adopted', builtin: true },
    ...snapshot.smartCollections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      count: 0,
      kind: 'smart' as const,
      rule: smartRuleLabel(collection),
      ...(collection.favorite === undefined ? {} : { favorite: collection.favorite }),
      models: collection.models,
      workflowIds: collection.workflowIds,
      tags: collection.tags,
      ...(collection.dateFrom ? { dateFrom: collection.dateFrom } : {}),
      ...(collection.dateTo ? { dateTo: collection.dateTo } : {}),
    })),
    ...snapshot.boards.map((board) => ({
      id: board.id,
      name: board.name,
      count: 0,
      kind: 'board' as const,
      description: board.description,
      assetIds: board.assetIds,
    })),
  ]
  return definitions.map((board) => ({ ...board, count: assets.filter((asset) => assetMatchesBoard(asset, board)).length }))
}

const snapshotFromBoardItems = (items: readonly BoardItem[]): CollectionSnapshot => ({
  schemaVersion: 1,
  boards: items.filter((item) => item.kind === 'board').map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description ?? '',
    assetIds: item.assetIds ?? [],
  })),
  smartCollections: items.filter((item) => item.kind === 'smart' && !item.builtin).map((item) => ({
    id: item.id,
    name: item.name,
    models: item.models ?? [],
    workflowIds: item.workflowIds ?? [],
    tags: item.tags ?? [],
    ...(item.favorite === undefined ? {} : { favorite: item.favorite }),
    ...(item.dateFrom ? { dateFrom: item.dateFrom } : {}),
    ...(item.dateTo ? { dateTo: item.dateTo } : {}),
  })),
})

const demoCollections: CollectionSnapshot = {
  schemaVersion: 1,
  boards: [
    { id: 'campaign', name: '夏季发布会', description: '发布会主视觉候选', assetIds: ['a1', 'a2', 'a3', 'a4'] },
    { id: 'materials', name: '材质参考', description: '材质与静物方向', assetIds: ['a5'] },
  ],
  smartCollections: [],
}

const boardsSeed = buildBoardItems(assetsSeed, demoCollections)

const providerSeed: readonly ProviderItem[] = [
  {
    id: 'account-group-default',
    name: 'default',
    baseUrl: 'https://api.example.com/v1',
    model: DEFAULT_IMAGE_MODEL,
    kind: 'openai-compatible',
    status: 'connected',
    hasSecret: true,
    managedBy: 'ai-terminal-account',
    groupId: 'default',
    models: [DEFAULT_IMAGE_MODEL, 'gpt-image-1'],
    description: '默认分组',
    latencyMs: 438,
  },
  {
    id: 'account-group-lab',
    name: 'creative-lab',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-image-1',
    kind: 'openai-compatible',
    status: 'connected',
    hasSecret: true,
    managedBy: 'ai-terminal-account',
    groupId: 'creative-lab',
    models: ['gpt-image-1', 'dall-e-3'],
    description: '创作分组',
    latencyMs: 512,
  },
]

const timelineSeed: readonly TimelineStage[] = [
  { id: 't1', label: '排队', durationMs: 184, status: 'success' },
  { id: 't2', label: 'Provider', durationMs: 5812, status: 'running' },
  { id: 't3', label: '下载', durationMs: 0, status: 'pending' },
  { id: 't4', label: '解码', durationMs: 0, status: 'pending' },
  { id: 't5', label: '落盘', durationMs: 0, status: 'pending' },
]

const emptyTimeline = (): readonly TimelineStage[] => [
  { id: 'queue', label: '排队', durationMs: 0, status: 'pending' },
  { id: 'provider', label: 'Provider', durationMs: 0, status: 'pending' },
  { id: 'download', label: '下载', durationMs: 0, status: 'pending' },
  { id: 'decode', label: '解码', durationMs: 0, status: 'pending' },
  { id: 'persist', label: '落盘', durationMs: 0, status: 'pending' },
]

const runSeed: readonly RunRecordSummary[] = [{
  schemaVersion: 1,
  runId: 'demo-run-1042',
  workflowId: 'workflow-neon-teahouse',
  status: 'succeeded',
  createdAt: '2026-07-15T14:32:14.342Z',
  events: timelineSeed.map((stage, index) => ({
    id: `demo-event-${index + 1}`,
    runId: 'demo-run-1042',
    nodeId: 'generate',
    phase: (['queue', 'provider', 'download', 'decode', 'persist'] as const)[index] ?? 'queue',
    startedAt: new Date(Date.parse('2026-07-15T14:32:08.000Z') + index * 1_000).toISOString(),
    finishedAt: new Date(Date.parse('2026-07-15T14:32:08.000Z') + index * 1_000 + stage.durationMs).toISOString(),
    durationMs: stage.durationMs,
  })),
  environment: { platform: 'win32', arch: 'x64', electron: 'demo', node: 'demo' },
}]

const toneForIndex = (index: number): AssetItem['tone'] =>
  (['copper', 'jade', 'blue', 'rose', 'violet', 'mono'] as const)[index % 6] ?? 'mono'

const mapProvider = (provider: ProviderDescriptor, models: readonly string[] = []): ProviderItem => ({
  id: provider.id,
  name: provider.name,
  baseUrl: provider.baseUrl,
  model: provider.defaultModel,
  kind: provider.kind,
  status: 'untested',
  hasSecret: provider.hasSecret,
  models: provider.availableModels ?? models,
  ...(provider.kind === 'openai-compatible' && provider.confirmedOnlyModels
    ? { confirmedOnlyModels: provider.confirmedOnlyModels }
    : {}),
  timeoutMs: provider.timeoutMs,
  maxImageBytes: provider.maxImageBytes,
  proxyMode: provider.proxyMode,
  ...(provider.managedBy ? { managedBy: provider.managedBy } : {}),
  ...(provider.groupId ? { groupId: provider.groupId } : {}),
  ...(provider.description ? { description: provider.description } : {}),
})

const readinessProvidersFromItems = (
  providers: readonly ProviderItem[],
): readonly StudioReadinessProvider[] => providers.map((provider) => ({
  id: provider.id,
  kind: provider.kind,
  hasSecret: provider.hasSecret,
  defaultModel: provider.model,
  ...(provider.confirmedOnlyModels ? { confirmedOnlyModels: provider.confirmedOnlyModels } : {}),
  ...(provider.managedBy ? { managedBy: provider.managedBy } : {}),
}))

const mapTaskStatus = (status: TaskRecord['status']): QueueItem['status'] => {
  if (status === 'pending') return 'queued'
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'error'
  return status
}

const taskStatusFromEvent = (status: unknown): QueueItem['status'] | undefined => {
  if (status === 'pending') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'error'
  if (status === 'billing-unknown') return 'billing-unknown'
  return undefined
}

const nodeStatusFromTaskEvent = (status: unknown): CanvasNodeData['status'] | undefined => {
  if (status === 'pending') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'billing-unknown') return 'error'
  if (status === 'cancelled') return 'cancelled'
  return undefined
}

const normalizeDispatchState = (value: unknown): RunDispatchState | undefined =>
  value === 'not_sent' || value === 'sent' || value === 'billing_unknown' ? value : undefined

const dispatchStateFromResult = (result: Pick<RunResult, 'dispatchState' | 'error'>): RunDispatchState | undefined =>
  result.dispatchState ?? result.error?.dispatchState ?? (result.error?.billingUnknown ? 'billing_unknown' : undefined)

const mapTasks = (tasks: readonly TaskRecord[], runs: readonly RunRecordSummary[] = []): readonly QueueItem[] => {
  const groups = new Map<string, TaskRecord[]>()
  const runsById = new Map(runs.map((run) => [run.runId, run]))
  tasks.forEach((task) => {
    const id = task.runId ?? task.id
    groups.set(id, [...(groups.get(id) ?? []), task])
  })
  return [...groups.entries()]
    .sort(([, left], [, right]) => Math.max(...right.map((task) => Date.parse(task.updatedAt))) - Math.max(...left.map((task) => Date.parse(task.updatedAt))))
    .map(([runId, group]) => {
      const latest = [...group].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] as TaskRecord
      const statuses = group.map((task) => mapTaskStatus(task.status))
      const status: QueueItem['status'] = statuses.includes('billing-unknown')
        ? 'billing-unknown'
        : statuses.includes('running')
          ? 'running'
          : statuses.includes('queued')
            ? 'queued'
            : statuses.includes('error')
              ? 'error'
              : 'success'
      const progress = group.reduce((total, task) => total + Math.max(0, Math.min(1, task.progress)), 0) / group.length
      const run = runsById.get(runId)
      const taskDispatchStates = group.map((task) => task.dispatchState)
      const taskDispatchState: RunDispatchState | undefined = taskDispatchStates.includes('billing_unknown')
        ? 'billing_unknown'
        : taskDispatchStates.includes('sent')
          ? 'sent'
          : taskDispatchStates.every((value) => value === 'not_sent')
            ? 'not_sent'
            : undefined
      const dispatchState = (run ? dispatchStateFromResult(run) : undefined) ?? taskDispatchState
      return {
        id: runId,
        title: `${group.length} 个节点 · ${latest.nodeId}`,
        workflow: latest.workflowId,
        provider: '工作流 Provider',
        status,
        progress: Math.round(progress * 100),
        createdAt: new Date(group.map((task) => task.createdAt).sort()[0] ?? latest.createdAt).toLocaleTimeString('zh-CN', { hour12: false }),
        message: latest.message,
        ...(dispatchState ? { dispatchState } : {}),
      }
    })
}

const mapPersistentRuns = (items: readonly PersistentRunSummary[]): readonly QueueItem[] => items.map((item) => ({
  id: item.id,
  title: item.workflowName,
  workflow: item.workflowId,
  provider: item.providerIds.join(', ') || '本地工作流',
  status: item.dispatchState !== 'not_sent'
    ? 'billing-unknown'
    : item.status === 'running'
      ? 'running'
      : 'queued',
  progress: item.status === 'running' ? 1 : 0,
  createdAt: new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour12: false }),
  message: item.blockedReason ?? item.lastError ?? (item.status === 'paused' ? '上次退出前未完成；需要明确确认后恢复' : '已持久化，等待主进程执行'),
  dispatchState: item.dispatchState,
  persistentStatus: item.status,
  canResume: item.canResume,
  canRemove: item.canRemove,
  ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
  attempt: item.attempt,
}))

const mergeQueue = (
  tasks: readonly TaskRecord[],
  runs: readonly RunRecordSummary[],
  persistent: readonly PersistentRunSummary[],
): readonly QueueItem[] => {
  const durable = mapPersistentRuns(persistent)
  const durableIds = new Set(durable.map((item) => item.id))
  return [...durable, ...mapTasks(tasks, runs).filter((item) => !durableIds.has(item.id))]
}

const mapAsset = (asset: GeneratedAsset, index: number, previewUrl?: string): AssetItem => ({
  id: asset.id,
  title: `${asset.operation === 'generate' ? '生成' : asset.operation === 'edit' ? '编辑' : asset.operation === 'inpaint' ? '局部重绘' : '扩图'} · ${String(index + 1).padStart(2, '0')}`,
  prompt: asset.prompt,
  ...(asset.revisedPrompt ? { revisedPrompt: asset.revisedPrompt } : {}),
  model: asset.model,
  providerId: asset.providerId,
  nodeId: asset.nodeId,
  workflow: asset.workflowId,
  createdAt: new Date(asset.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  createdAtIso: asset.createdAt,
  favorite: asset.favorite,
  decision: asset.decision,
  candidateGroup: asset.candidateGroupId,
  ...(asset.parentAssetId ? { parentId: asset.parentAssetId } : {}),
  operation: asset.operation,
  tags: asset.tags,
  tone: toneForIndex(index),
  size: asset.width && asset.height ? `${asset.width}×${asset.height}` : '—',
  ...(asset.seed !== undefined ? { seed: asset.seed } : {}),
  ...(previewUrl ? { previewUrl } : {}),
  previewPath: asset.thumbnailPath ?? asset.relativePath,
  relativePath: asset.relativePath,
})

const defaultDebugOutput = (node: StudioFlowNode): unknown => {
  const output = node.data.outputs[0]
  if (!output) return {}
  let value: unknown = null
  if (output.dataType === 'text') value = node.data.nodeType === 'text' ? String(node.data.parameters.text ?? '') : ''
  else if (output.dataType === 'image') value = node.data.nodeType === 'project_image' ? String(node.data.parameters.path ?? '') : ''
  else if (output.dataType === 'images') value = []
  else if (output.dataType === 'number') value = 0
  else if (output.dataType === 'boolean') value = false
  return { [output.id]: value }
}

const graphExecutionPrefixes = (graphs: Readonly<Record<string, GraphDocument>>): ReadonlyMap<string, string> => {
  const prefixes = new Map<string, string>([['root', '']])
  const prefixFor = (graphId: string, visiting = new Set<string>()): string | undefined => {
    const cached = prefixes.get(graphId)
    if (cached !== undefined) return cached
    const graph = graphs[graphId]
    if (!graph?.parentId || !graph.instanceNodeId || visiting.has(graphId)) return undefined
    visiting.add(graphId)
    const parent = prefixFor(graph.parentId, visiting)
    visiting.delete(graphId)
    if (parent === undefined) return undefined
    const prefix = `${parent}${graph.instanceNodeId}__`
    prefixes.set(graphId, prefix)
    return prefix
  }
  Object.keys(graphs).forEach((graphId) => prefixFor(graphId))
  return prefixes
}

const updateExecutionNode = (
  graphs: Readonly<Record<string, GraphDocument>>,
  executionNodeId: string,
  update: (node: StudioFlowNode) => Partial<CanvasNodeData>,
): Readonly<Record<string, GraphDocument>> => {
  const prefixes = graphExecutionPrefixes(graphs)
  let changed = false
  const result = Object.fromEntries(Object.entries(graphs).map(([graphId, graph]) => {
    const prefix = prefixes.get(graphId)
    if (prefix === undefined) return [graphId, graph]
    const nodes = graph.nodes.map((node) => {
      if (`${prefix}${node.id}` !== executionNodeId) return node
      changed = true
      return { ...node, data: { ...node.data, ...update(node) } }
    })
    return [graphId, changed && nodes.some((node, index) => node !== graph.nodes[index]) ? { ...graph, nodes } : graph]
  }))
  return changed ? result : graphs
}

const executionNode = (
  graphs: Readonly<Record<string, GraphDocument>>,
  executionNodeId: string,
): { readonly graphId: string; readonly node: StudioFlowNode } | undefined => {
  const prefixes = graphExecutionPrefixes(graphs)
  for (const [graphId, graph] of Object.entries(graphs)) {
    const prefix = prefixes.get(graphId)
    if (prefix === undefined) continue
    const node = graph.nodes.find((candidate) => `${prefix}${candidate.id}` === executionNodeId)
    if (node) return { graphId, node }
  }
  return undefined
}

const normalizePreviewPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const path = value.trim().replaceAll('\\', '/')
  if (!path || path.includes('\0') || !/^(?:assets|outputs)\//i.test(path)) return undefined
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return undefined
  return path
}

const previewPathsFromOutput = (output: unknown): readonly string[] => {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return []
  const value = output as Readonly<Record<string, unknown>>
  const candidates = Array.isArray(value.images)
    ? value.images
    : value.image === undefined
      ? []
      : [value.image]
  return [...new Set(candidates.map(normalizePreviewPath).filter((path): path is string => Boolean(path)))].slice(0, 32)
}

const previewSourceExecutionIds = (
  graphs: Readonly<Record<string, GraphDocument>>,
  graphId: string,
  previewNodeId: string,
): { readonly assetNodeIds: ReadonlySet<string>; readonly localPaths: readonly string[] } => {
  const graph = graphs[graphId]
  const prefix = graphExecutionPrefixes(graphs).get(graphId)
  if (!graph || prefix === undefined) return { assetNodeIds: new Set(), localPaths: [] }
  const assetNodeIds = new Set<string>()
  const localPaths = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    for (const incoming of graph.edges.filter((edge) => edge.target === nodeId)) {
      const source = graph.nodes.find((node) => node.id === incoming.source)
      if (!source) continue
      if (['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'].includes(source.data.nodeType)) {
        assetNodeIds.add(`${prefix}${source.id}`)
        continue
      }
      if (source.data.nodeType === 'project_image') {
        const path = normalizePreviewPath(source.data.parameters.path)
        if (path) localPaths.add(path)
        continue
      }
      visit(source.id)
    }
  }
  visit(previewNodeId)
  return { assetNodeIds, localPaths: [...localPaths] }
}

const previewPathsFromAssets = (
  state: Pick<StudioState, 'graphs' | 'assets' | 'workflowId'>,
  graphId: string,
  previewNodeId: string,
): readonly string[] => {
  const sources = previewSourceExecutionIds(state.graphs, graphId, previewNodeId)
  const matching = state.assets
    .filter((asset) => asset.workflow === state.workflowId && asset.nodeId && sources.assetNodeIds.has(asset.nodeId) && asset.relativePath)
    .slice()
    .sort((left, right) => Date.parse(right.createdAtIso ?? '') - Date.parse(left.createdAtIso ?? ''))
  const latest = matching[0]
  const generatedPaths = latest
    ? matching
        .filter((asset) => asset.nodeId === latest.nodeId && asset.candidateGroup === latest.candidateGroup)
        .map((asset) => normalizePreviewPath(asset.relativePath))
        .filter((path): path is string => Boolean(path))
    : []
  return [...new Set([...generatedPaths, ...sources.localPaths])].slice(0, 32)
}

export const buildDebugOverrides = (graphs: Readonly<Record<string, GraphDocument>>): Readonly<Record<string, NodeOverride>> => {
  const prefixes = graphExecutionPrefixes(graphs)
  const overrides: Record<string, NodeOverride> = {}
  for (const graph of Object.values(graphs)) {
    const prefix = prefixes.get(graph.id)
    if (prefix === undefined) continue
    for (const node of graph.nodes) {
      if (!node.data.pinned && !node.data.mocked) continue
      overrides[`${prefix}${node.id}`] = {
        action: node.data.pinned ? 'pin' : 'mock',
        value: structuredClone(node.data.debugOutput === undefined ? defaultDebugOutput(node) : node.data.debugOutput),
      }
    }
  }
  return overrides
}

const nodesFromGraph = (graph: GraphDocument): readonly WorkflowNode[] => graph.nodes.map((node) => {
  const rawPresentation: Record<string, unknown> = { ...(node.data.rawPresentation ?? {}) }
  delete rawPresentation.debugOverride
  const presentation = {
    ...rawPresentation,
    ...(node.data.annotation !== undefined ? { annotation: node.data.annotation } : {}),
    ...(node.data.collapsed !== undefined ? { collapsed: node.data.collapsed } : {}),
    ...(node.data.bypassed !== undefined ? { bypassed: node.data.bypassed } : {}),
    ...(node.data.pinned || node.data.mocked ? {
      debugOverride: {
        action: node.data.pinned ? 'pin' as const : 'mock' as const,
        value: structuredClone(node.data.debugOutput === undefined ? defaultDebugOutput(node) : node.data.debugOutput),
      },
    } : {}),
  }
  return {
    id: node.id,
    type: node.data.nodeType,
    name: node.data.label,
    position: node.position,
    parameters: node.data.parameters,
    ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
    ...(node.data.subgraphDefinitionId && node.data.subgraphDefinitionVersion ? {
      subgraph: {
        definitionId: node.data.subgraphDefinitionId,
        definitionVersion: node.data.subgraphDefinitionVersion,
      },
    } : {}),
  }
})

const edgesFromGraph = (graph: GraphDocument): WorkflowDocument['edges'] => graph.edges.flatMap((item) => item.sourceHandle && item.targetHandle ? [{
  id: item.id,
  sourceNode: item.source,
  sourceSocket: item.sourceHandle.replace(/^out:/, ''),
  targetNode: item.target,
  targetSocket: item.targetHandle.replace(/^in:/, ''),
  ...(item.data?.presentation ? { presentation: item.data.presentation } : {}),
}] : [])

export const workflowPlanFingerprint = workflowDocumentFingerprint

export interface CompatiblePickerState {
  readonly x: number
  readonly y: number
  readonly sourceNodeId: string
  readonly sourceHandle: string
  readonly dataType: CanvasPort['dataType']
}

export interface PromptMatrixInput {
  readonly prompts: readonly string[]
  readonly models: readonly string[]
  readonly sizes: readonly string[]
  readonly seeds: readonly number[]
  readonly costPerImage?: number
  readonly maxEstimatedCost?: number
}

type PreparedMatrixRun = PreparedPromptMatrixRun

interface PendingDraftRecovery {
  readonly baseRevision: number
  readonly conflicted?: boolean
  readonly savedAt: string
  readonly workflow: WorkflowDocument
  readonly changes: readonly WorkflowChange[]
}

interface WorkflowVersionItem {
  readonly workflowId: string
  readonly revision: number
  readonly name: string
  readonly savedAt: string
}

interface ArchivedWorkflowItem {
  readonly archiveId: string
  readonly workflowId: string
  readonly name: string
  readonly revision: number
  readonly archivedAt: string
}

interface WorkflowEditorStoreProjection {
  readonly graphs: Readonly<Record<string, GraphDocument>>
  readonly activeGraphId: string
  readonly selectedNodeId: string | undefined
  readonly workflowDocument: WorkflowDocument
  readonly workflowId: string
  readonly workflowRevision: number
  readonly workflowDirty: boolean
  readonly subgraphDefinitions: readonly SubgraphDefinition[]
  readonly workflowReadiness: StudioReadinessReport
  readonly linearValues: Readonly<Record<string, string | number>>
  readonly linearDefinition: LinearViewDefinition
  readonly draftSaving: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
}

interface WorkflowEditorStoreActions {
  setSelectedNode(nodeId: string | undefined): void
  restoreRunSnapshot(runId: string): void
  onNodesChange(changes: readonly NodeChange<StudioFlowNode>[]): void
  onEdgesChange(changes: readonly EdgeChange<StudioFlowEdge>[]): void
  connect(connection: Connection): void
  addNode(type: string, position?: XYPosition): void
  addSubgraphInstance(definitionId: string, position?: XYPosition): void
  addCompatibleNode(type: string): void
  undoEditor(): void
  redoEditor(): void
  autoLayoutWorkflow(scope?: 'all' | 'selected'): void
  arrangeSelectedNodes(arrangement: WorkflowEditorArrangement): void
  applyCopilotOperations(
    operations: readonly StudioCopilotOperation[],
    generationBinding?: { readonly providerId: string; readonly model: string },
  ): void
  resizeFrame(nodeId: string, width: number, height: number): void
  updateNodeData(nodeId: string, patch: Partial<CanvasNodeData>): void
  updateNodeParameter(nodeId: string, key: string, value: unknown): void
  bindAccountGroup(providerId: string, model?: string): void
  toggleNodeFlag(nodeId: string, flag: 'bypassed' | 'collapsed' | 'pinned' | 'mocked'): void
  removeSelectedNodes(): void
  copySelectedNodes(): void
  pasteCopiedNodes(position?: { readonly x: number; readonly y: number }): Promise<void>
  connectSelectedNodes(): void
  duplicateSelectedNodes(): void
  convertSelectionToSubgraph(): void
  enterGraph(graphId: string): void
  importLocalImage(position?: XYPosition): Promise<void>
  chooseProjectImage(nodeId: string, parameter: string): Promise<void>
  clearProjectImage(nodeId: string): void
  updateLinearValue(key: string, value: string | number): void
  setLinearField(nodeId: string, parameter: string, label: string, exposed: boolean): void
  repairWorkflow(action: StudioRepairAction): void
}

interface StudioTextInputRequest {
  readonly id: number
  readonly title: string
  readonly label: string
  readonly initialValue?: string
  readonly placeholder?: string
  readonly confirmLabel?: string
  readonly maxLength?: number
}

interface StudioState extends WorkflowEditorStoreProjection, WorkflowEditorStoreActions {
  readonly page: PageId
  readonly workflowView: WorkflowView
  readonly bottomPanel: BottomPanelId
  readonly bottomOpen: boolean
  readonly modal: ModalId
  readonly textInputRequest: StudioTextInputRequest | undefined
  readonly selectedAssetId: string
  readonly selectedBoardId: string
  readonly selectedQueueId: string
  readonly assets: readonly AssetItem[]
  readonly boards: readonly BoardItem[]
  readonly queue: readonly QueueItem[]
  readonly providers: readonly ProviderItem[]
  readonly pendingProviderImports: readonly ProviderImportPreview[]
  readonly providerImportBusy: string | undefined
  readonly plugins: readonly ProjectPluginRecord[]
  readonly presets: readonly ParameterPresetRecord[]
  readonly lastPresetDiffs: readonly PresetDiff[]
  readonly runs: readonly RunRecordSummary[]
  readonly selectedRunId: string | undefined
  readonly timeline: readonly TimelineStage[]
  readonly compatiblePicker: CompatiblePickerState | undefined
  readonly toast: string | undefined
  readonly connectionState: 'demo' | 'idle' | 'loading' | 'ready' | 'error'
  readonly appVersion: string
  readonly projectPath: string | undefined
  readonly projectName: string | undefined
  readonly availableProjects: readonly ProjectSummary[]
  readonly workflows: readonly WorkflowDocument[]
  readonly pendingPlan: RunPlan | undefined
  readonly pendingWorkflow: WorkflowDocument | undefined
  readonly pendingMatrixRuns: readonly PreparedMatrixRun[]
  readonly pendingMatrixPrepareGeneration: number | undefined
  readonly pendingTargetNodeIds: readonly string[]
  readonly safeMode: boolean
  readonly gridSnap: boolean
  readonly showMinimap: boolean
  readonly filenameTemplate: string
  readonly localImageImporting: boolean
  readonly pendingDraftRecovery: PendingDraftRecovery | undefined
  readonly workflowVersions: readonly WorkflowVersionItem[]
  readonly archivedWorkflows: readonly ArchivedWorkflowItem[]
  navigate(page: PageId): void
  setWorkflowView(view: WorkflowView): void
  setBottomPanel(panel: BottomPanelId): void
  toggleBottom(): void
  openModal(modal: ModalId): void
  closeModal(): void
  requestTextInput(request: Omit<StudioTextInputRequest, 'id'>): Promise<string | undefined>
  resolveTextInput(value?: string): void
  selectAsset(assetId: string): void
  selectBoard(boardId: string): void
  selectQueue(queueId: string): void
  selectRun(runId: string): void
  openCompatiblePicker(picker: CompatiblePickerState): void
  closeCompatiblePicker(): void
  showToast(message: string): void
  dismissToast(): void
  ensureProjectForRun(): Promise<boolean>
  runWorkflow(targetNodeIds?: readonly string[]): Promise<void>
  runSelectedNode(): Promise<void>
  preparePromptMatrix(input: PromptMatrixInput): Promise<void>
  confirmRun(): Promise<void>
  saveWorkflow(): Promise<void>
  switchWorkflow(workflowId: string): Promise<void>
  createNewWorkflow(name: string): Promise<void>
  createWorkflowFromTemplate(templateId: WorkflowTemplateId): Promise<void>
  recoverWorkflowDraft(): void
  discardWorkflowDraft(): Promise<void>
  openWorkflowHistory(): Promise<void>
  restoreWorkflowVersion(revision: number): Promise<void>
  duplicateCurrentWorkflow(name?: string): Promise<void>
  archiveCurrentWorkflow(): Promise<void>
  restoreArchivedWorkflow(archiveId: string): Promise<void>
  exportCurrentWorkflowPackage(): Promise<void>
  importWorkflowPackage(): Promise<void>
  createProject(name: string): Promise<void>
  openProject(projectPath?: string): Promise<void>
  ensureAssetPreview(assetId: string): Promise<void>
  reloadAssetPreview(assetId: string): Promise<void>
  refreshAssets(): Promise<void>
  refreshRuns(): Promise<void>
  refreshQueue(): Promise<void>
  resumePersistentRun(itemId: string): Promise<void>
  removePersistentRun(itemId: string): Promise<void>
  exportDiagnostics(runId: string): Promise<void>
  upsertProvider(draft: ProviderDraft): Promise<boolean>
  probeProvider(providerId: string): Promise<void>
  acceptProviderImport(requestId: string): Promise<void>
  dismissProviderImport(requestId: string): Promise<void>
  deleteProvider(providerId: string): Promise<void>
  savePlugin(plugin: ProjectPluginRecord): Promise<void>
  deletePlugin(pluginId: string): Promise<void>
  savePreset(preset: ParameterPresetRecord): Promise<void>
  deletePreset(presetId: string): Promise<void>
  importPresets(): Promise<void>
  exportPresets(presetIds: readonly string[]): Promise<void>
  applyPresets(presetIds: readonly string[]): void
  cancelTask(taskId: string): Promise<void>
  toggleFavorite(assetId: string): Promise<void>
  reuseAsset(assetId: string, mode: 'prompt' | 'seed' | 'all'): void
  setCandidateDecision(assetId: string, decision: AssetItem['decision']): Promise<void>
  updateAssetTags(assetId: string, tags: readonly string[]): Promise<void>
  exportAssets(assetIds: readonly string[]): Promise<void>
  upsertBoard(board: Board): Promise<void>
  upsertSmartCollection(collection: SmartCollection): Promise<void>
  deleteCollection(collectionId: string, kind: BoardItem['kind']): Promise<void>
  addAssetsToBoard(boardId: string, assetIds: readonly string[]): Promise<void>
  createInpaintFromAsset(assetId: string, pngBase64: string, prompt: string, inputFidelity: 'low' | 'high'): Promise<void>
  ensureProjectImagePreview(graphId: string, nodeId: string, relativePath: string, force?: boolean): Promise<void>
  ensureResultImagePreview(graphId: string, nodeId: string, force?: boolean): Promise<void>
  hydrateRunResultPreviews(result: RunResult, projectPath: string, workflowId: string): Promise<void>
  copyText(text: string): Promise<void>
  setFilenameTemplate(value: string): void
  toggleSafeMode(): void
  toggleGridSnap(): void
  toggleMinimap(): void
  bootstrap(): Promise<void>
  refreshProviders(): Promise<void>
}

const initialRoot: GraphDocument = {
  id: 'root',
  label: '霓虹茶室 · 主工作流',
  nodes: initialNodes,
  edges: initialEdges,
}

const initialLinearDefinition: LinearViewDefinition = {
  id: 'default',
  title: '霓虹茶室 · 生成面板',
  description: '作者只公开必要参数；普通用户无需进入复杂画布。',
  fields: [
    { id: 'prompt', nodeId: 'brief', parameter: 'text', label: '提示词', group: '画面描述', order: 10 },
    { id: 'model', nodeId: 'generate', parameter: 'model', label: '模型', group: '生成设置', order: 20 },
    { id: 'size', nodeId: 'generate', parameter: 'size', label: '尺寸', group: '生成设置', order: 30 },
    { id: 'seed', nodeId: 'generate', parameter: 'seed', label: 'Seed', group: '生成设置', order: 40 },
    { id: 'count', nodeId: 'generate', parameter: 'count', label: '候选数量', group: '生成设置', order: 50 },
  ],
}

const emptyOnlineRoot: GraphDocument = {
  id: 'root',
  label: '等待账户分组',
  nodes: [],
  edges: [],
}

const initialRuntimeRoot = uiPreviewHarnessEnabled ? initialRoot : emptyOnlineRoot
const initialRuntimeLinearDefinition: LinearViewDefinition = uiPreviewHarnessEnabled
  ? initialLinearDefinition
  : { ...initialLinearDefinition, fields: [] }
const initialRuntimeLinearValues: Readonly<Record<string, string | number>> = uiPreviewHarnessEnabled
  ? {
      prompt: '雨夜里的未来主义茶室，电影级布光，细腻材质',
      model: DEFAULT_IMAGE_MODEL,
      size: '1536x1024',
      seed: 842019,
      count: 4,
    }
  : {}

const initialWorkflowTimestamp = uiPreviewHarnessEnabled
  ? '2026-07-13T09:24:00.000Z'
  : new Date(0).toISOString()
const initialWorkflowDocument: WorkflowDocument = {
  schemaVersion: 3,
  id: uiPreviewHarnessEnabled ? 'workflow-neon-teahouse' : 'workflow-online-pending',
  name: initialRuntimeRoot.label,
  revision: uiPreviewHarnessEnabled ? 18 : 1,
  nodes: nodesFromGraph(initialRuntimeRoot),
  edges: edgesFromGraph(initialRuntimeRoot),
  createdAt: initialWorkflowTimestamp,
  updatedAt: initialWorkflowTimestamp,
  ...(uiPreviewHarnessEnabled ? { metadata: { linearView: initialRuntimeLinearDefinition } } : {}),
  subgraphs: [],
}

const remoteImageNodeTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])

interface RemoteImageBinding {
  readonly providerId: string
  readonly model: string
}

const commonRemoteImageBinding = (
  graphs: Readonly<Record<string, GraphDocument>>,
  providers: readonly ProviderItem[],
): RemoteImageBinding | undefined => {
  const bindings = new Map<string, RemoteImageBinding>()
  Object.values(graphs).flatMap((graph) => graph.nodes).forEach((node) => {
    if (!remoteImageNodeTypes.has(node.data.nodeType)) return
    const providerId = String(node.data.parameters.providerId ?? '').trim()
    const model = String(node.data.parameters.model ?? '').trim()
    if (providerId && model) bindings.set(`${providerId}\u0000${model}`, { providerId, model })
  })
  if (bindings.size !== 1) return undefined
  const binding = [...bindings.values()][0]
  if (!binding) return undefined
  const provider = accountProviders(providers).find((item) => item.id === binding.providerId)
  return provider && providerModelOptions(provider).includes(binding.model) ? binding : undefined
}

const preferredProvider = (providers: readonly ProviderItem[]): ProviderItem | undefined =>
  accountProviders(providers)[0]

const createQuickStartWorkflow = (provider?: ProviderItem): WorkflowDocument => {
  const workflow = createCoreWorkflow('快速生图')
  const linearView: LinearViewDefinition = {
    id: 'quick-start',
    title: '快速生图',
    description: '模型在页面顶部统一选择；这里只调整提示词、尺寸和数量。',
    fields: [
      { id: 'prompt', nodeId: 'prompt', parameter: 'text', label: '提示词', group: '画面描述', order: 10 },
      { id: 'model', nodeId: 'generate', parameter: 'model', label: '模型', group: '生成设置', order: 20 },
      { id: 'size', nodeId: 'generate', parameter: 'size', label: '尺寸', group: '生成设置', order: 30 },
      { id: 'count', nodeId: 'generate', parameter: 'count', label: '数量', group: '生成设置', order: 40 },
    ],
  }
  return {
    ...workflow,
    nodes: [
      {
        id: 'prompt',
        type: 'text',
        name: '画面提示词',
        position: { x: 90, y: 170 },
        parameters: { text: '一座雨夜中的未来主义茶室，电影级布光，真实材质，清晰建筑线条' },
      },
      {
        id: 'generate',
        type: 'image_generation',
        name: '图像生成',
        position: { x: 450, y: 150 },
        parameters: {
          providerId: provider?.id ?? '',
          model: provider?.model ?? '',
          size: '1024x1024',
          quality: 'high',
          count: 1,
          outputFormat: 'png',
          outputCompression: 100,
          background: 'auto',
          moderation: 'auto',
        },
      },
      {
        id: 'preview',
        type: 'image_preview',
        name: '结果预览',
        position: { x: 825, y: 170 },
        parameters: {},
      },
    ],
    edges: [
      { id: 'prompt-generate', sourceNode: 'prompt', sourceSocket: 'text', targetNode: 'generate', targetSocket: 'prompt' },
      { id: 'generate-preview', sourceNode: 'generate', sourceSocket: 'images', targetNode: 'preview', targetSocket: 'images' },
    ],
    metadata: { linearView },
  }
}

const bindWorkflowProvider = (workflow: WorkflowDocument, provider: ProviderItem): WorkflowDocument => ({
  ...workflow,
  nodes: workflow.nodes.map((node) => remoteImageNodeTypes.has(node.type)
    ? { ...node, parameters: { ...node.parameters, providerId: provider.id, model: provider.model } }
    : node),
  ...(workflow.subgraphs ? {
    subgraphs: workflow.subgraphs.map((definition) => ({
      ...definition,
      workflow: bindWorkflowProvider(definition.workflow, provider),
    })),
  } : {}),
})

const plannedProviderIssue = (
  flattenedWorkflow: WorkflowDocument,
  plan: RunPlan,
  providers: readonly ProviderItem[],
): { readonly nodeId: string; readonly message: string } | undefined => {
  const nodes = new Map(flattenedWorkflow.nodes.map((node) => [node.id, node]))
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  for (const planned of plan.nodes) {
    if (planned.action !== 'execute') continue
    const node = nodes.get(planned.nodeId)
    if (!node || !remoteImageNodeTypes.has(node.type)) continue
    const providerId = String(node.parameters.providerId ?? '').trim()
    const provider = providerById.get(providerId)
    if (!provider || !isAiTerminalAccountProvider(provider)) return { nodeId: node.id, message: '图像工作流尚未选择可用分组' }
    if (!provider.hasSecret) {
      return { nodeId: node.id, message: `分组“${provider.groupId ?? provider.name}”当前不可用` }
    }
    const capabilityIssue = inspectWorkflowProviderCapabilities(flattenedWorkflow, providers, new Set([node.id]))[0]
    if (capabilityIssue) return { nodeId: capabilityIssue.nodeId, message: capabilityIssue.message }
    if (provider.kind === 'comfyui') {
      const comfyPrompt = node.parameters.comfyPrompt
      const hasComfyPrompt = typeof comfyPrompt === 'string'
        ? comfyPrompt.trim().length > 0
        : typeof comfyPrompt === 'object' && comfyPrompt !== null && !Array.isArray(comfyPrompt) && Object.keys(comfyPrompt).length > 0
      if (!hasComfyPrompt) {
        return { nodeId: node.id, message: `接口“${provider.name}”需要在生成节点中配置 ComfyUI API-format Workflow` }
      }
    }
  }
  return undefined
}

const quickProjectName = (): string => {
  const now = new Date()
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join('')
  return `AI 图像项目 ${date} ${time}`
}

const emptyWorkflowDocument = (projectName: string): WorkflowDocument => {
  const label = projectName.trim() || '未命名项目'
  const now = new Date().toISOString()
  return {
    schemaVersion: 3,
    id: uid(),
    name: `${label} · 主工作流`,
    revision: 0,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    metadata: {},
    presentation: {},
    subgraphs: [],
  }
}

const activeGraph = (state: Pick<StudioState, 'graphs' | 'activeGraphId'>): GraphDocument =>
  state.graphs[state.activeGraphId] ?? initialRoot

const handlePort = (node: StudioFlowNode, handleId: string | null | undefined, kind: 'input' | 'output'): CanvasPort | undefined => {
  if (!handleId) return undefined
  const id = handleId.replace(kind === 'input' ? /^in:/ : /^out:/, '')
  return (kind === 'input' ? node.data.inputs : node.data.outputs).find((port) => port.id === id)
}

const importedImageConnection = (
  graph: GraphDocument,
  sourceNodeId: string,
  selectedNodeId?: string,
): { readonly sourceSocket: string; readonly targetNode: string; readonly targetSocket: string } | undefined => {
  const source = graph.nodes.find((node) => node.id === sourceNodeId)
  if (!source) return undefined
  const candidates = graph.nodes.flatMap((node) => {
    if (!remoteImageNodeTypes.has(node.data.nodeType)) return []
    const targetSocket = node.data.inputs.some((port) => port.id === 'referenceImages')
      ? 'referenceImages'
      : node.data.inputs.some((port) => port.id === 'image') ? 'image' : undefined
    if (!targetSocket || graph.edges.some((edge) => edge.target === node.id
      && edge.targetHandle?.replace(/^in:/, '') === targetSocket)) return []
    const targetPort = node.data.inputs.find((port) => port.id === targetSocket)
    const sourcePort = source.data.outputs.find((port) => defaultRegistry.compatible(port.dataType, targetPort?.dataType ?? 'any'))
    return sourcePort ? [{ sourceSocket: sourcePort.id, targetNode: node.id, targetSocket }] : []
  })
  return candidates.find((candidate) => candidate.targetNode === selectedNodeId)
    ?? (candidates.length === 1 ? candidates[0] : undefined)
}

const remoteBridge = (): StudioBridge | undefined =>
  (window as unknown as { readonly onekey?: { readonly studio?: StudioBridge } }).onekey?.studio

/* In-app fallback clipboard; survives even when the system clipboard is denied. */
let studioNodeClipboard: WorkflowEditorClipboardPayload | undefined

const workflowEditorSession = createWorkflowEditorSession({
  persistence: {
    save: async (scope, workflow) => {
      const bridge = remoteBridge()
      if (!bridge) throw new Error('未检测到 Electron Studio 桥')
      return bridge.saveWorkflow({ projectPath: scope.projectPath, workflow })
    },
    saveDraft: async (scope, workflow) => {
      const bridge = remoteBridge()
      if (!bridge || typeof bridge.saveWorkflowDraft !== 'function') throw new Error('当前桌面版本不支持 Workflow 草稿')
      await bridge.saveWorkflowDraft({ projectPath: scope.projectPath, workflow })
    },
    discardDraft: async (scope) => {
      const bridge = remoteBridge()
      if (!bridge || typeof bridge.discardWorkflowDraft !== 'function') return
      await bridge.discardWorkflowDraft({ projectPath: scope.projectPath, workflowId: scope.workflowId })
    },
  },
  draftEnabled: true,
  readinessProviders: readinessProvidersFromItems(uiPreviewHarnessEnabled ? providerSeed : []),
})
workflowEditorSession.open({ workflowId: initialWorkflowDocument.id }, initialWorkflowDocument)
workflowEditorSession.dispatch(createWorkflowRuntimeProjectionCommand({ root: initialRuntimeRoot }))

type WorkflowEditorSessionProjection = Omit<WorkflowEditorStoreProjection, 'activeGraphId' | 'selectedNodeId'>

type WorkflowDocumentState = Pick<WorkflowEditorSessionProjection,
  'workflowDocument' | 'workflowId' | 'workflowRevision' | 'subgraphDefinitions' |
  'workflowDirty' | 'draftSaving' | 'workflowReadiness' | 'canUndo' | 'canRedo'>

const workflowDocumentState = (snapshot: WorkflowEditorSessionSnapshot): WorkflowDocumentState => {
  const workflow = snapshot.document
  if (!workflow || !snapshot.readiness) throw new Error('Workflow 编辑会话尚未打开')
  return {
    workflowDocument: workflow,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    subgraphDefinitions: workflow.subgraphs ?? [],
    workflowDirty: snapshot.dirty,
    draftSaving: snapshot.draftSaving,
    workflowReadiness: snapshot.readiness,
    canUndo: snapshot.history.canUndo,
    canRedo: snapshot.history.canRedo,
  }
}

type WorkflowProjectionState = WorkflowEditorSessionProjection

const workflowProjectionState = (snapshot: WorkflowEditorSessionSnapshot): WorkflowProjectionState => {
  if (!snapshot.linear) throw new Error('Workflow 编辑会话尚未打开')
  return {
    graphs: snapshot.graphs,
    linearDefinition: snapshot.linear.definition,
    linearValues: snapshot.linear.values,
    ...workflowDocumentState(snapshot),
  }
}

const workflowRuntimeProjectionState = (
  graphs: Readonly<Record<string, GraphDocument>>,
): Pick<WorkflowEditorStoreProjection, 'graphs'> => ({
  graphs: workflowEditorSession.dispatch(createWorkflowRuntimeProjectionCommand(graphs)).snapshot.graphs,
})

const workflowProviderProjectionState = (
  providers: readonly ProviderItem[],
): Pick<StudioState, 'providers' | 'workflowReadiness'> => {
  const snapshot = workflowEditorSession.dispatch({
    kind: 'readiness/set-providers',
    providers: readinessProvidersFromItems(providers),
  }).snapshot
  if (!snapshot.readiness) throw new Error('Workflow 编辑会话尚未打开')
  return { providers, workflowReadiness: snapshot.readiness }
}

const workflowStoreCoordinator = createWorkflowStoreCoordinator()

const workflowSessionScopeIdentity = (state: Pick<StudioState,
  'projectPath' | 'workflowId' | 'workflowRevision'>): WorkflowOperationIdentity | undefined => {
  const snapshot = workflowEditorSession.getSnapshot()
  if (!snapshot.scope || !snapshot.document
    || snapshot.scope.projectPath !== state.projectPath
    || snapshot.scope.workflowId !== state.workflowId) return undefined
  return {
    projectPath: state.projectPath,
    workflowId: state.workflowId,
    revision: snapshot.document.revision,
    editGeneration: snapshot.editGeneration,
  }
}

const workflowOperationIdentity = (state: Pick<StudioState,
  'projectPath' | 'workflowId' | 'workflowRevision'>): WorkflowOperationIdentity | undefined => {
  const identity = workflowSessionScopeIdentity(state)
  return identity?.revision === state.workflowRevision ? identity : undefined
}

const requireWorkflowOperationIdentity = (state: Pick<StudioState,
  'projectPath' | 'workflowId' | 'workflowRevision'>): WorkflowOperationIdentity => {
  const identity = workflowOperationIdentity(state)
  if (!identity) throw new Error('Workflow Store 与文档会话的作用域不一致')
  return identity
}

const beginWorkflowOperation = (state: Pick<StudioState,
  'projectPath' | 'workflowId' | 'workflowRevision'>): WorkflowOperationTicket =>
  workflowStoreCoordinator.beginRequest(requireWorkflowOperationIdentity(state))

const isCurrentWorkflowOperation = (
  ticket: WorkflowOperationTicket,
  state: Pick<StudioState, 'projectPath' | 'workflowId' | 'workflowRevision'>,
): boolean => {
  return workflowStoreCoordinator.current(ticket, workflowOperationIdentity(state))
}

const flushBeforeWorkflowScopeChange = (
  ticket: WorkflowOperationTicket,
  getState: () => Pick<StudioState, 'projectPath' | 'workflowId' | 'workflowRevision'>,
) => workflowStoreCoordinator.flushDraftThenCommit(
  ticket,
  () => workflowOperationIdentity(getState()),
  () => workflowEditorSession.flushDraft(),
  () => undefined,
)

const workflowEditorState = (
  workflow: WorkflowDocument,
  projectPath?: string,
  options: { readonly dirty?: boolean } = {},
): WorkflowEditorStoreProjection => {
  workflowEditorSession.open({ ...(projectPath ? { projectPath } : {}), workflowId: workflow.id }, workflow, options)
  const snapshot = workflowEditorSession.getSnapshot()
  workflowStoreCoordinator.beginScope({
    projectPath,
    workflowId: workflow.id,
    revision: workflow.revision,
    editGeneration: snapshot.editGeneration,
  })
  return {
    activeGraphId: 'root',
    selectedNodeId: workflow.nodes[0]?.id,
    ...workflowProjectionState(snapshot),
  }
}

const emptyEditorState = (projectName: string, projectPath?: string) =>
  workflowEditorState(emptyWorkflowDocument(projectName), projectPath)

type SynchronizedWorkflowEditorState = WorkflowEditorStoreProjection

const synchronizedWorkflowEditorState = (
  state: Pick<StudioState, 'graphs' | 'activeGraphId' | 'selectedNodeId'>,
  snapshot: WorkflowEditorSessionSnapshot,
): SynchronizedWorkflowEditorState => {
  const graphs = snapshot.graphs
  const activeGraphId = graphs[state.activeGraphId] ? state.activeGraphId : 'root'
  const selectedNodeId = state.selectedNodeId
    && graphs[activeGraphId]?.nodes.some((node) => node.id === state.selectedNodeId)
    ? state.selectedNodeId
    : undefined
  return {
    ...workflowProjectionState(snapshot),
    activeGraphId,
    selectedNodeId,
  }
}

const interruptedBootstrapState = (
  state: StudioState,
): Pick<StudioState, 'connectionState' | 'graphs' | 'linearDefinition' | 'linearValues' | 'workflowReadiness'> => {
  const snapshot = workflowEditorSession.dispatch(createWorkflowRuntimeProjectionCommand(state.graphs)).snapshot
  if (!snapshot.linear || !snapshot.readiness) throw new Error('Workflow 编辑会话尚未打开')
  return {
    connectionState: 'idle',
    graphs: snapshot.graphs,
    linearDefinition: snapshot.linear.definition,
    linearValues: snapshot.linear.values,
    workflowReadiness: snapshot.readiness,
  }
}

const replaceWorkflowDocument = (
  state: StudioState,
  document: WorkflowDocument,
  reason: Extract<Parameters<typeof workflowEditorSession.dispatch>[0], { kind: 'document/replace' }>['reason'],
): WorkflowProjectionState => workflowProjectionState(workflowEditorSession.dispatch({
  kind: 'document/replace',
  document,
  reason,
  context: {
    graphId: state.activeGraphId,
    ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
  },
}).snapshot)

const initialWorkflowProjection = workflowProjectionState(workflowEditorSession.getSnapshot())

const studioRunSession = new StudioSessionController()
const promptMatrixSession = new PromptMatrixSessionController()
let promptMatrixPrepareEpoch = 0
const clearPreparedRunSessions = (): void => {
  studioRunSession.clear()
  promptMatrixPrepareEpoch += 1
  promptMatrixSession.clear()
}
const clearedPreparedRunState = () => ({
  pendingPlan: undefined,
  pendingWorkflow: undefined,
  pendingMatrixRuns: [],
  pendingMatrixPrepareGeneration: undefined,
  pendingTargetNodeIds: [],
})
let runSessionStoreUnsubscribe: (() => void) | undefined
const assetPreviewRequests = new Set<string>()
const projectImagePreviewRequests = new Set<string>()
const resultImagePreviewRequests = new Set<string>()
let projectLoadEpoch = 0
let textInputRequestSequence = 0
let textInputResolver: ((value: string | undefined) => void) | undefined

const defaultFilenameTemplate = '{date}_{workflow}_{model}_{seed}_{index}'
const readFilenameTemplate = (): string => {
  try { return window.localStorage.getItem('studio.filenameTemplate')?.trim() || defaultFilenameTemplate } catch { return defaultFilenameTemplate }
}
const readBooleanPreference = (key: string, fallback: boolean): boolean => {
  try {
    const value = window.localStorage.getItem(key)
    return value === null ? fallback : value === 'true'
  } catch { return fallback }
}
const writeBooleanPreference = (key: string, value: boolean): void => {
  try { window.localStorage.setItem(key, String(value)) } catch { /* non-persistent renderer */ }
}

const readProjectSnapshot = async (bridge: StudioBridge, projectPath: string) => {
  const [workflows, rawAssets, tasks, runs, collections, plugins, presets, persistentRuns] = await Promise.all([
    bridge.listWorkflows(projectPath),
    bridge.listAssets({ projectPath }),
    bridge.listTasks({ projectPath }),
    bridge.listRuns({ projectPath }),
    bridge.listCollections({ projectPath }),
    bridge.listPlugins({ projectPath }),
    bridge.listPresets({ projectPath }),
    typeof bridge.listPersistentRuns === 'function' ? bridge.listPersistentRuns({ projectPath }) : Promise.resolve([]),
  ])
  const assets = rawAssets.map((asset, index) => mapAsset(asset, index))
  const workflow = workflows[0]
  const draft = workflow && typeof bridge.loadWorkflowDraft === 'function'
    ? await bridge.loadWorkflowDraft({ projectPath, workflowId: workflow.id }).catch(() => undefined)
    : undefined
  return {
    workflows,
    workflow,
    assets,
    boards: buildBoardItems(assets, collections),
    queue: mergeQueue(tasks, runs, persistentRuns),
    runs,
    plugins,
    presets,
    draft,
  }
}

const recoverableDraft = (
  formal: WorkflowDocument | undefined,
  draft: Awaited<ReturnType<StudioBridge['loadWorkflowDraft']>>,
): PendingDraftRecovery | undefined => {
  if (!formal || !draft) return undefined
  if (workflowPlanFingerprint(formal) === workflowPlanFingerprint(draft.workflow)) return undefined
  const conflicted = draft.baseRevision !== formal.revision
  if (!conflicted && Date.parse(draft.savedAt) <= Date.parse(formal.updatedAt)) return undefined
  return {
    baseRevision: draft.baseRevision,
    conflicted,
    savedAt: draft.savedAt,
    workflow: draft.workflow,
    changes: diffWorkflows(formal, draft.workflow),
  }
}

const upsertFormalWorkflow = (
  workflows: readonly WorkflowDocument[],
  formalDocument: WorkflowDocument,
): readonly WorkflowDocument[] => {
  const existing = workflows.find((workflow) => workflow.id === formalDocument.id)
  const accepted = existing && existing.revision > formalDocument.revision ? existing : formalDocument
  return [accepted, ...workflows.filter((workflow) => workflow.id !== formalDocument.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export const useStudioStore = create<StudioState>((set, get) => ({
  page: 'workflow',
  workflowView: 'canvas',
  bottomPanel: 'live',
  bottomOpen: true,
  modal: 'none',
  textInputRequest: undefined,
  graphs: initialWorkflowProjection.graphs,
  activeGraphId: 'root',
  selectedNodeId: uiPreviewHarnessEnabled ? 'generate' : undefined,
  selectedAssetId: uiPreviewHarnessEnabled ? 'a1' : '',
  selectedBoardId: 'all',
  selectedQueueId: uiPreviewHarnessEnabled ? 'task-1042' : '',
  assets: uiPreviewHarnessEnabled ? assetsSeed : [],
  boards: uiPreviewHarnessEnabled ? boardsSeed : buildBoardItems([], { schemaVersion: 1, boards: [], smartCollections: [] }),
  queue: uiPreviewHarnessEnabled ? queueSeed : [],
  providers: uiPreviewHarnessEnabled ? providerSeed : [],
  pendingProviderImports: [],
  providerImportBusy: undefined,
  plugins: [],
  presets: [],
  lastPresetDiffs: [],
  runs: uiPreviewHarnessEnabled ? runSeed : [],
  selectedRunId: uiPreviewHarnessEnabled ? runSeed[0]?.runId : undefined,
  timeline: uiPreviewHarnessEnabled ? timelineSeed : emptyTimeline(),
  compatiblePicker: undefined,
  toast: undefined,
  connectionState: uiPreviewHarnessEnabled ? 'demo' : 'idle',
  appVersion: uiPreviewHarnessEnabled ? '1.0.0-preview' : '0.1.2',
  projectPath: undefined,
  projectName: undefined,
  availableProjects: [],
  workflows: [],
  workflowDocument: initialWorkflowProjection.workflowDocument,
  workflowId: initialWorkflowProjection.workflowId,
  workflowRevision: initialWorkflowProjection.workflowRevision,
  workflowDirty: initialWorkflowProjection.workflowDirty,
  subgraphDefinitions: initialWorkflowProjection.subgraphDefinitions,
  workflowReadiness: initialWorkflowProjection.workflowReadiness,
  pendingPlan: undefined,
  pendingWorkflow: undefined,
  pendingMatrixRuns: [],
  pendingMatrixPrepareGeneration: undefined,
  pendingTargetNodeIds: [],
  safeMode: readBooleanPreference('studio.safeMode', true),
  gridSnap: readBooleanPreference('studio.gridSnap', true),
  showMinimap: readBooleanPreference('studio.showMinimap', true),
  linearValues: initialWorkflowProjection.linearValues,
  linearDefinition: initialWorkflowProjection.linearDefinition,
  filenameTemplate: readFilenameTemplate(),
  localImageImporting: false,
  draftSaving: initialWorkflowProjection.draftSaving,
  pendingDraftRecovery: undefined,
  workflowVersions: [],
  archivedWorkflows: [],
  canUndo: initialWorkflowProjection.canUndo,
  canRedo: initialWorkflowProjection.canRedo,
  navigate: (page) => set({ page }),
  setWorkflowView: (workflowView) => set({ workflowView }),
  setBottomPanel: (bottomPanel) => set({ bottomPanel, bottomOpen: true }),
  toggleBottom: () => set((state) => ({ bottomOpen: !state.bottomOpen })),
  openModal: (modal) => set({ modal }),
  closeModal: () => {
    if (get().textInputRequest) {
      get().resolveTextInput()
      return
    }
    if (get().modal === 'run-confirm') clearPreparedRunSessions()
    set((state) => {
      const modal = state.pendingDraftRecovery && state.modal !== 'draft-recovery' ? 'draft-recovery' : 'none'
      return state.modal === 'run-confirm'
        ? {
            modal,
            pendingPlan: undefined,
            pendingWorkflow: undefined,
            pendingMatrixRuns: [],
            pendingMatrixPrepareGeneration: undefined,
            pendingTargetNodeIds: [],
          }
        : { modal }
    })
  },
  requestTextInput: (request) => new Promise((resolve) => {
    textInputResolver?.(undefined)
    textInputResolver = resolve
    set({ textInputRequest: { ...request, id: ++textInputRequestSequence } })
  }),
  resolveTextInput: (value) => {
    const resolve = textInputResolver
    textInputResolver = undefined
    set({ textInputRequest: undefined })
    resolve?.(value)
  },
  setSelectedNode: (selectedNodeId) => set({ selectedNodeId }),
  selectAsset: (selectedAssetId) => set({ selectedAssetId }),
  selectBoard: (selectedBoardId) => set({ selectedBoardId }),
  selectQueue: (selectedQueueId) => set({ selectedQueueId }),
  selectRun: (selectedRunId) => set({ selectedRunId }),
  restoreRunSnapshot: (runId) => {
    const state = get()
    const run = state.runs.find((candidate) => candidate.runId === runId)
    if (!run?.workflowSnapshot) {
      set({ toast: '这条旧运行记录没有可复现快照，当前画布未改变' })
      return
    }
    const formal = state.workflows.find((workflow) => workflow.id === run.workflowId)
    if (!formal) {
      set({ toast: '运行记录对应的正式 Workflow 已不在当前项目；请先从 Workflow 包恢复它' })
      return
    }
    clearPreparedRunSessions()
    const restored: WorkflowDocument = {
      ...structuredClone(run.workflowSnapshot),
      id: formal.id,
      name: formal.name,
      metadata: {
        ...(run.workflowSnapshot.metadata ?? {}),
        restoredFromRunId: run.runId,
        restoredFromWorkflowHash: run.workflowHash ?? 'legacy-unverified',
        restoredTargetNodeIds: [...(run.targetNodeIds ?? [])],
      },
    }
    set({
      ...replaceWorkflowDocument(state, restored, 'run-snapshot'),
      page: 'workflow',
      activeGraphId: 'root',
      selectedNodeId: restored.nodes[0]?.id,
      modal: 'none',
      pendingPlan: undefined,
      pendingWorkflow: undefined,
      pendingMatrixRuns: [],
      pendingMatrixPrepareGeneration: undefined,
      pendingTargetNodeIds: [],
      toast: `已从 ${run.runId} 恢复为未保存草稿；不会自动运行，运行前会重新预检`,
    })
  },
  onNodesChange: (changes) => set((state) => workflowProjectionState(workflowEditorSession.dispatch({
    kind: 'canvas/apply-node-changes',
    graphId: state.activeGraphId,
    changes,
    context: {
      graphId: state.activeGraphId,
      ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
    },
  }).snapshot)),
  onEdgesChange: (changes) => set((state) => workflowProjectionState(workflowEditorSession.dispatch({
    kind: 'canvas/apply-edge-changes',
    graphId: state.activeGraphId,
    changes,
    context: {
      graphId: state.activeGraphId,
      ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
    },
  }).snapshot)),
  connect: (connection) => {
    const state = get()
    const graph = activeGraph(state)
    if (!connection.source || !connection.target) return get().showToast('无法连接：缺少起点或终点节点')
    const source = graph.nodes.find((node) => node.id === connection.source)
    const target = graph.nodes.find((node) => node.id === connection.target)
    if (!source || !target) return get().showToast('无法连接：节点不存在')
    const output = handlePort(source, connection.sourceHandle, 'output')
    const input = handlePort(target, connection.targetHandle, 'input')
    if (!output || !input || !defaultRegistry.compatible(output.dataType, input.dataType)) {
      return get().showToast('端口类型不兼容')
    }
    const providerId = String(target.data.parameters.providerId ?? '').trim()
    const capabilityIssue = inspectProviderConnectionCapability({
      provider: state.providers.find((provider) => provider.id === providerId),
      targetNode: {
        id: target.id,
        type: target.data.nodeType,
        name: target.data.label,
        parameters: target.data.parameters,
      },
      targetSocket: input.id,
    })
    if (capabilityIssue) return get().showToast(capabilityIssue.message)
    try {
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/connect',
        graphId: state.activeGraphId,
        sourceNode: source.id,
        sourceSocket: output.id,
        targetNode: target.id,
        targetSocket: input.id,
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set(workflowProjectionState(transition.snapshot))
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '节点连接失败')
    }
  },
  addNode: (type, position) => {
    try {
      const state = get()
      const graph = activeGraph(state)
      const generationBinding = remoteImageNodeTypes.has(type)
        ? commonRemoteImageBinding(state.graphs, state.providers)
        : undefined
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/add-node',
        graphId: state.activeGraphId,
        nodeType: type,
        position: position ?? { x: 540 + graph.nodes.length * 18, y: 180 + graph.nodes.length * 12 },
        ...(generationBinding ? { generationBinding } : {}),
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
      })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '节点添加失败')
    }
  },
  addSubgraphInstance: (definitionId, position) => {
    const state = get()
    const definition = state.subgraphDefinitions.find((item) => item.id === definitionId)
    if (!definition) return get().showToast('子图库中不存在该定义')
    const graph = activeGraph(state)
    try {
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/add-subgraph-instance',
        graphId: state.activeGraphId,
        definitionId,
        position: position ?? { x: 540 + graph.nodes.length * 18, y: 180 + graph.nodes.length * 12 },
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
        toast: `已添加共享子图“${definition.name}”`,
      })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '子图实例添加失败')
    }
  },
  addCompatibleNode: (type) => {
    const picker = get().compatiblePicker
    if (!picker) return
    const state = get()
    const graph = activeGraph(state)
    try {
      if (type.startsWith('subgraph:')) {
        const definition = state.subgraphDefinitions.find((item) => item.id === type.slice('subgraph:'.length))
        if (!definition) return get().showToast('子图库中不存在该定义')
        const transition = workflowEditorSession.dispatch({
          kind: 'canvas/add-subgraph-instance',
          graphId: state.activeGraphId,
          definitionId: definition.id,
          position: { x: picker.x, y: picker.y },
          source: {
            nodeId: picker.sourceNodeId,
            socket: picker.sourceHandle.replace(/^out:/, ''),
          },
          context: {
            graphId: state.activeGraphId,
            ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
          },
        })
        set({
          ...workflowProjectionState(transition.snapshot),
          selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
          compatiblePicker: undefined,
          toast: `已添加并连接共享子图“${definition.name}”`,
        })
        return
      }
      const generationBinding = remoteImageNodeTypes.has(type)
        ? commonRemoteImageBinding(state.graphs, state.providers)
        : undefined
      const next = makeNode(uid(), type, { x: picker.x, y: picker.y }, generationBinding
        ? { parameters: { providerId: generationBinding.providerId, model: generationBinding.model } }
        : {})
      const targetPort = next.data.inputs.find((port) => defaultRegistry.compatible(picker.dataType, port.dataType))
      if (!targetPort) return get().showToast('所选节点没有兼容输入')
      const providerId = String(next.data.parameters.providerId ?? '').trim()
      const capabilityIssue = inspectProviderConnectionCapability({
        provider: state.providers.find((provider) => provider.id === providerId),
        targetNode: { id: next.id, type: next.data.nodeType, name: next.data.label, parameters: next.data.parameters },
        targetSocket: targetPort.id,
      })
      if (capabilityIssue) return get().showToast(capabilityIssue.message)
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/add-compatible-node',
        graphId: state.activeGraphId,
        nodeType: type,
        position: { x: picker.x, y: picker.y },
        sourceNode: picker.sourceNodeId,
        sourceSocket: picker.sourceHandle.replace(/^out:/, ''),
        ...(generationBinding ? { generationBinding } : {}),
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        compatiblePicker: undefined,
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
      })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '节点添加失败')
    }
  },
  openCompatiblePicker: (compatiblePicker) => set({ compatiblePicker }),
  closeCompatiblePicker: () => set({ compatiblePicker: undefined }),
  undoEditor: () => set((state) => {
    if (!state.canUndo) return { toast: '没有可撤销的画布操作' }
    const transition = workflowEditorSession.dispatch({
      kind: 'history/undo',
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    const focus = transition.effect?.kind === 'focus-canvas' ? transition.effect : undefined
    return {
      ...workflowProjectionState(transition.snapshot),
      activeGraphId: focus?.graphId ?? state.activeGraphId,
      selectedNodeId: focus?.nodeId,
      toast: '已撤销画布操作',
    }
  }),
  redoEditor: () => set((state) => {
    if (!state.canRedo) return { toast: '没有可重做的画布操作' }
    const transition = workflowEditorSession.dispatch({
      kind: 'history/redo',
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    const focus = transition.effect?.kind === 'focus-canvas' ? transition.effect : undefined
    return {
      ...workflowProjectionState(transition.snapshot),
      activeGraphId: focus?.graphId ?? state.activeGraphId,
      selectedNodeId: focus?.nodeId,
      toast: '已重做画布操作',
    }
  }),
  autoLayoutWorkflow: (scope = 'all') => set((state) => {
    const graph = activeGraph(state)
    const selectedIds = scope === 'selected'
      ? graph.nodes.filter((node) => node.selected || node.id === state.selectedNodeId).map((node) => node.id)
      : undefined
    if (scope === 'selected' && selectedIds?.length === 0) return { toast: '请先选择要自动整理的节点' }
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/auto-layout',
      graphId: state.activeGraphId,
      ...(selectedIds ? { nodeIds: selectedIds } : {}),
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    if (!transition.documentChanged) return { toast: scope === 'selected' ? '所选节点已经排列整齐' : '当前画布已经排列整齐' }
    return {
      ...workflowProjectionState(transition.snapshot),
      toast: `已自动整理${scope === 'selected' ? '所选节点' : '当前画布'}；Frame 与 Note 保持原位`,
    }
  }),
  arrangeSelectedNodes: (arrangement) => set((state) => {
    const graph = activeGraph(state)
    const selectedNodes = graph.nodes.filter((node) => node.selected || node.id === state.selectedNodeId)
    const selectedIds = selectedNodes.map((node) => node.id)
    if (selectedIds.length < 2) return { toast: '请至少选择两个节点' }
    const sizes = Object.fromEntries(selectedNodes.map((node) => [node.id, {
      width: node.measured?.width ?? node.width ?? 0,
      height: node.measured?.height ?? node.height ?? 0,
    }]))
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/arrange-selection',
      graphId: state.activeGraphId,
      nodeIds: selectedIds,
      arrangement,
      sizes,
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    const labels = {
      'align-left': '左对齐',
      'align-right': '右对齐',
      'align-top': '顶部对齐',
      'align-bottom': '底部对齐',
      'align-center-horizontal': '水平居中',
      'align-center-vertical': '垂直居中',
      'distribute-horizontal': '水平等距',
      'distribute-vertical': '垂直等距',
    } as const
    return {
      ...workflowProjectionState(transition.snapshot),
      toast: transition.documentChanged ? `已将 ${selectedIds.length} 个节点${labels[arrangement]}` : '所选节点已经排列整齐',
    }
  }),
  applyCopilotOperations: (operations, generationBinding) => {
    const state = get()
    if (state.activeGraphId !== 'root') {
      get().showToast('请返回主工作流后再应用助手计划')
      return
    }
    const addsRemoteNode = operations.some((operation) =>
      operation.kind === 'add-node' && remoteImageNodeTypes.has(operation.nodeType))
    if (addsRemoteNode) {
      const provider = generationBinding
        ? accountProviders(state.providers).find((item) => item.id === generationBinding.providerId)
        : undefined
      if (!provider || !generationBinding || !providerModelOptions(provider).includes(generationBinding.model)) {
        get().showToast('计划包含图片节点，请先在页面顶部选择分组和模型')
        return
      }
    }
    try {
      const result = applyStudioCopilotOperations(workflowEditorSession, {
        operations,
        graphId: state.activeGraphId,
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
        ...(generationBinding ? { generationBinding } : {}),
      })
      set({
        ...workflowProjectionState(result.snapshot),
        selectedNodeId: result.selectedNodeId,
        toast: `已应用 ${result.changedOperations} 项工作流变更，可使用撤销恢复`,
      })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '工作流计划应用失败')
    }
  },
  resizeFrame: (nodeId, width, height) => set((state) => {
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/resize-frame',
      graphId: state.activeGraphId,
      nodeId,
      width,
      height,
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    return workflowProjectionState(transition.snapshot)
  }),
  updateNodeData: (nodeId, patch) => set((state) => {
    const graph = activeGraph(state)
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return {}
    const debugOverride = patch.pinned === true
      ? { action: 'pin' as const, value: patch.debugOutput ?? node.data.debugOutput }
      : patch.mocked === true
        ? { action: 'mock' as const, value: patch.debugOutput ?? node.data.debugOutput }
        : patch.pinned === false || patch.mocked === false ? null : undefined
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/update-nodes',
      graphId: state.activeGraphId,
      updates: [{
        nodeId,
        ...(patch.label === undefined ? {} : { name: patch.label }),
        ...(patch.parameters === undefined ? {} : { parameters: patch.parameters }),
        ...(patch.annotation === undefined ? {} : { annotation: patch.annotation }),
        ...(patch.bypassed === undefined ? {} : { bypassed: patch.bypassed }),
        ...(patch.collapsed === undefined ? {} : { collapsed: patch.collapsed }),
        ...(debugOverride === undefined ? {} : { debugOverride }),
      }],
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    return workflowProjectionState(transition.snapshot)
  }),
  updateNodeParameter: (nodeId, key, value) => {
    const state = get()
    const graph = activeGraph(state)
    const node = graph.nodes.find((item) => item.id === nodeId)
    if (!node) return
    if (key === 'providerId') {
      const provider = state.providers.find((item) => item.id === String(value))
      get().updateNodeData(nodeId, {
        parameters: {
          ...node.data.parameters,
          providerId: value,
          model: provider?.model ?? '',
        },
      })
      return
    }
    get().updateNodeData(nodeId, { parameters: { ...node.data.parameters, [key]: value } })
  },
  bindAccountGroup: (providerId, requestedModel) => set((state) => {
    const provider = accountProviders(state.providers).find((item) => item.id === providerId)
    if (!provider) return { toast: '请选择分组' }
    const availableModels = providerModelOptions(provider)
    const model = requestedModel && availableModels.includes(requestedModel) ? requestedModel : provider.model
    const changed = Object.values(state.graphs).flatMap((graph) => graph.nodes).filter((node) =>
      remoteImageNodeTypes.has(node.data.nodeType)
      && (node.data.parameters.providerId !== provider.id || node.data.parameters.model !== model)).length
    if (changed === 0) return { toast: `当前工作流已使用“${accountGroupLabel(provider)} / ${model}”` }
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/bind-generation-provider',
      providerId: provider.id,
      model,
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    return {
      ...workflowProjectionState(transition.snapshot),
      toast: `已将 ${changed} 个生图与编辑节点切换到“${accountGroupLabel(provider)} / ${model}”`,
    }
  }),
  toggleNodeFlag: (nodeId, flag) => {
    const node = activeGraph(get()).nodes.find((item) => item.id === nodeId)
    if (!node) return
    const enabled = !node.data[flag]
    if (flag === 'pinned' || flag === 'mocked') {
      get().updateNodeData(nodeId, {
        [flag]: enabled,
        ...(enabled ? { [flag === 'pinned' ? 'mocked' : 'pinned']: false } : {}),
        ...(enabled && node.data.debugOutput === undefined ? { debugOutput: defaultDebugOutput(node) } : {}),
      })
      return
    }
    get().updateNodeData(nodeId, { [flag]: enabled })
  },
  removeSelectedNodes: () => set((state) => {
    const graph = activeGraph(state)
    const ids = new Set(graph.nodes.filter((node) => node.selected || node.id === state.selectedNodeId).map((node) => node.id))
    // Selected edges whose endpoints stay behind must be removed explicitly;
    // node removal already drops edges attached to removed nodes.
    const selectedEdgeIds = graph.edges
      .filter((edge) => edge.selected === true && !ids.has(edge.source) && !ids.has(edge.target))
      .map((edge) => edge.id)
    if (ids.size === 0 && selectedEdgeIds.length === 0) return {}
    const context = {
      graphId: state.activeGraphId,
      ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
    }
    let snapshot: WorkflowEditorSessionSnapshot | undefined
    if (selectedEdgeIds.length > 0) {
      snapshot = workflowEditorSession.dispatch({
        kind: 'canvas/apply-edge-changes',
        graphId: state.activeGraphId,
        changes: selectedEdgeIds.map((id) => ({ type: 'remove' as const, id })),
        context,
      }).snapshot
    }
    if (ids.size > 0) {
      snapshot = workflowEditorSession.dispatch({
        kind: 'canvas/remove-nodes',
        graphId: state.activeGraphId,
        nodeIds: [...ids],
        context,
      }).snapshot
    }
    if (!snapshot) return {}
    return {
      ...workflowProjectionState(snapshot),
      ...(ids.size > 0 ? { selectedNodeId: undefined } : {}),
    }
  }),
  duplicateSelectedNodes: () => set((state) => {
    const graph = activeGraph(state)
    const selected = graph.nodes.filter((node) => node.selected || node.id === state.selectedNodeId)
    if (selected.length === 0) return { toast: '请先选择要复制的节点' }
    const ids = new Set(selected.map((node) => node.id))
    const copiedEdgeCount = graph.edges.filter((item) => ids.has(item.source) && ids.has(item.target)).length
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/duplicate-nodes',
      graphId: state.activeGraphId,
      nodeIds: [...ids],
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    return {
      ...workflowProjectionState(transition.snapshot),
      selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
      toast: `已复制 ${selected.length} 个节点${copiedEdgeCount ? `及 ${copiedEdgeCount} 条内部连线` : ''}`,
    }
  }),
  copySelectedNodes: () => {
    const state = get()
    const graph = activeGraph(state)
    const selectedIds = graph.nodes
      .filter((node) => node.selected || node.id === state.selectedNodeId)
      .map((node) => node.id)
    if (selectedIds.length === 0) return get().showToast('请先选择要复制的节点')
    const payload = workflowEditorSession.getClipboardPayload(state.activeGraphId, selectedIds)
    if (!payload) return get().showToast('所选内容暂时无法复制')
    studioNodeClipboard = payload
    try {
      void navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => {})
    } catch {
      // System clipboard is best-effort; the in-app clipboard already holds the payload.
    }
    get().showToast(`已复制 ${payload.nodes.length} 个节点${payload.edges.length ? `及 ${payload.edges.length} 条内部连线` : ''}，Ctrl+V 粘贴`)
  },
  pasteCopiedNodes: async (position) => {
    let payload = studioNodeClipboard
    try {
      const text = await navigator.clipboard?.readText()
      const parsed = text ? parseWorkflowClipboardPayload(text) : undefined
      if (parsed) payload = parsed
    } catch {
      // Clipboard read denied — fall back to the in-app clipboard.
    }
    if (!payload) return get().showToast('剪贴板里没有可粘贴的节点')
    const state = get()
    try {
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/paste-nodes',
        graphId: state.activeGraphId,
        payload,
        ...(position ? { position } : {}),
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
        toast: `已粘贴 ${payload.nodes.length} 个节点`,
      })
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '粘贴失败：内容与当前工作流不兼容')
    }
  },
  connectSelectedNodes: () => {
    const state = get()
    const graph = activeGraph(state)
    const selected = graph.nodes.filter((node) => node.selected || node.id === state.selectedNodeId)
    if (selected.length !== 2) return get().showToast('请恰好选择两个节点后再快捷连接')
    const ordered = [...selected].sort((left, right) => left.position.x - right.position.x)
    const findPair = (source: StudioFlowNode, target: StudioFlowNode) => {
      for (const output of source.data.outputs) {
        for (const input of target.data.inputs) {
          const occupied = graph.edges.some((edge) => edge.target === target.id
            && edge.targetHandle?.replace(/^in:/, '') === input.id)
          if (!occupied && defaultRegistry.compatible(output.dataType, input.dataType)) {
            return { source, target, output, input }
          }
        }
      }
      return undefined
    }
    const pair = findPair(ordered[0]!, ordered[1]!) ?? findPair(ordered[1]!, ordered[0]!)
    if (!pair) return get().showToast('两个节点之间没有可用的兼容端口')
    get().connect({
      source: pair.source.id,
      target: pair.target.id,
      sourceHandle: `out:${pair.output.id}`,
      targetHandle: `in:${pair.input.id}`,
    })
  },
  convertSelectionToSubgraph: () => {
    const state = get()
    const graph = activeGraph(state)
    const selected = graph.nodes.filter((node) => node.selected || node.id === state.selectedNodeId)
    if (selected.length === 0) return get().showToast('请先选择要转换的节点')
    try {
      const definitionId = `group_${uid().replace(/-/g, '_')}`
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/convert-selection-to-subgraph',
        graphId: state.activeGraphId,
        nodeIds: selected.map((node) => node.id),
        definitionId,
        name: `子图 · ${selected.length} 个节点`,
        description: '由画布选择转换；跨边端口自动公开。',
        tags: ['canvas'],
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        activeGraphId: state.activeGraphId,
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : state.selectedNodeId,
      })
      get().showToast(`已创建${state.activeGraphId === 'root' ? '' : '嵌套'}类型化子图并自动公开跨边端口`)
    } catch (error) {
      get().showToast(error instanceof Error ? error.message : '子图转换失败')
    }
  },
  enterGraph: (activeGraphId) => {
    if (!get().graphs[activeGraphId]) return
    set({ activeGraphId, selectedNodeId: undefined })
  },
  showToast: (toast) => set({ toast }),
  dismissToast: () => set({ toast: undefined }),
  ensureProjectForRun: async () => {
    const state = get()
    const bridge = remoteBridge()
    if (!bridge) {
      set({ toast: '未检测到 Electron 桌面桥；请双击 start.bat 启动客户端，不能从浏览器页面真实生图' })
      return false
    }
    if (state.connectionState !== 'ready') {
      set({ toast: state.connectionState === 'loading' || state.connectionState === 'idle' ? '正在连接账户，请稍后再运行' : '账户连接异常，请重新启动客户端' })
      return false
    }
    if (state.projectPath) return true

    const replacingBuiltInDemo = state.workflowId === 'workflow-neon-teahouse'
    const originalCapture = captureWorkflowDocument(state.workflowDocument, workflowPlanFingerprint)
    let workflow = replacingBuiltInDemo
      ? createQuickStartWorkflow(preferredProvider(state.providers))
      : originalCapture.document
    let flattened = flattenSubgraphs(workflow)
    let localPlan = createExecutionPlan(flattened, undefined, replacingBuiltInDemo ? {} : buildDebugOverrides(state.graphs))
    let providerIssue = plannedProviderIssue(flattened, localPlan, state.providers)
    if (providerIssue) {
      const eligibleProviders = accountProviders(state.providers).filter((provider) => provider.hasSecret)
      if (eligibleProviders.length === 1) {
        workflow = bindWorkflowProvider(workflow, eligibleProviders[0] as ProviderItem)
        flattened = flattenSubgraphs(workflow)
        localPlan = createExecutionPlan(flattened, undefined, {})
        providerIssue = plannedProviderIssue(flattened, localPlan, state.providers)
      }
      if (providerIssue) {
        const issue = providerIssue
        set({
          page: 'workflow',
          selectedNodeId: state.graphs.root?.nodes.some((node) => node.id === issue.nodeId) ? issue.nodeId : state.selectedNodeId,
          toast: eligibleProviders.length === 0
            ? '当前账户没有可用分组；请重新登录后刷新'
            : `${issue.message}；请在页面顶部选择分组和模型`,
        })
        return false
      }
    }

    const loadEpoch = ++projectLoadEpoch
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    try {
      if (loadEpoch !== projectLoadEpoch
        || !workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return false
      const current = get()
      if (!matchesWorkflowDocumentCapture(originalCapture, current.workflowDocument, workflowPlanFingerprint)) {
        set({ toast: '创建运行项目期间画布已变化，请重新点击运行' })
        return false
      }
      const now = new Date().toISOString()
      const initialWorkflow: WorkflowDocument = { ...workflow, revision: 0, createdAt: now, updatedAt: now }
      const project = await bridge.createProject({
        name: quickProjectName(),
        initialWorkflow,
      })
      const snapshot = await readProjectSnapshot(bridge, project.path)
      if (loadEpoch !== projectLoadEpoch) return false
      const latest = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(latest))
        || !matchesWorkflowDocumentCapture(originalCapture, latest.workflowDocument, workflowPlanFingerprint)) {
        set({ toast: `项目“${project.name}”已创建，但画布随后发生变化；已保留当前画布，请重新点击运行` })
        return false
      }
      const savedWorkflow = snapshot.workflows.find((item) => item.id === initialWorkflow.id) ?? snapshot.workflow
      if (!savedWorkflow) throw new Error('新项目没有可运行的 Workflow')
      clearPreparedRunSessions()
      set({
        projectPath: project.path,
        projectName: project.name,
        availableProjects: [project, ...latest.availableProjects.filter((item) => item.id !== project.id)],
        connectionState: 'ready',
        page: 'workflow',
        ...workflowEditorState(savedWorkflow, project.path),
        workflows: snapshot.workflows,
        assets: snapshot.assets,
        boards: snapshot.boards,
        selectedAssetId: snapshot.assets[0]?.id ?? '',
        selectedBoardId: 'all',
        queue: snapshot.queue,
        selectedQueueId: snapshot.queue[0]?.id ?? '',
        plugins: snapshot.plugins,
        presets: snapshot.presets,
        lastPresetDiffs: [],
        runs: snapshot.runs,
        selectedRunId: snapshot.runs[0]?.runId,
        timeline: emptyTimeline(),
        modal: 'none',
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        pendingDraftRecovery: undefined,
        workflowVersions: [],
        archivedWorkflows: [],
        toast: `项目“${project.name}”已创建`,
      })
      return true
    } catch (error) {
      if (loadEpoch !== projectLoadEpoch
        || !workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return false
      set({ toast: error instanceof Error ? `创建运行项目失败：${error.message}` : '创建运行项目失败' })
      return false
    }
  },
  preparePromptMatrix: async (input) => {
    const initial = get()
    const bridge = remoteBridge()
    if (!bridge) {
      set({ toast: '未检测到 Electron 桌面桥；请关闭浏览器页面并双击 start.bat' })
      return
    }
    if (initial.connectionState !== 'ready') {
        set({ toast: initial.connectionState === 'loading' || initial.connectionState === 'idle' ? '正在连接账户，请稍后再运行' : '账户连接异常，请重新启动客户端' })
      return
    }
    const projectPath = initial.projectPath
    if (!projectPath) {
      if (await get().ensureProjectForRun()) await get().preparePromptMatrix(input)
      return
    }
    clearPreparedRunSessions()
    const prepareEpoch = promptMatrixPrepareEpoch
    set({
      modal: 'none',
      pendingPlan: undefined,
      pendingWorkflow: undefined,
      pendingMatrixRuns: [],
      pendingMatrixPrepareGeneration: undefined,
      pendingTargetNodeIds: [],
    })
    const state = get()
    const root = state.workflowDocument
    const sourceFingerprint = workflowPlanFingerprint(root)
    const sourceGeneration = workflowEditorSession.getSnapshot().editGeneration
    const textNode = root.nodes.find((node) => node.type === 'text')
    const generationNode = root.nodes.find((node) => node.type === 'image_generation')
    if (!textNode || !generationNode) return get().showToast('Prompt Matrix 需要一个文本节点和一个图像生成节点')
    try {
      const overrides = buildDebugOverrides(state.graphs)
      const flattened = flattenSubgraphs(root)
      const localPlan = createExecutionPlan(flattened, undefined, overrides)
      const providerIssue = plannedProviderIssue(flattened, localPlan, state.providers)
      if (providerIssue) {
        set({
          page: 'workflow',
          selectedNodeId: state.graphs.root?.nodes.some((node) => node.id === providerIssue.nodeId) ? providerIssue.nodeId : state.selectedNodeId,
          modal: 'none',
          pendingPlan: undefined,
          pendingWorkflow: undefined,
          pendingMatrixRuns: [],
          pendingMatrixPrepareGeneration: undefined,
          pendingTargetNodeIds: [],
          toast: `${providerIssue.message}；请在页面顶部选择分组和模型，远程请求尚未发送`,
        })
        return
      }
      const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))]
      if (models.length === 0) throw new Error('Prompt Matrix 至少需要一个模型')
      const providerId = String(generationNode.parameters.providerId ?? '').trim()
      const provider = state.providers.find((item) => item.id === providerId)
      if (!provider || !isAiTerminalAccountProvider(provider)) {
        throw new Error('Prompt Matrix 需要先选择账户分组')
      }
      const availableModels = new Set(providerModelOptions(provider))
      const unavailableModel = models.find((model) => !availableModels.has(model))
      if (unavailableModel) {
        throw new Error(`模型“${unavailableModel}”不在当前分组目录中`)
      }
      const combinations = models.flatMap((model) => planPromptMatrix([
        { id: 'prompt', nodeId: textNode.id, parameter: 'text', values: input.prompts },
        { id: 'model', nodeId: generationNode.id, parameter: 'model', values: [model] },
        { id: 'size', nodeId: generationNode.id, parameter: 'size', values: input.sizes },
        { id: 'seed', nodeId: generationNode.id, parameter: 'seed', values: supportsImageSeed(model) ? input.seeds : [input.seeds[0] ?? 0] },
      ], { hardLimit: 32, confirmationTaskThreshold: 1 }).combinations)
      if (combinations.length > 32) throw new Error('Prompt Matrix 去重后的任务数仍超过上限 32')
      if (input.costPerImage !== undefined && (!Number.isFinite(input.costPerImage) || input.costPerImage < 0)) {
        throw new Error('单图费用估算必须是非负有限数值')
      }
      if (input.maxEstimatedCost !== undefined && (!Number.isFinite(input.maxEstimatedCost) || input.maxEstimatedCost < 0)) {
        throw new Error('费用风险上限必须是非负有限数值')
      }
      const minimumEstimatedCost = input.costPerImage === undefined ? undefined : input.costPerImage * combinations.length
      if (minimumEstimatedCost !== undefined && input.maxEstimatedCost !== undefined && minimumEstimatedCost > input.maxEstimatedCost) {
        throw new Error(`Prompt Matrix 最低预计费用 ${minimumEstimatedCost.toFixed(4)} 超过风险上限 ${input.maxEstimatedCost.toFixed(4)}`)
      }
      const rawTaskCount = input.prompts.length * input.models.length * input.sizes.length * input.seeds.length
      const removedTaskCount = Math.max(0, rawTaskCount - combinations.length)
      const matrixBatchId = `matrix-${uid()}`
      const workflows = combinations.map((combination, combinationIndex): WorkflowDocument => ({
        ...root,
        id: root.id,
        name: `${root.name} / Matrix ${combinationIndex + 1}`,
        nodes: root.nodes.map((node) => {
          const prefix = `${node.id}.`
          const patches = Object.fromEntries(Object.entries(combination.values)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key.slice(prefix.length), value]))
          return {
            ...node,
            parameters: {
              ...node.parameters,
              ...patches,
              ...(node.id === generationNode.id ? { count: 1, candidateGroupId: matrixBatchId } : {}),
            },
          }
        }),
        metadata: {
          ...(root.metadata ?? {}),
          promptMatrix: {
            batchId: matrixBatchId,
            index: combinationIndex + 1,
            taskCount: combinations.length,
            ...(input.costPerImage === undefined ? {} : { userEstimatedCostPerImage: input.costPerImage }),
          },
        },
        updatedAt: new Date().toISOString(),
      }))
      const preparedSession = await promptMatrixSession.prepare({
        bridge,
        projectPath,
        workflowFingerprint: sourceFingerprint,
        sourceGeneration,
        workflows,
        targetNodeIds: [],
        overrides,
      })
      const prepared = preparedSession.runs
      const plannedRemoteTasks = prepared.reduce((total, item) => total + item.plan.remoteTaskCount, 0)
      const plannedImageUnits = prepared.reduce((batchTotal, item) => {
        const nodes = new Map(flattenSubgraphs(item.workflow).nodes.map((node) => [node.id, node]))
        return batchTotal + item.plan.nodes.reduce((planTotal, planned) => {
          if (planned.action !== 'execute') return planTotal
          const node = nodes.get(planned.nodeId)
          if (!node || !remoteImageNodeTypes.has(node.type)) return planTotal
          const rawCount = Number(node.parameters.count ?? 1)
          const count = Number.isFinite(rawCount) ? Math.max(1, Math.trunc(rawCount)) : 1
          return planTotal + count
        }, 0)
      }, 0)
      const estimatedRemoteUnits = Math.max(plannedRemoteTasks, plannedImageUnits)
      const estimatedCost = input.costPerImage === undefined ? undefined : input.costPerImage * estimatedRemoteUnits
      if (estimatedCost !== undefined && input.maxEstimatedCost !== undefined && estimatedCost > input.maxEstimatedCost) {
        throw new Error(`Prompt Matrix 预计费用 ${estimatedCost.toFixed(4)} 超过风险上限 ${input.maxEstimatedCost.toFixed(4)}`)
      }
      if (prepareEpoch !== promptMatrixPrepareEpoch) return
      const current = get()
      if (current.projectPath !== projectPath || current.workflowId !== state.workflowId) return
      if (workflowPlanFingerprint(current.workflowDocument) !== sourceFingerprint) {
        set({ toast: '画布在 Prompt Matrix 预检期间发生变化，请重新预检' })
        return
      }
      if (workflowEditorSession.getSnapshot().editGeneration !== sourceGeneration) {
        set({ toast: '画布在 Prompt Matrix 预检期间已被编辑，请重新预检' })
        return
      }
      const aggregate: RunPlan = {
        id: `matrix-${uid()}`,
        workflowId: root.id,
        taskCount: prepared.reduce((total, item) => total + item.plan.taskCount, 0),
        remoteTaskCount: plannedRemoteTasks,
        ...(estimatedCost === undefined ? {} : { estimatedCost }),
        nodes: prepared.flatMap((item, index) => item.plan.nodes.map((node) => ({ ...node, nodeId: `${index + 1}:${node.nodeId}` }))),
      }
      set({
        pendingPlan: aggregate,
        pendingWorkflow: undefined,
        pendingMatrixRuns: prepared,
        pendingMatrixPrepareGeneration: preparedSession.prepareGeneration,
        pendingTargetNodeIds: [],
        modal: 'run-confirm',
        toast: `Prompt Matrix 已展开 ${combinations.length} 个独立组合${removedTaskCount > 0 ? `，移除 ${removedTaskCount} 个无效或重复组合` : ''}；确认前不会派发`,
      })
    } catch (error) {
      if (prepareEpoch !== promptMatrixPrepareEpoch
        || get().projectPath !== projectPath || get().workflowId !== state.workflowId) return
      set({ toast: error instanceof Error ? error.message : 'Prompt Matrix 预检失败' })
    }
  },
  runWorkflow: async (targetNodeIds) => {
    const initial = get()
    const frozenTargetNodeIds = [...new Set((targetNodeIds ?? []).filter((nodeId) => typeof nodeId === 'string' && nodeId.length > 0))]
    const initialBridge = remoteBridge()
    if (!initialBridge) {
      set({ toast: '未检测到 Electron 桌面桥；请关闭浏览器页面并双击 start.bat' })
      return
    }
    if (initial.connectionState !== 'ready') {
      set({ toast: initial.connectionState === 'loading' || initial.connectionState === 'idle' ? '正在连接账户，请稍后再运行' : '账户连接异常，请重新启动客户端' })
      return
    }
    const projectPath = initial.projectPath
    if (!projectPath) {
      if (await get().ensureProjectForRun()) await get().runWorkflow(frozenTargetNodeIds)
      return
    }
    const state = get()
    const bridge = initialBridge
    clearPreparedRunSessions()
    set({
      modal: 'none',
      pendingPlan: undefined,
      pendingWorkflow: undefined,
      pendingMatrixRuns: [],
      pendingMatrixPrepareGeneration: undefined,
      pendingTargetNodeIds: [],
    })
    try {
      const overrides = buildDebugOverrides(state.graphs)
      const workflow = state.workflowDocument
      const sourceFingerprint = workflowPlanFingerprint(workflow)
      const flattened = flattenSubgraphs(workflow)
      const localPlan = createExecutionPlan(flattened, frozenTargetNodeIds.length > 0 ? frozenTargetNodeIds : undefined, overrides)
      const providerIssue = plannedProviderIssue(flattened, localPlan, state.providers)
      if (providerIssue) {
        set({
          page: 'workflow',
          selectedNodeId: state.graphs.root?.nodes.some((node) => node.id === providerIssue.nodeId) ? providerIssue.nodeId : state.selectedNodeId,
          toast: `${providerIssue.message}；远程请求尚未发送`,
        })
        return
      }
      const preparedSession = await studioRunSession.prepare({
        bridge,
        projectPath,
        workflow,
        workflowFingerprint: sourceFingerprint,
        targetNodeIds: frozenTargetNodeIds,
        overrides,
      })
      const plan = preparedSession.plan
      const current = get()
      if (current.projectPath !== projectPath || current.workflowId !== state.workflowId) {
        clearPreparedRunSessions()
        return
      }
      if (workflowPlanFingerprint(current.workflowDocument) !== sourceFingerprint) {
        set({ toast: '画布在执行预检期间发生变化，请重新运行预检' })
        clearPreparedRunSessions()
        return
      }
      set({
        pendingPlan: plan,
        pendingWorkflow: preparedSession.workflow,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: preparedSession.targetNodeIds,
        modal: 'run-confirm',
        toast: `${frozenTargetNodeIds.length > 0 ? '所选节点的' : ''}执行计划已就绪：${plan.taskCount} 个执行节点，其中 ${plan.remoteTaskCount} 个远程节点；确认前不会派发`,
      })
    } catch (error) {
      if (get().projectPath !== projectPath || get().workflowId !== state.workflowId) return
      set({ toast: error instanceof Error ? `执行计划失败：${error.message}` : '执行计划失败' })
    }
  },
  runSelectedNode: async () => {
    const before = get()
    if (!before.projectPath) {
      if (await before.ensureProjectForRun()) await get().runSelectedNode()
      return
    }
    const selectedNodeId = before.selectedNodeId
    if (!selectedNodeId) {
      set({ toast: '请先在画布中选择一个要运行到的节点' })
      return
    }
    const graph = before.graphs[before.activeGraphId]
    if (!graph?.nodes.some((node) => node.id === selectedNodeId)) {
      set({ toast: '所选节点已不存在，请重新选择' })
      return
    }
    const prefix = graphExecutionPrefixes(before.graphs).get(before.activeGraphId)
    if (prefix === undefined) {
      set({ toast: '无法确定当前子图的执行路径，请返回根画布后重试' })
      return
    }
    await get().runWorkflow([`${prefix}${selectedNodeId}`])
  },
  confirmRun: async () => {
    const state = get()
    const plan = state.pendingPlan
    if (!plan) return
    const bridge = remoteBridge()
    if (!bridge || state.connectionState !== 'ready' || !state.projectPath) {
      clearPreparedRunSessions()
      set({
        modal: 'none',
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        toast: '未派发：真实运行需要 Electron 项目和明确的输出目录',
      })
      return
    }
    const runProjectPath = state.projectPath
    if (state.pendingMatrixRuns.length > 0) {
      const prepareGeneration = state.pendingMatrixPrepareGeneration
      if (prepareGeneration === undefined) {
        clearPreparedRunSessions()
        set({
          modal: 'none',
          pendingPlan: undefined,
          pendingWorkflow: undefined,
          pendingMatrixRuns: [],
          pendingMatrixPrepareGeneration: undefined,
          pendingTargetNodeIds: [],
          toast: 'Prompt Matrix 缺少冻结的预检会话，请重新预检',
        })
        return
      }
      const currentFingerprint = workflowPlanFingerprint(state.workflowDocument)
      const currentGeneration = workflowEditorSession.getSnapshot().editGeneration
      let frozenRuns: readonly PreparedMatrixRun[] = []
      try {
        const settled = await promptMatrixSession.confirm({
          projectPath: runProjectPath,
          workflowFingerprint: currentFingerprint,
          sourceGeneration: currentGeneration,
          prepareGeneration,
        }, (prepared) => {
          frozenRuns = prepared.runs
          const matrixTasks: QueueItem[] = prepared.runs.map((item, index) => ({
            id: item.plan.id,
            title: `Prompt Matrix ${index + 1}/${prepared.runs.length}`,
            workflow: item.workflow.name,
            provider: '已配置 Provider',
            status: 'queued',
            dispatchState: 'not_sent',
            progress: 0,
            createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            message: '已确认并进入主进程队列，等待派发',
          }))
          set((current) => ({
            queue: [...matrixTasks, ...current.queue.filter((item) => !matrixTasks.some((task) => task.id === item.id))],
            timeline: emptyTimeline(),
            modal: 'none',
            pendingPlan: undefined,
            pendingWorkflow: undefined,
            pendingMatrixRuns: [],
            pendingMatrixPrepareGeneration: undefined,
            pendingTargetNodeIds: [],
            bottomPanel: 'live',
            bottomOpen: true,
            toast: `已确认 ${matrixTasks.length} 个 Matrix 组合，正在加入主进程队列`,
          }))
        })
        const results = settled.map((item, index): RunResult => {
          if (item.status === 'fulfilled') return item.value
          const run = frozenRuns[index]
          return {
            runId: run?.plan.id ?? `matrix-failed-${index + 1}`,
            status: 'failed',
            dispatchState: 'not_sent',
            outputs: {},
            error: {
              code: 'ipc-run-failed',
              message: item.reason instanceof Error ? item.reason.message : '运行失败',
              billingUnknown: false,
              dispatchState: 'not_sent',
            },
          }
        })
        if (get().projectPath !== runProjectPath) return
        const resultByPlanId = new Map(frozenRuns.flatMap((run, index) => {
          const result = results[index]
          return result ? [[run.plan.id, result] as const] : []
        }))
        set((current) => ({
          queue: current.queue.map((item) => {
            const result = resultByPlanId.get(item.id)
            if (!result) return item
            const dispatchState = dispatchStateFromResult(result)
            return {
              ...item,
              status: result.status === 'succeeded' ? 'success' : result.error?.billingUnknown ? 'billing-unknown' : 'error',
              progress: 100,
              message: result.status === 'succeeded' ? '生成完成并已落盘' : result.error?.message ?? `运行${result.status}`,
              ...(dispatchState ? { dispatchState } : {}),
            }
          }),
          toast: `Prompt Matrix 完成：${results.filter((result) => result.status === 'succeeded').length}/${results.length} 个组合成功`,
        }))
        await get().refreshAssets()
        await get().refreshRuns()
      } catch (error) {
        if (get().projectPath !== runProjectPath) return
        clearPreparedRunSessions()
        set({
          modal: 'none',
          pendingPlan: undefined,
          pendingWorkflow: undefined,
          pendingMatrixRuns: [],
          pendingMatrixPrepareGeneration: undefined,
          pendingTargetNodeIds: [],
          toast: error instanceof Error ? error.message : 'Prompt Matrix 确认失败',
        })
      }
      return
    }
    const preparedWorkflow = state.pendingWorkflow
    if (!preparedWorkflow) {
      clearPreparedRunSessions()
      set({ modal: 'none', pendingPlan: undefined, pendingMatrixPrepareGeneration: undefined, pendingTargetNodeIds: [], toast: '执行计划缺少冻结的 Workflow，请重新预检' })
      return
    }
    const currentWorkflow = state.workflowDocument
    const currentWorkflowFingerprint = workflowPlanFingerprint(currentWorkflow)
    if (currentWorkflowFingerprint !== workflowPlanFingerprint(preparedWorkflow)) {
      clearPreparedRunSessions()
      set({ modal: 'none', pendingPlan: undefined, pendingWorkflow: undefined, pendingMatrixPrepareGeneration: undefined, pendingTargetNodeIds: [], toast: '画布在预检后发生变化，已取消旧计划；请重新运行预检' })
      return
    }
    const task: QueueItem = {
      id: plan.id,
      title: `${preparedWorkflow.name} · ${plan.remoteTaskCount} 个远程节点`,
      workflow: preparedWorkflow.name,
      provider: '已配置 Provider',
      status: 'queued',
      dispatchState: 'not_sent',
      progress: 0,
      createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      ...(plan.estimatedCost !== undefined ? { cost: plan.estimatedCost } : {}),
      message: bridge && state.connectionState === 'ready' ? '请求准备派发到 Provider' : '未派发：账户或 Electron 项目尚未就绪',
    }
    set((current) => ({
      queue: [task, ...current.queue.filter((item) => item.id !== task.id)],
      timeline: emptyTimeline(),
      modal: 'none',
      pendingPlan: undefined,
      pendingWorkflow: undefined,
      pendingMatrixRuns: [],
      pendingMatrixPrepareGeneration: undefined,
      pendingTargetNodeIds: [],
      bottomPanel: 'live',
      bottomOpen: true,
      toast: bridge && state.connectionState === 'ready' ? '已确认并加入主进程队列；派发后会显示 sent' : '未派发：账户或 Electron 项目尚未就绪',
    }))
    try {
      await studioRunSession.confirm({
        projectPath: state.projectPath,
        workflowFingerprint: currentWorkflowFingerprint,
      })
      if (get().projectPath !== runProjectPath) return
      const authoritativeRun = studioRunSession.getSnapshot().runs.find((run) => run.runId === plan.id)
      const result = authoritativeRun?.projection.result
      if (!result) {
        set({ toast: authoritativeRun?.projection.message ?? '运行终态缺少结果' })
        return
      }
      set({ toast: authoritativeRun.projection.message })
      await get().hydrateRunResultPreviews(result, runProjectPath, state.workflowId)
      await get().refreshAssets()
      await get().refreshRuns()
    } catch (error) {
      if (get().projectPath !== runProjectPath) return
      const authoritativeRun = studioRunSession.getSnapshot().runs.find((run) => run.runId === plan.id)
      set({ toast: authoritativeRun?.projection.message ?? (error instanceof Error ? error.message : '运行失败') })
    }
  },
  saveWorkflow: async () => {
    const state = get()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    if (!remoteBridge() || state.connectionState !== 'ready' || !projectPath) {
      set({ toast: '账户或 Electron 项目尚未就绪，修改未写入项目' })
      return
    }
    if (!state.workflowDirty) {
      set({ toast: '当前 Workflow 没有未保存修改' })
      return
    }
    const feedbackTicket = workflowStoreCoordinator.beginRequest(
      requireWorkflowOperationIdentity(state),
      'scope',
      'save-feedback',
    )
    try {
      const result = await workflowEditorSession.save()
      if (result.status !== 'saved') {
        if (workflowStoreCoordinator.current(feedbackTicket, workflowSessionScopeIdentity(get()))) {
          set({ toast: result.status === 'clean' ? '当前 Workflow 没有未保存修改' : '当前 Workflow 尚未绑定磁盘项目' })
        }
        return
      }
      const formalDocument = result.document
      const beforeApply = get()
      if (!result.appliedToSession
        && beforeApply.projectPath === result.scope.projectPath
        && beforeApply.workflowId === result.scope.workflowId) {
        workflowEditorSession.acceptFormalDocument(result.scope, formalDocument)
      }
      const sessionSnapshot = workflowEditorSession.getSnapshot()
      const appliesToCurrent = beforeApply.projectPath === result.scope.projectPath
        && beforeApply.workflowId === result.scope.workflowId
        && sessionSnapshot.scope?.projectPath === result.scope.projectPath
        && sessionSnapshot.scope.workflowId === result.scope.workflowId
      set((current) => {
        if (current.projectPath !== result.scope.projectPath) return {}
        const workflows = upsertFormalWorkflow(current.workflows, formalDocument)
        const stillCurrent = appliesToCurrent
          && current.workflowId === result.scope.workflowId
          && current.projectPath === result.scope.projectPath
        const feedbackCurrent = workflowStoreCoordinator.current(
          feedbackTicket,
          workflowSessionScopeIdentity(current),
        )
        return {
          workflows,
          ...(stillCurrent ? synchronizedWorkflowEditorState(current, sessionSnapshot) : {}),
          ...(stillCurrent ? { pendingDraftRecovery: undefined } : {}),
          ...(feedbackCurrent ? {
            toast: stillCurrent
              ? !sessionSnapshot.dirty
                ? `工作流已保存 · rev. ${formalDocument.revision}`
                : `已保存 rev. ${formalDocument.revision}；保存期间的新修改仍待保存`
              : `“${formalDocument.name}”已保存 · rev. ${formalDocument.revision}`,
          } : {}),
        }
      })
      if (appliesToCurrent && sessionSnapshot.dirty) {
        try {
          await workflowEditorSession.flushDraft()
        } catch (error) {
          if (workflowStoreCoordinator.current(feedbackTicket, workflowSessionScopeIdentity(get()))) {
            set({ toast: error instanceof Error
              ? `已保存 rev. ${formalDocument.revision}；新修改仍待保存，自动草稿写入失败：${error.message}`
              : `已保存 rev. ${formalDocument.revision}；新修改仍待保存，自动草稿写入失败` })
          }
        }
      }
    } catch (error) {
      if (get().projectPath !== projectPath || get().workflowId !== workflowId
        || !workflowStoreCoordinator.current(feedbackTicket, workflowSessionScopeIdentity(get()))) return
      set({ toast: error instanceof Error ? `保存失败：${error.message}` : '保存失败' })
    }
  },
  switchWorkflow: async (workflowId) => {
    const state = get()
    if (workflowId === state.workflowId) return
    if (!state.workflows.some((item) => item.id === workflowId)) {
      return get().showToast('要切换的 Workflow 不存在或已被移除')
    }
    const switchTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    let workflow: WorkflowDocument | undefined
    let projectPath: string | undefined
    const transition = await workflowStoreCoordinator.flushDraftThenCommit(
      switchTicket,
      () => workflowOperationIdentity(get()),
      () => workflowEditorSession.flushDraft(),
      () => {
        const current = get()
        workflow = current.workflows.find((item) => item.id === workflowId)
        projectPath = current.projectPath
        if (!workflow) return
        clearPreparedRunSessions()
        set({
          ...workflowEditorState(workflow, projectPath),
          modal: 'none',
          pendingDraftRecovery: undefined,
          workflowVersions: [],
          pendingPlan: undefined,
          pendingWorkflow: undefined,
          pendingMatrixRuns: [],
          pendingMatrixPrepareGeneration: undefined,
          pendingTargetNodeIds: [],
          compatiblePicker: undefined,
          timeline: emptyTimeline(),
          toast: `已切换到“${workflow.name}”`,
        })
      },
    )
    if (transition.status === 'flush-failed') {
      if (get().projectPath === state.projectPath && get().workflowId === state.workflowId) {
        set({ toast: transition.error instanceof Error
          ? `切换已取消，旧 Workflow 草稿保存失败：${transition.error.message}`
          : '切换已取消，旧 Workflow 草稿保存失败' })
      }
      return
    }
    if (transition.status === 'stale') {
      if (get().projectPath === state.projectPath && get().workflowId === state.workflowId) {
        set({ toast: '切换期间 Workflow 发生变化；已保留当前画布，请重试' })
      }
      return
    }
    if (!workflow) return get().showToast('要切换的 Workflow 不存在或已被移除')
    const bridge = remoteBridge()
    if (!bridge || !projectPath || typeof bridge.loadWorkflowDraft !== 'function') return
    const draftTicket = beginWorkflowOperation(get())
    try {
      const draft = await bridge.loadWorkflowDraft({ projectPath, workflowId })
      const latest = get()
      if (!isCurrentWorkflowOperation(draftTicket, latest) || latest.workflowDirty) return
      const formal = latest.workflows.find((item) => item.id === workflowId)
      const recovery = recoverableDraft(formal, draft)
      if (recovery) set((current) => ({
        pendingDraftRecovery: recovery,
        ...(current.modal === 'none' ? { modal: 'draft-recovery' as const } : {}),
      }))
    } catch {
      // A damaged optional draft must not block switching.
    }
  },
  createNewWorkflow: async (name) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const trimmed = name.trim()
    if (!trimmed) return get().showToast('Workflow 名称不能为空')
    if (!bridge || state.connectionState !== 'ready' || !projectPath) {
      return get().showToast('请先打开 Electron 磁盘项目，再新建 Workflow')
    }
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    try {
      const transition = await flushBeforeWorkflowScopeChange(scopeTicket, get)
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `新建已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '新建已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') return
      const saved = await bridge.saveWorkflow({ projectPath, workflow: createCoreWorkflow(trimmed) })
      const current = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))) {
        if (current.projectPath === projectPath) {
          set({
            workflows: upsertFormalWorkflow(current.workflows, saved),
            ...(current.workflowId === state.workflowId
              ? { toast: `已创建“${saved.name}”，但当前 Workflow 随后发生变化；已保留当前画布` }
              : {}),
          })
        }
        return
      }
      clearPreparedRunSessions()
      const editorUpdate = workflowEditorState(saved, projectPath)
      set({
        ...editorUpdate,
        workflows: upsertFormalWorkflow(current.workflows, saved),
        modal: 'none',
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        compatiblePicker: undefined,
        timeline: emptyTimeline(),
        toast: `已新建 Workflow“${saved.name}”`,
      })
    } catch (error) {
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `新建 Workflow 失败：${error.message}` : '新建 Workflow 失败' })
    }
  },
  createWorkflowFromTemplate: async (templateId) => {
    const state = get()
    const provider = preferredProvider(state.providers)
    const workflow = instantiateWorkflowTemplate(templateId, {
      providerId: provider?.id ?? '',
      model: provider?.model ?? '',
    })
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || state.connectionState !== 'ready' || !projectPath) {
      if (projectPath) {
        set({ toast: state.connectionState === 'loading' || state.connectionState === 'idle'
          ? '项目仍在连接中，请连接完成后再载入模板'
          : '当前磁盘项目连接异常，未切换 Workflow' })
        return
      }
      if (state.workflowDirty) {
        set({ toast: '当前 Quick Start 有未保存修改；请先创建项目保存，再载入其他模板' })
        return
      }
      clearPreparedRunSessions()
      set({
        ...workflowEditorState(workflow, undefined, { dirty: true }),
        modal: 'none',
        ...clearedPreparedRunState(),
        pendingDraftRecovery: undefined,
        toast: '模板已载入同一工作区；首次运行时会先让你选择项目保存位置',
      })
      return
    }
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    try {
      const transition = await flushBeforeWorkflowScopeChange(scopeTicket, get)
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `模板创建已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '模板创建已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') return
      const saved = await bridge.saveWorkflow({ projectPath, workflow })
      const current = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))) {
        if (current.projectPath === projectPath) {
          set({
            workflows: upsertFormalWorkflow(current.workflows, saved),
            ...(current.workflowId === state.workflowId
              ? { toast: `已从模板创建“${saved.name}”，但当前 Workflow 随后发生变化；已保留当前画布` }
              : {}),
          })
        }
        return
      }
      clearPreparedRunSessions()
      const editorUpdate = workflowEditorState(saved, projectPath)
      set({
        ...editorUpdate,
        workflows: upsertFormalWorkflow(current.workflows, saved),
        modal: 'none',
        ...clearedPreparedRunState(),
        pendingDraftRecovery: undefined,
        workflowVersions: [],
        toast: `已从模板创建“${saved.name}”`,
      })
    } catch (error) {
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `模板创建失败：${error.message}` : '模板创建失败' })
    }
  },
  recoverWorkflowDraft: () => {
    const state = get()
    const pending = state.pendingDraftRecovery
    if (!pending) return
    const formal = state.workflows.find((workflow) => workflow.id === state.workflowId)
    const now = new Date().toISOString()
    const recovered: WorkflowDocument = pending.conflicted
      ? {
          ...pending.workflow,
          id: crypto.randomUUID(),
          name: `${pending.workflow.name} · 冲突恢复副本`,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          metadata: {
            ...(pending.workflow.metadata ?? {}),
            recoveredFromConflict: {
              workflowId: pending.workflow.id,
              baseRevision: pending.baseRevision,
              formalRevision: formal?.revision ?? state.workflowRevision,
            },
          },
        }
      : {
          ...pending.workflow,
        }
    clearPreparedRunSessions()
    const recoveredEditor = pending.conflicted
      ? workflowEditorState(recovered, state.projectPath, { dirty: true })
      : replaceWorkflowDocument(state, recovered, 'draft-recovery')
    set({
      ...recoveredEditor,
      activeGraphId: 'root',
      selectedNodeId: recovered.nodes[0]?.id,
      modal: 'none',
      ...clearedPreparedRunState(),
      pendingDraftRecovery: undefined,
      toast: pending.conflicted
        ? `草稿基于旧 rev. ${pending.baseRevision}，已恢复为独立副本；正式版本未被覆盖`
        : `已恢复 ${pending.changes.length} 项草稿修改；正式版本尚未覆盖`,
    })
    if (pending.conflicted && state.projectPath) {
      const bridge = remoteBridge()
      if (bridge && typeof bridge.saveWorkflowDraft === 'function') {
        void bridge.saveWorkflowDraft({ projectPath: state.projectPath, workflow: recovered }).then(async () => {
          if (typeof bridge.discardWorkflowDraft === 'function') {
            await bridge.discardWorkflowDraft({ projectPath: state.projectPath as string, workflowId: pending.workflow.id })
          }
        }).catch((error: unknown) => {
          if (get().workflowId !== recovered.id) return
          set({ toast: error instanceof Error ? `冲突副本已保留在画布，但草稿落盘失败：${error.message}` : '冲突副本已保留在画布，但草稿落盘失败' })
        })
      }
    }
  },
  discardWorkflowDraft: async () => {
    const state = get()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    const requestTicket = workflowStoreCoordinator.beginRequest(
      requireWorkflowOperationIdentity(state),
      'document',
      'document',
    )
    try {
      await workflowEditorSession.discardDraft()
      const current = get()
      if (!workflowStoreCoordinator.current(requestTicket, workflowOperationIdentity(current))) {
        if (current.projectPath === projectPath && current.workflowId === workflowId && current.workflowDirty) {
          try {
            await workflowEditorSession.flushDraft()
          } catch (error) {
            if (get().projectPath === projectPath && get().workflowId === workflowId) {
              set({ toast: error instanceof Error
                ? `草稿丢弃期间出现新编辑，重新保存失败：${error.message}`
                : '草稿丢弃期间出现新编辑，重新保存失败' })
            }
          }
        }
        return
      }
      set({ pendingDraftRecovery: undefined, modal: 'none', toast: '已保留正式版本并丢弃恢复草稿' })
    } catch (error) {
      if (!workflowStoreCoordinator.current(requestTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `草稿丢弃失败：${error.message}` : '草稿丢弃失败' })
    }
  },
  openWorkflowHistory: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.listWorkflowVersions !== 'function') {
      return get().showToast('请先打开磁盘项目再查看 Workflow 历史')
    }
    const requestTicket = workflowStoreCoordinator.beginRequest(
      requireWorkflowOperationIdentity(state),
      'scope',
      'history',
    )
    const formalRevision = state.workflowRevision
    try {
      const [workflowVersions, archivedWorkflows] = await Promise.all([
        bridge.listWorkflowVersions({ projectPath, workflowId: state.workflowId }),
        typeof bridge.listArchivedWorkflows === 'function' ? bridge.listArchivedWorkflows({ projectPath }) : Promise.resolve([]),
      ])
      const identity = workflowSessionScopeIdentity(get())
      if (!workflowStoreCoordinator.current(requestTicket, identity)
        || identity?.revision !== formalRevision) return
      set({ workflowVersions, archivedWorkflows, modal: 'workflow-history' })
    } catch (error) {
      const identity = workflowSessionScopeIdentity(get())
      if (!workflowStoreCoordinator.current(requestTicket, identity)
        || identity?.revision !== formalRevision) return
      set({ toast: error instanceof Error ? `读取历史失败：${error.message}` : '读取历史失败' })
    }
  },
  restoreWorkflowVersion: async (revision) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.loadWorkflowVersion !== 'function') return
    const requestTicket = beginWorkflowOperation(state)
    try {
      const historic = await bridge.loadWorkflowVersion({ projectPath, workflowId: state.workflowId, revision })
      const current = get()
      if (!isCurrentWorkflowOperation(requestTicket, current)) return
      const restored: WorkflowDocument = {
        ...historic,
        metadata: { ...historic.metadata, restoredFromRevision: revision },
      }
      clearPreparedRunSessions()
      set({
        ...replaceWorkflowDocument(current, restored, 'history'),
        activeGraphId: 'root',
        selectedNodeId: restored.nodes[0]?.id,
        modal: 'none',
        ...clearedPreparedRunState(),
        toast: `已把 rev. ${revision} 载入为未保存修改；当前正式版本未被覆盖`,
      })
    } catch (error) {
      if (!isCurrentWorkflowOperation(requestTicket, get())) return
      set({ toast: error instanceof Error ? `版本恢复失败：${error.message}` : '版本恢复失败' })
    }
  },
  duplicateCurrentWorkflow: async (name) => {
    let state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.duplicateWorkflow !== 'function') return get().showToast('请先打开磁盘项目')
    if (state.workflowDirty) {
      await get().saveWorkflow()
      const afterSave = get()
      if (afterSave.projectPath !== projectPath || afterSave.workflowId !== state.workflowId) return
      if (afterSave.workflowDirty) {
        set({ toast: '复制已取消；请先完成当前 Workflow 保存' })
        return
      }
      state = afterSave
    }
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    try {
      const transition = await flushBeforeWorkflowScopeChange(scopeTicket, get)
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `复制已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '复制已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') return
      const saved = await bridge.duplicateWorkflow({ projectPath, workflowId: state.workflowId, ...(name?.trim() ? { name: name.trim() } : {}) })
      const current = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))) {
        if (current.projectPath === projectPath) {
          set({
            workflows: upsertFormalWorkflow(current.workflows, saved),
            ...(current.workflowId === state.workflowId
              ? { toast: `已创建副本“${saved.name}”，但原 Workflow 随后发生变化；已保留当前画布` }
              : {}),
          })
        }
        return
      }
      clearPreparedRunSessions()
      const editorUpdate = workflowEditorState(saved, projectPath)
      set({
        ...editorUpdate,
        workflows: upsertFormalWorkflow(current.workflows, saved),
        modal: 'none',
        ...clearedPreparedRunState(),
        workflowVersions: [],
        toast: `已创建独立副本“${saved.name}”`,
      })
    } catch (error) {
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `复制 Workflow 失败：${error.message}` : '复制 Workflow 失败' })
    }
  },
  archiveCurrentWorkflow: async () => {
    let state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.archiveWorkflow !== 'function') return get().showToast('请先打开磁盘项目')
    if (state.workflowDirty) {
      await get().saveWorkflow()
      const afterSave = get()
      if (afterSave.projectPath !== projectPath || afterSave.workflowId !== state.workflowId) return
      if (afterSave.workflowDirty) {
        set({ toast: '归档已取消；请先完成当前 Workflow 保存' })
        return
      }
      state = afterSave
    }
    const workflowId = state.workflowId
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    let feedbackTicket: WorkflowOperationTicket | undefined
    try {
      const transition = await flushBeforeWorkflowScopeChange(scopeTicket, get)
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `归档已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '归档已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') return
      const current = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))) {
        return
      }
      const next = current.workflows.find((workflow) => workflow.id !== workflowId)
      if (!next) throw new Error('项目必须至少保留一个 Workflow')
      clearPreparedRunSessions()
      set({
        ...workflowEditorState(next, projectPath),
        workflows: current.workflows.filter((workflow) => workflow.id !== workflowId),
        modal: 'none',
        pendingDraftRecovery: undefined,
        workflowVersions: [],
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        compatiblePicker: undefined,
        timeline: emptyTimeline(),
        toast: `正在归档“${state.workflowDocument.name}”`,
      })
      feedbackTicket = workflowStoreCoordinator.beginRequest(
        requireWorkflowOperationIdentity(get()),
        'scope',
        'archive-feedback',
      )
      const archived = await bridge.archiveWorkflow({ projectPath, workflowId })
      if (!archived) throw new Error('Workflow 已不在当前项目中')
      let workflows: readonly WorkflowDocument[]
      try {
        workflows = await bridge.listWorkflows(projectPath)
      } catch {
        workflows = get().workflows.filter((workflow) => workflow.id !== workflowId)
      }
      set((latest) => {
        if (latest.projectPath !== projectPath) return {}
        const feedbackCurrent = feedbackTicket
          && workflowStoreCoordinator.current(feedbackTicket, workflowSessionScopeIdentity(latest))
        return {
          workflows,
          ...(feedbackCurrent ? { toast: 'Workflow 已移入可恢复归档，没有永久删除' } : {}),
        }
      })
    } catch (error) {
      let workflows: readonly WorkflowDocument[] | undefined
      try {
        workflows = await bridge.listWorkflows(projectPath)
      } catch {
        // Keep the optimistic catalog closed when the disk result is unknown.
      }
      const current = get()
      const feedbackCurrent = feedbackTicket
        ? workflowStoreCoordinator.current(feedbackTicket, workflowSessionScopeIdentity(current))
        : workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))
      if (current.projectPath !== projectPath) return
      set({
        ...(workflows ? { workflows } : {}),
        ...(feedbackCurrent ? {
          toast: error instanceof Error ? `归档失败：${error.message}` : '归档失败',
        } : {}),
      })
    }
  },
  restoreArchivedWorkflow: async (archiveId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.restoreArchivedWorkflow !== 'function') return
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    try {
      const transition = await flushBeforeWorkflowScopeChange(scopeTicket, get)
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `归档恢复已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '归档恢复已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') return
      const restored = await bridge.restoreArchivedWorkflow({ projectPath, archiveId })
      const workflows = await bridge.listWorkflows(projectPath)
      const current = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))) {
        if (current.projectPath === projectPath) {
          set({
            workflows,
            archivedWorkflows: current.archivedWorkflows.filter((item) => item.archiveId !== archiveId),
            ...(current.workflowId === state.workflowId
              ? { toast: `已恢复“${restored.name}”，但当前 Workflow 随后发生变化；已保留当前画布` }
              : {}),
          })
        }
        return
      }
      clearPreparedRunSessions()
      const editorUpdate = workflowEditorState(restored, projectPath)
      set({
        ...editorUpdate,
        workflows,
        modal: 'none',
        ...clearedPreparedRunState(),
        archivedWorkflows: current.archivedWorkflows.filter((item) => item.archiveId !== archiveId),
        workflowVersions: [],
        toast: `已恢复“${restored.name}”`,
      })
      if (typeof bridge.loadWorkflowDraft === 'function') {
        const draftTicket = beginWorkflowOperation(get())
        try {
          const draft = await bridge.loadWorkflowDraft({ projectPath, workflowId: restored.id })
          const latest = get()
          if (!isCurrentWorkflowOperation(draftTicket, latest) || latest.workflowDirty) return
          const formal = latest.workflows.find((workflow) => workflow.id === restored.id)
          const recovery = recoverableDraft(formal, draft)
          if (recovery) {
            set({
              pendingDraftRecovery: recovery,
              modal: 'draft-recovery',
              toast: `已恢复“${restored.name}”，并发现可恢复草稿`,
            })
          }
        } catch {
          // An optional historic draft must not turn a successful archive restore into failure.
        }
      }
    } catch (error) {
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `归档恢复失败：${error.message}` : '归档恢复失败' })
    }
  },
  exportCurrentWorkflowPackage: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.exportWorkflowPackage !== 'function') return get().showToast('请先打开磁盘项目')
    try {
      const workflow = state.workflowDocument
      const result = await bridge.exportWorkflowPackage({ projectPath, workflow })
      if (get().projectPath === projectPath) set({ toast: result.saved ? `Workflow 包已导出：${result.path ?? ''}` : '已取消导出' })
    } catch (error) {
      set({ toast: error instanceof Error ? `导出失败：${error.message}` : '导出失败' })
    }
  },
  importWorkflowPackage: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || typeof bridge.importWorkflowPackage !== 'function') return get().showToast('请先打开磁盘项目')
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(state))
    try {
      const transition = await flushBeforeWorkflowScopeChange(scopeTicket, get)
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `导入已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '导入已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') return
      const result = await bridge.importWorkflowPackage({ projectPath })
      if (!result.imported) return
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) {
        if (get().projectPath === projectPath && get().workflowId === state.workflowId) {
          set({ toast: '导入选择期间 Workflow 发生变化；已保留当前画布，请重新导入' })
        }
        return
      }
      const now = new Date().toISOString()
      const imported: WorkflowDocument = {
        ...result.workflow,
        id: crypto.randomUUID(),
        name: `${result.workflow.name} · 导入`,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        metadata: { ...result.workflow.metadata, importedFromWorkflowId: result.workflow.id },
      }
      const saved = await bridge.saveWorkflow({ projectPath, workflow: imported })
      const formalImported: WorkflowDocument = {
        ...imported,
        revision: saved.revision,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      }
      const missing = [
        ...result.compatibility.missingProviderIds.map((id) => `接口 ${id}`),
        ...result.compatibility.missingNodeTypes.map((type) => `节点 ${type}`),
        ...result.compatibility.missingPlugins.map((plugin) => `插件 ${plugin.id}@${plugin.versionLock}`),
      ]
      const current = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(current))) {
        if (current.projectPath === projectPath) {
          set({
            workflows: upsertFormalWorkflow(current.workflows, formalImported),
            ...(current.workflowId === state.workflowId
              ? { toast: `已导入“${formalImported.name}”，但当前 Workflow 随后发生变化；已保留当前画布` }
              : {}),
          })
        }
        return
      }
      clearPreparedRunSessions()
      const editorUpdate = workflowEditorState(formalImported, projectPath)
      set({
        ...editorUpdate,
        workflows: upsertFormalWorkflow(current.workflows, formalImported),
        modal: 'none',
        ...clearedPreparedRunState(),
        workflowVersions: [],
        toast: missing.length ? `已安全导入；仍缺少：${missing.slice(0, 4).join('、')}` : `已导入“${formalImported.name}”`,
      })
    } catch (error) {
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `导入失败：${error.message}` : '导入失败' })
    }
  },
  createProject: async (name) => {
    const bridge = remoteBridge()
    if (!bridge) return get().showToast('当前没有 Electron 预加载桥，无法创建磁盘项目')
    const source = get()
    if (source.connectionState === 'loading') {
      set({ toast: '正在读取账户和项目，请完成后再创建项目' })
      return
    }
    const sourceCapture = captureWorkflowDocument(source.workflowDocument, workflowPlanFingerprint)
    const loadEpoch = ++projectLoadEpoch
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(source))
    try {
      const transition = await workflowStoreCoordinator.flushDraftThenCommit(
        scopeTicket,
        () => workflowOperationIdentity(get()),
        () => workflowEditorSession.flushDraft(),
        () => undefined,
      )
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `项目切换已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '项目切换已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') {
        if (get().projectPath === source.projectPath && get().workflowId === source.workflowId) {
          set({ toast: '项目创建期间 Workflow 发生变化；已保留当前画布，请重试' })
        }
        return
      }
      if (loadEpoch !== projectLoadEpoch) return
      if (!matchesWorkflowDocumentCapture(sourceCapture, get().workflowDocument, workflowPlanFingerprint)) {
        set({ toast: '草稿保存期间 Workflow 已变化；为避免保存错版本，请重新创建项目' })
        return
      }
      const now = new Date().toISOString()
      const initialWorkflow: WorkflowDocument = {
        ...sourceCapture.document,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      }
      const project = await bridge.createProject({ name, initialWorkflow })
      const snapshot = await readProjectSnapshot(bridge, project.path)
      if (loadEpoch !== projectLoadEpoch) return
      const latest = get()
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(latest))
        || !matchesWorkflowDocumentCapture(sourceCapture, latest.workflowDocument, workflowPlanFingerprint)) {
        set({ toast: `项目“${project.name}”已创建，但当前 Workflow 随后发生变化；已保留当前画布，请重新打开新项目` })
        return
      }
      const workflow = snapshot.workflow
      const draftRecovery = recoverableDraft(workflow, snapshot.draft)
      clearPreparedRunSessions()
      set({
        projectPath: project.path,
        projectName: project.name,
        availableProjects: [project, ...latest.availableProjects.filter((item) => item.id !== project.id)],
        connectionState: 'ready',
        modal: draftRecovery ? 'draft-recovery' : 'none',
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        pendingDraftRecovery: draftRecovery,
        workflowVersions: [],
        archivedWorkflows: [],
        workflows: snapshot.workflows,
        ...(workflow ? workflowEditorState(workflow, project.path) : emptyEditorState(project.name, project.path)),
        assets: snapshot.assets,
        boards: snapshot.boards,
        selectedBoardId: 'all',
        queue: snapshot.queue,
        plugins: snapshot.plugins,
        presets: snapshot.presets,
        lastPresetDiffs: [],
        runs: snapshot.runs,
        selectedRunId: snapshot.runs[0]?.runId,
        timeline: emptyTimeline(),
        toast: `项目“${project.name}”已创建`,
      })
    } catch (error) {
      if (loadEpoch !== projectLoadEpoch) return
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `创建项目失败：${error.message}` : '创建项目失败' })
    }
  },
  openProject: async (requestedProjectPath) => {
    const bridge = remoteBridge()
    if (!bridge) return get().showToast('当前没有 Electron 预加载桥，无法打开磁盘项目')
    const source = get()
    if (source.connectionState === 'loading') {
      set({ toast: '正在读取账户和项目，请完成后再打开其他项目' })
      return
    }
    if (!requestedProjectPath) {
      try {
        const payload = await bridge.bootstrap()
        const projects = [...payload.projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        if (projects.length === 0) {
          set({ availableProjects: [], toast: '默认 Studio 工作区中还没有项目，请先创建一个项目' })
          return
        }
        set({ availableProjects: projects })
        if (projects.length === 1) {
          await get().openProject(projects[0]?.path)
          return
        }
        set({ modal: 'project-picker' })
      } catch (error) {
        set({ toast: error instanceof Error ? `读取项目列表失败：${error.message}` : '读取项目列表失败' })
      }
      return
    }
    const loadEpoch = ++projectLoadEpoch
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(source))
    try {
      const transition = await workflowStoreCoordinator.flushDraftThenCommit(
        scopeTicket,
        () => workflowOperationIdentity(get()),
        () => workflowEditorSession.flushDraft(),
        () => undefined,
      )
      if (transition.status === 'flush-failed') {
        set({ toast: transition.error instanceof Error
          ? `项目切换已取消，当前 Workflow 草稿保存失败：${transition.error.message}`
          : '项目切换已取消，当前 Workflow 草稿保存失败' })
        return
      }
      if (transition.status === 'stale') {
        if (get().projectPath === source.projectPath && get().workflowId === source.workflowId) {
          set({ toast: '项目切换期间 Workflow 发生变化；已保留当前画布，请重试' })
        }
        return
      }
      if (loadEpoch !== projectLoadEpoch) return
      const project = await bridge.openProject({ path: requestedProjectPath })
      const snapshot = await readProjectSnapshot(bridge, project.path)
      if (loadEpoch !== projectLoadEpoch) return
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) {
        set({ toast: `项目“${project.name}”已读取，但当前 Workflow 随后发生变化；已保留当前画布，请重新打开项目` })
        return
      }
      const workflow = snapshot.workflow
      const draftRecovery = recoverableDraft(workflow, snapshot.draft)
      clearPreparedRunSessions()
      set({
        projectPath: project.path,
        projectName: project.name,
        availableProjects: [project, ...get().availableProjects.filter((item) => item.id !== project.id)],
        connectionState: 'ready',
        modal: draftRecovery ? 'draft-recovery' : 'none',
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        pendingDraftRecovery: draftRecovery,
        workflowVersions: [],
        archivedWorkflows: [],
        workflows: snapshot.workflows,
        ...(workflow ? workflowEditorState(workflow, project.path) : emptyEditorState(project.name, project.path)),
        assets: snapshot.assets,
        boards: snapshot.boards,
        selectedBoardId: 'all',
        queue: snapshot.queue,
        plugins: snapshot.plugins,
        presets: snapshot.presets,
        lastPresetDiffs: [],
        runs: snapshot.runs,
        selectedRunId: snapshot.runs[0]?.runId,
        timeline: emptyTimeline(),
        toast: `已打开项目“${project.name}”`,
      })
    } catch (error) {
      if (loadEpoch !== projectLoadEpoch
        || !workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) return
      set({ toast: error instanceof Error ? `打开项目失败：${error.message}` : '打开项目失败' })
    }
  },
  ensureAssetPreview: async (assetId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const asset = state.assets.find((item) => item.id === assetId)
    const previewPath = asset?.previewPath ?? asset?.relativePath
    if (!bridge || !projectPath || !asset?.relativePath || !previewPath || asset.previewUrl) return
    const requestKey = `${projectPath}\u0000${assetId}`
    if (assetPreviewRequests.has(requestKey)) return
    assetPreviewRequests.add(requestKey)
    try {
      const previewUrl = await bridge.assetUrl({ projectPath, relativePath: previewPath })
      set((current) => {
        if (current.projectPath !== projectPath) return {}
        const currentAsset = current.assets.find((item) => item.id === assetId)
        if (!currentAsset || (currentAsset.previewPath ?? currentAsset.relativePath) !== previewPath) return {}
        return { assets: current.assets.map((item) => item.id === assetId ? { ...item, previewUrl } : item) }
      })
    } catch {
      // Missing/corrupt images retain their metadata and use the safe placeholder.
    } finally {
      assetPreviewRequests.delete(requestKey)
    }
  },
  reloadAssetPreview: async (assetId) => {
    set((state) => ({ assets: state.assets.map((asset) => {
      if (asset.id !== assetId) return asset
      const { previewUrl: _previewUrl, ...withoutPreview } = asset
      return withoutPreview
    }) }))
    await get().ensureAssetPreview(assetId)
  },
  refreshAssets: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath) return
    try {
      const raw = await bridge.listAssets({ projectPath })
      set((current) => {
        if (current.projectPath !== projectPath) return {}
        const existing = new Map(current.assets.map((asset) => [asset.id, asset]))
        const assets = raw.map((asset, index) => {
          const previous = existing.get(asset.id)
          const previewUrl = (previous?.previewPath ?? previous?.relativePath) === (asset.thumbnailPath ?? asset.relativePath) ? previous?.previewUrl : undefined
          return mapAsset(asset, index, previewUrl)
        })
        return { assets, boards: buildBoardItems(assets, snapshotFromBoardItems(current.boards)) }
      })
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `作品刷新失败：${error.message}` : '作品刷新失败' })
    }
  },
  refreshRuns: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath) return
    try {
      const runs = await bridge.listRuns({ projectPath })
      set((current) => current.projectPath !== projectPath ? {} : ({
        runs,
        selectedRunId: current.selectedRunId && runs.some((run) => run.runId === current.selectedRunId)
          ? current.selectedRunId
          : runs[0]?.runId,
      }))
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `运行记录刷新失败：${error.message}` : '运行记录刷新失败' })
    }
  },
  refreshQueue: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath) return
    try {
      const [tasks, runs, persistentRuns] = await Promise.all([
        bridge.listTasks({ projectPath }),
        bridge.listRuns({ projectPath }),
        typeof bridge.listPersistentRuns === 'function' ? bridge.listPersistentRuns({ projectPath }) : Promise.resolve([]),
      ])
      set((current) => {
        if (current.projectPath !== projectPath) return {}
        const queue = mergeQueue(tasks, runs, persistentRuns)
        return {
          queue,
          runs,
          selectedQueueId: current.selectedQueueId && queue.some((item) => item.id === current.selectedQueueId)
            ? current.selectedQueueId
            : queue[0]?.id ?? '',
          selectedRunId: current.selectedRunId && runs.some((run) => run.runId === current.selectedRunId)
            ? current.selectedRunId
            : runs[0]?.runId,
        }
      })
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `任务队列刷新失败：${error.message}` : '任务队列刷新失败' })
    }
  },
  resumePersistentRun: async (itemId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const item = state.queue.find((candidate) => candidate.id === itemId)
    if (!bridge || !projectPath || state.connectionState !== 'ready' || typeof bridge.resumePersistentRun !== 'function') {
      set({ toast: '当前 Electron 版本不支持恢复持久任务' })
      return
    }
    if (!item?.canResume || item.persistentStatus !== 'paused' || item.dispatchState !== 'not_sent') {
      set({ toast: item?.blockedReason ?? '只有明确尚未派发的暂停任务才能恢复' })
      return
    }
    set((current) => ({
      queue: current.queue.map((candidate) => candidate.id === itemId
        ? { ...candidate, status: 'running', progress: 1, message: '已明确确认恢复；主进程正在重新预检' }
        : candidate),
      toast: '正在重新预检恢复项；不会复用旧计划，也不会自动重发已发送请求',
    }))
    try {
      const result = await bridge.resumePersistentRun({ projectPath, itemId })
      if (get().projectPath !== projectPath) return
      await get().refreshQueue()
      await get().refreshAssets()
      if (get().projectPath === projectPath) {
        set({ toast: result.status === 'succeeded' ? '恢复任务已完成' : result.error?.message ?? `恢复任务${result.status}` })
      }
    } catch (error) {
      if (get().projectPath !== projectPath) return
      await get().refreshQueue()
      set({ toast: error instanceof Error ? `恢复失败：${error.message}` : '恢复失败' })
    }
  },
  removePersistentRun: async (itemId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const item = state.queue.find((candidate) => candidate.id === itemId)
    if (!bridge || !projectPath || state.connectionState !== 'ready' || typeof bridge.removePersistentRun !== 'function') {
      set({ toast: '当前 Electron 版本不支持移除恢复项' })
      return
    }
    if (!item?.canRemove || item.persistentStatus !== 'paused' || item.dispatchState !== 'not_sent') {
      set({ toast: item?.blockedReason ?? '只能移除明确尚未派发的暂停恢复项' })
      return
    }
    try {
      const removed = await bridge.removePersistentRun({ projectPath, itemId })
      if (get().projectPath !== projectPath) return
      await get().refreshQueue()
      if (get().projectPath === projectPath) set({ toast: removed ? '恢复项已移除；没有发送远程请求' : '恢复项已不存在' })
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `移除恢复项失败：${error.message}` : '移除恢复项失败' })
    }
  },
  exportDiagnostics: async (runId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath) return get().showToast('请先打开 Electron 项目，再导出真实运行诊断包')
    try {
      const result = await bridge.exportDiagnostics({ projectPath, runId })
      if (get().projectPath === projectPath) set({ toast: result.saved ? `脱敏诊断包已保存：${result.path ?? 'JSON 文件'}` : '已取消导出' })
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `诊断导出失败：${error.message}` : '诊断导出失败' })
    }
  },
  upsertProvider: async (draft) => {
    const bridge = remoteBridge()
    if (!bridge) {
      get().showToast('测试预览未连接 Electron，不会保存接口配置')
      return false
    }
    try {
      const saved = await bridge.upsertProvider(draft)
      const previous = get().providers.find((item) => item.id === saved.id)
      const provider = mapProvider(saved, previous?.models)
      set((state) => ({
        ...workflowProviderProjectionState([provider, ...state.providers.filter((item) => item.id !== provider.id)]),
        toast: `接口“${provider.name}”已保存`,
      }))
      return true
    } catch (error) {
      set({ toast: error instanceof Error ? `接口保存失败：${error.message}` : '接口保存失败' })
      return false
    }
  },
  probeProvider: async (providerId) => {
    const bridge = remoteBridge()
    if (!bridge) return get().showToast('测试预览未连接 Electron，不会发送连接测试')
    try {
      const result = await bridge.probeProvider({ providerId })
      set((state) => {
        const providers: readonly ProviderItem[] = state.providers.map((item) => item.id === providerId ? {
          ...item,
          status: result.ok ? 'connected' : 'error',
          lastProbeMessage: result.message,
          ...(result.ok ? { models: normalizeProviderModels(result.models) } : {}),
        } : item)
        return { ...workflowProviderProjectionState(providers), toast: result.message }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接测试失败'
      set((state) => ({
        ...workflowProviderProjectionState(state.providers.map((item) => item.id === providerId
          ? { ...item, status: 'error', lastProbeMessage: message }
          : item)),
        toast: message,
      }))
    }
  },
  acceptProviderImport: async (requestId) => {
    const bridge = remoteBridge()
    if (!bridge || typeof bridge.acceptProviderImport !== 'function') {
      set({ toast: '当前桌面桥不支持安全接口导入' })
      return
    }
    if (get().providerImportBusy) return
    set({ providerImportBusy: requestId })
    try {
      const saved = await bridge.acceptProviderImport({ requestId })
      const previous = get().providers.find((item) => item.id === saved.id)
      const provider = mapProvider(saved, previous?.models)
      set((state) => ({
        ...workflowProviderProjectionState([provider, ...state.providers.filter((item) => item.id !== provider.id)]),
        pendingProviderImports: state.pendingProviderImports.filter((item) => item.requestId !== requestId),
        page: 'workflow',
        toast: `接口“${provider.name}”已安全保存；尚未测试连接，也没有发送生图请求`,
      }))
    } catch (error) {
      set({ toast: error instanceof Error ? `接口导入失败：${error.message}` : '接口导入失败' })
    } finally {
      if (get().providerImportBusy === requestId) set({ providerImportBusy: undefined })
    }
  },
  dismissProviderImport: async (requestId) => {
    const bridge = remoteBridge()
    if (!bridge || typeof bridge.dismissProviderImport !== 'function') {
      set((state) => ({
        pendingProviderImports: state.pendingProviderImports.filter((item) => item.requestId !== requestId),
        toast: '接口导入已取消',
      }))
      return
    }
    if (get().providerImportBusy) return
    set({ providerImportBusy: requestId })
    try {
      await bridge.dismissProviderImport({ requestId })
      set((state) => ({ pendingProviderImports: state.pendingProviderImports.filter((item) => item.requestId !== requestId), toast: '接口导入已取消，未保存任何配置' }))
    } catch (error) {
      set({ toast: error instanceof Error ? `取消导入失败：${error.message}` : '取消导入失败' })
    } finally {
      if (get().providerImportBusy === requestId) set({ providerImportBusy: undefined })
    }
  },
  deleteProvider: async (providerId) => {
    const bridge = remoteBridge()
    if (!bridge) return get().showToast('测试预览未连接 Electron，没有可删除的账户配置')
    try {
      await bridge.deleteProvider({ providerId })
      set((state) => ({
        ...workflowProviderProjectionState(state.providers.filter((item) => item.id !== providerId)),
        toast: '接口已删除',
      }))
    } catch (error) {
      set({ toast: error instanceof Error ? `删除失败：${error.message}` : '删除失败' })
    }
  },
  savePlugin: async (plugin) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    try {
      const saved = bridge && projectPath && state.connectionState === 'ready'
        ? await bridge.upsertPlugin({ projectPath, plugin })
        : plugin
      set((current) => projectPath && current.projectPath !== projectPath ? {} : ({
        plugins: [saved, ...current.plugins.filter((item) => item.manifest.id !== saved.manifest.id)],
        toast: bridge && projectPath ? `Manifest“${saved.manifest.name}”已保存；未执行插件入口` : `演示 Manifest“${saved.manifest.name}”已载入内存`,
      }))
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `Manifest 保存失败：${error.message}` : 'Manifest 保存失败' })
    }
  },
  deletePlugin: async (pluginId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    try {
      if (bridge && projectPath && state.connectionState === 'ready') await bridge.deletePlugin({ projectPath, pluginId })
      set((current) => projectPath && current.projectPath !== projectPath ? {} : ({ plugins: current.plugins.filter((item) => item.manifest.id !== pluginId), toast: 'Manifest 记录已删除；项目节点数据未被改写' }))
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `Manifest 删除失败：${error.message}` : 'Manifest 删除失败' })
    }
  },
  savePreset: async (preset) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    try {
      const saved = bridge && projectPath && state.connectionState === 'ready'
        ? await bridge.upsertPreset({ projectPath, preset })
        : preset
      set((current) => projectPath && current.projectPath !== projectPath ? {} : ({ presets: [saved, ...current.presets.filter((item) => item.id !== saved.id)], toast: `预设“${saved.name}”已保存` }))
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `预设保存失败：${error.message}` : '预设保存失败' })
    }
  },
  deletePreset: async (presetId) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    try {
      if (bridge && projectPath && state.connectionState === 'ready') await bridge.deletePreset({ projectPath, presetId })
      set((current) => projectPath && current.projectPath !== projectPath ? {} : ({ presets: current.presets.filter((item) => item.id !== presetId), toast: '预设已删除' }))
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `预设删除失败：${error.message}` : '预设删除失败' })
    }
  },
  importPresets: async () => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || state.connectionState !== 'ready') return get().showToast('请先打开 Electron 项目再导入预设 JSON')
    try {
      const result = await bridge.importPresets({ projectPath })
      set((current) => current.projectPath !== projectPath ? {} : ({
        presets: result.presets.reduce<ParameterPresetRecord[]>((items, preset) => [preset, ...items.filter((item) => item.id !== preset.id)], [...current.presets]),
        toast: result.imported > 0 ? `已导入 ${result.imported} 个预设` : '已取消导入',
      }))
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `预设导入失败：${error.message}` : '预设导入失败' })
    }
  },
  exportPresets: async (presetIds) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || state.connectionState !== 'ready') return get().showToast('请先打开 Electron 项目再导出预设 JSON')
    if (presetIds.length === 0) return get().showToast('请选择至少一个预设')
    try {
      const result = await bridge.exportPresets({ projectPath, presetIds })
      if (get().projectPath === projectPath) set({ toast: result.saved ? `预设已导出：${result.path ?? 'JSON 文件'}` : '已取消导出' })
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `预设导出失败：${error.message}` : '预设导出失败' })
    }
  },
  applyPresets: (presetIds) => {
    const state = get()
    const selected = presetIds.map((id) => state.presets.find((preset) => preset.id === id)).filter((preset): preset is ParameterPresetRecord => preset !== undefined)
    if (selected.length === 0) return get().showToast('请选择至少一个预设')
    try {
      const modelField = state.linearDefinition.fields.find((field) => field.parameter === 'model')
      const result = stackPresets(state.linearValues, selected, String(modelField ? state.linearValues[modelField.id] ?? '' : ''))
      const updates: Record<string, string | number> = {}
      state.linearDefinition.fields.forEach((field) => {
        const value = result.values[field.id]
        if (typeof value === 'string' && value.length <= 4000 && (field.parameter !== 'model' || value.trim())) updates[field.id] = value
        if (typeof value === 'number' && Number.isFinite(value)
          && (field.parameter !== 'seed' || (Number.isSafeInteger(value) && value >= 0))
          && (field.parameter !== 'count' || (Number.isSafeInteger(value) && value >= 1 && value <= 8))) updates[field.id] = value
      })
      const appliedPaths = new Set(Object.keys(updates))
      const appliedDiffs = result.diffs.filter((diff) => appliedPaths.has(diff.path))
      const transition = workflowEditorSession.dispatch({
        kind: 'linear/set-values',
        values: updates,
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        lastPresetDiffs: appliedDiffs,
        toast: `已按顺序叠加 ${selected.length - result.skipped.length} 个预设，应用 ${appliedDiffs.length} 项差异${result.skipped.length ? `；跳过 ${result.skipped.length} 个模型不适用预设` : ''}`,
      })
    } catch (error) {
      set({ toast: error instanceof Error ? `预设应用失败：${error.message}` : '预设应用失败' })
    }
  },
  cancelTask: async (taskId) => {
    const state = get()
    const bridge = remoteBridge()
    if (!bridge) {
      set((current) => ({
        queue: current.queue.map((item) => item.id === taskId
          ? { ...item, status: 'error', message: '演示任务已取消' }
          : item),
        toast: '演示任务已取消',
      }))
      return
    }
    if (state.connectionState !== 'ready') {
      set({ toast: 'Studio 尚未连接，未发送取消请求' })
      return
    }
    try {
      const trackedActiveRun = studioRunSession.getSnapshot().activeRunIds.includes(taskId)
      const accepted = trackedActiveRun
        ? await studioRunSession.cancel(taskId)
        : await bridge.cancelRun({ runId: taskId })
      set({ toast: accepted ? '取消请求已提交' : '任务已结束或不在当前运行队列中，未发送取消请求' })
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : '取消失败' })
    }
  },
  toggleFavorite: async (assetId) => {
    const state = get()
    const projectPath = state.projectPath
    const asset = state.assets.find((item) => item.id === assetId)
    if (!asset) return
    const favorite = !asset.favorite
    const nextAssets = state.assets.map((item) => item.id === assetId ? { ...item, favorite } : item)
    set({ assets: nextAssets, boards: buildBoardItems(nextAssets, snapshotFromBoardItems(state.boards)) })
    const bridge = remoteBridge()
    if (!bridge || !projectPath || state.connectionState !== 'ready') return
    try {
      await bridge.updateAsset({ projectPath, assetId, favorite })
    } catch (error) {
      set((current) => {
        if (current.projectPath !== projectPath) return {}
        const assets = current.assets.map((item) => item.id === assetId ? { ...item, favorite: asset.favorite } : item)
        return {
          assets,
          boards: buildBoardItems(assets, snapshotFromBoardItems(current.boards)),
          toast: error instanceof Error ? `收藏保存失败：${error.message}` : '收藏保存失败',
        }
      })
    }
  },
  reuseAsset: (assetId, mode) => set((state) => {
    const asset = state.assets.find((item) => item.id === assetId)
    if (!asset) return { toast: '要复用的作品不存在' }
    if (mode === 'seed' && asset.seed === undefined) return { toast: '该作品没有可复用的 Seed' }
    const root = state.graphs.root ?? activeGraph(state)
    const textNode = root.nodes.find((node) => node.data.nodeType === 'text')
    const generationNode = root.nodes.find((node) => node.data.nodeType === 'image_generation')
    if ((mode === 'prompt' && !textNode) || (mode !== 'prompt' && !generationNode)) {
      return { toast: mode === 'prompt' ? '当前 Workflow 没有文本节点' : '当前 Workflow 没有图像生成节点' }
    }
    const patches = new Map<string, Readonly<Record<string, unknown>>>()
    if (mode === 'prompt' || mode === 'all') {
      if (!textNode) return { toast: '当前 Workflow 没有文本节点，无法复用完整参数' }
      patches.set(textNode.id, { text: asset.prompt })
    }
    if (mode === 'seed' || mode === 'all') {
      if (!generationNode) return { toast: '当前 Workflow 没有图像生成节点' }
      const size = /^\d+[×x]\d+$/.test(asset.size) ? asset.size.replace('×', 'x') : undefined
      patches.set(generationNode.id, {
        ...(mode === 'all' ? { model: asset.model, ...(size ? { size } : {}) } : {}),
        ...(asset.seed !== undefined ? { seed: asset.seed } : {}),
      })
    }
    const target = mode === 'prompt' ? textNode : generationNode
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/update-nodes',
      graphId: 'root',
      updates: [...patches.entries()].map(([nodeId, parameters]) => ({ nodeId, parameters })),
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
    })
    return {
      page: 'workflow',
      activeGraphId: 'root',
      selectedNodeId: target?.id,
      ...workflowProjectionState(transition.snapshot),
      toast: mode === 'prompt' ? '已把作品提示词载入当前 Workflow' : mode === 'seed' ? '已把 Seed 载入当前 Workflow' : '已把作品参数载入当前 Workflow，可调整后重新生成',
    }
  }),
  setCandidateDecision: async (assetId, decision) => {
    const state = get()
    const projectPath = state.projectPath
    const asset = state.assets.find((item) => item.id === assetId)
    if (!asset) return
    const previousDecisions = new Map(
      state.assets
        .filter((item) => item.candidateGroup === asset.candidateGroup)
        .map((item) => [item.id, item.decision] as const),
    )
    const nextAssets = state.assets.map((item) => {
      if (item.id === assetId) return { ...item, decision }
      if (decision === 'adopted' && item.candidateGroup === asset.candidateGroup && item.decision === 'adopted') {
        return { ...item, decision: 'pending' as const }
      }
      return item
    })
    set({ assets: nextAssets, boards: buildBoardItems(nextAssets, snapshotFromBoardItems(state.boards)) })
    const bridge = remoteBridge()
    if (!bridge || !projectPath || state.connectionState !== 'ready') return
    try {
      await bridge.updateAsset({ projectPath, assetId, decision })
    } catch (error) {
      set((current) => {
        if (current.projectPath !== projectPath) return {}
        const assets = current.assets.map((item) => {
          const previous = previousDecisions.get(item.id)
          return previous === undefined ? item : { ...item, decision: previous }
        })
        return {
          assets,
          boards: buildBoardItems(assets, snapshotFromBoardItems(current.boards)),
          toast: error instanceof Error ? `候选决策保存失败：${error.message}` : '候选决策保存失败',
        }
      })
    }
  },
  updateAssetTags: async (assetId, tags) => {
    const state = get()
    const projectPath = state.projectPath
    const asset = state.assets.find((item) => item.id === assetId)
    if (!asset) return
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    const nextAssets = state.assets.map((item) => item.id === assetId ? { ...item, tags: normalized } : item)
    set({ assets: nextAssets, boards: buildBoardItems(nextAssets, snapshotFromBoardItems(state.boards)) })
    const bridge = remoteBridge()
    if (!bridge || !projectPath || state.connectionState !== 'ready') return
    try {
      await bridge.updateAsset({ projectPath, assetId, tags: normalized })
    } catch (error) {
      set((current) => {
        if (current.projectPath !== projectPath) return {}
        const assets = current.assets.map((item) => item.id === assetId ? { ...item, tags: asset.tags } : item)
        return {
          assets,
          boards: buildBoardItems(assets, snapshotFromBoardItems(current.boards)),
          toast: error instanceof Error ? `标签保存失败：${error.message}` : '标签保存失败',
        }
      })
    }
  },
  copyText: async (text) => {
    const bridge = remoteBridge()
    if (!bridge) return get().showToast('测试预览未连接 Electron，不会访问系统剪贴板')
    try {
      await bridge.copyText({ text })
      set({ toast: '已复制到系统剪贴板' })
    } catch (error) {
      set({ toast: error instanceof Error ? `复制失败：${error.message}` : '复制失败' })
    }
  },
  exportAssets: async (assetIds) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    if (!bridge || !projectPath || state.connectionState !== 'ready') return get().showToast('请先打开 Electron 项目再导出真实文件')
    if (assetIds.length === 0) return get().showToast('请先选择要导出的作品')
    try {
      const result = await bridge.exportAssets({
        projectPath,
        assetIds,
        filenameTemplate: state.filenameTemplate,
      })
      if (get().projectPath === projectPath) set({ toast: result.destination ? `已导出 ${result.exported} 个作品到 ${result.destination}` : '已取消导出' })
    } catch (error) {
      if (get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `导出失败：${error.message}` : '导出失败' })
    }
  },
  upsertBoard: async (board) => {
    const state = get()
    const projectPath = state.projectPath
    const normalized: Board = { ...board, assetIds: [...new Set(board.assetIds)] }
    const bridge = remoteBridge()
    try {
      const saved = bridge && projectPath && state.connectionState === 'ready'
        ? await bridge.upsertBoard({ projectPath, board: normalized })
        : normalized
      set((current) => {
        if (projectPath && current.projectPath !== projectPath) return {}
        const snapshot = snapshotFromBoardItems(current.boards)
        const boards = [...snapshot.boards]
        const index = boards.findIndex((item) => item.id === saved.id)
        if (index >= 0) boards[index] = saved
        else boards.push(saved)
        return {
          boards: buildBoardItems(current.assets, { ...snapshot, boards }),
          selectedBoardId: saved.id,
          toast: bridge ? `Board“${saved.name}”已保存` : `演示 Board“${saved.name}”已创建`,
        }
      })
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `Board 保存失败：${error.message}` : 'Board 保存失败' })
    }
  },
  upsertSmartCollection: async (collection) => {
    const state = get()
    const projectPath = state.projectPath
    const bridge = remoteBridge()
    try {
      const saved = bridge && projectPath && state.connectionState === 'ready'
        ? await bridge.upsertSmartCollection({ projectPath, collection })
        : collection
      set((current) => {
        if (projectPath && current.projectPath !== projectPath) return {}
        const snapshot = snapshotFromBoardItems(current.boards)
        const smartCollections = [...snapshot.smartCollections]
        const index = smartCollections.findIndex((item) => item.id === saved.id)
        if (index >= 0) smartCollections[index] = saved
        else smartCollections.push(saved)
        return {
          boards: buildBoardItems(current.assets, { ...snapshot, smartCollections }),
          selectedBoardId: saved.id,
          toast: bridge ? `智能集合“${saved.name}”已保存` : `演示智能集合“${saved.name}”已创建`,
        }
      })
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `智能集合保存失败：${error.message}` : '智能集合保存失败' })
    }
  },
  deleteCollection: async (collectionId, kind) => {
    const state = get()
    const projectPath = state.projectPath
    const target = state.boards.find((item) => item.id === collectionId && item.kind === kind)
    if (!target || target.builtin) return get().showToast('系统集合不能删除')
    const bridge = remoteBridge()
    try {
      if (bridge && projectPath && state.connectionState === 'ready') {
        if (kind === 'board') await bridge.deleteBoard({ projectPath, boardId: collectionId })
        else await bridge.deleteSmartCollection({ projectPath, collectionId })
      }
      set((current) => {
        if (projectPath && current.projectPath !== projectPath) return {}
        const remaining = current.boards.filter((item) => item.id !== collectionId)
        return {
          boards: buildBoardItems(current.assets, snapshotFromBoardItems(remaining)),
          selectedBoardId: current.selectedBoardId === collectionId ? 'all' : current.selectedBoardId,
          toast: `集合“${target.name}”已删除`,
        }
      })
    } catch (error) {
      if (projectPath && get().projectPath !== projectPath) return
      set({ toast: error instanceof Error ? `集合删除失败：${error.message}` : '集合删除失败' })
    }
  },
  addAssetsToBoard: async (boardId, assetIds) => {
    const board = get().boards.find((item) => item.id === boardId && item.kind === 'board')
    if (!board) return get().showToast('请选择一个普通 Board')
    await get().upsertBoard({
      id: board.id,
      name: board.name,
      description: board.description ?? '',
      assetIds: [...new Set([...(board.assetIds ?? []), ...assetIds])],
    })
  },
  createInpaintFromAsset: async (assetId, pngBase64, prompt, inputFidelity) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    const asset = state.assets.find((item) => item.id === assetId)
    const provider = accountProviders(state.providers).find((item) => item.id === asset?.providerId)
      ?? accountProviders(state.providers)[0]
    if (!asset?.relativePath || !bridge || !projectPath || state.connectionState !== 'ready') {
      return get().showToast('局部重绘需要先打开包含真实作品的 Electron 项目')
    }
    if (!provider) return get().showToast('当前账户没有可用于图片编辑的分组')
    if (!prompt.trim()) return get().showToast('编辑提示词不能为空')
    try {
      const savedMask = await bridge.saveAssetMask({ projectPath, assetId, pngBase64 })
      const current = get()
      if (current.projectPath !== projectPath || current.workflowId !== workflowId) return
      const currentAsset = current.assets.find((item) => item.id === assetId) ?? asset
      const currentProvider = accountProviders(current.providers).find((item) => item.id === currentAsset.providerId)
        ?? accountProviders(current.providers).find((item) => item.id === provider.id)
        ?? accountProviders(current.providers)[0]
      if (!currentProvider) return current.showToast('原图所用分组已不可用，请刷新分组')
      const sourceRelativePath = currentAsset.relativePath ?? asset.relativePath
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/insert-inpaint-chain',
        prompt: prompt.trim(),
        sourcePath: sourceRelativePath,
        maskPath: savedMask.relativePath,
        providerId: currentProvider.id,
        model: currentAsset.model || currentProvider.model,
        size: /^\d+×\d+$/.test(currentAsset.size) ? currentAsset.size.replace('×', 'x') : '1024x1024',
        inputFidelity,
        assetTitle: currentAsset.title,
        context: {
          graphId: current.activeGraphId,
          ...(current.selectedNodeId ? { selectedNodeId: current.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        activeGraphId: 'root',
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : current.selectedNodeId,
        page: 'workflow',
        workflowView: 'canvas',
        modal: 'none',
        toast: '蒙版已安全保存并生成局部重绘节点链；尚未发送远程请求',
      })
      await get().saveWorkflow()
    } catch (error) {
      if (get().projectPath !== projectPath || get().workflowId !== workflowId) return
      set({ toast: error instanceof Error ? `蒙版应用失败：${error.message}` : '蒙版应用失败' })
    }
  },
  importLocalImage: async (position) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    const graphId = state.activeGraphId
    if (!bridge || typeof bridge.importProjectImage !== 'function' || state.connectionState !== 'ready') return get().showToast('当前未连接桌面项目，请使用 BAT 启动 Electron 客户端')
    if (!projectPath) return get().showToast('请先创建或打开项目，再载入本地图片')
    if (state.localImageImporting) return get().showToast('正在载入图片，请稍候')

    set({ localImageImporting: true })
    try {
      const result = await bridge.importProjectImage({ projectPath })
      const current = get()
      if (current.projectPath !== projectPath || current.workflowId !== workflowId || current.activeGraphId !== graphId) return
      if (!result.imported) return set({ toast: '已取消载入本地图片' })

      let previewUrl: string | undefined
      let previewError: string | undefined
      try {
        previewUrl = await bridge.assetUrl({ projectPath, relativePath: result.relativePath })
      } catch (error) {
        previewError = error instanceof Error ? error.message : '预览地址签发失败'
      }

      const latest = get()
      if (latest.projectPath !== projectPath || latest.workflowId !== workflowId || latest.activeGraphId !== graphId) return
      const graph = latest.graphs[graphId]
      if (!graph) return
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/import-project-image',
        graphId,
        path: result.relativePath,
        position: position ?? findFreeNodePosition(graph.nodes),
        preview: {
          ...(previewUrl ? { url: previewUrl } : {}),
          ...(result.width ? { width: result.width } : {}),
          ...(result.height ? { height: result.height } : {}),
          ...(previewError ? { error: previewError } : {}),
        },
        context: {
          graphId,
          ...(latest.selectedNodeId ? { selectedNodeId: latest.selectedNodeId } : {}),
        },
      })
      set({
        ...workflowProjectionState(transition.snapshot),
        selectedNodeId: transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : latest.selectedNodeId,
        toast: previewUrl
          ? `已载入本地图片：${result.relativePath}`
          : `图片已导入，但预览暂不可用：${previewError}`,
      })
      const importedNodeId = transition.effect?.kind === 'focus-canvas' ? transition.effect.nodeId : undefined
      const projected = get()
      const projectedGraph = projected.graphs[graphId]
      const connection = importedNodeId && projectedGraph
        ? importedImageConnection(projectedGraph, importedNodeId, latest.selectedNodeId)
        : undefined
      if (importedNodeId && connection) {
        get().connect({
          source: importedNodeId,
          sourceHandle: `out:${connection.sourceSocket}`,
          target: connection.targetNode,
          targetHandle: `in:${connection.targetSocket}`,
        })
        const connected = get().graphs[graphId]?.edges.some((edge) => edge.source === importedNodeId
          && edge.target === connection.targetNode
          && edge.targetHandle?.replace(/^in:/, '') === connection.targetSocket)
        if (connected) {
          set({ toast: previewUrl ? '图片已载入并接入参考图' : `图片已接入参考图，但预览暂不可用：${previewError}` })
        }
      }
    } catch (error) {
      const current = get()
      if (current.projectPath !== projectPath || current.workflowId !== workflowId || current.activeGraphId !== graphId) return
      set({ toast: error instanceof Error ? `本地图片载入失败：${error.message}` : '本地图片载入失败' })
    } finally {
      set({ localImageImporting: false })
    }
  },
  ensureProjectImagePreview: async (graphId, nodeId, relativePath, force = false) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    const path = relativePath.trim()
    const node = state.graphs[graphId]?.nodes.find((item) => item.id === nodeId)
    if (!bridge || typeof bridge.assetUrl !== 'function' || !projectPath || state.connectionState !== 'ready' || !path || node?.data.nodeType !== 'project_image') return
    if (!force && node.data.previewUrl && node.data.parameters.path === path) return
    const requestKey = `${projectPath}\u0000${workflowId}\u0000${graphId}\u0000${nodeId}\u0000${path}`
    if (projectImagePreviewRequests.has(requestKey)) return
    projectImagePreviewRequests.add(requestKey)
    set((current) => {
      const graph = current.graphs[graphId]
      if (!graph) return {}
      return workflowRuntimeProjectionState({
        ...current.graphs,
        [graphId]: {
          ...graph,
          nodes: graph.nodes.map((item) => item.id === nodeId
            ? { ...item, data: { ...item.data, previewLoading: true, previewError: undefined } }
            : item),
        },
      })
    })
    try {
      const previewUrl = await bridge.assetUrl({ projectPath, relativePath: path })
      set((current) => {
        if (current.projectPath !== projectPath || current.workflowId !== workflowId || current.activeGraphId !== graphId) return {}
        const graph = current.graphs[graphId]
        const currentNode = graph?.nodes.find((item) => item.id === nodeId)
        if (!graph || currentNode?.data.parameters.path !== path) return {}
        return workflowRuntimeProjectionState({
          ...current.graphs,
          [graphId]: {
            ...graph,
            nodes: graph.nodes.map((item) => item.id === nodeId
              ? { ...item, data: { ...item.data, previewUrl, previewLoading: false, previewError: undefined } }
              : item),
          },
        })
      })
    } catch (error) {
      set((current) => {
        if (current.projectPath !== projectPath || current.workflowId !== workflowId || current.activeGraphId !== graphId) return {}
        const graph = current.graphs[graphId]
        const currentNode = graph?.nodes.find((item) => item.id === nodeId)
        if (!graph || currentNode?.data.parameters.path !== path) return {}
        return workflowRuntimeProjectionState({
          ...current.graphs,
          [graphId]: {
            ...graph,
            nodes: graph.nodes.map((item) => item.id === nodeId
              ? {
                  ...item,
                  data: {
                    ...item.data,
                    previewUrl: undefined,
                    previewLoading: false,
                    previewError: error instanceof Error ? error.message : '图片预览失败',
                  },
                }
              : item),
          },
        })
      })
    } finally {
      projectImagePreviewRequests.delete(requestKey)
    }
  },
  ensureResultImagePreview: async (graphId, nodeId, force = false) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    const node = state.graphs[graphId]?.nodes.find((item) => item.id === nodeId)
    if (!bridge || typeof bridge.assetUrl !== 'function' || !projectPath || state.connectionState !== 'ready' || node?.data.nodeType !== 'image_preview') return
    const existingPaths = Array.isArray(node.data.previewPaths)
      ? node.data.previewPaths.map(normalizePreviewPath).filter((path): path is string => Boolean(path))
      : []
    const paths = existingPaths.length > 0 ? existingPaths : previewPathsFromAssets(state, graphId, nodeId)
    if (paths.length === 0) return
    const existingUrls = Array.isArray(node.data.previewUrls) ? node.data.previewUrls : []
    if (!force && existingUrls.length === paths.length && existingUrls.every(Boolean)) return
    const ownerRunId = typeof node.data.previewRunId === 'string' ? node.data.previewRunId : undefined
    const requestKey = `${projectPath}\u0000${workflowId}\u0000${graphId}\u0000${nodeId}\u0000${paths.join('\u0001')}`
    if (resultImagePreviewRequests.has(requestKey)) return
    resultImagePreviewRequests.add(requestKey)
    set((current) => {
      if (current.projectPath !== projectPath || current.workflowId !== workflowId) return {}
      const graph = current.graphs[graphId]
      if (!graph) return {}
      return workflowRuntimeProjectionState({
        ...current.graphs,
        [graphId]: {
          ...graph,
          nodes: graph.nodes.map((item) => item.id === nodeId
            ? { ...item, data: { ...item.data, previewPaths: paths, previewLoading: true, previewError: undefined } }
            : item),
        },
      })
    })
    try {
      const settled = await Promise.allSettled(paths.map((relativePath) => bridge.assetUrl({ projectPath, relativePath })))
      const previewUrls = settled.map((item) => item.status === 'fulfilled' ? item.value : '')
      const failed = settled.filter((item) => item.status === 'rejected')
      const previewError = failed.length > 0
        ? `${failed.length}/${paths.length} 张结果预览加载失败${failed[0]?.status === 'rejected' && failed[0].reason instanceof Error ? `：${failed[0].reason.message}` : ''}`
        : undefined
      set((current) => {
        if (current.projectPath !== projectPath || current.workflowId !== workflowId) return {}
        const graph = current.graphs[graphId]
        const currentNode = graph?.nodes.find((item) => item.id === nodeId)
        if (!graph || currentNode?.data.nodeType !== 'image_preview') return {}
        if (ownerRunId && currentNode.data.previewRunId !== ownerRunId) return {}
        if (!Array.isArray(currentNode.data.previewPaths) || currentNode.data.previewPaths.join('\u0001') !== paths.join('\u0001')) return {}
        return workflowRuntimeProjectionState({
          ...current.graphs,
          [graphId]: {
            ...graph,
            nodes: graph.nodes.map((item) => item.id === nodeId
              ? {
                  ...item,
                  data: {
                    ...item.data,
                    previewUrl: previewUrls.find(Boolean),
                    previewUrls,
                    previewLoading: false,
                    previewError,
                  },
                }
              : item),
          },
        })
      })
    } finally {
      resultImagePreviewRequests.delete(requestKey)
    }
  },
  hydrateRunResultPreviews: async (result, projectPath, workflowId) => {
    if (result.status !== 'succeeded') return
    const state = get()
    if (state.projectPath !== projectPath || state.workflowId !== workflowId) return
    const previews = Object.entries(result.outputs).flatMap(([executionNodeId, output]) => {
      const target = executionNode(state.graphs, executionNodeId)
      if (!target || target.node.data.nodeType !== 'image_preview') return []
      const paths = previewPathsFromOutput(output)
      return paths.length > 0 ? [{ executionNodeId, graphId: target.graphId, nodeId: target.node.id, paths }] : []
    })
    if (previews.length === 0) return
    set((current) => {
      if (current.projectPath !== projectPath || current.workflowId !== workflowId) return {}
      const graphs = previews.reduce((next, preview) => updateExecutionNode(next, preview.executionNodeId, (node) => {
        if (node.data.nodeType !== 'image_preview') return {}
        return {
          previewUrl: undefined,
          previewUrls: [],
          previewPaths: preview.paths,
          previewRunId: result.runId,
          previewLoading: true,
          previewError: undefined,
        }
      }), current.graphs)
      return graphs === current.graphs ? {} : workflowRuntimeProjectionState(graphs)
    })
    await Promise.all(previews.map((preview) => get().ensureResultImagePreview(preview.graphId, preview.nodeId, true)))
  },
  chooseProjectImage: async (nodeId, parameter) => {
    const state = get()
    const bridge = remoteBridge()
    const projectPath = state.projectPath
    const workflowId = state.workflowId
    const graphId = state.activeGraphId
    if (!bridge || typeof bridge.importProjectImage !== 'function' || !projectPath || state.connectionState !== 'ready') return get().showToast('请先打开 Electron 项目再导入图片')
    if (state.localImageImporting) return get().showToast('正在载入图片，请稍候')
    const originalNode = state.graphs[graphId]?.nodes.find((node) => node.id === nodeId)
    if (!originalNode) return get().showToast('要替换图片的节点不存在')
    set({ localImageImporting: true })
    try {
      const result = await bridge.importProjectImage({ projectPath })
      const current = get()
      if (current.projectPath !== projectPath || current.workflowId !== workflowId || current.activeGraphId !== graphId) return
      if (!result.imported) return set({ toast: '已取消载入本地图片' })

      let previewUrl: string | undefined
      let previewError: string | undefined
      try {
        previewUrl = await bridge.assetUrl({ projectPath, relativePath: result.relativePath })
      } catch (error) {
        previewError = error instanceof Error ? error.message : '预览地址签发失败'
      }

      const latest = get()
      if (latest.projectPath !== projectPath || latest.workflowId !== workflowId || latest.activeGraphId !== graphId) return
      const graph = latest.graphs[graphId]
      if (!graph?.nodes.some((node) => node.id === nodeId)) return
      const transition = workflowEditorSession.dispatch({
        kind: 'canvas/set-project-image',
        graphId,
        nodeId,
        parameter,
        path: result.relativePath,
        preview: {
          ...(previewUrl ? { url: previewUrl } : {}),
          ...(result.width ? { width: result.width } : {}),
          ...(result.height ? { height: result.height } : {}),
          ...(previewError ? { error: previewError } : {}),
        },
        context: {
          graphId,
          ...(latest.selectedNodeId ? { selectedNodeId: latest.selectedNodeId } : {}),
        },
        })
      set({
        ...workflowProjectionState(transition.snapshot),
        toast: previewUrl
          ? `已替换本地图片：${result.relativePath}${result.width && result.height ? ` · ${result.width}×${result.height}` : ''}`
          : `图片已导入，但预览暂不可用：${previewError}`,
      })
    } catch (error) {
      if (get().projectPath !== projectPath || get().workflowId !== workflowId || get().activeGraphId !== graphId) return
      set({ toast: error instanceof Error ? `图片导入失败：${error.message}` : '图片导入失败' })
    } finally {
      set({ localImageImporting: false })
    }
  },
  clearProjectImage: (nodeId) => set((state) => {
    const graph = activeGraph(state)
    const node = graph.nodes.find((item) => item.id === nodeId)
    if (!node || node.data.nodeType !== 'project_image') return { toast: '本地图片节点不存在' }
    const transition = workflowEditorSession.dispatch({
      kind: 'canvas/set-project-image',
      graphId: state.activeGraphId,
      nodeId,
      parameter: 'path',
      path: '',
      context: {
        graphId: state.activeGraphId,
        ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
      },
      })
    return {
      ...workflowProjectionState(transition.snapshot),
      toast: '已清除图片引用；项目中的原文件未删除',
    }
  }),
  setFilenameTemplate: (filenameTemplate) => {
    try { window.localStorage.setItem('studio.filenameTemplate', filenameTemplate) } catch { /* non-persistent renderer */ }
    set({ filenameTemplate })
  },
  updateLinearValue: (key, value) => set((state) => {
    try {
      const snapshot = workflowEditorSession.dispatch({
        kind: 'linear/set-value',
        fieldId: key,
        value,
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      }).snapshot
      return workflowProjectionState(snapshot)
    } catch (error) {
      return { toast: error instanceof Error ? error.message : `Linear View 字段更新失败：${key}` }
    }
  }),
  setLinearField: (nodeId, parameter, label, exposed) => set((state) => {
    try {
      const snapshot = workflowEditorSession.dispatch({
        kind: 'linear/set-field',
        graphId: state.activeGraphId,
        nodeId,
        parameter,
        label,
        exposed,
        context: {
          graphId: state.activeGraphId,
          ...(state.selectedNodeId ? { selectedNodeId: state.selectedNodeId } : {}),
        },
      }).snapshot
      return {
        ...workflowProjectionState(snapshot),
        toast: exposed ? `已将“${label}”公开到 Linear View` : `已从 Linear View 隐藏“${label}”`,
      }
    } catch (error) {
      return { toast: error instanceof Error ? error.message : 'Linear View 字段配置失败' }
    }
  }),
  repairWorkflow: (action) => {
    try {
      const transition = workflowEditorSession.dispatch({ kind: 'readiness/repair', action })
      set(workflowProjectionState(transition.snapshot))
      const effect: WorkflowEditorEffect | undefined = transition.effect
      if (!effect) return
      if (effect.kind === 'request-project') {
        void get().requestTextInput({
          title: '创建项目',
          label: '项目名称',
          initialValue: effect.suggestedName,
          placeholder: '输入项目名称',
          confirmLabel: '创建项目',
          maxLength: 80,
        }).then((value) => {
          const name = value?.trim()
          if (name) void get().createProject(name)
        })
        return
      }
      if (effect.kind === 'focus-canvas') {
        set({
          page: 'workflow',
          workflowView: 'canvas',
          activeGraphId: effect.graphId,
          selectedNodeId: effect.nodeId,
        })
        return
      }
      set({
        page: 'workflow',
        workflowView: 'canvas',
        activeGraphId: effect.graphId,
        selectedNodeId: effect.nodeId,
      })
      void get().chooseProjectImage(effect.nodeId, effect.parameter)
    } catch (error) {
      set({ toast: error instanceof Error ? error.message : 'Workflow 修复失败' })
    }
  },
  toggleSafeMode: () => set((state) => { const value = !state.safeMode; writeBooleanPreference('studio.safeMode', value); return { safeMode: value } }),
  toggleGridSnap: () => set((state) => { const value = !state.gridSnap; writeBooleanPreference('studio.gridSnap', value); return { gridSnap: value } }),
  toggleMinimap: () => set((state) => { const value = !state.showMinimap; writeBooleanPreference('studio.showMinimap', value); return { showMinimap: value } }),
  bootstrap: async () => {
    const bridge = remoteBridge()
    if (!bridge) return
    if (get().connectionState === 'loading') return
    if (get().connectionState === 'ready') return get().refreshProviders()
    const loadEpoch = ++projectLoadEpoch
    const scopeTicket = workflowStoreCoordinator.beginScope(requireWorkflowOperationIdentity(get()))
    clearPreparedRunSessions()
    set({
      ...workflowProviderProjectionState([]),
      connectionState: 'loading',
      graphs: { root: emptyOnlineRoot },
      activeGraphId: 'root',
      selectedNodeId: undefined,
      selectedAssetId: '',
      selectedQueueId: '',
      assets: [],
      boards: buildBoardItems([], { schemaVersion: 1, boards: [], smartCollections: [] }),
      queue: [],
      runs: [],
      selectedRunId: undefined,
      timeline: emptyTimeline(),
      linearValues: {},
      linearDefinition: initialRuntimeLinearDefinition,
    })
    try {
      const payload = await bridge.bootstrap()
      const mappedProviders = payload.providers
        .filter(isAiTerminalAccountProvider)
        .map((provider) => mapProvider(provider))
      let projectUpdate: Partial<StudioState> = {}
      let editorWorkflow: WorkflowDocument
      let editorProjectPath: string | undefined
      if (payload.recentProjectPath) {
        const snapshot = await readProjectSnapshot(bridge, payload.recentProjectPath)
        const draftRecovery = recoverableDraft(snapshot.workflow, snapshot.draft)
        projectUpdate = {
          workflows: snapshot.workflows,
          assets: snapshot.assets,
          boards: snapshot.boards,
          selectedBoardId: 'all',
          queue: snapshot.queue,
          plugins: snapshot.plugins,
          presets: snapshot.presets,
          lastPresetDiffs: [],
          runs: snapshot.runs,
          selectedRunId: snapshot.runs[0]?.runId,
          pendingDraftRecovery: draftRecovery,
          modal: draftRecovery ? 'draft-recovery' : 'none',
          workflowVersions: [],
          archivedWorkflows: [],
        }
        if (snapshot.workflow) {
          editorWorkflow = snapshot.workflow
          editorProjectPath = payload.recentProjectPath
        } else {
          const projectName = payload.recentProjectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目'
          editorWorkflow = emptyWorkflowDocument(projectName)
          editorProjectPath = payload.recentProjectPath
        }
      } else {
        const quickStart = createQuickStartWorkflow(preferredProvider(mappedProviders))
        editorWorkflow = quickStart
        editorProjectPath = undefined
        projectUpdate = {
          workflows: [],
          assets: [],
          boards: buildBoardItems([], { schemaVersion: 1, boards: [], smartCollections: [] }),
          selectedAssetId: '',
          selectedBoardId: 'all',
          queue: [],
          selectedQueueId: '',
          plugins: [],
          presets: [],
          lastPresetDiffs: [],
          runs: [],
          selectedRunId: undefined,
          pendingDraftRecovery: undefined,
          workflowVersions: [],
          archivedWorkflows: [],
        }
      }
      if (loadEpoch !== projectLoadEpoch) {
        set((current) => current.connectionState === 'loading' ? {
          ...interruptedBootstrapState(current),
          toast: '启动读取已取消；当前 Workflow 保持不变',
        } : {})
        return
      }
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) {
        set((current) => current.connectionState !== 'loading' ? {} : ({
          ...interruptedBootstrapState(current),
          toast: '启动读取期间 Workflow 发生变化；已保留当前画布，请重试连接',
        }))
        return
      }
      studioRunSession.connect(bridge)
      if (!runSessionStoreUnsubscribe) {
        runSessionStoreUnsubscribe = studioRunSession.subscribe(() => {
          const feedback = studioRunSession.getSnapshot().latestFeedback
          if (!feedback) return
          const projection = feedback.run.projection
          const event = feedback.event
          set((state) => {
            let matchedRun = false
            const queue = state.queue.map((item) => {
              if (item.id !== feedback.run.runId) return item
              matchedRun = true
              return {
                ...item,
                status: taskStatusFromEvent(projection.status) ?? item.status,
                progress: projection.progress,
                message: projection.message,
                ...(projection.dispatchState ? { dispatchState: projection.dispatchState } : {}),
              }
            })
            if (!matchedRun) return {}

            let timeline = state.timeline
            let graphs = state.graphs
            if (event?.type === 'timeline') {
              const phaseEvent = event.event
              const durationMs = phaseEvent.durationMs ?? 0
              timeline = state.timeline.map((stage) => stage.id === phaseEvent.phase ? {
                ...stage,
                durationMs: phaseEvent.finishedAt ? stage.durationMs + durationMs : stage.durationMs,
                status: phaseEvent.errorCode ? 'error' : phaseEvent.finishedAt ? 'success' : 'running',
              } : stage)
              if (event.workflowId === state.workflowId) {
                graphs = updateExecutionNode(graphs, phaseEvent.nodeId, (node) => ({
                  status: phaseEvent.errorCode
                    ? 'error'
                    : phaseEvent.cacheHit === true && phaseEvent.finishedAt
                      ? 'success'
                      : 'running',
                  ...(phaseEvent.cacheHit === true ? { cacheHit: true } : {}),
                  ...(phaseEvent.finishedAt && phaseEvent.durationMs !== undefined
                    ? { runtimeMs: phaseEvent.cacheHit === true ? durationMs : (node.data.runtimeMs ?? 0) + durationMs }
                    : {}),
                }))
              }
            }

            const nodeStatus = projection.node ? nodeStatusFromTaskEvent(projection.node.status) : undefined
            if (projection.node && projection.workflowId === state.workflowId && nodeStatus) {
              graphs = updateExecutionNode(graphs, projection.node.nodeId, () => ({
                status: nodeStatus,
                ...(nodeStatus === 'running' ? { runtimeMs: 0, cacheHit: false } : {}),
              }))
            }
            return {
              queue,
              timeline,
              ...(graphs === state.graphs ? {} : workflowRuntimeProjectionState(graphs)),
            }
          })
        })
      }
      let editorUpdate: ReturnType<typeof workflowEditorState>
      try {
        editorUpdate = workflowEditorState(editorWorkflow, editorProjectPath)
      } catch (error) {
        throw error
      }
      const providerUpdate = workflowProviderProjectionState(mappedProviders)
      const recentProject = payload.projects.find((project) => project.path === payload.recentProjectPath)
      set((state) => ({
        connectionState: 'ready',
        appVersion: payload.version,
        projectPath: payload.recentProjectPath,
        projectName: recentProject?.name,
        availableProjects: payload.projects,
        timeline: emptyTimeline(),
        modal: 'none',
        pendingPlan: undefined,
        pendingWorkflow: undefined,
        pendingMatrixRuns: [],
        pendingMatrixPrepareGeneration: undefined,
        pendingTargetNodeIds: [],
        pendingProviderImports: [],
        ...projectUpdate,
        ...editorUpdate,
        ...providerUpdate,
      }))
    } catch (error) {
      if (loadEpoch !== projectLoadEpoch) {
        set((current) => current.connectionState === 'loading' ? {
          ...interruptedBootstrapState(current),
          toast: '启动读取已取消；当前 Workflow 保持不变',
        } : {})
        return
      }
      if (!workflowStoreCoordinator.current(scopeTicket, workflowOperationIdentity(get()))) {
        set((current) => current.connectionState === 'loading'
          ? { ...interruptedBootstrapState(current), toast: '启动读取已取消；当前 Workflow 保持不变' }
          : {})
        return
      }
      set({
        ...workflowProviderProjectionState([]),
        connectionState: 'error',
        availableProjects: [],
        assets: [],
        boards: buildBoardItems([], { schemaVersion: 1, boards: [], smartCollections: [] }),
        queue: [],
        runs: [],
        selectedRunId: undefined,
        toast: error instanceof Error ? `启动读取失败：${error.message}` : '启动读取失败',
      })
    }
  },
  refreshProviders: async () => {
    const bridge = remoteBridge()
    if (!bridge) return
    try {
      const descriptors = (await bridge.listProviders()).filter(isAiTerminalAccountProvider)
      set((state) => {
        const previous = new Map(state.providers.map((provider) => [provider.id, provider]))
        const providers = descriptors.map((descriptor) => {
          const current = previous.get(descriptor.id)
          return {
            ...mapProvider(descriptor, current?.models),
            ...(current?.status ? { status: current.status } : {}),
            ...(current?.lastProbeMessage ? { lastProbeMessage: current.lastProbeMessage } : {}),
          }
        })
        return workflowProviderProjectionState(providers)
      })
    } catch (error) {
      set({
        ...workflowProviderProjectionState([]),
        toast: error instanceof Error ? `刷新账户接口失败：${error.message}` : '刷新账户接口失败',
      })
    }
  },
}))

let workflowSessionSyncQueued = false
let lastWorkflowDraftError = ''
workflowEditorSession.subscribe(() => {
  if (workflowSessionSyncQueued) return
  workflowSessionSyncQueued = true
  queueMicrotask(() => {
    workflowSessionSyncQueued = false
    const snapshot = workflowEditorSession.getSnapshot()
    const state = useStudioStore.getState()
    if (!snapshot.scope || !snapshot.document
      || snapshot.scope.workflowId !== state.workflowId
      || snapshot.scope.projectPath !== state.projectPath) return
    const draftError = snapshot.draftError
    const toast = draftError && draftError !== lastWorkflowDraftError
      ? draftError.startsWith('正式版本已保存') ? draftError : `自动草稿保存失败：${draftError}`
      : undefined
    lastWorkflowDraftError = draftError
    const documentChanged = state.workflowDocument !== snapshot.document
    useStudioStore.setState({
      ...(documentChanged
        ? synchronizedWorkflowEditorState(state, snapshot)
        : workflowDocumentState(snapshot)),
      ...(toast ? { toast } : {}),
    })
  })
})

// Keep the close guard alive after the Studio surface is switched out. The
// store and its draft timer outlive the React subtree, so the protection must
// live at the same level or a fast "Studio -> Chat -> close" can lose edits.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (!useStudioStore.getState().workflowDirty) return
    event.preventDefault()
    event.returnValue = ''
  })
}


export const getActiveGraph = (state: Pick<StudioState, 'graphs' | 'activeGraphId'>): GraphDocument =>
  state.graphs[state.activeGraphId] ?? initialRoot

export const nodeDefinitions = defaultRegistry.list()
