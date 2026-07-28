import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'

import { Icon } from './Icon.js'

export interface StudioSelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
  readonly group?: string
}

interface StudioSelectProps {
  readonly ariaLabel: string
  readonly className?: string
  readonly describedBy?: string
  readonly disabled?: boolean
  readonly id?: string
  readonly invalid?: boolean
  readonly onChange: (value: string) => void
  readonly options: readonly StudioSelectOption[]
  readonly placeholder: string
  readonly required?: boolean
  readonly title?: string
  readonly value: string
}

export function StudioSelect({
  ariaLabel,
  className,
  describedBy,
  disabled = false,
  id,
  invalid = false,
  onChange,
  options,
  placeholder,
  required = false,
  title,
  value,
}: StudioSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const listboxId = `${useId().replace(/:/g, '')}-listbox`
  const selected = options.find((option) => option.value === value)

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const focusOption = (edge: 'first' | 'last' | 'selected' = 'selected'): void => {
    window.requestAnimationFrame(() => {
      const available = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])]
      const selectedOption = available.find((option) => option.dataset.value === value)
      const target = edge === 'first'
        ? available[0]
        : edge === 'last'
          ? available.at(-1)
          : selectedOption ?? available[0]
      target?.focus()
    })
  }

  const openListbox = (edge: 'first' | 'last' | 'selected' = 'selected'): void => {
    if (disabled || options.every((option) => option.disabled)) return
    setOpen(true)
    focusOption(edge)
  }

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  useEffect(() => {
    if (!open) return undefined
    const closeOnPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (!root || event.composedPath().includes(root)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown, true)
    return () => document.removeEventListener('pointerdown', closeOnPointerDown, true)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return undefined
    const trigger = triggerRef.current
    const listbox = listboxRef.current
    if (!trigger || !listbox) return undefined

    const place = (): void => {
      const rect = trigger.getBoundingClientRect()
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const gap = 5
      const edge = 8
      const width = Math.min(Math.max(rect.width, 180), Math.max(0, viewportWidth - edge * 2))
      const maxHeight = Math.min(240, Math.max(96, viewportHeight * 0.34))
      listbox.style.width = `${width}px`
      listbox.style.maxHeight = `${maxHeight}px`
      const desiredHeight = Math.min(listbox.scrollHeight, maxHeight)
      const spaceBelow = viewportHeight - rect.bottom - edge
      const spaceAbove = rect.top - edge
      const opensAbove = spaceBelow < desiredHeight + gap && spaceAbove > spaceBelow
      const top = opensAbove
        ? Math.max(edge, rect.top - gap - desiredHeight)
        : Math.min(viewportHeight - edge - desiredHeight, rect.bottom + gap)
      const left = Math.min(Math.max(edge, rect.left), Math.max(edge, viewportWidth - edge - width))
      listbox.style.top = `${Math.max(edge, top)}px`
      listbox.style.left = `${left}px`
    }

    if (typeof listbox.showPopover === 'function' && !listbox.matches(':popover-open')) {
      listbox.showPopover()
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      if (typeof listbox.hidePopover === 'function' && listbox.matches(':popover-open')) {
        listbox.hidePopover()
      }
    }
  }, [open, options])

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setOpen(false)
  }

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      openListbox(event.key === 'ArrowUp' ? 'last' : 'selected')
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  }

  const handleListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.stopPropagation()
    const available = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    if (available.length === 0) return
    const root = event.currentTarget.getRootNode()
    const activeElement = root instanceof Document || root instanceof ShadowRoot
      ? root.activeElement
      : document.activeElement
    const currentIndex = available.indexOf(activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? available.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + available.length) % available.length
          : (currentIndex - 1 + available.length) % available.length
    event.preventDefault()
    available[nextIndex]?.focus()
  }

  return (
    <div className={`studio-select${className ? ` ${className}` : ''}${open ? ' is-open' : ''}`} onBlur={handleBlur} ref={rootRef}>
      <button
        aria-controls={listboxId}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        aria-required={required || undefined}
        className="studio-select-trigger"
        disabled={disabled}
        id={id}
        onClick={() => open ? close() : openListbox()}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        title={title ?? selected?.label ?? placeholder}
        type="button"
      >
        <span>{selected?.label ?? placeholder}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div aria-label={ariaLabel} className="studio-select-listbox" id={listboxId} onKeyDown={handleListboxKeyDown} popover="manual" ref={listboxRef} role="listbox">
          {options.map((option, index) => {
            const previousGroup = options[index - 1]?.group
            const showGroup = Boolean(option.group && option.group !== previousGroup)
            return (
              <div className="studio-select-option-block" key={`${option.group ?? ''}\u0000${option.value}`}>
                {showGroup ? <div className="studio-select-group-label" role="presentation">{option.group}</div> : null}
                <button
                  aria-selected={option.value === value}
                  className={option.value === value ? 'is-selected' : ''}
                  data-value={option.value}
                  disabled={option.disabled}
                  onClick={() => {
                    onChange(option.value)
                    close(true)
                  }}
                  role="option"
                  title={option.label}
                  type="button"
                >
                  <span>{option.label}</span>
                  {option.value === value ? <Icon name="check" size={13} /> : null}
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
