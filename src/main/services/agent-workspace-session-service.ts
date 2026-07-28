import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface AgentWorkspaceSessionStorage {
  read(): Promise<string | null>
  write(serializedDocument: string): Promise<void>
}

export interface AgentWorkspaceSessionServiceOptions {
  readonly documentsRoot: string
  readonly storage: AgentWorkspaceSessionStorage
  readonly clock?: () => number
}

export interface AgentWorkspaceSession {
  readonly absolutePath: string
  readonly displayName: string
}

export interface AgentWorkspaceProvisionInput {
  readonly prompt?: string
  readonly directoryName?: string
}

export type AgentWorkspaceSessionErrorCode =
  | 'invalid_options'
  | 'invalid_project_id'
  | 'workspace_unavailable'
  | 'storage_unavailable'
  | 'corrupt_storage'
  | 'capacity_exceeded'
  | 'provision_failed'

const ERROR_MESSAGES: Readonly<Record<AgentWorkspaceSessionErrorCode, string>> = Object.freeze({
  invalid_options: 'The Agent workspace session options are invalid.',
  invalid_project_id: 'The Agent workspace project identifier is invalid.',
  workspace_unavailable: 'The Agent workspace is unavailable.',
  storage_unavailable: 'The Agent workspace session storage is unavailable.',
  corrupt_storage: 'The Agent workspace session document is invalid.',
  capacity_exceeded: 'The Agent workspace session capacity was exceeded.',
  provision_failed: 'The Agent workspace could not be created.'
})

const MAX_LOCAL_PATH_CHARACTERS = 32_768
const MAX_PROVISION_ATTEMPTS = 1_000
const MAX_DOCUMENT_BYTES = 256 * 1024
const MAX_BINDINGS = 2_048
const DOCUMENT_FORMAT = 'ai-terminal.agent-workspace-sessions'
const DOCUMENT_VERSION = 1
const PROJECT_ID_PREFIX = 'project:workspace:'
const PROJECT_ID_PATTERN = /^project:workspace:[A-Za-z0-9_-]{43}$/u

export class AgentWorkspaceSessionError extends Error {
  readonly code: AgentWorkspaceSessionErrorCode

  constructor(code: AgentWorkspaceSessionErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'AgentWorkspaceSessionError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class AgentWorkspaceSessionService {
  readonly #documentsRoot: string
  readonly #storage: AgentWorkspaceSessionStorage
  readonly #clock: () => number
  #operations: Promise<void> = Promise.resolve()
  #bindings: Map<string, string> | null = null

  constructor(options: AgentWorkspaceSessionServiceOptions) {
    if (!isPlainRecord(options) || !hasExactKeys(options, ['documentsRoot', 'storage'], ['clock'])) {
      throw new AgentWorkspaceSessionError('invalid_options')
    }
    if (!isValidAbsolutePath(options.documentsRoot)) {
      throw new AgentWorkspaceSessionError('invalid_options')
    }
    if (
      (typeof options.storage !== 'object' || options.storage === null) ||
      typeof options.storage.read !== 'function' ||
      typeof options.storage.write !== 'function' ||
      (options.clock !== undefined && typeof options.clock !== 'function')
    ) {
      throw new AgentWorkspaceSessionError('invalid_options')
    }

    this.#documentsRoot = resolve(options.documentsRoot)
    this.#storage = options.storage
    this.#clock = options.clock ?? Date.now
    this.#readNow()
  }

  async provision(input: AgentWorkspaceProvisionInput = {}): Promise<AgentWorkspaceSession> {
    if (!isPlainRecord(input) || !hasExactKeys(input, [], ['prompt', 'directoryName'])) {
      throw new AgentWorkspaceSessionError('invalid_options')
    }
    if (
      (input.prompt !== undefined && typeof input.prompt !== 'string') ||
      (input.directoryName !== undefined && typeof input.directoryName !== 'string')
    ) {
      throw new AgentWorkspaceSessionError('invalid_options')
    }
    const baseName = codexWorkspaceSlug(input.directoryName ?? input.prompt ?? '')
    return await this.#serialize(async () => {
      const dateSegment = localDateSegment(this.#readNow())
      try {
        await fs.mkdir(this.#documentsRoot, { recursive: true })
        const canonicalRoot = resolve(await fs.realpath(this.#documentsRoot))
        const datedParent = join(canonicalRoot, 'Codex', dateSegment)
        await fs.mkdir(datedParent, { recursive: true })
        const canonicalParent = resolve(await fs.realpath(datedParent))
        if (!isPathInside(canonicalRoot, canonicalParent)) {
          throw new AgentWorkspaceSessionError('provision_failed')
        }

        for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt += 1) {
          const displayName = attempt === 1 ? baseName : `${baseName}-${attempt}`
          const candidate = join(canonicalParent, displayName)
          try {
            await fs.mkdir(candidate)
          } catch (error) {
            if (isNodeErrorCode(error, 'EEXIST')) continue
            throw error
          }
          const absolutePath = resolve(await fs.realpath(candidate))
          const stats = await fs.stat(absolutePath)
          if (!stats.isDirectory() || !isPathInside(canonicalParent, absolutePath)) {
            throw new AgentWorkspaceSessionError('provision_failed')
          }
          await Promise.all([
            fs.mkdir(join(absolutePath, 'work')),
            fs.mkdir(join(absolutePath, 'outputs'))
          ])
          return Object.freeze({ absolutePath, displayName })
        }
      } catch (error) {
        if (error instanceof AgentWorkspaceSessionError) throw error
        throw new AgentWorkspaceSessionError('provision_failed')
      }
      throw new AgentWorkspaceSessionError('provision_failed')
    })
  }

  async bindProject(projectId: string, absolutePath: string): Promise<void> {
    assertProjectId(projectId)
    if (!isValidAbsolutePath(absolutePath)) {
      throw new AgentWorkspaceSessionError('workspace_unavailable')
    }
    return await this.#serialize(async () => {
      const canonicalPath = await canonicalExistingDirectory(absolutePath)
      const bindings = await this.#loadBindings()
      if (!bindings.has(projectId) && bindings.size >= MAX_BINDINGS) {
        throw new AgentWorkspaceSessionError('capacity_exceeded')
      }
      const next = new Map(bindings)
      next.set(projectId, canonicalPath)
      await this.#persistBindings(next)
      this.#bindings = next
    })
  }

  async resolveProject(projectId: string): Promise<AgentWorkspaceSession | null> {
    assertProjectId(projectId)
    return await this.#serialize(async () => {
      const bindings = await this.#loadBindings()
      const storedPath = bindings.get(projectId)
      if (!storedPath) return null
      try {
        const canonicalPath = await canonicalExistingDirectory(storedPath)
        if (!samePath(canonicalPath, storedPath)) return null
        return Object.freeze({
          absolutePath: canonicalPath,
          displayName: safeDisplayName(canonicalPath)
        })
      } catch (error) {
        if (error instanceof AgentWorkspaceSessionError && error.code === 'workspace_unavailable') {
          return null
        }
        throw error
      }
    })
  }

  async forgetProject(projectId: string): Promise<void> {
    assertProjectId(projectId)
    return await this.#serialize(async () => {
      const bindings = await this.#loadBindings()
      if (!bindings.has(projectId)) return
      const next = new Map(bindings)
      next.delete(projectId)
      await this.#persistBindings(next)
      this.#bindings = next
    })
  }

  async #loadBindings(): Promise<Map<string, string>> {
    if (this.#bindings) return this.#bindings
    let serialized: string | null
    try {
      serialized = await this.#storage.read()
    } catch {
      throw new AgentWorkspaceSessionError('storage_unavailable')
    }
    if (serialized === null) {
      this.#bindings = new Map()
      return this.#bindings
    }
    this.#bindings = parseDocument(serialized)
    return this.#bindings
  }

  async #persistBindings(bindings: ReadonlyMap<string, string>): Promise<void> {
    const document = {
      format: DOCUMENT_FORMAT,
      version: DOCUMENT_VERSION,
      bindings: [...bindings]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([projectId, absolutePath]) => ({ projectId, absolutePath }))
    }
    const serialized = JSON.stringify(document)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new AgentWorkspaceSessionError('capacity_exceeded')
    }
    try {
      await this.#storage.write(serialized)
    } catch {
      throw new AgentWorkspaceSessionError('storage_unavailable')
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation)
    this.#operations = result.then(() => undefined, () => undefined)
    return result
  }

  #readNow(): number {
    let value: number
    try {
      value = this.#clock()
    } catch {
      throw new AgentWorkspaceSessionError('invalid_options')
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new AgentWorkspaceSessionError('invalid_options')
    }
    return value
  }
}

function parseDocument(serialized: unknown): Map<string, string> {
  if (
    typeof serialized !== 'string' ||
    serialized.length === 0 ||
    Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES
  ) {
    throw new AgentWorkspaceSessionError('corrupt_storage')
  }
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new AgentWorkspaceSessionError('corrupt_storage')
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['format', 'version', 'bindings']) ||
    value.format !== DOCUMENT_FORMAT ||
    value.version !== DOCUMENT_VERSION ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > MAX_BINDINGS
  ) {
    throw new AgentWorkspaceSessionError('corrupt_storage')
  }
  const bindings = new Map<string, string>()
  for (const entry of value.bindings) {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ['projectId', 'absolutePath']) ||
      !isCanonicalProjectId(entry.projectId) ||
      !isValidAbsolutePath(entry.absolutePath) ||
      bindings.has(entry.projectId)
    ) {
      throw new AgentWorkspaceSessionError('corrupt_storage')
    }
    bindings.set(entry.projectId, resolve(entry.absolutePath))
  }
  return bindings
}

async function canonicalExistingDirectory(absolutePath: string): Promise<string> {
  try {
    const canonicalPath = resolve(await fs.realpath(absolutePath))
    const stats = await fs.stat(canonicalPath)
    if (!stats.isDirectory()) throw new AgentWorkspaceSessionError('workspace_unavailable')
    return canonicalPath
  } catch (error) {
    if (error instanceof AgentWorkspaceSessionError) throw error
    throw new AgentWorkspaceSessionError('workspace_unavailable')
  }
}

function assertProjectId(value: unknown): asserts value is string {
  if (!isCanonicalProjectId(value)) throw new AgentWorkspaceSessionError('invalid_project_id')
}

function isCanonicalProjectId(value: unknown): value is string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) return false
  const token = value.slice(PROJECT_ID_PREFIX.length)
  try {
    const decoded = Buffer.from(token, 'base64url')
    return decoded.length === 32 && decoded.toString('base64url') === token
  } catch {
    return false
  }
}

function safeDisplayName(absolutePath: string): string {
  const candidate = basename(absolutePath).replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  if (candidate.length === 0 || candidate.length > 160) return 'Agent workspace'
  return candidate
}

function codexWorkspaceSlug(value: string): string {
  const words = value
    .slice(0, 4_096)
    .toLowerCase()
    .match(/[a-z0-9]+/gu)
    ?.slice(0, 6) ?? []
  const slug = words.join('-').slice(0, 80).replace(/-+$/u, '')
  return slug || 'new-chat'
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = resolve(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function localDateSegment(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) throw new AgentWorkspaceSessionError('invalid_options')
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

function isValidAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LOCAL_PATH_CHARACTERS &&
    isAbsolute(value) &&
    !/[\r\n\0]/u.test(value)
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
