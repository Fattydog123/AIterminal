import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { ConversationSnapshot } from '../../shared/contracts.ts'
import { redactSensitiveContent } from '../security/redaction.ts'

export interface ConversationWorkspaceHistoryReader {
  load(taskId: string): Promise<ConversationSnapshot>
}

export interface ConversationWorkspaceResolver {
  resolveProject(projectId: string): Promise<{
    readonly absolutePath: string
    readonly displayName: string
  } | null>
}

export interface ConversationWorkspaceExportServiceOptions {
  readonly history: ConversationWorkspaceHistoryReader
  readonly agentWorkspaces: ConversationWorkspaceResolver
}

export type ConversationWorkspaceSyncResult =
  | { readonly status: 'written'; readonly fileName: typeof EXPORT_FILE_NAME }
  | { readonly status: 'skipped'; readonly reason: 'not_agent' | 'workspace_unbound' }

export type ConversationWorkspaceExportErrorCode =
  | 'invalid_options'
  | 'invalid_input'
  | 'invalid_history'
  | 'history_unavailable'
  | 'workspace_unavailable'
  | 'unsafe_target'
  | 'limit_exceeded'
  | 'write_failed'

const ERROR_MESSAGES: Readonly<Record<ConversationWorkspaceExportErrorCode, string>> = Object.freeze({
  invalid_options: 'The conversation workspace export options are invalid.',
  invalid_input: 'The conversation workspace export request is invalid.',
  invalid_history: 'The conversation cannot be exported.',
  history_unavailable: 'The conversation history is unavailable.',
  workspace_unavailable: 'The Agent workspace is unavailable.',
  unsafe_target: 'The conversation history target is unavailable.',
  limit_exceeded: 'The conversation history export is too large.',
  write_failed: 'The conversation history could not be written.'
})

const EXPORT_FILE_NAME = 'AI-TERMINAL-HISTORY.md'
const TASK_EXPORT_FILE_PREFIX = 'AI-TERMINAL-HISTORY-'
const TASK_ID_PATTERN = /^task:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TASK_EXPORT_FILE_PATTERN = /^AI-TERMINAL-HISTORY-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.md$/u
const MAX_PROJECT_ID_CHARACTERS = 128
const MAX_LOCAL_PATH_CHARACTERS = 32_768
const MAX_MESSAGES = 2_000
const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_EXPORT_BYTES = 2 * 1024 * 1024
const MAX_INDEX_ENTRIES = 2_000
const TEMPORARY_FILE_ATTEMPTS = 8

type FileStats = Awaited<ReturnType<typeof fs.lstat>>

interface TaskExportFileIdentity {
  readonly fileName: string
  readonly stats: FileStats
}

export class ConversationWorkspaceExportError extends Error {
  readonly code: ConversationWorkspaceExportErrorCode

  constructor(code: ConversationWorkspaceExportErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ConversationWorkspaceExportError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class ConversationWorkspaceExportService {
  readonly #history: ConversationWorkspaceHistoryReader
  readonly #agentWorkspaces: ConversationWorkspaceResolver
  #operationTail: Promise<void> = Promise.resolve()

  constructor(options: ConversationWorkspaceExportServiceOptions) {
    assertMainProcess()
    if (
      !isPlainRecord(options) ||
      !hasExactKeys(options, ['history', 'agentWorkspaces']) ||
      !hasMethod(options.history, 'load') ||
      !hasMethod(options.agentWorkspaces, 'resolveProject')
    ) {
      throw new ConversationWorkspaceExportError('invalid_options')
    }
    this.#history = options.history as ConversationWorkspaceHistoryReader
    this.#agentWorkspaces = options.agentWorkspaces as ConversationWorkspaceResolver
  }

  async syncTask(taskId: string): Promise<ConversationWorkspaceSyncResult> {
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
      throw new ConversationWorkspaceExportError('invalid_input')
    }
    return await this.#exclusive(async () => {
      const snapshot = await this.#loadSnapshot(taskId)
      const task = parseTask(snapshot, taskId)
      if (task.mode !== 'agent') return Object.freeze({ status: 'skipped', reason: 'not_agent' })

      let workspace: Awaited<ReturnType<ConversationWorkspaceResolver['resolveProject']>>
      try {
        workspace = await this.#agentWorkspaces.resolveProject(task.projectId)
      } catch {
        throw new ConversationWorkspaceExportError('workspace_unavailable')
      }
      if (workspace === null) return Object.freeze({ status: 'skipped', reason: 'workspace_unbound' })
      if (!isPlainRecord(workspace) || !hasExactKeys(workspace, ['absolutePath', 'displayName'])) {
        throw new ConversationWorkspaceExportError('workspace_unavailable')
      }
      if (!isValidAbsolutePath(workspace.absolutePath) || !isSafeDisplayName(workspace.displayName)) {
        throw new ConversationWorkspaceExportError('workspace_unavailable')
      }

      const markdown = renderVisibleMessages(snapshot)
      const taskFileName = taskExportFileName(taskId)
      const root = await inspectCanonicalWorkspaceRoot(workspace.absolutePath)
      await inspectExportTarget(join(root.absolutePath, EXPORT_FILE_NAME))
      const existingTaskFile = await inspectExportTarget(join(root.absolutePath, taskFileName))
      try {
        await writeAtomicWorkspaceFile(root.absolutePath, taskFileName, markdown)
        const taskFiles = await scanTaskExportFiles(root)
        const indexMarkdown = renderTaskIndex(taskFiles.map((entry) => entry.fileName))
        await writeAtomicWorkspaceFile(
          root.absolutePath,
          EXPORT_FILE_NAME,
          indexMarkdown,
          async () => await verifyTaskExportFiles(root, taskFiles)
        )
      } catch (error) {
        if (existingTaskFile === null) {
          await removeWorkspaceEntryWithoutFollowing(join(root.absolutePath, taskFileName))
        }
        throw error
      }
      return Object.freeze({ status: 'written', fileName: EXPORT_FILE_NAME })
    })
  }

  async #loadSnapshot(taskId: string): Promise<ConversationSnapshot> {
    try {
      return await this.#history.load(taskId)
    } catch {
      throw new ConversationWorkspaceExportError('history_unavailable')
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function parseTask(snapshot: unknown, taskId: string): { mode: 'chat' | 'agent'; projectId: string } {
  if (!isPlainRecord(snapshot) || !isPlainRecord(snapshot.task)) {
    throw new ConversationWorkspaceExportError('invalid_history')
  }
  const task = snapshot.task
  if (
    task.id !== taskId ||
    (task.mode !== 'chat' && task.mode !== 'agent') ||
    !isSafeProjectId(task.projectId)
  ) {
    throw new ConversationWorkspaceExportError('invalid_history')
  }
  return { mode: task.mode, projectId: task.projectId }
}

function renderVisibleMessages(snapshot: unknown): string {
  if (!isPlainRecord(snapshot) || !Array.isArray(snapshot.messages) || snapshot.messages.length > MAX_MESSAGES) {
    throw new ConversationWorkspaceExportError('invalid_history')
  }
  const sections = ['# AI Terminal Agent History']
  for (const message of snapshot.messages) {
    if (!isPlainRecord(message) || (message.role !== 'user' && message.role !== 'assistant')) {
      throw new ConversationWorkspaceExportError('invalid_history')
    }
    const content = normalizeVisibleContent(message.content)
    sections.push(message.role === 'user' ? '## User' : '## Assistant', content)
  }
  const markdown = `${sections.join('\n\n')}\n`
  if (Buffer.byteLength(markdown, 'utf8') > MAX_EXPORT_BYTES) {
    throw new ConversationWorkspaceExportError('limit_exceeded')
  }
  return markdown
}

function normalizeVisibleContent(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new ConversationWorkspaceExportError('invalid_history')
  }
  const redacted = redactRemainingAbsolutePaths(
    redactSensitiveContent(value).replace(/\r\n?/gu, '\n')
  )
  if (Buffer.byteLength(redacted, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new ConversationWorkspaceExportError('limit_exceeded')
  }
  return redacted
}

function redactRemainingAbsolutePaths(value: string): string {
  return value.replace(
    /(^|[\s("'`=:\[{])\/(?!\/)[^\r\n\s`"'<>|,;)}\]]+/gu,
    '$1<local-path>'
  )
}

function taskExportFileName(taskId: string): string {
  return `${TASK_EXPORT_FILE_PREFIX}${taskId.slice('task:'.length)}.md`
}

async function scanTaskExportFiles(root: {
  readonly absolutePath: string
  readonly stats: FileStats
}): Promise<readonly TaskExportFileIdentity[]> {
  const files: TaskExportFileIdentity[] = []
  let directory: Awaited<ReturnType<typeof fs.opendir>> | null = null
  try {
    directory = await fs.opendir(root.absolutePath)
    while (true) {
      const entry = await directory.read()
      if (entry === null) break
      if (!TASK_EXPORT_FILE_PATTERN.test(entry.name)) continue
      if (files.length >= MAX_INDEX_ENTRIES) {
        throw new ConversationWorkspaceExportError('limit_exceeded')
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new ConversationWorkspaceExportError('unsafe_target')
      }
      const target = await inspectExportTarget(join(root.absolutePath, entry.name))
      if (target === null) throw new ConversationWorkspaceExportError('unsafe_target')
      files.push(Object.freeze({ fileName: entry.name, stats: target }))
    }
    const rootAfter = await inspectCanonicalWorkspaceRoot(root.absolutePath)
    if (!sameDirectoryIdentity(root.stats, rootAfter.stats)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    return Object.freeze(files)
  } catch (error) {
    if (error instanceof ConversationWorkspaceExportError) throw error
    throw new ConversationWorkspaceExportError('write_failed')
  } finally {
    if (directory) await directory.close().catch(() => undefined)
  }
}

async function verifyTaskExportFiles(
  root: { readonly absolutePath: string; readonly stats: FileStats },
  files: readonly TaskExportFileIdentity[]
): Promise<void> {
  const rootBefore = await inspectCanonicalWorkspaceRoot(root.absolutePath)
  if (!sameDirectoryIdentity(root.stats, rootBefore.stats)) {
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
  for (const file of files) {
    const current = await inspectExportTarget(join(root.absolutePath, file.fileName))
    if (current === null || !sameFileIdentity(file.stats, current)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
  }
  const rootAfter = await inspectCanonicalWorkspaceRoot(root.absolutePath)
  if (!sameDirectoryIdentity(root.stats, rootAfter.stats)) {
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
}

function renderTaskIndex(fileNames: readonly string[]): string {
  const uniqueFileNames = [...new Set(fileNames)].sort((left, right) => left.localeCompare(right, 'en'))
  if (uniqueFileNames.length === 0 || uniqueFileNames.length > MAX_INDEX_ENTRIES) {
    throw new ConversationWorkspaceExportError('limit_exceeded')
  }
  const markdown = [
    '# AI Terminal Agent Histories',
    '',
    ...uniqueFileNames.map((fileName) => `- [${fileName}](./${fileName})`),
    ''
  ].join('\n')
  if (Buffer.byteLength(markdown, 'utf8') > MAX_EXPORT_BYTES) {
    throw new ConversationWorkspaceExportError('limit_exceeded')
  }
  return markdown
}

async function writeAtomicWorkspaceFile(
  workspacePath: string,
  fileName: string,
  content: string,
  validateDependencies?: () => Promise<void>
): Promise<void> {
  let temporaryPath: string | null = null
  let temporaryHandle: FileHandle | null = null
  let committed = false
  let destinationTouched = false
  let targetPath: string | null = null
  const expectedBytes = Buffer.from(content, 'utf8')
  const expectedDigest = createHash('sha256').update(expectedBytes).digest('hex')
  try {
    const rootBefore = await inspectCanonicalWorkspaceRoot(workspacePath)
    targetPath = join(rootBefore.absolutePath, fileName)
    const targetBefore = await inspectExportTarget(targetPath)
    const temporary = await createTemporaryFile(rootBefore.absolutePath)
    temporaryPath = temporary.path
    temporaryHandle = temporary.handle
    await temporaryHandle.writeFile(expectedBytes)
    await temporaryHandle.sync()
    const openedBefore = await assertOpenFileContent(temporaryHandle, expectedBytes.byteLength, expectedDigest)

    const rootAfter = await inspectCanonicalWorkspaceRoot(rootBefore.absolutePath)
    if (!sameDirectoryIdentity(rootBefore.stats, rootAfter.stats)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    const targetAfter = await inspectExportTarget(targetPath)
    if (!sameOptionalFileIdentity(targetBefore, targetAfter)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    const temporaryBefore = await inspectExportTarget(temporaryPath)
    if (temporaryBefore === null || !sameFileIdentity(openedBefore, temporaryBefore)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    await validateDependencies?.()

    const rootAtCommit = await inspectCanonicalWorkspaceRoot(rootBefore.absolutePath)
    if (!sameDirectoryIdentity(rootBefore.stats, rootAtCommit.stats)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    const targetAtCommit = await inspectExportTarget(targetPath)
    if (!sameOptionalFileIdentity(targetAfter, targetAtCommit)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    const temporaryAtCommit = await inspectExportTarget(temporaryPath)
    if (temporaryAtCommit === null || !sameFileIdentity(openedBefore, temporaryAtCommit)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    await fs.rename(temporaryPath, targetPath)
    destinationTouched = true

    const committedTarget = await inspectExportTarget(targetPath)
    const openedAfter = await assertOpenFileContent(temporaryHandle, expectedBytes.byteLength, expectedDigest)
    if (
      committedTarget === null ||
      !sameFileIdentity(openedBefore, openedAfter) ||
      !sameFileIdentity(openedBefore, committedTarget)
    ) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
    await validateDependencies?.()
    committed = true
  } catch (error) {
    if (destinationTouched && !committed && targetPath) {
      await removeWorkspaceEntryWithoutFollowing(targetPath)
    }
    if (error instanceof ConversationWorkspaceExportError) throw error
    throw new ConversationWorkspaceExportError('write_failed')
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined)
    if (!committed && temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function assertOpenFileContent(
  handle: FileHandle,
  expectedBytes: number,
  expectedDigest: string
): Promise<FileStats> {
  const stats = await handle.stat()
  if (!stats.isFile() || stats.size !== expectedBytes || stats.nlink !== 1) {
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
  const bytes = Buffer.alloc(expectedBytes)
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead <= 0) break
    offset += result.bytesRead
  }
  if (
    offset !== expectedBytes ||
    createHash('sha256').update(bytes).digest('hex') !== expectedDigest
  ) {
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
  return stats as FileStats
}

async function removeWorkspaceEntryWithoutFollowing(targetPath: string): Promise<void> {
  try {
    await fs.unlink(targetPath)
    return
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return
  }
  try {
    await fs.rm(targetPath, { force: true, recursive: false })
  } catch {
    // Never recurse through an untrusted replacement target.
  }
}

async function inspectCanonicalWorkspaceRoot(absolutePath: string): Promise<{
  absolutePath: string
  stats: Awaited<ReturnType<typeof fs.lstat>>
}> {
  try {
    const stats = await fs.lstat(absolutePath)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ConversationWorkspaceExportError('workspace_unavailable')
    }
    const canonicalPath = resolve(await fs.realpath(absolutePath))
    if (!samePath(canonicalPath, absolutePath)) {
      throw new ConversationWorkspaceExportError('workspace_unavailable')
    }
    return { absolutePath: canonicalPath, stats }
  } catch (error) {
    if (error instanceof ConversationWorkspaceExportError) throw error
    throw new ConversationWorkspaceExportError('workspace_unavailable')
  }
}

async function inspectExportTarget(
  targetPath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  let stats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
  if (stats.nlink !== 1) throw new ConversationWorkspaceExportError('unsafe_target')
  try {
    if (!samePath(resolve(await fs.realpath(targetPath)), targetPath)) {
      throw new ConversationWorkspaceExportError('unsafe_target')
    }
  } catch (error) {
    if (error instanceof ConversationWorkspaceExportError) throw error
    throw new ConversationWorkspaceExportError('unsafe_target')
  }
  return stats
}

async function createTemporaryFile(parentPath: string): Promise<{ path: string; handle: FileHandle }> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow
  for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
    const path = join(parentPath, `.ai-terminal-history-${randomBytes(18).toString('base64url')}.tmp`)
    try {
      return { path, handle: await fs.open(path, flags, 0o600) }
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) continue
      throw new ConversationWorkspaceExportError('write_failed')
    }
  }
  throw new ConversationWorkspaceExportError('write_failed')
}

function sameOptionalFileIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>> | null,
  right: Awaited<ReturnType<typeof fs.lstat>> | null
): boolean {
  if (left === null || right === null) return left === right
  return sameFileIdentity(left, right)
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>
): boolean {
  if (left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false
  if (left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

function sameDirectoryIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>
): boolean {
  if (left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false
  if (left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false
  return left.isDirectory() && right.isDirectory()
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isSafeProjectId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= MAX_PROJECT_ID_CHARACTERS &&
    /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(value) &&
    redactSensitiveContent(value) === value
}

function isValidAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LOCAL_PATH_CHARACTERS &&
    isAbsolute(value) &&
    !/[\r\n\0]/u.test(value)
}

function isSafeDisplayName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 160 &&
    !/[\r\n\0]/u.test(value) &&
    redactSensitiveContent(value) === value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasMethod(value: unknown, name: string): boolean {
  return (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === 'function'
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') {
    throw new ConversationWorkspaceExportError('invalid_options')
  }
}
