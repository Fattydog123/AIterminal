import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type OnConnectStartParams,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isGptImage2Model, isGptImageModel } from '@studio/core/imageModels.js'
import { evaluateParameterField } from '@studio/core/parameters.js'
import { providerCapabilityProfile } from '@studio/core/providerCapabilities.js'
import { presetSupportsModel } from '@studio/core/presets.js'
import type { StudioRepairAction } from '@studio/core/studioReadiness.js'
import type { LinearField } from '@studio/core/linearView.js'
import {
  studioCopilotPlanSchema,
  type StudioBridge,
  type StudioCopilotPlan,
} from '@studio/shared/contracts.js'
import { Icon } from '../components/Icon.js'
import { AccountRoutePicker } from '../components/AccountRoutePicker.js'
import { ExposureRail, IconButton, StatusPill, Toggle } from '../components/Primitives.js'
import { StudioSelect } from '../components/StudioSelect.js'
import { accountGroupLabel, accountProviders, isAiTerminalAccountProvider, isLegacyComfyParameter, providerModelOptions } from '../providerSelection.js'
import { getActiveGraph, nodeDefinitions, useStudioStore, type CompatiblePickerState } from '../store/studioStore.js'
import type { CanvasPort, GraphDocument, ProviderItem, StudioFlowEdge, StudioFlowNode } from '../types.js'
import {
  describeStudioCopilotOperation,
  describeStudioCopilotOperationDetail,
} from '../session/studio-copilot-operations.js'
import { beginPointerResize, resizeFromKeyboard, useWorkspaceLayout } from '../../../ui/use-workspace-layout.js'
import { ExposureEdge } from './ExposureEdge.js'
import { WorkflowNode } from './WorkflowNode.js'

const nodeTypes = { studio: WorkflowNode }
const edgeTypes = { exposure: ExposureEdge }
const remoteImageNodeTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])
const topRouteParameterNames = new Set(['providerId', 'model'])
const isTopRouteParameter = (nodeType: string, parameter: string): boolean =>
  remoteImageNodeTypes.has(nodeType) && topRouteParameterNames.has(parameter)
const confirmedOnlyOmittedParameters = new Set([
  'size',
  'quality',
  'responseFormat',
  'outputFormat',
  'outputCompression',
  'background',
  'moderation',
  'seed',
  'extra',
  'inputFidelity',
])
const isConfirmedOnlyProviderModel = (provider: ProviderItem | undefined, model: string): boolean => (
  Boolean(model && provider?.confirmedOnlyModels?.includes(model))
)
const nodeLibraryTabs = ['library', 'outline'] as const
const inspectorTabs = ['params', 'notes', 'performance'] as const

interface WorkflowRouteSelection {
  readonly accountGroups: readonly ProviderItem[]
  readonly boundProviderIds: readonly string[]
  readonly selectedAccountGroupId: string
  readonly selectedAccountGroup: ProviderItem | undefined
  readonly selectedAccountModels: readonly string[]
  readonly boundModels: readonly string[]
  readonly selectedModel: string
}

const workflowRouteSelection = (
  providers: readonly ProviderItem[],
  graphs: Readonly<Record<string, GraphDocument>>,
): WorkflowRouteSelection => {
  const accountGroups = accountProviders(providers)
  const remoteNodes = Object.values(graphs).flatMap((graph) => graph.nodes)
    .filter((node) => remoteImageNodeTypes.has(node.data.nodeType))
  const boundProviderIds = [...new Set(remoteNodes
    .map((node) => String(node.data.parameters.providerId ?? '').trim())
    .filter(Boolean))]
  const selectedAccountGroupId = boundProviderIds.length === 1
    && accountGroups.some((provider) => provider.id === boundProviderIds[0])
    ? boundProviderIds[0] ?? ''
    : ''
  const selectedAccountGroup = accountGroups.find((provider) => provider.id === selectedAccountGroupId)
  const selectedAccountModels = selectedAccountGroup ? providerModelOptions(selectedAccountGroup) : []
  const boundModels = [...new Set(remoteNodes
    .filter((node) => String(node.data.parameters.providerId ?? '').trim() === selectedAccountGroupId)
    .map((node) => String(node.data.parameters.model ?? '').trim())
    .filter(Boolean))]
  const selectedModel = boundModels.length === 1 && selectedAccountModels.includes(boundModels[0] ?? '')
    ? boundModels[0] ?? ''
    : ''
  return {
    accountGroups,
    boundProviderIds,
    selectedAccountGroupId,
    selectedAccountGroup,
    selectedAccountModels,
    boundModels,
    selectedModel,
  }
}

const activateTabFromKeyboard = <T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  tabs: readonly T[],
  activate: (tab: T) => void,
): void => {
  const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]')
  const buttons = tablist ? [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')] : []
  const currentIndex = buttons.indexOf(event.currentTarget)
  if (currentIndex < 0) return
  let nextIndex: number | undefined
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = tabs.length - 1
  if (nextIndex === undefined) return
  const next = tabs[nextIndex]
  if (!next) return
  event.preventDefault()
  activate(next)
  buttons[nextIndex]?.focus()
}

const navLabels: Record<string, string> = {
  prompt: '提示词',
  referenceImages: '参考图',
  images: '图片',
  image: '图片',
  mask: '蒙版',
  text: '文本',
}

const parameterDefinition = (node: StudioFlowNode, name: string) =>
  nodeDefinitions.find((definition) => definition.type === node.data.nodeType)
    ?.parameters.find((parameter) => parameter.id === name)

const parameterLabel = (node: StudioFlowNode, name: string): string =>
  parameterDefinition(node, name)?.label ?? navLabels[name] ?? name

const supportLabel = (support: 'supported' | 'unsupported' | 'unknown'): string =>
  support === 'supported' ? '支持' : support === 'unsupported' ? '不支持' : '由模型服务决定'

const projectImageFileName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? '未选择图片'

const projectImageDimensions = (node: StudioFlowNode): string => {
  const width = typeof node.data.previewWidth === 'number' ? node.data.previewWidth : undefined
  const height = typeof node.data.previewHeight === 'number' ? node.data.previewHeight : undefined
  return width && height ? `${width} × ${height} px` : '尺寸待读取'
}

function Breadcrumbs() {
  const graphs = useStudioStore((state) => state.graphs)
  const activeGraphId = useStudioStore((state) => state.activeGraphId)
  const enterGraph = useStudioStore((state) => state.enterGraph)
  const crumbs = useMemo(() => {
    const result: { id: string; label: string }[] = []
    let graph = graphs[activeGraphId]
    while (graph) {
      result.unshift({ id: graph.id, label: graph.label })
      graph = graph.parentId ? graphs[graph.parentId] : undefined
    }
    return result
  }, [activeGraphId, graphs])
  const parent = crumbs.at(-2)
  if (!parent) return null
  return (
    <nav aria-label="子图面包屑" className="workflow-breadcrumbs">
      {parent ? <button aria-label={`返回上一级：${parent.label}`} className="breadcrumb-back-button" onClick={() => enterGraph(parent.id)} type="button"><Icon name="chevron" size={12} /><span>返回</span></button> : null}
      {crumbs.map((crumb, index) => (
        <span key={crumb.id}>
          {index > 0 ? <Icon name="chevron" size={12} /> : null}
          <button aria-current={index === crumbs.length - 1 ? 'page' : undefined} onClick={() => enterGraph(crumb.id)} type="button">{crumb.label}</button>
        </span>
      ))}
    </nav>
  )
}

interface WorkflowToolbarProps {
  readonly copilotOpen: boolean
  readonly onToggleCopilot: () => void
}

function WorkflowToolbar({ copilotOpen, onToggleCopilot }: WorkflowToolbarProps) {
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)
  const view = useStudioStore((state) => state.workflowView)
  const workflows = useStudioStore((state) => state.workflows)
  const workflowId = useStudioStore((state) => state.workflowId)
  const workflowDirty = useStudioStore((state) => state.workflowDirty)
  const pendingDraftRecovery = useStudioStore((state) => state.pendingDraftRecovery)
  const projectPath = useStudioStore((state) => state.projectPath)
  const currentWorkflowLabel = useStudioStore((state) => state.graphs.root?.label ?? '未命名工作流')
  const setView = useStudioStore((state) => state.setWorkflowView)
  const switchWorkflow = useStudioStore((state) => state.switchWorkflow)
  const createNewWorkflow = useStudioStore((state) => state.createNewWorkflow)
  const createProject = useStudioStore((state) => state.createProject)
  const openProject = useStudioStore((state) => state.openProject)
  const requestTextInput = useStudioStore((state) => state.requestTextInput)
  const openWorkflowHistory = useStudioStore((state) => state.openWorkflowHistory)
  const openModal = useStudioStore((state) => state.openModal)
  const convert = useStudioStore((state) => state.convertSelectionToSubgraph)
  const run = useStudioStore((state) => state.runWorkflow)
  const runSelectedNode = useStudioStore((state) => state.runSelectedNode)
  const selectedNodeId = useStudioStore((state) => state.selectedNodeId)
  const save = useStudioStore((state) => state.saveWorkflow)
  const undo = useStudioStore((state) => state.undoEditor)
  const redo = useStudioStore((state) => state.redoEditor)
  const autoLayout = useStudioStore((state) => state.autoLayoutWorkflow)
  const importLocalImage = useStudioStore((state) => state.importLocalImage)
  const localImageImporting = useStudioStore((state) => state.localImageImporting)
  const providers = useStudioStore((state) => state.providers)
  const graphs = useStudioStore((state) => state.graphs)
  const bindAccountGroup = useStudioStore((state) => state.bindAccountGroup)
  const refreshProviders = useStudioStore((state) => state.refreshProviders)
  const connectionState = useStudioStore((state) => state.connectionState)
  const canUndo = useStudioStore((state) => state.canUndo)
  const canRedo = useStudioStore((state) => state.canRedo)
  const {
    accountGroups,
    boundProviderIds,
    selectedAccountGroupId,
    selectedAccountGroup,
    selectedAccountModels,
    boundModels,
    selectedModel,
  } = workflowRouteSelection(providers, graphs)
  const listedCurrent = workflows.some((workflow) => workflow.id === workflowId)
  const workflowOptions = [
    ...(!listedCurrent ? [{ value: workflowId, label: currentWorkflowLabel }] : []),
    ...workflows.map((workflow) => ({ value: workflow.id, label: workflow.name })),
  ]
  const confirmDiscard = (): boolean => !workflowDirty || window.confirm('当前工作流有未保存修改。继续会先保存恢复草稿再切换，是否继续？')
  const selectWorkflow = (nextId: string) => {
    if (nextId === workflowId || !confirmDiscard()) return
    void switchWorkflow(nextId)
  }
  const addWorkflow = async (): Promise<void> => {
    if (!confirmDiscard()) return
    const value = await requestTextInput({
      title: '新建工作流',
      label: '工作流名称',
      initialValue: `工作流 ${workflows.length + 1}`,
      placeholder: '输入工作流名称',
      confirmLabel: '新建工作流',
      maxLength: 100,
    })
    const name = value?.trim()
    if (name) await createNewWorkflow(name)
  }
  const startCreateProject = async (): Promise<void> => {
    const value = await requestTextInput({
      title: '创建项目',
      label: '项目名称',
      initialValue: '未命名项目',
      placeholder: '输入项目名称',
      confirmLabel: '创建项目',
      maxLength: 80,
    })
    const name = value?.trim()
    if (name) await createProject(name)
  }
  useEffect(() => {
    if (!overflowOpen) return undefined
    const closeOnPointerDown = (event: PointerEvent): void => {
      const menu = overflowRef.current
      const target = event.target as Node | null
      const insideMenu = Boolean(menu && (
        (target && menu.contains(target))
        || event.composedPath().includes(menu)
      ))
      if (!insideMenu) setOverflowOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOverflowOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [overflowOpen])
  return (
    <header className="workflow-toolbar">
      <div className="workflow-context">
        <div className="workflow-switcher">
          <StudioSelect
            ariaLabel="当前工作流"
            className="workflow-select"
            disabled={workflows.length < 2}
            onChange={selectWorkflow}
            options={workflowOptions}
            placeholder={currentWorkflowLabel}
            title={workflowDirty ? '当前工作流有未保存修改' : '切换工作流'}
            value={workflowId}
          />
          <button aria-label="新建工作流" disabled={!projectPath} onClick={() => void addWorkflow()} title="在当前项目中新建工作流" type="button"><Icon name="plus" size={13} /></button>
          {workflowDirty ? <span aria-label="有未保存修改" className="workflow-dirty-dot" role="status" /> : null}
        </div>
        <Breadcrumbs />
      </div>
      <div className="toolbar-center" role="group" aria-label="视图切换">
        <button className={view === 'canvas' ? 'is-active' : ''} onClick={() => setView('canvas')} type="button"><Icon name="workflow" size={15} />画布</button>
        <button className={view === 'linear' ? 'is-active' : ''} onClick={() => setView('linear')} type="button"><Icon name="list" size={15} />参数视图</button>
      </div>
      <div className="toolbar-actions">
        <IconButton disabled={!canUndo} icon="undo" label="撤销 Ctrl+Z" onClick={undo} />
        <IconButton disabled={!canRedo} icon="redo" label="重做 Ctrl+Shift+Z" onClick={redo} />
        <button aria-label="自动整理当前画布" className="toolbar-button toolbar-optional" onClick={() => autoLayout('all')} title="按依赖关系从左到右整理节点；Frame 与 Note 保持原位，可撤销" type="button"><Icon name="workflow" size={14} />自动整理</button>
        <span className="toolbar-separator" />
        {pendingDraftRecovery ? <button aria-label="草稿待处理" className="toolbar-button toolbar-optional toolbar-attention" onClick={() => openModal('draft-recovery')} type="button"><Icon name="warning" size={15} />草稿</button> : null}
        <button className="toolbar-button toolbar-optional" onClick={() => openModal('workflow-templates')} title="工作流模板" type="button"><Icon name="spark" size={15} />模板</button>
        <button className="toolbar-button toolbar-optional" disabled={!projectPath} onClick={() => void openWorkflowHistory()} title={projectPath ? '版本历史、归档与工作流备份' : '打开项目后可用'} type="button"><Icon name="clock" size={15} />版本</button>
        <button
          className="toolbar-button toolbar-optional local-image-toolbar"
          disabled={localImageImporting}
          onClick={() => void importLocalImage()}
          title="从电脑选择图片并创建本地图片节点"
          type="button"
        >
          <Icon name="image" size={15} />{localImageImporting ? '载入中' : '载入图片'}
        </button>
        <button className="toolbar-button toolbar-optional" onClick={convert} title="转换为子图" type="button"><Icon name="layers" size={15} />转子图</button>
        <button className="toolbar-button toolbar-optional" onClick={() => openModal('prompt-matrix')} title="提示词矩阵" type="button"><Icon name="matrix" size={15} />矩阵</button>
        <button className="toolbar-button save-workflow-button" disabled={!workflowDirty} onClick={() => void save()} title="保存工作流" type="button"><Icon name="save" size={15} />保存{workflowDirty ? ' •' : ''}</button>
        <button aria-label="运行到所选节点" className="toolbar-button run-selected-button" disabled={!selectedNodeId} onClick={() => void runSelectedNode()} title={selectedNodeId ? '只执行到所选节点所需的依赖链' : '请先在画布中选择一个节点'} type="button"><Icon name="bypass" size={14} />运行到节点</button>
        <div className="toolbar-overflow" ref={overflowRef}>
          <button aria-expanded={overflowOpen} aria-haspopup="menu" aria-label="更多工作流操作" className="toolbar-button toolbar-overflow-trigger" onClick={() => setOverflowOpen((open) => !open)} title="更多工作流操作" type="button"><Icon name="more" size={15} /><span>更多</span></button>
          {overflowOpen ? <div aria-label="更多工作流操作" className="toolbar-overflow-menu" role="menu">
            <button onClick={() => { setOverflowOpen(false); void startCreateProject() }} role="menuitem" type="button"><Icon name="plus" size={14} /><span>创建项目</span></button>
            <button onClick={() => { setOverflowOpen(false); void openProject() }} role="menuitem" type="button"><Icon name="folder" size={14} /><span>打开项目</span></button>
            <button onClick={() => { setOverflowOpen(false); autoLayout('all') }} role="menuitem" type="button"><Icon name="workflow" size={14} /><span>自动整理</span></button>
            {pendingDraftRecovery ? <button className="toolbar-attention" onClick={() => { setOverflowOpen(false); openModal('draft-recovery') }} role="menuitem" type="button"><Icon name="warning" size={14} /><span>处理草稿</span></button> : null}
            <button onClick={() => { setOverflowOpen(false); openModal('workflow-templates') }} role="menuitem" type="button"><Icon name="spark" size={14} /><span>工作流模板</span></button>
            <button disabled={!projectPath} onClick={() => { setOverflowOpen(false); void openWorkflowHistory() }} role="menuitem" type="button"><Icon name="clock" size={14} /><span>版本历史</span></button>
            <button disabled={localImageImporting} onClick={() => { setOverflowOpen(false); void importLocalImage() }} role="menuitem" type="button"><Icon name="image" size={14} /><span>{localImageImporting ? '载入中' : '载入图片'}</span></button>
            <button onClick={() => { setOverflowOpen(false); convert() }} role="menuitem" type="button"><Icon name="layers" size={14} /><span>转为子图</span></button>
            <button onClick={() => { setOverflowOpen(false); openModal('prompt-matrix') }} role="menuitem" type="button"><Icon name="matrix" size={14} /><span>提示词矩阵</span></button>
          </div> : null}
        </div>
        <button
          aria-expanded={copilotOpen}
          aria-label={copilotOpen ? '关闭工作流助手' : '打开工作流助手'}
          className={`toolbar-button copilot-toolbar-button${copilotOpen ? ' is-active' : ''}`}
          onClick={onToggleCopilot}
          title="工作流助手"
          type="button"
        ><Icon name="spark" size={15} /><span>助手</span></button>
        <AccountRoutePicker
          groups={accountGroups.map((provider) => ({
            id: provider.id,
            label: accountGroupLabel(provider),
            description: provider.description,
          }))}
          groupPlaceholder={boundProviderIds.length > 1 ? '多个分组' : accountGroups.length > 0 ? '选择分组' : '无可用分组'}
          loading={connectionState === 'loading'}
          modelDisabled={!selectedAccountGroup || selectedAccountModels.length === 0}
          modelPlaceholder={selectedAccountGroup ? boundModels.length > 1 ? '多个模型' : '选择模型' : '选择分组'}
          models={selectedAccountModels}
          onGroupChange={(groupId) => bindAccountGroup(groupId)}
          onModelChange={(model) => bindAccountGroup(selectedAccountGroupId, model)}
          onRefresh={() => void refreshProviders()}
          selectedGroupId={selectedAccountGroupId}
          selectedModel={selectedModel}
        />
        <button className="primary-button run-button" onClick={() => void run()} type="button"><Icon name="play" size={15} />运行 <kbd>Ctrl ↵</kbd></button>
      </div>
    </header>
  )
}

function WorkflowReadinessBar() {
  const [expanded, setExpanded] = useState(false)
  const report = useStudioStore((state) => state.workflowReadiness)
  const runRepair = useStudioStore((state) => state.repairWorkflow)
  const repairLabel = (action: StudioRepairAction, title: string): string => {
    if (action.kind === 'create-project') return '创建项目'
    if (action.kind === 'select-node') return `编辑节点：${title}`
    if (action.kind === 'connect-input') return `连接节点：${title}`
    if (action.kind === 'import-local-image') return '载入本地图片'
    return '移除问题连线'
  }
  const primaryIssue = report.issues.find((issue) => issue.severity === 'blocking') ?? report.issues[0]
  return (
    <section aria-label="工作流就绪检查" className={`workflow-readiness ${report.ready ? 'is-ready' : 'is-blocked'}`}>
      <div className="workflow-readiness-summary">
        <span className="workflow-readiness-icon"><Icon name={report.ready ? 'check' : 'warning'} size={15} /></span>
        <strong>{report.ready ? '已就绪' : `${report.blockingCount} 项阻止运行`}</strong>
        {primaryIssue ? <span className="workflow-readiness-primary">{primaryIssue.title}</span> : <span className="workflow-readiness-primary">项目与连线均已准备完成</span>}
        {primaryIssue ? <button aria-label={repairLabel(primaryIssue.action, primaryIssue.title)} className="readiness-action" onClick={() => runRepair(primaryIssue.action)} type="button">{repairLabel(primaryIssue.action, primaryIssue.title)}<Icon name="chevron" size={11} /></button> : null}
        {report.issues.length > 1 ? <button aria-expanded={expanded} className="readiness-toggle" onClick={() => setExpanded((value) => !value)} type="button">{expanded ? '收起' : `查看全部 ${report.issues.length}`}</button> : null}
      </div>
      {expanded ? <div className="workflow-readiness-details">{report.issues.map((issue) => <article key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? ''}`}><span><Icon name={issue.severity === 'blocking' ? 'error' : 'warning'} size={13} /></span><div><strong>{issue.title}</strong><p>{issue.message}</p></div><button aria-label={repairLabel(issue.action, issue.title)} className="secondary-button" onClick={() => runRepair(issue.action)} type="button">{repairLabel(issue.action, issue.title)}</button></article>)}</div> : null}
    </section>
  )
}

function NodeLibrary() {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'library' | 'outline'>('library')
  const graph = useStudioStore(getActiveGraph)
  const subgraphs = useStudioStore((state) => state.subgraphDefinitions)
  const addNode = useStudioStore((state) => state.addNode)
  const importLocalImage = useStudioStore((state) => state.importLocalImage)
  const localImageImporting = useStudioStore((state) => state.localImageImporting)
  const addSubgraphInstance = useStudioStore((state) => state.addSubgraphInstance)
  const setSelected = useStudioStore((state) => state.setSelectedNode)
  const filtered = nodeDefinitions.filter((item) => `${item.title}${item.category}${item.description}`.toLowerCase().includes(query.toLowerCase()))
  const visibleSubgraphs = subgraphs.filter((item) => `${item.name}${item.description}${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const groups = [...new Set(filtered.map((item) => item.category))]
  const addLibraryNode = (type: string) => {
    if (type === 'project_image') void importLocalImage()
    else addNode(type)
  }
  return (
    <aside aria-label="节点库" className="node-library">
      <div aria-label="节点面板" className="panel-tabs compact-tabs" role="tablist">
        <button aria-controls="node-library-panel-library" aria-selected={tab === 'library'} className={tab === 'library' ? 'is-active' : ''} id="node-library-tab-library" onClick={() => setTab('library')} onKeyDown={(event) => activateTabFromKeyboard(event, nodeLibraryTabs, setTab)} role="tab" tabIndex={tab === 'library' ? 0 : -1} type="button">节点库</button>
        <button aria-controls="node-library-panel-outline" aria-selected={tab === 'outline'} className={tab === 'outline' ? 'is-active' : ''} id="node-library-tab-outline" onClick={() => setTab('outline')} onKeyDown={(event) => activateTabFromKeyboard(event, nodeLibraryTabs, setTab)} role="tab" tabIndex={tab === 'outline' ? 0 : -1} type="button">大纲</button>
      </div>
      <div aria-labelledby="node-library-tab-library" className="node-library-tabpanel" hidden={tab !== 'library'} id="node-library-panel-library" role="tabpanel">
        {tab === 'library' ? (
          <>
          <label className="search-field node-search"><Icon name="search" size={15} /><input aria-label="搜索节点" onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点或功能" value={query} /><kbd>F</kbd></label>
          <div className="library-scroll">
            <section className="library-favorites">
              <h3><Icon name="star" size={13} />常用</h3>
              <div className="quick-node-grid">
                {['project_image', 'text', 'image_generation', 'image_preview', 'note'].map((type) => {
                  const item = nodeDefinitions.find((node) => node.type === type)
                  return item ? <button className={item.type === 'project_image' ? 'local-image-quick' : undefined} disabled={item.type === 'project_image' && localImageImporting} key={item.type} onClick={() => addLibraryNode(item.type)} title={item.type === 'project_image' ? '从电脑选择图片并创建节点' : `添加${item.title}节点`} type="button"><Icon name={item.accent === 'image' ? 'image' : item.type === 'note' ? 'note' : 'code'} size={15} />{item.type === 'project_image' && localImageImporting ? '正在载入图片' : item.title}</button> : null
                })}
              </div>
            </section>
            {visibleSubgraphs.length > 0 ? (
              <details className="subgraph-library" open>
                <summary>类型化子图库<small>{visibleSubgraphs.length}</small></summary>
                <div className="library-list">
                  {visibleSubgraphs.map((definition) => (
                    <button
                      draggable
                      key={definition.id}
                      onClick={() => addSubgraphInstance(definition.id)}
                      onDragStart={(event) => { event.dataTransfer.setData('application/x-studio-node', `subgraph:${definition.id}`); event.dataTransfer.effectAllowed = 'copy' }}
                      type="button"
                    >
                      <span className="library-node-icon accent-control"><Icon name="layers" size={15} /></span>
                      <span><strong>{definition.name}</strong><small>{definition.inputs.length} 入 · {definition.outputs.length} 出 · v{definition.version}</small></span>
                      <Icon name="plus" size={13} />
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
            {groups.map((group) => (
              <details key={group} open>
                <summary>{group}<small>{filtered.filter((item) => item.category === group).length}</small></summary>
                <div className="library-list">
                  {filtered.filter((item) => item.category === group).map((item) => (
                    <button
                      draggable
                      key={item.type}
                      disabled={item.type === 'project_image' && localImageImporting}
                      onClick={() => addLibraryNode(item.type)}
                      onDragStart={(event) => { event.dataTransfer.setData('application/x-studio-node', item.type); event.dataTransfer.effectAllowed = 'copy' }}
                      title={item.type === 'project_image' ? '点击选择图片，或拖到画布后选择' : `添加${item.title}节点`}
                      type="button"
                    >
                      <span className={`library-node-icon accent-${item.accent}`}><Icon name={item.type === 'frame' ? 'frame' : item.type === 'note' ? 'note' : item.accent === 'image' ? 'image' : 'code'} size={15} /></span>
                      <span><strong>{item.title}</strong><small>{item.description}</small></span>
                      <Icon name="plus" size={13} />
                    </button>
                  ))}
                </div>
              </details>
            ))}
          </div>
          </>
        ) : null}
      </div>
      <div aria-labelledby="node-library-tab-outline" className="node-library-tabpanel" hidden={tab !== 'outline'} id="node-library-panel-outline" role="tabpanel">
        {tab === 'outline' ? <div className="outline-tree">
          <p className="panel-kicker">{graph.label}</p>
          {graph.nodes.map((node) => (
            <button key={node.id} onClick={() => setSelected(node.id)} type="button">
              <span className={`outline-status status-${node.data.status}`} />
              <Icon name={node.data.nodeType === 'note' ? 'note' : node.data.accent === 'image' ? 'image' : 'workflow'} size={14} />
              <span>{node.data.label}</span>
              {node.data.subgraphId ? <Icon name="chevron" size={12} /> : null}
            </button>
          ))}
        </div> : null}
      </div>
    </aside>
  )
}

function CompatibleNodePicker() {
  const [query, setQuery] = useState('')
  const picker = useStudioStore((state) => state.compatiblePicker)
  const subgraphs = useStudioStore((state) => state.subgraphDefinitions)
  const addCompatible = useStudioStore((state) => state.addCompatibleNode)
  const close = useStudioStore((state) => state.closeCompatiblePicker)
  const compatible = picker ? [
    ...nodeDefinitions.filter((definition) => Object.values(definition.inputs).some((port) => {
      return picker.dataType === port.dataType || picker.dataType === 'any' || port.dataType === 'any' || (picker.dataType === 'image' && port.dataType === 'images')
    })).map((definition) => ({ type: definition.type, title: definition.title, category: definition.category, accent: definition.accent })),
    ...subgraphs.filter((definition) => definition.inputs.some((port) => {
      return picker.dataType === port.dataType || picker.dataType === 'any' || port.dataType === 'any' || (picker.dataType === 'image' && port.dataType === 'images')
    })).map((definition) => ({ type: `subgraph:${definition.id}`, title: definition.name, category: '类型化子图', accent: 'control' as const })),
  ].filter((item) => `${item.title}${item.category}`.toLowerCase().includes(query.toLowerCase())) : []
  if (!picker) return null
  return (
    <Panel className="compatible-picker" position="top-left">
      <header><div><span className={`port-dot port-${picker.dataType}`} /><strong>添加兼容节点</strong></div><button aria-label="关闭" onClick={close} type="button"><Icon name="close" size={14} /></button></header>
      <label className="search-field"><Icon name="search" size={14} /><input aria-label="搜索兼容节点" autoFocus onChange={(event) => setQuery(event.target.value)} placeholder={`接受 ${picker.dataType} 的节点`} type="search" value={query} /></label>
      <div>
        {compatible.slice(0, 7).map((definition) => (
          <button key={definition.type} onClick={() => addCompatible(definition.type)} type="button"><span className={`library-node-icon accent-${definition.accent}`}><Icon name={definition.type.startsWith('subgraph:') ? 'layers' : definition.accent === 'image' ? 'image' : 'code'} size={14} /></span><span><strong>{definition.title}</strong><small>{definition.category}</small></span><Icon name="plus" size={13} /></button>
        ))}
        {compatible.length === 0 ? <p className="compatible-empty">没有匹配的兼容节点</p> : null}
      </div>
      <footer>从端口拖到空白处可快速创建并连线</footer>
    </Panel>
  )
}

function CanvasSurface({ onNodeSelected }: { readonly onNodeSelected: () => void }) {
  const graph = useStudioStore(getActiveGraph)
  const onNodesChange = useStudioStore((state) => state.onNodesChange)
  const onEdgesChange = useStudioStore((state) => state.onEdgesChange)
  const connect = useStudioStore((state) => state.connect)
  const addNode = useStudioStore((state) => state.addNode)
  const importLocalImage = useStudioStore((state) => state.importLocalImage)
  const addSubgraphInstance = useStudioStore((state) => state.addSubgraphInstance)
  const setSelectedNode = useStudioStore((state) => state.setSelectedNode)
  const openCompatiblePicker = useStudioStore((state) => state.openCompatiblePicker)
  const closeCompatiblePicker = useStudioStore((state) => state.closeCompatiblePicker)
  const showMinimap = useStudioStore((state) => state.showMinimap)
  const gridSnap = useStudioStore((state) => state.gridSnap)
  const selectedNodeId = useStudioStore((state) => state.selectedNodeId)
  const arrangeSelectedNodes = useStudioStore((state) => state.arrangeSelectedNodes)
  const autoLayoutWorkflow = useStudioStore((state) => state.autoLayoutWorkflow)
  const copySelectedNodes = useStudioStore((state) => state.copySelectedNodes)
  const pasteCopiedNodes = useStudioStore((state) => state.pasteCopiedNodes)
  const connectSelectedNodes = useStudioStore((state) => state.connectSelectedNodes)
  const { fitView, getViewport, screenToFlowPosition, setViewport } = useReactFlow<StudioFlowNode>()
  const [marqueeSelect, setMarqueeSelect] = useState(() => {
    try {
      return window.localStorage.getItem('ai-terminal:studio-marquee:v1') !== '0'
    } catch {
      return true
    }
  })
  const toggleMarqueeSelect = () => setMarqueeSelect((current) => {
    const next = !current
    try {
      window.localStorage.setItem('ai-terminal:studio-marquee:v1', next ? '1' : '0')
    } catch {
      // Preference persistence is best-effort.
    }
    return next
  })
  // Render-time derivation only: light up edges feeding or leaving running
  // nodes without ever writing runtime state into the workflow document.
  const liveEdges = useMemo(() => {
    const runningIds = new Set(graph.nodes.filter((node) => node.data.status === 'running').map((node) => node.id))
    if (runningIds.size === 0) return [...graph.edges]
    return graph.edges.map((edge) => edge.data && (runningIds.has(edge.target) || runningIds.has(edge.source))
      ? { ...edge, data: { ...edge.data, active: true } }
      : edge)
  }, [graph.edges, graph.nodes])
  const [connectionOrigin, setConnectionOrigin] = useState<{ nodeId: string; handleId: string; port: CanvasPort } | undefined>()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef<{ width: number; height: number } | undefined>(undefined)
  const pendingCenterShiftRef = useRef({ x: 0, y: 0 })
  const initialFitTimerRef = useRef<number | undefined>(undefined)
  const resizeTimerRef = useRef<number | undefined>(undefined)
  const fittedGraphRef = useRef<string | undefined>(undefined)
  const userAdjustedViewportRef = useRef(false)
  const selectedNodeIds = useMemo(() => [...new Set([
    ...graph.nodes.filter((node) => node.selected).map((node) => node.id),
    ...(selectedNodeId ? [selectedNodeId] : []),
  ])], [graph.nodes, selectedNodeId])

  useEffect(() => {
    userAdjustedViewportRef.current = false
    fittedGraphRef.current = undefined
    pendingCenterShiftRef.current = { x: 0, y: 0 }
  }, [graph.id])

  useEffect(() => {
    if (graph.nodes.length === 0 || fittedGraphRef.current === graph.id) return undefined
    fittedGraphRef.current = graph.id
    window.clearTimeout(initialFitTimerRef.current)
    initialFitTimerRef.current = window.setTimeout(() => {
      if (!userAdjustedViewportRef.current) {
        void fitView({ duration: 180, maxZoom: 1.15, minZoom: 0.38, padding: 0.14 })
      }
    }, 110)
    return () => window.clearTimeout(initialFitTimerRef.current)
  }, [fitView, graph.id, graph.nodes.length])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const nextSize = { width: entry.contentRect.width, height: entry.contentRect.height }
      const previousSize = lastSizeRef.current
      lastSizeRef.current = nextSize
      if (graph.nodes.length === 0) return
      if (!previousSize) return
      const widthDelta = nextSize.width - previousSize.width
      const heightDelta = nextSize.height - previousSize.height
      if (Math.abs(widthDelta) < 2 && Math.abs(heightDelta) < 2) return
      pendingCenterShiftRef.current.x += widthDelta / 2
      pendingCenterShiftRef.current.y += heightDelta / 2
      window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        if (userAdjustedViewportRef.current) {
          const viewport = getViewport()
          const shift = pendingCenterShiftRef.current
          pendingCenterShiftRef.current = { x: 0, y: 0 }
          void setViewport({ ...viewport, x: viewport.x + shift.x, y: viewport.y + shift.y }, { duration: 140 })
          return
        }
        pendingCenterShiftRef.current = { x: 0, y: 0 }
        void fitView({ duration: 180, maxZoom: 1.15, minZoom: 0.38, padding: 0.14 })
      }, 110)
    })
    observer.observe(surface)
    return () => {
      observer.disconnect()
      window.clearTimeout(resizeTimerRef.current)
    }
  }, [fitView, getViewport, graph.nodes.length, setViewport])

  const startConnection = (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (!params.nodeId || !params.handleId || !params.handleId.startsWith('out:')) return setConnectionOrigin(undefined)
    const node = graph.nodes.find((item) => item.id === params.nodeId)
    const port = node?.data.outputs.find((item) => `out:${item.id}` === params.handleId)
    setConnectionOrigin(node && port ? { nodeId: node.id, handleId: params.handleId, port } : undefined)
  }
  const finishConnection = (event: MouseEvent | TouchEvent) => {
    if (!connectionOrigin) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.react-flow__pane')) return setConnectionOrigin(undefined)
    const touch = 'changedTouches' in event ? event.changedTouches.item(0) : undefined
    const position = screenToFlowPosition({ x: touch?.clientX ?? ('clientX' in event ? event.clientX : 0), y: touch?.clientY ?? ('clientY' in event ? event.clientY : 0) })
    const picker: CompatiblePickerState = { x: position.x, y: position.y, sourceNodeId: connectionOrigin.nodeId, sourceHandle: connectionOrigin.handleId, dataType: connectionOrigin.port.dataType }
    openCompatiblePicker(picker)
    setConnectionOrigin(undefined)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const type = event.dataTransfer.getData('application/x-studio-node')
    if (!type) return
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    if (type.startsWith('subgraph:')) addSubgraphInstance(type.slice('subgraph:'.length), position)
    else if (type === 'project_image') void importLocalImage(position)
    else addNode(type, position)
  }
  return (
    <div className="canvas-surface" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={onDrop} ref={surfaceRef}>
      <ReactFlow<StudioFlowNode, StudioFlowEdge>
        colorMode="dark"
        connectionLineStyle={{ stroke: 'var(--studio-brand)', strokeWidth: 2 }}
        defaultEdgeOptions={{ type: 'exposure' }}
        deleteKeyCode={null}
        edgeTypes={edgeTypes}
        edges={liveEdges}
        fitView
        fitViewOptions={{ padding: 0.14, minZoom: 0.38, maxZoom: 1.15 }}
        minZoom={0.25}
        multiSelectionKeyCode={['Control', 'Meta']}
        nodeTypes={nodeTypes}
        nodes={[...graph.nodes]}
        panActivationKeyCode="Space"
        panOnDrag={marqueeSelect ? [1, 2] : true}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag={marqueeSelect}
        onConnect={(connection: Connection) => connect(connection)}
        onConnectEnd={finishConnection}
        onConnectStart={startConnection}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => {
          setSelectedNode(node.id)
          onNodeSelected()
        }}
        onNodesChange={onNodesChange}
        onMoveStart={(event) => { if (event) userAdjustedViewportRef.current = true }}
        onPaneClick={() => closeCompatiblePicker()}
        snapGrid={[16, 16]}
        snapToGrid={gridSnap}
      >
        <Background bgColor="var(--studio-glass-canvas-solid, #0b0f16)" color="rgba(255,255,255,.11)" gap={16} size={1} variant={BackgroundVariant.Dots} />
        <Controls position="bottom-left" showInteractive={false} />
        {showMinimap ? <MiniMap className="studio-minimap" maskColor="var(--studio-minimap-mask)" nodeColor={(node) => node.data?.status === 'running' ? 'var(--studio-brand)' : node.data?.accent === 'image' ? 'var(--studio-brand)' : 'rgba(255,255,255,.42)'} pannable zoomable /> : null}
        <Panel className="canvas-status-strip" position="top-center">
          <span><i className="signal-dot" />{graph.nodes.length} 节点</span>
          <span>{graph.edges.length} 连线</span>
          <span>{gridSnap ? '网格已开启' : '自由移动'}</span>
          <button aria-label={marqueeSelect ? '切换为拖动画布' : '切换为框选节点'} aria-pressed={marqueeSelect} className={`strip-toggle${marqueeSelect ? ' is-active' : ''}`} onClick={toggleMarqueeSelect} title={marqueeSelect ? '当前：拖动即框选（空格或中键平移）' : '当前：拖动即平移画布'} type="button"><Icon name="marquee" size={13} />{marqueeSelect ? '框选' : '平移'}</button>
          <button aria-label="粘贴节点" className="strip-toggle" onClick={() => { void pasteCopiedNodes() }} title="粘贴复制的节点 · Ctrl+V" type="button"><Icon name="paste" size={13} />粘贴</button>
        </Panel>
        {selectedNodeIds.length >= 2 ? <Panel className="canvas-selection-toolbar" position="bottom-center">
          <span>{selectedNodeIds.length} 个节点</span>
          <i aria-hidden="true" />
          <button aria-label="左对齐所选节点" onClick={() => arrangeSelectedNodes('align-left')} title="左对齐" type="button"><Icon name="align-left" size={15} /></button>
          <button aria-label="水平居中所选节点" onClick={() => arrangeSelectedNodes('align-center-horizontal')} title="水平居中" type="button"><Icon name="align-center-horizontal" size={15} /></button>
          <button aria-label="右对齐所选节点" onClick={() => arrangeSelectedNodes('align-right')} title="右对齐" type="button"><Icon name="align-right" size={15} /></button>
          <button aria-label="顶部对齐所选节点" onClick={() => arrangeSelectedNodes('align-top')} title="顶部对齐" type="button"><Icon name="align-top" size={15} /></button>
          <button aria-label="垂直居中所选节点" onClick={() => arrangeSelectedNodes('align-center-vertical')} title="垂直居中" type="button"><Icon name="align-center-vertical" size={15} /></button>
          <button aria-label="底部对齐所选节点" onClick={() => arrangeSelectedNodes('align-bottom')} title="底部对齐" type="button"><Icon name="align-bottom" size={15} /></button>
          <i aria-hidden="true" />
          <button aria-label="水平等距排列所选节点" onClick={() => arrangeSelectedNodes('distribute-horizontal')} title="水平等距" type="button"><Icon name="distribute-horizontal" size={15} /></button>
          <button aria-label="垂直等距排列所选节点" onClick={() => arrangeSelectedNodes('distribute-vertical')} title="垂直等距" type="button"><Icon name="distribute-vertical" size={15} /></button>
          <i aria-hidden="true" />
          <button aria-label="复制所选节点" onClick={copySelectedNodes} title="复制 · Ctrl+C" type="button"><Icon name="copy" size={15} /></button>
          {selectedNodeIds.length === 2 ? <button aria-label="连接所选的两个节点" onClick={connectSelectedNodes} title="按兼容端口快捷连接" type="button"><Icon name="link" size={15} /></button> : null}
          <button aria-label="按依赖关系整理所选节点" className="selection-auto-layout" onClick={() => autoLayoutWorkflow('selected')} title="整理所选" type="button"><Icon name="fit" size={15} /><span>整理</span></button>
        </Panel> : null}
        <CompatibleNodePicker />
      </ReactFlow>
    </div>
  )
}

function ParameterInput({ node, name, value }: { readonly node: StudioFlowNode; readonly name: string; readonly value: unknown }) {
  const update = useStudioStore((state) => state.updateNodeParameter)
  const chooseProjectImage = useStudioStore((state) => state.chooseProjectImage)
  const providers = useStudioStore((state) => state.providers)
  const refreshProviders = useStudioStore((state) => state.refreshProviders)
  const definition = parameterDefinition(node, name)
  const label = parameterLabel(node, name)
  const providerId = String(node.data.parameters.providerId ?? '').trim()
  const provider = providers.find((item) => item.id === providerId)
  const accountProvider = provider && isAiTerminalAccountProvider(provider) ? provider : undefined
  const groups = accountProviders(providers)
  const model = String(node.data.parameters.model ?? accountProvider?.model ?? '').trim()
  const confirmedOnly = isConfirmedOnlyProviderModel(accountProvider, model)
  const capability = accountProvider
    ? providerCapabilityProfile({ kind: accountProvider.kind, model, confirmedOnly })
    : undefined
  const sizeMatchesSuggestion = name === 'size' && [
    ...(capability?.sizes ?? []),
    ...(definition?.options?.map((option) => option.value) ?? []),
  ].includes(String(value))
  const [customSizeMode, setCustomSizeMode] = useState(name === 'size' && !sizeMatchesSuggestion)
  useEffect(() => {
    if (name === 'size') setCustomSizeMode(!sizeMatchesSuggestion)
  }, [name, node.id, sizeMatchesSuggestion, value])
  const fieldState = definition
    ? evaluateParameterField(definition, value, {
        parameters: node.data.parameters,
        ...(capability ? { capabilities: capability } : {}),
      })
    : { visible: true, disabled: false }
  if (!fieldState.visible || (confirmedOnly && confirmedOnlyOmittedParameters.has(name))) return null
  const fieldId = `parameter-${node.id}-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const legacyDisabledReason = name === 'responseFormat' && isGptImageModel(model)
    ? '当前模型不接收此兼容字段。'
    : name === 'inputFidelity' && isGptImage2Model(model)
      ? '当前模型不接收此兼容字段。'
      : undefined
  const disabledReason = fieldState.disabled
    ? name === 'seed'
      ? `${model || '当前模型'} 不支持 Seed；此值不会发送。`
      : name === 'outputFormat'
        ? `${model || '当前模型'} 不支持指定输出格式；最终格式由模型服务决定。`
        : name === 'outputCompression'
          ? `${model || '当前模型'} 不接收 output_format，因此不会发送压缩质量。`
          : fieldState.disabledReason
    : legacyDisabledReason
  const disabled = fieldState.disabled || Boolean(legacyDisabledReason)
  const describedBy = [
    fieldState.error ? `${fieldId}-error` : undefined,
    disabledReason ? `${fieldId}-disabled` : undefined,
    definition?.help || definition?.example ? `${fieldId}-help` : undefined,
  ].filter(Boolean).join(' ') || undefined
  const messages = (contextHelp?: string) => <>
    {fieldState.error ? <small className="field-error" id={`${fieldId}-error`} role="alert">{fieldState.error}</small> : null}
    {disabledReason ? <small className="field-capability-hint" id={`${fieldId}-disabled`}>{disabledReason}</small> : null}
    {definition?.help || definition?.example || contextHelp ? <small className="field-help" id={`${fieldId}-help`}>{contextHelp ?? definition?.help}{definition?.example ? ` 示例：${definition.example}` : ''}</small> : null}
  </>
  if (definition?.kind === 'boolean' || typeof value === 'boolean') return <Toggle checked={Boolean(value)} label={label} onChange={() => update(node.id, name, !value)} />
  if (definition?.kind === 'number' || typeof value === 'number') {
    return <label className="field"><span>{label}</span><input aria-describedby={describedBy} aria-invalid={fieldState.error ? true : undefined} aria-label={label} disabled={disabled} max={definition?.max} min={definition?.min} onChange={(event) => update(node.id, name, event.target.value === '' ? '' : Number(event.target.value))} placeholder={definition?.placeholder} required={definition?.required} step={definition?.step} type="number" value={typeof value === 'number' || typeof value === 'string' ? value : ''} />{messages()}</label>
  }
  if (name === 'providerId') {
    const legacyValue = provider && !isAiTerminalAccountProvider(provider) ? provider.id : ''
    return (
      <div className="field account-group-field">
        <label htmlFor={fieldId}>{label}</label>
        <div className="account-group-input">
          <StudioSelect
            ariaLabel={label}
            describedBy={describedBy}
            disabled={disabled}
            id={fieldId}
            invalid={Boolean(fieldState.error)}
            onChange={(nextValue) => update(node.id, name, nextValue)}
            options={[
              ...(legacyValue ? [{ value: legacyValue, label: '原分组不可用', disabled: true }] : []),
              ...groups.map((group) => ({ value: group.id, label: accountGroupLabel(group) })),
            ]}
            placeholder="选择分组"
            required={definition?.required}
            value={String(value)}
          />
          <button aria-label="刷新分组" disabled={disabled} onClick={() => void refreshProviders()} title="刷新" type="button"><Icon name="pulse" size={13} /></button>
        </div>
        {groups.length === 0 ? <small className="field-capability-hint">暂无可用分组。</small> : null}
        {messages(`${groups.length} 个分组`)}
      </div>
    )
  }
  if (name === 'model') {
    const models = accountProvider ? providerModelOptions(accountProvider) : []
    const currentModel = String(value)
    const modelOptions = [
      ...(!models.includes(currentModel) && currentModel ? [{ value: currentModel, label: currentModel }] : []),
      ...models.map((modelOption) => ({ value: modelOption, label: modelOption })),
    ]
    return (
      <div className="field">
        <span>{label}</span>
        <StudioSelect
          ariaLabel={label}
          describedBy={describedBy}
          disabled={disabled || !accountProvider || models.length === 0}
          invalid={Boolean(fieldState.error)}
          onChange={(nextValue) => update(node.id, name, nextValue)}
          options={modelOptions}
          placeholder={accountProvider ? '选择模型' : '先选择分组'}
          required={definition?.required}
          value={currentModel}
        />
        {messages(accountProvider ? `${models.length} 个模型` : '选择分组后显示可用模型。')}
      </div>
    )
  }
  if (definition?.kind === 'textarea' || name === 'text' || name === 'template' || name === 'prompt' || name === 'comfyPrompt') return <label className="field"><span>{label}</span><textarea aria-describedby={describedBy} aria-invalid={fieldState.error ? true : undefined} aria-label={label} className={name === 'comfyPrompt' || name === 'comfyBindings' ? 'code-textarea' : undefined} disabled={disabled} onChange={(event) => update(node.id, name, event.target.value)} placeholder={definition?.placeholder} required={definition?.required} rows={name === 'comfyPrompt' || name === 'comfyBindings' ? 10 : 4} value={String(value)} />{messages()}</label>
  if (name === 'size' && definition?.options) {
    const knownSizes = capability?.sizes ?? []
    const suggestedLabels = new Map(definition.options.map((option) => [option.value, option.label]))
    const optionMap = new Map<string, { readonly label: string; readonly value: string }>()
    knownSizes.forEach((size) => optionMap.set(size, { label: suggestedLabels.get(size) ?? size, value: size }))
    definition.options.forEach((option) => {
      if (!optionMap.has(option.value)) optionMap.set(option.value, option)
    })
    const grouped = [
      { label: '自动', options: [...optionMap.values()].filter((option) => option.value === 'auto') },
      { label: '方形', options: [...optionMap.values()].filter((option) => { const match = /^(\d+)x(\d+)$/i.exec(option.value); return match ? match[1] === match[2] : false }) },
      { label: '横向', options: [...optionMap.values()].filter((option) => { const match = /^(\d+)x(\d+)$/i.exec(option.value); return match ? Number(match[1]) > Number(match[2]) : false }) },
      { label: '纵向', options: [...optionMap.values()].filter((option) => { const match = /^(\d+)x(\d+)$/i.exec(option.value); return match ? Number(match[1]) < Number(match[2]) : false }) },
    ]
    const sizeOptions = grouped.flatMap((group) => group.options.map((option) => ({ ...option, group: group.label })))
    sizeOptions.push({ value: '__custom__', label: '自定义尺寸…', group: '自定义' })
    const currentValue = String(value)
    const selectValue = customSizeMode || !optionMap.has(currentValue) ? '__custom__' : currentValue
    return <div className="field size-parameter-field"><span className="size-parameter-label">{label}</span><StudioSelect ariaLabel={label} describedBy={describedBy} disabled={disabled} id={fieldId} invalid={Boolean(fieldState.error)} onChange={(nextValue) => { if (nextValue === '__custom__') { setCustomSizeMode(true); return } setCustomSizeMode(false); update(node.id, name, nextValue) }} options={sizeOptions} placeholder="选择尺寸" required={definition.required} value={selectValue} />{customSizeMode ? <label className="size-custom-entry"><span>自定义尺寸</span><input aria-describedby={describedBy} aria-invalid={fieldState.error ? true : undefined} aria-label="自定义尺寸" autoFocus disabled={disabled} onChange={(event) => update(node.id, name, event.target.value)} placeholder="例如 1600x900" required={definition.required} value={currentValue} /></label> : null}{messages(knownSizes.length > 0 ? `${model} 的内置基础建议：${knownSizes.join('、')}；下拉仍完整列出常用尺寸，最终由上游接口决定。` : '下拉完整列出常用尺寸；客户端不按尺寸白名单拦截，最终由上游接口决定。')}</div>
  }
  if (definition?.kind === 'select' && definition.options) {
    return <div className="field"><span>{label}</span><StudioSelect ariaLabel={label} describedBy={describedBy} disabled={disabled} invalid={Boolean(fieldState.error)} onChange={(nextValue) => update(node.id, name, nextValue)} options={definition.options.map((option) => ({ value: option.value, label: option.label }))} placeholder="选择" required={definition.required} value={String(value)} />{messages()}</div>
  }
  if (definition?.kind === 'path' || name === 'path' || name === 'maskPath') return <label className="field"><span>{label}</span><div className="path-input-row"><input aria-describedby={describedBy} aria-invalid={fieldState.error ? true : undefined} aria-label={label} disabled={disabled} onChange={(event) => update(node.id, name, event.target.value)} placeholder={definition?.placeholder ?? 'assets/... 或 outputs/...'} required={definition?.required} value={String(value)} /><button disabled={disabled} onClick={() => void chooseProjectImage(node.id, name)} title="选择外部图片并安全复制到项目" type="button"><Icon name="folder" size={13} />导入</button></div>{messages('只保存项目相对路径；外部文件会先校验完整图片再复制。')}</label>
  return <label className="field"><span>{label}</span><input aria-describedby={describedBy} aria-invalid={fieldState.error ? true : undefined} aria-label={label} disabled={disabled} onChange={(event) => update(node.id, name, event.target.value)} placeholder={definition?.placeholder} required={definition?.required} value={String(value)} />{messages()}</label>
}

function ProjectImageInspector({ node }: { readonly node: StudioFlowNode }) {
  const chooseProjectImage = useStudioStore((state) => state.chooseProjectImage)
  const clearProjectImage = useStudioStore((state) => state.clearProjectImage)
  const ensureProjectImagePreview = useStudioStore((state) => state.ensureProjectImagePreview)
  const localImageImporting = useStudioStore((state) => state.localImageImporting)
  const activeGraphId = useStudioStore((state) => state.activeGraphId)
  const path = String(node.data.parameters.path ?? '').trim()
  const previewUrl = typeof node.data.previewUrl === 'string' ? node.data.previewUrl : ''
  const previewLoading = node.data.previewLoading === true
  const previewError = typeof node.data.previewError === 'string' ? node.data.previewError : ''
  const fileName = projectImageFileName(path)
  const choose = () => void chooseProjectImage(node.id, 'path')

  return (
    <section className="inspector-section project-image-inspector">
      <div className="inspector-section-title"><h3>本地图片</h3><small>项目素材</small></div>
      {previewUrl ? (
        <div className="project-image-inspector-preview">
          <img alt={`${node.data.label}本地图片预览：${fileName}`} src={previewUrl} />
          <span><strong title={fileName}>{fileName}</strong><small>{projectImageDimensions(node)}</small></span>
        </div>
      ) : path ? (
        <button aria-busy={previewLoading} className={`project-image-inspector-empty ${previewError ? 'has-error' : 'is-loading'}`} disabled={previewLoading} onClick={() => void ensureProjectImagePreview(activeGraphId, node.id, path, true)} title={previewError ? `重新载入图片预览：${previewError}` : '正在载入图片预览'} type="button">
          <Icon name={previewError ? 'error' : 'image'} size={22} />
          <span><strong>{previewError ? '预览暂不可用' : fileName}</strong><small>{previewError ? '点击重试' : '正在载入安全预览…'}</small></span>
        </button>
      ) : (
        <button className="project-image-inspector-empty" disabled={localImageImporting} onClick={choose} title="从电脑选择本地图片" type="button">
          <Icon name="folder" size={22} />
          <span><strong>{localImageImporting ? '正在载入图片' : '选择本地图片'}</strong><small>PNG、JPEG、WebP 或 GIF</small></span>
        </button>
      )}
      {path ? <div className="project-image-path"><span>项目相对路径</span><code title={path}>{path}</code></div> : null}
      {path ? <div className="project-image-actions">
        <button className="secondary-button" disabled={localImageImporting} onClick={choose} title="选择另一张图片并保留原素材文件" type="button"><Icon name="folder" size={13} />{localImageImporting ? '载入中' : '替换图片'}</button>
        <button className="danger-ghost" disabled={!path || localImageImporting} onClick={() => clearProjectImage(node.id)} title="仅清除节点引用，不删除磁盘文件" type="button"><Icon name="close" size={13} />清除引用</button>
      </div> : null}
      <p className="field-help">图片会校验后复制到项目；清除引用不会删除磁盘文件。</p>
    </section>
  )
}

const debugJson = (value: unknown): string => {
  try { return JSON.stringify(value ?? {}, null, 2) ?? '{}' } catch { return '{}' }
}

function DebugOutputEditor({ node }: { readonly node: StudioFlowNode }) {
  const update = useStudioStore((state) => state.updateNodeData)
  const [draft, setDraft] = useState(() => debugJson(node.data.debugOutput))
  const [error, setError] = useState<string>()
  useEffect(() => {
    setDraft(debugJson(node.data.debugOutput))
    setError(undefined)
  }, [node.id, node.data.debugOutput])
  const apply = () => {
    if (draft.length > 1_048_576) return setError('调试输出不能超过 1 MiB')
    try {
      update(node.id, { debugOutput: JSON.parse(draft) as unknown })
      setError(undefined)
    } catch {
      setError('请输入有效 JSON；键名应对应节点输出端口')
    }
  }
  return <div className="debug-output-editor"><label className="field"><span>{node.data.pinned ? '固定输出数据' : '模拟输出数据'}</span><textarea className="code-textarea" onChange={(event) => { setDraft(event.target.value); setError(undefined) }} rows={7} spellCheck={false} value={draft} /></label><small className={error ? 'is-error' : ''}>{error ?? `输出项：${node.data.outputs.map((port) => port.label).join('、') || '无'}；保存后会用于本次运行。`}</small><button className="secondary-button" onClick={apply} type="button"><Icon name="check" size={13} />应用调试输出</button></div>
}

function NodeInspector() {
  const graph = useStudioStore(getActiveGraph)
  const selectedNodeId = useStudioStore((state) => state.selectedNodeId)
  const updateNodeData = useStudioStore((state) => state.updateNodeData)
  const toggle = useStudioStore((state) => state.toggleNodeFlag)
  const remove = useStudioStore((state) => state.removeSelectedNodes)
  const duplicate = useStudioStore((state) => state.duplicateSelectedNodes)
  const linearDefinition = useStudioStore((state) => state.linearDefinition)
  const setLinearField = useStudioStore((state) => state.setLinearField)
  const activeGraphId = useStudioStore((state) => state.activeGraphId)
  const providers = useStudioStore((state) => state.providers)
  const [tab, setTab] = useState<'params' | 'notes' | 'performance'>('params')
  const scrollRef = useRef<HTMLDivElement>(null)
  const node = graph.nodes.find((item) => item.id === selectedNodeId)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [selectedNodeId, tab])
  if (!node) return (
    <aside className="node-inspector inspector-empty"><Icon name="workflow" size={28} /><h2>未选择节点</h2><p>选择画布节点以编辑参数、调试输出和查看运行性能。</p></aside>
  )
  const providerId = String(node.data.parameters.providerId ?? '').trim()
  const provider = providers.find((item) => item.id === providerId)
  const model = String(node.data.parameters.model ?? provider?.model ?? '').trim()
  const confirmedOnly = isConfirmedOnlyProviderModel(provider, model)
  const capability = provider && remoteImageNodeTypes.has(node.data.nodeType)
    ? providerCapabilityProfile({ kind: provider.kind, model, confirmedOnly })
    : undefined
  const visibleParameterEntries = Object.entries(node.data.parameters)
    .filter(([name]) => node.data.nodeType !== 'project_image' || name !== 'path')
    .filter(([name]) => !isTopRouteParameter(node.data.nodeType, name))
    .filter(([name]) => !confirmedOnly || !confirmedOnlyOmittedParameters.has(name))
    .filter(([name]) => !isLegacyComfyParameter(node.data.nodeType, name))
    .filter(([name, value]) => {
      const definition = parameterDefinition(node, name)
      return !definition || evaluateParameterField(definition, value, {
        parameters: node.data.parameters,
        ...(capability ? { capabilities: capability } : {}),
      }).visible
    })
  return (
    <aside aria-label="节点属性" className="node-inspector">
      <header className="inspector-header">
        <div className={`inspector-icon accent-${node.data.accent}`}><Icon name={node.data.accent === 'image' ? 'image' : 'code'} size={18} /></div>
        <div><p>{node.data.category} / {node.data.nodeType}</p><input aria-label="节点名称" onChange={(event) => updateNodeData(node.id, { label: event.target.value })} value={node.data.label} /></div>
        <IconButton icon="copy" label="复制节点" onClick={duplicate} />
      </header>
      <div className="inspector-state-row"><StatusPill label={node.data.status === 'running' ? '正在执行' : node.data.status === 'success' ? '执行成功' : '就绪'} status={node.data.status} />{node.data.runtimeMs !== undefined ? <span><Icon name="clock" size={13} />{node.data.runtimeMs} ms</span> : null}{node.data.cacheHit ? <span className="cache-label">缓存命中</span> : null}</div>
      <div aria-label="节点属性分区" className="panel-tabs inspector-tabs" role="tablist">
        <button aria-controls="node-inspector-panel-params" aria-selected={tab === 'params'} className={tab === 'params' ? 'is-active' : ''} id="node-inspector-tab-params" onClick={() => setTab('params')} onKeyDown={(event) => activateTabFromKeyboard(event, inspectorTabs, setTab)} role="tab" tabIndex={tab === 'params' ? 0 : -1} type="button">参数</button>
        <button aria-controls="node-inspector-panel-notes" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'is-active' : ''} id="node-inspector-tab-notes" onClick={() => setTab('notes')} onKeyDown={(event) => activateTabFromKeyboard(event, inspectorTabs, setTab)} role="tab" tabIndex={tab === 'notes' ? 0 : -1} type="button">注释</button>
        <button aria-controls="node-inspector-panel-performance" aria-selected={tab === 'performance'} className={tab === 'performance' ? 'is-active' : ''} id="node-inspector-tab-performance" onClick={() => setTab('performance')} onKeyDown={(event) => activateTabFromKeyboard(event, inspectorTabs, setTab)} role="tab" tabIndex={tab === 'performance' ? 0 : -1} type="button">性能</button>
      </div>
      <div className="inspector-scroll" ref={scrollRef}>
        <div aria-labelledby="node-inspector-tab-params" hidden={tab !== 'params'} id="node-inspector-panel-params" role="tabpanel">
          {tab === 'params' ? (
            <>
            {node.data.nodeType === 'project_image' ? <ProjectImageInspector node={node} /> : null}
            {capability ? <div className="settings-callout provider-capability-callout"><Icon name="pulse" size={16} /><p><strong>能力说明 · {provider?.name} / {model || '未指定模型'}</strong><span>生成：{supportLabel(capability.generation)} · 编辑：{supportLabel(capability.editing)} · 参考图：{supportLabel(capability.referenceImages)} · 随机种子：{supportLabel(capability.seed)}</span><small>尺寸：{supportLabel(capability.size)}{capability.sizes.length > 0 ? `（建议：${capability.sizes.join('、')}）` : ''}；输出格式：{supportLabel(capability.outputFormat)}{capability.outputFormats.length > 0 ? `（${capability.outputFormats.join('、')}）` : ''}。尺寸可按模型服务支持范围填写；不支持的选项会在运行前提示。</small></p></div> : null}
            {isGptImageModel(String(node.data.parameters.model ?? '')) ? <div className="settings-callout"><Icon name="info" size={16} /><p><strong>{isGptImage2Model(String(node.data.parameters.model ?? '')) ? 'GPT Image 2 能力档案已启用' : 'GPT Image 能力档案已启用'}</strong><span>{isGptImage2Model(String(node.data.parameters.model ?? '')) ? '固定接收 base64 并使用 output_format；客户端会省略 response_format、input_fidelity 和 seed，透明背景会在派发前阻止。' : '固定接收 base64，生成使用 output_format、编辑使用 image[]；客户端会省略 response_format 和 seed。'}</span></p></div> : null}
            {visibleParameterEntries.length > 0 ? <section className="inspector-section"><div className="inspector-section-title"><h3>节点参数</h3><small>显示在参数视图</small></div>{visibleParameterEntries.map(([name, value]) => { const label = parameterLabel(node, name); const exposed = linearDefinition.fields.some((field) => field.nodeId === node.id && field.parameter === name); const exposable = activeGraphId === 'root' && (typeof value === 'string' || typeof value === 'number'); return <div className="linear-author-field" key={name}><ParameterInput name={name} node={node} value={value} /><button aria-label={`${exposed ? '从参数视图隐藏' : '显示在参数视图'}：${label}`} className={exposed ? 'is-active' : ''} disabled={!exposable} onClick={() => setLinearField(node.id, name, label, !exposed)} title={exposable ? (exposed ? '参数视图当前可见' : '参数视图当前不可见') : '只有主工作流中的文本或数值参数可显示'} type="button"><Icon name={exposed ? 'eye' : 'plus'} size={12} /></button></div> })}</section> : null}
            <section className="inspector-section"><h3>调试控制</h3>
              <Toggle checked={Boolean(node.data.pinned)} detail="固定下方配置的输出，本节点不再执行" label="固定输出" onChange={() => toggle(node.id, 'pinned')} />
              <Toggle checked={Boolean(node.data.mocked)} detail="使用下方本地数据验证后续节点，不调用本节点" label="模拟输出" onChange={() => toggle(node.id, 'mocked')} />
              {node.data.pinned || node.data.mocked ? <DebugOutputEditor node={node} /> : null}
              <Toggle checked={Boolean(node.data.bypassed)} detail="执行时跳过并转发兼容数据" label="跳过节点" onChange={() => toggle(node.id, 'bypassed')} />
            </section>
            <section className="inspector-section"><h3>端口</h3><div className="port-inspector-list">{[
              ...node.data.inputs.map((port) => ({ direction: 'in', port })),
              ...node.data.outputs.map((port) => ({ direction: 'out', port })),
            ].map(({ direction, port }) => <div key={`${direction}-${port.id}`}><span className={`port-dot port-${port.dataType}`} /><span>{port.label}</span><code>{port.dataType}</code></div>)}</div></section>
            </>
          ) : null}
        </div>
        <div aria-labelledby="node-inspector-tab-notes" hidden={tab !== 'notes'} id="node-inspector-panel-notes" role="tabpanel">
          {tab === 'notes' ? <section className="inspector-section"><h3>节点注释</h3><label className="field"><span>说明</span><textarea onChange={(event) => updateNodeData(node.id, { annotation: event.target.value })} placeholder="记录意图、限制或交付检查…" rows={10} value={node.data.annotation ?? ''} /></label><p className="field-help">注释随工作流保存，不会发送给模型服务。</p></section> : null}
        </div>
        <div aria-labelledby="node-inspector-tab-performance" hidden={tab !== 'performance'} id="node-inspector-panel-performance" role="tabpanel">
          {tab === 'performance' ? <section className="inspector-section"><h3>本次运行</h3><ExposureRail active={node.data.status === 'success' ? 4 : node.data.status === 'running' ? 1 : 0} /><dl className="metric-list"><div><dt>节点状态</dt><dd>{node.data.status}</dd></div><div><dt>已知耗时</dt><dd>{node.data.runtimeMs !== undefined ? `${node.data.runtimeMs} ms` : '暂无'}</dd></div><div><dt>缓存命中</dt><dd>{node.data.cacheHit ? '是' : '否'}</dd></div></dl><p className="field-help"><Icon name="shield" size={13} />分阶段真实耗时请在左侧“记录”页查看和导出。</p></section> : null}
        </div>
      </div>
      <footer className="inspector-footer"><button className="danger-ghost" onClick={remove} type="button"><Icon name="trash" size={14} />删除节点</button><button className="secondary-button" onClick={duplicate} type="button"><Icon name="copy" size={14} />复制</button></footer>
    </aside>
  )
}

function BottomDock() {
  const isOpen = useStudioStore((state) => state.bottomOpen)
  const active = useStudioStore((state) => state.bottomPanel)
  const setPanel = useStudioStore((state) => state.setBottomPanel)
  const toggle = useStudioStore((state) => state.toggleBottom)
  const queue = useStudioStore((state) => state.queue)
  const timeline = useStudioStore((state) => state.timeline)
  const navigate = useStudioStore((state) => state.navigate)
  const { snapshot: workspaceLayout, actions: workspaceLayoutActions } = useWorkspaceLayout()
  const activeTask = queue.find((item) => item.status === 'running') ?? queue.find((item) => item.status === 'queued' && item.persistentStatus !== 'paused')
  const activeTaskCount = queue.filter((item) => item.status === 'running' || (item.status === 'queued' && item.persistentStatus !== 'paused')).length
  if (!isOpen) return <button aria-label="展开运行面板" className="bottom-dock-collapsed" onClick={toggle} type="button"><Icon name="pulse" size={14} />运行面板 {activeTaskCount > 0 ? <span>{activeTaskCount}</span> : null}<Icon name="chevron-up" size={13} /></button>
  const tabs = [
    { id: 'live' as const, label: '运行', icon: 'pulse' as const },
  ]
  const tabIds = tabs.map((tab) => tab.id)
  return (
    <section
      aria-label="底部运行面板"
      className="bottom-dock"
      style={{ position: 'relative', height: `min(${workspaceLayout.studioDockHeight}px, 52dvh)` }}
    >
      <div
        aria-label="调整运行面板高度"
        aria-orientation="horizontal"
        aria-valuemax={420}
        aria-valuemin={96}
        aria-valuenow={workspaceLayout.studioDockHeight}
        role="separator"
        style={{ position: 'absolute', top: -4, right: 0, left: 0, height: 8, cursor: 'row-resize', touchAction: 'none', zIndex: 5 }}
        tabIndex={0}
        onPointerDown={(event) => beginPointerResize({
          event,
          axis: 'vertical',
          startSize: workspaceLayout.studioDockHeight,
          direction: -1,
          onResize: workspaceLayoutActions.resizeStudioDock,
        })}
        onKeyDown={(event) => resizeFromKeyboard({
          event,
          axis: 'vertical',
          currentSize: workspaceLayout.studioDockHeight,
          direction: -1,
          onResize: workspaceLayoutActions.resizeStudioDock,
        })}
      />
      <header>
        <div aria-label="运行面板分区" className="bottom-tabs" role="tablist">{tabs.map((tab) => <button aria-controls={`bottom-dock-panel-${tab.id}`} aria-selected={active === tab.id} className={active === tab.id ? 'is-active' : ''} id={`bottom-dock-tab-${tab.id}`} key={tab.id} onClick={() => setPanel(tab.id)} onKeyDown={(event) => activateTabFromKeyboard(event, tabIds, setPanel)} role="tab" tabIndex={active === tab.id ? 0 : -1} type="button"><Icon name={tab.icon} size={14} />{tab.label}</button>)}</div>
        <div className="bottom-actions"><span className="connection-indicator"><i />状态</span><IconButton icon="external" label="打开运行记录" onClick={() => navigate('runs')} /><IconButton icon="chevron-down" label="收起运行面板" onClick={toggle} /></div>
      </header>
      <div className="bottom-content">
        <div aria-labelledby="bottom-dock-tab-live" hidden={active !== 'live'} id="bottom-dock-panel-live" role="tabpanel">{active === 'live' ? <><div className="live-run-summary"><span className="run-glyph"><Icon name="spark" size={20} /></span><div><strong>{activeTask?.title ?? '当前没有运行任务'}</strong><small>{activeTask ? `${activeTask.id} · ${activeTask.message}` : '确认执行计划后会显示实时阶段；完整任务请打开左侧“任务”'}</small></div><StatusPill label={activeTask?.status === 'running' ? '执行中' : activeTask?.status === 'queued' ? '等待' : '空闲'} status={activeTask?.status ?? 'pending'} /></div>{activeTask?.status === 'running' ? <div className="timeline-waterfall compact-waterfall">{timeline.map((stage, index) => <div className={`waterfall-stage status-${stage.status}`} key={stage.id} style={{ flex: Math.max(stage.durationMs, 320) }}><span>{index + 1}</span><strong>{stage.label}</strong><small>{stage.durationMs ? `${stage.durationMs} ms` : '等待'}</small></div>)}</div> : null}</> : null}</div>
      </div>
    </section>
  )
}

function LinearFieldControl({ field, value, update }: { readonly field: LinearField; readonly value: string | number | undefined; update(id: string, value: string | number): void }) {
  const detail = field.description ? <small>{field.description}</small> : null
  if (typeof value === 'number') return <label className="field"><span>{field.label}</span><input max={field.parameter === 'count' ? 8 : undefined} min={field.parameter === 'count' ? 1 : field.parameter === 'seed' ? 0 : undefined} onChange={(event) => update(field.id, Number(event.target.value))} type="number" value={value} />{detail}</label>
  if (field.parameter === 'text' || field.parameter === 'prompt' || field.id === 'prompt') return <label className="field large-field"><span>{field.label}</span><textarea maxLength={4000} onChange={(event) => update(field.id, event.target.value)} rows={7} value={String(value ?? '')} /><small>{String(value ?? '').length} / 4000{field.description ? ` · ${field.description}` : ''}</small></label>
  return <label className="field"><span>{field.label}</span><input onChange={(event) => update(field.id, event.target.value)} value={String(value ?? '')} />{detail}</label>
}

function LinearView() {
  const values = useStudioStore((state) => state.linearValues)
  const definition = useStudioStore((state) => state.linearDefinition)
  const update = useStudioStore((state) => state.updateLinearValue)
  const run = useStudioStore((state) => state.runWorkflow)
  const graph = useStudioStore((state) => state.graphs.root ?? getActiveGraph(state))
  const assets = useStudioStore((state) => state.assets)
  const workflowId = useStudioStore((state) => state.workflowId)
  const ensureAssetPreview = useStudioStore((state) => state.ensureAssetPreview)
  const navigate = useStudioStore((state) => state.navigate)
  const setView = useStudioStore((state) => state.setWorkflowView)
  const latestAsset = useMemo(() => assets
    .filter((asset) => asset.workflow === workflowId)
    .slice()
    .sort((left, right) => Date.parse(right.createdAtIso ?? '') - Date.parse(left.createdAtIso ?? ''))[0], [assets, workflowId])
  useEffect(() => {
    if (!latestAsset || latestAsset.previewUrl) return
    void ensureAssetPreview(latestAsset.id)
  }, [ensureAssetPreview, latestAsset?.id, latestAsset?.previewUrl])
  const visibleFields = useMemo(() => {
    const nodeTypesById = new Map(graph.nodes.map((node) => [node.id, node.data.nodeType]))
    return definition.fields.filter((field) => !isTopRouteParameter(nodeTypesById.get(field.nodeId) ?? '', field.parameter))
  }, [definition, graph.nodes])
  const groups = useMemo(() => {
    const result: { readonly name: string; readonly fields: LinearField[] }[] = []
    visibleFields.slice().sort((left, right) => left.order - right.order).forEach((field) => {
      const current = result.find((group) => group.name === field.group)
      if (current) current.fields.push(field)
      else result.push({ name: field.group, fields: [field] })
    })
    return result
  }, [visibleFields])
  const promptField = visibleFields.find((field) => field.parameter === 'text' || field.parameter === 'prompt' || field.id === 'prompt')
  const appendStyle = (style: string) => {
    if (!promptField) return
    const current = String(values[promptField.id] ?? '').trim()
    update(promptField.id, current ? `${current}, ${style}` : style)
  }
  const countField = visibleFields.find((field) => field.parameter === 'count')
  const modelField = definition.fields.find((field) => field.parameter === 'model')
  const sizeField = visibleFields.find((field) => field.parameter === 'size')
  const outputCount = Number(countField ? values[countField.id] : 1)
  return (
    <main className="linear-view">
      <section className="linear-form-panel">
        <div className="linear-heading"><span className="eyebrow">LINEAR VIEW</span><h1>{definition.title || `${graph.label} · 生成面板`}</h1><p>{definition.description}</p></div>
        {groups.map((group, index) => <div className="linear-section" key={group.name}><header><span>{String(index + 1).padStart(2, '0')}</span><div><h2>{group.name}</h2><p>{group.fields.length} 个由作者公开的参数。</p></div></header><div className={group.fields.some((field) => field.id === promptField?.id) ? '' : 'linear-field-grid'}>{group.fields.map((field) => <LinearFieldControl field={field} key={field.id} update={update} value={values[field.id]} />)}</div>{promptField && group.fields.some((field) => field.id === promptField.id) ? <div className="style-chip-row"><button onClick={() => appendStyle('cinematic lighting')} type="button">+ 电影质感</button><button onClick={() => appendStyle('rainy night atmosphere')} type="button">+ 雨夜氛围</button><button onClick={() => appendStyle('architectural photography')} type="button">+ 建筑摄影</button></div> : null}</div>)}
        {groups.length === 0 ? <div className="linear-empty"><Icon name="eye" size={25} /><strong>尚未选择要显示的参数</strong><span>返回画布，在节点参数右侧点击“显示在参数视图”。</span><button className="secondary-button" onClick={() => setView('canvas')} type="button">返回画布配置</button></div> : null}
        <PresetRack />
        <footer className="linear-run-bar"><div><span>预计输出 <strong>{Number.isFinite(outputCount) ? outputCount : 1}</strong> 张</span><span>费用风险 <strong>模型服务未提供估算</strong></span><small>执行前会显示运行内容，失败请求不会自动重试。</small></div><button className="primary-button" onClick={() => void run()} type="button"><Icon name="play" size={16} />生成候选</button></footer>
      </section>
      <aside className="linear-preview-panel"><header><div><span className="signal-dot" />最新结果</div><button onClick={() => navigate('assets')} type="button"><Icon name="external" size={14} />打开作品库</button></header><div className="linear-preview-art">{latestAsset?.previewUrl ? <img alt={latestAsset.title} src={latestAsset.previewUrl} /> : <div className={`art-preview tone-${latestAsset?.tone ?? 'mono'}`}><span className="art-horizon" /><span className="art-structure art-structure-a" /><span className="art-structure art-structure-b" /><span className="art-glow" /><span className="art-grain" /></div>}<span className="proof-mark">{latestAsset ? '最新' : '暂无结果'}</span></div><div className="linear-preview-meta"><strong>{latestAsset?.title ?? '尚未生成作品'}</strong><ExposureRail active={latestAsset ? 4 : 0} /><dl><div><dt>工作流</dt><dd>{latestAsset?.workflow ?? graph.label}</dd></div><div><dt>模型</dt><dd>{latestAsset?.model ?? String(modelField ? values[modelField.id] ?? '—' : '未显示')}</dd></div><div><dt>尺寸</dt><dd>{latestAsset?.size ?? String(sizeField ? values[sizeField.id] ?? '—' : '未显示')}</dd></div></dl></div></aside>
    </main>
  )
}

const commaValues = (value: string): readonly string[] => [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]

function PresetRack() {
  const presets = useStudioStore((state) => state.presets)
  const values = useStudioStore((state) => state.linearValues)
  const definition = useStudioStore((state) => state.linearDefinition)
  const diffs = useStudioStore((state) => state.lastPresetDiffs)
  const savePreset = useStudioStore((state) => state.savePreset)
  const deletePreset = useStudioStore((state) => state.deletePreset)
  const importPresets = useStudioStore((state) => state.importPresets)
  const exportPresets = useStudioStore((state) => state.exportPresets)
  const applyPresets = useStudioStore((state) => state.applyPresets)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const modelField = definition.fields.find((field) => field.parameter === 'model')
  const promptField = definition.fields.find((field) => field.parameter === 'text' || field.parameter === 'prompt' || field.id === 'prompt')
  const [patterns, setPatterns] = useState(String(modelField ? values[modelField.id] ?? '*' : '*'))
  const [tags, setTags] = useState('参数')
  const [includePrompt, setIncludePrompt] = useState(false)
  const toggle = (id: string): void => setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id])
  const move = (id: string, offset: -1 | 1): void => setSelected((items) => {
    const index = items.indexOf(id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= items.length) return items
    const next = [...items]
    const other = next[target]
    if (!other) return items
    next[target] = id
    next[index] = other
    return next
  })
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    await savePreset({
      id: `preset-${globalThis.crypto.randomUUID()}`,
      name: name.trim(),
      modelPatterns: commaValues(patterns),
      values: Object.fromEntries(Object.entries(values).filter(([key]) => includePrompt || key !== promptField?.id)),
      tags: commaValues(tags),
    })
    setCreating(false)
    setName('')
  }
  const currentModel = String(modelField ? values[modelField.id] ?? '' : '')
  return (
    <div className="linear-section preset-rack"><header><span>03</span><div><h2>参数与风格预设</h2><p>按选中顺序叠加；模型不适用的预设会跳过，并保留差异记录。</p></div></header><div className="preset-toolbar"><button className="secondary-button" onClick={() => setCreating(!creating)} type="button"><Icon name="plus" size={13} />从当前创建</button><button className="secondary-button" onClick={() => void importPresets()} type="button"><Icon name="download" size={13} />导入 JSON</button><button className="secondary-button" disabled={presets.length === 0} onClick={() => void exportPresets(selected.length ? selected : presets.map((preset) => preset.id))} type="button"><Icon name="external" size={13} />导出{selected.length ? '所选' : '全部'}</button></div>{creating ? <div className="preset-create-form"><label className="field"><span>名称</span><input autoFocus onChange={(event) => setName(event.target.value)} value={name} /></label><label className="field"><span>适用模型（逗号分隔，支持 *）</span><input onChange={(event) => setPatterns(event.target.value)} value={patterns} /></label><label className="field"><span>标签</span><input onChange={(event) => setTags(event.target.value)} value={tags} /></label><label className="plugin-enabled-check"><input checked={includePrompt} onChange={(event) => setIncludePrompt(event.target.checked)} type="checkbox" /><span><strong>包含完整提示词</strong><small>关闭时只保存模型、尺寸、Seed 与数量</small></span></label><div><button className="secondary-button" onClick={() => setCreating(false)} type="button">取消</button><button className="primary-button" disabled={!name.trim()} onClick={() => void create()} type="button">保存预设</button></div></div> : null}<div className="preset-list">{presets.map((preset) => { const compatible = presetSupportsModel(preset, currentModel); const order = selected.indexOf(preset.id); return <article className={`${selected.includes(preset.id) ? 'is-selected' : ''} ${compatible ? '' : 'is-incompatible'}`} key={preset.id}><label><input checked={selected.includes(preset.id)} onChange={() => toggle(preset.id)} type="checkbox" /><span><strong>{preset.name}</strong><small>{preset.modelPatterns.length ? preset.modelPatterns.join(', ') : '所有模型'} · {preset.tags.join(' / ') || '无标签'}</small></span></label><div>{order >= 0 ? <><button aria-label="上移" disabled={order === 0} onClick={() => move(preset.id, -1)} type="button"><Icon name="chevron" size={12} /></button><em>{order + 1}</em><button aria-label="下移" disabled={order === selected.length - 1} onClick={() => move(preset.id, 1)} type="button"><Icon name="chevron" size={12} /></button></> : <StatusPill label={compatible ? '适用' : '模型不适用'} status={compatible ? 'success' : 'pending'} />}<button aria-label="删除预设" onClick={() => { if (window.confirm(`删除预设“${preset.name}”？`)) { void deletePreset(preset.id); setSelected((items) => items.filter((id) => id !== preset.id)) } }} type="button"><Icon name="trash" size={12} /></button></div></article> })}{presets.length === 0 ? <div className="preset-empty">当前项目没有预设；可从当前参数创建或导入 JSON。</div> : null}</div><div className="preset-apply-row"><span>叠加顺序：{selected.map((id) => presets.find((preset) => preset.id === id)?.name).filter(Boolean).join(' → ') || '尚未选择'}</span><button className="primary-button" disabled={selected.length === 0} onClick={() => applyPresets(selected)} type="button"><Icon name="layers" size={14} />叠加并应用</button></div>{diffs.length > 0 ? <details className="preset-diffs" open><summary>最近应用差异 · {diffs.length}</summary>{diffs.map((diff, index) => <div key={`${diff.presetId}-${diff.path}-${index}`}><code>{diff.path}</code><span>{JSON.stringify(diff.before) ?? 'undefined'}</span><Icon name="chevron" size={11} /><strong>{JSON.stringify(diff.after)}</strong><small>{diff.presetId}</small></div>)}</details> : null}</div>
  )
}

function CanvasWorkspace() {
  const selectedNodeId = useStudioStore((state) => state.selectedNodeId)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(selectedNodeId))
  const [compact, setCompact] = useState(false)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const compactRef = useRef(false)

  useEffect(() => {
    const workbench = workbenchRef.current
    if (!workbench || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const nextCompact = entry.contentRect.width <= 1050
      if (compactRef.current === nextCompact) return
      compactRef.current = nextCompact
      setCompact(nextCompact)
      if (nextCompact) {
        setLibraryOpen(false)
        setInspectorOpen(false)
      } else if (selectedNodeId) {
        setInspectorOpen(true)
      }
    })
    observer.observe(workbench)
    return () => observer.disconnect()
  }, [selectedNodeId])

  const toggleLibrary = (): void => {
    setLibraryOpen((open) => {
      const next = !open
      if (next && compact) setInspectorOpen(false)
      return next
    })
  }
  const toggleInspector = (): void => {
    setInspectorOpen((open) => {
      const next = !open
      if (next && compact) setLibraryOpen(false)
      return next
    })
  }

  return (
    <>
      <div className={`canvas-workbench${libraryOpen ? ' has-library' : ''}${inspectorOpen ? ' has-inspector' : ''}`} ref={workbenchRef}>
        {libraryOpen ? <NodeLibrary /> : null}
        <ReactFlowProvider><CanvasSurface onNodeSelected={() => {
          setInspectorOpen(true)
          if (compact) setLibraryOpen(false)
        }} /></ReactFlowProvider>
        {inspectorOpen ? <NodeInspector /> : null}
        <button aria-label={libraryOpen ? '收起节点库' : '打开节点库'} aria-pressed={libraryOpen} className="canvas-pane-toggle canvas-pane-toggle-library" onClick={toggleLibrary} title={libraryOpen ? '收起节点库' : '打开节点库'} type="button"><Icon name={libraryOpen ? 'chevron-left' : 'chevron-right'} size={15} /></button>
        <button aria-label={inspectorOpen ? '收起节点属性' : '打开节点属性'} aria-pressed={inspectorOpen} className="canvas-pane-toggle canvas-pane-toggle-inspector" onClick={toggleInspector} title={inspectorOpen ? '收起节点属性' : '打开节点属性'} type="button"><Icon name={inspectorOpen ? 'chevron-right' : 'chevron-left'} size={15} /></button>
      </div>
      <BottomDock />
    </>
  )
}

const studioBridge = (): StudioBridge | undefined =>
  (window as unknown as { readonly onekey?: { readonly studio?: StudioBridge } }).onekey?.studio

const publicStudioError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '工作流计划生成失败'
  return message.replace(/^\[[^\]]+\]\s*/u, '').slice(0, 500)
}

function StudioCopilotPanel({ onClose }: { readonly onClose: () => void }) {
  const providers = useStudioStore((state) => state.providers)
  const graphs = useStudioStore((state) => state.graphs)
  const activeGraphId = useStudioStore((state) => state.activeGraphId)
  const selectedNodeId = useStudioStore((state) => state.selectedNodeId)
  const workflow = useStudioStore((state) => state.workflowDocument)
  const applyOperations = useStudioStore((state) => state.applyCopilotOperations)
  const [instruction, setInstruction] = useState('')
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<StudioCopilotPlan>()
  const [sourceDocument, setSourceDocument] = useState('')
  const [error, setError] = useState('')
  const [applied, setApplied] = useState('')
  const route = workflowRouteSelection(providers, graphs)
  const selectedNodeIds = activeGraphId === 'root'
    ? [...new Set([
        ...((graphs.root?.nodes ?? []).filter((node) => node.selected).map((node) => node.id)),
        ...(selectedNodeId ? [selectedNodeId] : []),
      ])]
    : []
  const currentDocument = JSON.stringify(workflow)
  const stale = Boolean(plan && sourceDocument !== currentDocument)
  const routeReady = Boolean(route.selectedAccountGroupId && route.selectedModel)
  const canGenerate = !loading && activeGraphId === 'root' && routeReady && instruction.trim().length > 0

  const generate = async (): Promise<void> => {
    if (!canGenerate) return
    const bridge = studioBridge()
    if (!bridge) {
      setError('桌面连接不可用，请重新打开应用')
      return
    }
    const capturedDocument = JSON.stringify(workflow)
    setLoading(true)
    setError('')
    setApplied('')
    try {
      const result = studioCopilotPlanSchema.parse(await bridge.planWorkflow({
        providerId: route.selectedAccountGroupId,
        workflow,
        instruction: instruction.trim(),
        ...(selectedNodeIds.length > 0 ? { selectedNodeIds } : {}),
      }))
      setPlan(result)
      setSourceDocument(capturedDocument)
    } catch (reason) {
      setPlan(undefined)
      setSourceDocument('')
      setError(publicStudioError(reason))
    } finally {
      setLoading(false)
    }
  }

  const apply = (): void => {
    if (!plan || stale || !routeReady) return
    applyOperations(plan.operations, {
      providerId: route.selectedAccountGroupId,
      model: route.selectedModel,
    })
    setPlan(undefined)
    setSourceDocument('')
    setApplied('计划已应用')
  }

  return (
    <aside aria-label="工作流助手" className="studio-copilot-panel">
      <header>
        <div><span className="studio-copilot-mark"><Icon name="spark" size={15} /></span><div><strong>工作流助手</strong><small>{selectedNodeIds.length > 0 ? `已选 ${selectedNodeIds.length} 个节点` : '整个工作流'}</small></div></div>
        <button aria-label="关闭工作流助手" onClick={onClose} title="关闭" type="button"><Icon name="close" size={15} /></button>
      </header>
      <div className="studio-copilot-compose">
        <textarea
          aria-label="工作流调整意图"
          maxLength={12000}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void generate()
            }
          }}
          placeholder="例如：添加参考图输入，并连接到图片编辑节点"
          value={instruction}
        />
        <footer>
          <span>{routeReady ? `${accountGroupLabel(route.selectedAccountGroup as ProviderItem)} · ${route.selectedModel}` : activeGraphId !== 'root' ? '请返回主工作流' : '请先选择顶部模型'}</span>
          <button className="primary-button" disabled={!canGenerate} onClick={() => void generate()} type="button">
            {loading ? <span className="studio-copilot-thinking"><i /><i /><i /></span> : <Icon name="spark" size={14} />}
            {loading ? '生成中' : '生成计划'}
          </button>
        </footer>
      </div>
      {error ? <div className="studio-copilot-message is-error" role="alert"><Icon name="error" size={14} /><span>{error}</span></div> : null}
      {applied ? <div className="studio-copilot-message is-success" role="status"><Icon name="check" size={14} /><span>{applied}</span></div> : null}
      {plan ? <div className="studio-copilot-plan">
        <div className="studio-copilot-plan-heading"><div><span>修改预览</span><strong>{plan.summary}</strong></div><small>{plan.groupId} · {plan.model}</small></div>
        {(() => {
          const counts = { added: 0, removed: 0, updated: 0, connected: 0, layout: 0 }
          for (const operation of plan.operations) {
            if (operation.kind === 'add-node') counts.added += 1
            else if (operation.kind === 'remove-node') counts.removed += 1
            else if (operation.kind === 'update-node') counts.updated += 1
            else if (operation.kind === 'connect') counts.connected += 1
            else counts.layout += 1
          }
          return (
            <div aria-label="应用前后差异" className="studio-copilot-impact">
              <span className="impact-before">当前 {workflow.nodes.length} 节点 · {workflow.edges.length} 连线</span>
              <Icon name="chevron-right" size={12} />
              <span className="impact-after">应用后约 {workflow.nodes.length + counts.added - counts.removed} 节点 · {workflow.edges.length + counts.connected} 连线</span>
              <span className="impact-tags">
                {counts.added > 0 && <em className="is-add">+{counts.added} 新增</em>}
                {counts.removed > 0 && <em className="is-remove">-{counts.removed} 删除</em>}
                {counts.updated > 0 && <em>{counts.updated} 处参数调整</em>}
                {counts.connected > 0 && <em>{counts.connected} 条新连线</em>}
                {counts.layout > 0 && <em>自动整理</em>}
              </span>
            </div>
          )
        })()}
        {stale ? <div className="studio-copilot-message is-warning" role="status"><Icon name="warning" size={14} /><span>画布已变化，请重新生成计划</span></div> : null}
        <ol>{plan.operations.map((operation, index) => <li key={`${operation.kind}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{describeStudioCopilotOperation(operation, workflow)}</strong><small>{describeStudioCopilotOperationDetail(operation)}</small></div></li>)}</ol>
        <footer><button className="secondary-button" onClick={() => { setPlan(undefined); setSourceDocument('') }} type="button">放弃</button><button className="primary-button" disabled={stale || !routeReady} onClick={apply} type="button"><Icon name="check" size={14} />应用 {plan.operations.length} 项变更</button></footer>
      </div> : null}
    </aside>
  )
}

export function WorkflowPage() {
  const view = useStudioStore((state) => state.workflowView)
  const [copilotOpen, setCopilotOpen] = useState(false)
  return <section className="workflow-page">
    <WorkflowToolbar copilotOpen={copilotOpen} onToggleCopilot={() => setCopilotOpen((open) => !open)} />
    <WorkflowReadinessBar />
    <div className={`workflow-workspace${copilotOpen ? ' has-copilot' : ''}`}>
      <div className="workflow-main-view">{view === 'canvas' ? <CanvasWorkspace /> : <LinearView />}</div>
      {copilotOpen ? <StudioCopilotPanel onClose={() => setCopilotOpen(false)} /> : null}
    </div>
  </section>
}
