import { z } from 'zod'
import type { ExecutionTimelineEvent, RunDispatchState, RunResult, TaskRecord } from '../shared/types.js'

const id = z.string().min(1).max(160)
const timestamp = z.string().datetime()
const dispatchState = z.enum(['not_sent', 'sent', 'billing_unknown'])
const runStatus = z.enum(['succeeded', 'failed', 'cancelled'])
const taskStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'billing-unknown'])
const comfyPromptId = z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f]/.test(value))

const timelineEventSchema = z.object({
  id,
  runId: id,
  nodeId: id,
  phase: z.enum(['queue', 'provider', 'download', 'decode', 'persist']),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  durationMs: z.number().nonnegative().optional(),
  cacheHit: z.boolean().optional(),
  errorCode: z.string().max(256).optional(),
}).strict()

const taskRecordSchema = z.object({
  id,
  runId: id.optional(),
  projectId: id,
  workflowId: id,
  nodeId: id,
  status: taskStatus,
  dispatchState: dispatchState.optional(),
  progress: z.number().min(0).max(1),
  message: z.string().max(8_192),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

const runResultSchema = z.object({
  runId: id,
  status: runStatus,
  dispatchState: dispatchState.optional(),
  outputs: z.record(z.string(), z.unknown()),
  error: z.object({
    code: z.string().min(1).max(256),
    message: z.string().max(8_192),
    billingUnknown: z.boolean(),
    dispatchState: dispatchState.optional(),
  }).optional(),
}).strict()

const comfyJobSchema = z.object({
  promptId: comfyPromptId,
  clientId: z.string().min(1).max(256),
  queueNumber: z.number().finite().optional(),
}).strict().transform(({ promptId, queueNumber }) => ({ promptId, ...(queueNumber === undefined ? {} : { queueNumber }) }))

const comfyProgressSchema = z.object({
  type: z.string().min(1).max(128),
  promptId: comfyPromptId,
  nodeId: id.optional(),
  value: z.number().finite().nonnegative().optional(),
  maximum: z.number().finite().positive().optional(),
}).strict()

const runLifecycleEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run-queued'), runId: id, workflowId: id, createdAt: timestamp }).strict(),
  z.object({ type: z.literal('run-started'), runId: id, workflowId: id, createdAt: timestamp }).strict(),
  z.object({ type: z.literal('run-cancel-requested'), runId: id, createdAt: timestamp }).strict(),
  z.object({ type: z.literal('run-dispatch'), runId: id, workflowId: id, dispatchState, createdAt: timestamp }).strict(),
  z.object({
    type: z.literal('run-progress'),
    runId: id,
    workflowId: id,
    nodeId: id.optional(),
    nodeStatus: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'billing-unknown']).optional(),
    overallProgress: z.number().min(0).max(1),
    message: z.string().max(8_192),
  }).strict(),
  z.object({ type: z.literal('timeline'), workflowId: id, event: timelineEventSchema }).strict(),
  z.object({ type: z.literal('task'), runId: id.optional(), overallProgress: z.number().min(0).max(1), task: taskRecordSchema }).strict(),
  z.object({ type: z.literal('run-finished'), result: runResultSchema }).strict(),
  z.object({ type: z.literal('comfy-job'), runId: id, workflowId: id, nodeId: id, job: comfyJobSchema }).strict(),
  z.object({ type: z.literal('comfy-progress'), runId: id, workflowId: id, nodeId: id, event: comfyProgressSchema }).strict(),
  z.object({ type: z.literal('persistent-queue-warning'), runId: id, workflowId: id, message: z.string().min(1).max(8_192) }).strict(),
  z.object({
    type: z.literal('run-record-warning'), runId: id, workflowId: id, createdAt: timestamp,
    message: z.string().min(1).max(8_192),
  }).strict(),
])

export type RunLifecycleEvent =
  | { readonly type: 'run-queued'; readonly runId: string; readonly workflowId: string; readonly createdAt: string }
  | { readonly type: 'run-started'; readonly runId: string; readonly workflowId: string; readonly createdAt: string }
  | { readonly type: 'run-cancel-requested'; readonly runId: string; readonly createdAt: string }
  | { readonly type: 'run-dispatch'; readonly runId: string; readonly workflowId: string; readonly dispatchState: RunDispatchState; readonly createdAt: string }
  | { readonly type: 'run-progress'; readonly runId: string; readonly workflowId: string; readonly nodeId?: string; readonly nodeStatus?: TaskRecord['status']; readonly overallProgress: number; readonly message: string }
  | { readonly type: 'timeline'; readonly workflowId: string; readonly event: ExecutionTimelineEvent }
  | { readonly type: 'task'; readonly runId?: string; readonly overallProgress: number; readonly task: TaskRecord }
  | { readonly type: 'run-finished'; readonly result: RunResult }
  | { readonly type: 'comfy-job'; readonly runId: string; readonly workflowId: string; readonly nodeId: string; readonly job: { readonly promptId: string; readonly queueNumber?: number } }
  | { readonly type: 'comfy-progress'; readonly runId: string; readonly workflowId: string; readonly nodeId: string; readonly event: { readonly type: string; readonly promptId: string; readonly nodeId?: string; readonly value?: number; readonly maximum?: number } }
  | { readonly type: 'persistent-queue-warning'; readonly runId: string; readonly workflowId: string; readonly message: string }
  | { readonly type: 'run-record-warning'; readonly runId: string; readonly workflowId: string; readonly createdAt: string; readonly message: string }

export type RunLifecycleStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'billing-unknown'

export interface RunLifecycleProjection {
  readonly runId: string
  readonly workflowId?: string
  readonly status: RunLifecycleStatus
  readonly dispatchState?: RunDispatchState
  readonly progress: number
  readonly message: string
  readonly node?: { readonly nodeId: string; readonly status: TaskRecord['status'] }
  readonly timelineEvent?: ExecutionTimelineEvent
  readonly result?: RunResult
  readonly diagnostic?: {
    readonly kind: 'comfy-job' | 'comfy-progress' | 'persistent-queue-warning' | 'run-record-warning'
    readonly message: string
  }
}

export const parseRunLifecycleEvent = (raw: unknown): RunLifecycleEvent | undefined => {
  const parsed = runLifecycleEventSchema.safeParse(raw)
  return parsed.success ? parsed.data as RunLifecycleEvent : undefined
}

const eventRunId = (event: RunLifecycleEvent): string => {
  if (event.type === 'timeline') return event.event.runId
  if (event.type === 'task') return event.runId ?? event.task.runId ?? event.task.id
  if (event.type === 'run-finished') return event.result.runId
  return event.runId
}

const resultDispatchState = (result: RunResult): RunDispatchState | undefined =>
  result.dispatchState ?? result.error?.dispatchState ?? (result.error?.billingUnknown ? 'billing_unknown' : undefined)

const redactedPromptId = (promptId: string): string => {
  const suffix = promptId.slice(-5)
  return `••••${suffix}`
}

export const reduceRunLifecycle = (
  current: RunLifecycleProjection,
  event: RunLifecycleEvent,
): RunLifecycleProjection => {
  if (eventRunId(event) !== current.runId) return current
  switch (event.type) {
    case 'run-queued':
      return { ...current, workflowId: event.workflowId, status: 'pending', progress: 0, message: '已加入运行队列' }
    case 'run-started':
      return { ...current, workflowId: event.workflowId, status: 'running', message: '开始运行' }
    case 'run-cancel-requested':
      return { ...current, message: '正在取消；已派发请求可能无法撤回' }
    case 'run-dispatch':
      return {
        ...current,
        workflowId: event.workflowId,
        dispatchState: event.dispatchState,
        message: event.dispatchState === 'billing_unknown'
          ? '无法确认 Provider 是否已完成或计费'
          : event.dispatchState === 'sent'
            ? '请求已跨过 Provider 网络派发边界'
            : current.message,
      }
    case 'run-progress':
      return {
        ...current,
        workflowId: event.workflowId,
        status: 'running',
        progress: Math.round(event.overallProgress * 100),
        message: event.message,
        ...(event.nodeId && event.nodeStatus ? { node: { nodeId: event.nodeId, status: event.nodeStatus } } : {}),
      }
    case 'timeline':
      return { ...current, workflowId: event.workflowId, timelineEvent: event.event }
    case 'task': {
      const status = event.task.dispatchState === 'billing_unknown' || event.task.status === 'billing-unknown'
        ? 'billing-unknown'
        : event.task.status === 'succeeded'
          ? 'running'
          : event.task.status
      const nextDispatch = event.task.dispatchState ?? current.dispatchState
      return {
        ...current,
        workflowId: event.task.workflowId,
        status,
        ...(nextDispatch ? { dispatchState: nextDispatch } : {}),
        progress: Math.round(event.overallProgress * 100),
        message: event.task.message,
        node: { nodeId: event.task.nodeId, status: event.task.status },
      }
    }
    case 'run-finished': {
      const state = resultDispatchState(event.result)
      return {
        ...current,
        status: state === 'billing_unknown' ? 'billing-unknown' : event.result.status,
        ...(state ? { dispatchState: state } : {}),
        progress: 100,
        message: event.result.error?.message ?? (event.result.status === 'succeeded' ? '运行完成' : event.result.status === 'cancelled' ? '运行已取消' : '运行失败'),
        result: event.result,
      }
    }
    case 'comfy-job': {
      const promptId = redactedPromptId(event.job.promptId)
      const message = `ComfyUI 已接收任务（prompt_id ${promptId}${event.job.queueNumber === undefined ? '' : ` · 队列 ${event.job.queueNumber}`}）`
      return {
        ...current,
        workflowId: event.workflowId,
        status: 'running',
        dispatchState: 'sent',
        message,
        node: { nodeId: event.nodeId, status: 'running' },
        diagnostic: { kind: 'comfy-job', message },
      }
    }
    case 'comfy-progress': {
      const promptId = redactedPromptId(event.event.promptId)
      const percentage = event.event.value !== undefined && event.event.maximum !== undefined
        ? ` ${Math.max(0, Math.min(100, Math.round(event.event.value / event.event.maximum * 100)))}%`
        : ''
      const message = `ComfyUI${percentage || ` · ${event.event.type}`}（prompt_id ${promptId}）`
      return {
        ...current,
        workflowId: event.workflowId,
        status: 'running',
        message,
        node: { nodeId: event.nodeId, status: 'running' },
        diagnostic: { kind: 'comfy-progress', message },
      }
    }
    case 'persistent-queue-warning':
      return {
        ...current,
        workflowId: event.workflowId,
        message: event.message,
        diagnostic: { kind: 'persistent-queue-warning', message: event.message },
      }
    case 'run-record-warning':
      return {
        ...current,
        workflowId: event.workflowId,
        message: event.message,
        diagnostic: { kind: 'run-record-warning', message: event.message },
      }
  }
}
