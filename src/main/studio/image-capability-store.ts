import { createHash } from 'node:crypto'

import { z } from 'zod'

import { readJson, writePrivateJson } from './filesystem.ts'

const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const emptyFile = Object.freeze({ schemaVersion: 1 as const, entries: Object.freeze([]) })

const confirmationSchema = z.object({
  serverFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  groupId: z.string().trim().min(1).max(160),
  modelId: z.string().trim().min(1).max(256),
  imageGenerationPath: z.string().startsWith('/').max(2_048),
  confirmedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict()

const confirmationFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(confirmationSchema).max(2_000),
}).strict()

export interface ConfirmedStudioImageCapability {
  readonly groupId: string
  readonly modelId: string
  readonly imageGenerationPath: string
  readonly confirmedAt: number
  readonly expiresAt: number
}

export class StudioImageCapabilityStore {
  readonly #filePath: string | undefined
  readonly #serverFingerprint: string
  readonly #now: () => number
  readonly #entries = new Map<string, ConfirmedStudioImageCapability>()
  #loadPromise: Promise<void> | undefined

  constructor(serverOrigin: string, now: () => number = Date.now, filePath?: string) {
    this.#filePath = filePath
    this.#serverFingerprint = createHash('sha256')
      .update(serverOrigin.replace(/\/+$/u, '').toLowerCase())
      .digest('hex')
    this.#now = now
  }

  async list(): Promise<readonly ConfirmedStudioImageCapability[]> {
    await this.#load()
    this.#prune()
    return Object.freeze([...this.#entries.values()])
  }

  async get(groupId: string, modelId: string): Promise<ConfirmedStudioImageCapability | undefined> {
    await this.#load()
    this.#prune()
    return this.#entries.get(capabilityKey(groupId, modelId))
  }

  async remember(groupId: string, modelId: string, imageGenerationPath: string): Promise<ConfirmedStudioImageCapability> {
    await this.#load()
    const confirmedAt = this.#now()
    const capability = Object.freeze({
      groupId,
      modelId,
      imageGenerationPath,
      confirmedAt,
      expiresAt: confirmedAt + CONFIRMATION_TTL_MS,
    })
    this.#entries.set(capabilityKey(groupId, modelId), capability)
    await this.#persist().catch(() => undefined)
    return capability
  }

  async #load(): Promise<void> {
    if (this.#loadPromise) return await this.#loadPromise
    this.#loadPromise = this.#read()
    await this.#loadPromise
  }

  async #read(): Promise<void> {
    if (!this.#filePath) return
    let raw: unknown
    try {
      raw = await readJson(this.#filePath, emptyFile)
    } catch {
      return
    }
    const parsed = confirmationFileSchema.safeParse(raw)
    if (!parsed.success) return
    for (const entry of parsed.data.entries) {
      if (entry.serverFingerprint !== this.#serverFingerprint || entry.expiresAt <= this.#now()) continue
      const capability = Object.freeze({
        groupId: entry.groupId,
        modelId: entry.modelId,
        imageGenerationPath: entry.imageGenerationPath,
        confirmedAt: entry.confirmedAt,
        expiresAt: entry.expiresAt,
      })
      this.#entries.set(capabilityKey(entry.groupId, entry.modelId), capability)
    }
  }

  #prune(): void {
    const now = this.#now()
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key)
    }
  }

  async #persist(): Promise<void> {
    if (!this.#filePath) return
    this.#prune()
    await writePrivateJson(this.#filePath, {
      schemaVersion: 1,
      entries: [...this.#entries.values()].map((entry) => ({
        serverFingerprint: this.#serverFingerprint,
        ...entry,
      })),
    })
  }
}

const capabilityKey = (groupId: string, modelId: string): string => JSON.stringify([groupId, modelId])
