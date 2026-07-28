import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, createReadStream } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

import type {
  TaskSummary,
  WorkspaceChangeState,
  WorkspaceWorktreeKind,
  WorkspaceWorktreeStatus
} from '../../shared/contracts.ts'
import type { AgentWorkspaceSessionService } from './agent-workspace-session-service.ts'
import type { ConversationHistoryService } from './conversation-history-service.ts'

const DOCUMENT_FORMAT = 'ai-terminal.workspace-change-sessions'
const DOCUMENT_VERSION = 1
const SNAPSHOT_FORMAT = 'ai-terminal.workspace-snapshot'
const SNAPSHOT_VERSION = 1
const MAX_DOCUMENT_BYTES = 512 * 1024
const MAX_CHECKPOINTS = 256
const MAX_WORKTREES = 128
const MAX_FILES = 50_000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_RELATIVE_PATH_CHARACTERS = 1_024
const MAX_GIT_OUTPUT_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 60_000

const CHECKPOINT_ID_PATTERN = /^checkpoint:[0-9a-f-]{36}$/u
const WORKTREE_ID_PATTERN = /^worktree:[0-9a-f-]{36}$/u
const PROJECT_ID_PATTERN = /^project:workspace:[A-Za-z0-9_-]{43}$/u
const TASK_ID_PATTERN = /^task:[0-9a-f-]{36}$/u

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.ai-terminal',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  'dist',
  'out',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__'
])

export interface WorkspaceChangeStorage {
  read(): Promise<string | null>
  write(serializedDocument: string): Promise<void>
}

export interface WorkspaceChangeSessionOptions {
  readonly history: ConversationHistoryService
  readonly workspaces: AgentWorkspaceSessionService
  readonly storage: WorkspaceChangeStorage
  readonly snapshotRoot: string
  readonly worktreeRoot: string
  readonly clock?: () => number
}

export interface WorkspaceConversationForkInput {
  readonly taskId: string
  readonly isolateFiles: boolean
  /** Optional complete message the branch keeps history up to and including. */
  readonly anchorMessageId?: string
}

export interface WorkspaceCheckpointInput {
  readonly taskId: string
  readonly label?: string
}

export interface WorkspaceRewindInput {
  readonly taskId: string
  readonly checkpointId: string
}

export interface WorkspaceWorktreeMutationInput {
  readonly taskId: string
  readonly worktreeId: string
}

export interface WorkspaceAgentIsolationInput {
  /** Root conversation that owns the resulting apply/discard controls. */
  readonly rootTaskId: string
  /** May be the root workspace or a previously isolated child workspace. */
  readonly sourceProjectId: string
  readonly label?: string
  readonly signal?: AbortSignal
}

export interface WorkspaceAgentIsolationResult {
  readonly taskId: string
  readonly projectId: string
  readonly worktreeId: string
  readonly absolutePath: string
}

export interface ManagedGitWorktreeAuthorization {
  readonly commonDirectory: string
}

export type WorkspaceChangeErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'workspace_unavailable'
  | 'checkpoint_unavailable'
  | 'worktree_unavailable'
  | 'snapshot_too_large'
  | 'merge_conflict'
  | 'git_failed'
  | 'storage_error'
  | 'corrupt_data'

const ERROR_MESSAGES: Readonly<Record<WorkspaceChangeErrorCode, string>> = Object.freeze({
  invalid_configuration: 'Workspace change sessions are not configured correctly.',
  invalid_input: 'The workspace change request is invalid.',
  workspace_unavailable: 'The task workspace is unavailable.',
  checkpoint_unavailable: 'The selected checkpoint is unavailable.',
  worktree_unavailable: 'The selected worktree is unavailable.',
  snapshot_too_large: 'The workspace is too large to checkpoint.',
  merge_conflict: 'The source workspace and worktree changed the same files. Resolve those changes before applying.',
  git_failed: 'Git could not create or remove the worktree.',
  storage_error: 'Workspace change metadata could not be stored.',
  corrupt_data: 'Stored workspace change metadata is invalid.'
})

export class WorkspaceChangeError extends Error {
  readonly code: WorkspaceChangeErrorCode

  constructor(code: WorkspaceChangeErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'WorkspaceChangeError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

interface StoredCheckpoint {
  readonly id: string
  readonly taskId: string
  readonly projectId: string
  readonly snapshotId: string
  readonly label: string
  readonly createdAt: string
}

interface StoredWorktree {
  readonly id: string
  readonly sourceTaskId: string
  readonly targetTaskId: string
  readonly sourceProjectId: string
  readonly targetProjectId: string
  readonly baseSnapshotId: string
  readonly kind: WorkspaceWorktreeKind
  status: Exclude<WorkspaceWorktreeStatus, 'missing'>
  readonly sourcePath: string
  readonly targetRoot: string
  readonly targetWorkspacePath: string
  readonly gitSourceRoot?: string
  readonly gitBranch?: string
  readonly createdAt: string
  updatedAt: string
}

interface WorkspaceChangeDocument {
  readonly format: typeof DOCUMENT_FORMAT
  readonly version: typeof DOCUMENT_VERSION
  checkpoints: StoredCheckpoint[]
  worktrees: StoredWorktree[]
}

interface SnapshotEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly size?: number
  readonly hash?: string
}

interface SnapshotManifest {
  readonly format: typeof SNAPSHOT_FORMAT
  readonly version: typeof SNAPSHOT_VERSION
  readonly entries: SnapshotEntry[]
}

interface MaterializedWorktree {
  readonly kind: WorkspaceWorktreeKind
  readonly targetRoot: string
  readonly targetWorkspacePath: string
  readonly gitSourceRoot?: string
  readonly gitBranch?: string
}

export class WorkspaceChangeSession {
  readonly #history: ConversationHistoryService
  readonly #workspaces: AgentWorkspaceSessionService
  readonly #storage: WorkspaceChangeStorage
  readonly #snapshotRoot: string
  readonly #worktreeRoot: string
  readonly #clock: () => number
  #document: WorkspaceChangeDocument | null = null
  #operationTail: Promise<void> = Promise.resolve()

  constructor(options: WorkspaceChangeSessionOptions) {
    if (
      !isRecord(options) ||
      !isAbsolute(options.snapshotRoot) ||
      !isAbsolute(options.worktreeRoot) ||
      typeof options.history?.load !== 'function' ||
      typeof options.history?.fork !== 'function' ||
      typeof options.workspaces?.resolveProject !== 'function' ||
      typeof options.workspaces?.bindProject !== 'function' ||
      typeof options.storage?.read !== 'function' ||
      typeof options.storage?.write !== 'function' ||
      (options.clock !== undefined && typeof options.clock !== 'function')
    ) {
      throw new WorkspaceChangeError('invalid_configuration')
    }
    this.#history = options.history
    this.#workspaces = options.workspaces
    this.#storage = options.storage
    this.#snapshotRoot = resolve(options.snapshotRoot)
    this.#worktreeRoot = resolve(options.worktreeRoot)
    this.#clock = options.clock ?? Date.now
  }

  async forkConversation(input: WorkspaceConversationForkInput): Promise<TaskSummary> {
    assertTaskId(input.taskId)
    if (typeof input.isolateFiles !== 'boolean') throw new WorkspaceChangeError('invalid_input')
    const anchor = input.anchorMessageId === undefined ? {} : { anchorMessageId: input.anchorMessageId }
    return await this.#exclusive(async () => {
      const source = await this.#history.load(input.taskId)
      if (source.task.mode !== 'agent' || !input.isolateFiles) {
        return await this.#history.fork(input.taskId, anchor)
      }
      const sourceWorkspace = await this.#workspaces.resolveProject(source.task.projectId)
      if (!sourceWorkspace) return await this.#history.fork(input.taskId, anchor)

      const document = await this.#loadDocument()
      if (document.worktrees.length >= MAX_WORKTREES) {
        throw new WorkspaceChangeError('storage_error')
      }
      const checkpoint = await this.#captureCheckpoint(
        source.task.id,
        source.task.projectId,
        sourceWorkspace.absolutePath,
        '创建分支前'
      )
      document.checkpoints.push(checkpoint)
      await this.#trimCheckpoints(document)
      await this.#persistDocument(document)

      const worktreeId = `worktree:${randomUUID()}`
      let materialized: MaterializedWorktree | null = null
      let forkedTask: TaskSummary | null = null
      let targetProjectId: string | null = null
      try {
        materialized = await this.#materializeWorktree(
          worktreeId,
          sourceWorkspace.absolutePath,
          checkpoint.snapshotId
        )
        targetProjectId = await projectIdForDirectory(materialized.targetWorkspacePath)
        forkedTask = await this.#history.fork(input.taskId, { projectId: targetProjectId, ...anchor })
        await this.#workspaces.bindProject(targetProjectId, materialized.targetWorkspacePath)
        const timestamp = this.#timestamp()
        document.worktrees.push({
          id: worktreeId,
          sourceTaskId: source.task.id,
          targetTaskId: forkedTask.id,
          sourceProjectId: source.task.projectId,
          targetProjectId,
          baseSnapshotId: checkpoint.snapshotId,
          kind: materialized.kind,
          status: 'ready',
          sourcePath: sourceWorkspace.absolutePath,
          targetRoot: materialized.targetRoot,
          targetWorkspacePath: materialized.targetWorkspacePath,
          ...(materialized.gitSourceRoot ? { gitSourceRoot: materialized.gitSourceRoot } : {}),
          ...(materialized.gitBranch ? { gitBranch: materialized.gitBranch } : {}),
          createdAt: timestamp,
          updatedAt: timestamp
        })
        await this.#persistDocument(document)
        return forkedTask
      } catch (error) {
        if (targetProjectId) await this.#workspaces.forgetProject(targetProjectId).catch(() => undefined)
        if (forkedTask) await this.#history.delete(forkedTask.id).catch(() => undefined)
        if (materialized) await this.#removeMaterializedWorktree(materialized).catch(() => undefined)
        throw error
      }
    })
  }

  async list(taskId: string): Promise<WorkspaceChangeState> {
    assertTaskId(taskId)
    return await this.#exclusive(async () => this.#toState(await this.#loadDocument(), taskId))
  }

  /**
   * Materializes a child Agent workspace without creating a second visible
   * conversation. The root task owns later apply/discard actions while the
   * source project may itself be an isolated parent for a depth-two graph.
   */
  async createAgentIsolation(
    input: WorkspaceAgentIsolationInput
  ): Promise<WorkspaceAgentIsolationResult> {
    assertTaskId(input.rootTaskId)
    if (!PROJECT_ID_PATTERN.test(input.sourceProjectId)) {
      throw new WorkspaceChangeError('invalid_input')
    }
    if (input.label !== undefined && typeof input.label !== 'string') {
      throw new WorkspaceChangeError('invalid_input')
    }
    if (input.signal !== undefined && !isAbortSignal(input.signal)) {
      throw new WorkspaceChangeError('invalid_input')
    }
    return await this.#exclusive(async () => {
      throwIfAborted(input.signal)
      const rootConversation = await this.#history.load(input.rootTaskId)
      if (rootConversation.task.mode !== 'agent') {
        throw new WorkspaceChangeError('workspace_unavailable')
      }
      const sourceWorkspace = await this.#workspaces.resolveProject(input.sourceProjectId)
      if (!sourceWorkspace) throw new WorkspaceChangeError('workspace_unavailable')

      const document = await this.#loadDocument()
      if (document.worktrees.length >= MAX_WORKTREES) {
        throw new WorkspaceChangeError('storage_error')
      }
      const checkpoint = await this.#captureCheckpoint(
        input.rootTaskId,
        input.sourceProjectId,
        sourceWorkspace.absolutePath,
        normalizeLabel(input.label, '智能体隔离工作区')
      )
      document.checkpoints.push(checkpoint)
      await this.#trimCheckpoints(document)
      await this.#persistDocument(document)
      throwIfAborted(input.signal)

      const worktreeId = `worktree:${randomUUID()}`
      const targetTaskId = `task:${randomUUID()}`
      let materialized: MaterializedWorktree | null = null
      let targetProjectId: string | null = null
      try {
        materialized = await this.#materializeWorktree(
          worktreeId,
          sourceWorkspace.absolutePath,
          checkpoint.snapshotId
        )
        throwIfAborted(input.signal)
        targetProjectId = await projectIdForDirectory(materialized.targetWorkspacePath)
        await this.#workspaces.bindProject(targetProjectId, materialized.targetWorkspacePath)
        throwIfAborted(input.signal)
        const timestamp = this.#timestamp()
        document.worktrees.push({
          id: worktreeId,
          sourceTaskId: input.rootTaskId,
          targetTaskId,
          sourceProjectId: input.sourceProjectId,
          targetProjectId,
          baseSnapshotId: checkpoint.snapshotId,
          kind: materialized.kind,
          status: 'ready',
          sourcePath: sourceWorkspace.absolutePath,
          targetRoot: materialized.targetRoot,
          targetWorkspacePath: materialized.targetWorkspacePath,
          ...(materialized.gitSourceRoot ? { gitSourceRoot: materialized.gitSourceRoot } : {}),
          ...(materialized.gitBranch ? { gitBranch: materialized.gitBranch } : {}),
          createdAt: timestamp,
          updatedAt: timestamp
        })
        await this.#persistDocument(document)
        return Object.freeze({
          taskId: targetTaskId,
          projectId: targetProjectId,
          worktreeId,
          absolutePath: materialized.targetWorkspacePath
        })
      } catch (error) {
        if (targetProjectId) await this.#workspaces.forgetProject(targetProjectId).catch(() => undefined)
        if (materialized) await this.#removeMaterializedWorktree(materialized).catch(() => undefined)
        throw error
      }
    })
  }

  /** Authorizes only linked Git metadata created and still owned by this module. */
  async authorizeManagedGitWorktree(
    workspacePath: string,
    gitDirectory: string
  ): Promise<ManagedGitWorktreeAuthorization | null> {
    if (!isAbsolutePath(workspacePath) || !isAbsolutePath(gitDirectory)) return null
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const worktree = document.worktrees.find((candidate) =>
        candidate.kind === 'git-worktree' &&
        candidate.status !== 'discarded' &&
        samePath(candidate.targetWorkspacePath, workspacePath) &&
        candidate.gitSourceRoot
      )
      if (!worktree?.gitSourceRoot) return null
      let commonDirectory: string
      try {
        const output = (await runGit(worktree.gitSourceRoot, ['rev-parse', '--git-common-dir'])).trim()
        const candidate = isAbsolute(output) ? output : resolve(worktree.gitSourceRoot, output)
        commonDirectory = await canonicalDirectory(candidate)
      } catch {
        return null
      }
      const linkedMetadataRoot = resolve(join(commonDirectory, 'worktrees'))
      const canonicalGitDirectory = await canonicalDirectory(gitDirectory).catch(() => null)
      if (
        !canonicalGitDirectory ||
        !isPathInside(linkedMetadataRoot, canonicalGitDirectory) ||
        samePath(linkedMetadataRoot, canonicalGitDirectory)
      ) return null
      return { commonDirectory }
    })
  }

  async createCheckpoint(input: WorkspaceCheckpointInput): Promise<WorkspaceChangeState> {
    assertTaskId(input.taskId)
    if (input.label !== undefined && typeof input.label !== 'string') {
      throw new WorkspaceChangeError('invalid_input')
    }
    return await this.#exclusive(async () => {
      const { task, absolutePath } = await this.#resolveTaskWorkspace(input.taskId)
      const document = await this.#loadDocument()
      const checkpoint = await this.#captureCheckpoint(
        task.id,
        task.projectId,
        absolutePath,
        normalizeLabel(input.label, '手动检查点')
      )
      document.checkpoints.push(checkpoint)
      await this.#trimCheckpoints(document)
      await this.#persistDocument(document)
      return await this.#toState(document, input.taskId)
    })
  }

  async rewind(input: WorkspaceRewindInput): Promise<WorkspaceChangeState> {
    assertTaskId(input.taskId)
    if (!CHECKPOINT_ID_PATTERN.test(input.checkpointId)) throw new WorkspaceChangeError('invalid_input')
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const checkpoint = document.checkpoints.find((candidate) =>
        candidate.id === input.checkpointId && candidate.taskId === input.taskId
      )
      if (!checkpoint) throw new WorkspaceChangeError('checkpoint_unavailable')
      const { task, absolutePath } = await this.#resolveTaskWorkspace(input.taskId)
      if (task.projectId !== checkpoint.projectId) throw new WorkspaceChangeError('checkpoint_unavailable')

      const safetyCheckpoint = await this.#captureCheckpoint(
        task.id,
        task.projectId,
        absolutePath,
        '回退前自动检查点'
      )
      document.checkpoints.push(safetyCheckpoint)
      await this.#trimCheckpoints(document)
      await this.#persistDocument(document)
      await restoreSnapshot(this.#snapshotDirectory(checkpoint.snapshotId), absolutePath, true)
      return await this.#toState(document, input.taskId)
    })
  }

  async applyWorktree(input: WorkspaceWorktreeMutationInput): Promise<WorkspaceChangeState> {
    validateWorktreeMutationInput(input)
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const worktree = findOwnedWorktree(document, input)
      if (worktree.status !== 'ready') throw new WorkspaceChangeError('worktree_unavailable')
      const sourceWorkspace = await this.#workspaces.resolveProject(worktree.sourceProjectId)
      if (!sourceWorkspace || !samePath(sourceWorkspace.absolutePath, worktree.sourcePath)) {
        throw new WorkspaceChangeError('workspace_unavailable')
      }
      if (!await isExistingDirectory(worktree.targetWorkspacePath)) {
        throw new WorkspaceChangeError('worktree_unavailable')
      }

      const baseline = await readSnapshotManifest(this.#snapshotDirectory(worktree.baseSnapshotId))
      const source = await scanWorkspace(sourceWorkspace.absolutePath)
      const target = await scanWorkspace(worktree.targetWorkspacePath)
      const changedPaths = changedManifestPaths(baseline, target)
      const conflicts = changedPaths.filter((path) => {
        const baseEntry = manifestEntry(baseline, path)
        const sourceEntry = manifestEntry(source, path)
        const targetEntry = manifestEntry(target, path)
        return !sameSnapshotEntry(sourceEntry, baseEntry) && !sameSnapshotEntry(sourceEntry, targetEntry)
      })
      if (conflicts.length > 0) throw new WorkspaceChangeError('merge_conflict')

      const checkpoint = await this.#captureCheckpoint(
        worktree.sourceTaskId,
        worktree.sourceProjectId,
        sourceWorkspace.absolutePath,
        '应用工作树前'
      )
      document.checkpoints.push(checkpoint)
      await this.#trimCheckpoints(document)
      await this.#persistDocument(document)
      await applyManifestPaths(
        worktree.targetWorkspacePath,
        sourceWorkspace.absolutePath,
        target,
        changedPaths
      )
      worktree.status = 'applied'
      worktree.updatedAt = this.#timestamp()
      await this.#persistDocument(document)
      return await this.#toState(document, input.taskId)
    })
  }

  async discardWorktree(input: WorkspaceWorktreeMutationInput): Promise<WorkspaceChangeState> {
    validateWorktreeMutationInput(input)
    return await this.#exclusive(async () => {
      const document = await this.#loadDocument()
      const worktree = findOwnedWorktree(document, input)
      if (worktree.status === 'discarded') return await this.#toState(document, input.taskId)
      await this.#removeMaterializedWorktree(worktree)
      await this.#workspaces.forgetProject(worktree.targetProjectId)
      worktree.status = 'discarded'
      worktree.updatedAt = this.#timestamp()
      await this.#persistDocument(document)
      return await this.#toState(document, input.taskId)
    })
  }

  async #resolveTaskWorkspace(taskId: string): Promise<{
    task: TaskSummary
    absolutePath: string
  }> {
    const snapshot = await this.#history.load(taskId)
    if (snapshot.task.mode !== 'agent') throw new WorkspaceChangeError('workspace_unavailable')
    const workspace = await this.#workspaces.resolveProject(snapshot.task.projectId)
    if (!workspace) throw new WorkspaceChangeError('workspace_unavailable')
    return { task: snapshot.task, absolutePath: workspace.absolutePath }
  }

  async #captureCheckpoint(
    taskId: string,
    projectId: string,
    absolutePath: string,
    label: string
  ): Promise<StoredCheckpoint> {
    const id = `checkpoint:${randomUUID()}`
    const snapshotId = id.slice('checkpoint:'.length)
    await captureSnapshot(absolutePath, this.#snapshotDirectory(snapshotId))
    return {
      id,
      taskId,
      projectId,
      snapshotId,
      label,
      createdAt: this.#timestamp()
    }
  }

  async #materializeWorktree(
    worktreeId: string,
    sourceWorkspacePath: string,
    snapshotId: string
  ): Promise<MaterializedWorktree> {
    await fs.mkdir(this.#worktreeRoot, { recursive: true })
    const canonicalRoot = resolve(await fs.realpath(this.#worktreeRoot))
    if (!samePath(canonicalRoot, this.#worktreeRoot)) {
      throw new WorkspaceChangeError('workspace_unavailable')
    }
    const shortId = worktreeId.slice('worktree:'.length, 'worktree:'.length + 8)
    const name = `${safeSlug(basename(sourceWorkspacePath))}-${shortId}`
    const targetRoot = resolve(join(canonicalRoot, name))
    if (!isPathInside(canonicalRoot, targetRoot) || await pathExists(targetRoot)) {
      throw new WorkspaceChangeError('worktree_unavailable')
    }
    const gitSourceRoot = await detectGitRoot(sourceWorkspacePath)
    if (!gitSourceRoot) {
      try {
        await fs.mkdir(targetRoot)
        await restoreSnapshot(this.#snapshotDirectory(snapshotId), targetRoot, false)
        return { kind: 'workspace-copy', targetRoot, targetWorkspacePath: targetRoot }
      } catch (error) {
        await fs.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }

    const workspaceSubpath = relative(gitSourceRoot, sourceWorkspacePath)
    if (workspaceSubpath === '..' || workspaceSubpath.startsWith(`..${sep}`) || isAbsolute(workspaceSubpath)) {
      throw new WorkspaceChangeError('git_failed')
    }
    const gitBranch = `ai-terminal/${shortId}-${randomUUID().slice(0, 8)}`
    try {
      await runGit(gitSourceRoot, ['worktree', 'add', '-b', gitBranch, targetRoot, 'HEAD'])
      const targetWorkspacePath = resolve(targetRoot, workspaceSubpath)
      if (!isPathInside(targetRoot, targetWorkspacePath)) throw new WorkspaceChangeError('git_failed')
      await fs.mkdir(targetWorkspacePath, { recursive: true })
      await restoreSnapshot(this.#snapshotDirectory(snapshotId), targetWorkspacePath, true)
      return {
        kind: 'git-worktree',
        targetRoot,
        targetWorkspacePath,
        gitSourceRoot,
        gitBranch
      }
    } catch (error) {
      await fs.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined)
      await runGit(gitSourceRoot, ['branch', '-D', gitBranch]).catch(() => undefined)
      if (error instanceof WorkspaceChangeError) throw error
      throw new WorkspaceChangeError('git_failed')
    }
  }

  async #removeMaterializedWorktree(
    worktree: MaterializedWorktree | StoredWorktree
  ): Promise<void> {
    const targetRoot = resolve(worktree.targetRoot)
    if (!isPathInside(this.#worktreeRoot, targetRoot)) {
      throw new WorkspaceChangeError('worktree_unavailable')
    }
    if (worktree.kind === 'git-worktree' && worktree.gitSourceRoot) {
      await runGit(worktree.gitSourceRoot, ['worktree', 'remove', '--force', targetRoot])
        .catch(async () => {
          await fs.rm(targetRoot, { recursive: true, force: true })
          await runGit(worktree.gitSourceRoot!, ['worktree', 'prune'])
        })
      if (worktree.gitBranch) {
        await runGit(worktree.gitSourceRoot, ['branch', '-D', worktree.gitBranch]).catch(() => undefined)
      }
      return
    }
    await fs.rm(targetRoot, { recursive: true, force: true })
  }

  async #toState(document: WorkspaceChangeDocument, taskId: string): Promise<WorkspaceChangeState> {
    const checkpoints = document.checkpoints
      .filter((checkpoint) => checkpoint.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ id, label, createdAt }) => ({ id, label, createdAt }))
    const worktrees = await Promise.all(document.worktrees
      .filter((worktree) => worktree.sourceTaskId === taskId || worktree.targetTaskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(async (worktree) => {
        let status: WorkspaceWorktreeStatus = worktree.status
        let changedFiles: number | null = null
        if (worktree.status !== 'discarded') {
          if (!await isExistingDirectory(worktree.targetWorkspacePath)) {
            status = 'missing'
          } else {
            try {
              const baseline = await readSnapshotManifest(this.#snapshotDirectory(worktree.baseSnapshotId))
              const target = await scanWorkspace(worktree.targetWorkspacePath)
              changedFiles = changedManifestPaths(baseline, target).length
            } catch {
              changedFiles = null
            }
          }
        }
        return {
          id: worktree.id,
          sourceTaskId: worktree.sourceTaskId,
          targetTaskId: worktree.targetTaskId,
          kind: worktree.kind,
          status,
          changedFiles,
          createdAt: worktree.createdAt,
          updatedAt: worktree.updatedAt
        }
      }))
    return { taskId, checkpoints, worktrees }
  }

  async #trimCheckpoints(document: WorkspaceChangeDocument): Promise<void> {
    if (document.checkpoints.length <= MAX_CHECKPOINTS) return
    const retainedSnapshots = new Set(document.worktrees.map((worktree) => worktree.baseSnapshotId))
    const candidates = [...document.checkpoints]
      .filter((checkpoint) => !retainedSnapshots.has(checkpoint.snapshotId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    while (document.checkpoints.length > MAX_CHECKPOINTS && candidates.length > 0) {
      const checkpoint = candidates.shift()!
      document.checkpoints = document.checkpoints.filter((item) => item.id !== checkpoint.id)
      await fs.rm(this.#snapshotDirectory(checkpoint.snapshotId), { recursive: true, force: true })
    }
    if (document.checkpoints.length > MAX_CHECKPOINTS) {
      throw new WorkspaceChangeError('storage_error')
    }
  }

  async #loadDocument(): Promise<WorkspaceChangeDocument> {
    if (this.#document) return this.#document
    let serialized: string | null
    try {
      serialized = await this.#storage.read()
    } catch {
      throw new WorkspaceChangeError('storage_error')
    }
    if (serialized === null) {
      this.#document = emptyDocument()
      return this.#document
    }
    this.#document = parseDocument(serialized)
    return this.#document
  }

  async #persistDocument(document: WorkspaceChangeDocument): Promise<void> {
    if (document.worktrees.length > MAX_WORKTREES) throw new WorkspaceChangeError('storage_error')
    const serialized = JSON.stringify(document)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new WorkspaceChangeError('storage_error')
    }
    try {
      await this.#storage.write(serialized)
      this.#document = document
    } catch {
      throw new WorkspaceChangeError('storage_error')
    }
  }

  #snapshotDirectory(snapshotId: string): string {
    const candidate = resolve(join(this.#snapshotRoot, snapshotId))
    if (!isPathInside(this.#snapshotRoot, candidate)) throw new WorkspaceChangeError('checkpoint_unavailable')
    return candidate
  }

  #timestamp(): string {
    const value = this.#clock()
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new WorkspaceChangeError('invalid_configuration')
    }
    return new Date(value).toISOString()
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

async function captureSnapshot(sourceRoot: string, snapshotDirectory: string): Promise<void> {
  const canonicalSource = await canonicalDirectory(sourceRoot)
  const parent = resolve(join(snapshotDirectory, '..'))
  await fs.mkdir(parent, { recursive: true })
  const temporary = resolve(`${snapshotDirectory}.tmp-${randomUUID()}`)
  if (!isPathInside(parent, temporary) || !isPathInside(parent, snapshotDirectory)) {
    throw new WorkspaceChangeError('checkpoint_unavailable')
  }
  try {
    const filesDirectory = join(temporary, 'files')
    await fs.mkdir(filesDirectory, { recursive: true })
    const manifest = await scanWorkspace(canonicalSource, filesDirectory)
    await fs.writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), {
      encoding: 'utf8',
      flag: 'wx'
    })
    await fs.rename(temporary, snapshotDirectory)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof WorkspaceChangeError) throw error
    throw new WorkspaceChangeError('workspace_unavailable')
  }
}

async function scanWorkspace(sourceRoot: string, copyRoot?: string): Promise<SnapshotManifest> {
  const root = await canonicalDirectory(sourceRoot)
  const entries: SnapshotEntry[] = []
  let fileCount = 0
  let totalBytes = 0
  const visit = async (relativePath: string): Promise<void> => {
    const directoryPath = pathFromRelative(root, relativePath)
    let directoryEntries
    try {
      directoryEntries = await fs.readdir(directoryPath, { withFileTypes: true })
    } catch {
      throw new WorkspaceChangeError('workspace_unavailable')
    }
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of directoryEntries) {
      if (entry.name.includes('\0') || IGNORED_DIRECTORY_NAMES.has(entry.name)) continue
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (!isSafeRelativePath(childRelative)) continue
      const sourcePath = pathFromRelative(root, childRelative)
      const stats = await fs.lstat(sourcePath)
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) {
        entries.push({ path: childRelative, kind: 'directory' })
        if (copyRoot) await fs.mkdir(pathFromRelative(copyRoot, childRelative), { recursive: true })
        await visit(childRelative)
        continue
      }
      if (!stats.isFile()) continue
      fileCount += 1
      totalBytes += stats.size
      if (
        fileCount > MAX_FILES ||
        stats.size > MAX_FILE_BYTES ||
        totalBytes > MAX_TOTAL_BYTES
      ) {
        throw new WorkspaceChangeError('snapshot_too_large')
      }
      const hashSource = copyRoot ? pathFromRelative(copyRoot, childRelative) : sourcePath
      if (copyRoot) {
        await fs.mkdir(resolve(hashSource, '..'), { recursive: true })
        await fs.copyFile(sourcePath, hashSource)
      }
      entries.push({
        path: childRelative,
        kind: 'file',
        size: stats.size,
        hash: await hashFile(hashSource)
      })
    }
  }
  await visit('')
  return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, entries }
}

async function restoreSnapshot(
  snapshotDirectory: string,
  targetRoot: string,
  clearExisting: boolean
): Promise<void> {
  const manifest = await readSnapshotManifest(snapshotDirectory)
  await fs.mkdir(targetRoot, { recursive: true })
  const canonicalTarget = await canonicalDirectory(targetRoot)
  if (clearExisting) {
    const current = await scanWorkspace(canonicalTarget)
    const desired = new Map(manifest.entries.map((entry) => [entry.path, entry]))
    const removals = current.entries
      .filter((entry) => !sameSnapshotEntry(entry, desired.get(entry.path)))
      .sort((left, right) => pathDepth(right.path) - pathDepth(left.path))
    for (const entry of removals) {
      await removeWithin(canonicalTarget, entry.path)
    }
  }
  for (const entry of manifest.entries.filter((candidate) => candidate.kind === 'directory')) {
    const target = pathFromRelative(canonicalTarget, entry.path)
    const existing = await lstatOrNull(target)
    if (existing && !existing.isDirectory()) await removeWithin(canonicalTarget, entry.path)
    await fs.mkdir(target, { recursive: true })
  }
  for (const entry of manifest.entries.filter((candidate) => candidate.kind === 'file')) {
    const target = pathFromRelative(canonicalTarget, entry.path)
    const existing = await lstatOrNull(target)
    if (existing?.isDirectory()) await removeWithin(canonicalTarget, entry.path)
    await fs.mkdir(resolve(target, '..'), { recursive: true })
    await fs.copyFile(pathFromRelative(join(snapshotDirectory, 'files'), entry.path), target)
  }
}

async function applyManifestPaths(
  sourceRoot: string,
  targetRoot: string,
  sourceManifest: SnapshotManifest,
  paths: readonly string[]
): Promise<void> {
  const entries = new Map(sourceManifest.entries.map((entry) => [entry.path, entry]))
  const deletions = paths
    .filter((path) => !entries.has(path))
    .sort((left, right) => pathDepth(right) - pathDepth(left))
  for (const path of deletions) await removeWithin(targetRoot, path)
  const directories = paths
    .map((path) => entries.get(path))
    .filter((entry): entry is SnapshotEntry => entry?.kind === 'directory')
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path))
  for (const entry of directories) {
    const destination = pathFromRelative(targetRoot, entry.path)
    const current = await lstatOrNull(destination)
    if (current && !current.isDirectory()) await removeWithin(targetRoot, entry.path)
    await fs.mkdir(destination, { recursive: true })
  }
  const files = paths
    .map((path) => entries.get(path))
    .filter((entry): entry is SnapshotEntry => entry?.kind === 'file')
  for (const entry of files) {
    const destination = pathFromRelative(targetRoot, entry.path)
    const current = await lstatOrNull(destination)
    if (current?.isDirectory()) await removeWithin(targetRoot, entry.path)
    await fs.mkdir(resolve(destination, '..'), { recursive: true })
    await fs.copyFile(pathFromRelative(sourceRoot, entry.path), destination)
  }
}

async function readSnapshotManifest(snapshotDirectory: string): Promise<SnapshotManifest> {
  let parsed: unknown
  try {
    const serialized = await fs.readFile(join(snapshotDirectory, 'manifest.json'), 'utf8')
    parsed = JSON.parse(serialized)
  } catch {
    throw new WorkspaceChangeError('checkpoint_unavailable')
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== SNAPSHOT_FORMAT ||
    parsed.version !== SNAPSHOT_VERSION ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > MAX_FILES * 2
  ) {
    throw new WorkspaceChangeError('checkpoint_unavailable')
  }
  const seen = new Set<string>()
  const entries = parsed.entries.map((value): SnapshotEntry => {
    if (
      !isRecord(value) ||
      !isSafeRelativePath(value.path) ||
      (value.kind !== 'directory' && value.kind !== 'file') ||
      seen.has(value.path)
    ) {
      throw new WorkspaceChangeError('checkpoint_unavailable')
    }
    seen.add(value.path)
    if (value.kind === 'directory') return { path: value.path, kind: 'directory' }
    if (
      !Number.isSafeInteger(value.size) ||
      Number(value.size) < 0 ||
      Number(value.size) > MAX_FILE_BYTES ||
      typeof value.hash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.hash)
    ) {
      throw new WorkspaceChangeError('checkpoint_unavailable')
    }
    return { path: value.path, kind: 'file', size: Number(value.size), hash: value.hash }
  })
  return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, entries }
}

function changedManifestPaths(base: SnapshotManifest, current: SnapshotManifest): string[] {
  const paths = new Set([
    ...base.entries.map((entry) => entry.path),
    ...current.entries.map((entry) => entry.path)
  ])
  return [...paths]
    .filter((path) => !sameSnapshotEntry(manifestEntry(base, path), manifestEntry(current, path)))
    .sort()
}

function manifestEntry(manifest: SnapshotManifest, path: string): SnapshotEntry | undefined {
  return manifest.entries.find((entry) => entry.path === path)
}

function sameSnapshotEntry(left: SnapshotEntry | undefined, right: SnapshotEntry | undefined): boolean {
  if (!left || !right) return left === right
  if (left.kind !== right.kind) return false
  if (left.kind === 'directory') return true
  return left.size === right.size && left.hash === right.hash
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex')
  } catch {
    throw new WorkspaceChangeError('workspace_unavailable')
  }
}

async function detectGitRoot(workspacePath: string): Promise<string | null> {
  try {
    const output = (await runGit(workspacePath, ['rev-parse', '--show-toplevel'])).trim()
    if (!isAbsolute(output)) return null
    const root = await canonicalDirectory(output)
    return isPathInside(root, workspacePath) ? root : null
  } catch {
    return null
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'credential.helper=', '-C', cwd, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolvePromise(Buffer.concat(stdout).toString('utf8'))
    }
    const collect = (target: Buffer[]) => (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += value.length
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill()
        finish(new WorkspaceChangeError('git_failed'))
        return
      }
      target.push(value)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', () => finish(new WorkspaceChangeError('git_failed')))
    child.once('close', (code) => {
      if (code !== 0) finish(new WorkspaceChangeError('git_failed'))
      else finish()
    })
    const timeout = setTimeout(() => {
      child.kill()
      finish(new WorkspaceChangeError('git_failed'))
    }, GIT_TIMEOUT_MS)
    timeout.unref()
  })
}

async function projectIdForDirectory(absolutePath: string): Promise<string> {
  const canonical = await canonicalDirectory(absolutePath)
  const stats = await fs.stat(canonical, { bigint: true })
  const digest = createHash('sha256')
    .update('ai-terminal.workspace-project.v1\0', 'utf8')
    .update(stats.dev.toString(10), 'utf8')
    .update('\0', 'utf8')
    .update(stats.ino.toString(10), 'utf8')
    .digest('base64url')
  return `project:workspace:${digest}`
}

function findOwnedWorktree(
  document: WorkspaceChangeDocument,
  input: WorkspaceWorktreeMutationInput
): StoredWorktree {
  const worktree = document.worktrees.find((candidate) =>
    candidate.id === input.worktreeId &&
    (candidate.sourceTaskId === input.taskId || candidate.targetTaskId === input.taskId)
  )
  if (!worktree) throw new WorkspaceChangeError('worktree_unavailable')
  return worktree
}

function validateWorktreeMutationInput(input: WorkspaceWorktreeMutationInput): void {
  assertTaskId(input.taskId)
  if (!WORKTREE_ID_PATTERN.test(input.worktreeId)) throw new WorkspaceChangeError('invalid_input')
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WorkspaceChangeError('worktree_unavailable')
}

function parseDocument(serialized: string): WorkspaceChangeDocument {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new WorkspaceChangeError('corrupt_data')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new WorkspaceChangeError('corrupt_data')
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== DOCUMENT_FORMAT ||
    parsed.version !== DOCUMENT_VERSION ||
    !Array.isArray(parsed.checkpoints) ||
    !Array.isArray(parsed.worktrees) ||
    parsed.checkpoints.length > MAX_CHECKPOINTS ||
    parsed.worktrees.length > MAX_WORKTREES
  ) {
    throw new WorkspaceChangeError('corrupt_data')
  }
  const checkpoints = parsed.checkpoints.map(parseCheckpoint)
  const worktrees = parsed.worktrees.map(parseWorktree)
  if (
    new Set(checkpoints.map((item) => item.id)).size !== checkpoints.length ||
    new Set(worktrees.map((item) => item.id)).size !== worktrees.length
  ) {
    throw new WorkspaceChangeError('corrupt_data')
  }
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, checkpoints, worktrees }
}

function parseCheckpoint(value: unknown): StoredCheckpoint {
  if (
    !isRecord(value) ||
    !CHECKPOINT_ID_PATTERN.test(String(value.id)) ||
    !TASK_ID_PATTERN.test(String(value.taskId)) ||
    !PROJECT_ID_PATTERN.test(String(value.projectId)) ||
    typeof value.snapshotId !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(value.snapshotId) ||
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    value.label.length > 120 ||
    !isTimestamp(value.createdAt)
  ) throw new WorkspaceChangeError('corrupt_data')
  return {
    id: String(value.id),
    taskId: String(value.taskId),
    projectId: String(value.projectId),
    snapshotId: value.snapshotId,
    label: value.label,
    createdAt: value.createdAt
  }
}

function parseWorktree(value: unknown): StoredWorktree {
  if (
    !isRecord(value) ||
    !WORKTREE_ID_PATTERN.test(String(value.id)) ||
    !TASK_ID_PATTERN.test(String(value.sourceTaskId)) ||
    !TASK_ID_PATTERN.test(String(value.targetTaskId)) ||
    !PROJECT_ID_PATTERN.test(String(value.sourceProjectId)) ||
    !PROJECT_ID_PATTERN.test(String(value.targetProjectId)) ||
    typeof value.baseSnapshotId !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(value.baseSnapshotId) ||
    (value.kind !== 'git-worktree' && value.kind !== 'workspace-copy') ||
    (value.status !== 'ready' && value.status !== 'applied' && value.status !== 'discarded') ||
    !isAbsolutePath(value.sourcePath) ||
    !isAbsolutePath(value.targetRoot) ||
    !isAbsolutePath(value.targetWorkspacePath) ||
    (value.gitSourceRoot !== undefined && !isAbsolutePath(value.gitSourceRoot)) ||
    (value.gitBranch !== undefined && (typeof value.gitBranch !== 'string' || value.gitBranch.length > 160)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) throw new WorkspaceChangeError('corrupt_data')
  return {
    id: String(value.id),
    sourceTaskId: String(value.sourceTaskId),
    targetTaskId: String(value.targetTaskId),
    sourceProjectId: String(value.sourceProjectId),
    targetProjectId: String(value.targetProjectId),
    baseSnapshotId: value.baseSnapshotId,
    kind: value.kind,
    status: value.status,
    sourcePath: resolve(value.sourcePath),
    targetRoot: resolve(value.targetRoot),
    targetWorkspacePath: resolve(value.targetWorkspacePath),
    ...(value.gitSourceRoot ? { gitSourceRoot: resolve(value.gitSourceRoot) } : {}),
    ...(value.gitBranch ? { gitBranch: value.gitBranch } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

function emptyDocument(): WorkspaceChangeDocument {
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, checkpoints: [], worktrees: [] }
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0 || normalized.length > 120) {
    throw new WorkspaceChangeError('invalid_input')
  }
  return normalized
}

function safeSlug(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
  return normalized || 'agent-worktree'
}

function assertTaskId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new WorkspaceChangeError('invalid_input')
  }
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RELATIVE_PATH_CHARACTERS &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function pathFromRelative(root: string, relativePath: string): string {
  if (relativePath === '') return resolve(root)
  if (!isSafeRelativePath(relativePath)) throw new WorkspaceChangeError('workspace_unavailable')
  const candidate = resolve(root, ...relativePath.split('/'))
  if (!isPathInside(root, candidate)) throw new WorkspaceChangeError('workspace_unavailable')
  return candidate
}

async function removeWithin(root: string, relativePath: string): Promise<void> {
  const canonicalRoot = resolve(root)
  const target = pathFromRelative(canonicalRoot, relativePath)
  if (samePath(canonicalRoot, target) || !isPathInside(canonicalRoot, target)) {
    throw new WorkspaceChangeError('workspace_unavailable')
  }
  await fs.rm(target, { recursive: true, force: true })
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = resolve(await fs.realpath(path))
    const stats = await fs.stat(canonical)
    if (!stats.isDirectory()) throw new WorkspaceChangeError('workspace_unavailable')
    return canonical
  } catch (error) {
    if (error instanceof WorkspaceChangeError) throw error
    throw new WorkspaceChangeError('workspace_unavailable')
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

async function lstatOrNull(path: string) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === 'win32'
    ? resolve(value).toLowerCase()
    : resolve(value)
  return normalize(left) === normalize(right)
}

function pathDepth(value: string): number {
  return value.split('/').length
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 &&
    isAbsolute(value) && !/[\r\n\0]/u.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
