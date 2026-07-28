import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ConversationSnapshot } from '../../src/shared/contracts.ts'
import {
  ConversationWorkspaceExportError,
  ConversationWorkspaceExportService,
  type ConversationWorkspaceHistoryReader,
  type ConversationWorkspaceResolver
} from '../../src/main/services/conversation-workspace-export-service.ts'

const TASK_ID = 'task:11111111-1111-4111-8111-111111111111'
const SECOND_TASK_ID = 'task:33333333-3333-4333-8333-333333333333'
const PROJECT_ID = `project:workspace:${Buffer.alloc(32, 9).toString('base64url')}`

async function createWorkspace(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-history-export-'))
  t.after(async () => await fs.rm(root, { recursive: true, force: true }))
  return root
}

function snapshot(options: {
  readonly taskId?: string
  readonly mode?: 'chat' | 'agent'
  readonly projectId?: string
  readonly user?: string
  readonly assistant?: string
} = {}): ConversationSnapshot {
  return {
    task: {
      id: options.taskId ?? TASK_ID,
      projectId: options.projectId ?? PROJECT_ID,
      title: 'Private task title',
      mode: options.mode ?? 'agent',
      updatedAt: '2026-07-23T00:00:00.000Z',
      archivedAt: null,
      status: 'idle'
    },
    messages: [
      {
        id: 'message:11111111-1111-4111-8111-111111111111',
        role: 'user',
        content: options.user ?? 'Build a calculator.',
        status: 'complete',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z'
      },
      {
        id: 'message:22222222-2222-4222-8222-222222222222',
        role: 'assistant',
        content: options.assistant ?? 'Created the calculator.',
        status: 'complete',
        createdAt: '2026-07-23T00:00:01.000Z',
        updatedAt: '2026-07-23T00:00:01.000Z'
      }
    ],
    events: []
  }
}

function historyReader(value: ConversationSnapshot): ConversationWorkspaceHistoryReader {
  return { load: async () => value }
}

function workspaceResolver(absolutePath: string | null): ConversationWorkspaceResolver {
  return {
    resolveProject: async () => absolutePath === null
      ? null
      : { absolutePath, displayName: 'Workspace' }
  }
}

test('syncTask atomically exports visible Agent messages as stable Markdown', async (t) => {
  const workspace = await createWorkspace(t)
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(workspace)
  })

  const result = await service.syncTask(TASK_ID)

  assert.deepEqual(result, { status: 'written', fileName: 'AI-TERMINAL-HISTORY.md' })
  assert.equal(
    await fs.readFile(
      join(workspace, 'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'),
      'utf8'
    ),
    [
      '# AI Terminal Agent History',
      '',
      '## User',
      '',
      'Build a calculator.',
      '',
      '## Assistant',
      '',
      'Created the calculator.',
      ''
    ].join('\n')
  )
  assert.equal(
    await fs.readFile(join(workspace, 'AI-TERMINAL-HISTORY.md'), 'utf8'),
    [
      '# AI Terminal Agent Histories',
      '',
      '- [AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md](./AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md)',
      ''
    ].join('\n')
  )
})

test('syncTask skips Chat history without resolving or writing a workspace', async () => {
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot({ mode: 'chat' })),
    agentWorkspaces: {
      resolveProject: async () => {
        assert.fail('Chat export must not resolve an Agent workspace')
      }
    }
  })

  assert.deepEqual(await service.syncTask(TASK_ID), { status: 'skipped', reason: 'not_agent' })
})

test('syncTask skips Agent history when its project has no bound workspace', async () => {
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(null)
  })

  assert.deepEqual(await service.syncTask(TASK_ID), {
    status: 'skipped',
    reason: 'workspace_unbound'
  })
})

test('syncTask redacts visible text and excludes reasoning, tool data, metadata, and absolute paths', async (t) => {
  const workspace = await createWorkspace(t)
  const base = snapshot({
    user: 'Use api_key=sk-private-export-12345678 from C:\\Users\\Alice\\private.txt.',
    assistant: [
      'Finished with Authorization: Bearer private-bearer-token-12345678.',
      'Read /etc/private-export.conf and `/home/alice/inline/private.txt`.',
      'Public docs remain at https://example.com/private/path.'
    ].join('\n')
  })
  const injected = {
    ...base,
    messages: base.messages.map((message) => ({
      ...message,
      reasoning: 'PRIVATE_REASONING_MARKER',
      toolArguments: 'PRIVATE_TOOL_ARGUMENTS_MARKER',
      toolOutput: 'PRIVATE_TOOL_OUTPUT_MARKER'
    })),
    events: [{ reasoning: 'PRIVATE_EVENT_MARKER' }]
  } as unknown as ConversationSnapshot
  const service = new ConversationWorkspaceExportService({
    history: historyReader(injected),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await service.syncTask(TASK_ID)

  const exported = await fs.readFile(
    join(workspace, 'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'),
    'utf8'
  )
  assert.match(exported, /<redacted>/u)
  assert.match(exported, /<local-path>/u)
  assert.doesNotMatch(exported, /sk-private|private-bearer|C:\\Users|\/etc\/private-export|\/home\/alice|PRIVATE_|Private task title/u)
  assert.match(exported, /https:\/\/example\.com\/private\/path/u)
  assert.match(exported, /Read <local-path> and `<local-path>`\./u)
  assert.equal(exported.includes(TASK_ID), false)
  assert.equal(exported.includes(PROJECT_ID), false)
})

test('syncTask rejects a symbolic-link or reparse-point export target without following it', async (t) => {
  const workspace = await createWorkspace(t)
  const linkTarget = join(workspace, 'linked-directory')
  const exportTarget = join(workspace, 'AI-TERMINAL-HISTORY.md')
  await fs.mkdir(linkTarget)
  await fs.symlink(linkTarget, exportTarget, process.platform === 'win32' ? 'junction' : 'dir')
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await assert.rejects(service.syncTask(TASK_ID), (error: unknown) => {
    assert.equal(error instanceof ConversationWorkspaceExportError, true)
    assert.equal((error as ConversationWorkspaceExportError).code, 'unsafe_target')
    assert.equal(String(error).includes(workspace), false)
    return true
  })
  assert.deepEqual(await fs.readdir(linkTarget), [])
  assert.equal((await fs.lstat(exportTarget)).isSymbolicLink(), true)
})

test('syncTask rejects a symbolic-link task history target without following it', async (t) => {
  const workspace = await createWorkspace(t)
  const linkTarget = join(workspace, 'linked-task-directory')
  const exportTarget = join(
    workspace,
    'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'
  )
  await fs.mkdir(linkTarget)
  await fs.symlink(linkTarget, exportTarget, process.platform === 'win32' ? 'junction' : 'dir')
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await assert.rejects(service.syncTask(TASK_ID), (error: unknown) => {
    assert.equal(error instanceof ConversationWorkspaceExportError, true)
    assert.equal((error as ConversationWorkspaceExportError).code, 'unsafe_target')
    assert.equal(String(error).includes(workspace), false)
    return true
  })
  assert.deepEqual(await fs.readdir(linkTarget), [])
  assert.equal((await fs.lstat(exportTarget)).isSymbolicLink(), true)
  await assert.rejects(fs.stat(join(workspace, 'AI-TERMINAL-HISTORY.md')), { code: 'ENOENT' })
})

test('syncTask removes a temporary-file junction swapped in immediately before commit', async (t) => {
  const workspace = await createWorkspace(t)
  const linkedDirectory = join(workspace, 'linked-temporary-directory')
  const taskTarget = join(
    workspace,
    'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'
  )
  await fs.mkdir(linkedDirectory)
  const originalRename = fs.rename
  let injected = false
  fs.rename = (async (sourcePath, destinationPath) => {
    if (
      !injected &&
      String(sourcePath).includes('.ai-terminal-history-') &&
      String(destinationPath) === taskTarget
    ) {
      injected = true
      await fs.rm(sourcePath, { force: true })
      await fs.symlink(
        linkedDirectory,
        sourcePath,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    await originalRename(sourcePath, destinationPath)
  }) as typeof fs.rename
  t.after(() => {
    fs.rename = originalRename
  })
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await assert.rejects(service.syncTask(TASK_ID), (error: unknown) => {
    assert.equal(error instanceof ConversationWorkspaceExportError, true)
    assert.equal((error as ConversationWorkspaceExportError).code, 'unsafe_target')
    return true
  })
  assert.equal(injected, true)
  await assert.rejects(fs.lstat(taskTarget), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(linkedDirectory), [])
  assert.equal(
    (await fs.readdir(workspace)).some((name) => name.startsWith('.ai-terminal-history-')),
    false
  )
})

test('syncTask rejects linked histories discovered while rebuilding the bounded index', async (t) => {
  const workspace = await createWorkspace(t)
  const linkTarget = join(workspace, 'linked-existing-directory')
  const linkedHistory = join(
    workspace,
    'AI-TERMINAL-HISTORY-33333333-3333-4333-8333-333333333333.md'
  )
  await fs.mkdir(linkTarget)
  await fs.symlink(linkTarget, linkedHistory, process.platform === 'win32' ? 'junction' : 'dir')
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await assert.rejects(service.syncTask(TASK_ID), (error: unknown) => {
    assert.equal(error instanceof ConversationWorkspaceExportError, true)
    assert.equal((error as ConversationWorkspaceExportError).code, 'unsafe_target')
    return true
  })
  assert.deepEqual(await fs.readdir(linkTarget), [])
  await assert.rejects(
    fs.stat(join(workspace, 'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md')),
    { code: 'ENOENT' }
  )
})

test('syncTask revalidates scanned task histories immediately before replacing the index', async (t) => {
  const workspace = await createWorkspace(t)
  const existingHistory = join(
    workspace,
    'AI-TERMINAL-HISTORY-33333333-3333-4333-8333-333333333333.md'
  )
  const currentHistory = join(
    workspace,
    'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'
  )
  const indexTarget = join(workspace, 'AI-TERMINAL-HISTORY.md')
  const linkedDirectory = join(workspace, 'linked-scanned-directory')
  await fs.writeFile(existingHistory, 'existing history\n', 'utf8')
  await fs.writeFile(indexTarget, 'preserved index\n', 'utf8')
  await fs.mkdir(linkedDirectory)
  const originalRename = fs.rename
  let injected = false
  fs.rename = (async (sourcePath, destinationPath) => {
    if (!injected && String(destinationPath) === indexTarget) {
      injected = true
      await fs.rm(existingHistory, { force: true })
      await fs.symlink(
        linkedDirectory,
        existingHistory,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    await originalRename(sourcePath, destinationPath)
  }) as typeof fs.rename
  t.after(() => {
    fs.rename = originalRename
  })
  const service = new ConversationWorkspaceExportService({
    history: historyReader(snapshot()),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await assert.rejects(service.syncTask(TASK_ID), (error: unknown) => {
    assert.equal(error instanceof ConversationWorkspaceExportError, true)
    assert.equal((error as ConversationWorkspaceExportError).code, 'unsafe_target')
    return true
  })
  assert.equal(injected, true)
  await assert.rejects(fs.lstat(indexTarget), { code: 'ENOENT' })
})

test('concurrent tasks in one workspace retain independent histories behind one index', async (t) => {
  const workspace = await createWorkspace(t)
  let notifyFirstStarted!: () => void
  let releaseFirst!: () => void
  const firstStarted = new Promise<void>((resolvePromise) => {
    notifyFirstStarted = resolvePromise
  })
  const firstRelease = new Promise<void>((resolvePromise) => {
    releaseFirst = resolvePromise
  })
  const snapshots = new Map([
    [TASK_ID, snapshot({ user: 'FIRST_VISIBLE_MESSAGE', assistant: 'First response.' })],
    [SECOND_TASK_ID, snapshot({
      taskId: SECOND_TASK_ID,
      user: 'SECOND_VISIBLE_MESSAGE',
      assistant: 'Second response.'
    })]
  ])
  const service = new ConversationWorkspaceExportService({
    history: {
      load: async (taskId) => {
        if (taskId === TASK_ID) {
          notifyFirstStarted()
          await firstRelease
        }
        return snapshots.get(taskId)!
      }
    },
    agentWorkspaces: workspaceResolver(workspace)
  })

  const first = service.syncTask(TASK_ID)
  await firstStarted
  const second = service.syncTask(SECOND_TASK_ID)
  releaseFirst()
  await Promise.all([first, second])

  const firstExport = await fs.readFile(
    join(workspace, 'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'),
    'utf8'
  )
  const secondExport = await fs.readFile(
    join(workspace, 'AI-TERMINAL-HISTORY-33333333-3333-4333-8333-333333333333.md'),
    'utf8'
  )
  const index = await fs.readFile(join(workspace, 'AI-TERMINAL-HISTORY.md'), 'utf8')
  assert.match(firstExport, /FIRST_VISIBLE_MESSAGE/u)
  assert.doesNotMatch(firstExport, /SECOND_VISIBLE_MESSAGE/u)
  assert.match(secondExport, /SECOND_VISIBLE_MESSAGE/u)
  assert.doesNotMatch(secondExport, /FIRST_VISIBLE_MESSAGE/u)
  assert.match(index, /AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111\.md/u)
  assert.match(index, /AI-TERMINAL-HISTORY-33333333-3333-4333-8333-333333333333\.md/u)
})

test('an oversized export fails before commit and preserves the previous bridge file', async (t) => {
  const workspace = await createWorkspace(t)
  const exportTarget = join(workspace, 'AI-TERMINAL-HISTORY.md')
  await fs.writeFile(exportTarget, 'preserved history\n', 'utf8')
  const base = snapshot()
  const oversized = {
    ...base,
    messages: Array.from({ length: 9 }, (_, index) => ({
      ...base.messages[index % base.messages.length]!,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: String(index).repeat(240 * 1024)
    }))
  }
  const service = new ConversationWorkspaceExportService({
    history: historyReader(oversized),
    agentWorkspaces: workspaceResolver(workspace)
  })

  await assert.rejects(service.syncTask(TASK_ID), (error: unknown) => {
    assert.equal(error instanceof ConversationWorkspaceExportError, true)
    assert.equal((error as ConversationWorkspaceExportError).code, 'limit_exceeded')
    return true
  })
  assert.equal(await fs.readFile(exportTarget, 'utf8'), 'preserved history\n')
})
