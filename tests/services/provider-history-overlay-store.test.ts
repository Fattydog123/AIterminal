import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProviderHistoryOverlayError,
  ProviderHistoryOverlayStore,
} from '../../src/main/services/provider-history-overlay-store.ts'

const codexTask = 'codex:0f5a9c3e-8f2b-4a6d-9c1e-2b7d4e6f8a01'
const claudeTask = `claude:source_${'a'.repeat(43)}`

test('hide and archive persist across store instances without touching provider ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overlay-'))
  const filePath = join(directory, 'overlay.json')
  try {
    const store = new ProviderHistoryOverlayStore(filePath, () => 1_753_500_000_000)
    assert.equal(await store.isHidden(codexTask), false)

    await store.hide(codexTask)
    const archivedAt = await store.setArchived(claudeTask, true)
    assert.ok(archivedAt)

    // A fresh instance reads the same file: state survives restart.
    const reloaded = new ProviderHistoryOverlayStore(filePath)
    assert.equal(await reloaded.isHidden(codexTask), true)
    assert.equal(await reloaded.archivedAt(claudeTask), archivedAt)
    assert.equal(await reloaded.isHidden(claudeTask), false)

    // Unarchiving clears the overlay mark.
    await reloaded.setArchived(claudeTask, false)
    assert.equal(await reloaded.archivedAt(claudeTask), null)

    // Only UI marks live in the file — no message content, no paths.
    const raw = await readFile(filePath, 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['archived', 'hidden', 'version'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects non-provider task ids and survives a corrupt overlay file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'overlay-'))
  const filePath = join(directory, 'overlay.json')
  try {
    const store = new ProviderHistoryOverlayStore(filePath)
    await assert.rejects(store.hide('task:0f5a9c3e-8f2b-4a6d-9c1e-2b7d4e6f8a01'), ProviderHistoryOverlayError)
    await assert.rejects(store.setArchived('../escape', true), ProviderHistoryOverlayError)

    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, '{not json', 'utf8')
    const corrupted = new ProviderHistoryOverlayStore(filePath)
    assert.equal(await corrupted.isHidden(codexTask), false)
    await corrupted.hide(codexTask)
    assert.equal(await corrupted.isHidden(codexTask), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
