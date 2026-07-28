import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { useEffect } from 'react'
import { inspectProviderConnectionCapability } from '@studio/core/providerCapabilities.js'
import { Icon } from '../components/Icon.js'
import { ArtPreview, ExposureRail, StatusPill } from '../components/Primitives.js'
import { isLegacyComfyParameter } from '../providerSelection.js'
import { useStudioStore } from '../store/studioStore.js'
import type { CanvasPort, StudioFlowNode } from '../types.js'

const portClass = (port: CanvasPort): string => `port-${port.dataType}`
const portTypeLabels: Readonly<Record<string, string>> = {
  text: '文本',
  image: '图片',
  images: '图片组',
  number: '数字',
  boolean: '开关',
  any: '任意数据',
}
const parameterLabels: Readonly<Record<string, string>> = {
  text: '文本',
  prompt: '提示词',
  size: '尺寸',
  quality: '质量',
  responseFormat: '返回方式',
  outputFormat: '图片格式',
  outputCompression: '压缩质量',
  background: '背景',
  moderation: '内容审核',
  seed: '随机种子',
  count: '数量',
  inputFidelity: '输入保真度',
  extra: '更多设置',
}

const projectImageFileName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? '未选择图片'

const projectImageDimensions = (data: StudioFlowNode['data']): string => {
  const width = typeof data.previewWidth === 'number' ? data.previewWidth : undefined
  const height = typeof data.previewHeight === 'number' ? data.previewHeight : undefined
  return width && height ? `${width} × ${height} px` : '尺寸待读取'
}

const remoteImageNodeTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])
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

function ResultImagePreview({
  error,
  label,
  loading,
  paths,
  retry,
  urls,
}: {
  readonly error?: string
  readonly label: string
  readonly loading: boolean
  readonly paths: readonly string[]
  readonly retry: () => void
  readonly urls: readonly string[]
}) {
  const images = paths.flatMap((path, index) => urls[index] ? [{ path, url: urls[index] as string }] : [])
  return (
    <div className={`result-image-node-preview ${images.length > 1 ? 'is-grid' : ''} ${images.length > 0 ? 'has-image' : error ? 'has-error' : loading ? 'is-loading' : 'is-empty'}`}>
      {images.length > 0 ? (
        <div className="result-image-grid">
          {images.map((image) => <img alt={`${label}：${projectImageFileName(image.path)}`} draggable={false} key={image.path} src={image.url} />)}
        </div>
      ) : (
        <button aria-busy={loading} className="nodrag" disabled={loading || paths.length === 0} onClick={(event) => { event.stopPropagation(); retry() }} type="button">
          <Icon name={error ? 'error' : 'image'} size={24} />
          <span>
            <strong>{loading ? '正在载入结果' : error ? '结果预览失败' : '等待生成结果'}</strong>
            <small>{loading ? '正在加载预览' : error ? '点击重新载入' : '运行连接到此处的上游节点'}</small>
          </span>
        </button>
      )}
      {paths.length > 0 ? (
        <div className="result-image-node-meta">
          <span>{images.length}/{paths.length} 张已显示</span>
          {error ? <button className="nodrag" onClick={(event) => { event.stopPropagation(); retry() }} type="button">重试</button> : <small>{projectImageFileName(paths[0] ?? '')}</small>}
        </div>
      ) : null}
    </div>
  )
}

function PortRow({ port, side, disabledReason }: { readonly port: CanvasPort; readonly side: 'input' | 'output'; readonly disabledReason?: string }) {
  const target = side === 'input'
  const typeLabel = portTypeLabels[port.dataType] ?? '数据'
  const availabilityLabel = port.id === 'referenceImages' ? '请使用图片编辑' : '暂不支持'
  return (
    <div className={`node-port-row is-${side} ${disabledReason ? 'is-disabled' : ''}`} title={disabledReason}>
      <Handle
        aria-disabled={disabledReason ? true : undefined}
        aria-label={`${target ? '输入' : '输出'} ${port.label}，类型 ${typeLabel}`}
        className={`typed-handle ${portClass(port)}`}
        id={`${target ? 'in' : 'out'}:${port.id}`}
        isConnectable={!disabledReason}
        position={target ? Position.Left : Position.Right}
        type={target ? 'target' : 'source'}
      />
      <span className={`port-dot ${portClass(port)}`} />
      <span>{port.label}</span>
      <small>{disabledReason ? availabilityLabel : typeLabel}</small>
    </div>
  )
}

function NoteNode({ data, selected }: Pick<StudioFlowNode, 'data'> & { readonly selected: boolean }) {
  return (
    <article className={`workflow-note ${selected ? 'is-selected' : ''}`}>
      <header><Icon name="note" size={15} /><strong>{data.label}</strong></header>
      <p>{String(data.parameters.text ?? data.annotation ?? '双击添加说明')}</p>
      {data.annotation ? <small>{data.annotation}</small> : null}
    </article>
  )
}

function FrameNode({ id, data, selected }: Pick<StudioFlowNode, 'id' | 'data'> & { readonly selected: boolean }) {
  const resizeFrame = useStudioStore((state) => state.resizeFrame)
  const toggleNodeFlag = useStudioStore((state) => state.toggleNodeFlag)
  return (
    <article aria-label={`${data.label} 分组`} className={`workflow-frame ${selected ? 'is-selected' : ''} ${data.collapsed ? 'is-collapsed' : ''}`} role="group">
      <NodeResizer
        color="var(--studio-focus)"
        isVisible={selected}
        minHeight={120}
        minWidth={240}
        onResizeEnd={(_event, parameters) => resizeFrame(id, parameters.width, parameters.height)}
      />
      <header>
        <span><Icon name="layers" size={14} /><strong>{String(data.parameters.label ?? data.label)}</strong></span>
        <button aria-label={data.collapsed ? '展开分组' : '折叠分组'} className="node-mini-action nodrag" onClick={(event) => { event.stopPropagation(); toggleNodeFlag(id, 'collapsed') }} type="button"><Icon name={data.collapsed ? 'chevron-down' : 'chevron-up'} size={14} /></button>
      </header>
      <p>{data.collapsed ? '区域已折叠；框内节点暂时隐藏' : '拖动边框调整区域；折叠时隐藏框内节点'}</p>
      {data.annotation ? <small>{data.annotation}</small> : null}
    </article>
  )
}

export function WorkflowNode(props: NodeProps<StudioFlowNode>) {
  const { id, data, selected } = props
  const enterGraph = useStudioStore((state) => state.enterGraph)
  const toggleNodeFlag = useStudioStore((state) => state.toggleNodeFlag)
  const setSelectedNode = useStudioStore((state) => state.setSelectedNode)
  const chooseProjectImage = useStudioStore((state) => state.chooseProjectImage)
  const ensureProjectImagePreview = useStudioStore((state) => state.ensureProjectImagePreview)
  const ensureResultImagePreview = useStudioStore((state) => state.ensureResultImagePreview)
  const localImageImporting = useStudioStore((state) => state.localImageImporting)
  const providers = useStudioStore((state) => state.providers)
  const activeGraphId = useStudioStore((state) => state.activeGraphId)
  const connectionState = useStudioStore((state) => state.connectionState)
  const projectPath = useStudioStore((state) => state.projectPath)
  const resultAssetCatalogKey = useStudioStore((state) => data.nodeType === 'image_preview'
    ? state.assets.map((asset) => `${asset.id}:${asset.nodeId ?? ''}:${asset.relativePath ?? ''}`).join('\u0001')
    : '')
  const projectImagePath = data.nodeType === 'project_image' ? String(data.parameters.path ?? '').trim() : ''
  const projectImagePreviewUrl = data.nodeType === 'project_image' && typeof data.previewUrl === 'string' ? data.previewUrl : ''
  const projectImagePreviewLoading = data.nodeType === 'project_image' && data.previewLoading === true
  const projectImagePreviewError = data.nodeType === 'project_image' && typeof data.previewError === 'string' ? data.previewError : ''
  const resultPreviewPaths = data.nodeType === 'image_preview' && Array.isArray(data.previewPaths) ? data.previewPaths.filter((value): value is string => typeof value === 'string') : []
  const resultPreviewUrls = data.nodeType === 'image_preview' && Array.isArray(data.previewUrls) ? data.previewUrls.filter((value): value is string => typeof value === 'string') : []
  const resultPreviewPathKey = resultPreviewPaths.join('\u0001')
  const resultPreviewUrlKey = resultPreviewUrls.join('\u0001')
  const resultPreviewLoading = data.nodeType === 'image_preview' && data.previewLoading === true
  const resultPreviewError = data.nodeType === 'image_preview' && typeof data.previewError === 'string' ? data.previewError : ''
  const providerId = String(data.parameters.providerId ?? '').trim()
  const provider = providers.find((item) => item.id === providerId)
  const model = String(data.parameters.model ?? provider?.model ?? '').trim()
  const confirmedOnly = Boolean(model && provider?.confirmedOnlyModels?.includes(model))
  const inputDisabledReason = (port: CanvasPort): string | undefined => inspectProviderConnectionCapability({
    provider,
    targetNode: { id, type: data.nodeType, name: data.label, parameters: data.parameters },
    targetSocket: port.id,
  })?.message

  useEffect(() => {
    if (data.nodeType !== 'project_image' || !projectImagePath || projectImagePreviewUrl) return
    void ensureProjectImagePreview(activeGraphId, id, projectImagePath)
  }, [activeGraphId, connectionState, data.nodeType, ensureProjectImagePreview, id, projectImagePath, projectImagePreviewUrl, projectPath])

  useEffect(() => {
    if (data.nodeType !== 'image_preview' || resultPreviewLoading || resultPreviewError) return
    if (resultPreviewPaths.length > 0 && resultPreviewUrls.length === resultPreviewPaths.length && resultPreviewUrls.every(Boolean)) return
    void ensureResultImagePreview(activeGraphId, id)
  }, [activeGraphId, connectionState, data.nodeType, ensureResultImagePreview, id, projectPath, resultAssetCatalogKey, resultPreviewError, resultPreviewLoading, resultPreviewPathKey, resultPreviewUrlKey])

  if (data.nodeType === 'note') return <NoteNode data={data} selected={selected} />
  if (data.nodeType === 'frame') return <FrameNode data={data} id={id} selected={selected} />

  const activeStage = data.status === 'success' ? 5 : data.status === 'running' ? 1 : data.status === 'queued' ? 0 : -1
  const parameterEntries = data.nodeType === 'project_image' ? [] : Object.entries(data.parameters)
    .filter(([key]) => key !== 'providerId' && key !== 'model')
    .filter(([key]) => !confirmedOnly || !confirmedOnlyOmittedParameters.has(key))
    .filter(([key]) => !isLegacyComfyParameter(data.nodeType, key))
    .slice(0, data.collapsed ? 0 : 3)

  return (
    <article
      aria-label={`${data.label} 节点`}
      className={`workflow-node accent-${data.accent} status-${data.status} ${data.nodeType === 'project_image' ? 'node-project-image' : data.nodeType === 'image_preview' ? 'node-result-image' : ''} ${selected ? 'is-selected' : ''} ${data.bypassed ? 'is-bypassed' : ''}`}
      onDoubleClick={() => data.subgraphId ? enterGraph(data.subgraphId) : setSelectedNode(id)}
      role="group"
    >
      <div className="node-signal-cap" />
      <header className="node-header">
        <span className="node-kind-icon"><Icon name={data.nodeType.startsWith('subgraph:') ? 'layers' : data.accent === 'image' ? 'image' : data.accent === 'text' ? 'code' : 'workflow'} size={15} /></span>
        <div className="node-title-block">
          <strong>{data.label}</strong>
          <small>{data.category}</small>
        </div>
        <button
          aria-label={data.collapsed ? '展开节点' : '折叠节点'}
          className="node-mini-action nodrag"
          onClick={(event) => { event.stopPropagation(); toggleNodeFlag(id, 'collapsed') }}
          type="button"
        >
          <Icon name={data.collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
        </button>
      </header>

      <ExposureRail active={activeStage} compact error={data.status === 'error' ? 1 : -1} />

      <div className="node-port-grid">
        <div className="node-ports">
          {data.inputs.map((port) => { const disabledReason = inputDisabledReason(port); return <PortRow {...(disabledReason ? { disabledReason } : {})} key={`in-${port.id}`} port={port} side="input" /> })}
        </div>
        <div className="node-ports is-output-list">
          {data.outputs.map((port) => <PortRow key={`out-${port.id}`} port={port} side="output" />)}
        </div>
      </div>

      {!data.collapsed ? (
        <>
          {data.nodeType === 'project_image' ? (
            <div className={`project-image-node-preview ${projectImagePreviewUrl ? 'has-image' : projectImagePreviewError ? 'has-error' : projectImagePath ? 'is-loading' : 'is-empty'}`}>
              {projectImagePreviewUrl ? <img alt={`${data.label}本地图片预览：${projectImageFileName(projectImagePath)}`} draggable={false} src={projectImagePreviewUrl} /> : projectImagePath ? (
                <button aria-busy={projectImagePreviewLoading} className="nodrag" disabled={projectImagePreviewLoading} onClick={(event) => { event.stopPropagation(); void ensureProjectImagePreview(activeGraphId, id, projectImagePath, true) }} title={projectImagePreviewError ? `重新载入图片预览：${projectImagePreviewError}` : '正在载入图片预览'} type="button"><Icon name={projectImagePreviewError ? 'error' : 'image'} size={23} /><span><strong>{projectImagePreviewError ? '预览暂不可用' : '正在载入预览'}</strong><small>{projectImagePreviewError ? '点击重试' : '校验项目素材'}</small></span></button>
              ) : (
                <button className="nodrag" disabled={localImageImporting} onClick={(event) => { event.stopPropagation(); void chooseProjectImage(id, 'path') }} title="从电脑选择本地图片" type="button"><Icon name="folder" size={23} /><span><strong>{localImageImporting ? '正在载入图片' : '选择本地图片'}</strong><small>作为下游节点的图片输入</small></span></button>
              )}
              {projectImagePath ? <div className="project-image-node-meta"><strong title={projectImageFileName(projectImagePath)}>{projectImageFileName(projectImagePath)}</strong><small>{projectImageDimensions(data)}</small></div> : null}
            </div>
          ) : null}
          {data.nodeType === 'image_preview' ? (
            <ResultImagePreview
              {...(resultPreviewError ? { error: resultPreviewError } : {})}
              label={data.label}
              loading={resultPreviewLoading}
              paths={resultPreviewPaths}
              retry={() => { void ensureResultImagePreview(activeGraphId, id, true) }}
              urls={resultPreviewUrls}
            />
          ) : null}
          {data.previewTone && data.nodeType !== 'image_preview' && data.nodeType !== 'project_image' ? <ArtPreview label={`${data.label} 预览`} tone={data.previewTone} /> : null}
          {parameterEntries.length > 0 ? (
            <dl className="node-parameter-summary">
              {parameterEntries.map(([key, value]) => (
                <div key={key}><dt>{parameterLabels[key] ?? key}</dt><dd>{String(value || '—')}</dd></div>
              ))}
            </dl>
          ) : null}
          {data.annotation ? <p className="node-annotation"><Icon name="note" size={13} />{data.annotation}</p> : null}
        </>
      ) : null}

      <footer className="node-footer">
        <StatusPill
          label={data.status === 'success' ? '完成' : data.status === 'running' ? '执行中' : data.status === 'queued' ? '排队' : data.status === 'error' ? '错误' : '就绪'}
          status={data.status}
        />
        <span className="node-metrics">
          {data.pinned ? <Icon name="pin" size={13} /> : null}
          {data.mocked ? <Icon name="mock" size={13} /> : null}
          {data.cacheHit ? <em>缓存</em> : null}
          {data.runtimeMs !== undefined ? `${data.runtimeMs < 1000 ? `${data.runtimeMs} ms` : `${(data.runtimeMs / 1000).toFixed(1)} s`}` : ''}
        </span>
      </footer>
      {data.bypassed ? <div className="bypass-stamp"><Icon name="bypass" size={13} />已跳过</div> : null}
    </article>
  )
}
