import type { BackgroundTaskDto } from '../../../shared/contracts'

import type { StudioRunActivityItem } from './activity-bridge'

export type ActivityNotificationKind = 'success' | 'warning' | 'danger' | 'info'

export interface ActivityNotification {
  readonly key: string
  readonly kind: ActivityNotificationKind
  readonly title: string
  readonly detail: string
  readonly target: 'background' | 'studio'
  readonly targetId: string
}

/**
 * Derive user-facing notifications from background-task status transitions.
 * Only transitions into a terminal or attention state notify; initial load
 * (previous empty map) stays silent so restoring history never spams toasts.
 */
export function diffBackgroundTransitions(
  previous: ReadonlyMap<string, BackgroundTaskDto['status']>,
  tasks: readonly BackgroundTaskDto[],
): readonly ActivityNotification[] {
  if (previous.size === 0) return []
  const notifications: ActivityNotification[] = []
  for (const task of tasks) {
    const before = previous.get(task.id)
    if (before === undefined || before === task.status) continue
    if (task.status === 'completed') {
      notifications.push({ key: `bg:${task.id}:completed`, kind: 'success', title: '后台任务完成', detail: task.title, target: 'background', targetId: task.id })
    } else if (task.status === 'failed') {
      notifications.push({ key: `bg:${task.id}:failed`, kind: 'danger', title: '后台任务失败', detail: task.title, target: 'background', targetId: task.id })
    } else if (task.status === 'waiting-approval') {
      notifications.push({ key: `bg:${task.id}:waiting`, kind: 'warning', title: '后台任务等待批准', detail: task.title, target: 'background', targetId: task.id })
    }
  }
  return notifications
}

/** Same idea for Studio run items crossing the activity bridge. */
export function diffStudioRunTransitions(
  previous: ReadonlyMap<string, StudioRunActivityItem['status']>,
  items: readonly StudioRunActivityItem[],
): readonly ActivityNotification[] {
  if (previous.size === 0) return []
  const notifications: ActivityNotification[] = []
  for (const item of items) {
    const before = previous.get(item.id)
    if (before === undefined || before === item.status) continue
    if (item.status === 'success') {
      notifications.push({ key: `studio:${item.id}:success`, kind: 'success', title: 'Studio 运行完成', detail: item.title, target: 'studio', targetId: item.id })
    } else if (item.status === 'error') {
      notifications.push({ key: `studio:${item.id}:error`, kind: 'danger', title: 'Studio 运行失败', detail: item.message || item.title, target: 'studio', targetId: item.id })
    }
  }
  return notifications
}

export function toStatusMap<T extends { readonly id: string }, S extends string>(
  entries: readonly T[],
  status: (entry: T) => S,
): ReadonlyMap<string, S> {
  return new Map(entries.map((entry) => [entry.id, status(entry)]))
}
