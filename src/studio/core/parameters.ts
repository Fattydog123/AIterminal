import type {
  ParameterCapabilityKey,
  ParameterCondition,
  ParameterDefinition,
} from '../shared/types.js'
import type { CapabilitySupport } from './providerCapabilities.js'

export interface ParameterFieldContext {
  readonly parameters: Readonly<Record<string, unknown>>
  readonly capabilities?: Partial<Readonly<Record<ParameterCapabilityKey, CapabilitySupport>>>
}

export interface ParameterFieldState {
  readonly visible: boolean
  readonly disabled: boolean
  readonly error?: string
  readonly disabledReason?: string
}

const conditionMatches = (
  condition: ParameterCondition | undefined,
  parameters: Readonly<Record<string, unknown>>,
): boolean => {
  if (!condition) return true
  const actual = parameters[condition.parameter]
  if (condition.operator === 'equals') return actual === condition.value
  if (condition.operator === 'not-equals') return actual !== condition.value
  if (condition.operator === 'in') return condition.values.includes(actual as never)
  if (condition.operator === 'not-in') return !condition.values.includes(actual as never)
  if (condition.operator === 'truthy') return Boolean(actual)
  return !actual
}

const missing = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)

const numericError = (definition: ParameterDefinition, value: unknown): string | undefined => {
  if (definition.kind !== 'number' || missing(value)) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${definition.label}必须是有效数字`
  if (definition.min !== undefined && value < definition.min) return `${definition.label}不能小于 ${definition.min}`
  if (definition.max !== undefined && value > definition.max) return `${definition.label}不能大于 ${definition.max}`
  if (definition.step !== undefined && definition.step > 0) {
    const base = definition.min ?? 0
    const quotient = (value - base) / definition.step
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `${definition.label}必须按 ${definition.step} 递增`
  }
  return undefined
}

export const evaluateParameterField = (
  definition: ParameterDefinition,
  value: unknown,
  context: ParameterFieldContext,
): ParameterFieldState => {
  if (!conditionMatches(definition.condition, context.parameters)) return { visible: false, disabled: false }
  const capabilityHint = definition.capabilityHint
  if (capabilityHint && context.capabilities?.[capabilityHint.capability] === 'unsupported') {
    if (capabilityHint.unsupportedBehavior === 'hide') return { visible: false, disabled: false }
    return {
      visible: true,
      disabled: true,
      disabledReason: capabilityHint.message ?? `当前 Provider 不支持${definition.label}`,
    }
  }
  if (definition.required && missing(value)) {
    return { visible: true, disabled: false, error: `${definition.label}不能为空` }
  }
  const error = numericError(definition, value)
  return { visible: true, disabled: false, ...(error ? { error } : {}) }
}
