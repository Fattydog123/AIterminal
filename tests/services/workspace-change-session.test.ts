import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  AgentWorkspaceSessionService,
  type AgentWorkspaceSessionStorage
} from '../../src/main/services/agent-workspace-session-service.ts'
import {
  ConversationHistoryService,
  type ConversationHistoryStorage
} from '../../src/main/services/conversation-history-service.ts'
import {
  WorkspaceChangeSession,
  type WorkspaceChangeStorage
} from '../../src/main/services/workspace-change-session.ts'
import { SelectionTokenStore } from '../../src/main/services/selection-token-store.ts'
import { WorkspaceToolService } from '../../src/main/services/workspace-tool-service.ts'

class MemoryStorage implements ConversationHistoryStorage, AgentWorkspaceSessionStorage, WorkspaceChangeStorage {
  value: string | null = null

  async read(): Promise<string | null> {
    return this.value
  }

  async write(value: string): Promise<void> {
    this.value = value
  }
}

const runFile = promisify(execFile)

async function projectIdForDirectory(path: string): Promise<string> {
  const stats = await fs.stat(path, { bigint: true })
  const digest = createHash('sha256')
    .update('ai-terminal.workspace-project.v1\0', 'utf8')
    .update(stats.dev.toString(10), 'utf8')
    .update('\0', 'utf8')
    .update(stats.ino.toString(10), 'utf8')
    .digest('base64url')
  return `project:workspace:${digest}`
}

test('checkpoint, rewind, isolated fork, apply, and discard share one file-state session', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-workspace-change-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'source')
  await fs.mkdir(workspacePath)
  await fs.writeFile(join(workspacePath, 'app.txt'), 'base', 'utf8')

  const history = new ConversationHistoryService(new MemoryStorage())
  const workspaces = new AgentWorkspaceSessionService({
    documentsRoot: join(root, 'documents'),
    storage: new MemoryStorage()
  })
  const changes = new WorkspaceChangeSession({
    history,
    workspaces,
    storage: new MemoryStorage(),
    snapshotRoot: join(root, 'snapshots'),
    worktreeRoot: join(root, 'worktrees')
  })
  const projectId = await projectIdForDirectory(workspacePath)
  await workspaces.bindProject(projectId, workspacePath)
  const task = await history.create({ projectId, mode: 'agent', title: 'File state' })

  const checkpointState = await changes.createCheckpoint({ taskId: task.id, label: 'Base' })
  assert.equal(checkpointState.checkpoints.length, 1)
  await fs.writeFile(join(workspacePath, 'app.txt'), 'changed', 'utf8')
  await fs.writeFile(join(workspacePath, 'new.txt'), 'remove me', 'utf8')
  await changes.rewind({ taskId: task.id, checkpointId: checkpointState.checkpoints[0]!.id })
  assert.equal(await fs.readFile(join(workspacePath, 'app.txt'), 'utf8'), 'base')
  await assert.rejects(fs.readFile(join(workspacePath, 'new.txt'), 'utf8'), { code: 'ENOENT' })

  const forked = await changes.forkConversation({ taskId: task.id, isolateFiles: true })
  const forkedWorkspace = await workspaces.resolveProject(forked.projectId)
  assert.ok(forkedWorkspace)
  assert.notEqual(forkedWorkspace.absolutePath, workspacePath)
  assert.equal(await fs.readFile(join(forkedWorkspace.absolutePath, 'app.txt'), 'utf8'), 'base')
  await fs.writeFile(join(forkedWorkspace.absolutePath, 'app.txt'), 'from fork', 'utf8')

  const sourceState = await changes.list(task.id)
  assert.equal(sourceState.worktrees.length, 1)
  assert.equal(sourceState.worktrees[0]!.kind, 'workspace-copy')
  assert.equal(sourceState.worktrees[0]!.changedFiles, 1)
  await changes.applyWorktree({ taskId: task.id, worktreeId: sourceState.worktrees[0]!.id })
  assert.equal(await fs.readFile(join(workspacePath, 'app.txt'), 'utf8'), 'from fork')

  await changes.discardWorktree({ taskId: task.id, worktreeId: sourceState.worktrees[0]!.id })
  assert.equal(await workspaces.resolveProject(forked.projectId), null)
})

test('a Git workspace uses a real linked worktree and applies its file changes', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-workspace-change-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'source')
  await fs.mkdir(workspacePath)
  await runFile('git', ['init'], { cwd: workspacePath, windowsHide: true })
  await runFile('git', ['config', 'user.email', 'workspace-change@example.invalid'], { cwd: workspacePath, windowsHide: true })
  await runFile('git', ['config', 'user.name', 'Workspace Change Test'], { cwd: workspacePath, windowsHide: true })
  await fs.writeFile(join(workspacePath, 'tracked.txt'), 'base', 'utf8')
  await runFile('git', ['add', 'tracked.txt'], { cwd: workspacePath, windowsHide: true })
  await runFile('git', ['commit', '-m', 'base'], { cwd: workspacePath, windowsHide: true })

  const history = new ConversationHistoryService(new MemoryStorage())
  const workspaces = new AgentWorkspaceSessionService({
    documentsRoot: join(root, 'documents'),
    storage: new MemoryStorage()
  })
  const changes = new WorkspaceChangeSession({
    history,
    workspaces,
    storage: new MemoryStorage(),
    snapshotRoot: join(root, 'snapshots'),
    worktreeRoot: join(root, 'worktrees')
  })
  const projectId = await projectIdForDirectory(workspacePath)
  await workspaces.bindProject(projectId, workspacePath)
  const task = await history.create({ projectId, mode: 'agent', title: 'Git file state' })

  const forked = await changes.forkConversation({ taskId: task.id, isolateFiles: true })
  const forkedWorkspace = await workspaces.resolveProject(forked.projectId)
  assert.ok(forkedWorkspace)
  const state = await changes.list(task.id)
  assert.equal(state.worktrees[0]?.kind, 'git-worktree')
  await fs.writeFile(join(forkedWorkspace.absolutePath, 'tracked.txt'), 'worktree', 'utf8')
  const selections = new SelectionTokenStore()
  const selection = selections.issueWorkspace(forkedWorkspace.absolutePath, 1)
  const tools = new WorkspaceToolService({
    selections,
    authorizeManagedGitWorktree: (workspacePath, gitDirectory) =>
      changes.authorizeManagedGitWorktree(workspacePath, gitDirectory)
  })
  const summary = await tools.gitSummary({ workspaceToken: selection.workspaceToken }, 1)
  assert.equal(summary.files.some((file) => file.relativePath === 'tracked.txt'), true)
  await changes.applyWorktree({ taskId: task.id, worktreeId: state.worktrees[0]!.id })
  assert.equal(await fs.readFile(join(workspacePath, 'tracked.txt'), 'utf8'), 'worktree')
  await changes.discardWorktree({ taskId: task.id, worktreeId: state.worktrees[0]!.id })
})

test('an Agent isolation creates a managed worktree without adding a sidebar conversation', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-agent-isolation-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'source')
  await fs.mkdir(workspacePath)
  await fs.writeFile(join(workspacePath, 'agent.txt'), 'base', 'utf8')

  const history = new ConversationHistoryService(new MemoryStorage())
  const workspaces = new AgentWorkspaceSessionService({
    documentsRoot: join(root, 'documents'),
    storage: new MemoryStorage()
  })
  const changes = new WorkspaceChangeSession({
    history,
    workspaces,
    storage: new MemoryStorage(),
    snapshotRoot: join(root, 'snapshots'),
    worktreeRoot: join(root, 'worktrees')
  })
  const projectId = await projectIdForDirectory(workspacePath)
  await workspaces.bindProject(projectId, workspacePath)
  const task = await history.create({ projectId, mode: 'agent', title: 'Root Agent' })

  const isolated = await changes.createAgentIsolation({
    rootTaskId: task.id,
    sourceProjectId: projectId,
    label: 'Implement one focused change'
  })
  assert.notEqual(isolated.projectId, projectId)
  assert.notEqual(isolated.taskId, task.id)
  assert.equal((await history.list()).length, 1)
  assert.equal((await workspaces.resolveProject(isolated.projectId))?.absolutePath, isolated.absolutePath)
  await fs.writeFile(join(isolated.absolutePath, 'agent.txt'), 'isolated change', 'utf8')

  const state = await changes.list(task.id)
  assert.equal(state.worktrees[0]?.id, isolated.worktreeId)
  assert.equal(state.worktrees[0]?.targetTaskId, isolated.taskId)
  assert.equal(state.worktrees[0]?.changedFiles, 1)
  await changes.applyWorktree({ taskId: task.id, worktreeId: isolated.worktreeId })
  assert.equal(await fs.readFile(join(workspacePath, 'agent.txt'), 'utf8'), 'isolated change')
  await changes.discardWorktree({ taskId: task.id, worktreeId: isolated.worktreeId })
  assert.equal(await workspaces.resolveProject(isolated.projectId), null)
})

test('an already-cancelled Agent isolation never materializes a worktree', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-agent-isolation-cancel-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, 'source')
  await fs.mkdir(workspacePath)
  const history = new ConversationHistoryService(new MemoryStorage())
  const workspaces = new AgentWorkspaceSessionService({
    documentsRoot: join(root, 'documents'),
    storage: new MemoryStorage()
  })
  const changes = new WorkspaceChangeSession({
    history,
    workspaces,
    storage: new MemoryStorage(),
    snapshotRoot: join(root, 'snapshots'),
    worktreeRoot: join(root, 'worktrees')
  })
  const projectId = await projectIdForDirectory(workspacePath)
  await workspaces.bindProject(projectId, workspacePath)
  const task = await history.create({ projectId, mode: 'agent', title: 'Cancelled Agent' })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(changes.createAgentIsolation({
    rootTaskId: task.id,
    sourceProjectId: projectId,
    signal: controller.signal
  }))
  assert.deepEqual((await changes.list(task.id)).worktrees, [])
})
