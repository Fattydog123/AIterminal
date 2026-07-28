import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { WorkspaceMode } from '../../../shared/contracts.ts'
import {
  createConversationSession,
  type ConversationSessionActions,
  type ConversationSessionAdapter,
  type ConversationSessionEnvironment,
  type ConversationSessionSnapshot,
} from './conversation-session.ts'
import {
  createConversationSessionAdapter,
  createConversationSessionEnvironment,
  type ConversationRuntime,
} from './conversation-session-adapter.ts'

export interface UseConversationSessionOptions {
  readonly runtime: ConversationRuntime
  readonly initialMode?: WorkspaceMode
  readonly onModeChange?: (mode: WorkspaceMode) => void
  readonly adapter?: ConversationSessionAdapter
  readonly environment?: ConversationSessionEnvironment
}

export interface UseConversationSessionResult {
  readonly snapshot: ConversationSessionSnapshot
  readonly actions: ConversationSessionActions
  readonly elapsedSeconds: number
}

export function useConversationSession(options: UseConversationSessionOptions): UseConversationSessionResult {
  const onModeChangeRef = useRef(options.onModeChange)
  onModeChangeRef.current = options.onModeChange
  const lifecycleGenerationRef = useRef(0)
  const [controller] = useState(() => createConversationSession({
    runtime: options.runtime,
    adapter: options.adapter ?? createConversationSessionAdapter(options.runtime),
    environment: options.environment ?? createConversationSessionEnvironment(),
    ...(options.initialMode ? { initialMode: options.initialMode } : {}),
    onModeChange: (mode) => onModeChangeRef.current?.(mode),
  }))
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1
    lifecycleGenerationRef.current = generation
    controller.connect()
    return () => {
      controller.disconnect()
      queueMicrotask(() => {
        if (lifecycleGenerationRef.current === generation) controller.dispose()
      })
    }
  }, [controller])

  useEffect(() => {
    if (!snapshot.running || !snapshot.activity) return
    setClock(Date.now())
    const timer = globalThis.setInterval(() => setClock(Date.now()), 1_000)
    return () => globalThis.clearInterval(timer)
  }, [snapshot.activity?.startedAt, snapshot.running])

  const elapsedSeconds = snapshot.running && snapshot.activity
    ? Math.max(0, Math.floor((clock - snapshot.activity.startedAt) / 1_000))
    : 0

  return useMemo(() => ({
    snapshot,
    actions: controller.actions,
    elapsedSeconds,
  }), [clock, controller.actions, elapsedSeconds, snapshot])
}
