import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat } from 'node:fs/promises'
import { app, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  assetListSchema,
  assetExportSchema,
  assetMaskSaveSchema,
  assetUpdateSchema,
  assetUrlSchema,
  clipboardWriteSchema,
  boardDeleteSchema,
  boardUpsertSchema,
  collectionListSchema,
  diagnosticExportSchema,
  projectCreateSchema,
  projectImageImportSchema,
  projectOpenSchema,
  pluginDeleteSchema,
  pluginListSchema,
  pluginUpsertSchema,
  presetDeleteSchema,
  presetExportSchema,
  presetImportSchema,
  presetListSchema,
  presetUpsertSchema,
  providerDeleteSchema,
  providerImportDecisionSchema,
  providerProbeSchema,
  runCancelSchema,
  persistentRunActionSchema,
  persistentRunListSchema,
  runPrepareSchema,
  runListSchema,
  runStartSchema,
  smartCollectionDeleteSchema,
  smartCollectionUpsertSchema,
  taskListSchema,
  workflowLoadSchema,
  workflowSaveSchema,
  workflowDraftLoadSchema,
  workflowDraftSaveSchema,
  workflowDraftDiscardSchema,
  workflowVersionListSchema,
  workflowVersionLoadSchema,
  workflowDuplicateSchema,
  workflowArchiveSchema,
  workflowArchiveListSchema,
  workflowArchiveRestoreSchema,
  workflowPackageExportSchema,
  workflowPackageImportSchema,
  studioCopilotPlanRequestSchema,
  type PersistentRunSummary,
} from '../../studio/shared/contracts.js'
import {
  createStudioInvokeRegistrationTracker,
  type StudioInputInvokeOperationName,
  type StudioNoInputInvokeOperationName,
} from '../../studio/shared/ipc-channels.js'
import type { AppBootstrap, ProjectSummary, WorkflowDocument } from '../../studio/shared/types.js'
import { flattenSubgraphs } from '../../studio/core/subgraphs.js'
import { createWorkflowPackage, inspectWorkflowPackage, parseWorkflowPackage } from '../../studio/core/workflowPackage.js'
import {
  buildImagesEditRequestUrl,
  buildImagesGenerationRequestUrl,
} from '../services/images-client.js'
import { AssetProtocol } from './assetProtocol.js'
import { exportDiagnosticBundle } from './diagnostics.js'
import { asStudioError, redactText, StudioError } from './errors.js'
import {
  buildStudioModelsRequestUrl,
  probeProvider,
} from './network.js'
import { ProjectStore, type PersistentRunQueueItem } from './projects.js'
import { atomicWriteJson, readJson, safeFilename } from './filesystem.js'
import { ProviderImportController } from './providerImports.js'
import { ProviderStore } from './providers.js'
import { assertStudioAccountProvider, isRemoteImageNodeType, WorkflowRunner } from './runner.js'
import { StudioPathTokenStore } from './path-token-store.js'
import type { StudioCopilotService } from './studio-copilot-service.js'

interface IpcDependencies {
  readonly projects: ProjectStore
  readonly providers: ProviderStore
  readonly providerImports: ProviderImportController
  readonly runner: WorkflowRunner
  readonly copilot: Pick<StudioCopilotService, 'plan'>
  readonly assets: AssetProtocol
  readonly paths: StudioPathTokenStore
  readonly getWindow: () => BrowserWindow | undefined
  readonly isSessionUnlocked: () => boolean
  readonly ensureEndpointConsent: (endpoints: readonly string[]) => Promise<void>
  readonly allowedRendererOrigin?: string
}

export interface StudioIpcRegistration {
  dispose(): void
}

const projectPathSchema = z.string().trim().min(1).max(4096)

const trustedSender = (
  event: IpcMainInvokeEvent,
  window: BrowserWindow | undefined,
  developmentOrigin: string | undefined,
): boolean => {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) return false
  const senderFrame = event.senderFrame
  if (!senderFrame || senderFrame.routingId !== event.sender.mainFrame.routingId) return false
  let url: URL
  try {
    url = new URL(senderFrame.url)
  } catch {
    return false
  }
  if (developmentOrigin) return url.origin === developmentOrigin
  if (url.protocol !== 'file:') return false
  if (url.search || url.hash) return false
  try {
    const actual = path.resolve(fileURLToPath(url))
    const expected = path.resolve(app.getAppPath(), 'out', 'renderer', 'index.html')
    return process.platform === 'win32'
      ? actual.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
      : actual === expected
  } catch {
    return false
  }
}

const publicError = (error: unknown): Error => {
  const studioError = asStudioError(error)
  return new Error(`[${studioError.code}] ${redactText(studioError.message)}`)
}

const persistentRunSummary = (item: PersistentRunQueueItem): PersistentRunSummary => {
  const providerIds = new Set<string>()
  const visitedWorkflows = new Set<string>()
  const collectProviders = (workflow: WorkflowDocument): void => {
    if (visitedWorkflows.has(workflow.id)) return
    visitedWorkflows.add(workflow.id)
    workflow.nodes.forEach((node) => {
      const providerId = node.parameters.providerId
      if (typeof providerId === 'string' && providerId.trim()) providerIds.add(providerId.trim())
    })
    workflow.subgraphs?.forEach((definition) => collectProviders(definition.workflow))
  }
  collectProviders(item.workflow)
  const dispatchState = item.dispatchState
    ?? (item.status === 'pending' ? 'not_sent' : 'billing_unknown')
  const canResume = item.status === 'paused' && dispatchState === 'not_sent'
  const canRemove = canResume
  const blockedReason = canResume
    ? undefined
    : dispatchState === 'sent'
      ? '请求已经发送到 Provider；为避免重复扣费，恢复已禁用，请先人工核对 Provider 记录。'
      : dispatchState === 'billing_unknown'
        ? '无法确认请求是否已经发送或计费；为避免重复扣费，恢复已禁用，请先人工核对 Provider 记录。'
        : item.status === 'running'
          ? '任务仍由主进程管理，不能重复恢复。'
          : '任务尚未进入可恢复状态。'
  return {
    id: item.id,
    projectId: item.projectId,
    workflowId: item.workflowId,
    workflowName: item.workflow.name,
    providerIds: [...providerIds].sort(),
    status: item.status,
    priority: item.priority,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    targetNodeIds: [...item.targetNodeIds],
    attempt: item.attempt,
    dispatchState,
    ...(item.lastError ? { lastError: redactText(item.lastError) } : {}),
    canResume,
    canRemove,
    ...(blockedReason ? { blockedReason } : {}),
  }
}

export const registerIpc = (dependencies: IpcDependencies): StudioIpcRegistration => {
  const registrations = createStudioInvokeRegistrationTracker()
  const resolveProjectPath = (token: string): string => dependencies.paths.resolveProject(token)
  const presentProject = (project: ProjectSummary): ProjectSummary => ({
    ...project,
    path: dependencies.paths.issueProject(project.path),
  })
  const ensureWorkflowEndpointConsent = async (workflow: WorkflowDocument): Promise<void> => {
    const providerNeeds = new Map<string, { generation: boolean; edit: boolean }>()
    for (const node of flattenSubgraphs(workflow).nodes) {
      const providerId = node.parameters.providerId
      const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : ''
      if (normalizedProviderId && !providerNeeds.has(normalizedProviderId)) {
        providerNeeds.set(normalizedProviderId, { generation: false, edit: false })
      }
      if (!isRemoteImageNodeType(node.type)) continue
      if (!normalizedProviderId) assertStudioAccountProvider(undefined)
      const needs = providerNeeds.get(normalizedProviderId)!
      if (node.type === 'image_generation') needs.generation = true
      else needs.edit = true
    }
    const endpoints = (await Promise.all([...providerNeeds].map(async ([providerId, needs]) => {
      const descriptor = await dependencies.providers.descriptor(providerId)
      if (needs.generation || needs.edit) assertStudioAccountProvider(descriptor)
      if (descriptor.kind !== 'openai-compatible') return [descriptor.baseUrl]
      const urls: string[] = []
      if (needs.generation) {
        urls.push(buildImagesGenerationRequestUrl(
          descriptor.baseUrl,
          descriptor.imageGenerationPath,
        ))
      }
      if (needs.edit) {
        if (descriptor.imageGenerationPath !== undefined && descriptor.imageEditPath === undefined) {
          throw new StudioError(
            'account-provider-edit-endpoint-unavailable',
            '登录账户声明的 image-generation 路径无法安全派生图片编辑地址',
          )
        }
        urls.push(buildImagesEditRequestUrl(descriptor.baseUrl, descriptor.imageEditPath))
      }
      if (urls.length === 0) urls.push(descriptor.baseUrl)
      return urls
    }))).flat()
    await dependencies.ensureEndpointConsent(endpoints)
  }
  const invoke = async <TResult>(
    event: IpcMainInvokeEvent,
    operation: () => Promise<TResult> | TResult,
  ): Promise<TResult> => {
    if (!trustedSender(event, dependencies.getWindow(), dependencies.allowedRendererOrigin)) {
      throw new Error('不可信的渲染进程 IPC 请求')
    }
    if (!dependencies.isSessionUnlocked()) throw new Error('请先登录 AI终点站账户')
    try {
      return await operation()
    } catch (error) {
      throw publicError(error)
    }
  }
  const handleInput = <TSchema extends z.ZodType, TResult>(
    operationName: StudioInputInvokeOperationName,
    schema: TSchema,
    operation: (input: z.output<TSchema>, event: IpcMainInvokeEvent) => Promise<TResult> | TResult,
  ): void => {
    const channel = registrations.registerInput(operationName)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, raw: unknown) => invoke(event, () => operation(schema.parse(raw) as z.output<TSchema>, event)))
  }
  const handleNoInput = <TResult>(
    operationName: StudioNoInputInvokeOperationName,
    operation: (event: IpcMainInvokeEvent) => Promise<TResult> | TResult,
  ): void => {
    const channel = registrations.registerNoInput(operationName)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event) => invoke(event, () => operation(event)))
  }

  handleNoInput('bootstrap', async (): Promise<AppBootstrap> => {
    const [listedProviders, projects, recentProjectPath] = await Promise.all([
      dependencies.providers.list(),
      dependencies.projects.listManaged?.() ?? Promise.resolve([]),
      dependencies.projects.recentManagedProjectPath?.() ?? Promise.resolve(undefined),
    ])
    const providers = listedProviders.filter((provider) => provider.managedBy === 'ai-terminal-account')
    return {
      version: app.getVersion(),
      platform: process.platform as AppBootstrap['platform'],
      projects: projects.map(presentProject),
      providers,
      ...(recentProjectPath ? { recentProjectPath: dependencies.paths.issueProject(recentProjectPath) } : {}),
    }
  })
  handleInput('createProject', projectCreateSchema, async (input) => presentProject(await dependencies.projects.createManaged(
    input.name,
    input.initialWorkflow as WorkflowDocument | undefined,
  )))
  handleInput('openProject', projectOpenSchema, async (input) => presentProject(
    await dependencies.projects.openManaged(resolveProjectPath(input.path))
  ))
  handleInput('listWorkflows', projectPathSchema, (projectToken) => dependencies.projects.listWorkflows(resolveProjectPath(projectToken)))
  handleInput('loadWorkflow', workflowLoadSchema, (input) => dependencies.projects.loadWorkflow(resolveProjectPath(input.projectPath), input.workflowId))
  handleInput('saveWorkflow', workflowSaveSchema, (input) => dependencies.projects.saveWorkflow(resolveProjectPath(input.projectPath), input.workflow as unknown as WorkflowDocument))
  handleInput('loadWorkflowDraft', workflowDraftLoadSchema, (input) => dependencies.projects.loadWorkflowDraft(resolveProjectPath(input.projectPath), input.workflowId))
  handleInput('saveWorkflowDraft', workflowDraftSaveSchema, (input) => dependencies.projects.saveWorkflowDraft(resolveProjectPath(input.projectPath), input.workflow as unknown as WorkflowDocument))
  handleInput('discardWorkflowDraft', workflowDraftDiscardSchema, (input) => dependencies.projects.discardWorkflowDraft(resolveProjectPath(input.projectPath), input.workflowId))
  handleInput('listWorkflowVersions', workflowVersionListSchema, (input) => dependencies.projects.listWorkflowVersions(resolveProjectPath(input.projectPath), input.workflowId))
  handleInput('loadWorkflowVersion', workflowVersionLoadSchema, (input) => dependencies.projects.loadWorkflowVersion(resolveProjectPath(input.projectPath), input.workflowId, input.revision))
  handleInput('duplicateWorkflow', workflowDuplicateSchema, (input) => dependencies.projects.duplicateWorkflow(resolveProjectPath(input.projectPath), input.workflowId, input.name))
  handleInput('archiveWorkflow', workflowArchiveSchema, (input) => dependencies.projects.archiveWorkflow(resolveProjectPath(input.projectPath), input.workflowId))
  handleInput('listArchivedWorkflows', workflowArchiveListSchema, (input) => dependencies.projects.listArchivedWorkflows(resolveProjectPath(input.projectPath)))
  handleInput('restoreArchivedWorkflow', workflowArchiveRestoreSchema, (input) => dependencies.projects.restoreArchivedWorkflow(resolveProjectPath(input.projectPath), input.archiveId))
  handleInput('exportWorkflowPackage', workflowPackageExportSchema, async (input) => {
    await dependencies.projects.summary(resolveProjectPath(input.projectPath))
    const workflow = input.workflow as unknown as WorkflowDocument
    const plugins = await dependencies.projects.listPlugins(resolveProjectPath(input.projectPath))
    const portable = createWorkflowPackage(workflow, { plugins })
    const options: Electron.SaveDialogOptions = {
      title: '导出可移植 Workflow 包',
      defaultPath: `${safeFilename(workflow.name, 'workflow')}.aistudio-workflow.json`,
      filters: [{ name: 'AI 终点站 Workflow 包', extensions: ['json'] }],
    }
    const parent = dependencies.getWindow()
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false as const }
    await atomicWriteJson(result.filePath, portable)
    return { saved: true as const }
  })
  handleInput('importWorkflowPackage', workflowPackageImportSchema, async (input) => {
    await dependencies.projects.summary(resolveProjectPath(input.projectPath))
    const options: Electron.OpenDialogOptions = {
      title: '导入可移植 Workflow 包',
      properties: ['openFile'],
      filters: [{ name: 'AI 终点站 Workflow 包', extensions: ['json'] }],
    }
    const parent = dependencies.getWindow()
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const selected = result.canceled ? undefined : result.filePaths[0]
    if (!selected) return { imported: false as const }
    const details = await lstat(selected)
    if (details.isSymbolicLink() || !details.isFile() || details.size > 128 * 1024 * 1024) {
      throw new StudioError('workflow-package-file-invalid', 'Workflow 包必须是普通 JSON 文件且不超过 128 MiB')
    }
    const raw = await readJson(selected)
    const portable = parseWorkflowPackage(raw)
    const [providers, plugins] = await Promise.all([
      dependencies.providers.list(),
      dependencies.projects.listPlugins(resolveProjectPath(input.projectPath)),
    ])
    return {
      imported: true as const,
      workflow: portable.workflow,
      compatibility: inspectWorkflowPackage(portable, {
        providerIds: providers.map((provider) => provider.id),
        plugins,
      }),
    }
  })
  handleInput('planWorkflow', studioCopilotPlanRequestSchema, (input) => dependencies.copilot.plan({
    providerId: input.providerId,
    workflow: input.workflow as unknown as WorkflowDocument,
    instruction: input.instruction,
    ...(input.selectedNodeIds === undefined ? {} : { selectedNodeIds: input.selectedNodeIds }),
  }))
  handleNoInput('listProviders', async () => (await dependencies.providers.list()).filter((provider) => provider.managedBy === 'ai-terminal-account'))
  handleInput('upsertProvider', z.unknown(), () => {
    throw new StudioError(
      'studio-account-provider-required',
      'Studio 仅允许使用当前账户分组，不能保存独立 Provider',
    )
  })
  handleInput('deleteProvider', providerDeleteSchema, async (input) => {
    if (input.providerId.startsWith('account-group-')) {
      throw new StudioError('managed-provider-read-only', '登录账户分组由 AI-terminal 会话管理，不能删除')
    }
    throw new StudioError(
      'studio-account-provider-required',
      'Studio 仅允许使用当前账户分组，不能删除独立 Provider',
    )
  })
  handleNoInput('listProviderImports', () => [])
  handleInput('acceptProviderImport', providerImportDecisionSchema, () => {
    throw new StudioError(
      'studio-account-provider-required',
      'Studio 不接受独立 Provider 导入；请从账户分组中选择模型',
    )
  })
  handleInput('dismissProviderImport', providerImportDecisionSchema, (input) => dependencies.providerImports.dismiss(input.requestId))
  handleInput('probeProvider', providerProbeSchema, async (input) => {
    const descriptor = await dependencies.providers.descriptor(input.providerId)
    assertStudioAccountProvider(descriptor)
    if (descriptor.kind !== 'openai-compatible') {
      throw new StudioError(
        'studio-account-provider-required',
        '当前账户分组必须提供 OpenAI-compatible 图片路由',
      )
    }
    try {
      await dependencies.ensureEndpointConsent([
        buildStudioModelsRequestUrl(descriptor.baseUrl),
      ])
      const credentials = await dependencies.providers.credentials(input.providerId, descriptor.defaultModel)
      if (!('apiKey' in credentials) || credentials.descriptor.managedBy !== 'ai-terminal-account') {
        throw new StudioError('studio-account-provider-required', 'Studio 仅允许使用当前账户凭据')
      }
      const models = await probeProvider({
        ...credentials,
        ensureEndpointConsent: (endpoint) => dependencies.ensureEndpointConsent([endpoint]),
      })
      return { ok: true, message: `连接成功，发现 ${models.length} 个模型`, models }
    } catch (error) {
      const studioError = asStudioError(error)
      const detail = redactText(studioError.message)
      const message = studioError.code === 'provider-probe-failed'
        ? `仅 GET /v1/models 探测未通过：${detail}。配置不会被禁用；部分只开放图片路由的中转仍可正常生图。为避免费用，连接测试不会自动 POST 生图。`
        : detail
      return { ok: false, message, models: [] }
    }
  })
  handleInput('prepareRun', runPrepareSchema, (input) => dependencies.runner.prepare({
    projectPath: resolveProjectPath(input.projectPath),
    workflow: input.workflow as unknown as WorkflowDocument,
    ...(input.targetNodeIds === undefined ? {} : { targetNodeIds: input.targetNodeIds }),
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
  }))
  handleInput('startRun', runStartSchema, async (input) => {
    const workflow = input.workflow as unknown as WorkflowDocument
    await ensureWorkflowEndpointConsent(workflow)
    return dependencies.runner.start({
      projectPath: resolveProjectPath(input.projectPath),
      workflow,
      planId: input.planId,
      ...(input.targetNodeIds === undefined ? {} : { targetNodeIds: input.targetNodeIds }),
      ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
    })
  })
  handleInput('cancelRun', runCancelSchema, (input) => dependencies.runner.cancel(input.runId))
  handleInput('listPersistentRuns', persistentRunListSchema, async (input) =>
    (await dependencies.projects.listQueuedRuns(resolveProjectPath(input.projectPath))).map(persistentRunSummary))
  handleInput('resumePersistentRun', persistentRunActionSchema, async (input) => {
    const projectPath = resolveProjectPath(input.projectPath)
    const item = (await dependencies.projects.listQueuedRuns(projectPath)).find((candidate) => candidate.id === input.itemId)
    if (!item) throw new StudioError('persistent-run-not-found', '持久运行项不存在')
    const consentedWorkflow = structuredClone(item.workflow)
    await ensureWorkflowEndpointConsent(consentedWorkflow)
    return dependencies.runner.resumePersistent(projectPath, input.itemId, consentedWorkflow)
  })
  handleInput('removePersistentRun', persistentRunActionSchema, async (input) => {
    const item = (await dependencies.projects.listQueuedRuns(resolveProjectPath(input.projectPath))).find((candidate) => candidate.id === input.itemId)
    if (!item) return false
    const dispatchState = item.dispatchState ?? (item.status === 'pending' ? 'not_sent' : 'billing_unknown')
    if (item.status !== 'paused' || dispatchState !== 'not_sent') {
      throw new StudioError('persistent-run-remove-blocked', '只能移除明确尚未派发的暂停恢复项')
    }
    return dependencies.projects.removeQueuedRun(resolveProjectPath(input.projectPath), input.itemId)
  })
  handleInput('listAssets', assetListSchema, (input) => dependencies.projects.listAssets(resolveProjectPath(input.projectPath)))
  handleInput('assetUrl', assetUrlSchema, async (input) => {
    await dependencies.projects.resolveExistingAsset(resolveProjectPath(input.projectPath), input.relativePath)
    return dependencies.assets.grant(resolveProjectPath(input.projectPath), input.relativePath)
  })
  handleInput('updateAsset', assetUpdateSchema, (input) => dependencies.projects.updateAsset(resolveProjectPath(input.projectPath), input.assetId, {
    ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  }))
  handleInput('exportAssets', assetExportSchema, async (input) => {
    await dependencies.projects.summary(resolveProjectPath(input.projectPath))
    const options: Electron.OpenDialogOptions = {
      title: '选择作品导出目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const parent = dependencies.getWindow()
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const destination = result.canceled ? undefined : result.filePaths[0]
    if (!destination) return { exported: 0 }
    const exported = await dependencies.projects.exportAssets(resolveProjectPath(input.projectPath), input.assetIds, destination, input.filenameTemplate)
    return { exported }
  })
  handleInput('saveAssetMask', assetMaskSaveSchema, (input) => dependencies.projects.saveMask(resolveProjectPath(input.projectPath), input.assetId, input.pngBase64))
  handleInput('importProjectImage', projectImageImportSchema, async (input) => {
    await dependencies.projects.summary(resolveProjectPath(input.projectPath))
    const options: Electron.OpenDialogOptions = {
      title: '导入项目图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    }
    const parent = dependencies.getWindow()
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const source = result.canceled ? undefined : result.filePaths[0]
    if (!source) return { imported: false as const }
    return { imported: true as const, ...(await dependencies.projects.importProjectImage(resolveProjectPath(input.projectPath), source)) }
  })
  handleInput('listCollections', collectionListSchema, (input) => dependencies.projects.listCollections(resolveProjectPath(input.projectPath)))
  handleInput('upsertBoard', boardUpsertSchema, (input) => dependencies.projects.upsertBoard(resolveProjectPath(input.projectPath), input.board))
  handleInput('deleteBoard', boardDeleteSchema, (input) => dependencies.projects.deleteBoard(resolveProjectPath(input.projectPath), input.boardId))
  handleInput('upsertSmartCollection', smartCollectionUpsertSchema, (input) => dependencies.projects.upsertSmartCollection(resolveProjectPath(input.projectPath), {
    id: input.collection.id,
    name: input.collection.name,
    models: input.collection.models,
    workflowIds: input.collection.workflowIds,
    tags: input.collection.tags,
    ...(input.collection.favorite === undefined ? {} : { favorite: input.collection.favorite }),
    ...(input.collection.dateFrom === undefined ? {} : { dateFrom: input.collection.dateFrom }),
    ...(input.collection.dateTo === undefined ? {} : { dateTo: input.collection.dateTo }),
  }))
  handleInput('deleteSmartCollection', smartCollectionDeleteSchema, (input) => dependencies.projects.deleteSmartCollection(resolveProjectPath(input.projectPath), input.collectionId))
  handleInput('listPlugins', pluginListSchema, (input) => dependencies.projects.listPlugins(resolveProjectPath(input.projectPath)))
  handleInput('upsertPlugin', pluginUpsertSchema, (input) => dependencies.projects.upsertPlugin(resolveProjectPath(input.projectPath), {
    enabled: input.plugin.enabled,
    versionLock: input.plugin.versionLock,
    grantedPermissions: input.plugin.grantedPermissions,
    manifest: {
      schemaVersion: 1,
      id: input.plugin.manifest.id,
      name: input.plugin.manifest.name,
      version: input.plugin.manifest.version,
      hostVersion: input.plugin.manifest.hostVersion,
      permissions: input.plugin.manifest.permissions,
      nodeTypes: input.plugin.manifest.nodeTypes,
      dependencies: input.plugin.manifest.dependencies,
      ...(input.plugin.manifest.description === undefined ? {} : { description: input.plugin.manifest.description }),
      ...(input.plugin.manifest.entryPoint === undefined ? {} : { entryPoint: input.plugin.manifest.entryPoint }),
    },
  }))
  handleInput('deletePlugin', pluginDeleteSchema, (input) => dependencies.projects.deletePlugin(resolveProjectPath(input.projectPath), input.pluginId))
  handleInput('listPresets', presetListSchema, (input) => dependencies.projects.listPresets(resolveProjectPath(input.projectPath)))
  handleInput('upsertPreset', presetUpsertSchema, (input) => dependencies.projects.upsertPreset(resolveProjectPath(input.projectPath), input.preset))
  handleInput('deletePreset', presetDeleteSchema, (input) => dependencies.projects.deletePreset(resolveProjectPath(input.projectPath), input.presetId))
  handleInput('importPresets', presetImportSchema, async (input) => {
    await dependencies.projects.summary(resolveProjectPath(input.projectPath))
    const options: Electron.OpenDialogOptions = {
      title: '导入参数/风格预设',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const parent = dependencies.getWindow()
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const source = result.canceled ? undefined : result.filePaths[0]
    if (!source) return { imported: 0, presets: [] }
    const presets = await dependencies.projects.importPresets(resolveProjectPath(input.projectPath), await readJson<unknown>(source))
    return { imported: presets.length, presets }
  })
  handleInput('exportPresets', presetExportSchema, async (input) => {
    const presets = await dependencies.projects.listPresets(resolveProjectPath(input.projectPath))
    const byId = new Map(presets.map((preset) => [preset.id, preset]))
    const selected = input.presetIds.map((id) => byId.get(id))
    if (selected.some((preset) => preset === undefined)) throw new Error('导出列表包含不存在的预设')
    const parent = dependencies.getWindow()
    const options: Electron.SaveDialogOptions = {
      title: '导出参数/风格预设',
      defaultPath: path.join(resolveProjectPath(input.projectPath), 'ai-studio-presets.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false }
    const destination = result.filePath.toLowerCase().endsWith('.json') ? result.filePath : `${result.filePath}.json`
    await atomicWriteJson(destination, { schemaVersion: 1, exportedAt: new Date().toISOString(), presets: selected })
    return { saved: true }
  })
  handleInput('listTasks', taskListSchema, (input) => dependencies.projects.listTasks(resolveProjectPath(input.projectPath)))
  handleInput('listRuns', runListSchema, (input) => dependencies.projects.listRuns(resolveProjectPath(input.projectPath)))
  handleInput('exportDiagnostics', diagnosticExportSchema, async (input) => {
    await dependencies.projects.summary(resolveProjectPath(input.projectPath))
    const parent = dependencies.getWindow()
    const options: Electron.SaveDialogOptions = {
      title: '导出脱敏诊断包',
      defaultPath: path.join(resolveProjectPath(input.projectPath), `diagnostics-${input.runId}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false }
    const destination = result.filePath.toLowerCase().endsWith('.json') ? result.filePath : `${result.filePath}.json`
    await exportDiagnosticBundle(dependencies.projects, resolveProjectPath(input.projectPath), input.runId, destination, app.getVersion())
    return { saved: true }
  })
  handleInput('copyText', clipboardWriteSchema, (input) => {
    clipboard.writeText(input.text)
  })

  registrations.assertComplete()
  let disposed = false
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      registrations.registeredChannels().forEach((channel) => ipcMain.removeHandler(channel))
    },
  }
}
