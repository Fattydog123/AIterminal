import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  ApprovalMode,
  CapabilityCatalog,
  CapabilityDiscoveryCategory,
  CapabilityExecuteResult,
  PluginDescriptor
} from '../../shared/contracts.ts'
import { redactSensitiveContent, redactSensitiveText } from '../security/redaction.ts'
import {
  CapabilityRegistry,
  type CapabilitySkillUseRequest,
  type CapabilityWorkspaceIdentity
} from './capability-registry.ts'
import {
  connectMcp,
  McpClientError,
  type McpConnectionConfig,
  type McpSession,
  type McpTool,
  type McpToolCallResult
} from './mcp-client.ts'
import type {
  ResponsesFunctionToolCall,
  ResponsesFunctionToolDefinition,
  ResponsesJsonObject
} from './responses-client.ts'

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_INSTRUCTION_BYTES = 48 * 1024
const MAX_HOOK_OUTPUT_BYTES = 32 * 1024
const MAX_MCP_OUTPUT_BYTES = 192 * 1024
const HOOK_TIMEOUT_MS = 15_000
const MCP_PREFIX = 'mcp__'

type ExtensionHookName = 'beforeTurn' | 'afterTurn' | 'beforeTool' | 'afterTool'

export interface ExtensionScope {
  readonly ownerWebContentsId: number
  readonly workspace?: CapabilityWorkspaceIdentity
}

export interface ExtensionCatalogRequest extends ExtensionScope {
  readonly discover?: CapabilityDiscoveryCategory
}

export interface ExtensionAction {
  readonly id: string
  readonly args?: string
  readonly grantHandle?: string
}

export interface ExtensionInvokeAuthorization {
  readonly authorizeSkillUse?: (request: CapabilitySkillUseRequest) => Promise<boolean>
  readonly authorizePluginUse?: (plugin: Readonly<PluginDescriptor>) => Promise<boolean>
}

export interface ExtensionTurnContext extends ExtensionScope {
  readonly taskId: string
  readonly turnId?: string
  readonly approvalMode: ApprovalMode
  readonly signal?: AbortSignal
  readonly authorizeTool?: (request: ExtensionToolAuthorizationRequest) => Promise<boolean>
  readonly onToolStatus?: (event: ExtensionToolStatusEvent) => void
}

export interface ExtensionToolAuthorizationRequest {
  readonly callId: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly label: string
  readonly signal: AbortSignal
}

export interface ExtensionToolStatusEvent {
  readonly callId: string
  readonly label: string
  readonly status: 'running' | 'completed' | 'failed'
}

export interface ExtensionTurnFinish {
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly message?: string
}

export interface ExtensionTurnSession {
  readonly instructions: readonly string[]
  readonly tools: readonly ResponsesFunctionToolDefinition[]
  readonly diagnostics: readonly string[]
  dispatch(toolCall: ResponsesFunctionToolCall, signal?: AbortSignal): Promise<string>
  finish(result: ExtensionTurnFinish): Promise<void>
  dispose(): Promise<void>
}

export interface ExtensionHostOptions {
  readonly registry?: CapabilityRegistry
  readonly homeDirectory?: string
  readonly connectMcp?: (config: McpConnectionConfig) => Promise<McpSession>
  readonly runHook?: (hook: ExtensionHookInvocation) => Promise<string>
}

export interface ExtensionHookInvocation {
  readonly name: ExtensionHookName
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly context: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

interface PluginGrantBinding {
  readonly descriptor: PluginDescriptor
  readonly manifestPath: string
  readonly workspaceKey: string | null
}

interface EnabledPlugin {
  readonly descriptor: PluginDescriptor
  readonly manifestPath: string
  readonly workspaceKey: string | null
  readonly manifest: PluginManifest
}

interface OwnerExtensionState {
  readonly selectedSkills: Map<string, { instructions: string; workspaceKey: string | null }>
  readonly enabledPlugins: Map<string, EnabledPlugin>
  readonly pluginGrants: Map<string, PluginGrantBinding>
}

interface PluginManifest {
  readonly instructions: readonly string[]
  readonly mcpServers: Readonly<Record<string, unknown>>
  readonly hooks: Readonly<Partial<Record<ExtensionHookName, readonly HookCommand[]>>>
}

interface HookCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

interface ConnectedMcpTool {
  readonly session: McpSession
  readonly serverName: string
  readonly remoteName: string
  readonly definition: ResponsesFunctionToolDefinition
}

/**
 * Main-process owner for slash commands, selected skills, declarative plugins,
 * MCP transports, and extension lifecycle hooks. Renderer-facing methods only
 * return the existing metadata contracts; executable details stay in Main.
 */
export class ExtensionHost {
  readonly #registry: CapabilityRegistry
  readonly #homeDirectory: string
  readonly #connectMcp: (config: McpConnectionConfig) => Promise<McpSession>
  readonly #runHook: (hook: ExtensionHookInvocation) => Promise<string>
  readonly #owners = new Map<number, OwnerExtensionState>()
  readonly #turnSessions = new Set<ExtensionTurnSession>()
  #disposed = false

  constructor(options: ExtensionHostOptions = {}) {
    this.#registry = options.registry ?? new CapabilityRegistry({ homeDirectory: options.homeDirectory })
    this.#homeDirectory = resolve(options.homeDirectory ?? homedir())
    this.#connectMcp = options.connectMcp ?? connectMcp
    this.#runHook = options.runHook ?? runDeclaredHook
  }

  getPlanMode(ownerWebContentsId: number): boolean {
    return this.#registry.getPlanMode(ownerWebContentsId)
  }

  consumeReviewMode(
    ownerWebContentsId: number,
    workspace: CapabilityWorkspaceIdentity,
    reviewHandle: unknown
  ): boolean {
    return this.#registry.consumeReviewMode(ownerWebContentsId, workspace, reviewHandle)
  }

  async catalog(request: ExtensionCatalogRequest): Promise<CapabilityCatalog> {
    this.#assertActive()
    const catalog = await this.#registry.list({
      ownerWebContentsId: request.ownerWebContentsId,
      ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
      ...(request.discover === undefined ? {} : { discover: request.discover })
    })
    if (request.discover !== 'plugins') return catalog

    const owner = this.#owner(request.ownerWebContentsId)
    owner.pluginGrants.clear()
    const plugins = await Promise.all(catalog.plugins.map(async (descriptor) => {
      const manifestPath = await this.#resolveDescriptorPath(descriptor, request.workspace)
      if (manifestPath) {
        owner.pluginGrants.set(descriptor.grantHandle, {
          descriptor: clonePluginDescriptor(descriptor),
          manifestPath,
          workspaceKey: descriptor.scope === 'workspace' ? workspaceKey(request.workspace) : null
        })
      }
      return {
        ...clonePluginDescriptor(descriptor),
        enabled: owner.enabledPlugins.get(descriptor.id)?.workspaceKey === (
          descriptor.scope === 'workspace' ? workspaceKey(request.workspace) : null
        )
      }
    }))
    return { ...catalog, plugins }
  }

  async invoke(
    scope: ExtensionScope,
    action: ExtensionAction,
    authorization: ExtensionInvokeAuthorization = {}
  ): Promise<CapabilityExecuteResult> {
    this.#assertActive()
    if (action.id.startsWith('plugin:')) {
      return await this.#invokePlugin(scope, action, authorization.authorizePluginUse)
    }
    const result = await this.#registry.execute({
      id: action.id,
      ownerWebContentsId: scope.ownerWebContentsId,
      ...(action.args === undefined ? {} : { args: action.args }),
      ...(action.grantHandle === undefined ? {} : { grantHandle: action.grantHandle }),
      ...(scope.workspace === undefined ? {} : { workspace: scope.workspace }),
      ...(authorization.authorizeSkillUse === undefined
        ? {}
        : { authorizeSkillUse: authorization.authorizeSkillUse })
    })
    if (action.id.startsWith('skill:') && result.status === 'completed' && result.instructions) {
      this.#owner(scope.ownerWebContentsId).selectedSkills.set(action.id, {
        instructions: result.instructions,
        workspaceKey: action.id.startsWith('skill:workspace:') ? workspaceKey(scope.workspace) : null
      })
    }
    return result
  }

  async openTurn(context: ExtensionTurnContext): Promise<ExtensionTurnSession> {
    this.#assertActive()
    const owner = this.#owner(context.ownerWebContentsId)
    const selectedPlugins = [...owner.enabledPlugins.values()].filter((plugin) => (
      plugin.workspaceKey === null || plugin.workspaceKey === workspaceKey(context.workspace)
    ))
    const diagnostics: string[] = []
    const currentWorkspaceKey = workspaceKey(context.workspace)
    const instructions = [...owner.selectedSkills.values()]
      .filter((skill) => skill.workspaceKey === null || skill.workspaceKey === currentWorkspaceKey)
      .map((skill) => skill.instructions)
    for (const plugin of selectedPlugins) instructions.push(...plugin.manifest.instructions)

    const hookContext = Object.freeze({
      taskId: context.taskId,
      turnId: context.turnId ?? '',
      approvalMode: context.approvalMode,
      workspace: context.workspace?.absolutePath ?? ''
    })
    const hooks = collectHooks(selectedPlugins)
    const beforeTurnOutput = await this.#runHooks(
      'beforeTurn', hooks.beforeTurn, hookContext, diagnostics, context.signal
    )
    if (beforeTurnOutput) instructions.push(beforeTurnOutput)

    const serverDeclarations: Array<{
      name: string
      value: unknown
      cwd: string
    }> = []
    // .mcp.json is user-authored local configuration; connections load in every
    // approval mode, and each individual tool call still passes through the
    // per-call authorization gate below. The approval mode is not a proxy for
    // whether the user wants their configured MCP servers at all.
    await this.#collectDirectMcpServers(context.workspace, serverDeclarations, diagnostics)
    for (const plugin of selectedPlugins) {
      const cwd = dirname(plugin.manifestPath)
      for (const [name, value] of Object.entries(plugin.manifest.mcpServers)) {
        serverDeclarations.push({ name, value, cwd })
      }
    }

    const connectedSessions: McpSession[] = []
    const toolMap = new Map<string, ConnectedMcpTool>()
    for (const declaration of serverDeclarations) {
      if (context.signal?.aborted) break
      const config = parseMcpConnectionConfig(declaration.value, declaration.cwd)
      if (!config) {
        diagnostics.push(`扩展 ${safeLabel(declaration.name)} 的 MCP 配置无效，已跳过。`)
        continue
      }
      try {
        const session = await connectWithCancellation(this.#connectMcp(config), context.signal)
        connectedSessions.push(session)
        const remoteTools = await session.listTools(context.signal)
        for (const remoteTool of remoteTools) {
          if (toolMap.size >= 20) {
            diagnostics.push('扩展工具数量已达到本轮上限，其余工具未加载。')
            break
          }
          const localName = uniqueToolName(declaration.name, remoteTool.name, toolMap)
          const definition = mcpToolDefinition(localName, remoteTool)
          if (!definition) {
            diagnostics.push(`MCP ${safeLabel(declaration.name)} 的工具定义无效，已跳过。`)
            continue
          }
          toolMap.set(localName, {
            session,
            serverName: declaration.name,
            remoteName: remoteTool.name,
            definition
          })
        }
      } catch (error) {
        if (context.signal?.aborted || isMcpCancellation(error)) {
          await Promise.allSettled(connectedSessions.map((session) => session.close()))
          throw error
        }
        diagnostics.push(`MCP ${safeLabel(declaration.name)} 暂时不可用：${safeExtensionError(error)}`)
      }
    }

    let closed = false
    let finished = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await Promise.allSettled(connectedSessions.map((session) => session.close()))
    }
    const extensionSession: ExtensionTurnSession = {
      instructions: Object.freeze(instructions.map(boundInstruction).filter(Boolean)),
      tools: Object.freeze([...toolMap.values()].map((entry) => entry.definition)),
      diagnostics: Object.freeze([...diagnostics]),
      dispatch: async (toolCall, signal) => {
        if (closed) throw new Error('The extension turn session is closed.')
        const target = toolMap.get(toolCall.name)
        if (!target) throw new Error('The requested extension tool is unavailable.')
        const activeSignal = signal ?? context.signal ?? new AbortController().signal
        throwIfSignalAborted(activeSignal)
        const label = `扩展工具 ${safeLabel(target.serverName)}：${safeLabel(target.remoteName)}`
        const approved = context.approvalMode === 'full' && !context.authorizeTool
          ? true
          : await context.authorizeTool?.({
              callId: toolCall.callId,
              name: toolCall.name,
              arguments: asToolArguments(toolCall.arguments),
              label,
              signal: activeSignal
            }) ?? false
        throwIfSignalAborted(activeSignal)
        if (!approved) {
          context.onToolStatus?.({ callId: toolCall.callId, label, status: 'failed' })
          return 'The user or local policy denied this exact extension tool call. No extension operation was performed.'
        }
        const callContext = Object.freeze({
          ...hookContext,
          tool: toolCall.name,
          server: target.serverName
        })
        await this.#runHooks('beforeTool', hooks.beforeTool, callContext, diagnostics, activeSignal)
        context.onToolStatus?.({ callId: toolCall.callId, label, status: 'running' })
        let output: string
        try {
          const result = await target.session.callTool(
            target.remoteName,
            asToolArguments(toolCall.arguments),
            activeSignal
          )
          output = formatMcpToolResult(result)
          context.onToolStatus?.({
            callId: toolCall.callId,
            label,
            status: result.isError ? 'failed' : 'completed'
          })
        } catch (error) {
          if (activeSignal.aborted || isMcpCancellation(error)) throw error
          output = `扩展工具执行失败：${safeExtensionError(error)}`
          context.onToolStatus?.({ callId: toolCall.callId, label, status: 'failed' })
        }
        await this.#runHooks('afterTool', hooks.afterTool, {
          ...callContext,
          result: boundText(output, 2_048)
        }, diagnostics, activeSignal)
        return output
      },
      finish: async (result) => {
        if (finished) return
        finished = true
        await this.#runHooks('afterTurn', hooks.afterTurn, {
          ...hookContext,
          status: result.status,
          message: boundText(result.message ?? '', 2_048)
        }, diagnostics, context.signal)
        await close()
        this.#turnSessions.delete(extensionSession)
      },
      dispose: async () => {
        await close()
        this.#turnSessions.delete(extensionSession)
      }
    }
    this.#turnSessions.add(extensionSession)
    return extensionSession
  }

  resetOwner(ownerWebContentsId: number): void {
    this.#registry.resetOwner(ownerWebContentsId)
    this.#owners.delete(ownerWebContentsId)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const sessions = [...this.#turnSessions]
    this.#turnSessions.clear()
    await Promise.allSettled(sessions.map((session) => session.dispose()))
    for (const owner of this.#owners.keys()) this.#registry.resetOwner(owner)
    this.#owners.clear()
  }

  #owner(ownerWebContentsId: number): OwnerExtensionState {
    const existing = this.#owners.get(ownerWebContentsId)
    if (existing) return existing
    const state: OwnerExtensionState = {
      selectedSkills: new Map(),
      enabledPlugins: new Map(),
      pluginGrants: new Map()
    }
    this.#owners.set(ownerWebContentsId, state)
    return state
  }

  async #invokePlugin(
    scope: ExtensionScope,
    action: ExtensionAction,
    authorize: ExtensionInvokeAuthorization['authorizePluginUse']
  ): Promise<CapabilityExecuteResult> {
    const owner = this.#owner(scope.ownerWebContentsId)
    const disabling = /^(?:off|disable|disabled)$/iu.test(action.args?.trim() ?? '')
    if (disabling) {
      owner.enabledPlugins.delete(action.id)
      return { id: action.id, status: 'completed', message: '扩展已停用。' }
    }
    if (!action.grantHandle) {
      return { id: action.id, status: 'requires-approval', message: '启用扩展需要确认本地权限。' }
    }
    const binding = owner.pluginGrants.get(action.grantHandle)
    owner.pluginGrants.delete(action.grantHandle)
    if (
      !binding ||
      binding.descriptor.id !== action.id ||
      (binding.workspaceKey !== null && binding.workspaceKey !== workspaceKey(scope.workspace))
    ) {
      return { id: action.id, status: 'not-ready', message: '扩展信息已变化，请刷新后重试。' }
    }
    if (!authorize || !await authorize(clonePluginDescriptor(binding.descriptor))) {
      return { id: action.id, status: 'requires-approval', message: '扩展保持停用。' }
    }
    const manifestSource = await this.#registry.consumePluginGrant({
      id: action.id,
      grantHandle: action.grantHandle,
      ownerWebContentsId: scope.ownerWebContentsId,
      ...(scope.workspace === undefined ? {} : { workspace: scope.workspace })
    })
    const manifest = manifestSource === null ? null : parsePluginManifestSource(manifestSource)
    if (!manifest) {
      return { id: action.id, status: 'not-ready', message: '扩展配置无法读取，请刷新后重试。' }
    }
    const requiredPermissions = requiredPluginPermissions(manifest)
    if (!requiredPermissions.every((permission) => binding.descriptor.permissions.includes(permission))) {
      return { id: action.id, status: 'not-ready', message: '扩展声明的权限与实际配置不一致，请修正后刷新。' }
    }
    owner.enabledPlugins.set(action.id, {
      descriptor: { ...clonePluginDescriptor(binding.descriptor), enabled: true },
      manifestPath: binding.manifestPath,
      workspaceKey: binding.workspaceKey,
      manifest
    })
    return { id: action.id, status: 'completed', message: '扩展已启用，将在新的 Agent 任务中生效。' }
  }

  async #resolveDescriptorPath(
    descriptor: PluginDescriptor,
    workspace: CapabilityWorkspaceIdentity | undefined
  ): Promise<string | null> {
    const root = descriptor.scope === 'workspace' ? workspace?.absolutePath : this.#homeDirectory
    if (!root) return null
    return await resolveRegularFileWithin(root, descriptor.relativePath, MAX_MANIFEST_BYTES)
  }

  async #collectDirectMcpServers(
    workspace: CapabilityWorkspaceIdentity | undefined,
    output: Array<{ name: string; value: unknown; cwd: string }>,
    diagnostics: string[]
  ): Promise<void> {
    const roots = [this.#homeDirectory, ...(workspace ? [workspace.absolutePath] : [])]
    for (const root of roots) {
      const path = await resolveRegularFileWithin(root, '.mcp.json', MAX_MANIFEST_BYTES)
      if (!path) continue
      const parsed = await readJsonRecord(path, MAX_MANIFEST_BYTES)
      if (!parsed) {
        diagnostics.push(`${safeLabel(relative(root, path) || '.mcp.json')} 无法解析，已跳过。`)
        continue
      }
      const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
      for (const [name, value] of Object.entries(servers)) output.push({ name, value, cwd: root })
    }
  }

  async #runHooks(
    name: ExtensionHookName,
    hooks: readonly { hook: HookCommand; cwd: string }[],
    context: Readonly<Record<string, string>>,
    diagnostics: string[],
    signal?: AbortSignal
  ): Promise<string> {
    const outputs: string[] = []
    for (const { hook, cwd } of hooks) {
      try {
        throwIfSignalAborted(signal)
        const output = await this.#runHook({ name, ...hook, cwd, context, signal })
        throwIfSignalAborted(signal)
        if (output.trim()) outputs.push(boundText(redactSensitiveContent(output), MAX_HOOK_OUTPUT_BYTES))
      } catch (error) {
        diagnostics.push(`扩展钩子 ${name} 未完成：${safeExtensionError(error)}`)
      }
    }
    return outputs.join('\n\n')
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('The extension host is disposed.')
  }
}

function collectHooks(plugins: readonly EnabledPlugin[]): Record<ExtensionHookName, Array<{ hook: HookCommand; cwd: string }>> {
  const result: Record<ExtensionHookName, Array<{ hook: HookCommand; cwd: string }>> = {
    beforeTurn: [],
    afterTurn: [],
    beforeTool: [],
    afterTool: []
  }
  for (const plugin of plugins) {
    const cwd = dirname(plugin.manifestPath)
    for (const name of Object.keys(result) as ExtensionHookName[]) {
      for (const hook of plugin.manifest.hooks[name] ?? []) result[name].push({ hook, cwd })
    }
  }
  return result
}

function parsePluginManifestSource(source: string): PluginManifest | null {
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) return null
  let value: unknown
  try { value = JSON.parse(source) } catch { return null }
  return isRecord(value) ? parsePluginManifest(value) : null
}

function parsePluginManifest(value: Record<string, unknown>): PluginManifest {
  const instructions = parseInstructions(value.instructions)
  if (typeof value.prompt === 'string') instructions.push(value.prompt)
  const mcpServers = isRecord(value.mcpServers) ? value.mcpServers : {}
  const hooks = parseHooks(value.hooks)
  return {
    instructions: Object.freeze(instructions.map(boundInstruction).filter(Boolean)),
    mcpServers: Object.freeze({ ...mcpServers }),
    hooks
  }
}

function requiredPluginPermissions(manifest: PluginManifest): Array<'execute' | 'network'> {
  const required = new Set<'execute' | 'network'>()
  if (Object.keys(manifest.mcpServers).length > 0) {
    required.add('execute')
    required.add('network')
  }
  if (Object.values(manifest.hooks).some((hooks) => (hooks?.length ?? 0) > 0)) {
    required.add('execute')
  }
  return [...required]
}

function parseInstructions(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, 16)
}

function parseHooks(value: unknown): PluginManifest['hooks'] {
  if (!isRecord(value)) return {}
  const result: Partial<Record<ExtensionHookName, readonly HookCommand[]>> = {}
  for (const name of ['beforeTurn', 'afterTurn', 'beforeTool', 'afterTool'] as const) {
    const entries = Array.isArray(value[name]) ? value[name] : value[name] === undefined ? [] : [value[name]]
    const commands = entries.map(parseHookCommand).filter((item): item is HookCommand => item !== null).slice(0, 8)
    if (commands.length > 0) result[name] = Object.freeze(commands)
  }
  return Object.freeze(result)
}

function parseHookCommand(value: unknown): HookCommand | null {
  if (!isRecord(value) || typeof value.command !== 'string' || !safeExecutable(value.command)) return null
  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === 'string' && safeArgument(item)).slice(0, 64)
    : []
  const env = parseStringRecord(value.env, 64)
  return { command: value.command, args: Object.freeze(args), env: Object.freeze(env) }
}

function parseMcpConnectionConfig(value: unknown, cwd: string): McpConnectionConfig | null {
  if (!isRecord(value)) return null
  const timeout = typeof value.requestTimeoutMs === 'number' && Number.isSafeInteger(value.requestTimeoutMs)
    ? Math.max(1_000, Math.min(value.requestTimeoutMs, 120_000))
    : undefined
  const url = typeof value.url === 'string' ? value.url : typeof value.httpUrl === 'string' ? value.httpUrl : undefined
  if (url) {
    let parsed: URL
    try { parsed = new URL(url) } catch { return null }
    if (parsed.protocol !== 'https:' && !isLoopbackUrl(parsed)) return null
    const rawHeaders = parseStringRecord(value.headers, 64)
    const authorization = rawHeaders.authorization ?? rawHeaders.Authorization
    delete rawHeaders.authorization
    delete rawHeaders.Authorization
    return {
      transport: 'http',
      url: parsed.toString(),
      headers: Object.freeze(rawHeaders),
      ...(authorization === undefined ? {} : { getAuthorizationHeader: async () => resolveEnvReferences(authorization) }),
      ...(timeout === undefined ? {} : { requestTimeoutMs: timeout })
    }
  }
  if (typeof value.command !== 'string' || !safeExecutable(value.command)) return null
  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === 'string' && safeArgument(item)).slice(0, 128)
    : []
  const env = Object.fromEntries(Object.entries(parseStringRecord(value.env, 128)).map(([key, item]) => [
    key,
    resolveEnvReferences(item)
  ]))
  const configuredCwd = typeof value.cwd === 'string' && value.cwd.trim()
    ? (isAbsolute(value.cwd) ? resolve(value.cwd) : resolve(cwd, value.cwd))
    : cwd
  return {
    transport: 'stdio',
    command: value.command,
    args: Object.freeze(args),
    cwd: configuredCwd,
    env: Object.freeze(env),
    ...(value.framing === 'content-length' ? { framing: 'content-length' as const } : {}),
    ...(timeout === undefined ? {} : { requestTimeoutMs: timeout })
  }
}

function mcpToolDefinition(
  localName: string,
  tool: McpTool
): ResponsesFunctionToolDefinition | null {
  const schema = normalizeMcpInputSchema(tool.inputSchema)
  if (!schema) return null
  return Object.freeze({
    type: 'function',
    name: localName,
    description: boundText(tool.description ?? `MCP tool ${tool.name}`, 1_024),
    strict: false,
    parameters: schema as ResponsesJsonObject
  })
}

function uniqueToolName(server: string, remote: string, existing: ReadonlyMap<string, unknown>): string {
  const base = `${MCP_PREFIX}${toolSegment(server)}__${toolSegment(remote)}`.slice(0, 64)
  let candidate = base
  let suffix = 2
  while (existing.has(candidate)) candidate = `${base.slice(0, 58)}_${suffix++}`
  return candidate
}

function toolSegment(value: string): string {
  const normalized = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '')
  return normalized || 'tool'
}

function normalizeMcpInputSchema(value: unknown): ResponsesJsonObject | null {
  if (!isRecord(value) || value.type !== 'object') return null
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return null
  }
  if (Buffer.byteLength(serialized, 'utf8') > 128 * 1024) return null
  let nodes = 0
  const inspect = (candidate: unknown, depth: number): boolean => {
    if (depth > 24 || ++nodes > 2_048) return false
    if (candidate === null || typeof candidate !== 'object') return true
    if (Array.isArray(candidate)) return candidate.every((item) => inspect(item, depth + 1))
    return Object.entries(candidate as Record<string, unknown>).every(([key, item]) => (
      key.length <= 256 && inspect(item, depth + 1)
    ))
  }
  if (!inspect(value, 0)) return null
  return structuredClone(value) as ResponsesJsonObject
}

function formatMcpToolResult(result: McpToolCallResult): string {
  const safe = redactSensitiveContent(JSON.stringify(result, null, 2))
  return boundText(safe, MAX_MCP_OUTPUT_BYTES)
}

function asToolArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error('Extension tool arguments must be an object.')
  return structuredClone(value)
}

async function connectWithCancellation(
  connection: Promise<McpSession>,
  signal: AbortSignal | undefined
): Promise<McpSession> {
  if (!signal) return await connection
  if (signal.aborted) {
    void connection.then((session) => session.close(), () => undefined)
    throw new McpClientError('cancelled')
  }
  return await new Promise<McpSession>((resolvePromise, reject) => {
    let settled = false
    const finish = (session: McpSession | null, error?: unknown): void => {
      if (settled) {
        if (session) void session.close()
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (session) resolvePromise(session)
      else reject(error)
    }
    const onAbort = (): void => finish(null, new McpClientError('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    void connection.then(
      (session) => signal.aborted
        ? (void session.close().finally(() => finish(null, new McpClientError('cancelled'))))
        : finish(session),
      (error) => finish(null, error)
    )
  })
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new McpClientError('cancelled')
}

function isMcpCancellation(error: unknown): boolean {
  return error instanceof McpClientError && error.code === 'cancelled'
}

async function runDeclaredHook(input: ExtensionHookInvocation): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const env = {
      PATH: process.env.PATH ?? '',
      Path: process.env.Path ?? '',
      PATHEXT: process.env.PATHEXT ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      ...Object.fromEntries(Object.entries(input.env).map(([key, value]) => [key, resolveEnvReferences(value)])),
      AI_TERMINAL_HOOK: input.name,
      AI_TERMINAL_TASK_ID: input.context.taskId ?? '',
      AI_TERMINAL_TURN_ID: input.context.turnId ?? '',
      AI_TERMINAL_TOOL: input.context.tool ?? '',
      AI_TERMINAL_SERVER: input.context.server ?? '',
      AI_TERMINAL_STATUS: input.context.status ?? '',
      AI_TERMINAL_RESULT: input.context.result ?? ''
    }
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let bytes = 0
    const collect = (chunk: Buffer): void => {
      if (bytes >= MAX_HOOK_OUTPUT_BYTES) return
      const remaining = MAX_HOOK_OUTPUT_BYTES - bytes
      const bounded = chunk.subarray(0, remaining)
      chunks.push(bounded)
      bytes += bounded.length
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let settled = false
    const finish = (error: Error | null, output = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolvePromise(output)
    }
    const stop = (error: Error): void => {
      void terminateHookProcessTree(child, env).finally(() => finish(error))
    }
    const onAbort = (): void => stop(new McpClientError('cancelled'))
    const timer = setTimeout(() => stop(new Error('hook timed out')), HOOK_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error) => {
      finish(error)
    })
    child.once('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8')
      if (code === 0) finish(null, output)
      else finish(new Error(`hook exited with code ${String(code)}`))
    })
    if (input.signal?.aborted) onAbort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function terminateHookProcessTree(
  child: ChildProcess,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR
    if (typeof systemRoot === 'string' && isAbsolute(systemRoot) && !/[\r\n\0]/u.test(systemRoot)) {
      await new Promise<void>((resolvePromise) => {
        const killer = spawn(
          join(systemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' }
        )
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          try { child.kill('SIGKILL') } catch { /* taskkill owns the tree */ }
          resolvePromise()
        }
        const timer = setTimeout(() => {
          try { killer.kill('SIGKILL') } catch { /* bounded fallback */ }
          finish()
        }, 2_000)
        timer.unref?.()
        killer.once('error', finish)
        killer.once('close', finish)
      })
      return
    }
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* direct child fallback */ }
  }
  try { child.kill('SIGKILL') } catch { /* already stopped */ }
}

async function resolveRegularFileWithin(root: string, relativePath: string, maximumBytes: number): Promise<string | null> {
  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, relativePath)
  if (!isWithin(absoluteRoot, candidate)) return null
  try {
    const [realRoot, realCandidate, stats] = await Promise.all([
      fs.realpath(absoluteRoot),
      fs.realpath(candidate),
      fs.lstat(candidate)
    ])
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) return null
    const normalizedRoot = resolve(realRoot)
    const normalizedCandidate = resolve(realCandidate)
    return isWithin(normalizedRoot, normalizedCandidate) ? normalizedCandidate : null
  } catch {
    return null
  }
}

async function readJsonRecord(path: string, maximumBytes: number): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await fs.readFile(path)
    if (bytes.length > maximumBytes) return null
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function workspaceKey(workspace: CapabilityWorkspaceIdentity | undefined): string | null {
  return workspace ? `${workspace.device}:${workspace.inode}` : null
}

function clonePluginDescriptor(plugin: PluginDescriptor): PluginDescriptor {
  return { ...plugin, permissions: [...plugin.permissions] }
}

function parseStringRecord(value: unknown, maximumEntries: number): Record<string, string> {
  if (!isRecord(value)) return {}
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value).slice(0, maximumEntries)) {
    if (/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(key) && typeof item === 'string' && item.length <= 32_768) {
      output[key] = item
    }
  }
  return output
}

function resolveEnvReferences(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => process.env[name] ?? '')
}

function safeExecutable(value: string): boolean {
  return value.length > 0 && value.length <= 32_768 && !/[\0\r\n]/u.test(value)
}

function safeArgument(value: string): boolean {
  return value.length <= 32_768 && !value.includes('\0')
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundInstruction(value: string): string {
  return boundText(redactSensitiveContent(value), MAX_INSTRUCTION_BYTES).trim()
}

function boundText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return bytes.subarray(0, maximumBytes).toString('utf8')
}

function safeLabel(value: string): string {
  return boundText(value.replace(/[\0\r\n]/gu, ' ').trim(), 160) || 'extension'
}

function safeExtensionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return boundText(redactSensitiveText(message), 512)
}
