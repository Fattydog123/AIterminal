import { lstat, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { migrateWorkflowDocument } from '../../studio/core/migrations.js'
import { workflowDocumentSchema } from '../../studio/shared/contracts.js'
import type { WorkflowDocument } from '../../studio/shared/types.js'
import { StudioError, assertNoSecretFields } from './errors.js'
import { atomicWriteJson, readJson, resolveInside } from './filesystem.js'
import { MutationCoordinator, ProjectLayout } from './project-persistence.js'

export interface WorkflowDraftRecord {
  readonly schemaVersion: 1
  readonly workflowId: string
  readonly baseRevision: number
  readonly savedAt: string
  readonly workflow: WorkflowDocument
}

export interface WorkflowVersionSummary {
  readonly workflowId: string
  readonly revision: number
  readonly name: string
  readonly savedAt: string
}

export interface ArchivedWorkflowSummary {
  readonly archiveId: string
  readonly workflowId: string
  readonly name: string
  readonly revision: number
  readonly archivedAt: string
}

const workflowIdPattern = /^[a-zA-Z0-9_-]{1,160}$/

const workflowDraftSchema = z.object({
  schemaVersion: z.literal(1),
  workflowId: z.string().regex(workflowIdPattern),
  baseRevision: z.number().int().nonnegative(),
  savedAt: z.string().datetime(),
  workflow: workflowDocumentSchema,
}).strict()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeUnknownFields = (existing: unknown, workflow: WorkflowDocument): unknown => {
  if (!isRecord(existing)) return workflow
  const result: Record<string, unknown> = { ...existing, ...workflow }
  delete result.version
  const existingNodes = new Map(
    (Array.isArray(existing.nodes) ? existing.nodes : [])
      .filter(isRecord)
      .map((node) => [String(node.id ?? ''), node]),
  )
  result.nodes = workflow.nodes.map((node) => ({ ...(existingNodes.get(node.id) ?? {}), ...node }))
  const existingEdges = new Map(
    (Array.isArray(existing.edges) ? existing.edges : [])
      .filter(isRecord)
      .map((edge) => [String(edge.id ?? ''), edge]),
  )
  result.edges = workflow.edges.map((edge) => ({ ...(existingEdges.get(edge.id) ?? {}), ...edge }))
  if (workflow.subgraphs !== undefined) {
    const existingSubgraphs = new Map(
      (Array.isArray(existing.subgraphs) ? existing.subgraphs : [])
        .filter(isRecord)
        .map((definition) => [String(definition.id ?? ''), definition]),
    )
    result.subgraphs = workflow.subgraphs.map((definition) => {
      const previous = existingSubgraphs.get(definition.id)
      return {
        ...(previous ?? {}),
        ...definition,
        workflow: mergeUnknownFields(previous?.workflow, definition.workflow),
      }
    })
  }
  return result
}

export class WorkflowRepository {
  constructor(
    private readonly layout: ProjectLayout,
    private readonly mutations: MutationCoordinator,
  ) {}

  async list(root: string): Promise<readonly WorkflowDocument[]> {
    await this.layout.metadata(root)
    const directory = await this.layout.managedDirectory(root, 'workflows', true)
    const entries = await readdir(directory, { withFileTypes: true })
    const workflows: WorkflowDocument[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const workflowId = entry.name.toLowerCase().endsWith('.workflow.json') ? entry.name.slice(0, -14) : entry.name.slice(0, -5)
      if (!workflowIdPattern.test(workflowId) || seen.has(workflowId)) continue
      seen.add(workflowId)
      try {
        workflows.push(await this.load(root, workflowId))
      } catch (error) {
        if (error instanceof StudioError && ['project-symlink-denied', 'workflow-symlink-denied', 'path-outside-project', 'symlink-denied'].includes(error.code)) throw error
        // One damaged or unrelated legacy JSON must not hide every valid workflow.
      }
    }
    return workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(root: string, workflowId: string): Promise<WorkflowDocument> {
    await this.layout.metadata(root)
    await this.layout.managedDirectory(root, 'workflows')
    const filePath = await this.#existingPath(root, workflowId)
    const details = await stat(filePath)
    const raw = await readJson<unknown>(filePath)
    assertNoSecretFields(raw)
    const document = migrateWorkflowDocument(raw, { timestamp: details.mtime.toISOString() }).document
    assertNoSecretFields(document)
    return document
  }

  async duplicate(root: string, workflowId: string, requestedName?: string): Promise<WorkflowDocument> {
    const source = await this.load(root, workflowId)
    const now = new Date().toISOString()
    const name = requestedName?.trim() || `${source.name} 副本`
    if (name.length > 160) throw new StudioError('workflow-name-too-long', 'Workflow 名称不能超过 160 个字符')
    const duplicate: WorkflowDocument = {
      ...structuredClone(source),
      id: crypto.randomUUID(),
      name,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      metadata: { ...source.metadata, duplicatedFrom: source.id },
    }
    return this.save(root, duplicate)
  }

  async archive(root: string, workflowId: string): Promise<boolean> {
    return this.mutations.run(root, `workflow:${workflowId}`, async () => {
      const projectRoot = path.resolve(root)
      const workflows = await this.list(projectRoot)
      if (!workflows.some((workflow) => workflow.id === workflowId)) return false
      if (workflows.length <= 1) throw new StudioError('last-workflow-required', '项目至少保留最后一个 Workflow；可先创建或复制另一个 Workflow')
      const source = await this.#existingPath(projectRoot, workflowId)
      const details = await lstat(source)
      if (details.isSymbolicLink() || !details.isFile()) throw new StudioError('workflow-symlink-denied', 'Workflow 文件必须是普通文件')
      const trash = await this.#trashDirectory(projectRoot)
      const destination = resolveInside(trash, `${crypto.randomUUID()}.workflow.json`)
      await rename(source, destination)
      return true
    })
  }

  async listArchived(root: string): Promise<readonly ArchivedWorkflowSummary[]> {
    const trash = await this.#trashDirectory(path.resolve(root))
    const entries = await readdir(trash, { withFileTypes: true })
    const archived: ArchivedWorkflowSummary[] = []
    for (const entry of entries.slice(0, 5_000)) {
      const match = entry.name.match(/^([a-zA-Z0-9_-]{1,160})\.workflow\.json$/)
      if (!entry.isFile() || !match) continue
      const filePath = resolveInside(trash, entry.name)
      try {
        const details = await lstat(filePath)
        if (details.isSymbolicLink() || !details.isFile() || details.size > 128 * 1024 * 1024) continue
        const raw = await readJson(filePath)
        assertNoSecretFields(raw)
        const workflow = migrateWorkflowDocument(raw, { timestamp: details.mtime.toISOString() }).document
        archived.push({
          archiveId: match[1]!,
          workflowId: workflow.id,
          name: workflow.name,
          revision: workflow.revision,
          archivedAt: details.mtime.toISOString(),
        })
      } catch {
        // One damaged archive must not hide every recoverable Workflow.
      }
    }
    return archived.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt)).slice(0, 500)
  }

  async restoreArchived(root: string, archiveId: string): Promise<WorkflowDocument> {
    return this.mutations.run(root, `workflow-archive:${archiveId}`, async () => {
      if (!workflowIdPattern.test(archiveId)) throw new StudioError('workflow-archive-id-invalid', 'Workflow 归档标识非法')
      const projectRoot = path.resolve(root)
      const trash = await this.#trashDirectory(projectRoot)
      const source = resolveInside(trash, `${archiveId}.workflow.json`)
      const details = await lstat(source)
      if (details.isSymbolicLink() || !details.isFile() || details.size > 128 * 1024 * 1024) {
        throw new StudioError('workflow-archive-invalid', 'Workflow 归档必须是普通文件且不超过 128 MiB')
      }
      const raw = await readJson(source)
      assertNoSecretFields(raw)
      const workflow = migrateWorkflowDocument(raw, { timestamp: details.mtime.toISOString() }).document
      const destination = this.#workflowPath(projectRoot, workflow.id)
      try {
        await lstat(destination)
        throw new StudioError('workflow-restore-conflict', `Workflow ${workflow.id} 已存在，不能覆盖恢复`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(source, destination)
      return this.load(projectRoot, workflow.id)
    })
  }

  async save(root: string, workflow: WorkflowDocument): Promise<WorkflowDocument> {
    return this.mutations.run(root, `workflow:${workflow.id}`, () => this.#saveUnlocked(root, workflow))
  }

  async saveDraft(root: string, workflow: WorkflowDocument): Promise<WorkflowDraftRecord> {
    return this.mutations.run(root, `workflow-draft:${workflow.id}`, async () => {
      const projectRoot = path.resolve(root)
      await this.layout.metadata(projectRoot)
      await this.#draftDirectory(projectRoot)
      const parsed = workflowDocumentSchema.parse(workflow) as unknown as WorkflowDocument
      assertNoSecretFields(parsed)
      const record = workflowDraftSchema.parse({
        schemaVersion: 1,
        workflowId: parsed.id,
        baseRevision: parsed.revision,
        savedAt: new Date().toISOString(),
        workflow: parsed,
      }) as unknown as WorkflowDraftRecord
      await atomicWriteJson(this.#draftPath(projectRoot, parsed.id), record)
      return record
    })
  }

  async loadDraft(root: string, workflowId: string): Promise<WorkflowDraftRecord | undefined> {
    const projectRoot = path.resolve(root)
    await this.layout.metadata(projectRoot)
    await this.#draftDirectory(projectRoot)
    const filePath = this.#draftPath(projectRoot, workflowId)
    try {
      const details = await lstat(filePath)
      if (details.isSymbolicLink()) throw new StudioError('workflow-draft-symlink-denied', '工作流草稿不能是符号链接')
      if (!details.isFile() || details.size > 128 * 1024 * 1024) throw new StudioError('workflow-draft-size-denied', '工作流草稿超过 128 MiB')
      const raw = await readJson(filePath)
      assertNoSecretFields(raw)
      const record = workflowDraftSchema.parse(raw) as unknown as WorkflowDraftRecord
      if (record.workflowId !== workflowId || record.workflow.id !== workflowId) {
        throw new StudioError('workflow-draft-id-mismatch', '工作流草稿标识与文件名不一致')
      }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async discardDraft(root: string, workflowId: string): Promise<boolean> {
    return this.mutations.run(root, `workflow-draft:${workflowId}`, async () => {
      const projectRoot = path.resolve(root)
      await this.layout.metadata(projectRoot)
      await this.#draftDirectory(projectRoot)
      const filePath = this.#draftPath(projectRoot, workflowId)
      try {
        const details = await lstat(filePath)
        if (details.isSymbolicLink() || !details.isFile()) throw new StudioError('workflow-draft-symlink-denied', '工作流草稿必须是普通文件')
        await rm(filePath)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
  }

  async listVersions(root: string, workflowId: string): Promise<readonly WorkflowVersionSummary[]> {
    const directory = await this.#historyDirectory(path.resolve(root), workflowId)
    const entries = await readdir(directory, { withFileTypes: true })
    const versions: WorkflowVersionSummary[] = []
    for (const entry of entries.slice(0, 5_000)) {
      const match = entry.name.match(/^(\d+)\.workflow\.json$/)
      if (!entry.isFile() || !match) continue
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision) || revision < 0) continue
      try {
        const workflow = await this.loadVersion(root, workflowId, revision)
        versions.push({ workflowId, revision, name: workflow.name, savedAt: workflow.updatedAt })
      } catch (error) {
        if (error instanceof StudioError && ['workflow-version-symlink-denied', 'path-outside-project', 'project-symlink-denied'].includes(error.code)) throw error
        // A damaged historic snapshot must not hide every usable version.
      }
    }
    return versions.sort((left, right) => right.revision - left.revision).slice(0, 500)
  }

  async loadVersion(root: string, workflowId: string, revision: number): Promise<WorkflowDocument> {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new StudioError('workflow-version-invalid', '工作流版本号必须是非负整数')
    const directory = await this.#historyDirectory(path.resolve(root), workflowId)
    const filePath = resolveInside(directory, `${revision}.workflow.json`)
    const details = await lstat(filePath)
    if (details.isSymbolicLink() || !details.isFile()) throw new StudioError('workflow-version-symlink-denied', '工作流版本必须是普通文件')
    if (details.size > 128 * 1024 * 1024) throw new StudioError('workflow-version-size-denied', '工作流版本超过 128 MiB')
    const raw = await readJson(filePath)
    assertNoSecretFields(raw)
    const document = migrateWorkflowDocument(raw, { timestamp: details.mtime.toISOString() }).document
    if (document.id !== workflowId || document.revision !== revision) {
      throw new StudioError('workflow-version-mismatch', '工作流版本内容与请求不一致')
    }
    return document
  }

  async #saveUnlocked(root: string, workflow: WorkflowDocument): Promise<WorkflowDocument> {
    const projectRoot = path.resolve(root)
    await this.layout.metadata(projectRoot)
    await this.layout.managedDirectory(projectRoot, 'workflows')
    const parsed = workflowDocumentSchema.parse(workflow) as unknown as WorkflowDocument
    assertNoSecretFields(parsed)
    const filePath = await this.#existingPath(projectRoot, parsed.id, true)
    let existing: unknown
    let existingDocument: WorkflowDocument | undefined
    try {
      const details = await lstat(filePath)
      if (details.isSymbolicLink()) throw new StudioError('workflow-symlink-denied', '工作流文件不能是符号链接')
      if (!details.isFile() || details.size > 128 * 1024 * 1024) throw new StudioError('workflow-size-denied', '工作流文件超过 128 MiB')
      existing = JSON.parse(await readFile(filePath, 'utf8'))
      assertNoSecretFields(existing)
      existingDocument = migrateWorkflowDocument(existing, { timestamp: details.mtime.toISOString() }).document
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existingDocument && existingDocument.revision !== parsed.revision) {
      throw new StudioError(
        'workflow-revision-conflict',
        `工作流已被其他窗口更新（磁盘 rev. ${existingDocument.revision}，当前 rev. ${parsed.revision}）；请重新打开后再保存`,
      )
    }
    const now = new Date().toISOString()
    const saved: WorkflowDocument = {
      ...parsed,
      revision: existingDocument ? existingDocument.revision + 1 : parsed.revision,
      updatedAt: now,
    }
    const persisted = mergeUnknownFields(existing, saved)
    const versionRecord = await this.#recordVersion(projectRoot, saved, persisted)
    try {
      // The formal Workflow is the commit point. No required write may fail after
      // this succeeds, otherwise callers would retain a stale revision even
      // though the canonical file had already advanced.
      await atomicWriteJson(filePath, persisted)
    } catch (error) {
      if (versionRecord.created) await rm(versionRecord.filePath, { force: true }).catch(() => undefined)
      throw error
    }
    try {
      await this.layout.touch(projectRoot, now)
    } catch {
      // Project updatedAt is advisory. Once the formal Workflow commit succeeds,
      // an ancillary timestamp failure must not be reported as a failed save.
    }
    return saved
  }

  #workflowPath(root: string, workflowId: string): string {
    if (!workflowIdPattern.test(workflowId)) throw new StudioError('invalid-workflow-id', '工作流 ID 非法')
    const directory = path.join(path.resolve(root), 'workflows')
    return resolveInside(directory, `${workflowId}.workflow.json`)
  }

  async #existingPath(root: string, workflowId: string, allowMissing = false): Promise<string> {
    const canonical = this.#workflowPath(root, workflowId)
    try {
      if ((await lstat(canonical)).isSymbolicLink()) throw new StudioError('workflow-symlink-denied', '工作流文件不能是符号链接')
      return canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const legacyName = resolveInside(path.join(path.resolve(root), 'workflows'), `${workflowId}.json`)
    try {
      if ((await lstat(legacyName)).isSymbolicLink()) throw new StudioError('workflow-symlink-denied', '工作流文件不能是符号链接')
      return legacyName
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error
      return canonical
    }
  }

  #draftPath(root: string, workflowId: string): string {
    if (!workflowIdPattern.test(workflowId)) throw new StudioError('invalid-workflow-id', '工作流 ID 非法')
    return resolveInside(path.join(path.resolve(root), '.studio', 'drafts'), `${workflowId}.draft.json`)
  }

  async #draftDirectory(root: string): Promise<string> {
    return this.layout.managedDirectory(root, '.studio/drafts', true)
  }

  async #historyDirectory(root: string, workflowId: string): Promise<string> {
    if (!workflowIdPattern.test(workflowId)) throw new StudioError('invalid-workflow-id', '工作流 ID 非法')
    await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio/workflow-history', true)
    return this.layout.managedDirectory(root, `.studio/workflow-history/${workflowId}`, true)
  }

  async #trashDirectory(root: string): Promise<string> {
    await this.layout.metadata(root)
    return this.layout.managedDirectory(root, '.studio/trash', true)
  }

  async #recordVersion(
    root: string,
    workflow: WorkflowDocument,
    persisted: unknown,
  ): Promise<{ readonly created: boolean; readonly filePath: string }> {
    const directory = await this.#historyDirectory(root, workflow.id)
    const filePath = resolveInside(directory, `${workflow.revision}.workflow.json`)
    try {
      const existing = await readJson(filePath)
      const previous = migrateWorkflowDocument(existing).document
      if (JSON.stringify(previous) !== JSON.stringify(migrateWorkflowDocument(persisted).document)) {
        throw new StudioError('workflow-version-immutable', `工作流版本 rev. ${workflow.revision} 已存在且内容不同`)
      }
      return { created: false, filePath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await atomicWriteJson(filePath, persisted)
    return { created: true, filePath }
  }
}
