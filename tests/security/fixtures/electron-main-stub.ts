type InvokeHandler = (event: unknown, input?: unknown) => unknown

const state = globalThis as typeof globalThis & {
  __studioIpcTestHandlers?: Map<string, InvokeHandler>
}

export const studioIpcTestHandlers = state.__studioIpcTestHandlers ??= new Map<string, InvokeHandler>()

export const app = {
  getAppPath: (): string => process.cwd(),
  getVersion: (): string => 'test',
}

export class BrowserWindow {}

export const clipboard = { writeText: (): void => undefined }
export const dialog = {}
export const net = {}
export const protocol = {}
export const safeStorage = {}
export const session = {}

export const ipcMain = {
  handle(channel: string, handler: InvokeHandler): void {
    studioIpcTestHandlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    studioIpcTestHandlers.delete(channel)
  },
}
