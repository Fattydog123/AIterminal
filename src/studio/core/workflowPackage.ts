import { z } from 'zod'
import { projectPluginRecordSchema, workflowDocumentSchema } from '../shared/contracts.js'
import type { ProjectPluginRecord, WorkflowDocument, WorkflowNode } from '../shared/types.js'
import { defaultRegistry } from './registry.js'

const sensitiveKey = /(?:authorization|api[_-]?key|secret|token|password|cookie)/i

const assertPackageSafe = (value: unknown, currentPath = '$', seen = new WeakSet<object>()): void => {
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) throw new Error(`工作流包包含循环引用：${currentPath}`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPackageSafe(item, `${currentPath}[${index}]`, seen))
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey.test(key)) throw new Error(`工作流包禁止包含敏感字段：${currentPath}.${key}`)
      assertPackageSafe(item, `${currentPath}.${key}`, seen)
    }
  }
  seen.delete(value)
}

const dependencySchema = z.object({
  nodeTypes: z.array(z.string().min(1).max(256)).max(10_000),
  providerIds: z.array(z.string().min(1).max(160)).max(1_000),
  models: z.array(z.string().min(1).max(256)).max(10_000),
  plugins: z.array(projectPluginRecordSchema).max(500),
}).strict()

const packageSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('ai-terminal-studio-workflow'),
  createdAt: z.string().datetime(),
  workflow: workflowDocumentSchema,
  dependencies: dependencySchema,
}).strict()

export interface WorkflowPackageDependencies {
  readonly nodeTypes: readonly string[]
  readonly providerIds: readonly string[]
  readonly models: readonly string[]
  readonly plugins: readonly ProjectPluginRecord[]
}

export interface PortableWorkflowPackage {
  readonly schemaVersion: 1
  readonly kind: 'ai-terminal-studio-workflow'
  readonly createdAt: string
  readonly workflow: WorkflowDocument
  readonly dependencies: WorkflowPackageDependencies
}

export interface WorkflowPackageInspection {
  readonly compatible: boolean
  readonly missingProviderIds: readonly string[]
  readonly missingNodeTypes: readonly string[]
  readonly missingPlugins: readonly { readonly id: string; readonly versionLock: string }[]
}

const nestedWorkflows = (workflow: WorkflowDocument): readonly WorkflowDocument[] => {
  const result: WorkflowDocument[] = [workflow]
  for (const definition of workflow.subgraphs ?? []) result.push(...nestedWorkflows(definition.workflow))
  return result
}

const uniqueSorted = (values: Iterable<string>): readonly string[] =>
  [...new Set(values)].filter(Boolean).sort((left, right) => left.localeCompare(right))

const dependenciesOf = (workflow: WorkflowDocument, plugins: readonly ProjectPluginRecord[]): WorkflowPackageDependencies => {
  const workflows = nestedWorkflows(workflow)
  const nodes = workflows.flatMap((item) => [...item.nodes])
  const remoteTypes = new Set(['image_generation', 'image_edit', 'image_inpaint', 'image_outpaint'])
  return {
    nodeTypes: uniqueSorted(nodes.map((node) => node.type).filter((type) => !type.startsWith('subgraph:'))),
    providerIds: uniqueSorted(nodes
      .filter((node) => remoteTypes.has(node.type))
      .map((node) => String(node.parameters.providerId ?? '').trim())),
    models: uniqueSorted(nodes
      .filter((node) => remoteTypes.has(node.type))
      .map((node) => String(node.parameters.model ?? '').trim())),
    plugins: [...plugins],
  }
}

export const createWorkflowPackage = (
  workflow: WorkflowDocument,
  options: { readonly plugins?: readonly ProjectPluginRecord[]; readonly createdAt?: string } = {},
): PortableWorkflowPackage => {
  assertPackageSafe(workflow)
  assertPackageSafe(options.plugins ?? [])
  const parsedWorkflow = workflowDocumentSchema.parse(workflow) as unknown as WorkflowDocument
  const value = {
    schemaVersion: 1 as const,
    kind: 'ai-terminal-studio-workflow' as const,
    createdAt: options.createdAt ?? new Date().toISOString(),
    workflow: parsedWorkflow,
    dependencies: dependenciesOf(parsedWorkflow, options.plugins ?? []),
  }
  assertPackageSafe(value)
  return packageSchema.parse(value) as unknown as PortableWorkflowPackage
}

export const parseWorkflowPackage = (raw: unknown): PortableWorkflowPackage => {
  assertPackageSafe(raw)
  return packageSchema.parse(raw) as unknown as PortableWorkflowPackage
}

const pluginMatches = (required: ProjectPluginRecord, installed: readonly ProjectPluginRecord[]): boolean =>
  installed.some((candidate) => candidate.enabled
    && candidate.manifest.id === required.manifest.id
    && candidate.manifest.version === required.versionLock
    && candidate.versionLock === required.versionLock)

export const inspectWorkflowPackage = (
  raw: unknown,
  available: { readonly providerIds: readonly string[]; readonly plugins: readonly ProjectPluginRecord[] },
): WorkflowPackageInspection => {
  const portable = parseWorkflowPackage(raw)
  const providerIds = new Set(available.providerIds)
  const availableNodeTypes = new Set(defaultRegistry.list().map((definition) => definition.type))
  available.plugins.filter((plugin) => plugin.enabled).forEach((plugin) => {
    plugin.manifest.nodeTypes.forEach((type) => availableNodeTypes.add(type))
  })
  const missingProviderIds = portable.dependencies.providerIds.filter((id) => !providerIds.has(id))
  const missingNodeTypes = portable.dependencies.nodeTypes.filter((type) => !availableNodeTypes.has(type))
  const missingPlugins = portable.dependencies.plugins
    .filter((plugin) => !pluginMatches(plugin, available.plugins))
    .map((plugin) => ({ id: plugin.manifest.id, versionLock: plugin.versionLock }))
  return {
    compatible: missingProviderIds.length === 0 && missingNodeTypes.length === 0 && missingPlugins.length === 0,
    missingProviderIds,
    missingNodeTypes,
    missingPlugins,
  }
}

export const workflowPackageNodes = (raw: unknown): readonly WorkflowNode[] =>
  nestedWorkflows(parseWorkflowPackage(raw).workflow).flatMap((workflow) => workflow.nodes)
