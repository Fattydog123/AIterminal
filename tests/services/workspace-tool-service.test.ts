import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, parse } from 'node:path'
import test, { type TestContext } from 'node:test'

import { SelectionTokenStore } from '../../src/main/services/selection-token-store.ts'
import {
  WorkspaceToolError,
  WorkspaceToolService
} from '../../src/main/services/workspace-tool-service.ts'

const OWNER_ID = 41

test('read_file rejects traversal, absolute, device, ADS, and unsafe Windows path forms', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const rejectedPaths = [
    '../outside.txt',
    'folder/../../outside.txt',
    'C:\\private\\file.txt',
    '\\\\server\\share\\file.txt',
    '\\\\?\\C:\\private\\file.txt',
    '\\\\.\\PhysicalDrive0',
    '/etc/passwd',
    'folder/file.txt:stream',
    'folder/CON.txt',
    'folder/trailing.',
    'folder/trailing '
  ]

  for (const relativePath of rejectedPaths) {
    await assert.rejects(
      fixture.service.readFile(
        { workspaceToken: fixture.workspaceToken, relativePath },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.equal(error.code, 'invalid_relative_path')
        assert.equal(error.message.includes(relativePath), false)
        return true
      }
    )
  }
})

test('read_file hard-rejects credential and private-history paths before file access', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const sensitivePaths = [
    '.env',
    '.env.local',
    'keys/server.pem',
    'keys/server.key',
    '.npmrc',
    '.pypirc',
    'auth.json',
    'credentials',
    '.ssh/id_ed25519',
    'secure/access-profiles.json',
    'secure/conversation-history.json'
  ]

  for (const relativePath of sensitivePaths) {
    await assert.rejects(
      fixture.service.readFile(
        { workspaceToken: fixture.workspaceToken, relativePath },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.equal(error.code, 'sensitive_path')
        assert.equal(error.message.includes(relativePath), false)
        return true
      }
    )
  }
})

test('read_file returns bounded UTF-8 text with credentials redacted and paths preserved', async (t) => {
  const fixture = await createWorkspaceFixture(t, { maxFileBytes: 1_024, maxResultCharacters: 1_024 })
  const secret = 'workspace-service-secret-marker'
  const localPath = 'C:\\Users\\private-user\\notes.txt'
  await fs.writeFile(
    join(fixture.root, 'notes.txt'),
    `api_key=${secret}\nlocal=${localPath}\nhello workspace`,
    'utf8'
  )

  const result = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'notes.txt' },
    OWNER_ID
  )
  assert.equal(result.relativePath, 'notes.txt')
  assert.equal(result.truncated, false)
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.match(result.content, /<redacted>/)
  assert.match(result.content, /C:\\Users\\private-user\\notes\.txt/)
  assert.equal(result.content.includes(secret), false)
  assert.match(result.content, /hello workspace/)

  const filenameSecret = 'read-filename-secret-marker'
  const sensitiveFilename = `token=${filenameSecret}.txt`
  await fs.writeFile(join(fixture.root, sensitiveFilename), 'safe body', 'utf8')
  const filenameResult = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: sensitiveFilename },
    OWNER_ID
  )
  assert.equal(filenameResult.relativePath.includes(filenameSecret), false)
  assert.match(filenameResult.relativePath, /<redacted>/)
})

test('read_file enforces byte, UTF-8, owner, and cancellation boundaries', async (t) => {
  const fixture = await createWorkspaceFixture(t, { maxFileBytes: 16 })
  await fs.writeFile(join(fixture.root, 'large.txt'), 'x'.repeat(17), 'utf8')
  await fs.writeFile(join(fixture.root, 'binary.txt'), Buffer.from([0xff, 0xfe, 0xfd]))

  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'large.txt' },
      OWNER_ID
    ),
    'file_too_large'
  )
  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'binary.txt' },
      OWNER_ID
    ),
    'invalid_text_file'
  )
  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'large.txt' },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )

  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'large.txt' },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('read_file rejects symlink or junction traversal out of the workspace', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(join(outside, 'secret.txt'), 'must not be read', 'utf8')

  const linkPath = join(fixture.root, 'escape')
  try {
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (isNodeErrorCode(error, 'EPERM') || isNodeErrorCode(error, 'EACCES')) {
      t.skip('This host does not permit creating a symlink or junction fixture.')
      return
    }
    throw error
  }

  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'escape/secret.txt' },
      OWNER_ID
    ),
    'reparse_point_rejected'
  )
})

test('read, search, write, and replace reject multiply-linked regular files', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-hard-link-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))

  const contents = new Map([
    ['read-hard-link.txt', 'read hard-link marker\n'],
    ['search-hard-link.txt', 'search hard-link marker\n'],
    ['write-hard-link.txt', 'write original\n'],
    ['replace-hard-link.txt', 'replace old value\n']
  ])
  for (const [fileName, content] of contents) {
    await fs.writeFile(join(fixture.root, fileName), content, 'utf8')
  }

  const writeRevision = (
    await fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'write-hard-link.txt' },
      OWNER_ID
    )
  ).revision
  const replaceRevision = (
    await fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'replace-hard-link.txt' },
      OWNER_ID
    )
  ).revision

  try {
    for (const fileName of contents.keys()) {
      await fs.link(join(fixture.root, fileName), join(outside, fileName))
    }
  } catch (error) {
    if (
      isNodeErrorCode(error, 'EACCES') ||
      isNodeErrorCode(error, 'EPERM') ||
      isNodeErrorCode(error, 'ENOTSUP') ||
      isNodeErrorCode(error, 'EXDEV')
    ) {
      t.skip('This host does not permit creating a hard-link fixture.')
      return
    }
    throw error
  }

  const reportedLinkCount = (await fs.lstat(join(fixture.root, 'read-hard-link.txt'))).nlink
  if (reportedLinkCount === 0 || reportedLinkCount === 0n) {
    t.skip('This filesystem does not report hard-link counts.')
    return
  }
  assert.ok(
    typeof reportedLinkCount === 'bigint' ? reportedLinkCount > 1n : reportedLinkCount > 1
  )

  await assertHardLinkRejected(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'read-hard-link.txt' },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'read-hard-link.txt'
  )
  await assertHardLinkRejected(
    fixture.service.searchFiles(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'search-hard-link.txt',
        query: 'marker',
        caseSensitive: true
      },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'search-hard-link.txt'
  )
  await assertHardLinkRejected(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'write-hard-link.txt',
        content: 'write modified\n',
        expectedRevision: writeRevision
      },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'write-hard-link.txt'
  )
  await assertHardLinkRejected(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'replace-hard-link.txt',
        oldText: 'old',
        newText: 'new',
        expectedRevision: replaceRevision
      },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'replace-hard-link.txt'
  )

  assert.equal(await fs.readFile(join(outside, 'write-hard-link.txt'), 'utf8'), 'write original\n')
  assert.equal(
    await fs.readFile(join(outside, 'replace-hard-link.txt'), 'utf8'),
    'replace old value\n'
  )
})

test('list_directory accepts only safe relative directories and propagates cancellation', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'plain.txt'), 'plain', 'utf8')
  await fs.mkdir(join(fixture.root, '.ssh'))

  for (const relativePath of [
    '../outside',
    './nested',
    'C:\\private',
    '\\\\server\\share',
    '\\\\?\\C:\\private',
    '\\\\.\\PhysicalDrive0',
    '/etc',
    'folder:stream',
    'CON',
    'trailing.',
    'trailing '
  ]) {
    await assertWorkspaceError(
      fixture.service.listDirectory(
        { workspaceToken: fixture.workspaceToken, relativePath },
        OWNER_ID
      ),
      'invalid_relative_path'
    )
  }

  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: 'plain.txt' },
      OWNER_ID
    ),
    'path_not_directory'
  )
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.ssh' },
      OWNER_ID
    ),
    'sensitive_path'
  )
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.' },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )

  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.' },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )

  const midOperationController = new AbortController()
  const originalRealpath = fs.realpath
  fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
    const result = await originalRealpath(...args)
    if (String(args[0]).toLowerCase() === join(fixture.root, 'plain.txt').toLowerCase()) {
      midOperationController.abort()
    }
    return result
  }) as typeof fs.realpath
  t.after(() => {
    fs.realpath = originalRealpath
  })
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.' },
      OWNER_ID,
      { signal: midOperationController.signal }
    ),
    'cancelled'
  )
})

test('list_directory returns one stable layer and hides sensitive, protected, and reparse entries', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'z-last.txt'), 'z', 'utf8')
  await fs.writeFile(join(fixture.root, 'a-first.txt'), 'a', 'utf8')
  await fs.mkdir(join(fixture.root, 'src'))
  await fs.writeFile(join(fixture.root, 'src', 'nested.ts'), 'nested', 'utf8')
  await fs.writeFile(join(fixture.root, '.env.local'), 'secret', 'utf8')
  await fs.writeFile(join(fixture.root, 'auth.json'), 'secret', 'utf8')
  await fs.mkdir(join(fixture.root, '.ssh'))
  await fs.writeFile(join(fixture.root, '.ssh', 'id_ed25519'), 'secret', 'utf8')
  await fs.writeFile(join(fixture.root, '.ai-terminal-history-hidden.tmp'), 'temporary', 'utf8')
  const filenameSecret = 'directory-filename-secret-marker'
  await fs.writeFile(join(fixture.root, `token=${filenameSecret}.txt`), 'secret', 'utf8')
  const protectedRoot = join(fixture.root, 'private-runtime')
  await fs.mkdir(protectedRoot)
  await fs.writeFile(join(protectedRoot, 'private.txt'), 'private', 'utf8')

  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-list-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  const linkPath = join(fixture.root, 'escape-link')
  let linkCreated = false
  try {
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linkCreated = true
  } catch (error) {
    if (!isNodeErrorCode(error, 'EPERM') && !isNodeErrorCode(error, 'EACCES')) throw error
  }

  const service = new WorkspaceToolService({
    selections: fixture.selections,
    protectedAbsoluteRoots: [protectedRoot]
  })
  const result = await service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '.' },
    OWNER_ID
  )
  assert.deepEqual(result.entries, [
    { relativePath: 'a-first.txt', kind: 'file' },
    { relativePath: 'src', kind: 'directory' },
    { relativePath: 'z-last.txt', kind: 'file' }
  ])
  assert.equal(result.truncated, false)
  assert.deepEqual(Object.keys(result).sort(), ['entries', 'truncated'])
  assert.ok(result.entries.every((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ['kind', 'relativePath'])
    return entry.kind === 'file' || entry.kind === 'directory'
  }))

  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(fixture.root), false)
  assert.equal(serialized.includes(filenameSecret), false)
  assert.equal(serialized.includes('.env'), false)
  assert.equal(serialized.includes('.ssh'), false)
  assert.equal(serialized.includes('auth.json'), false)
  assert.equal(serialized.includes('.ai-terminal-history-'), false)
  assert.equal(serialized.includes('private-runtime'), false)
  assert.equal(serialized.includes('escape-link'), false)
  assert.doesNotMatch(serialized, /(?:size|mtime|ctime|birthtime)/u)

  const nested = await service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: 'src' },
    OWNER_ID
  )
  assert.deepEqual(nested.entries, [{ relativePath: 'src/nested.ts', kind: 'file' }])

  if (linkCreated) {
    await assertWorkspaceError(
      service.listDirectory(
        { workspaceToken: fixture.workspaceToken, relativePath: 'escape-link' },
        OWNER_ID
      ),
      'reparse_point_rejected'
    )
  }
})

test('list_directory enforces stable entry and serialized-character limits', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  for (let index = 9; index >= 0; index -= 1) {
    await fs.writeFile(
      join(fixture.root, `file-${String(index).padStart(2, '0')}-with-a-bounded-name.txt`),
      'x',
      'utf8'
    )
  }

  const entryBoundService = new WorkspaceToolService({
    selections: fixture.selections,
    maxDirectoryEntries: 3,
    maxDirectoryResultCharacters: 1_024
  })
  const entryBound = await entryBoundService.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '.' },
    OWNER_ID
  )
  assert.deepEqual(
    entryBound.entries.map((entry) => entry.relativePath),
    [
      'file-00-with-a-bounded-name.txt',
      'file-01-with-a-bounded-name.txt',
      'file-02-with-a-bounded-name.txt'
    ]
  )
  assert.equal(entryBound.truncated, true)

  const characterBoundService = new WorkspaceToolService({
    selections: fixture.selections,
    maxDirectoryEntries: 20,
    maxDirectoryResultCharacters: 128
  })
  const characterBound = await characterBoundService.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '.' },
    OWNER_ID
  )
  assert.ok(JSON.stringify(characterBound).length <= 128)
  assert.ok(characterBound.entries.length < 10)
  assert.equal(characterBound.truncated, true)
  assert.deepEqual(
    characterBound.entries.map((entry) => entry.relativePath),
    [...characterBound.entries.map((entry) => entry.relativePath)].sort()
  )
})

test('write_file creates and atomically replaces text with revision conflict protection', async (t) => {
  const fixture = await createWorkspaceFixture(t)

  const created = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'src/new-file.ts',
      content: 'export const value = 1\n'
    },
    OWNER_ID
  ).catch(async (error) => {
    if (error instanceof WorkspaceToolError && error.code === 'path_not_found') {
      await fs.mkdir(join(fixture.root, 'src'))
      return await fixture.service.writeFile(
        {
          workspaceToken: fixture.workspaceToken,
          relativePath: 'src/new-file.ts',
          content: 'export const value = 1\n'
        },
        OWNER_ID
      )
    }
    throw error
  })
  assert.equal(await fs.readFile(join(fixture.root, 'src', 'new-file.ts'), 'utf8'), 'export const value = 1\n')
  assert.match(created.revision, /^[a-f0-9]{64}$/)
  assert.equal((await fs.readdir(join(fixture.root, 'src'))).some((name) => name.startsWith('.ai-terminal-write-')), false)

  await assertWorkspaceError(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'src/new-file.ts',
        content: 'unsafe overwrite\n'
      },
      OWNER_ID
    ),
    'write_conflict'
  )

  const updated = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'src/new-file.ts',
      content: 'export const value = 2\n',
      expectedRevision: created.revision
    },
    OWNER_ID
  )
  assert.equal(await fs.readFile(join(fixture.root, 'src', 'new-file.ts'), 'utf8'), 'export const value = 2\n')
  assert.notEqual(updated.revision, created.revision)

  await assertWorkspaceError(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'src/new-file.ts',
        content: 'stale update\n',
        expectedRevision: created.revision
      },
      OWNER_ID
    ),
    'write_conflict'
  )
  assert.equal(await fs.readFile(join(fixture.root, 'src', 'new-file.ts'), 'utf8'), 'export const value = 2\n')
})

test('write_file blocks control, credential, traversal, owner, and cancelled requests', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  for (const relativePath of [
    '../outside.txt',
    '.git/config',
    '.codex/config.toml',
    '.agents/private.txt',
    'node_modules/package/index.js',
    'AGENTS.md',
    'AI-TERMINAL-HISTORY.md',
    'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md',
    '.ai-terminal-history-private.tmp',
    '.env.local',
    'keys/private.pem'
  ]) {
    await assert.rejects(
      fixture.service.writeFile(
        { workspaceToken: fixture.workspaceToken, relativePath, content: 'blocked' },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.ok(['invalid_relative_path', 'write_not_allowed'].includes(error.code))
        assert.equal(error.message.includes(relativePath), false)
        return true
      }
    )
  }

  await assertWorkspaceError(
    fixture.service.writeFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'owner.txt', content: 'blocked' },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )
  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.writeFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'cancelled.txt', content: 'blocked' },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
  assert.equal(await pathExists(join(fixture.root, 'cancelled.txt')), false)
})

test('write_file cancellation during final validation preserves the target and removes its temporary file', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const targetPath = join(fixture.root, 'cancel-during-validation.txt')
  await fs.writeFile(targetPath, 'original\n', 'utf8')
  const original = await fixture.service.readFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'cancel-during-validation.txt'
    },
    OWNER_ID
  )

  const controller = new AbortController()
  const originalRealpath = fs.realpath
  let workspaceRealpathCalls = 0
  fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
    const result = await originalRealpath(...args)
    if (
      typeof result === 'string' &&
      result.toLowerCase() === fixture.root.toLowerCase() &&
      ++workspaceRealpathCalls === 3
    ) {
      controller.abort()
    }
    return result
  }) as typeof fs.realpath
  t.after(() => {
    fs.realpath = originalRealpath
  })

  await assertWorkspaceError(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'cancel-during-validation.txt',
        content: 'must not commit\n',
        expectedRevision: original.revision
      },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )

  assert.equal(await fs.readFile(targetPath, 'utf8'), 'original\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )
})

test('write_file cancellation does not wait for an earlier write holding the same path lock', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const originalRename = fs.rename
  const renameStarted = deferred<void>()
  const allowRename = deferred<void>()
  let intercepted = false
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (!intercepted) {
      intercepted = true
      renameStarted.resolve()
      await allowRename.promise
    }
    return await originalRename(...args)
  }) as typeof fs.rename
  t.after(() => {
    fs.rename = originalRename
    allowRename.resolve()
  })

  const firstWrite = fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'queued-cancel.txt',
      content: 'first\n'
    },
    OWNER_ID
  )
  await renameStarted.promise

  const controller = new AbortController()
  const queuedWrite = fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'queued-cancel.txt',
      content: 'second\n'
    },
    OWNER_ID,
    { signal: controller.signal }
  )
  controller.abort()

  try {
    await completesWithin(assertWorkspaceError(queuedWrite, 'cancelled'), 1_000)
  } finally {
    allowRename.resolve()
  }
  await firstWrite

  assert.equal(await fs.readFile(join(fixture.root, 'queued-cancel.txt'), 'utf8'), 'first\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )
})

test('write_file flushes before rename and reports success once rename has committed', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const controller = new AbortController()
  const originalOpen = fs.open
  const originalRename = fs.rename
  let temporaryFileSynced = false

  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).includes('.ai-terminal-write-') && args[1] === 'wx') {
      const originalSync = handle.sync.bind(handle)
      handle.sync = async (): Promise<void> => {
        await originalSync()
        temporaryFileSynced = true
      }
    }
    return handle
  }) as typeof fs.open
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    assert.equal(temporaryFileSynced, true)
    await originalRename(...args)
    controller.abort()
  }) as typeof fs.rename
  t.after(() => {
    fs.open = originalOpen
    fs.rename = originalRename
  })

  const result = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'committed.txt',
      content: 'committed\n'
    },
    OWNER_ID,
    { signal: controller.signal }
  )

  assert.equal(controller.signal.aborted, true)
  assert.equal(result.content, 'committed\n')
  assert.equal(await fs.readFile(join(fixture.root, 'committed.txt'), 'utf8'), 'committed\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )
})

test('concurrent write_file compare-and-swap permits only one replacement', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'shared.txt'), 'initial\n', 'utf8')
  const original = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'shared.txt' },
    OWNER_ID
  )

  const writes = await Promise.allSettled([
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'shared.txt',
        content: 'first\n',
        expectedRevision: original.revision
      },
      OWNER_ID
    ),
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'shared.txt',
        content: 'second\n',
        expectedRevision: original.revision
      },
      OWNER_ID
    )
  ])
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = writes.find((result) => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof WorkspaceToolError)
  assert.equal(rejected.reason.code, 'write_conflict')
  assert.match(await fs.readFile(join(fixture.root, 'shared.txt'), 'utf8'), /^(?:first|second)\n$/)
})

test('search_files performs bounded literal search with stable redacted previews', async (t) => {
  const fixture = await createWorkspaceFixture(t, {
    maxSearchResults: 8,
    maxSearchSnippetCharacters: 80
  })
  await fs.mkdir(join(fixture.root, 'src'))
  await fs.writeFile(
    join(fixture.root, 'src', 'z-last.ts'),
    'before NEEDLE after\nsecond needle\n',
    'utf8'
  )
  await fs.writeFile(
    join(fixture.root, 'a-first.ts'),
    'api_key=search-preview-secret\nneedle here\n',
    'utf8'
  )
  await fs.writeFile(join(fixture.root, '.env.local'), 'needle secret\n', 'utf8')
  await fs.mkdir(join(fixture.root, '.git'))
  await fs.writeFile(join(fixture.root, '.git', 'config'), 'needle protected\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'AI-TERMINAL-HISTORY.md'), 'needle bridge index\n', 'utf8')
  await fs.writeFile(
    join(fixture.root, 'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md'),
    'needle bridge task\n',
    'utf8'
  )
  await fs.writeFile(join(fixture.root, '.ai-terminal-history-hidden.tmp'), 'needle temporary\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))

  const result = await fixture.service.searchFiles(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      query: 'needle',
      caseSensitive: false
    },
    OWNER_ID
  )
  assert.deepEqual(
    result.matches.map(({ relativePath, line, column }) => ({ relativePath, line, column })),
    [
      { relativePath: 'a-first.ts', line: 2, column: 1 },
      { relativePath: 'src/z-last.ts', line: 1, column: 8 },
      { relativePath: 'src/z-last.ts', line: 2, column: 8 }
    ]
  )
  assert.equal(result.truncated, false)
  assert.ok(result.matches.every((match) => match.preview.length <= 80))
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(fixture.root), false)
  assert.equal(serialized.includes('search-preview-secret'), false)
  assert.equal(serialized.includes('.env.local'), false)
  assert.equal(serialized.includes('.git'), false)
  assert.equal(serialized.includes('AI-TERMINAL-HISTORY'), false)
  assert.equal(serialized.includes('.ai-terminal-history-'), false)

  const bounded = await new WorkspaceToolService({
    selections: fixture.selections,
    maxSearchResults: 1
  }).searchFiles(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      query: 'needle',
      caseSensitive: false
    },
    OWNER_ID
  )
  assert.equal(bounded.matches.length, 1)
  assert.equal(bounded.truncated, true)

  await assertWorkspaceError(
    fixture.service.searchFiles(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: '.',
        query: 'needle',
        caseSensitive: true
      },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )
  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.searchFiles(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: '.',
        query: 'needle',
        caseSensitive: false
      },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('replace_in_file requires one literal match and atomically commits a revisioned result', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const targetPath = join(fixture.root, 'replace.txt')
  await fs.writeFile(targetPath, 'prefix old suffix\n', 'utf8')
  const original = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'replace.txt' },
    OWNER_ID
  )

  const result = await fixture.service.replaceInFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'replace.txt',
      oldText: 'old',
      newText: 'new',
      expectedRevision: original.revision
    },
    OWNER_ID
  )
  assert.deepEqual(Object.keys(result).sort(), ['relativePath', 'replacements', 'revision'])
  assert.equal(result.relativePath, 'replace.txt')
  assert.equal(result.replacements, 1)
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.equal('content' in result, false)
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'prefix new suffix\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )

  for (const oldText of ['old', 'new']) {
    await assertWorkspaceError(
      fixture.service.replaceInFile(
        {
          workspaceToken: fixture.workspaceToken,
          relativePath: 'replace.txt',
          oldText,
          newText: 'other',
          expectedRevision: original.revision
        },
        OWNER_ID
      ),
      'write_conflict'
    )
  }

  const duplicatePath = join(fixture.root, 'duplicate.txt')
  await fs.writeFile(duplicatePath, 'same same\n', 'utf8')
  const duplicate = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'duplicate.txt' },
    OWNER_ID
  )
  await assertWorkspaceError(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'duplicate.txt',
        oldText: 'same',
        newText: 'changed',
        expectedRevision: duplicate.revision
      },
      OWNER_ID
    ),
    'write_conflict'
  )
  assert.equal(await fs.readFile(duplicatePath, 'utf8'), 'same same\n')

  await assertWorkspaceError(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'replace.txt',
        oldText: 'new',
        newText: 'blocked',
        expectedRevision: original.revision
      },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )
  await assertWorkspaceError(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: '.env',
        oldText: 'old',
        newText: 'blocked',
        expectedRevision: original.revision
      },
      OWNER_ID
    ),
    'write_not_allowed'
  )
  for (const relativePath of [
    'AI-TERMINAL-HISTORY.md',
    'AI-TERMINAL-HISTORY-11111111-1111-4111-8111-111111111111.md',
    '.ai-terminal-history-private.tmp'
  ]) {
    await assertWorkspaceError(
      fixture.service.replaceInFile(
        {
          workspaceToken: fixture.workspaceToken,
          relativePath,
          oldText: 'old',
          newText: 'blocked',
          expectedRevision: original.revision
        },
        OWNER_ID
      ),
      'write_not_allowed'
    )
  }
})

test('git.summary returns relative bounded status and redacts sensitive filenames', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)

  await fs.writeFile(join(fixture.root, 'tracked.txt'), 'one changed\ntwo\nthree\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'untracked.txt'), 'new\n', 'utf8')
  const filenameSecret = 'git-filename-secret-marker'
  await fs.writeFile(join(fixture.root, `token=${filenameSecret}.txt`), 'new\n', 'utf8')

  const summary = await fixture.service.gitSummary(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(fixture.root), false)
  assert.equal(serialized.includes(filenameSecret), false)
  assert.ok(summary.files.some((file) => file.relativePath === 'tracked.txt' && file.status === 'modified'))
  assert.ok(summary.files.some((file) => file.relativePath === 'untracked.txt' && file.status === 'untracked'))
  assert.ok(summary.additions >= 2)
  assert.ok(summary.deletions >= 1)
  assert.ok(summary.files.every((file) => !file.relativePath.includes(':\\')))
})

test('git.diff returns only bounded redacted patches for safe tracked paths', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await fs.writeFile(join(fixture.root, '.env.local'), 'TOKEN=baseline\n', 'utf8')
  await runGit(fixture.root, ['add', '--', '.env.local'])
  await runGit(fixture.root, ['commit', '-m', 'sensitive fixture'])

  const secret = 'review-diff-secret-marker'
  await fs.writeFile(join(fixture.root, 'tracked.txt'), `one staged\napi_key=${secret}\n`, 'utf8')
  await runGit(fixture.root, ['add', '--', 'tracked.txt'])
  await fs.appendFile(join(fixture.root, 'tracked.txt'), 'unstaged line\n', 'utf8')
  await fs.writeFile(join(fixture.root, '.env.local'), `TOKEN=${secret}\n`, 'utf8')
  await fs.writeFile(join(fixture.root, 'untracked.ts'), 'export const value = 1\n', 'utf8')

  const result = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.deepEqual(result.files, ['tracked.txt'])
  assert.deepEqual(result.untrackedFiles, ['untracked.ts'])
  assert.equal(result.truncated, false)
  assert.match(result.patch, /## Unstaged changes/u)
  assert.match(result.patch, /## Staged changes/u)
  assert.match(result.patch, /tracked\.txt/u)
  assert.match(result.patch, /unstaged line/u)
  assert.match(result.patch, /<redacted>/u)
  assert.equal(result.patch.includes(secret), false)
  assert.equal(result.patch.includes('.env.local'), false)
  assert.equal(JSON.stringify(result).includes(fixture.root), false)

  await assertWorkspaceError(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID + 1),
    'workspace_unavailable'
  )
  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.gitDiff(
      { workspaceToken: fixture.workspaceToken },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('git.diff treats bracket pathspec characters literally and cannot pull a sensitive neighbor', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await fs.writeFile(join(fixture.root, '.env.local'), 'TOKEN=baseline\n', 'utf8')
  await fs.writeFile(join(fixture.root, '[.]env.local'), 'safe baseline\n', 'utf8')
  await runGit(fixture.root, ['add', '--', '.env.local', '[.]env.local'])
  await runGit(fixture.root, ['commit', '-m', 'literal pathspec fixture'])

  const secret = 'literal-pathspec-sensitive-marker'
  await fs.writeFile(join(fixture.root, '.env.local'), `TOKEN=${secret}\n`, 'utf8')
  await fs.writeFile(join(fixture.root, '[.]env.local'), 'safe staged change\n', 'utf8')
  await runGit(fixture.root, ['add', '--', '[.]env.local'])

  const result = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.deepEqual(result.files, ['[.]env.local'])
  assert.match(result.patch, /\[\.\]env\.local/u)
  assert.equal(result.patch.includes(secret), false)
  assert.equal(result.patch.includes('TOKEN='), false)
})

test('git tools reject local worktree overrides, executable filters, and filter attributes', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }

  for (const attack of ['core-worktree', 'filter-config', 'filter-attributes'] as const) {
    const fixture = await createWorkspaceFixture(t)
    await initializeRepository(fixture.root)
    const marker = join(fixture.root, `filter-marker-${attack}.txt`)
    if (attack === 'core-worktree') {
      const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-worktree-outside-'))
      t.after(() => fs.rm(outside, { recursive: true, force: true }))
      await runGit(fixture.root, ['config', 'core.worktree', outside])
    } else if (attack === 'filter-config') {
      const markerForShell = marker.replace(/\\/gu, '/')
      await runGit(fixture.root, [
        'config',
        'filter.review-attack.clean',
        `echo filter-ran > "${markerForShell}" && cat`
      ])
    } else {
      await fs.writeFile(join(fixture.root, '.gitattributes'), '*.txt filter=review-attack\n', 'utf8')
    }
    await fs.appendFile(join(fixture.root, 'tracked.txt'), 'changed\n', 'utf8')

    await assertWorkspaceError(
      fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
      'git_unavailable'
    )
    await assert.rejects(fs.access(marker))
  }
})

test('git.diff rejects tracked hard links and omits local Agent control directories', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await fs.mkdir(join(fixture.root, '.codex'), { recursive: true })
  await fs.mkdir(join(fixture.root, '.agents', 'skills'), { recursive: true })
  await fs.writeFile(join(fixture.root, '.codex', 'instructions.md'), 'private control text\n', 'utf8')
  await fs.writeFile(join(fixture.root, '.agents', 'skills', 'local.md'), 'private skill text\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'visible-untracked.txt'), 'visible name only\n', 'utf8')

  const safeResult = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.deepEqual(safeResult.untrackedFiles, ['visible-untracked.txt'])
  assert.doesNotMatch(JSON.stringify(safeResult), /\.codex|\.agents|private control|private skill/u)

  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-hard-link-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  try {
    await fs.link(join(fixture.root, 'tracked.txt'), join(outside, 'tracked-copy.txt'))
  } catch (error) {
    if (isLinkPrivilegeError(error)) {
      t.skip('This host does not permit creating a hard-link fixture.')
      return
    }
    throw error
  }
  const reportedLinkCount = (await fs.lstat(join(fixture.root, 'tracked.txt'))).nlink
  if (reportedLinkCount <= 1) {
    t.skip('This filesystem does not report hard-link counts.')
    return
  }
  await assertWorkspaceError(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
    'hard_link_rejected'
  )
})

test('git.diff excludes an exact sensitive-file rename from staged review content', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  const secret = 'sensitive-rename-review-marker'
  await fs.writeFile(join(fixture.root, '.env.local'), `PRIVATE_VALUE=${secret}\n`, 'utf8')
  await runGit(fixture.root, ['add', '--', '.env.local'])
  await runGit(fixture.root, ['commit', '-m', 'sensitive rename baseline'])
  await fs.rename(join(fixture.root, '.env.local'), join(fixture.root, 'notes.txt'))
  await runGit(fixture.root, ['add', '--', '.env.local', 'notes.txt'])

  const result = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.equal(result.files.includes('notes.txt'), false)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/u)
})

test('git.diff rejects a tracked parent replaced by a junction or symlink', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  const trackedDirectory = join(fixture.root, 'linked')
  await fs.mkdir(trackedDirectory)
  await fs.writeFile(join(trackedDirectory, 'inside.txt'), 'inside baseline\n', 'utf8')
  await runGit(fixture.root, ['add', '--', 'linked/inside.txt'])
  await runGit(fixture.root, ['commit', '-m', 'junction baseline'])

  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-junction-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(join(outside, 'inside.txt'), 'outside private marker\n', 'utf8')
  await fs.rm(trackedDirectory, { recursive: true, force: true })
  try {
    await fs.symlink(outside, trackedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (isLinkPrivilegeError(error)) {
      t.skip('This host does not permit creating a junction or symlink fixture.')
      return
    }
    throw error
  }

  await assertWorkspaceError(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
    'reparse_point_rejected'
  )
})

test('git.summary terminates and fails closed when output exceeds its cap', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t, { maxGitOutputBytes: 128 })
  await initializeRepository(fixture.root)
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(
      join(fixture.root, `untracked-file-with-a-long-name-${String(index).padStart(3, '0')}.txt`),
      'x',
      'utf8'
    )
  }

  await assertWorkspaceError(
    fixture.service.gitSummary({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
    'git_output_too_large'
  )
})

test('run_command uses a relative cwd, sanitized environment, and redacts credentials in UTF-8 output', async (t) => {
  const secret = 'workspace-command-environment-secret'
  const fixture = await createWorkspaceFixture(t, {
    environmentSource: {
      ...process.env,
      AI_TERMINAL_SECRET_MARKER: secret,
      NODE_OPTIONS: '--inspect=0'
    }
  })
  await fs.mkdir(join(fixture.root, 'scripts'))
  await fs.writeFile(
    join(fixture.root, 'scripts', 'inspect.mjs'),
    [
      'console.log(process.cwd())',
      "console.log(process.env.AI_TERMINAL_SECRET_MARKER ?? 'missing')",
      "console.log(process.env.NODE_OPTIONS ?? 'node-options-missing')",
      "console.log('api_key=command-output-secret')",
      "console.error('stderr-ok')"
    ].join('\n'),
    'utf8'
  )

  const result = await fixture.service.runCommand(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'scripts',
      argv: ['node', 'inspect.mjs']
    },
    OWNER_ID
  )

  assert.equal(result.relativePath, 'scripts')
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.includes(fixture.root), true)
  assert.match(result.stdout, /missing/u)
  assert.match(result.stdout, /node-options-missing/u)
  assert.match(result.stdout, /api_key=<redacted>/u)
  assert.match(result.stderr, /stderr-ok/u)
  assert.equal(result.stdout.includes(secret), false)
})

test('run_command decodes non-ASCII Windows Python output as UTF-8', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('The Windows Python console encoding regression is Windows-specific.')
    return
  }
  if (!(await commandIsAvailable('python3', ['--version']))) {
    t.skip('python3 is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)

  const result = await fixture.service.runCommand(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      argv: ['python3', '-c', "print('中文输出正常')"]
    },
    OWNER_ID
  )

  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /中文输出正常/u)
  assert.equal(result.stderr, '')
})

test('run_command returns non-zero exit codes without turning test failures into broker errors', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(
    join(fixture.root, 'fail.mjs'),
    "console.error('expected-test-failure')\nprocess.exitCode = 7\n",
    'utf8'
  )

  const result = await fixture.service.runCommand(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      argv: ['node', 'fail.mjs']
    },
    OWNER_ID
  )

  assert.equal(result.exitCode, 7)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /expected-test-failure/u)
})

test('run_command resolves the Windows npm shim through its bounded Node entrypoint', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('The npm.cmd compatibility path is Windows-specific.')
    return
  }
  const fixture = await createWorkspaceFixture(t)

  const result = await fixture.service.runCommand(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      argv: ['npm', '--version']
    },
    OWNER_ID
  )

  assert.equal(result.exitCode, 0)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u)
  assert.equal(result.stderr, '')
})

test('run_command rejects shell, credential, absolute, traversal, and malformed argv before spawn', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const rejectedArgv: readonly (readonly string[])[] = [
    [],
    ['cmd.exe', '/c', 'echo unsafe'],
    ['powershell', '-Command', 'Write-Output unsafe'],
    ['node', '../outside.mjs'],
    ['node', 'C:\\outside\\script.mjs'],
    ['node', 'sk-command-secret-12345678'],
    ['node', '&&', 'whoami']
  ]
  for (const argv of rejectedArgv) {
    await assertWorkspaceError(
      fixture.service.runCommand(
        { workspaceToken: fixture.workspaceToken, relativePath: '.', argv },
        OWNER_ID
      ),
      'command_rejected'
    )
  }

  for (const relativePath of ['../outside', 'C:\\outside', '\\\\server\\share']) {
    await assertWorkspaceError(
      fixture.service.runCommand(
        {
          workspaceToken: fixture.workspaceToken,
          relativePath,
          argv: ['node', '--version']
        },
        OWNER_ID
      ),
      'invalid_relative_path'
    )
  }
})

test('run_command bounds combined output, times out, and honors cancellation', async (t) => {
  const outputFixture = await createWorkspaceFixture(t, { maxCommandOutputBytes: 128 })
  await fs.writeFile(
    join(outputFixture.root, 'large-output.mjs'),
    "process.stdout.write('x'.repeat(1024))\n",
    'utf8'
  )
  await assertWorkspaceError(
    outputFixture.service.runCommand(
      {
        workspaceToken: outputFixture.workspaceToken,
        relativePath: '.',
        argv: ['node', 'large-output.mjs']
      },
      OWNER_ID
    ),
    'command_output_too_large'
  )

  const timeoutFixture = await createWorkspaceFixture(t, { commandTimeoutMs: 100 })
  await fs.writeFile(
    join(timeoutFixture.root, 'wait.mjs'),
    'setInterval(() => undefined, 1_000)\n',
    'utf8'
  )
  await assertWorkspaceError(
    timeoutFixture.service.runCommand(
      {
        workspaceToken: timeoutFixture.workspaceToken,
        relativePath: '.',
        argv: ['node', 'wait.mjs']
      },
      OWNER_ID
    ),
    'command_timeout'
  )

  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    timeoutFixture.service.runCommand(
      {
        workspaceToken: timeoutFixture.workspaceToken,
        relativePath: '.',
        argv: ['node', '--version']
      },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('system access scope operates on a real sibling directory by absolute and traversal paths', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const sibling = await fs.mkdtemp(join(dirname(fixture.root), 'ai-terminal-system-sibling-'))
  t.after(() => fs.rm(sibling, { recursive: true, force: true }))
  const siblingFromWorkspace = `../${basename(sibling)}`
  const originalPath = join(sibling, 'original.txt')
  await fs.mkdir(join(sibling, 'nested'))
  await fs.writeFile(originalPath, 'system scope original needle\n', 'utf8')
  await fs.writeFile(join(sibling, 'nested', 'second.txt'), 'another needle\n', 'utf8')

  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: originalPath },
      OWNER_ID
    ),
    'invalid_relative_path'
  )

  const absoluteRead = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: originalPath },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(absoluteRead.content, 'system scope original needle\n')

  const traversalRead = await fixture.service.readFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: `${siblingFromWorkspace}/original.txt`
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(traversalRead.revision, absoluteRead.revision)

  const directory = await fixture.service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: siblingFromWorkspace },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.deepEqual(directory.entries, [
    { relativePath: 'nested', kind: 'directory' },
    { relativePath: 'original.txt', kind: 'file' }
  ])

  const search = await fixture.service.searchFiles(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: sibling,
      query: 'needle',
      caseSensitive: true
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.deepEqual(
    search.matches.map((match) => match.relativePath),
    ['nested/second.txt', 'original.txt']
  )

  const createdPath = join(sibling, 'created.txt')
  const created = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: createdPath,
      content: 'before replacement\n'
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(await fs.readFile(createdPath, 'utf8'), 'before replacement\n')

  const replaced = await fixture.service.replaceInFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: `${siblingFromWorkspace}/created.txt`,
      oldText: 'before',
      newText: 'after',
      expectedRevision: created.revision
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(replaced.replacements, 1)
  assert.equal(await fs.readFile(createdPath, 'utf8'), 'after replacement\n')

  const environmentPath = join(sibling, '.env.system-scope-test')
  await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: environmentPath,
      content: 'SYSTEM_SCOPE_ENV_OK=true\n'
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(await fs.readFile(environmentPath, 'utf8'), 'SYSTEM_SCOPE_ENV_OK=true\n')

  const filesystemRoot = parse(fixture.root).root
  const rootListing = await fixture.service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: filesystemRoot },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.ok(rootListing.entries.length > 0)

  const homeListing = await fixture.service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '~' },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.ok(Array.isArray(homeListing.entries))
  assert.ok(homedir().length > 0)
})

test('workspace delete_path removes ordinary targets but keeps the workspace boundary', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const filePath = join(fixture.root, 'delete-me.txt')
  const directoryPath = join(fixture.root, 'delete-tree')
  await fs.writeFile(filePath, 'remove me\n', 'utf8')
  await fs.mkdir(directoryPath)
  await fs.writeFile(join(directoryPath, 'nested.txt'), 'remove me too\n', 'utf8')
  await fs.mkdir(join(fixture.root, '.codex'))
  await fs.writeFile(join(fixture.root, '.codex', 'history.json'), '{}\n', 'utf8')

  const deletedFile = await fixture.service.deletePath(
    { workspaceToken: fixture.workspaceToken, relativePath: 'delete-me.txt', recursive: false },
    OWNER_ID
  )
  assert.equal(deletedFile.kind, 'file')
  await assert.rejects(fs.access(filePath), (error: unknown) => isNodeErrorCode(error, 'ENOENT'))

  const deletedDirectory = await fixture.service.deletePath(
    { workspaceToken: fixture.workspaceToken, relativePath: 'delete-tree', recursive: true },
    OWNER_ID
  )
  assert.equal(deletedDirectory.kind, 'directory')
  await assert.rejects(fs.access(directoryPath), (error: unknown) => isNodeErrorCode(error, 'ENOENT'))

  await assertWorkspaceError(
    fixture.service.deletePath(
      { workspaceToken: fixture.workspaceToken, relativePath: '.codex/history.json', recursive: false },
      OWNER_ID
    ),
    'write_not_allowed'
  )
  await assertWorkspaceError(
    fixture.service.deletePath(
      { workspaceToken: fixture.workspaceToken, relativePath: '../outside.txt', recursive: false },
      OWNER_ID
    ),
    'invalid_relative_path'
  )
})

test('system access deletes an external history file and directory', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const sibling = await fs.mkdtemp(join(dirname(fixture.root), 'ai-terminal-system-delete-'))
  t.after(() => fs.rm(sibling, { recursive: true, force: true }))
  const historyFile = join(sibling, 'conversation-history.json')
  const historyDirectory = join(sibling, 'provider-history')
  const protectedHistoryDirectory = join(sibling, 'secure')
  const protectedHistoryFile = join(protectedHistoryDirectory, 'conversation-history.json')
  await fs.mkdir(protectedHistoryDirectory)
  await fs.writeFile(historyFile, '{"history":true}\n', 'utf8')
  await fs.writeFile(protectedHistoryFile, '{"protectedHistory":true}\n', 'utf8')
  await fs.mkdir(join(historyDirectory, 'nested'), { recursive: true })
  await fs.writeFile(join(historyDirectory, 'nested', 'turn.md'), 'history\n', 'utf8')
  const service = new WorkspaceToolService({
    selections: fixture.selections,
    protectedAbsoluteRoots: [sibling]
  })

  const deletedFile = await service.deletePath(
    { workspaceToken: fixture.workspaceToken, relativePath: protectedHistoryFile, recursive: false },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(deletedFile.removed, true)
  assert.equal(deletedFile.kind, 'file')
  await assert.rejects(fs.access(protectedHistoryFile), (error: unknown) => isNodeErrorCode(error, 'ENOENT'))

  const deletedOrdinaryFile = await service.deletePath(
    { workspaceToken: fixture.workspaceToken, relativePath: historyFile, recursive: false },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(deletedOrdinaryFile.removed, true)
  await assert.rejects(fs.access(historyFile), (error: unknown) => isNodeErrorCode(error, 'ENOENT'))

  const deletedDirectory = await service.deletePath(
    { workspaceToken: fixture.workspaceToken, relativePath: historyDirectory, recursive: true },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(deletedDirectory.removed, true)
  assert.equal(deletedDirectory.kind, 'directory')
  await assert.rejects(fs.access(historyDirectory), (error: unknown) => isNodeErrorCode(error, 'ENOENT'))
})

test('system access follows an explicit directory junction outside the workspace', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const sibling = await fs.mkdtemp(join(dirname(fixture.root), 'ai-terminal-system-link-target-'))
  t.after(() => fs.rm(sibling, { recursive: true, force: true }))
  const linkPath = join(fixture.root, 'outside-link')
  await fs.writeFile(join(sibling, 'linked.txt'), 'SYSTEM_LINK_OK\n', 'utf8')
  try {
    await fs.symlink(sibling, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating a junction or symlink is not permitted on this host.')
      return
    }
    throw error
  }

  const result = await fixture.service.readFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: join(linkPath, 'linked.txt')
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(result.content, 'SYSTEM_LINK_OK\n')
})

test('system run_command accepts absolute cwd, argv paths, and an explicit platform shell', async (t) => {
  const fixture = await createWorkspaceFixture(t, {
    environmentSource: {
      ...process.env,
      AI_TERMINAL_SYSTEM_ENV: 'SYSTEM_ENV_OK'
    }
  })
  const sibling = await fs.mkdtemp(join(dirname(fixture.root), 'ai-terminal-system-command-'))
  t.after(() => fs.rm(sibling, { recursive: true, force: true }))
  const scriptPath = join(sibling, 'inspect-system.mjs')
  await fs.writeFile(
    scriptPath,
    [
      "console.log('SYSTEM_COMMAND_OK')",
      'console.log(process.cwd())',
      'console.log(process.env.AI_TERMINAL_SYSTEM_ENV)',
      "console.log('api_key=system-command-secret')"
    ].join('\n'),
    'utf8'
  )

  const absoluteResult = await fixture.service.runCommand(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: sibling,
      argv: [process.execPath, scriptPath]
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(absoluteResult.exitCode, 0)
  assert.match(absoluteResult.stdout, /SYSTEM_COMMAND_OK/u)
  assert.match(absoluteResult.stdout, /SYSTEM_ENV_OK/u)
  assert.equal(absoluteResult.stdout.includes(sibling), true)
  assert.doesNotMatch(absoluteResult.stdout, /<local-path>/u)
  assert.match(absoluteResult.stdout, /api_key=<redacted>/u)
  assert.equal(absoluteResult.stdout.includes('system-command-secret'), false)

  const shellArgv = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', 'echo SYSTEM_SHELL_OK']
    : ['/bin/sh', '-c', 'printf SYSTEM_SHELL_OK']
  const shellResult = await fixture.service.runCommand(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: `../${basename(sibling)}`,
      argv: shellArgv
    },
    OWNER_ID,
    { accessScope: 'system' }
  )
  assert.equal(shellResult.exitCode, 0)
  assert.match(shellResult.stdout, /SYSTEM_SHELL_OK/u)
})

interface FixtureOptions {
  maxFileBytes?: number
  maxResultCharacters?: number
  maxGitOutputBytes?: number
  maxDirectoryEntries?: number
  maxDirectoryResultCharacters?: number
  maxSearchResults?: number
  maxSearchFiles?: number
  maxSearchResultCharacters?: number
  maxSearchSnippetCharacters?: number
  commandTimeoutMs?: number
  maxCommandOutputBytes?: number
  environmentSource?: NodeJS.ProcessEnv
}

test('search_files regex mode finds bounded pattern matches with accurate positions', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.mkdir(join(fixture.root, 'src'), { recursive: true })
  await fs.writeFile(
    join(fixture.root, 'src', 'auth.ts'),
    'function refreshToken() {}\nconst x = 1\nrefresh_token_v2()\n',
    'utf8'
  )

  const result = await fixture.service.searchFiles(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      query: 'refresh[_A-Za-z]*[Tt]oken',
      caseSensitive: true,
      regex: true
    },
    OWNER_ID
  )
  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.matches.map((match) => ({ relativePath: match.relativePath, line: match.line, column: match.column })),
    [
      { relativePath: 'src/auth.ts', line: 1, column: 10 },
      { relativePath: 'src/auth.ts', line: 3, column: 1 }
    ]
  )
})

test('search_files regex mode rejects unsupported patterns with invalid_pattern', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  for (const query of ['(a)\\1', '(?=a)b', 'a{65}', 'a{64}'.repeat(40)]) {
    await assert.rejects(
      fixture.service.searchFiles(
        { workspaceToken: fixture.workspaceToken, relativePath: '.', query, caseSensitive: true, regex: true },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.equal(error.code, 'invalid_pattern')
        return true
      }
    )
  }
})

test('glob returns matching files newest first and honors base directories', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.mkdir(join(fixture.root, 'src', 'deep'), { recursive: true })
  await fs.mkdir(join(fixture.root, 'docs'), { recursive: true })
  await fs.writeFile(join(fixture.root, 'src', 'app.ts'), 'a', 'utf8')
  await fs.writeFile(join(fixture.root, 'src', 'deep', 'util.ts'), 'bb', 'utf8')
  await fs.writeFile(join(fixture.root, 'docs', 'note.md'), 'c', 'utf8')
  const past = new Date(Date.now() - 60_000)
  await fs.utimes(join(fixture.root, 'src', 'app.ts'), past, past)

  const all = await fixture.service.globFiles(
    { workspaceToken: fixture.workspaceToken, relativePath: '.', pattern: '*.ts' },
    OWNER_ID
  )
  assert.equal(all.truncated, false)
  assert.deepEqual(all.files.map((file) => file.relativePath), ['src/deep/util.ts', 'src/app.ts'])
  assert.equal(all.files[0]!.sizeBytes, 2)

  const scoped = await fixture.service.globFiles(
    { workspaceToken: fixture.workspaceToken, relativePath: 'src', pattern: 'deep/*.ts' },
    OWNER_ID
  )
  assert.deepEqual(scoped.files.map((file) => file.relativePath), ['src/deep/util.ts'])

  await assert.rejects(
    fixture.service.globFiles(
      { workspaceToken: fixture.workspaceToken, relativePath: '.', pattern: '{unclosed' },
      OWNER_ID
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceToolError)
      assert.equal(error.code, 'invalid_pattern')
      return true
    }
  )
})

test('search and glob skip dependency directories unless explicitly rooted inside one', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.mkdir(join(fixture.root, 'dist'), { recursive: true })
  await fs.mkdir(join(fixture.root, 'src'), { recursive: true })
  await fs.writeFile(join(fixture.root, 'dist', 'bundle.js'), 'SENTINEL_NEEDLE', 'utf8')
  await fs.writeFile(join(fixture.root, 'src', 'index.ts'), 'SENTINEL_NEEDLE', 'utf8')

  const search = await fixture.service.searchFiles(
    { workspaceToken: fixture.workspaceToken, relativePath: '.', query: 'SENTINEL_NEEDLE', caseSensitive: true },
    OWNER_ID
  )
  assert.deepEqual(search.matches.map((match) => match.relativePath), ['src/index.ts'])

  const globbed = await fixture.service.globFiles(
    { workspaceToken: fixture.workspaceToken, relativePath: '.', pattern: '*.{js,ts}' },
    OWNER_ID
  )
  assert.deepEqual(globbed.files.map((file) => file.relativePath), ['src/index.ts'])

  const rooted = await fixture.service.searchFiles(
    { workspaceToken: fixture.workspaceToken, relativePath: 'dist', query: 'SENTINEL_NEEDLE', caseSensitive: true },
    OWNER_ID
  )
  assert.deepEqual(rooted.matches.map((match) => match.relativePath), ['dist/bundle.js'])
})

async function createWorkspaceFixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-workspace-tool-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const selections = new SelectionTokenStore()
  const selection = selections.issueWorkspace(root, OWNER_ID)
  const service = new WorkspaceToolService({ selections, ...options })
  return { root, selections, service, workspaceToken: selection.workspaceToken }
}

async function initializeRepository(root: string): Promise<void> {
  await runGit(root, ['init'])
  await runGit(root, ['config', 'user.name', 'AI Terminal Test'])
  await runGit(root, ['config', 'user.email', 'test@example.invalid'])
  await fs.writeFile(join(root, 'tracked.txt'), 'one\ntwo\n', 'utf8')
  await runGit(root, ['add', '--', 'tracked.txt'])
  await runGit(root, ['commit', '-m', 'initial'])
}

async function gitIsAvailable(): Promise<boolean> {
  return commandIsAvailable('git', ['--version'])
}

async function commandIsAvailable(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never'
      }
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error('Git fixture command failed.'))
    })
  })
}

async function assertWorkspaceError(
  promise: Promise<unknown>,
  expectedCode: WorkspaceToolError['code']
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceToolError)
    assert.equal(error.code, expectedCode)
    assert.equal(error.stack, `WorkspaceToolError: ${error.message}`)
    return true
  })
}

async function assertHardLinkRejected(
  promise: Promise<unknown>,
  ...forbiddenDetails: readonly string[]
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceToolError)
    assert.equal(error.code, 'hard_link_rejected')
    assert.equal(error.stack, `WorkspaceToolError: ${error.message}`)
    const exposedError = `${error.message}\n${error.stack}`
    for (const detail of forbiddenDetails) {
      assert.equal(exposedError.includes(detail), false)
    }
    return true
  })
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value?: T): void => resolvePromise(value as T)
  }
}

async function completesWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Operation did not cancel promptly.')), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && 'code' in value && value.code === code
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

test('git.diff base "main" includes committed branch work and falls back to HEAD when main is absent', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await runGit(fixture.root, ['branch', '-M', 'main'])

  // A committed change on a feature branch: invisible to 'current' (HEAD diff),
  // visible to 'main' (merge-base diff).
  await runGit(fixture.root, ['checkout', '-b', 'feature'])
  await fs.writeFile(join(fixture.root, 'tracked.txt'), 'one\ntwo\ncommitted-on-feature\n', 'utf8')
  await runGit(fixture.root, ['add', '--', 'tracked.txt'])
  await runGit(fixture.root, ['commit', '-m', 'feature work'])
  await fs.appendFile(join(fixture.root, 'tracked.txt'), 'uncommitted-edit\n', 'utf8')

  // The committed line is an ADDED line only against main; against HEAD it is at
  // most unchanged context, never an addition.
  const current = await fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken, base: 'current' }, OWNER_ID)
  assert.doesNotMatch(current.patch, /^\+committed-on-feature/mu)
  assert.match(current.patch, /^\+uncommitted-edit/mu)

  const againstMain = await fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken, base: 'main' }, OWNER_ID)
  assert.match(againstMain.patch, /^\+committed-on-feature/mu)
  assert.match(againstMain.patch, /^\+uncommitted-edit/mu)

  // With no main/master branch, base 'main' degrades to the HEAD comparison.
  const soloFixture = await createWorkspaceFixture(t)
  await initializeRepository(soloFixture.root)
  await runGit(soloFixture.root, ['branch', '-M', 'trunk'])
  await fs.appendFile(join(soloFixture.root, 'tracked.txt'), 'solo-edit\n', 'utf8')
  const fallback = await soloFixture.service.gitDiff({ workspaceToken: soloFixture.workspaceToken, base: 'main' }, OWNER_ID)
  assert.match(fallback.patch, /solo-edit/u)

  // An unknown base value is rejected before any git process runs.
  await assert.rejects(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken, base: 'origin/main' } as never, OWNER_ID),
    (error: unknown) => error instanceof WorkspaceToolError && error.code === 'invalid_request'
  )
})

test('a truncated read must not authorize a whole-file overwrite', async (t) => {
  // maxResultCharacters forces truncation while the file stays under maxFileBytes.
  const fixture = await createWorkspaceFixture(t, { maxResultCharacters: 64 })
  const original = `${'A'.repeat(200)}\nTAIL_MUST_SURVIVE\n`
  await fs.writeFile(join(fixture.root, 'big.txt'), original, 'utf8')

  const read = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'big.txt' },
    OWNER_ID
  )
  assert.equal(read.truncated, true)
  assert.equal(read.content.includes('TAIL_MUST_SURVIVE'), false)

  // The model only saw a prefix; rewriting the whole file from it would destroy
  // the unread remainder, so the revision from a truncated read must be refused.
  await assert.rejects(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'big.txt',
        content: read.content,
        expectedRevision: read.revision,
      },
      OWNER_ID
    ),
    (error: unknown) => error instanceof WorkspaceToolError && error.code === 'partial_revision'
  )
  assert.equal(await fs.readFile(join(fixture.root, 'big.txt'), 'utf8'), original)
})

test('ranged reads return the requested window and stay safe for targeted edits', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`)
  await fs.writeFile(join(fixture.root, 'ranged.txt'), `${lines.join('\n')}\n`, 'utf8')

  const window = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'ranged.txt', startLine: 10, lineCount: 3 },
    OWNER_ID
  )
  assert.match(window.content, /line-10/u)
  assert.match(window.content, /line-12/u)
  assert.equal(window.content.includes('line-13'), false)
  assert.equal(window.content.includes('line-9\n'), false)
  // The excerpt is labelled so the model cannot mistake it for the whole file.
  assert.match(window.content, /lines 10-12 of 41/u)

  // A whole-file overwrite from an excerpt is refused...
  await assert.rejects(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'ranged.txt',
        content: window.content,
        expectedRevision: window.revision,
      },
      OWNER_ID
    ),
    (error: unknown) => error instanceof WorkspaceToolError && error.code === 'partial_revision'
  )

  // ...while a unique literal replacement still works from the same revision.
  const replaced = await fixture.service.replaceInFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'ranged.txt',
      oldText: 'line-11',
      newText: 'line-11-edited',
      expectedRevision: window.revision,
    },
    OWNER_ID
  )
  assert.ok(replaced)
  const onDisk = await fs.readFile(join(fixture.root, 'ranged.txt'), 'utf8')
  assert.match(onDisk, /line-11-edited/u)
  assert.match(onDisk, /line-40/u)
})

test('a full read still authorizes a whole-file write', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'small.txt'), 'alpha\nbeta\n', 'utf8')

  const read = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'small.txt' },
    OWNER_ID
  )
  assert.equal(read.truncated, false)
  assert.equal(read.revision.startsWith('partial:'), false)

  await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'small.txt',
      content: 'alpha\nbeta\ngamma\n',
      expectedRevision: read.revision,
    },
    OWNER_ID
  )
  assert.equal(await fs.readFile(join(fixture.root, 'small.txt'), 'utf8'), 'alpha\nbeta\ngamma\n')
})
