import { AlertTriangle, Bot, CheckCircle2, ChevronRight, Clock3, Image, LoaderCircle, ShieldAlert, X } from 'lucide-react'

import type { BackgroundTaskDto, WorkspaceMode } from '../../../shared/contracts'
import BackgroundTaskPanel, { type BackgroundTaskPanelProps } from '../background-tasks/BackgroundTaskPanel'
import type { StudioRunActivityItem } from './activity-bridge'

export interface StudioActivitySnapshot {
  readonly activeCount: number
  readonly totalCount: number
  readonly label: string
  readonly status: 'idle' | 'running' | 'queued' | 'failed' | 'completed'
}

const STUDIO_STATUS_LABEL: Record<StudioRunActivityItem['status'], string> = {
  'queued': '排队',
  'running': '执行中',
  'success': '完成',
  'error': '失败',
  'billing-unknown': '计费未知',
}

export default function ActivityCenter({
  open,
  mode,
  foregroundTitle,
  foregroundRunning,
  foregroundActivity,
  foregroundWaitingApproval,
  backgroundTasks,
  backgroundTaskPanel,
  studio,
  studioItems,
  onOpenStudioQueue,
  onClose,
}: {
  readonly open: boolean
  readonly mode: WorkspaceMode
  readonly foregroundTitle: string
  readonly foregroundRunning: boolean
  readonly foregroundActivity?: string
  readonly foregroundWaitingApproval?: boolean
  readonly backgroundTasks: readonly BackgroundTaskDto[]
  readonly backgroundTaskPanel: BackgroundTaskPanelProps
  readonly studio: StudioActivitySnapshot
  readonly studioItems: readonly StudioRunActivityItem[]
  readonly onOpenStudioQueue: () => void
  readonly onClose: () => void
}) {
  if (!open) return null
  const activeBackground = backgroundTasks.filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'waiting-approval').length
  const waitingBackground = backgroundTasks.filter((task) => task.status === 'waiting-approval').length
  const failedBackground = backgroundTasks.filter((task) => task.status === 'failed').length
  const visibleStudioItems = studioItems.slice(0, 6)

  return (
    <>
      <button type="button" className="activity-center-scrim" aria-label="关闭任务中心" onClick={onClose} />
      <aside className="activity-center" aria-label="任务中心">
        <header>
          <div><span className="eyebrow">任务中心</span><strong>所有运行</strong></div>
          <button type="button" className="icon-button" aria-label="关闭任务中心" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="activity-center-overview">
          <article className={foregroundRunning ? 'is-running' : ''}>
            <span>{foregroundRunning ? <LoaderCircle className="spin" size={16} /> : <Bot size={16} />}</span>
            <div><strong>{mode === 'agent' ? '当前 Agent' : '当前 Chat'}</strong><small title={foregroundTitle}>{foregroundActivity || foregroundTitle}</small></div>
            <em>{foregroundWaitingApproval ? '等待批准' : foregroundRunning ? '执行中' : '空闲'}</em>
          </article>
          <article className={studio.activeCount > 0 ? 'is-running' : ''}>
            <span>{studio.activeCount > 0 ? <LoaderCircle className="spin" size={16} /> : <Image size={16} />}</span>
            <div><strong>Studio</strong><small>{studio.label}</small></div>
            <em>{studio.activeCount > 0 ? `${studio.activeCount} 项` : '空闲'}</em>
          </article>
        </div>
        <div className="activity-center-summary">
          <span><Clock3 size={13} />后台运行 {activeBackground}</span>
          {waitingBackground > 0 && <span className="is-warning"><ShieldAlert size={13} />等待批准 {waitingBackground}</span>}
          {failedBackground > 0 && <span className="is-danger"><AlertTriangle size={13} />失败 {failedBackground}</span>}
          <span><CheckCircle2 size={13} />记录 {backgroundTasks.length + studio.totalCount}</span>
        </div>
        <div className="activity-center-list">
          {visibleStudioItems.length > 0 && (
            <section className="activity-studio-runs" aria-label="Studio 运行">
              <header>
                <strong>Studio 运行</strong>
                <button type="button" onClick={onOpenStudioQueue}>打开队列<ChevronRight size={12} /></button>
              </header>
              {visibleStudioItems.map((item) => (
                <article key={item.id} className={`status-${item.status}`}>
                  <span className="activity-studio-state">
                    {item.status === 'running' ? <LoaderCircle className="spin" size={13} /> : item.status === 'error' ? <AlertTriangle size={13} /> : item.status === 'success' ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}
                  </span>
                  <div>
                    <strong title={item.title}>{item.title}</strong>
                    <small title={item.message}>{item.workflow}{item.message ? ` · ${item.message}` : ''}</small>
                  </div>
                  <em>{STUDIO_STATUS_LABEL[item.status]}{item.status === 'running' && item.progress > 0 ? ` ${Math.round(item.progress)}%` : ''}</em>
                </article>
              ))}
            </section>
          )}
          <BackgroundTaskPanel {...backgroundTaskPanel} />
        </div>
      </aside>
    </>
  )
}
