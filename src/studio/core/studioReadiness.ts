import type { WorkflowDocument, WorkflowNode } from '../shared/types.js'
import { parseComfyBindingMap } from './comfyWorkflow.js'
import { flattenSubgraphs } from './subgraphs.js'
import { inspectWorkflow } from './workflow.js'
import { inspectWorkflowProviderCapabilities, providerCapabilityProfile } from './providerCapabilities.js'

export interface StudioReadinessProvider {
  readonly id: string
  readonly kind: 'openai-compatible' | 'comfyui'
  readonly hasSecret: boolean
  readonly defaultModel: string
  readonly confirmedOnlyModels?: readonly string[]
  readonly managedBy?: 'ai-terminal-account'
}

export type StudioRepairAction =
  | { readonly kind: 'create-project' }
  | { readonly kind: 'select-node'; readonly nodeId: string; readonly graphId?: string }
  | { readonly kind: 'connect-input'; readonly nodeId: string; readonly graphId?: string }
  | { readonly kind: 'import-local-image'; readonly nodeId: string; readonly graphId?: string; readonly parameter?: string }
  | { readonly kind: 'remove-edge'; readonly edgeId: string; readonly graphId?: string }

export interface StudioReadinessIssue {
  readonly code: string
  readonly severity: 'blocking' | 'warning'
  readonly title: string
  readonly message: string
  readonly action: StudioRepairAction
  readonly nodeId?: string
  readonly edgeId?: string
}

export interface StudioReadinessReport {
  readonly ready: boolean
  readonly blockingCount: number
  readonly warningCount: number
  readonly issues: readonly StudioReadinessIssue[]
}

const remoteNodeTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])

const stringParameter = (node: WorkflowNode, key: string): string => {
  const value = node.parameters[key]
  return typeof value === 'string' ? value.trim() : ''
}

const issue = (
  code: string,
  title: string,
  message: string,
  action: StudioRepairAction,
  location: { readonly nodeId?: string; readonly edgeId?: string } = {},
  severity: StudioReadinessIssue['severity'] = 'blocking',
): StudioReadinessIssue => ({ code, severity, title, message, action, ...location })

interface ReadinessLocation {
  readonly graphId: string
  readonly localId: string
}

const readinessLocations = (workflow: WorkflowDocument): {
  readonly nodes: ReadonlyMap<string, ReadinessLocation>
  readonly edges: ReadonlyMap<string, ReadinessLocation>
} => {
  const definitions = new Map((workflow.subgraphs ?? []).map((definition) => [definition.id, definition]))
  const nodes = new Map<string, ReadinessLocation>()
  const edges = new Map<string, ReadinessLocation>()
  const visit = (document: WorkflowDocument, graphId: string, prefix: string, stack: readonly string[]): void => {
    document.nodes.forEach((node) => {
      const reference = node.type.startsWith('subgraph:') ? node.subgraph : undefined
      const definition = reference ? definitions.get(reference.definitionId) : undefined
      if (reference && definition && !stack.includes(definition.id)) {
        visit(definition.workflow, `${graphId}/${node.id}`, `${prefix}${node.id}__`, [...stack, definition.id])
      } else {
        nodes.set(`${prefix}${node.id}`, { graphId, localId: node.id })
      }
    })
    document.edges.forEach((edge) => edges.set(`${prefix}${edge.id}`, { graphId, localId: edge.id }))
  }
  visit(workflow, 'root', '', [])
  return { nodes, edges }
}

const graphProperty = (location: ReadinessLocation | undefined): { readonly graphId?: string } =>
  location && location.graphId !== 'root' ? { graphId: location.graphId } : {}

export const inspectStudioReadiness = (input: {
  readonly projectPath?: string
  readonly workflow: WorkflowDocument
  readonly providers: readonly StudioReadinessProvider[]
}): StudioReadinessReport => {
  const issues: StudioReadinessIssue[] = []
  const locations = readinessLocations(input.workflow)
  let workflow = input.workflow
  try {
    workflow = flattenSubgraphs(input.workflow)
  } catch {
    // The structural inspection below reports an invalid subgraph in user-facing terms.
  }
  if (!input.projectPath?.trim()) {
    issues.push(issue(
      'project-required',
      '先创建或打开项目',
      '项目用于保存工作流、输入图片和生成结果；创建项目不会调用远程接口。',
      { kind: 'create-project' },
    ))
  }

  const structural = inspectWorkflow(workflow, undefined, { requireConnectedInputs: true })
  for (const problem of structural) {
    const nodeLocation = problem.nodeId ? locations.nodes.get(problem.nodeId) : undefined
    issues.push(issue(
      problem.code,
      '工作流还未连接完整',
      problem.message,
      problem.nodeId
        ? { kind: 'connect-input', nodeId: nodeLocation?.localId ?? problem.nodeId, ...graphProperty(nodeLocation) }
        : { kind: 'select-node', nodeId: input.workflow.nodes[0]?.id ?? '$workflow' },
      { ...(problem.nodeId ? { nodeId: problem.nodeId } : {}), ...(problem.edgeId ? { edgeId: problem.edgeId } : {}) },
    ))
  }

  const providers = new Map(input.providers.map((provider) => [provider.id, provider]))
  for (const node of workflow.nodes) {
    const nodeLocation = locations.nodes.get(node.id)
    const localNodeId = nodeLocation?.localId ?? node.id
    const nodeGraph = graphProperty(nodeLocation)
    if (node.type === 'project_image' && !stringParameter(node, 'path')) {
      issues.push(issue(
        'local-image-required',
        '载入一张本地图片',
        `“${node.name}”尚未选择真实图片；载入后会复制到项目 assets/imports。`,
        { kind: 'import-local-image', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
      ))
    }
    if (node.type === 'text' && !stringParameter(node, 'text')) {
      issues.push(issue(
        'prompt-required',
        '填写画面描述',
        `“${node.name}”内容为空；请描述主体、环境和必须保留的细节。`,
        { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
      ))
    }
    if (!remoteNodeTypes.has(node.type)) continue
    const providerId = stringParameter(node, 'providerId')
    const provider = providers.get(providerId)
    if (!provider || provider.managedBy !== 'ai-terminal-account') {
      issues.push(issue(
        'provider-required',
        '选择分组',
        providerId ? '节点绑定的分组不可用；请重新选择分组。' : '图像节点尚未选择分组。',
        { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
      ))
      continue
    }
    if (provider.kind === 'openai-compatible' && !provider.hasSecret) {
      issues.push(issue(
        'provider-secret-required',
        '分组暂不可用',
        `分组“${provider.id}”当前不可用；请重新登录后再试。`,
        { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
      ))
    }
    const model = stringParameter(node, 'model') || provider.defaultModel.trim()
    if (!model) {
      issues.push(issue(
        'model-required',
        '选择或填写模型',
        `“${node.name}”没有模型；可从接口探测结果搜索，也可手动输入兼容模型名。`,
        { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
      ))
    }
    if (provider.kind === 'comfyui' && node.type === 'image_generation' && !stringParameter(node, 'comfyPrompt')) {
      issues.push(issue(
        'comfy-workflow-required',
        '导入 ComfyUI API Workflow',
        '远程 ComfyUI 需要 API-format Workflow JSON；它不会在客户端安装 CUDA 或自动猜测本机工作流。',
        { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
      ))
    }
    if (provider.kind === 'comfyui' && node.type === 'image_generation') {
      try {
        const bindings = parseComfyBindingMap(node.parameters.comfyBindings)
        const bindsImage = (bindings.image?.length ?? 0) > 0
        const bindsMask = (bindings.mask?.length ?? 0) > 0
        const hasSourceImage = workflow.edges.some((edge) => edge.targetNode === node.id && ['referenceImages', 'image', 'images'].includes(edge.targetSocket))
        if ((bindsImage || bindsMask) && !hasSourceImage) {
          issues.push(issue(
            'comfy-source-image-required',
            '连接 ComfyUI 源图片',
            '图片或蒙版绑定会先上传项目图片；请把“本地图片”的图片列表连接到生成节点参考图输入。',
            { kind: 'connect-input', nodeId: localNodeId, ...nodeGraph },
            { nodeId: node.id },
          ))
        }
        if (bindsMask && !stringParameter(node, 'maskPath')) {
          issues.push(issue(
            'comfy-mask-required',
            '载入 ComfyUI 蒙版',
            '当前绑定声明了 mask；请选择项目内蒙版图片，提交前会安全上传到远程 ComfyUI。',
            { kind: 'import-local-image', nodeId: localNodeId, parameter: 'maskPath', ...nodeGraph },
            { nodeId: node.id },
          ))
        }
      } catch (error) {
        issues.push(issue(
          'comfy-bindings-invalid',
          '修正 ComfyUI 参数绑定',
          error instanceof Error ? error.message : 'ComfyUI 参数绑定 JSON 无效。',
          { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
          { nodeId: node.id },
        ))
      }
    }
    const profile = providerCapabilityProfile({
      kind: provider.kind,
      ...(model ? { model } : {}),
      confirmedOnly: Boolean(model && provider.confirmedOnlyModels?.includes(model)),
    })
    const seed = Number(node.parameters.seed ?? 0)
    if (seed !== 0 && profile.seed === 'unsupported') {
      issues.push(issue(
        'seed-ignored',
        '当前模型不使用 Seed',
        `${model} 不支持确定性 Seed；该值不会用于远程请求。`,
        { kind: 'select-node', nodeId: localNodeId, ...nodeGraph },
        { nodeId: node.id },
        'warning',
      ))
    }
  }

  const capabilityIssues = inspectWorkflowProviderCapabilities(
    workflow,
    input.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      defaultModel: provider.defaultModel,
    })),
  )
  for (const problem of capabilityIssues) {
    if (issues.some((candidate) => candidate.code === problem.code && candidate.nodeId === problem.nodeId)) continue
    const nodeLocation = locations.nodes.get(problem.nodeId)
    const edgeLocation = problem.edgeId ? locations.edges.get(problem.edgeId) : undefined
    issues.push(issue(
      problem.code,
      '当前连接不受接口支持',
      problem.message,
      problem.edgeId
        ? { kind: 'remove-edge', edgeId: edgeLocation?.localId ?? problem.edgeId, ...graphProperty(edgeLocation) }
        : { kind: 'select-node', nodeId: nodeLocation?.localId ?? problem.nodeId, ...graphProperty(nodeLocation) },
      { nodeId: problem.nodeId, ...(problem.edgeId ? { edgeId: problem.edgeId } : {}) },
    ))
  }

  const blockingCount = issues.filter((item) => item.severity === 'blocking').length
  return {
    ready: blockingCount === 0,
    blockingCount,
    warningCount: issues.length - blockingCount,
    issues,
  }
}
