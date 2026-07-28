import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Icon } from './Icon.js'

export interface AccountRouteGroupOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

interface AccountRoutePickerProps {
  readonly groups: readonly AccountRouteGroupOption[]
  readonly selectedGroupId: string
  readonly groupPlaceholder: string
  readonly models: readonly string[]
  readonly selectedModel: string
  readonly modelPlaceholder: string
  readonly modelDisabled?: boolean
  readonly loading?: boolean
  readonly error?: string
  readonly onGroupChange: (groupId: string) => void
  readonly onModelChange: (model: string) => void
  readonly onRefresh: () => void
}

type OpenMenu = 'group' | 'model' | null

export function AccountRoutePicker({
  groups,
  selectedGroupId,
  groupPlaceholder,
  models,
  selectedModel,
  modelPlaceholder,
  modelDisabled = false,
  loading = false,
  error,
  onGroupChange,
  onModelChange,
  onRefresh,
}: AccountRoutePickerProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const groupTriggerRef = useRef<HTMLButtonElement>(null)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const routeId = useId().replace(/:/g, '')
  const groupListId = `${routeId}-groups`
  const modelListId = `${routeId}-models`
  const selectedGroup = groups.find((group) => group.id === selectedGroupId)
  const groupTriggerValue = selectedGroup?.label
    ?? (loading
      ? '读取分组'
      : groupPlaceholder)
  const routeModels = useMemo(() => [...new Set(models)], [models])
  const visibleModels = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return routeModels
    return routeModels.filter((model) => model.toLocaleLowerCase().includes(normalizedQuery))
  }, [query, routeModels])

  const closeMenu = (restoreFocus = false): void => {
    const previousMenu = openMenu
    setOpenMenu(null)
    setQuery('')
    if (!restoreFocus) return
    window.requestAnimationFrame(() => {
      if (previousMenu === 'group') groupTriggerRef.current?.focus()
      if (previousMenu === 'model') modelTriggerRef.current?.focus()
    })
  }

  const toggleMenu = (menu: Exclude<OpenMenu, null>): void => {
    if (menu === 'model' && modelDisabled) return
    setQuery('')
    setOpenMenu((current) => current === menu ? null : menu)
  }

  useEffect(() => {
    if (!openMenu) return undefined
    const handlePointerDown = (event: PointerEvent): void => {
      const path = event.composedPath()
      if (!rootRef.current || path.includes(rootRef.current)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [openMenu])

  useEffect(() => {
    if (openMenu === 'model') {
      window.requestAnimationFrame(() => modelSearchRef.current?.focus())
      return
    }
    if (openMenu !== 'group') return
    window.requestAnimationFrame(() => {
      const selected = rootRef.current?.querySelector<HTMLButtonElement>('[data-route-group-option="selected"]')
      const first = rootRef.current?.querySelector<HTMLButtonElement>('[data-route-group-option]')
      ;(selected ?? first)?.focus()
    })
  }, [openMenu])

  const moveOptionFocus = (event: KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    if (options.length === 0) return
    const root = event.currentTarget.getRootNode()
    const activeElement = root instanceof Document || root instanceof ShadowRoot
      ? root.activeElement
      : document.activeElement
    const currentIndex = options.indexOf(activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + options.length) % options.length
          : (currentIndex - 1 + options.length) % options.length
    event.preventDefault()
    options[nextIndex]?.focus()
  }

  const handleTriggerKeyDown = (menu: Exclude<OpenMenu, null>, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      toggleMenu(menu)
    }
    if (event.key === 'Escape' && openMenu) {
      event.preventDefault()
      closeMenu(true)
    }
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
      return
    }
    moveOptionFocus(event)
  }

  const handleRootBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    closeMenu()
  }

  const selectGroup = (groupId: string): void => {
    onGroupChange(groupId)
    closeMenu(true)
  }

  const selectModel = (model: string): void => {
    onModelChange(model)
    closeMenu(true)
  }

  return (
    <div
      aria-label="运行分组与模型"
      className="toolbar-account-route"
      onBlur={handleRootBlur}
      ref={rootRef}
      role="group"
    >
      <div className="studio-route-anchor studio-route-group-anchor">
        <button
          aria-controls={groupListId}
          aria-expanded={openMenu === 'group'}
          aria-haspopup="listbox"
          aria-label={`分组：${groupTriggerValue}`}
          className="studio-route-trigger"
          onClick={() => toggleMenu('group')}
          onKeyDown={(event) => handleTriggerKeyDown('group', event)}
          ref={groupTriggerRef}
          title={selectedGroup?.description ?? '选择分组'}
          type="button"
        >
          <span className="studio-route-trigger-copy"><small>分组</small><strong>{groupTriggerValue}</strong></span>
          <Icon name="chevron" size={12} />
        </button>
        {openMenu === 'group' ? (
          <div aria-busy={groups.length === 0 && loading} aria-label="分组" className="studio-route-popover studio-route-group-popover" id={groupListId} onKeyDown={handleMenuKeyDown} role={groups.length > 0 ? 'listbox' : 'dialog'}>
            <div className="studio-route-popover-heading"><span>分组</span><small>{groups.length} 个</small></div>
            <div className="studio-route-options">
              {groups.length === 0 ? (
                <div className="studio-route-empty-state studio-route-capability-state">
                  {loading ? <><strong>正在读取分组</strong><span role="status">请稍候。</span></> : <><strong>暂时没有分组</strong><span>{error || '请检查账户连接和令牌后刷新。'}</span><button onClick={onRefresh} type="button"><Icon name="pulse" size={13} />刷新</button></>}
                </div>
              ) : groups.map((group) => (
                <button
                  aria-selected={group.id === selectedGroupId}
                  className={group.id === selectedGroupId ? 'is-selected' : ''}
                  data-route-group-option={group.id === selectedGroupId ? 'selected' : 'option'}
                  key={group.id}
                  onClick={() => selectGroup(group.id)}
                  role="option"
                  title={group.description ?? group.label}
                  type="button"
                >
                  <Icon name="workflow" size={15} />
                  <span><strong>{group.label}</strong><small>{group.description || '可用'}</small></span>
                  {group.id === selectedGroupId ? <Icon name="check" size={15} /> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="studio-route-anchor studio-route-model-anchor">
          <button
            aria-controls={modelListId}
            aria-expanded={openMenu === 'model'}
            aria-haspopup="listbox"
            aria-label={`运行模型：${selectedModel || modelPlaceholder}`}
            className="studio-route-trigger studio-route-model-trigger"
            data-full-label={selectedModel || modelPlaceholder}
            disabled={modelDisabled}
            onClick={() => toggleMenu('model')}
            onKeyDown={(event) => handleTriggerKeyDown('model', event)}
            ref={modelTriggerRef}
            title={selectedModel || modelPlaceholder}
            type="button"
          >
            <span className="studio-route-trigger-copy"><small>模型</small><strong>{selectedModel || modelPlaceholder}</strong></span>
            <Icon name="chevron" size={12} />
          </button>
          {openMenu === 'model' ? (
            <div aria-label="运行模型" className="studio-route-popover studio-route-model-popover" id={modelListId} onKeyDown={handleMenuKeyDown} role="dialog">
              <label className="studio-route-search"><Icon name="search" size={14} /><input aria-label="搜索模型" autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" ref={modelSearchRef} value={query} /></label>
              <div className="studio-route-popover-heading"><span>模型</span><small>{selectedGroup?.label ?? '选择分组'} · {routeModels.length} 个</small></div>
              <div aria-label="可用模型列表" className="studio-route-options" role="listbox">
                {visibleModels.map((model) => <button aria-selected={model === selectedModel} className={model === selectedModel ? 'is-selected' : ''} key={model} onClick={() => selectModel(model)} role="option" title={model} type="button"><span><strong>{model}</strong><small>可用</small></span>{model === selectedModel ? <Icon name="check" size={15} /> : null}</button>)}
              </div>
              {visibleModels.length === 0 ? <p className="studio-route-empty">没有匹配的模型</p> : null}
            </div>
          ) : null}
        </div>
      <button aria-label="刷新分组" className="studio-route-refresh" disabled={loading} onClick={onRefresh} title="刷新" type="button"><Icon name="pulse" size={13} /></button>
    </div>
  )
}
