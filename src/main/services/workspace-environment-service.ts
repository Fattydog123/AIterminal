import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import type {
  GitDiffBase,
  GitSummary,
  WorkspaceDirectoryResult,
  WorkspaceEnvironmentSnapshot,
} from '../../shared/contracts'
import { reverseApplyHunk } from './git-hunks.ts'
import { SelectionTokenStore } from './selection-token-store.ts'
import { WorkspaceToolError, WorkspaceToolService } from './workspace-tool-service.ts'

export type WorkspaceEnvironmentErrorCode =
  | 'invalid_request'
  | 'workspace_unavailable'
  | 'workspace_changed'

export class WorkspaceEnvironmentError extends Error {
  readonly code: WorkspaceEnvironmentErrorCode

  constructor(code: WorkspaceEnvironmentErrorCode) {
    super(code)
    this.name = 'WorkspaceEnvironmentError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface WorkspaceEnvironmentServiceOptions {
  selections: SelectionTokenStore
  tools: WorkspaceToolService
  now?: () => number
  cacheTtlMs?: number
}

interface CachedEnvironment {
  readonly expiresAt: number
  readonly snapshot: WorkspaceEnvironmentSnapshot
}

const DEFAULT_CACHE_TTL_MS = 1_250
const MAX_CACHE_ENTRIES = 128
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u

const NOT_REPOSITORY: WorkspaceEnvironmentSnapshot = Object.freeze({
  state: 'not-repository',
  branch: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  clean: true,
})

const UNAVAILABLE: WorkspaceEnvironmentSnapshot = Object.freeze({
  state: 'unavailable',
  branch: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  clean: false,
})

/**
 * Produces the narrow, credential-free snapshot consumed by the environment
 * panel. The renderer never receives a local path or a general filesystem
 * capability; every read remains bound to its opaque workspace selection.
 */
export class WorkspaceEnvironmentService {
  readonly #selections: SelectionTokenStore
  readonly #tools: WorkspaceToolService
  readonly #now: () => number
  readonly #cacheTtlMs: number
  readonly #cache = new Map<string, CachedEnvironment>()
  readonly #pending = new Map<string, Promise<WorkspaceEnvironmentSnapshot>>()

  constructor(options: WorkspaceEnvironmentServiceOptions) {
    if (!options || typeof options !== 'object') throw new WorkspaceEnvironmentError('invalid_request')
    if (!(options.selections instanceof SelectionTokenStore) || !(options.tools instanceof WorkspaceToolService)) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 30_000) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    this.#selections = options.selections
    this.#tools = options.tools
    this.#now = options.now ?? Date.now
    this.#cacheTtlMs = cacheTtlMs
  }

  async inspect(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
  ): Promise<WorkspaceEnvironmentSnapshot> {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).length !== 1 ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }

    const key = `${ownerWebContentsId}:${input.workspaceToken}`
    const now = this.#readNow()
    const cached = this.#cache.get(key)
    if (cached && cached.expiresAt > now) return cached.snapshot
    this.#cache.delete(key)

    const existing = this.#pending.get(key)
    if (existing) return await existing

    const pending = this.#inspectFresh(input.workspaceToken, ownerWebContentsId)
    this.#pending.set(key, pending)
    try {
      const snapshot = await pending
      this.#store(key, snapshot)
      return snapshot
    } finally {
      if (this.#pending.get(key) === pending) this.#pending.delete(key)
    }
  }

  revokeOwner(ownerWebContentsId: number): void {
    const prefix = `${ownerWebContentsId}:`
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) this.#cache.delete(key)
    }
  }

  async #inspectFresh(
    workspaceToken: string,
    ownerWebContentsId: number,
  ): Promise<WorkspaceEnvironmentSnapshot> {
    const workspace = await this.#selections.resolveWorkspace(workspaceToken, ownerWebContentsId)
    if (!workspace) throw new WorkspaceEnvironmentError('workspace_unavailable')

    try {
      await fs.lstat(join(workspace.absolutePath, '.git'))
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) return NOT_REPOSITORY
      return UNAVAILABLE
    }

    try {
      const summary = await this.#tools.gitSummary({ workspaceToken }, ownerWebContentsId)
      return Object.freeze({
        state: 'ready',
        branch: summary.branch,
        additions: summary.additions,
        deletions: summary.deletions,
        changedFiles: summary.files.length,
        clean: summary.files.length === 0,
      })
    } catch (error) {
      if (error instanceof WorkspaceToolError) {
        if (error.code === 'workspace_changed') {
          throw new WorkspaceEnvironmentError('workspace_changed')
        }
        if (error.code === 'workspace_unavailable') {
          throw new WorkspaceEnvironmentError('workspace_unavailable')
        }
        return UNAVAILABLE
      }
      return UNAVAILABLE
    }
  }

  async diff(
    input: { workspaceToken: string; base?: GitDiffBase },
    ownerWebContentsId: number,
  ): Promise<{ patch: string; truncated: boolean }> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      (input.base !== undefined && input.base !== 'current' && input.base !== 'main') ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    try {
      const result = await this.#tools.gitDiff(
        { workspaceToken: input.workspaceToken, ...(input.base === undefined ? {} : { base: input.base }) },
        ownerWebContentsId,
        {}
      )
      return { patch: result.patch, truncated: result.truncated }
    } catch {
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
  }

  async summary(
    input: { workspaceToken: string; base?: GitDiffBase },
    ownerWebContentsId: number,
  ): Promise<GitSummary> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      (input.base !== undefined && input.base !== 'current' && input.base !== 'main') ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    try {
      return await this.#tools.gitSummary(
        { workspaceToken: input.workspaceToken, ...(input.base === undefined ? {} : { base: input.base }) },
        ownerWebContentsId
      )
    } catch {
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
  }

  async listDirectory(
    input: { workspaceToken: string; relativePath: string },
    ownerWebContentsId: number,
  ): Promise<WorkspaceDirectoryResult> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      typeof input.relativePath !== 'string' ||
      input.relativePath.length === 0 ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    try {
      return await this.#tools.listDirectory(
        { workspaceToken: input.workspaceToken, relativePath: input.relativePath },
        ownerWebContentsId,
        {},
      )
    } catch {
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
  }

  async revertPaths(
    input: { workspaceToken: string; relativePaths: readonly string[] },
    ownerWebContentsId: number,
  ): Promise<{ reverted: string[]; failed: { relativePath: string; message: string }[] }> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      !Array.isArray(input.relativePaths) ||
      input.relativePaths.length === 0 ||
      input.relativePaths.length > 40 ||
      input.relativePaths.some((path) =>
        typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.startsWith('-')) ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    const reverted: string[] = []
    const failed: { relativePath: string; message: string }[] = []
    for (const relativePath of input.relativePaths) {
      try {
        // Restores index and worktree from HEAD through the same bounded git
        // channel the commit action already uses ('--' guards the pathspec).
        const result = await this.#tools.runCommand(
          { workspaceToken: input.workspaceToken, relativePath: '.', argv: ['git', 'checkout', 'HEAD', '--', relativePath] },
          ownerWebContentsId,
          {}
        )
        if (result.exitCode === 0) {
          reverted.push(relativePath)
        } else {
          const detail = `${result.stderr || result.stdout || ''}`.trim()
          failed.push({
            relativePath,
            message: detail.includes('did not match any file')
              ? '该文件在最近一次提交中不存在（新增文件请直接删除）'
              : detail.slice(0, 300) || `git 退出码 ${result.exitCode}`,
          })
        }
      } catch {
        failed.push({ relativePath, message: '无法回退该文件' })
      }
    }
    return { reverted, failed }
  }

  async revertHunk(
    input: { workspaceToken: string; relativePath: string; hunkText: string },
    ownerWebContentsId: number,
  ): Promise<{ relativePath: string }> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      typeof input.relativePath !== 'string' ||
      input.relativePath.length === 0 ||
      input.relativePath.length > 1024 ||
      typeof input.hunkText !== 'string' ||
      input.hunkText.length < 4 ||
      input.hunkText.length > 200_000 ||
      !input.hunkText.startsWith('@@') ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    let file: { content: string; revision: string; truncated: boolean }
    try {
      file = await this.#tools.readFile(
        { workspaceToken: input.workspaceToken, relativePath: input.relativePath },
        ownerWebContentsId,
        {}
      )
    } catch {
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
    if (file.truncated) throw new WorkspaceEnvironmentError('invalid_request')
    const applied = reverseApplyHunk(file.content, input.hunkText)
    if (!applied.ok) throw new WorkspaceEnvironmentError('workspace_changed')
    try {
      await this.#tools.writeFile(
        {
          workspaceToken: input.workspaceToken,
          relativePath: input.relativePath,
          content: applied.content,
          expectedRevision: file.revision,
        },
        ownerWebContentsId,
        {}
      )
    } catch (error) {
      if (error instanceof WorkspaceToolError && error.code === 'write_conflict') {
        throw new WorkspaceEnvironmentError('workspace_changed')
      }
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
    return { relativePath: input.relativePath }
  }

  async commit(
    input: { workspaceToken: string; message: string },
    ownerWebContentsId: number,
  ): Promise<{ output: string }> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      typeof input.message !== 'string' ||
      input.message.length === 0 ||
      input.message.length > 500 ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    try {
      const addResult = await this.#tools.runCommand(
        { workspaceToken: input.workspaceToken, relativePath: '.', argv: ['git', 'add', '-A'] },
        ownerWebContentsId,
        {}
      )
      const commitResult = await this.#tools.runCommand(
        { workspaceToken: input.workspaceToken, relativePath: '.', argv: ['git', 'commit', '-m', input.message] },
        ownerWebContentsId,
        {}
      )
      const output = [addResult.stdout, addResult.stderr, commitResult.stdout, commitResult.stderr]
        .filter((s) => s.trim())
        .join('\n')
      return { output: output || `Exit code: ${commitResult.exitCode}` }
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw new WorkspaceEnvironmentError((error as { code: string }).code === 'sensitive_path' ? 'workspace_unavailable' : 'invalid_request')
      }
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
  }

  async readFile(
    input: { workspaceToken: string; relativePath: string },
    ownerWebContentsId: number,
  ): Promise<{ relativePath: string; content: string; truncated: boolean }> {
    if (
      !input ||
      typeof input !== 'object' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      typeof input.relativePath !== 'string' ||
      input.relativePath.length === 0 ||
      !Number.isSafeInteger(ownerWebContentsId) ||
      ownerWebContentsId < 1
    ) {
      throw new WorkspaceEnvironmentError('invalid_request')
    }
    try {
      const result = await this.#tools.readFile(
        { workspaceToken: input.workspaceToken, relativePath: input.relativePath },
        ownerWebContentsId,
        {}
      )
      return { relativePath: result.relativePath, content: result.content, truncated: result.truncated }
    } catch {
      throw new WorkspaceEnvironmentError('workspace_unavailable')
    }
  }

  #store(key: string, snapshot: WorkspaceEnvironmentSnapshot): void {
    if (this.#cacheTtlMs === 0) return
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value
      if (typeof oldest === 'string') this.#cache.delete(oldest)
    }
    this.#cache.set(key, {
      expiresAt: this.#readNow() + this.#cacheTtlMs,
      snapshot,
    })
  }

  #readNow(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new WorkspaceEnvironmentError('invalid_request')
    return value
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
