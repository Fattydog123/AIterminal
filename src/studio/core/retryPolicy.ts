import type { RunDispatchState } from '../shared/types.js'

export interface RetryPolicyInput {
  readonly attempt: number
  readonly dispatchState: RunDispatchState
  readonly errorCode: string
}

export type RetryDecision =
  | { readonly mode: 'automatic'; readonly delayMs: number; readonly billingRisk: false; readonly reason: string }
  | { readonly mode: 'manual-confirmation'; readonly billingRisk: true; readonly reason: string }
  | { readonly mode: 'none'; readonly billingRisk: false; readonly reason: string }

const transientBeforeDispatch = new Set([
  'network-connect-failed',
  'provider-unreachable',
  'proxy-connect-failed',
  'dns-failed',
  'run-queue-failed',
])

const deterministicPrefixes = [
  'workflow-',
  'invalid-',
  'provider-operation-',
  'generation-reference-',
  'missing-',
  'comfy-prompt-',
]

export const retryDecision = (input: RetryPolicyInput): RetryDecision => {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    return { mode: 'none', billingRisk: false, reason: '重试次数无效' }
  }
  if (input.dispatchState !== 'not_sent') {
    return {
      mode: 'manual-confirmation',
      billingRisk: true,
      reason: input.dispatchState === 'billing_unknown'
        ? '无法确认远程请求是否完成或计费；禁止自动重试'
        : '请求已经发送；再次运行可能重复生成或计费，需要人工确认',
    }
  }
  if (deterministicPrefixes.some((prefix) => input.errorCode.startsWith(prefix))) {
    return { mode: 'none', billingRisk: false, reason: '这是可修复的配置或工作流错误，重试不会改变结果' }
  }
  if (!transientBeforeDispatch.has(input.errorCode)) {
    return { mode: 'none', billingRisk: false, reason: '错误未被证明可安全自动重试' }
  }
  if (input.attempt >= 2) {
    return { mode: 'none', billingRisk: false, reason: '已达到本地安全重试上限' }
  }
  return {
    mode: 'automatic',
    delayMs: Math.min(8_000, 1_000 * (2 ** input.attempt)),
    billingRisk: false,
    reason: '请求明确尚未发送，将在本地退避后重试',
  }
}
