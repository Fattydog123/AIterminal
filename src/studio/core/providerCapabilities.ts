import type { WorkflowDocument } from '../shared/types.js'
import { isGptImageModel } from './imageModels.ts'

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown'

export interface ProviderCapabilityProfile {
  readonly generation: CapabilitySupport
  readonly editing: CapabilitySupport
  /** Reference images supplied directly to an image_generation node. */
  readonly referenceImages: CapabilitySupport
  readonly seed: CapabilitySupport
  readonly size: CapabilitySupport
  readonly outputFormat: CapabilitySupport
  /** Non-exhaustive baseline suggestions. The upstream Provider always validates the final size. */
  readonly sizes: readonly string[]
  /** Empty means that the Provider owns validation for this field. */
  readonly outputFormats: readonly ('png' | 'jpeg' | 'webp')[]
}

export interface ProviderCapabilityInput {
  readonly kind: 'openai-compatible' | 'comfyui'
  readonly model?: string
  readonly confirmedOnly?: boolean
}

export interface ProviderCapabilityDescriptor extends ProviderCapabilityInput {
  readonly id: string
  readonly defaultModel?: string
  readonly confirmedOnlyModels?: readonly string[]
}

export interface CapabilityWorkflowNode {
  readonly id: string
  readonly type: string
  readonly name: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface ProviderCapabilityIssue {
  readonly code: string
  readonly message: string
  readonly nodeId: string
  readonly edgeId?: string
}

const gptImageSizes = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const
const modernImageFormats = ['png', 'jpeg', 'webp'] as const

export const normalizeProviderModels = (models: readonly string[]): readonly string[] => {
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of models) {
    const model = item.trim()
    if (!model || model.length > 256 || seen.has(model)) continue
    seen.add(model)
    result.push(model)
    if (result.length >= 100) break
  }
  return result
}

export const providerCapabilityProfile = (
  provider: ProviderCapabilityInput,
): ProviderCapabilityProfile => {
  const model = provider.model?.trim().toLowerCase() ?? ''
  if (provider.kind === 'comfyui') {
    return {
      generation: 'supported',
      editing: 'unsupported',
      referenceImages: 'unsupported',
      seed: 'unknown',
      size: 'unknown',
      outputFormat: 'unknown',
      sizes: [],
      outputFormats: [],
    }
  }
  if (provider.confirmedOnly) {
    return {
      generation: 'supported',
      editing: 'unsupported',
      referenceImages: 'unsupported',
      seed: 'unsupported',
      size: 'unsupported',
      outputFormat: 'unsupported',
      sizes: [],
      outputFormats: [],
    }
  }
  if (isGptImageModel(model)) {
    return {
      generation: 'supported',
      editing: 'supported',
      referenceImages: 'supported',
      seed: 'unsupported',
      size: 'supported',
      outputFormat: 'supported',
      sizes: gptImageSizes,
      outputFormats: modernImageFormats,
    }
  }
  if (model === 'dall-e-3') {
    return {
      generation: 'supported',
      editing: 'unsupported',
      referenceImages: 'unsupported',
      seed: 'unsupported',
      size: 'supported',
      outputFormat: 'unsupported',
      sizes: ['1024x1024', '1792x1024', '1024x1792'],
      outputFormats: [],
    }
  }
  if (model === 'dall-e-2') {
    return {
      generation: 'supported',
      editing: 'supported',
      referenceImages: 'supported',
      seed: 'unsupported',
      size: 'supported',
      outputFormat: 'unsupported',
      sizes: ['256x256', '512x512', '1024x1024'],
      outputFormats: [],
    }
  }
  return {
    generation: 'supported',
    editing: 'unknown',
    referenceImages: 'unknown',
    seed: 'unsupported',
    size: 'unknown',
    outputFormat: 'unknown',
    sizes: [],
    outputFormats: [],
  }
}

export const inspectProviderConnectionCapability = (input: {
  readonly provider: ProviderCapabilityDescriptor | undefined
  readonly targetNode: CapabilityWorkflowNode
  readonly targetSocket: string
}): ProviderCapabilityIssue | undefined => {
  const model = typeof input.targetNode.parameters.model === 'string'
    ? input.targetNode.parameters.model.trim()
    : input.provider?.model ?? input.provider?.defaultModel
  const profile = input.provider
    ? providerCapabilityProfile({
        ...input.provider,
        ...(model ? { model } : {}),
        confirmedOnly: Boolean(model && input.provider.confirmedOnlyModels?.includes(model)),
      })
    : undefined
  if (['image_edit', 'image_inpaint', 'image_outpaint'].includes(input.targetNode.type) && profile?.editing === 'unsupported') {
    return {
      code: 'provider-operation-unsupported',
      nodeId: input.targetNode.id,
      message: input.provider?.kind === 'comfyui'
        ? '远程 ComfyUI Adapter 当前不直接执行图片编辑、重绘或扩图；请在 ComfyUI API Workflow 内完成这些步骤。远程请求尚未发送。'
        : `当前模型不支持“${input.targetNode.name}”；请更换支持编辑的模型。远程请求尚未发送。`,
    }
  }
  if (
    input.targetNode.type !== 'image_generation'
    || input.targetSocket !== 'referenceImages'
    || profile?.referenceImages !== 'unsupported'
  ) return undefined
  const fix = input.provider?.kind === 'comfyui'
    ? '请先在模型服务中配置图片输入映射'
    : '请更换支持参考图的模型'
  return {
    code: 'generation-reference-images-unsupported',
    nodeId: input.targetNode.id,
    message: `当前模型不能接收参考图；${fix}。`,
  }
}

export const inspectWorkflowProviderCapabilities = (
  workflow: WorkflowDocument,
  providers: readonly ProviderCapabilityDescriptor[],
  executedNodeIds?: ReadonlySet<string>,
): readonly ProviderCapabilityIssue[] => {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const issues: ProviderCapabilityIssue[] = []
  for (const node of workflow.nodes) {
    if (executedNodeIds && !executedNodeIds.has(node.id)) continue
    const providerId = typeof node.parameters.providerId === 'string' ? node.parameters.providerId.trim() : ''
    const provider = providerById.get(providerId)
    const issue = inspectProviderConnectionCapability({ provider, targetNode: node, targetSocket: '' })
    if (issue) issues.push(issue)
  }
  for (const edge of workflow.edges) {
    const targetNode = nodeById.get(edge.targetNode)
    if (!targetNode || (executedNodeIds && !executedNodeIds.has(targetNode.id))) continue
    const providerId = typeof targetNode.parameters.providerId === 'string'
      ? targetNode.parameters.providerId.trim()
      : ''
    const provider = providerById.get(providerId)
    const model = typeof targetNode.parameters.model === 'string'
      ? targetNode.parameters.model.trim()
      : provider?.model ?? provider?.defaultModel
    const issue = inspectProviderConnectionCapability({
      provider: provider ? { ...provider, ...(model ? { model } : {}) } : undefined,
      targetNode,
      targetSocket: edge.targetSocket,
    })
    if (issue && !issues.some((candidate) => candidate.code === issue.code && candidate.nodeId === issue.nodeId)) {
      issues.push({ ...issue, edgeId: edge.id })
    }
  }
  return issues
}
