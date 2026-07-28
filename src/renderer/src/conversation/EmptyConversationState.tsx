import {
  Bot,
  Code2,
  FileText,
  ListChecks,
  MessageSquare,
  ScanSearch,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import type { WorkspaceMode } from '../../../shared/contracts.ts'

interface StarterAction {
  readonly title: string
  readonly detail: string
  readonly prompt: string
  readonly icon: LucideIcon
}

const AGENT_STARTERS: readonly StarterAction[] = [
  {
    title: '分析项目',
    detail: '梳理结构和优先问题',
    prompt: '分析当前项目的结构与现状，指出最值得优先处理的问题。',
    icon: ScanSearch,
  },
  {
    title: '实现功能',
    detail: '修改文件并说明结果',
    prompt: '根据我的需求实现一个完整可用的功能，并说明改动结果。',
    icon: Wrench,
  },
  {
    title: '排查问题',
    detail: '定位原因并完成处理',
    prompt: '检查项目当前的问题，定位具体原因并完成修复。',
    icon: SquareTerminal,
  },
]

const CHAT_STARTERS: readonly StarterAction[] = [
  {
    title: '解释代码',
    detail: '理解作用和关键逻辑',
    prompt: '请解释下面这段代码的作用、关键逻辑和需要注意的地方：',
    icon: Code2,
  },
  {
    title: '整理方案',
    detail: '把目标拆成清晰步骤',
    prompt: '请把这个目标整理成清晰、可执行的方案：',
    icon: ListChecks,
  },
  {
    title: '整理内容',
    detail: '改善结构和表达',
    prompt: '请整理并改写下面的内容，让结构更清楚、表达更自然：',
    icon: FileText,
  },
]

export default function EmptyConversationState({
  mode,
  onChoose,
}: {
  mode: WorkspaceMode
  onChoose: (prompt: string) => void
}) {
  const agent = mode === 'agent'
  const PrimaryIcon = agent ? Bot : MessageSquare
  const actions = agent ? AGENT_STARTERS : CHAT_STARTERS

  return (
    <section className="transcript-empty conversation-start" aria-labelledby="conversation-start-title">
      <span className="conversation-start-mark"><PrimaryIcon size={21} aria-hidden="true" /></span>
      <div className="conversation-start-copy">
        <h2 id="conversation-start-title">{agent ? '开始一项 Agent 任务' : '开始一段对话'}</h2>
        <span>{agent
          ? '说出目标即可；发送后会自动准备工作目录，并持续显示执行进度。'
          : '直接提问、粘贴内容，或添加文件和图片。'}</span>
      </div>
      <div className="conversation-starters" role="group" aria-label="快捷开始">
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <button type="button" key={action.title} onClick={() => onChoose(action.prompt)}>
              <span><Icon size={15} aria-hidden="true" /></span>
              <span><strong>{action.title}</strong><small>{action.detail}</small></span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
