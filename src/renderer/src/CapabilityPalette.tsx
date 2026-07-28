import {
  Brain,
  Check,
  Command,
  FileCog,
  FileText,
  ListChecks,
  PackageOpen,
  PlugZap,
  Search,
  ScanSearch,
  Sparkles,
  Target,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  ComposerCapabilitiesSnapshot,
  ComposerPaletteItem,
} from './composer/composer-capabilities'

export interface CapabilityPaletteProps {
  palette: ComposerCapabilitiesSnapshot['palette']
  listId: string
  onChoose: (key: string) => void
  onMove: (direction: 'next' | 'previous') => void
  onHighlight: (key: string) => void
  onDismiss: () => void
  onReopen: () => void
  onStateChange?: (state: { expanded: boolean; activeDescendant?: string }) => void
  disabled?: boolean
}

const triggerLabels = {
  '/': '命令',
  '$': '技能',
  '@': '插件与文件',
} as const

function itemIcon(item: ComposerPaletteItem) {
  if (item.kind === 'skill') return Sparkles
  if (item.kind === 'plugin') return PlugZap
  if (item.kind === 'file') return FileText
  switch (item.id) {
    case 'plan': return ListChecks
    case 'goal': return Target
    case 'compact': return ScanSearch
    case 'memories': return Brain
    case 'init': return FileCog
    case 'review': return Search
    default: return Command
  }
}

function itemOptionId(listId: string, item: ComposerPaletteItem): string {
  return `${listId}-option-${encodeURIComponent(item.key)}`
}

export default function CapabilityPalette({
  palette,
  listId,
  onChoose,
  onMove,
  onHighlight,
  onDismiss,
  onReopen,
  onStateChange,
  disabled = false,
}: CapabilityPaletteProps) {
  const [mobilePortal, setMobilePortal] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const listRef = useRef<HTMLDivElement>(null)
  const expanded = palette.expanded && !disabled
  const highlighted = palette.items.find((item) => item.key === palette.highlightedKey && !item.disabled)
  const activeDescendant = expanded && !palette.loading && highlighted
    ? itemOptionId(listId, highlighted)
    : undefined

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const update = (): void => setMobilePortal(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    onStateChange?.({ expanded, ...(activeDescendant ? { activeDescendant } : {}) })
  }, [activeDescendant, expanded, onStateChange])

  useEffect(() => () => {
    onStateChange?.({ expanded: false })
  }, [onStateChange])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [palette.highlightedKey, palette.items.length])

  useEffect(() => {
    if (!palette.trigger) return
    const dismissOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (listRef.current?.contains(target)) return
      if (target instanceof HTMLTextAreaElement && target.dataset.capabilityInput === 'true') return
      onDismiss()
    }
    const dismissOnFocusChange = (event: globalThis.FocusEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (target instanceof HTMLTextAreaElement && target.dataset.capabilityInput === 'true') {
        onReopen()
        return
      }
      if (listRef.current?.contains(target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('focusin', dismissOnFocusChange, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('focusin', dismissOnFocusChange, true)
    }
  }, [onDismiss, onReopen, palette.trigger])

  useEffect(() => {
    if (!palette.trigger || !expanded) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        !(document.activeElement instanceof HTMLTextAreaElement)
        || document.activeElement.dataset.capabilityInput !== 'true'
        || event.isComposing
        || event.keyCode === 229
      ) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onDismiss()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        onMove('next')
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        onMove('previous')
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (!palette.loading && highlighted) void onChoose(highlighted.key)
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [expanded, highlighted, onChoose, onDismiss, onMove, palette.loading, palette.trigger])

  if (!palette.trigger || !expanded) return null

  const inputTop = mobilePortal
    ? document.querySelector<HTMLElement>('[data-capability-input="true"]')?.getBoundingClientRect().top
    : undefined
  const mobileBottom = inputTop === undefined ? 76 : Math.max(12, window.innerHeight - inputTop + 10)

  const paletteView = (
    <div
      className="capability-palette"
      id={listId}
      role="listbox"
      aria-label={`${triggerLabels[palette.trigger]}选择`}
      aria-busy={palette.loading || undefined}
      style={mobilePortal ? { bottom: `${mobileBottom}px` } : undefined}
      ref={listRef}
    >
      <div className="capability-palette-header">
        <span className="capability-palette-trigger">{palette.trigger}</span>
        <span>{triggerLabels[palette.trigger]}</span>
        <small>{palette.items.length} 项</small>
      </div>
      <div className="capability-palette-list">
        {palette.loading ? (
          <div className="capability-palette-empty"><ScanSearch size={16} className="capability-palette-spin" />正在加载目录</div>
        ) : palette.items.length === 0 ? (
          <div className="capability-palette-empty"><PackageOpen size={16} />没有匹配的能力</div>
        ) : palette.items.map((item) => {
          const Icon = itemIcon(item)
          const selected = !item.disabled && item.key === palette.highlightedKey
          return (
            <button
              id={itemOptionId(listId, item)}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={item.disabled || undefined}
              tabIndex={-1}
              disabled={item.disabled}
              className={selected ? 'is-highlighted' : ''}
              key={item.key}
              onMouseEnter={() => { if (!item.disabled) onHighlight(item.key) }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { void onChoose(item.key) }}
            >
              <span className="capability-palette-icon"><Icon size={15} /></span>
              <span className="capability-palette-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              {selected && <Check size={14} className="capability-palette-check" />}
            </button>
          )
        })}
      </div>
      <div className="capability-palette-footer"><span>Enter 选择</span><span>Esc 关闭</span></div>
    </div>
  )

  return mobilePortal ? createPortal(paletteView, document.body) : paletteView
}
