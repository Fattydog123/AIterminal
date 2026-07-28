import assert from 'node:assert/strict'
import test from 'node:test'

import { reverseApplyHunk } from '../../src/main/services/git-hunks.ts'

test('reverses an addition hunk back to the original content', () => {
  const content = ['alpha', 'added-line', 'beta', 'gamma'].join('\n')
  const hunk = ['@@ -1,3 +1,4 @@', ' alpha', '+added-line', ' beta', ' gamma'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.ok(result.ok)
  assert.equal(result.content, ['alpha', 'beta', 'gamma'].join('\n'))
})

test('reverses a removal hunk by restoring the removed lines', () => {
  const content = ['alpha', 'gamma'].join('\n')
  const hunk = ['@@ -1,3 +1,2 @@', ' alpha', '-removed-line', ' gamma'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.ok(result.ok)
  assert.equal(result.content, ['alpha', 'removed-line', 'gamma'].join('\n'))
})

test('reverses a mixed modification hunk', () => {
  const content = ['head', 'new-1', 'new-2', 'tail'].join('\n')
  const hunk = ['@@ -1,4 +1,4 @@', ' head', '-old-1', '-old-2', '+new-1', '+new-2', ' tail'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.ok(result.ok)
  assert.equal(result.content, ['head', 'old-1', 'old-2', 'tail'].join('\n'))
})

test('refuses when the file has drifted from the hunk context', () => {
  const content = ['alpha', 'CHANGED', 'beta', 'gamma'].join('\n')
  const hunk = ['@@ -1,3 +1,4 @@', ' alpha', '+added-line', ' beta', ' gamma'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.deepEqual(result, { ok: false, reason: 'mismatch' })
})

test('refuses malformed hunks and stray line prefixes', () => {
  assert.deepEqual(reverseApplyHunk('x', 'not a hunk'), { ok: false, reason: 'invalid_hunk' })
  assert.deepEqual(
    reverseApplyHunk('x', ['@@ -1,1 +1,1 @@', '*weird'].join('\n')),
    { ok: false, reason: 'invalid_hunk' },
  )
  assert.deepEqual(
    reverseApplyHunk('x', ['@@ -1,1 +1,3 @@', ' x'].join('\n')),
    { ok: false, reason: 'invalid_hunk' },
  )
})

test('handles hunks that touch the middle of a file with offsets', () => {
  const content = ['l1', 'l2', 'l3', 'inserted', 'l4', 'l5'].join('\n')
  const hunk = ['@@ -2,3 +2,4 @@', ' l2', ' l3', '+inserted', ' l4'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.ok(result.ok)
  assert.equal(result.content, ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n'))
})

test('anchors zero-length new ranges after the recorded line', () => {
  const content = ['l1', 'l2'].join('\n')
  const hunk = ['@@ -2,2 +1,0 @@', '-dropped-a', '-dropped-b'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.ok(result.ok)
  assert.equal(result.content, ['l1', 'dropped-a', 'dropped-b', 'l2'].join('\n'))
})

test('ignores no-newline markers inside the hunk body', () => {
  const content = ['alpha', 'omega'].join('\n')
  const hunk = ['@@ -1,2 +1,2 @@', ' alpha', '-OMEGA', '+omega', '\\ No newline at end of file'].join('\n')
  const result = reverseApplyHunk(content, hunk)
  assert.ok(result.ok)
  assert.equal(result.content, ['alpha', 'OMEGA'].join('\n'))
})
