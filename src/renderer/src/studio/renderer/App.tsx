import { lazy, Suspense, useEffect, useRef } from 'react'
import { dispatchStudioActivity, onStudioCommand } from '../../ui/activity-bridge.js'
import { Icon, type IconName } from './components/Icon.js'
import { StudioModals } from './components/StudioModals.js'
import { useStudioStore } from './store/studioStore.js'
import type { PageId } from './types.js'

const WorkflowPage = lazy(() => import('./workflow/WorkflowPage.js').then((module) => ({ default: module.WorkflowPage })))
const AssetsPage = lazy(() => import('./pages/AssetsPage.js').then((module) => ({ default: module.AssetsPage })))
const QueuePage = lazy(() => import('./pages/QueuePage.js').then((module) => ({ default: module.QueuePage })))
const RunsPage = lazy(() => import('./pages/RunsPage.js').then((module) => ({ default: module.RunsPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then((module) => ({ default: module.SettingsPage })))

const navigation: readonly { readonly id: PageId; readonly label: string; readonly icon: IconName; readonly shortcut?: string }[] = [
  { id: 'workflow', label: '工作流', icon: 'workflow', shortcut: '1' },
  { id: 'assets', label: '作品', icon: 'image', shortcut: '2' },
  { id: 'queue', label: '任务', icon: 'queue', shortcut: '3' },
  { id: 'runs', label: '记录', icon: 'pulse', shortcut: '4' },
]

interface StudioAccountProps {
  readonly accountName: string
  readonly connectionLabel: string
  readonly modelConnected: boolean
  readonly onOpenUserCenter: () => void
  readonly onOpenGlobalCommand: () => void
}

function ActivityRail({
  accountName,
  connectionLabel,
  modelConnected,
  onOpenUserCenter,
  onOpenGlobalCommand,
}: StudioAccountProps) {
  const page = useStudioStore((state) => state.page)
  const queue = useStudioStore((state) => state.queue)
  const navigate = useStudioStore((state) => state.navigate)
  const activeTasks = queue.filter((item) => item.status === 'running' || item.status === 'queued').length
  const accountInitial = accountName.trim().slice(0, 1).toLocaleUpperCase() || 'U'
  return (
    <nav aria-label="主导航" className="activity-rail">
      <div className="activity-main">
        {navigation.map((item) => (
          <button aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'is-active' : ''} key={item.id} onClick={() => navigate(item.id)} title={`${item.label}${item.shortcut ? ` · Ctrl ${item.shortcut}` : ''}`} type="button">
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
            {item.id === 'queue' && activeTasks > 0 ? <em>{activeTasks}</em> : null}
          </button>
        ))}
      </div>
      <div className="activity-bottom">
        <button onClick={onOpenGlobalCommand} title="命令与搜索 · Ctrl K" type="button"><Icon name="command" size={18} /><span>命令</span></button>
        <button aria-current={page === 'settings' ? 'page' : undefined} className={page === 'settings' ? 'is-active' : ''} onClick={() => navigate('settings')} title="设置" type="button"><Icon name="settings" size={18} /><span>设置</span></button>
        <button className="studio-account-row" onClick={onOpenUserCenter} title={accountName} type="button">
          <span className="rail-avatar" aria-hidden="true">{accountInitial}</span>
          <span className="studio-account-copy">
            <strong>{accountName}</strong>
            <small><i className={modelConnected ? '' : 'is-offline'} />{connectionLabel}</small>
          </span>
          <Icon name="more" size={15} />
        </button>
      </div>
    </nav>
  )
}

function CurrentPage() {
  const page = useStudioStore((state) => state.page)
  if (page === 'workflow') return <WorkflowPage />
  if (page === 'assets') return <AssetsPage />
  if (page === 'queue') return <QueuePage />
  if (page === 'runs') return <RunsPage />
  return <SettingsPage />
}

function WorkspaceLoading() {
  return <div aria-live="polite" className="workspace-loading"><span className="exposure-loader"><i /><i /><i /><i /></span><strong>正在准备工作台</strong><small>载入当前工具与画布</small></div>
}

function ToastRegion() {
  const toast = useStudioStore((state) => state.toast)
  const dismiss = useStudioStore((state) => state.dismissToast)
  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(dismiss, 4200)
    return () => window.clearTimeout(timeout)
  }, [dismiss, toast])
  return <div aria-live="polite" aria-atomic="true" className="toast-region">{toast ? <div className="studio-toast"><span><Icon name="info" size={16} /></span><p>{toast}</p><button aria-label="关闭通知" onClick={dismiss} type="button"><Icon name="close" size={14} /></button></div> : null}</div>
}

export default function App(props: StudioAccountProps) {
  const bootstrap = useStudioStore((state) => state.bootstrap)
  const connectionState = useStudioStore((state) => state.connectionState)
  const refreshProviders = useStudioStore((state) => state.refreshProviders)
  const closeModal = useStudioStore((state) => state.closeModal)
  const navigate = useStudioStore((state) => state.navigate)
  const run = useStudioStore((state) => state.runWorkflow)
  const save = useStudioStore((state) => state.saveWorkflow)
  const remove = useStudioStore((state) => state.removeSelectedNodes)
  const duplicate = useStudioStore((state) => state.duplicateSelectedNodes)
  const copyNodes = useStudioStore((state) => state.copySelectedNodes)
  const pasteNodes = useStudioStore((state) => state.pasteCopiedNodes)
  const undo = useStudioStore((state) => state.undoEditor)
  const redo = useStudioStore((state) => state.redoEditor)
  const autoLayout = useStudioStore((state) => state.autoLayoutWorkflow)
  const queue = useStudioStore((state) => state.queue)
  const modal = useStudioStore((state) => state.modal)
  const page = useStudioStore((state) => state.page)
  const navigationSequenceExpiresAt = useRef(0)
  const accountProviderRefresh = useRef({
    accountName: props.accountName,
    modelConnected: props.modelConnected,
    pending: false,
  })
  const appRef = useRef<HTMLDivElement>(null)

  useEffect(() => { void bootstrap() }, [bootstrap])
  useEffect(() => {
    const refresh = accountProviderRefresh.current
    if (!props.modelConnected) {
      refresh.modelConnected = false
      refresh.accountName = props.accountName
      refresh.pending = false
      return
    }
    if (!refresh.modelConnected || refresh.accountName !== props.accountName) refresh.pending = true
    refresh.modelConnected = true
    refresh.accountName = props.accountName
    if (!refresh.pending || connectionState !== 'ready') return
    refresh.pending = false
    void refreshProviders()
  }, [connectionState, props.accountName, props.modelConnected, refreshProviders])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.composedPath().find((entry): entry is HTMLElement => entry instanceof HTMLElement)
      const editing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))
      if (event.key === 'Escape') { closeModal(); return }
      const commandToggle = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
      const modalOpen = modal !== 'none' || Boolean(appRef.current?.querySelector('[role="dialog"][aria-modal="true"]'))
      if (modalOpen) {
        if (commandToggle) { event.preventDefault(); props.onOpenGlobalCommand() }
        return
      }
      if (commandToggle) { event.preventDefault(); props.onOpenGlobalCommand(); return }
      if (!editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const key = event.key.toLowerCase()
        const now = Date.now()
        if (key === 'f' && page === 'workflow') {
          const focusNodeSearch = (): boolean => {
            const nodeSearch = appRef.current?.querySelector<HTMLInputElement>('input[aria-label="搜索节点"]')
            if (!nodeSearch) return false
            nodeSearch.focus()
            nodeSearch.select()
            return true
          }
          if (focusNodeSearch()) {
            event.preventDefault()
            navigationSequenceExpiresAt.current = 0
            return
          }
          const libraryToggle = appRef.current?.querySelector<HTMLButtonElement>('button[aria-label="打开节点库"]')
          if (libraryToggle) {
            event.preventDefault()
            navigationSequenceExpiresAt.current = 0
            libraryToggle.click()
            window.requestAnimationFrame(() => window.requestAnimationFrame(focusNodeSearch))
            return
          }
        }
        if (key === 'g') {
          event.preventDefault()
          navigationSequenceExpiresAt.current = now + 900
          return
        }
        if (key === 'a' && navigationSequenceExpiresAt.current >= now) {
          event.preventDefault()
          navigationSequenceExpiresAt.current = 0
          navigate('assets')
          return
        }
        navigationSequenceExpiresAt.current = 0
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void run(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !editing) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y' && !editing) { event.preventDefault(); redo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && !editing) { event.preventDefault(); duplicate(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !editing && page === 'workflow' && !window.getSelection()?.toString()) { event.preventDefault(); copyNodes(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && !editing && page === 'workflow') { event.preventDefault(); void pasteNodes(); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !editing) { event.preventDefault(); remove(); return }
      if ((event.ctrlKey || event.metaKey) && /^[1-4]$/.test(event.key)) { event.preventDefault(); const item = navigation[Number(event.key) - 1]; if (item) navigate(item.id) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeModal, copyNodes, duplicate, modal, navigate, page, pasteNodes, props, redo, remove, run, save, undo])

  useEffect(() => onStudioCommand((command) => {
    if (command.startsWith('navigate:')) {
      const pageId = command.slice('navigate:'.length)
      if (['workflow', 'assets', 'queue', 'runs', 'settings'].includes(pageId)) navigate(pageId as PageId)
    } else if (command === 'run') void run()
    else if (command === 'auto-layout') autoLayout('all')
  }), [autoLayout, navigate, run])

  useEffect(() => {
    const active = queue.filter((item) => item.status === 'running' || item.status === 'queued')
    const current = active.find((item) => item.status === 'running') ?? active[0] ?? queue[0]
    dispatchStudioActivity({
      activeCount: active.length,
      totalCount: queue.length,
      label: current?.title ?? '当前没有运行任务',
      status: current?.status === 'running' ? 'running' : current?.status === 'queued' ? 'queued' : current?.status === 'error' ? 'failed' : current ? 'completed' : 'idle',
      items: queue.slice(0, 16).map((item) => ({
        id: item.id,
        title: item.title,
        workflow: item.workflow,
        status: item.status,
        progress: item.progress,
        message: item.message,
        createdAt: item.createdAt,
      })),
    })
  }, [queue])

  return (
    <div className="studio-app" ref={appRef}>
      <div className="studio-shell"><ActivityRail {...props} /><div className="page-viewport"><Suspense fallback={<WorkspaceLoading />}><CurrentPage /></Suspense></div></div>
      <StudioModals />
      <ToastRegion />
    </div>
  )
}
