import { Check, Command, History, Search, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { buildCommandRows, pushRecentCommand, type CommandSearchEntry } from './command-search'

export interface GlobalCommandItem extends CommandSearchEntry {
  readonly shortcut?: string
  readonly icon: LucideIcon
  run(): void | Promise<void>
}

const RECENTS_KEY = 'ai-terminal:command-recents:v1'

function readRecents(): readonly string[] {
  try {
    const value = window.localStorage.getItem(RECENTS_KEY)
    if (!value) return []
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function rememberRecent(id: string): void {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(pushRecentCommand(readRecents(), id)))
  } catch {
    // Recents are a convenience; never let storage break command execution.
  }
}

export default function GlobalCommandCenter({
  open,
  items,
  onClose,
}: {
  readonly open: boolean
  readonly items: readonly GlobalCommandItem[]
  readonly onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recents, setRecents] = useState<readonly string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const { rows, flat } = useMemo(() => buildCommandRows(items, query, recents), [items, query, recents])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setRecents(readRecents())
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, flat.length - 1)))
  }, [flat.length])

  useEffect(() => {
    listRef.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, rows])

  if (!open) return null

  const run = (item: GlobalCommandItem | undefined): void => {
    if (!item || item.disabled) return
    rememberRecent(item.id)
    onClose()
    void item.run()
  }

  return createPortal(
    <div className="global-command-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="global-command-center" role="dialog" aria-modal="true" aria-label="命令与搜索">
        <header>
          <Command size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); onClose() }
              else if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(flat.length - 1, index + 1)) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)) }
              else if (event.key === 'PageDown') { event.preventDefault(); setActiveIndex((index) => Math.min(flat.length - 1, index + 8)) }
              else if (event.key === 'PageUp') { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 8)) }
              else if (event.key === 'Enter') { event.preventDefault(); run(flat[activeIndex]) }
            }}
            placeholder="搜索会话、模型、技能、设置和命令"
            aria-label="搜索命令"
          />
          <kbd>Ctrl K</kbd>
          <button type="button" aria-label="关闭命令中心" onClick={onClose}><X size={15} /></button>
        </header>
        <div className="global-command-results" role="listbox" aria-label="可用命令" ref={listRef}>
          {rows.map((row) => {
            if (row.kind === 'section') {
              return <div className="global-command-section" role="presentation" key={`section:${row.title}`}>
                {row.title === '最近使用' && <History size={11} aria-hidden="true" />}{row.title}
              </div>
            }
            const { item, flatIndex } = row
            const Icon = item.icon
            return (
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === flatIndex}
                disabled={item.disabled}
                className={activeIndex === flatIndex ? 'is-active' : ''}
                key={`${item.id}:${flatIndex}`}
                onMouseEnter={() => setActiveIndex(flatIndex)}
                onClick={() => run(item)}
              >
                <span className="global-command-icon"><Icon size={16} /></span>
                <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                <em>{item.section}</em>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : activeIndex === flatIndex ? <Check size={14} /> : null}
              </button>
            )
          })}
          {flat.length === 0 && <div className="global-command-empty"><Search size={18} /><strong>没有匹配结果</strong><span>换一个任务名、模型名或命令试试。</span></div>}
        </div>
        <footer><span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span></footer>
      </section>
    </div>,
    document.body,
  )
}
