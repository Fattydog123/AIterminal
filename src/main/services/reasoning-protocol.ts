import type {
  ExplicitReasoningEffort,
  ModelEndpointType,
  ModelReasoningProtocol,
  ReasoningBudgetByEffort,
  ReasoningEffort
} from '../../shared/contracts.ts'

const EXPLICIT_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'light',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const satisfies readonly ExplicitReasoningEffort[])
const MAX_REASONING_BUDGET_TOKENS = 1_000_000
const REASONING_EFFORTS = Object.freeze([
  'auto',
  ...EXPLICIT_EFFORTS
] as const satisfies readonly ReasoningEffort[])

export type ReasoningWireTarget =
  | 'responses'
  | 'chat-completions'
  | 'anthropic-adaptive'
  | 'gemini-level'

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
}

export function mapReasoningEffortForWire(
  effort: ReasoningEffort,
  target: ReasoningWireTarget
): string | undefined {
  if (effort === 'auto') return undefined
  if (effort === 'none') {
    return target === 'responses' || target === 'chat-completions' ? 'none' : undefined
  }
  if (effort === 'minimal') {
    if (target === 'responses' || target === 'chat-completions') return 'minimal'
    return target === 'gemini-level' ? 'MINIMAL' : undefined
  }
  if (effort === 'light') return target === 'gemini-level' ? 'LOW' : 'low'
  if (effort === 'medium') return target === 'gemini-level' ? 'MEDIUM' : 'medium'
  if (effort === 'high') return target === 'gemini-level' ? 'HIGH' : 'high'
  if (effort === 'xhigh') {
    if (target === 'responses' || target === 'chat-completions' || target === 'anthropic-adaptive') {
      return 'xhigh'
    }
    return undefined
  }
  if (effort === 'max') {
    return target === 'gemini-level' ? undefined : 'max'
  }
  // Ultra is a Codex product-level preset. The public OpenAI request schema
  // tops out at `max`, and Codex CLI performs this same projection before
  // sending a request. Native Anthropic/Gemini transports do not receive it.
  return target === 'responses' || target === 'chat-completions'
    ? 'max'
    : undefined
}

export function isReasoningEffortRepresentable(
  effort: ReasoningEffort,
  target: ReasoningWireTarget
): boolean {
  return effort === 'auto' || mapReasoningEffortForWire(effort, target) !== undefined
}

export function reasoningBudgetForEffort(
  protocol: Extract<ModelReasoningProtocol, { type: 'anthropic-budget' | 'gemini-budget' }>,
  effort: ReasoningEffort
): number | undefined {
  return effort === 'auto' ? undefined : protocol.budgets[effort]
}

export function cloneModelReasoningProtocol(
  protocol: ModelReasoningProtocol
): ModelReasoningProtocol {
  if (protocol.type === 'anthropic-adaptive') {
    return Object.freeze({ type: protocol.type })
  }
  if (protocol.type === 'gemini-level') {
    return Object.freeze({
      type: protocol.type,
      ...(protocol.includeThoughts === undefined
        ? {}
        : { includeThoughts: protocol.includeThoughts })
    })
  }
  return Object.freeze({
    type: protocol.type,
    budgets: Object.freeze({ ...protocol.budgets }),
    ...(protocol.type === 'gemini-budget' && protocol.includeThoughts !== undefined
      ? { includeThoughts: protocol.includeThoughts }
      : {})
  })
}

export function reasoningProtocolForEndpoint(
  protocol: ModelReasoningProtocol | undefined,
  endpointType: ModelEndpointType
): ModelReasoningProtocol | undefined {
  if (protocol === undefined) return undefined
  if (endpointType === 'anthropic' && protocol.type.startsWith('anthropic-')) return protocol
  if (endpointType === 'gemini' && protocol.type.startsWith('gemini-')) return protocol
  return undefined
}

export function isModelReasoningProtocol(value: unknown): value is ModelReasoningProtocol {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'anthropic-adaptive') {
    return hasExactKeys(value, ['type'])
  }
  if (value.type === 'anthropic-budget') {
    return hasExactKeys(value, ['type', 'budgets']) && isReasoningBudgetMap(value.budgets, false)
  }
  if (value.type === 'gemini-level') {
    return hasOptionalIncludeThoughts(value, ['type'])
  }
  if (value.type === 'gemini-budget') {
    return hasOptionalIncludeThoughts(value, ['type', 'budgets']) &&
      isReasoningBudgetMap(value.budgets, true)
  }
  return false
}

function isReasoningBudgetMap(
  value: unknown,
  allowDisabledBudget: boolean
): value is ReasoningBudgetByEffort {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length < 1 || keys.length > EXPLICIT_EFFORTS.length) return false
  return keys.every((key) => {
    if (!(EXPLICIT_EFFORTS as readonly string[]).includes(key)) return false
    if (key === 'none' && !allowDisabledBudget) return false
    const budget = value[key]
    return typeof budget === 'number' &&
      Number.isSafeInteger(budget) &&
      budget >= (key === 'none' ? 0 : 1) &&
      budget <= MAX_REASONING_BUDGET_TOKENS
  })
}

function hasOptionalIncludeThoughts(
  value: Record<string, unknown>,
  requiredKeys: readonly string[]
): boolean {
  const allowedKeys = [...requiredKeys, 'includeThoughts']
  const keys = Object.keys(value)
  return requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowedKeys.includes(key)) &&
    (value.includeThoughts === undefined || typeof value.includeThoughts === 'boolean')
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
