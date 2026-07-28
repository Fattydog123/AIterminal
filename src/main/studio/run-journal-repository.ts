import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { canonicalJson } from '../../studio/core/canonicalJson.js'
import { flattenSubgraphs } from '../../studio/core/subgraphs.js'
import { workflowDocumentSchema } from '../../studio/shared/contracts.js'
import type {
  RunDispatchState,
  RunRecordRemoteJob,
  RunRecordSummary,
  TaskRecord,
  WorkflowDocument,
} from '../../studio/shared/types.js'
import { StudioError, assertNoSecretFields } from './errors.js'
import { atomicWriteJson, readJson, resolveInside } from './filesystem.js'
import { MutationCoordinator, ProjectLayout } from './project-persistence.js'

export interface PersistentRunQueueItem {
  readonly schemaVersion: 1
  readonly id: string
  readonly projectId: string
  readonly workflowId: string
  readonly status: 'pending' | 'paused' | 'running'
  readonly priority: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly workflow: WorkflowDocument
  readonly targetNodeIds: readonly string[]
  readonly overrides: Readonly<Record<string, { readonly action: 'pin' | 'mock'; readonly value: unknown }>>
  readonly attempt: number
  readonly dispatchState?: RunDispatchState
  readonly remoteJobs?: readonly RunRecordRemoteJob[]
  readonly lastError?: string
}

const persistentRunQueueItemSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  projectId: z.string().min(1).max(160),
  workflowId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  status: z.enum(['pending', 'paused', 'running']),
  priority: z.number().int().min(-1_000).max(1_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workflow: workflowDocumentSchema,
  targetNodeIds: z.array(z.string().min(1).max(160)).max(10_000),
  overrides: z.record(
    z.string().min(1).max(160),
    z.object({ action: z.enum(['pin', 'mock']), value: z.unknown() }).strict(),
  ),
  attempt: z.number().int().nonnegative().max(100),
  dispatchState: z.enum(['not_sent', 'sent', 'billing_unknown']).optional(),
  remoteJobs: z.array(z.object({
    nodeId: z.string().min(1).max(160),
    providerId: z.string().max(160),
    providerKind: z.literal('comfyui'),
    promptIdHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptIdSuffix: z.string().max(4),
    queueNumber: z.number().int().nonnegative().optional(),
  }).strict()).max(10_000).optional(),
  lastError: z.string().max(8_192).optional(),
}).strict()

const persistentRunQueueLimit = 1_000
const recordIdentifierSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f]/.test(value),
  '作品标识不能带首尾空白或控制字符',
)

const taskRecordSchema = z.object({
  id: recordIdentifierSchema,
  runId: recordIdentifierSchema.optional(),
  projectId: recordIdentifierSchema,
  workflowId: recordIdentifierSchema,
  nodeId: recordIdentifierSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'billing-unknown']),
  dispatchState: z.enum(['not_sent', 'sent', 'billing_unknown']).optional(),
  progress: z.number().min(0).max(1),
  message: z.string().max(8_192),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const taskHistoryLimit = 20_000
const taskFileHardLimit = 100_000
const activeTaskStatuses = new Set<TaskRecord['status']>(['pending', 'running'])

export const trimTaskHistory = (tasks: readonly TaskRecord[], limit = taskHistoryLimit): readonly TaskRecord[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new StudioError('task-history-limit-invalid', '任务历史上限必须是正整数')
  if (tasks.length <= limit) return tasks
  const activeCount = tasks.filter((task) => activeTaskStatuses.has(task.status)).length
  if (activeCount > limit) {
    throw new StudioError('task-history-active-overflow', `活跃任务数量 ${activeCount} 超过安全上限 ${limit}，请先取消或完成部分任务`)
  }
  const terminalBudget = limit - activeCount
  const retainedTerminalIndices = new Set(
    tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => !activeTaskStatuses.has(task.status))
      .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))
      .slice(0, terminalBudget)
      .map(({ index }) => index),
  )
  return tasks.filter((task, index) => activeTaskStatuses.has(task.status) || retainedTerminalIndices.has(index))
}

const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(160),
  workflowId: z.string().min(1).max(160),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  dispatchState: z.enum(['not_sent', 'sent', 'billing_unknown']).optional(),
  createdAt: z.string().datetime(),
  events: z.array(z.object({
    id: z.string().min(1),
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    phase: z.enum(['queue', 'provider', 'download', 'decode', 'persist']),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().nonnegative().optional(),
    cacheHit: z.boolean().optional(),
    errorCode: z.string().optional(),
  })).max(100_000),
  error: z.object({
    code: z.string(),
    message: z.string(),
    billingUnknown: z.boolean(),
    dispatchState: z.enum(['not_sent', 'sent', 'billing_unknown']).optional(),
  }).optional(),
  environment: z.record(z.string(), z.string()),
  workflowSnapshot: workflowDocumentSchema.optional(),
  workflowHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  targetNodeIds: z.array(z.string().min(1).max(160)).max(10_000).optional(),
  overrides: z.record(
    z.string().min(1).max(160),
    z.object({ action: z.enum(['pin', 'mock']), value: z.unknown() }).strict(),
  ).optional(),
  plan: z.object({
    taskCount: z.number().int().nonnegative(),
    remoteTaskCount: z.number().int().nonnegative(),
    estimatedCost: z.number().finite().nonnegative().optional(),
    nodes: z.array(z.object({
      nodeId: z.string().min(1).max(160),
      action: z.enum(['execute', 'pin', 'mock', 'cache', 'bypass']),
      reason: z.string().max(8_192),
    }).strict()).max(100_000),
  }).strict().optional(),
  providerBindings: z.array(z.object({
    nodeId: z.string().min(1).max(160),
    providerId: z.string().max(160),
    providerKind: z.enum(['openai-compatible', 'comfyui']).optional(),
    model: z.string().max(1_024),
  }).strict()).max(10_000).optional(),
  matrix: z.object({
    batchId: z.string().min(1).max(160),
    index: z.number().int().positive(),
    taskCount: z.number().int().positive(),
    userEstimatedCostPerImage: z.number().finite().nonnegative().optional(),
    parameters: z.record(z.string().min(1).max(320), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
  }).strict().optional(),
  remoteJobs: z.array(z.object({
    nodeId: z.string().min(1).max(160),
    providerId: z.string().max(160),
    providerKind: z.literal('comfyui'),
    promptIdHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptIdSuffix: z.string().max(4),
    queueNumber: z.number().int().nonnegative().optional(),
  }).strict()).max(10_000).optional(),
}).passthrough().superRefine((record, context) => {
  if ((record.workflowSnapshot === undefined) !== (record.workflowHash === undefined)) {
    context.addIssue({ code: 'custom', message: '运行记录的 Workflow 快照与哈希必须同时存在' })
    return
  }
  if (record.workflowSnapshot && record.workflowHash) {
    const actual = createHash('sha256').update(canonicalJson(record.workflowSnapshot)).digest('hex')
    if (actual !== record.workflowHash) context.addIssue({ code: 'custom', message: '运行记录的 Workflow 快照哈希不匹配' })
  }
})

export class RunJournalRepository {
  constructor(
    private readonly layout: ProjectLayout,
    private readonly mutations: MutationCoordinator,
  ) {}

  async listTasks(root: string): Promise<readonly TaskRecord[]> {
    const metadata = await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const raw = await readJson<unknown>(path.join(path.resolve(root), '.studio', 'tasks.json'), [])
    assertNoSecretFields(raw)
    const tasks = z.array(taskRecordSchema).max(taskFileHardLimit).parse(raw) as readonly TaskRecord[]
    if (tasks.some((task) => task.projectId !== metadata.id)) {
      throw new StudioError('task-project-mismatch', '任务目录包含不属于当前项目的记录')
    }
    return tasks
  }

  async listQueue(root: string): Promise<readonly PersistentRunQueueItem[]> {
    const metadata = await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const raw = await readJson<unknown>(path.join(path.resolve(root), '.studio', 'run-queue.json'), [])
    assertNoSecretFields(raw)
    const items = z.array(persistentRunQueueItemSchema).max(persistentRunQueueLimit).parse(raw) as unknown as readonly PersistentRunQueueItem[]
    const ids = new Set<string>()
    for (const item of items) {
      if (ids.has(item.id)) throw new StudioError('run-queue-id-conflict', `运行队列 ID 重复：${item.id}`)
      ids.add(item.id)
      if (item.projectId !== metadata.id) throw new StudioError('run-queue-project-mismatch', '运行队列包含不属于当前项目的记录')
      if (item.workflowId !== item.workflow.id) throw new StudioError('run-queue-workflow-mismatch', '运行队列的工作流标识不一致')
      const knownNodes = new Set(flattenSubgraphs(item.workflow).nodes.map((node) => node.id))
      const missingTarget = item.targetNodeIds.find((nodeId) => !knownNodes.has(nodeId))
      if (missingTarget) throw new StudioError('run-queue-target-missing', `运行队列目标节点不存在：${missingTarget}`)
    }
    return [...items].sort((left, right) =>
      right.priority - left.priority
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id))
  }

  async upsertQueue(root: string, item: PersistentRunQueueItem): Promise<PersistentRunQueueItem> {
    return this.mutations.run(root, 'run-queue', async () => {
      assertNoSecretFields(item)
      const metadata = await this.layout.metadata(root)
      const parsed = persistentRunQueueItemSchema.parse(item) as unknown as PersistentRunQueueItem
      if (parsed.projectId !== metadata.id) throw new StudioError('run-queue-project-mismatch', '不能把任务加入其他项目的运行队列')
      if (parsed.workflowId !== parsed.workflow.id) throw new StudioError('run-queue-workflow-mismatch', '运行队列的工作流标识不一致')
      const knownNodes = new Set(flattenSubgraphs(parsed.workflow).nodes.map((node) => node.id))
      const missingTarget = parsed.targetNodeIds.find((nodeId) => !knownNodes.has(nodeId))
      if (missingTarget) throw new StudioError('run-queue-target-missing', `运行队列目标节点不存在：${missingTarget}`)
      const items = [...(await this.listQueue(root))]
      const index = items.findIndex((candidate) => candidate.id === parsed.id)
      const normalized = index >= 0 ? { ...parsed, createdAt: items[index]!.createdAt } : parsed
      if (index >= 0) items[index] = normalized
      else items.push(normalized)
      if (items.length > persistentRunQueueLimit) throw new StudioError('run-queue-limit', `运行队列不能超过 ${persistentRunQueueLimit} 项`)
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'run-queue.json'), items)
      return normalized
    })
  }

  async removeQueue(root: string, itemId: string): Promise<boolean> {
    return this.mutations.run(root, 'run-queue', async () => {
      const items = await this.listQueue(root)
      const remaining = items.filter((item) => item.id !== itemId)
      if (remaining.length === items.length) return false
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'run-queue.json'), remaining)
      return true
    })
  }

  async recoverQueue(root: string): Promise<number> {
    return this.mutations.run(root, 'run-queue', async () => {
      const items = await this.listQueue(root)
      const now = new Date().toISOString()
      let recovered = 0
      const updated = items.map((item): PersistentRunQueueItem => {
        if (item.status === 'pending' && (item.dispatchState ?? 'not_sent') === 'not_sent') {
          recovered += 1
          return {
            ...item,
            status: 'paused',
            dispatchState: 'not_sent',
            updatedAt: now,
            lastError: '应用退出时尚在本地队列中且未派发，请确认后再恢复',
          }
        }
        if (item.status === 'running') {
          recovered += 1
          return {
            ...item,
            status: 'paused',
            updatedAt: now,
            lastError: '应用退出时正在执行，请确认后再恢复',
          }
        }
        return item
      })
      if (recovered > 0) await atomicWriteJson(path.join(path.resolve(root), '.studio', 'run-queue.json'), updated)
      return recovered
    })
  }

  async recoverTasks(root: string): Promise<number> {
    return this.mutations.run(root, 'tasks', async () => {
      const tasks = [...(await this.listTasks(root))]
      const now = new Date().toISOString()
      let recovered = 0
      const updated = tasks.map((task): TaskRecord => {
        if (task.status === 'pending') {
          recovered += 1
          return { ...task, status: 'cancelled', dispatchState: 'not_sent', progress: 1, message: '应用重启前尚未派发，已安全取消', updatedAt: now }
        }
        if (task.status === 'running') {
          recovered += 1
          if (task.dispatchState === 'not_sent') {
            return { ...task, status: 'cancelled', dispatchState: 'not_sent', progress: 1, message: '上次应用退出时仍在本地执行且未派发，已安全取消', updatedAt: now }
          }
          return { ...task, status: 'billing-unknown', dispatchState: 'billing_unknown', progress: 1, message: '上次应用退出时已进入或可能进入远程派发；是否计费需人工核对', updatedAt: now }
        }
        return task
      })
      if (recovered > 0) {
        await atomicWriteJson(path.join(path.resolve(root), '.studio', 'tasks.json'), z.array(taskRecordSchema).parse(trimTaskHistory(updated)))
      }
      return recovered
    })
  }

  async listRuns(root: string): Promise<readonly RunRecordSummary[]> {
    await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const directory = resolveInside(path.resolve(root), '.studio/runs')
    let entries
    try {
      await this.layout.managedDirectory(root, '.studio/runs')
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: RunRecordSummary[] = []
    for (const entry of entries.slice(0, 5_000)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const filePath = resolveInside(directory, entry.name)
      const details = await lstat(filePath)
      if (details.isSymbolicLink() || !details.isFile() || details.size > 64 * 1024 * 1024) continue
      try {
        const raw = await readJson(filePath)
        assertNoSecretFields(raw)
        records.push(runRecordSchema.parse(raw) as unknown as RunRecordSummary)
      } catch {
        // One damaged historic record must not make every diagnostic page unusable.
      }
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 500)
  }

  async upsertTask(root: string, task: TaskRecord): Promise<void> {
    return this.mutations.run(root, 'tasks', async () => {
      const metadata = await this.layout.metadata(root)
      if (task.projectId !== metadata.id) throw new StudioError('task-project-mismatch', '任务记录不属于当前项目')
      assertNoSecretFields(task)
      const current = [...(await this.listTasks(root))]
      const index = current.findIndex((item) => item.id === task.id)
      if (index >= 0) current[index] = task
      else current.push(task)
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'tasks.json'), z.array(taskRecordSchema).parse(trimTaskHistory(current)))
    })
  }
}
