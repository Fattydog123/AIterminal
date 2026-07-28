import type { StudioBridge } from '@studio/shared/contracts.js'
import type { RunPlan, RunResult, WorkflowDocument } from '@studio/shared/types.js'
import {
  parseRunLifecycleEvent,
  reduceRunLifecycle,
  type RunLifecycleEvent,
  type RunLifecycleProjection,
} from '../../../../../studio/core/runLifecycle.ts'

type PreflightBridge = Pick<StudioBridge, 'prepareRun' | 'startRun'>
export type StudioSessionAdapter = Pick<StudioBridge, 'prepareRun' | 'startRun' | 'cancelRun' | 'onRunEvent'>
type RunOverrides = NonNullable<Parameters<StudioBridge['prepareRun']>[0]['overrides']>

export interface StudioSessionPrepareInput {
  readonly bridge: StudioSessionAdapter
  readonly projectPath: string
  readonly workflow: WorkflowDocument
  readonly workflowFingerprint: string
  readonly targetNodeIds: readonly string[]
  readonly overrides: RunOverrides
}

export interface StudioSessionConfirmation {
  readonly projectPath: string
  readonly workflowFingerprint: string
}

export interface PreparedStudioSession {
  readonly plan: RunPlan
  readonly workflow: WorkflowDocument
  readonly workflowFingerprint: string
  readonly targetNodeIds: readonly string[]
}

interface FrozenSession extends PreparedStudioSession {
  readonly bridge: StudioSessionAdapter
  readonly projectPath: string
  readonly overrides: RunOverrides
}

export type StudioRunSessionPhase = 'starting' | 'queued' | 'running' | 'cancelling' | 'terminal'
export type StudioRunCancellationState = 'idle' | 'requesting' | 'requested' | 'failed'
export type StudioRunTerminalAuthority = 'run-event' | 'start-result' | 'start-error'

export interface StudioRunSessionState {
  readonly runId: string
  readonly phase: StudioRunSessionPhase
  readonly cancellation: StudioRunCancellationState
  readonly projection: RunLifecycleProjection
  readonly terminalAuthority?: StudioRunTerminalAuthority
  readonly startError?: string
}

export interface StudioRunSessionFeedback {
  readonly source: 'start' | 'event' | 'cancel' | 'result' | 'error'
  readonly run: StudioRunSessionState
  readonly event?: RunLifecycleEvent
}

export interface StudioRunSessionSnapshot {
  readonly sequence: number
  readonly activeRunIds: readonly string[]
  readonly runs: readonly StudioRunSessionState[]
  readonly latestFeedback?: StudioRunSessionFeedback
}

interface MutableStudioRunSession {
  readonly bridge: StudioSessionAdapter
  readonly runId: string
  projection: RunLifecycleProjection
  phase: StudioRunSessionPhase
  phaseBeforeCancel?: Exclude<StudioRunSessionPhase, 'cancelling' | 'terminal'>
  cancellation: StudioRunCancellationState
  terminalAuthority?: StudioRunTerminalAuthority
  startError?: string
  cancelPromise?: Promise<boolean>
}

const clonePrepared = (session: FrozenSession): PreparedStudioSession => ({
  plan: structuredClone(session.plan),
  workflow: structuredClone(session.workflow),
  workflowFingerprint: session.workflowFingerprint,
  targetNodeIds: [...session.targetNodeIds],
})

const cloneRunSession = (session: MutableStudioRunSession): StudioRunSessionState => ({
  runId: session.runId,
  phase: session.phase,
  cancellation: session.cancellation,
  projection: structuredClone(session.projection),
  ...(session.terminalAuthority ? { terminalAuthority: session.terminalAuthority } : {}),
  ...(session.startError ? { startError: session.startError } : {}),
})

const runIdFromEvent = (event: RunLifecycleEvent): string => {
  if (event.type === 'timeline') return event.event.runId
  if (event.type === 'task') return event.runId ?? event.task.runId ?? event.task.id
  if (event.type === 'run-finished') return event.result.runId
  return event.runId
}

const workflowIdFromEvent = (event: RunLifecycleEvent): string | undefined => {
  if (event.type === 'timeline') return event.workflowId
  if (event.type === 'task') return event.task.workflowId
  if (event.type === 'run-finished' || event.type === 'run-cancel-requested') return undefined
  return event.workflowId
}

const initialRunProjection = (
  runId: string,
  workflowId: string | undefined,
  message = '等待主进程运行反馈',
): RunLifecycleProjection => ({
  runId,
  ...(workflowId ? { workflowId } : {}),
  status: 'pending',
  progress: 0,
  message,
})

const withoutTransientFeedback = (projection: RunLifecycleProjection): RunLifecycleProjection => {
  const {
    node: _node,
    timelineEvent: _timelineEvent,
    diagnostic: _diagnostic,
    ...stable
  } = projection
  return stable
}

const phaseAfterEvent = (
  current: MutableStudioRunSession,
  event: RunLifecycleEvent,
): StudioRunSessionPhase => {
  if (event.type === 'run-finished') return 'terminal'
  if (event.type === 'run-cancel-requested' || current.cancellation === 'requesting' || current.cancellation === 'requested') {
    return 'cancelling'
  }
  if (event.type === 'run-queued') return 'queued'
  if (event.type === 'run-started' || event.type === 'run-progress' || event.type === 'task'
    || event.type === 'timeline' || event.type === 'run-dispatch' || event.type === 'comfy-job'
    || event.type === 'comfy-progress') return 'running'
  return current.phase
}

/**
 * Owns the security-sensitive boundary between renderer preflight and explicit
 * confirmation. Inputs are copied once at preflight and never rebuilt from live
 * UI state when the user confirms.
 */
export class StudioSessionController {
  #epoch = 0
  #prepared: FrozenSession | undefined
  #adapter: StudioSessionAdapter | undefined
  #eventUnsubscribe: (() => void) | undefined
  #connectionEpoch = 0
  #disposed = false
  #sequence = 0
  readonly #listeners = new Set<() => void>()
  readonly #runs = new Map<string, MutableStudioRunSession>()
  #snapshot: StudioRunSessionSnapshot = {
    sequence: 0,
    activeRunIds: [],
    runs: [],
  }

  getSnapshot = (): StudioRunSessionSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  connect(adapter: StudioSessionAdapter): void {
    if (this.#disposed) throw new Error('Studio 运行会话已经释放')
    if (this.#adapter === adapter && this.#eventUnsubscribe) return
    this.disconnect()
    this.#adapter = adapter
    const connectionEpoch = this.#connectionEpoch
    const unsubscribe = adapter.onRunEvent((rawEvent) => {
      if (this.#disposed || connectionEpoch !== this.#connectionEpoch) return
      this.#receiveEvent(rawEvent, adapter)
    })
    this.#eventUnsubscribe = unsubscribe
  }

  disconnect(): void {
    this.#connectionEpoch += 1
    const unsubscribe = this.#eventUnsubscribe
    this.#eventUnsubscribe = undefined
    this.#adapter = undefined
    try { unsubscribe?.() } catch { /* stale listener cleanup is best-effort */ }
  }

  clear(): void {
    this.#epoch += 1
    this.#prepared = undefined
  }

  dispose(): void {
    if (this.#disposed) return
    this.clear()
    this.disconnect()
    this.#disposed = true
    this.#runs.clear()
    this.#listeners.clear()
    this.#snapshot = { sequence: this.#sequence, activeRunIds: [], runs: [] }
  }

  async prepare(input: StudioSessionPrepareInput): Promise<PreparedStudioSession> {
    if (this.#disposed) throw new Error('Studio 运行会话已经释放')
    this.connect(input.bridge)
    this.clear()
    const epoch = this.#epoch
    const workflow = structuredClone(input.workflow)
    const targetNodeIds = [...new Set(input.targetNodeIds)]
    const overrides = structuredClone(input.overrides)
    const plan = await input.bridge.prepareRun({
      projectPath: input.projectPath,
      workflow: structuredClone(workflow),
      ...(targetNodeIds.length > 0 ? { targetNodeIds: [...targetNodeIds] } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides: structuredClone(overrides) } : {}),
    })
    if (epoch !== this.#epoch) throw new Error('已有更新的执行预检，本次旧计划已丢弃')
    if (plan.workflowId !== workflow.id) throw new Error('主进程返回了不属于当前 Workflow 的执行计划')
    const frozen: FrozenSession = {
      bridge: input.bridge,
      projectPath: input.projectPath,
      plan: structuredClone(plan),
      workflow,
      workflowFingerprint: input.workflowFingerprint,
      targetNodeIds,
      overrides,
    }
    this.#prepared = frozen
    return clonePrepared(frozen)
  }

  async confirm(current: StudioSessionConfirmation): Promise<RunResult> {
    if (this.#disposed) throw new Error('Studio 运行会话已经释放')
    const prepared = this.#prepared
    if (!prepared) throw new Error('执行计划不存在或已经确认，请重新预检')
    if (prepared.projectPath !== current.projectPath) {
      throw new Error('项目在预检后发生变化，已拒绝旧计划')
    }
    if (prepared.workflowFingerprint !== current.workflowFingerprint) {
      throw new Error('画布在预检后发生变化，已拒绝旧计划')
    }
    this.clear()
    const runId = prepared.plan.id
    const run: MutableStudioRunSession = {
      bridge: prepared.bridge,
      runId,
      phase: 'starting',
      cancellation: 'idle',
      projection: initialRunProjection(runId, prepared.workflow.id, '正在启动运行'),
    }
    this.#runs.set(runId, run)
    this.#publish(run, 'start')
    try {
      const result = await prepared.bridge.startRun({
        projectPath: prepared.projectPath,
        workflow: structuredClone(prepared.workflow),
        planId: runId,
        ...(prepared.targetNodeIds.length > 0 ? { targetNodeIds: [...prepared.targetNodeIds] } : {}),
        ...(Object.keys(prepared.overrides).length > 0 ? { overrides: structuredClone(prepared.overrides) } : {}),
      })
      if (result.runId !== runId) {
        throw new Error('主进程返回了不属于当前执行计划的运行结果')
      }
      this.#settleFromResult(runId, result, 'start-result')
      return this.#authoritativeResult(runId) ?? structuredClone(result)
    } catch (error) {
      this.#settleFromStartError(runId, error)
      const authoritativeResult = this.#authoritativeResult(runId)
      if (authoritativeResult) return authoritativeResult
      throw error
    }
  }

  cancel(runId: string): Promise<boolean> {
    if (this.#disposed) return Promise.reject(new Error('Studio 运行会话已经释放'))
    const existing = this.#runs.get(runId)
    if (existing?.phase === 'terminal') return Promise.resolve(false)
    if (existing?.cancelPromise) return existing.cancelPromise
    if (existing?.cancellation === 'requested') return Promise.resolve(true)
    const bridge = existing?.bridge ?? this.#adapter
    if (!bridge) return Promise.reject(new Error('Studio 运行桥尚未连接'))
    const run = existing ?? {
      bridge,
      runId,
      phase: 'starting' as const,
      cancellation: 'idle' as const,
      projection: initialRunProjection(runId, undefined),
    }
    if (!existing) this.#runs.set(runId, run)
    run.phaseBeforeCancel = run.phase === 'queued' || run.phase === 'running' ? run.phase : 'starting'
    run.phase = 'cancelling'
    run.cancellation = 'requesting'
    run.projection = { ...withoutTransientFeedback(run.projection), message: '正在提交取消请求' }
    this.#publish(run, 'cancel')

    let operation!: Promise<boolean>
    operation = Promise.resolve()
      .then(() => bridge.cancelRun({ runId }))
      .then((accepted) => {
        const current = this.#runs.get(runId)
        if (!current || current !== run || current.phase === 'terminal') return accepted
        if (accepted) {
          if (current.cancellation !== 'requested') {
            current.cancellation = 'requested'
            current.phase = 'cancelling'
            current.projection = {
              ...withoutTransientFeedback(current.projection),
              message: '取消请求已受理，等待主进程确认终态',
            }
            this.#publish(current, 'cancel')
          }
          return true
        }
        if (current.cancellation !== 'requested') {
          current.cancellation = 'failed'
          current.phase = current.phaseBeforeCancel ?? 'running'
          current.projection = {
            ...withoutTransientFeedback(current.projection),
            message: '运行已经结束或不在当前运行队列中',
          }
          this.#publish(current, 'cancel')
        }
        return false
      })
      .catch((error: unknown) => {
        const current = this.#runs.get(runId)
        if (current && current === run && current.cancellation === 'requested') return true
        if (current && current === run && current.phase !== 'terminal') {
          current.cancellation = 'failed'
          current.phase = current.phaseBeforeCancel ?? 'running'
          current.projection = {
            ...withoutTransientFeedback(current.projection),
            message: error instanceof Error ? error.message : '取消请求未完成',
          }
          this.#publish(current, 'error')
        }
        throw error
      })
      .finally(() => {
        const current = this.#runs.get(runId)
        if (current?.cancelPromise === operation) current.cancelPromise = undefined
      })
    run.cancelPromise = operation
    return operation
  }

  #receiveEvent(rawEvent: unknown, bridge: StudioSessionAdapter): void {
    const event = parseRunLifecycleEvent(rawEvent)
    if (!event) return
    const runId = runIdFromEvent(event)
    let run = this.#runs.get(runId)
    if (run?.phase === 'terminal') {
      if (event.type !== 'persistent-queue-warning' && event.type !== 'run-record-warning') return
      run.projection = reduceRunLifecycle(withoutTransientFeedback(run.projection), event)
      this.#publish(run, 'event', event)
      return
    }
    if (!run) {
      run = {
        bridge,
        runId,
        phase: 'starting',
        cancellation: 'idle',
        projection: initialRunProjection(runId, workflowIdFromEvent(event)),
      }
      this.#runs.set(runId, run)
    }
    run.projection = reduceRunLifecycle(withoutTransientFeedback(run.projection), event)
    if (event.type === 'run-cancel-requested') run.cancellation = 'requested'
    run.phase = phaseAfterEvent(run, event)
    if (event.type === 'run-finished') run.terminalAuthority = 'run-event'
    this.#publish(run, 'event', event)
  }

  #settleFromResult(runId: string, result: RunResult, authority: StudioRunTerminalAuthority): void {
    const run = this.#runs.get(runId)
    if (!run || run.phase === 'terminal') return
    const event: RunLifecycleEvent = { type: 'run-finished', result: structuredClone(result) }
    run.projection = reduceRunLifecycle(withoutTransientFeedback(run.projection), event)
    run.phase = 'terminal'
    run.terminalAuthority = authority
    this.#publish(run, 'result', event)
  }

  #settleFromStartError(runId: string, error: unknown): void {
    const run = this.#runs.get(runId)
    if (!run || run.phase === 'terminal') return
    const message = error instanceof Error ? error.message : '运行启动失败'
    run.projection = { ...withoutTransientFeedback(run.projection), status: 'failed', message }
    run.phase = 'terminal'
    run.terminalAuthority = 'start-error'
    run.startError = message
    this.#publish(run, 'error')
  }

  #authoritativeResult(runId: string): RunResult | undefined {
    const run = this.#runs.get(runId)
    if (!run || run.phase !== 'terminal' || !run.projection.result) return undefined
    return structuredClone(run.projection.result)
  }

  #publish(
    run: MutableStudioRunSession,
    source: StudioRunSessionFeedback['source'],
    event?: RunLifecycleEvent,
  ): void {
    if (this.#disposed) return
    this.#sequence += 1
    const runSnapshot = cloneRunSession(run)
    const runs = [...this.#runs.values()].map(cloneRunSession)
    this.#snapshot = {
      sequence: this.#sequence,
      activeRunIds: runs.filter((item) => item.phase !== 'terminal').map((item) => item.runId),
      runs,
      latestFeedback: {
        source,
        run: runSnapshot,
        ...(event ? { event: structuredClone(event) } : {}),
      },
    }
    for (const listener of this.#listeners) listener()
  }
}

export interface PromptMatrixSessionPrepareInput {
  readonly bridge: PreflightBridge
  readonly projectPath: string
  readonly workflowFingerprint: string
  readonly sourceGeneration: number
  readonly workflows: readonly WorkflowDocument[]
  readonly targetNodeIds: readonly string[]
  readonly overrides: RunOverrides
}

export interface PromptMatrixSessionConfirmation extends StudioSessionConfirmation {
  readonly sourceGeneration: number
  readonly prepareGeneration: number
}

export interface PreparedPromptMatrixRun {
  readonly workflow: WorkflowDocument
  readonly plan: RunPlan
}

export interface PreparedPromptMatrixSession {
  readonly prepareGeneration: number
  readonly workflowFingerprint: string
  readonly sourceGeneration: number
  readonly targetNodeIds: readonly string[]
  readonly runs: readonly PreparedPromptMatrixRun[]
}

interface FrozenPromptMatrixSession extends PreparedPromptMatrixSession {
  readonly bridge: PreflightBridge
  readonly projectPath: string
  readonly overrides: RunOverrides
}

const clonePreparedPromptMatrix = (session: FrozenPromptMatrixSession): PreparedPromptMatrixSession => ({
  prepareGeneration: session.prepareGeneration,
  workflowFingerprint: session.workflowFingerprint,
  sourceGeneration: session.sourceGeneration,
  targetNodeIds: [...session.targetNodeIds],
  runs: session.runs.map((run) => ({
    workflow: structuredClone(run.workflow),
    plan: structuredClone(run.plan),
  })),
})

/**
 * Freezes an entire Prompt Matrix between billable preflight and confirmation.
 * The Store may render its cloned plan, but only this module can dispatch the
 * matching frozen workflows, targets, and debug overrides.
 */
export class PromptMatrixSessionController {
  #generation = 0
  #prepared: FrozenPromptMatrixSession | undefined

  clear(): void {
    this.#generation += 1
    this.#prepared = undefined
  }

  async prepare(input: PromptMatrixSessionPrepareInput): Promise<PreparedPromptMatrixSession> {
    this.clear()
    const prepareGeneration = this.#generation
    const workflows = input.workflows.map((workflow) => structuredClone(workflow))
    if (workflows.length === 0) throw new Error('Prompt Matrix 没有可预检的 Workflow')
    const targetNodeIds = [...new Set(input.targetNodeIds)]
    const overrides = structuredClone(input.overrides)
    const runs: PreparedPromptMatrixRun[] = []
    for (const workflow of workflows) {
      const plan = await input.bridge.prepareRun({
        projectPath: input.projectPath,
        workflow: structuredClone(workflow),
        ...(targetNodeIds.length > 0 ? { targetNodeIds: [...targetNodeIds] } : {}),
        ...(Object.keys(overrides).length > 0 ? { overrides: structuredClone(overrides) } : {}),
      })
      if (prepareGeneration !== this.#generation) {
        throw new Error('已有更新的 Prompt Matrix 预检，本次旧计划已丢弃')
      }
      if (plan.workflowId !== workflow.id) {
        throw new Error('主进程返回了不属于当前 Prompt Matrix Workflow 的执行计划')
      }
      runs.push({ workflow, plan: structuredClone(plan) })
    }
    const frozen: FrozenPromptMatrixSession = {
      bridge: input.bridge,
      projectPath: input.projectPath,
      prepareGeneration,
      workflowFingerprint: input.workflowFingerprint,
      sourceGeneration: input.sourceGeneration,
      targetNodeIds,
      overrides,
      runs,
    }
    this.#prepared = frozen
    return clonePreparedPromptMatrix(frozen)
  }

  async confirm(
    current: PromptMatrixSessionConfirmation,
    onAccepted?: (prepared: PreparedPromptMatrixSession) => void,
  ): Promise<readonly PromiseSettledResult<RunResult>[]> {
    const prepared = this.#prepared
    if (!prepared || prepared.prepareGeneration !== current.prepareGeneration) {
      throw new Error('Prompt Matrix 计划不存在或已经被更新，请重新预检')
    }
    if (prepared.projectPath !== current.projectPath) {
      throw new Error('项目在 Prompt Matrix 预检后发生变化，已拒绝旧计划')
    }
    if (prepared.workflowFingerprint !== current.workflowFingerprint) {
      throw new Error('画布在 Prompt Matrix 预检后发生变化，已拒绝旧计划')
    }
    if (prepared.sourceGeneration !== current.sourceGeneration) {
      throw new Error('画布在 Prompt Matrix 预检后已被编辑，已拒绝旧计划')
    }
    this.clear()
    onAccepted?.(clonePreparedPromptMatrix(prepared))
    return Promise.allSettled(prepared.runs.map((run) => Promise.resolve().then(() => prepared.bridge.startRun({
      projectPath: prepared.projectPath,
      workflow: structuredClone(run.workflow),
      planId: run.plan.id,
      ...(prepared.targetNodeIds.length > 0 ? { targetNodeIds: [...prepared.targetNodeIds] } : {}),
      ...(Object.keys(prepared.overrides).length > 0 ? { overrides: structuredClone(prepared.overrides) } : {}),
    }))))
  }
}
