import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCommandRows,
  pushRecentCommand,
  scoreCommandMatch,
} from '../../src/renderer/src/ui/command-search.ts'

const entry = (id: string, label: string, section = '视图', extra: Partial<{ detail: string; keywords: string; disabled: boolean }> = {}) => ({
  id,
  label,
  detail: extra.detail ?? '',
  section,
  ...(extra.keywords === undefined ? {} : { keywords: extra.keywords }),
  ...(extra.disabled === undefined ? {} : { disabled: extra.disabled }),
})

test('label prefix outranks substring and subsequence matches', () => {
  const prefix = scoreCommandMatch(entry('a', '打开任务中心'), '打开')
  const substring = scoreCommandMatch(entry('b', '重新打开会话'), '打开')
  const subsequence = scoreCommandMatch(entry('c', '打断当前流程并展开'), '打开')
  assert.ok(prefix > substring, 'prefix must outrank substring')
  assert.ok(substring > subsequence, 'substring must outrank subsequence')
  assert.ok(subsequence > 0, 'subsequence still matches')
})

test('keyword-only matches surface items whose label misses the query', () => {
  const item = entry('studio', '转到 Studio', '导航', { keywords: '画布 生图 图片' })
  assert.ok(scoreCommandMatch(item, '画布') > 0)
  assert.equal(scoreCommandMatch(entry('x', '打开设置'), 'zzz'), 0)
})

test('empty query groups by section and floats recents first', () => {
  const items = [
    entry('one', '新建 Agent', '开始'),
    entry('two', '打开设置', '导航'),
    entry('three', '打开任务中心', '视图'),
  ]
  const { rows, flat } = buildCommandRows(items, '', ['three', 'missing', 'one'])
  assert.equal(rows[0]?.kind, 'section')
  assert.equal((rows[0] as { title: string }).title, '最近使用')
  assert.deepEqual(flat.slice(0, 2).map((item) => item.id), ['three', 'one'])
  const sectionTitles = rows.filter((row) => row.kind === 'section').map((row) => (row as { title: string }).title)
  assert.deepEqual(sectionTitles, ['最近使用', '开始', '导航', '视图'])
})

test('disabled items never appear in the recents group', () => {
  const items = [entry('one', '运行工作流', 'Studio', { disabled: true })]
  const { rows } = buildCommandRows(items, '', ['one'])
  assert.equal((rows[0] as { title: string }).title, 'Studio')
})

test('query flattens results into a single ranked group', () => {
  const items = [
    entry('sub', '打断当前流程并展开', '其他'),
    entry('pre', '打开任务中心', '视图'),
  ]
  const { rows, flat } = buildCommandRows(items, '打开', [])
  assert.equal((rows[0] as { title: string }).title, '匹配结果')
  assert.deepEqual(flat.map((item) => item.id), ['pre', 'sub'])
})

test('recents list deduplicates, prepends, and caps at the limit', () => {
  let recents: readonly string[] = []
  for (let index = 0; index < 12; index += 1) recents = pushRecentCommand(recents, `id-${index}`)
  assert.equal(recents.length, 8)
  assert.equal(recents[0], 'id-11')
  recents = pushRecentCommand(recents, 'id-9')
  assert.equal(recents[0], 'id-9')
  assert.equal(recents.filter((id) => id === 'id-9').length, 1)
})
