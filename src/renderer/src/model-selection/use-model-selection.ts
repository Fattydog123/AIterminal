import { useMemo, useState, useSyncExternalStore } from 'react'

import {
  createModelSelectionController,
  type ModelSelectionActions,
  type ModelSelectionAdapter,
  type ModelSelectionSnapshot,
} from './model-selection'

export interface UseModelSelectionOptions {
  readonly runtime: 'desktop' | 'preview' | 'disconnected'
}

export interface UseModelSelectionResult {
  readonly snapshot: ModelSelectionSnapshot
  readonly actions: ModelSelectionActions
  readonly getCurrentSnapshot: () => ModelSelectionSnapshot
}

function createWindowAdapter(): ModelSelectionAdapter {
  return {
    getOverview: () => window.onekey.relay.getOverview(),
    listTokens: () => window.onekey.relay.listTokens(),
    listModels: (input) => window.onekey.models.list(input),
  }
}

export function useModelSelection(options: UseModelSelectionOptions): UseModelSelectionResult {
  const [controller] = useState(() => createModelSelectionController({
    runtime: options.runtime,
    ...(options.runtime === 'desktop' ? { adapter: createWindowAdapter() } : {}),
  }))
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  return useMemo(() => ({
    snapshot,
    actions: controller.actions,
    getCurrentSnapshot: controller.getSnapshot,
  }), [controller.actions, controller.getSnapshot, snapshot])
}
