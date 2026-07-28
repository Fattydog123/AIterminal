const canonicalValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (depth > 128) throw new Error('JSON 结构嵌套过深')
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) throw new Error('JSON 结构包含循环引用')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1, seen))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Readonly<Record<string, unknown>>)[key], depth + 1, seen)]),
    )
  } finally {
    seen.delete(value)
  }
}

/** Stable JSON used for hashes that must survive schema parsing and key reorder. */
export const canonicalJson = (value: unknown): string => {
  const serialized = JSON.stringify(canonicalValue(value, 0, new WeakSet()))
  if (serialized === undefined) throw new Error('值不能序列化为 JSON')
  return serialized
}
