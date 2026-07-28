import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TaskHistoryActionsProps {
  title: string
  archived: boolean
  disabled: boolean
  /** Provider-history entries cannot be renamed at the source. */
  renameDisabled?: boolean
  /** Overrides the delete item label (e.g. 从列表移除 for read-only provider history). */
  deleteLabel?: string
  onArchiveChange: (archived: boolean) => void
  onDelete: () => void
  onRename: (newTitle: string) => void
}

interface MenuPosition {
  left: number
  top: number
}

const MENU_WIDTH = 176
const MENU_HEIGHT = 120
const VIEWPORT_PADDING = 8
const MENU_GAP = 6

export default function TaskHistoryActions({
  title,
  archived,
  disabled,
  renameDisabled = false,
  deleteLabel,
  onArchiveChange,
  onDelete,
  onRename,
}: TaskHistoryActionsProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(title)

  useEffect(() => {
    if (disabled) setPosition(null)
  }, [disabled])

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renaming])

  useEffect(() => {
    if (!position) return

    const closeFromOutside = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setPosition(null)
      setRenaming(false)
    }
    const closeFromKeyboard = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPosition(null)
      setRenaming(false)
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
    const closeAfterViewportChange = (): void => { setPosition(null); setRenaming(false) }

    document.addEventListener('pointerdown', closeFromOutside, true)
    document.addEventListener('keydown', closeFromKeyboard)
    window.addEventListener('resize', closeAfterViewportChange)
    window.addEventListener('scroll', closeAfterViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true)
      document.removeEventListener('keydown', closeFromKeyboard)
      window.removeEventListener('resize', closeAfterViewportChange)
      window.removeEventListener('scroll', closeAfterViewportChange, true)
    }
  }, [position])

  const toggleMenu = (): void => {
    if (disabled) return
    if (position) {
      setPosition(null)
      setRenaming(false)
      return
    }
    const bounds = triggerRef.current?.getBoundingClientRect()
    if (!bounds) return
    const left = Math.min(
      window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, bounds.right - MENU_WIDTH),
    )
    const fitsBelow = bounds.bottom + MENU_GAP + MENU_HEIGHT <= window.innerHeight - VIEWPORT_PADDING
    const top = fitsBelow
      ? bounds.bottom + MENU_GAP
      : Math.max(VIEWPORT_PADDING, bounds.top - MENU_GAP - MENU_HEIGHT)
    setPosition({ left, top })
    setRenameValue(title)
  }

  const runAction = (action: () => void): void => {
    setPosition(null)
    setRenaming(false)
    action()
  }

  const submitRename = (): void => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== title) onRename(trimmed)
    setPosition(null)
    setRenaming(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="task-row-actions-trigger"
        aria-label={`管理会话：${title}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        aria-controls={position ? menuId : undefined}
        title="更多操作"
        disabled={disabled}
        onClick={toggleMenu}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {position && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="task-history-menu"
          role="menu"
          aria-label={`会话操作：${title}`}
          style={position}
        >
          {renaming ? (
            <div className="task-history-rename-row">
              <input
                ref={renameInputRef}
                type="text"
                className="task-history-rename-input"
                value={renameValue}
                maxLength={200}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename()
                  if (e.key === 'Escape') { setRenaming(false); e.stopPropagation() }
                }}
                onBlur={(e) => {
                  if (menuRef.current?.contains(e.relatedTarget as Node)) return
                  submitRename()
                }}
              />
            </div>
          ) : renameDisabled ? null : (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setRenaming(true); setRenameValue(title) }}
            >
              <Pencil size={14} />
              <span>重命名</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onArchiveChange(!archived))}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            <span>{archived ? '移出归档' : '归档会话'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => runAction(onDelete)}
          >
            <Trash2 size={14} />
            <span>{deleteLabel ?? '删除会话'}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
