import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const studioRendererRoot = fileURLToPath(
  new URL('../../src/renderer/src/studio/', import.meta.url),
)

const tsxFiles = (directory: string): readonly string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })

const nativeSelectLines = (source: string): readonly number[] => source
  .split(/\r?\n/u)
  .flatMap((line, index) => /<\s*select(?:\s|>)/iu.test(line) ? [index + 1] : [])

test('native Studio select detector catches the Windows white-menu control', () => {
  assert.deepEqual(nativeSelectLines('<label>Quality\n<select value="high">\n</select></label>'), [2])
})

test('Studio renderer uses themed listboxes instead of native select controls', () => {
  const violations = tsxFiles(studioRendererRoot).flatMap((path) => nativeSelectLines(readFileSync(path, 'utf8'))
    .map((line) => `${relative(studioRendererRoot, path)}:${line}`))

  assert.deepEqual(
    violations,
    [],
    `Native <select> opens a system-owned white menu on Windows; use StudioSelect instead:\n${violations.join('\n')}`,
  )
})
