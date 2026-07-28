import type { GitFileSummary } from '../../../shared/contracts'

export interface DiffLine {
  readonly id: string
  readonly kind: 'added' | 'removed' | 'hunk' | 'meta' | 'context'
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

export interface ParsedFileDiff {
  readonly path: string
  readonly lines: readonly DiffLine[]
}

const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u

function normalizeDiffPath(value: string): string {
  return value.replace(/^[ab]\//u, '').trim()
}

export function parseUnifiedDiff(patch: string): readonly ParsedFileDiff[] {
  const files: Array<{ path: string; lines: DiffLine[] }> = []
  let current: { path: string; lines: DiffLine[] } | undefined
  let oldLine = 0
  let newLine = 0

  for (const [index, text] of patch.split('\n').entries()) {
    if (text.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(text)
      current = { path: normalizeDiffPath(match?.[2] ?? match?.[1] ?? `变更 ${files.length + 1}`), lines: [] }
      files.push(current)
    }
    if (!current) continue
    const hunk = HUNK_PATTERN.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      current.lines.push({ id: `${current.path}:${index}`, kind: 'hunk', text, oldLine: null, newLine: null })
      continue
    }
    if (text.startsWith('+++ ')) {
      const path = normalizeDiffPath(text.slice(4))
      if (path !== '/dev/null') current.path = path
      current.lines.push({ id: `${current.path}:${index}`, kind: 'meta', text, oldLine: null, newLine: null })
      continue
    }
    if (text.startsWith('--- ') || text.startsWith('index ') || text.startsWith('new file ') || text.startsWith('deleted file ') || text.startsWith('diff --git ')) {
      current.lines.push({ id: `${current.path}:${index}`, kind: 'meta', text, oldLine: null, newLine: null })
      continue
    }
    if (text.startsWith('\\')) {
      // "\ No newline at end of file" markers carry no line counters.
      current.lines.push({ id: `${current.path}:${index}`, kind: 'meta', text, oldLine: null, newLine: null })
    } else if (text.startsWith('+')) {
      current.lines.push({ id: `${current.path}:${index}`, kind: 'added', text: text.slice(1), oldLine: null, newLine: newLine++ })
    } else if (text.startsWith('-')) {
      current.lines.push({ id: `${current.path}:${index}`, kind: 'removed', text: text.slice(1), oldLine: oldLine++, newLine: null })
    } else {
      current.lines.push({ id: `${current.path}:${index}`, kind: 'context', text: text.startsWith(' ') ? text.slice(1) : text, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return files
}

export interface DiffHunk {
  readonly id: string
  readonly header: string
  readonly lines: readonly DiffLine[]
  readonly additions: number
  readonly deletions: number
}

/** Group a parsed file diff into hunks so the UI can act on one block at a time. */
export function groupDiffHunks(file: ParsedFileDiff): readonly DiffHunk[] {
  const hunks: Array<{ id: string; header: string; lines: DiffLine[]; additions: number; deletions: number }> = []
  let current: (typeof hunks)[number] | undefined
  for (const line of file.lines) {
    if (line.kind === 'hunk') {
      current = { id: line.id, header: line.text, lines: [], additions: 0, deletions: 0 }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.kind === 'meta' && !line.text.startsWith('\\')) continue
    current.lines.push(line)
    if (line.kind === 'added') current.additions += 1
    else if (line.kind === 'removed') current.deletions += 1
  }
  return hunks
}

/** Rebuild the raw unified-diff text of a hunk for the revert IPC. */
export function rebuildHunkText(hunk: DiffHunk): string {
  const body = hunk.lines.map((line) => {
    if (line.kind === 'added') return `+${line.text}`
    if (line.kind === 'removed') return `-${line.text}`
    if (line.kind === 'meta') return line.text
    return ` ${line.text}`
  })
  return [hunk.header, ...body].join('\n')
}

export function mergeDiffFiles(
  summaries: readonly GitFileSummary[],
  parsed: readonly ParsedFileDiff[],
): ReadonlyArray<GitFileSummary & { readonly diff: ParsedFileDiff | null }> {
  const byPath = new Map(parsed.map((file) => [file.path, file]))
  return summaries.map((summary) => ({ ...summary, diff: byPath.get(summary.relativePath) ?? null }))
}
