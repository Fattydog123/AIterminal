import assert from 'node:assert/strict'
import test from 'node:test'

import { groupDiffHunks, mergeDiffFiles, parseUnifiedDiff, rebuildHunkText } from '../../src/renderer/src/change-review/change-review.ts'

const patch = `diff --git a/src/old.ts b/src/old.ts
index 1111111..2222222 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -2,3 +2,4 @@
 context
-before
+after
+added
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+first
+second`

test('change review parses file boundaries, hunks, and line numbers from unified diff', () => {
  const files = parseUnifiedDiff(patch)

  assert.deepEqual(files.map((file) => file.path), ['src/old.ts', 'src/new.ts'])
  const oldLines = files[0]?.lines ?? []
  assert.deepEqual(
    oldLines.filter((line) => line.kind === 'context' || line.kind === 'removed' || line.kind === 'added')
      .map((line) => [line.kind, line.oldLine, line.newLine, line.text]),
    [
      ['context', 2, 2, 'context'],
      ['removed', 3, null, 'before'],
      ['added', null, 3, 'after'],
      ['added', null, 4, 'added'],
    ],
  )
  assert.deepEqual(
    files[1]?.lines.filter((line) => line.kind === 'added').map((line) => [line.newLine, line.text]),
    [[1, 'first'], [2, 'second']],
  )
})

test('hunks group per header with counts and rebuild to raw unified-diff text', () => {
  const files = parseUnifiedDiff(patch)
  const hunks = groupDiffHunks(files[0]!)
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0]?.header, '@@ -2,3 +2,4 @@')
  assert.equal(hunks[0]?.additions, 2)
  assert.equal(hunks[0]?.deletions, 1)
  assert.equal(
    rebuildHunkText(hunks[0]!),
    ['@@ -2,3 +2,4 @@', ' context', '-before', '+after', '+added'].join('\n'),
  )
})

test('no-newline markers stay meta lines and survive hunk rebuild verbatim', () => {
  const marked = [
    'diff --git a/x.txt b/x.txt',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,1 +1,1 @@',
    '-OLD',
    '+NEW',
    '\\ No newline at end of file',
  ].join('\n')
  const files = parseUnifiedDiff(marked)
  const metaTail = files[0]?.lines.at(-1)
  assert.equal(metaTail?.kind, 'meta')
  assert.equal(metaTail?.oldLine, null)
  const hunk = groupDiffHunks(files[0]!)[0]!
  assert.ok(rebuildHunkText(hunk).endsWith('\\ No newline at end of file'))
})

test('change review preserves Git summary order and attaches matching patches', () => {
  const merged = mergeDiffFiles([
    { relativePath: 'src/new.ts', additions: 2, deletions: 0, status: 'added' },
    { relativePath: 'README.md', additions: 0, deletions: 0, status: 'untracked' },
    { relativePath: 'src/old.ts', additions: 2, deletions: 1, status: 'modified' },
  ], parseUnifiedDiff(patch))

  assert.deepEqual(merged.map((file) => file.relativePath), ['src/new.ts', 'README.md', 'src/old.ts'])
  assert.equal(merged[0]?.diff?.path, 'src/new.ts')
  assert.equal(merged[1]?.diff, null)
  assert.equal(merged[2]?.diff?.path, 'src/old.ts')
})
