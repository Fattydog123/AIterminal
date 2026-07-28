import { join } from 'node:path'

import { dialog, type BrowserWindow } from 'electron'

import { channels } from '../../studio/shared/contracts'
import type { ConsentStore } from '../security/consent-store'
import { EndpointConsentCoordinator } from '../services/endpoint-consent-coordinator'
import type { RelayService } from '../services/relay-service'
import type { RemoteModelCatalogService } from '../services/model-catalog'
import type { OpenAICompatibleResponsesClient } from '../services/responses-client'
import type { OpenAICompatibleChatCompletionsClient } from '../services/chat-completions-client'
import type { AnthropicMessagesClient } from '../services/anthropic-messages-client'
import type { GeminiContentClient } from '../services/gemini-content-client'
import { AssetProtocol } from './assetProtocol'
import { StudioAccountProviderAdapter } from './account-providers'
import { StudioImageCapabilityStore } from './image-capability-store'
import { StudioProviderSnapshotStore } from './provider-snapshot-store'
import { redactValue } from './errors'
import { registerIpc } from './ipc'
import { StudioPathTokenStore } from './path-token-store'
import { ProjectStore } from './projects'
import { ProviderImportController } from './providerImports'
import { ProviderStore } from './providers'
import { WorkflowRunner } from './runner'
import {
  NativeStudioCopilotModelAdapter,
  StudioCopilotService,
} from './studio-copilot-service'

export interface StudioRuntimeOptions {
  window: BrowserWindow
  userDataPath: string
  managedProjectsRoot: string
  consents: ConsentStore
  relay: RelayService
  modelCatalog: RemoteModelCatalogService
  responses: OpenAICompatibleResponsesClient
  chatCompletions: OpenAICompatibleChatCompletionsClient
  anthropic: AnthropicMessagesClient
  gemini: GeminiContentClient
  isSessionUnlocked(): boolean
  allowedRendererOrigin?: string
}

export interface StudioRuntime {
  shutdown(): Promise<void>
}

async function requestStudioEndpointConsent(
  window: BrowserWindow,
  endpoint: string
): Promise<boolean> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '允许 Studio 连接外部接口？',
    message: 'Studio 准备连接以下接口',
    detail: `${endpoint}\n\n工作流提示词、输入图片和必要的生成参数可能发送到该服务，服务方也可能产生费用。此授权仅在本次 AI-terminal 会话内有效。`,
    buttons: ['本次会话允许', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0
}

export async function createStudioRuntime(options: StudioRuntimeOptions): Promise<StudioRuntime> {
  const stateDirectory = join(options.userDataPath, 'studio', 'state')
  const projects = new ProjectStore(stateDirectory, options.managedProjectsRoot)
  const imageCapabilities = new StudioImageCapabilityStore(
    options.relay.serverOrigin,
    Date.now,
    join(stateDirectory, 'image-capabilities.json'),
  )
  const providerSnapshots = new StudioProviderSnapshotStore(
    options.relay.serverOrigin,
    join(stateDirectory, 'account-provider-snapshot.json'),
    Date.now,
  )
  const providers = new ProviderStore(
    stateDirectory,
    new StudioAccountProviderAdapter(
      options.relay,
      Date.now,
      imageCapabilities,
      providerSnapshots,
    )
  )
  await Promise.all([projects.initialize(), providers.initialize()])

  const paths = new StudioPathTokenStore()
  const providerImports = new ProviderImportController(providers)
  const assets = new AssetProtocol(projects)
  const endpointConsent = new EndpointConsentCoordinator(
    options.consents,
    (endpoint) => requestStudioEndpointConsent(options.window, endpoint)
  )
  const copilot = new StudioCopilotService({
    relay: options.relay,
    modelCatalog: options.modelCatalog,
    providers,
    adapter: new NativeStudioCopilotModelAdapter({
      responses: options.responses,
      chatCompletions: options.chatCompletions,
      anthropic: options.anthropic,
      gemini: options.gemini,
    }),
    ensureEndpointConsent: async (endpoint) => {
      await endpointConsent.ensure(endpoint)
    },
  })
  const runner = new WorkflowRunner(projects, providers, (event) => {
    if (options.window.isDestroyed() || options.window.webContents.isDestroyed()) return
    options.window.webContents.send(channels.runEvent, redactValue(event))
  }, async (endpoint) => {
    await endpointConsent.ensure(endpoint)
  })

  assets.install()
  let registration: ReturnType<typeof registerIpc>
  try {
    registration = registerIpc({
      projects,
      providers,
      providerImports,
      runner,
      copilot,
      assets,
      paths,
      getWindow: () => options.window,
      isSessionUnlocked: options.isSessionUnlocked,
      ensureEndpointConsent: async (endpoints) => {
        const uniqueEndpoints = [...new Set(endpoints)]
        for (const endpoint of uniqueEndpoints) await endpointConsent.ensure(endpoint)
      },
      ...(options.allowedRendererOrigin === undefined
        ? {}
        : { allowedRendererOrigin: options.allowedRendererOrigin })
    })
  } catch (error) {
    endpointConsent.clear()
    paths.revokeAll()
    assets.uninstall()
    throw error
  }

  let shutdownPromise: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    registration.dispose()
    paths.revokeAll()
    endpointConsent.clear()
    shutdownPromise = runner.shutdown().finally(() => assets.uninstall())
    return shutdownPromise
  }
  options.window.webContents.once('destroyed', () => {
    void shutdown()
  })
  return { shutdown }
}
