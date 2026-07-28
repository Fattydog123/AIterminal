import { useSyncExternalStore } from 'react'

export interface ToastItem {
  readonly id: string
  readonly kind: 'info' | 'success' | 'warning' | 'danger'
  readonly title: string
  readonly detail?: string
  readonly actionLabel?: string
  readonly onAction?: () => void
}

const TOAST_LIMIT = 4

let toasts: readonly ToastItem[] = []
const listeners = new Set<() => void>()
let counter = 0

function emit(next: readonly ToastItem[]): void {
  toasts = next
  for (const listener of listeners) listener()
}

export function pushToast(input: Omit<ToastItem, 'id'> & { readonly key?: string }): string {
  const id = input.key ?? `toast-${counter += 1}`
  const { key: _key, ...item } = input
  // Re-pushing the same key replaces in place instead of stacking duplicates.
  const rest = toasts.filter((toast) => toast.id !== id)
  emit([...rest, { ...item, id }].slice(-TOAST_LIMIT))
  return id
}

export function dismissToast(id: string): void {
  if (!toasts.some((toast) => toast.id === id)) return
  emit(toasts.filter((toast) => toast.id !== id))
}

export function clearToasts(): void {
  if (toasts.length > 0) emit([])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, () => toasts, () => [])
}
