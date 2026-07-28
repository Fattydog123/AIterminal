import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeWorkspaceLayout, resizeFromKeyboard } from '../../src/renderer/src/ui/use-workspace-layout.ts'

test('workspace separators resize in their visual direction from the keyboard', () => {
  let prevented = false
  let nextSize = 0
  resizeFromKeyboard({
    event: { key: 'ArrowRight', shiftKey: false, preventDefault: () => { prevented = true } },
    axis: 'horizontal',
    currentSize: 260,
    onResize: (value) => { nextSize = value },
  })
  assert.equal(prevented, true)
  assert.equal(nextSize, 268)

  resizeFromKeyboard({
    event: { key: 'ArrowLeft', shiftKey: true, preventDefault() {} },
    axis: 'horizontal',
    currentSize: 326,
    direction: -1,
    onResize: (value) => { nextSize = value },
  })
  assert.equal(nextSize, 358)
})

test('workspace separators ignore unrelated keys', () => {
  let calls = 0
  resizeFromKeyboard({
    event: { key: 'Enter', shiftKey: false, preventDefault() { throw new Error('must not prevent') } },
    axis: 'vertical',
    currentSize: 260,
    onResize: () => { calls += 1 },
  })
  assert.equal(calls, 0)
})

test('vertical separators map ArrowUp/ArrowDown with direction -1 for bottom docks', () => {
  let nextSize = 0
  resizeFromKeyboard({
    event: { key: 'ArrowUp', shiftKey: false, preventDefault() {} },
    axis: 'vertical',
    currentSize: 200,
    direction: -1,
    onResize: (value) => { nextSize = value },
  })
  assert.equal(nextSize, 208)
})

test('layout normalization clamps every pane and fills defaults', () => {
  const defaults = normalizeWorkspaceLayout({})
  assert.deepEqual(defaults, {
    sidebarWidth: 260,
    inspectorWidth: 326,
    dockHeight: 260,
    studioDockHeight: 122,
    focusMode: false,
  })
  const clamped = normalizeWorkspaceLayout({
    sidebarWidth: 9999,
    inspectorWidth: 1,
    dockHeight: -50,
    studioDockHeight: 9999,
    focusMode: true,
  })
  assert.deepEqual(clamped, {
    sidebarWidth: 380,
    inspectorWidth: 280,
    dockHeight: 168,
    studioDockHeight: 420,
    focusMode: true,
  })
})

test('studio dock default first-paints inside the pinned 100-140px band', () => {
  const layout = normalizeWorkspaceLayout({})
  assert.ok(layout.studioDockHeight >= 100 && layout.studioDockHeight <= 140)
})
