import { homedir } from 'node:os'
import { join } from 'node:path'

import { ConsentStore } from '../security/consent-store'
import { SecureStore, createElectronSafeStorageCipher } from '../security/secure-store'
import { AccessProfileService, type AccessProfileStorage } from './access-profile-service'
import {
  ConversationHistoryService,
  type ConversationHistoryStorage
} from './conversation-history-service'
import { RemoteModelCatalogService } from './model-catalog'
import {
  SecureRelayCredentialStorage,
  type RelayCredentialStringStore
} from './relay-credential-storage'
import {
  RelayService,
  type RelayEncryptedCredentialStorage,
  type RelayStoredCredential
} from './relay-service'
import { AnthropicMessagesClient } from './anthropic-messages-client'
import { OpenAICompatibleChatCompletionsClient } from './chat-completions-client'
import { GeminiContentClient } from './gemini-content-client'
import { OpenAICompatibleImagesClient } from './images-client'
import { OpenAICompatibleResponsesClient } from './responses-client'
import { ExtensionHost } from './extension-host'
import {
  AgentWorkspaceSessionService,
  type AgentWorkspaceSessionStorage
} from './agent-workspace-session-service'
import { CodexAppServerHistoryService } from './codex-app-server-history-service'
import { ExternalProviderHistoryService } from './external-provider-history-service'
import {
  WorkspaceChangeSession,
  type WorkspaceChangeStorage
} from './workspace-change-session'
import {
  AgentTaskSupervisor,
  type BackgroundTaskStorage
} from './background-task-manager'

/** DPAPI-backed storage for persisted "always allow" approval scopes. */
export interface ApprovalScopeStorage {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

export interface MainBackendServices {
  profiles: AccessProfileService
  conversations: ConversationHistoryService
  consents: ConsentStore
  approvalScopes: ApprovalScopeStorage
  modelCatalog: RemoteModelCatalogService
  chatCompletions: OpenAICompatibleChatCompletionsClient
  responses: OpenAICompatibleResponsesClient
  anthropic: AnthropicMessagesClient
  gemini: GeminiContentClient
  images: OpenAICompatibleImagesClient
  relay: RelayService
  extensions: ExtensionHost
  agentWorkspaces: AgentWorkspaceSessionService
  codexHistory: CodexAppServerHistoryService
  externalHistory: ExternalProviderHistoryService
  workspaceChanges: WorkspaceChangeSession
  agentTaskSupervisor: AgentTaskSupervisor
}

export interface MainBackendServiceOptions {
  relayServerOrigin?: string
  documentsRoot?: string
}

export async function createMainBackendServices(
  userDataPath: string,
  options: MainBackendServiceOptions = {}
): Promise<MainBackendServices> {
  let profileStorage: AccessProfileStorage
  let conversationStorage: ConversationHistoryStorage
  let agentWorkspaceStorage: AgentWorkspaceSessionStorage
  let workspaceChangeStorage: WorkspaceChangeStorage
  let backgroundTaskStorage: BackgroundTaskStorage
  let relayCredentialStorage: RelayEncryptedCredentialStorage
  let approvalScopeStorage: ApprovalScopeStorage
  try {
    const cipher = await createElectronSafeStorageCipher()
    profileStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'access-profiles.json'),
      purpose: 'access-profiles',
      cipher
    })
    conversationStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'conversation-history.json'),
      purpose: 'conversation-history',
      cipher
    })
    agentWorkspaceStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'agent-workspace-sessions.json'),
      purpose: 'agent-workspace-sessions',
      cipher
    })
    workspaceChangeStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'workspace-change-sessions.json'),
      purpose: 'workspace-change-sessions',
      cipher
    })
    backgroundTaskStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'agent-task-supervisor.json'),
      purpose: 'agent-task-supervisor',
      cipher
    })
    const relayStringStore: RelayCredentialStringStore = new SecureStore({
      filePath: join(userDataPath, 'secure', 'relay-device-credential.json'),
      purpose: 'relay-device-credential',
      cipher
    })
    relayCredentialStorage = new SecureRelayCredentialStorage(relayStringStore)
    approvalScopeStorage = new SecureStore({
      filePath: join(userDataPath, 'secure', 'approval-session-scopes.json'),
      purpose: 'approval-session-scopes',
      cipher
    })
  } catch {
    // Keep the application usable for actionable diagnostics, but never fall
    // back to plaintext or release an existing credential when DPAPI is unavailable.
    profileStorage = failClosedStorage()
    conversationStorage = failClosedStorage()
    agentWorkspaceStorage = failClosedStorage()
    workspaceChangeStorage = failClosedStorage()
    backgroundTaskStorage = failClosedStorage()
    relayCredentialStorage = failClosedStorage()
    approvalScopeStorage = failClosedStorage()
  }

  const conversations = new ConversationHistoryService(conversationStorage)
  // Crash recovery must never block or fail startup; an unreadable document
  // surfaces through the normal history error paths later.
  void conversations.settleInterruptedStreaming().catch(() => undefined)
  const agentWorkspaces = new AgentWorkspaceSessionService({
    documentsRoot: options.documentsRoot ?? join(userDataPath, 'Documents'),
    storage: agentWorkspaceStorage
  })
  const documentsRoot = options.documentsRoot ?? join(userDataPath, 'Documents')
  return {
    profiles: new AccessProfileService(profileStorage),
    conversations,
    consents: new ConsentStore(),
    approvalScopes: approvalScopeStorage,
    modelCatalog: new RemoteModelCatalogService(),
    chatCompletions: new OpenAICompatibleChatCompletionsClient(),
    responses: new OpenAICompatibleResponsesClient(),
    anthropic: new AnthropicMessagesClient(),
    gemini: new GeminiContentClient(),
    images: new OpenAICompatibleImagesClient(),
    extensions: new ExtensionHost(),
    agentWorkspaces,
    workspaceChanges: new WorkspaceChangeSession({
      history: conversations,
      workspaces: agentWorkspaces,
      storage: workspaceChangeStorage,
      snapshotRoot: join(userDataPath, 'workspace-changes', 'snapshots'),
      worktreeRoot: join(documentsRoot, 'Codex', 'Worktrees')
    }),
    codexHistory: new CodexAppServerHistoryService(),
    externalHistory: new ExternalProviderHistoryService({ homeDirectory: homedir() }),
    agentTaskSupervisor: new AgentTaskSupervisor({ storage: backgroundTaskStorage }),
    relay: new RelayService({
      credentialStorage: relayCredentialStorage,
      ...(options.relayServerOrigin === undefined
        ? {}
        : { serverOrigin: options.relayServerOrigin })
    })
  }
}

function failClosedStorage(): AccessProfileStorage &
  ConversationHistoryStorage &
  AgentWorkspaceSessionStorage &
  WorkspaceChangeStorage &
  BackgroundTaskStorage &
  RelayEncryptedCredentialStorage {
  return {
    async read(): Promise<never> {
      throw new Error('Secure profile storage is unavailable.')
    },
    async write(): Promise<never> {
      throw new Error('Secure profile storage is unavailable.')
    },
    async loadCredential(): Promise<never> {
      throw new Error('Secure relay credential storage is unavailable.')
    },
    async saveCredential(_credential: RelayStoredCredential): Promise<never> {
      throw new Error('Secure relay credential storage is unavailable.')
    },
    async clearCredential(): Promise<never> {
      throw new Error('Secure relay credential storage is unavailable.')
    }
  }
}
