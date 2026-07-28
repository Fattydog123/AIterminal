import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { BackgroundTaskDto } from '../../../shared/contracts.ts'
import { isBackgroundTaskActive } from './use-background-tasks.ts'

export interface BackgroundTaskPanelProps {
  readonly tasks: readonly BackgroundTaskDto[]
  readonly loading: boolean
  readonly error: string
  readonly busyTaskIds: ReadonlySet<string>
  readonly foregroundBusy: boolean
  onRefresh(): void
  onOpen(task: BackgroundTaskDto): void
  onCancel(task: BackgroundTaskDto): Promise<void>
  onTurn(task: BackgroundTaskDto, prompt: string, operation: 'followUp' | 'resume'): Promise<boolean>
}

const STATUS_LABELS: Record<BackgroundTaskDto['status'], string> = {
  queued: '排队中',
  running: '运行中',
  'waiting-approval': '等待确认',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已停止',
  interrupted: '可恢复',
}

export default function BackgroundTaskPanel({
  tasks,
  loading,
  error,
  busyTaskIds,
  foregroundBusy,
  onRefresh,
  onOpen,
  onCancel,
  onTurn,
}: BackgroundTaskPanelProps) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [expandedTaskId, setExpandedTaskId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const autoOpenedRef = useRef(false)
  const activeCount = tasks.filter((task) => isBackgroundTaskActive(task.status)).length

  useEffect(() => {
    if (activeCount === 0 || autoOpenedRef.current) return
    autoOpenedRef.current = true
    setOpen(true)
    setExpandedTaskId(tasks.find((task) => isBackgroundTaskActive(task.status))?.id ?? '')
  }, [activeCount, tasks])

  const orderedTasks = useMemo(() => [...tasks].sort((left, right) => {
    const activeDelta = Number(isBackgroundTaskActive(right.status)) - Number(isBackgroundTaskActive(left.status))
    return activeDelta || right.updatedAt.localeCompare(left.updatedAt)
  }), [tasks])
  const visibleTasks = showAll ? orderedTasks : orderedTasks.slice(0, 4)

  const submitTurn = async (task: BackgroundTaskDto): Promise<void> => {
    const active = isBackgroundTaskActive(task.status)
    const prompt = drafts[task.id]?.trim() ?? ''
    if (active && !prompt) return
    const accepted = await onTurn(task, prompt, active ? 'followUp' : 'resume')
    if (accepted) setDrafts((current) => ({ ...current, [task.id]: '' }))
  }

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>, task: BackgroundTaskDto): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submitTurn(task)
  }

  return (
    <section className={`background-task-panel ${open ? 'is-open' : ''}`} aria-label="后台任务">
      <div className="background-task-panel-heading">
        <button
          type="button"
          className="background-task-panel-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Bot size={14} />
          <span>后台任务</span>
          <span className={`background-task-count ${activeCount > 0 ? 'is-active' : ''}`}>
            {activeCount > 0 ? activeCount : tasks.length}
          </span>
        </button>
        <button
          type="button"
          className="background-task-icon-button"
          aria-label="刷新后台任务"
          data-tooltip="刷新后台任务"
          title="刷新后台任务"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {open && (
        <div className="background-task-list">
          {error && <p className="background-task-error"><AlertCircle size={12} />{error}</p>}
          {!loading && tasks.length === 0 && !error && (
            <p className="background-task-empty">没有后台任务</p>
          )}
          {visibleTasks.map((task) => {
            const active = isBackgroundTaskActive(task.status)
            const expanded = expandedTaskId === task.id
            const busy = busyTaskIds.has(task.id)
            const latestEvent = task.events.at(-1)
            return (
              <article className={`background-task-item status-${task.status}`} key={task.id}>
                <div className="background-task-summary">
                  <button
                    type="button"
                    className="background-task-main"
                    aria-expanded={expanded}
                    onClick={() => setExpandedTaskId((current) => current === task.id ? '' : task.id)}
                  >
                    <TaskStatusIcon status={task.status} />
                    <span className="background-task-copy">
                      <strong title={task.title}>{task.title}</strong>
                      <small title={latestEvent?.label}>{latestEvent?.label ?? STATUS_LABELS[task.status]}</small>
                    </span>
                    <span className={`background-task-status status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
                  </button>
                  <div className="background-task-actions">
                    {active && (
                      <button
                        type="button"
                        aria-label="停止后台任务"
                        data-tooltip="停止后台任务"
                        title="停止后台任务"
                        disabled={busy}
                        onClick={() => { void onCancel(task) }}
                      >
                        {busy ? <LoaderCircle size={13} className="spin" /> : <Square size={11} fill="currentColor" />}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="重新打开会话"
                      data-tooltip="重新打开会话"
                      title="重新打开会话"
                      disabled={foregroundBusy}
                      onClick={() => onOpen(task)}
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="background-task-details">
                    {task.events.length > 0 && (
                      <ol className="background-task-events" aria-label="任务进度">
                        {task.events.slice(-6).map((event) => (
                          <li className={`event-${event.status}`} key={event.id}>
                            <span aria-hidden="true" />
                            <span title={event.label}>{event.label}</span>
                            <time dateTime={event.createdAt}>{formatTaskTime(event.createdAt)}</time>
                          </li>
                        ))}
                      </ol>
                    )}
                    {(task.error || task.result) && (
                      <p className={`background-task-result ${task.error ? 'is-error' : ''}`}>
                        {task.error ?? task.result}
                      </p>
                    )}
                    <div className="background-task-follow-up">
                      <input
                        value={drafts[task.id] ?? ''}
                        onChange={(event) => setDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                        onKeyDown={(event) => handleDraftKeyDown(event, task)}
                        placeholder={active ? '追加要求' : '说明接下来要做什么（可留空）'}
                        aria-label={active ? '追加后台任务要求' : '恢复后台任务说明'}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        aria-label={active ? '加入后续队列' : '恢复任务'}
                        data-tooltip={active ? '加入后续队列' : '恢复任务'}
                        title={active ? '加入后续队列' : '恢复任务'}
                        disabled={busy || (active && !(drafts[task.id]?.trim()))}
                        onClick={() => { void submitTurn(task) }}
                      >
                        {busy
                          ? <LoaderCircle size={14} className="spin" />
                          : active ? <Send size={14} /> : <RotateCcw size={14} />}
                      </button>
                    </div>
                    {task.queuedFollowUps > 0 && (
                      <small className="background-task-queued">已排队 {task.queuedFollowUps} 条后续消息</small>
                    )}
                  </div>
                )}
              </article>
            )
          })}
          {orderedTasks.length > 4 && (
            <button type="button" className="background-task-show-all" onClick={() => setShowAll((current) => !current)}>
              {showAll ? '收起历史任务' : `查看全部 ${orderedTasks.length} 项`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function TaskStatusIcon({ status }: { status: BackgroundTaskDto['status'] }) {
  if (status === 'running') return <LoaderCircle size={14} className="spin background-task-state-icon" />
  if (status === 'queued') return <CircleDot size={14} className="background-task-state-icon" />
  if (status === 'waiting-approval') return <ShieldAlert size={14} className="background-task-state-icon" />
  if (status === 'completed') return <CheckCircle2 size={14} className="background-task-state-icon" />
  if (status === 'interrupted') return <RotateCcw size={14} className="background-task-state-icon" />
  if (status === 'cancelled') return <Square size={11} className="background-task-state-icon" />
  return <AlertCircle size={14} className="background-task-state-icon" />
}

function formatTaskTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
