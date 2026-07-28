import type { IpcMainInvokeEvent } from 'electron'

import type { ApiResult } from '../../shared/contracts.ts'
import { IPC_CHANNELS } from '../../shared/ipc-channels.ts'

type QuitAction = () => ApiResult<null> | Promise<ApiResult<null>>
type ProtectedQuitAction = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<ApiResult<null>>

export interface ApplicationQuitIpcOptions {
  ipc: {
    handle(channel: string, handler: ProtectedQuitAction): void
  }
  requestQuit(): void
  protect(handler: QuitAction): ProtectedQuitAction
}

export function registerApplicationQuitIpcHandler(options: ApplicationQuitIpcOptions): void {
  options.ipc.handle(
    IPC_CHANNELS.appQuit,
    options.protect(() => {
      options.requestQuit()
      return { ok: true, value: null }
    })
  )
}
