import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  BackgroundTaskDto,
  BackgroundTaskSubmitInput,
  TurnStartInput,
} from '../../../shared/contracts.ts'
import type { ConversationRuntime } from '../conversation/conversation-session-adapter.ts'

export type BackgroundTaskMutationResult =
  | { readonly ok: true; readonly task: BackgroundTaskDto }
  | { readonly ok: false; readonly message: string }

export interface BackgroundTaskSession {
  readonly tasks: readonly BackgroundTaskDto[]
  readonly loading: boolean
  readonly error: string
  readonly attaching: boolean
  readonly busyTaskIds: ReadonlySet<string>
  refresh(): Promise<void>
  attach(input: BackgroundTaskSubmitInput): Promise<BackgroundTaskMutationResult>
  followUp(id: string, turn: TurnStartInput): Promise<BackgroundTaskMutationResult>
  resume(id: string, turn: TurnStartInput): Promise<BackgroundTaskMutationResult>
  cancel(id: string): Promise<{ readonly ok: boolean; readonly message: string }>
}

const ACTIVE_STATUSES = new Set<BackgroundTaskDto['status']>([
  'queued',
  'running',
  'waiting-approval',
])

export function useBackgroundTasks(runtime: ConversationRuntime): BackgroundTaskSession {
  const enabled = runtime === 'desktop'
  const [tasks, setTasks] = useState<BackgroundTaskDto[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set())
  const requestEpochRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !('onekey' in window)) {
      setTasks([])
      setLoading(false)
      return
    }
    const epoch = ++requestEpochRef.current
    try {
      const result = await window.onekey.background.list()
      if (requestEpochRef.current !== epoch) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setTasks(result.value)
      setError('')
    } catch {
      if (requestEpochRef.current === epoch) setError('后台任务状态暂时无法刷新。')
    } finally {
      if (requestEpochRef.current === epoch) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const hasActiveTask = tasks.some((task) => ACTIVE_STATUSES.has(task.status))
  useEffect(() => {
    if (!enabled) return
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = window.setInterval(refreshWhenVisible, hasActiveTask ? 2_000 : 8_000)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [enabled, hasActiveTask, refresh])

  const upsertTask = useCallback((task: BackgroundTaskDto): void => {
    setTasks((current) => [task, ...current.filter((entry) => entry.id !== task.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
    setError('')
  }, [])

  const setTaskBusy = useCallback((id: string, busy: boolean): void => {
    setBusyTaskIds((current) => {
      const next = new Set(current)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const attach = useCallback(async (input: BackgroundTaskSubmitInput): Promise<BackgroundTaskMutationResult> => {
    if (!enabled || !('onekey' in window)) return { ok: false, message: '后台任务仅在桌面端可用。' }
    requestEpochRef.current += 1
    setAttaching(true)
    setError('')
    try {
      const result = await window.onekey.background.submit(input)
      if (!result.ok) {
        setError(result.error.message)
        return { ok: false, message: result.error.message }
      }
      upsertTask(result.value)
      return { ok: true, task: result.value }
    } catch {
      const message = '任务未能转到后台，请重试。'
      setError(message)
      return { ok: false, message }
    } finally {
      setLoading(false)
      setAttaching(false)
    }
  }, [enabled, upsertTask])

  const runTurnMutation = useCallback(async (
    operation: 'followUp' | 'resume',
    id: string,
    turn: TurnStartInput,
  ): Promise<BackgroundTaskMutationResult> => {
    if (!enabled || !('onekey' in window)) return { ok: false, message: '后台任务仅在桌面端可用。' }
    requestEpochRef.current += 1
    setTaskBusy(id, true)
    setError('')
    try {
      const result = await window.onekey.background[operation]({ id, turn })
      if (!result.ok) {
        setError(result.error.message)
        return { ok: false, message: result.error.message }
      }
      upsertTask(result.value)
      return { ok: true, task: result.value }
    } catch {
      const message = operation === 'resume' ? '任务恢复未完成，请重试。' : '后续消息未能加入队列。'
      setError(message)
      return { ok: false, message }
    } finally {
      setLoading(false)
      setTaskBusy(id, false)
    }
  }, [enabled, setTaskBusy, upsertTask])

  const followUp = useCallback(
    (id: string, turn: TurnStartInput) => runTurnMutation('followUp', id, turn),
    [runTurnMutation],
  )
  const resume = useCallback(
    (id: string, turn: TurnStartInput) => runTurnMutation('resume', id, turn),
    [runTurnMutation],
  )

  const cancel = useCallback(async (id: string): Promise<{ readonly ok: boolean; readonly message: string }> => {
    if (!enabled || !('onekey' in window)) return { ok: false, message: '后台任务仅在桌面端可用。' }
    requestEpochRef.current += 1
    setTaskBusy(id, true)
    setError('')
    try {
      const result = await window.onekey.background.cancel(id)
      if (!result.ok) {
        setError(result.error.message)
        return { ok: false, message: result.error.message }
      }
      setTasks((current) => current.map((task) => task.id === id
        ? { ...task, status: 'cancelled', updatedAt: new Date().toISOString(), queuedFollowUps: 0 }
        : task))
      setError('')
      void refresh()
      return { ok: true, message: '后台任务已停止。' }
    } catch {
      const message = '后台任务停止未完成，请重试。'
      setError(message)
      return { ok: false, message }
    } finally {
      setLoading(false)
      setTaskBusy(id, false)
    }
  }, [enabled, refresh, setTaskBusy])

  return {
    tasks,
    loading,
    error,
    attaching,
    busyTaskIds,
    refresh,
    attach,
    followUp,
    resume,
    cancel,
  }
}

export function isBackgroundTaskActive(status: BackgroundTaskDto['status']): boolean {
  return ACTIVE_STATUSES.has(status)
}
