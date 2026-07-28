import assert from 'node:assert/strict'
import test from 'node:test'

import { StudioError } from '../../src/main/studio/errors.ts'
import { actionableImageGenerationError } from '../../src/main/studio/image-generation-errors.ts'

test('empty image responses recommend the balanced sibling without retrying or changing selection', () => {
  const transportCause = new TypeError('fetch failed', {
    cause: Object.assign(new Error('net::ERR_EMPTY_RESPONSE'), { code: 'ERR_EMPTY_RESPONSE' }),
  })
  const original = new StudioError(
    'provider-network-error',
    '接口连接中断',
    'billing_unknown',
    transportCause,
  )

  const result = actionableImageGenerationError(
    original,
    'gpt-image-2-high',
    ['gpt-image-2-high', 'gpt-image-2-2k', 'gpt-image-2-4k'],
  )

  assert.ok(result instanceof StudioError)
  assert.notEqual(result, original)
  assert.equal(result.code, 'provider-image-response-interrupted')
  assert.equal(result.dispatchState, 'billing_unknown')
  assert.match(result.message, /gpt-image-2-2k/u)
  assert.doesNotMatch(result.message, /ERR_EMPTY_RESPONSE|fetch failed/u)
  assert.equal(result.cause, original)
})

test('unrelated image transport failures retain their original classification', () => {
  const original = new StudioError(
    'provider-network-error',
    '接口连接中断',
    'billing_unknown',
    new Error('net::ERR_INTERNET_DISCONNECTED'),
  )

  assert.equal(
    actionableImageGenerationError(original, 'gpt-image-2-high', ['gpt-image-2-2k']),
    original,
  )
})

