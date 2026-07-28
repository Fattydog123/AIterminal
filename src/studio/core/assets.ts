import type { Board, CandidateDecision, GeneratedAsset, SmartCollection } from '../shared/types.js'

export interface DerivationNode {
  readonly asset: GeneratedAsset
  readonly children: readonly DerivationNode[]
}

export const buildDerivationForest = (assets: readonly GeneratedAsset[]): readonly DerivationNode[] => {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  if (byId.size !== assets.length) throw new Error('候选版本 ID 重复')
  assets.forEach((asset) => {
    if (asset.parentAssetId) {
      const parent = byId.get(asset.parentAssetId)
      if (!parent) throw new Error(`候选版本缺少父级：${asset.parentAssetId}`)
      if (parent.candidateGroupId !== asset.candidateGroupId) throw new Error('父子候选必须属于同一候选组')
    }
  })

  const state = new Map<string, 1 | 2>()
  assets.forEach((asset) => {
    if (state.get(asset.id) === 2) return
    const chain: GeneratedAsset[] = []
    let current: GeneratedAsset | undefined = asset
    while (current && state.get(current.id) !== 2) {
      if (state.get(current.id) === 1) throw new Error('候选派生关系包含循环')
      state.set(current.id, 1)
      chain.push(current)
      current = current.parentAssetId ? byId.get(current.parentAssetId) : undefined
    }
    chain.forEach((item) => state.set(item.id, 2))
  })

  interface MutableDerivationNode {
    readonly asset: GeneratedAsset
    readonly children: MutableDerivationNode[]
  }
  const nodes = new Map<string, MutableDerivationNode>(
    assets.map((asset) => [asset.id, { asset, children: [] }]),
  )
  const roots: MutableDerivationNode[] = []
  assets.forEach((asset) => {
    const item = nodes.get(asset.id) as MutableDerivationNode
    if (asset.parentAssetId) (nodes.get(asset.parentAssetId) as MutableDerivationNode).children.push(item)
    else roots.push(item)
  })
  const compare = (left: MutableDerivationNode, right: MutableDerivationNode): number =>
    left.asset.createdAt.localeCompare(right.asset.createdAt) || left.asset.id.localeCompare(right.asset.id)
  roots.sort(compare)
  nodes.forEach((item) => item.children.sort(compare))
  return roots
}

const normalizeDate = (value: string, end = false): number => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const normalized = dateOnly ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) throw new Error(`无效日期：${value}`)
  return timestamp
}

export const matchesSmartCollection = (asset: GeneratedAsset, collection: SmartCollection): boolean => {
  validateSmartCollection(collection)
  if (collection.favorite !== undefined && asset.favorite !== collection.favorite) return false
  if (collection.models.length > 0 && !collection.models.includes(asset.model)) return false
  if (collection.workflowIds.length > 0 && !collection.workflowIds.includes(asset.workflowId)) return false
  if (collection.tags.length > 0 && !collection.tags.every((tag) => asset.tags.includes(tag))) return false
  const created = normalizeDate(asset.createdAt)
  if (collection.dateFrom && created < normalizeDate(collection.dateFrom)) return false
  if (collection.dateTo && created > normalizeDate(collection.dateTo, true)) return false
  return true
}

export const validateSmartCollection = (collection: SmartCollection): SmartCollection => {
  if (!collection.id.trim() || !collection.name.trim()) throw new Error('智能集合 ID 和名称不能为空')
  const from = collection.dateFrom ? normalizeDate(collection.dateFrom) : undefined
  const to = collection.dateTo ? normalizeDate(collection.dateTo, true) : undefined
  if (from !== undefined && to !== undefined && from > to) throw new Error('智能集合开始日期不能晚于结束日期')
  return collection
}

export const filterSmartCollection = (
  assets: readonly GeneratedAsset[],
  collection: SmartCollection,
): readonly GeneratedAsset[] => {
  validateSmartCollection(collection)
  return assets.filter((asset) => matchesSmartCollection(asset, collection))
}

export const setCandidateDecision = (
  assets: readonly GeneratedAsset[],
  assetId: string,
  decision: CandidateDecision,
): readonly GeneratedAsset[] => {
  const selected = assets.find((asset) => asset.id === assetId)
  if (!selected) throw new Error(`候选版本不存在：${assetId}`)
  return assets.map((asset) => {
    if (asset.id === assetId) return { ...asset, decision }
    if (decision === 'adopted' && asset.candidateGroupId === selected.candidateGroupId && asset.decision === 'adopted') {
      return { ...asset, decision: 'pending' }
    }
    return asset
  })
}

export const setAssetFavorite = (
  assets: readonly GeneratedAsset[],
  assetIds: readonly string[],
  favorite: boolean,
): readonly GeneratedAsset[] => {
  const selected = new Set(assetIds)
  const existing = new Set(assets.map((asset) => asset.id))
  const missing = [...selected].filter((id) => !existing.has(id))
  if (missing.length > 0) throw new Error(`作品不存在：${missing.join(', ')}`)
  return assets.map((asset) => selected.has(asset.id) ? { ...asset, favorite } : asset)
}

export const addAssetsToBoard = (board: Board, assetIds: readonly string[]): Board => ({
  ...board,
  assetIds: [...new Set([...board.assetIds, ...assetIds])],
})

export const removeAssetsFromBoard = (board: Board, assetIds: readonly string[]): Board => {
  const removed = new Set(assetIds)
  return { ...board, assetIds: board.assetIds.filter((id) => !removed.has(id)) }
}

const invalidFilename = /[<>:"/\\|?*\u0000-\u001f]+/g
const reservedNames = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)])

const safePart = (value: unknown): string => {
  let result = String(value ?? '').replace(invalidFilename, '_').replace(/\.\./g, '_').trim().replace(/[. ]+$/g, '')
  if (!result) result = 'untitled'
  if (reservedNames.has(result.split('.')[0]?.toUpperCase() ?? '')) result = `_${result}`
  return result.slice(0, 100)
}

export const renderSafeFilename = (
  template: string,
  values: Readonly<Record<string, unknown>>,
  maxLength = 240,
): string => {
  const allowed = new Set(['date', 'workflow', 'model', 'seed', 'prompt', 'id', 'ext', 'index'])
  const result = template.replace(/\{([a-z]+)\}/gi, (_, token: string) => {
    const normalizedToken = token.toLowerCase()
    if (!allowed.has(normalizedToken)) throw new Error(`不支持的文件名变量：${token}`)
    if (!(normalizedToken in values)) throw new Error(`缺少文件名变量：${normalizedToken}`)
    return safePart(values[normalizedToken])
  })
  const parts = result.split(/[\\/]+/).filter((part) => part && part !== '.' && part !== '..').map(safePart)
  if (parts.length === 0) throw new Error('文件名模板结果为空')
  let relative = parts.join('/')
  if (relative.length > maxLength) {
    const final = parts.at(-1) ?? 'output'
    const extensionIndex = final.lastIndexOf('.')
    const extension = extensionIndex > 0 ? final.slice(extensionIndex) : ''
    const budget = Math.max(1, maxLength - extension.length)
    relative = `${relative.slice(0, budget)}${extension}`
  }
  return relative
}
