/**
 * Typed bridge for the window CustomEvents that cross the Studio shadow-DOM
 * boundary. Both sides (light-DOM shell and Studio shadow app) import these
 * helpers so the payload shape is one contract instead of two string protocols.
 */
export const STUDIO_ACTIVITY_EVENT = 'ai-terminal:studio-activity'
export const STUDIO_COMMAND_EVENT = 'ai-terminal:studio-command'

export type StudioRunActivityStatus = 'queued' | 'running' | 'success' | 'error' | 'billing-unknown'

export interface StudioRunActivityItem {
  readonly id: string
  readonly title: string
  readonly workflow: string
  readonly status: StudioRunActivityStatus
  readonly progress: number
  readonly message: string
  readonly createdAt: string
}

export interface StudioActivityDetail {
  readonly activeCount: number
  readonly totalCount: number
  readonly label: string
  readonly status: 'idle' | 'running' | 'queued' | 'failed' | 'completed'
  readonly items: readonly StudioRunActivityItem[]
}

export function isStudioActivityDetail(value: unknown): value is StudioActivityDetail {
  if (typeof value !== 'object' || value === null) return false
  const detail = value as Partial<StudioActivityDetail>
  return Number.isFinite(detail.activeCount)
    && Number.isFinite(detail.totalCount)
    && typeof detail.label === 'string'
    && typeof detail.status === 'string'
    && Array.isArray(detail.items)
}

export function dispatchStudioActivity(detail: StudioActivityDetail): void {
  window.dispatchEvent(new CustomEvent(STUDIO_ACTIVITY_EVENT, { detail }))
}

export function onStudioActivity(listener: (detail: StudioActivityDetail) => void): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (isStudioActivityDetail(detail)) listener(detail)
  }
  window.addEventListener(STUDIO_ACTIVITY_EVENT, handle)
  return () => window.removeEventListener(STUDIO_ACTIVITY_EVENT, handle)
}

export function dispatchStudioCommand(command: string): void {
  window.dispatchEvent(new CustomEvent(STUDIO_COMMAND_EVENT, { detail: { command } }))
}

export function onStudioCommand(listener: (command: string) => void): () => void {
  const handle = (event: Event): void => {
    const command = (event as CustomEvent<{ command?: string }>).detail?.command
    if (typeof command === 'string' && command) listener(command)
  }
  window.addEventListener(STUDIO_COMMAND_EVENT, handle)
  return () => window.removeEventListener(STUDIO_COMMAND_EVENT, handle)
}
