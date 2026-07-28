import {
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleX,
  FileCog,
  LoaderCircle,
  Send,
  ShieldAlert,
  Square,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import type { AgentExecutionEntry } from './conversation-session.ts'
import {
  executionDuration,
  executionStatusLabel,
  presentAgentExecution,
  type AgentExecutionOverallState,
} from './agent-execution-presentation.ts'

type ExecutionVisualKind =
  | 'request'
  | 'analysis'
  | 'subagent'
  | 'file'
  | 'command'
  | 'tool'
  | 'approval'
  | 'completion'
  | 'failure'
  | 'stopped'

function executionVisual(entry: AgentExecutionEntry): {
  icon: LucideIcon
  kind: ExecutionVisualKind
  label: string
} {
  if (entry.status === 'failed') return { icon: CircleX, kind: 'failure', label: '未完成' }
  if (entry.status === 'cancelled') return { icon: Square, kind: 'stopped', label: '已停止' }
  if (entry.kind === 'approval') return { icon: ShieldAlert, kind: 'approval', label: '确认' }
  if (entry.kind === 'terminal') return { icon: CheckCircle2, kind: 'completion', label: '完成' }
  if (entry.kind === 'subagent') return { icon: Bot, kind: 'subagent', label: '子智能体' }
  if (entry.kind === 'status') {
    return /请求|提交|发送|排队|queued|request/iu.test(entry.label)
      ? { icon: Send, kind: 'request', label: '请求' }
      : { icon: BrainCircuit, kind: 'analysis', label: '思考' }
  }

  const toolLabel = `${entry.label} ${entry.detail ?? ''}`
  if (/命令|终端|脚本|测试|构建|运行|执行程序|command|terminal|shell|script|build|test/iu.test(toolLabel)) {
    return { icon: SquareTerminal, kind: 'command', label: '命令' }
  }
  if (/文件|目录|路径|工作区|读取|写入|编辑|搜索|列出|file|folder|path|workspace|read|write|edit|search|list/iu.test(toolLabel)) {
    return { icon: FileCog, kind: 'file', label: '文件' }
  }
  return { icon: Wrench, kind: 'tool', label: '操作' }
}

function executionStateIcon(entry: AgentExecutionEntry): LucideIcon {
  if (entry.status === 'running') return LoaderCircle
  if (entry.status === 'waiting') return entry.kind === 'approval' ? ShieldAlert : Circle
  if (entry.status === 'completed') return Check
  if (entry.status === 'failed') return CircleX
  return Square
}

const overallLabel: Readonly<Record<AgentExecutionOverallState, string>> = {
  running: 'Agent 正在工作',
  approval: '等待你的确认',
  completed: '本轮执行完成',
  failed: '执行遇到问题',
  cancelled: '本轮执行已停止',
}

export default function AgentExecutionSummary({
  entries,
  now,
}: {
  entries: readonly AgentExecutionEntry[]
  now: number
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const presentation = useMemo(() => presentAgentExecution(entries), [entries])
  if (!presentation) return null

  const primaryVisual = executionVisual(presentation.primary)
  const PrimaryIcon = primaryVisual.icon
  const primaryLabel = presentation.primary.kind === 'terminal'
    ? presentation.total > 0
      ? `${presentation.total} 个步骤已处理`
      : presentation.primary.label
    : presentation.primary.label
  const totalDuration = executionDuration(
    presentation.startedAt,
    presentation.primary.endedAt ?? now,
  )
  const subagentStatus = [
    presentation.subagents.running ? `${presentation.subagents.running} 个运行中` : '',
    presentation.subagents.waiting ? `${presentation.subagents.waiting} 个等待中` : '',
    presentation.subagents.completed ? `${presentation.subagents.completed} 个已完成` : '',
    presentation.subagents.failed ? `${presentation.subagents.failed} 个未完成` : '',
  ].filter(Boolean).join(' · ')

  return (
    <section
      className={`agent-run-summary state-${presentation.state}`}
      aria-label="Agent 执行进度"
    >
      <header className="agent-run-heading">
        <span className={`agent-run-primary-icon visual-${primaryVisual.kind}`}>
          <PrimaryIcon className={presentation.primary.status === 'running' ? 'spin' : undefined} size={17} aria-hidden="true" />
        </span>
        <span className="agent-run-primary-copy">
          <small>{overallLabel[presentation.state]}</small>
          <strong>{primaryLabel}</strong>
          {presentation.primary.detail && presentation.primary.detail !== presentation.primary.label && (
            <span>{presentation.primary.detail}</span>
          )}
        </span>
        <span className="agent-run-measure">
          <strong>{presentation.state === 'completed' ? `${presentation.total} 步` : `${presentation.settled}/${presentation.total} 步`}</strong>
          <small>{totalDuration}</small>
        </span>
      </header>

      <div
        className="agent-run-progress"
        role="progressbar"
        aria-label="执行进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={presentation.progress}
      >
        <span style={{ width: `${presentation.progress}%` }} />
      </div>

      {presentation.subagents.total > 0 && (
        <div className="agent-run-subagents">
          <Users size={14} aria-hidden="true" />
          <strong>{presentation.subagents.total} 个子智能体</strong>
          <span>{subagentStatus || '正在准备'}</span>
        </div>
      )}

      {presentation.entries.length > 0 && (
        <button
          type="button"
          className="agent-run-details-toggle"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span>{detailsOpen ? '收起执行过程' : `查看执行过程（${presentation.entries.length}）`}</span>
          <ChevronDown className={detailsOpen ? 'rotate-180' : undefined} size={14} aria-hidden="true" />
        </button>
      )}

      {detailsOpen && (
        <div className="agent-run-details" role="list" aria-label="执行过程">
          {presentation.entries.map((entry) => {
            const visual = executionVisual(entry)
            const Icon = visual.icon
            const StateIcon = executionStateIcon(entry)
            return (
              <div className={`agent-run-step ${entry.status} visual-${visual.kind}`} key={entry.id} role="listitem">
                <span className="live-track-icon" title={visual.label}><Icon size={14} aria-hidden="true" /></span>
                <span className="agent-run-step-copy">
                  <strong>{entry.label}</strong>
                  {entry.detail && entry.detail !== entry.label && <small>{entry.detail}</small>}
                </span>
                <span className={`event-status ${entry.status}`}>
                  <StateIcon className={entry.status === 'running' ? 'spin' : undefined} size={12} aria-hidden="true" />
                  <span>{executionStatusLabel(entry)}</span>
                </span>
                <span className="event-duration">{executionDuration(entry.startedAt, entry.endedAt ?? now)}</span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
