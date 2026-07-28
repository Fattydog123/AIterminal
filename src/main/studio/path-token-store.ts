import { randomBytes } from 'node:crypto'
import path from 'node:path'

const TOKEN_BYTES = 32
const MAX_PROJECT_TOKENS = 128
const PROJECT_TOKEN_PREFIX = 'studio-project:'

interface ProjectGrant {
  readonly absolutePath: string
}

export class StudioPathTokenError extends Error {
  constructor() {
    super('Studio path authorization is invalid or expired.')
    this.name = 'StudioPathTokenError'
    this.stack = `${this.name}: ${this.message}`
  }
}

/**
 * Keeps absolute Studio project paths in Main. Renderer receives only opaque,
 * per-window capability tokens and cannot mint or persist a filesystem grant.
 */
export class StudioPathTokenStore {
  readonly #projectGrants = new Map<string, ProjectGrant>()
  readonly #projectTokensByPath = new Map<string, string>()

  issueProject(absolutePath: string): string {
    const resolved = path.resolve(absolutePath)
    const key = pathKey(resolved)
    const existing = this.#projectTokensByPath.get(key)
    if (existing && this.#projectGrants.has(existing)) return existing

    const token = issueToken(PROJECT_TOKEN_PREFIX)
    this.#projectGrants.set(token, { absolutePath: resolved })
    this.#projectTokensByPath.set(key, token)
    while (this.#projectGrants.size > MAX_PROJECT_TOKENS) {
      const oldest = this.#projectGrants.keys().next().value as string | undefined
      if (!oldest) break
      const grant = this.#projectGrants.get(oldest)
      this.#projectGrants.delete(oldest)
      if (grant) this.#projectTokensByPath.delete(pathKey(grant.absolutePath))
    }
    return token
  }

  resolveProject(token: string): string {
    const grant = this.#projectGrants.get(token)
    if (!grant) throw new StudioPathTokenError()
    return grant.absolutePath
  }

  revokeAll(): void {
    this.#projectGrants.clear()
    this.#projectTokensByPath.clear()
  }
}

function issueToken(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

function pathKey(absolutePath: string): string {
  return process.platform === 'win32' ? absolutePath.toLocaleLowerCase('en-US') : absolutePath
}
