import { z } from 'zod'
import type { StudioOperationName } from './ipc-channels.js'
import type {
  AppBootstrap,
  Board,
  CollectionSnapshot,
  GeneratedAsset,
  ProjectSummary,
  ProjectPluginRecord,
  ParameterPresetRecord,
  ProviderDescriptor,
  ProviderImportPreview,
  RunRecordSummary,
  RunPlan,
  RunResult,
  SmartCollection,
  TaskRecord,
  WorkflowDocument,
} from './types.js'

const id = z.string().trim().min(1).max(160)
const safeRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\'))
  .refine((value) => !value.split(/[\\/]+/).includes('..'))

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).passthrough()

const subgraphInstanceSchema = z.object({
  definitionId: id,
  definitionVersion: z.number().int().positive(),
}).passthrough()

export const workflowNodeSchema = z.object({
  id,
  type: id,
  name: z.string().trim().min(1).max(200),
  position: pointSchema,
  parameters: z.record(z.string(), z.unknown()),
  presentation: z
    .object({
      annotation: z.string().max(4000).optional(),
      collapsed: z.boolean().optional(),
      bypassed: z.boolean().optional(),
      width: z.number().finite().min(120).max(2400).optional(),
      height: z.number().finite().min(60).max(1600).optional(),
      color: z.string().max(32).optional(),
      debugOverride: z.object({ action: z.enum(['pin', 'mock']), value: z.unknown() }).strict().optional(),
    })
    .passthrough()
    .optional(),
  subgraph: subgraphInstanceSchema.optional(),
}).passthrough()

export const workflowEdgeSchema = z.object({
  id,
  sourceNode: id,
  sourceSocket: id,
  targetNode: id,
  targetSocket: id,
  presentation: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const workflowDocumentSchema = z.object({
  schemaVersion: z.literal(3),
  id,
  name: z.string().trim().min(1).max(200),
  revision: z.number().int().nonnegative(),
  nodes: z.array(workflowNodeSchema).max(5000),
  edges: z.array(workflowEdgeSchema).max(20_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  presentation: z.record(z.string(), z.unknown()).optional(),
  // Subgraph bodies are validated by the recursive core validator. Keeping this
  // schema generic avoids a recursive Zod type while preserving vendor fields.
  subgraphs: z.array(z.record(z.string(), z.unknown())).max(512).optional(),
}).passthrough()

const studioCopilotReferenceSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u)

export const studioCopilotNodeTargetSchema = z.union([
  z.object({ nodeId: id }).strict(),
  z.object({ ref: studioCopilotReferenceSchema }).strict(),
])

const studioCopilotParametersSchema = z
  .record(z.string().trim().min(1).max(160), z.json())
  .superRefine((parameters, context) => {
    if (Object.hasOwn(parameters, 'providerId') || Object.hasOwn(parameters, 'model')) {
      context.addIssue({
        code: 'custom',
        message: '工作流助手不能修改顶部模型路由',
      })
    }
    if (Object.keys(parameters).length > 128 || JSON.stringify(parameters).length > 64 * 1024) {
      context.addIssue({
        code: 'custom',
        message: '工作流助手节点参数过多',
      })
    }
  })

const studioCopilotPositionSchema = z.object({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
}).strict()

export const studioCopilotOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add-node'),
    ref: studioCopilotReferenceSchema,
    nodeType: id,
    position: studioCopilotPositionSchema,
    name: z.string().trim().min(1).max(200).optional(),
    parameters: studioCopilotParametersSchema.optional(),
    annotation: z.string().trim().max(4000).optional(),
  }).strict(),
  z.object({
    kind: z.literal('update-node'),
    target: studioCopilotNodeTargetSchema,
    name: z.string().trim().min(1).max(200).optional(),
    parameters: studioCopilotParametersSchema.optional(),
    annotation: z.string().trim().max(4000).optional(),
    bypassed: z.boolean().optional(),
    collapsed: z.boolean().optional(),
  }).strict().refine((operation) => (
    operation.name !== undefined ||
    operation.parameters !== undefined ||
    operation.annotation !== undefined ||
    operation.bypassed !== undefined ||
    operation.collapsed !== undefined
  ), '节点更新没有包含任何变更'),
  z.object({
    kind: z.literal('remove-node'),
    target: studioCopilotNodeTargetSchema,
  }).strict(),
  z.object({
    kind: z.literal('connect'),
    source: studioCopilotNodeTargetSchema,
    sourceSocket: id,
    target: studioCopilotNodeTargetSchema,
    targetSocket: id,
  }).strict(),
  z.object({
    kind: z.literal('auto-layout'),
    nodes: z.array(studioCopilotNodeTargetSchema).max(256).optional(),
  }).strict(),
])

export const studioCopilotPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  groupId: id,
  model: z.string().trim().min(1).max(256),
  operations: z.array(studioCopilotOperationSchema).min(1).max(64),
}).strict()

export const studioCopilotPlanRequestSchema = z.object({
  providerId: id,
  workflow: workflowDocumentSchema,
  instruction: z.string().trim().min(1).max(12_000),
  selectedNodeIds: z.array(id).max(256).optional(),
}).strict()

export type StudioCopilotNodeTarget = z.output<typeof studioCopilotNodeTargetSchema>
export type StudioCopilotOperation = z.output<typeof studioCopilotOperationSchema>
export type StudioCopilotPlan = z.output<typeof studioCopilotPlanSchema>

export interface StudioCopilotPlanInput {
  readonly providerId: string
  readonly workflow: WorkflowDocument
  readonly instruction: string
  readonly selectedNodeIds?: readonly string[]
}

const providerDraftBase = {
  id,
  name: z.string().trim().min(1).max(160),
  baseUrl: z.string().url().max(2048),
  defaultModel: z.string().trim().min(1).max(256),
  timeoutMs: z.number().int().min(5_000).max(600_000),
  maxImageBytes: z.number().int().min(1_048_576).max(536_870_912),
  proxyMode: z.enum(['system', 'direct']),
} as const

export const openAiProviderDraftSchema = z.object({
  ...providerDraftBase,
  kind: z.literal('openai-compatible'),
  secretUpdate: z.string().max(16_384).optional(),
}).strict()

export const comfyUiProviderDraftSchema = z.object({
  ...providerDraftBase,
  kind: z.literal('comfyui'),
}).strict()

export const providerDraftSchema = z.discriminatedUnion('kind', [
  openAiProviderDraftSchema,
  comfyUiProviderDraftSchema,
])

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  initialWorkflow: workflowDocumentSchema.optional(),
})

export const projectOpenSchema = z.object({ path: z.string().trim().min(1).max(4096) })
export const workflowLoadSchema = z.object({ projectPath: z.string().min(1), workflowId: id })
export const workflowSaveSchema = z.object({
  projectPath: z.string().min(1),
  workflow: workflowDocumentSchema,
})
export const workflowDraftLoadSchema = workflowLoadSchema
export const workflowDraftSaveSchema = workflowSaveSchema
export const workflowDraftDiscardSchema = workflowLoadSchema
export const workflowVersionListSchema = workflowLoadSchema
export const workflowVersionLoadSchema = workflowLoadSchema.extend({ revision: z.number().int().nonnegative() })
export const workflowDuplicateSchema = workflowLoadSchema.extend({ name: z.string().trim().min(1).max(160).optional() })
export const workflowArchiveSchema = workflowLoadSchema
export const workflowArchiveListSchema = z.object({ projectPath: z.string().min(1) })
export const workflowArchiveRestoreSchema = z.object({ projectPath: z.string().min(1), archiveId: id })
export const workflowPackageExportSchema = workflowSaveSchema
export const workflowPackageImportSchema = z.object({ projectPath: z.string().min(1) })
export const runPrepareSchema = z.object({
  projectPath: z.string().min(1),
  workflow: workflowDocumentSchema,
  targetNodeIds: z.array(id).optional(),
  overrides: z.record(id, z.object({ action: z.enum(['pin', 'mock']), value: z.unknown() })).optional(),
})
export const runStartSchema = runPrepareSchema.extend({ planId: id })
export const runCancelSchema = z.object({ runId: id })
export const assetListSchema = z.object({ projectPath: z.string().min(1) })
export const assetUrlSchema = z.object({ projectPath: z.string().min(1), relativePath: safeRelativePath })
export const assetUpdateSchema = z.object({
  projectPath: z.string().min(1),
  assetId: id,
  favorite: z.boolean().optional(),
  decision: z.enum(['pending', 'adopted', 'rejected']).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
}).refine((value) => value.favorite !== undefined || value.decision !== undefined || value.tags !== undefined, '至少需要一个作品更新字段')
export const assetExportSchema = z.object({
  projectPath: z.string().min(1),
  assetIds: z.array(id).min(1).max(500),
  filenameTemplate: z.string().min(1).max(240),
})
export const assetMaskSaveSchema = z.object({
  projectPath: z.string().min(1),
  assetId: id,
  pngBase64: z.string().min(16).max(48 * 1024 * 1024),
})
export const projectImageImportSchema = z.object({ projectPath: z.string().min(1) })
export const boardSchema = z.object({
  id,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000),
  assetIds: z.array(id).max(20_000),
}).strict()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须使用 YYYY-MM-DD')
export const smartCollectionSchema = z.object({
  id,
  name: z.string().trim().min(1).max(160),
  favorite: z.boolean().optional(),
  models: z.array(z.string().trim().min(1).max(256)).max(100),
  workflowIds: z.array(id).max(100),
  tags: z.array(z.string().trim().min(1).max(80)).max(100),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
}).strict().refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, {
  message: '开始日期不能晚于结束日期',
})
export const collectionListSchema = z.object({ projectPath: z.string().min(1) })
export const boardUpsertSchema = z.object({ projectPath: z.string().min(1), board: boardSchema })
export const boardDeleteSchema = z.object({ projectPath: z.string().min(1), boardId: id })
export const smartCollectionUpsertSchema = z.object({ projectPath: z.string().min(1), collection: smartCollectionSchema })
export const smartCollectionDeleteSchema = z.object({ projectPath: z.string().min(1), collectionId: id })
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export const pluginPermissionSchema = z.enum(['network', 'project-read', 'project-write', 'clipboard', 'shell'])
export const pluginManifestContractSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/),
  name: z.string().trim().min(1).max(160),
  version: z.string().regex(semver),
  hostVersion: z.string().regex(semver),
  description: z.string().max(4000).optional(),
  entryPoint: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  permissions: z.array(pluginPermissionSchema).max(5).refine((items) => new Set(items).size === items.length, '插件权限不能重复'),
  nodeTypes: z.array(z.string().regex(/^[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)*$/).max(160)).max(256).refine((items) => new Set(items).size === items.length, '插件节点类型不能重复'),
  dependencies: z.record(z.string(), z.string().regex(semver)).default({}),
}).strict().superRefine((manifest, context) => {
  if (Object.hasOwn(manifest.dependencies, manifest.id)) context.addIssue({ code: 'custom', message: '插件不能依赖自身', path: ['dependencies', manifest.id] })
})
export const projectPluginRecordSchema = z.object({
  manifest: pluginManifestContractSchema,
  enabled: z.boolean(),
  versionLock: z.string().regex(semver),
  grantedPermissions: z.array(pluginPermissionSchema).max(5).refine((items) => new Set(items).size === items.length, '授权权限不能重复'),
}).strict()
export const pluginListSchema = z.object({ projectPath: z.string().min(1) })
export const pluginUpsertSchema = z.object({ projectPath: z.string().min(1), plugin: projectPluginRecordSchema })
export const pluginDeleteSchema = z.object({ projectPath: z.string().min(1), pluginId: id })
const safePresetPath = z.string().trim().min(1).max(240).refine((value) => value.split('.').every((part) => part && !['__proto__', 'prototype', 'constructor'].includes(part)), '预设参数路径不安全')
export const parameterPresetSchema = z.object({
  id,
  name: z.string().trim().min(1).max(160),
  modelPatterns: z.array(z.string().trim().min(1).max(256)).max(100),
  values: z.record(safePresetPath, z.unknown()).refine((value) => Object.keys(value).length <= 500, '预设参数过多'),
  tags: z.array(z.string().trim().min(1).max(80)).max(100),
}).strict().refine((value) => JSON.stringify(value).length <= 1_048_576, '单个预设超过 1 MiB')
export const presetListSchema = z.object({ projectPath: z.string().min(1) })
export const presetUpsertSchema = z.object({ projectPath: z.string().min(1), preset: parameterPresetSchema })
export const presetDeleteSchema = z.object({ projectPath: z.string().min(1), presetId: id })
export const presetImportSchema = z.object({ projectPath: z.string().min(1) })
export const presetExportSchema = z.object({ projectPath: z.string().min(1), presetIds: z.array(id).min(1).max(500) })
export const taskListSchema = z.object({ projectPath: z.string().min(1) })
export const runListSchema = z.object({ projectPath: z.string().min(1) })
export const persistentRunListSchema = z.object({ projectPath: z.string().min(1) })
export const persistentRunActionSchema = z.object({ projectPath: z.string().min(1), itemId: id })
export const providerDeleteSchema = z.object({ providerId: id })
export const providerProbeSchema = z.object({ providerId: id })
export const providerImportDecisionSchema = z.object({ requestId: id }).strict()
export const diagnosticExportSchema = z.object({ projectPath: z.string().min(1), runId: id })
export const clipboardWriteSchema = z.object({ text: z.string().max(100_000) })

interface WorkflowSaveBridgeInput {
  readonly projectPath: string
  readonly workflow: WorkflowDocument
}

interface RunBridgeInput extends WorkflowSaveBridgeInput {
  readonly targetNodeIds?: readonly string[]
  readonly overrides?: Readonly<Record<string, { readonly action: 'pin' | 'mock'; readonly value: unknown }>>
}

interface RunStartBridgeInput extends RunBridgeInput {
  readonly planId: string
}

export interface PersistentRunSummary {
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly workflowName: string
  readonly providerIds: readonly string[]
  readonly status: 'pending' | 'running' | 'paused'
  readonly priority: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly targetNodeIds: readonly string[]
  readonly attempt: number
  readonly dispatchState: 'not_sent' | 'sent' | 'billing_unknown'
  readonly lastError?: string
  readonly canResume: boolean
  readonly canRemove: boolean
  readonly blockedReason?: string
}

export { channels } from './ipc-channels.js'

export interface StudioBridge {
  bootstrap(): Promise<AppBootstrap>
  createProject(input: {
    readonly name: string
    readonly initialWorkflow?: WorkflowDocument
  }): Promise<ProjectSummary>
  openProject(input: z.input<typeof projectOpenSchema>): Promise<ProjectSummary>
  listWorkflows(projectPath: string): Promise<readonly WorkflowDocument[]>
  loadWorkflow(input: z.input<typeof workflowLoadSchema>): Promise<WorkflowDocument>
  saveWorkflow(input: WorkflowSaveBridgeInput): Promise<WorkflowDocument>
  loadWorkflowDraft(input: z.input<typeof workflowDraftLoadSchema>): Promise<{
    readonly schemaVersion: 1
    readonly workflowId: string
    readonly baseRevision: number
    readonly savedAt: string
    readonly workflow: WorkflowDocument
  } | undefined>
  saveWorkflowDraft(input: WorkflowSaveBridgeInput): Promise<{
    readonly schemaVersion: 1
    readonly workflowId: string
    readonly baseRevision: number
    readonly savedAt: string
    readonly workflow: WorkflowDocument
  }>
  discardWorkflowDraft(input: z.input<typeof workflowDraftDiscardSchema>): Promise<boolean>
  listWorkflowVersions(input: z.input<typeof workflowVersionListSchema>): Promise<readonly {
    readonly workflowId: string
    readonly revision: number
    readonly name: string
    readonly savedAt: string
  }[]>
  loadWorkflowVersion(input: z.input<typeof workflowVersionLoadSchema>): Promise<WorkflowDocument>
  duplicateWorkflow(input: z.input<typeof workflowDuplicateSchema>): Promise<WorkflowDocument>
  archiveWorkflow(input: z.input<typeof workflowArchiveSchema>): Promise<boolean>
  listArchivedWorkflows(input: z.input<typeof workflowArchiveListSchema>): Promise<readonly {
    readonly archiveId: string
    readonly workflowId: string
    readonly name: string
    readonly revision: number
    readonly archivedAt: string
  }[]>
  restoreArchivedWorkflow(input: z.input<typeof workflowArchiveRestoreSchema>): Promise<WorkflowDocument>
  exportWorkflowPackage(input: WorkflowSaveBridgeInput): Promise<{ readonly saved: boolean; readonly path?: string }>
  importWorkflowPackage(input: z.input<typeof workflowPackageImportSchema>): Promise<{
    readonly imported: false
  } | {
    readonly imported: true
    readonly workflow: WorkflowDocument
    readonly compatibility: {
      readonly compatible: boolean
      readonly missingProviderIds: readonly string[]
      readonly missingNodeTypes: readonly string[]
      readonly missingPlugins: readonly { readonly id: string; readonly versionLock: string }[]
    }
  }>
  planWorkflow(input: StudioCopilotPlanInput): Promise<StudioCopilotPlan>
  listProviders(): Promise<readonly ProviderDescriptor[]>
  upsertProvider(input: z.input<typeof providerDraftSchema>): Promise<ProviderDescriptor>
  deleteProvider(input: z.input<typeof providerDeleteSchema>): Promise<boolean>
  probeProvider(input: z.input<typeof providerProbeSchema>): Promise<{ ok: boolean; message: string; models: readonly string[] }>
  listProviderImports(): Promise<readonly ProviderImportPreview[]>
  acceptProviderImport(input: z.input<typeof providerImportDecisionSchema>): Promise<ProviderDescriptor>
  dismissProviderImport(input: z.input<typeof providerImportDecisionSchema>): Promise<boolean>
  prepareRun(input: RunBridgeInput): Promise<RunPlan>
  startRun(input: RunStartBridgeInput): Promise<RunResult>
  cancelRun(input: z.input<typeof runCancelSchema>): Promise<boolean>
  listAssets(input: z.input<typeof assetListSchema>): Promise<readonly GeneratedAsset[]>
  assetUrl(input: z.input<typeof assetUrlSchema>): Promise<string>
  updateAsset(input: {
    readonly projectPath: string
    readonly assetId: string
    readonly favorite?: boolean
    readonly decision?: GeneratedAsset['decision']
    readonly tags?: readonly string[]
  }): Promise<GeneratedAsset>
  exportAssets(input: { readonly projectPath: string; readonly assetIds: readonly string[]; readonly filenameTemplate: string }): Promise<{ readonly exported: number; readonly destination?: string }>
  saveAssetMask(input: z.input<typeof assetMaskSaveSchema>): Promise<{ readonly relativePath: string; readonly width: number; readonly height: number }>
  importProjectImage(input: z.input<typeof projectImageImportSchema>): Promise<{ readonly imported: false } | { readonly imported: true; readonly relativePath: string; readonly width?: number; readonly height?: number }>
  listCollections(input: z.input<typeof collectionListSchema>): Promise<CollectionSnapshot>
  upsertBoard(input: { readonly projectPath: string; readonly board: Board }): Promise<Board>
  deleteBoard(input: z.input<typeof boardDeleteSchema>): Promise<boolean>
  upsertSmartCollection(input: { readonly projectPath: string; readonly collection: SmartCollection }): Promise<SmartCollection>
  deleteSmartCollection(input: z.input<typeof smartCollectionDeleteSchema>): Promise<boolean>
  listPlugins(input: z.input<typeof pluginListSchema>): Promise<readonly ProjectPluginRecord[]>
  upsertPlugin(input: { readonly projectPath: string; readonly plugin: ProjectPluginRecord }): Promise<ProjectPluginRecord>
  deletePlugin(input: z.input<typeof pluginDeleteSchema>): Promise<boolean>
  listPresets(input: z.input<typeof presetListSchema>): Promise<readonly ParameterPresetRecord[]>
  upsertPreset(input: { readonly projectPath: string; readonly preset: ParameterPresetRecord }): Promise<ParameterPresetRecord>
  deletePreset(input: z.input<typeof presetDeleteSchema>): Promise<boolean>
  importPresets(input: z.input<typeof presetImportSchema>): Promise<{ readonly imported: number; readonly presets: readonly ParameterPresetRecord[] }>
  exportPresets(input: { readonly projectPath: string; readonly presetIds: readonly string[] }): Promise<{ readonly saved: boolean; readonly path?: string }>
  listTasks(input: z.input<typeof taskListSchema>): Promise<readonly TaskRecord[]>
  listRuns(input: z.input<typeof runListSchema>): Promise<readonly RunRecordSummary[]>
  listPersistentRuns(input: z.input<typeof persistentRunListSchema>): Promise<readonly PersistentRunSummary[]>
  resumePersistentRun(input: z.input<typeof persistentRunActionSchema>): Promise<RunResult>
  removePersistentRun(input: z.input<typeof persistentRunActionSchema>): Promise<boolean>
  exportDiagnostics(input: z.input<typeof diagnosticExportSchema>): Promise<{ readonly saved: boolean; readonly path?: string }>
  copyText(input: z.input<typeof clipboardWriteSchema>): Promise<void>
  onRunEvent(listener: (event: unknown) => void): () => void
}

type AssertNever<TValue extends never> = TValue
type StudioBridgeCatalogMismatch =
  | Exclude<Extract<keyof StudioBridge, string>, StudioOperationName>
  | Exclude<StudioOperationName, Extract<keyof StudioBridge, string>>

// A catalog operation and a public bridge method may not exist without the other.
type StudioBridgeCatalogMustMatch = AssertNever<StudioBridgeCatalogMismatch>
