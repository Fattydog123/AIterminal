import { z } from 'zod'
import type { NodeDefinition, PortDefinition } from '../shared/types.js'
import { evaluatePlugin, pluginManifestSchema, type PluginManifest, type PluginPolicy } from './plugins.js'

const port = (id: string, label: string): PortDefinition => ({ id, label, dataType: 'text', required: true })

const executorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text-template'),
    template: z.string().max(64_000),
    input: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    output: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  }).strict(),
  z.object({
    kind: z.literal('text-join'),
    inputs: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).min(1).max(32),
    separator: z.string().max(1_024),
    output: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  }).strict(),
  z.object({
    kind: z.literal('constant-text'),
    value: z.string().max(256_000),
    output: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  }).strict(),
])

const declarativeNodeSchema = z.object({
  type: z.string().regex(/^[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)*$/).max(160),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4_000),
  executor: executorSchema,
}).strict()

const bundleSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: pluginManifestSchema,
  nodes: z.array(declarativeNodeSchema).min(1).max(256),
}).strict()

export type DeclarativePluginBundle = z.infer<typeof bundleSchema>

export interface CompiledDeclarativePlugin {
  readonly manifest: PluginManifest
  readonly bundle: DeclarativePluginBundle
  readonly definitions: readonly NodeDefinition[]
}

const definitionOf = (node: DeclarativePluginBundle['nodes'][number]): NodeDefinition => {
  const inputs = node.executor.kind === 'text-template'
    ? { [node.executor.input]: port(node.executor.input, '文本') }
    : node.executor.kind === 'text-join'
      ? Object.fromEntries(node.executor.inputs.map((input) => [input, port(input, input)]))
      : {}
  const outputId = node.executor.output
  return {
    type: node.type,
    title: node.title,
    category: '插件',
    description: node.description,
    inputs,
    outputs: { [outputId]: port(outputId, '文本') },
    parameters: [],
    cachePolicy: 'pure',
    accent: 'utility',
  }
}

export const compileDeclarativePlugin = (raw: unknown, policy: PluginPolicy): CompiledDeclarativePlugin => {
  const bundle = bundleSchema.parse(raw)
  if (bundle.manifest.entryPoint) throw new Error('声明式插件不能包含代码 entryPoint')
  if (bundle.manifest.permissions.length > 0) throw new Error('声明式运行时不授予 network、文件、剪贴板或 shell 权限')
  const decision = evaluatePlugin(bundle.manifest, policy)
  if (!decision.allowed) throw new Error(decision.reasons.join('；'))
  const declared = [...bundle.manifest.nodeTypes].sort()
  const implemented = bundle.nodes.map((node) => node.type).sort()
  if (new Set(implemented).size !== implemented.length || JSON.stringify(declared) !== JSON.stringify(implemented)) {
    throw new Error('插件 Manifest 的节点声明与声明式实现不一致')
  }
  return {
    manifest: bundle.manifest,
    bundle,
    definitions: bundle.nodes.map(definitionOf),
  }
}

const textInput = (inputs: Readonly<Record<string, unknown>>, key: string): string => {
  const value = inputs[key]
  const result = value === undefined || value === null ? '' : String(value)
  if (result.length > 256_000) throw new Error(`插件文本输入超过 256000 字符：${key}`)
  return result
}

export const executeDeclarativePluginNode = (
  raw: unknown,
  nodeType: string,
  inputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> => {
  const bundle = bundleSchema.parse(raw)
  const node = bundle.nodes.find((candidate) => candidate.type === nodeType)
  if (!node || !bundle.manifest.nodeTypes.includes(nodeType)) throw new Error(`声明式插件节点不存在：${nodeType}`)
  const executor = node.executor
  let value: string
  if (executor.kind === 'text-template') {
    value = executor.template.replaceAll(`{${executor.input}}`, textInput(inputs, executor.input))
  } else if (executor.kind === 'text-join') {
    value = executor.inputs.map((input) => textInput(inputs, input)).join(executor.separator)
  } else {
    value = executor.value
  }
  if (value.length > 256_000) throw new Error('声明式插件输出超过 256000 字符')
  return { [executor.output]: value }
}
