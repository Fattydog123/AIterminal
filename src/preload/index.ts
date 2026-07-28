import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { AgentEvent, RendererApi } from '../shared/contracts'
import { isAgentEvent } from '../shared/agent-event-validator'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type { IpcChannel } from '../shared/ipc-channels'
import { studioApi } from './studio'

// Electron's invoke boundary is dynamically typed; the objects below are checked
// against RendererApi before they are exposed to the untrusted renderer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = (channel: IpcChannel, ...args: unknown[]): Promise<any> =>
  ipcRenderer.invoke(channel, ...args)

const appApi: RendererApi['app'] = {
  getBootstrap: () => invoke(IPC_CHANNELS.appGetBootstrap)
}

const windowApi: RendererApi['window'] = {
  minimize: () => invoke(IPC_CHANNELS.windowMinimize),
  toggleMaximize: () => invoke(IPC_CHANNELS.windowToggleMaximize),
  close: () => invoke(IPC_CHANNELS.windowClose),
  quit: () => invoke(IPC_CHANNELS.appQuit)
}

const dialogApi: RendererApi['dialog'] = {
  selectWorkspace: () => invoke(IPC_CHANNELS.dialogSelectWorkspace),
  selectAttachments: () => invoke(IPC_CHANNELS.dialogSelectAttachments),
  pasteImage: () => invoke(IPC_CHANNELS.dialogPasteImage),
  registerDroppedFiles: (files) => {
    const paths: string[] = []
    for (const file of Array.isArray(files) ? files : []) {
      // Only real on-disk files resolve to a path; in-app drags yield ''.
      try {
        const path = webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
        if (typeof path === 'string' && path.length > 0) paths.push(path)
      } catch {
        // Skip entries that are not droppable files.
      }
    }
    if (paths.length === 0) return Promise.resolve({ ok: true, value: [] })
    return invoke(IPC_CHANNELS.dialogRegisterDroppedFiles, { paths })
  }
}

const conversationApi: RendererApi['conversation'] = {
  list: () => invoke(IPC_CHANNELS.conversationList),
  create: (input) => invoke(IPC_CHANNELS.conversationCreate, input),
  load: (input) => invoke(IPC_CHANNELS.conversationLoad, input),
  import: (input) => invoke(IPC_CHANNELS.conversationImport, input),
  compact: (input) => invoke(IPC_CHANNELS.conversationCompact, input),
  rename: (input) => invoke(IPC_CHANNELS.conversationRename, input),
  fork: (input) => invoke(IPC_CHANNELS.conversationFork, input),
  search: (input) => invoke(IPC_CHANNELS.conversationSearch, input),
  setArchived: (input) => invoke(IPC_CHANNELS.conversationSetArchived, input),
  delete: (input) => invoke(IPC_CHANNELS.conversationDelete, input)
}

const modelsApi: RendererApi['models'] = {
  list: (input) => invoke(IPC_CHANNELS.modelsList, input)
}

const capabilitiesApi: RendererApi['capabilities'] = {
  list: (input) => input === undefined
    ? invoke(IPC_CHANNELS.capabilityList)
    : invoke(IPC_CHANNELS.capabilityList, input),
  execute: (input) => invoke(IPC_CHANNELS.capabilityExecute, input)
}

const turnApi: RendererApi['turn'] = {
  start: (input) => invoke(IPC_CHANNELS.turnStart, input),
  cancel: (input) => invoke(IPC_CHANNELS.turnCancel, input)
}

const approvalApi: RendererApi['approval'] = {
  resolve: (input) => invoke(IPC_CHANNELS.approvalResolve, input),
  listSessionScopes: () => invoke(IPC_CHANNELS.approvalSessionScopesList),
  revokeSessionScope: (input) => invoke(IPC_CHANNELS.approvalSessionScopeRevoke, input)
}

const imageApi: RendererApi['image'] = {
  read: (input) => invoke(IPC_CHANNELS.imageRead, input)
}

const workspaceApi: RendererApi['workspace'] = {
  provision: (input) => input === undefined
    ? invoke(IPC_CHANNELS.workspaceProvision)
    : invoke(IPC_CHANNELS.workspaceProvision, input),
  restore: (input) => invoke(IPC_CHANNELS.workspaceRestore, input),
  remember: (input) => invoke(IPC_CHANNELS.workspaceRemember, input),
  listOpeners: (input) => invoke(IPC_CHANNELS.workspaceListOpeners, input),
  open: (input) => invoke(IPC_CHANNELS.workspaceOpen, input),
  environment: (input) => invoke(IPC_CHANNELS.workspaceEnvironment, input),
  changes: (input) => invoke(IPC_CHANNELS.workspaceChanges, input),
  checkpoint: (input) => invoke(IPC_CHANNELS.workspaceCheckpoint, input),
  rewind: (input) => invoke(IPC_CHANNELS.workspaceRewind, input),
  worktreeApply: (input) => invoke(IPC_CHANNELS.workspaceWorktreeApply, input),
  worktreeDiscard: (input) => invoke(IPC_CHANNELS.workspaceWorktreeDiscard, input),
  listDirectory: (input) => invoke(IPC_CHANNELS.workspaceListDirectory, input),
  readFile: (input) => invoke(IPC_CHANNELS.workspaceReadFile, input),
  writeFile: (input) => invoke(IPC_CHANNELS.workspaceWriteFile, input),
  gitSummary: (input) => invoke(IPC_CHANNELS.workspaceGitSummary, input),
  gitDiff: (input) => invoke(IPC_CHANNELS.workspaceGitDiff, input),
  gitRevert: (input) => invoke(IPC_CHANNELS.workspaceGitRevert, input),
  gitRevertHunk: (input) => invoke(IPC_CHANNELS.workspaceGitRevertHunk, input),
  gitCommit: (input) => invoke(IPC_CHANNELS.workspaceGitCommit, input)
}

const terminalApi: RendererApi['terminal'] = {
  start: (input) => invoke(IPC_CHANNELS.terminalStart, input),
  input: (input) => invoke(IPC_CHANNELS.terminalInput, input),
  resize: (input) => invoke(IPC_CHANNELS.terminalResize, input),
  stop: (input) => invoke(IPC_CHANNELS.terminalStop, input)
}

const profileApi: RendererApi['profile'] = {
  listPublic: () => invoke(IPC_CHANNELS.profileListPublic),
  save: (input) => invoke(IPC_CHANNELS.profileSave, input),
  delete: (input) => invoke(IPC_CHANNELS.profileDelete, input),
  apply: (input) => invoke(IPC_CHANNELS.profileApply, input),
  restore: (input) => invoke(IPC_CHANNELS.profileRestore, input)
}

const integrationApi: RendererApi['integration'] = {
  status: (input) => invoke(IPC_CHANNELS.integrationStatus, input),
  diagnose: (input) => invoke(IPC_CHANNELS.integrationDiagnose, input),
  install: (input) => invoke(IPC_CHANNELS.integrationInstall, input),
  relaunch: (input) => invoke(IPC_CHANNELS.integrationRelaunch, input),
  restore: (input) => invoke(IPC_CHANNELS.integrationRestore, input)
}

const relayApi: RendererApi['relay'] = {
  getConnection: () => invoke(IPC_CHANNELS.relayGetConnection),
  connect: (input) => invoke(IPC_CHANNELS.relayConnect, input),
  startDeviceAuthorization: () => invoke(IPC_CHANNELS.relayStartDeviceAuthorization),
  openDeviceAuthorization: (input) => invoke(IPC_CHANNELS.relayOpenDeviceAuthorization, input),
  pollDeviceAuthorization: (input) => invoke(IPC_CHANNELS.relayPollDeviceAuthorization, input),
  signOut: () => invoke(IPC_CHANNELS.relaySignOut),
  getOverview: () => invoke(IPC_CHANNELS.relayGetOverview),
  getBillingConfig: () => invoke(IPC_CHANNELS.relayGetBillingConfig),
  listTokens: () => invoke(IPC_CHANNELS.relayListTokens),
  updateTokenStatus: (input) => invoke(IPC_CHANNELS.relayUpdateTokenStatus, input),
  revokeToken: (input) => invoke(IPC_CHANNELS.relayRevokeToken, input),
  listUsage: (input) => invoke(IPC_CHANNELS.relayListUsage, input),
  listPricing: () => invoke(IPC_CHANNELS.relayListPricing),
  redeem: (input) => invoke(IPC_CHANNELS.relayRedeem, input)
}

const linkApi: RendererApi['link'] = {
  openExternal: (url) => invoke(IPC_CHANNELS.linkOpenExternal, url)
}

const backgroundApi: RendererApi['background'] = {
  list: () => invoke(IPC_CHANNELS.backgroundList),
  submit: (input) => invoke(IPC_CHANNELS.backgroundSubmit, input),
  followUp: (input) => invoke(IPC_CHANNELS.backgroundFollowUp, input),
  resume: (input) => invoke(IPC_CHANNELS.backgroundResume, input),
  cancel: (id) => invoke(IPC_CHANNELS.backgroundCancel, id)
}

const browserApi: RendererApi['browser'] = {
  navigate: (url) => invoke(IPC_CHANNELS.browserNavigate, url),
  screenshot: () => invoke(IPC_CHANNELS.browserScreenshot),
  content: () => invoke(IPC_CHANNELS.browserContent),
  close: () => invoke(IPC_CHANNELS.browserClose)
}

const screenApi: RendererApi['screen'] = {
  capture: (displayId) => invoke(IPC_CHANNELS.screenCapture, displayId),
  displays: () => invoke(IPC_CHANNELS.screenDisplays)
}

const api: RendererApi = {
  studio: studioApi,
  app: appApi,
  window: windowApi,
  dialog: dialogApi,
  conversation: conversationApi,
  models: modelsApi,
  capabilities: capabilitiesApi,
  turn: turnApi,
  approval: approvalApi,
  image: imageApi,
  workspace: workspaceApi,
  terminal: terminalApi,
  profile: profileApi,
  integration: integrationApi,
  relay: relayApi,
  link: linkApi,
  background: backgroundApi,
  browser: browserApi,
  screen: screenApi,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    if (typeof listener !== 'function') return () => undefined
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      if (isAgentEvent(payload)) listener(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.agentEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, wrapped)
    }
  }
}

Object.freeze(appApi)
Object.freeze(windowApi)
Object.freeze(dialogApi)
Object.freeze(conversationApi)
Object.freeze(modelsApi)
Object.freeze(capabilitiesApi)
Object.freeze(turnApi)
Object.freeze(approvalApi)
Object.freeze(imageApi)
Object.freeze(workspaceApi)
Object.freeze(terminalApi)
Object.freeze(profileApi)
Object.freeze(integrationApi)
Object.freeze(relayApi)
Object.freeze(linkApi)
Object.freeze(backgroundApi)
Object.freeze(browserApi)
Object.freeze(screenApi)
Object.freeze(api)

contextBridge.exposeInMainWorld('onekey', api)
