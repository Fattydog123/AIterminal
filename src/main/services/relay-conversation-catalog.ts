import type { ModelDescriptor, WorkspaceMode } from '../../shared/contracts.ts'
import { ModelCatalogError, type RemoteModelCatalogService } from './model-catalog.ts'
import {
  buildRelayGroupModelCatalog,
  relayGroupModelIds
} from './relay-model-catalog.ts'
import {
  RelayServiceError,
  type RelayPricingDto,
  type RelayService
} from './relay-service.ts'

type RelayConversationCatalogSource = Pick<
  RelayService,
  | 'getTokenBackedUserGroups'
  | 'getUserModels'
  | 'getUserModelsForGroup'
  | 'getPricing'
  | 'getEligibleModelIdsForGroup'
  | 'getSelectedModelAccessCredentials'
>

export interface RelayConversationCatalogInput {
  readonly relay: RelayConversationCatalogSource
  readonly modelCatalog: Pick<RemoteModelCatalogService, 'list'>
  readonly groupId: string
  readonly mode: WorkspaceMode
}

export interface RelayConversationCatalogResult {
  readonly models: readonly ModelDescriptor[]
  readonly pricing: RelayPricingDto
}

export async function loadRelayConversationCatalog(
  input: RelayConversationCatalogInput
): Promise<RelayConversationCatalogResult> {
  const groups = await input.relay.getTokenBackedUserGroups()
  if (!Object.hasOwn(groups, input.groupId)) throw new RelayServiceError('invalid_input')

  const [accountModelIds, pricing] = await Promise.all([
    input.groupId === 'auto'
      ? input.relay.getUserModels()
      : input.relay.getUserModelsForGroup(input.groupId),
    input.relay.getPricing()
  ])
  const groupModelIds = input.groupId === 'auto'
    ? relayGroupModelIds(accountModelIds, pricing, input.groupId)
    : [...accountModelIds]
  let eligibleGroupModelIds = await input.relay.getEligibleModelIdsForGroup(
    input.groupId,
    groupModelIds
  )

  const declaredModels = buildRelayGroupModelCatalog({
    groupModelIds: eligibleGroupModelIds,
    pricing,
    remoteModels: [],
    mode: input.mode
  }).filter((model) => model.modes.includes(input.mode))
  if (declaredModels.length > 0) return { models: declaredModels, pricing }

  let remoteModels: ModelDescriptor[] = []
  let remoteCatalogError: unknown
  if (groupModelIds.length === 0 && input.groupId !== 'auto') {
    // Some NewAPI deployments expose a token-backed group before the account
    // ability index has caught up. The exact group's token catalog is still an
    // authoritative, narrower source and avoids guessing aliases or model IDs.
    const secret = await input.relay.getSelectedModelAccessCredentials({
      groupId: input.groupId
    })
    remoteModels = await input.modelCatalog.list(
      { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
      input.mode
    )
    eligibleGroupModelIds = await input.relay.getEligibleModelIdsForGroup(
      input.groupId,
      remoteModels.map((model) => model.id)
    )
  } else if (eligibleGroupModelIds.length > 0) {
    try {
      const secret = await input.relay.getSelectedModelAccessCredentials({
        groupId: input.groupId,
        modelId: eligibleGroupModelIds[0]
      })
      remoteModels = await input.modelCatalog.list(
        { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
        input.mode
      )
    } catch (error) {
      if (!isOptionalRelayCatalogEnrichmentError(error)) throw error
      remoteCatalogError = error
    }
  }

  const models = buildRelayGroupModelCatalog({
    groupModelIds: eligibleGroupModelIds,
    pricing,
    remoteModels,
    mode: input.mode
  }).filter((model) => model.modes.includes(input.mode))
  if (models.length === 0 && remoteCatalogError !== undefined) throw remoteCatalogError
  return { models, pricing }
}

function isOptionalRelayCatalogEnrichmentError(error: unknown): boolean {
  if (!(error instanceof ModelCatalogError)) return false
  return error.code === 'network_error' ||
    error.code === 'timeout' ||
    error.code === 'remote_rejected'
}
