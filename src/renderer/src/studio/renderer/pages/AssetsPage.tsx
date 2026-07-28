import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '../components/Icon.js'
import { ArtPreview, IconButton, StatusPill } from '../components/Primitives.js'
import { StudioSelect } from '../components/StudioSelect.js'
import { useModalFocusTrap } from '../components/StudioModals.js'
import { assetMatchesBoard, useStudioStore } from '../store/studioStore.js'
import type { SmartCollection } from '@studio/shared/types.js'
import type { AssetItem, BoardItem } from '../types.js'

function AssetVisual({ asset }: { readonly asset: AssetItem }) {
  const ensurePreview = useStudioStore((state) => state.ensureAssetPreview)
  const reloadPreview = useStudioStore((state) => state.reloadAssetPreview)
  const retried = useRef(false)
  const [decoded, setDecoded] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(Boolean(!asset.previewUrl && asset.relativePath))
  useEffect(() => {
    retried.current = false
    setDecoded(false)
    if (asset.previewUrl || !asset.relativePath) {
      setPreviewLoading(false)
      return undefined
    }
    let active = true
    setPreviewLoading(true)
    void ensurePreview(asset.id).finally(() => { if (active) setPreviewLoading(false) })
    return () => { active = false }
  }, [asset.id, asset.previewUrl, asset.relativePath, ensurePreview])
  if (asset.previewUrl) return <div aria-busy={!decoded} className={`asset-image-wrap ${decoded ? 'is-decoded' : 'is-loading'}`}>{!decoded ? <span aria-label={`正在载入 ${asset.title}`} className="asset-image-skeleton" role="status" /> : null}<img alt={asset.title} decoding="async" loading="lazy" onError={() => { if (!retried.current) { retried.current = true; void reloadPreview(asset.id) } else setDecoded(true) }} onLoad={() => setDecoded(true)} src={asset.previewUrl} /></div>
  if (previewLoading) return <div aria-busy="true" className="asset-image-wrap is-loading"><span aria-label={`正在载入 ${asset.title}`} className="asset-image-skeleton" role="status" /></div>
  return <ArtPreview label={asset.title} tone={asset.tone} />
}

const splitValues = (value: string): readonly string[] => [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]
const ASSET_PAGE_SIZE = 48

function CollectionEditor({ initial, kind: initialKind, onClose }: { readonly initial?: BoardItem; readonly kind: BoardItem['kind']; onClose(): void }) {
  const upsertBoard = useStudioStore((state) => state.upsertBoard)
  const upsertSmartCollection = useStudioStore((state) => state.upsertSmartCollection)
  const deleteCollection = useStudioStore((state) => state.deleteCollection)
  const showToast = useStudioStore((state) => state.showToast)
  const [kind, setKind] = useState<BoardItem['kind']>(initial?.kind ?? initialKind)
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [favorite, setFavorite] = useState(initial?.favorite === undefined ? 'any' : String(initial.favorite))
  const [models, setModels] = useState(initial?.models?.join(', ') ?? '')
  const [workflows, setWorkflows] = useState(initial?.workflowIds?.join(', ') ?? '')
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '')
  const [dateFrom, setDateFrom] = useState(initial?.dateFrom ?? '')
  const [dateTo, setDateTo] = useState(initial?.dateTo ?? '')
  const focusTrap = useModalFocusTrap<HTMLDivElement>('[data-modal-initial-focus="true"]')
  const save = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return showToast('集合名称不能为空')
    if (dateFrom && dateTo && dateFrom > dateTo) return showToast('开始日期不能晚于结束日期')
    const id = initial?.id ?? `collection-${globalThis.crypto.randomUUID()}`
    if (kind === 'board') {
      await upsertBoard({ id, name: trimmed, description: description.trim(), assetIds: initial?.assetIds ?? [] })
    } else {
      const collection: SmartCollection = {
        id,
        name: trimmed,
        models: splitValues(models),
        workflowIds: splitValues(workflows),
        tags: splitValues(tags),
        ...(favorite === 'any' ? {} : { favorite: favorite === 'true' }),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
      }
      await upsertSmartCollection(collection)
    }
    onClose()
  }
  const remove = async (): Promise<void> => {
    if (!initial || initial.builtin || !window.confirm(`删除集合“${initial.name}”？原图不会被删除。`)) return
    await deleteCollection(initial.id, initial.kind)
    onClose()
  }
  return (
    <div aria-label="集合编辑器" aria-modal="true" className="collection-editor-overlay" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }} ref={focusTrap.dialogRef} role="dialog" tabIndex={-1}>
      <form className="collection-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <header><div><span className="eyebrow">REFERENCE ONLY</span><h2>{initial ? '编辑集合' : '新建集合'}</h2></div><IconButton icon="close" label="关闭" onClick={onClose} /></header>
        {!initial ? <label className="field"><span>类型</span><StudioSelect ariaLabel="类型" onChange={(nextValue) => setKind(nextValue as BoardItem['kind'])} options={[{ value: 'smart', label: '智能集合' }, { value: 'board', label: 'Board' }]} placeholder="选择类型" value={kind} /></label> : null}
        <label className="field"><span>名称</span><input data-modal-initial-focus="true" maxLength={160} onChange={(event) => setName(event.target.value)} value={name} /></label>
        {kind === 'board'
          ? <label className="field"><span>说明</span><textarea maxLength={2000} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} /></label>
          : <div className="collection-rule-grid"><label className="field"><span>收藏状态</span><StudioSelect ariaLabel="收藏状态" onChange={setFavorite} options={[{ value: 'any', label: '不限' }, { value: 'true', label: '已收藏' }, { value: 'false', label: '未收藏' }]} placeholder="选择收藏状态" value={favorite} /></label><label className="field"><span>模型</span><input onChange={(event) => setModels(event.target.value)} placeholder="用逗号分隔" value={models} /></label><label className="field"><span>工作流</span><input onChange={(event) => setWorkflows(event.target.value)} placeholder="用逗号分隔" value={workflows} /></label><label className="field"><span>标签（需全部命中）</span><input onChange={(event) => setTags(event.target.value)} placeholder="建筑, 雨夜" value={tags} /></label><label className="field"><span>开始日期</span><input onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} /></label><label className="field"><span>结束日期</span><input onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} /></label></div>}
        <p className="collection-editor-note"><Icon name="info" size={14} />集合仅保存作品 ID 引用，不会复制或删除原图。</p>
        <footer>{initial && !initial.builtin ? <button className="danger-text-button" onClick={() => void remove()} type="button"><Icon name="trash" size={14} />删除</button> : <span />}<div><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" type="submit"><Icon name="check" size={14} />保存</button></div></footer>
      </form>
    </div>
  )
}

function CollectionSidebar({ onClose }: { readonly onClose?: () => void }) {
  const boards = useStudioStore((state) => state.boards)
  const selected = useStudioStore((state) => state.selectedBoardId)
  const select = useStudioStore((state) => state.selectBoard)
  const [editor, setEditor] = useState<{ readonly kind: BoardItem['kind']; readonly item?: BoardItem }>()
  const collectionRow = (board: BoardItem) => <div className="collection-sidebar-row" key={board.id}><button className={selected === board.id ? 'is-active' : ''} onClick={() => { select(board.id); onClose?.() }} title={board.rule ?? board.description} type="button"><Icon name={board.kind === 'board' ? 'board' : board.id === 'favorites' ? 'star' : board.id === 'today' ? 'calendar' : 'spark'} size={15} /><span>{board.name}</span><small>{board.count}</small></button>{!board.builtin ? <IconButton icon="more" label={`编辑 ${board.name}`} onClick={() => setEditor({ kind: board.kind, item: board })} /> : null}</div>
  return (
    <aside className="collection-sidebar">
      <header><h2>作品组织</h2><div><IconButton icon="plus" label="新建智能集合" onClick={() => setEditor({ kind: 'smart' })} /><IconButton className="asset-compact-close" icon="close" label="关闭作品组织" onClick={onClose} /></div></header>
      <section><p className="sidebar-caption"><Icon name="spark" size={13} />智能集合</p>{boards.filter((item) => item.kind === 'smart').map(collectionRow)}<button className="sidebar-add-button" onClick={() => setEditor({ kind: 'smart' })} type="button"><Icon name="plus" size={14} />新建智能集合</button></section>
      <section><p className="sidebar-caption"><Icon name="board" size={13} />Boards</p>{boards.filter((item) => item.kind === 'board').map(collectionRow)}<button className="sidebar-add-button" onClick={() => setEditor({ kind: 'board' })} type="button"><Icon name="plus" size={14} />新建 Board</button></section>
      <footer><p><Icon name="info" size={13} />集合只保存引用，不会复制图片。磁盘用量由项目文件系统决定。</p></footer>
      {editor ? <CollectionEditor key={editor.item?.id ?? `new-${editor.kind}`} {...(editor.item ? { initial: editor.item } : {})} kind={editor.kind} onClose={() => setEditor(undefined)} /> : null}
    </aside>
  )
}

function DerivationTree({ asset }: { readonly asset: AssetItem }) {
  const assets = useStudioStore((state) => state.assets)
  const selectAsset = useStudioStore((state) => state.selectAsset)
  const family = useMemo(() => {
    const group = assets.filter((item) => item.candidateGroup === asset.candidateGroup)
    const byId = new Map(group.map((item) => [item.id, item]))
    const compare = (left: AssetItem, right: AssetItem): number => {
      const byCreatedAt = (left.createdAtIso ?? left.createdAt).localeCompare(right.createdAtIso ?? right.createdAt)
      return byCreatedAt || left.id.localeCompare(right.id)
    }
    const children = new Map<string, AssetItem[]>()
    group.forEach((item) => {
      if (!item.parentId || !byId.has(item.parentId)) return
      const siblings = children.get(item.parentId) ?? []
      siblings.push(item)
      children.set(item.parentId, siblings)
    })
    children.forEach((items) => items.sort(compare))
    const roots = group
      .filter((item) => !item.parentId || !byId.has(item.parentId))
      .sort(compare)
    const result: { readonly item: AssetItem; readonly depth: number }[] = []
    const visited = new Set<string>()
    const visit = (root: AssetItem): void => {
      const stack: { readonly item: AssetItem; readonly depth: number }[] = [{ item: root, depth: 0 }]
      while (stack.length > 0) {
        const entry = stack.pop()
        if (!entry || visited.has(entry.item.id)) continue
        visited.add(entry.item.id)
        result.push(entry)
        const nested = children.get(entry.item.id) ?? []
        for (let index = nested.length - 1; index >= 0; index -= 1) {
          const child = nested[index]
          if (child) stack.push({ item: child, depth: entry.depth + 1 })
        }
      }
    }
    roots.forEach(visit)
    group.filter((item) => !visited.has(item.id)).sort(compare).forEach(visit)
    return result
  }, [asset.candidateGroup, assets])
  const visibleFamily = useMemo(() => {
    if (family.length <= 2_000) return family
    const visible = family.slice(0, 1_999)
    const current = family.find(({ item }) => item.id === asset.id)
    if (current && !visible.some(({ item }) => item.id === current.item.id)) visible.push(current)
    return visible
  }, [asset.id, family])
  return (
    <div className="derivation-tree">
      {family.length > visibleFamily.length ? <p className="tree-limit-note">派生树共 {family.length.toLocaleString()} 项，为保持界面流畅仅显示前 {visibleFamily.length.toLocaleString()} 项（始终包含当前作品）。</p> : null}
      {visibleFamily.map(({ item, depth }) => (
        <button className={item.id === asset.id ? 'is-current' : ''} key={item.id} onClick={() => selectAsset(item.id)} style={{ marginLeft: Math.min(depth, 6) * 18 }} type="button">
          <span className={`tree-line ${depth > 0 ? 'has-parent' : ''}`} />
          <span className={`tree-thumb tone-${item.tone}`} />
          <span><strong>{item.title}</strong><small>{item.operation} · {item.createdAt}</small></span>
          {item.decision === 'adopted' ? <Icon name="check" size={13} /> : null}
        </button>
      ))}
    </div>
  )
}

function AssetInspector({ asset, onClose }: { readonly asset: AssetItem; readonly onClose?: () => void }) {
  const toggleFavorite = useStudioStore((state) => state.toggleFavorite)
  const setDecision = useStudioStore((state) => state.setCandidateDecision)
  const openModal = useStudioStore((state) => state.openModal)
  const updateTags = useStudioStore((state) => state.updateAssetTags)
  const requestTextInput = useStudioStore((state) => state.requestTextInput)
  const copyText = useStudioStore((state) => state.copyText)
  const reuseAsset = useStudioStore((state) => state.reuseAsset)
  const [tab, setTab] = useState<'details' | 'tree'>('details')
  const addTag = async (): Promise<void> => {
    const value = await requestTextInput({
      title: '添加标签',
      label: '标签名称',
      placeholder: '输入新标签',
      confirmLabel: '添加',
      maxLength: 60,
    })
    const tag = value?.trim()
    if (tag) await updateTags(asset.id, [...asset.tags, tag])
  }
  return (
    <aside className="asset-inspector">
      <header><div><span className="eyebrow">当前作品</span><h2>{asset.title}</h2></div><div><IconButton active={asset.favorite} icon="star" label={asset.favorite ? '取消收藏' : '收藏'} onClick={() => void toggleFavorite(asset.id)} /><IconButton className="asset-compact-close" icon="close" label="关闭作品详情" onClick={onClose} /></div></header>
      <AssetVisual asset={asset} />
      <div className="asset-inspector-actions"><button onClick={() => openModal('compare')} type="button"><Icon name="compare" size={14} />A/B 比较</button><button onClick={() => openModal('mask')} type="button"><Icon name="brush" size={14} />局部重绘</button></div>
      <div className="decision-bar"><button className={asset.decision === 'adopted' ? 'is-active adopt' : ''} onClick={() => void setDecision(asset.id, 'adopted')} type="button"><Icon name="check" size={14} />采用</button><button className={asset.decision === 'rejected' ? 'is-active reject' : ''} onClick={() => void setDecision(asset.id, 'rejected')} type="button"><Icon name="close" size={14} />拒绝</button></div>
      <div className="panel-tabs inspector-tabs" role="tablist"><button aria-selected={tab === 'details'} className={tab === 'details' ? 'is-active' : ''} onClick={() => setTab('details')} role="tab" type="button">详情</button><button aria-selected={tab === 'tree'} className={tab === 'tree' ? 'is-active' : ''} onClick={() => setTab('tree')} role="tab" type="button">派生树</button></div>
      <div className="asset-inspector-scroll">
        {tab === 'details' ? <><section><h3>复用到当前工作流</h3><div className="asset-reuse-actions"><button onClick={() => reuseAsset(asset.id, 'prompt')} type="button"><Icon name="copy" size={13} />仅提示词</button>{asset.seed !== undefined ? <button onClick={() => reuseAsset(asset.id, 'seed')} type="button"><Icon name="redo" size={13} />仅随机种子</button> : null}<button className="is-primary" onClick={() => reuseAsset(asset.id, 'all')} type="button"><Icon name="workflow" size={13} />全部参数</button></div><p className="section-copy">载入模型、尺寸及可用随机种子，不会立即发起远程请求。</p></section><section><h3>提示词</h3><p className="prompt-copy">{asset.prompt}</p><button className="text-button" onClick={() => void copyText(asset.prompt)} type="button"><Icon name="copy" size={13} />复制提示词</button>{asset.revisedPrompt && asset.revisedPrompt !== asset.prompt ? <div className="revised-prompt"><h3>模型服务修订的提示词</h3><p className="prompt-copy">{asset.revisedPrompt}</p><button className="text-button" onClick={() => void copyText(asset.revisedPrompt ?? '')} type="button"><Icon name="copy" size={13} />复制修订提示词</button></div> : null}</section><section><h3>生成参数</h3><dl className="metadata-list"><div><dt>模型</dt><dd>{asset.model}</dd></div><div><dt>尺寸</dt><dd>{asset.size}</dd></div><div><dt>随机种子</dt><dd>{asset.seed ?? '—'}</dd></div><div><dt>工作流</dt><dd>{asset.workflow}</dd></div><div><dt>操作</dt><dd>{asset.operation}</dd></div><div><dt>时间</dt><dd>{asset.createdAt}</dd></div></dl></section><section><h3>标签</h3><div className="tag-row">{asset.tags.map((tag) => <button key={tag} onClick={() => void updateTags(asset.id, asset.tags.filter((item) => item !== tag))} title="点击移除标签" type="button">#{tag}</button>)}<button className="add-tag" onClick={() => void addTag()} type="button"><Icon name="plus" size={12} />标签</button></div></section></> : <section><h3>候选与编辑关系</h3><p className="section-copy">沿父子关系追踪采用、重绘和扩图版本。</p><DerivationTree asset={asset} /></section>}
      </div>
    </aside>
  )
}

function AssetEmptyState({ libraryEmpty, onAction }: { readonly libraryEmpty: boolean; onAction(): void }) {
  return (
    <div className="asset-empty-state">
      <Icon name="image" size={24} />
      <strong>{libraryEmpty ? '还没有作品' : '没有匹配的作品'}</strong>
      <span>{libraryEmpty ? '运行一个工作流后，生成结果会自动出现在这里。' : '调整搜索或筛选条件，或者清除条件查看全部作品。'}</span>
      <button className="secondary-button" onClick={onAction} type="button">{libraryEmpty ? '前往工作流' : '清除筛选'}</button>
    </div>
  )
}

export function AssetsPage() {
  const browserRef = useRef<HTMLElement>(null)
  const assets = useStudioStore((state) => state.assets)
  const boards = useStudioStore((state) => state.boards)
  const selectedId = useStudioStore((state) => state.selectedAssetId)
  const selectedBoard = useStudioStore((state) => state.selectedBoardId)
  const selectAsset = useStudioStore((state) => state.selectAsset)
  const toggleFavorite = useStudioStore((state) => state.toggleFavorite)
  const openModal = useStudioStore((state) => state.openModal)
  const showToast = useStudioStore((state) => state.showToast)
  const updateAssetTags = useStudioStore((state) => state.updateAssetTags)
  const addAssetsToBoard = useStudioStore((state) => state.addAssetsToBoard)
  const exportAssets = useStudioStore((state) => state.exportAssets)
  const navigate = useStudioStore((state) => state.navigate)
  const selectBoard = useStudioStore((state) => state.selectBoard)
  const requestTextInput = useStudioStore((state) => state.requestTextInput)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [cardWidth, setCardWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('studio.assetCardWidth'))
      return Number.isFinite(saved) && saved >= 180 && saved <= 320 ? saved : 220
    } catch { return 220 }
  })
  const [selectedMany, setSelectedMany] = useState<readonly string[]>([])
  const [modelFilter, setModelFilter] = useState('all')
  const [workflowFilter, setWorkflowFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState('all')
  const [collectionOpen, setCollectionOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  useEffect(() => {
    const available = new Set(assets.map((asset) => asset.id))
    setSelectedMany((current) => {
      const next = current.filter((id) => available.has(id))
      return next.length === current.length ? current : next
    })
  }, [assets])
  const selectedBoardItem = boards.find((item) => item.id === selectedBoard)
  const today = new Date().toLocaleDateString('en-CA')
  const filtered = useMemo(() => assets.filter((asset) => assetMatchesBoard(asset, selectedBoardItem)
    && (modelFilter === 'all' || asset.model === modelFilter)
    && (workflowFilter === 'all' || asset.workflow === workflowFilter)
    && (dateFilter === 'all' || asset.createdAtIso?.slice(0, 10) === today || (!asset.createdAtIso && asset.createdAt.startsWith('今天')))
    && `${asset.title}${asset.prompt}${asset.model}${asset.workflow}${asset.tags.join('')}`.toLowerCase().includes(query.toLowerCase())), [assets, dateFilter, modelFilter, query, selectedBoardItem, today, workflowFilter])
  const pageCount = Math.max(1, Math.ceil(filtered.length / ASSET_PAGE_SIZE))
  const selectedIndex = filtered.findIndex((asset) => asset.id === selectedId)
  const [pageIndex, setPageIndex] = useState(() => selectedIndex >= 0 ? Math.floor(selectedIndex / ASSET_PAGE_SIZE) : 0)
  useEffect(() => {
    setPageIndex(selectedIndex >= 0 ? Math.floor(selectedIndex / ASSET_PAGE_SIZE) : 0)
  }, [dateFilter, modelFilter, query, selectedBoard, selectedId, selectedIndex, workflowFilter])
  useEffect(() => setPageIndex((current) => Math.min(current, pageCount - 1)), [pageCount])
  useEffect(() => { browserRef.current?.scrollTo?.({ top: 0 }) }, [pageIndex])
  useEffect(() => {
    try { window.localStorage.setItem('studio.assetCardWidth', String(cardWidth)) } catch { /* non-persistent renderer */ }
  }, [cardWidth])
  const pageStart = pageIndex * ASSET_PAGE_SIZE
  const visibleAssets = filtered.slice(pageStart, pageStart + ASSET_PAGE_SIZE)
  const selectedAsset = filtered.find((asset) => asset.id === selectedId) ?? filtered[0]
  const modelOptions = [...new Set(assets.map((asset) => asset.model))].sort()
  const workflowOptions = [...new Set(assets.map((asset) => asset.workflow))].sort()
  const exportIds = selectedMany.length > 0 ? selectedMany : filtered.map((asset) => asset.id)
  const batchFavorite = async (): Promise<void> => {
    const targets = assets.filter((asset) => selectedMany.includes(asset.id) && !asset.favorite)
    if (targets.length === 0) return showToast('所选作品已经全部收藏')
    await Promise.all(targets.map((asset) => toggleFavorite(asset.id)))
    showToast(`已收藏 ${targets.length} 个作品`)
  }
  const batchTags = async (): Promise<void> => {
    const input = await requestTextInput({
      title: '批量编辑标签',
      label: '标签（用逗号分隔；以 = 开头会替换原标签）',
      placeholder: '例如：建筑, 雨夜',
      confirmLabel: '更新标签',
      maxLength: 500,
    })
    if (!input?.trim()) return
    const replace = input.trim().startsWith('=')
    const tags = splitValues(replace ? input.trim().slice(1) : input)
    if (tags.length === 0) return showToast('没有可保存的标签')
    await Promise.all(assets.filter((asset) => selectedMany.includes(asset.id)).map((asset) => updateAssetTags(asset.id, replace ? tags : [...asset.tags, ...tags])))
    showToast(`已更新 ${selectedMany.length} 个作品的标签`)
  }
  const batchBoard = async (): Promise<void> => {
    const available = boards.filter((item) => item.kind === 'board')
    if (available.length === 0) return showToast('请先在左侧创建一个 Board')
    const input = await requestTextInput({
      title: '加入 Board',
      label: 'Board 名称',
      placeholder: available.map((item) => item.name).join('、'),
      confirmLabel: '加入',
      maxLength: 100,
    })
    if (!input?.trim()) return
    const board = available.find((item) => item.id === input.trim() || item.name.toLocaleLowerCase() === input.trim().toLocaleLowerCase())
    if (!board) return showToast('没有找到该 Board')
    await addAssetsToBoard(board.id, selectedMany)
  }
  const clearFilters = (): void => {
    setQuery('')
    setModelFilter('all')
    setWorkflowFilter('all')
    setDateFilter('all')
    selectBoard('all')
  }
  const closeCompactPanels = (): void => {
    setCollectionOpen(false)
    setInspectorOpen(false)
  }
  const openAsset = (assetId: string): void => {
    selectAsset(assetId)
    setCollectionOpen(false)
    setInspectorOpen(true)
  }
  return (
    <section className={`assets-page${collectionOpen ? ' is-collection-open' : ''}${inspectorOpen ? ' is-inspector-open' : ''}`}>
      <CollectionSidebar onClose={() => setCollectionOpen(false)} />
      <main className="asset-browser" ref={browserRef}>
        <div aria-label="作品页面板" className="asset-compact-toolbar" role="group"><button aria-expanded={collectionOpen} onClick={() => { setCollectionOpen((open) => !open); setInspectorOpen(false) }} type="button"><Icon name="board" size={14} />作品组织</button><button aria-expanded={inspectorOpen} disabled={!selectedAsset} onClick={() => { setInspectorOpen((open) => !open); setCollectionOpen(false) }} type="button"><Icon name="info" size={14} />作品详情</button></div>
        <header className="page-header asset-page-header"><div><span className="eyebrow">作品管理</span><h1>作品库</h1><p>{filtered.length} 个结果 · 原图不因集合分类而复制</p></div><div className="page-header-actions"><button className="secondary-button" disabled={assets.length < 2} onClick={() => openModal('compare')} type="button"><Icon name="compare" size={14} />比较</button><button className="secondary-button" disabled={exportIds.length === 0} onClick={() => void exportAssets(exportIds)} type="button"><Icon name="download" size={14} />批量导出</button></div></header>
        <div className="asset-filterbar"><label className="search-field"><Icon name="search" size={15} /><input aria-label="搜索作品" onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示词、模型或标签" value={query} /></label><label className="compact-filter"><Icon name="filter" size={14} /><span className="sr-only">模型</span><StudioSelect ariaLabel="按模型筛选" onChange={setModelFilter} options={[{ value: 'all', label: '全部模型' }, ...modelOptions.map((model) => ({ value: model, label: model }))]} placeholder="全部模型" value={modelFilter} /></label><label className="compact-filter"><Icon name="workflow" size={14} /><span className="sr-only">工作流</span><StudioSelect ariaLabel="按工作流筛选" onChange={setWorkflowFilter} options={[{ value: 'all', label: '全部工作流' }, ...workflowOptions.map((workflow) => ({ value: workflow, label: workflow }))]} placeholder="全部工作流" value={workflowFilter} /></label><label className="compact-filter"><Icon name="calendar" size={14} /><span className="sr-only">日期</span><StudioSelect ariaLabel="按日期筛选" onChange={setDateFilter} options={[{ value: 'all', label: '全部日期' }, { value: 'today', label: '今天' }]} placeholder="全部日期" value={dateFilter} /></label><span className="asset-filter-spacer" /><label className="asset-density-control" title="调整作品缩略图大小"><Icon name="image" size={13} /><input aria-label="作品缩略图大小" disabled={view === 'list'} max={320} min={180} onChange={(event) => setCardWidth(Number(event.target.value))} step={20} type="range" value={cardWidth} /></label><div className="view-switch"><IconButton active={view === 'grid'} icon="grid" label="网格视图" onClick={() => setView('grid')} /><IconButton active={view === 'list'} icon="list" label="列表视图" onClick={() => setView('list')} /></div></div>
        {selectedMany.length > 0 ? <div className="batch-actionbar"><strong>已选择 {selectedMany.length} 项</strong><button onClick={() => void batchFavorite()} type="button"><Icon name="star" size={14} />收藏</button><button onClick={() => void batchTags()} type="button"><Icon name="tag" size={14} />编辑标签</button><button onClick={() => void batchBoard()} type="button"><Icon name="board" size={14} />加入 Board</button><button onClick={() => void exportAssets(selectedMany)} type="button"><Icon name="download" size={14} />导出</button><button aria-label="清除选择" onClick={() => setSelectedMany([])} type="button"><Icon name="close" size={14} /></button></div> : null}
        <div className={`asset-grid view-${view}`} style={{ '--asset-card-min': `${cardWidth}px` } as CSSProperties}>
          {visibleAssets.map((asset) => (
            <article className={`asset-card ${selectedId === asset.id ? 'is-selected' : ''}`} key={asset.id}>
              <button aria-label={`查看作品：${asset.title}`} className="asset-card-open" onClick={() => openAsset(asset.id)} type="button" />
              <div className="asset-card-visual"><AssetVisual asset={asset} /><label className="asset-select-check"><input checked={selectedMany.includes(asset.id)} onChange={(event) => { const checked = event.target.checked; setSelectedMany((current) => checked ? [...new Set([...current, asset.id])] : current.filter((id) => id !== asset.id)) }} onClick={(event) => event.stopPropagation()} type="checkbox" /><span /></label><button aria-label={asset.favorite ? '取消收藏' : '收藏'} className={`asset-favorite ${asset.favorite ? 'is-active' : ''}`} onClick={(event) => { event.stopPropagation(); void toggleFavorite(asset.id) }} type="button"><Icon name="star" size={15} /></button><span className="asset-size">{asset.size}</span>{asset.parentId ? <span className="asset-derived"><Icon name="layers" size={12} />派生</span> : null}</div>
              <div className="asset-card-copy"><div><strong>{asset.title}</strong><StatusPill label={asset.decision === 'adopted' ? '采用' : asset.decision === 'rejected' ? '拒绝' : '候选'} status={asset.decision} /></div><p>{asset.prompt}</p><footer><span>{asset.model}</span><time>{asset.createdAt}</time></footer></div>
            </article>
          ))}
          {filtered.length === 0 ? <AssetEmptyState libraryEmpty={assets.length === 0} onAction={() => { if (assets.length === 0) navigate('workflow'); else clearFilters() }} /> : null}
        </div>
        {filtered.length > ASSET_PAGE_SIZE ? <nav aria-label="作品分页" className="asset-pagination"><button aria-label="上一页作品" disabled={pageIndex === 0} onClick={() => setPageIndex((current) => Math.max(0, current - 1))} type="button"><Icon name="chevron" size={14} />上一页</button><span aria-live="polite">第 {pageIndex + 1} / {pageCount} 页 · {pageStart + 1}–{Math.min(pageStart + ASSET_PAGE_SIZE, filtered.length)} / {filtered.length}</span><button aria-label="下一页作品" disabled={pageIndex >= pageCount - 1} onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))} type="button">下一页<Icon name="chevron" size={14} /></button></nav> : null}
      </main>
      {collectionOpen || inspectorOpen ? <button aria-label="关闭作品面板" className="asset-compact-scrim" onClick={closeCompactPanels} type="button" /> : null}
      {selectedAsset ? <AssetInspector asset={selectedAsset} onClose={() => setInspectorOpen(false)} /> : null}
    </section>
  )
}
