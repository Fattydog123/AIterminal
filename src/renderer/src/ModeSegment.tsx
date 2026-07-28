import { Bot, MessageSquare, Workflow } from 'lucide-react'
import { useEffect, useRef } from 'react'

export type AppMode = 'chat' | 'agent' | 'studio'

let pendingFocusMode: AppMode | undefined

export default function ModeSegment({
  active,
  disabled = false,
  className = '',
  onSelect,
}: {
  active: AppMode
  disabled?: boolean
  className?: string
  onSelect: (mode: AppMode) => void
}) {
  const segmentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pendingFocusMode !== active) return
    const button = segmentRef.current?.querySelector<HTMLButtonElement>(`button[data-mode="${active}"]`)
    if (!button || button.disabled) return
    pendingFocusMode = undefined
    button.focus()
  }, [active])

  const selectMode = (mode: AppMode) => {
    if (mode !== active) pendingFocusMode = mode
    onSelect(mode)
  }

  return (
    <div className={`mode-segment ${className}`.trim()} aria-label="工作模式" ref={segmentRef} role="group">
      <button aria-pressed={active === 'chat'} className={active === 'chat' ? 'active' : ''} data-mode="chat" disabled={disabled} onClick={() => selectMode('chat')} title="Chat" type="button"><MessageSquare size={13} />Chat</button>
      <button aria-pressed={active === 'agent'} className={active === 'agent' ? 'active' : ''} data-mode="agent" disabled={disabled} onClick={() => selectMode('agent')} title="Agent" type="button"><Bot size={13} />Agent</button>
      <button aria-pressed={active === 'studio'} className={active === 'studio' ? 'active' : ''} data-mode="studio" disabled={disabled} onClick={() => selectMode('studio')} title="Studio" type="button"><Workflow size={13} />Studio</button>
    </div>
  )
}
