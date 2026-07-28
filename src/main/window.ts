import { join } from 'node:path'

import { BrowserWindow, app, nativeTheme } from 'electron'

import { registerIpcHandlers } from './ipc/register-ipc'
import { lockDownSession } from './security/content-security-policy'
import { validateDevelopmentRendererUrl } from './security/web-contents'
import {
  createMainBackendServices,
  type MainBackendServices
} from './services/backend-services'
import { createStudioRuntime, type StudioRuntime } from './studio/runtime'

const WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD = 22621

export interface MainWindowHandle {
  window: BrowserWindow
  shutdown(): Promise<void>
}

function supportsWindowsAcrylic(): boolean {
  if (process.platform !== 'win32' || nativeTheme.shouldUseHighContrastColors) return false
  const build = Number.parseInt(process.getSystemVersion().split('.')[2] ?? '', 10)
  return Number.isFinite(build) && build >= WINDOWS_BACKGROUND_MATERIAL_MIN_BUILD
}

export async function createMainWindow(requestQuit: () => void): Promise<MainWindowHandle> {
  const useNativeAcrylic = supportsWindowsAcrylic()
  const window = new BrowserWindow({
    title: 'AI终点站',
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    transparent: false,
    thickFrame: true,
    roundedCorners: true,
    ...(useNativeAcrylic
      ? { backgroundMaterial: 'acrylic' as const }
      : { backgroundColor: '#070A11' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged
    }
  })

  let backend: MainBackendServices | null = null
  let studioRuntime: StudioRuntime | null = null
  let shutdown: (() => Promise<void>) | null = null
  let startupStage = 'session-security'
  try {
    lockDownSession(window.webContents.session)
    window.once('ready-to-show', () => window.show())

    const requestedDevelopmentUrl = process.env.ELECTRON_RENDERER_URL
    const developmentUrl = requestedDevelopmentUrl
      ? validateDevelopmentRendererUrl(requestedDevelopmentUrl)
      : undefined
    if (!developmentUrl) {
      startupStage = 'splash'
      await window.loadFile(join(__dirname, '../renderer/splash.html'))
    }

    startupStage = 'backend'
    const smokeRelayServerOrigin = !app.isPackaged && process.env.ONEKEY_SMOKE_TEST === '1'
      ? process.env.ONEKEY_SMOKE_RELAY_ORIGIN
      : undefined
    backend = await createMainBackendServices(
      app.getPath('userData'),
      {
        documentsRoot: app.getPath('documents'),
        ...(smokeRelayServerOrigin === undefined ? {} : { relayServerOrigin: smokeRelayServerOrigin })
      }
    )
    startupStage = 'ipc'
    const ipcRegistration = registerIpcHandlers(window, backend, requestQuit)
    startupStage = 'studio'
    studioRuntime = await createStudioRuntime({
      window,
      userDataPath: app.getPath('userData'),
      managedProjectsRoot: join(app.getPath('documents'), 'Codex', 'Studio'),
      consents: backend.consents,
      relay: backend.relay,
      modelCatalog: backend.modelCatalog,
      responses: backend.responses,
      chatCompletions: backend.chatCompletions,
      anthropic: backend.anthropic,
      gemini: backend.gemini,
      isSessionUnlocked: ipcRegistration.isLocalSessionUnlocked,
      ...(developmentUrl === undefined
        ? {}
        : { allowedRendererOrigin: new URL(developmentUrl).origin })
    })
    shutdown = async () => {
      await Promise.allSettled([
        studioRuntime?.shutdown(),
        ipcRegistration.shutdown()
      ])
    }

    startupStage = 'renderer'
    if (developmentUrl) {
      await window.loadURL(developmentUrl)
    } else {
      await window.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return { window, shutdown }
  } catch {
    if (!app.isPackaged && process.env.ONEKEY_SMOKE_TEST === '1') {
      const diagnostics = globalThis as typeof globalThis & {
        __onekeySmokeStartupFailureStage?: string
      }
      diagnostics.__onekeySmokeStartupFailureStage = startupStage
      process.stderr.write(`Electron smoke startup failure stage: ${startupStage}.\n`)
    }
    if (shutdown) {
      await shutdown().catch(() => undefined)
    } else {
      if (studioRuntime) await studioRuntime.shutdown().catch(() => undefined)
      if (backend) await backend.relay.shutdown().catch(() => undefined)
    }
    if (!window.isDestroyed()) window.destroy()
    throw new Error('Main window initialization failed.')
  }
}
