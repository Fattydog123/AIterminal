import type { ModelDescriptor } from '../../shared/contracts.ts'
import type { RelaySupportedEndpointDto } from './relay-service.ts'

export interface ConfirmedModelCatalog {
  readonly profileHandle: string
  readonly mode: 'chat' | 'agent'
  readonly groupId: string | null
  readonly generation: number
  readonly models: ModelDescriptor[]
  readonly endpointRoutes: Readonly<Record<string, Readonly<RelaySupportedEndpointDto>>>
}

export class ConfirmedModelCatalogStore {
  readonly #catalogs = new Map<string, ConfirmedModelCatalog>()
  readonly #profileGenerations = new Map<string, number>()

  generation(profileHandle: string): number {
    return this.#profileGenerations.get(profileHandle) ?? 0
  }

  get(
    profileHandle: string,
    mode: 'chat' | 'agent',
    groupId: string | null
  ): ConfirmedModelCatalog | undefined {
    return this.#catalogs.get(catalogKey(profileHandle, mode, groupId))
  }

  set(catalog: ConfirmedModelCatalog): void {
    this.#catalogs.set(
      catalogKey(catalog.profileHandle, catalog.mode, catalog.groupId),
      catalog
    )
  }

  isCurrent(catalog: ConfirmedModelCatalog): boolean {
    return this.get(catalog.profileHandle, catalog.mode, catalog.groupId) === catalog &&
      this.generation(catalog.profileHandle) === catalog.generation
  }

  clear(): void {
    this.#catalogs.clear()
    this.#profileGenerations.clear()
  }

  invalidateProfile(profileHandle: string): void {
    this.#profileGenerations.set(profileHandle, this.generation(profileHandle) + 1)
    for (const [key, catalog] of this.#catalogs) {
      if (catalog.profileHandle === profileHandle) this.#catalogs.delete(key)
    }
  }
}

function catalogKey(
  profileHandle: string,
  mode: 'chat' | 'agent',
  groupId: string | null
): string {
  return JSON.stringify([profileHandle, mode, groupId])
}
