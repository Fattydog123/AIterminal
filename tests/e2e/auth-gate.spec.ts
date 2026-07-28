import { expect, test, type Page } from '@playwright/test'

type AuthScenario = 'locked' | 'restored' | 'restored-delayed' | 'device' | 'device-history' | 'denied' | 'open-fails-once' | 'signed-in' | 'signed-in-model-delay' | 'signed-in-capability-delay' | 'signed-in-agent-fallback' | 'signed-in-agent-error' | 'signed-in-token-groups' | 'signed-in-studio-candidates'

async function installAuthHarness(page: Page, scenario: AuthScenario): Promise<void> {
  await page.addInitScript((selectedScenario) => {
    const calls: string[] = []
    const hasRestoredHistory = selectedScenario === 'restored'
      || selectedScenario === 'restored-delayed'
      || selectedScenario === 'device-history'
    const bootstrapResolvers: Array<() => void> = []
    const modelResolvers: Array<() => void> = []
    const capabilityResolvers: Array<() => void> = []
    let defaultCapabilityRequests = 0
    let delayedChatPending = false
    let authenticated = selectedScenario === 'restored-delayed'
      || selectedScenario === 'signed-in'
      || selectedScenario === 'signed-in-model-delay'
      || selectedScenario === 'signed-in-capability-delay'
      || selectedScenario === 'signed-in-agent-fallback'
      || selectedScenario === 'signed-in-agent-error'
      || selectedScenario === 'signed-in-token-groups'
      || selectedScenario === 'signed-in-studio-candidates'
    let endpointConfirmed = authenticated
    let openAttempts = 0
    let vipTokenActive = true
    let agentEventListener: ((event: unknown) => void) | null = null
    const workspaceToken = `ws_${'a'.repeat(43)}`
    const initDraftHandle = `draft_${'b'.repeat(43)}`
    const reviewHandle = `review_${'r'.repeat(43)}`

    const connection = () => ({
      endpoint: 'https://www.wzhxiaozhan.top',
      endpointConsent: {
        status: endpointConfirmed ? 'confirmed' as const : 'required' as const,
        endpointLabel: 'https://www.wzhxiaozhan.top',
      },
      authenticated,
      deviceId: authenticated ? 'device_auth_gate_e2e' : null,
    })

    const success = <T,>(value: T) => ({ ok: true as const, value })
    const restoredTask = {
      id: 'task:11111111-1111-4111-8111-111111111111',
      projectId: 'project:local-history',
      title: '恢复的本机任务',
      mode: 'chat' as const,
      updatedAt: '2026-07-17T08:00:00.000Z',
      status: 'idle' as const,
    }
    const bootstrap = {
      schemaVersion: 1,
      app: { name: 'AI终点站', version: '0.1.0', platform: 'win32' as const, preview: false },
      runtime: { status: 'ready' as const, protocolVersion: 1, message: 'Auth gate E2E runtime.' },
      security: {
        rendererHasNodeAccess: false as const,
        rendererNetworkAccess: false as const,
        secretsExposedToRenderer: false as const,
        endpointConsentRequired: true,
        localToolConsentRequired: true,
      },
      defaults: {
        mode: 'agent' as const,
        approvalMode: 'request' as const,
        reasoning: 'auto' as const,
        webSearch: false,
        imageGeneration: false,
        activeProfileHandle: 'relay:wzh-server',
        activeModelId: '',
      },
      profiles: [{
        credentialHandle: 'relay:wzh-server',
        name: 'wzh-server',
        description: '账户会话',
        baseUrl: 'https://www.wzhxiaozhan.top/v1',
        hasKey: true,
        isCurrent: true,
        targets: ['codex' as const],
      }],
      models: [],
      projects: hasRestoredHistory ? [{
        id: 'project:local-history',
        name: '本地历史',
        tasks: [restoredTask],
      }] : [],
      activeTaskId: hasRestoredHistory ? restoredTask.id : '',
    }
    let studioProviders = [
      {
        id: `account-group-${'a'.repeat(24)}`,
        name: '登录账号 · default',
        kind: 'openai-compatible' as const,
        baseUrl: 'https://www.wzhxiaozhan.top/v1',
        defaultModel: 'gpt-image-default',
        timeoutMs: 300_000,
        maxImageBytes: 104_857_600,
        proxyMode: 'system' as const,
        hasSecret: true,
        maskedSecret: '账户会话',
        managedBy: 'ai-terminal-account' as const,
        groupId: 'default',
        availableModels: ['gpt-image-default', 'gpt-image-shared'],
        description: '默认分组',
      },
      {
        id: `account-group-${'b'.repeat(24)}`,
        name: '登录账号 · vip',
        kind: 'openai-compatible' as const,
        baseUrl: 'https://www.wzhxiaozhan.top/v1',
        defaultModel: 'gpt-image-vip',
        timeoutMs: 300_000,
        maxImageBytes: 104_857_600,
        proxyMode: 'system' as const,
        hasSecret: true,
        maskedSecret: '账户会话',
        managedBy: 'ai-terminal-account' as const,
        groupId: 'vip',
        availableModels: selectedScenario === 'signed-in-studio-candidates'
          ? ['gpt-image-vip', 'gpt-image-shared', 'gpt-image-vip-high']
          : ['gpt-image-vip', 'gpt-image-shared'],
        description: '高优先级分组',
      },
    ]

    Object.defineProperty(globalThis, '__authGateE2eCalls', {
      value: calls,
      configurable: true,
    })
    Object.defineProperty(globalThis, '__resolveAuthGateBootstrap', {
      value: () => {
        for (const resolve of bootstrapResolvers.splice(0)) resolve()
      },
      configurable: true,
    })
    Object.defineProperty(globalThis, '__resolveAuthGateModels', {
      value: () => {
        for (const resolve of modelResolvers.splice(0)) resolve()
      },
      configurable: true,
    })
    Object.defineProperty(globalThis, '__resolveAuthGateCapabilities', {
      value: () => {
        for (const resolve of capabilityResolvers.splice(0)) resolve()
      },
      configurable: true,
    })
    Object.defineProperty(globalThis, '__emitAuthGateAgentEvent', {
      value: (event: unknown) => agentEventListener?.(event),
      configurable: true,
    })
    Object.defineProperty(window, 'onekey', {
      configurable: true,
      value: {
        app: {
          getBootstrap: async () => {
            calls.push('bootstrap')
            if (selectedScenario === 'restored-delayed') {
              await new Promise<void>((resolve) => bootstrapResolvers.push(resolve))
            }
            return success(bootstrap)
          },
        },
        models: {
          list: async (input: { profileHandle: string; mode: 'chat' | 'agent'; groupId: string | null }) => {
            calls.push(`models:${input.profileHandle}:${input.mode}:${input.groupId ?? 'direct'}`)
            if (selectedScenario === 'signed-in-model-delay' && input.mode === 'chat') {
              delayedChatPending = true
              await new Promise<void>((resolve) => modelResolvers.push(resolve))
              delayedChatPending = false
              calls.push('models:resolved:chat')
            }
            if (
              selectedScenario === 'signed-in-agent-fallback' &&
              input.mode === 'agent' &&
              input.groupId === 'default'
            ) {
              return success([])
            }
            if (
              selectedScenario === 'signed-in-agent-error' &&
              input.mode === 'agent' &&
              input.groupId === 'default'
            ) {
              return {
                ok: false as const,
                error: {
                  code: 'runtime_error' as const,
                  message: '所选分组模型目录读取失败，请重试。',
                  retryable: true,
                },
              }
            }
            const primaryModelId = input.groupId === 'vip'
              ? 'gpt-5.6-sol-vip'
              : input.groupId === 'archive'
                ? 'tokenless-online-model'
                : 'gpt-5.6-sol-standard'
            const responseModels = [
              {
                id: primaryModelId,
                label: primaryModelId,
                provider: 'openai-compatible' as const,
                wireMode: 'standard' as const,
                endpointTypes: ['openai-response' as const],
                declaredEndpointTypes: ['openai-response' as const],
                preferredChatEndpoint: 'openai-response' as const,
                preferredChatTransport: 'responses' as const,
                modes: ['chat' as const, 'agent' as const],
                reasoning: ['auto' as const, 'high' as const, 'ultra' as const],
                capabilities: {
                  attachments: false,
                  imageInput: false,
                  imageGeneration: true,
                  subagents: false,
                  toolUse: false,
                  webSearch: true,
                },
                declaredCapabilities: { imageGeneration: true, webSearch: true },
                source: 'remote' as const,
              },
              {
                id: 'gpt-5.6-terra',
                label: 'gpt-5.6-terra',
                provider: 'openai-compatible' as const,
                wireMode: 'lite' as const,
                endpointTypes: ['openai-response' as const],
                declaredEndpointTypes: ['openai-response' as const],
                preferredChatEndpoint: 'openai-response' as const,
                preferredChatTransport: 'responses' as const,
                modes: ['chat' as const, 'agent' as const],
                reasoning: ['auto' as const, 'high' as const],
                capabilities: {
                  attachments: false,
                  imageInput: false,
                  imageGeneration: false,
                  subagents: false,
                  toolUse: false,
                  webSearch: false,
                },
                declaredCapabilities: {},
                source: 'remote' as const,
              },
            ]
            const chatOnlyModels = input.mode === 'chat' ? [
              {
                id: 'openai-chat-test',
                label: 'openai-chat-test',
                provider: 'openai-compatible' as const,
                wireMode: 'standard' as const,
                endpointTypes: ['openai' as const],
                declaredEndpointTypes: ['openai' as const],
                preferredChatEndpoint: 'openai' as const,
                preferredChatTransport: 'chat-completions' as const,
                modes: ['chat' as const],
                reasoning: ['auto' as const],
                capabilities: { attachments: true, imageInput: true, imageGeneration: false, subagents: false, toolUse: false, webSearch: false },
                declaredCapabilities: { attachments: true, imageInput: true },
                source: 'remote' as const,
              },
              {
                id: 'claude-native-test',
                label: 'claude-native-test',
                provider: 'anthropic-compatible' as const,
                wireMode: 'standard' as const,
                endpointTypes: ['anthropic' as const],
                declaredEndpointTypes: ['anthropic' as const],
                preferredChatEndpoint: 'anthropic' as const,
                preferredChatTransport: 'anthropic' as const,
                modes: ['chat' as const],
                reasoning: ['auto' as const],
                capabilities: { attachments: false, imageInput: false, imageGeneration: false, subagents: false, toolUse: false, webSearch: false },
                declaredCapabilities: {},
                source: 'remote' as const,
              },
              {
                id: 'gemini-native-test',
                label: 'gemini-native-test',
                provider: 'gemini-compatible' as const,
                wireMode: 'standard' as const,
                endpointTypes: ['gemini' as const],
                declaredEndpointTypes: ['gemini' as const],
                preferredChatEndpoint: 'gemini' as const,
                preferredChatTransport: 'gemini' as const,
                modes: ['chat' as const],
                reasoning: ['auto' as const],
                capabilities: { attachments: false, imageInput: false, imageGeneration: false, subagents: false, toolUse: false, webSearch: false },
                declaredCapabilities: {},
                source: 'remote' as const,
              },
              {
                id: 'gpt-image-2',
                label: 'gpt-image-2',
                provider: 'openai-compatible' as const,
                wireMode: 'standard' as const,
                endpointTypes: ['image-generation' as const],
                declaredEndpointTypes: ['image-generation' as const],
                preferredChatEndpoint: 'image-generation' as const,
                preferredChatTransport: 'images' as const,
                modes: ['chat' as const],
                reasoning: ['auto' as const],
                capabilities: { attachments: false, imageInput: false, imageGeneration: true, subagents: false, toolUse: false, webSearch: false },
                declaredCapabilities: { imageGeneration: true },
                source: 'remote' as const,
              },
              {
                id: 'responses-images-test',
                label: 'responses-images-test',
                provider: 'openai-compatible' as const,
                wireMode: 'standard' as const,
                endpointTypes: ['openai-response' as const, 'image-generation' as const],
                declaredEndpointTypes: ['openai-response' as const, 'image-generation' as const],
                preferredChatEndpoint: 'openai-response' as const,
                preferredChatTransport: 'responses' as const,
                modes: ['chat' as const, 'agent' as const],
                reasoning: ['auto' as const, 'high' as const],
                capabilities: { attachments: false, imageInput: false, imageGeneration: true, subagents: false, toolUse: true, webSearch: false },
                declaredCapabilities: { imageGeneration: true },
                source: 'remote' as const,
              },
            ] : []
            return success([...responseModels, ...chatOnlyModels])
          },
        },
        studio: {
          bootstrap: async () => {
            calls.push('studio:bootstrap')
            return {
              version: '0.1.0',
              platform: 'win32' as const,
              projects: [],
              providers: selectedScenario === 'signed-in-model-delay' && delayedChatPending ? [] : studioProviders,
            }
          },
          listProviders: async () => {
            calls.push('studio:list-providers')
            return studioProviders
          },
          onRunEvent: () => () => undefined,
        },
        capabilities: {
          list: async (input?: { category?: 'skills' | 'plugins'; workspaceToken?: string }) => {
            calls.push(input?.category ? `capabilities:${input.category}` : 'capabilities:default')
            if (!input?.category) {
              defaultCapabilityRequests += 1
              if (selectedScenario === 'signed-in-capability-delay' && defaultCapabilityRequests > 1) {
                calls.push('capabilities:scope-pending')
                await new Promise<void>((resolve) => capabilityResolvers.push(resolve))
                calls.push('capabilities:scope-resolved')
              }
            }
            return success({
              commands: selectedScenario === 'signed-in' ? [
                {
                  id: 'init' as const,
                  name: '/init',
                  description: '生成 AGENTS.md 项目规则草稿',
                  aliases: ['setup'],
                  scope: 'builtin' as const,
                  permissions: ['read' as const, 'write' as const, 'approval' as const],
                  safe: false,
                  availability: 'requires-approval' as const,
                },
                {
                  id: 'review' as const,
                  name: '/review',
                  description: '审查当前 Git 改动',
                  aliases: ['audit'],
                  scope: 'builtin' as const,
                  permissions: ['read' as const, 'execute' as const, 'approval' as const],
                  safe: false,
                  availability: 'requires-approval' as const,
                },
              ] : [],
              skills: [],
              plugins: [],
              session: { planMode: false, memoriesEnabled: true },
            })
          },
          execute: async (input: {
            id: string
            workspaceToken?: string
            draftHandle?: string
            projectInitAction?: 'commit' | 'discard'
            content?: string
          }) => {
            calls.push(`execute:${input.id}:${input.workspaceToken ?? 'none'}:${input.draftHandle ? 'draft' : 'prepare'}`)
            if (input.id === 'review' && input.workspaceToken === workspaceToken) {
              calls.push('review:armed')
              return success({
                id: 'review',
                status: 'preview' as const,
                message: 'Code review is armed for the next Agent turn.',
                reviewHandle,
                session: { planMode: false, memoriesEnabled: true },
              })
            }
            if (input.id === 'init' && input.workspaceToken === workspaceToken) {
              if (
                input.draftHandle === initDraftHandle &&
                input.projectInitAction === 'discard' &&
                input.content === undefined
              ) {
                calls.push('init:discard:handle-only')
                return success({
                  id: 'init',
                  status: 'completed' as const,
                  message: 'The AGENTS.md draft authorization was discarded.',
                })
              }
              if (
                input.draftHandle === initDraftHandle &&
                input.projectInitAction === 'commit' &&
                input.content === undefined
              ) {
                calls.push('init:commit:handle-only')
                return success({
                  id: 'init',
                  status: 'completed' as const,
                  message: 'AGENTS.md was atomically created from the approved draft.',
                  projectInit: {
                    state: 'committed' as const,
                    relativePath: 'AGENTS.md' as const,
                    revision: 'c'.repeat(64),
                    replaced: false,
                  },
                })
              }
              calls.push('init:preview')
              return success({
                id: 'init',
                status: 'preview' as const,
                message: 'AGENTS.md draft is ready for review. No file was changed.',
                projectInit: {
                  state: 'preview' as const,
                  draftHandle: initDraftHandle,
                  relativePath: 'AGENTS.md' as const,
                  content: '# AGENTS.md\n\n## Working rules\n\n- Keep changes scoped.\n',
                  contentSha256: 'd'.repeat(64),
                  target: 'create' as const,
                  expiresAt: Date.now() + 60_000,
                },
              })
            }
            return success({
              id: input.id,
              status: 'not-ready' as const,
              message: 'Capability unavailable in the auth harness.',
              session: { planMode: false, memoriesEnabled: true },
            })
          },
        },
        dialog: {
          selectWorkspace: async () => success({ workspaceToken, displayName: 'E2E workspace' }),
          selectAttachments: async () => success([]),
        },
        workspace: {
          listOpeners: async () => success({ openers: [], launchToken: `wl_${'e'.repeat(43)}` }),
          open: async () => success({ openerId: 'explorer' as const }),
        },
        window: {
          minimize: async () => success(null),
          toggleMaximize: async () => success(null),
          close: async () => success(null),
        },
        conversation: {
          create: async (input: { title?: string; mode: 'chat' | 'agent'; workspaceToken?: string }) => {
            calls.push(`conversation:create:${input.mode}:${input.workspaceToken ?? 'none'}`)
            return success({
              id: 'task:22222222-2222-4222-8222-222222222222',
              projectId: 'project:local-history',
              title: input.title ?? 'Review task',
              mode: input.mode,
              updatedAt: '2026-07-18T08:00:00.000Z',
              status: 'idle' as const,
            })
          },
          load: async (input: { taskId: string }) => {
            calls.push(`load:${input.taskId}`)
            return success({
              task: restoredTask,
              messages: [{
                id: 'message:restored',
                role: 'assistant' as const,
                content: '本机加密历史已恢复。',
                status: 'complete' as const,
                createdAt: '2026-07-17T08:00:00.000Z',
                updatedAt: '2026-07-17T08:00:00.000Z',
              }],
              events: [],
            })
          },
        },
        turn: {
          start: async (input: {
            mode: 'chat' | 'agent'
            prompt: string
            modelId: string
            workspaceToken?: string
            reviewHandle?: string
            attachmentTokens: string[]
            webSearch: boolean
            imageGeneration: boolean
          }) => {
            calls.push(`turn:start:${input.mode}:${input.prompt}:${input.workspaceToken ?? 'none'}:${input.attachmentTokens.length}`)
            calls.push(`turn:hosted:${input.modelId}:${Number(input.webSearch)}:${Number(input.imageGeneration)}`)
            if (Object.hasOwn(input, 'wireMode')) calls.push('turn:renderer-wire-mode')
            if (input.reviewHandle) calls.push(`turn:review-handle:${input.reviewHandle}`)
            return success({ turnId: `turn_${'f'.repeat(32)}` })
          },
          cancel: async () => success(null),
        },
        relay: {
          getConnection: async () => {
            calls.push(`connection:${authenticated ? 'in' : 'out'}`)
            return success(connection())
          },
          connect: async (input: { endpoint: string; confirmation: string }) => {
            calls.push(`connect:${input.endpoint}:${input.confirmation}`)
            endpointConfirmed = true
            if (selectedScenario === 'restored') authenticated = true
            return success(connection())
          },
          startDeviceAuthorization: async () => {
            calls.push('start')
            return success({
              sessionId: 'relay-session-auth-gate-e2e',
              userCode: 'GATE-E2E',
              verificationUri: 'https://www.wzhxiaozhan.top/desktop/authorize',
              expiresAt: '2026-07-17T12:00:00.000Z',
              intervalSeconds: 1,
            })
          },
          openDeviceAuthorization: async (input: { sessionId: string }) => {
            calls.push(`open:${input.sessionId}`)
            openAttempts += 1
            if (selectedScenario === 'open-fails-once' && openAttempts === 1) {
              return {
                ok: false as const,
                error: { code: 'runtime_error' as const, message: '无法打开授权页。', retryable: true },
              }
            }
            return success(null)
          },
          pollDeviceAuthorization: async () => {
            calls.push('poll')
            if (selectedScenario === 'denied') return success({ status: 'denied' as const })
            if (selectedScenario === 'open-fails-once') {
              return success({ status: 'pending' as const, retryAfterSeconds: 1 })
            }
            authenticated = true
            return success({ status: 'authenticated' as const, deviceId: 'device_auth_gate_e2e' })
          },
          signOut: async () => {
            calls.push('signOut')
            authenticated = false
            return success(null)
          },
          getBillingConfig: async () => success({
            quotaPerUnit: 500_000,
            displayInCurrency: true,
            quotaDisplayType: 'USD' as const,
            usdExchangeRate: 7.3,
            customCurrencySymbol: '¤',
            customCurrencyExchangeRate: 1,
          }),
          getOverview: async () => {
            calls.push('overview')
            const groups = selectedScenario === 'signed-in-token-groups'
              ? [
                  { id: 'default', ratio: 1, description: '默认分组' },
                  ...(vipTokenActive ? [{ id: 'vip', ratio: 1.5, description: '高优先级分组' }] : []),
                ]
              : [
                  { id: 'default', ratio: 1, description: '默认分组' },
                  { id: 'vip', ratio: 1.5, description: '高优先级分组' },
                ]
            if (selectedScenario === 'signed-in-token-groups') {
              calls.push(`overview-groups:${groups.map((group) => group.id).join('+')}`)
            }
            return success({
              account: { id: 7, username: 'demo-user', displayName: 'Profile Alias', email: null, group: 'default', status: 1, role: 1 },
              quota: { total: 100, used: 5, remaining: 95 },
              requestCount: 1,
              groups,
              models: [],
              updatedAt: new Date().toISOString(),
            })
          },
          listTokens: async () => {
            if (selectedScenario !== 'signed-in-token-groups') {
              return success({ page: 1, pageSize: 100, total: 0, items: [] })
            }
            const items = [
              {
                id: 1,
                name: 'Default access',
                maskedKey: 'sk-********',
                status: 'active' as const,
                remainQuota: 100,
                usedQuota: 0,
                unlimitedQuota: false,
                group: 'default',
                modelLimits: null,
                createdAt: null,
                lastUsedAt: null,
                expiresAt: null,
              },
              {
                id: 2,
                name: 'VIP access',
                maskedKey: 'sk-********',
                status: vipTokenActive ? 'active' as const : 'disabled' as const,
                remainQuota: 100,
                usedQuota: 0,
                unlimitedQuota: false,
                group: 'vip',
                modelLimits: null,
                createdAt: null,
                lastUsedAt: null,
                expiresAt: null,
              },
            ]
            return success({ page: 1, pageSize: 100, total: items.length, items })
          },
          updateTokenStatus: async (input: { tokenId: number; status: 'active' | 'disabled' }) => {
            calls.push(`token:update:${input.tokenId}:${input.status}`)
            if (selectedScenario === 'signed-in-token-groups' && input.tokenId === 2) {
              vipTokenActive = input.status === 'active'
            }
            return success({ tokenId: input.tokenId, status: input.status })
          },
          listUsage: async (input: { from: string; to: string }) => success({
            range: input,
            totals: { requests: 0, quota: 0, tokenUsed: 0 },
            records: [],
          }),
          listPricing: async () => success(selectedScenario === 'signed-in-token-groups'
            ? {
                models: [{
                  modelName: 'tokenless-online-model',
                  description: '服务端存在，但当前账户没有对应分组令牌',
                  owner: 'openai-compatible',
                  quotaType: 0,
                  modelRatio: 1,
                  modelPrice: 0,
                  completionRatio: 1,
                  cacheRatio: null,
                  imageRatio: null,
                  enabledGroups: ['archive'],
                  endpointTypes: ['openai-response'],
                  billingMode: 'ratio',
                }],
                groupRatios: { default: 1, vip: 1.5, archive: 0.8 },
                pricingVersion: 'token-group-e2e',
              }
            : { models: [], groupRatios: {}, pricingVersion: null }),
        },
        link: {
          openExternal: async () => {
            calls.push('openExternal')
            return success(null)
          },
        },
        onAgentEvent: (listener: (event: unknown) => void) => {
          calls.push('subscribe')
          agentEventListener = listener
          return () => {
            if (agentEventListener === listener) agentEventListener = null
            calls.push('unsubscribe')
          }
        },
      },
    })
  }, scenario)
}

async function authCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((globalThis as typeof globalThis & { __authGateE2eCalls?: string[] }).__authGateE2eCalls ?? [])])
}

async function resolveModelRequests(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = globalThis as typeof globalThis & { __resolveAuthGateModels?: () => void }
    control.__resolveAuthGateModels?.()
  })
}

async function resolveCapabilityRequests(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = globalThis as typeof globalThis & { __resolveAuthGateCapabilities?: () => void }
    control.__resolveAuthGateCapabilities?.()
  })
}

test('未登录时只挂载登录门禁，不初始化工作台', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await installAuthHarness(page, 'locked')
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '登录后继续工作' })).toBeVisible()
  await expect(page.getByText('https://www.wzhxiaozhan.top', { exact: true })).toBeVisible()
  await expect(page.getByText('首次登录会发送应用名称、Windows 系统和版本信息；登录后读取账户可用模型，并使用账户授权完成模型请求。', { exact: true })).toBeVisible()
  await expect(page.locator('.auth-gate')).not.toContainText(/Renderer|Electron Main|IPC|DPAPI|endpoint|fail-closed/u)
  await expect(page.getByRole('button', { name: '登录并进入工作台' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page.locator('.conversation-pane')).toHaveCount(0)
  await expect(page.locator('.composer')).toHaveCount(0)
  await expect(page.locator('.task-sidebar')).toHaveCount(0)
  expect(await authCalls(page)).not.toContain('bootstrap')
  expect(await authCalls(page)).not.toContain('subscribe')
  const geometry = await page.evaluate(() => {
    const login = document.querySelector<HTMLElement>('.auth-login')!.getBoundingClientRect()
    const workbench = document.querySelector<HTMLElement>('.auth-workbench')!.getBoundingClientRect()
    return {
      loginLeft: login.left,
      workbenchRight: workbench.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }
  })
  expect(geometry.loginLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.workbenchRight).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
})

test('未登录时不存在本地解锁旁路', async ({ page }) => {
  await installAuthHarness(page, 'locked')
  await page.goto('/')

  await expect(page.getByRole('button', { name: '使用 API Key 进入工作台' })).toHaveCount(0)
  await expect(page.locator('.auth-gate')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  expect(await page.evaluate(() => 'session' in window.onekey)).toBe(false)
  expect(await authCalls(page)).not.toContain('bootstrap')
})

test('设备码授权成功后自动进入工作台', async ({ page }) => {
  await installAuthHarness(page, 'device')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('open:')).length).toBe(1)
  await page.getByRole('button', { name: '重新打开授权页' }).click()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('open:')).length).toBe(2)
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.sidebar-full .account-copy strong')).toHaveText('demo-user')
  await expect(page.locator('.sidebar-full .account-copy small')).toHaveText('模型已连接')
  await expect(page.locator('.conversation-pane')).toBeVisible()
  await expect(page.locator('.auth-gate')).toHaveCount(0)

  const calls = await authCalls(page)
  const connectCall = 'connect:https://www.wzhxiaozhan.top:connect'
  const openCall = 'open:relay-session-auth-gate-e2e'
  expect(calls).toContain(connectCall)
  expect(calls).toContain('start')
  expect(calls).toContain(openCall)
  expect(calls).toContain('poll')
  expect(calls).toContain('bootstrap')
  expect(calls).toContain('overview')
  expect(calls).toContain('models:relay:wzh-server:agent:default')
  expect(calls).not.toContain('openExternal')
  expect(calls.indexOf(connectCall)).toBeLessThan(calls.indexOf('start'))
  expect(calls.indexOf('start')).toBeLessThan(calls.indexOf(openCall))
  expect(calls.indexOf(openCall)).toBeLessThan(calls.indexOf('poll'))
  expect(calls.indexOf('poll')).toBeLessThan(calls.indexOf('bootstrap'))
})

test('接入分组在 Agent 与 Chat 间共享并刷新对应模型目录', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('capabilities:default')).toBe(true)
  expect((await authCalls(page)).some((entry) => entry === 'capabilities:skills' || entry === 'capabilities:plugins')).toBe(false)
  const groupButton = page.getByRole('button', { name: '接入分组：default' })
  await expect(groupButton).toBeVisible()
  await groupButton.click()
  await page.getByRole('menuitemradio', { name: /vip/ }).click()
  await expect(page.getByRole('button', { name: '接入分组：vip' })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:agent:vip')).toBe(true)
  await expect(page.locator('.model-button')).toContainText('5.6-sol-vip')

  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect(page.getByRole('button', { name: '接入分组：vip' })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:vip')).toBe(true)
})

test('Agent 执行摘要突出当前步骤并在窄窗口保持清晰', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 720 })
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.model-button')).toContainText('5.6-sol-standard')
  await page.getByRole('button', { name: '选择工作区' }).click()
  await expect(page.locator('.workspace-name')).toHaveText('E2E workspace')
  await page.getByRole('textbox', { name: '消息' }).fill('检查真实执行轨迹')
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(async () => (await authCalls(page)).some((entry) => entry.startsWith('turn:start:agent:检查真实执行轨迹:'))).toBe(true)

  const turnId = `turn_${'f'.repeat(32)}`
  const emit = async (events: unknown[]) => page.evaluate((items) => {
    const control = globalThis as typeof globalThis & { __emitAuthGateAgentEvent?: (event: unknown) => void }
    for (const event of items) control.__emitAuthGateAgentEvent?.(event)
  }, events)

  await emit([
    { type: 'turn-status', turnId, status: 'queued', message: '请求已发送，等待模型响应' },
    { type: 'turn-status', turnId, status: 'running', message: '正在分析任务结构' },
    { type: 'tool-status', turnId, callId: 'file', label: '读取文件', status: 'running' },
    { type: 'tool-status', turnId, callId: 'file', label: '读取文件', status: 'completed' },
    { type: 'tool-status', turnId, callId: 'command', label: '运行命令', status: 'running' },
  ])

  const executionSummary = page.locator('.agent-run-summary')
  await expect(executionSummary).toContainText('Agent 正在工作')
  await expect(executionSummary.locator('.agent-run-primary-copy')).toContainText('运行命令')
  await expect(executionSummary.getByRole('progressbar', { name: '执行进度' })).toBeVisible()
  await expect(executionSummary.locator('.agent-run-details')).toHaveCount(0)
  await executionSummary.getByRole('button', { name: /查看执行过程/ }).click()
  await expect(executionSummary.locator('.agent-run-step.visual-request')).not.toHaveCount(0)
  await expect(executionSummary.locator('.agent-run-step.visual-analysis')).toHaveCount(1)
  await expect(executionSummary.locator('.agent-run-step.visual-file')).toHaveCount(1)
  await expect(executionSummary.locator('.agent-run-step.visual-command')).toHaveCount(1)
  await expect(executionSummary.locator('.agent-run-step.running')).toContainText('运行命令')
  await expect(executionSummary.locator('.agent-run-step.running .event-status')).toContainText('进行中')
  await expect(executionSummary.locator('.visual-request .live-track-icon .lucide-send').first()).toBeVisible()
  await expect(executionSummary.locator('.visual-analysis .live-track-icon .lucide-brain-circuit')).toBeVisible()
  await expect(executionSummary.locator('.visual-file .live-track-icon .lucide-file-cog')).toBeVisible()
  await expect(executionSummary.locator('.visual-command .live-track-icon .lucide-square-terminal')).toBeVisible()

  await emit([
    { type: 'tool-status', turnId, callId: 'command', label: '运行命令', status: 'completed' },
    { type: 'tool-status', turnId, callId: 'tool', label: '调用外部工具', status: 'running' },
    { type: 'tool-status', turnId, callId: 'tool', label: '调用外部工具', status: 'completed' },
    { type: 'tool-status', turnId, callId: 'failed', label: '校验输出', status: 'failed' },
    { type: 'approval-request', turnId, approvalId: 'approval_e2e', label: '允许写入结果', risk: 'medium', expiresAt: '2030-01-01T00:00:00.000Z' },
  ])
  await expect(executionSummary).toContainText('等待你的确认')
  await expect(executionSummary.locator('.agent-run-primary-copy')).toContainText('允许写入结果')
  await expect(executionSummary.locator('.agent-run-step.visual-tool')).toHaveCount(1)
  await expect(executionSummary.locator('.agent-run-step.visual-failure')).toHaveCount(1)
  await expect(executionSummary.locator('.agent-run-step.visual-approval')).toHaveCount(1)
  await expect(executionSummary.locator('.visual-tool .live-track-icon .lucide-wrench')).toBeVisible()
  await expect(executionSummary.locator('.visual-failure .live-track-icon .lucide-circle-x')).toBeVisible()
  await expect(executionSummary.locator('.visual-approval .live-track-icon .lucide-shield-alert')).toBeVisible()

  await emit([{ type: 'turn-status', turnId, status: 'completed' }])
  await expect(executionSummary).toHaveClass(/state-completed/)
  await expect(executionSummary).toContainText('本轮执行完成')
  await expect(executionSummary.locator('.agent-run-primary-icon .lucide-circle-check')).toBeVisible()

  await page.setViewportSize({ width: 420, height: 720 })
  await expect(executionSummary).toBeVisible()
  const layout = await executionSummary.evaluate((summary) => {
    const intersects = (left: DOMRect, right: DOMRect) => (
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5
      && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
    )
    const rows = [...summary.querySelectorAll<HTMLElement>('.agent-run-step')]
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      rows: rows.map((row) => {
        const copy = row.querySelector<HTMLElement>('.agent-run-step-copy')!.getBoundingClientRect()
        const state = row.querySelector<HTMLElement>('.event-status')!.getBoundingClientRect()
        return {
          copyStateOverlap: intersects(copy, state),
          stateVisible: state.width > 0 && Number.parseFloat(getComputedStyle(row.querySelector('.event-status')!).opacity) === 1,
        }
      }),
    }
  })
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.rows.every((row) => (
    !row.copyStateOverlap
    && row.stateVisible
  ))).toBe(true)
})

test('Agent 与 Chat 只显示由可用令牌支持的接入分组', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-token-groups')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.getByRole('button', { name: '接入分组：default' })).toBeVisible()

  const assertTokenBackedGroups = async () => {
    await page.getByRole('button', { name: /接入分组：/u }).click()
    const menu = page.getByRole('menu', { name: '接入分组' })
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2)
    await expect(menu.getByRole('menuitemradio', { name: /default/u })).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /vip/u })).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /archive/u })).toHaveCount(0)
    await page.keyboard.press('Escape')
  }

  await assertTokenBackedGroups()
  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)
  await assertTokenBackedGroups()

  const calls = await authCalls(page)
  expect(calls).toContain('overview-groups:default+vip')
  expect(calls).not.toContain('models:relay:wzh-server:agent:archive')
  expect(calls).not.toContain('models:relay:wzh-server:chat:archive')
})

test('停用当前分组令牌后重读 overview 并失效旧模型目录', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-token-groups')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: '接入分组：default' }).click()
  await page.getByRole('menuitemradio', { name: /vip/u }).click()
  await expect(page.getByRole('button', { name: '接入分组：vip' })).toBeVisible()
  await expect(page.locator('.model-button')).toContainText('5.6-sol-vip')

  await page.locator('.sidebar-full .account-row').click()
  await expect(page.locator('.user-center')).toBeVisible()
  await page.getByRole('button', { name: '访问令牌', exact: true }).click()
  const vipTokenRow = page.getByRole('row').filter({ hasText: 'VIP access' })
  await expect(vipTokenRow).toContainText('有效')
  await vipTokenRow.getByRole('button', { name: '停用令牌' }).click()
  await expect(vipTokenRow).toContainText('已停用')
  await expect.poll(async () => (await authCalls(page)).includes('overview-groups:default')).toBe(true)

  await page.getByRole('button', { name: '返回工作区' }).click()
  await expect(page.getByRole('button', { name: '接入分组：default' })).toBeVisible()
  await expect(page.locator('.model-button')).toContainText('5.6-sol-standard')
  await page.locator('.model-button').click()
  const agentModels = page.getByRole('dialog', { name: '选择模型' })
  await expect(agentModels.getByText('gpt-5.6-sol-vip', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '接入分组：default' }).click()
  const remainingGroups = page.getByRole('menu', { name: '接入分组' })
  await expect(remainingGroups.getByRole('menuitemradio')).toHaveCount(1)
  await expect(remainingGroups.getByRole('menuitemradio', { name: /vip|archive/u })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect(page.getByRole('button', { name: '接入分组：default' })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)

  const calls = await authCalls(page)
  const updateIndex = calls.indexOf('token:update:2:disabled')
  expect(updateIndex).toBeGreaterThanOrEqual(0)
  expect(calls.slice(updateIndex + 1)).toContain('overview-groups:default')
  expect(calls.slice(updateIndex + 1)).toContain('models:relay:wzh-server:agent:default')
})

test('当前分组没有 Agent 模型时自动切换到有线上模型的账户分组', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-agent-fallback')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect.poll(async () => await authCalls(page)).toEqual(expect.arrayContaining([
    'models:relay:wzh-server:agent:default',
    'models:relay:wzh-server:agent:vip',
  ]))
  await expect(page.getByRole('button', { name: '接入分组：vip' })).toBeVisible()
  await expect(page.locator('.model-button')).toContainText('5.6-sol-vip')
})

test('所选 Agent 分组目录读取失败时保留分组且不尝试其他分组', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-agent-error')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.getByRole('button', { name: '接入分组：default' })).toBeVisible()
  await expect(page.locator('.sidebar-full .account-copy small')).toHaveText('模型服务暂不可用')
  await expect(page.locator('.model-button')).toContainText('选择模型')

  const calls = await authCalls(page)
  expect(calls).toContain('models:relay:wzh-server:agent:default')
  expect(calls).not.toContain('models:relay:wzh-server:agent:vip')
})

test('切换模式会清空旧目录并忽略迟到的 Chat 模型结果', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-model-delay')
  await page.goto('/')

  const modes = page.locator('.task-sidebar .sidebar-mode-row .mode-segment')
  const modelButton = page.locator('.model-button')
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'models:relay:wzh-server:agent:default').length).toBe(1)
  await expect(modelButton).toContainText('5.6-sol-standard')

  await modes.getByRole('button', { name: 'Chat' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)
  await expect(modelButton).toContainText('选择模型')

  await modes.getByRole('button', { name: 'Agent' }).click()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'models:relay:wzh-server:agent:default').length).toBe(2)
  await expect(modelButton).toContainText('5.6-sol-standard')
  await modelButton.click()
  const agentMenu = page.getByRole('dialog', { name: '选择模型' })
  await expect(agentMenu.getByText('claude-native-test', { exact: true })).toHaveCount(0)
  await expect(agentMenu.getByText('gpt-image-2', { exact: true })).toHaveCount(0)

  await resolveModelRequests(page)
  await expect.poll(async () => (await authCalls(page)).includes('models:resolved:chat')).toBe(true)
  await expect(modelButton).toContainText('5.6-sol-standard')
  await expect(agentMenu.getByText('claude-native-test', { exact: true })).toHaveCount(0)
})

test('Chat 显示协议矩阵并锁定 Images 模型的附件与图片开关', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.locator('.task-sidebar .sidebar-mode-row .mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)

  const modelButton = page.locator('.model-button')
  await modelButton.click()
  let modelMenu = page.getByRole('dialog', { name: '选择模型' })
  await expect(modelMenu.getByRole('button', { name: /openai-chat-test.*Chat Completions/u })).toBeVisible()
  await expect(modelMenu.getByRole('button', { name: /claude-native-test.*Anthropic Messages/u })).toBeVisible()
  await expect(modelMenu.getByRole('button', { name: /gemini-native-test.*Gemini/u })).toBeVisible()
  await expect(modelMenu.getByRole('button', { name: /gpt-image-2.*Images/u })).toBeVisible()
  await expect(modelMenu.getByRole('button', { name: /responses-images-test.*Responses \/ Images/u })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.locator('.composer input[type="file"]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('reference-image-e2e'),
  })
  await expect(page.locator('.attachment-row').getByText('reference.png', { exact: true })).toBeVisible()

  await modelButton.click()
  modelMenu = page.getByRole('dialog', { name: '选择模型' })
  await modelMenu.getByRole('button', { name: /gpt-image-2.*Images/u }).click()

  await expect(page.locator('.attachment-row')).toHaveCount(0)
  await expect(page.getByText('已移除 Chat 附件；Images 模型只接受文本提示词，参考图或图片编辑请转到 Studio。', { exact: true })).toBeVisible()
  await expect(page.locator('.model-compatibility-notice')).toContainText('图片生成固定开启')
  await expect(page.locator('.model-compatibility-notice')).toContainText('参考图或图片编辑请转到 Studio')
  const lockedImage = page.getByRole('button', { name: 'Images 模型固定开启图片生成' })
  const lockedAttachment = page.getByRole('button', { name: 'Images 模型不接收附件；参考图或编辑请使用 Studio' })
  await expect(lockedImage).toBeDisabled()
  await expect(lockedImage).toHaveAttribute('aria-pressed', 'true')
  await expect(lockedAttachment).toBeDisabled()

  await modelButton.click()
  modelMenu = page.getByRole('dialog', { name: '选择模型' })
  await modelMenu.getByRole('button', { name: /responses-images-test.*Responses \/ Images/u }).click()
  await expect(page.locator('.model-compatibility-notice')).toContainText('本轮将使用 Images')
  await expect(page.locator('.model-compatibility-notice')).toContainText('普通对话使用 Responses')
})

test('Studio 运行栏选择分组并同步对应模型', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.sidebar-full .account-copy strong')).toHaveText('demo-user')
  await page.locator('.task-sidebar .sidebar-mode-row .mode-segment').getByRole('button', { name: 'Studio' }).click()
  const studio = page.getByRole('region', { name: 'Studio 图像工作流' })
  await expect(studio.getByText('图像工作流 · 线上 NewAPI 账户分组', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await authCalls(page)).includes('studio:bootstrap')).toBe(true)

  const navigation = page.getByRole('navigation', { name: '主导航' })
  await expect(navigation.locator('.activity-main > button')).toHaveCount(4)
  await expect(navigation.locator('.studio-account-row')).toContainText('demo-user')
  await expect(navigation.getByRole('button', { name: '接口', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '接口与插件' })).toHaveCount(0)

  const group = page.getByRole('button', { name: '分组：default', exact: true })
  const runModel = page.getByRole('button', { name: '运行模型：gpt-image-default', exact: true })
  await expect(group).toBeVisible()
  await expect(runModel).toBeVisible()

  await group.click()
  const groupMenu = page.getByRole('listbox', { name: '分组', exact: true })
  await expect(groupMenu).toBeVisible()
  const groupMaterial = await groupMenu.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { backdropFilter: style.backdropFilter, backgroundColor: style.backgroundColor, top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight }
  })
  expect(groupMaterial.backdropFilter).not.toBe('none')
  expect(groupMaterial.backgroundColor).not.toBe('rgb(255, 255, 255)')
  expect(groupMaterial.top).toBeGreaterThan(0)
  expect(groupMaterial.bottom).toBeLessThanOrEqual(groupMaterial.viewportHeight)
  await groupMenu.getByRole('option', { name: /vip/ }).click()
  await expect(page.getByRole('button', { name: '分组：vip', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '运行模型：gpt-image-vip', exact: true })).toBeVisible()
  await page.getByRole('group', { name: '图像生成 节点', exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '节点属性' })
  await expect(inspector.getByLabel('分组', { exact: true })).toHaveCount(0)
  await expect(inspector.getByLabel('模型', { exact: true })).toHaveCount(0)
  await expect(inspector.locator('.provider-capability-callout')).toContainText('gpt-image-vip')
  await expect(inspector.getByRole('button', { name: '尺寸', exact: true })).toBeVisible()
  const quality = inspector.getByRole('button', { name: '质量', exact: true })
  await expect(quality).toBeVisible()
  await quality.click()
  const qualityMenu = page.getByRole('listbox', { name: '质量', exact: true })
  await expect(qualityMenu).toBeVisible()
  const qualityMaterial = await qualityMenu.evaluate((element) => {
    const style = getComputedStyle(element)
    return { backdropFilter: style.backdropFilter, backgroundColor: style.backgroundColor }
  })
  expect(qualityMaterial.backdropFilter).not.toBe('none')
  expect(qualityMaterial.backgroundColor).not.toBe('rgb(255, 255, 255)')
  expect(qualityMaterial.backgroundColor).not.toBe('rgba(255, 255, 255, 1)')
  await expect(qualityMenu.getByRole('option')).toHaveText([
    'Provider 默认',
    'Auto · Provider 决定',
    'Low · 草稿',
    'Medium · 平衡',
    'High · 精细',
  ])
  await qualityMenu.getByRole('option', { name: 'High · 精细', exact: true }).click()
  await expect(quality).toHaveAttribute('title', 'High · 精细')
  await expect(page.getByRole('button', { name: '运行模型：gpt-image-vip', exact: true })).toBeVisible()

  for (const nodeName of ['图片编辑', '局部重绘', '扩图']) {
    await page.getByRole('button', { name: '打开节点库', exact: true }).click()
    await page.getByTitle(`添加${nodeName}节点`, { exact: true }).click()
    await page.getByRole('button', { name: '打开节点属性', exact: true }).click()
    await expect(inspector.getByLabel('分组', { exact: true })).toHaveCount(0)
    await expect(inspector.getByLabel('模型', { exact: true })).toHaveCount(0)
    await expect(inspector.locator('.provider-capability-callout')).toContainText('gpt-image-vip')
    await expect(page.getByRole('button', { name: '运行模型：gpt-image-vip', exact: true })).toBeVisible()
  }

  await page.getByRole('button', { name: '参数视图', exact: true }).click()
  await expect(page.locator('.linear-view').getByLabel('模型', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '运行模型：gpt-image-vip', exact: true })).toBeVisible()

  const modelButton = page.getByRole('button', { name: '运行模型：gpt-image-vip', exact: true })
  await modelButton.click()
  const modelMenu = page.getByRole('listbox', { name: '可用模型列表', exact: true })
  const modelPopover = page.getByRole('dialog', { name: '运行模型', exact: true })
  await expect(modelMenu).toBeVisible()
  const modelMaterial = await modelPopover.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { backdropFilter: style.backdropFilter, backgroundColor: style.backgroundColor, left: rect.left, right: rect.right, viewportWidth: window.innerWidth }
  })
  expect(modelMaterial.backdropFilter).not.toBe('none')
  expect(modelMaterial.backgroundColor).not.toBe('rgb(255, 255, 255)')
  expect(modelMaterial.left).toBeGreaterThanOrEqual(0)
  expect(modelMaterial.right).toBeLessThanOrEqual(modelMaterial.viewportWidth)
  await expect(modelMenu.getByRole('option')).toHaveText([
    'gpt-image-vip可用',
    'gpt-image-shared可用',
  ])
  await page.keyboard.press('Escape')
  await expect(modelMenu).toHaveCount(0)

  await modelButton.click()
  await expect(modelMenu).toBeVisible()
  await page.locator('.run-button').focus()
  await expect(modelMenu).toHaveCount(0)

  await expect(studio.getByText('使用 AI-terminal 当前登录账号的接入分组', { exact: false })).toHaveCount(0)

  await page.getByRole('button', { name: '刷新分组' }).click()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'studio:list-providers').length).toBe(1)
})

test('Studio 直接展示并绑定同组联网模型', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-studio-candidates')
  await page.goto('/')

  await page.locator('.task-sidebar .sidebar-mode-row .mode-segment').getByRole('button', { name: 'Studio' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('studio:bootstrap')).toBe(true)

  await page.getByRole('button', { name: '分组：default', exact: true }).click()
  await page.getByRole('listbox', { name: '分组', exact: true }).getByRole('option', { name: /vip/u }).click()
  const readyModel = page.getByRole('button', { name: '运行模型：gpt-image-vip', exact: true })
  await expect(readyModel).toBeVisible()

  await readyModel.click()
  const modelMenu = page.getByRole('listbox', { name: '可用模型列表', exact: true })
  await expect(modelMenu.getByRole('option')).toHaveText([
    'gpt-image-vip可用',
    'gpt-image-shared可用',
    'gpt-image-vip-high可用',
  ])
  await modelMenu.getByRole('option', { name: /gpt-image-vip-high.*可用/u }).click()
  await expect(page.getByRole('button', { name: '运行模型：gpt-image-vip-high', exact: true })).toBeVisible()
  expect((await authCalls(page)).filter((entry) => entry.startsWith('studio:confirm-image:'))).toHaveLength(0)
})

test('Studio 在账户目录恢复后只刷新一次分组', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-model-delay')
  await page.goto('/')

  const modes = page.locator('.task-sidebar .sidebar-mode-row .mode-segment')
  await modes.getByRole('button', { name: 'Chat' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)
  await modes.getByRole('button', { name: 'Studio' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('studio:bootstrap')).toBe(true)
  await expect(page.getByRole('button', { name: '分组：无可用分组', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '运行模型：选择分组', exact: true })).toBeVisible()
  expect((await authCalls(page)).filter((entry) => entry === 'studio:list-providers')).toHaveLength(0)

  await resolveModelRequests(page)
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'studio:list-providers').length).toBe(1)
  await expect(page.getByRole('button', { name: '分组：选择分组', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '运行模型：选择分组', exact: true })).toBeVisible()

  await resolveModelRequests(page)
  await page.waitForTimeout(50)
  expect((await authCalls(page)).filter((entry) => entry === 'studio:list-providers')).toHaveLength(1)
})

test('Responses Lite 明确关闭并禁用托管联网与图片生成', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)
  await expect(page.locator('.model-button')).toContainText('5.6-sol-standard')

  await expect(page.getByRole('button', { name: '关闭联网' })).toBeEnabled()
  await page.getByRole('button', { name: '开启图片生成' }).click()
  await expect(page.getByRole('button', { name: '关闭图片生成' })).toBeEnabled()

  await page.locator('.model-button').click()
  await page.getByRole('button', { name: /gpt-5\.6-terra/u }).click()

  const compatibilityNotice = page.locator('.model-compatibility-notice')
  await expect(compatibilityNotice).toContainText('当前模型使用 Responses Lite')
  await expect(compatibilityNotice).toContainText('切换到支持它们的标准模型')
  const webButton = page.getByRole('button', { name: '当前模型不支持联网搜索' })
  const imageButton = page.getByRole('button', { name: '当前模型不支持图片生成' })
  await expect(webButton).toBeDisabled()
  await expect(imageButton).toBeDisabled()
  await expect(webButton).toHaveAttribute('aria-pressed', 'false')
  await expect(imageButton).toHaveAttribute('aria-pressed', 'false')

  const prompt = '验证 Lite 能力边界'
  await page.getByRole('textbox', { name: '消息' }).fill(prompt)
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(async () => (await authCalls(page)).includes(
    'turn:hosted:gpt-5.6-terra:0:0'
  )).toBe(true)
  expect(await authCalls(page)).not.toContain('turn:renderer-wire-mode')
})

test('/init 预览只用一次性句柄提交固定 AGENTS.md 草稿', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.getByRole('button', { name: '选择工作区' }).click()
  await expect(page.getByTitle('E2E workspace')).toBeVisible()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('/init')
  await page.getByRole('listbox', { name: '命令选择' }).getByRole('option', { name: /^\/init\b/u }).click()
  await input.press('Enter')
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('execute:'))).toEqual([
    `execute:init:ws_${'a'.repeat(43)}:prepare`,
  ])

  const preview = page.getByRole('dialog', { name: '预览 AGENTS.md' })
  await expect(preview).toBeVisible()
  await expect(preview.locator('.init-preview-content')).toContainText('# AGENTS.md')
  await expect(preview.locator('.init-preview-content')).toContainText('Keep changes scoped.')
  await expect(preview).toContainText('新建文件')
  await preview.getByRole('button', { name: '写入此草稿' }).click()

  await expect(preview).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect(page.locator('.capability-state-message')).toContainText('atomically created')
  const calls = await authCalls(page)
  expect(calls.filter((entry) => entry === 'init:preview')).toHaveLength(1)
  expect(calls.filter((entry) => entry === 'init:commit:handle-only')).toHaveLength(1)
})

test('/init 取消会销毁单个草稿并恢复焦点', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.getByRole('button', { name: '选择工作区' }).click()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('/init')
  await page.getByRole('listbox', { name: '命令选择' }).getByRole('option', { name: /^\/init\b/u }).click()
  await input.press('Enter')

  const preview = page.getByRole('dialog', { name: '预览 AGENTS.md' })
  await expect(preview).toBeVisible()
  const close = preview.getByRole('button', { name: '关闭草稿预览' })
  const commit = preview.getByRole('button', { name: '写入此草稿' })

  await commit.focus()
  await commit.press('Tab')
  await expect(close).toBeFocused()
  await close.press('Shift+Tab')
  await expect(commit).toBeFocused()

  await preview.locator('.init-preview-content').focus()
  await preview.locator('.init-preview-content').press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'init:discard:handle-only')).toHaveLength(1)
  expect((await authCalls(page)).filter((entry) => entry === 'init:commit:handle-only')).toHaveLength(0)
})

test('工作区目录刷新期间 Composer 锁定且不会回退到旧 token 发送', async ({ page }) => {
  await installAuthHarness(page, 'signed-in-capability-delay')
  await page.goto('/')

  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('scope switch request')
  await page.getByRole('button', { name: '选择工作区' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('capabilities:scope-pending')).toBe(true)
  await expect(input).toBeDisabled()
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
  expect((await authCalls(page)).some((entry) => entry.startsWith('turn:start:'))).toBe(false)

  await resolveCapabilityRequests(page)
  await expect.poll(async () => (await authCalls(page)).includes('capabilities:scope-resolved')).toBe(true)
  await expect(input).toBeEnabled()
  await input.press('Enter')

  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('turn:start:agent:scope switch request:'))).toEqual([
    `turn:start:agent:scope switch request:ws_${'a'.repeat(43)}:0`,
  ])
  expect((await authCalls(page)).some((entry) => entry.includes(':preview-workspace:'))).toBe(false)
})

test('/review 绑定后立即以只读 Agent 轮次发送而不会落入 Chat', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.getByRole('button', { name: '选择工作区' }).click()
  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('/review')
  await page.getByRole('listbox', { name: '命令选择' }).getByRole('option', { name: /^\/review\b/u }).click()
  await Promise.all([input.press('Enter'), input.press('Enter')])

  await expect.poll(async () => (await authCalls(page)).some((entry) => (
    entry.startsWith('turn:start:agent:/review:')
  ))).toBe(true)
  await expect(page.locator('.mode-segment').getByRole('button', { name: 'Agent' })).toHaveClass(/active/u)
  await expect(page.locator('.user-message-body')).toContainText('/review')
  const calls = await authCalls(page)
  expect(calls).toContain(`execute:review:ws_${'a'.repeat(43)}:prepare`)
  expect(calls).toContain('review:armed')
  expect(calls).toContain(`turn:review-handle:review_${'r'.repeat(43)}`)
  expect(calls).toContain(`conversation:create:agent:ws_${'a'.repeat(43)}`)
  expect(calls.filter((entry) => entry === `execute:review:ws_${'a'.repeat(43)}:prepare`)).toHaveLength(1)
  expect(calls.filter((entry) => entry.startsWith('turn:start:agent:/review:'))).toHaveLength(1)
  expect(calls.some((entry) => entry.startsWith('turn:start:chat:/review:'))).toBe(false)
  expect(calls.some((entry) => entry.endsWith(':0') && entry.startsWith('turn:start:agent:/review:'))).toBe(true)
})

test('授权拒绝后保持锁定并允许重试', async ({ page }) => {
  await installAuthHarness(page, 'denied')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('设备授权已被拒绝。', { timeout: 5_000 })
  await expect(page.getByRole('button', { name: '登录并进入工作台' })).toBeEnabled()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  expect(await authCalls(page)).not.toContain('bootstrap')
})

test('自动打开失败时保留同一设备码并可无弹窗重开', async ({ page }) => {
  await installAuthHarness(page, 'open-fails-once')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('设备码仍然有效，可以点击重新打开。')
  await expect(page.locator('.app-shell')).toHaveCount(0)

  await page.getByRole('button', { name: '重新打开授权页' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()

  const calls = await authCalls(page)
  expect(calls.filter((entry) => entry.startsWith('open:'))).toEqual([
    'open:relay-session-auth-gate-e2e',
    'open:relay-session-auth-gate-e2e',
  ])
  expect(calls.filter((entry) => entry === 'start')).toHaveLength(1)
  expect(calls).not.toContain('openExternal')
  expect(calls).not.toContain('bootstrap')
})

test('确认 endpoint 后从 DPAPI 会话恢复本机历史', async ({ page }) => {
  await installAuthHarness(page, 'restored')
  await page.goto('/')

  await expect(page.getByRole('button', { name: '登录并进入工作台' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.sidebar-full .account-copy small')).toHaveText('模型已连接')
  await expect(page.locator('.auth-gate')).toHaveCount(0)
  await expect(page.getByText('本机加密历史已恢复。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('当前任务')).toHaveText('恢复的本机任务')
  const calls = await authCalls(page)
  const connectCall = 'connect:https://www.wzhxiaozhan.top:connect'
  const loadCall = 'load:task:11111111-1111-4111-8111-111111111111'
  expect(calls).toContain(connectCall)
  expect(calls).not.toContain('start')
  expect(calls.some((entry) => entry.startsWith('open:'))).toBe(false)
  expect(calls).not.toContain('poll')
  expect(calls).toContain('bootstrap')
  expect(calls).toContain(loadCall)
  expect(calls.indexOf(connectCall)).toBeLessThan(calls.indexOf('bootstrap'))
  expect(calls.indexOf('bootstrap')).toBeLessThan(calls.indexOf(loadCall))
})

test('设备码登录成功后按 activeTaskId 恢复本机历史', async ({ page }) => {
  await installAuthHarness(page, 'device-history')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('本机加密历史已恢复。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('当前任务')).toHaveText('恢复的本机任务')

  const calls = await authCalls(page)
  const loadCall = 'load:task:11111111-1111-4111-8111-111111111111'
  expect(calls).toContain('start')
  expect(calls).toContain('poll')
  expect(calls).toContain('bootstrap')
  expect(calls).toContain(loadCall)
  expect(calls.indexOf('poll')).toBeLessThan(calls.indexOf('bootstrap'))
  expect(calls.indexOf('bootstrap')).toBeLessThan(calls.indexOf(loadCall))
})

test('迟到的会话恢复不会覆盖用户已新建的任务', async ({ page }) => {
  await installAuthHarness(page, 'restored-delayed')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'bootstrap').length).toBeGreaterThan(0)
  await page.getByRole('button', { name: '新建 Chat', exact: true }).click()
  await expect(page.getByLabel('当前任务')).toHaveText('新 Chat')
  await page.evaluate(() => {
    const control = globalThis as typeof globalThis & { __resolveAuthGateBootstrap?: () => void }
    control.__resolveAuthGateBootstrap?.()
  })

  await expect(page.getByRole('button', { name: '本地历史 1' })).toBeVisible()
  await expect(page.getByLabel('当前任务')).toHaveText('新 Chat')
  await expect(page.getByText('本机加密历史已恢复。', { exact: true })).toHaveCount(0)
  expect(await authCalls(page)).not.toContain('load:task:11111111-1111-4111-8111-111111111111')
})

test('空白 Agent 任务提供快捷开始并把环境信息收成侧边入口', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.workspace-grid')).toHaveClass(/context-compact/)
  await expect(page.getByRole('heading', { name: '开始一项 Agent 任务' })).toBeVisible()
  await expect(page.getByRole('group', { name: '快捷开始' }).getByRole('button')).toHaveCount(3)
  await expect(page.getByRole('button', { name: '展开环境信息' })).toBeVisible()

  await page.getByRole('button', { name: /分析项目/ }).click()
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(/分析当前项目的结构与现状/)
  await expect(page.getByRole('textbox', { name: '消息' })).toBeFocused()

  await page.getByRole('button', { name: '展开环境信息' }).click()
  await expect(page.locator('.workspace-grid')).toHaveClass(/context-expanded/)
  await expect(page.getByText('工作目录会自动准备', { exact: true })).toBeVisible()
  await expect(page.getByText('未选择工作区', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '连接正常，查看详情' }).click()
  await expect(page.getByRole('dialog', { name: '连接详情' })).toContainText('模型服务已就绪')
})

test('退出账户成功后立即卸载工作台并重新锁定', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')
  await expect(page.locator('.app-shell')).toBeVisible()

  await page.locator('.sidebar-full .account-row').click()
  await expect(page.locator('.user-center')).toBeVisible()
  await page.getByRole('button', { name: '退出账户' }).click()

  await expect(page.getByRole('heading', { name: '登录后继续工作' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page.locator('.user-center')).toHaveCount(0)
  const calls = await authCalls(page)
  expect(calls).toContain('signOut')
  expect(calls).toContain('unsubscribe')
})
