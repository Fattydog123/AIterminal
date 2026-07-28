import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon.js'

export function IconButton({
  label,
  icon,
  active = false,
  disabled = false,
  onClick,
  className = '',
}: {
  readonly label: string
  readonly icon: IconName
  readonly active?: boolean
  readonly disabled?: boolean
  readonly onClick?: () => void
  readonly className?: string
}) {
  return (
    <button
      aria-label={label}
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  )
}

export function SectionHeading({ title, meta, action }: { readonly title: string; readonly meta?: string; readonly action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {meta ? <p>{meta}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function StatusPill({ status, label }: { readonly status: string; readonly label?: string }) {
  const icon: IconName = status === 'success' || status === 'connected' || status === 'adopted'
    ? 'check'
    : status === 'error' || status === 'rejected' || status === 'billing-unknown'
      ? 'error'
      : status === 'running'
        ? 'pulse'
        : status === 'queued' || status === 'pending' || status === 'untested'
          ? 'clock'
          : 'info'
  return (
    <span className={`status-pill status-${status}`}>
      <Icon name={icon} size={13} />
      {label ?? ({
        success: '完成',
        connected: '已连接',
        adopted: '已采用',
        error: '失败',
        rejected: '未通过',
        'billing-unknown': '费用待确认',
        running: '执行中',
        queued: '等待中',
        pending: '处理中',
        untested: '尚未检测',
      } as Readonly<Record<string, string>>)[status] ?? '状态更新'}
    </span>
  )
}

const exposureStages = ['排队', '生成', '接收', '处理', '保存'] as const

export function ExposureRail({ active = 0, error = -1, compact = false }: { readonly active?: number; readonly error?: number; readonly compact?: boolean }) {
  return (
    <div aria-label="运行进度：排队、生成、接收、处理、保存" className={`exposure-rail ${compact ? 'is-compact' : ''}`} role="img">
      {exposureStages.map((stage, index) => (
        <span
          className={`exposure-stage ${index < active ? 'is-done' : ''} ${index === active ? 'is-active' : ''} ${index === error ? 'is-error' : ''}`}
          key={stage}
          title={stage}
        >
          {!compact ? <small>{stage}</small> : null}
        </span>
      ))}
    </div>
  )
}

export function Toggle({ checked, label, detail, onChange }: { readonly checked: boolean; readonly label: string; readonly detail?: string; readonly onChange: () => void }) {
  return (
    <button aria-checked={checked} className="toggle-row" onClick={onChange} role="switch" type="button">
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className={`switch-track ${checked ? 'is-on' : ''}`}><span /></span>
    </button>
  )
}

export function ArtPreview({ tone, label }: { readonly tone: string; readonly label?: string }) {
  return (
    <div aria-label={label ?? '图片预览'} className={`art-preview tone-${tone}`} role="img">
      <span className="art-horizon" />
      <span className="art-structure art-structure-a" />
      <span className="art-structure art-structure-b" />
      <span className="art-glow" />
      <span className="art-grain" />
    </div>
  )
}

export function Kbd({ children }: { readonly children: ReactNode }) {
  return <kbd>{children}</kbd>
}
