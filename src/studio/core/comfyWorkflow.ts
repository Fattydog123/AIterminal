export type ComfyBindingKind = 'text' | 'seed' | 'width' | 'height' | 'model' | 'image' | 'mask'
export type ComfyPrimitive = string | number | boolean

export interface ComfyInputReference {
  readonly filename: string
  readonly subfolder: string
  readonly type: 'input'
}

export interface ComfyApiWorkflowNode {
  readonly class_type: string
  readonly inputs: Readonly<Record<string, unknown>>
  readonly _meta?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export type ComfyApiWorkflow = Readonly<Record<string, ComfyApiWorkflowNode>>

export interface ComfyBindingCandidate {
  readonly nodeId: string
  readonly classType: string
  readonly inputName: string
  readonly kind: ComfyBindingKind
  readonly value: ComfyPrimitive
}

export interface ComfyWorkflowInspection {
  readonly workflow: ComfyApiWorkflow
  readonly nodeCount: number
  readonly nodeTypes: readonly string[]
  readonly bindings: readonly ComfyBindingCandidate[]
}

export interface ComfyBindingTarget {
  readonly nodeId: string
  readonly inputName: string
}

export type ComfyBindingMap = Readonly<Partial<Record<ComfyBindingKind, readonly ComfyBindingTarget[]>>>
export type ComfyBindingValues = Readonly<Partial<{
  readonly text: ComfyPrimitive
  readonly seed: ComfyPrimitive
  readonly width: ComfyPrimitive
  readonly height: ComfyPrimitive
  readonly model: ComfyPrimitive
  readonly image: ComfyInputReference
  readonly mask: ComfyInputReference
}>>
const bindingKinds = ['text', 'seed', 'width', 'height', 'model', 'image', 'mask'] as const

const reservedKeys = new Set(['__proto__', 'prototype', 'constructor'])

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const safeIdentifier = (value: string, maximum = 256): boolean =>
  Boolean(value.trim()) && value.length <= maximum && !/[\u0000-\u001f]/.test(value) && !reservedKeys.has(value)

const bindingKind = (classType: string, inputName: string, value: unknown): ComfyBindingKind | undefined => {
  const name = inputName.toLowerCase()
  if (Number.isSafeInteger(value) && Number(value) >= 0) {
    if (/(?:^|_)seed$/.test(name)) return 'seed'
    if (/(?:^|_)width$/.test(name)) return 'width'
    if (/(?:^|_)height$/.test(name)) return 'height'
  }
  if (typeof value !== 'string') return undefined
  if (/(?:^|_)(?:image|mask)(?:_name)?$/.test(name)) {
    return /mask/i.test(classType) || /(?:^|_)mask(?:_name)?$/.test(name) ? 'mask' : 'image'
  }
  if (/(?:^|_)(?:ckpt|checkpoint|model)(?:_name)?$/.test(name)) return 'model'
  if (/(?:^|_)(?:text|prompt)$/.test(name)) return 'text'
  return undefined
}

const parseWorkflow = (input: unknown): Readonly<Record<string, unknown>> => {
  let value = input
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > 16 * 1024 * 1024) throw new Error('ComfyUI API Workflow JSON 超过 16 MiB')
    try {
      value = JSON.parse(input) as unknown
    } catch (error) {
      throw new Error(`ComfyUI API Workflow 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const workflow = recordValue(value)
  if (!workflow) throw new Error('ComfyUI API Workflow 必须是节点 ID 到节点定义的对象')
  return workflow
}

export const inspectComfyApiWorkflow = (input: unknown): ComfyWorkflowInspection => {
  const raw = parseWorkflow(input)
  const entries = Object.entries(raw)
  if (entries.length === 0 || entries.length > 5_000) throw new Error('ComfyUI API Workflow 必须包含 1–5000 个节点')
  const workflow: Record<string, ComfyApiWorkflowNode> = {}
  const bindings: ComfyBindingCandidate[] = []
  const nodeTypes = new Set<string>()
  for (const [nodeId, candidate] of entries) {
    if (!safeIdentifier(nodeId)) throw new Error(`ComfyUI API Workflow 节点 ID 无效：${nodeId}`)
    const node = recordValue(candidate)
    const classType = typeof node?.class_type === 'string' ? node.class_type.trim() : ''
    const inputs = recordValue(node?.inputs)
    if (!safeIdentifier(classType) || !inputs) throw new Error(`ComfyUI API Workflow 节点 ${nodeId} 缺少 class_type 或 inputs`)
    const inputEntries = Object.entries(inputs)
    if (inputEntries.length > 1_000) throw new Error(`ComfyUI API Workflow 节点 ${nodeId} 输入过多`)
    for (const [inputName, value] of inputEntries) {
      if (!safeIdentifier(inputName)) throw new Error(`ComfyUI API Workflow 输入名无效：${nodeId}.${inputName}`)
      const kind = bindingKind(classType, inputName, value)
      if (kind) bindings.push({ nodeId, classType, inputName, kind, value: value as ComfyPrimitive })
    }
    workflow[nodeId] = { ...structuredClone(node), class_type: classType, inputs: structuredClone(inputs) } as ComfyApiWorkflowNode
    nodeTypes.add(classType)
  }
  return {
    workflow,
    nodeCount: entries.length,
    nodeTypes: [...nodeTypes].sort(),
    bindings,
  }
}

export const parseComfyBindingMap = (input: unknown): ComfyBindingMap => {
  let value = input
  if (typeof input === 'string') {
    if (!input.trim()) return {}
    if (new TextEncoder().encode(input).byteLength > 1024 * 1024) throw new Error('ComfyUI 参数绑定 JSON 超过 1 MiB')
    try { value = JSON.parse(input) as unknown } catch (error) {
      throw new Error(`ComfyUI 参数绑定不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const record = recordValue(value)
  if (!record) throw new Error('ComfyUI 参数绑定必须是对象')
  const unknown = Object.keys(record).find((key) => !bindingKinds.includes(key as ComfyBindingKind))
  if (unknown) throw new Error(`ComfyUI 参数绑定包含未知字段：${unknown}`)
  const result: Partial<Record<ComfyBindingKind, readonly ComfyBindingTarget[]>> = {}
  const seen = new Set<string>()
  let count = 0
  for (const kind of bindingKinds) {
    const targets = record[kind]
    if (targets === undefined) continue
    if (!Array.isArray(targets)) throw new Error(`ComfyUI ${kind} 参数绑定必须是数组`)
    const parsed: ComfyBindingTarget[] = []
    for (const value of targets) {
      count += 1
      if (count > 1_000) throw new Error('ComfyUI 参数绑定超过安全上限 1000')
      const target = recordValue(value)
      const nodeId = typeof target?.nodeId === 'string' ? target.nodeId : ''
      const inputName = typeof target?.inputName === 'string' ? target.inputName : ''
      const targetUnknown = Object.keys(target ?? {}).find((key) => key !== 'nodeId' && key !== 'inputName')
      if (!safeIdentifier(nodeId) || !safeIdentifier(inputName) || targetUnknown) {
        throw new Error(`ComfyUI ${kind} 参数绑定目标无效`)
      }
      const key = `${nodeId}\u0000${inputName}`
      if (seen.has(key)) throw new Error(`ComfyUI 参数被重复绑定：${nodeId}.${inputName}`)
      seen.add(key)
      parsed.push({ nodeId, inputName })
    }
    result[kind] = parsed
  }
  return result
}

const validPrimitiveBindingValue = (kind: Exclude<ComfyBindingKind, 'image' | 'mask'>, value: unknown): value is ComfyPrimitive => {
  if (kind === 'text') return typeof value === 'string' && value.length <= 256_000
  if (kind === 'model') return typeof value === 'string' && Boolean(value.trim()) && value.length <= 1_024 && !/[\u0000-\u001f]/.test(value)
  if (!Number.isSafeInteger(value)) return false
  if (kind === 'seed') return Number(value) >= 0
  return Number(value) >= 1 && Number(value) <= 65_536
}

const inputReferencePath = (value: unknown): string | undefined => {
  const reference = recordValue(value)
  const filename = typeof reference?.filename === 'string' ? reference.filename : ''
  const subfolder = typeof reference?.subfolder === 'string' ? reference.subfolder : ''
  if (reference?.type !== 'input'
    || !filename.trim()
    || filename !== filename.trim()
    || filename.length > 255
    || filename === '.'
    || filename === '..'
    || /[\\/\u0000-\u001f]/.test(filename)
    || subfolder !== subfolder.trim()
    || subfolder.length > 1024
    || subfolder.startsWith('/')
    || subfolder.endsWith('/')
    || /[\\\u0000-\u001f]/.test(subfolder)
    || (subfolder && subfolder.split('/').some((part) => !part || part === '.' || part === '..'))) return undefined
  return subfolder ? `${subfolder}/${filename}` : filename
}

const materializeBindingValue = (kind: ComfyBindingKind, value: unknown): ComfyPrimitive | undefined => {
  if (kind === 'image' || kind === 'mask') return inputReferencePath(value)
  return validPrimitiveBindingValue(kind, value) ? value : undefined
}

export const applyComfyWorkflowBindings = (
  input: unknown,
  mapping: ComfyBindingMap,
  values: ComfyBindingValues,
): ComfyApiWorkflow => {
  const inspection = inspectComfyApiWorkflow(input)
  const candidates = new Map(inspection.bindings.map((candidate) => [
    `${candidate.nodeId}\u0000${candidate.inputName}`,
    candidate,
  ]))
  const result: Record<string, ComfyApiWorkflowNode> = Object.fromEntries(
    Object.entries(inspection.workflow).map(([nodeId, node]) => [
      nodeId,
      { ...structuredClone(node), inputs: { ...structuredClone(node.inputs) } },
    ]),
  )
  const boundTargets = new Set<string>()
  let targetCount = 0
  for (const kind of bindingKinds) {
    const targets = mapping[kind] ?? []
    if (targets.length === 0) continue
    const value = values[kind]
    const materialized = materializeBindingValue(kind, value)
    if (materialized === undefined) throw new Error(`ComfyUI ${kind} 绑定值无效`)
    for (const target of targets) {
      targetCount += 1
      if (targetCount > 1_000) throw new Error('ComfyUI 多参数绑定超过安全上限 1000')
      const key = `${target.nodeId}\u0000${target.inputName}`
      if (boundTargets.has(key)) throw new Error(`ComfyUI 输入被重复绑定：${target.nodeId}.${target.inputName}`)
      const candidate = candidates.get(key)
      if (!candidate || candidate.kind !== kind) {
        throw new Error(`ComfyUI 绑定目标不是可绑定的 ${kind} 直接值：${target.nodeId}.${target.inputName}`)
      }
      const node = result[target.nodeId]
      if (!node) throw new Error(`ComfyUI 绑定节点不存在：${target.nodeId}`)
      result[target.nodeId] = { ...node, inputs: { ...node.inputs, [target.inputName]: materialized } }
      boundTargets.add(key)
    }
  }
  return result
}
