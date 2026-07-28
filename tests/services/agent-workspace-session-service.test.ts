import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentWorkspaceSessionError,
  AgentWorkspaceSessionService,
  type AgentWorkspaceSessionStorage
} from '../../src/main/services/agent-workspace-session-service.ts'

const PROJECT_ID = `project:workspace:${Buffer.alloc(32, 7).toString('base64url')}`
const SECOND_PROJECT_ID = `project:workspace:${Buffer.alloc(32, 8).toString('base64url')}`

class MemoryStorage implements AgentWorkspaceSessionStorage {
  value: string | null = null
  readonly writes: string[] = []

  async read(): Promise<string | null> {
    return this.value
  }

  async write(value: string): Promise<void> {
    this.writes.push(value)
    this.value = value
  }
}

class FirstWriteGateStorage extends MemoryStorage {
  readonly firstWriteStarted: Promise<void>
  #notifyFirstWrite!: () => void
  #releaseFirstWrite!: () => void
  readonly #firstWriteRelease: Promise<void>

  constructor() {
    super()
    this.firstWriteStarted = new Promise((resolvePromise) => {
      this.#notifyFirstWrite = resolvePromise
    })
    this.#firstWriteRelease = new Promise((resolvePromise) => {
      this.#releaseFirstWrite = resolvePromise
    })
  }

  releaseFirstWrite(): void {
    this.#releaseFirstWrite()
  }

  override async write(value: string): Promise<void> {
    if (this.writes.length === 0) {
      this.#notifyFirstWrite()
      await this.#firstWriteRelease
    }
    await super.write(value)
  }
}

async function createDocumentsRoot(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-agent-workspace-'))
  t.after(async () => await fs.rm(root, { recursive: true, force: true }))
  return join(root, 'Documents')
}

test('provision creates a Codex-style dated workspace, work directory, and output directory', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const service = new AgentWorkspaceSessionService({
    documentsRoot,
    storage: new MemoryStorage(),
    clock: () => new Date(2026, 6, 22, 12, 0, 0).getTime()
  })

  const workspace = await service.provision({ prompt: 'Build a useful calculator with tests now' })

  assert.equal(workspace.displayName, 'build-a-useful-calculator-with-tests')
  assert.equal(
    workspace.absolutePath,
    await fs.realpath(join(documentsRoot, 'Codex', '2026-07-22', 'build-a-useful-calculator-with-tests'))
  )
  assert.equal((await fs.stat(workspace.absolutePath)).isDirectory(), true)
  assert.equal((await fs.stat(join(workspace.absolutePath, 'work'))).isDirectory(), true)
  assert.equal((await fs.stat(join(workspace.absolutePath, 'outputs'))).isDirectory(), true)
})

test('provision appends a stable numeric suffix without replacing existing entries', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const datedParent = join(documentsRoot, 'Codex', '2026-07-22')
  await fs.mkdir(join(datedParent, 'new-chat'), { recursive: true })
  await fs.writeFile(join(datedParent, 'new-chat-2'), 'existing', 'utf8')
  const service = new AgentWorkspaceSessionService({
    documentsRoot,
    storage: new MemoryStorage(),
    clock: () => new Date(2026, 6, 22, 12, 0, 0).getTime()
  })

  const workspace = await service.provision()

  assert.equal(workspace.displayName, 'new-chat-3')
  assert.equal((await fs.stat(workspace.absolutePath)).isDirectory(), true)
  assert.equal(await fs.readFile(join(datedParent, 'new-chat-2'), 'utf8'), 'existing')
})

test('a bound project resolves its canonical workspace after service restart', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const workspaceInput = join(documentsRoot, 'project', '..', 'project')
  await fs.mkdir(workspaceInput, { recursive: true })
  const canonicalPath = await fs.realpath(workspaceInput)
  const storage = new MemoryStorage()
  const first = new AgentWorkspaceSessionService({ documentsRoot, storage })

  await first.bindProject(PROJECT_ID, workspaceInput)

  const restarted = new AgentWorkspaceSessionService({ documentsRoot, storage })
  assert.deepEqual(await restarted.resolveProject(PROJECT_ID), {
    absolutePath: canonicalPath,
    displayName: 'project'
  })
})

test('forgetProject persists removal of an existing project binding', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const workspacePath = join(documentsRoot, 'forgotten-project')
  await fs.mkdir(workspacePath, { recursive: true })
  const storage = new MemoryStorage()
  const first = new AgentWorkspaceSessionService({ documentsRoot, storage })
  await first.bindProject(PROJECT_ID, workspacePath)

  await first.forgetProject(PROJECT_ID)

  const restarted = new AgentWorkspaceSessionService({ documentsRoot, storage })
  assert.equal(await restarted.resolveProject(PROJECT_ID), null)
})

test('resolveProject returns null when the canonical workspace directory is missing', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const workspacePath = join(documentsRoot, 'removed-project')
  await fs.mkdir(workspacePath, { recursive: true })
  const storage = new MemoryStorage()
  const service = new AgentWorkspaceSessionService({ documentsRoot, storage })
  await service.bindProject(PROJECT_ID, workspacePath)
  await fs.rm(workspacePath, { recursive: true })

  assert.equal(await service.resolveProject(PROJECT_ID), null)
})

test('corrupt and oversized persisted documents fail with a fixed path-free error', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const documents = [
    '{"private-path-marker":',
    'x'.repeat(300 * 1024)
  ]

  for (const value of documents) {
    const storage = new MemoryStorage()
    storage.value = value
    const service = new AgentWorkspaceSessionService({ documentsRoot, storage })
    await assert.rejects(service.resolveProject(PROJECT_ID), (error: unknown) => {
      assert.equal(error instanceof AgentWorkspaceSessionError, true)
      assert.equal((error as AgentWorkspaceSessionError).code, 'corrupt_storage')
      assert.doesNotMatch(String(error), /private-path-marker/u)
      return true
    })
  }
})

test('every project operation rejects malformed workspace project identifiers', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const workspacePath = join(documentsRoot, 'valid-project')
  await fs.mkdir(workspacePath, { recursive: true })
  const service = new AgentWorkspaceSessionService({ documentsRoot, storage: new MemoryStorage() })
  const invalidIds = [
    'project:workspace:short',
    `project:workspace:${'a'.repeat(42)}!`,
    `project:workspace:${'a'.repeat(43)}`
  ]

  for (const projectId of invalidIds) {
    for (const operation of [
      service.bindProject(projectId, workspacePath),
      service.resolveProject(projectId),
      service.forgetProject(projectId)
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.equal(error instanceof AgentWorkspaceSessionError, true)
        assert.equal((error as AgentWorkspaceSessionError).code, 'invalid_project_id')
        assert.equal(String(error).includes(projectId), false)
        return true
      })
    }
  }
})

test('concurrent project bindings are serialized without losing either workspace', async (t) => {
  const documentsRoot = await createDocumentsRoot(t)
  const firstPath = join(documentsRoot, 'first-project')
  const secondPath = join(documentsRoot, 'second-project')
  await Promise.all([
    fs.mkdir(firstPath, { recursive: true }),
    fs.mkdir(secondPath, { recursive: true })
  ])
  const storage = new FirstWriteGateStorage()
  const service = new AgentWorkspaceSessionService({ documentsRoot, storage })

  const firstBinding = service.bindProject(PROJECT_ID, firstPath)
  await storage.firstWriteStarted
  const secondBinding = service.bindProject(SECOND_PROJECT_ID, secondPath)
  storage.releaseFirstWrite()
  await Promise.all([firstBinding, secondBinding])

  const restarted = new AgentWorkspaceSessionService({ documentsRoot, storage })
  assert.equal((await restarted.resolveProject(PROJECT_ID))?.displayName, 'first-project')
  assert.equal((await restarted.resolveProject(SECOND_PROJECT_ID))?.displayName, 'second-project')
})
