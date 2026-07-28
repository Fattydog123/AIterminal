import { ipcRenderer, type IpcRendererEvent } from 'electron'

import { createStudioBridge } from './studio-bridge'

const studioBridge = createStudioBridge({
  invoke: (channel, input) =>
    input === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, input),
  subscribe: (channel, listener) => {
    const wrapped = (_event: IpcRendererEvent, value: unknown): void => listener(value)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})

export const studioApi = studioBridge
