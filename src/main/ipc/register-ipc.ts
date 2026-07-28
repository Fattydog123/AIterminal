import { app, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  AgentEvent,
  ApiResult,
  BootstrapPayload,
  CapabilityCatalog,
  CapabilityExecuteResult,
  ConversationCreateInput,
  ConversationImportInput,
  GitDiffBase,
  ConversationSnapshot,
  ConversationSourceProvider,
  GeneratedImageData,
  ModelDescriptor,
  PluginDescriptor,
  ProjectSummary,
  PublicAccessProfile,
  TaskSummary,
  TurnStartResult,
  RemoteRelayBillingConfigDto,
  RemoteRelayConnectionDto,
  RemoteRelayDeviceAuthorizationDto,
  RemoteRelayDeviceAuthorizationPollDto,
  RemoteRelayOverviewDto,
  RemoteRelayPricingDto,
  RemoteRelayRedeemResultDto,
  RemoteRelayTokenMutationDto,
  RemoteRelayTokenPageDto,
  RemoteRelayUsageDto,
  WorkspaceEnvironmentSnapshot,
  WorkspaceChangeState,
  WorkspaceOpenerListResult,
  WorkspaceOpenResult
} from '../../shared/contracts.ts'
import {
  declaredModelAgentEndpoints,
  isModelEndpointType,
  isValidModelId,
  isValidRelayGroupId,
  preferredModelEndpoint,
  isWorkspaceOpenerId
} from '../../shared/contracts.ts'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { WZH_MODEL_BASE_URL, WZH_RELAY_PROFILE_HANDLE } from '../../shared/server-config'
import { ConsentValidationError } from '../security/consent-store'
import { failure, internalFailure, redactCredentialContent, redactSensitiveContent, redactSensitiveText } from '../security/redaction'
import { validateExternalUrl } from '../security/web-contents'
import {
  PendingTurnStartError
} from '../runtime/pending-turn-starts'
import { TurnRegistry, TurnRegistryError } from '../runtime/turn-registry'
import { AccessProfileServiceError } from '../services/access-profile-service'
import {
  AttachmentInputError,
  AttachmentInputService
} from '../services/attachment-input-service'
import type { MainBackendServices } from '../services/backend-services'
import { getBootstrapPayload } from '../services/bootstrap'
import { ChatTurnError, ChatTurnService } from '../services/chat-turn-service'
import { buildChatCompletionsRequestUrl } from '../services/chat-completions-client'
import { buildResponsesRequestUrl } from '../services/responses-client'
import { buildAnthropicMessagesRequestUrl } from '../services/anthropic-messages-client'
import { buildGeminiContentRequestUrl } from '../services/gemini-content-client'
import { ConfirmedModelCatalogStore } from '../services/confirmed-model-catalog-store'
import {
  CapabilityRegistryError,
  type CapabilitySkillUseRequest
} from '../services/capability-registry'
import type { ExtensionInvokeAuthorization } from '../services/extension-host'
import { CapabilityGrantStoreError } from '../services/capability-grant-store'
import { AgentApprovalError, AgentApprovalService } from '../services/agent-approval-service'
import { AgentTurnError, AgentTurnService } from '../services/agent-turn-service'
import { isReasoningEffort } from '../services/reasoning-protocol'
import { ConversationHistoryError } from '../services/conversation-history-service'
import {
  ConversationCompactionError,
  ConversationCompactionService,
  type ConversationCompactionEndpoint,
} from '../services/conversation-compaction-service'
import {
  EndpointConsentCoordinator,
  EndpointConsentCoordinatorError
} from '../services/endpoint-consent-coordinator'
import { ModelCatalogError } from '../services/model-catalog'
import { loadRelayConversationCatalog } from '../services/relay-conversation-catalog'
import { ImageResultStore, ImageResultStoreError } from '../services/image-result-store'
import {
  ProjectInitError,
  ProjectInitService,
  type ProjectInitCommitInspection
} from '../services/project-init-service'
import {
  RelayDtoAdapterError,
  normalizeRemoteRelayUsageInput,
  toRemoteRelayBillingConfig,
  toRemoteRelayConnection,
  toRemoteRelayDeviceAuthorization,
  toRemoteRelayDeviceAuthorizationPoll,
  toRemoteRelayOverview,
  toRemoteRelayPricing,
  toRemoteRelayTokenMutation,
  toRemoteRelayTokenPage,
  toRemoteRelayUsage
} from '../services/relay-dto-adapter'
import {
  RelayServiceError,
  type RelaySupportedEndpointDto
} from '../services/relay-service'
import {
  SelectionTokenError,
  SelectionTokenStore,
  type ResolvedWorkspaceRecord
} from '../services/selection-token-store'
import { WorkspaceLaunchTokenStore } from '../services/workspace-launch-token-store'
import {
  WorkspaceEnvironmentError,
  WorkspaceEnvironmentService
} from '../services/workspace-environment-service'
import { WorkspaceOpenerError, WorkspaceOpenerService } from '../services/workspace-opener-service'
import { WorkspaceToolError, WorkspaceToolService } from '../services/workspace-tool-service'
import { TurnAdmissionService, validateTurnStartInput } from '../services/turn-admission-service'
import { AgentWorkspaceSessionError } from '../services/agent-workspace-session-service'
import { WorkspaceChangeError } from '../services/workspace-change-session'
import { AgentTaskSupervisorError } from '../services/background-task-manager'
import { BrowserControlService } from '../services/browser-control-service'
import { ScreenCaptureService } from '../services/screen-capture-service'
import { TerminalService } from '../services/terminal-service'
import {
  CodexHistoryError,
  type CodexHistoryThreadSnapshot,
  type CodexHistoryThreadSummary
} from '../services/codex-app-server-history-service'
import {
  ExternalProviderHistoryError,
  type ExternalHistoryProvider,
  type ExternalHistoryThreadSnapshot,
  type ExternalHistoryThreadSummary
} from '../services/external-provider-history-service'
import { ConversationWorkspaceExportService } from '../services/conversation-workspace-export-service'
import { ProviderHistoryOverlayStore } from '../services/provider-history-overlay-store'
import { registerApplicationQuitIpcHandler } from './application-quit-ipc'

type Handler<T> = (...args: unknown[]) => ApiResult<T> | Promise<ApiResult<T>>

export interface IpcHandlerRegistration {
  tokenStore: SelectionTokenStore
  isLocalSessionUnlocked(): boolean
  shutdown(): Promise<void>
}

const REGISTERED_CHANNELS = Object.values(IPC_CHANNELS).filter(
  (channel) => channel !== IPC_CHANNELS.agentEvent
)

// Single allowlist for every attachment entry path (picker dialog and drag-drop).
const ATTACHMENT_FILE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'csv', 'json', 'html', 'xml',
  'yaml', 'yml', 'toml', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go',
  'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'ps1', 'log'
]

export function registerIpcHandlers(
  window: BrowserWindow,
  backend: MainBackendServices,
  requestQuit: () => void
): IpcHandlerRegistration {
  for (const channel of REGISTERED_CHANNELS) ipcMain.removeHandler(channel)

  const tokenStore = new SelectionTokenStore()
  const workspaceLaunchTokens = new WorkspaceLaunchTokenStore()
  const workspaceOpeners = new WorkspaceOpenerService()
  const attachmentInputs = new AttachmentInputService({
    selections: tokenStore,
    protectedAbsoluteRoots: [app.getPath('userData')]
  })
  const imageResults = new ImageResultStore()
  const ownerWebContentsId = window.webContents.id
  let shuttingDown = false
  let localSessionUnlocked = false
  const publicSecure = <T>(handler: Handler<T>) => secureHandler(window, (...args: unknown[]) => {
    if (shuttingDown) return failure('cancelled', '应用正在安全退出。')
    return handler(...args)
  })
  const localSecure = <T>(handler: Handler<T>) => publicSecure<T>(async (...args: unknown[]) => {
    if (!localSessionUnlocked) {
      return failure('denied', '请先登录 AI终点站账户。')
    }
    return handler(...args)
  })
  const chatEndpointConsent = new EndpointConsentCoordinator(
    backend.consents,
    (endpoint) => isAuthenticatedRelayModelEndpoint(endpoint, backend.relay.serverOrigin)
      ? Promise.resolve(true)
      : requestChatEndpointConsent(window, endpoint)
  )
  const agentEndpointConsent = new EndpointConsentCoordinator(
    backend.consents,
    (endpoint) => isAuthenticatedRelayModelEndpoint(endpoint, backend.relay.serverOrigin)
      ? Promise.resolve(true)
      : requestAgentEndpointConsent(window, endpoint)
  )
  let relayEndpointConfirmed = false
  const currentRelayConnection = (): RemoteRelayConnectionDto =>
    toRemoteRelayConnection(
      backend.relay.serverOrigin,
      relayEndpointConfirmed,
      backend.relay.getAuthenticationState()
    )
  const relayProfileAvailable = (): boolean => (
    relayEndpointConfirmed && backend.relay.getAuthenticationState().authenticated
  )
  const listPublicProfiles = (): PublicAccessProfile[] =>
    relayProfileAvailable() ? [createRelayPublicProfile()] : []
  const resolveModelCredentials = async (
    profileHandle: string,
    groupId: string | null,
    modelId: string
  ) => {
    if (profileHandle !== WZH_RELAY_PROFILE_HANDLE || groupId === null) {
      throw new RelayServiceError('invalid_input')
    }
    return await backend.relay.getSelectedModelAccessCredentials({ groupId, modelId })
  }
  const secure = <T>(handler: Handler<T>) => publicSecure<T>(async (...args: unknown[]) => {
    if (!relayEndpointConfirmed) {
      return failure('denied', '请先登录 AI终点站账户。')
    }
    await backend.relay.ensureAuthenticatedSession()
    localSessionUnlocked = true
    return handler(...args)
  })
  const chatTurnRegistry = new TurnRegistry({ maxActiveTurns: 8, maxRetainedTurns: 128 })
  const agentTurnRegistry = new TurnRegistry({ maxActiveTurns: 8, maxRetainedTurns: 128 })
  const waitingAgentTurns = new Set<string>()
  /**
   * Fires only when the window cannot convey the state itself: minimized, hidden,
   * or not focused. Body text is already redacted by the emitting service.
   */
  const notifyWhenUnattended = (title: string, body: string): void => {
    try {
      if (window.isDestroyed() || !Notification.isSupported()) return
      if (window.isFocused() && window.isVisible() && !window.isMinimized()) return
      new Notification({ title, body: body.slice(0, 180) }).show()
    } catch {
      // Notifications are a convenience; never let one break event delivery.
    }
  }

  const publishAgentEvent = (event: AgentEvent): void => {
    if (event.type === 'turn-status') {
      if (event.status === 'waiting-approval') waitingAgentTurns.add(event.turnId)
      else waitingAgentTurns.delete(event.turnId)
    } else if (event.type === 'approval-request') {
      waitingAgentTurns.add(event.turnId)
    } else if (event.type === 'tool-status') {
      waitingAgentTurns.delete(event.turnId)
    }
    backend.agentTaskSupervisor.handleEvent(event)
    if (
      event.type === 'turn-status' &&
      (event.status === 'completed' || event.status === 'failed')
    ) {
      void backend.agentTaskSupervisor.list().then((tasks) => {
        const task = tasks.find((candidate) => candidate.turnId === event.turnId)
        if (!task || task.queuedFollowUps > 0 || !Notification.isSupported()) return
        try {
          new Notification({
            title: event.status === 'completed' ? '后台任务完成' : '后台任务失败',
            body: event.status === 'completed'
              ? task.title
              : `${task.title}: ${task.error ?? '任务未完成'}`
          }).show()
        } catch { /* notification unavailable */ }
      }).catch(() => undefined)
    }
    // A turn that stops for approval, or finishes, while the user is looking at
    // another window is otherwise silent — the run just waits. Only notify when
    // the window cannot show the state itself.
    if (event.type === 'approval-request') {
      notifyWhenUnattended('需要你的批准', event.label)
    } else if (
      event.type === 'turn-status' &&
      (event.status === 'completed' || event.status === 'failed')
    ) {
      notifyWhenUnattended(
        event.status === 'completed' ? '本轮已完成' : '本轮未完成',
        event.message || (event.status === 'completed' ? '回答已生成。' : '请回到应用查看详情。')
      )
    }
    sendAgentEvent(window, event)
  }
  const withLiveTaskStatus = (task: TaskSummary): TaskSummary => {
    const agentTurn = agentTurnRegistry.getActiveSnapshotForTask(task.id)
    if (agentTurn) {
      return {
        ...task,
        status: waitingAgentTurns.has(agentTurn.turnId) ? 'waiting-approval' : 'running'
      }
    }
    if (chatTurnRegistry.getActiveSnapshotForTask(task.id)) return { ...task, status: 'running' }
    return task
  }
  const chatTurns = new ChatTurnService({
    history: backend.conversations,
    responses: backend.responses,
    chatCompletions: backend.chatCompletions,
    anthropic: backend.anthropic,
    gemini: backend.gemini,
    images: backend.images,
    imageResults,
    registry: chatTurnRegistry,
    onEvent: publishAgentEvent
  })
  const agentApprovals = new AgentApprovalService({
    consents: backend.consents,
    onEvent: publishAgentEvent,
    persistence: backend.approvalScopes,
    // A persisted grant follows the workspace's stable identity, never the
    // session-scoped selection token.
    resolveWorkspaceIdentity: async (workspaceToken) => {
      const workspace = await tokenStore.resolveWorkspace(workspaceToken, ownerWebContentsId)
      return workspace ? { device: workspace.device, inode: workspace.inode } : null
    }
  })
  const workspaceTools = new WorkspaceToolService({
    selections: tokenStore,
    protectedAbsoluteRoots: [app.getPath('userData')],
    authorizeManagedGitWorktree: (workspacePath, gitDirectory) =>
      backend.workspaceChanges.authorizeManagedGitWorktree(workspacePath, gitDirectory)
  })
  const workspaceEnvironment = new WorkspaceEnvironmentService({
    selections: tokenStore,
    tools: workspaceTools
  })
  const projectInit = new ProjectInitService({
    selections: tokenStore,
    protectedAbsoluteRoots: [app.getPath('userData')],
    summarizeWorkspace: async (workspace, options) => {
      const result = await workspaceTools.listDirectory(
        { workspaceToken: workspace.workspaceToken, relativePath: '.' },
        workspace.ownerWebContentsId,
        options
      )
      const entries = result.entries.map((entry) => `${entry.kind}: ${entry.relativePath}`)
      return [
        'Top-level workspace entries:',
        ...entries,
        result.truncated ? 'Additional top-level entries were omitted by the local safety limit.' : ''
      ].filter(Boolean).join('\n')
    }
  })
  const providerHistoryOverlay = new ProviderHistoryOverlayStore(
    join(app.getPath('userData'), 'provider-history-overlay.json')
  )
  const conversationWorkspaceExport = new ConversationWorkspaceExportService({
    history: backend.conversations,
    agentWorkspaces: backend.agentWorkspaces
  })
  const conversationCompaction = new ConversationCompactionService({
    history: backend.conversations,
    responses: backend.responses,
    chatCompletions: backend.chatCompletions,
    anthropic: backend.anthropic,
    gemini: backend.gemini,
    onConversationUpdated: async (taskId) => {
      await conversationWorkspaceExport.syncTask(taskId)
    },
  })
  const agentTurns = new AgentTurnService({
    history: backend.conversations,
    responses: backend.responses,
    chatCompletions: backend.chatCompletions,
    anthropic: backend.anthropic,
    gemini: backend.gemini,
    approvals: agentApprovals,
    workspaceTools,
    executionBudget: { maxModelRounds: 80, maxToolCalls: 160 },
    checkpoints: {
      createTurnCheckpoint: (taskId) =>
        backend.workspaceChanges.createCheckpoint({ taskId, label: '写入前自动检查点' })
    },
    subagentWorktrees: {
      createIsolatedWorkspace: async (input) => {
        const sourceSelection = await tokenStore.resolveWorkspace(
          input.source.workspaceToken,
          input.ownerWebContentsId
        )
        const sourceWorkspace = await backend.agentWorkspaces.resolveProject(input.source.projectId)
        if (
          input.signal.aborted ||
          !sourceSelection ||
          !sourceWorkspace ||
          workspacePathKey(sourceSelection.absolutePath) !== workspacePathKey(sourceWorkspace.absolutePath)
        ) {
          throw new WorkspaceChangeError('workspace_unavailable')
        }
        const isolated = await backend.workspaceChanges.createAgentIsolation({
          rootTaskId: input.rootTaskId,
          sourceProjectId: input.source.projectId,
          label: input.task,
          signal: input.signal
        })
        try {
          if (input.signal.aborted) throw new WorkspaceChangeError('worktree_unavailable')
          const selection = tokenStore.issueWorkspace(
            isolated.absolutePath,
            input.ownerWebContentsId
          )
          const resolved = await tokenStore.resolveWorkspace(
            selection.workspaceToken,
            input.ownerWebContentsId
          )
          if (!resolved || input.signal.aborted) {
            throw new WorkspaceChangeError('worktree_unavailable')
          }
          return {
            taskId: isolated.taskId,
            projectId: isolated.projectId,
            workspaceToken: selection.workspaceToken,
            worktreeId: isolated.worktreeId
          }
        } catch (error) {
          await backend.workspaceChanges.discardWorktree({
            taskId: input.rootTaskId,
            worktreeId: isolated.worktreeId
          }).catch(() => undefined)
          throw error
        }
      }
    },
    extensions: backend.extensions,
    imageResults,
    registry: agentTurnRegistry,
    onConversationUpdated: async (taskId) => {
      await conversationWorkspaceExport.syncTask(taskId)
    },
    onEvent: publishAgentEvent
  })
  const confirmedModelCatalogs = new ConfirmedModelCatalogStore()
  const turnAdmission = new TurnAdmissionService({
    ownerWebContentsId,
    catalogs: confirmedModelCatalogs,
    selections: tokenStore,
    attachments: attachmentInputs,
    resolveCredentials: resolveModelCredentials,
    ensureEndpoint: async (mode, requestUrl) => {
      if (mode === 'agent') return await agentEndpointConsent.ensure(requestUrl)
      return await chatEndpointConsent.ensure(requestUrl)
    },
    extensions: backend.extensions,
    chatTurns,
    agentTurns,
    compaction: conversationCompaction,
    workspaceProjectId: projectIdForWorkspace
  })
  backend.agentTaskSupervisor.connect({
    startTurn: (input) => turnAdmission.start(input),
    cancelPendingStart: (requestId) => turnAdmission.cancelPendingStart(requestId).ok,
    cancelTurn: (turnId) => agentTurns.cancel(turnId)
  })
  const invalidateConfirmedRelayCatalogs = (): void => {
    confirmedModelCatalogs.invalidateProfile(WZH_RELAY_PROFILE_HANDLE)
  }
  ipcMain.handle(
    IPC_CHANNELS.appGetBootstrap,
    localSecure<BootstrapPayload>(async () => success(await getBackendBootstrapPayload(
      backend,
      relayProfileAvailable(),
      providerHistoryOverlay
    )))
  )

  registerApplicationQuitIpcHandler({
    ipc: ipcMain,
    requestQuit,
    protect: (handler) => publicSecure(handler)
  })
  ipcMain.handle(
    IPC_CHANNELS.windowMinimize,
    publicSecure(() => {
      window.minimize()
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.windowToggleMaximize,
    publicSecure(() => {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.windowClose,
    publicSecure(() => {
      window.close()
      return success(null)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.dialogSelectWorkspace,
    localSecure(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择工作区',
        buttonLabel: '选择此文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return success(null)
      const selection = tokenStore.issueWorkspace(result.filePaths[0], ownerWebContentsId)
      return success(selection)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.dialogSelectAttachments,
    localSecure(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '添加附件',
        buttonLabel: '添加',
        properties: ['openFile', 'multiSelections'],
        filters: [{
          name: '支持的图片与文本文件',
          extensions: [...ATTACHMENT_FILE_EXTENSIONS]
        }]
      })
      if (result.canceled) return success([])
      if (result.filePaths.length > 6) {
        return failure('invalid_input', '一次最多选择 6 个附件。')
      }
      return success(
        result.filePaths.map((filePath) => tokenStore.issueAttachment(filePath, ownerWebContentsId))
      )
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.dialogRegisterDroppedFiles,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['paths']) ||
        !Array.isArray(input.paths) ||
        input.paths.length === 0 ||
        input.paths.some((path) => typeof path !== 'string' || path.length === 0)
      ) {
        return failure('invalid_input', '拖入附件请求无效。')
      }
      const paths = input.paths as string[]
      if (paths.length > 6) return failure('invalid_input', '一次最多拖入 6 个附件。')
      const unsupported = paths.find(
        (path) => !ATTACHMENT_FILE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())
      )
      if (unsupported !== undefined) {
        return failure('invalid_input', `暂不支持这种附件类型：${basename(unsupported) || unsupported}`)
      }
      // The dropped paths come from the OS drag payload, not a trusted picker;
      // only accept entries that are regular files on disk right now.
      const stats = await Promise.all(paths.map(async (path) => {
        try {
          return await fs.promises.stat(path)
        } catch {
          return null
        }
      }))
      const missing = stats.findIndex((stat) => stat === null || !stat.isFile())
      if (missing !== -1) {
        return failure('invalid_input', `拖入的附件不可读：${basename(paths[missing]!)}`)
      }
      try {
        return success(
          paths.map((path) => tokenStore.issueAttachment(path, ownerWebContentsId))
        )
      } catch {
        return failure('invalid_input', '拖入的附件无法登记，请重试。')
      }
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.dialogPasteImage,
    localSecure(async () => {
      const image = clipboard.readImage()
      if (image.isEmpty()) return success([])
      const pngBuffer = image.toPNG()
      if (pngBuffer.length === 0 || pngBuffer.length > 8 * 1024 * 1024) return success([])
      const tempPath = join(app.getPath('temp'), `ai-terminal-paste-${randomUUID()}.png`)
      try {
        await fs.promises.writeFile(tempPath, pngBuffer)
      } catch {
        return failure('runtime_error', '无法保存粘贴的图片，请检查磁盘空间。', true)
      }
      return success([tokenStore.issueAttachment(tempPath, ownerWebContentsId)])
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.conversationList,
    localSecure<ProjectSummary[]>(async () => success(await listConversationProjects(
      backend,
      withLiveTaskStatus,
      providerHistoryOverlay
    )))
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationCreate,
    localSecure(async (input: unknown) => {
      if (
        !hasOnlyAllowedKeys(input, ['title', 'mode', 'workspaceToken']) ||
        !Object.hasOwn(input, 'mode') ||
        (input.mode !== 'chat' && input.mode !== 'agent') ||
        (input.title !== undefined && typeof input.title !== 'string') ||
        (input.workspaceToken !== undefined && typeof input.workspaceToken !== 'string')
      ) {
        return failure('invalid_input', '新建任务请求无效。')
      }
      if (input.mode === 'chat' && input.workspaceToken !== undefined) {
        return failure('invalid_input', 'Chat 模式不能绑定本地工作区。')
      }
      let projectId = 'project:local-history'
      let resolvedAgentWorkspace: ResolvedWorkspaceRecord | null = null
      if (input.mode === 'agent') {
        if (typeof input.workspaceToken !== 'string') {
          return failure('invalid_input', 'Agent 任务需要选择一个本地工作区。')
        }
        resolvedAgentWorkspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
        if (!resolvedAgentWorkspace) return failure('denied', '所选工作区授权无效或已过期，请重新选择。')
        projectId = projectIdForWorkspace(resolvedAgentWorkspace)
        await backend.agentWorkspaces.bindProject(projectId, resolvedAgentWorkspace.absolutePath)
      }
      return success(await backend.conversations.create({
        projectId,
        title: input.title,
        mode: input.mode
      } satisfies ConversationCreateInput & { projectId: string }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationLoad,
    localSecure<ConversationSnapshot>(async (input: unknown) => {
      if (!hasExactStringField(input, 'taskId')) return failure('invalid_input', '任务请求无效。')
      if (isProviderHistoryTaskId(input.taskId)) {
        return success(await providerHistorySnapshot(backend, input.taskId))
      }
      const snapshot = await backend.conversations.load(input.taskId)
      return success({ ...snapshot, task: withLiveTaskStatus(snapshot.task) })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationImport,
    localSecure<ConversationSnapshot>(async (input: unknown) => {
      if (
        !isObject(input) ||
        !hasOnlyAllowedKeys(input, ['taskId', 'workspaceToken', 'mode']) ||
        typeof input.taskId !== 'string' ||
        (input.workspaceToken !== undefined && typeof input.workspaceToken !== 'string') ||
        (input.mode !== undefined && input.mode !== 'chat' && input.mode !== 'agent') ||
        !isProviderHistoryTaskId(input.taskId) ||
        ((input.mode ?? 'agent') === 'agent' && typeof input.workspaceToken !== 'string')
      ) {
        return failure('invalid_input', '导入历史任务请求无效。')
      }

      const targetMode = input.mode ?? 'agent'
      let projectId = 'project:local-history'
      if (targetMode === 'agent') {
        // Agent continuations retain the source workspace contract. Chat
        // imports intentionally skip workspace resolution altogether.
        const resolvedWorkspace = await tokenStore.resolveWorkspace(
          input.workspaceToken as string,
          ownerWebContentsId
        )
        if (!resolvedWorkspace) return failure('denied', '所选工作区授权无效或已过期，请重新选择。')
        projectId = projectIdForWorkspace(resolvedWorkspace)
        await backend.agentWorkspaces.bindProject(projectId, resolvedWorkspace.absolutePath)
      }

      const sourceSnapshot = await providerHistorySnapshot(backend, input.taskId)
      const source = sourceSnapshot.task.source
      if (!source) return failure('invalid_input', '导入历史任务请求无效。')
      const imported = await backend.conversations.importSnapshot({
        projectId,
        title: sourceSnapshot.task.title,
        mode: targetMode,
        source,
        messages: sourceSnapshot.messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      })
      return success({ ...imported, task: withLiveTaskStatus(imported.task) })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationCompact,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['taskId', 'profileHandle', 'groupId', 'modelId', 'reasoning']) ||
        typeof input.taskId !== 'string' ||
        typeof input.profileHandle !== 'string' ||
        input.profileHandle !== WZH_RELAY_PROFILE_HANDLE ||
        !isValidRelayGroupId(input.groupId) ||
        !isValidModelId(input.modelId) ||
        !isReasoningEffort(input.reasoning) ||
        isProviderHistoryTaskId(input.taskId)
      ) {
        return failure('invalid_input', '上下文压缩请求无效。')
      }
      if (
        chatTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
        agentTurnRegistry.getActiveSnapshotForTask(input.taskId)
      ) {
        return failure('conflict', '请等待当前回答结束后再压缩上下文。')
      }
      const snapshot = await backend.conversations.load(input.taskId)
      const catalog = confirmedModelCatalogs.get(input.profileHandle, snapshot.task.mode, input.groupId)
      const model = catalog?.models.find((candidate) => (
        candidate.id === input.modelId && candidate.modes.includes(snapshot.task.mode)
      ))
      if (!catalog || !model || !confirmedModelCatalogs.isCurrent(catalog)) {
        return failure('conflict', '模型目录已变化，请刷新后重试压缩。')
      }
      const endpointType = compactionEndpointForModel(model, snapshot.task.mode)
      if (!endpointType) return failure('not_ready', '当前模型没有可用的上下文压缩接口。')
      const endpointRoute = catalog.endpointRoutes[endpointType]
      if (endpointRoute && endpointRoute.method !== 'POST') {
        return failure('not_ready', '当前模型接口暂不支持上下文压缩。')
      }
      const credentials = await resolveModelCredentials(input.profileHandle, input.groupId, input.modelId)
      const requestUrl = buildConfirmedCompactionRequestUrl(
        credentials.baseUrl,
        endpointType,
        input.modelId,
        endpointRoute?.path,
      )
      if (snapshot.task.mode === 'agent') await agentEndpointConsent.ensure(requestUrl)
      else await chatEndpointConsent.ensure(requestUrl)
      if (!confirmedModelCatalogs.isCurrent(catalog)) {
        return failure('conflict', '模型目录已变化，请刷新后重试压缩。')
      }
      const taskId = input.taskId
      return success(await conversationCompaction.compact(taskId, {
        model: input.modelId,
        credentials: { baseUrl: credentials.baseUrl, apiKey: credentials.apiKey },
        endpointType,
        ...(endpointRoute?.path === undefined ? {} : { endpointPath: endpointRoute.path }),
        wireMode: model.wireMode,
        reasoning: input.reasoning,
        ...(model.reasoningProtocol === undefined ? {} : { reasoningProtocol: model.reasoningProtocol }),
      }, {
        force: true,
        // The summarization request runs for seconds; a turn admitted in that
        // window appends messages a replace would clobber. Abort instead.
        confirmStillSafe: () => (
          !chatTurnRegistry.getActiveSnapshotForTask(taskId) &&
          !agentTurnRegistry.getActiveSnapshotForTask(taskId)
        ),
      }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationRename,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['taskId', 'title']) ||
        typeof input.taskId !== 'string' ||
        typeof input.title !== 'string'
      ) {
        return failure('invalid_input', '重命名请求无效。')
      }
      if (isProviderHistoryTaskId(input.taskId)) return externalHistoryReadOnlyFailure()
      return success(withLiveTaskStatus(await backend.conversations.rename(input.taskId, input.title)))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationFork,
    localSecure(async (input: unknown) => {
      if (
        !hasOnlyAllowedKeys(input, ['taskId', 'workspaceToken', 'isolateFiles', 'anchorMessageId']) ||
        typeof input.taskId !== 'string' ||
        (input.workspaceToken !== undefined && typeof input.workspaceToken !== 'string') ||
        (input.isolateFiles !== undefined && typeof input.isolateFiles !== 'boolean') ||
        (input.anchorMessageId !== undefined && (
          typeof input.anchorMessageId !== 'string' ||
          input.anchorMessageId.length > 200
        ))
      ) {
        return failure('invalid_input', '分支请求无效。')
      }
      if (isProviderHistoryTaskId(input.taskId)) return externalHistoryReadOnlyFailure()
      if (
        agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(input.taskId)
      ) {
        return failure('conflict', '请先停止当前回答，再创建分支。')
      }
      return success(withLiveTaskStatus(await backend.workspaceChanges.forkConversation({
        taskId: input.taskId,
        isolateFiles: input.isolateFiles ?? true,
        ...(input.anchorMessageId === undefined ? {} : { anchorMessageId: input.anchorMessageId })
      })))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationSearch,
    localSecure(async (input: unknown) => {
      if (!hasExactKeys(input, ['query']) || typeof input.query !== 'string') {
        return failure('invalid_input', '搜索请求无效。')
      }
      const [local, provider] = await Promise.all([
        backend.conversations.search(input.query),
        searchProviderHistory(backend, providerHistoryOverlay, input.query),
      ])
      return success([...local, ...provider])
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationSetArchived,
    localSecure<TaskSummary>(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['taskId', 'archived']) ||
        typeof input.taskId !== 'string' ||
        typeof input.archived !== 'boolean'
      ) {
        return failure('invalid_input', '归档请求无效。')
      }
      if (isProviderHistoryTaskId(input.taskId)) {
        // Provider history stays read-only at the source; archive is an
        // app-local overlay mark. The result merges overlay first, then any
        // provider-side archived flag (which this app cannot clear).
        const snapshot = await providerHistorySnapshot(backend, input.taskId)
        const archivedAt = await providerHistoryOverlay.setArchived(input.taskId, input.archived)
        return success({ ...snapshot.task, archivedAt: archivedAt ?? snapshot.task.archivedAt })
      }
      if (
        input.archived &&
        (agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
          chatTurnRegistry.getActiveSnapshotForTask(input.taskId))
      ) {
        return failure('conflict', '请先停止当前回答，再归档该会话。')
      }
      return success(withLiveTaskStatus(
        await backend.conversations.setArchived(input.taskId, input.archived)
      ))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationDelete,
    localSecure<null>(async (input: unknown) => {
      if (!hasExactStringField(input, 'taskId')) return failure('invalid_input', '删除任务请求无效。')
      if (isProviderHistoryTaskId(input.taskId)) {
        // "Delete" for provider history means hiding it from this app's list;
        // the provider's own files/threads are never touched.
        await providerHistoryOverlay.hide(input.taskId)
        return success(null)
      }
      if (
        agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(input.taskId)
      ) {
        return failure('conflict', '正在运行的任务不能删除，请先停止当前请求。')
      }
      await backend.conversations.delete(input.taskId)
      return success(null)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.modelsList,
    localSecure<ModelDescriptor[]>(async (input: unknown) => {
      if (!hasExactKeys(input, ['profileHandle', 'mode', 'groupId'])) {
        return failure('invalid_input', '模型请求无效。')
      }
      const mode = input.mode
      if (mode !== 'chat' && mode !== 'agent') return failure('invalid_input', '模型请求无效。')
      if (typeof input.profileHandle !== 'string') {
        return failure('invalid_input', '模型请求无效。')
      }
      const profileHandle = input.profileHandle
      if (profileHandle !== WZH_RELAY_PROFILE_HANDLE) {
        return failure('denied', 'Chat 和 Agent 仅支持当前账户的模型。')
      }
      const groupId = input.groupId
      if (
        (groupId !== null && !isValidRelayGroupId(groupId)) ||
        groupId === null
      ) {
        return failure('invalid_input', '接入分组请求无效。')
      }
      const refreshGeneration = confirmedModelCatalogs.generation(profileHandle)
      const relayGroupId = groupId
      const catalog = await loadRelayConversationCatalog({
        relay: backend.relay,
        modelCatalog: backend.modelCatalog,
        groupId: relayGroupId,
        mode
      })
      let models = [...catalog.models]
      const pricing = catalog.pricing
      const endpointRoutes = cloneEndpointRoutes(pricing.supported_endpoint)
      models = models.filter((model) => model.modes.includes(mode))
      if (confirmedModelCatalogs.generation(profileHandle) !== refreshGeneration) {
        return failure('conflict', 'The access profile changed while models were loading. Refresh again.')
      }
      confirmedModelCatalogs.set({
        profileHandle,
        mode,
        groupId,
        generation: refreshGeneration,
        models: structuredClone(models),
        endpointRoutes
      })
      return success(models)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.capabilityList,
    localSecure<CapabilityCatalog>(async (...args: unknown[]) => {
      if (args.length > 1) return failure('invalid_input', 'Capability list input is invalid.')
      const input = args[0]
      if (input !== undefined && !hasOnlyAllowedKeys(input, ['workspaceToken', 'category'])) {
        return failure('invalid_input', 'Capability list input is invalid.')
      }
      if (
        input !== undefined &&
        input.category !== undefined &&
        input.category !== 'skills' &&
        input.category !== 'plugins'
      ) {
        return failure('invalid_input', 'Capability discovery category is invalid.')
      }
      const category: 'skills' | 'plugins' | undefined = input?.category === 'skills' || input?.category === 'plugins'
        ? input.category
        : undefined
      let workspaceSelection: { absolutePath: string; device: string; inode: string } | undefined
      if (input !== undefined && Object.hasOwn(input, 'workspaceToken')) {
        if (category === undefined) {
          return failure('denied', 'A category-specific capability discovery request is required.')
        }
        if (typeof input.workspaceToken !== 'string' || input.workspaceToken.length > 256) {
          return failure('invalid_input', 'Capability workspace selection is invalid.')
        }
        const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
        if (!workspace) return failure('denied', 'The selected workspace authorization is invalid or expired.')
        workspaceSelection = workspace
      }
      if (category !== undefined) {
        const approved = await requestCapabilityDiscoveryConsent(
          window,
          category,
          workspaceSelection?.absolutePath
        )
        if (!approved) {
          return failure('cancelled', '能力目录读取已取消；未读取任何本地能力文件。')
        }
      }
      return success(await backend.extensions.catalog({
        ownerWebContentsId,
        ...(workspaceSelection === undefined ? {} : {
          workspace: {
            absolutePath: workspaceSelection.absolutePath,
            device: workspaceSelection.device,
            inode: workspaceSelection.inode
          }
        }),
        ...(category === undefined ? {} : { discover: category })
      }))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.capabilityExecute,
    localSecure<CapabilityExecuteResult>(async (...args: unknown[]) => {
      const draftAttempt = args[0]
      const discardDraftAttempt = (): void => {
        projectInit.discardAttempt(draftAttempt, ownerWebContentsId)
      }
      if (
        args.length !== 1 ||
        !hasOnlyAllowedKeys(args[0], [
          'id',
          'args',
          'workspaceToken',
          'grantHandle',
          'draftHandle',
          'projectInitAction'
        ])
      ) {
        discardDraftAttempt()
        return failure('invalid_input', 'Capability execution input is invalid.')
      }
      const input = args[0]
      if (
        typeof input.id !== 'string' ||
        input.id.length === 0 ||
        input.id.length > 128 ||
        (input.args !== undefined &&
          (typeof input.args !== 'string' || input.args.length > 2_000)) ||
        (input.workspaceToken !== undefined &&
          (typeof input.workspaceToken !== 'string' || input.workspaceToken.length > 256)) ||
        (input.grantHandle !== undefined &&
          (typeof input.grantHandle !== 'string' || input.grantHandle.length > 64)) ||
        (input.draftHandle !== undefined &&
          (typeof input.draftHandle !== 'string' || !/^draft_[A-Za-z0-9_-]{43}$/u.test(input.draftHandle))) ||
        (input.projectInitAction !== undefined &&
          input.projectInitAction !== 'commit' &&
          input.projectInitAction !== 'discard') ||
        (input.grantHandle !== undefined && input.draftHandle !== undefined) ||
        (input.grantHandle !== undefined && input.projectInitAction !== undefined) ||
        (input.projectInitAction !== undefined && input.draftHandle === undefined)
      ) {
        discardDraftAttempt()
        return failure('invalid_input', 'Capability execution input is invalid.')
      }
      let workspaceSelection: ResolvedWorkspaceRecord | undefined
      if (input.workspaceToken !== undefined) {
        const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
        if (!workspace) {
          discardDraftAttempt()
          return failure('denied', 'The selected workspace authorization is invalid or expired.')
        }
        workspaceSelection = workspace
      }
      const normalizedCapabilityId = input.id.trim().replace(/^[/@$]+/u, '').split(/\s+/u, 1)[0]
      if (
        (input.draftHandle !== undefined || input.projectInitAction !== undefined) &&
        normalizedCapabilityId !== 'init'
      ) {
        discardDraftAttempt()
        return failure('invalid_input', 'Capability execution input is invalid.')
      }
      if (normalizedCapabilityId === 'init') {
        if (
          input.args !== undefined ||
          input.grantHandle !== undefined ||
          workspaceSelection === undefined
        ) {
          discardDraftAttempt()
          return failure('invalid_input', 'Project initialization requires one authorized workspace.')
        }
        if (input.draftHandle === undefined && input.projectInitAction === undefined) {
          const approved = await requestProjectInitPrepareConsent(
            window,
            workspaceSelection.absolutePath
          )
          if (!approved) {
            return failure('cancelled', 'Project initialization preview was cancelled. No workspace file was read.')
          }
          const preview = await projectInit.prepare({
            workspace: workspaceSelection,
            ownerWebContentsId
          })
          return success({
            id: 'init',
            status: 'preview',
            message: 'AGENTS.md draft is ready for review. No file was changed.',
            projectInit: {
              state: 'preview',
              draftHandle: preview.draftHandle,
              relativePath: preview.relativePath,
              content: preview.content,
              contentSha256: preview.contentSha256,
              target: preview.target.state === 'absent' ? 'create' : 'replace',
              expiresAt: preview.expiresAt
            }
          })
        }
        if (input.draftHandle === undefined || input.projectInitAction === undefined) {
          discardDraftAttempt()
          return failure('invalid_input', 'Project initialization draft action is invalid.')
        }
        if (input.projectInitAction === 'discard') {
          projectInit.discardAttempt({ draftHandle: input.draftHandle }, ownerWebContentsId)
          return success({
            id: 'init',
            status: 'completed',
            message: 'The AGENTS.md draft authorization was discarded.'
          })
        }
        if (backend.extensions.getPlanMode(ownerWebContentsId)) {
          projectInit.discardAttempt({ draftHandle: input.draftHandle }, ownerWebContentsId)
          return failure('denied', 'Plan mode blocks AGENTS.md writes. Exit plan mode before committing the draft.')
        }
        const commitInput = {
          draftHandle: input.draftHandle,
          workspace: workspaceSelection
        }
        const inspection = await projectInit.inspectForCommit(commitInput, ownerWebContentsId)
        const approved = await requestProjectInitCommitConsent(
          window,
          workspaceSelection.absolutePath,
          inspection
        )
        if (!approved) {
          projectInit.discardAttempt({ draftHandle: input.draftHandle }, ownerWebContentsId)
          return failure('cancelled', 'AGENTS.md write was cancelled. This draft authorization was revoked.')
        }
        const committed = await projectInit.commit(
          commitInput,
          ownerWebContentsId
        )
        return success({
          id: 'init',
          status: 'completed',
          message: committed.replaced
            ? 'AGENTS.md was atomically replaced with the approved draft.'
            : 'AGENTS.md was atomically created from the approved draft.',
          projectInit: { state: 'committed', ...committed }
        })
      }
      if (
        normalizedCapabilityId === 'plan' &&
        typeof input.args === 'string' &&
        input.args.trim().toLowerCase() === 'off' &&
        backend.extensions.getPlanMode(ownerWebContentsId)
      ) {
        const approved = await requestPlanModeExitConsent(window)
        if (!approved) return failure('cancelled', '计划模式仍保持启用。')
      }
      const scope = {
        ownerWebContentsId,
        ...(workspaceSelection === undefined ? {} : {
          workspace: {
            absolutePath: workspaceSelection.absolutePath,
            device: workspaceSelection.device,
            inode: workspaceSelection.inode
          }
        })
      }
      const authorization: ExtensionInvokeAuthorization = input.id.startsWith('skill:')
        ? {
            authorizeSkillUse: async (request: CapabilitySkillUseRequest) =>
              await requestCapabilitySkillUseConsent(window, request)
          }
        : input.id.startsWith('plugin:')
          ? {
              authorizePluginUse: async (plugin) =>
                await requestCapabilityPluginUseConsent(window, plugin)
            }
          : {}
      return success(await backend.extensions.invoke(scope, {
        id: input.id,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.grantHandle === undefined ? {} : { grantHandle: input.grantHandle })
      }, authorization))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.turnStart,
    localSecure<TurnStartResult>((input: unknown) => turnAdmission.start(input))
  )
  ipcMain.handle(
    IPC_CHANNELS.turnCancel,
    localSecure<null>((input: unknown) => {
      if (hasExactStringField(input, 'requestId')) {
        return turnAdmission.cancelPendingStart(input.requestId)
      }
      if (hasExactStringField(input, 'turnId') && !/^turn_[A-Za-z0-9_-]{32}$/.test(input.turnId)) {
        return failure('invalid_input', 'Turn cancellation input is invalid.')
      }
      if (!hasExactStringField(input, 'turnId')) return failure('invalid_input', '停止请求无效。')
      const agentCancelled = agentTurns.cancel(input.turnId)
      const chatCancelled = chatTurns.cancel(input.turnId)
      if (!agentCancelled && !chatCancelled) return failure('not_found', '没有找到正在运行的请求。')
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.approvalResolve,
    localSecure<null>((input: unknown) => {
      if (
        !hasExactKeys(input, ['approvalId', 'decision']) ||
        typeof input.approvalId !== 'string' ||
        (
          input.decision !== 'allow_once' &&
          input.decision !== 'allow_session' &&
          input.decision !== 'deny' &&
          !(typeof input.decision === 'string' && /^option:[0-3]$/.test(input.decision))
        )
      ) {
        return failure('invalid_input', '批准请求无效。')
      }
      if (!agentApprovals.resolve(input.approvalId, input.decision)) {
        return failure('not_found', '批准请求不存在、已过期或已经处理。')
      }
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.approvalSessionScopesList,
    localSecure(async (input: unknown, ...extra: unknown[]) => {
      if (input !== undefined || extra.length !== 0) {
        return failure('invalid_input', '查询会话授权请求无效。')
      }
      return success(agentApprovals.listSessionScopes())
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.approvalSessionScopeRevoke,
    localSecure<null>(async (input: unknown, ...extra: unknown[]) => {
      if (extra.length !== 0 || !hasExactStringField(input, 'id')) {
        return failure('invalid_input', '撤销会话授权请求无效。')
      }
      if (!agentApprovals.revokeSessionScope(input.id)) {
        return failure('not_found', '该会话授权不存在或已撤销。')
      }
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.imageRead,
    localSecure<GeneratedImageData>((input: unknown) => {
      if (!hasExactStringField(input, 'imageToken')) {
        return failure('invalid_input', '图片读取请求无效。')
      }
      const image = imageResults.consume(input.imageToken, ownerWebContentsId)
      return image
        ? success(image)
        : failure('not_found', '图片已读取、已过期或不属于当前窗口。')
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceProvision,
    localSecure(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        (input !== undefined && (
          !hasOnlyAllowedKeys(input, ['prompt']) ||
          (input.prompt !== undefined && (
            typeof input.prompt !== 'string' ||
            input.prompt.length > 16_384 ||
            input.prompt.includes('\0')
          ))
        ))
      ) {
        return failure('invalid_input', '自动工作区请求无效。')
      }
      const workspace = await backend.agentWorkspaces.provision(
        typeof input === 'object' && input !== null && typeof input.prompt === 'string'
          ? { prompt: input.prompt }
          : {}
      )
      const selection = tokenStore.issueWorkspace(workspace.absolutePath, ownerWebContentsId)
      return success({ ...selection, origin: 'projectless' as const })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceRestore,
    localSecure(async (input: unknown, ...extra: unknown[]) => {
      if (extra.length !== 0 || !hasExactStringField(input, 'taskId')) {
        return failure('invalid_input', '工作区恢复请求无效。')
      }
      if (isProviderHistoryTaskId(input.taskId)) return success(null)
      const snapshot = await backend.conversations.load(input.taskId)
      if (snapshot.task.mode !== 'agent') return success(null)
      const workspace = await backend.agentWorkspaces.resolveProject(snapshot.task.projectId)
      if (!workspace) return success(null)
      const selection = tokenStore.issueWorkspace(workspace.absolutePath, ownerWebContentsId)
      const origin = isCodexProjectlessWorkspace(workspace.absolutePath, app.getPath('documents'))
        ? 'projectless' as const
        : 'selected' as const
      return success({ ...selection, origin })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceRemember,
    localSecure<null>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['taskId', 'workspaceToken']) ||
        typeof input.taskId !== 'string' ||
        typeof input.workspaceToken !== 'string'
      ) {
        return failure('invalid_input', '工作区绑定请求无效。')
      }
      const [snapshot, workspace] = await Promise.all([
        backend.conversations.load(input.taskId),
        tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      ])
      if (!workspace || snapshot.task.mode !== 'agent') {
        return failure('denied', '当前任务无法绑定此工作区。')
      }
      const projectId = projectIdForWorkspace(workspace)
      if (snapshot.task.projectId !== projectId) {
        return failure('conflict', '所选目录不是该任务原来的工作区。')
      }
      await backend.agentWorkspaces.bindProject(projectId, workspace.absolutePath)
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceListOpeners,
    localSecure<WorkspaceOpenerListResult>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['workspaceToken', 'confirmation']) ||
        typeof input.workspaceToken !== 'string' ||
        input.confirmation !== 'detect'
      ) {
        return failure('invalid_input', '本机打开方式检测请求无效。')
      }
      const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      if (!workspace) {
        return failure('denied', '工作区授权无效或已过期，请重新选择。')
      }
      const openers = [...(await workspaceOpeners.detect())]
      const launchToken = workspaceLaunchTokens.issue(
        input.workspaceToken,
        ownerWebContentsId,
        openers.map((opener) => opener.id)
      )
      if (!launchToken) {
        return failure('not_ready', '本机应用启动授权暂不可用，请稍后重试。', true)
      }
      return success({ openers, launchToken })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceOpen,
    localSecure<WorkspaceOpenResult>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['workspaceToken', 'openerId', 'launchToken', 'confirmation']) ||
        typeof input.workspaceToken !== 'string' ||
        !isWorkspaceOpenerId(input.openerId) ||
        typeof input.launchToken !== 'string' ||
        input.confirmation !== 'open_once'
      ) {
        return failure('invalid_input', '工作区打开请求无效。')
      }
      const launchAuthorization = workspaceLaunchTokens.consume({
        launchToken: input.launchToken,
        workspaceToken: input.workspaceToken,
        openerId: input.openerId,
        ownerWebContentsId
      })
      if (launchAuthorization === 'rate_limited') {
        return failure('conflict', '本机应用启动过于频繁，请稍后重试。', true)
      }
      if (launchAuthorization !== 'authorized') {
        return failure('denied', '本次本机应用启动授权无效或已使用，请重新打开菜单。')
      }
      const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      if (!workspace) {
        return failure('denied', '工作区授权无效或已过期，请重新选择。')
      }
      await workspaceOpeners.open({
        openerId: input.openerId,
        workspace: {
          absolutePath: workspace.absolutePath,
          device: workspace.device,
          inode: workspace.inode,
        },
      })
      return success({ openerId: input.openerId })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceEnvironment,
    localSecure<WorkspaceEnvironmentSnapshot>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['workspaceToken']) ||
        typeof input.workspaceToken !== 'string'
      ) {
        return failure('invalid_input', '工作区状态请求无效。')
      }
      return success(await workspaceEnvironment.inspect(
        { workspaceToken: input.workspaceToken },
        ownerWebContentsId
      ))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceChanges,
    localSecure<WorkspaceChangeState>(async (input: unknown, ...extra: unknown[]) => {
      if (extra.length !== 0 || !hasExactStringField(input, 'taskId')) {
        return failure('invalid_input', '工作区版本请求无效。')
      }
      return success(await backend.workspaceChanges.list(input.taskId))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceCheckpoint,
    localSecure<WorkspaceChangeState>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasOnlyAllowedKeys(input, ['taskId', 'label']) ||
        typeof input.taskId !== 'string' ||
        (input.label !== undefined && typeof input.label !== 'string')
      ) {
        return failure('invalid_input', '检查点请求无效。')
      }
      if (agentTurnRegistry.getActiveSnapshotForTask(input.taskId)) {
        return failure('conflict', '请先停止当前 Agent，再创建检查点。')
      }
      return success(await backend.workspaceChanges.createCheckpoint({
        taskId: input.taskId,
        ...(input.label === undefined ? {} : { label: input.label })
      }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceRewind,
    localSecure<WorkspaceChangeState>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['taskId', 'checkpointId']) ||
        typeof input.taskId !== 'string' ||
        typeof input.checkpointId !== 'string'
      ) {
        return failure('invalid_input', '回退请求无效。')
      }
      if (agentTurnRegistry.getActiveSnapshotForTask(input.taskId)) {
        return failure('conflict', '请先停止当前 Agent，再回退文件。')
      }
      return success(await backend.workspaceChanges.rewind({
        taskId: input.taskId,
        checkpointId: input.checkpointId
      }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceWorktreeApply,
    localSecure<WorkspaceChangeState>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['taskId', 'worktreeId']) ||
        typeof input.taskId !== 'string' ||
        typeof input.worktreeId !== 'string'
      ) {
        return failure('invalid_input', '应用工作树请求无效。')
      }
      if (
        agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(input.taskId)
      ) {
        return failure('conflict', '请先停止当前任务，再应用工作树。')
      }
      return success(await backend.workspaceChanges.applyWorktree({
        taskId: input.taskId,
        worktreeId: input.worktreeId
      }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceWorktreeDiscard,
    localSecure<WorkspaceChangeState>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['taskId', 'worktreeId']) ||
        typeof input.taskId !== 'string' ||
        typeof input.worktreeId !== 'string'
      ) {
        return failure('invalid_input', '丢弃工作树请求无效。')
      }
      if (
        agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(input.taskId)
      ) {
        return failure('conflict', '请先停止当前任务，再丢弃工作树。')
      }
      return success(await backend.workspaceChanges.discardWorktree({
        taskId: input.taskId,
        worktreeId: input.worktreeId
      }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceListDirectory,
    localSecure(async (input: unknown) => {
      const parsed = input as { workspaceToken?: string; relativePath?: string }
      if (typeof parsed?.workspaceToken !== 'string' || typeof parsed?.relativePath !== 'string') {
        return failure('invalid_input', '目录读取请求无效。')
      }
      try {
        return success(await workspaceEnvironment.listDirectory(
          { workspaceToken: parsed.workspaceToken, relativePath: parsed.relativePath },
          ownerWebContentsId,
        ))
      } catch {
        return failure('runtime_error', '无法读取目录。', true)
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceReadFile,
    localSecure(async (input: unknown) => {
      const parsed = input as { workspaceToken?: string; relativePath?: string }
      if (typeof parsed?.workspaceToken !== 'string' || typeof parsed?.relativePath !== 'string') {
        return failure('invalid_input', '文件读取请求无效。')
      }
      try {
        const result = await workspaceEnvironment.readFile(
          { workspaceToken: parsed.workspaceToken, relativePath: parsed.relativePath },
          ownerWebContentsId
        )
        return success(result)
      } catch {
        return failure('runtime_error', '无法读取文件。', true)
      }
    })
  )
  ipcMain.handle(IPC_CHANNELS.workspaceWriteFile, localSecure(() => runtimeNotReady()))
  ipcMain.handle(
    IPC_CHANNELS.workspaceGitSummary,
    localSecure(async (input: unknown) => {
      const parsed = parseGitBaseRequest(input)
      if (!parsed) return failure('invalid_input', '工作区摘要请求无效。')
      try {
        return success(await workspaceEnvironment.summary(parsed, ownerWebContentsId))
      } catch {
        return failure('runtime_error', '无法读取工作区摘要。', true)
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceGitDiff,
    localSecure(async (input: unknown) => {
      const parsed = parseGitBaseRequest(input)
      if (!parsed) return failure('invalid_input', '工作区 Diff 请求无效。')
      try {
        return success(await workspaceEnvironment.diff(parsed, ownerWebContentsId))
      } catch {
        return failure('runtime_error', '无法读取工作区 Git 差异。', true)
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceGitRevert,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['workspaceToken', 'relativePaths', 'taskId']) ||
        typeof (input as Record<string, unknown>).workspaceToken !== 'string' ||
        !Array.isArray((input as Record<string, unknown>).relativePaths) ||
        typeof (input as Record<string, unknown>).taskId !== 'string'
      ) {
        return failure('invalid_input', '文件回退请求无效。')
      }
      const parsed = input as { workspaceToken: string; relativePaths: string[]; taskId: string }
      if (parsed.taskId && (
        agentTurnRegistry.getActiveSnapshotForTask(parsed.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(parsed.taskId)
      )) {
        return failure('conflict', '请先停止当前任务，再回退文件。')
      }
      try {
        return success(await workspaceEnvironment.revertPaths(
          { workspaceToken: parsed.workspaceToken, relativePaths: parsed.relativePaths },
          ownerWebContentsId
        ))
      } catch {
        return failure('runtime_error', '文件回退失败。', true)
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceGitRevertHunk,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['workspaceToken', 'relativePath', 'hunkText', 'taskId']) ||
        typeof (input as Record<string, unknown>).workspaceToken !== 'string' ||
        typeof (input as Record<string, unknown>).relativePath !== 'string' ||
        typeof (input as Record<string, unknown>).hunkText !== 'string' ||
        typeof (input as Record<string, unknown>).taskId !== 'string'
      ) {
        return failure('invalid_input', '变更块回退请求无效。')
      }
      const parsed = input as { workspaceToken: string; relativePath: string; hunkText: string; taskId: string }
      if (parsed.taskId && (
        agentTurnRegistry.getActiveSnapshotForTask(parsed.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(parsed.taskId)
      )) {
        return failure('conflict', '请先停止当前任务，再回退变更。')
      }
      try {
        return success(await workspaceEnvironment.revertHunk(
          { workspaceToken: parsed.workspaceToken, relativePath: parsed.relativePath, hunkText: parsed.hunkText },
          ownerWebContentsId
        ))
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'workspace_changed') {
          return failure('conflict', '文件内容已变化，请刷新差异后重试。')
        }
        return failure('runtime_error', '变更块回退失败。', true)
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceGitCommit,
    localSecure(async (input: unknown) => {
      const parsed = input as { workspaceToken?: string; message?: string }
      if (typeof parsed?.workspaceToken !== 'string' || typeof parsed?.message !== 'string' || parsed.message.length === 0) {
        return failure('invalid_input', 'Git 提交请求无效。')
      }
      try {
        const result = await workspaceEnvironment.commit(
          { workspaceToken: parsed.workspaceToken, message: parsed.message },
          ownerWebContentsId
        )
        return success(result)
      } catch {
        return failure('runtime_error', 'Git 提交失败。', true)
      }
    })
  )
  const terminalService = new TerminalService({
    onOutput: (event) => {
      try {
        window.webContents.send(IPC_CHANNELS.agentEvent, { type: 'terminal-output', terminalId: event.terminalId, data: event.data })
      } catch { /* window destroyed */ }
    },
    onExit: (terminalId, code) => {
      try {
        window.webContents.send(IPC_CHANNELS.agentEvent, { type: 'terminal-output', terminalId, data: `\r\n[进程退出: ${code ?? 'signal'}]\r\n` })
      } catch { /* window destroyed */ }
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.terminalStart,
    localSecure(async (input: unknown) => {
      const parsed = input as { workspaceToken?: string; columns?: number; rows?: number }
      let cwd = app.getPath('home')
      if (typeof parsed?.workspaceToken === 'string' && parsed.workspaceToken) {
        const workspace = await tokenStore.resolveWorkspace(parsed.workspaceToken, ownerWebContentsId)
        if (workspace) cwd = workspace.absolutePath
      }
      try {
        const session = terminalService.start(
          cwd,
          undefined,
          typeof parsed?.columns === 'number' ? parsed.columns : undefined,
          typeof parsed?.rows === 'number' ? parsed.rows : undefined
        )
        return success({ terminalId: session.id })
      } catch (error) {
        return failure('runtime_error', error instanceof Error ? error.message : '终端启动失败', true)
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.terminalInput,
    localSecure(async (input: unknown) => {
      const parsed = input as { terminalId?: string; data?: string }
      if (typeof parsed?.terminalId !== 'string' || typeof parsed?.data !== 'string') {
        return failure('invalid_input', '终端输入无效。')
      }
      terminalService.write(parsed.terminalId, parsed.data)
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    localSecure(async (input: unknown) => {
      const parsed = input as { terminalId?: string; columns?: number; rows?: number }
      if (typeof parsed?.terminalId === 'string') {
        terminalService.resize(parsed.terminalId, parsed.columns ?? 80, parsed.rows ?? 24)
      }
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.terminalStop,
    localSecure(async (input: unknown) => {
      const parsed = input as { terminalId?: string }
      if (typeof parsed?.terminalId === 'string') terminalService.stop(parsed.terminalId)
      return success(null)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.profileListPublic,
    localSecure<PublicAccessProfile[]>(() => success(listPublicProfiles()))
  )
  ipcMain.handle(
    IPC_CHANNELS.profileSave,
    localSecure<PublicAccessProfile>(() =>
      failure('denied', '模型渠道由当前账户统一管理。'))
  )
  ipcMain.handle(
    IPC_CHANNELS.profileDelete,
    localSecure<null>(() =>
      failure('denied', '模型渠道由当前账户统一管理。'))
  )
  ipcMain.handle(
    IPC_CHANNELS.profileApply,
    localSecure(() => failure('denied', '不支持导入独立渠道配置。'))
  )
  ipcMain.handle(
    IPC_CHANNELS.profileRestore,
    localSecure(() => failure('denied', '不支持从独立渠道配置恢复账户。'))
  )

  ipcMain.handle(IPC_CHANNELS.integrationStatus, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationDiagnose, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationInstall, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationRelaunch, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationRestore, localSecure(() => localConsentRequired()))

  ipcMain.handle(
    IPC_CHANNELS.relayGetConnection,
    publicSecure<RemoteRelayConnectionDto>((...args: unknown[]) =>
      args.length === 0
        ? success(currentRelayConnection())
        : failure('invalid_input', '中转站连接请求无效。'))
  )
  ipcMain.handle(
    IPC_CHANNELS.relayConnect,
    publicSecure<RemoteRelayConnectionDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['endpoint', 'confirmation']) ||
        typeof input.endpoint !== 'string' ||
        input.confirmation !== 'connect'
      ) {
        return failure('invalid_input', '中转站连接确认无效。')
      }
      backend.relay.confirmEndpoint(input.endpoint)
      relayEndpointConfirmed = true
      const restored = await backend.relay.restoreSession()
      if (restored.authenticated) localSessionUnlocked = true
      return success(currentRelayConnection())
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayStartDeviceAuthorization,
    publicSecure<RemoteRelayDeviceAuthorizationDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '设备登录请求无效。')
      if (!relayEndpointConfirmed) {
        return failure('denied', '请先确认中转站 endpoint。')
      }
      const authorization = await backend.relay.startDeviceAuthorization({
        device_name: 'AI终点站 Electron',
        platform: 'Windows',
        client_version: app.getVersion()
      })
      return success(toRemoteRelayDeviceAuthorization(authorization))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayOpenDeviceAuthorization,
    publicSecure<null>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['sessionId']) ||
        typeof input.sessionId !== 'string'
      ) {
        return failure('invalid_input', '设备授权页请求无效。')
      }
      await shell.openExternal(backend.relay.getDeviceAuthorizationUrl(input.sessionId))
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayPollDeviceAuthorization,
    publicSecure<RemoteRelayDeviceAuthorizationPollDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['sessionId']) ||
        typeof input.sessionId !== 'string'
      ) {
        return failure('invalid_input', '设备登录轮询请求无效。')
      }
      const poll = await backend.relay.pollDeviceAuthorization(input.sessionId)
      if (poll.status === 'authenticated') localSessionUnlocked = true
      return success(toRemoteRelayDeviceAuthorizationPoll(poll))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relaySignOut,
    publicSecure<null>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '退出登录请求无效。')
      turnAdmission.abortPendingStarts()
      chatTurnRegistry.cancelAll()
      agentTurnRegistry.cancelAll()
      confirmedModelCatalogs.clear()
      workspaceEnvironment.revokeOwner(ownerWebContentsId)
      tokenStore.revokeOwner(ownerWebContentsId)
      workspaceLaunchTokens.revokeOwner(ownerWebContentsId)
      imageResults.revokeOwner(ownerWebContentsId)
      projectInit.revokeOwner(ownerWebContentsId)
      backend.extensions.resetOwner(ownerWebContentsId)
      browserControl.dispose()
      screenCapture.dispose()
      terminalService.dispose()
      waitingAgentTurns.clear()
      localSessionUnlocked = false
      await backend.relay.clearLocalSession()
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayGetOverview,
    secure<RemoteRelayOverviewDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '账户概览请求无效。')
      const [account, groups, models] = await Promise.all([
        backend.relay.getSelf(),
        backend.relay.getTokenBackedUserGroups(),
        backend.relay.getUserModels()
      ])
      return success(toRemoteRelayOverview(account, groups, models))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayGetBillingConfig,
    secure<RemoteRelayBillingConfigDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '计费配置请求无效。')
      return success(toRemoteRelayBillingConfig(await backend.relay.getBillingConfig()))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayListTokens,
    secure<RemoteRelayTokenPageDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '访问令牌列表请求无效。')
      return success(toRemoteRelayTokenPage(await backend.relay.listApiTokens(1, 100)))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayUpdateTokenStatus,
    secure<RemoteRelayTokenMutationDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['tokenId', 'status']) ||
        !Number.isSafeInteger(input.tokenId) ||
        Number(input.tokenId) <= 0 ||
        (input.status !== 'active' && input.status !== 'disabled')
      ) {
        return failure('invalid_input', '访问令牌状态请求无效。')
      }
      const statusCode = input.status === 'active' ? 1 : 2
      const result = await backend.relay.updateApiTokenStatus(Number(input.tokenId), statusCode)
      invalidateConfirmedRelayCatalogs()
      return success(toRemoteRelayTokenMutation(result, input.status))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayRevokeToken,
    secure<RemoteRelayTokenMutationDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['tokenId', 'confirmation']) ||
        !Number.isSafeInteger(input.tokenId) ||
        Number(input.tokenId) <= 0 ||
        input.confirmation !== 'revoke'
      ) {
        return failure('invalid_input', '访问令牌撤销请求无效。')
      }
      const result = await backend.relay.revokeApiToken(Number(input.tokenId))
      invalidateConfirmedRelayCatalogs()
      return success(toRemoteRelayTokenMutation(result, 'revoked'))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayListUsage,
    secure<RemoteRelayUsageDto>(async (input: unknown, ...extra: unknown[]) => {
      if (extra.length !== 0) return failure('invalid_input', '用量请求无效。')
      const range = normalizeRemoteRelayUsageInput(input)
      const usage = await backend.relay.getUsageHistory(range.startTimestamp, range.endTimestamp)
      return success(toRemoteRelayUsage(range, usage))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayListPricing,
    secure<RemoteRelayPricingDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '价格目录请求无效。')
      return success(toRemoteRelayPricing(await backend.relay.getPricing()))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayRedeem,
    secure<RemoteRelayRedeemResultDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['code']) ||
        typeof input.code !== 'string'
      ) {
        return failure('invalid_input', '兑换请求无效。')
      }
      const result = await backend.relay.redeem(input.code)
      return success({ creditedQuota: result.quota })
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.linkOpenExternal,
    publicSecure(async (rawUrl: unknown) => {
      const url = validateExternalUrl(rawUrl)
      if (!url) return failure('invalid_input', '只允许打开不含凭据的 HTTPS 链接。')
      const approval = await dialog.showMessageBox(window, {
        type: 'question',
        title: '打开外部链接',
        message: '是否在系统浏览器中打开此地址？',
        detail: url,
        buttons: ['取消', '打开'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (approval.response !== 1) return failure('cancelled', '已取消打开外部链接。')
      await shell.openExternal(url)
      return success(null)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.backgroundList,
    localSecure(async () => success(await backend.agentTaskSupervisor.list()))
  )

  ipcMain.handle(
    IPC_CHANNELS.backgroundSubmit,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['taskId', 'title']) ||
        typeof input.taskId !== 'string' ||
        typeof input.title !== 'string'
      ) return failure('invalid_input', '后台任务请求无效。')
      const activeTurn = agentTurnRegistry.getActiveSnapshotForTask(input.taskId)
      if (!activeTurn) return failure('conflict', '该 Agent 任务当前没有正在运行的请求。')
      return success(await backend.agentTaskSupervisor.attach(
        input.taskId,
        input.title,
        activeTurn.turnId
      ))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.backgroundFollowUp,
    localSecure(async (input: unknown) => {
      const parsed = parseBackgroundTurnInput(input)
      if (!parsed.ok) return parsed.result
      return success(await backend.agentTaskSupervisor.followUp(parsed.id, parsed.turn))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.backgroundResume,
    localSecure(async (input: unknown) => {
      const parsed = parseBackgroundTurnInput(input)
      if (!parsed.ok) return parsed.result
      return success(await backend.agentTaskSupervisor.resume(parsed.id, parsed.turn))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.backgroundCancel,
    localSecure(async (id: unknown) => {
      if (typeof id !== 'string') return failure('invalid_input', '无效的任务 ID。')
      const cancelled = await backend.agentTaskSupervisor.cancel(id)
      if (!cancelled) return failure('not_found', '任务不存在或已结束。')
      return success(null)
    })
  )

  const browserControl = new BrowserControlService()
  const screenCapture = new ScreenCaptureService()

  void fs.promises.readdir(app.getPath('temp')).then((files) => {
    for (const file of files) {
      if (file.startsWith('ai-terminal-paste-') && file.endsWith('.png')) {
        void fs.promises.unlink(join(app.getPath('temp'), file)).catch(() => undefined)
      }
    }
  }).catch(() => undefined)

  ipcMain.handle(
    IPC_CHANNELS.browserNavigate,
    localSecure(async (url: unknown) => {
      if (typeof url !== 'string') return failure('invalid_input', '无效的 URL。')
      let parsed: URL
      try { parsed = new URL(url) } catch { return failure('invalid_input', '无效的 URL。') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return failure('invalid_input', '只允许 HTTP/HTTPS 协议。')
      const host = parsed.hostname.toLowerCase()
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' ||
          host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('169.254.') ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
        return failure('invalid_input', '不允许访问内网地址。')
      }
      return success(await browserControl.navigate(url))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.browserScreenshot,
    localSecure(async () => success(await browserControl.screenshot()))
  )

  ipcMain.handle(
    IPC_CHANNELS.browserContent,
    localSecure(async () => success(await browserControl.getContent()))
  )

  ipcMain.handle(
    IPC_CHANNELS.browserClose,
    localSecure(async () => { browserControl.close(); return success(null) })
  )

  ipcMain.handle(
    IPC_CHANNELS.screenCapture,
    localSecure(async (displayId: unknown) => {
      const id = Number.isSafeInteger(displayId) ? displayId as number : undefined
      return success(await screenCapture.captureScreen(id))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.screenDisplays,
    localSecure(async () => success(await screenCapture.listDisplays()))
  )

  let cleanupStarted = false
  const beginCleanup = (): void => {
    if (cleanupStarted) return
    cleanupStarted = true
    shuttingDown = true
    turnAdmission.abortPendingStarts()
    confirmedModelCatalogs.clear()
    chatTurns.dispose()
    agentTurns.dispose()
    chatEndpointConsent.clear()
    agentEndpointConsent.clear()
    relayEndpointConfirmed = false
    localSessionUnlocked = false
    backend.relay.revokeEndpointConfirmation()
    backend.codexHistory.dispose()
    workspaceEnvironment.revokeOwner(ownerWebContentsId)
    tokenStore.revokeOwner(ownerWebContentsId)
    workspaceLaunchTokens.revokeOwner(ownerWebContentsId)
    imageResults.revokeOwner(ownerWebContentsId)
    projectInit.revokeOwner(ownerWebContentsId)
    backend.extensions.resetOwner(ownerWebContentsId)
    waitingAgentTurns.clear()
  }
  let shutdownPromise: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    beginCleanup()
    shutdownPromise = Promise.allSettled([
      chatTurns.shutdown(),
      agentTurns.shutdown(),
      backend.extensions.dispose(),
      backend.relay.shutdown()
    ]).then(() => {
      backend.agentTaskSupervisor.dispose()
    })
    return shutdownPromise
  }
  window.webContents.once('destroyed', () => {
    void shutdown()
  })
  return {
    tokenStore,
    isLocalSessionUnlocked: () => localSessionUnlocked && !shuttingDown,
    shutdown
  }
}

export function sendAgentEvent(window: BrowserWindow, event: AgentEvent): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(IPC_CHANNELS.agentEvent, redactAgentEvent(event))
}

function parseGitBaseRequest(input: unknown): { workspaceToken: string; base?: GitDiffBase } | null {
  if (
    (!hasExactKeys(input, ['workspaceToken']) && !hasExactKeys(input, ['workspaceToken', 'base'])) ||
    typeof input.workspaceToken !== 'string' ||
    ('base' in input && input.base !== 'current' && input.base !== 'main')
  ) {
    return null
  }
  return {
    workspaceToken: input.workspaceToken,
    ...('base' in input ? { base: input.base as GitDiffBase } : {})
  }
}

function compactionEndpointForModel(
  model: Pick<ModelDescriptor, 'endpointTypes' | 'preferredChatEndpoint' | 'preferredAgentEndpoint'>,
  mode: 'chat' | 'agent',
): ConversationCompactionEndpoint | null {
  if (mode === 'agent') {
    const declared = declaredModelAgentEndpoints(model.endpointTypes)
    const preferred = model.preferredAgentEndpoint
    const selected = preferred && declared.includes(preferred)
      ? preferred
      : declared[0] ?? null
    return isConversationCompactionEndpoint(selected) ? selected : null
  }
  const selected = model.preferredChatEndpoint ?? preferredModelEndpoint(model.endpointTypes)
  return isConversationCompactionEndpoint(selected) ? selected : null
}

function isConversationCompactionEndpoint(value: unknown): value is ConversationCompactionEndpoint {
  return value === 'openai-response' || value === 'openai' || value === 'anthropic' || value === 'gemini'
}

function buildConfirmedCompactionRequestUrl(
  baseUrl: string,
  endpointType: ConversationCompactionEndpoint,
  model: string,
  endpointPath?: string,
): string {
  switch (endpointType) {
    case 'openai-response':
      return buildResponsesRequestUrl(baseUrl, endpointPath)
    case 'openai':
      return buildChatCompletionsRequestUrl(baseUrl, endpointPath)
    case 'anthropic':
      return buildAnthropicMessagesRequestUrl(baseUrl, endpointPath)
    case 'gemini':
      return buildGeminiContentRequestUrl(baseUrl, model, endpointPath)
  }
}

function secureHandler<T>(window: BrowserWindow, handler: Handler<T>) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ApiResult<T>> => {
    if (!isTrustedRenderer(window, event)) {
      return failure('denied', '请求来源未获授权。')
    }
    try {
      return await handler(...args)
    } catch (error) {
      return knownFailure(error)
    }
  }
}

function isTrustedRenderer(window: BrowserWindow, event: IpcMainInvokeEvent): boolean {
  return (
    !window.isDestroyed() &&
    event.sender.id === window.webContents.id &&
    event.senderFrame === window.webContents.mainFrame
  )
}

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function runtimeNotReady(message = '可信 Agent 运行时尚未连接。'): ApiResult<never> {
  return failure('not_ready', message, true)
}

function localConsentRequired(): ApiResult<never> {
  return failure('denied', '请先明确批准本次本地环境检查。')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isObject(value)) return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function hasOnlyAllowedKeys<K extends string>(
  value: unknown,
  allowedKeys: readonly K[]
): value is Record<K, unknown> {
  return isObject(value) && Object.keys(value).every((key) => allowedKeys.includes(key as K))
}

function hasExactStringField<K extends string>(
  value: unknown,
  field: K
): value is Record<K, string> {
  return hasExactKeys(value, [field]) && typeof value[field] === 'string'
}

function parseBackgroundTurnInput(input: unknown):
  | { ok: true; id: string; turn: import('../../shared/contracts.ts').TurnStartInput }
  | { ok: false; result: ApiResult<never> } {
  if (!hasExactKeys(input, ['id', 'turn']) || typeof input.id !== 'string') {
    return { ok: false, result: failure('invalid_input', '后台 Agent 请求无效。') }
  }
  const parsedTurn = validateTurnStartInput(input.turn)
  if (!parsedTurn.ok) return { ok: false, result: parsedTurn.result }
  if (parsedTurn.value.mode !== 'agent') {
    return { ok: false, result: failure('invalid_input', '后台任务只支持 Agent 请求。') }
  }
  return { ok: true, id: input.id, turn: parsedTurn.value }
}

function groupConversationTasks(tasks: Awaited<ReturnType<MainBackendServices['conversations']['list']>>): ProjectSummary[] {
  if (tasks.length === 0) return []
  return [{
    id: 'project:local-history',
    name: '本地历史',
    tasks
  }]
}

async function listConversationProjects(
  backend: MainBackendServices,
  withLiveTaskStatus: (task: TaskSummary) => TaskSummary,
  overlay: ProviderHistoryOverlayStore
): Promise<ProjectSummary[]> {
  const localProjects = groupConversationTasks(
    (await backend.conversations.list()).map(withLiveTaskStatus)
  )
  const projects = [...localProjects]
  // App-local hide/archive marks over the read-only provider projections.
  const applyOverlay = async (tasks: TaskSummary[]): Promise<TaskSummary[]> => {
    const visible: TaskSummary[] = []
    for (const task of tasks) {
      if (await overlay.isHidden(task.id)) continue
      const overlayArchivedAt = await overlay.archivedAt(task.id)
      visible.push(overlayArchivedAt === null ? task : { ...task, archivedAt: overlayArchivedAt })
    }
    return visible
  }
  try {
    const active = await backend.codexHistory.listThreads({ archived: false })
    const archived = await backend.codexHistory.listThreads({ archived: true })
    const byId = new Map<string, CodexHistoryThreadSummary>()
    for (const thread of [...active.threads, ...archived.threads]) byId.set(thread.id, thread)
    const tasks = await applyOverlay([...byId.values()]
      .filter((thread) => CODEX_THREAD_ID_PATTERN.test(thread.id))
      .map(codexThreadTaskSummary)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
    if (tasks.length > 0) projects.push({
      id: 'project:codex-history',
      name: 'Codex 历史',
      tasks
    })
  } catch {
    // A missing Codex CLI must not hide local or other provider history.
  }
  try {
    const external = await backend.externalHistory.listThreads()
    const byProvider = new Map<ExternalHistoryProvider, ExternalHistoryThreadSummary[]>()
    for (const thread of external.threads) {
      const entries = byProvider.get(thread.provider) ?? []
      entries.push(thread)
      byProvider.set(thread.provider, entries)
    }
    for (const provider of ['claude', 'gemini', 'grok'] as const) {
      const tasks = await applyOverlay((byProvider.get(provider) ?? [])
        .map(externalThreadTaskSummary)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
      if (tasks.length === 0) continue
      projects.push({
        id: externalProjectId(provider),
        name: `${providerLabel(provider)} 历史`,
        tasks
      })
    }
  } catch {
    // External history is best-effort; local history remains available.
  }
  return projects
}

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function isCodexTaskId(taskId: string): boolean {
  return taskId.startsWith('codex:') && CODEX_THREAD_ID_PATTERN.test(taskId.slice('codex:'.length))
}

const EXTERNAL_SOURCE_ID_PATTERN = /^source_[A-Za-z0-9_-]{43}$/u

function isProviderHistoryTaskId(taskId: string): boolean {
  return isCodexTaskId(taskId) || parseExternalHistoryTaskId(taskId) !== null
}

function parseExternalHistoryTaskId(taskId: string): {
  provider: ExternalHistoryProvider
  id: string
} | null {
  const separator = taskId.indexOf(':')
  if (separator <= 0 || separator === taskId.length - 1) return null
  const provider = taskId.slice(0, separator)
  const id = taskId.slice(separator + 1)
  if (
    (provider !== 'claude' && provider !== 'gemini' && provider !== 'grok') ||
    !EXTERNAL_SOURCE_ID_PATTERN.test(id)
  ) return null
  return { provider, id }
}

function externalProjectId(provider: ExternalHistoryProvider): string {
  return `project:${provider}-history`
}

function providerLabel(provider: ConversationSourceProvider): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'gemini') return 'Gemini'
  if (provider === 'grok') return 'Grok'
  return '外部'
}

function codexThreadTaskSummary(thread: CodexHistoryThreadSummary): TaskSummary {
  const updatedAt = codexTimestamp(thread.updatedAt)
  return {
    id: `codex:${thread.id}`,
    projectId: 'project:codex-history',
    title: thread.title,
    mode: 'agent',
    updatedAt,
    archivedAt: thread.archived ? updatedAt : null,
    status: 'idle',
    readOnly: true,
    source: { provider: 'codex', id: thread.id }
  }
}

function codexThreadSnapshot(snapshot: CodexHistoryThreadSnapshot): ConversationSnapshot {
  const task = codexThreadTaskSummary(snapshot.thread)
  const createdAt = codexTimestamp(snapshot.thread.createdAt)
  const updatedAt = codexTimestamp(snapshot.thread.updatedAt)
  return {
    task,
    messages: snapshot.messages.map((message, index) => ({
      id: `codex-message:${createHash('sha256')
        .update(snapshot.thread.id, 'utf8')
        .update('\0', 'utf8')
        .update(String(index), 'utf8')
        .digest('base64url')}`,
      role: message.role,
      content: redactSensitiveContent(message.text),
      status: 'complete',
      createdAt,
      updatedAt
    })),
    events: []
  }
}

function externalThreadTaskSummary(thread: ExternalHistoryThreadSummary): TaskSummary {
  const updatedAt = providerHistoryTimestamp(thread.updatedAt)
  return {
    id: `${thread.provider}:${thread.id}`,
    projectId: externalProjectId(thread.provider),
    title: thread.title,
    mode: 'agent',
    updatedAt,
    archivedAt: null,
    status: 'idle',
    readOnly: true,
    source: { provider: thread.provider, id: thread.id }
  }
}

function externalThreadSnapshot(snapshot: ExternalHistoryThreadSnapshot): ConversationSnapshot {
  const task = externalThreadTaskSummary(snapshot.thread)
  const createdAt = providerHistoryTimestamp(snapshot.thread.createdAt)
  const updatedAt = providerHistoryTimestamp(snapshot.thread.updatedAt)
  return {
    task,
    messages: snapshot.messages.map((message, index) => ({
      id: `external-message:${createHash('sha256')
        .update(snapshot.thread.provider, 'utf8')
        .update('\0', 'utf8')
        .update(snapshot.thread.id, 'utf8')
        .update('\0', 'utf8')
        .update(String(index), 'utf8')
        .digest('base64url')}`,
      role: message.role,
      content: redactSensitiveContent(message.text),
      status: 'complete',
      createdAt,
      updatedAt
    })),
    events: []
  }
}

// Provider history is a read-only projection of other tools' data. Titles are
// already in memory from listing (cheap), but message content requires reading
// each thread — so content search is bounded to the newest threads to stay
// responsive under the renderer's debounced live search.
const MAX_PROVIDER_SEARCH_RESULTS = 20
const MAX_PROVIDER_CONTENT_READS = 40

async function searchProviderHistory(
  backend: MainBackendServices,
  overlay: ProviderHistoryOverlayStore,
  rawQuery: string
): Promise<TaskSummary[]> {
  const query = rawQuery.trim().toLowerCase()
  if (query.length < 2) return []

  const candidates: TaskSummary[] = []
  try {
    const active = await backend.codexHistory.listThreads({ archived: false })
    const archived = await backend.codexHistory.listThreads({ archived: true })
    const byId = new Map<string, CodexHistoryThreadSummary>()
    for (const thread of [...active.threads, ...archived.threads]) byId.set(thread.id, thread)
    for (const thread of byId.values()) {
      if (CODEX_THREAD_ID_PATTERN.test(thread.id)) candidates.push(codexThreadTaskSummary(thread))
    }
  } catch {
    // A missing Codex CLI must not fail the whole search.
  }
  try {
    const external = await backend.externalHistory.listThreads()
    for (const thread of external.threads) candidates.push(externalThreadTaskSummary(thread))
  } catch {
    // External history is best-effort.
  }

  const visible: TaskSummary[] = []
  for (const task of candidates) {
    if (!(await overlay.isHidden(task.id))) visible.push(task)
  }
  visible.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  const matched: TaskSummary[] = []
  const titleMatched = new Set<string>()
  for (const task of visible) {
    if (task.title.toLowerCase().includes(query)) {
      matched.push(task)
      titleMatched.add(task.id)
    }
  }

  // Content search on the newest non-title matches, hard-capped for latency.
  let reads = 0
  for (const task of visible) {
    if (matched.length >= MAX_PROVIDER_SEARCH_RESULTS || reads >= MAX_PROVIDER_CONTENT_READS) break
    if (titleMatched.has(task.id)) continue
    reads += 1
    try {
      const snapshot = await providerHistorySnapshot(backend, task.id)
      if (snapshot.messages.some((message) => message.content.toLowerCase().includes(query))) {
        matched.push(task)
      }
    } catch {
      // A single unreadable thread must not abort the search.
    }
  }
  return matched.slice(0, MAX_PROVIDER_SEARCH_RESULTS)
}

async function providerHistorySnapshot(
  backend: MainBackendServices,
  taskId: string
): Promise<ConversationSnapshot> {
  if (isCodexTaskId(taskId)) {
    return codexThreadSnapshot(await backend.codexHistory.readThread(
      taskId.slice('codex:'.length)
    ))
  }
  const source = parseExternalHistoryTaskId(taskId)
  if (!source) throw new Error('Unsupported external history task id.')
  return externalThreadSnapshot(await backend.externalHistory.readThread(source.provider, source.id))
}

function providerHistoryTimestamp(value: number): string {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value
  const bounded = Number.isFinite(milliseconds)
    ? Math.min(8_640_000_000_000_000, Math.max(0, milliseconds))
    : 0
  return new Date(bounded).toISOString()
}

function externalHistoryReadOnlyFailure(): ApiResult<never> {
  return failure('denied', '外部历史源为只读；发送消息时会自动导入为可继续编辑的本地任务。')
}

function codexTimestamp(value: number): string {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value
  const bounded = Number.isFinite(milliseconds)
    ? Math.min(8_640_000_000_000_000, Math.max(0, milliseconds))
    : 0
  return new Date(bounded).toISOString()
}

async function getBackendBootstrapPayload(
  backend: MainBackendServices,
  relayProfileAvailable: boolean,
  overlay: ProviderHistoryOverlayStore
): Promise<BootstrapPayload> {
  const payload = getBootstrapPayload()
  const storedTasks = await backend.conversations.list()
  const relayProfile = relayProfileAvailable ? createRelayPublicProfile() : null
  payload.profiles = relayProfile ? [relayProfile] : []
  payload.projects = await listConversationProjects(backend, (task) => task, overlay)
  payload.activeTaskId = storedTasks.find((task) => task.archivedAt === null)?.id ?? ''
  payload.defaults.activeProfileHandle = relayProfile?.credentialHandle ?? ''
  return payload
}

function createRelayPublicProfile(): PublicAccessProfile {
  return {
    credentialHandle: WZH_RELAY_PROFILE_HANDLE,
    name: 'wzh-server',
    description: '当前账户会话提供的安全模型访问',
    baseUrl: WZH_MODEL_BASE_URL,
    hasKey: true,
    isCurrent: true,
    targets: ['codex']
  }
}

function cloneEndpointRoutes(
  routes: Readonly<Record<string, Readonly<RelaySupportedEndpointDto>>> | undefined
): Readonly<Record<string, Readonly<RelaySupportedEndpointDto>>> {
  if (!routes) return Object.freeze({})
  const cloned: Record<string, Readonly<RelaySupportedEndpointDto>> = Object.create(null) as Record<string, Readonly<RelaySupportedEndpointDto>>
  for (const [endpointType, route] of Object.entries(routes)) {
    if (!isModelEndpointType(endpointType)) continue
    cloned[endpointType] = Object.freeze({ path: route.path, method: route.method })
  }
  return Object.freeze(cloned)
}

function workspacePathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function requestCapabilityDiscoveryConsent(
  window: BrowserWindow,
  category: 'skills' | 'plugins',
  workspacePath?: string
): Promise<boolean> {
  const categoryLabel = category === 'skills' ? '技能' : '插件'
  const locations = category === 'skills'
    ? '~/.codex/skills、~/.agents/skills'
    : '~/.codex-plugin、~/.codex/plugins、~/.agents/plugins'
  const workspaceDetail = workspacePath
    ? `\n并检查当前已选择工作区内对应的 ${categoryLabel} 目录：\n${workspacePath}`
    : ''
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: `读取本地${categoryLabel}目录`,
    message: `是否允许本次读取已知的本地${categoryLabel}目录？`,
    detail: [
      `将有界扫描 ${locations}${workspaceDetail}。`,
      '只返回经过脱敏的名称、说明、权限和工作区相对路径；不会运行脚本、命令或插件。',
      '本次批准只用于这一次目录读取，不会持久化。'
    ].join('\n\n'),
    buttons: ['取消', '允许本次读取'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestCapabilitySkillUseConsent(
  window: BrowserWindow,
  request: CapabilitySkillUseRequest
): Promise<boolean> {
  const scope = request.scope === 'workspace' ? '当前工作区' : '当前用户'
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '读取技能说明',
    message: '是否允许本次读取所选技能的说明文件？',
    detail: [
      `技能：${request.id}`,
      `范围：${scope}`,
      `相对路径：${request.relativePath}`,
      '文件必须与目录发现时的设备、文件标识和内容摘要完全一致，否则会拒绝。',
      '说明会先脱敏并限制长度；只有你随后发送消息且确认精确模型 endpoint 时，才会进入模型上下文。'
    ].join('\n'),
    buttons: ['取消', '允许本次读取'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestCapabilityPluginUseConsent(
  window: BrowserWindow,
  plugin: Readonly<PluginDescriptor>
): Promise<boolean> {
  const scope = plugin.scope === 'workspace' ? '当前工作区' : '当前用户'
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '启用扩展',
    message: `是否启用 ${plugin.name}？`,
    detail: [
      plugin.description,
      `范围：${scope}`,
      `版本：${plugin.version}`,
      `权限：${plugin.permissions.join('、') || '只读'}`,
      '启用后，扩展声明的说明、MCP 工具和生命周期钩子会在新的 Agent 任务中生效。'
    ].join('\n'),
    buttons: ['取消', '启用扩展'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestProjectInitPrepareConsent(
  window: BrowserWindow,
  workspacePath: string
): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '准备 AGENTS.md 草稿',
    message: '是否允许本次读取当前工作区以准备项目规则草稿？',
    detail: [
      workspacePath,
      '将只枚举工作区根目录的一层安全条目，并检查现有 AGENTS.md 的受限内容与修订摘要。',
      '本步骤不会写入文件、运行任意命令、连接网络或把内容发送给模型。',
      '批准仅用于这一次草稿准备；生成后还需要单独确认才能写入。'
    ].join('\n\n'),
    buttons: ['取消', '允许本次读取并预览'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestProjectInitCommitConsent(
  window: BrowserWindow,
  workspacePath: string,
  inspection: ProjectInitCommitInspection
): Promise<boolean> {
  const targetAction = inspection.target.state === 'absent'
    ? 'create a new file'
    : 'atomically replace the existing file'
  const approval = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '写入 AGENTS.md',
    message: '是否将刚才预览的固定草稿写入当前工作区？',
    detail: [
      workspacePath,
      `Bound action: ${targetAction}`,
      `Approved draft SHA-256: ${inspection.contentSha256}`,
      '目标文件：AGENTS.md',
      'Main 进程只会使用内存中的一次性草稿，不接受 Renderer 回传正文。',
      '写入前会再次核对工作区、目标文件和草稿摘要；任何变化都会拒绝写入。',
      '文件通过同目录临时文件同步后原子提交。'
    ].join('\n\n'),
    buttons: ['取消并撤销草稿', '写入已预览草稿'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestPlanModeExitConsent(window: BrowserWindow): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '退出计划模式',
    message: '是否退出当前应用会话的只读计划模式？',
    detail: '退出后，后续 Agent 轮次可再次按所选批准策略请求文件写入。工作区边界、逐项批准和脱敏规则仍然有效。',
    buttons: ['保持计划模式', '退出计划模式'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestChatEndpointConsent(
  window: BrowserWindow,
  endpoint: string
): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '确认 Chat endpoint',
    message: '是否允许本次应用会话向以下 endpoint 发送 Chat 内容？',
    detail: `${endpoint}\n\n将发送经过脱敏的聊天文本、所选模型、推理强度和已确认的工具能力。仅当本轮明确选择附件时，才会读取并发送经过本地校验、文本脱敏和通用重命名的图片或文本内容；启用图片生成时，会向该 endpoint 请求生成图片并接收结果。不会发送附件绝对路径、原始文件名或 API Key。图片结果只进入当前应用会话的受限内存。`,
    buttons: ['取消', '允许本次会话'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

function isAuthenticatedRelayModelEndpoint(endpoint: string, serverOrigin: string): boolean {
  try {
    const target = new URL(endpoint)
    const origin = new URL(serverOrigin)
    if (target.origin !== origin.origin || target.username || target.password || target.hash) return false
    return target.pathname.startsWith('/v1/') || target.pathname.startsWith('/v1beta/models/')
  } catch {
    return false
  }
}

async function requestAgentEndpointConsent(
  window: BrowserWindow,
  endpoint: string
): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '确认 Agent endpoint',
    message: '是否允许本次应用会话向以下 endpoint 发送 Agent 内容？',
    detail: `${endpoint}\n\n将发送经过脱敏的聊天文本、所选模型、推理强度、工具开关、工作区相对文件名、获批文件内容和工具结果。若确认的模型支持自动子智能体，Agent 会在需要时自行调用最多三个受限只读子任务；它们继承相同工作区、批准、取消与脱敏边界，不能写文件、运行命令或启用 Web Search。仅当本轮明确选择附件时，才会发送经过本地校验、文本脱敏和通用重命名的图片或文本内容；启用图片生成时，会向该 endpoint 请求生成图片并接收结果。不会发送工作区或附件绝对路径、附件原始文件名，也不会把 API Key 放入 URL、日志或本地明文历史。`,
    buttons: ['取消', '允许本次会话'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

function projectIdForWorkspace(workspace: { device: string; inode: string }): string {
  const digest = createHash('sha256')
    .update('ai-terminal.workspace-project.v1\0', 'utf8')
    .update(workspace.device, 'utf8')
    .update('\0', 'utf8')
    .update(workspace.inode, 'utf8')
    .digest('base64url')
  return `project:workspace:${digest}`
}

function isCodexProjectlessWorkspace(absolutePath: string, documentsRoot: string): boolean {
  if (!isAbsolute(absolutePath) || !isAbsolute(documentsRoot)) return false
  const root = resolve(join(documentsRoot, 'Codex'))
  const candidate = resolve(absolutePath)
  const relativePath = relative(root, candidate)
  return relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
}

function knownFailure(error: unknown): ApiResult<never> {
  if (error instanceof AgentTaskSupervisorError) {
    switch (error.code) {
      case 'invalid_options':
      case 'storage_error':
      case 'corrupt_data':
        return failure('runtime_error', '后台 Agent 任务记录暂时不可用。', true)
      case 'invalid_input':
        return failure('invalid_input', '后台 Agent 请求无效。')
      case 'not_found':
        return failure('not_found', '没有找到该后台 Agent 任务。')
      case 'conflict':
        return failure('conflict', '后台 Agent 任务当前无法执行此操作。')
    }
  }
  if (error instanceof WorkspaceChangeError) {
    switch (error.code) {
      case 'invalid_configuration':
      case 'storage_error':
      case 'corrupt_data':
        return failure('runtime_error', '工作区版本记录暂时不可用。', true)
      case 'invalid_input':
        return failure('invalid_input', '工作区版本请求无效。')
      case 'workspace_unavailable':
        return failure('not_found', '任务工作区已移动或不可用。')
      case 'checkpoint_unavailable':
        return failure('not_found', '检查点不存在或已经不可用。')
      case 'worktree_unavailable':
        return failure('not_found', '工作树不存在、已处理或已经不可用。')
      case 'snapshot_too_large':
        return failure('conflict', '工作区内容过大，无法创建检查点。')
      case 'merge_conflict':
        return failure('conflict', '原工作区和工作树修改了同一文件，请先处理冲突再应用。')
      case 'git_failed':
        return failure('runtime_error', 'Git 工作树操作失败，请检查仓库状态后重试。', true)
    }
  }
  if (error instanceof CodexHistoryError) {
    switch (error.code) {
      case 'invalid_input':
        return failure('invalid_input', 'Codex 历史请求无效。')
      case 'cancelled':
        return failure('cancelled', 'Codex 历史读取已取消。')
      case 'timeout':
        return failure('runtime_error', 'Codex 历史读取超时，请重试。', true)
      case 'unavailable':
      case 'process_exited':
        return failure('not_ready', 'Codex 历史服务暂不可用，请确认已安装 Codex CLI。', true)
      case 'invalid_configuration':
      case 'protocol_error':
      case 'request_failed':
      case 'limit_exceeded':
        return failure('runtime_error', 'Codex 历史未能以只读方式加载。', true)
    }
  }
  if (error instanceof ExternalProviderHistoryError) {
    switch (error.code) {
      case 'invalid_input':
        return failure('invalid_input', '外部历史请求无效。')
      case 'unavailable':
        return failure('not_found', '没有找到所选外部历史任务。')
      case 'invalid_configuration':
      case 'corrupt_data':
      case 'limit_exceeded':
      case 'read_failed':
        return failure('runtime_error', '外部历史暂时无法读取，请稍后重试。', true)
    }
  }
  if (error instanceof AgentWorkspaceSessionError) {
    switch (error.code) {
      case 'invalid_options':
      case 'invalid_project_id':
        return failure('invalid_input', 'Agent 工作区请求无效。')
      case 'workspace_unavailable':
        return failure('not_found', 'Agent 工作区已移动或不可用。')
      case 'capacity_exceeded':
        return failure('not_ready', 'Agent 工作区记录已达上限。')
      case 'storage_unavailable':
      case 'corrupt_storage':
        return failure('runtime_error', 'Agent 工作区记录暂时不可用。', true)
      case 'provision_failed':
        return failure('runtime_error', '无法在文档目录创建 Agent 工作区。', true)
    }
  }
  if (error instanceof EndpointConsentCoordinatorError) {
    if (error.code === 'denied') return failure('denied', '本次会话未批准该 endpoint。')
    return failure('runtime_error', '无法显示 endpoint 批准请求，请重试。', true)
  }
  if (error instanceof RelayDtoAdapterError) {
    return error.code === 'invalid_input'
      ? failure('invalid_input', '中转站请求无效。')
      : failure('runtime_error', '中转站数据未通过本地安全校验。')
  }
  if (error instanceof RelayServiceError) {
    switch (error.code) {
      case 'invalid_configuration':
      case 'storage_error':
        return failure('runtime_error', '中转站安全存储不可用，请检查 Windows DPAPI 后重试。')
      case 'invalid_endpoint':
      case 'invalid_input':
        return failure('invalid_input', '中转站请求无效。')
      case 'endpoint_not_confirmed':
        return failure('denied', '请先确认精确的中转站 endpoint。')
      case 'cancelled':
        return failure('cancelled', '中转站请求已取消。')
      case 'timeout':
        return failure('runtime_error', '中转站请求超时，请重试。', true)
      case 'network_error':
        return failure('runtime_error', '无法连接已确认的中转站。', true)
      case 'authentication_required':
      case 'authorization_expired':
      case 'authorization_denied':
        return failure('denied', '中转站登录已失效，请重新进行设备授权。')
      case 'no_available_token':
        return failure('not_ready', '账户中没有可用的访问令牌，请先在用户中心创建或启用一个令牌。')
      case 'no_compatible_token':
        return failure('not_ready', '所选接入分组没有可用于该模型的令牌，请在用户中心检查令牌分组和模型限制。')
      case 'authorization_pending':
      case 'authorization_slow_down':
        return failure('not_ready', '设备授权尚未完成，请稍后重试。', true)
      case 'too_many_sessions':
        return failure('conflict', '待处理的设备登录过多，请等待现有登录过期。')
      case 'remote_unavailable':
        return failure('runtime_error', '中转站服务暂时不可用，请稍后重试。', true)
      case 'remote_rejected':
        return failure('runtime_error', '中转站拒绝了本次请求，请检查接口权限或服务端是否支持该功能。')
      case 'redirect_rejected':
        return failure('denied', '中转站返回了不允许的跳转，已阻止本次请求。')
      case 'response_too_large':
        return failure('runtime_error', '中转站响应超过本地安全上限。')
      case 'invalid_response':
        return failure('runtime_error', '中转站响应结构未通过本地安全校验。')
    }
  }
  if (error instanceof ConsentValidationError) {
    return error.code === 'invalid_endpoint'
      ? failure('invalid_input', '模型 endpoint 不符合安全传输策略。')
      : failure('runtime_error', '本次会话授权状态无效，请重试。', true)
  }
  if (error instanceof AccessProfileServiceError) {
    switch (error.code) {
      case 'invalid_input':
        return failure('invalid_input', '渠道配置无效。')
      case 'not_found':
        return failure('not_found', '没有找到所选渠道。')
      case 'missing_secret':
        return failure('denied', '请先为所选渠道安全保存 API Key。')
      case 'corrupt_data':
        return failure('runtime_error', '加密渠道配置已损坏，未读取其中内容。')
      case 'invalid_configuration':
      case 'storage_error':
        return failure('runtime_error', '无法安全读取或保存渠道配置。', true)
    }
  }
  if (error instanceof ConversationHistoryError) {
    switch (error.code) {
      case 'invalid_input':
        return failure('invalid_input', '对话历史请求无效。')
      case 'not_found':
        return failure('not_found', '没有找到所选本地任务。')
      case 'conflict':
        return failure('conflict', '对话状态已变化，请重新加载。')
      case 'limit_exceeded':
        return failure('conflict', '加密对话历史已达到安全容量上限。')
      case 'corrupt_data':
        return failure('runtime_error', '加密对话历史已损坏，未读取其中内容。')
      case 'invalid_configuration':
      case 'storage_error':
        return failure('runtime_error', '无法安全读取或保存加密对话历史。', true)
    }
  }
  if (error instanceof ConversationCompactionError) {
    return error.code === 'superseded'
      ? failure('conflict', '压缩期间有新回合开始，历史未改动；请等待回合结束后重试。')
      : failure('runtime_error', '当前模型没有返回可用的上下文摘要，请重试。', true)
  }
  if (error instanceof ChatTurnError) {
    return error.code === 'invalid_task_mode'
      ? failure('conflict', '所选任务不是 Chat 模式。')
      : failure('runtime_error', 'Chat 请求未能安全启动。', true)
  }
  if (error instanceof AgentTurnError) {
    return error.code === 'invalid_task_mode' || error.code === 'workspace_mismatch'
      ? failure(
          'conflict',
          error.code === 'workspace_mismatch'
            ? '所选 Agent 任务属于另一个工作区，请为当前工作区新建任务。'
            : '所选任务不是 Agent 模式。'
        )
      : error.code === 'invalid_tool_call'
        ? failure('denied', '模型提出了不符合本地工具契约的请求。')
        : failure('runtime_error', 'Agent 请求未能安全启动。', true)
  }
  if (error instanceof AgentApprovalError) {
    return error.code === 'capacity_exceeded'
      ? failure('not_ready', '待处理的 Agent 批准请求过多，请稍后重试。', true)
      : failure('runtime_error', 'Agent 批准状态无效，请重试。', true)
  }
  if (error instanceof AttachmentInputError) {
    switch (error.code) {
      case 'cancelled':
        return failure('cancelled', '附件读取已取消。')
      case 'invalid_request':
        return failure('invalid_input', '附件请求无效，请重新选择。')
      case 'selection_invalid':
        return failure('denied', '附件授权无效、已使用或已过期，请重新选择。')
      case 'unsupported_type':
        return failure('invalid_input', '附件类型、编码或图片格式不受支持。')
      case 'sensitive_path':
        return failure('denied', '本地安全策略禁止发送该附件。')
      case 'file_too_large':
      case 'total_too_large':
        return failure('invalid_input', '附件超过本地安全大小限制。')
      case 'file_unavailable':
      case 'file_changed':
        return failure('conflict', '附件不可用或在选择后发生变化，请重新选择。')
      case 'invalid_configuration':
        return failure('runtime_error', '附件读取服务不可用，请重试。', true)
    }
  }
  if (error instanceof ImageResultStoreError) {
    return error.code === 'invalid_image'
      ? failure('runtime_error', '模型返回的图片未通过本地安全校验。')
      : failure('not_ready', '图片临时存储容量不可用，请稍后重试。', true)
  }
  if (error instanceof ProjectInitError) {
    switch (error.code) {
      case 'invalid_request':
        return failure('invalid_input', 'Project initialization request is invalid.')
      case 'draft_capacity_exceeded':
        return failure('not_ready', 'Too many project drafts are pending. Try again later.', true)
      case 'draft_unavailable':
        return failure('denied', 'The project draft is invalid or expired. Prepare it again.')
      case 'workspace_unavailable':
        return failure('not_found', 'The authorized workspace is unavailable. Select it again.')
      case 'workspace_changed':
      case 'target_changed':
        return failure('conflict', 'The workspace or AGENTS.md changed after preview. Prepare a new draft.')
      case 'target_invalid':
        return failure('denied', 'The existing AGENTS.md target does not meet local safety requirements.')
      case 'cancelled':
        return failure('cancelled', 'Project initialization was cancelled.')
      case 'committed_cleanup_failed':
        return failure(
          'runtime_error',
          'AGENTS.md was committed, but temporary cleanup did not finish safely. Do not retry this draft; inspect the file before preparing another draft.'
        )
      case 'summary_failed':
      case 'write_failed':
      case 'invalid_options':
        return failure('runtime_error', 'Project initialization could not be completed safely.', true)
    }
  }
  if (error instanceof SelectionTokenError) {
    return error.code === 'invalid_selection' || error.code === 'invalid_owner'
      ? failure('invalid_input', '本地选择无效，请重新选择。')
      : failure('runtime_error', '无法创建安全的本地选择授权。', true)
  }
  if (error instanceof WorkspaceOpenerError) {
    switch (error.code) {
      case 'invalid_request':
        return failure('invalid_input', '工作区打开请求无效。')
      case 'unsupported_platform':
        return failure('not_ready', '当前系统暂不支持打开本机应用。')
      case 'opener_unavailable':
        return failure('not_found', '所选本机应用不可用，请重新检测。')
      case 'workspace_unavailable':
        return failure('not_found', '工作区目录当前不可用，请重新选择。')
      case 'workspace_changed':
        return failure('conflict', '工作区在选择后发生变化，请重新选择。')
      case 'launch_failed':
        return failure('runtime_error', '本机应用未能启动，请重新检测后再试。', true)
    }
  }
  if (error instanceof WorkspaceEnvironmentError) {
    switch (error.code) {
      case 'invalid_request':
        return failure('invalid_input', '工作区状态请求无效。')
      case 'workspace_unavailable':
        return failure('not_found', '工作区授权已失效，请重新选择。')
      case 'workspace_changed':
        return failure('conflict', '工作区在选择后发生变化，请重新选择。')
    }
  }
  if (error instanceof WorkspaceToolError) {
    if (error.code === 'cancelled') return failure('cancelled', '本地工作区操作已取消。')
    if (['invalid_request', 'invalid_relative_path'].includes(error.code)) {
      return failure('invalid_input', '工作区工具请求无效。')
    }
    if (['workspace_unavailable', 'path_not_found'].includes(error.code)) {
      return failure('not_found', '工作区或目标文件不可用。')
    }
    if (
      [
        'sensitive_path',
        'path_outside_workspace',
        'reparse_point_rejected',
        'hard_link_rejected'
      ].includes(error.code)
    ) {
      return failure('denied', '工作区安全策略拒绝了该路径。')
    }
    return failure('runtime_error', '工作区工具未能安全完成。', error.retryable)
  }
  if (error instanceof PendingTurnStartError) {
    switch (error.code) {
      case 'invalid_request_id':
        return failure('invalid_input', 'Turn start request is invalid.')
      case 'duplicate_request':
        return failure('conflict', 'This turn start request is already pending.')
      case 'capacity_exceeded':
        return failure('not_ready', 'Too many turn starts are pending.', true)
      case 'cancelled':
        return failure('cancelled', 'Turn start was cancelled.')
    }
  }
  if (error instanceof TurnRegistryError) {
    switch (error.code) {
      case 'duplicate_active_turn':
        return failure('conflict', '该任务已有一个正在运行的请求。')
      case 'active_turn_capacity':
        return failure('not_ready', '并发请求已达到安全上限，请稍后重试。', true)
      case 'invalid_task_id':
        return failure('invalid_input', '任务标识无效。')
      case 'invalid_options':
      case 'turn_id_unavailable':
        return failure('runtime_error', '无法创建安全的请求标识，请重试。', true)
    }
  }
  if (error instanceof ModelCatalogError) {
    switch (error.code) {
      case 'invalid_endpoint':
      case 'invalid_credential':
        return failure('invalid_input', '模型 endpoint 或 API Key 无效。')
      case 'timeout':
        return failure('runtime_error', '读取模型目录超时，请重试。', true)
      case 'network_error':
        return failure('runtime_error', '无法连接已确认的模型 endpoint。', true)
      case 'remote_rejected':
        return failure('runtime_error', '模型 endpoint 拒绝了目录请求，请检查 API Key 和服务状态。', true)
      case 'response_too_large':
      case 'invalid_response':
        return failure('runtime_error', '模型目录响应不符合安全格式。')
    }
  }
  if (error instanceof CapabilityRegistryError) {
    return error.code === 'invalid_input'
      ? failure('invalid_input', 'Capability request is invalid.')
      : failure('runtime_error', 'Capability discovery is temporarily unavailable.', true)
  }
  if (error instanceof CapabilityGrantStoreError) {
    return error.code === 'invalid_binding' || error.code === 'invalid_options'
      ? failure('invalid_input', 'Capability authorization is invalid.')
      : failure('runtime_error', 'Capability authorization is temporarily unavailable.', true)
  }
  return internalFailure()
}

// Mirrors MAX_APPROVAL_DETAIL_CHARACTERS in the shared agent event validator:
// an over-long detail would make the renderer reject the whole approval request
// and leave the agent waiting on a prompt that never appears.
const MAX_APPROVAL_DETAIL_CHARACTERS = 8 * 1024

function boundApprovalDetailForRenderer(detail: string): string {
  return detail.length <= MAX_APPROVAL_DETAIL_CHARACTERS
    ? detail
    : `${detail.slice(0, MAX_APPROVAL_DETAIL_CHARACTERS - 16)}\n…（已截断）`
}

function redactAgentEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'assistant-delta':
      return { ...event, text: redactSensitiveContent(event.text) }
    case 'image-result':
      return event
    case 'terminal-output':
      // Live terminal output is sent directly by the TerminalService callbacks
      // and never reaches this function today. Keep the branch safe anyway:
      // redactSensitiveText would cap each chunk at 600 characters and rewrite
      // paths, which destroys interactive TUI frames. Credential-only redaction
      // masks printed secrets without breaking the stream; the slice keeps a
      // lengthened chunk inside the renderer validator's 16KB bound.
      return { ...event, data: redactCredentialContent(event.data).slice(0, 16 * 1024) }
    case 'turn-status':
      return event.message ? { ...event, message: redactSensitiveText(event.message) } : event
    case 'subagent-status':
      return {
        ...event,
        label: redactSensitiveText(event.label),
        ...(event.detail === undefined ? {} : { detail: redactSensitiveText(event.detail) })
      }
    case 'tool-status':
      return { ...event, label: redactSensitiveText(event.label) }
    case 'approval-request':
      return {
        ...event,
        label: redactSensitiveText(event.label),
        // The approval detail is a multi-line command or diff preview. Redacting
        // it with redactSensitiveText would cut it to a single short message and
        // leave the user approving an operation they cannot actually read.
        ...(event.detail === undefined
          ? {}
          : { detail: boundApprovalDetailForRenderer(redactSensitiveContent(event.detail)) })
      }
    case 'usage':
      return event
  }
}
