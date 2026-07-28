import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { WorkspaceMode } from '../../../shared/contracts.ts'
import {
  createComposerCapabilitiesController,
  type ComposerCapabilitiesActions,
  type ComposerCapabilitiesEnvironment,
  type ComposerCapabilitiesSnapshot,
  type ComposerLaunchPreparation,
  type ComposerTurnSubmission,
} from './composer-capabilities.ts'
import {
  createComposerCapabilitiesAdapter,
  type ComposerCapabilitiesAdapter,
  type ComposerRuntime,
} from './composer-capabilities-adapter.ts'

export interface UseComposerCapabilitiesOptions {
  readonly runtime: ComposerRuntime
  readonly workspaceToken: string
  readonly attachmentsAllowed: boolean
  readonly contextSummary: string
  readonly userPreamble?: string
  readonly prepareLaunch?: (requestedMode?: WorkspaceMode) => Promise<ComposerLaunchPreparation>
  readonly launchTurn: (submission: ComposerTurnSubmission) => Promise<boolean>
  readonly compactConversation?: () => Promise<{ readonly message: string }>
  readonly adapter?: ComposerCapabilitiesAdapter
  readonly environment?: ComposerCapabilitiesEnvironment
}

export interface UseComposerCapabilitiesResult {
  readonly snapshot: ComposerCapabilitiesSnapshot
  readonly actions: ComposerCapabilitiesActions
  readonly getCurrentSnapshot: () => ComposerCapabilitiesSnapshot
}

export function useComposerCapabilities(
  options: UseComposerCapabilitiesOptions,
): UseComposerCapabilitiesResult {
  const contextSummaryRef = useRef(options.contextSummary)
  const userPreambleRef = useRef(options.userPreamble ?? '')
  const prepareLaunchRef = useRef(options.prepareLaunch)
  const launchTurnRef = useRef(options.launchTurn)
  const compactConversationRef = useRef(options.compactConversation)
  const lifecycleGenerationRef = useRef(0)
  contextSummaryRef.current = options.contextSummary
  userPreambleRef.current = options.userPreamble ?? ''
  prepareLaunchRef.current = options.prepareLaunch
  launchTurnRef.current = options.launchTurn
  compactConversationRef.current = options.compactConversation

  const [controller] = useState(() => createComposerCapabilitiesController({
    runtime: options.runtime,
    adapter: options.adapter ?? createComposerCapabilitiesAdapter(options.runtime),
    ...(options.environment ? { environment: options.environment } : {}),
    initialWorkspaceToken: options.workspaceToken,
    attachmentsAllowed: options.attachmentsAllowed,
    getContextSummary: () => contextSummaryRef.current,
    getUserPreamble: () => userPreambleRef.current,
    prepareLaunch: (requestedMode) => prepareLaunchRef.current?.(requestedMode) ?? Promise.resolve({ ok: true }),
    launchTurn: (submission) => launchTurnRef.current(submission),
    compactConversation: () => compactConversationRef.current?.() ?? Promise.resolve({ message: '当前没有可压缩的上下文。' }),
  }))

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1
    lifecycleGenerationRef.current = generation
    void controller.actions.initialize()
    return () => {
      queueMicrotask(() => {
        if (lifecycleGenerationRef.current === generation) controller.dispose()
      })
    }
  }, [controller])

  useEffect(() => {
    void controller.actions.changeScope(options.workspaceToken)
  }, [controller.actions, options.workspaceToken])

  useEffect(() => {
    controller.actions.setAttachmentsAllowed(options.attachmentsAllowed)
  }, [controller.actions, options.attachmentsAllowed])

  return useMemo(() => ({
    snapshot,
    actions: controller.actions,
    getCurrentSnapshot: controller.getSnapshot,
  }), [controller.actions, controller.getSnapshot, snapshot])
}
