import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
)

const visualTokens = source('../../src/renderer/src/studio/renderer/visual-tokens.css')
const studioStyles = source('../../src/renderer/src/studio/renderer/styles.css')
const studioTheme = source('../../src/renderer/src/studio/renderer/ai-terminal-theme.css')
const workspace = source('../../src/renderer/src/studio/StudioWorkspace.tsx')

test('Studio has one visual-token owner and injects it before reset and feature styles', () => {
  const owners = [
    ['visual-tokens.css', visualTokens],
    ['styles.css', studioStyles],
    ['ai-terminal-theme.css', studioTheme],
  ].filter(([, css]) => /^:root\s*\{/mu.test(css))

  assert.deepEqual(owners.map(([name]) => name), ['visual-tokens.css'])

  const tokenIndex = workspace.indexOf("${studioVisualTokens.replace(':root {', ':host {')}")
  const resetIndex = workspace.indexOf('${studioStyles}')
  const themeIndex = workspace.indexOf('${studioThemeStyles}')
  assert.ok(tokenIndex >= 0, 'StudioWorkspace must project visual tokens onto the Shadow host')
  assert.ok(tokenIndex < resetIndex, 'visual tokens must load before the Studio reset')
  assert.ok(resetIndex < themeIndex, 'the native/theme adapter must load last')
})

test('Studio listboxes and native fallbacks consume semantic dark-surface tokens', () => {
  for (const token of [
    '--studio-control-surface',
    '--studio-popover-surface',
    '--studio-listbox-surface',
    '--studio-native-option-surface',
  ]) {
    assert.match(visualTokens, new RegExp(`${token}\\s*:`, 'u'))
  }

  assert.match(
    studioTheme,
    /\.studio-select-listbox\s*\{[^}]*background:\s*var\(--studio-listbox-surface\)/su,
  )
  assert.match(
    studioTheme,
    /\.studio-select-listbox:popover-open\s*\{[^}]*color-scheme:\s*dark/su,
  )
  assert.match(
    studioStyles,
    /option,\s*\noptgroup\s*\{[^}]*background-color:\s*var\(--studio-native-option-surface\)/su,
  )
})
