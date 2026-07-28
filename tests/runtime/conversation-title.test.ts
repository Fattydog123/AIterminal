import assert from 'node:assert/strict'
import test from 'node:test'

import { conversationTitleFromText } from '../../src/shared/conversation-title.ts'

test('conversation titles remove internal command blocks without changing the visible request', () => {
  assert.equal(
    conversationTitleFromText(
      '<command-name>/effort</command-name>\n<command-message>xhigh</command-message>\n修复 Gemini 分组刷新',
      '新 Agent 任务',
    ),
    '修复 Gemini 分组刷新',
  )
})

test('conversation titles replace command-only and generated slug rows with a user-facing fallback', () => {
  assert.equal(conversationTitleFromText('/effort ultra', '新 Agent 任务'), '新 Agent 任务')
  assert.equal(
    conversationTitleFromText('delegate-tasks-a-work-item-in-the-background', '新 Agent 任务'),
    '新 Agent 任务',
  )
})

test('conversation titles stay single-line and use a compact ellipsis', () => {
  assert.equal(conversationTitleFromText('第一行\n第二行', '新 Chat'), '第一行 第二行')
  assert.equal(conversationTitleFromText('1234567890', '新 Chat', 6), '12345…')
})
