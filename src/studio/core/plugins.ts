import { z } from 'zod'
import type { WorkflowNode } from '../shared/types.js'

export const pluginPermissions = ['network', 'project-read', 'project-write', 'clipboard', 'shell'] as const
export type PluginPermission = (typeof pluginPermissions)[number]

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/),
  name: z.string().trim().min(1).max(160),
  version: z.string().regex(semver),
  hostVersion: z.string().regex(semver),
  description: z.string().max(4000).optional(),
  entryPoint: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  permissions: z.array(z.enum(pluginPermissions)).max(pluginPermissions.length)
    .refine((items) => new Set(items).size === items.length, '插件权限不能重复'),
  nodeTypes: z.array(z.string().regex(/^[A-Za-z0-9]+(?:[_.-][A-Za-z0-9]+)*$/).max(160)).max(256)
    .refine((items) => new Set(items).size === items.length, '插件节点类型不能重复'),
  dependencies: z.record(z.string(), z.string().regex(semver)).default({}),
}).strict().superRefine((manifest, context) => {
  if (manifest.id in manifest.dependencies) {
    context.addIssue({ code: 'custom', message: '插件不能依赖自身', path: ['dependencies', manifest.id] })
  }
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>

export interface PluginPolicy {
  readonly safeMode: boolean
  readonly hostVersion: string
  readonly enabled: boolean
  readonly versionLock: string
  readonly grantedPermissions: ReadonlySet<PluginPermission>
  readonly installedPlugins?: Readonly<Record<string, string>>
}

export interface PluginDecision {
  readonly allowed: boolean
  readonly reasons: readonly string[]
  readonly missingPermissions: readonly PluginPermission[]
}

export const evaluatePlugin = (manifest: PluginManifest, policy: PluginPolicy): PluginDecision => {
  const parsed = pluginManifestSchema.parse(manifest)
  const reasons: string[] = []
  if (!policy.enabled) reasons.push('插件未启用')
  if (parsed.version !== policy.versionLock) reasons.push('插件版本与锁定版本不一致')
  if (parsed.hostVersion !== policy.hostVersion) reasons.push('插件 Host 版本不兼容')
  const missingPermissions = parsed.permissions.filter((permission) => !policy.grantedPermissions.has(permission))
  if (missingPermissions.length > 0) reasons.push('插件权限未授权')
  if (policy.safeMode) reasons.push('安全模式禁止执行第三方插件代码')
  for (const [pluginId, version] of Object.entries(parsed.dependencies)) {
    if (policy.installedPlugins?.[pluginId] !== version) reasons.push(`插件依赖缺失或版本不匹配：${pluginId}@${version}`)
  }
  return { allowed: reasons.length === 0, reasons, missingPermissions }
}

export interface MissingNodePlaceholder {
  readonly executable: false
  readonly originalType: string
  readonly pluginId?: string
  readonly reason: string
  readonly serializedNode: string
}

const losslessJson = (value: unknown): string => {
  const payload = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('缺失节点包含非有限数值')
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined) {
      throw new Error('缺失节点包含非 JSON 数据')
    }
    return item
  })
  if (payload === undefined) throw new Error('缺失节点数据不是有效 JSON')
  JSON.parse(payload) as unknown
  return payload
}

export const createMissingNodePlaceholder = (
  node: WorkflowNode,
  input: { readonly pluginId?: string; readonly reason?: string } = {},
): MissingNodePlaceholder => {
  if (!node.type.trim()) throw new Error('缺失节点必须包含原始类型')
  return {
    executable: false,
    originalType: node.type,
    ...(input.pluginId ? { pluginId: input.pluginId } : {}),
    reason: input.reason?.trim() || '插件或节点类型不可用',
    serializedNode: losslessJson(node),
  }
}

export const restoreMissingNode = (placeholder: MissingNodePlaceholder): WorkflowNode => {
  const value: unknown = JSON.parse(placeholder.serializedNode)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('缺失节点快照损坏')
  return value as WorkflowNode
}
