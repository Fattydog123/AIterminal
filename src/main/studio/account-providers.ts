import { createHash } from 'node:crypto'

import type {
  OpenAiProviderDescriptor,
} from '../../studio/shared/types.ts'
import type {
  RelayAuthenticationStateDto,
  RelayGroupInfoDto,
  RelayGroupsDto,
  RelayModelAccessCredentials,
  RelayModelAccessSelection,
  RelayPricingDto
} from '../services/relay-service.ts'
import { StudioError } from './errors.ts'
import type { OpenAiProviderCredentials } from './providers.ts'
import {
  buildImagesEditRequestUrl,
  buildImagesGenerationRequestUrl,
} from '../services/images-client.ts'
import { relayModelIdsForEndpoint } from '../services/relay-model-catalog.ts'
import type { ConfirmedStudioImageCapability } from './image-capability-store.ts'

const ACCOUNT_PROVIDER_PREFIX = 'account-group-'
const CATALOG_TTL_MS = 30_000
const IMAGE_GENERATION_SUFFIX = '/images/generations'
const DEFAULT_IMAGE_GENERATION_PATH = '/v1/images/generations'
const PREFERRED_BALANCED_IMAGE_MODEL = 'gpt-image-2-2k'

const deriveImageEditPath = (generationPath: string): string | undefined =>
  generationPath.endsWith(IMAGE_GENERATION_SUFFIX)
    ? `${generationPath.slice(0, -IMAGE_GENERATION_SUFFIX.length)}/images/edits`
    : undefined

export interface StudioAccountRelay {
  readonly serverOrigin: string
  getAuthenticationState(): RelayAuthenticationStateDto
  ensureAuthenticatedSession?(): Promise<RelayAuthenticationStateDto>
  getTokenBackedUserGroups(): Promise<RelayGroupsDto>
  getUserModels(): Promise<readonly string[]>
  getUserModelsForGroup(groupId: string): Promise<readonly string[]>
  getEligibleModelIdsForGroup(
    groupId: string,
    modelIds: readonly string[]
  ): Promise<readonly string[]>
  getPricing(): Promise<RelayPricingDto>
  getSelectedModelAccessCredentials(
    selection: RelayModelAccessSelection
  ): Promise<Readonly<RelayModelAccessCredentials>>
}

export interface StudioManagedProviderSource {
  owns(providerId: string): boolean
  list(): Promise<readonly OpenAiProviderDescriptor[]>
  descriptor(providerId: string): Promise<OpenAiProviderDescriptor | undefined>
  credentials(providerId: string, modelId?: string): Promise<OpenAiProviderCredentials>
}

export interface StudioImageCapabilitySource {
  list(): Promise<readonly ConfirmedStudioImageCapability[]>
}

export interface StudioProviderSnapshotSource {
  load(): Promise<readonly OpenAiProviderDescriptor[] | undefined>
  save(providers: readonly OpenAiProviderDescriptor[]): Promise<void>
}

interface AccountProviderCatalog {
  readonly expiresAt: number
  readonly descriptors: readonly OpenAiProviderDescriptor[]
  readonly groupsByProviderId: ReadonlyMap<string, string>
}

export class StudioAccountProviderAdapter implements StudioManagedProviderSource {
  readonly #relay: StudioAccountRelay
  readonly #now: () => number
  readonly #imageCapabilities: StudioImageCapabilitySource | undefined
  readonly #providerSnapshots: StudioProviderSnapshotSource | undefined
  #catalog: AccountProviderCatalog | undefined

  constructor(
    relay: StudioAccountRelay,
    now: () => number = Date.now,
    imageCapabilities?: StudioImageCapabilitySource,
    providerSnapshots?: StudioProviderSnapshotSource,
  ) {
    this.#relay = relay
    this.#now = now
    this.#imageCapabilities = imageCapabilities
    this.#providerSnapshots = providerSnapshots
  }

  owns(providerId: string): boolean {
    return providerId.startsWith(ACCOUNT_PROVIDER_PREFIX)
  }

  async list(): Promise<readonly OpenAiProviderDescriptor[]> {
    if (!await this.#hasAuthenticatedSession()) {
      this.#catalog = undefined
      return []
    }
    try {
      const descriptors = (await this.#loadCatalog(true)).descriptors
      await this.#providerSnapshots?.save(descriptors).catch(() => undefined)
      return descriptors
    } catch (error) {
      if (!isTransientCatalogFailure(error) || !this.#relay.getAuthenticationState().authenticated) {
        throw error
      }
      const snapshot = await this.#providerSnapshots?.load().catch(() => undefined)
      if (snapshot !== undefined) return snapshot
      throw error
    }
  }

  async descriptor(providerId: string): Promise<OpenAiProviderDescriptor | undefined> {
    if (!this.owns(providerId) || !await this.#hasAuthenticatedSession()) return undefined
    return (await this.#loadCatalog()).descriptors.find((item) => item.id === providerId)
  }

  async credentials(providerId: string, modelId?: string): Promise<OpenAiProviderCredentials> {
    if (!this.owns(providerId) || !await this.#hasAuthenticatedSession()) {
      throw new StudioError('account-provider-unavailable', '当前账户接口不可用，请重新登录')
    }
    const catalog = await this.#loadCatalog()
    const groupId = catalog.groupsByProviderId.get(providerId)
    const descriptor = catalog.descriptors.find((item) => item.id === providerId)
    if (!groupId || !descriptor) {
      throw new StudioError('account-provider-not-found', '账户分组不存在或已发生变化，请刷新分组列表')
    }
    const selectedModel = modelId?.trim() || descriptor.defaultModel
    if (descriptor.availableModels?.includes(selectedModel) !== true) {
      throw new StudioError(
        'account-provider-image-capability-unconfirmed',
        '所选模型没有声明或确认图片生成能力，请刷新分组后重新选择',
      )
    }
    const [currentGroupModels, currentPricing] = await Promise.all([
      groupId === 'auto'
        ? this.#relay.getUserModels()
        : this.#relay.getUserModelsForGroup(groupId),
      this.#relay.getPricing(),
    ])
    const currentEligibleModels = await this.#relay.getEligibleModelIdsForGroup(groupId, currentGroupModels)
    if (!currentEligibleModels.includes(selectedModel)) {
      throw new StudioError(
        'account-provider-token-incompatible',
        '所选模型已不在该分组的联网目录中，或没有可用令牌，请刷新分组'
      )
    }
    const secret = await this.#relay.getSelectedModelAccessCredentials({
      groupId,
      modelId: selectedModel
    })
    const route = resolveImageRoute(
      secret.baseUrl,
      currentPricing,
      descriptor.imageGenerationPath ?? DEFAULT_IMAGE_GENERATION_PATH,
    )
    return { descriptor: descriptorWithImageRoute(descriptor, secret.baseUrl, route), apiKey: secret.apiKey }
  }

  async #hasAuthenticatedSession(): Promise<boolean> {
    if (this.#relay.getAuthenticationState().authenticated) return true
    if (!this.#relay.ensureAuthenticatedSession) return false
    try {
      return (await this.#relay.ensureAuthenticatedSession()).authenticated
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'authentication_required'
      ) {
        this.#catalog = undefined
        return false
      }
      throw error
    }
  }

  async #loadCatalog(forceRefresh = false): Promise<AccountProviderCatalog> {
    const now = this.#now()
    if (!forceRefresh && this.#catalog && this.#catalog.expiresAt > now) return this.#catalog

    const [groups, accountModels, pricing, confirmedCapabilities] = await Promise.all([
      this.#relay.getTokenBackedUserGroups(),
      this.#relay.getUserModels(),
      this.#relay.getPricing(),
      this.#imageCapabilities?.list() ?? Promise.resolve([]),
    ])
    const baseUrl = `${this.#relay.serverOrigin.replace(/\/+$/u, '')}/v1`
    const route = resolveImageRoute(baseUrl, pricing, DEFAULT_IMAGE_GENERATION_PATH)
    const currentImageGenerationPath = route.imageGenerationPath
    // `auto` is a virtual NewAPI route. Every concrete group must use its
    // exact server-side model list so pricing metadata cannot widen access.
    const groupModelEntries = await Promise.all(
      Object.keys(groups)
        .filter((groupId) => groupId !== 'auto')
        .map(async (groupId) => [groupId, await this.#relay.getUserModelsForGroup(groupId)] as const),
    )
    const modelsByGroup = new Map(groupModelEntries)
    const modelCatalogByGroup = new Map(await Promise.all(
      Object.keys(groups).map(async (groupId) => {
        const models = groupId === 'auto'
          ? accountModels
          : modelsByGroup.get(groupId) ?? []
        const declaredImageModelSet = new Set([
          ...relayModelIdsForEndpoint(models, pricing, 'image-generation'),
          ...pricingImageModelIds(pricing, models),
        ])
        const eligibleModels = await this.#relay.getEligibleModelIdsForGroup(groupId, models)
        const eligibleModelSet = new Set(eligibleModels)
        const confirmedImageModelSet = new Set(
          currentImageGenerationPath === undefined
            ? []
            : confirmedCapabilities
              .filter((capability) => (
                capability.groupId === groupId
                && capability.imageGenerationPath === currentImageGenerationPath
              ))
              .map((capability) => capability.modelId),
        )
        const imageModels = [...new Set(models)].filter((modelId) => (
          eligibleModelSet.has(modelId)
          && (declaredImageModelSet.has(modelId) || confirmedImageModelSet.has(modelId))
        ))
        const confirmedOnlyModels = imageModels.filter((modelId) => (
          !declaredImageModelSet.has(modelId) && confirmedImageModelSet.has(modelId)
        ))
        // Image tier aliases can have very different end-to-end latency. Keep
        // every exact model selectable, but use the balanced route for an
        // implicit/new-workflow selection when the server actually offers it.
        const defaultModel = imageModels.find((modelId) =>
          modelId.toLowerCase() === PREFERRED_BALANCED_IMAGE_MODEL)
          ?? imageModels[0]
        return [groupId, Object.freeze({
          models: Object.freeze(imageModels),
          confirmedOnlyModels: Object.freeze(confirmedOnlyModels),
          defaultModel,
        })] as const
      })
    ))
    const groupsByProviderId = new Map<string, string>()
    const descriptors = Object.entries(groups).flatMap(([groupId, info]): OpenAiProviderDescriptor[] => {
      const modelCatalog = modelCatalogByGroup.get(groupId)
      const models = modelCatalog?.models ?? []
      if (models.length === 0 || !modelCatalog?.defaultModel) return []
      const descriptor = accountProviderDescriptor({
        groupId,
        info,
        baseUrl,
        models,
        confirmedOnlyModels: modelCatalog.confirmedOnlyModels,
        defaultModel: modelCatalog.defaultModel,
        imageGenerationPath: route.imageGenerationPath,
        imageEditPath: route.imageEditPath,
      })
      groupsByProviderId.set(descriptor.id, groupId)
      return [descriptor]
    })
    this.#catalog = {
      expiresAt: now + CATALOG_TTL_MS,
      descriptors: Object.freeze(descriptors),
      groupsByProviderId
    }
    return this.#catalog
  }
}

interface ImageRoute {
  readonly imageGenerationPath?: string
  readonly imageEditPath?: string
}

function resolveImageRoute(
  baseUrl: string,
  pricing: RelayPricingDto,
  fallbackGenerationPath?: string,
): ImageRoute {
  const declaredRoute = pricing.supported_endpoint?.['image-generation']
  if (declaredRoute?.method !== undefined && declaredRoute.method !== 'POST') {
    throw new StudioError(
      'account-provider-endpoint-method-unsupported',
      '登录账户声明的 image-generation 请求方法不受支持',
    )
  }
  const imageGenerationPath = declaredRoute?.path ?? fallbackGenerationPath
  if (imageGenerationPath === undefined) return Object.freeze({})
  try {
    buildImagesGenerationRequestUrl(baseUrl, imageGenerationPath)
    const imageEditPath = deriveImageEditPath(imageGenerationPath)
    if (imageEditPath !== undefined) buildImagesEditRequestUrl(baseUrl, imageEditPath)
    return Object.freeze({
      imageGenerationPath,
      ...(imageEditPath === undefined ? {} : { imageEditPath }),
    })
  } catch {
    throw new StudioError(
      'account-provider-endpoint-invalid',
      '登录账户声明的 image-generation 路径无效',
    )
  }
}

function descriptorWithImageRoute(
  descriptor: OpenAiProviderDescriptor,
  baseUrl: string,
  route: ImageRoute,
): OpenAiProviderDescriptor {
  const {
    imageGenerationPath: _previousGenerationPath,
    imageEditPath: _previousEditPath,
    ...base
  } = descriptor
  return Object.freeze({
    ...base,
    baseUrl,
    ...(route.imageGenerationPath === undefined
      ? {}
      : { imageGenerationPath: route.imageGenerationPath }),
    ...(route.imageEditPath === undefined ? {} : { imageEditPath: route.imageEditPath }),
  })
}

function accountProviderDescriptor(input: {
  readonly groupId: string
  readonly info: Readonly<RelayGroupInfoDto>
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly confirmedOnlyModels: readonly string[]
  readonly defaultModel: string
  readonly imageGenerationPath?: string
  readonly imageEditPath?: string
}): OpenAiProviderDescriptor {
  if (!input.defaultModel || !input.models.includes(input.defaultModel)) {
    throw new StudioError('account-provider-model-incompatible', '分组没有可用模型')
  }
  return Object.freeze({
    id: accountProviderId(input.groupId),
    name: input.groupId,
    kind: 'openai-compatible',
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    timeoutMs: 300_000,
    maxImageBytes: 104_857_600,
    proxyMode: 'system',
    hasSecret: true,
    maskedSecret: '账户会话',
    managedBy: 'ai-terminal-account',
    groupId: input.groupId,
    availableModels: Object.freeze([...input.models]),
    ...(input.confirmedOnlyModels.length === 0
      ? {}
      : { confirmedOnlyModels: Object.freeze([...input.confirmedOnlyModels]) }),
    ...(input.imageGenerationPath === undefined
      ? {}
      : { imageGenerationPath: input.imageGenerationPath }),
    ...(input.imageEditPath === undefined ? {} : { imageEditPath: input.imageEditPath }),
    ...(input.info.desc ? { description: input.info.desc } : {}),
  })
}

function accountProviderId(groupId: string): string {
  return `${ACCOUNT_PROVIDER_PREFIX}${createHash('sha256').update(groupId).digest('hex').slice(0, 24)}`
}

const transientCatalogFailureCodes = new Set([
  'network_error',
  'remote_unavailable',
  'timeout',
])

function isTransientCatalogFailure(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && transientCatalogFailureCodes.has(error.code)
  )
}

/**
 * NewAPI 中图片模型（gpt-image-2-*）的 supported_endpoint_types 声明为
 * ["openai"] 而非 ["image-generation"]，因为图片走 /v1/images/generations
 * 本身是 OpenAI 标准路径。通过 quota_type === 1（图片计费）识别这类模型，
 * 补充 relayModelIdsForEndpoint 按 endpoint 类型过滤时的遗漏。
 */
function pricingImageModelIds(
  pricing: RelayPricingDto,
  groupModelIds: readonly string[],
): readonly string[] {
  const modelSet = new Set(groupModelIds)
  return pricing.data
    .filter((entry) => entry.quota_type === 1 && modelSet.has(entry.model_name))
    .map((entry) => entry.model_name)
}
