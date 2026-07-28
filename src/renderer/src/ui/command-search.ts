/**
 * Pure matching/grouping logic for the global command center. Kept free of
 * React so the runtime test suite can exercise ranking behaviour directly.
 */
export interface CommandSearchEntry {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly section: string
  readonly keywords?: string
  readonly disabled?: boolean
}

export interface CommandSectionRow {
  readonly kind: 'section'
  readonly title: string
}

export interface CommandItemRow<T extends CommandSearchEntry> {
  readonly kind: 'item'
  readonly item: T
  readonly flatIndex: number
}

export type CommandRow<T extends CommandSearchEntry> = CommandSectionRow | CommandItemRow<T>

export const COMMAND_RECENTS_LIMIT = 8

export function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true
  if (needle.length > haystack.length) return false
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

/**
 * Weighted match: label prefix beats word-start, beats substring, beats
 * subsequence; secondary fields only strengthen an existing match or provide
 * a weak fallback. Returns 0 when the query misses entirely.
 */
export function scoreCommandMatch(item: CommandSearchEntry, normalizedQuery: string): number {
  const label = item.label.toLocaleLowerCase()
  const rest = `${item.detail} ${item.section} ${item.keywords ?? ''}`.toLocaleLowerCase()
  let score = 0
  if (label.startsWith(normalizedQuery)) score = 100
  else if (label.includes(` ${normalizedQuery}`) || label.includes(`：${normalizedQuery}`) || label.includes(`:${normalizedQuery}`)) score = 80
  else if (label.includes(normalizedQuery)) score = 60
  else if (isSubsequence(normalizedQuery, label)) score = 30
  if (rest.includes(normalizedQuery)) score = Math.max(score, 40) + 8
  else if (score > 0 && isSubsequence(normalizedQuery, rest)) score += 2
  return score
}

export function buildCommandRows<T extends CommandSearchEntry>(
  items: readonly T[],
  query: string,
  recents: readonly string[],
): { rows: ReadonlyArray<CommandRow<T>>; flat: readonly T[] } {
  const normalized = query.trim().toLocaleLowerCase()
  let ordered: ReadonlyArray<readonly [string, readonly T[]]>

  if (normalized) {
    const scored = items
      .map((item, index) => ({ item, index, score: scoreCommandMatch(item, normalized) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
    const list = scored.map((entry) => entry.item)
    ordered = list.length > 0 ? [['匹配结果', list]] : []
  } else {
    const byId = new Map(items.map((item) => [item.id, item]))
    const recentItems = recents
      .map((id) => byId.get(id))
      .filter((item): item is T => item !== undefined && item.disabled !== true)
    const sections = new Map<string, T[]>()
    for (const item of items) {
      const bucket = sections.get(item.section)
      if (bucket) bucket.push(item)
      else sections.set(item.section, [item])
    }
    ordered = [
      ...(recentItems.length > 0 ? [['最近使用', recentItems] as const] : []),
      ...[...sections.entries()].map(([title, list]) => [title, list] as const),
    ]
  }

  const rows: Array<CommandRow<T>> = []
  const flat: T[] = []
  for (const [title, list] of ordered) {
    rows.push({ kind: 'section', title })
    for (const item of list) {
      rows.push({ kind: 'item', item, flatIndex: flat.length })
      flat.push(item)
    }
  }
  return { rows, flat }
}

export function pushRecentCommand(recents: readonly string[], id: string): readonly string[] {
  return [id, ...recents.filter((entry) => entry !== id)].slice(0, COMMAND_RECENTS_LIMIT)
}
