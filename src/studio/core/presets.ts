export interface ParameterPreset {
  readonly id: string
  readonly name: string
  readonly modelPatterns: readonly string[]
  readonly values: Readonly<Record<string, unknown>>
  readonly tags: readonly string[]
}

export interface PresetDiff {
  readonly path: string
  readonly before: unknown
  readonly after: unknown
  readonly presetId: string
}

const modelMatches = (model: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`, 'i').test(model)
}

export const presetSupportsModel = (preset: ParameterPreset, model: string): boolean =>
  preset.modelPatterns.length === 0 || preset.modelPatterns.some((pattern) => modelMatches(model, pattern))

const blockedPathParts = new Set(['__proto__', 'prototype', 'constructor'])

const parsePath = (path: string): readonly string[] => {
  const parts = path.split('.')
  if (parts.some((part) => !part || blockedPathParts.has(part))) throw new Error(`预设参数路径不安全：${path}`)
  return parts
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const valueAt = (root: Readonly<Record<string, unknown>>, parts: readonly string[]): unknown => {
  let current: unknown = root
  for (const part of parts) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

const setValueAt = (
  root: Readonly<Record<string, unknown>>,
  parts: readonly string[],
  value: unknown,
): Readonly<Record<string, unknown>> => {
  const result: Record<string, unknown> = { ...root }
  let target = result
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      target[part] = structuredClone(value)
      break
    }
    const previous = target[part]
    const child: Record<string, unknown> = isRecord(previous) ? { ...previous } : {}
    target[part] = child
    target = child
  }
  return result
}

const equalValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equalValue(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && equalValue(left[key], right[key]))
  }
  return false
}

export const stackPresets = (
  base: Readonly<Record<string, unknown>>,
  presets: readonly ParameterPreset[],
  model: string,
): { readonly values: Readonly<Record<string, unknown>>; readonly diffs: readonly PresetDiff[]; readonly skipped: readonly string[] } => {
  let values: Readonly<Record<string, unknown>> = { ...base }
  const diffs: PresetDiff[] = []
  const skipped: string[] = []
  presets.forEach((preset) => {
    if (!presetSupportsModel(preset, model)) {
      skipped.push(preset.id)
      return
    }
    Object.entries(preset.values).forEach(([path, after]) => {
      const parts = parsePath(path)
      const before = valueAt(values, parts)
      if (!equalValue(before, after)) {
        diffs.push({
          path,
          before: before === undefined ? undefined : structuredClone(before),
          after: structuredClone(after),
          presetId: preset.id,
        })
      }
      values = setValueAt(values, parts, after)
    })
  })
  return { values, diffs, skipped }
}
