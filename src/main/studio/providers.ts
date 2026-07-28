import type {
  OpenAiProviderDescriptor,
  ProviderDescriptor,
  ProviderDraft,
} from '../../studio/shared/types.ts'
import type { StudioManagedProviderSource } from './account-providers.ts'
import { StudioError } from './errors.ts'

const managedProviderIdPrefix = 'account-group-'

const accountProviderOnlyError = (): StudioError => new StudioError(
  'studio-account-provider-required',
  'Studio 仅允许使用当前账户分组，独立 Provider 配置已禁用',
)

const managedProviderReadOnlyError = (): StudioError => new StudioError(
  'managed-provider-read-only',
  '登录账户分组由 AI-terminal 会话管理，不能覆盖或删除',
)

export interface OpenAiProviderCredentials {
  readonly descriptor: OpenAiProviderDescriptor
  readonly apiKey: string
}

// Kept as a compatibility type for callers that narrow credentials by apiKey.
// Studio never creates or returns this variant; all runtime credentials come
// from the authenticated NewAPI account adapter above.
export interface ComfyUiProviderCredentials {
  readonly descriptor: Extract<ProviderDescriptor, { kind: 'comfyui' }>
}

export type ProviderCredentials = OpenAiProviderCredentials | ComfyUiProviderCredentials

/**
 * Studio's provider boundary is intentionally account-only. Legacy local
 * provider files are not read, listed, mutated, probed, or used for runs.
 */
export class ProviderStore {
  readonly #managedProviders: StudioManagedProviderSource | undefined
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(
    _stateDirectory: string,
    managedProviders?: StudioManagedProviderSource,
  ) {
    this.#managedProviders = managedProviders
  }

  async initialize(): Promise<void> {
    // Local provider persistence was removed from the product path. Keep this
    // lifecycle method so runtime construction remains explicit and stable.
  }

  async canPersistSecrets(): Promise<boolean> {
    return false
  }

  async list(): Promise<readonly ProviderDescriptor[]> {
    return this.#mutate(async () => {
      const providers = await this.#managedProviders?.list() ?? []
      // Project only exposes descriptors explicitly marked as account-owned;
      // an unexpected legacy descriptor is dropped before it reaches IPC.
      return providers.filter((provider) => provider.managedBy === 'ai-terminal-account')
    })
  }

  async upsert(_input: ProviderDraft): Promise<ProviderDescriptor> {
    throw accountProviderOnlyError()
  }

  async delete(providerId: string): Promise<boolean> {
    if (this.#managedProviders?.owns(providerId) || providerId.startsWith(managedProviderIdPrefix)) {
      throw managedProviderReadOnlyError()
    }
    throw accountProviderOnlyError()
  }

  async descriptor(providerId: string): Promise<ProviderDescriptor> {
    return this.#mutate(async () => {
      if (!this.#managedProviders?.owns(providerId)) throw accountProviderOnlyError()
      const descriptor = await this.#managedProviders.descriptor(providerId)
      if (!descriptor) {
        throw new StudioError('provider-not-found', '登录账户分组不存在或已发生变化，请刷新账户分组')
      }
      if (descriptor.managedBy !== 'ai-terminal-account') throw accountProviderOnlyError()
      return descriptor
    })
  }

  async credentials(providerId: string, modelId?: string): Promise<ProviderCredentials> {
    return this.#mutate(async () => {
      if (!this.#managedProviders?.owns(providerId)) throw accountProviderOnlyError()
      const credentials = await this.#managedProviders.credentials(providerId, modelId)
      if (credentials.descriptor.managedBy !== 'ai-terminal-account') throw accountProviderOnlyError()
      return credentials
    })
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.#mutationTail.catch(() => undefined).then(operation)
    this.#mutationTail = running.then(() => undefined, () => undefined)
    return running
  }
}
