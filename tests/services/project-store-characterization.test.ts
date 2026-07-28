import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import test, { type TestContext } from 'node:test'
import type {
  GeneratedAsset,
  ParameterPresetRecord,
  ProjectPluginRecord,
  TaskRecord,
  WorkflowDocument,
} from '../../src/studio/shared/types.ts'
import type { PersistentRunQueueItem } from '../../src/main/studio/projects.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return nextResolve(new URL('../security/fixtures/electron-main-stub.ts', import.meta.url).href, context)
    }
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { ProjectStore } = await import('../../src/main/studio/projects.ts')

const timestamp = '2026-07-21T00:00:00.000Z'

const workflowFixture = (overrides: Partial<WorkflowDocument> = {}): WorkflowDocument => ({
  schemaVersion: 3,
  id: 'workflow-main',
  name: 'Main workflow',
  revision: 0,
  nodes: [],
  edges: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: { fixture: 'project-store-characterization' },
  presentation: {},
  subgraphs: [],
  ...overrides,
})

interface Harness {
  readonly directory: string
  readonly projectsDirectory: string
  readonly stateDirectory: string
  readonly store: InstanceType<typeof ProjectStore>
}

const createHarness = async (t: TestContext): Promise<Harness> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-terminal-project-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const projectsDirectory = path.join(directory, 'projects')
  const stateDirectory = path.join(directory, 'state')
  await mkdir(projectsDirectory, { recursive: true })
  const store = new ProjectStore(stateDirectory)
  await store.initialize()
  return { directory, projectsDirectory, stateDirectory, store }
}

const createProject = async (harness: Harness, workflow = workflowFixture()) => {
  const summary = await harness.store.create('Characterization Project', harness.projectsDirectory, workflow)
  return { summary, root: summary.path, workflow: await harness.store.loadWorkflow(summary.path, workflow.id) }
}

const hasStudioCode = (code: string) => (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error as Error & { code: string }).code === code

const taskFixture = (
  projectId: string,
  id: string,
  status: TaskRecord['status'],
  dispatchState?: TaskRecord['dispatchState'],
): TaskRecord => ({
  id,
  runId: `run-${id}`,
  projectId,
  workflowId: 'workflow-main',
  nodeId: 'node-main',
  status,
  ...(dispatchState ? { dispatchState } : {}),
  progress: status === 'succeeded' ? 1 : 0.25,
  message: `before recovery: ${id}`,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const queueFixture = (
  projectId: string,
  workflow: WorkflowDocument,
  id: string,
  status: PersistentRunQueueItem['status'],
  dispatchState?: PersistentRunQueueItem['dispatchState'],
): PersistentRunQueueItem => ({
  schemaVersion: 1,
  id,
  projectId,
  workflowId: workflow.id,
  status,
  priority: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  workflow,
  targetNodeIds: [],
  overrides: {},
  attempt: 0,
  ...(dispatchState ? { dispatchState } : {}),
})

const assetFixture = (
  projectId: string,
  id: string,
  decision: GeneratedAsset['decision'] = 'pending',
): GeneratedAsset => ({
  id,
  projectId,
  workflowId: 'workflow-main',
  nodeId: 'node-main',
  relativePath: `outputs/${id}.png`,
  prompt: `prompt for ${id}`,
  providerId: 'provider-main',
  model: 'model-main',
  width: 64,
  height: 64,
  createdAt: timestamp,
  favorite: false,
  decision,
  candidateGroupId: 'candidate-group-main',
  operation: 'generate',
  tags: [],
})

const pluginFixture = (): ProjectPluginRecord => ({
  manifest: {
    schemaVersion: 1,
    id: 'plugin.characterization',
    name: 'Characterization Plugin',
    version: '1.2.3',
    hostVersion: '0.1.2',
    permissions: ['project-read'],
    nodeTypes: ['image.characterization'],
    dependencies: {},
  },
  enabled: true,
  versionLock: '1.2.3',
  grantedPermissions: ['project-read'],
})

const presetFixture = (id: string, name = id): ParameterPresetRecord => ({
  id,
  name,
  modelPatterns: ['model-*'],
  values: { 'parameters.seed': 42 },
  tags: ['characterization'],
})

test('opens the legacy project filename and migrates a legacy workflow through the ProjectStore interface', async (t) => {
  const harness = await createHarness(t)
  const root = path.join(harness.projectsDirectory, 'Legacy Project')
  const workflowsDirectory = path.join(root, 'workflows')
  await mkdir(workflowsDirectory, { recursive: true })
  await writeFile(path.join(root, 'studio.project.json'), JSON.stringify({
    version: 1,
    id: 'legacy-project',
    name: 'Legacy Project',
    created_at: '2024-01-02T03:04:05.000Z',
    updated_at: '2024-02-03T04:05:06.000Z',
    legacy_project_extension: 'retained-on-disk',
  }))
  await writeFile(path.join(workflowsDirectory, 'legacy-workflow.json'), JSON.stringify({
    version: 1,
    id: 'legacy-workflow',
    name: 'Legacy Workflow',
    revision: 4,
    nodes: [],
    edges: [],
    createdAt: '2024-01-02T03:04:05.000Z',
    updatedAt: '2024-02-03T04:05:06.000Z',
    metadata: { migratedFrom: 'legacy-v1' },
    presentation: {},
    legacyWorkflowExtension: { retained: true },
  }))

  const summary = await harness.store.open(path.join(root, 'studio.project.json'))
  const workflow = await harness.store.loadWorkflow(root, 'legacy-workflow')

  assert.deepEqual(summary, {
    id: 'legacy-project',
    name: 'Legacy Project',
    path: path.resolve(root),
    updatedAt: '2024-02-03T04:05:06.000Z',
    workflowCount: 1,
    assetCount: 0,
  })
  assert.equal(workflow.schemaVersion, 3)
  assert.equal(workflow.id, 'legacy-workflow')
  assert.equal(workflow.revision, 4)
  assert.deepEqual(workflow.metadata, { migratedFrom: 'legacy-v1' })
  assert.deepEqual(
    (workflow as WorkflowDocument & { legacyWorkflowExtension: unknown }).legacyWorkflowExtension,
    { retained: true },
  )
})

test('managed projects are created, discovered and reopened from the app-owned root', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-terminal-managed-projects-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const managedRoot = path.join(directory, 'Documents', 'Codex', 'Studio')
  const externalRoot = path.join(directory, 'external')
  const store = new ProjectStore(path.join(directory, 'state'), managedRoot)
  await store.initialize()
  await mkdir(path.join(managedRoot, 'not-a-project'))
  await mkdir(externalRoot)

  const first = await store.createManaged('First managed', workflowFixture({ id: 'workflow-first' }))
  const second = await store.createManaged('Second managed', workflowFixture({ id: 'workflow-second' }))
  await store.create('External project', externalRoot, workflowFixture({ id: 'workflow-external' }))

  assert.deepEqual((await store.listManaged()).map((project) => project.id).sort(), [first.id, second.id].sort())
  assert.equal(await store.recentManagedProjectPath(), second.path)

  await store.openManaged(first.path)
  assert.equal(await store.recentManagedProjectPath(), first.path)
  await assert.rejects(
    store.openManaged(path.join(externalRoot, 'External project')),
    hasStudioCode('managed-project-required'),
  )
})

test('legacy workflow paths remain stable through save and archive while restore uses the canonical path', async (t) => {
  const harness = await createHarness(t)
  const { root, workflow: original } = await createProject(harness)
  await harness.store.duplicateWorkflow(root, original.id, 'Keep project non-empty')

  const canonicalPath = path.join(root, 'workflows', `${original.id}.workflow.json`)
  const legacyPath = path.join(root, 'workflows', `${original.id}.json`)
  const persisted = JSON.parse(await readFile(canonicalPath, 'utf8')) as Record<string, unknown>
  await writeFile(legacyPath, JSON.stringify({ ...persisted, legacyWorkflowExtension: { retained: true } }))
  await rm(canonicalPath)

  const loaded = await harness.store.loadWorkflow(root, original.id)
  const saved = await harness.store.saveWorkflow(root, { ...loaded, name: 'Saved at legacy path' })
  const legacySaved = JSON.parse(await readFile(legacyPath, 'utf8')) as Record<string, unknown>
  assert.equal(legacySaved.name, 'Saved at legacy path')
  assert.deepEqual(legacySaved.legacyWorkflowExtension, { retained: true })
  await assert.rejects(readFile(canonicalPath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT')

  assert.equal(await harness.store.archiveWorkflow(root, saved.id), true)
  const archived = (await harness.store.listArchivedWorkflows(root)).find((item) => item.workflowId === saved.id)
  assert.ok(archived)
  const restored = await harness.store.restoreArchivedWorkflow(root, archived.archiveId)
  assert.equal(restored.name, 'Saved at legacy path')
  assert.deepEqual(
    (restored as WorkflowDocument & { legacyWorkflowExtension: unknown }).legacyWorkflowExtension,
    { retained: true },
  )
  assert.equal(JSON.parse(await readFile(canonicalPath, 'utf8')).name, 'Saved at legacy path')
})

test('formal saves advance CAS revisions, reject stale saves, and keep historic versions immutable', async (t) => {
  const harness = await createHarness(t)
  const { root, workflow: original } = await createProject(harness)

  const revisionOne = await harness.store.saveWorkflow(root, { ...original, name: 'Revision one' })
  const immutableRevisionOne = await harness.store.loadWorkflowVersion(root, original.id, 1)
  const revisionTwo = await harness.store.saveWorkflow(root, { ...revisionOne, name: 'Revision two' })

  assert.equal(revisionOne.revision, 1)
  assert.equal(revisionTwo.revision, 2)
  assert.equal((await harness.store.loadWorkflow(root, original.id)).name, 'Revision two')
  assert.equal(immutableRevisionOne.name, 'Revision one')
  assert.equal((await harness.store.loadWorkflowVersion(root, original.id, 1)).name, 'Revision one')
  assert.deepEqual(
    (await harness.store.listWorkflowVersions(root, original.id)).map(({ revision, name }) => ({ revision, name })),
    [
      { revision: 2, name: 'Revision two' },
      { revision: 1, name: 'Revision one' },
      { revision: 0, name: 'Main workflow' },
    ],
  )

  await assert.rejects(
    harness.store.saveWorkflow(root, { ...original, name: 'Stale overwrite' }),
    hasStudioCode('workflow-revision-conflict'),
  )
  assert.equal((await harness.store.loadWorkflow(root, original.id)).name, 'Revision two')
  assert.equal((await harness.store.loadWorkflowVersion(root, original.id, 1)).name, 'Revision one')
})

test('drafts survive a ProjectStore restart without changing the formal workflow and can be discarded', async (t) => {
  const harness = await createHarness(t)
  const { root, workflow: formal } = await createProject(harness)
  const draftWorkflow = {
    ...formal,
    name: 'Unsaved draft',
    metadata: { ...formal.metadata, draftValue: 'recover me' },
  }

  const savedDraft = await harness.store.saveWorkflowDraft(root, draftWorkflow)
  const restartedStore = new ProjectStore(harness.stateDirectory)
  await restartedStore.initialize()
  const recoveredDraft = await restartedStore.loadWorkflowDraft(root, formal.id)

  assert.equal(savedDraft.baseRevision, formal.revision)
  assert.equal(recoveredDraft?.workflow.name, 'Unsaved draft')
  assert.equal((await restartedStore.loadWorkflow(root, formal.id)).name, 'Main workflow')
  assert.equal(await restartedStore.discardWorkflowDraft(root, formal.id), true)
  assert.equal(await restartedStore.loadWorkflowDraft(root, formal.id), undefined)
  assert.equal(await restartedStore.discardWorkflowDraft(root, formal.id), false)
})

test('asset catalog and collections round-trip through restart with candidate and membership invariants', async (t) => {
  const harness = await createHarness(t)
  const { root, summary } = await createProject(harness)
  const first = assetFixture(summary.id, 'asset-first', 'adopted')
  const second = assetFixture(summary.id, 'asset-second')
  await harness.store.appendAssets(root, [first, second])

  const adopted = await harness.store.updateAsset(root, second.id, {
    favorite: true,
    decision: 'adopted',
    tags: [' selected ', 'selected', 'reviewed'],
  })
  assert.deepEqual(adopted.tags, ['selected', 'reviewed'])
  await assert.rejects(harness.store.appendAssets(root, [second]), hasStudioCode('duplicate-asset'))

  const board = await harness.store.upsertBoard(root, {
    id: 'board-main',
    name: 'Board main',
    description: 'Characterization board',
    assetIds: [first.id, second.id, first.id],
  })
  const smart = await harness.store.upsertSmartCollection(root, {
    id: 'smart-main',
    name: 'Smart main',
    models: ['model-main', 'model-main'],
    workflowIds: ['workflow-main', 'workflow-main'],
    tags: ['reviewed', 'reviewed'],
  })
  assert.deepEqual(board.assetIds, [first.id, second.id])
  assert.deepEqual(smart.models, ['model-main'])

  const restartedStore = new ProjectStore(harness.stateDirectory)
  await restartedStore.initialize()
  const assets = new Map((await restartedStore.listAssets(root)).map((asset) => [asset.id, asset]))
  assert.equal(assets.get(first.id)?.decision, 'pending')
  assert.deepEqual(
    { favorite: assets.get(second.id)?.favorite, decision: assets.get(second.id)?.decision, tags: assets.get(second.id)?.tags },
    { favorite: true, decision: 'adopted', tags: ['selected', 'reviewed'] },
  )
  assert.deepEqual(await restartedStore.listCollections(root), {
    schemaVersion: 1,
    boards: [board],
    smartCollections: [smart],
  })
})

test('plugin persistence enforces declared permissions and the exact manifest version lock', async (t) => {
  const harness = await createHarness(t)
  const { root } = await createProject(harness)
  const plugin = pluginFixture()

  await assert.rejects(
    harness.store.upsertPlugin(root, { ...plugin, grantedPermissions: ['shell'] }),
    hasStudioCode('plugin-permission-not-declared'),
  )
  await assert.rejects(
    harness.store.upsertPlugin(root, { ...plugin, versionLock: '1.2.4' }),
    hasStudioCode('plugin-version-lock-mismatch'),
  )
  assert.deepEqual(await harness.store.upsertPlugin(root, plugin), plugin)

  const restartedStore = new ProjectStore(harness.stateDirectory)
  await restartedStore.initialize()
  assert.deepEqual(await restartedStore.listPlugins(root), [plugin])
  assert.equal(await restartedStore.deletePlugin(root, plugin.manifest.id), true)
  assert.equal(await restartedStore.deletePlugin(root, plugin.manifest.id), false)
})

test('preset normalization and envelope import merge survive a ProjectStore restart', async (t) => {
  const harness = await createHarness(t)
  const { root } = await createProject(harness)
  const normalized = await harness.store.upsertPreset(root, {
    ...presetFixture('preset-normalized'),
    modelPatterns: ['model-*', 'model-*', 'image-*'],
    tags: ['characterization', 'characterization', 'portrait'],
  })
  assert.deepEqual(normalized.modelPatterns, ['model-*', 'image-*'])
  assert.deepEqual(normalized.tags, ['characterization', 'portrait'])

  const replacement = presetFixture('preset-imported', 'Imported v2')
  await harness.store.upsertPreset(root, presetFixture('preset-imported', 'Imported v1'))
  const added = presetFixture('preset-added', 'Added by import')
  assert.deepEqual(await harness.store.importPresets(root, {
    schemaVersion: 1,
    presets: [replacement, added],
    exportSource: 'characterization',
  }), [replacement, added])

  const restartedStore = new ProjectStore(harness.stateDirectory)
  await restartedStore.initialize()
  const presets = new Map((await restartedStore.listPresets(root)).map((preset) => [preset.id, preset]))
  assert.equal(presets.size, 3)
  assert.deepEqual(presets.get(normalized.id), normalized)
  assert.deepEqual(presets.get(replacement.id), replacement)
  assert.deepEqual(presets.get(added.id), added)
})

test('queue upsert preserves identity fields and duplicate persisted IDs fail through the facade', async (t) => {
  const harness = await createHarness(t)
  const { root, summary, workflow } = await createProject(harness)
  const original = queueFixture(summary.id, workflow, 'queue-identity', 'pending', 'not_sent')
  await harness.store.upsertQueuedRun(root, original)
  const updated = await harness.store.upsertQueuedRun(root, {
    ...original,
    status: 'running',
    priority: 12,
    createdAt: '2027-01-01T00:00:00.000Z',
    updatedAt: '2027-01-01T00:00:01.000Z',
    attempt: 1,
  })
  assert.equal(updated.createdAt, original.createdAt)
  assert.deepEqual(
    { status: updated.status, priority: updated.priority, attempt: updated.attempt },
    { status: 'running', priority: 12, attempt: 1 },
  )

  await writeFile(path.join(root, '.studio', 'run-queue.json'), JSON.stringify([updated, updated]))
  await assert.rejects(harness.store.listQueuedRuns(root), hasStudioCode('run-queue-id-conflict'))
})

test('historic run corruption is isolated and managed asset paths cannot escape their directory', async (t) => {
  const harness = await createHarness(t)
  const { root, workflow } = await createProject(harness)
  const runsDirectory = path.join(root, '.studio', 'runs')
  await mkdir(runsDirectory)
  await writeFile(path.join(runsDirectory, 'valid.json'), JSON.stringify({
    schemaVersion: 1,
    runId: 'run-valid',
    workflowId: workflow.id,
    status: 'succeeded',
    createdAt: timestamp,
    events: [],
    environment: { platform: 'characterization' },
  }))
  await writeFile(path.join(runsDirectory, 'damaged.json'), '{not-json')

  assert.deepEqual((await harness.store.listRuns(root)).map((run) => run.runId), ['run-valid'])
  assert.throws(() => harness.store.resolveAsset(root, '../outside.png'), hasStudioCode('asset-path-denied'))
  await assert.rejects(
    harness.store.resolveExistingAsset(root, 'assets/../project.json'),
    hasStudioCode('path-outside-project'),
  )
  await assert.rejects(
    harness.store.resolveOutputAsset(root, 'assets/not-an-output.png'),
    hasStudioCode('output-path-denied'),
  )
})

test('restart recovery preserves queue billing state and classifies interrupted local and remote tasks', async (t) => {
  const harness = await createHarness(t)
  const { root, summary, workflow } = await createProject(harness)
  await Promise.all([
    harness.store.upsertQueuedRun(root, queueFixture(summary.id, workflow, 'queue-local', 'pending', 'not_sent')),
    harness.store.upsertQueuedRun(root, queueFixture(summary.id, workflow, 'queue-remote', 'running', 'sent')),
    harness.store.upsertQueuedRun(root, queueFixture(summary.id, workflow, 'queue-paused', 'paused', 'not_sent')),
  ])
  await Promise.all([
    harness.store.upsertTask(root, taskFixture(summary.id, 'task-pending', 'pending')),
    harness.store.upsertTask(root, taskFixture(summary.id, 'task-local', 'running', 'not_sent')),
    harness.store.upsertTask(root, taskFixture(summary.id, 'task-remote', 'running', 'sent')),
    harness.store.upsertTask(root, taskFixture(summary.id, 'task-complete', 'succeeded', 'sent')),
  ])

  const restartedStore = new ProjectStore(harness.stateDirectory)
  await restartedStore.initialize()
  assert.equal(await restartedStore.recoverInterruptedQueue(root), 2)
  assert.equal(await restartedStore.recoverInterruptedTasks(root), 3)

  const queue = new Map((await restartedStore.listQueuedRuns(root)).map((item) => [item.id, item]))
  assert.equal(queue.get('queue-local')?.status, 'paused')
  assert.equal(queue.get('queue-local')?.dispatchState, 'not_sent')
  assert.match(queue.get('queue-local')?.lastError ?? '', /未派发/u)
  assert.equal(queue.get('queue-remote')?.status, 'paused')
  assert.equal(queue.get('queue-remote')?.dispatchState, 'sent')
  assert.match(queue.get('queue-remote')?.lastError ?? '', /正在执行/u)
  assert.equal(queue.get('queue-paused')?.status, 'paused')
  assert.equal(queue.get('queue-paused')?.lastError, undefined)

  const tasks = new Map((await restartedStore.listTasks(root)).map((item) => [item.id, item]))
  assert.deepEqual(
    { status: tasks.get('task-pending')?.status, dispatchState: tasks.get('task-pending')?.dispatchState },
    { status: 'cancelled', dispatchState: 'not_sent' },
  )
  assert.deepEqual(
    { status: tasks.get('task-local')?.status, dispatchState: tasks.get('task-local')?.dispatchState },
    { status: 'cancelled', dispatchState: 'not_sent' },
  )
  assert.deepEqual(
    { status: tasks.get('task-remote')?.status, dispatchState: tasks.get('task-remote')?.dispatchState },
    { status: 'billing-unknown', dispatchState: 'billing_unknown' },
  )
  assert.deepEqual(
    { status: tasks.get('task-complete')?.status, dispatchState: tasks.get('task-complete')?.dispatchState },
    { status: 'succeeded', dispatchState: 'sent' },
  )
})

test('rejects a symlinked managed workflow directory', async (t) => {
  const harness = await createHarness(t)
  const { root } = await createProject(harness)
  const managedDirectory = path.join(root, 'workflows')
  const realDirectory = path.join(harness.directory, 'real-workflows')
  await rename(managedDirectory, realDirectory)
  try {
    try {
      await symlink(realDirectory, managedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      await rename(realDirectory, managedDirectory)
      const code = (error as NodeJS.ErrnoException).code
      if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(code ?? '')) {
        t.skip(`symbolic links are unavailable on this Windows host (${code ?? 'unknown error'})`)
        return
      }
      throw error
    }

    await assert.rejects(harness.store.listWorkflows(root), hasStudioCode('project-symlink-denied'))
  } finally {
    try {
      await unlink(managedDirectory)
      await rename(realDirectory, managedDirectory)
    } catch {
      // The skipped branch already restored the real directory.
    }
  }
})

test('serializes concurrent mutations of one task resource without losing accepted records', async (t) => {
  const harness = await createHarness(t)
  const { root, summary } = await createProject(harness)
  const expectedIds = Array.from({ length: 32 }, (_, index) => `concurrent-task-${index}`)

  await Promise.all(expectedIds.map((id) =>
    harness.store.upsertTask(root, taskFixture(summary.id, id, 'succeeded', 'sent'))))

  const restartedStore = new ProjectStore(harness.stateDirectory)
  await restartedStore.initialize()
  const persistedTasks = await restartedStore.listTasks(root)
  assert.deepEqual(persistedTasks.map((task) => task.id).sort(), expectedIds.sort())
})
