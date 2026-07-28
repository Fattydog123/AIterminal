import { useCallback, useMemo, useSyncExternalStore } from 'react'

export interface WorkspaceLayoutSnapshot {
  readonly sidebarWidth: number
  readonly inspectorWidth: number
  readonly dockHeight: number
  readonly studioDockHeight: number
  readonly focusMode: boolean
}

export interface WorkspaceLayoutActions {
  readonly resizeSidebar: (width: number) => void
  readonly resizeInspector: (width: number) => void
  readonly resizeDock: (height: number) => void
  readonly resizeStudioDock: (height: number) => void
  readonly toggleFocusMode: () => void
  readonly reset: () => void
}

const STORAGE_KEY = 'ai-terminal:workspace-layout:v1'
const DEFAULT_LAYOUT: WorkspaceLayoutSnapshot = Object.freeze({
  sidebarWidth: 260,
  inspectorWidth: 326,
  dockHeight: 260,
  // Studio's run panel must first-paint inside the 100-140px band pinned by e2e.
  studioDockHeight: 122,
  focusMode: false,
})

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function normalizeWorkspaceLayout(value: Partial<WorkspaceLayoutSnapshot>): WorkspaceLayoutSnapshot {
  return {
    sidebarWidth: clamp(value.sidebarWidth ?? DEFAULT_LAYOUT.sidebarWidth, 216, 380),
    inspectorWidth: clamp(value.inspectorWidth ?? DEFAULT_LAYOUT.inspectorWidth, 280, 460),
    dockHeight: clamp(value.dockHeight ?? DEFAULT_LAYOUT.dockHeight, 168, 520),
    studioDockHeight: clamp(value.studioDockHeight ?? DEFAULT_LAYOUT.studioDockHeight, 96, 420),
    focusMode: value.focusMode === true,
  }
}

function readLayout(): WorkspaceLayoutSnapshot {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return DEFAULT_LAYOUT
    const parsed = JSON.parse(value) as Partial<WorkspaceLayoutSnapshot>
    return normalizeWorkspaceLayout(parsed)
  } catch {
    return DEFAULT_LAYOUT
  }
}

/*
 * Module-level store so the light-DOM shell and the Studio shadow tree share
 * one live layout snapshot instead of each reading localStorage separately.
 */
let layoutState: WorkspaceLayoutSnapshot = typeof window === 'undefined' ? DEFAULT_LAYOUT : readLayout()
const listeners = new Set<() => void>()

function setLayoutState(next: WorkspaceLayoutSnapshot): void {
  layoutState = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layoutState))
  } catch {
    // Layout persistence is best-effort and must never block the workspace.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function patchLayout(patch: Partial<WorkspaceLayoutSnapshot>): void {
  setLayoutState(normalizeWorkspaceLayout({ ...layoutState, ...patch }))
}

export function useWorkspaceLayout(): {
  readonly snapshot: WorkspaceLayoutSnapshot
  readonly actions: WorkspaceLayoutActions
} {
  const snapshot = useSyncExternalStore(subscribe, () => layoutState, () => DEFAULT_LAYOUT)

  const resizeSidebar = useCallback((sidebarWidth: number) => patchLayout({ sidebarWidth }), [])
  const resizeInspector = useCallback((inspectorWidth: number) => patchLayout({ inspectorWidth }), [])
  const resizeDock = useCallback((dockHeight: number) => patchLayout({ dockHeight }), [])
  const resizeStudioDock = useCallback((studioDockHeight: number) => patchLayout({ studioDockHeight }), [])
  const toggleFocusMode = useCallback(() => patchLayout({ focusMode: !layoutState.focusMode }), [])
  const reset = useCallback(() => setLayoutState(DEFAULT_LAYOUT), [])

  const actions = useMemo(
    () => ({ resizeSidebar, resizeInspector, resizeDock, resizeStudioDock, toggleFocusMode, reset }),
    [reset, resizeDock, resizeInspector, resizeSidebar, resizeStudioDock, toggleFocusMode],
  )
  return { snapshot, actions }
}

export function beginPointerResize(input: {
  readonly event: { readonly clientX: number; readonly clientY: number; preventDefault(): void }
  readonly axis: 'horizontal' | 'vertical'
  readonly startSize: number
  readonly direction?: 1 | -1
  readonly onResize: (nextSize: number) => void
}): void {
  input.event.preventDefault()
  const startPointer = input.axis === 'horizontal' ? input.event.clientX : input.event.clientY
  const direction = input.direction ?? 1
  const previousUserSelect = document.body.style.userSelect
  const previousCursor = document.body.style.cursor
  document.body.style.userSelect = 'none'
  document.body.style.cursor = input.axis === 'horizontal' ? 'col-resize' : 'row-resize'

  const move = (event: PointerEvent): void => {
    const currentPointer = input.axis === 'horizontal' ? event.clientX : event.clientY
    input.onResize(input.startSize + ((currentPointer - startPointer) * direction))
  }
  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.body.style.userSelect = previousUserSelect
    document.body.style.cursor = previousCursor
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish, { once: true })
  window.addEventListener('pointercancel', finish, { once: true })
}

export function resizeFromKeyboard(input: {
  readonly event: { readonly key: string; readonly shiftKey: boolean; preventDefault(): void }
  readonly axis: 'horizontal' | 'vertical'
  readonly currentSize: number
  readonly direction?: 1 | -1
  readonly onResize: (nextSize: number) => void
}): void {
  const positiveKey = input.axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  const negativeKey = input.axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  if (input.event.key !== positiveKey && input.event.key !== negativeKey) return
  input.event.preventDefault()
  const step = input.event.shiftKey ? 32 : 8
  const delta = input.event.key === positiveKey ? step : -step
  input.onResize(input.currentSize + (delta * (input.direction ?? 1)))
}
