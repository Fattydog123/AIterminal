export const uiPreviewHarnessEnabled =
  import.meta.env.DEV && import.meta.env.VITE_UI_PREVIEW_HARNESS === '1'

export const hasElectronBridge = (): boolean => 'onekey' in window
