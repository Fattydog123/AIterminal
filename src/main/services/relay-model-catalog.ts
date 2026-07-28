import type {
  ModelDescriptor,
  ModelEndpointType,
  ModelReasoningProtocol,
  ReasoningEffort,
  WorkspaceMode
} from '../../shared/contracts.ts'
import { isModelCapabilityExplicitlyUnsupported } from '../../shared/contracts.ts'
import {
  applyTrustedModelReasoningProfile,
  mergeModelEndpointTypes,
  modelCatalogFromIds,
  normalizeModelEndpointTypes
} from './model-catalog.ts'
import type { RelayPricingDto, RelayPricingModelDto } from './relay-service.ts'

interface RelayGroupCatalogInput {
  readonly groupModelIds: readonly string[]
  readonly pricing: RelayPricingDto
  readonly remoteModels: readonly ModelDescriptor[]
  readonly mode: WorkspaceMode
}

/**
 * Builds a renderer-safe catalog from the exact group model IDs returned by
 * NewAPI. A relay model is selectable only when either /api/pricing or
 * /v1/models explicitly declares a supported endpoint type.
 */
export function buildRelayGroupModelCatalog(input: RelayGroupCatalogInput): ModelDescriptor[] {
  if (input.groupModelIds.length === 0) return []

  const baseModels = modelCatalogFromIds(input.groupModelIds, input.mode)
  const remoteById = new Map(input.remoteModels.map((model) => [model.id, model] as const))
  const pricingEndpoints = pricingEndpointTypesByModel(input.pricing)

  return baseModels.flatMap((baseModel): ModelDescriptor[] => {
    const remoteModel = remoteById.get(baseModel.id)
    const hasPricingDeclaration = pricingEndpoints.has(baseModel.id)
    if (!hasPricingDeclaration && remoteModel?.declaredEndpointTypes === undefined && baseModel.declaredEndpointTypes === undefined) return []

    let model = remoteModel ?? baseModel
    if (hasPricingDeclaration) {
      model = mergeModelEndpointTypes(model, pricingEndpoints.get(baseModel.id) ?? [], input.mode)
    }
    model = applyRelayAgentEndpointContract(model, input.pricing)
    model = applyOfficialRelayReasoningProfile(model, input.pricing)
    if (!model.modes.includes(input.mode)) return []
    if (
      input.mode === 'agent' &&
      isModelCapabilityExplicitlyUnsupported(model, 'toolUse')
    ) return []
    return [model]
  })
}

/**
 * Some providers expose both OpenAI-compatible transports in NewAPI pricing
 * while their Agent tool loop is only implemented on Responses. Keep Chat's
 * server-selected endpoint untouched, and record this explicit vendor fact
 * for Agent admission. Provider identity comes only from pricing metadata;
 * model names remain opaque.
 */
function applyRelayAgentEndpointContract(
  model: ModelDescriptor,
  pricing: RelayPricingDto
): ModelDescriptor {
  if (pricingVendorForModel(pricing, model.id) !== 'xai') return model
  if (!model.endpointTypes.includes('openai-response')) return model
  return { ...model, preferredAgentEndpoint: 'openai-response' }
}

/**
 * Filters the account-wide model union into one NewAPI group. The virtual
 * `auto` group is the union of the server-declared auto_groups, while `all`
 * remains the explicit NewAPI wildcard.
 */
export function relayGroupModelIds(
  accountModelIds: readonly string[],
  pricing: RelayPricingDto,
  groupId: string
): string[] {
  const enabled = new Set<string>()
  for (const entry of pricing.data) {
    if (pricingModelSupportsGroup(entry, pricing, groupId)) enabled.add(entry.model_name)
  }
  return uniqueModelIds(accountModelIds).filter((modelId) => enabled.has(modelId))
}

export function relayGroupModelIdsForEndpoint(
  accountModelIds: readonly string[],
  pricing: RelayPricingDto,
  groupId: string,
  endpointType: ModelEndpointType
): string[] {
  const groupModels = new Set(relayGroupModelIds(accountModelIds, pricing, groupId))
  return filterModelIdsForEndpoint(groupModels, pricing, accountModelIds, endpointType)
}

/**
 * Filters an already group-scoped model list only by an explicit endpoint
 * declaration. The concrete `/api/user/models?group=...` response is the
 * authority for membership; pricing `enable_groups` is not reapplied here.
 */
export function relayModelIdsForEndpoint(
  groupModelIds: readonly string[],
  pricing: RelayPricingDto,
  endpointType: ModelEndpointType
): string[] {
  return filterModelIdsForEndpoint(undefined, pricing, groupModelIds, endpointType)
}

function filterModelIdsForEndpoint(
  groupModels: ReadonlySet<string> | undefined,
  pricing: RelayPricingDto,
  sourceModelIds: readonly string[],
  endpointType: ModelEndpointType
): string[] {
  const endpointModels = new Set<string>()
  const endpointsByModel = pricingEndpointTypesByModel(pricing)
  for (const [modelId, endpointTypes] of endpointsByModel) {
    if (endpointTypes.includes(endpointType)) endpointModels.add(modelId)
  }
  return uniqueModelIds(sourceModelIds).filter((modelId) => (
    (groupModels === undefined || groupModels.has(modelId)) && endpointModels.has(modelId)
  ))
}

function pricingEndpointTypesByModel(
  pricing: RelayPricingDto
): ReadonlyMap<string, ModelEndpointType[]> {
  const output = new Map<string, ModelEndpointType[]>()
  for (const entry of pricing.data) {
    if (entry.supported_endpoint_types === undefined) continue
    const current = output.get(entry.model_name) ?? []
    const next = normalizeModelEndpointTypes(entry.supported_endpoint_types)
    output.set(entry.model_name, [...new Set([...current, ...next])])
  }
  return output
}

function pricingModelSupportsGroup(
  entry: Readonly<RelayPricingModelDto>,
  pricing: RelayPricingDto,
  groupId: string
): boolean {
  if (entry.enable_groups.includes('all') || entry.enable_groups.includes(groupId)) return true
  if (groupId !== 'auto') return false
  return (pricing.auto_groups ?? []).some((autoGroup) => entry.enable_groups.includes(autoGroup))
}

interface OfficialReasoningProfile {
  readonly endpointTypes: readonly ModelEndpointType[]
  readonly reasoning: readonly ReasoningEffort[]
  readonly protocol?: ModelReasoningProtocol
}

const OPENAI_ENDPOINTS = Object.freeze([
  'openai',
  'openai-response'
] as const satisfies readonly ModelEndpointType[])
const ANTHROPIC_ENDPOINTS = Object.freeze([
  'anthropic'
] as const satisfies readonly ModelEndpointType[])
const GEMINI_ENDPOINTS = Object.freeze([
  'gemini'
] as const satisfies readonly ModelEndpointType[])
const ANTHROPIC_ADAPTIVE = Object.freeze({
  type: 'anthropic-adaptive'
} as const satisfies ModelReasoningProtocol)
const GEMINI_LEVEL = Object.freeze({
  type: 'gemini-level'
} as const satisfies ModelReasoningProtocol)

const OFFICIAL_REASONING_PROFILES: Readonly<
  Record<string, Readonly<Record<string, OfficialReasoningProfile>>>
> = Object.freeze({
  openai: Object.freeze({
    'gpt-5.6-sol': openAiProfile(['light', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    'gpt-5.6-terra': openAiProfile(['light', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    'gpt-5.6-luna': openAiProfile(['light', 'medium', 'high', 'xhigh', 'max']),
    'gpt-5.5': openAiProfile(['light', 'medium', 'high', 'xhigh']),
    'gpt-5.4': openAiProfile(['light', 'medium', 'high', 'xhigh']),
    'gpt-5.4-mini': openAiProfile(['light', 'medium', 'high', 'xhigh'])
  }),
  anthropic: Object.freeze({
    'claude-opus-4-5': anthropicProfile(['light', 'medium', 'high', 'max']),
    'claude-opus-4-6': anthropicProfile(['light', 'medium', 'high', 'max']),
    'claude-sonnet-4-6': anthropicProfile(['light', 'medium', 'high', 'max']),
    'claude-opus-4-7': anthropicProfile(['light', 'medium', 'high', 'xhigh', 'max']),
    'claude-opus-4-8': anthropicProfile(['light', 'medium', 'high', 'xhigh', 'max']),
    'claude-fable-5': anthropicProfile(['light', 'medium', 'high', 'xhigh', 'max']),
    'claude-sonnet-5': anthropicProfile(['light', 'medium', 'high', 'xhigh', 'max'])
  }),
  xai: Object.freeze({
    'grok-4.3': openAiProfile(['none', 'light', 'medium', 'high', 'xhigh']),
    'grok-4.5': openAiProfile(['light', 'medium', 'high', 'xhigh'])
  }),
  gemini: Object.freeze({
    'gemini-3.1-pro-preview': geminiProfile(['light', 'medium', 'high']),
    'gemini-3.1-flash-lite-image': geminiProfile(['minimal', 'high']),
    'gemini-3-flash-preview': geminiProfile(['minimal', 'light', 'medium', 'high']),
    'gemini-3-pro-preview': geminiProfile(['light', 'high']),
    'gemini-3.5-flash': geminiProfile(['minimal', 'light', 'medium', 'high']),
    'gemini-2.5-pro': geminiBudgetProfile(
      ['light', 'medium', 'high'],
      { light: 1_024, medium: 8_192, high: 32_768 }
    ),
    'gemini-2.5-flash': geminiBudgetProfile(
      ['none', 'light', 'medium', 'high'],
      { none: 0, light: 1_024, medium: 8_192, high: 24_576 }
    ),
    'gemini-2.5-flash-lite': geminiBudgetProfile(
      ['none', 'light', 'medium', 'high'],
      { none: 0, light: 1_024, medium: 8_192, high: 24_576 }
    )
  })
})

function openAiProfile(reasoning: readonly ReasoningEffort[]): OfficialReasoningProfile {
  return Object.freeze({ endpointTypes: OPENAI_ENDPOINTS, reasoning: Object.freeze([...reasoning]) })
}

function anthropicProfile(reasoning: readonly ReasoningEffort[]): OfficialReasoningProfile {
  return Object.freeze({
    endpointTypes: ANTHROPIC_ENDPOINTS,
    reasoning: Object.freeze([...reasoning]),
    protocol: ANTHROPIC_ADAPTIVE
  })
}

function geminiProfile(reasoning: readonly ReasoningEffort[]): OfficialReasoningProfile {
  return Object.freeze({
    endpointTypes: GEMINI_ENDPOINTS,
    reasoning: Object.freeze([...reasoning]),
    protocol: GEMINI_LEVEL
  })
}

function geminiBudgetProfile(
  reasoning: readonly ReasoningEffort[],
  budgets: Readonly<Partial<Record<Exclude<ReasoningEffort, 'auto'>, number>>>
): OfficialReasoningProfile {
  return Object.freeze({
    endpointTypes: GEMINI_ENDPOINTS,
    reasoning: Object.freeze([...reasoning]),
    protocol: Object.freeze({
      type: 'gemini-budget',
      budgets: Object.freeze({ ...budgets })
    })
  })
}

function applyOfficialRelayReasoningProfile(
  model: ModelDescriptor,
  pricing: RelayPricingDto
): ModelDescriptor {
  if (model.declaredReasoning !== undefined || model.preferredChatEndpoint === null) return model
  const vendor = pricingVendorForModel(pricing, model.id)
  if (vendor === undefined) return model
  const profiles = OFFICIAL_REASONING_PROFILES[vendor]
  const profile = profiles?.[model.id]
  if (!profile || !profile.endpointTypes.includes(model.preferredChatEndpoint)) return model
  return applyTrustedModelReasoningProfile(model, profile.reasoning, profile.protocol)
}

function pricingVendorForModel(pricing: RelayPricingDto, modelId: string): string | undefined {
  const vendors = new Map((pricing.vendors ?? []).map((vendor) => [vendor.id, vendor.name] as const))
  const candidates = new Set<string>()
  for (const row of pricing.data) {
    if (row.model_name !== modelId) continue
    const raw = row.vendor_id === undefined ? row.owner_by : vendors.get(row.vendor_id)
    const normalized = normalizePricingVendor(raw)
    if (normalized !== undefined) candidates.add(normalized)
  }
  return candidates.size === 1 ? [...candidates][0] : undefined
}

function normalizePricingVendor(value: string | undefined): keyof typeof OFFICIAL_REASONING_PROFILES | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'openai' || normalized === 'anthropic' || normalized === 'xai') {
    return normalized
  }
  if (normalized === 'gemini' || normalized === 'google' || normalized === 'google gemini') {
    return 'gemini'
  }
  return undefined
}

function uniqueModelIds(values: readonly string[]): string[] {
  return [...new Set(values)]
}
