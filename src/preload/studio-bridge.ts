import type { StudioBridge } from '../studio/shared/contracts.js'
import {
  studioOperationCatalog,
  studioOperationNames,
} from '../studio/shared/ipc-channels.ts'

export interface StudioBridgeTransport {
  invoke(channel: string, input?: unknown): Promise<unknown>
  subscribe(channel: string, listener: (value: unknown) => void): () => void
}

export const createStudioBridge = (transport: StudioBridgeTransport): StudioBridge => {
  const bridge: Record<string, unknown> = {}

  for (const operation of studioOperationNames) {
    const definition = studioOperationCatalog[operation]
    if (definition.kind === 'event') {
      bridge[operation] = (listener: (value: unknown) => void): (() => void) =>
        transport.subscribe(definition.channel, listener)
      continue
    }
    if (definition.kind === 'invoke-no-input') {
      bridge[operation] = (): Promise<unknown> => transport.invoke(definition.channel)
      continue
    }
    bridge[operation] = (input: unknown): Promise<unknown> =>
      transport.invoke(definition.channel, input)
  }

  return Object.freeze(bridge) as unknown as StudioBridge
}
