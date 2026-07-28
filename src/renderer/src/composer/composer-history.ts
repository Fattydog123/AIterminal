// Prompt history for the composer: recorded on successful submits and
// recalled with ArrowUp/ArrowDown. Persistence is best-effort localStorage;
// every failure degrades to an in-memory session history.

const STORAGE_KEY = 'ai-terminal:composer-history:v1'
const HISTORY_LIMIT = 50
const ENTRY_CHARACTER_LIMIT = 8_000

let memoryFallback: string[] = []

function readStore(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return [...memoryFallback]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...memoryFallback]
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return [...memoryFallback]
  }
}

function writeStore(entries: string[]): void {
  memoryFallback = entries
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota or privacy-mode failure: the in-memory copy still serves this session.
  }
}

/** Oldest first; the last entry is the most recent submission. */
export function loadComposerHistory(): string[] {
  return readStore()
}

export function recordComposerHistory(entry: string): void {
  const trimmed = entry.trim()
  if (!trimmed || trimmed.length > ENTRY_CHARACTER_LIMIT) return
  const entries = readStore().filter((existing) => existing !== trimmed)
  entries.push(trimmed)
  writeStore(entries.slice(-HISTORY_LIMIT))
}

export interface ComposerHistorySession {
  readonly entries: readonly string[]
  index: number
  readonly stash: string
  recalled: string
}

export function beginComposerHistorySession(stash: string): ComposerHistorySession | null {
  const entries = readStore()
  if (entries.length === 0) return null
  return { entries, index: entries.length, stash, recalled: '' }
}

/**
 * Steps the session and returns the draft to show, or null when the step
 * cannot move (already at the oldest entry). Stepping past the newest entry
 * restores the stashed draft and the caller should discard the session.
 */
export function stepComposerHistory(
  session: ComposerHistorySession,
  direction: 'older' | 'newer',
): { draft: string; done: boolean } | null {
  const nextIndex = direction === 'older' ? session.index - 1 : session.index + 1
  if (nextIndex < 0) return null
  if (nextIndex >= session.entries.length) {
    return { draft: session.stash, done: true }
  }
  session.index = nextIndex
  session.recalled = session.entries[nextIndex]!
  return { draft: session.recalled, done: false }
}
