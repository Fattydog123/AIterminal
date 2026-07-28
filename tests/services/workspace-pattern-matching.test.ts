import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_IGNORED_TRAVERSAL_DIRECTORY_NAMES,
  PatternCompileError,
  compileGlobPattern,
  compileSearchPattern
} from '../../src/main/services/workspace-pattern-matching.ts'

test('search patterns match literals, classes, quantifiers, and alternation', () => {
  const literal = compileSearchPattern('token', true)
  assert.deepEqual(literal.findMatch('a token here', 0), { start: 2, end: 7 })
  assert.equal(literal.findMatch('nothing', 0), null)

  const classes = compileSearchPattern('[a-c]x[0-9]', true)
  assert.deepEqual(classes.findMatch('zzbx7zz', 0), { start: 2, end: 5 })
  assert.equal(classes.findMatch('dx7', 0), null)

  const negated = compileSearchPattern('[^0-9]+', true)
  assert.deepEqual(negated.findMatch('12abc34', 0), { start: 2, end: 5 })

  const quantified = compileSearchPattern('ab{2,3}c', true)
  assert.deepEqual(quantified.findMatch('abbc', 0), { start: 0, end: 4 })
  assert.deepEqual(quantified.findMatch('abbbc', 0), { start: 0, end: 5 })
  assert.equal(quantified.findMatch('abc', 0), null)
  assert.equal(quantified.findMatch('abbbbc', 0), null)

  const alternation = compileSearchPattern('(foo|bar)baz', true)
  assert.deepEqual(alternation.findMatch('xxbarbazxx', 0), { start: 2, end: 8 })

  const nonCapturing = compileSearchPattern('(?:ab)+', true)
  assert.deepEqual(nonCapturing.findMatch('zababz', 0), { start: 1, end: 5 })

  const escapes = compileSearchPattern('\\d{3}-\\w+', true)
  assert.deepEqual(escapes.findMatch('call 555-abc now', 0), { start: 5, end: 12 })

  const hex = compileSearchPattern('\\x41\\u0042', true)
  assert.deepEqual(hex.findMatch('zzABzz', 0), { start: 2, end: 4 })
})

test('search patterns honor anchors, word boundaries, and case folding', () => {
  const anchored = compileSearchPattern('^import', true)
  assert.deepEqual(anchored.findMatch('import x', 0), { start: 0, end: 6 })
  assert.equal(anchored.findMatch(' import x', 0), null)

  const tail = compileSearchPattern(';$', true)
  assert.deepEqual(tail.findMatch('done();', 0), { start: 6, end: 7 })
  assert.equal(tail.findMatch('done(); ', 0), null)

  const word = compileSearchPattern('\\bfor\\b', true)
  assert.deepEqual(word.findMatch('a for loop', 0), { start: 2, end: 5 })
  assert.equal(word.findMatch('before it', 0), null)

  const folded = compileSearchPattern('Error[A-Z]ode', false)
  assert.deepEqual(folded.findMatch('an errorcode here', 0), { start: 3, end: 12 })
  const sensitive = compileSearchPattern('Error', true)
  assert.equal(sensitive.findMatch('error', 0), null)
})

test('search matching is leftmost, extends to the longest end, and resumes from an index', () => {
  const pattern = compileSearchPattern('fo+', true)
  assert.deepEqual(pattern.findMatch('xfooofy', 0), { start: 1, end: 5 })
  assert.deepEqual(pattern.findMatch('xfooofoy', 5), { start: 5, end: 7 })

  const preferLeft = compileSearchPattern('foo|f', true)
  assert.deepEqual(preferLeft.findMatch('xfoo', 0), { start: 1, end: 4 })

  const zeroWidth = compileSearchPattern('a*', true)
  assert.deepEqual(zeroWidth.findMatch('xyz', 0), { start: 0, end: 0 })
  assert.deepEqual(zeroWidth.findMatch('xaaz', 1), { start: 1, end: 3 })
})

test('catastrophic backtracking shapes stay linear in the NFA engine', () => {
  const subject = 'a'.repeat(4_000)
  const shapes = ['(a|a)+b', '(a+)+b', '(a?){32}b', '(ab?)*c']
  for (const shape of shapes) {
    const pattern = compileSearchPattern(shape, true)
    const startedAt = process.hrtime.bigint()
    assert.equal(pattern.findMatch(subject, 0), null)
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    assert.ok(elapsedMs < 1_000, `pattern ${shape} took ${elapsedMs}ms`)
  }
})

test('unsupported or malformed search patterns are rejected at compile time', () => {
  const rejected = [
    '',
    'a'.repeat(513),
    '(a)\\1',
    '(?=a)b',
    '(?<name>a)',
    '(a',
    'a)',
    '[z-a]',
    '[]',
    'a{65}',
    'a{3,2}',
    'a{2',
    'a**',
    '*a',
    'a\\',
    '\\q',
    '\\u12',
    'a{64}'.repeat(40)
  ]
  for (const pattern of rejected) {
    assert.throws(
      () => compileSearchPattern(pattern, true),
      (error: unknown) => error instanceof PatternCompileError,
      `pattern ${JSON.stringify(pattern)} should be rejected`
    )
  }
})

test('glob patterns match segments, wildcards, classes, and braces', () => {
  const anyDepth = compileGlobPattern('*.ts')
  assert.equal(anyDepth.matchesPath('app.ts'), true)
  assert.equal(anyDepth.matchesPath('src/main/deep/app.ts'), true)
  assert.equal(anyDepth.matchesPath('src/app.tsx'), false)

  const nested = compileGlobPattern('src/**/*.test.ts')
  assert.equal(nested.matchesPath('src/a/b/c.test.ts'), true)
  assert.equal(nested.matchesPath('src/c.test.ts'), true)
  assert.equal(nested.matchesPath('tests/c.test.ts'), false)

  const single = compileGlobPattern('file.?s')
  assert.equal(single.matchesPath('file.ts'), true)
  assert.equal(single.matchesPath('file.tts'), false)

  const classes = compileGlobPattern('lib/[ab]-[0-9].js')
  assert.equal(classes.matchesPath('lib/a-7.js'), true)
  assert.equal(classes.matchesPath('lib/c-7.js'), false)

  const negatedClass = compileGlobPattern('[!.]*.md')
  assert.equal(negatedClass.matchesPath('docs/readme.md'), true)
  assert.equal(negatedClass.matchesPath('docs/.hidden.md'), false)

  const braces = compileGlobPattern('src/{main,renderer}/**/*.ts')
  assert.equal(braces.matchesPath('src/main/services/a.ts'), true)
  assert.equal(braces.matchesPath('src/renderer/b.ts'), true)
  assert.equal(braces.matchesPath('src/shared/c.ts'), false)

  const nestedBraces = compileGlobPattern('{a,{b,c}}.txt')
  assert.equal(nestedBraces.matchesPath('x/b.txt'), true)
  assert.equal(nestedBraces.matchesPath('x/d.txt'), false)

  const tree = compileGlobPattern('docs/**')
  assert.equal(tree.matchesPath('docs/guide/setup.md'), true)
  assert.equal(tree.matchesPath('src/guide.md'), false)
})

test('glob matching folds case and accepts Windows separators', () => {
  const pattern = compileGlobPattern('src/*.TS')
  assert.equal(pattern.matchesPath('SRC/App.ts'), true)
  assert.equal(pattern.matchesPath('src\\app.ts'), true)
})

test('malformed glob patterns are rejected at compile time', () => {
  const rejected = [
    '',
    'a'.repeat(513),
    '/rooted.ts',
    'a//b.ts',
    '../escape.ts',
    './../escape.ts',
    'src/./a.ts',
    '{a,b',
    'src/[ab.ts',
    'src/' + 'a/'.repeat(70) + 'b.ts',
    '{a,b,c}'.repeat(4) + '.ts'
  ]
  for (const pattern of rejected) {
    assert.throws(
      () => compileGlobPattern(pattern),
      (error: unknown) => error instanceof PatternCompileError,
      `pattern ${JSON.stringify(pattern)} should be rejected`
    )
  }
})

test('the default ignored traversal set covers dependency and build directories', () => {
  for (const name of ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', '__pycache__', 'target']) {
    assert.equal(DEFAULT_IGNORED_TRAVERSAL_DIRECTORY_NAMES.has(name), true)
  }
  assert.equal(DEFAULT_IGNORED_TRAVERSAL_DIRECTORY_NAMES.has('src'), false)
})
