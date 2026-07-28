/**
 * Pure reverse-application of a unified-diff hunk onto current file content.
 * The hunk's NEW side must match the file exactly (strict context check) —
 * any drift refuses to apply instead of corrupting the file.
 */

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

export type ReverseHunkResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: 'invalid_hunk' | 'mismatch' }

export function reverseApplyHunk(content: string, hunkText: string): ReverseHunkResult {
  const lines = hunkText.split('\n')
  const headerLine = lines[0] ?? ''
  const header = HUNK_HEADER_PATTERN.exec(headerLine)
  if (!header) return { ok: false, reason: 'invalid_hunk' }
  const newStart = Number(header[3])
  const declaredNewCount = header[4] === undefined ? 1 : Number(header[4])

  const oldSide: string[] = []
  const newSide: string[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith(' ')) {
      oldSide.push(line.slice(1))
      newSide.push(line.slice(1))
    } else if (line.startsWith('-')) {
      oldSide.push(line.slice(1))
    } else if (line.startsWith('+')) {
      newSide.push(line.slice(1))
    } else if (line === '') {
      // A trailing empty segment from the final newline split; ignore.
      continue
    } else {
      return { ok: false, reason: 'invalid_hunk' }
    }
  }
  if (newSide.length !== declaredNewCount) return { ok: false, reason: 'invalid_hunk' }

  const fileLines = content.split('\n')
  // Git records zero-length ranges against the line BEFORE the hunk, so an
  // empty new side inserts after that line instead of replacing it.
  const startIndex = declaredNewCount === 0 ? newStart : Math.max(0, newStart - 1)
  const current = fileLines.slice(startIndex, startIndex + newSide.length)
  if (current.length !== newSide.length || current.some((line, index) => line !== newSide[index])) {
    return { ok: false, reason: 'mismatch' }
  }

  const next = [
    ...fileLines.slice(0, startIndex),
    ...oldSide,
    ...fileLines.slice(startIndex + newSide.length),
  ]
  return { ok: true, content: next.join('\n') }
}
