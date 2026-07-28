import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { StudioError, assertNoSecretFields } from './errors.js'
import { atomicWriteJson, ensureDirectory, readJson, resolveInside } from './filesystem.js'

export const projectFileName = 'project.json'
export const fallbackProjectFileName = 'studio.project.json'

export const emptyCollections = {
  schemaVersion: 1 as const,
  boards: [],
  smartCollections: [],
}

const projectMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const legacyProjectMetadataSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
}).passthrough()

export type ProjectMetadata = z.infer<typeof projectMetadataSchema>

const managedDirectories = [
  'workflows',
  'assets',
  'outputs',
  '.studio',
  '.studio/drafts',
  '.studio/workflow-history',
  '.studio/trash',
] as const

const initialStateFiles: ReadonlyArray<readonly [string, unknown]> = [
  ['assets.json', []],
  ['tasks.json', []],
  ['run-queue.json', []],
  ['collections.json', emptyCollections],
  ['plugins.json', []],
  ['presets.json', []],
]

const ensureJsonFile = async (filePath: string, fallback: unknown): Promise<void> => {
  try {
    await readJson(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await atomicWriteJson(filePath, fallback)
  }
}

export class ProjectLayout {
  async initialize(root: string, metadata: ProjectMetadata): Promise<void> {
    const projectRoot = path.resolve(root)
    await Promise.all(managedDirectories.map((name) => ensureDirectory(path.join(projectRoot, name))))
    await atomicWriteJson(path.join(projectRoot, projectFileName), {
      version: 1,
      id: metadata.id,
      name: metadata.name,
      created_at: metadata.createdAt,
      updated_at: metadata.updatedAt,
      studio_schema_version: 1,
    })
    for (const [fileName, fallback] of initialStateFiles) {
      await atomicWriteJson(path.join(projectRoot, '.studio', fileName), fallback)
    }
  }

  async metadata(root: string): Promise<ProjectMetadata> {
    const projectRoot = path.resolve(root)
    let raw: unknown
    try {
      raw = await readJson(path.join(projectRoot, projectFileName))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      raw = await readJson(path.join(projectRoot, fallbackProjectFileName))
    }
    assertNoSecretFields(raw)
    const modern = projectMetadataSchema.safeParse(raw)
    if (modern.success) return modern.data
    const legacy = legacyProjectMetadataSchema.parse(raw)
    return {
      schemaVersion: 1,
      id: legacy.id,
      name: legacy.name,
      createdAt: new Date(legacy.created_at).toISOString(),
      updatedAt: new Date(legacy.updated_at).toISOString(),
    }
  }

  async ensure(root: string): Promise<void> {
    const projectRoot = path.resolve(root)
    await Promise.all(managedDirectories.map((name) => ensureDirectory(path.join(projectRoot, name))))
    await Promise.all(managedDirectories.map((name) => this.managedDirectory(projectRoot, name)))
    for (const [fileName, fallback] of initialStateFiles) {
      await ensureJsonFile(path.join(projectRoot, '.studio', fileName), fallback)
    }
  }

  async managedDirectory(root: string, relativeDirectory: string, create = false): Promise<string> {
    const projectRoot = path.resolve(root)
    const directory = resolveInside(projectRoot, relativeDirectory)
    if (create) {
      const parent = path.dirname(relativeDirectory)
      if (parent !== '.') await this.managedDirectory(projectRoot, parent)
      await ensureDirectory(directory)
    }
    const details = await lstat(directory)
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new StudioError('project-symlink-denied', `项目受管目录不能是符号链接或普通文件：${relativeDirectory}`)
    }
    const [realRoot, realDirectory] = await Promise.all([realpath(projectRoot), realpath(directory)])
    resolveInside(realRoot, realDirectory)
    return directory
  }

  async touch(root: string, updatedAt: string): Promise<void> {
    const metadataPath = await this.#metadataPath(root)
    const rawMetadata = await readJson<Record<string, unknown>>(metadataPath)
    if ('version' in rawMetadata) {
      await atomicWriteJson(metadataPath, { ...rawMetadata, updated_at: updatedAt })
      return
    }
    await atomicWriteJson(metadataPath, { ...rawMetadata, updatedAt })
  }

  async #metadataPath(root: string): Promise<string> {
    const projectRoot = path.resolve(root)
    const primary = path.join(projectRoot, projectFileName)
    try {
      await stat(primary)
      return primary
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return path.join(projectRoot, fallbackProjectFileName)
    }
  }
}

export class MutationCoordinator {
  readonly #queues = new Map<string, Promise<void>>()

  async run<T>(root: string, resource: string, operation: () => Promise<T>): Promise<T> {
    const rawKey = `${path.resolve(root)}\u0000${resource}`
    const key = process.platform === 'win32' ? rawKey.toLocaleLowerCase('en-US') : rawKey
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const running = previous.catch(() => undefined).then(operation)
    const tail = running.then(() => undefined, () => undefined)
    this.#queues.set(key, tail)
    try {
      return await running
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    }
  }
}
