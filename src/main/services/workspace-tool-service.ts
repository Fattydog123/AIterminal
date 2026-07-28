import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'

import type {
  GitDiffBase,
  GitFileSummary,
  GitSummary,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryResult,
  WorkspaceFileInput,
  WorkspaceFileResult,
  WorkspaceWriteInput
} from '../../shared/contracts'
import {
  containsSensitiveCredential,
  redactCredentialContent
} from '../security/redaction.ts'
import {
  SelectionTokenStore,
  type ResolvedWorkspaceRecord
} from './selection-token-store.ts'
import {
  DEFAULT_IGNORED_TRAVERSAL_DIRECTORY_NAMES,
  PatternCompileError,
  compileGlobPattern,
  compileSearchPattern,
  type CompiledGlobPattern,
  type CompiledTextPattern
} from './workspace-pattern-matching.ts'

export type WorkspaceToolErrorCode =
  | 'invalid_request'
  | 'workspace_unavailable'
  | 'workspace_changed'
  | 'invalid_relative_path'
  | 'sensitive_path'
  | 'path_not_found'
  | 'path_not_file'
  | 'path_not_directory'
  | 'path_outside_workspace'
  | 'reparse_point_rejected'
  | 'hard_link_rejected'
  | 'file_too_large'
  | 'invalid_text_file'
  | 'invalid_pattern'
  | 'write_conflict'
  | 'partial_revision'
  | 'write_not_allowed'
  | 'write_failed'
  | 'cancelled'
  | 'command_rejected'
  | 'command_unavailable'
  | 'command_timeout'
  | 'command_output_too_large'
  | 'command_invalid_output'
  | 'git_unavailable'
  | 'git_timeout'
  | 'git_failed'
  | 'git_output_too_large'
  | 'git_invalid_output'

const WORKSPACE_TOOL_ERROR_MESSAGES: Readonly<Record<WorkspaceToolErrorCode, string>> = Object.freeze({
  invalid_request: 'The workspace tool request is invalid.',
  workspace_unavailable: 'The selected workspace is unavailable.',
  workspace_changed: 'The selected workspace changed during the operation.',
  invalid_relative_path: 'The workspace-relative path is invalid.',
  sensitive_path: 'Reading this protected local file is not allowed.',
  path_not_found: 'The requested workspace file was not found.',
  path_not_file: 'The requested workspace path is not a regular file.',
  path_not_directory: 'The requested workspace path is not a directory.',
  path_outside_workspace: 'The requested path is outside the selected workspace.',
  reparse_point_rejected: 'Symbolic links and junctions are not allowed for this operation.',
  hard_link_rejected: 'Files with multiple hard links are not allowed for this operation.',
  file_too_large: 'The requested file exceeds the safe read limit.',
  invalid_text_file: 'The requested file is not bounded UTF-8 text.',
  invalid_pattern: 'The pattern is not supported by the bounded matching engine. Simplify the pattern and retry.',
  write_conflict: 'The workspace file changed; the write was not applied.',
  partial_revision: 'That revision came from a partial read, so it cannot authorize replacing the whole file. Read the file without a line range first, then write.',
  write_not_allowed: 'Writing this protected workspace path is not allowed.',
  write_failed: 'The workspace file could not be written safely.',
  cancelled: 'The workspace tool operation was cancelled.',
  command_rejected: 'The command request is outside the bounded workspace command policy.',
  command_unavailable: 'The requested command is unavailable in the sanitized command environment.',
  command_timeout: 'The command did not finish within the safe time limit.',
  command_output_too_large: 'Command output exceeded the safe size limit.',
  command_invalid_output: 'The command returned output outside the bounded UTF-8 contract.',
  git_unavailable: 'Git is unavailable for this workspace.',
  git_timeout: 'Git did not finish within the safe time limit.',
  git_failed: 'Git could not summarize this workspace.',
  git_output_too_large: 'Git output exceeded the safe size limit.',
  git_invalid_output: 'Git returned an invalid bounded result.'
})

export class WorkspaceToolError extends Error {
  readonly code: WorkspaceToolErrorCode
  readonly retryable: boolean

  constructor(code: WorkspaceToolErrorCode, retryable = false) {
    super(WORKSPACE_TOOL_ERROR_MESSAGES[code])
    this.name = 'WorkspaceToolError'
    this.code = code
    this.retryable = retryable
    this.stack = `${this.name}: ${this.message}`
  }
}

export type LocalAccessScope = 'workspace' | 'system'

export interface WorkspaceToolExecutionOptions {
  signal?: AbortSignal
  accessScope?: LocalAccessScope
}

export interface WorkspaceSearchInput {
  workspaceToken: string
  relativePath: string
  query: string
  caseSensitive: boolean
  regex?: boolean
}

export interface WorkspaceGlobInput {
  workspaceToken: string
  relativePath: string
  pattern: string
}

export interface WorkspaceGlobFile {
  relativePath: string
  sizeBytes: number
  modifiedMs: number
}

export interface WorkspaceGlobResult {
  files: WorkspaceGlobFile[]
  truncated: boolean
}

export interface WorkspaceSearchMatch {
  relativePath: string
  line: number
  column: number
  preview: string
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[]
  truncated: boolean
}

export interface WorkspaceGitDiffResult {
  patch: string
  files: readonly string[]
  untrackedFiles: readonly string[]
  truncated: boolean
}

export interface WorkspaceReplaceInput {
  workspaceToken: string
  relativePath: string
  oldText: string
  newText: string
  expectedRevision: string
}

export interface WorkspaceReplaceResult {
  relativePath: string
  revision: string
  replacements: 1
}

export interface WorkspaceCommandInput {
  workspaceToken: string
  relativePath: string
  argv: readonly string[]
}

export interface WorkspaceCommandResult {
  relativePath: string
  exitCode: number
  stdout: string
  stderr: string
}

export interface WorkspaceDeleteInput {
  workspaceToken: string
  relativePath: string
  recursive: boolean
}

export interface WorkspaceDeleteResult {
  relativePath: string
  kind: 'file' | 'directory'
  removed: true
}

export interface WorkspaceToolServiceOptions {
  selections: SelectionTokenStore
  maxFileBytes?: number
  maxResultCharacters?: number
  maxWriteBytes?: number
  maxDirectoryEntries?: number
  maxDirectoryResultCharacters?: number
  gitExecutable?: string
  gitTimeoutMs?: number
  maxGitOutputBytes?: number
  maxGitFiles?: number
  maxSearchResults?: number
  maxSearchFiles?: number
  maxSearchResultCharacters?: number
  maxSearchSnippetCharacters?: number
  commandTimeoutMs?: number
  maxCommandOutputBytes?: number
  environmentSource?: NodeJS.ProcessEnv
  protectedAbsoluteRoots?: readonly string[]
  authorizeManagedGitWorktree?: (
    workspacePath: string,
    gitDirectory: string
  ) => Promise<{ readonly commonDirectory: string } | null>
}

interface GitMetadataLocation {
  readonly gitDirectory: string
  readonly commonDirectory: string
  readonly linked: boolean
}

interface ResolvedWorkspacePath {
  absolutePath: string
  stats: Awaited<ReturnType<typeof fs.lstat>>
}

type LocalTargetKind = 'file' | 'directory' | 'file-or-directory' | 'delete'

interface ResolvedLocalTarget {
  readonly operationRoot: ResolvedWorkspaceRecord
  readonly relativePath: string
}

interface GitStatusEntry {
  relativePath: string
  originalRelativePath?: string
  status: GitFileSummary['status']
}

interface GitDiffStat {
  additions: number
  deletions: number
}

interface MutableGitSummary extends GitDiffStat {
  status: GitFileSummary['status']
}

interface BoundedProcessOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}

interface BoundedProcessResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

interface GitIndexEntry {
  readonly oid: string
  readonly mode: string
}

interface SafeGitContext {
  readonly common: Omit<BoundedProcessOptions, 'args'>
  readonly repositoryArguments: readonly string[]
  readonly indexEntries: ReadonlyMap<string, GitIndexEntry>
  readonly headEntries: ReadonlyMap<string, GitIndexEntry>
  readonly branch: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly untrackedEntries: readonly GitStatusEntry[]
  readonly untrackedTruncated: boolean
}

interface SafeGitWorktreeChange {
  readonly content: Buffer | null
  readonly omitted: boolean
}

interface SafeGitSnapshot {
  readonly entries: readonly GitStatusEntry[]
  readonly worktreeChanges: ReadonlyMap<string, SafeGitWorktreeChange>
  readonly truncated: boolean
}

interface WriteLockState {
  tail: Promise<void>
  pending: number
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const MAX_CONFIGURED_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_DIRECTORY_ENTRIES = 512
const MAX_CONFIGURED_DIRECTORY_ENTRIES = 4_096
const DEFAULT_MAX_DIRECTORY_RESULT_CHARACTERS = 64 * 1024
const MAX_CONFIGURED_DIRECTORY_RESULT_CHARACTERS = 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const MAX_CONFIGURED_GIT_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_GIT_FILES = 10_000
const MAX_CONFIGURED_GIT_FILES = 20_000
const MAX_REVIEW_DIFF_FILES = 128
const MAX_REVIEW_PATH_ARGUMENT_CHARACTERS = 16 * 1024
const MAX_REVIEW_PATCH_CHARACTERS = 384 * 1024
const MAX_REVIEW_ATTRIBUTE_BYTES = 256 * 1024
const MAX_REVIEW_UNTRACKED_SCAN_ENTRIES = 20_000
const MAX_REVIEW_WORKTREE_SCAN_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_SEARCH_RESULTS = 256
const MAX_CONFIGURED_SEARCH_RESULTS = 4_096
const DEFAULT_MAX_SEARCH_FILES = 2_048
const MAX_CONFIGURED_SEARCH_FILES = 20_000
const DEFAULT_MAX_SEARCH_RESULT_CHARACTERS = 64 * 1024
const MAX_CONFIGURED_SEARCH_RESULT_CHARACTERS = 512 * 1024
const DEFAULT_MAX_SEARCH_SNIPPET_CHARACTERS = 240
const MAX_CONFIGURED_SEARCH_SNIPPET_CHARACTERS = 2_048
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const MAX_CONFIGURED_COMMAND_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 512 * 1024
const MAX_CONFIGURED_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_COMMAND_ARGUMENTS = 64
const MAX_COMMAND_ARGUMENT_BYTES = 16 * 1024
const MAX_COMMAND_TOTAL_ARGUMENT_BYTES = 128 * 1024
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u
/**
 * Marks a revision produced by a read that returned only part of the file.
 * write_file replaces the whole file and therefore rejects a marked revision;
 * replace_in_file strips the marker because a unique literal match cannot
 * clobber the part the model never saw.
 */
const PARTIAL_REVISION_PREFIX = 'partial:'

function stripPartialRevision(revision: string | undefined): string | undefined {
  return revision?.startsWith(PARTIAL_REVISION_PREFIX)
    ? revision.slice(PARTIAL_REVISION_PREFIX.length)
    : revision
}

/**
 * Returns the requested 1-based line window, prefixed with a marker naming the
 * range so the model never mistakes an excerpt for the whole file. `ranged` is
 * true whenever the caller asked for a window, even if it happened to cover the
 * file, because the caller's own view was still range-scoped.
 */
function selectLineWindow(
  text: string,
  startLine: number | undefined,
  lineCount: number | undefined
): { text: string; ranged: boolean } {
  if (startLine === undefined && lineCount === undefined) return { text, ranged: false }
  const lines = text.split('\n')
  const firstIndex = Math.min(Math.max((startLine ?? 1) - 1, 0), lines.length)
  const lastIndex = lineCount === undefined
    ? lines.length
    : Math.min(firstIndex + lineCount, lines.length)
  const selected = lines.slice(firstIndex, lastIndex)
  const header = `[lines ${firstIndex + 1}-${firstIndex + selected.length} of ${lines.length}]`
  return { text: `${header}\n${selected.join('\n')}`, ranged: true }
}
const COMMAND_SHELL_NAMES = new Set([
  'bash',
  'bash.exe',
  'cmd',
  'cmd.exe',
  'command.com',
  'csh',
  'dash',
  'fish',
  'ksh',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'sh.exe',
  'wsl',
  'wsl.exe',
  'zsh'
])
const WINDOWS_NODE_CLI_ENTRYPOINTS = Object.freeze({
  npm: 'npm-cli.js',
  npx: 'npx-cli.js'
} as const)
const MAX_SEARCH_QUERY_CHARACTERS = 4_096
const MAX_GLOB_RESULTS = 512
const SEARCH_DIRECTORY_ENTRY_CAP = 4_096
const SEARCH_CONTEXT_CHARACTERS = 96
const MAX_RELATIVE_PATH_CHARACTERS = 4_096
const MAX_PATH_SEGMENT_CHARACTERS = 255
const MAX_GIT_BRANCH_CHARACTERS = 256
const MAX_DIFF_LINES = 1_000_000_000
const GIT_METADATA_FILE_LIMIT = 4_096
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu
const INVALID_WINDOWS_SEGMENT_CHARACTER = /[<>:"|?*\u0000-\u001f]/u
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const SENSITIVE_EXACT_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'auth.json',
  'credentials',
  'credentials.json',
  'access-profiles.json',
  'conversation-history.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519'
])
const SENSITIVE_DIRECTORY_NAMES = new Set(['.ssh'])
const SENSITIVE_FILE_EXTENSION = /\.(?:pem|key|p12|pfx)$/iu
const PROTECTED_WRITE_DIRECTORY_NAMES = new Set(['.git', '.codex', '.agents', 'node_modules'])
const PROTECTED_WRITE_FILE_NAMES = new Set(['agents.md'])
const CONVERSATION_HISTORY_BRIDGE_FILE_PATTERN =
  /^ai-terminal-history(?:-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.md$/u
const CONVERSATION_HISTORY_TEMPORARY_PREFIX = '.ai-terminal-history-'

export class WorkspaceToolService {
  readonly #selections: SelectionTokenStore
  readonly #maxFileBytes: number
  readonly #maxResultCharacters: number
  readonly #maxWriteBytes: number
  readonly #maxDirectoryEntries: number
  readonly #maxDirectoryResultCharacters: number
  readonly #gitExecutable: string
  readonly #gitTimeoutMs: number
  readonly #maxGitOutputBytes: number
  readonly #maxGitFiles: number
  readonly #maxSearchResults: number
  readonly #maxSearchFiles: number
  readonly #maxSearchResultCharacters: number
  readonly #maxSearchSnippetCharacters: number
  readonly #commandTimeoutMs: number
  readonly #maxCommandOutputBytes: number
  readonly #environmentSource: NodeJS.ProcessEnv
  readonly #protectedAbsoluteRoots: string[]
  readonly #authorizeManagedGitWorktree?: WorkspaceToolServiceOptions['authorizeManagedGitWorktree']
  readonly #writeLocks = new Map<string, WriteLockState>()

  constructor(options: WorkspaceToolServiceOptions) {
    if (!isPlainRecord(options) || !(options.selections instanceof SelectionTokenStore)) {
      throw new WorkspaceToolError('invalid_request')
    }
    this.#selections = options.selections
    if (
      options.authorizeManagedGitWorktree !== undefined &&
      typeof options.authorizeManagedGitWorktree !== 'function'
    ) throw new WorkspaceToolError('invalid_request')
    this.#authorizeManagedGitWorktree = options.authorizeManagedGitWorktree
    this.#maxFileBytes = boundedInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      1,
      MAX_CONFIGURED_FILE_BYTES
    )
    this.#maxResultCharacters = boundedInteger(
      options.maxResultCharacters,
      this.#maxFileBytes,
      1,
      MAX_CONFIGURED_FILE_BYTES
    )
    this.#maxWriteBytes = boundedInteger(
      options.maxWriteBytes,
      2 * 1024 * 1024,
      1,
      MAX_CONFIGURED_FILE_BYTES
    )
    this.#maxDirectoryEntries = boundedInteger(
      options.maxDirectoryEntries,
      DEFAULT_MAX_DIRECTORY_ENTRIES,
      1,
      MAX_CONFIGURED_DIRECTORY_ENTRIES
    )
    this.#maxDirectoryResultCharacters = boundedInteger(
      options.maxDirectoryResultCharacters,
      DEFAULT_MAX_DIRECTORY_RESULT_CHARACTERS,
      64,
      MAX_CONFIGURED_DIRECTORY_RESULT_CHARACTERS
    )
    this.#gitExecutable = validateGitExecutable(options.gitExecutable ?? 'git')
    this.#gitTimeoutMs = boundedInteger(options.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, 100, 60_000)
    this.#maxGitOutputBytes = boundedInteger(
      options.maxGitOutputBytes,
      DEFAULT_MAX_GIT_OUTPUT_BYTES,
      128,
      MAX_CONFIGURED_GIT_OUTPUT_BYTES
    )
    this.#maxGitFiles = boundedInteger(
      options.maxGitFiles,
      DEFAULT_MAX_GIT_FILES,
      1,
      MAX_CONFIGURED_GIT_FILES
    )
    this.#maxSearchResults = boundedInteger(
      options.maxSearchResults,
      DEFAULT_MAX_SEARCH_RESULTS,
      1,
      MAX_CONFIGURED_SEARCH_RESULTS
    )
    this.#maxSearchFiles = boundedInteger(
      options.maxSearchFiles,
      DEFAULT_MAX_SEARCH_FILES,
      1,
      MAX_CONFIGURED_SEARCH_FILES
    )
    this.#maxSearchResultCharacters = boundedInteger(
      options.maxSearchResultCharacters,
      DEFAULT_MAX_SEARCH_RESULT_CHARACTERS,
      128,
      MAX_CONFIGURED_SEARCH_RESULT_CHARACTERS
    )
    this.#maxSearchSnippetCharacters = boundedInteger(
      options.maxSearchSnippetCharacters,
      DEFAULT_MAX_SEARCH_SNIPPET_CHARACTERS,
      32,
      MAX_CONFIGURED_SEARCH_SNIPPET_CHARACTERS
    )
    this.#commandTimeoutMs = boundedInteger(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      100,
      MAX_CONFIGURED_COMMAND_TIMEOUT_MS
    )
    this.#maxCommandOutputBytes = boundedInteger(
      options.maxCommandOutputBytes,
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
      128,
      MAX_CONFIGURED_COMMAND_OUTPUT_BYTES
    )
    this.#environmentSource = options.environmentSource ?? process.env
    this.#protectedAbsoluteRoots = parseProtectedRoots(options.protectedAbsoluteRoots)
  }

  async readFile(
    input: WorkspaceFileInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceFileResult> {
    assertReadFileInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'file',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (accessScope === 'workspace' && isSensitiveRelativePath(relativePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    await verifyWorkspaceRoot(workspace, options.signal)
    const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(resolvedPath.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
    if (accessScope === 'workspace') assertSingleLinkRegularFile(resolvedPath.stats)
    if (resolvedPath.stats.size > this.#maxFileBytes) {
      throw new WorkspaceToolError('file_too_large')
    }

    throwIfAborted(options.signal)
    let handle: FileHandle | null = null
    try {
      handle = await fs.open(resolvedPath.absolutePath, 'r')
      const openedStats = await handle.stat()
      if (!openedStats.isFile()) throw new WorkspaceToolError('path_not_file')
      if (accessScope === 'workspace') assertSingleLinkRegularFile(openedStats)
      if (!sameFileIdentity(resolvedPath.stats, openedStats)) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
      const bytes = await readBoundedFile(handle, this.#maxFileBytes, options.signal)
      const finalRealPath = resolve(await fs.realpath(resolvedPath.absolutePath))
      if (
        !isPathInsideWorkspace(workspace.absolutePath, finalRealPath) ||
        pathComparisonKey(finalRealPath) !== pathComparisonKey(resolvedPath.absolutePath)
      ) {
        throw new WorkspaceToolError('workspace_changed', true)
      }

      let text: string
      try {
        if (bytes.includes(0)) throw new Error('binary')
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new WorkspaceToolError('invalid_text_file')
      }

      const redacted = accessScope === 'system'
        ? redactCredentialContent(text)
        : redactCredentialContent(text)
      const window = selectLineWindow(redacted, input.startLine, input.lineCount)
      const bounded = truncateText(window.text, this.#maxResultCharacters)
      const fullRevision = createHash('sha256').update(bytes).digest('hex')
      const partial = bounded.truncated || window.ranged
      return Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath, accessScope),
        content: bounded.text,
        // A read that returned only part of the file marks its revision. That
        // keeps replace_in_file usable (it matches unique literal text, so a
        // partial view cannot silently clobber) while write_file, which
        // replaces the whole file, refuses it and forces a complete read.
        revision: partial ? `${PARTIAL_REVISION_PREFIX}${fullRevision}` : fullRevision,
        truncated: bounded.truncated
      })
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw fixedFileSystemError(error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async listDirectory(
    input: WorkspaceDirectoryInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceDirectoryResult> {
    assertListDirectoryInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'directory',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (
      accessScope === 'workspace' &&
      relativePath !== '.' &&
      isSensitiveRelativePath(relativePath)
    ) {
      throw new WorkspaceToolError('sensitive_path')
    }

    await verifyWorkspaceRoot(workspace, options.signal)
    let resolvedPath: ResolvedWorkspacePath
    if (relativePath === '.') {
      try {
        resolvedPath = {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      } catch {
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('workspace_changed', true)
      }
    } else {
      resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    }
    throwIfAborted(options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(resolvedPath.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!resolvedPath.stats.isDirectory()) throw new WorkspaceToolError('path_not_directory')

    const candidates: WorkspaceDirectoryEntry[] = []
    let eligibleEntryCount = 0
    let directory: Awaited<ReturnType<typeof fs.opendir>> | null = null
    try {
      directory = await fs.opendir(resolvedPath.absolutePath)
      while (true) {
        throwIfAborted(options.signal)
        const dirent = await directory.read()
        throwIfAborted(options.signal)
        if (!dirent) break

        let entryRelativePath: string
        try {
          entryRelativePath = normalizeWorkspaceRelativePath(
            relativePath === '.' ? dirent.name : `${relativePath}/${dirent.name}`
          )
        } catch {
          continue
        }
        if (accessScope === 'workspace' && isSensitiveRelativePath(entryRelativePath)) continue

        const candidatePath = resolve(resolvedPath.absolutePath, dirent.name)
        if (
          !isPathInsideWorkspace(workspace.absolutePath, candidatePath) ||
          (accessScope === 'workspace' && this.#isProtectedAbsolutePath(candidatePath))
        ) {
          continue
        }

        let entryStats: Awaited<ReturnType<typeof fs.lstat>>
        let canonicalPath: string
        try {
          entryStats = accessScope === 'system'
            ? await fs.stat(candidatePath)
            : await fs.lstat(candidatePath)
          throwIfAborted(options.signal)
          if (accessScope === 'workspace' && entryStats.isSymbolicLink()) continue
          if (!entryStats.isFile() && !entryStats.isDirectory()) continue
          canonicalPath = resolve(await fs.realpath(candidatePath))
          throwIfAborted(options.signal)
        } catch (error) {
          if (error instanceof WorkspaceToolError) throw error
          if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
          if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) continue
          if (accessScope === 'system') continue
          throw new WorkspaceToolError('workspace_unavailable', true)
        }
        if (accessScope === 'workspace' && (
          !isPathInsideWorkspace(workspace.absolutePath, canonicalPath) ||
          pathComparisonKey(canonicalPath) !== pathComparisonKey(candidatePath) ||
          this.#isProtectedAbsolutePath(canonicalPath)
        )) {
          continue
        }

        const safeRelativePath = safeWorkspaceResultPath(entryRelativePath, accessScope)
        if (safeRelativePath !== entryRelativePath) continue
        eligibleEntryCount = Math.min(Number.MAX_SAFE_INTEGER, eligibleEntryCount + 1)
        insertBoundedDirectoryEntry(
          candidates,
          Object.freeze({
            relativePath: safeRelativePath,
            kind: entryStats.isDirectory() ? 'directory' : 'file'
          }),
          this.#maxDirectoryEntries
        )
      }

      throwIfAborted(options.signal)
      const finalStats = await fs.lstat(resolvedPath.absolutePath)
      const finalCanonicalPath = resolve(await fs.realpath(resolvedPath.absolutePath))
      throwIfAborted(options.signal)
      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isDirectory() ||
        !sameFileIdentity(resolvedPath.stats, finalStats) ||
        pathComparisonKey(finalCanonicalPath) !== pathComparisonKey(resolvedPath.absolutePath)
      ) {
        throw new WorkspaceToolError('workspace_changed', true)
      }

      return buildBoundedDirectoryResult(
        candidates,
        eligibleEntryCount,
        this.#maxDirectoryResultCharacters
      )
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw fixedDirectorySystemError(error)
    } finally {
      await directory?.close().catch(() => undefined)
    }
  }

  async searchFiles(
    input: WorkspaceSearchInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceSearchResult> {
    assertSearchFilesInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'file-or-directory',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (
      accessScope === 'workspace' &&
      relativePath !== '.' &&
      isSensitiveRelativePath(relativePath)
    ) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (accessScope === 'workspace' && isSearchExcludedRelativePath(relativePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    await verifyWorkspaceRoot(workspace, options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    let root: ResolvedWorkspacePath
    if (relativePath === '.') {
      try {
        root = {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      } catch (error) {
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw fixedDirectorySystemError(error)
      }
    } else {
      root = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    }
    throwIfAborted(options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(root.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!root.stats.isFile() && !root.stats.isDirectory()) {
      throw new WorkspaceToolError('path_not_directory')
    }

    let textPattern: CompiledTextPattern | null = null
    if (input.regex === true) {
      try {
        textPattern = compileSearchPattern(input.query, input.caseSensitive)
      } catch (error) {
        if (error instanceof PatternCompileError) throw new WorkspaceToolError('invalid_pattern')
        throw error
      }
    }
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
    const matches: WorkspaceSearchMatch[] = []
    let resultsFull = false

    const appendMatch = (candidateRelativePath: string, lineNumber: number, column: number, preview: string): boolean => {
      const match = Object.freeze({
        relativePath: safeWorkspaceResultPath(candidateRelativePath, accessScope),
        line: lineNumber,
        column,
        preview
      })
      const nextMatches = [...matches, match]
      if (
        nextMatches.length > this.#maxSearchResults ||
        JSON.stringify({ matches: nextMatches, truncated: true }).length >
          this.#maxSearchResultCharacters
      ) {
        resultsFull = true
        return false
      }
      matches.push(match)
      return true
    }

    const onFile = async (candidate: ResolvedWorkspacePath, candidateRelativePath: string): Promise<'continue' | 'stop'> => {
      if (candidate.stats.size > this.#maxFileBytes) return 'continue'

      let handle: FileHandle | null = null
      try {
        handle = await fs.open(candidate.absolutePath, 'r')
        const openedStats = await handle.stat()
        if (!openedStats.isFile() || !sameFileIdentity(candidate.stats, openedStats)) return 'continue'
        if (accessScope === 'workspace') assertSingleLinkRegularFile(openedStats)
        const bytes = await readBoundedFile(handle, this.#maxFileBytes, options.signal)
        const finalRealPath = resolve(await fs.realpath(candidate.absolutePath))
        if (
          !isPathInsideWorkspace(workspace.absolutePath, finalRealPath) ||
          pathComparisonKey(finalRealPath) !== pathComparisonKey(candidate.absolutePath)
        ) {
          return 'continue'
        }
        let text: string
        try {
          if (bytes.includes(0) || containsUnsafeControlCharacters(bytes)) throw new Error('binary')
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          return 'continue'
        }

        const lines = text.split(/\r?\n/u)
        if (textPattern !== null) {
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            throwIfAborted(options.signal)
            const line = lines[lineIndex]!
            let offset = 0
            while (offset <= line.length) {
              const found = textPattern.findMatch(line, offset)
              if (found === null) break
              if (found.end === found.start) {
                offset = found.start + 1
                continue
              }
              const preview = buildSearchPreview(
                line,
                found.start,
                found.end - found.start,
                this.#maxSearchSnippetCharacters,
                accessScope
              )
              if (!appendMatch(candidateRelativePath, lineIndex + 1, found.start + 1, preview)) return 'stop'
              offset = found.end
            }
          }
          return 'continue'
        }

        const searchText = input.caseSensitive ? text : text.toLowerCase()
        const searchLines = searchText.split(/\r?\n/u)
        for (let lineIndex = 0; lineIndex < searchLines.length; lineIndex += 1) {
          throwIfAborted(options.signal)
          const line = searchLines[lineIndex]!
          let offset = 0
          while (offset <= line.length - needle.length) {
            const matchOffset = line.indexOf(needle, offset)
            if (matchOffset < 0) break
            const originalLine = lines[lineIndex] ?? ''
            const preview = buildSearchPreview(
              originalLine,
              matchOffset,
              input.query.length,
              this.#maxSearchSnippetCharacters,
              accessScope
            )
            if (!appendMatch(candidateRelativePath, lineIndex + 1, matchOffset + 1, preview)) return 'stop'
            offset = matchOffset + Math.max(needle.length, 1)
          }
        }
        return 'continue'
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        // Files which disappear or cannot be decoded are ignored safely.
        return 'continue'
      } finally {
        await handle?.close().catch(() => undefined)
      }
    }

    const walkTruncated = await this.#walkEligibleFiles(
      workspace,
      root,
      relativePath,
      accessScope,
      options.signal,
      onFile
    )
    throwIfAborted(options.signal)
    try {
      const finalRootStats = await fs.lstat(root.absolutePath)
      if (!sameFileIdentity(root.stats, finalRootStats)) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw new WorkspaceToolError('workspace_changed', true)
    }

    return Object.freeze({
      matches: Object.freeze(matches) as unknown as WorkspaceSearchMatch[],
      truncated: walkTruncated || resultsFull
    })
  }

  async globFiles(
    input: WorkspaceGlobInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceGlobResult> {
    assertGlobFilesInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    let glob: CompiledGlobPattern
    try {
      glob = compileGlobPattern(input.pattern)
    } catch (error) {
      if (error instanceof PatternCompileError) throw new WorkspaceToolError('invalid_pattern')
      throw error
    }

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'file-or-directory',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (
      accessScope === 'workspace' &&
      relativePath !== '.' &&
      isSensitiveRelativePath(relativePath)
    ) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (accessScope === 'workspace' && isSearchExcludedRelativePath(relativePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    await verifyWorkspaceRoot(workspace, options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    let root: ResolvedWorkspacePath
    if (relativePath === '.') {
      try {
        root = {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      } catch (error) {
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw fixedDirectorySystemError(error)
      }
    } else {
      root = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    }
    throwIfAborted(options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(root.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!root.stats.isDirectory()) {
      throw new WorkspaceToolError('path_not_directory')
    }

    const collected: WorkspaceGlobFile[] = []
    const basePrefix = relativePath === '.' ? '' : `${relativePath}/`
    const walkTruncated = await this.#walkEligibleFiles(
      workspace,
      root,
      relativePath,
      accessScope,
      options.signal,
      async (candidate, candidateRelativePath) => {
        let relativeToBase = candidateRelativePath
        if (basePrefix.length > 0) {
          if (!candidateRelativePath.startsWith(basePrefix)) return 'continue'
          relativeToBase = candidateRelativePath.slice(basePrefix.length)
        }
        if (!glob.matchesPath(relativeToBase)) return 'continue'
        collected.push({
          relativePath: safeWorkspaceResultPath(candidateRelativePath, accessScope),
          sizeBytes: Number(candidate.stats.size),
          modifiedMs: Math.floor(Number(candidate.stats.mtimeMs))
        })
        return 'continue'
      }
    )
    throwIfAborted(options.signal)
    try {
      const finalRootStats = await fs.lstat(root.absolutePath)
      if (!sameFileIdentity(root.stats, finalRootStats)) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw new WorkspaceToolError('workspace_changed', true)
    }

    collected.sort((left, right) =>
      right.modifiedMs - left.modifiedMs ||
      (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
    )
    const files = collected.slice(0, MAX_GLOB_RESULTS).map((file) => Object.freeze(file))
    return Object.freeze({
      files: files as unknown as WorkspaceGlobFile[],
      truncated: walkTruncated || collected.length > files.length
    })
  }

  /**
   * Shared bounded traversal for search and glob so both tools see exactly
   * the same file population: workspace exclusions, protected paths, symlink
   * and hard-link rules, loop guards, and the visited-file budget are applied
   * here once. Dependency and build directories are skipped while descending;
   * rooting the operation inside one still works.
   */
  async #walkEligibleFiles(
    workspace: { absolutePath: string },
    root: ResolvedWorkspacePath,
    rootRelativePath: string,
    accessScope: LocalAccessScope,
    signal: AbortSignal | undefined,
    onFile: (candidate: ResolvedWorkspacePath, candidateRelativePath: string) => Promise<'continue' | 'stop'>
  ): Promise<boolean> {
    let truncated = false
    let visitedFiles = 0
    let visitedEntries = 0
    const visitedDirectories = new Set<string>()

    const visit = async (candidate: ResolvedWorkspacePath, candidateRelativePath: string): Promise<void> => {
      throwIfAborted(signal)
      if (truncated) return
      if (accessScope === 'workspace' && isSearchExcludedRelativePath(candidateRelativePath)) return
      if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(candidate.absolutePath)) return

      if (candidate.stats.isDirectory()) {
        const directoryKey = pathComparisonKey(candidate.absolutePath)
        if (visitedDirectories.has(directoryKey)) return
        visitedDirectories.add(directoryKey)
        const names: string[] = []
        let directory: Awaited<ReturnType<typeof fs.opendir>> | null = null
        try {
          directory = await fs.opendir(candidate.absolutePath)
          while (true) {
            throwIfAborted(signal)
            const dirent = await directory.read()
            if (!dirent) break
            if (++visitedEntries > this.#maxSearchFiles * 4) {
              truncated = true
              break
            }
            if (names.length >= SEARCH_DIRECTORY_ENTRY_CAP) {
              truncated = true
              break
            }
            if (!isSafeSearchEntryName(dirent.name)) continue
            names.push(dirent.name)
          }
        } catch (error) {
          if (error instanceof WorkspaceToolError) throw error
          if (signal?.aborted) throw new WorkspaceToolError('cancelled')
          // A directory which disappears or becomes inaccessible is skipped.
          return
        } finally {
          await directory?.close().catch(() => undefined)
        }
        names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        for (const name of names) {
          throwIfAborted(signal)
          if (truncated) return
          let childRelativePath: string
          try {
            childRelativePath = normalizeWorkspaceRelativePath(
              candidateRelativePath === '.' ? name : `${candidateRelativePath}/${name}`
            )
          } catch {
            continue
          }
          if (accessScope === 'workspace' && isSearchExcludedRelativePath(childRelativePath)) continue
          const childPath = resolve(candidate.absolutePath, name)
          if (!isPathInsideWorkspace(workspace.absolutePath, childPath)) continue

          let childStats: Awaited<ReturnType<typeof fs.lstat>>
          let canonicalPath: string
          try {
            childStats = accessScope === 'system'
              ? await fs.stat(childPath)
              : await fs.lstat(childPath)
            throwIfAborted(signal)
            if (accessScope === 'workspace' && childStats.isSymbolicLink()) continue
            if (!childStats.isFile() && !childStats.isDirectory()) continue
            if (childStats.isDirectory() && DEFAULT_IGNORED_TRAVERSAL_DIRECTORY_NAMES.has(name.toLowerCase())) continue
            canonicalPath = resolve(await fs.realpath(childPath))
            throwIfAborted(signal)
          } catch (error) {
            if (error instanceof WorkspaceToolError) throw error
            if (signal?.aborted) throw new WorkspaceToolError('cancelled')
            continue
          }
          if (accessScope === 'workspace' && (
            !isPathInsideWorkspace(workspace.absolutePath, canonicalPath) ||
            pathComparisonKey(canonicalPath) !== pathComparisonKey(childPath) ||
            this.#isProtectedAbsolutePath(canonicalPath)
          )) {
            continue
          }
          await visit(
            { absolutePath: canonicalPath, stats: childStats },
            childRelativePath
          )
        }
        return
      }

      if (!candidate.stats.isFile()) return
      if (accessScope === 'workspace') assertSingleLinkRegularFile(candidate.stats)
      if (++visitedFiles > this.#maxSearchFiles) {
        truncated = true
        return
      }
      if (await onFile(candidate, candidateRelativePath) === 'stop') truncated = true
    }

    await visit(root, rootRelativePath)
    return truncated
  }

  async replaceInFile(
    input: WorkspaceReplaceInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceReplaceResult> {
    assertReplaceInFileInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    if (
      Buffer.byteLength(input.oldText, 'utf8') > this.#maxWriteBytes ||
      Buffer.byteLength(input.newText, 'utf8') > this.#maxWriteBytes
    ) {
      throw new WorkspaceToolError('file_too_large')
    }

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'file',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (
      accessScope === 'workspace' &&
      (isSensitiveRelativePath(relativePath) || isProtectedWriteRelativePath(relativePath))
    ) {
      throw new WorkspaceToolError('write_not_allowed')
    }

    const releaseWriteLock = await this.#acquireWriteLock(
      localWriteLockKey(input.workspaceToken, workspace, relativePath),
      options.signal
    )
    try {
      throwIfAborted(options.signal)
      await verifyWorkspaceRoot(workspace, options.signal)
      const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
      throwIfAborted(options.signal)
      if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(resolvedPath.absolutePath)) {
        throw new WorkspaceToolError('write_not_allowed')
      }
      if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
      if (accessScope === 'workspace') assertSingleLinkRegularFile(resolvedPath.stats)
      if (resolvedPath.stats.size > this.#maxWriteBytes) {
        throw new WorkspaceToolError('file_too_large')
      }

      let handle: FileHandle | null = null
      let bytes!: Buffer
      try {
        handle = await fs.open(resolvedPath.absolutePath, 'r')
        const openedStats = await handle.stat()
        if (!openedStats.isFile() || !sameFileIdentity(resolvedPath.stats, openedStats)) {
          throw new WorkspaceToolError('write_conflict')
        }
        if (accessScope === 'workspace') assertSingleLinkRegularFile(openedStats)
        bytes = await readBoundedFile(handle, this.#maxWriteBytes, options.signal)
        const finalRealPath = resolve(await fs.realpath(resolvedPath.absolutePath))
        if (
          !isPathInsideWorkspace(workspace.absolutePath, finalRealPath) ||
          pathComparisonKey(finalRealPath) !== pathComparisonKey(resolvedPath.absolutePath)
        ) {
          throw new WorkspaceToolError('workspace_changed', true)
        }
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('write_conflict')
      } finally {
        await handle?.close().catch(() => undefined)
      }

      throwIfAborted(options.signal)
      const currentRevision = createHash('sha256').update(bytes).digest('hex')
      // A targeted replacement stays safe after a partial read: it must match a
      // unique literal, so an unseen remainder cannot be silently rewritten.
      if (currentRevision !== stripPartialRevision(input.expectedRevision)) {
        throw new WorkspaceToolError('write_conflict')
      }
      let text: string
      try {
        if (bytes.includes(0)) throw new Error('binary')
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        throw new WorkspaceToolError('invalid_text_file')
      }
      const matchCount = countLiteralMatches(text, input.oldText)
      if (matchCount !== 1) throw new WorkspaceToolError('write_conflict')
      const matchOffset = text.indexOf(input.oldText)
      const replacementText =
        text.slice(0, matchOffset) + input.newText + text.slice(matchOffset + input.oldText.length)
      const replacementBytes = Buffer.from(replacementText, 'utf8')
      if (replacementBytes.byteLength > this.#maxWriteBytes) {
        throw new WorkspaceToolError('file_too_large')
      }
      const result = Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath, accessScope),
        revision: createHash('sha256').update(replacementBytes).digest('hex'),
        replacements: 1 as const
      })

      const parentPath = dirname(resolvedPath.absolutePath)
      let temporaryPath = ''
      let temporaryHandle: FileHandle | null = null
      let committed = false
      try {
        throwIfAborted(options.signal)
        const temporary = await createTemporaryWriteFile(parentPath)
        temporaryPath = temporary.path
        temporaryHandle = temporary.handle
        throwIfAborted(options.signal)
        await temporaryHandle.chmod(Number(resolvedPath.stats.mode) & 0o777).catch(() => undefined)
        await temporaryHandle.writeFile(replacementBytes)
        throwIfAborted(options.signal)
        await temporaryHandle.sync()
        throwIfAborted(options.signal)
        await temporaryHandle.close()
        temporaryHandle = null

        await verifyWorkspaceRoot(workspace, options.signal)
        const verifiedParent = resolve(await fs.realpath(parentPath))
        throwIfAborted(options.signal)
        if (pathComparisonKey(verifiedParent) !== pathComparisonKey(parentPath)) {
          throw new WorkspaceToolError('workspace_changed', true)
        }
        await revalidateWriteTarget(
          resolvedPath.absolutePath,
          workspace,
          resolvedPath.stats,
          // The pre-commit recheck compares against the real file hash; a
          // partial-read marker was already accepted for this targeted edit.
          stripPartialRevision(input.expectedRevision),
          this.#maxWriteBytes,
          options.signal,
          accessScope
        )
        throwIfAborted(options.signal)
        await fs.rename(temporaryPath, resolvedPath.absolutePath)
        committed = true
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted && !committed) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('write_failed', true)
      } finally {
        let cleanupFailed = false
        if (temporaryHandle) {
          try {
            await temporaryHandle.close()
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && temporaryPath) {
          try {
            await fs.rm(temporaryPath, { force: true })
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && cleanupFailed) throw new WorkspaceToolError('write_failed', true)
      }
      return result
    } finally {
      releaseWriteLock()
    }
  }

  async writeFile(
    input: WorkspaceWriteInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceFileResult> {
    assertWriteFileInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    const contentBytes = Buffer.from(input.content, 'utf8')
    if (contentBytes.byteLength > this.#maxWriteBytes) {
      throw new WorkspaceToolError('file_too_large')
    }

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'file',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (
      accessScope === 'workspace' &&
      (isSensitiveRelativePath(relativePath) || isProtectedWriteRelativePath(relativePath))
    ) {
      throw new WorkspaceToolError('write_not_allowed')
    }
    const releaseWriteLock = await this.#acquireWriteLock(
      localWriteLockKey(input.workspaceToken, workspace, relativePath),
      options.signal
    )
    try {
      throwIfAborted(options.signal)

      await verifyWorkspaceRoot(workspace, options.signal)
      const segments = relativePath.split('/')
      const fileName = segments.at(-1)!
      const parentRelativePath = segments.slice(0, -1).join('/')
      const parent = parentRelativePath
        ? await resolveExistingWorkspacePath(workspace, parentRelativePath, options.signal)
        : { absolutePath: workspace.absolutePath, stats: await fs.lstat(workspace.absolutePath) }
      throwIfAborted(options.signal)
      if (!parent.stats.isDirectory()) throw new WorkspaceToolError('path_not_found')
      if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(parent.absolutePath)) {
        throw new WorkspaceToolError('write_not_allowed')
      }

      const targetPath = resolve(parent.absolutePath, fileName)
      if (!isPathInsideWorkspace(workspace.absolutePath, targetPath)) {
        throw new WorkspaceToolError('path_outside_workspace')
      }
      const existing = await inspectWriteTarget(targetPath, workspace, options.signal, accessScope)
      if (existing) {
        if (!input.expectedRevision) throw new WorkspaceToolError('write_conflict')
        const currentRevision = await revisionForExistingFile(
          targetPath,
          existing,
          this.#maxWriteBytes,
          options.signal,
          accessScope
        )
        if (currentRevision !== input.expectedRevision) {
          throw new WorkspaceToolError('write_conflict')
        }
      } else if (input.expectedRevision !== undefined) {
        throw new WorkspaceToolError('write_conflict')
      }

      const redacted = accessScope === 'system'
        ? redactCredentialContent(input.content)
        : redactCredentialContent(input.content)
      const bounded = truncateText(redacted, this.#maxResultCharacters)
      const result = Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath, accessScope),
        content: bounded.text,
        revision: createHash('sha256').update(contentBytes).digest('hex'),
        truncated: bounded.truncated
      })
      throwIfAborted(options.signal)

      let temporaryPath = ''
      let temporaryHandle: FileHandle | null = null
      let committed = false
      try {
        throwIfAborted(options.signal)
        const temporary = await createTemporaryWriteFile(parent.absolutePath)
        temporaryPath = temporary.path
        temporaryHandle = temporary.handle
        throwIfAborted(options.signal)
        if (existing) {
          await temporaryHandle.chmod(Number(existing.mode) & 0o777).catch(() => undefined)
        }
        throwIfAborted(options.signal)
        await temporaryHandle.writeFile(contentBytes)
        throwIfAborted(options.signal)
        await temporaryHandle.sync()
        throwIfAborted(options.signal)
        await temporaryHandle.close()
        temporaryHandle = null

        throwIfAborted(options.signal)
        await verifyWorkspaceRoot(workspace, options.signal)
        const verifiedParent = resolve(await fs.realpath(parent.absolutePath))
        throwIfAborted(options.signal)
        if (pathComparisonKey(verifiedParent) !== pathComparisonKey(parent.absolutePath)) {
          throw new WorkspaceToolError('workspace_changed', true)
        }
        await revalidateWriteTarget(
          targetPath,
          workspace,
          existing,
          input.expectedRevision,
          this.#maxWriteBytes,
          options.signal,
          accessScope
        )
        throwIfAborted(options.signal)
        await fs.rename(temporaryPath, targetPath)
        committed = true
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted && !committed) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('write_failed', true)
      } finally {
        let cleanupFailed = false
        if (temporaryHandle) {
          try {
            await temporaryHandle.close()
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && temporaryPath) {
          try {
            await fs.rm(temporaryPath, { force: true })
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && cleanupFailed) throw new WorkspaceToolError('write_failed', true)
      }

      return result
    } finally {
      releaseWriteLock()
    }
  }

  async deletePath(
    input: WorkspaceDeleteInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceDeleteResult> {
    assertDeletePathInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'delete',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    if (accessScope === 'workspace' && (
      isSensitiveRelativePath(relativePath) ||
      isProtectedWriteRelativePath(relativePath)
    )) {
      throw new WorkspaceToolError('write_not_allowed')
    }

    const releaseWriteLock = await this.#acquireWriteLock(
      localWriteLockKey(input.workspaceToken, workspace, relativePath),
      options.signal
    )
    let removed = false
    try {
      throwIfAborted(options.signal)
      await verifyWorkspaceRoot(workspace, options.signal)
      const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
      throwIfAborted(options.signal)

      if (
        accessScope === 'workspace' &&
        this.#isProtectedAbsolutePath(resolvedPath.absolutePath)
      ) {
        throw new WorkspaceToolError('write_not_allowed')
      }

      const isDirectory = resolvedPath.stats.isDirectory()
      const isFile = resolvedPath.stats.isFile()
      if (!isDirectory && !isFile) throw new WorkspaceToolError('path_not_file')
      if (isDirectory && !input.recursive) throw new WorkspaceToolError('path_not_file')
      if (accessScope === 'workspace' && isFile) assertSingleLinkRegularFile(resolvedPath.stats)
      if (accessScope === 'workspace' && isDirectory) {
        await assertWorkspaceDeleteTreeAllowed(
          workspace,
          resolvedPath.absolutePath,
          relativePath,
          this.#protectedAbsoluteRoots,
          options.signal
        )
      }

      // Re-check identity immediately before the destructive operation so a
      // replacement or reparse-point swap cannot redirect the delete.
      await verifyWorkspaceRoot(workspace, options.signal)
      const currentStats = await fs.lstat(resolvedPath.absolutePath)
      if (
        currentStats.isSymbolicLink() ||
        !sameFileIdentity(resolvedPath.stats, currentStats) ||
        currentStats.isDirectory() !== isDirectory ||
        currentStats.isFile() !== isFile
      ) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
      const canonical = resolve(await fs.realpath(resolvedPath.absolutePath))
      if (
        !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
        pathComparisonKey(canonical) !== pathComparisonKey(resolvedPath.absolutePath)
      ) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
      throwIfAborted(options.signal)

      await fs.rm(resolvedPath.absolutePath, {
        recursive: isDirectory && input.recursive,
        force: false
      })
      removed = true
      return Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath, accessScope),
        kind: isDirectory ? 'directory' : 'file',
        removed: true as const
      })
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted && !removed) throw new WorkspaceToolError('cancelled')
      if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
        throw new WorkspaceToolError('path_not_found')
      }
      if (isNodeErrorCode(error, 'EISDIR')) throw new WorkspaceToolError('path_not_file')
      throw new WorkspaceToolError('write_failed', true)
    } finally {
      releaseWriteLock()
    }
  }

  async runCommand(
    input: WorkspaceCommandInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceCommandResult> {
    assertRunCommandInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    const accessScope = normalizeWorkspaceToolAccessScope(options.accessScope)
    throwIfAborted(options.signal)

    const argv = normalizeWorkspaceCommandArgv(input.argv, accessScope)
    const selectedWorkspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    const target = await resolveLocalTarget(
      selectedWorkspace,
      input.relativePath,
      accessScope,
      'directory',
      options.signal
    )
    const { operationRoot: workspace, relativePath } = target
    await verifyWorkspaceRoot(workspace, options.signal)
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    const resolvedDirectory = relativePath === '.'
      ? {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      : await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    if (!resolvedDirectory.stats.isDirectory()) {
      throw new WorkspaceToolError('path_not_directory')
    }
    if (accessScope === 'workspace' && this.#isProtectedAbsolutePath(resolvedDirectory.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    const environment = accessScope === 'system'
      ? systemCommandEnvironment(this.#environmentSource)
      : sanitizedCommandEnvironment(
          this.#environmentSource,
          workspace.absolutePath,
          this.#protectedAbsoluteRoots
        )
    const executable = await resolveCommandExecutable(
      argv[0]!,
      environment,
      workspace.absolutePath,
      options.signal,
      accessScope
    )
    const processResult = await runBoundedCommandProcess({
      command: executable.command,
      args: [...executable.prefixArguments, ...argv.slice(1)],
      cwd: resolvedDirectory.absolutePath,
      env: environment,
      timeoutMs: this.#commandTimeoutMs,
      maxOutputBytes: this.#maxCommandOutputBytes,
      signal: options.signal
    })
    throwIfAborted(options.signal)
    await verifyWorkspaceRoot(workspace, options.signal)

    const finalDirectory = relativePath === '.'
      ? {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      : await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    if (
      !finalDirectory.stats.isDirectory() ||
      !sameFileIdentity(resolvedDirectory.stats, finalDirectory.stats)
    ) {
      throw new WorkspaceToolError('workspace_changed', true)
    }

    return Object.freeze({
      relativePath: safeWorkspaceResultPath(relativePath, accessScope),
      exitCode: processResult.exitCode,
      stdout: decodeCommandOutput(processResult.stdout, accessScope),
      stderr: decodeCommandOutput(processResult.stderr, accessScope)
    })
  }

  async gitSummary(
    input: { workspaceToken: string; base?: GitDiffBase },
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<GitSummary> {
    assertGitSummaryInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    if (this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    const gitContext = await this.#prepareSafeGitContext(workspace, options.signal, input.base)
    const snapshot = await this.#inspectSafeGitSnapshot(workspace, gitContext, options.signal)
    const selection = selectReviewDiffPaths(snapshot.entries)
    const patches = await this.#buildSafeRepositoryPatches(
      selection.paths,
      gitContext,
      snapshot,
      options.signal
    )
    await verifyWorkspaceRoot(workspace, options.signal)
    return buildGitSummary(
      gitContext.branch,
      snapshot.entries,
      patches.stats,
      this.#maxGitFiles
    )
  }

  async gitDiff(
    input: { workspaceToken: string; base?: GitDiffBase },
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceGitDiffResult> {
    assertGitSummaryInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    if (this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    const gitContext = await this.#prepareSafeGitContext(workspace, options.signal, input.base)
    const snapshot = await this.#inspectSafeGitSnapshot(workspace, gitContext, options.signal)
    const selection = selectReviewDiffPaths(snapshot.entries)
    if (selection.files.length === 0) {
      await verifyWorkspaceRoot(workspace, options.signal)
      return Object.freeze({
        patch: '',
        files: Object.freeze([]),
        untrackedFiles: Object.freeze([...selection.untrackedFiles]),
        truncated: selection.truncated || snapshot.truncated
      })
    }

    const patches = await this.#buildSafeRepositoryPatches(
      selection.paths,
      gitContext,
      snapshot,
      options.signal
    )
    throwIfAborted(options.signal)
    await verifyWorkspaceRoot(workspace, options.signal)

    const combined = [
      patches.worktreePatch ? '## Unstaged changes\n' + patches.worktreePatch : '',
      patches.stagedPatch ? '## Staged changes\n' + patches.stagedPatch : ''
    ].filter(Boolean).join('\n\n')
    const bounded = truncateText(combined, MAX_REVIEW_PATCH_CHARACTERS)
    return Object.freeze({
      patch: bounded.text,
      files: Object.freeze([...selection.files]),
      untrackedFiles: Object.freeze([...selection.untrackedFiles]),
      truncated:
        selection.truncated ||
        snapshot.truncated ||
        patches.truncated ||
        bounded.truncated
    })
  }

  async #prepareSafeGitContext(
    workspace: ResolvedWorkspaceRecord,
    signal?: AbortSignal,
    base: GitDiffBase = 'current'
  ): Promise<SafeGitContext> {
    const gitMetadata = await verifyGitMetadataLocation(
      workspace,
      this.#authorizeManagedGitWorktree,
      signal
    )
    const environment = sanitizedGitEnvironment(this.#environmentSource)
    const gitExecutable = await resolveGitExecutable(
      this.#gitExecutable,
      this.#environmentSource,
      workspace.absolutePath
    )
    const common: Omit<BoundedProcessOptions, 'args'> = {
      command: gitExecutable,
      cwd: workspace.absolutePath,
      env: environment,
      timeoutMs: this.#gitTimeoutMs,
      maxOutputBytes: this.#maxGitOutputBytes,
      signal
    }
    const repositoryArguments = safeGitRepositoryArguments(
      gitMetadata.gitDirectory,
      workspace.absolutePath
    )
    await verifySafeGitConfiguration(
      common,
      repositoryArguments,
      gitMetadata,
      signal
    )
    const indexOutput = await runBoundedProcess({
      ...common,
      args: [...repositoryArguments, 'ls-files', '--stage', '-z']
    })
    const indexEntries = parseGitIndexEntries(indexOutput, this.#maxGitFiles)
    // 'current' compares against HEAD (uncommitted work only). 'main' compares
    // against the merge-base with the main branch so committed branch work is
    // included; if no main/master ref exists the base falls back to HEAD. The
    // ref never comes from free-form input — only the two enum values map to
    // git arguments here.
    let baselineRef = 'HEAD'
    if (base === 'main') {
      for (const candidate of ['main', 'master']) {
        try {
          const mergeBaseOutput = await runBoundedProcess({
            ...common,
            args: [...repositoryArguments, 'merge-base', 'HEAD', candidate]
          })
          const resolved = decodeGitOutput(mergeBaseOutput).trim()
          if (/^[0-9a-f]{40,64}$/iu.test(resolved)) {
            baselineRef = resolved
            break
          }
        } catch (error) {
          if (!(error instanceof WorkspaceToolError) || error.code !== 'git_failed') throw error
        }
      }
    }
    let headEntries: Map<string, GitIndexEntry>
    try {
      const headOutput = await runBoundedProcess({
        ...common,
        args: [...repositoryArguments, 'ls-tree', '-r', '-z', '--full-tree', baselineRef]
      })
      headEntries = parseGitTreeEntries(headOutput, this.#maxGitFiles)
    } catch (error) {
      if (!(error instanceof WorkspaceToolError) || error.code !== 'git_failed') throw error
      headEntries = new Map()
    }
    const objectFormat = inferGitObjectFormat(indexEntries, headEntries)
    let branch = 'HEAD'
    try {
      const branchOutput = await runBoundedProcess({
        ...common,
        args: [...repositoryArguments, 'symbolic-ref', '--quiet', '--short', 'HEAD']
      })
      branch = safeGitBranchName(branchOutput)
    } catch (error) {
      if (!(error instanceof WorkspaceToolError) || error.code !== 'git_failed') throw error
    }
    await verifyReviewWorktreePreflight(
      workspace,
      [...indexEntries.keys()],
      this.#protectedAbsoluteRoots,
      signal
    )
    const untracked = await enumerateSafeUntrackedFiles(
      workspace,
      new Set(indexEntries.keys()),
      this.#maxGitFiles,
      this.#protectedAbsoluteRoots,
      signal
    )
    return {
      common,
      repositoryArguments,
      indexEntries,
      headEntries,
      branch,
      objectFormat,
      untrackedEntries: untracked.entries,
      untrackedTruncated: untracked.truncated
    }
  }

  async #inspectSafeGitSnapshot(
    workspace: ResolvedWorkspaceRecord,
    context: SafeGitContext,
    signal?: AbortSignal
  ): Promise<SafeGitSnapshot> {
    const entries: GitStatusEntry[] = []
    const worktreeChanges = new Map<string, SafeGitWorktreeChange>()
    let scannedBytes = 0
    let truncated = context.untrackedTruncated
    const sensitiveHeadOids = new Set(
      [...context.headEntries]
        .filter(([relativePath]) => isReviewSensitiveRelativePath(relativePath))
        .map(([, entry]) => entry.oid)
    )

    const repositoryPaths = new Set([
      ...context.headEntries.keys(),
      ...context.indexEntries.keys()
    ])
    for (const relativePath of repositoryPaths) {
      if (isReviewSensitiveRelativePath(relativePath)) continue
      const head = context.headEntries.get(relativePath)
      const index = context.indexEntries.get(relativePath)
      if (index && sensitiveHeadOids.has(index.oid) && !head) continue
      if (!head && index) entries.push({ relativePath, status: 'added' })
      else if (head && !index) entries.push({ relativePath, status: 'deleted' })
      else if (head && index && (head.oid !== index.oid || head.mode !== index.mode)) {
        entries.push({ relativePath, status: 'modified' })
      }
    }

    for (const [relativePath, indexEntry] of context.indexEntries) {
      throwIfAborted(signal)
      if (
        isReviewSensitiveRelativePath(relativePath) ||
        sensitiveHeadOids.has(indexEntry.oid) && !context.headEntries.has(relativePath)
      ) {
        continue
      }
      let current: Buffer | null
      try {
        current = await readStableWorkspaceFileIfExists(
          workspace,
          relativePath,
          this.#maxFileBytes,
          this.#protectedAbsoluteRoots,
          signal
        )
      } catch (error) {
        if (error instanceof WorkspaceToolError && error.code === 'file_too_large') {
          worktreeChanges.set(relativePath, { content: null, omitted: true })
          entries.push({ relativePath, status: 'modified' })
          truncated = true
          continue
        }
        throw error
      }
      if (current) {
        scannedBytes += current.byteLength
        if (scannedBytes > MAX_REVIEW_WORKTREE_SCAN_BYTES) {
          throw new WorkspaceToolError('git_output_too_large')
        }
      }
      const currentOid = current === null
        ? null
        : gitBlobOid(current, context.objectFormat)
      if (currentOid !== indexEntry.oid) {
        worktreeChanges.set(relativePath, { content: current, omitted: false })
        entries.push({
          relativePath,
          status: current === null ? 'deleted' : 'modified'
        })
      }
    }
    entries.push(...context.untrackedEntries)
    return { entries, worktreeChanges, truncated }
  }

  async #buildSafeRepositoryPatches(
    paths: readonly string[],
    context: SafeGitContext,
    snapshot: SafeGitSnapshot,
    signal?: AbortSignal
  ): Promise<{
    worktreePatch: string
    stagedPatch: string
    stats: Map<string, GitDiffStat>
    truncated: boolean
  }> {
    const worktreePatches: string[] = []
    const stagedPatches: string[] = []
    const stats = new Map<string, GitDiffStat>()
    const blobCache = new Map<string, { text: string | null; omitted: boolean }>()
    let truncated = false

    const loadBlob = async (entry: GitIndexEntry | undefined): Promise<{
      text: string | null
      omitted: boolean
    }> => {
      if (!entry) return { text: null, omitted: false }
      const cached = blobCache.get(entry.oid)
      if (cached) return cached
      if (!entry.mode.startsWith('100')) {
        const omitted = { text: null, omitted: true }
        blobCache.set(entry.oid, omitted)
        return omitted
      }
      try {
        const bytes = await runBoundedProcess({
          ...context.common,
          args: [...context.repositoryArguments, 'cat-file', 'blob', entry.oid]
        })
        const decoded = decodeReviewText(bytes)
        const value = decoded === null
          ? { text: null, omitted: true }
          : { text: redactCredentialContent(decoded), omitted: false }
        blobCache.set(entry.oid, value)
        return value
      } catch (error) {
        if (error instanceof WorkspaceToolError && error.code === 'git_output_too_large') {
          const omitted = { text: null, omitted: true }
          blobCache.set(entry.oid, omitted)
          return omitted
        }
        throw error
      }
    }

    for (const relativePath of paths) {
      throwIfAborted(signal)
      const headEntry = context.headEntries.get(relativePath)
      const indexEntry = context.indexEntries.get(relativePath)
      if (
        (!headEntry && indexEntry) ||
        (headEntry && !indexEntry) ||
        (headEntry && indexEntry && (headEntry.oid !== indexEntry.oid || headEntry.mode !== indexEntry.mode))
      ) {
        const [head, index] = await Promise.all([loadBlob(headEntry), loadBlob(indexEntry)])
        if (head.omitted || index.omitted) {
          stagedPatches.push(formatOmittedReviewPatch(relativePath, 'staged content is not bounded UTF-8 text'))
          truncated = true
        } else {
          const patch = buildBoundedUnifiedDiff(relativePath, head.text, index.text)
          if (patch) stagedPatches.push(patch)
          addGitDiffStat(stats, relativePath, diffStatForTexts(head.text, index.text))
        }
      }

      const worktree = snapshot.worktreeChanges.get(relativePath)
      if (worktree) {
        const index = await loadBlob(indexEntry)
        const currentText = worktree.content === null ? null : decodeReviewText(worktree.content)
        if (worktree.omitted || index.omitted || (worktree.content !== null && currentText === null)) {
          worktreePatches.push(formatOmittedReviewPatch(relativePath, 'worktree content is not bounded UTF-8 text'))
          truncated = true
        } else {
          const safeCurrent = currentText === null ? null : redactCredentialContent(currentText)
          const patch = buildBoundedUnifiedDiff(relativePath, index.text, safeCurrent)
          if (patch) worktreePatches.push(patch)
          addGitDiffStat(stats, relativePath, diffStatForTexts(index.text, safeCurrent))
        }
      }

      if (
        worktreePatches.join('\n\n').length + stagedPatches.join('\n\n').length >
        MAX_REVIEW_PATCH_CHARACTERS
      ) {
        truncated = true
        break
      }
    }

    const worktreeBounded = truncateText(worktreePatches.join('\n\n'), MAX_REVIEW_PATCH_CHARACTERS)
    const stagedBounded = truncateText(stagedPatches.join('\n\n'), MAX_REVIEW_PATCH_CHARACTERS)
    return {
      worktreePatch: sanitizeGeneratedPatch(worktreeBounded.text),
      stagedPatch: sanitizeGeneratedPatch(stagedBounded.text),
      stats,
      truncated: truncated || worktreeBounded.truncated || stagedBounded.truncated
    }
  }

  async #resolveWorkspace(
    workspaceToken: string,
    ownerWebContentsId: number
  ): Promise<ResolvedWorkspaceRecord> {
    if (!WORKSPACE_TOKEN_PATTERN.test(workspaceToken)) {
      throw new WorkspaceToolError('workspace_unavailable')
    }
    const workspace = await this.#selections.resolveWorkspace(workspaceToken, ownerWebContentsId)
    if (!workspace) throw new WorkspaceToolError('workspace_unavailable')
    return workspace
  }

  #isProtectedAbsolutePath(candidate: string): boolean {
    return this.#protectedAbsoluteRoots.some((root) => isPathInsideWorkspace(root, candidate))
  }

  async #acquireWriteLock(key: string, signal?: AbortSignal): Promise<() => void> {
    let state = this.#writeLocks.get(key)
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 }
      this.#writeLocks.set(key, state)
    }
    const previous = state.tail
    let releaseGate!: () => void
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate
    })
    state.tail = previous.then(() => gate, () => gate)
    state.pending += 1

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      releaseGate()
      state!.pending -= 1
      if (state!.pending === 0 && this.#writeLocks.get(key) === state) {
        this.#writeLocks.delete(key)
      }
    }
    try {
      await waitForWriteLock(previous, signal)
      return release
    } catch (error) {
      release()
      throw error
    }
  }
}

async function waitForWriteLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (!signal) {
    await previous.catch(() => undefined)
    return
  }

  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false
    let onAbort = (): void => undefined
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    onAbort = (): void => {
      settle(() => rejectWait(new WorkspaceToolError('cancelled')))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    previous.then(
      () => settle(resolveWait),
      () => settle(resolveWait)
    )
    if (signal.aborted) onAbort()
  })
}

async function verifyWorkspaceRoot(
  workspace: ResolvedWorkspaceRecord,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  try {
    const rootStats = await fs.lstat(workspace.absolutePath, { bigint: true })
    const canonical = resolve(await fs.realpath(workspace.absolutePath))
    throwIfAborted(signal)
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      pathComparisonKey(canonical) !== pathComparisonKey(workspace.absolutePath) ||
      !sameStoredIdentity(workspace, rootStats)
    ) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('workspace_unavailable', true)
  }
}

async function resolveLocalTarget(
  selectedWorkspace: ResolvedWorkspaceRecord,
  requestedPath: string,
  accessScope: LocalAccessScope,
  kind: LocalTargetKind,
  signal?: AbortSignal
): Promise<ResolvedLocalTarget> {
  if (accessScope === 'workspace') {
    return Object.freeze({
      operationRoot: selectedWorkspace,
      relativePath: kind === 'file' || kind === 'delete'
        ? normalizeWorkspaceRelativePath(requestedPath)
        : normalizeWorkspaceDirectoryPath(requestedPath)
    })
  }

  if (kind === 'delete') {
    const absoluteTarget = normalizeSystemTargetPath(selectedWorkspace.absolutePath, requestedPath)
    const parentPath = dirname(absoluteTarget)
    if (pathComparisonKey(parentPath) === pathComparisonKey(absoluteTarget)) {
      throw new WorkspaceToolError('write_not_allowed')
    }
    return Object.freeze({
      operationRoot: await createSystemOperationRoot(selectedWorkspace, parentPath, signal),
      relativePath: normalizeWorkspaceRelativePath(basename(absoluteTarget))
    })
  }

  let absoluteTarget = normalizeSystemTargetPath(selectedWorkspace.absolutePath, requestedPath)
  let targetStats: Awaited<ReturnType<typeof fs.stat>> | null = null
  try {
    targetStats = await fs.stat(absoluteTarget)
    absoluteTarget = resolve(await fs.realpath(absoluteTarget))
    throwIfAborted(signal)
  } catch (error) {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (!isNodeErrorCode(error, 'ENOENT') && !isNodeErrorCode(error, 'ENOTDIR')) {
      throw new WorkspaceToolError('workspace_unavailable', true)
    }
    if (kind !== 'file') throw new WorkspaceToolError('path_not_found')
  }

  if (targetStats?.isDirectory()) {
    if (kind === 'file') throw new WorkspaceToolError('path_not_file')
    return Object.freeze({
      operationRoot: await createSystemOperationRoot(selectedWorkspace, absoluteTarget, signal),
      relativePath: '.'
    })
  }
  if (kind === 'directory') throw new WorkspaceToolError('path_not_directory')
  if (targetStats && !targetStats.isFile()) throw new WorkspaceToolError('path_not_file')

  const parentPath = dirname(absoluteTarget)
  if (pathComparisonKey(parentPath) === pathComparisonKey(absoluteTarget)) {
    throw new WorkspaceToolError('path_not_file')
  }
  return Object.freeze({
    operationRoot: await createSystemOperationRoot(selectedWorkspace, parentPath, signal),
    relativePath: normalizeWorkspaceRelativePath(basename(absoluteTarget))
  })
}

async function createSystemOperationRoot(
  selectedWorkspace: ResolvedWorkspaceRecord,
  absoluteRoot: string,
  signal?: AbortSignal
): Promise<ResolvedWorkspaceRecord> {
  throwIfAborted(signal)
  try {
    const canonical = resolve(await fs.realpath(absoluteRoot))
    const stats = await fs.stat(canonical, { bigint: true })
    if (!stats.isDirectory()) throw new WorkspaceToolError('path_not_directory')
    throwIfAborted(signal)
    return Object.freeze({
      ...selectedWorkspace,
      absolutePath: canonical,
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10)
    })
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
      throw new WorkspaceToolError('path_not_found')
    }
    throw new WorkspaceToolError('workspace_unavailable', true)
  }
}

function normalizeSystemTargetPath(workspaceRoot: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 32_768 ||
    value !== value.trim() ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new WorkspaceToolError('invalid_relative_path')
  }
  const expanded = value === '~'
    ? homedir()
    : /^[~][\\/]/u.test(value)
      ? resolve(homedir(), value.slice(2))
      : value
  return resolve(workspaceRoot, expanded)
}

function normalizeWorkspaceToolAccessScope(value: unknown): LocalAccessScope {
  if (value === undefined || value === 'workspace') return 'workspace'
  if (value === 'system') return 'system'
  throw new WorkspaceToolError('invalid_request')
}

function localWriteLockKey(
  workspaceToken: string,
  operationRoot: ResolvedWorkspaceRecord,
  relativePath: string
): string {
  return `${workspaceToken}\0${pathComparisonKey(resolve(operationRoot.absolutePath, relativePath))}`
}

async function resolveExistingWorkspacePath(
  workspace: ResolvedWorkspaceRecord,
  relativePath: string,
  signal?: AbortSignal
): Promise<ResolvedWorkspacePath> {
  const segments = relativePath.split('/')
  let currentPath = workspace.absolutePath
  let finalStats: Awaited<ReturnType<typeof fs.lstat>> | null = null

  for (let index = 0; index < segments.length; index += 1) {
    throwIfAborted(signal)
    currentPath = join(currentPath, segments[index]!)
    if (!isPathInsideWorkspace(workspace.absolutePath, currentPath)) {
      throw new WorkspaceToolError('path_outside_workspace')
    }

    let stats: Awaited<ReturnType<typeof fs.lstat>>
    let canonical: string
    try {
      stats = await fs.lstat(currentPath)
      if (stats.isSymbolicLink()) throw new WorkspaceToolError('reparse_point_rejected')
      canonical = resolve(await fs.realpath(currentPath))
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (signal?.aborted) throw new WorkspaceToolError('cancelled')
      if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
        throw new WorkspaceToolError('path_not_found')
      }
      throw new WorkspaceToolError('workspace_unavailable', true)
    }

    if (!isPathInsideWorkspace(workspace.absolutePath, canonical)) {
      throw new WorkspaceToolError('path_outside_workspace')
    }
    if (pathComparisonKey(canonical) !== pathComparisonKey(resolve(currentPath))) {
      throw new WorkspaceToolError('reparse_point_rejected')
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new WorkspaceToolError('path_not_found')
    }
    currentPath = canonical
    finalStats = stats
  }

  if (!finalStats) throw new WorkspaceToolError('path_not_found')
  return { absolutePath: currentPath, stats: finalStats }
}

async function assertWorkspaceDeleteTreeAllowed(
  workspace: ResolvedWorkspaceRecord,
  absolutePath: string,
  relativePath: string,
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (
    isSensitiveRelativePath(relativePath) ||
    isProtectedWriteRelativePath(relativePath) ||
    protectedRoots.some((root) => isPathInsideWorkspace(root, absolutePath))
  ) {
    throw new WorkspaceToolError('write_not_allowed')
  }

  let stats: Awaited<ReturnType<typeof fs.lstat>>
  let canonical: string
  try {
    stats = await fs.lstat(absolutePath)
    if (stats.isSymbolicLink()) throw new WorkspaceToolError('reparse_point_rejected')
    canonical = resolve(await fs.realpath(absolutePath))
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
      throw new WorkspaceToolError('path_not_found')
    }
    throw new WorkspaceToolError('workspace_changed', true)
  }
  if (
    !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
    pathComparisonKey(canonical) !== pathComparisonKey(absolutePath)
  ) {
    throw new WorkspaceToolError('reparse_point_rejected')
  }
  if (stats.isFile()) {
    assertSingleLinkRegularFile(stats)
    return
  }
  if (!stats.isDirectory()) throw new WorkspaceToolError('path_not_file')

  const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch((error: unknown) => {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    throw new WorkspaceToolError('write_failed', true)
  })
  for (const entry of entries) {
    throwIfAborted(signal)
    const childRelativePath = normalizeWorkspaceRelativePath(`${relativePath}/${entry.name}`)
    await assertWorkspaceDeleteTreeAllowed(
      workspace,
      join(absolutePath, entry.name),
      childRelativePath,
      protectedRoots,
      signal
    )
  }
}

async function inspectWriteTarget(
  targetPath: string,
  workspace: ResolvedWorkspaceRecord,
  signal?: AbortSignal,
  accessScope: LocalAccessScope = 'workspace'
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  throwIfAborted(signal)
  let stats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT')) return null
    throw new WorkspaceToolError('write_failed', true)
  }
  throwIfAborted(signal)
  if (accessScope === 'workspace' && stats.isSymbolicLink()) {
    throw new WorkspaceToolError('reparse_point_rejected')
  }
  if (!stats.isFile()) throw new WorkspaceToolError('path_not_file')
  if (accessScope === 'workspace') assertSingleLinkRegularFile(stats)
  let canonical: string
  try {
    canonical = resolve(await fs.realpath(targetPath))
  } catch {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('write_failed', true)
  }
  throwIfAborted(signal)
  if (accessScope === 'workspace' && (
    !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
    pathComparisonKey(canonical) !== pathComparisonKey(targetPath)
  )) {
    throw new WorkspaceToolError('reparse_point_rejected')
  }
  return stats
}

async function revisionForExistingFile(
  targetPath: string,
  expectedStats: Awaited<ReturnType<typeof fs.lstat>>,
  maxBytes: number,
  signal?: AbortSignal,
  accessScope: LocalAccessScope = 'workspace'
): Promise<string> {
  throwIfAborted(signal)
  if (expectedStats.size > maxBytes) throw new WorkspaceToolError('file_too_large')
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(targetPath, 'r')
    throwIfAborted(signal)
    const openedStats = await handle.stat()
    throwIfAborted(signal)
    if (!openedStats.isFile() || !sameFileIdentity(expectedStats, openedStats)) {
      throw new WorkspaceToolError('write_conflict')
    }
    if (accessScope === 'workspace') assertSingleLinkRegularFile(openedStats)
    const bytes = await readBoundedFile(handle, maxBytes, signal)
    return createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('write_conflict')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function revalidateWriteTarget(
  targetPath: string,
  workspace: ResolvedWorkspaceRecord,
  previousStats: Awaited<ReturnType<typeof fs.lstat>> | null,
  expectedRevision: string | undefined,
  maxBytes: number,
  signal?: AbortSignal,
  accessScope: LocalAccessScope = 'workspace'
): Promise<void> {
  throwIfAborted(signal)
  const currentStats = await inspectWriteTarget(targetPath, workspace, signal, accessScope)
  if (!previousStats) {
    if (currentStats) throw new WorkspaceToolError('write_conflict')
    return
  }
  if (!currentStats || !sameFileIdentity(previousStats, currentStats)) {
    throw new WorkspaceToolError('write_conflict')
  }
  if (!expectedRevision) throw new WorkspaceToolError('write_conflict')
  const currentRevision = await revisionForExistingFile(
    targetPath,
    currentStats,
    maxBytes,
    signal,
    accessScope
  )
  if (currentRevision !== expectedRevision) throw new WorkspaceToolError('write_conflict')
  throwIfAborted(signal)
}

async function createTemporaryWriteFile(
  parentPath: string
): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(parentPath, `.ai-terminal-write-${randomBytes(18).toString('base64url')}.tmp`)
    try {
      const handle = await fs.open(path, 'wx', 0o600)
      return { path, handle }
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) continue
      throw new WorkspaceToolError('write_failed', true)
    }
  }
  throw new WorkspaceToolError('write_failed', true)
}

async function verifyGitMetadataLocation(
  workspace: ResolvedWorkspaceRecord,
  authorizeManagedGitWorktree: WorkspaceToolServiceOptions['authorizeManagedGitWorktree'],
  signal?: AbortSignal
): Promise<GitMetadataLocation> {
  throwIfAborted(signal)
  const dotGitPath = join(workspace.absolutePath, '.git')
  let stats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stats = await fs.lstat(dotGitPath)
  } catch (error) {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT')) throw new WorkspaceToolError('git_unavailable')
    throw new WorkspaceToolError('git_unavailable', true)
  }
  if (stats.isSymbolicLink()) throw new WorkspaceToolError('reparse_point_rejected')

  if (stats.isDirectory()) {
    const canonical = resolve(await fs.realpath(dotGitPath).catch(() => ''))
    if (
      !canonical ||
      !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
      pathComparisonKey(canonical) !== pathComparisonKey(resolve(dotGitPath))
    ) {
      throw new WorkspaceToolError('path_outside_workspace')
    }
    return { gitDirectory: canonical, commonDirectory: canonical, linked: false }
  }
  if (!stats.isFile() || stats.size > GIT_METADATA_FILE_LIMIT) {
    throw new WorkspaceToolError('git_unavailable')
  }

  let metadata: string
  try {
    const bytes = await fs.readFile(dotGitPath)
    metadata = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceToolError('git_unavailable')
  }
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(metadata)
  if (!match?.[1] || /[\r\n\0]/u.test(match[1])) throw new WorkspaceToolError('git_unavailable')
  const gitDirectory = resolve(workspace.absolutePath, match[1])
  try {
    const gitDirectoryStats = await fs.lstat(gitDirectory)
    const canonical = resolve(await fs.realpath(gitDirectory))
    if (
      !gitDirectoryStats.isDirectory() ||
      gitDirectoryStats.isSymbolicLink() ||
      pathComparisonKey(canonical) !== pathComparisonKey(gitDirectory)
    ) {
      throw new WorkspaceToolError('reparse_point_rejected')
    }
    if (isPathInsideWorkspace(workspace.absolutePath, canonical)) {
      return { gitDirectory: canonical, commonDirectory: canonical, linked: false }
    }
    if (!authorizeManagedGitWorktree) throw new WorkspaceToolError('path_outside_workspace')
    const authorization = await authorizeManagedGitWorktree(workspace.absolutePath, canonical)
    if (!authorization || !isAbsolute(authorization.commonDirectory)) {
      throw new WorkspaceToolError('path_outside_workspace')
    }
    const commonDirectory = resolve(await fs.realpath(authorization.commonDirectory))
    const commonStats = await fs.lstat(commonDirectory)
    const linkedMetadataRoot = join(commonDirectory, 'worktrees')
    if (
      !commonStats.isDirectory() ||
      commonStats.isSymbolicLink() ||
      !isPathInsideWorkspace(linkedMetadataRoot, canonical) ||
      pathComparisonKey(linkedMetadataRoot) === pathComparisonKey(canonical)
    ) throw new WorkspaceToolError('path_outside_workspace')

    const commonLink = await readSmallGitLink(join(canonical, 'commondir'))
    const dotGitLink = await readSmallGitLink(join(canonical, 'gitdir'))
    if (
      pathComparisonKey(resolve(canonical, commonLink)) !== pathComparisonKey(commonDirectory) ||
      pathComparisonKey(resolve(canonical, dotGitLink)) !== pathComparisonKey(dotGitPath)
    ) throw new WorkspaceToolError('git_unavailable')
    return { gitDirectory: canonical, commonDirectory, linked: true }
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    throw new WorkspaceToolError('git_unavailable')
  }
}

async function readSmallGitLink(path: string): Promise<string> {
  try {
    const stats = await fs.lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > GIT_METADATA_FILE_LIMIT) {
      throw new WorkspaceToolError('git_unavailable')
    }
    const value = new TextDecoder('utf-8', { fatal: true })
      .decode(await fs.readFile(path))
      .trim()
    if (!value || /[\r\n\0]/u.test(value)) throw new WorkspaceToolError('git_unavailable')
    return value
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    throw new WorkspaceToolError('git_unavailable')
  }
}

function safeGitRepositoryArguments(gitDirectory: string, workspacePath: string): string[] {
  return [
    '--no-pager',
    `--git-dir=${gitDirectory}`,
    `--work-tree=${workspacePath}`,
    '-c',
    `core.worktree=${workspacePath}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${nullDevicePath()}`,
    '-c',
    `core.attributesFile=${nullDevicePath()}`,
    '-c',
    `core.excludesFile=${nullDevicePath()}`,
    '-c',
    'core.sparseCheckout=false',
    '-c',
    'core.sparseCheckoutCone=false',
    '-c',
    'status.renames=false',
    '-c',
    'diff.renames=false'
  ]
}

async function verifySafeGitConfiguration(
  common: Omit<BoundedProcessOptions, 'args'>,
  repositoryArguments: readonly string[],
  metadata: GitMetadataLocation,
  signal?: AbortSignal
): Promise<void> {
  const configPath = join(metadata.commonDirectory, 'config')
  const config = await readStableInternalFileIfExists(
    metadata.commonDirectory,
    configPath,
    MAX_REVIEW_ATTRIBUTE_BYTES,
    signal
  )
  if (!config) throw new WorkspaceToolError('git_unavailable')

  const unsafeCommonPaths = [
    'config.worktree',
    'objects/info/alternates',
    'objects/info/http-alternates'
  ]
  if (!metadata.linked) unsafeCommonPaths.unshift('commondir')
  for (const relativeMetadataPath of unsafeCommonPaths) {
    const unsafeMetadata = await readStableInternalFileIfExists(
      metadata.commonDirectory,
      join(metadata.commonDirectory, ...relativeMetadataPath.split('/')),
      MAX_REVIEW_ATTRIBUTE_BYTES,
      signal
    )
    if (unsafeMetadata) throw new WorkspaceToolError('git_unavailable')
  }
  if (metadata.linked) {
    const worktreeConfig = await readStableInternalFileIfExists(
      metadata.gitDirectory,
      join(metadata.gitDirectory, 'config.worktree'),
      MAX_REVIEW_ATTRIBUTE_BYTES,
      signal
    )
    if (worktreeConfig) throw new WorkspaceToolError('git_unavailable')
  }

  const localConfig = await runBoundedProcess({
    ...common,
    args: [
      ...repositoryArguments,
      'config',
      '--local',
      '--null',
      '--list',
      '--no-includes'
    ]
  })
  for (const record of decodeGitOutput(localConfig).split('\0')) {
    if (!record) continue
    const separator = record.indexOf('\n')
    const key = (separator < 0 ? record : record.slice(0, separator)).trim().toLowerCase()
    if (!key || isDangerousLocalGitConfigKey(key)) {
      throw new WorkspaceToolError('git_unavailable')
    }
  }

  const infoAttributes = await readStableInternalFileIfExists(
    metadata.commonDirectory,
    join(metadata.commonDirectory, 'info', 'attributes'),
    MAX_REVIEW_ATTRIBUTE_BYTES,
    signal
  )
  if (infoAttributes && containsGitFilterAttribute(infoAttributes)) {
    throw new WorkspaceToolError('git_unavailable')
  }
}

function isDangerousLocalGitConfigKey(key: string): boolean {
  return key === 'core.worktree' ||
    key === 'extensions.worktreeconfig' ||
    key === 'extensions.partialclone' ||
    key.startsWith('include.') ||
    key.startsWith('includeif.') ||
    key.startsWith('filter.') ||
    key.startsWith('feature.') ||
    /(?:command|textconv|external|helper|program|hook|hookspath|fsmonitor)$/u.test(key) ||
    /^(?:remote\..*\.(?:promisor|partialclonefilter)|core\.(?:attributesfile|excludesfile|alternateRefsCommand))$/iu.test(key)
}

async function readStableInternalFileIfExists(
  root: string,
  absolutePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer | null> {
  throwIfAborted(signal)
  if (!isPathInsideWorkspace(root, absolutePath)) {
    throw new WorkspaceToolError('path_outside_workspace')
  }
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new WorkspaceToolError('path_outside_workspace')
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean)
  let current = root
  let finalStats: Awaited<ReturnType<typeof fs.lstat>> | null = null
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const stats = await fs.lstat(current)
      const canonical = resolve(await fs.realpath(current))
      if (
        stats.isSymbolicLink() ||
        !isPathInsideWorkspace(root, canonical) ||
        pathComparisonKey(canonical) !== pathComparisonKey(current)
      ) {
        throw new WorkspaceToolError('reparse_point_rejected')
      }
      finalStats = stats
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (signal?.aborted) throw new WorkspaceToolError('cancelled')
      if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) return null
      throw new WorkspaceToolError('git_unavailable', true)
    }
  }
  if (!finalStats?.isFile()) throw new WorkspaceToolError('git_unavailable')
  assertSingleLinkRegularFile(finalStats)
  if (finalStats.size > maxBytes) throw new WorkspaceToolError('git_output_too_large')

  let handle: FileHandle | null = null
  try {
    handle = await fs.open(absolutePath, 'r')
    const openedStats = await handle.stat()
    if (!openedStats.isFile() || !sameFileIdentity(finalStats, openedStats)) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    assertSingleLinkRegularFile(openedStats)
    const bytes = await readBoundedFile(handle, maxBytes, signal)
    const finalCanonical = resolve(await fs.realpath(absolutePath))
    if (pathComparisonKey(finalCanonical) !== pathComparisonKey(absolutePath)) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    return bytes
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('git_unavailable', true)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseGitIndexEntries(output: Buffer, maxFiles: number): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>()
  let records = 0
  for (const record of decodeGitOutput(output).split('\0')) {
    if (!record) continue
    records += 1
    if (records > maxFiles) throw new WorkspaceToolError('git_invalid_output')
    const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/iu.exec(record)
    if (!match) throw new WorkspaceToolError('git_invalid_output')
    const relativePath = normalizeGitRelativePath(match[4])
    const stage = Number(match[3])
    if (stage !== 0) continue
    if (entries.has(relativePath)) throw new WorkspaceToolError('git_invalid_output')
    entries.set(relativePath, Object.freeze({
      mode: match[1]!,
      oid: match[2]!.toLowerCase()
    }))
  }
  return entries
}

function parseGitTreeEntries(output: Buffer, maxFiles: number): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>()
  let records = 0
  for (const record of decodeGitOutput(output).split('\0')) {
    if (!record) continue
    records += 1
    if (records > maxFiles) throw new WorkspaceToolError('git_invalid_output')
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/iu.exec(record)
    if (!match) throw new WorkspaceToolError('git_invalid_output')
    const relativePath = normalizeGitRelativePath(match[4])
    if (entries.has(relativePath)) throw new WorkspaceToolError('git_invalid_output')
    entries.set(relativePath, Object.freeze({
      mode: match[1]!,
      oid: match[3]!.toLowerCase()
    }))
  }
  return entries
}

function inferGitObjectFormat(
  indexEntries: ReadonlyMap<string, GitIndexEntry>,
  headEntries: ReadonlyMap<string, GitIndexEntry>
): 'sha1' | 'sha256' {
  let format: 'sha1' | 'sha256' | null = null
  for (const entry of [...indexEntries.values(), ...headEntries.values()]) {
    const candidate = entry.oid.length === 40 ? 'sha1' : entry.oid.length === 64 ? 'sha256' : null
    if (!candidate || (format !== null && format !== candidate)) {
      throw new WorkspaceToolError('git_invalid_output')
    }
    format = candidate
  }
  return format ?? 'sha1'
}

function safeGitBranchName(output: Buffer): string {
  const candidate = decodeGitOutput(output).trim()
  if (
    !candidate ||
    candidate.length > MAX_GIT_BRANCH_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new WorkspaceToolError('git_invalid_output')
  }
  return redactCredentialContent(candidate)
}

async function readStableWorkspaceFileIfExists(
  workspace: ResolvedWorkspaceRecord,
  relativePath: string,
  maxBytes: number,
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<Buffer | null> {
  let resolvedPath: ResolvedWorkspacePath
  try {
    resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, signal)
  } catch (error) {
    if (error instanceof WorkspaceToolError && error.code === 'path_not_found') return null
    throw error
  }
  if (protectedRoots.some((root) => isPathInsideWorkspace(root, resolvedPath.absolutePath))) {
    throw new WorkspaceToolError('sensitive_path')
  }
  if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
  assertSingleLinkRegularFile(resolvedPath.stats)
  if (resolvedPath.stats.size > maxBytes) throw new WorkspaceToolError('file_too_large')

  let handle: FileHandle | null = null
  try {
    handle = await fs.open(resolvedPath.absolutePath, 'r')
    const openedStats = await handle.stat()
    if (!openedStats.isFile() || !sameFileIdentity(resolvedPath.stats, openedStats)) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    assertSingleLinkRegularFile(openedStats)
    const bytes = await readBoundedFile(handle, maxBytes, signal)
    const finalCanonical = resolve(await fs.realpath(resolvedPath.absolutePath))
    if (
      !isPathInsideWorkspace(workspace.absolutePath, finalCanonical) ||
      pathComparisonKey(finalCanonical) !== pathComparisonKey(resolvedPath.absolutePath)
    ) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    return bytes
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('workspace_changed', true)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function gitBlobOid(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format)
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex')
}

function decodeReviewText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function verifyReviewWorktreePreflight(
  workspace: ResolvedWorkspaceRecord,
  trackedPaths: readonly string[],
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  const attributePaths = new Set<string>([join(workspace.absolutePath, '.gitattributes')])
  for (const relativePath of trackedPaths) {
    throwIfAborted(signal)
    try {
      const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, signal)
      if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
      assertSingleLinkRegularFile(resolvedPath.stats)
      if (protectedRoots.some((root) => isPathInsideWorkspace(root, resolvedPath.absolutePath))) {
        throw new WorkspaceToolError('sensitive_path')
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError && error.code === 'path_not_found') {
        // Deleted tracked paths are valid review inputs.
      } else {
        throw error
      }
    }
    const segments = relativePath.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      attributePaths.add(join(workspace.absolutePath, ...segments.slice(0, index), '.gitattributes'))
    }
  }

  for (const attributePath of attributePaths) {
    const attributes = await readStableInternalFileIfExists(
      workspace.absolutePath,
      attributePath,
      MAX_REVIEW_ATTRIBUTE_BYTES,
      signal
    )
    if (attributes && containsGitFilterAttribute(attributes)) {
      throw new WorkspaceToolError('git_unavailable')
    }
  }
}

function containsGitFilterAttribute(bytes: Buffer): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceToolError('git_unavailable')
  }
  return /(?:^|[\t ])(?:-?!?filter|filter=[^\t ]*)(?=$|[\t ])/imu.test(text)
}

async function enumerateSafeUntrackedFiles(
  workspace: ResolvedWorkspaceRecord,
  trackedPaths: ReadonlySet<string>,
  maxFiles: number,
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<{ entries: GitStatusEntry[]; truncated: boolean }> {
  const entries: GitStatusEntry[] = []
  const queue: Array<{ absolutePath: string; relativePath: string }> = [{
    absolutePath: workspace.absolutePath,
    relativePath: '.'
  }]
  let scanned = 0
  let truncated = false
  while (queue.length > 0) {
    const directory = queue.shift()!
    let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null
    try {
      handle = await fs.opendir(directory.absolutePath)
      while (true) {
        throwIfAborted(signal)
        const dirent = await handle.read()
        if (!dirent) break
        scanned += 1
        if (scanned > MAX_REVIEW_UNTRACKED_SCAN_ENTRIES) {
          truncated = true
          queue.length = 0
          break
        }
        let relativePath: string
        try {
          relativePath = normalizeWorkspaceRelativePath(
            directory.relativePath === '.'
              ? dirent.name
              : `${directory.relativePath}/${dirent.name}`
          )
        } catch {
          continue
        }
        if (isReviewSensitiveRelativePath(relativePath)) continue
        const absolutePath = join(directory.absolutePath, dirent.name)
        if (protectedRoots.some((root) => isPathInsideWorkspace(root, absolutePath))) continue
        let stats: Awaited<ReturnType<typeof fs.lstat>>
        let canonical: string
        try {
          stats = await fs.lstat(absolutePath)
          if (stats.isSymbolicLink()) continue
          canonical = resolve(await fs.realpath(absolutePath))
        } catch {
          if (signal?.aborted) throw new WorkspaceToolError('cancelled')
          continue
        }
        if (
          !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
          pathComparisonKey(canonical) !== pathComparisonKey(absolutePath)
        ) {
          continue
        }
        if (stats.isDirectory()) {
          queue.push({ absolutePath: canonical, relativePath })
        } else if (stats.isFile() && !trackedPaths.has(relativePath)) {
          if (entries.length < maxFiles) {
            entries.push({ relativePath, status: 'untracked' })
          } else {
            truncated = true
          }
        }
      }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  return { entries, truncated }
}

async function readBoundedFile(
  handle: FileHandle,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    throwIfAborted(signal)
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  throwIfAborted(signal)
  if (offset > maxBytes) throw new WorkspaceToolError('file_too_large')
  return buffer.subarray(0, offset)
}

async function runBoundedProcess(options: BoundedProcessOptions): Promise<Buffer> {
  const result = await runBoundedProcessCore(options, {
    unavailable: 'git_unavailable',
    timeout: 'git_timeout',
    outputTooLarge: 'git_output_too_large'
  })
  if (result.exitCode !== 0) throw new WorkspaceToolError('git_failed', true)
  return result.stdout
}

async function runBoundedCommandProcess(
  options: BoundedProcessOptions
): Promise<BoundedProcessResult> {
  return await runBoundedProcessCore(options, {
    unavailable: 'command_unavailable',
    timeout: 'command_timeout',
    outputTooLarge: 'command_output_too_large'
  })
}

async function runBoundedProcessCore(
  options: BoundedProcessOptions,
  errors: {
    unavailable: WorkspaceToolErrorCode
    timeout: WorkspaceToolErrorCode
    outputTooLarge: WorkspaceToolErrorCode
  }
): Promise<BoundedProcessResult> {
  throwIfAborted(options.signal)
  return new Promise<BoundedProcessResult>((resolvePromise, rejectPromise) => {
    let settled = false
    let terminalError: WorkspaceToolError | null = null
    let treeTermination: Promise<void> | null = null
    let totalOutputBytes = 0
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let child: ReturnType<typeof spawn> | undefined

    const finish = (error: WorkspaceToolError | null, result?: BoundedProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) rejectPromise(error)
      else resolvePromise(result ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 })
    }
    const terminate = (error: WorkspaceToolError): void => {
      if (!terminalError) terminalError = error
      if (!child) {
        finish(terminalError)
        return
      }
      if (treeTermination) return
      child.stdout?.destroy()
      child.stderr?.destroy()
      treeTermination = terminateChildProcessTree(child, options.env)
      void treeTermination.finally(() => finish(terminalError ?? error))
    }
    const onAbort = (): void => terminate(new WorkspaceToolError('cancelled'))
    const timer = setTimeout(
      () => terminate(new WorkspaceToolError(errors.timeout, true)),
      options.timeoutMs
    )
    timer.unref?.()

    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      finish(new WorkspaceToolError(errors.unavailable, true))
      return
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      terminate(new WorkspaceToolError(errors.unavailable, true))
      void (treeTermination ?? Promise.resolve()).finally(() => {
        finish(new WorkspaceToolError(errors.unavailable, true))
      })
      return
    }
    stdout.on('data', (chunk: Buffer) => {
      const value = Buffer.from(chunk)
      totalOutputBytes += value.byteLength
      if (totalOutputBytes > options.maxOutputBytes) {
        terminate(new WorkspaceToolError(errors.outputTooLarge))
        return
      }
      stdoutChunks.push(value)
    })
    stderr.on('data', (chunk: Buffer) => {
      const value = Buffer.from(chunk)
      totalOutputBytes += value.byteLength
      if (totalOutputBytes > options.maxOutputBytes) {
        terminate(new WorkspaceToolError(errors.outputTooLarge))
        return
      }
      stderrChunks.push(value)
    })
    child.once('error', () => terminate(new WorkspaceToolError(errors.unavailable, true)))
    child.once('close', (code) => {
      if (terminalError) {
        void (treeTermination ?? Promise.resolve()).finally(() => finish(terminalError))
        return
      }
      if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0) {
        finish(new WorkspaceToolError(errors.unavailable, true))
        return
      }
      if (totalOutputBytes > options.maxOutputBytes) {
        finish(new WorkspaceToolError(errors.outputTooLarge))
        return
      }
      finish(null, {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: code
      })
    })
  })
}

function terminateChildProcessTree(
  child: ReturnType<typeof spawn>,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve()
  }
  if (process.platform === 'win32') {
    const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR
    if (
      typeof systemRoot === 'string' &&
      isAbsolute(systemRoot) &&
      !/[\r\n\0]/u.test(systemRoot)
    ) {
      try {
        const killer = spawn(
          join(systemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' }
        )
        return new Promise<void>((resolveTermination) => {
          let settled = false
          const finishTermination = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            try {
              child.kill('SIGKILL')
            } catch {
              // taskkill is the primary tree-wide termination mechanism.
            }
            resolveTermination()
          }
          const timeout = setTimeout(() => {
            try {
              killer.kill('SIGKILL')
            } catch {
              // The bounded wait is authoritative.
            }
            finishTermination()
          }, 2_000)
          timeout.unref?.()
          killer.once('error', finishTermination)
          killer.once('close', finishTermination)
        })
      } catch {
        // The direct kill below remains as the fixed fallback.
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Fall through to the direct child handle.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The caller's fixed terminal error remains authoritative.
  }
  return Promise.resolve()
}

function selectReviewDiffPaths(entries: readonly GitStatusEntry[]): {
  readonly paths: readonly string[]
  readonly files: readonly string[]
  readonly untrackedFiles: readonly string[]
  readonly truncated: boolean
} {
  const tracked = new Set<string>()
  const untracked = new Set<string>()
  for (const entry of entries) {
    if (
      isReviewSensitiveRelativePath(entry.relativePath) ||
      (entry.originalRelativePath !== undefined &&
        isReviewSensitiveRelativePath(entry.originalRelativePath))
    ) {
      continue
    }
    if (entry.status === 'untracked') untracked.add(entry.relativePath)
    else tracked.add(entry.relativePath)
  }

  const paths: string[] = []
  let pathCharacters = 0
  let truncated = false
  for (const relativePath of [...tracked].sort((left, right) => left.localeCompare(right))) {
    const nextCharacters = pathCharacters + relativePath.length + 1
    if (
      paths.length >= MAX_REVIEW_DIFF_FILES ||
      nextCharacters > MAX_REVIEW_PATH_ARGUMENT_CHARACTERS
    ) {
      truncated = true
      continue
    }
    paths.push(relativePath)
    pathCharacters = nextCharacters
  }

  const untrackedFiles = [...untracked]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_REVIEW_DIFF_FILES)
    .map((relativePath) => safeWorkspaceResultPath(relativePath))
  if (untracked.size > untrackedFiles.length) truncated = true
  return Object.freeze({
    paths: Object.freeze(paths),
    files: Object.freeze(paths.map((relativePath) => safeWorkspaceResultPath(relativePath))),
    untrackedFiles: Object.freeze(untrackedFiles),
    truncated
  })
}

function sanitizeGeneratedPatch(value: string): string {
  return redactCredentialContent(
    value
      .replace(/\r\n/gu, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  ).trim()
}

function buildBoundedUnifiedDiff(
  relativePath: string,
  baselineText: string | null,
  currentText: string | null
): string {
  if (baselineText === null && currentText === null) return ''
  const oldLines = baselineText === null ? [] : normalizedPatchLines(baselineText)
  const newLines = currentText === null ? [] : normalizedPatchLines(currentText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1
  }
  if (prefix === oldLines.length && prefix === newLines.length) return ''

  const contextStart = Math.max(0, prefix - 3)
  const oldChangeEnd = oldLines.length - suffix
  const newChangeEnd = newLines.length - suffix
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + 3)
  const newEnd = Math.min(newLines.length, newChangeEnd + 3)
  const lines = [
    `diff --git a/${relativePath} b/${relativePath}`,
    baselineText === null ? '--- /dev/null' : `--- a/${relativePath}`,
    currentText === null ? '+++ /dev/null' : `+++ b/${relativePath}`,
    `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`
  ]
  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${oldLines[index] ?? ''}`)
  }
  for (let index = prefix; index < oldChangeEnd; index += 1) {
    lines.push(`-${oldLines[index] ?? ''}`)
  }
  for (let index = prefix; index < newChangeEnd; index += 1) {
    lines.push(`+${newLines[index] ?? ''}`)
  }
  for (let index = 0; index < Math.min(3, suffix); index += 1) {
    lines.push(` ${oldLines[oldChangeEnd + index] ?? ''}`)
  }
  return lines.join('\n')
}

function diffStatForTexts(
  baselineText: string | null,
  currentText: string | null
): GitDiffStat {
  const oldLines = baselineText === null ? [] : normalizedPatchLines(baselineText)
  const newLines = currentText === null ? [] : normalizedPatchLines(currentText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1
  }
  return {
    additions: Math.min(MAX_DIFF_LINES, newLines.length - prefix - suffix),
    deletions: Math.min(MAX_DIFF_LINES, oldLines.length - prefix - suffix)
  }
}

function addGitDiffStat(
  stats: Map<string, GitDiffStat>,
  relativePath: string,
  addition: GitDiffStat
): void {
  const current = stats.get(relativePath) ?? { additions: 0, deletions: 0 }
  stats.set(relativePath, {
    additions: Math.min(MAX_DIFF_LINES, current.additions + addition.additions),
    deletions: Math.min(MAX_DIFF_LINES, current.deletions + addition.deletions)
  })
}

function normalizedPatchLines(value: string): string[] {
  const normalized = value.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function formatOmittedReviewPatch(relativePath: string, reason: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `Review content omitted: ${reason}.`
  ].join('\n')
}

function buildGitSummary(
  branch: string,
  statusEntries: readonly GitStatusEntry[],
  diffStats: ReadonlyMap<string, GitDiffStat>,
  maxFiles: number
): GitSummary {
  const remainingStats = new Map(diffStats)
  const internal = new Map<string, MutableGitSummary>()

  for (const entry of statusEntries) {
    const current = remainingStats.get(entry.relativePath) ?? { additions: 0, deletions: 0 }
    remainingStats.delete(entry.relativePath)
    let additions = current.additions
    let deletions = current.deletions
    if (entry.originalRelativePath) {
      const original = remainingStats.get(entry.originalRelativePath)
      if (original) {
        additions = safeLineTotal(additions, original.additions)
        deletions = safeLineTotal(deletions, original.deletions)
        remainingStats.delete(entry.originalRelativePath)
      }
    }
    internal.set(entry.relativePath, { additions, deletions, status: entry.status })
  }
  for (const [relativePath, stat] of remainingStats) {
    internal.set(relativePath, { ...stat, status: 'modified' })
  }
  if (internal.size > maxFiles) throw new WorkspaceToolError('git_output_too_large')

  let additions = 0
  let deletions = 0
  const safeFiles = new Map<string, MutableGitSummary>()
  for (const [relativePath, summary] of internal) {
    additions = safeLineTotal(additions, summary.additions)
    deletions = safeLineTotal(deletions, summary.deletions)
    const safeRelativePath = safeWorkspaceResultPath(relativePath)
    const existing = safeFiles.get(safeRelativePath)
    if (!existing) {
      safeFiles.set(safeRelativePath, { ...summary })
      continue
    }
    existing.additions = safeLineTotal(existing.additions, summary.additions)
    existing.deletions = safeLineTotal(existing.deletions, summary.deletions)
    existing.status = mergeGitStatus(existing.status, summary.status)
  }

  const files: GitFileSummary[] = [...safeFiles.entries()]
    .map(([relativePath, summary]) => Object.freeze({ relativePath, ...summary }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  return Object.freeze({ branch, additions, deletions, files })
}

function normalizeWorkspaceRelativePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_RELATIVE_PATH_CHARACTERS ||
    value !== value.trim() ||
    /[\r\n\0]/u.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('//') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    /^\\\\[?.]\\/u.test(value)
  ) {
    throw new WorkspaceToolError('invalid_relative_path')
  }

  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.length === 0) throw new WorkspaceToolError('invalid_relative_path')
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.length > MAX_PATH_SEGMENT_CHARACTERS ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      INVALID_WINDOWS_SEGMENT_CHARACTER.test(segment) ||
      WINDOWS_RESERVED_NAME.test(segment)
    ) {
      throw new WorkspaceToolError('invalid_relative_path')
    }
  }
  return segments.join('/')
}

function normalizeWorkspaceDirectoryPath(value: unknown): string {
  if (value === '.') return '.'
  return normalizeWorkspaceRelativePath(value)
}

function insertBoundedDirectoryEntry(
  entries: WorkspaceDirectoryEntry[],
  entry: WorkspaceDirectoryEntry,
  maximumEntries: number
): void {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (compareDirectoryEntries(entries[middle]!, entry) <= 0) low = middle + 1
    else high = middle
  }
  if (low >= maximumEntries) return
  entries.splice(low, 0, entry)
  if (entries.length > maximumEntries) entries.pop()
}

function compareDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry
): number {
  if (left.relativePath < right.relativePath) return -1
  if (left.relativePath > right.relativePath) return 1
  if (left.kind < right.kind) return -1
  if (left.kind > right.kind) return 1
  return 0
}

function buildBoundedDirectoryResult(
  candidates: readonly WorkspaceDirectoryEntry[],
  eligibleEntryCount: number,
  maximumCharacters: number
): WorkspaceDirectoryResult {
  const entries: WorkspaceDirectoryEntry[] = []
  for (const candidate of candidates) {
    const nextEntries = [...entries, candidate]
    const truncated = eligibleEntryCount > nextEntries.length
    if (JSON.stringify({ entries: nextEntries, truncated }).length > maximumCharacters) break
    entries.push(candidate)
  }
  return Object.freeze({
    entries,
    truncated: eligibleEntryCount > entries.length
  })
}

function normalizeGitRelativePath(value: unknown): string {
  try {
    return normalizeWorkspaceRelativePath(value)
  } catch {
    throw new WorkspaceToolError('git_invalid_output')
  }
}

function isSensitiveRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  const fileName = segments.at(-1) ?? ''
  if (fileName.startsWith(CONVERSATION_HISTORY_TEMPORARY_PREFIX)) return true
  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true
  if (fileName.startsWith('.env')) return true
  if (SENSITIVE_EXACT_FILE_NAMES.has(fileName)) return true
  if (SENSITIVE_FILE_EXTENSION.test(fileName)) return true
  if (
    segments.includes('secure') &&
    (fileName === 'access-profiles.json' || fileName === 'conversation-history.json')
  ) {
    return true
  }
  return false
}

function isReviewSensitiveRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  return isSensitiveRelativePath(relativePath) ||
    segments.some((segment) =>
      segment === '.git' ||
      segment === '.codex' ||
      segment === '.agents' ||
      segment === 'node_modules'
    )
}

function isProtectedWriteRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  const fileName = segments.at(-1) ?? ''
  return segments.some((segment) => PROTECTED_WRITE_DIRECTORY_NAMES.has(segment)) ||
    PROTECTED_WRITE_FILE_NAMES.has(fileName) ||
    CONVERSATION_HISTORY_BRIDGE_FILE_PATTERN.test(fileName) ||
    fileName.startsWith(CONVERSATION_HISTORY_TEMPORARY_PREFIX) ||
    fileName.startsWith('.ai-terminal-write-')
}

function isSearchExcludedRelativePath(relativePath: string): boolean {
  return relativePath !== '.' &&
    (isSensitiveRelativePath(relativePath) || isProtectedWriteRelativePath(relativePath))
}

function isSafeSearchEntryName(value: string): boolean {
  return value.length > 0 &&
    value.length <= MAX_PATH_SEGMENT_CHARACTERS &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value !== '.' &&
    value !== '..'
}

function containsUnsafeControlCharacters(value: Uint8Array): boolean {
  for (const byte of value) {
    if ((byte >= 0 && byte <= 8) || byte === 11 || byte === 12 || (byte >= 14 && byte <= 31) || byte === 127) {
      return true
    }
  }
  return false
}

function buildSearchPreview(
  line: string,
  matchOffset: number,
  matchLength: number,
  maximumCharacters: number,
  accessScope: LocalAccessScope = 'workspace'
): string {
  const start = Math.max(0, matchOffset - SEARCH_CONTEXT_CHARACTERS)
  const end = Math.min(line.length, matchOffset + matchLength + SEARCH_CONTEXT_CHARACTERS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < line.length ? '...' : ''
  const preview = `${prefix}${line.slice(start, end)}${suffix}`
  const redacted = accessScope === 'system'
    ? redactCredentialContent(preview)
    : redactCredentialContent(preview)
  return truncateText(redacted, maximumCharacters).text
}

function countLiteralMatches(value: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (offset <= value.length - needle.length) {
    const match = value.indexOf(needle, offset)
    if (match < 0) break
    count += 1
    if (count > 1) return count
    offset = match + needle.length
  }
  return count
}

function safeWorkspaceResultPath(
  relativePath: string,
  accessScope: LocalAccessScope = 'workspace'
): string {
  if (accessScope === 'workspace' && isSensitiveRelativePath(relativePath)) {
    return '<sensitive-file>'
  }
  const redacted = accessScope === 'system'
    ? redactCredentialContent(relativePath)
    : redactCredentialContent(relativePath)
  const bounded = truncateText(redacted, MAX_RELATIVE_PATH_CHARACTERS).text
  return bounded || '<redacted-file>'
}

function mergeGitStatus(
  left: GitFileSummary['status'],
  right: GitFileSummary['status']
): GitFileSummary['status'] {
  const priority: Readonly<Record<GitFileSummary['status'], number>> = {
    modified: 1,
    untracked: 2,
    added: 3,
    renamed: 4,
    deleted: 5
  }
  return priority[right] > priority[left] ? right : left
}

function safeLineTotal(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total) || total > MAX_DIFF_LINES) {
    throw new WorkspaceToolError('git_invalid_output')
  }
  return total
}

function decodeGitOutput(output: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch {
    throw new WorkspaceToolError('git_invalid_output')
  }
}

function sanitizedCommandEnvironment(
  source: NodeJS.ProcessEnv,
  workspaceRoot: string,
  protectedRoots: readonly string[] = []
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    PYTHONIOENCODING: 'utf-8'
  }
  const pathValue = readEnvironmentValue(source, 'PATH')
  if (pathValue !== undefined) {
    const directories = pathValue
      .split(delimiter)
      .map((value) => value.trim().replace(/^"|"$/gu, ''))
      .filter((value) => (
        value.length > 0 &&
        isAbsolute(value) &&
        !/[\r\n\0]/u.test(value) &&
        !isPathInsideWorkspace(workspaceRoot, value) &&
        !protectedRoots.some((root) => isPathInsideWorkspace(root, value))
      ))
    if (directories.length > 0) environment.PATH = [...new Set(directories)].join(delimiter)
  }
  const fixedNames = [
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS'
  ] as const
  for (const name of fixedNames) {
    const value = readEnvironmentValue(source, name)
    if (
      value !== undefined &&
      value.length <= 32_768 &&
      !/[\r\n\0]/u.test(value) &&
      (name === 'PATHEXT' || !isAbsolute(value) || (
        !isPathInsideWorkspace(workspaceRoot, value) &&
        !protectedRoots.some((root) => isPathInsideWorkspace(root, value))
      ))
    ) {
      environment[name] = value
    }
  }
  return environment
}

function systemCommandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      name.length < 1 ||
      name.length > 32_768 ||
      value.length > 32_768 ||
      name.includes('\0') ||
      value.includes('\0')
    ) {
      continue
    }
    environment[name] = value
  }
  environment.PYTHONIOENCODING = 'utf-8'
  return environment
}

function sanitizedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LANG: 'C',
    LC_ALL: 'C'
  }
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function readEnvironmentValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name]
  if (direct !== undefined) return direct
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : source[key]
}

function parseProtectedRoots(value: readonly string[] | undefined): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new WorkspaceToolError('invalid_request')
  return value.map((root) => {
    if (
      typeof root !== 'string' ||
      root.length < 1 ||
      root.length > 32_768 ||
      !isAbsolute(root) ||
      /[\r\n\0]/u.test(root)
    ) {
      throw new WorkspaceToolError('invalid_request')
    }
    return resolve(root)
  })
}

function isPathInsideWorkspace(root: string, candidate: string): boolean {
  const rootKey = pathComparisonKey(resolve(root))
  const candidateKey = pathComparisonKey(resolve(candidate))
  const rootPrefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`
  return candidateKey === rootKey || candidateKey.startsWith(rootPrefix)
}

function pathComparisonKey(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sameStoredIdentity(
  workspace: ResolvedWorkspaceRecord,
  stats: BigIntStats
): boolean {
  if (
    workspace.device === '0' ||
    workspace.inode === '0' ||
    stats.dev === 0n ||
    stats.ino === 0n
  ) {
    return true
  }
  return workspace.device === stats.dev.toString(10) &&
    workspace.inode === stats.ino.toString(10)
}

function sameFileIdentity(
  expected: Awaited<ReturnType<typeof fs.lstat>>,
  actual: Awaited<ReturnType<FileHandle['stat']>>
): boolean {
  if (expected.dev !== 0 && actual.dev !== 0 && expected.dev !== actual.dev) return false
  if (expected.ino !== 0 && actual.ino !== 0 && expected.ino !== actual.ino) return false
  return true
}

function assertSingleLinkRegularFile(stats: { isFile(): boolean; nlink: number | bigint }): void {
  // Some filesystems report zero when a reliable link count is unavailable.
  const hasMultipleLinks =
    typeof stats.nlink === 'bigint' ? stats.nlink > 1n : stats.nlink > 1
  if (stats.isFile() && hasMultipleLinks) {
    throw new WorkspaceToolError('hard_link_rejected')
  }
}

function truncateText(value: string, maximumCharacters: number): { text: string; truncated: boolean } {
  if (value.length <= maximumCharacters) return { text: value, truncated: false }
  let text = value.slice(0, maximumCharacters)
  const finalCodeUnit = text.charCodeAt(text.length - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) text = text.slice(0, -1)
  return { text, truncated: true }
}

export function normalizeWorkspaceCommandArgv(
  value: unknown,
  accessScope: LocalAccessScope = 'workspace'
): readonly string[] {
  const normalizedScope = normalizeWorkspaceToolAccessScope(accessScope)
  if (normalizedScope === 'system') return normalizeSystemCommandArgv(value)
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_COMMAND_ARGUMENTS
  ) {
    throw new WorkspaceToolError('command_rejected')
  }
  let totalBytes = 0
  const argv = value.map((argument, index): string => {
    if (
      typeof argument !== 'string' ||
      (index === 0 && !COMMAND_NAME_PATTERN.test(argument)) ||
      Buffer.byteLength(argument, 'utf8') > MAX_COMMAND_ARGUMENT_BYTES ||
      /[\r\n\0\u0001-\u001f\u007f]/u.test(argument) ||
      containsSensitiveCredential(argument) ||
      containsCommandPathEscape(argument) ||
      isShellOperatorArgument(argument)
    ) {
      throw new WorkspaceToolError('command_rejected')
    }
    totalBytes += Buffer.byteLength(argument, 'utf8')
    if (totalBytes > MAX_COMMAND_TOTAL_ARGUMENT_BYTES) {
      throw new WorkspaceToolError('command_rejected')
    }
    return argument
  })
  if (COMMAND_SHELL_NAMES.has(argv[0]!.toLowerCase())) {
    throw new WorkspaceToolError('command_rejected')
  }
  return Object.freeze(argv)
}

function normalizeSystemCommandArgv(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_COMMAND_ARGUMENTS
  ) {
    throw new WorkspaceToolError('command_rejected')
  }
  let totalBytes = 0
  const argv = value.map((argument, index): string => {
    const argumentBytes = typeof argument === 'string'
      ? Buffer.byteLength(argument, 'utf8')
      : Number.POSITIVE_INFINITY
    if (
      typeof argument !== 'string' ||
      (index === 0 && argument.length < 1) ||
      argumentBytes > MAX_COMMAND_ARGUMENT_BYTES ||
      /[\r\n\0\u0001-\u001f\u007f]/u.test(argument)
    ) {
      throw new WorkspaceToolError('command_rejected')
    }
    totalBytes += argumentBytes
    if (totalBytes > MAX_COMMAND_TOTAL_ARGUMENT_BYTES) {
      throw new WorkspaceToolError('command_rejected')
    }
    return argument
  })
  return Object.freeze(argv)
}

function containsCommandPathEscape(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  if (
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.startsWith('//') ||
    normalized.startsWith('/') ||
    /^\\\\[?.]\\/u.test(value)
  ) {
    return true
  }
  const segments = normalized.split('/')
  if (segments.includes('..')) return true
  return /(?:^|[\s=:@])(?:[A-Za-z]:\/|\/\/|\/(?:Users|home|tmp|var|private|opt|mnt|srv|workspace|workspaces|root|data)(?:\/|$))/iu
    .test(normalized)
}

function isShellOperatorArgument(value: string): boolean {
  return /^(?:&&|\|\||[;&|<>]|[0-9]?>{1,2}|[0-9]?<)$/u.test(value) ||
    value.includes('$(') ||
    value.includes(String.fromCharCode(96))
}

interface ResolvedCommandExecutable {
  readonly command: string
  readonly prefixArguments: readonly string[]
}

async function resolveCommandExecutable(
  configured: string,
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string,
  signal?: AbortSignal,
  accessScope: LocalAccessScope = 'workspace'
): Promise<ResolvedCommandExecutable> {
  throwIfAborted(signal)
  if (accessScope === 'workspace' && (
    !COMMAND_NAME_PATTERN.test(configured) ||
    COMMAND_SHELL_NAMES.has(configured.toLowerCase())
  )) {
    throw new WorkspaceToolError('command_rejected')
  }
  if (accessScope === 'system' && (
    isAbsolute(configured) ||
    win32.isAbsolute(configured) ||
    posix.isAbsolute(configured) ||
    configured.includes('/') ||
    configured.includes('\\')
  )) {
    return await resolveSystemCommandExecutable(
      normalizeSystemTargetPath(workspaceRoot, configured),
      signal
    )
  }
  if (!COMMAND_NAME_PATTERN.test(configured)) {
    throw new WorkspaceToolError('command_rejected')
  }
  const pathValue = environment.PATH
  if (!pathValue) throw new WorkspaceToolError('command_unavailable', true)
  const hasExtension = /\.[A-Za-z0-9]+$/u.test(configured)
  const names = process.platform === 'win32' && !hasExtension
    ? [configured + '.exe', configured + '.com']
    : [configured]
  if (
    process.platform === 'win32' &&
    hasExtension &&
    !/\.(?:exe|com)$/iu.test(configured)
  ) {
    throw new WorkspaceToolError('command_rejected')
  }

  for (const rawDirectory of pathValue.split(delimiter)) {
    throwIfAborted(signal)
    const directory = rawDirectory.trim().replace(/^"|"$/gu, '')
    if (
      !directory ||
      !isAbsolute(directory) ||
      /[\r\n\0]/u.test(directory) ||
      (accessScope === 'workspace' && isPathInsideWorkspace(workspaceRoot, directory))
    ) {
      continue
    }
    for (const name of names) {
      try {
        const candidate = resolve(await fs.realpath(join(directory, name)))
        const stats = await fs.stat(candidate)
        throwIfAborted(signal)
        if (
          !stats.isFile() ||
          (accessScope === 'workspace' && isPathInsideWorkspace(workspaceRoot, candidate))
        ) continue
        if (process.platform !== 'win32') {
          await fs.access(candidate, fsConstants.X_OK)
        }
        return Object.freeze({ command: candidate, prefixArguments: Object.freeze([]) })
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (signal?.aborted) throw new WorkspaceToolError('cancelled')
      }
    }
  }

  if (process.platform === 'win32') {
    const entrypoint = WINDOWS_NODE_CLI_ENTRYPOINTS[
      configured.toLowerCase() as keyof typeof WINDOWS_NODE_CLI_ENTRYPOINTS
    ]
    if (entrypoint) {
      for (const rawDirectory of pathValue.split(delimiter)) {
        throwIfAborted(signal)
        const directory = rawDirectory.trim().replace(/^"|"$/gu, '')
        if (
          !directory ||
          !isAbsolute(directory) ||
          /[\r\n\0]/u.test(directory) ||
          (accessScope === 'workspace' && isPathInsideWorkspace(workspaceRoot, directory))
        ) {
          continue
        }
        try {
          const nodeExecutable = resolve(await fs.realpath(join(directory, 'node.exe')))
          const cliEntrypoint = resolve(await fs.realpath(
            join(directory, 'node_modules', 'npm', 'bin', entrypoint)
          ))
          const [nodeStats, cliStats] = await Promise.all([
            fs.stat(nodeExecutable),
            fs.stat(cliEntrypoint)
          ])
          throwIfAborted(signal)
          if (
            !nodeStats.isFile() ||
            !cliStats.isFile() ||
            (accessScope === 'workspace' && (
              isPathInsideWorkspace(workspaceRoot, nodeExecutable) ||
              isPathInsideWorkspace(workspaceRoot, cliEntrypoint)
            ))
          ) {
            continue
          }
          return Object.freeze({
            command: nodeExecutable,
            prefixArguments: Object.freeze([cliEntrypoint])
          })
        } catch (error) {
          if (error instanceof WorkspaceToolError) throw error
          if (signal?.aborted) throw new WorkspaceToolError('cancelled')
        }
      }
    }
  }
  throw new WorkspaceToolError('command_unavailable', true)
}

async function resolveSystemCommandExecutable(
  candidate: string,
  signal?: AbortSignal
): Promise<ResolvedCommandExecutable> {
  throwIfAborted(signal)
  try {
    const command = resolve(await fs.realpath(candidate))
    const stats = await fs.stat(command)
    throwIfAborted(signal)
    if (!stats.isFile()) throw new WorkspaceToolError('command_unavailable', true)
    if (process.platform !== 'win32') await fs.access(command, fsConstants.X_OK)
    return Object.freeze({ command, prefixArguments: Object.freeze([]) })
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('command_unavailable', true)
  }
}

function decodeCommandOutput(
  output: Buffer,
  accessScope: LocalAccessScope = 'workspace'
): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(output)
    const normalized = value
      .replace(/\r\n/gu, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    return accessScope === 'system'
      ? redactCredentialContent(normalized)
      : redactCredentialContent(normalized)
  } catch {
    throw new WorkspaceToolError('command_invalid_output')
  }
}

function validateGitExecutable(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 32_768 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
  return value
}

async function resolveGitExecutable(
  configured: string,
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string
): Promise<string> {
  if (isAbsolute(configured)) return await validateResolvedExecutable(configured, workspaceRoot)
  if (configured.includes('/') || configured.includes('\\')) {
    throw new WorkspaceToolError('git_unavailable')
  }

  const pathValue = environment.PATH
  if (!pathValue) throw new WorkspaceToolError('git_unavailable')
  const names = process.platform === 'win32' && !/\.[A-Za-z0-9]+$/u.test(configured)
    ? [`${configured}.exe`]
    : [configured]

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, '')
    if (!directory || !isAbsolute(directory) || /[\r\n\0]/u.test(directory)) continue
    for (const name of names) {
      try {
        return await validateResolvedExecutable(join(directory, name), workspaceRoot)
      } catch (error) {
        if (error instanceof WorkspaceToolError && error.code === 'git_unavailable') continue
        throw error
      }
    }
  }
  throw new WorkspaceToolError('git_unavailable')
}

async function validateResolvedExecutable(candidate: string, workspaceRoot: string): Promise<string> {
  try {
    const resolvedExecutable = resolve(await fs.realpath(candidate))
    const stats = await fs.stat(resolvedExecutable)
    if (!stats.isFile() || isPathInsideWorkspace(workspaceRoot, resolvedExecutable)) {
      throw new WorkspaceToolError('git_unavailable')
    }
    return resolvedExecutable
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    throw new WorkspaceToolError('git_unavailable')
  }
}

function nullDevicePath(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new WorkspaceToolError('invalid_request')
  }
  return candidate
}

function assertReadFileInput(value: unknown): asserts value is WorkspaceFileInput {
  if (
    (!hasExactKeys(value, ['workspaceToken', 'relativePath']) &&
      !hasExactKeys(value, ['workspaceToken', 'relativePath', 'startLine']) &&
      !hasExactKeys(value, ['workspaceToken', 'relativePath', 'lineCount']) &&
      !hasExactKeys(value, ['workspaceToken', 'relativePath', 'startLine', 'lineCount'])) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !isOptionalPositiveInteger((value as { startLine?: unknown }).startLine) ||
    !isOptionalPositiveInteger((value as { lineCount?: unknown }).lineCount)
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1)
}

function assertListDirectoryInput(value: unknown): asserts value is WorkspaceDirectoryInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertWriteFileInput(value: unknown): asserts value is WorkspaceWriteInput {
  if (!isPlainRecord(value)) throw new WorkspaceToolError('invalid_request')
  const keys = Object.keys(value)
  const hasExpectedRevision = Object.hasOwn(value, 'expectedRevision')
  if (
    keys.length !== (hasExpectedRevision ? 4 : 3) ||
    !['workspaceToken', 'relativePath', 'content', 'expectedRevision'].every(
      (key) => key === 'expectedRevision' || Object.hasOwn(value, key)
    ) ||
    keys.some((key) => !['workspaceToken', 'relativePath', 'content', 'expectedRevision'].includes(key)) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.content !== 'string' ||
    value.content.includes('\0') ||
    (value.expectedRevision !== undefined && typeof value.expectedRevision !== 'string')
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
  if (typeof value.expectedRevision === 'string') {
    // Replacing the whole file from a partial view would discard the part the
    // caller never saw; surface it as a conflict so the fix is "read it fully".
    if (value.expectedRevision.startsWith(PARTIAL_REVISION_PREFIX)) {
      throw new WorkspaceToolError('partial_revision')
    }
    if (!/^[a-f0-9]{64}$/u.test(value.expectedRevision)) {
      throw new WorkspaceToolError('invalid_request')
    }
  }
}

function assertSearchFilesInput(value: unknown): asserts value is WorkspaceSearchInput {
  if (!isPlainRecord(value)) throw new WorkspaceToolError('invalid_request')
  const searchKeys = Object.keys(value)
  const hasRegexKey = Object.hasOwn(value, 'regex')
  if (
    searchKeys.length !== (hasRegexKey ? 5 : 4) ||
    !['workspaceToken', 'relativePath', 'query', 'caseSensitive'].every((key) => Object.hasOwn(value, key)) ||
    searchKeys.some((key) => !['workspaceToken', 'relativePath', 'query', 'caseSensitive', 'regex'].includes(key)) ||
    (hasRegexKey && typeof value.regex !== 'boolean') ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.query !== 'string' ||
    value.query.length < 1 ||
    value.query.length > MAX_SEARCH_QUERY_CHARACTERS ||
    value.query.includes('\0') ||
    /[\r\n\u0000-\u001f\u007f]/u.test(value.query) ||
    typeof value.caseSensitive !== 'boolean'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertReplaceInFileInput(value: unknown): asserts value is WorkspaceReplaceInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath', 'oldText', 'newText', 'expectedRevision']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.oldText !== 'string' ||
    typeof value.newText !== 'string' ||
    typeof value.expectedRevision !== 'string' ||
    value.oldText.length < 1 ||
    value.oldText.includes('\0') ||
    value.newText.includes('\0') ||
    // A targeted replacement may cite a partial read: the unique literal match
    // is what protects the unseen remainder, not the completeness of the view.
    !/^[a-f0-9]{64}$/u.test(stripPartialRevision(value.expectedRevision) ?? '')
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function containsForbiddenPatternCharacter(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function assertGlobFilesInput(value: unknown): asserts value is WorkspaceGlobInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath', 'pattern']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.pattern !== 'string' ||
    value.pattern.length < 1 ||
    value.pattern.length > MAX_SEARCH_QUERY_CHARACTERS ||
    containsForbiddenPatternCharacter(value.pattern)
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertRunCommandInput(value: unknown): asserts value is WorkspaceCommandInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath', 'argv']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !Array.isArray(value.argv)
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertDeletePathInput(value: unknown): asserts value is WorkspaceDeleteInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath', 'recursive']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.recursive !== 'boolean'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertGitSummaryInput(value: unknown): asserts value is { workspaceToken: string; base?: GitDiffBase } {
  if (
    (!hasExactKeys(value, ['workspaceToken']) && !hasExactKeys(value, ['workspaceToken', 'base'])) ||
    typeof value.workspaceToken !== 'string' ||
    ('base' in value && value.base !== 'current' && value.base !== 'main')
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertOwner(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertSignal(value: unknown): asserts value is AbortSignal | undefined {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null) {
    throw new WorkspaceToolError('invalid_request')
  }
  const candidate = value as {
    aborted?: unknown
    addEventListener?: unknown
    removeEventListener?: unknown
  }
  if (
    typeof candidate.aborted !== 'boolean' ||
    typeof candidate.addEventListener !== 'function' ||
    typeof candidate.removeEventListener !== 'function'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceToolError('cancelled')
}

function fixedFileSystemError(error: unknown): WorkspaceToolError {
  if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
    return new WorkspaceToolError('path_not_found')
  }
  if (isNodeErrorCode(error, 'EISDIR')) return new WorkspaceToolError('path_not_file')
  return new WorkspaceToolError('workspace_unavailable', true)
}

function fixedDirectorySystemError(error: unknown): WorkspaceToolError {
  if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
    return new WorkspaceToolError('path_not_found')
  }
  return new WorkspaceToolError('workspace_unavailable', true)
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && 'code' in value && value.code === code
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
