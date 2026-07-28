import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { isGptImage2Model, supportsImageSeed } from '@studio/core/imageModels.js'
import { workflowTemplates, type WorkflowTemplateId } from '@studio/core/workflowTemplates.js'
import { Icon, type IconName } from './Icon.js'
import { ArtPreview, ExposureRail, Kbd, StatusPill } from './Primitives.js'
import { StudioSelect } from './StudioSelect.js'
import { useStudioStore } from '../store/studioStore.js'
import type { PageId } from '../types.js'
import { accountProviders, isAiTerminalAccountProvider, providerModelOptions } from '../providerSelection.js'

const modalFocusableSelector = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const getModalFocusable = (dialog: HTMLElement): readonly HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>('*')]
  .filter((element) => element.matches(modalFocusableSelector) && !element.hidden && element.getAttribute('aria-hidden') !== 'true')

const getModalRoot = (dialog: HTMLElement): Document | ShadowRoot => {
  const root = dialog.getRootNode()
  return root instanceof Document || root instanceof ShadowRoot ? root : document
}

function trapModalFocus(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const focusable = getModalFocusable(dialog)
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  const activeElement = getModalRoot(dialog).activeElement
  if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
    event.preventDefault()
    first.focus()
  }
}

export function useModalFocusTrap<T extends HTMLElement>(initialFocusSelector?: string): { readonly dialogRef: RefObject<T | null> } {
  const dialogRef = useRef<T>(null)
  const restoreTarget = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined
    const root = getModalRoot(dialog)
    const activeElement = root.activeElement
    restoreTarget.current = activeElement instanceof HTMLElement ? activeElement : null
    if (!dialog.contains(activeElement)) {
      const initialFocus = initialFocusSelector ? dialog.querySelector<HTMLElement>(initialFocusSelector) : undefined
      ;(initialFocus ?? getModalFocusable(dialog)[0] ?? dialog).focus()
    }
    const onKeyDown = (event: Event): void => trapModalFocus(dialog, event as KeyboardEvent)
    root.addEventListener('keydown', onKeyDown, true)
    return () => {
      root.removeEventListener('keydown', onKeyDown, true)
      const target = restoreTarget.current
      if (target?.isConnected) target.focus()
    }
  }, [initialFocusSelector])
  return { dialogRef }
}

function ModalFrame({ title, eyebrow, children, className = '', wide = false, initialFocusSelector }: { readonly title: string; readonly eyebrow: string; readonly children: ReactNode; readonly className?: string; readonly wide?: boolean; readonly initialFocusSelector?: string }) {
  const close = useStudioStore((state) => state.closeModal)
  const focusTrap = useModalFocusTrap<HTMLElement>(initialFocusSelector)
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close() }}>
      <section aria-labelledby="modal-title" aria-modal="true" className={`studio-modal ${wide ? 'is-wide' : ''} ${className}`} ref={focusTrap.dialogRef} role="dialog" tabIndex={-1}>
        <header className="modal-header"><div><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2></div><button aria-label="关闭" onClick={close} type="button"><Icon name="close" size={18} /></button></header>
        {children}
      </section>
    </div>
  )
}

function TextInputDialog() {
  const request = useStudioStore((state) => state.textInputRequest)
  const resolve = useStudioStore((state) => state.resolveTextInput)
  const [value, setValue] = useState(request?.initialValue ?? '')
  if (!request) return null
  const submit = (): void => {
    if (!value.trim()) return
    resolve(value)
  }
  return (
    <ModalFrame className="text-input-modal" eyebrow="STUDIO" initialFocusSelector="input" title={request.title}>
      <form
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          resolve()
        }}
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <div className="provider-form">
          <label className="field">
            <span>{request.label}</span>
            <input
              aria-label={request.label}
              maxLength={request.maxLength}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              value={value}
            />
          </label>
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" onClick={() => resolve()} type="button">取消</button>
          <button className="primary-button" disabled={!value.trim()} type="submit">{request.confirmLabel ?? '确定'}</button>
        </footer>
      </form>
    </ModalFrame>
  )
}

function ProjectPickerModal() {
  const projects = useStudioStore((state) => state.availableProjects)
  const currentProjectPath = useStudioStore((state) => state.projectPath)
  const openProject = useStudioStore((state) => state.openProject)
  const close = useStudioStore((state) => state.closeModal)
  const [openingPath, setOpeningPath] = useState<string>()
  const chooseProject = async (path: string): Promise<void> => {
    setOpeningPath(path)
    try {
      await openProject(path)
    } finally {
      setOpeningPath(undefined)
    }
  }
  return (
    <ModalFrame className="project-picker-modal" eyebrow="STUDIO" title="打开项目">
      <div className="project-picker-list" role="list">
        {projects.map((project) => {
          const current = project.path === currentProjectPath
          const opening = project.path === openingPath
          const updatedAt = new Date(project.updatedAt)
          const updatedLabel = Number.isNaN(updatedAt.getTime())
            ? ''
            : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(updatedAt)
          return (
            <button
              aria-current={current ? 'true' : undefined}
              className={current ? 'is-current' : ''}
              disabled={Boolean(openingPath)}
              key={project.id}
              onClick={() => void chooseProject(project.path)}
              role="listitem"
              type="button"
            >
              <span className="project-picker-icon"><Icon name="folder" size={17} /></span>
              <span className="project-picker-copy"><strong>{project.name}</strong><small>{project.workflowCount} 个工作流 · {project.assetCount} 个作品</small></span>
              <span className="project-picker-meta">{opening ? '正在打开' : current ? '当前项目' : updatedLabel}</span>
              <Icon name="chevron" size={14} />
            </button>
          )
        })}
      </div>
      <footer className="modal-footer"><button className="secondary-button" onClick={close} type="button">取消</button></footer>
    </ModalFrame>
  )
}

type StudioCommandAction = 'create-project' | 'open-project'

const commands: readonly { readonly title: string; readonly detail: string; readonly icon: IconName; readonly key?: string; readonly page?: PageId; readonly modal?: 'prompt-matrix' | 'compare' | 'mask'; readonly action?: StudioCommandAction }[] = [
  { title: '运行当前工作流', detail: '先生成计划与费用风险，再确认派发', icon: 'play', key: 'Ctrl ↵' },
  { title: '创建项目', detail: '在默认 Studio 工作区中创建项目', icon: 'plus', action: 'create-project' },
  { title: '打开项目', detail: '打开默认 Studio 工作区中的项目', icon: 'folder', action: 'open-project' },
  { title: '打开批量生成', detail: '按提示词、模型、尺寸与随机种子组合任务', icon: 'matrix', modal: 'prompt-matrix' },
  { title: '进入作品库', detail: '浏览候选、派生树与智能集合', icon: 'image', key: 'G A', page: 'assets' },
  { title: '打开任务', detail: '管理全部任务队列、派发与取消', icon: 'queue', page: 'queue' },
  { title: '查看运行记录', detail: '查看运行诊断、阶段耗时与脱敏事件', icon: 'pulse', page: 'runs' },
  { title: '图片前后比较', detail: '使用可拖动擦拭滑杆', icon: 'compare', modal: 'compare' },
  { title: '打开 Mask Editor', detail: '绘制局部重绘蒙版', icon: 'brush', modal: 'mask' },
]

function CommandPalette() {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const close = useStudioStore((state) => state.closeModal)
  const navigate = useStudioStore((state) => state.navigate)
  const open = useStudioStore((state) => state.openModal)
  const run = useStudioStore((state) => state.runWorkflow)
  const createProject = useStudioStore((state) => state.createProject)
  const openProject = useStudioStore((state) => state.openProject)
  const requestTextInput = useStudioStore((state) => state.requestTextInput)
  const focusTrap = useModalFocusTrap<HTMLElement>()
  const filtered = commands.filter((command) => `${command.title}${command.detail}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => setActiveIndex(0), [query])
  const activate = (command: (typeof commands)[number]) => {
    if (command.page) navigate(command.page)
    if (command.modal) open(command.modal)
    else close()
    if (command.title.startsWith('运行当前')) void run()
    if (command.action === 'open-project') void openProject()
    if (command.action === 'create-project') {
      void requestTextInput({
        title: '创建项目',
        label: '项目名称',
        initialValue: '未命名项目',
        placeholder: '输入项目名称',
        confirmLabel: '创建项目',
        maxLength: 80,
      }).then((value) => {
        const name = value?.trim()
        if (name) void createProject(name)
      })
    }
  }
  return (
    <div className="modal-backdrop command-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close() }}>
      <section aria-label="命令面板" aria-modal="true" className="command-palette" ref={focusTrap.dialogRef} role="dialog" tabIndex={-1}>
        <label>
          <Icon name="command" size={20} />
          <input
            aria-activedescendant={filtered[activeIndex] ? `command-option-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls="command-results"
            aria-expanded="true"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => filtered.length ? (index + 1) % filtered.length : 0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0)
              } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
                const command = filtered[activeIndex]
                if (command) { event.preventDefault(); activate(command) }
              }
            }}
            placeholder="搜索命令、页面或节点…"
            role="combobox"
            value={query}
          />
          <Kbd>Esc</Kbd>
        </label>
        <div className="command-results" id="command-results" role="listbox">
          <p>建议</p>
          {filtered.map((command, index) => (
            <button aria-selected={index === activeIndex} className={index === activeIndex ? 'is-active' : ''} id={`command-option-${index}`} key={command.title} onClick={() => activate(command)} onMouseEnter={() => setActiveIndex(index)} role="option" type="button">
              <span className="command-icon"><Icon name={command.icon} size={17} /></span>
              <span><strong>{command.title}</strong><small>{command.detail}</small></span>
              {command.key ? <Kbd>{command.key}</Kbd> : <Icon name="chevron" size={13} />}
              {index === 0 && query ? <em>最佳匹配</em> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="command-empty"><Icon name="search" size={24} /><p>没有匹配的命令</p></div> : null}
        </div>
        <footer><span><Kbd>↑↓</Kbd> 选择</span><span><Kbd>↵</Kbd> 打开</span><span><Kbd>Ctrl K</Kbd> 切换</span></footer>
      </section>
    </div>
  )
}

function PromptMatrixModal() {
  const [prompts, setPrompts] = useState('雨夜里的未来主义茶室\n清晨薄雾中的未来主义茶室')
  const providers = useStudioStore((state) => state.providers)
  const graphs = useStudioStore((state) => state.graphs)
  const activeGraphId = useStudioStore((state) => state.activeGraphId)
  const activeGraph = graphs[activeGraphId] ?? graphs.root
  const boundProviderId = activeGraph?.nodes
    .map((node) => String(node.data.parameters.providerId ?? '').trim())
    .find(Boolean)
  const selectedProvider = accountProviders(providers).find((provider) => provider.id === boundProviderId)
    ?? accountProviders(providers)[0]
  const availableModels = selectedProvider && isAiTerminalAccountProvider(selectedProvider)
    ? providerModelOptions(selectedProvider)
    : []
  const availableModelText = availableModels.join('\n')
  const [models, setModels] = useState(() => availableModelText)
  const initializedProviderId = useRef(selectedProvider?.id ?? '')
  useEffect(() => {
    const providerId = selectedProvider?.id ?? ''
    if (initializedProviderId.current !== providerId) {
      initializedProviderId.current = providerId
      setModels(availableModelText)
      return
    }
    if (availableModelText) setModels((current) => current.trim() ? current : availableModelText)
  }, [availableModelText, selectedProvider?.id])
  const [sizes, setSizes] = useState('1536x1024')
  const [seeds, setSeeds] = useState('842019\n842020')
  const [costPerImageInput, setCostPerImageInput] = useState('')
  const [maxEstimatedCostInput, setMaxEstimatedCostInput] = useState('')
  const close = useStudioStore((state) => state.closeModal)
  const prepare = useStudioStore((state) => state.preparePromptMatrix)
  const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean)
  const dimensions = [lines(prompts), lines(models), lines(sizes), lines(seeds)]
  const counts = dimensions.map((values) => values.length)
  const uniqueModels = [...new Set(dimensions[1] ?? [])]
  const includesSeedlessModel = uniqueModels.some((model) => !supportsImageSeed(model))
  const rawTasks = counts.some((count) => count === 0) ? 0 : counts.reduce((total, count) => total * count, 1)
  const seedAwareModelFactor = uniqueModels.reduce((total, model) => total + (supportsImageSeed(model) ? counts[3] ?? 0 : 1), 0)
  const tasks = (counts[0] ?? 0) * (counts[2] ?? 0) * seedAwareModelFactor
  const removedTasks = Math.max(0, rawTasks - tasks)
  const costPerImage = costPerImageInput.trim() ? Number(costPerImageInput) : undefined
  const maxEstimatedCost = maxEstimatedCostInput.trim() ? Number(maxEstimatedCostInput) : undefined
  const invalidCostPerImage = costPerImage !== undefined && (!Number.isFinite(costPerImage) || costPerImage < 0)
  const invalidMaxEstimatedCost = maxEstimatedCost !== undefined && (!Number.isFinite(maxEstimatedCost) || maxEstimatedCost < 0)
  const estimatedCost = costPerImage === undefined || invalidCostPerImage ? undefined : tasks * costPerImage
  const budgetExceeded = estimatedCost !== undefined && maxEstimatedCost !== undefined && !invalidMaxEstimatedCost && estimatedCost > maxEstimatedCost
  const risk = tasks > 32 ? 'high' : tasks > 12 ? 'medium' : 'low'
  return (
    <ModalFrame className="matrix-modal" eyebrow="批量任务" title="批量生成" wide>
      <div className="matrix-layout"><main><div className="matrix-field-grid"><label className="field"><span>提示词变量 <em>{counts[0]}</em></span><textarea onChange={(event) => setPrompts(event.target.value)} rows={6} value={prompts} /><small>每行一个候选</small></label><label className="field"><span>模型 <em>{counts[1]}</em></span><textarea onChange={(event) => setModels(event.target.value)} rows={6} value={models} /><small>必须存在于对应模型分组；重复行会去重</small></label><label className="field"><span>尺寸 <em>{counts[2]}</em></span><textarea onChange={(event) => setSizes(event.target.value)} rows={5} value={sizes} /></label><label className="field"><span>随机种子 <em>{counts[3]}</em></span><textarea onChange={(event) => setSeeds(event.target.value)} rows={5} value={seeds} /><small>{includesSeedlessModel ? '当前图片模型不支持随机种子；预检会自动去重重复组合' : '每行一个整数'}</small></label></div><section className="matrix-preview"><header><div><h3>任务展开预览</h3><p>提示词 × 模型 × 尺寸 × 随机种子</p></div><span>{tasks} 个任务</span></header><div className="matrix-mini-grid">{Array.from({ length: Math.min(tasks, 24) }, (_, index) => <span className={`tone-${['copper', 'jade', 'blue', 'rose'][index % 4]}`} key={index}><small>{index + 1}</small></span>)}</div></section></main><aside><section className={`risk-meter risk-${risk}`}><span className="risk-dial"><strong>{tasks}</strong><small>实际任务</small></span><div><h3>{risk === 'high' ? '任务数较多' : risk === 'medium' ? '请核对任务数' : '任务数可控'}</h3><p>模型服务未提供单图价格。{removedTasks > 0 ? `已排除 ${removedTasks} 个重复或无效组合。` : ''}</p></div></section><dl className="matrix-equation"><div><dt>提示词</dt><dd>{counts[0]}</dd></div><div><dt>模型</dt><dd>× {counts[1]}</dd></div><div><dt>尺寸</dt><dd>× {counts[2]}</dd></div><div><dt>随机种子</dt><dd>× {counts[3]}</dd></div><div><dt>实际远程任务</dt><dd>{tasks}</dd></div></dl><div className="safety-note"><Icon name="info" size={17} /><p><strong>运行前会显示任务内容</strong><span>每个组合独立运行；失败项不自动重试。</span></p></div></aside></div>
      <section aria-label="用户费用估算" className={`matrix-cost-panel ${budgetExceeded ? 'is-over-budget' : ''}`}>
        <header><div><h3>费用估算（可选）</h3><p>可按模型服务给出的价格填写。</p></div>{budgetExceeded ? <span role="alert">估算超过费用上限</span> : null}</header>
        <div className="matrix-cost-fields">
          <label className="field"><span>单图费用估算</span><input aria-invalid={invalidCostPerImage || undefined} aria-label="单图费用估算（可选，单位自定）" min="0" onChange={(event) => setCostPerImageInput(event.target.value)} placeholder="例如 0.04" step="any" type="number" value={costPerImageInput} /><small>可使用元、美元、积分等任意单位。</small></label>
          <label className="field"><span>费用风险上限</span><input aria-invalid={invalidMaxEstimatedCost || undefined} aria-label="费用风险上限（可选，同单位）" min="0" onChange={(event) => setMaxEstimatedCostInput(event.target.value)} placeholder="例如 2.00" step="any" type="number" value={maxEstimatedCostInput} /><small>与单图费用使用相同单位；超过时不允许预检。</small></label>
          <dl><div><dt>{tasks} 个任务的总费用</dt><dd aria-live="polite">{estimatedCost === undefined ? '模型服务未提供' : `估算 ${estimatedCost.toFixed(2)}（单位同输入）`}</dd></div></dl>
        </div>
      </section>
      <footer className="modal-footer">
        <button className="secondary-button" onClick={close} type="button">取消</button>
        <button
          className="primary-button"
          disabled={tasks < 1 || tasks > 32 || invalidCostPerImage || invalidMaxEstimatedCost || budgetExceeded || dimensions[3]?.some((value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0)}
          onClick={() => {
            close()
            void prepare({
              prompts: dimensions[0] ?? [],
              models: dimensions[1] ?? [],
              sizes: dimensions[2] ?? [],
              seeds: (dimensions[3] ?? []).map(Number),
              ...(costPerImage === undefined ? {} : { costPerImage }),
              ...(maxEstimatedCost === undefined ? {} : { maxEstimatedCost }),
            })
          }}
          type="button"
        ><Icon name="play" size={14} />生成 {tasks} 个执行计划</button>
      </footer>
    </ModalFrame>
  )
}

function CompareModal() {
  const assets = useStudioStore((state) => state.assets)
  const selectedAssetId = useStudioStore((state) => state.selectedAssetId)
  const exportAssets = useStudioStore((state) => state.exportAssets)
  const ensurePreview = useStudioStore((state) => state.ensureAssetPreview)
  const reloadPreview = useStudioStore((state) => state.reloadAssetPreview)
  const leftRetried = useRef(false)
  const rightRetried = useRef(false)
  const [position, setPosition] = useState(52)
  const [mode, setMode] = useState<'wipe' | 'side' | 'blink'>('wipe')
  const initialLeft = assets.find((asset) => asset.id === selectedAssetId) ?? assets[0]
  const initialRight = assets.find((asset) => asset.parentId === initialLeft?.id) ?? assets.find((asset) => asset.id !== initialLeft?.id)
  const [leftId, setLeftId] = useState(initialLeft?.id ?? '')
  const [rightId, setRightId] = useState(initialRight?.id ?? '')
  const [blinkRight, setBlinkRight] = useState(false)
  const [assetQuery, setAssetQuery] = useState('')
  const left = assets.find((asset) => asset.id === leftId) ?? assets[0]
  const right = assets.find((asset) => asset.id === rightId && asset.id !== left?.id) ?? assets.find((asset) => asset.id !== left?.id)
  const compareOptions = useMemo(() => {
    const query = assetQuery.trim().toLocaleLowerCase()
    const sameGroups = new Set([left?.candidateGroup, right?.candidateGroup].filter((value): value is string => Boolean(value)))
    const source = query
      ? assets.filter((asset) => `${asset.title}\n${asset.prompt}\n${asset.model}\n${asset.workflow}\n${asset.tags.join(' ')}`.toLocaleLowerCase().includes(query))
      : [...assets.filter((asset) => sameGroups.has(asset.candidateGroup)), ...[...assets].reverse()]
    const result = [] as typeof assets[number][]
    const seen = new Set<string>()
    for (const candidate of [left, right, ...source]) {
      if (!candidate || seen.has(candidate.id)) continue
      seen.add(candidate.id)
      result.push(candidate)
      if (result.length >= 250) break
    }
    return result
  }, [assetQuery, assets, left, right])
  useEffect(() => {
    if (left) void ensurePreview(left.id)
    if (right) void ensurePreview(right.id)
  }, [ensurePreview, left?.id, right?.id])
  useEffect(() => { leftRetried.current = false }, [left?.id])
  useEffect(() => { rightRetried.current = false }, [right?.id])
  useEffect(() => {
    if (assets.length < 2) return
    const normalizedLeft = assets.find((asset) => asset.id === leftId) ?? assets[0]
    const normalizedRight = assets.find((asset) => asset.id === rightId && asset.id !== normalizedLeft?.id)
      ?? assets.find((asset) => asset.id !== normalizedLeft?.id)
    if (normalizedLeft && normalizedLeft.id !== leftId) setLeftId(normalizedLeft.id)
    if (normalizedRight && normalizedRight.id !== rightId) setRightId(normalizedRight.id)
  }, [assets, leftId, rightId])
  useEffect(() => {
    if (mode !== 'blink') return undefined
    const timer = window.setInterval(() => setBlinkRight((value) => !value), 650)
    return () => window.clearInterval(timer)
  }, [mode])
  const visual = (asset: typeof left, label: string, retried: { current: boolean }) => asset?.previewUrl
    ? <img alt={label} draggable={false} onError={() => { if (!retried.current) { retried.current = true; void reloadPreview(asset.id) } }} src={asset.previewUrl} />
    : <ArtPreview label={label} tone={asset?.tone ?? 'mono'} />
  if (!left || !right || left.id === right.id) {
    return <ModalFrame className="compare-modal" eyebrow="A / B PROOF" title="候选擦拭比较" wide><div className="command-empty"><Icon name="image" size={24} /><p>至少需要两个作品才能比较。</p></div></ModalFrame>
  }
  return (
    <ModalFrame className="compare-modal" eyebrow="A / B PROOF" title="候选擦拭比较" wide>
      <div className="compare-toolbar"><div><button className={mode === 'wipe' ? 'is-active' : ''} onClick={() => setMode('wipe')} type="button">擦拭</button><button className={mode === 'side' ? 'is-active' : ''} onClick={() => setMode('side')} type="button">并排</button><button className={mode === 'blink' ? 'is-active' : ''} onClick={() => setMode('blink')} type="button">闪烁</button></div><label>A <StudioSelect ariaLabel="候选 A" onChange={(next) => { setLeftId(next); if (next === rightId) setRightId(compareOptions.find((asset) => asset.id !== next)?.id ?? assets.find((asset) => asset.id !== next)?.id ?? '') }} options={compareOptions.map((asset) => ({ value: asset.id, label: asset.title, disabled: asset.id === right.id }))} placeholder="选择候选 A" value={left.id} /></label><Icon name="compare" size={16} /><label>B <StudioSelect ariaLabel="候选 B" onChange={(next) => { setRightId(next); if (next === leftId) setLeftId(compareOptions.find((asset) => asset.id !== next)?.id ?? assets.find((asset) => asset.id !== next)?.id ?? '') }} options={compareOptions.map((asset) => ({ value: asset.id, label: asset.title, disabled: asset.id === left.id }))} placeholder="选择候选 B" value={right.id} /></label></div>
      <label className="compare-filter"><Icon name="search" size={13} /><input aria-label="搜索比较候选" onChange={(event) => setAssetQuery(event.target.value)} placeholder="搜索标题、提示词、模型、工作流或标签" value={assetQuery} /><span>显示 {compareOptions.length} / {assets.length}</span></label>
      {mode === 'side'
        ? <div className="compare-stage compare-side"><div>{visual(left, `候选 A：${left.title}`, leftRetried)}<span>A · {left.title}</span></div><div>{visual(right, `候选 B：${right.title}`, rightRetried)}<span>B · {right.title}</span></div></div>
        : <div className="compare-stage"><div className="compare-layer compare-before">{visual(left, `候选 A：${left.title}`, leftRetried)}<span>A · {left.title}</span></div><div className="compare-layer compare-after" style={{ clipPath: mode === 'blink' ? (blinkRight ? 'inset(0)' : 'inset(0 100% 0 0)') : `inset(0 0 0 ${position}%)` }}>{visual(right, `候选 B：${right.title}`, rightRetried)}<span>B · {right.title}</span></div>{mode === 'wipe' ? <><div className="compare-divider" style={{ left: `${position}%` }}><i><Icon name="compare" size={17} /></i></div><input aria-label="图片比较位置" max={100} min={0} onChange={(event) => setPosition(Number(event.target.value))} type="range" value={position} /></> : null}</div>}
      <div className="compare-metadata"><div><strong>候选 A</strong><span>{left.model} · seed {left.seed ?? '—'} · {left.operation}</span><StatusPill label={left.decision === 'adopted' ? '已采用' : left.decision === 'rejected' ? '已拒绝' : '待决定'} status={left.decision} /></div><div><strong>候选 B</strong><span>{right.model} · seed {right.seed ?? '—'} · {right.operation}</span><StatusPill label={right.decision === 'adopted' ? '已采用' : right.decision === 'rejected' ? '已拒绝' : '待决定'} status={right.decision} /></div></div>
      <footer className="modal-footer"><span>{mode === 'wipe' ? '拖动滑杆检查结构、光影与细节差异。' : mode === 'side' ? '并排查看两张原始作品。' : '以 650ms 间隔闪烁检查细微变化。'}</span><button className="secondary-button" onClick={() => void exportAssets([...new Set([left.id, right.id])])} type="button"><Icon name="download" size={14} />导出 A/B 原图</button></footer>
    </ModalFrame>
  )
}

const MAX_MASK_PIXELS = 16_777_216
const MAX_MASK_UNDO_BYTES = 96 * 1024 * 1024

function MaskModal() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const history = useRef<ImageData[]>([])
  const [brush, setBrush] = useState(42)
  const [erase, setErase] = useState(false)
  const [feather, setFeather] = useState(12)
  const [historyCount, setHistoryCount] = useState(0)
  const [hasMask, setHasMask] = useState(false)
  const [prompt, setPrompt] = useState('增强选区内的光影与材质，保持其余结构不变')
  const [inputFidelity, setInputFidelity] = useState<'low' | 'high'>('high')
  const [applying, setApplying] = useState(false)
  const assets = useStudioStore((state) => state.assets)
  const selectedAssetId = useStudioStore((state) => state.selectedAssetId)
  const applyMask = useStudioStore((state) => state.createInpaintFromAsset)
  const showToast = useStudioStore((state) => state.showToast)
  const ensurePreview = useStudioStore((state) => state.ensureAssetPreview)
  const reloadPreview = useStudioStore((state) => state.reloadAssetPreview)
  const previewRetried = useRef(false)
  const asset = assets.find((item) => item.id === selectedAssetId) ?? assets[0]
  useEffect(() => {
    if (asset) void ensurePreview(asset.id)
  }, [asset?.id, ensurePreview])
  useEffect(() => { previewRetried.current = false }, [asset?.id])
  const dimensions = asset?.size.match(/^(\d+)×(\d+)$/)
  const sourceWidth = Number(dimensions?.[1] ?? 0)
  const sourceHeight = Number(dimensions?.[2] ?? 0)
  const hasKnownDimensions = Boolean(dimensions)
    && Number.isSafeInteger(sourceWidth) && Number.isSafeInteger(sourceHeight)
    && sourceWidth > 0 && sourceHeight > 0
  const dimensionsSupported = hasKnownDimensions && sourceWidth <= 16_384 && sourceHeight <= 16_384
  const pixelCount = dimensionsSupported ? sourceWidth * sourceHeight : 0
  const gptImage2SourceNeedsPng = Boolean(asset && isGptImage2Model(asset.model)
    && asset.relativePath && !asset.relativePath.toLowerCase().endsWith('.png'))
  const canEditMask = dimensionsSupported && pixelCount <= MAX_MASK_PIXELS && !gptImage2SourceNeedsPng
  const width = canEditMask ? sourceWidth : 1
  const height = canEditMask ? sourceHeight : 1
  const undoLimit = canEditMask ? Math.max(1, Math.min(10, Math.floor(MAX_MASK_UNDO_BYTES / (pixelCount * 4)))) : 0
  const maskWarning = !asset
    ? '没有可编辑的作品。'
    : !hasKnownDimensions
      ? '作品缺少可信的像素尺寸，内置编辑器不会猜测尺寸；请从工作流导入同尺寸 PNG 蒙版。'
      : !dimensionsSupported
        ? '作品尺寸无效或单边超过 16384 px，无法创建安全画布。'
        : gptImage2SourceNeedsPng
          ? 'GPT Image 2 要求源图与含 Alpha 的蒙版格式一致；当前源图不是 PNG，请先导入或生成 PNG 版本。'
        : !canEditMask
          ? `作品共 ${pixelCount.toLocaleString('zh-CN')} 像素，超过内置编辑器 16,777,216 像素的内存安全上限；请使用外部蒙版。`
          : undefined
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.clearRect(0, 0, width, height)
    history.current = []
    setHistoryCount(0)
    setHasMask(false)
  }, [height, width])
  const selectionExists = (data: ImageData): boolean => {
    for (let index = 3; index < data.data.length; index += 4) if ((data.data[index] ?? 0) > 0) return true
    return false
  }
  const saveUndoPoint = (): void => {
    const context = canvasRef.current?.getContext('2d')
    if (!context || !canEditMask || undoLimit < 1) return
    const retained = undoLimit > 1 ? history.current.slice(1 - undoLimit) : []
    history.current = [...retained, context.getImageData(0, 0, width, height)]
    setHistoryCount(history.current.length)
  }
  const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !canEditMask) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = width / rect.width
    const scaleY = height / rect.height
    const x = (event.clientX - rect.left) * scaleX
    const y = (event.clientY - rect.top) * scaleY
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
    context.fillStyle = 'rgba(127, 199, 255, 1)'
    context.shadowColor = erase ? 'transparent' : 'rgba(127, 199, 255, .28)'
    context.shadowBlur = erase ? 0 : feather * Math.max(scaleX, scaleY)
    context.beginPath()
    context.arc(x, y, (brush / 2) * Math.max(scaleX, scaleY), 0, Math.PI * 2)
    context.fill()
    setHasMask(true)
  }
  const clear = (): void => {
    const context = canvasRef.current?.getContext('2d')
    if (!context) return
    saveUndoPoint()
    context.clearRect(0, 0, width, height)
    setHasMask(false)
  }
  const undo = (): void => {
    const previous = history.current.at(-1)
    const context = canvasRef.current?.getContext('2d')
    if (!previous || !context) return
    context.putImageData(previous, 0, 0)
    history.current = history.current.slice(0, -1)
    setHistoryCount(history.current.length)
    setHasMask(selectionExists(previous))
  }
  const submit = async (): Promise<void> => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!asset || !canvas || !context) return showToast('没有可编辑的作品')
    if (!canEditMask) return showToast(maskWarning ?? '当前作品无法安全创建蒙版')
    if (!prompt.trim()) return showToast('编辑提示词不能为空')
    const selection = context.getImageData(0, 0, width, height)
    if (!hasMask || !selectionExists(selection)) return showToast('请先绘制至少一个局部重绘选区')
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = width
    maskCanvas.height = height
    const maskContext = maskCanvas.getContext('2d')
    if (!maskContext) return showToast('无法创建 PNG 蒙版')
    const output = maskContext.createImageData(width, height)
    for (let index = 0; index < output.data.length; index += 4) {
      output.data[index] = 255
      output.data[index + 1] = 255
      output.data[index + 2] = 255
      output.data[index + 3] = 255 - (selection.data[index + 3] ?? 0)
    }
    maskContext.putImageData(output, 0, 0)
    const pngBase64 = maskCanvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
    setApplying(true)
    try { await applyMask(asset.id, pngBase64, prompt, inputFidelity) } finally { setApplying(false) }
  }
  return (
    <ModalFrame className="mask-modal" eyebrow="LOCAL EDIT" title="Mask Editor" wide>
      <div className="mask-toolbar"><div className="segmented-control"><button className={!erase ? 'is-active' : ''} disabled={!canEditMask} onClick={() => setErase(false)} type="button"><Icon name="brush" size={14} />绘制</button><button className={erase ? 'is-active' : ''} disabled={!canEditMask} onClick={() => setErase(true)} type="button"><Icon name="bypass" size={14} />擦除</button></div><label>画笔 <input disabled={!canEditMask} max={180} min={8} onChange={(event) => setBrush(Number(event.target.value))} type="range" value={brush} /><strong>{brush}px</strong></label><label>羽化 <input disabled={!canEditMask} max={60} min={0} onChange={(event) => setFeather(Number(event.target.value))} type="range" value={feather} /><strong>{feather}px</strong></label><button disabled={!canEditMask || !hasMask} onClick={clear} type="button"><Icon name="trash" size={14} />清空</button><button disabled={!canEditMask || historyCount === 0} onClick={undo} type="button"><Icon name="undo" size={14} />撤销</button></div>
      <div className="mask-workbench"><div className="mask-image" style={{ aspectRatio: hasKnownDimensions ? `${sourceWidth} / ${sourceHeight}` : '1 / 1' }}>{asset?.previewUrl ? <img alt={`待局部重绘：${asset.title}`} draggable={false} onError={() => { if (!previewRetried.current) { previewRetried.current = true; void reloadPreview(asset.id) } }} src={asset.previewUrl} /> : <ArtPreview label={asset?.title ?? '待局部重绘图片'} tone={asset?.tone ?? 'copper'} />}<canvas aria-disabled={!canEditMask} aria-label="蒙版绘制画布" onPointerCancel={() => { drawing.current = false }} onPointerDown={(event) => { if (!canEditMask) return; saveUndoPoint(); drawing.current = true; event.currentTarget.setPointerCapture(event.pointerId); draw(event) }} onPointerMove={draw} onPointerUp={(event) => { drawing.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} ref={canvasRef} style={{ pointerEvents: canEditMask ? 'auto' : 'none' }} /><span className="mask-size-label">{hasKnownDimensions ? `${sourceWidth}×${sourceHeight}` : '尺寸未知'}</span></div><aside><h3>蒙版规则</h3><p><span className="mask-swatch" />青绿色选区会转换成透明 PNG 区域并被重绘，其余区域保持不变。</p>{maskWarning ? <div className="safety-note warning-note"><Icon name="warning" size={16} /><p><strong>内置编辑器已停用</strong><span>{maskWarning}</span></p></div> : null}<label className="field"><span>编辑提示词</span><textarea onChange={(event) => setPrompt(event.target.value)} rows={6} value={prompt} /></label><label className="field"><span>输入保真度</span><StudioSelect ariaLabel="输入保真度" disabled={Boolean(asset && isGptImage2Model(asset.model))} onChange={(nextValue) => setInputFidelity(nextValue as 'low' | 'high')} options={[{ value: 'high', label: asset && isGptImage2Model(asset.model) ? 'GPT Image 2 · 自动高保真' : 'High · 最大程度保留' }, ...(asset && isGptImage2Model(asset.model) ? [] : [{ value: 'low', label: 'Low · 允许更大变化' }])]} placeholder="选择输入保真度" value={inputFidelity} /></label><div className="safety-note"><Icon name="info" size={16} /><p><strong>只保存蒙版并创建节点</strong><span>会校验 PNG 完整性、Alpha、尺寸与项目路径；不会自动派发付费请求。</span></p></div></aside></div>
      <footer className="modal-footer"><span>{canEditMask ? `画笔支持鼠标、触控笔和触屏；最多保留 ${undoLimit} 个撤销快照。` : '请换用外部同尺寸 PNG 蒙版，或选择尺寸较小的作品。'}</span><button className="primary-button" disabled={applying || !canEditMask || !hasMask || !asset} onClick={() => void submit()} type="button"><Icon name="check" size={14} />{applying ? '正在保存…' : '保存并创建重绘节点'}</button></footer>
    </ModalFrame>
  )
}

function RunConfirmModal() {
  const plan = useStudioStore((state) => state.pendingPlan)
  const connection = useStudioStore((state) => state.connectionState)
  const projectPath = useStudioStore((state) => state.projectPath)
  const targetNodeIds = useStudioStore((state) => state.pendingTargetNodeIds)
  const close = useStudioStore((state) => state.closeModal)
  const confirm = useStudioStore((state) => state.confirmRun)
  if (!plan) return null
  const executeCount = plan.nodes.filter((node) => node.action === 'execute').length
  const willDispatch = connection === 'ready' && Boolean(projectPath) && plan.remoteTaskCount > 0
  return (
    <ModalFrame className="run-confirm-modal" eyebrow="EXECUTION BOUNDARY" title="确认执行计划">
      {targetNodeIds.length > 0 ? <div className="targeted-run-notice"><Icon name="fit" size={16} /><p><strong>仅运行依赖链到所选节点</strong><span><b>{targetNodeIds.length} 个目标节点</b>；不在其上游依赖链中的分支不会执行。</span></p></div> : null}
      <div className="run-confirm-summary"><span className="run-confirm-glyph"><Icon name="play" size={24} /></span><div><strong>{plan.remoteTaskCount} 个远程节点 · {plan.taskCount} 个执行节点</strong><p>{willDispatch ? '运行后会使用当前账号向模型服务发送真实请求。' : plan.remoteTaskCount === 0 ? '本次只有本地计算、固定输出、模拟输出、缓存或跳过节点。' : '当前运行条件不完整，请先处理下方提示。'}</p></div></div><ExposureRail active={0} /><dl className="matrix-equation"><div><dt>需要执行</dt><dd>{executeCount} 节点</dd></div><div><dt>远程模型服务</dt><dd>{plan.remoteTaskCount} 节点</dd></div><div><dt>本地或跳过</dt><dd>{plan.nodes.length - executeCount} 节点</dd></div><div><dt>预计费用</dt><dd>{plan.remoteTaskCount === 0 ? '无远程费用' : plan.estimatedCost !== undefined ? `估算 ${plan.estimatedCost.toFixed(2)}（单位同输入）` : '模型服务未提供'}</dd></div><div><dt>自动重试</dt><dd>关闭</dd></div></dl><div className={`safety-note ${willDispatch ? 'warning-note' : ''}`}><Icon name={willDispatch ? 'warning' : 'info'} size={18} /><p><strong>{willDispatch ? '即将发送真实请求' : plan.remoteTaskCount === 0 ? '仅在本地运行' : '运行条件不完整'}</strong><span>{willDispatch ? '请求发送后，即使取消也可能已经产生费用。' : plan.remoteTaskCount === 0 ? '不会调用图片模型服务；结果仍会写入任务记录。' : '请先打开项目并选择可用分组和模型。'}</span></p></div>
      <footer className="modal-footer"><button className="secondary-button" onClick={close} type="button">返回修改</button><button className="primary-button" disabled={plan.remoteTaskCount > 0 && !willDispatch} onClick={() => void confirm()} type="button"><Icon name="play" size={14} />{willDispatch ? '确认并派发' : plan.remoteTaskCount === 0 && connection === 'ready' && projectPath ? '确认本地执行' : '暂不可运行'}</button></footer>
    </ModalFrame>
  )
}

function WorkflowTemplatesModal() {
  const close = useStudioStore((state) => state.closeModal)
  const createFromTemplate = useStudioStore((state) => state.createWorkflowFromTemplate)
  const choose = (templateId: WorkflowTemplateId): void => {
    close()
    void createFromTemplate(templateId)
  }
  return (
    <ModalFrame className="workflow-templates-modal" eyebrow="快速开始" title="选择工作流模板" wide>
      <p className="modal-intro">选择最接近这次任务的目标；所有模板都会载入同一个可继续编辑的节点画布。</p>
      <div className="workflow-template-grid">
        {workflowTemplates.map((template) => (
          <article className="workflow-template-card" key={template.id}>
            <header>
              <span className="workflow-template-icon"><Icon name={template.id === 'image-edit' ? 'brush' : template.id === 'product-variations' ? 'layers' : 'spark'} size={20} /></span>
              <div><h3>{template.name}</h3><p>{template.description}</p></div>
            </header>
            <div className="workflow-template-tags">{template.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <ol>{template.nextSteps.map((step) => <li key={step}>{step}</li>)}</ol>
            <button aria-label={`使用模板：${template.name}`} className="primary-button" onClick={() => choose(template.id)} type="button">
              使用这个模板<Icon name="chevron" size={13} />
            </button>
          </article>
        ))}
      </div>
    </ModalFrame>
  )
}

const workflowChangeValue = (value: unknown): string => {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value || '（空白）'
  try {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 117)}…` : text
  } catch {
    return String(value)
  }
}

function DraftRecoveryModal() {
  const pending = useStudioStore((state) => state.pendingDraftRecovery)
  const formalRevision = useStudioStore((state) => state.workflowRevision)
  const recover = useStudioStore((state) => state.recoverWorkflowDraft)
  const discard = useStudioStore((state) => state.discardWorkflowDraft)
  if (!pending) return null
  const savedAt = new Date(pending.savedAt)
  const savedLabel = Number.isNaN(savedAt.getTime()) ? pending.savedAt : savedAt.toLocaleString('zh-CN')
  const kindLabel = { added: '新增', removed: '删除', changed: '修改' } as const
  return (
    <ModalFrame className="draft-recovery-modal" eyebrow="RECOVERY POINT" title="发现未保存草稿">
      <div className="draft-recovery-summary">
        <span className="draft-recovery-glyph"><Icon name="clock" size={22} /></span>
        <div><strong>{pending.workflow.name}</strong><p>{pending.conflicted ? `保存于 ${savedLabel}；草稿基于旧版本，将恢复为独立副本。` : `保存于 ${savedLabel}；恢复后仍作为未保存修改，不会直接覆盖磁盘版本。`}</p></div>
        <span className="draft-recovery-count">{pending.changes.length} 项变更</span>
      </div>
      {pending.conflicted ? <div className="safety-note warning-note"><Icon name="warning" size={17} /><p><strong>检测到版本冲突</strong><span>草稿基于 rev. {pending.baseRevision}，当前正式版本为 rev. {formalRevision}；恢复不会覆盖对方修改。</span></p></div> : null}
      <div className="draft-recovery-meta"><span>正式版本 rev. {formalRevision}</span>{pending.conflicted ? <span>草稿基于 rev. {pending.baseRevision}</span> : null}<span>{pending.workflow.nodes.length} 个节点</span><span>{pending.workflow.edges.length} 条连线</span></div>
      <div aria-label="草稿变更" className="draft-change-list">
        {pending.changes.map((change) => (
          <article className={`draft-change change-${change.kind}`} key={`${change.kind}-${change.path}`}>
            <span>{kindLabel[change.kind]}</span>
            <div><strong>{change.label}</strong><small>{change.path}</small></div>
            {change.kind !== 'added' ? <code title={workflowChangeValue(change.before)}>{workflowChangeValue(change.before)}</code> : null}
            {change.kind === 'changed' ? <Icon name="chevron" size={12} /> : null}
            {change.kind !== 'removed' ? <code title={workflowChangeValue(change.after)}>{workflowChangeValue(change.after)}</code> : null}
          </article>
        ))}
      </div>
      <footer className="modal-footer">
        <button className="danger-ghost" onClick={() => void discard()} type="button">丢弃草稿</button>
        <button className="primary-button" onClick={recover} type="button"><Icon name="undo" size={14} />{pending.conflicted ? '恢复为独立副本' : '恢复草稿'}</button>
      </footer>
    </ModalFrame>
  )
}

const workflowDateLabel = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function WorkflowHistoryModal() {
  const versions = useStudioStore((state) => state.workflowVersions)
  const archived = useStudioStore((state) => state.archivedWorkflows)
  const workflows = useStudioStore((state) => state.workflows)
  const workflowRevision = useStudioStore((state) => state.workflowRevision)
  const workflowDirty = useStudioStore((state) => state.workflowDirty)
  const currentName = useStudioStore((state) => state.graphs.root?.label ?? '未命名工作流')
  const restoreVersion = useStudioStore((state) => state.restoreWorkflowVersion)
  const duplicate = useStudioStore((state) => state.duplicateCurrentWorkflow)
  const requestTextInput = useStudioStore((state) => state.requestTextInput)
  const archive = useStudioStore((state) => state.archiveCurrentWorkflow)
  const restoreArchived = useStudioStore((state) => state.restoreArchivedWorkflow)
  const exportPackage = useStudioStore((state) => state.exportCurrentWorkflowPackage)
  const importPackage = useStudioStore((state) => state.importWorkflowPackage)
  const duplicateCurrent = async (): Promise<void> => {
    const value = await requestTextInput({
      title: '创建工作流副本',
      label: '副本名称',
      initialValue: `${currentName} 副本`,
      placeholder: '输入副本名称',
      confirmLabel: '创建副本',
      maxLength: 100,
    })
    const name = value?.trim()
    if (name) await duplicate(name)
  }
  const archiveCurrent = (): void => {
    if (window.confirm(`将“${currentName}”移入可恢复归档？不会永久删除。`)) void archive()
  }
  return (
    <ModalFrame className="workflow-history-modal" eyebrow="版本管理" title="工作流版本与归档" wide>
      <div className="workflow-history-intro">
        <span><Icon name="clock" size={20} /></span>
        <div><strong>{currentName} · rev. {workflowRevision}</strong><p>旧版本载入后作为未保存修改；只有再次点击保存才会生成新正式版本。</p></div>
      </div>
      <div className="workflow-history-layout">
        <section aria-labelledby="workflow-version-heading">
          <header><div><h3 id="workflow-version-heading">当前工作流版本</h3><p>按保存时间查看可恢复版本。</p></div><span>{versions.length} 个版本</span></header>
          <div className="workflow-version-list">
            {versions.map((version) => (
              <article className={version.revision === workflowRevision ? 'is-current' : ''} key={version.revision}>
                <span className="workflow-revision">rev. {version.revision}</span>
                <div><strong>{version.name}</strong><small>{workflowDateLabel(version.savedAt)}</small></div>
                {version.revision === workflowRevision
                  ? <span className="current-version-label"><Icon name="check" size={12} />当前正式版本</span>
                  : <button aria-label={`载入版本 rev. ${version.revision}`} className="secondary-button" onClick={() => void restoreVersion(version.revision)} type="button"><Icon name="undo" size={13} />载入</button>}
              </article>
            ))}
            {versions.length === 0 ? <div className="workflow-history-empty">暂无可恢复版本；下次保存时会自动保留版本。</div> : null}
          </div>
        </section>
        <aside className="workflow-history-side">
          <section aria-labelledby="workflow-action-heading">
            <header><div><h3 id="workflow-action-heading">当前工作流</h3><p>副本和归档操作仅针对已保存版本。</p></div></header>
            {workflowDirty ? <p className="workflow-history-warning"><Icon name="warning" size={14} />请先保存或撤销当前修改，再复制或归档。</p> : null}
            <div className="workflow-lifecycle-actions">
              <button aria-label="复制当前工作流" className="secondary-button" disabled={workflowDirty} onClick={() => void duplicateCurrent()} type="button"><Icon name="copy" size={14} />创建独立副本</button>
              <button aria-label="归档当前工作流" className="danger-ghost" disabled={workflowDirty || workflows.length < 2} onClick={archiveCurrent} title={workflows.length < 2 ? '项目至少需要保留一个工作流' : '可从下方归档恢复'} type="button"><Icon name="folder" size={14} />移入可恢复归档</button>
            </div>
          </section>
          <section aria-labelledby="workflow-package-heading">
            <header><div><h3 id="workflow-package-heading">工作流备份</h3><p>用于备份或在其他项目导入副本。</p></div></header>
            <div className="workflow-package-actions">
              <button aria-label="导出工作流备份" className="secondary-button" onClick={() => void exportPackage()} type="button"><Icon name="external" size={14} />导出当前</button>
              <button aria-label="导入工作流备份" className="secondary-button" onClick={() => void importPackage()} type="button"><Icon name="download" size={14} />导入为副本</button>
            </div>
          </section>
          <section aria-labelledby="workflow-archive-heading">
            <header><div><h3 id="workflow-archive-heading">可恢复归档</h3><p>归档不是永久删除。</p></div><span>{archived.length}</span></header>
            <div className="workflow-archive-list">
              {archived.map((item) => (
                <article key={item.archiveId}>
                  <span><Icon name="folder" size={14} /></span>
                  <div><strong>{item.name}</strong><small>rev. {item.revision} · {workflowDateLabel(item.archivedAt)}</small></div>
                  <button aria-label={`恢复归档：${item.name}`} className="secondary-button" onClick={() => void restoreArchived(item.archiveId)} type="button">恢复</button>
                </article>
              ))}
              {archived.length === 0 ? <div className="workflow-history-empty">当前项目没有归档。</div> : null}
            </div>
          </section>
        </aside>
      </div>
    </ModalFrame>
  )
}

export function StudioModals() {
  const modal = useStudioStore((state) => state.modal)
  const textInputRequest = useStudioStore((state) => state.textInputRequest)
  if (textInputRequest) return <TextInputDialog key={textInputRequest.id} />
  if (modal === 'command') return <CommandPalette />
  if (modal === 'project-picker') return <ProjectPickerModal />
  if (modal === 'prompt-matrix') return <PromptMatrixModal />
  if (modal === 'compare') return <CompareModal />
  if (modal === 'mask') return <MaskModal />
  if (modal === 'run-confirm') return <RunConfirmModal />
  if (modal === 'workflow-templates') return <WorkflowTemplatesModal />
  if (modal === 'draft-recovery') return <DraftRecoveryModal />
  if (modal === 'workflow-history') return <WorkflowHistoryModal />
  return null
}
