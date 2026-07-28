import { StudioError } from './errors.ts'

const EMPTY_RESPONSE = /(?:^|[^a-z])(?:net::)?err_empty_response(?:$|[^a-z])|empty[ _-]?response/iu
const IMAGE_NETWORK_CODES = new Set(['provider-network-error', 'response-read-failed'])
const PREFERRED_BALANCED_MODEL = 'gpt-image-2-2k'

const containsEmptyResponse = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): boolean => {
  if (depth > 5) return false
  if (typeof value === 'string') return EMPTY_RESPONSE.test(value)
  if (typeof value !== 'object' || value === null || seen.has(value)) return false
  seen.add(value)
  const record = value as Record<string, unknown>
  return ['name', 'message', 'code', 'error', 'cause', 'reason'].some((key) =>
    containsEmptyResponse(record[key], depth + 1, seen))
}

/**
 * Turns the Electron transport's empty-response failure into a user-facing
 * generation error. It never retries a dispatched request because the remote
 * job may still have started and may already be billable.
 */
export const actionableImageGenerationError = (
  error: unknown,
  selectedModel: string,
  availableModels: readonly string[] = [],
): unknown => {
  if (!(error instanceof StudioError)
    || !IMAGE_NETWORK_CODES.has(error.code)
    || !containsEmptyResponse(error)) return error

  const suggestedModel = availableModels.find((model) =>
    model.toLowerCase() === PREFERRED_BALANCED_MODEL && model !== selectedModel)
  return new StudioError(
    'provider-image-response-interrupted',
    suggestedModel
      ? `当前模型生成时间超过了这条线路的等待时间，图片返回前连接已断开。本次是否计费无法确认，请先查看账单；可切换为同组 ${suggestedModel} 后重新运行。`
      : '当前模型生成时间超过了这条线路的等待时间，图片返回前连接已断开。本次是否计费无法确认，请先查看账单，再切换同组其他模型运行。',
    error.dispatchState,
    error,
  )
}
