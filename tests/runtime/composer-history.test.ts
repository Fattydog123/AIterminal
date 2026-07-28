import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginComposerHistorySession,
  loadComposerHistory,
  recordComposerHistory,
  stepComposerHistory,
} from '../../src/renderer/src/composer/composer-history.ts'

// Node has no localStorage, so the module exercises its in-memory fallback;
// the storage layer itself is a best-effort mirror of the same array.

function clearHistory(): void {
  // Records are capped, so flooding with unique fillers evicts prior entries;
  // afterwards the known state is exactly the fillers we still see.
  for (let index = 0; index < 50; index += 1) {
    recordComposerHistory(`__filler_${index}__`)
  }
}

test('history records submissions newest-last, dedupes repeats, and caps length', () => {
  clearHistory()
  recordComposerHistory('first prompt')
  recordComposerHistory('second prompt')
  recordComposerHistory('first prompt')

  const entries = loadComposerHistory()
  assert.equal(entries.length, 50)
  assert.deepEqual(entries.slice(-2), ['second prompt', 'first prompt'])
  assert.equal(entries.filter((entry) => entry === 'first prompt').length, 1)

  recordComposerHistory('   ')
  assert.deepEqual(loadComposerHistory().at(-1), 'first prompt')
})

test('history sessions walk older entries and restore the stashed draft', () => {
  clearHistory()
  recordComposerHistory('older entry')
  recordComposerHistory('newest entry')

  const session = beginComposerHistorySession('my unsent draft')
  assert.ok(session)

  const first = stepComposerHistory(session!, 'older')
  assert.deepEqual(first, { draft: 'newest entry', done: false })
  const second = stepComposerHistory(session!, 'older')
  assert.deepEqual(second, { draft: 'older entry', done: false })

  stepComposerHistory(session!, 'newer')
  const restored = stepComposerHistory(session!, 'newer')
  assert.deepEqual(restored, { draft: 'my unsent draft', done: true })
})

test('stepping past the oldest entry stays put', () => {
  clearHistory()
  recordComposerHistory('only entry')
  const session = beginComposerHistorySession('')
  assert.ok(session)
  assert.equal(stepComposerHistory(session!, 'older')?.draft, 'only entry')
  let steps = 0
  while (stepComposerHistory(session!, 'older') !== null && steps < 60) steps += 1
  assert.ok(steps < 60)
  assert.equal(session!.recalled, '__filler_1__')
})
