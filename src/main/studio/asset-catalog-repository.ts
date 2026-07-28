import { constants } from 'node:fs'
import { copyFile, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { buildDerivationForest } from '../../studio/core/assets.js'
import { boardSchema, smartCollectionSchema } from '../../studio/shared/contracts.js'
import type { Board, CollectionSnapshot, GeneratedAsset, SmartCollection } from '../../studio/shared/types.js'
import { StudioError, assertNoSecretFields } from './errors.js'
import { atomicWriteFile, atomicWriteJson, ensureDirectory, readJson, resolveInside, safeFilename } from './filesystem.js'
import { detectImage, imageDimensions } from './network.js'
import { MutationCoordinator, ProjectLayout, emptyCollections } from './project-persistence.js'

const assetCatalogLimit = 100_000
const assetIdentifierSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f]/.test(value),
  '作品标识不能带首尾空白或控制字符',
)
const managedAssetPathSchema = z.string().min(1).max(1024).refine((value) => {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:assets|outputs)\//.test(normalized)
    && !path.isAbsolute(value)
    && !normalized.split('/').includes('..')
}, '作品路径必须位于项目 assets 或 outputs 目录')

const generatedAssetSchema = z.object({
  id: assetIdentifierSchema,
  projectId: assetIdentifierSchema,
  workflowId: assetIdentifierSchema,
  nodeId: assetIdentifierSchema,
  relativePath: managedAssetPathSchema,
  thumbnailPath: managedAssetPathSchema.optional(),
  prompt: z.string().max(256_000),
  revisedPrompt: z.string().max(256_000).optional(),
  providerId: z.string().max(160),
  model: z.string().max(256),
  width: z.number().int().positive().max(32_768).optional(),
  height: z.number().int().positive().max(32_768).optional(),
  seed: z.number().int().safe().optional(),
  createdAt: z.string().datetime(),
  favorite: z.boolean(),
  decision: z.enum(['pending', 'adopted', 'rejected']),
  candidateGroupId: assetIdentifierSchema,
  parentAssetId: assetIdentifierSchema.optional(),
  operation: z.enum(['generate', 'edit', 'inpaint', 'outpaint']),
  tags: z.array(z.string().trim().min(1).max(80)).max(100),
}).passthrough()

const parseAssetCatalog = (raw: unknown, projectId?: string): readonly GeneratedAsset[] => {
  assertNoSecretFields(raw)
  const parsed = z.array(generatedAssetSchema).max(assetCatalogLimit).parse(raw) as readonly GeneratedAsset[]
  if (projectId && parsed.some((asset) => asset.projectId !== projectId)) {
    throw new StudioError('asset-project-mismatch', '作品目录包含不属于当前项目的记录')
  }
  try {
    buildDerivationForest(parsed)
  } catch (error) {
    throw new StudioError(
      'asset-derivation-invalid',
      error instanceof Error ? error.message : '作品候选派生关系无效',
      'not_sent',
      error,
    )
  }
  return parsed
}

const collectionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  boards: z.array(boardSchema).max(500),
  smartCollections: z.array(smartCollectionSchema).max(500),
}).strict()

const reservedCollectionIds = new Set(['all', 'favorites', 'today', 'approved'])

const decodeMaskPng = (pngBase64: string): { readonly bytes: Buffer; readonly width: number; readonly height: number } => {
  if (pngBase64.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(pngBase64)) {
    throw new StudioError('mask-base64-invalid', '蒙版不是有效的 base64 PNG')
  }
  const bytes = Buffer.from(pngBase64, 'base64')
  if (bytes.length < 45 || bytes.length > 32 * 1024 * 1024) throw new StudioError('mask-size-invalid', '蒙版为空或超过 32 MiB')
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((value, index) => bytes[index] === value)
      || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(bytes.length - 12) !== 0
      || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') {
    throw new StudioError('mask-png-invalid', '蒙版必须是完整的 PNG 文件')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) throw new StudioError('mask-dimensions-invalid', '蒙版尺寸无效或超过 16384 px')
  if (![4, 6].includes(bytes[25] ?? -1)) throw new StudioError('mask-alpha-required', '局部重绘蒙版必须包含 Alpha 通道')
  return { bytes, width, height }
}

type AssetPatch = {
  readonly favorite?: boolean
  readonly decision?: GeneratedAsset['decision']
  readonly tags?: readonly string[]
}

export class AssetCatalogRepository {
  constructor(
    private readonly layout: ProjectLayout,
    private readonly mutations: MutationCoordinator,
  ) {}

  async list(root: string): Promise<readonly GeneratedAsset[]> {
    const metadata = await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const raw = await readJson<unknown>(path.join(path.resolve(root), '.studio', 'assets.json'), [])
    return parseAssetCatalog(raw, metadata.id)
  }

  async append(root: string, values: readonly GeneratedAsset[]): Promise<void> {
    return this.mutations.run(root, 'assets', () => this.#appendUnlocked(root, values))
  }

  async #appendUnlocked(root: string, values: readonly GeneratedAsset[]): Promise<void> {
    const current = await this.list(root)
    const ids = new Set(current.map((asset) => asset.id))
    if (values.some((asset) => {
      if (ids.has(asset.id)) return true
      ids.add(asset.id)
      return false
    })) throw new StudioError('duplicate-asset', '作品 ID 重复')
    const parsed = parseAssetCatalog([...current, ...values], (await this.layout.metadata(root)).id)
    await atomicWriteJson(path.join(path.resolve(root), '.studio', 'assets.json'), parsed)
  }

  async update(root: string, assetId: string, patch: AssetPatch): Promise<GeneratedAsset> {
    return this.mutations.run(root, 'assets', () => this.#updateUnlocked(root, assetId, patch))
  }

  async #updateUnlocked(root: string, assetId: string, patch: AssetPatch): Promise<GeneratedAsset> {
    const current = [...(await this.list(root))]
    const index = current.findIndex((asset) => asset.id === assetId)
    if (index < 0) throw new StudioError('asset-not-found', `作品不存在：${assetId}`)
    const previous = current[index]
    if (!previous) throw new StudioError('asset-not-found', `作品不存在：${assetId}`)
    const updated: GeneratedAsset = {
      ...previous,
      ...(patch.favorite === undefined ? {} : { favorite: patch.favorite }),
      ...(patch.decision === undefined ? {} : { decision: patch.decision }),
      ...(patch.tags === undefined ? {} : { tags: [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))] }),
    }
    current[index] = updated
    if (patch.decision === 'adopted') {
      for (let candidateIndex = 0; candidateIndex < current.length; candidateIndex += 1) {
        const candidate = current[candidateIndex]
        if (candidateIndex !== index && candidate?.candidateGroupId === updated.candidateGroupId && candidate.decision === 'adopted') {
          current[candidateIndex] = { ...candidate, decision: 'pending' }
        }
      }
    }
    await atomicWriteJson(path.join(path.resolve(root), '.studio', 'assets.json'), parseAssetCatalog(current, previous.projectId))
    return updated
  }

  async export(
    root: string,
    assetIds: readonly string[],
    destinationDirectory: string,
    filenameTemplate: string,
  ): Promise<number> {
    const assets = await this.list(root)
    const byId = new Map(assets.map((asset) => [asset.id, asset]))
    const selected = assetIds.map((id) => byId.get(id))
    if (selected.some((asset) => asset === undefined)) throw new StudioError('asset-export-missing', '导出列表包含不存在的作品')
    const destination = path.resolve(destinationDirectory)
    await ensureDirectory(destination)
    let exported = 0
    for (const [index, asset] of (selected as GeneratedAsset[]).entries()) {
      const source = await this.resolveExisting(root, asset.relativePath)
      const values: Readonly<Record<string, string>> = {
        date: asset.createdAt.slice(0, 10),
        workflow: asset.workflowId,
        model: asset.model,
        seed: asset.seed === undefined ? 'noseed' : String(asset.seed),
        index: String(index + 1).padStart(3, '0'),
        operation: asset.operation,
      }
      const expanded = filenameTemplate.replace(/\{(date|workflow|model|seed|index|operation)\}/g, (_match, key: string) => values[key] ?? '')
      const stem = safeFilename(expanded, `asset-${index + 1}`)
      const extension = path.extname(source).toLowerCase()
      let suffix = 0
      while (suffix < 10_000) {
        const fileName = `${stem}${suffix === 0 ? '' : `-${suffix + 1}`}${extension}`
        const target = path.join(destination, fileName)
        try {
          await copyFile(source, target, constants.COPYFILE_EXCL)
          exported += 1
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          suffix += 1
        }
      }
      if (suffix >= 10_000) throw new StudioError('asset-export-conflict', `导出文件名冲突过多：${stem}`)
    }
    return exported
  }

  async saveMask(root: string, assetId: string, pngBase64: string): Promise<{ readonly relativePath: string; readonly width: number; readonly height: number }> {
    const source = (await this.list(root)).find((asset) => asset.id === assetId)
    if (!source) throw new StudioError('mask-source-missing', `蒙版源作品不存在：${assetId}`)
    const decoded = decodeMaskPng(pngBase64)
    if (source.width && source.height && (decoded.width !== source.width || decoded.height !== source.height)) {
      throw new StudioError('mask-dimensions-mismatch', `蒙版尺寸 ${decoded.width}×${decoded.height} 与源图 ${source.width}×${source.height} 不一致`)
    }
    const relativePath = `assets/masks/${safeFilename(assetId, 'asset')}-${crypto.randomUUID().slice(0, 12)}.png`
    const projectRoot = path.resolve(root)
    const assetsDirectory = await this.layout.managedDirectory(projectRoot, 'assets')
    const destination = this.resolve(projectRoot, relativePath)
    await ensureDirectory(path.dirname(destination))
    const [realAssets, realParent] = await Promise.all([realpath(assetsDirectory), realpath(path.dirname(destination))])
    resolveInside(realAssets, realParent)
    await atomicWriteFile(destination, decoded.bytes)
    return { relativePath, width: decoded.width, height: decoded.height }
  }

  async importImage(root: string, sourcePath: string): Promise<{ readonly relativePath: string; readonly width?: number; readonly height?: number }> {
    await this.layout.metadata(root)
    const source = path.resolve(sourcePath)
    const details = await lstat(source)
    if (details.isSymbolicLink() || !details.isFile()) throw new StudioError('image-import-file-invalid', '导入图片必须是普通文件，不能是符号链接')
    if (details.size < 1 || details.size > 128 * 1024 * 1024) throw new StudioError('image-import-size-invalid', '导入图片为空或超过 128 MiB')
    const bytes = await readFile(source)
    const mediaType = detectImage(bytes)
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const)[mediaType]
    const dimensions = imageDimensions(bytes, mediaType)
    const relativePath = `assets/imports/${safeFilename(path.parse(source).name, 'image')}-${crypto.randomUUID().slice(0, 12)}.${extension}`
    const projectRoot = path.resolve(root)
    const assetsDirectory = await this.layout.managedDirectory(projectRoot, 'assets')
    const destination = this.resolve(projectRoot, relativePath)
    await ensureDirectory(path.dirname(destination))
    const [realAssets, realParent] = await Promise.all([realpath(assetsDirectory), realpath(path.dirname(destination))])
    resolveInside(realAssets, realParent)
    await atomicWriteFile(destination, bytes)
    return { relativePath, ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}) }
  }

  async collections(root: string): Promise<CollectionSnapshot> {
    await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const raw = await readJson<unknown>(path.join(path.resolve(root), '.studio', 'collections.json'), emptyCollections)
    assertNoSecretFields(raw)
    const parsed = collectionSnapshotSchema.parse(raw)
    const ids = [...parsed.boards, ...parsed.smartCollections].map((item) => item.id)
    if (new Set(ids).size !== ids.length) throw new StudioError('collection-id-conflict', 'Board 与智能集合 ID 不能重复')
    if (ids.some((id) => reservedCollectionIds.has(id))) {
      throw new StudioError('collection-id-reserved', '集合文件使用了系统保留 ID')
    }
    return parsed as CollectionSnapshot
  }

  async upsertBoard(root: string, board: Board): Promise<Board> {
    return this.mutations.run(root, 'collections', () => this.#upsertBoardUnlocked(root, board))
  }

  async #upsertBoardUnlocked(root: string, board: Board): Promise<Board> {
    const parsed = boardSchema.parse(board) as Board
    if (reservedCollectionIds.has(parsed.id)) throw new StudioError('collection-id-reserved', '该 Board ID 为系统保留值')
    const snapshot = await this.collections(root)
    if (snapshot.smartCollections.some((item) => item.id === parsed.id)) {
      throw new StudioError('collection-id-conflict', '该 ID 已被智能集合使用')
    }
    const assetIds = [...new Set(parsed.assetIds)]
    const knownAssets = new Set((await this.list(root)).map((asset) => asset.id))
    const missing = assetIds.find((assetId) => !knownAssets.has(assetId))
    if (missing) throw new StudioError('collection-asset-missing', `Board 引用了不存在的作品：${missing}`)
    const normalized: Board = { ...parsed, assetIds }
    const boards = [...snapshot.boards]
    const index = boards.findIndex((item) => item.id === normalized.id)
    if (index >= 0) boards[index] = normalized
    else boards.push(normalized)
    await atomicWriteJson(path.join(path.resolve(root), '.studio', 'collections.json'), collectionSnapshotSchema.parse({
      ...snapshot,
      boards,
    }))
    return normalized
  }

  async deleteBoard(root: string, boardId: string): Promise<boolean> {
    return this.mutations.run(root, 'collections', async () => {
      const snapshot = await this.collections(root)
      const boards = snapshot.boards.filter((item) => item.id !== boardId)
      if (boards.length === snapshot.boards.length) return false
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'collections.json'), { ...snapshot, boards })
      return true
    })
  }

  async upsertSmartCollection(root: string, collection: SmartCollection): Promise<SmartCollection> {
    return this.mutations.run(root, 'collections', () => this.#upsertSmartCollectionUnlocked(root, collection))
  }

  async #upsertSmartCollectionUnlocked(root: string, collection: SmartCollection): Promise<SmartCollection> {
    const parsed = smartCollectionSchema.parse(collection) as SmartCollection
    if (reservedCollectionIds.has(parsed.id)) throw new StudioError('collection-id-reserved', '该智能集合 ID 为系统保留值')
    const snapshot = await this.collections(root)
    if (snapshot.boards.some((item) => item.id === parsed.id)) {
      throw new StudioError('collection-id-conflict', '该 ID 已被 Board 使用')
    }
    const normalized: SmartCollection = {
      ...parsed,
      models: [...new Set(parsed.models)],
      workflowIds: [...new Set(parsed.workflowIds)],
      tags: [...new Set(parsed.tags)],
    }
    const smartCollections = [...snapshot.smartCollections]
    const index = smartCollections.findIndex((item) => item.id === normalized.id)
    if (index >= 0) smartCollections[index] = normalized
    else smartCollections.push(normalized)
    await atomicWriteJson(path.join(path.resolve(root), '.studio', 'collections.json'), collectionSnapshotSchema.parse({
      ...snapshot,
      smartCollections,
    }))
    return normalized
  }

  async deleteSmartCollection(root: string, collectionId: string): Promise<boolean> {
    return this.mutations.run(root, 'collections', async () => {
      const snapshot = await this.collections(root)
      const smartCollections = snapshot.smartCollections.filter((item) => item.id !== collectionId)
      if (smartCollections.length === snapshot.smartCollections.length) return false
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'collections.json'), { ...snapshot, smartCollections })
      return true
    })
  }

  resolve(root: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/')
    if (!/^(?:assets|outputs)\//.test(normalized)) {
      throw new StudioError('asset-path-denied', '只允许访问项目 assets 或 outputs 目录')
    }
    return resolveInside(path.resolve(root), normalized)
  }

  async resolveExisting(root: string, relativePath: string): Promise<string> {
    const normalized = relativePath.replace(/\\/g, '/')
    const managedName = normalized.startsWith('assets/') ? 'assets' : normalized.startsWith('outputs/') ? 'outputs' : undefined
    if (!managedName) throw new StudioError('asset-path-denied', '只允许访问项目 assets 或 outputs 目录')
    const candidate = this.resolve(root, relativePath)
    const managedDirectory = await this.layout.managedDirectory(root, managedName)
    const [realManaged, realCandidate] = await Promise.all([realpath(managedDirectory), realpath(candidate)])
    resolveInside(realManaged, realCandidate)
    return realCandidate
  }

  async resolveOutput(root: string, relativePath: string): Promise<string> {
    const candidate = this.resolve(root, relativePath)
    if (!relativePath.replace(/\\/g, '/').startsWith('outputs/')) {
      throw new StudioError('output-path-denied', '生成结果只能写入 outputs 目录')
    }
    const outputsDirectory = await this.layout.managedDirectory(root, 'outputs')
    const [realOutputs, realParent] = await Promise.all([realpath(outputsDirectory), realpath(path.dirname(candidate))])
    resolveInside(realOutputs, realParent)
    return candidate
  }
}
