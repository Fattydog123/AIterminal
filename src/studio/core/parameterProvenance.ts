export type ParameterLayerSource = 'preset' | 'linear' | 'matrix' | 'manual'

export interface ParameterLayer {
  readonly source: ParameterLayerSource
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface ParameterOriginStep {
  readonly source: 'default' | 'workflow' | ParameterLayerSource
  readonly id?: string
  readonly value: unknown
}

export interface ParameterProvenanceEntry {
  readonly path: string
  readonly effectiveValue: unknown
  readonly chain: readonly ParameterOriginStep[]
}

export interface ResolvedParameterProvenance {
  readonly values: Readonly<Record<string, unknown>>
  readonly entries: ReadonlyMap<string, ParameterProvenanceEntry>
}

const blockedParts = new Set(['__proto__', 'prototype', 'constructor'])
const safeParts = (path: string): readonly string[] => {
  const parts = path.split('.')
  if (parts.some((part) => !part || blockedParts.has(part))) throw new Error(`参数来源路径不安全：${path}`)
  if (parts.length > 32 || path.length > 512) throw new Error(`参数来源路径过深或过长：${path}`)
  return parts
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const flatten = (
  value: Readonly<Record<string, unknown>>,
  prefix = '',
  output = new Map<string, unknown>(),
): ReadonlyMap<string, unknown> => {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    safeParts(path)
    if (isRecord(item) && Object.keys(item).length > 0) flatten(item, path, output)
    else output.set(path, structuredClone(item))
    if (output.size > 10_000) throw new Error('参数来源路径超过安全上限 10000')
  }
  return output
}

const flattenLayer = (value: Readonly<Record<string, unknown>>): ReadonlyMap<string, unknown> => {
  const output = new Map<string, unknown>()
  for (const [key, item] of Object.entries(value)) {
    const parts = safeParts(key)
    if (!key.includes('.') && isRecord(item) && Object.keys(item).length > 0) flatten(item, key, output)
    else output.set(parts.join('.'), structuredClone(item))
    if (output.size > 10_000) throw new Error('参数来源路径超过安全上限 10000')
  }
  return output
}

const setPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = safeParts(path)
  let current = target
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      current[part] = structuredClone(value)
      return
    }
    const existing = current[part]
    const child: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
    current[part] = child
    current = child
  })
}

export const resolveParameterProvenance = (input: {
  readonly defaults: Readonly<Record<string, unknown>>
  readonly workflow: Readonly<Record<string, unknown>>
  readonly layers: readonly ParameterLayer[]
}): ResolvedParameterProvenance => {
  if (input.layers.length > 100) throw new Error('参数来源层超过安全上限 100')
  const chains = new Map<string, ParameterOriginStep[]>()
  const values: Record<string, unknown> = {}
  const apply = (path: string, value: unknown, origin: ParameterOriginStep): void => {
    setPath(values, path, value)
    chains.set(path, [...(chains.get(path) ?? []), { ...origin, value: structuredClone(value) }])
  }
  for (const [path, value] of flatten(input.defaults)) apply(path, value, { source: 'default', value })
  for (const [path, value] of flatten(input.workflow)) apply(path, value, { source: 'workflow', value })
  for (const layer of input.layers) {
    if (!layer.id.trim() || layer.id.length > 160) throw new Error('参数来源层 ID 无效')
    for (const [path, value] of flattenLayer(layer.values)) apply(path, value, { source: layer.source, id: layer.id, value })
  }
  const entries = new Map<string, ParameterProvenanceEntry>()
  for (const [path, chain] of chains) {
    const effectiveValue = chain.at(-1)?.value
    entries.set(path, { path, effectiveValue: structuredClone(effectiveValue), chain })
  }
  return { values, entries }
}
