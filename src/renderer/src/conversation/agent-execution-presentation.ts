import type { AgentExecutionEntry, AgentExecutionStatus } from './conversation-session.ts'

export type AgentExecutionOverallState = 'running' | 'approval' | 'completed' | 'failed' | 'cancelled'

export interface AgentExecutionPresentation {
  readonly entries: readonly AgentExecutionEntry[]
  readonly primary: AgentExecutionEntry
  readonly state: AgentExecutionOverallState
  readonly total: number
  readonly settled: number
  readonly progress: number
  readonly startedAt: number
  readonly subagents: {
    readonly total: number
    readonly running: number
    readonly waiting: number
    readonly completed: number
    readonly failed: number
  }
}

const isSettled = (status: AgentExecutionStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

function withoutRepeatedStatuses(entries: readonly AgentExecutionEntry[]): AgentExecutionEntry[] {
  const seen = new Set<string>()
  const retained: AgentExecutionEntry[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === 'terminal') continue
    if (entry.kind === 'status') {
      const key = `${entry.label.trim()}\u0000${entry.detail?.trim() ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    retained.push(entry)
  }
  return retained.reverse()
}

export function presentAgentExecution(
  source: readonly AgentExecutionEntry[],
): AgentExecutionPresentation | null {
  if (source.length === 0) return null
  const entries = withoutRepeatedStatuses(source)
  const terminal = [...source].reverse().find((entry) => entry.kind === 'terminal')
  const approval = [...entries].reverse().find(
    (entry) => entry.kind === 'approval' && entry.status === 'waiting',
  )
  const active = [...entries].reverse().find(
    (entry) => entry.status === 'running' || entry.status === 'waiting',
  )
  const failure = [...entries].reverse().find((entry) => entry.status === 'failed')
  const primary = approval ?? active ?? terminal ?? failure ?? entries.at(-1)
  if (!primary) return null

  const state: AgentExecutionOverallState = approval
    ? 'approval'
    : active
      ? 'running'
      : terminal
        ? terminal.status === 'failed'
          ? 'failed'
          : terminal.status === 'cancelled'
            ? 'cancelled'
            : 'completed'
        : failure
          ? 'failed'
          : 'completed'
  const settled = entries.filter((entry) => isSettled(entry.status)).length
  const total = entries.length
  const progress = state === 'completed'
    ? 100
    : total === 0
      ? 0
      : Math.min(96, Math.round(settled / total * 100))
  const subagentEntries = entries.filter((entry) => entry.kind === 'subagent')

  return {
    entries,
    primary,
    state,
    total,
    settled,
    progress,
    startedAt: Math.min(...source.map((entry) => entry.startedAt)),
    subagents: {
      total: subagentEntries.length,
      running: subagentEntries.filter((entry) => entry.status === 'running').length,
      waiting: subagentEntries.filter((entry) => entry.status === 'waiting').length,
      completed: subagentEntries.filter((entry) => entry.status === 'completed').length,
      failed: subagentEntries.filter((entry) => entry.status === 'failed' || entry.status === 'cancelled').length,
    },
  }
}

export function executionStatusLabel(entry: AgentExecutionEntry): string {
  if (entry.kind === 'approval') {
    if (entry.status === 'waiting') return '待确认'
    if (entry.status === 'completed') return '已确认'
    if (entry.status === 'cancelled') return '已拒绝'
    if (entry.status === 'failed') return '已失效'
  }
  if (entry.status === 'running') return '进行中'
  if (entry.status === 'waiting') return '等待中'
  if (entry.status === 'completed') return '已完成'
  if (entry.status === 'cancelled') return '已停止'
  return '未完成'
}

export function executionDuration(startedAt: number, endedAt: number): string {
  const elapsedSeconds = Math.max(0, (endedAt - startedAt) / 1000)
  if (elapsedSeconds < 60) return `${elapsedSeconds.toFixed(elapsedSeconds < 10 ? 1 : 0)} 秒`
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = Math.floor(elapsedSeconds % 60)
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}
