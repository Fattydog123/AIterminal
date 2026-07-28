import { createHash, randomUUID } from 'node:crypto'
import { parseProviderImportUrl } from '../../studio/core/providerImport.js'
import type { ProviderDescriptor, ProviderDraft, ProviderImportPreview } from '../../studio/shared/types.js'
import { StudioError } from './errors.js'

const importLifetimeMs = 10 * 60 * 1_000
const importLimit = 20

export interface ProviderImportStore {
  list(): Promise<readonly ProviderDescriptor[]>
  upsert(input: ProviderDraft): Promise<ProviderDescriptor>
  canPersistSecrets(): Promise<boolean>
}

interface PendingProviderImport {
  readonly preview: ProviderImportPreview
  readonly draft: ProviderDraft
  readonly fingerprint: string
}

const slug = (value: string): string => value
  .normalize('NFKD')
  .replace(/[^a-zA-Z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)
  .toLowerCase() || 'provider'

const publicFingerprint = (name: string, baseUrl: string, model: string, secret: string): string =>
  createHash('sha256').update(`${name}\0${baseUrl}\0${model}\0${secret}`).digest('hex')

const importedProviderId = (name: string, baseUrl: string): string => {
  const suffix = createHash('sha256').update(baseUrl).digest('hex').slice(0, 10)
  return `import-${slug(name)}-${suffix}`.slice(0, 160)
}

export class ProviderImportController {
  readonly #pending = new Map<string, PendingProviderImport>()

  constructor(
    private readonly providers: ProviderImportStore,
    private readonly now: () => number = Date.now,
  ) {}

  async stageDeepLink(raw: string): Promise<ProviderImportPreview> {
    this.#prune()
    const parsed = parseProviderImportUrl(raw)
    const fingerprint = publicFingerprint(parsed.name, parsed.baseUrl, parsed.defaultModel, parsed.apiKey)
    const duplicate = [...this.#pending.values()].find((item) => item.fingerprint === fingerprint)
    if (duplicate) return duplicate.preview
    if (this.#pending.size >= importLimit) throw new StudioError('provider-import-limit', '待确认接口导入请求过多，请先处理已有请求')

    const existing = await this.providers.list()
    const occupied = new Set(existing.map((provider) => provider.id))
    let targetProviderId = importedProviderId(parsed.name, parsed.baseUrl)
    const baseId = targetProviderId
    let suffix = 2
    while (occupied.has(targetProviderId)) {
      targetProviderId = `${baseId.slice(0, 154)}-${suffix}`
      suffix += 1
    }
    const createdAt = this.now()
    const requestId = randomUUID()
    const preview: ProviderImportPreview = {
      requestId,
      source: 'aiterminal-link',
      mode: 'create',
      targetProviderId,
      name: parsed.name,
      baseUrl: parsed.baseUrl,
      defaultModel: parsed.defaultModel,
      hasSecret: true,
      expiresAt: new Date(createdAt + importLifetimeMs).toISOString(),
    }
    const draft: ProviderDraft = {
      id: targetProviderId,
      name: parsed.name,
      kind: 'openai-compatible',
      baseUrl: parsed.baseUrl,
      defaultModel: parsed.defaultModel,
      timeoutMs: 300_000,
      maxImageBytes: 104_857_600,
      proxyMode: 'system',
      secretUpdate: parsed.apiKey,
    }
    this.#pending.set(requestId, { preview, draft, fingerprint })
    return preview
  }

  list(): readonly ProviderImportPreview[] {
    this.#prune()
    return [...this.#pending.values()].map((item) => item.preview)
  }

  async accept(requestId: string): Promise<ProviderDescriptor> {
    this.#prune()
    const pending = this.#pending.get(requestId)
    if (!pending) throw new StudioError('provider-import-expired', '接口导入请求不存在或已过期，请重新打开导入链接')
    if (!(await this.providers.canPersistSecrets())) {
      throw new StudioError('provider-import-encryption-unavailable', '系统加密存储当前不可用，已停止导入以避免密钥只保存在临时内存')
    }
    const saved = await this.providers.upsert(pending.draft)
    this.#pending.delete(requestId)
    return saved
  }

  dismiss(requestId: string): boolean {
    this.#prune()
    return this.#pending.delete(requestId)
  }

  #prune(): void {
    const now = this.now()
    for (const [requestId, item] of this.#pending) {
      if (Date.parse(item.preview.expiresAt) <= now) this.#pending.delete(requestId)
    }
  }
}
