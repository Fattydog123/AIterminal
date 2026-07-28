import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { dismissToast, useToasts, type ToastItem } from './toast-store'

const AUTO_DISMISS_MS = 6400

function ToastCard({ toast }: { readonly toast: ToastItem }) {
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    timerRef.current = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timerRef.current)
  }, [toast.id])

  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'warning' ? AlertTriangle : toast.kind === 'danger' ? OctagonAlert : Info
  return (
    <div
      className={`shell-toast kind-${toast.kind}`}
      role="status"
      onMouseEnter={() => window.clearTimeout(timerRef.current)}
      onMouseLeave={() => {
        window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS / 2)
      }}
    >
      <span className="shell-toast-icon"><Icon size={16} /></span>
      <div className="shell-toast-copy">
        <strong>{toast.title}</strong>
        {toast.detail && <small title={toast.detail}>{toast.detail}</small>}
      </div>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          className="shell-toast-action"
          onClick={() => {
            dismissToast(toast.id)
            toast.onAction?.()
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button type="button" className="shell-toast-close" aria-label="关闭通知" onClick={() => dismissToast(toast.id)}>
        <X size={13} />
      </button>
    </div>
  )
}

export default function ToastHost() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return createPortal(
    <div className="shell-toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
    </div>,
    document.body,
  )
}
