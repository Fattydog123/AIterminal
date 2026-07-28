export type DispatchCertainty = 'not_sent' | 'dispatching' | 'sent' | 'billing_unknown' | 'completed'
export type RemoteRequestOutcome = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export interface RemoteRequestState {
  readonly dispatch: DispatchCertainty
  readonly outcome: RemoteRequestOutcome
  readonly requestId?: string
  readonly errorCode?: string
}

export type RemoteRequestEvent =
  | { readonly type: 'dispatch-started' }
  | { readonly type: 'request-sent'; readonly requestId: string }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly errorCode: string }
  | { readonly type: 'cancelled' }

export const initialRemoteRequestState = (): RemoteRequestState => ({
  dispatch: 'not_sent',
  outcome: 'pending',
})

const terminal = (state: RemoteRequestState): boolean => state.outcome !== 'pending'

/**
 * Pure state machine used at the provider boundary. `request-sent` must only be
 * emitted after bytes have been committed to the transport. Any later failure
 * becomes billing-unknown and is never considered safe for an automatic retry.
 */
export const reduceRemoteRequestState = (
  state: RemoteRequestState,
  event: RemoteRequestEvent,
): RemoteRequestState => {
  if (terminal(state)) throw new Error('远程请求已结束，不能再次变更状态')
  switch (event.type) {
    case 'dispatch-started':
      if (state.dispatch !== 'not_sent') throw new Error('远程请求已经开始派发')
      return { ...state, dispatch: 'dispatching' }
    case 'request-sent':
      if (state.dispatch !== 'dispatching') throw new Error('请求只能在派发阶段标记为已发送')
      if (!event.requestId.trim()) throw new Error('已发送请求必须包含 requestId')
      return { ...state, dispatch: 'sent', requestId: event.requestId }
    case 'succeeded':
      if (state.dispatch !== 'sent') throw new Error('未发送的远程请求不能成功')
      return { ...state, dispatch: 'completed', outcome: 'succeeded' }
    case 'failed':
      if (!event.errorCode.trim()) throw new Error('失败事件必须包含错误码')
      if (state.dispatch === 'sent') {
        return { ...state, dispatch: 'billing_unknown', outcome: 'failed', errorCode: event.errorCode }
      }
      return { ...state, dispatch: 'not_sent', outcome: 'failed', errorCode: event.errorCode }
    case 'cancelled':
      if (state.dispatch === 'sent') return { ...state, dispatch: 'billing_unknown', outcome: 'cancelled' }
      return { ...state, dispatch: 'not_sent', outcome: 'cancelled' }
  }
}

export const mayAutomaticallyRetry = (state: RemoteRequestState): boolean =>
  state.outcome === 'failed' && state.dispatch === 'not_sent'

export const billingMayHaveOccurred = (state: RemoteRequestState): boolean =>
  state.dispatch === 'sent' || state.dispatch === 'completed' || state.dispatch === 'billing_unknown'

