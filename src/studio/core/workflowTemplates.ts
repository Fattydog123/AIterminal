import type { WorkflowDocument, WorkflowEdge, WorkflowNode } from '../shared/types.js'
import { createWorkflow } from './workflow.js'

export type WorkflowTemplateId = 'text-to-image' | 'image-edit' | 'product-variations'

export interface WorkflowTemplateDescriptor {
  readonly id: WorkflowTemplateId
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
  readonly nextSteps: readonly string[]
}

export interface WorkflowTemplateBinding {
  readonly providerId: string
  readonly model?: string
}

export const workflowTemplates: readonly WorkflowTemplateDescriptor[] = [
  {
    id: 'text-to-image',
    name: '文字生成图片',
    description: '写下画面、确认模型与尺寸，然后直接生成并预览。',
    tags: ['生图', '通用'],
    nextSteps: ['修改画面提示词', '检查接口与模型', '预检后运行'],
  },
  {
    id: 'image-edit',
    name: '载入图片并编辑',
    description: '载入本地图片，用自然语言修改、重绘或延展视觉方向。',
    tags: ['编辑', '本地图片'],
    nextSteps: ['在“本地图片”节点载入真实文件', '说明要保留和改变的内容', '预检后运行'],
  },
  {
    id: 'product-variations',
    name: '产品视觉变体',
    description: '把产品简报与摄影约束组合成可复用的候选图工作流。',
    tags: ['产品', '候选版本'],
    nextSteps: ['替换产品与场景描述', '调整摄影约束', '生成多张候选并采用结果'],
  },
]

const generationParameters = (binding: WorkflowTemplateBinding, count = 1): Readonly<Record<string, unknown>> => ({
  providerId: binding.providerId,
  model: binding.model?.trim() ?? '',
  size: '1024x1024',
  quality: 'high',
  count,
  outputFormat: 'png',
  outputCompression: 100,
  background: 'auto',
  moderation: 'auto',
})

const node = (
  id: string,
  type: string,
  name: string,
  x: number,
  y: number,
  parameters: Readonly<Record<string, unknown>>,
): WorkflowNode => ({ id, type, name, position: { x, y }, parameters })

const edge = (
  id: string,
  sourceNode: string,
  sourceSocket: string,
  targetNode: string,
  targetSocket: string,
): WorkflowEdge => ({ id, sourceNode, sourceSocket, targetNode, targetSocket })

const linearView = (
  title: string,
  description: string,
  fields: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> => ({
  id: 'primary',
  title,
  description,
  fields,
})

const field = (
  id: string,
  nodeId: string,
  parameter: string,
  label: string,
  group: string,
  order: number,
  description?: string,
): Readonly<Record<string, unknown>> => ({ id, nodeId, parameter, label, group, order, ...(description ? { description } : {}) })

const withContents = (
  workflow: WorkflowDocument,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  view: Readonly<Record<string, unknown>>,
  templateId: WorkflowTemplateId,
): WorkflowDocument => ({
  ...workflow,
  nodes,
  edges,
  metadata: { ...workflow.metadata, templateId, linearView: view },
})

export const instantiateWorkflowTemplate = (
  templateId: WorkflowTemplateId,
  binding: WorkflowTemplateBinding,
): WorkflowDocument => {
  if (templateId === 'text-to-image') {
    return withContents(
      createWorkflow('文字生成图片'),
      [
        node('prompt', 'text', '画面提示词', 80, 150, { text: '一座雨夜中的未来主义茶室，电影级布光，真实材质，清晰建筑线条' }),
        node('generate', 'image_generation', '图像生成', 430, 135, generationParameters(binding)),
        node('preview', 'image_preview', '结果预览', 800, 150, {}),
      ],
      [
        edge('prompt-generate', 'prompt', 'text', 'generate', 'prompt'),
        edge('generate-preview', 'generate', 'images', 'preview', 'images'),
      ],
      linearView('文字生成图片', '直接调整需要的内容；完整节点仍保留在同一画布。', [
        field('prompt', 'prompt', 'text', '画面提示词', '画面描述', 10, '主体、环境、光线和必须保留的细节。'),
        field('model', 'generate', 'model', '模型', '生成设置', 20),
        field('size', 'generate', 'size', '尺寸', '生成设置', 30),
        field('count', 'generate', 'count', '候选数量', '生成设置', 40),
      ]),
      templateId,
    )
  }

  if (templateId === 'image-edit') {
    return withContents(
      createWorkflow('载入图片并编辑'),
      [
        node('source', 'project_image', '本地图片', 70, 80, { path: '' }),
        node('prompt', 'text', '编辑要求', 70, 360, { text: '保留主体结构与构图，把环境改成柔和的清晨自然光，细节真实。' }),
        node('edit', 'image_edit', '图片编辑', 450, 190, { ...generationParameters(binding), inputFidelity: 'high', maskPath: '' }),
        node('preview', 'image_preview', '结果预览', 830, 200, {}),
      ],
      [
        edge('source-edit', 'source', 'image', 'edit', 'image'),
        edge('prompt-edit', 'prompt', 'text', 'edit', 'prompt'),
        edge('edit-preview', 'edit', 'images', 'preview', 'images'),
      ],
      linearView('载入图片并编辑', '先在同一工作流中载入图片，再描述需要保留和改变的内容。', [
        field('source', 'source', 'path', '本地图片', '输入', 5, '点击节点中的“载入/替换图片”选择真实文件。'),
        field('prompt', 'prompt', 'text', '编辑要求', '画面描述', 10),
        field('model', 'edit', 'model', '模型', '生成设置', 20),
        field('size', 'edit', 'size', '尺寸', '生成设置', 30),
        field('fidelity', 'edit', 'inputFidelity', '输入保真度', '生成设置', 40),
      ]),
      templateId,
    )
  }

  if (templateId !== 'product-variations') throw new Error(`未知工作流模板：${String(templateId)}`)
  return withContents(
    createWorkflow('产品视觉变体'),
    [
      node('brief', 'text', '产品简报', 70, 100, { text: '磨砂黑色智能音箱，保留准确轮廓与按键布局，摆放在浅色石材台面上' }),
      node('style', 'prompt_template', '摄影约束', 420, 100, { template: '{input}，商业产品摄影，柔和侧光，真实阴影，干净背景，主体无形变，无文字水印' }),
      node('generate', 'image_generation', '生成候选', 770, 100, generationParameters(binding, 4)),
      node('preview', 'image_preview', '候选预览', 1140, 110, {}),
    ],
    [
      edge('brief-style', 'brief', 'text', 'style', 'input'),
      edge('style-generate', 'style', 'text', 'generate', 'prompt'),
      edge('generate-preview', 'generate', 'images', 'preview', 'images'),
    ],
    linearView('产品视觉变体', '产品描述、摄影约束和候选数量都可直接修改；需要时可进入画布继续扩展。', [
      field('brief', 'brief', 'text', '产品与场景', '产品简报', 10),
      field('style', 'style', 'template', '摄影约束', '产品简报', 20),
      field('model', 'generate', 'model', '模型', '生成设置', 30),
      field('size', 'generate', 'size', '尺寸', '生成设置', 40),
      field('count', 'generate', 'count', '候选数量', '生成设置', 50),
    ]),
    templateId,
  )
}
