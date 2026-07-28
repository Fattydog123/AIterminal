import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { assertRegularFile } from './filesystem.js'
import { ProjectStore } from './projects.js'

interface AssetGrant {
  readonly projectPath: string
  readonly relativePath: string
  readonly expiresAt: number
}

const grantLifetimeMs = 12 * 60 * 60 * 1_000
const maximumGrantCount = 10_000

export class AssetProtocol {
  readonly #grants = new Map<string, AssetGrant>()
  #installed = false

  constructor(private readonly projects: ProjectStore) {}

  install(): void {
    if (this.#installed) return
    this.#installed = true
    protocol.handle('aistudio', async (request) => {
      const url = new URL(request.url)
      if (url.hostname !== 'asset') return new Response('Not found', { status: 404 })
      const token = url.pathname.slice(1)
      const grant = this.#grants.get(token)
      if (!grant || grant.expiresAt < Date.now()) {
        this.#grants.delete(token)
        return new Response('Expired', { status: 410 })
      }
      try {
        const filePath = await this.projects.resolveExistingAsset(grant.projectPath, grant.relativePath)
        await assertRegularFile(filePath, 512 * 1024 * 1024)
        const mediaType = ({
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webp': 'image/webp', '.gif': 'image/gif',
        } as const)[path.extname(filePath).toLowerCase() as '.png' | '.jpg' | '.jpeg' | '.webp' | '.gif']
        if (!mediaType) return new Response('Unsupported media type', { status: 415 })
        const response = await net.fetch(pathToFileURL(filePath).toString())
        const headers = new Headers(response.headers)
        headers.set('Content-Type', mediaType)
        headers.set('Cache-Control', 'no-store')
        headers.set('X-Content-Type-Options', 'nosniff')
        return new Response(response.body, { status: response.status, headers })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }

  uninstall(): void {
    if (this.#installed) {
      protocol.unhandle('aistudio')
      this.#installed = false
    }
    this.#grants.clear()
  }

  grant(projectPath: string, relativePath: string): string {
    this.#prune()
    const token = crypto.randomUUID()
    this.#grants.set(token, { projectPath: path.resolve(projectPath), relativePath, expiresAt: Date.now() + grantLifetimeMs })
    while (this.#grants.size > maximumGrantCount) {
      const oldest = this.#grants.keys().next().value as string | undefined
      if (!oldest) break
      this.#grants.delete(oldest)
    }
    return `aistudio://asset/${token}`
  }

  #prune(): void {
    const now = Date.now()
    for (const [token, grant] of this.#grants) if (grant.expiresAt < now) this.#grants.delete(token)
  }
}
