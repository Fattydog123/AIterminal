import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizePermission,
  resolvePermissionPreference,
  writePermissionPreference,
  type PermissionPreferenceStorage
} from '../../src/renderer/src/permission-preferences.ts'

class MemoryStorage implements PermissionPreferenceStorage {
  #value: string | null

  constructor(value: string | null = null) {
    this.#value = value
  }

  getItem(_key: string): string | null {
    return this.#value
  }

  setItem(_key: string, value: string): void {
    this.#value = value
  }

  value(): string | null {
    return this.#value
  }
}

test('persisted System Full Access survives a bootstrap default of request', () => {
  const storage = new MemoryStorage('full')
  assert.equal(resolvePermissionPreference('request', storage), 'full')
})

test('permission preference writes valid values and rejects corrupt storage', () => {
  const storage = new MemoryStorage('not-a-permission')
  assert.equal(resolvePermissionPreference('auto', storage), 'auto')
  assert.equal(resolvePermissionPreference('full', new MemoryStorage()), 'full')
  assert.equal(normalizePermission('full'), 'full')
  assert.equal(normalizePermission('unknown'), null)
  writePermissionPreference('full', storage)
  assert.equal(storage.value(), 'full')
})
