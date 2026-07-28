import type { NodeDefinition, PortDefinition, SocketDataType, SubgraphDefinition } from '../shared/types.js'

const port = (
  id: string,
  label: string,
  dataType: SocketDataType,
  required = true,
  multiple = false,
): PortDefinition => ({ id, label, dataType, required, multiple })

const generationParameters = [
  {
    id: 'providerId', label: '分组', kind: 'select' as const, defaultValue: '', required: true,
    placeholder: '选择分组', help: '用于当前图片任务。',
  },
  {
    id: 'model', label: '模型', kind: 'text' as const, defaultValue: '', required: true,
    placeholder: '先选择分组', help: '选择该分组中的图片模型。',
    capabilityHint: { capability: 'generation' as const, message: '当前 Provider 不支持图像生成。' },
  },
  {
    id: 'size',
    label: '尺寸',
    kind: 'select' as const,
    defaultValue: '1024x1024',
    required: true,
    placeholder: '1024x1024、1920x1080、auto 或 WIDTHxHEIGHT',
    help: '常用尺寸和模型基础尺寸仅作快捷建议，不是客户端白名单。可手工输入中转支持的 WIDTHxHEIGHT，最终由上游 Provider 决定。',
    example: '1536x1024',
    capabilityHint: { capability: 'size' as const, message: '当前 Provider 不公开尺寸参数；请在 API Workflow 中设置。' },
    options: [
      { label: '自动 · Provider 决定', value: 'auto' },
      { label: '512 × 512 · 方形 1:1 · 小图', value: '512x512' },
      { label: '768 × 768 · 方形 1:1', value: '768x768' },
      { label: '1024 × 1024 · 方形 1:1 · 常用', value: '1024x1024' },
      { label: '1536 × 1536 · 方形 1:1', value: '1536x1536' },
      { label: '2048 × 2048 · 方形 1:1 · 2K', value: '2048x2048' },
      { label: '1280 × 720 · 横向 16:9 · HD', value: '1280x720' },
      { label: '1024 × 768 · 横向 4:3', value: '1024x768' },
      { label: '1344 × 768 · 横向 7:4', value: '1344x768' },
      { label: '1536 × 1024 · 横向 3:2 · 常用', value: '1536x1024' },
      { label: '1792 × 1024 · 横向 7:4', value: '1792x1024' },
      { label: '1920 × 1080 · 横向 16:9 · Full HD', value: '1920x1080' },
      { label: '2048 × 1152 · 横向 16:9 · 2K', value: '2048x1152' },
      { label: '3840 × 2160 · 横向 16:9 · 4K UHD', value: '3840x2160' },
      { label: '720 × 1280 · 纵向 9:16 · 手机', value: '720x1280' },
      { label: '768 × 1024 · 纵向 3:4', value: '768x1024' },
      { label: '768 × 1344 · 纵向 4:7', value: '768x1344' },
      { label: '1024 × 1536 · 纵向 2:3 · 常用', value: '1024x1536' },
      { label: '1024 × 1792 · 纵向 4:7', value: '1024x1792' },
      { label: '1080 × 1920 · 纵向 9:16 · Full HD', value: '1080x1920' },
      { label: '1152 × 2048 · 纵向 9:16 · 2K', value: '1152x2048' },
      { label: '2160 × 3840 · 纵向 9:16 · 4K UHD', value: '2160x3840' },
    ],
  },
  {
    id: 'quality',
    label: '质量',
    kind: 'select' as const,
    defaultValue: '',
    help: '留空时使用 Provider 默认质量；不是所有模型都支持相同档位。',
    options: [
      { label: 'Provider 默认', value: '' },
      { label: 'Auto · Provider 决定', value: 'auto' },
      { label: 'Low · 草稿', value: 'low' },
      { label: 'Medium · 平衡', value: 'medium' },
      { label: 'High · 精细', value: 'high' },
    ],
  },
  {
    id: 'responseFormat',
    label: '兼容响应格式',
    kind: 'select' as const,
    defaultValue: '',
    help: '仅用于接受 response_format 的兼容接口；GPT Image 系列会自动禁用。',
    options: [
      { label: 'Provider 默认', value: '' },
      { label: 'URL', value: 'url' },
      { label: 'Base64 JSON', value: 'b64_json' },
    ],
  },
  {
    id: 'outputFormat',
    label: '输出格式',
    kind: 'select' as const,
    defaultValue: 'png',
    required: true,
    help: '控制支持 output_format 的模型返回格式；旧兼容模型由 Provider 决定。',
    capabilityHint: { capability: 'outputFormat' as const, message: '当前模型不接收 output_format；返回格式由 Provider 决定。' },
    options: [
      { label: 'PNG · 无损', value: 'png' },
      { label: 'JPEG · 更快', value: 'jpeg' },
      { label: 'WebP · 更小', value: 'webp' },
    ],
  },
  {
    id: 'outputCompression', label: 'JPEG/WebP 压缩质量', kind: 'number' as const, defaultValue: 100,
    min: 0, max: 100, step: 1, placeholder: '0–100', example: '90',
    help: '只在输出格式为 JPEG 或 WebP 时发送；PNG 不显示此项。',
    condition: { parameter: 'outputFormat', operator: 'in' as const, values: ['jpeg', 'webp'] },
    capabilityHint: { capability: 'outputFormat' as const, message: '当前模型不接收 output_format，因此不会发送压缩质量。' },
  },
  {
    id: 'background',
    label: '背景',
    kind: 'select' as const,
    defaultValue: 'auto',
    help: '透明背景需要模型和输出格式共同支持；不确定时保持 Auto。',
    options: [
      { label: 'Auto · Provider 决定', value: 'auto' },
      { label: '不透明', value: 'opaque' },
      { label: '透明（模型需支持）', value: 'transparent' },
    ],
  },
  {
    id: 'moderation',
    label: '内容审核',
    kind: 'select' as const,
    defaultValue: 'auto',
    help: '保留 Auto 可获得 Provider 的标准内容审核策略。',
    options: [
      { label: 'Auto · 标准', value: 'auto' },
      { label: 'Low · 较宽松', value: 'low' },
    ],
  },
  {
    id: 'seed', label: 'Seed（兼容模型）', kind: 'number' as const, defaultValue: 0,
    min: 0, step: 1, placeholder: '非负整数', example: '842019',
    help: '仅在 Provider 明确支持 Seed 时发送；同一 Seed 也不保证跨模型完全一致。',
    capabilityHint: { capability: 'seed' as const, message: '当前模型不支持 Seed；此值不会发送。' },
  },
  {
    id: 'count', label: '数量', kind: 'number' as const, defaultValue: 1,
    required: true, min: 1, max: 10, step: 1, placeholder: '1–10', example: '4',
    help: '单次远程任务请求的候选图片数量；批量对比请使用 Prompt Matrix。',
  },
] as const

const definitions: readonly NodeDefinition[] = [
  {
    type: 'text',
    title: '文本',
    category: '提示词',
    description: '保存场景、角色或约束文本。',
    inputs: {},
    outputs: { text: port('text', '文本', 'text') },
    parameters: [{
      id: 'text', label: '内容', kind: 'textarea', defaultValue: '',
      placeholder: '描述画面主体、环境、光线与限制…',
      help: '文本只沿连线传给下游节点；本节点不会单独调用 Provider。',
      example: '雨夜中的现代茶室，电影级布光，真实材质，清晰建筑线条',
    }],
    cachePolicy: 'pure',
    accent: 'text',
  },
  {
    type: 'prompt_template',
    title: '提示词模板',
    category: '提示词',
    description: '把输入文本注入可复用模板。',
    inputs: { input: port('input', '输入', 'text', false) },
    outputs: { text: port('text', '提示词', 'text') },
    parameters: [{
      id: 'template', label: '模板', kind: 'textarea', defaultValue: '{input}', required: true,
      placeholder: '{input}, cinematic lighting', help: '使用 {input} 插入上游文本；未连接输入时仍保留模板原文。',
      example: '{input}, restrained palette, volumetric light',
    }],
    cachePolicy: 'pure',
    accent: 'text',
  },
  {
    type: 'text_join',
    title: '文本拼接',
    category: '提示词',
    description: '按顺序合并多段提示词。',
    inputs: {
      a: port('a', '文本 A', 'text', false),
      b: port('b', '文本 B', 'text', false),
    },
    outputs: { text: port('text', '文本', 'text') },
    parameters: [{ id: 'separator', label: '分隔符', kind: 'text', defaultValue: ', ', placeholder: ', ', help: '插入两段文本之间；可以使用换行。', example: ', ' }],
    cachePolicy: 'pure',
    accent: 'text',
  },
  {
    type: 'reroute',
    title: '重路由',
    category: '工具',
    description: '整理长连线，不改变数据。',
    inputs: { input: port('input', '输入', 'any') },
    outputs: { output: port('output', '输出', 'any') },
    parameters: [],
    cachePolicy: 'pure',
    accent: 'utility',
  },
  {
    type: 'project_image',
    title: '本地图片',
    category: '图像',
    description: '从电脑载入图片并作为工作流输入。',
    inputs: {},
    outputs: {
      image: port('image', '单张图片', 'image'),
      images: port('images', '图片列表', 'images'),
    },
    parameters: [{
      id: 'path', label: '图片文件', kind: 'path', defaultValue: '', required: true,
      placeholder: 'assets/imports/图片.png', help: '请选择图片；客户端只保存项目相对路径，不会把外部绝对路径写入 Workflow。',
      example: 'assets/imports/reference.png',
    }],
    cachePolicy: 'pure',
    accent: 'image',
  },
  {
    type: 'image_generation',
    title: '图像生成',
    category: '生成',
    description: '根据提示词生成图像；连接参考图后会按图片内容引导生成。',
    inputs: {
      prompt: port('prompt', '提示词', 'text'),
      referenceImages: port('referenceImages', '参考图', 'images', false),
    },
    outputs: { images: port('images', '图片', 'images') },
    parameters: [
      ...generationParameters,
      {
        id: 'comfyPrompt', label: 'ComfyUI API Workflow JSON', kind: 'textarea', defaultValue: '',
        placeholder: '粘贴 ComfyUI 导出的 API-format Workflow JSON',
        help: '仅远程 ComfyUI Provider 使用；请从 ComfyUI 导出 API 格式，而不是界面 Workflow。',
        example: '{"3":{"class_type":"KSampler","inputs":{}}}',
      },
      {
        id: 'comfyBindings', label: 'ComfyUI 多参数绑定 JSON', kind: 'textarea', defaultValue: '',
        placeholder: '输入参数到节点字段的绑定 JSON（可留空）',
        help: '把提示词、模型、尺寸、Seed、参考图或蒙版绑定到 API Workflow 的 nodeId/inputName；每种绑定使用目标数组。',
        example: '{"text":[{"nodeId":"6","inputName":"text"}],"image":[{"nodeId":"12","inputName":"image"}]}',
      },
      {
        id: 'maskPath', label: 'ComfyUI 蒙版路径', kind: 'path', defaultValue: '',
        placeholder: 'assets/imports/mask.png',
        help: '仅在 comfyBindings 声明 mask 目标时上传；必须是项目内已校验图片。',
        example: 'assets/imports/product-mask.png',
      },
      {
        id: 'comfyPromptNodeId', label: '提示词节点 ID', kind: 'text', defaultValue: '',
        placeholder: '例如 6', help: '未配置多参数绑定时，将最终提示词写入这个 ComfyUI 节点。', example: '6',
      },
      {
        id: 'comfyPromptInput', label: '提示词输入名', kind: 'text', defaultValue: 'text',
        placeholder: 'text', help: '提示词节点接收文本的 inputs 字段名，通常为 text。', example: 'text',
      },
    ],
    cachePolicy: 'side-effecting',
    accent: 'image',
  },
  ...(['image_edit', 'image_inpaint', 'image_outpaint'] as const).map(
    (type, index): NodeDefinition => ({
      type,
      title: ['图片编辑', '局部重绘', '扩图'][index] ?? type,
      category: '生成',
      description: type === 'image_edit'
        ? '根据提示词修改源图的内容与风格。'
        : type === 'image_inpaint'
          ? '使用蒙版重绘源图的指定区域。'
          : '扩展画布并生成新的边缘内容。',
      inputs: {
        image: port('image', '单张源图', 'image', false),
        images: port('images', '源图列表（取第一张）', 'images', false),
        mask: port('mask', '蒙版', 'image', type === 'image_inpaint'),
        prompt: port('prompt', '提示词', 'text'),
      },
      outputs: {
        image: port('image', '首张图片', 'image'),
        images: port('images', '图片列表', 'images'),
      },
      requiredInputGroups: [['image', 'images']],
      parameters: [
        ...generationParameters,
        {
          id: 'maskPath', label: '蒙版路径', kind: 'path', defaultValue: '',
          placeholder: 'assets/imports/mask.png',
          help: '可选项目内蒙版；局部重绘优先使用已连接的蒙版端口，白色区域通常表示需要编辑。',
          example: 'assets/imports/product-mask.png',
        },
        {
          id: 'inputFidelity', label: '输入保真度（兼容模型）', kind: 'select', defaultValue: 'high',
          help: 'High 更强调保留源图细节；仅在当前编辑模型明确支持时发送。',
          capabilityHint: { capability: 'editing', message: '当前 Provider 不支持图像编辑。' },
          options: [{ label: 'High', value: 'high' }, { label: 'Low', value: 'low' }],
        },
      ],
      cachePolicy: 'side-effecting',
      accent: 'image',
    }),
  ),
  {
    type: 'image_preview',
    title: '图像预览',
    category: '图像',
    description: '预览、比较和固定上游图片。',
    inputs: { images: port('images', '图片', 'images') },
    outputs: { images: port('images', '图片', 'images') },
    parameters: [],
    cachePolicy: 'pure',
    accent: 'image',
  },
  {
    type: 'frame',
    title: '分组框',
    category: '组织',
    description: '可缩放的画布区域；折叠时隐藏框内节点。',
    inputs: {},
    outputs: {},
    parameters: [{
      id: 'label', label: '标题', kind: 'text', defaultValue: '分组', required: true,
      placeholder: '例如：角色一致性', help: '用于标记画布区域，不会参与执行。', example: '产品主视觉',
    }],
    cachePolicy: 'pure',
    accent: 'control',
  },
  {
    type: 'note',
    title: '便签',
    category: '组织',
    description: '记录工作流说明与注意事项。',
    inputs: {},
    outputs: {},
    parameters: [{
      id: 'text', label: '内容', kind: 'textarea', defaultValue: '',
      placeholder: '记录操作说明、交付标准或待办…', help: '便签仅随 Workflow 保存，不会发送给 Provider。',
      example: '交付前检查：主体比例、文字拼写、透明边缘。',
    }],
    cachePolicy: 'pure',
    accent: 'control',
  },
]

export class NodeRegistry {
  readonly #definitions = new Map<string, NodeDefinition>()

  constructor(initialDefinitions: readonly NodeDefinition[] = definitions) {
    initialDefinitions.forEach((definition) => this.register(definition))
  }

  register(definition: NodeDefinition): void {
    if (this.#definitions.has(definition.type)) {
      throw new Error(`节点类型重复：${definition.type}`)
    }
    this.#definitions.set(definition.type, definition)
  }

  has(type: string): boolean {
    return this.#definitions.has(type)
  }

  get(type: string): NodeDefinition {
    const definition = this.#definitions.get(type)
    if (!definition) throw new Error(`未知节点类型：${type}`)
    return definition
  }

  list(): readonly NodeDefinition[] {
    return [...this.#definitions.values()]
  }

  copy(): NodeRegistry {
    return new NodeRegistry(this.list())
  }

  withDefinitions(additional: readonly NodeDefinition[]): NodeRegistry {
    return new NodeRegistry([...this.list(), ...additional])
  }

  compatible(source: SocketDataType, target: SocketDataType): boolean {
    return source === target || source === 'any' || target === 'any' || (source === 'image' && target === 'images')
  }

  bypassRoute(type: string): readonly [string, string] | undefined {
    const definition = this.get(type)
    const inputs = Object.values(definition.inputs)
    const outputs = Object.values(definition.outputs)
    if (definition.cachePolicy === 'side-effecting' || inputs.length !== 1 || outputs.length !== 1) return undefined
    const input = inputs[0]
    const output = outputs[0]
    if (!input || !output || input.dataType !== output.dataType) return undefined
    return [input.id, output.id]
  }
}

export const subgraphNodeDefinition = (definition: SubgraphDefinition): NodeDefinition => ({
  type: `subgraph:${definition.id}`,
  title: definition.name,
  category: '子图',
  description: definition.description || '可复用的类型化子图。',
  inputs: Object.fromEntries(definition.inputs.map((item) => [item.name, {
    id: item.name,
    label: item.name,
    dataType: item.dataType,
    required: item.required,
    ...(item.multiple === undefined ? {} : { multiple: item.multiple }),
  }])),
  outputs: Object.fromEntries(definition.outputs.map((item) => [item.name, {
    id: item.name,
    label: item.name,
    dataType: item.dataType,
    required: item.required,
    ...(item.multiple === undefined ? {} : { multiple: item.multiple }),
  }])),
  parameters: [],
  cachePolicy: 'pure',
  accent: 'control',
})

export const registryWithSubgraphs = (
  registry: NodeRegistry,
  definitions: readonly SubgraphDefinition[],
): NodeRegistry => {
  const additional: NodeDefinition[] = []
  for (const definition of definitions) {
    const dynamic = subgraphNodeDefinition(definition)
    if (!registry.has(dynamic.type)) {
      additional.push(dynamic)
      continue
    }
    const existing = registry.get(dynamic.type)
    const interfaceOf = (value: Readonly<Record<string, PortDefinition>>): string =>
      JSON.stringify(Object.entries(value).map(([name, item]) => [
        name,
        item.dataType,
        item.required,
        item.multiple ?? false,
      ]))
    if (interfaceOf(existing.inputs) !== interfaceOf(dynamic.inputs)
      || interfaceOf(existing.outputs) !== interfaceOf(dynamic.outputs)) {
      throw new Error(`节点类型与子图接口冲突：${dynamic.type}`)
    }
  }
  return registry.withDefinitions(additional)
}

export const defaultRegistry = new NodeRegistry()
