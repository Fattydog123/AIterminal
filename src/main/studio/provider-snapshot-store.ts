import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { OpenAiProviderDescriptor } from '../../studio/shared/types.ts'
import {
  buildImagesEditRequestUrl,
  buildImagesGenerationRequestUrl,
} from '../services/images-client.ts'
import { readJson, writePrivateJson } from './filesystem.ts'

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000
const IMAGE_GENERATION_SUFFIX = '/images/generations'
const emptyFile = null

const modelIdSchema = z.string().trim().min(1).max(256)
const endpointPathSchema = z.string().startsWith('/').max(2_048)
const providerDescriptorSchema = z.object({
  id: z.string().regex(/^account-group-[a-f0-9]{24}$/u),
  name: z.string().trim().min(1).max(160),
  kind: z.literal('openai-compatible'),
  baseUrl: z.string().url().max(2_048),
  defaultModel: modelIdSchema,
  timeoutMs: z.literal(300_000),
  maxImageBytes: z.literal(104_857_600),
  proxyMode: z.literal('system'),
  hasSecret: z.literal(true),
  maskedSecret: z.literal('账户会话'),
  managedBy: z.literal('ai-terminal-account'),
  groupId: z.string().trim().min(1).max(160),
  availableModels: z.array(modelIdSchema).min(1).max(2_000),
  description: z.string().trim().min(1).max(4_096).optional(),
  confirmedOnlyModels: z.array(modelIdSchema).max(2_000).optional(),
  imageGenerationPath: endpointPathSchema,
  imageEditPath: endpointPathSchema.optional(),
}).strict().superRefine((descriptor, context) => {
  const availableModels = new Set(descriptor.availableModels)
  if (availableModels.size !== descriptor.availableModels.length) {
    context.addIssue({ code: 'custom', message: 'availableModels contains duplicates' })
  }
  if (!availableModels.has(descriptor.defaultModel)) {
    context.addIssue({ code: 'custom', message: 'defaultModel is unavailable' })
  }
  const confirmedOnlyModels = descriptor.confirmedOnlyModels ?? []
  if (new Set(confirmedOnlyModels).size !== confirmedOnlyModels.length) {
    context.addIssue({ code: 'custom', message: 'confirmedOnlyModels contains duplicates' })
  }
  if (confirmedOnlyModels.some((modelId) => !availableModels.has(modelId))) {
    context.addIssue({ code: 'custom', message: 'confirmedOnlyModels is not a subset' })
  }
  if (descriptor.name !== descriptor.groupId || descriptor.id !== accountProviderId(descriptor.groupId)) {
    context.addIssue({ code: 'custom', message: 'provider identity does not match its group' })
  }
  const expectedEditPath = descriptor.imageGenerationPath.endsWith(IMAGE_GENERATION_SUFFIX)
    ? `${descriptor.imageGenerationPath.slice(0, -IMAGE_GENERATION_SUFFIX.length)}/images/edits`
    : undefined
  if (descriptor.imageEditPath !== expectedEditPath) {
    context.addIssue({ code: 'custom', message: 'imageEditPath does not match imageGenerationPath' })
  }
})

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  serverFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  savedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  providers: z.array(providerDescriptorSchema).max(256),
}).strict()

export class StudioProviderSnapshotStore {
  readonly #filePath: string
  readonly #serverFingerprint: string
  readonly #expectedBaseUrl: string
  readonly #now: () => number

  constructor(serverOrigin: string, filePath: string, now: () => number = Date.now) {
    const normalizedOrigin = serverOrigin.replace(/\/+$/u, '')
    this.#filePath = filePath
    this.#serverFingerprint = createHash('sha256')
      .update(normalizedOrigin.toLowerCase())
      .digest('hex')
    this.#expectedBaseUrl = `${normalizedOrigin}/v1`
    this.#now = now
  }

  async load(): Promise<readonly OpenAiProviderDescriptor[] | undefined> {
    let raw: unknown
    try {
      raw = await readJson(this.#filePath, emptyFile)
    } catch {
      return undefined
    }
    const parsed = snapshotSchema.safeParse(raw)
    if (!parsed.success) return undefined
    const now = this.#now()
    if (
      parsed.data.serverFingerprint !== this.#serverFingerprint
      || parsed.data.expiresAt <= now
      || parsed.data.expiresAt <= parsed.data.savedAt
      || parsed.data.expiresAt - parsed.data.savedAt > SNAPSHOT_TTL_MS
      || parsed.data.savedAt > now + MAX_CLOCK_SKEW_MS
    ) return undefined
    if (parsed.data.providers.some((provider) => (
      provider.baseUrl !== this.#expectedBaseUrl || !hasValidImageRoutes(provider)
    ))) return undefined
    return freezeDescriptors(parsed.data.providers)
  }

  async save(providers: readonly OpenAiProviderDescriptor[]): Promise<void> {
    const projected = providers.map(projectDescriptor)
    const parsedProviders = z.array(providerDescriptorSchema).max(256).parse(projected)
    if (parsedProviders.some((provider) => (
      provider.baseUrl !== this.#expectedBaseUrl || !hasValidImageRoutes(provider)
    ))) throw new Error('Studio provider snapshot contains an invalid route')
    const savedAt = this.#now()
    await writePrivateJson(this.#filePath, {
      schemaVersion: 1,
      serverFingerprint: this.#serverFingerprint,
      savedAt,
      expiresAt: savedAt + SNAPSHOT_TTL_MS,
      providers: parsedProviders,
    })
  }
}

function projectDescriptor(provider: OpenAiProviderDescriptor): unknown {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    timeoutMs: provider.timeoutMs,
    maxImageBytes: provider.maxImageBytes,
    proxyMode: provider.proxyMode,
    hasSecret: provider.hasSecret,
    maskedSecret: provider.maskedSecret,
    managedBy: provider.managedBy,
    groupId: provider.groupId,
    availableModels: provider.availableModels,
    ...(provider.description === undefined ? {} : { description: provider.description }),
    ...(provider.confirmedOnlyModels === undefined
      ? {}
      : { confirmedOnlyModels: provider.confirmedOnlyModels }),
    ...(provider.imageGenerationPath === undefined
      ? {}
      : { imageGenerationPath: provider.imageGenerationPath }),
    ...(provider.imageEditPath === undefined ? {} : { imageEditPath: provider.imageEditPath }),
  }
}

function freezeDescriptors(
  providers: readonly z.output<typeof providerDescriptorSchema>[],
): readonly OpenAiProviderDescriptor[] {
  return Object.freeze(providers.map((provider) => Object.freeze({
    ...provider,
    availableModels: Object.freeze([...provider.availableModels]),
    ...(provider.confirmedOnlyModels === undefined
      ? {}
      : { confirmedOnlyModels: Object.freeze([...provider.confirmedOnlyModels]) }),
  })))
}

function hasValidImageRoutes(provider: z.output<typeof providerDescriptorSchema>): boolean {
  try {
    if (provider.imageGenerationPath !== undefined) {
      buildImagesGenerationRequestUrl(provider.baseUrl, provider.imageGenerationPath)
    }
    if (provider.imageEditPath !== undefined) {
      buildImagesEditRequestUrl(provider.baseUrl, provider.imageEditPath)
    }
    return true
  } catch {
    return false
  }
}

function accountProviderId(groupId: string): string {
  return `${'account-group-'}${createHash('sha256').update(groupId).digest('hex').slice(0, 24)}`
}
