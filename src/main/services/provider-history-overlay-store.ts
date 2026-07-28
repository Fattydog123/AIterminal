import { promises as fsPromises } from 'node:fs'
import { dirname } from 'node:path'

/**
 * App-local overlay over read-only provider history (Codex app-server threads,
 * ~/.claude / ~/.gemini / ~/.grok session files). The provider's own data is
 * never touched: "delete" hides the entry from this app's listing and
 * "archive" records an app-side archive timestamp. Losing this file loses only
 * those two UI marks, so plain JSON is sufficient.
 */

const MAX_OVERLAY_ENTRIES = 2_000
const PROVIDER_TASK_ID_PATTERN = /^(?:codex|claude|gemini|grok):[A-Za-z0-9_-]{1,128}$/u

interface OverlayDocument {
  version: 1
  hidden: string[]
  archived: Record<string, string>
}

const EMPTY_DOCUMENT: OverlayDocument = Object.freeze({ version: 1, hidden: [], archived: {} })

export class ProviderHistoryOverlayStore {
  readonly #filePath: string
  readonly #now: () => number
  #hidden = new Set<string>()
  #archived = new Map<string, string>()
  #loaded: Promise<void> | null = null
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string, now: () => number = Date.now) {
    this.#filePath = filePath
    this.#now = now
  }

  static isOverlayTaskId(taskId: string): boolean {
    return PROVIDER_TASK_ID_PATTERN.test(taskId)
  }

  async isHidden(taskId: string): Promise<boolean> {
    await this.#ensureLoaded()
    return this.#hidden.has(taskId)
  }

  async archivedAt(taskId: string): Promise<string | null> {
    await this.#ensureLoaded()
    return this.#archived.get(taskId) ?? null
  }

  /** Hides the entry from this app's listing. Provider files stay untouched. */
  async hide(taskId: string): Promise<void> {
    if (!ProviderHistoryOverlayStore.isOverlayTaskId(taskId)) throw new ProviderHistoryOverlayError()
    await this.#ensureLoaded()
    this.#hidden.add(taskId)
    this.#archived.delete(taskId)
    this.#trim()
    await this.#persist()
  }

  async setArchived(taskId: string, archived: boolean): Promise<string | null> {
    if (!ProviderHistoryOverlayStore.isOverlayTaskId(taskId)) throw new ProviderHistoryOverlayError()
    await this.#ensureLoaded()
    let archivedAt: string | null = null
    if (archived) {
      archivedAt = new Date(this.#now()).toISOString()
      this.#archived.set(taskId, archivedAt)
    } else {
      this.#archived.delete(taskId)
    }
    this.#trim()
    await this.#persist()
    return archivedAt
  }

  async #ensureLoaded(): Promise<void> {
    this.#loaded ??= this.#loadOnce()
    await this.#loaded
  }

  async #loadOnce(): Promise<void> {
    let document = EMPTY_DOCUMENT
    try {
      const parsed: unknown = JSON.parse(await fsPromises.readFile(this.#filePath, 'utf8'))
      if (isOverlayDocument(parsed)) document = parsed
    } catch {
      // Missing or corrupt overlay degrades to "nothing hidden, nothing archived".
    }
    this.#hidden = new Set(document.hidden.filter((id) => ProviderHistoryOverlayStore.isOverlayTaskId(id)))
    this.#archived = new Map(Object.entries(document.archived).filter(([id, at]) => (
      ProviderHistoryOverlayStore.isOverlayTaskId(id) && typeof at === 'string'
    )))
  }

  #trim(): void {
    while (this.#hidden.size > MAX_OVERLAY_ENTRIES) {
      const oldest = this.#hidden.values().next().value
      if (oldest === undefined) break
      this.#hidden.delete(oldest)
    }
    while (this.#archived.size > MAX_OVERLAY_ENTRIES) {
      const oldest = this.#archived.keys().next().value
      if (oldest === undefined) break
      this.#archived.delete(oldest)
    }
  }

  async #persist(): Promise<void> {
    const document: OverlayDocument = {
      version: 1,
      hidden: [...this.#hidden],
      archived: Object.fromEntries(this.#archived),
    }
    const serialized = JSON.stringify(document)
    this.#writeQueue = this.#writeQueue.then(async () => {
      await fsPromises.mkdir(dirname(this.#filePath), { recursive: true })
      const temporary = `${this.#filePath}.tmp`
      await fsPromises.writeFile(temporary, serialized, 'utf8')
      await fsPromises.rename(temporary, this.#filePath)
    })
    await this.#writeQueue
  }
}

export class ProviderHistoryOverlayError extends Error {
  constructor() {
    super('The task id is not a provider-history id.')
    this.name = 'ProviderHistoryOverlayError'
  }
}

function isOverlayDocument(value: unknown): value is OverlayDocument {
  return typeof value === 'object' && value !== null &&
    (value as OverlayDocument).version === 1 &&
    Array.isArray((value as OverlayDocument).hidden) &&
    (value as OverlayDocument).hidden.every((entry) => typeof entry === 'string') &&
    typeof (value as OverlayDocument).archived === 'object' &&
    (value as OverlayDocument).archived !== null
}
