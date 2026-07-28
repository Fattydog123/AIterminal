import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { createWorkflow } from '../../studio/core/workflow.js'
import { workflowDocumentSchema } from '../../studio/shared/contracts.js'
import type {
  Board,
  CollectionSnapshot,
  GeneratedAsset,
  ProjectSummary,
  ProjectPluginRecord,
  ParameterPresetRecord,
  RunRecordSummary,
  SmartCollection,
  TaskRecord,
  WorkflowDocument,
} from '../../studio/shared/types.js'
import { StudioError, assertNoSecretFields } from './errors.js'
import { atomicWriteJson, ensureDirectory, readJson, safeFilename } from './filesystem.js'
import { AssetCatalogRepository } from './asset-catalog-repository.js'
import { ProjectConfigurationRepository } from './project-configuration-repository.js'
import {
  MutationCoordinator,
  ProjectLayout,
  fallbackProjectFileName,
  projectFileName,
  type ProjectMetadata,
} from './project-persistence.js'
import { RunJournalRepository, type PersistentRunQueueItem } from './run-journal-repository.js'
import {
  WorkflowRepository,
  type ArchivedWorkflowSummary,
  type WorkflowDraftRecord,
  type WorkflowVersionSummary,
} from './workflow-repository.js'

export type { ArchivedWorkflowSummary, WorkflowDraftRecord, WorkflowVersionSummary } from './workflow-repository.js'
export { trimTaskHistory } from './run-journal-repository.js'
export type { PersistentRunQueueItem } from './run-journal-repository.js'

const recentSchema = z.object({
  schemaVersion: z.literal(1),
  recentProjectPath: z.string().optional(),
  projectPaths: z.array(z.string()).max(100),
})

export class ProjectStore {
  readonly #recentFile: string
  readonly #managedProjectsRoot: string | undefined
  readonly #layout = new ProjectLayout()
  readonly #mutations = new MutationCoordinator()
  readonly #workflows = new WorkflowRepository(this.#layout, this.#mutations)
  readonly #assets = new AssetCatalogRepository(this.#layout, this.#mutations)
  readonly #runs = new RunJournalRepository(this.#layout, this.#mutations)
  readonly #configuration = new ProjectConfigurationRepository(this.#layout, this.#mutations)

  constructor(private readonly stateDirectory: string, managedProjectsRoot?: string) {
    this.#recentFile = path.join(stateDirectory, 'projects.json')
    this.#managedProjectsRoot = managedProjectsRoot ? path.resolve(managedProjectsRoot) : undefined
  }

  async initialize(): Promise<void> {
    await Promise.all([
      ensureDirectory(this.stateDirectory),
      ...(this.#managedProjectsRoot ? [ensureDirectory(this.#managedProjectsRoot)] : []),
    ])
  }

  async createManaged(name: string, initialWorkflow?: WorkflowDocument): Promise<ProjectSummary> {
    if (!this.#managedProjectsRoot) {
      throw new StudioError('managed-project-root-unavailable', 'Studio 受管项目目录尚未初始化')
    }
    return this.create(name, this.#managedProjectsRoot, initialWorkflow)
  }

  async create(name: string, parentDirectory: string, initialWorkflow?: WorkflowDocument): Promise<ProjectSummary> {
    const trimmedName = name.trim()
    if (!trimmedName) throw new StudioError('project-name-required', '项目名称不能为空或只包含空白字符')
    const firstWorkflow = initialWorkflow
      ? workflowDocumentSchema.parse(initialWorkflow) as unknown as WorkflowDocument
      : createWorkflow('主工作流')
    assertNoSecretFields(firstWorkflow)
    const directoryName = safeFilename(trimmedName, 'AI-Studio-Project')
    const root = path.join(path.resolve(parentDirectory), directoryName)
    try {
      await mkdir(root, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StudioError('project-exists', `项目目录已存在：${root}`)
      }
      throw error
    }
    const now = new Date().toISOString()
    const metadata: ProjectMetadata = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: trimmedName,
      createdAt: now,
      updatedAt: now,
    }
    await this.#layout.initialize(root, metadata)
    await this.saveWorkflow(root, firstWorkflow)
    await this.remember(root)
    return this.summary(root)
  }

  async open(inputPath: string): Promise<ProjectSummary> {
    const baseName = path.basename(inputPath)
    const root = baseName === projectFileName || baseName === fallbackProjectFileName ? path.dirname(inputPath) : inputPath
    await this.metadata(root)
    await this.#layout.ensure(root)
    await this.remember(root)
    return this.summary(root)
  }

  async openManaged(inputPath: string): Promise<ProjectSummary> {
    if (!this.#managedProjectsRoot) {
      throw new StudioError('managed-project-root-unavailable', 'Studio 受管项目目录尚未初始化')
    }
    const baseName = path.basename(inputPath)
    const requestedRoot = baseName === projectFileName || baseName === fallbackProjectFileName
      ? path.dirname(inputPath)
      : inputPath
    const root = path.resolve(requestedRoot)
    const relativePath = path.relative(this.#managedProjectsRoot, root)
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || relativePath === '..' || path.isAbsolute(relativePath)) {
      throw new StudioError('managed-project-required', 'Studio 只能打开默认工作区中的项目')
    }
    return this.open(root)
  }

  async listRecent(): Promise<readonly ProjectSummary[]> {
    const registry = recentSchema.parse(await readJson(this.#recentFile, { schemaVersion: 1, projectPaths: [] }))
    const summaries = await Promise.all(
      registry.projectPaths.map((projectPath) => this.summary(projectPath).catch(() => undefined)),
    )
    return summaries.filter((item): item is ProjectSummary => item !== undefined)
  }

  async listManaged(): Promise<readonly ProjectSummary[]> {
    if (!this.#managedProjectsRoot) return this.listRecent()
    const entries = await readdir(this.#managedProjectsRoot, { withFileTypes: true })
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.summary(path.join(this.#managedProjectsRoot!, entry.name)).catch(() => undefined)))
    return summaries
      .filter((item): item is ProjectSummary => item !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
  }

  async recentProjectPath(): Promise<string | undefined> {
    const registry = recentSchema.parse(await readJson(this.#recentFile, { schemaVersion: 1, projectPaths: [] }))
    if (registry.recentProjectPath) {
      try {
        await this.metadata(registry.recentProjectPath)
        return registry.recentProjectPath
      } catch {
        // A moved/deleted recent project must not break application bootstrap.
      }
    }
    for (const candidate of registry.projectPaths) {
      try {
        await this.metadata(candidate)
        return candidate
      } catch {
        // Continue to the next still-valid recent project.
      }
    }
    return undefined
  }

  async recentManagedProjectPath(): Promise<string | undefined> {
    if (!this.#managedProjectsRoot) return this.recentProjectPath()
    const [registry, projects] = await Promise.all([this.#readRegistry(), this.listManaged()])
    const managedByPath = new Map(projects.map((project) => [projectPathKey(project.path), project.path]))
    const candidates = [registry.recentProjectPath, ...registry.projectPaths]
    for (const candidate of candidates) {
      if (!candidate) continue
      const managedPath = managedByPath.get(projectPathKey(candidate))
      if (managedPath) return managedPath
    }
    return projects[0]?.path
  }

  async recoverRecentProjectTasks(): Promise<number> {
    const paths = await this.#recoverableProjectPaths()
    let recovered = 0
    for (const projectPath of paths) {
      try {
        await this.metadata(projectPath)
        await this.#layout.ensure(projectPath)
        recovered += await this.recoverInterruptedTasks(projectPath)
      } catch {
        // Missing, moved or damaged historic projects must not block startup.
      }
    }
    return recovered
  }

  async recoverRecentProjectQueues(): Promise<number> {
    const paths = await this.#recoverableProjectPaths()
    let recovered = 0
    for (const projectPath of paths) {
      try {
        await this.metadata(projectPath)
        await this.#layout.ensure(projectPath)
        recovered += await this.recoverInterruptedQueue(projectPath)
      } catch {
        // Missing, moved or damaged historic projects must not block startup.
      }
    }
    return recovered
  }

  async metadata(root: string): Promise<ProjectMetadata> {
    return this.#layout.metadata(root)
  }

  async summary(root: string): Promise<ProjectSummary> {
    const normalized = path.resolve(root)
    const metadata = await this.metadata(normalized)
    const [workflows, assets] = await Promise.all([this.listWorkflows(normalized), this.listAssets(normalized)])
    return {
      id: metadata.id,
      name: metadata.name,
      path: normalized,
      updatedAt: metadata.updatedAt,
      workflowCount: workflows.length,
      assetCount: assets.length,
    }
  }

  async listWorkflows(root: string): Promise<readonly WorkflowDocument[]> {
    return this.#workflows.list(root)
  }

  async loadWorkflow(root: string, workflowId: string): Promise<WorkflowDocument> {
    return this.#workflows.load(root, workflowId)
  }

  async duplicateWorkflow(root: string, workflowId: string, requestedName?: string): Promise<WorkflowDocument> {
    return this.#workflows.duplicate(root, workflowId, requestedName)
  }

  async archiveWorkflow(root: string, workflowId: string): Promise<boolean> {
    return this.#workflows.archive(root, workflowId)
  }

  async listArchivedWorkflows(root: string): Promise<readonly ArchivedWorkflowSummary[]> {
    return this.#workflows.listArchived(root)
  }

  async restoreArchivedWorkflow(root: string, archiveId: string): Promise<WorkflowDocument> {
    return this.#workflows.restoreArchived(root, archiveId)
  }

  async saveWorkflow(root: string, workflow: WorkflowDocument): Promise<WorkflowDocument> {
    return this.#workflows.save(root, workflow)
  }

  async saveWorkflowDraft(root: string, workflow: WorkflowDocument): Promise<WorkflowDraftRecord> {
    return this.#workflows.saveDraft(root, workflow)
  }

  async loadWorkflowDraft(root: string, workflowId: string): Promise<WorkflowDraftRecord | undefined> {
    return this.#workflows.loadDraft(root, workflowId)
  }

  async discardWorkflowDraft(root: string, workflowId: string): Promise<boolean> {
    return this.#workflows.discardDraft(root, workflowId)
  }

  async listWorkflowVersions(root: string, workflowId: string): Promise<readonly WorkflowVersionSummary[]> {
    return this.#workflows.listVersions(root, workflowId)
  }

  async loadWorkflowVersion(root: string, workflowId: string, revision: number): Promise<WorkflowDocument> {
    return this.#workflows.loadVersion(root, workflowId, revision)
  }

  async listAssets(root: string): Promise<readonly GeneratedAsset[]> {
    return this.#assets.list(root)
  }

  async appendAssets(root: string, values: readonly GeneratedAsset[]): Promise<void> {
    return this.#assets.append(root, values)
  }

  async updateAsset(
    root: string,
    assetId: string,
    patch: { readonly favorite?: boolean; readonly decision?: GeneratedAsset['decision']; readonly tags?: readonly string[] },
  ): Promise<GeneratedAsset> {
    return this.#assets.update(root, assetId, patch)
  }

  async exportAssets(
    root: string,
    assetIds: readonly string[],
    destinationDirectory: string,
    filenameTemplate: string,
  ): Promise<number> {
    return this.#assets.export(root, assetIds, destinationDirectory, filenameTemplate)
  }

  async saveMask(root: string, assetId: string, pngBase64: string): Promise<{ readonly relativePath: string; readonly width: number; readonly height: number }> {
    return this.#assets.saveMask(root, assetId, pngBase64)
  }

  async importProjectImage(root: string, sourcePath: string): Promise<{ readonly relativePath: string; readonly width?: number; readonly height?: number }> {
    return this.#assets.importImage(root, sourcePath)
  }

  async listCollections(root: string): Promise<CollectionSnapshot> {
    return this.#assets.collections(root)
  }

  async upsertBoard(root: string, board: Board): Promise<Board> {
    return this.#assets.upsertBoard(root, board)
  }

  async deleteBoard(root: string, boardId: string): Promise<boolean> {
    return this.#assets.deleteBoard(root, boardId)
  }

  async upsertSmartCollection(root: string, collection: SmartCollection): Promise<SmartCollection> {
    return this.#assets.upsertSmartCollection(root, collection)
  }

  async deleteSmartCollection(root: string, collectionId: string): Promise<boolean> {
    return this.#assets.deleteSmartCollection(root, collectionId)
  }

  async listPlugins(root: string): Promise<readonly ProjectPluginRecord[]> {
    return this.#configuration.listPlugins(root)
  }

  async upsertPlugin(root: string, plugin: ProjectPluginRecord): Promise<ProjectPluginRecord> {
    return this.#configuration.upsertPlugin(root, plugin)
  }

  async deletePlugin(root: string, pluginId: string): Promise<boolean> {
    return this.#configuration.deletePlugin(root, pluginId)
  }

  async listPresets(root: string): Promise<readonly ParameterPresetRecord[]> {
    return this.#configuration.listPresets(root)
  }

  async upsertPreset(root: string, preset: ParameterPresetRecord): Promise<ParameterPresetRecord> {
    return this.#configuration.upsertPreset(root, preset)
  }

  async deletePreset(root: string, presetId: string): Promise<boolean> {
    return this.#configuration.deletePreset(root, presetId)
  }

  async importPresets(root: string, raw: unknown): Promise<readonly ParameterPresetRecord[]> {
    return this.#configuration.importPresets(root, raw)
  }

  async listTasks(root: string): Promise<readonly TaskRecord[]> {
    return this.#runs.listTasks(root)
  }

  async listQueuedRuns(root: string): Promise<readonly PersistentRunQueueItem[]> {
    return this.#runs.listQueue(root)
  }

  async upsertQueuedRun(root: string, item: PersistentRunQueueItem): Promise<PersistentRunQueueItem> {
    return this.#runs.upsertQueue(root, item)
  }

  async removeQueuedRun(root: string, itemId: string): Promise<boolean> {
    return this.#runs.removeQueue(root, itemId)
  }

  async recoverInterruptedQueue(root: string): Promise<number> {
    return this.#runs.recoverQueue(root)
  }

  async recoverInterruptedTasks(root: string): Promise<number> {
    return this.#runs.recoverTasks(root)
  }

  async listRuns(root: string): Promise<readonly RunRecordSummary[]> {
    return this.#runs.listRuns(root)
  }

  async upsertTask(root: string, task: TaskRecord): Promise<void> {
    return this.#runs.upsertTask(root, task)
  }

  resolveAsset(root: string, relativePath: string): string {
    return this.#assets.resolve(root, relativePath)
  }

  async resolveExistingAsset(root: string, relativePath: string): Promise<string> {
    return this.#assets.resolveExisting(root, relativePath)
  }

  async resolveOutputAsset(root: string, relativePath: string): Promise<string> {
    return this.#assets.resolveOutput(root, relativePath)
  }

  async #readRegistry(): Promise<z.infer<typeof recentSchema>> {
    return recentSchema.parse(await readJson(this.#recentFile, { schemaVersion: 1, projectPaths: [] }))
  }

  async #recoverableProjectPaths(): Promise<readonly string[]> {
    if (this.#managedProjectsRoot) {
      return (await this.listManaged()).map((project) => project.path)
    }
    const registry = await this.#readRegistry()
    return [...new Set([registry.recentProjectPath, ...registry.projectPaths]
      .filter((value): value is string => Boolean(value)))]
  }

  async remember(root: string): Promise<void> {
    return this.#mutations.run(this.stateDirectory, 'recent-projects', () => this.#rememberUnlocked(root))
  }

  async #rememberUnlocked(root: string): Promise<void> {
    const normalized = path.resolve(root)
    const current = await this.#readRegistry()
    const projectPaths = [normalized, ...current.projectPaths.filter((item) => path.resolve(item) !== normalized)].slice(0, 100)
    await atomicWriteJson(this.#recentFile, { schemaVersion: 1, recentProjectPath: normalized, projectPaths })
  }

}

function projectPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}
