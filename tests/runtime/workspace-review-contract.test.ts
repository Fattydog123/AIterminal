import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (relativePath: string): Promise<string> => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8')

test('workspace directory review stays wired through channel, preload, contract, and Main handler', async () => {
  const [channels, contracts, preload, handlers] = await Promise.all([
    read('src/shared/ipc-channels.ts'),
    read('src/shared/contracts.ts'),
    read('src/preload/index.ts'),
    read('src/main/ipc/register-ipc.ts'),
  ])

  assert.match(channels, /workspaceListDirectory:\s*'workspace:listDirectory'/u)
  assert.match(contracts, /listDirectory\(input:\s*WorkspaceDirectoryInput\):\s*Promise<ApiResult<WorkspaceDirectoryResult>>/u)
  assert.match(preload, /listDirectory:\s*\(input\)\s*=>\s*invoke\(IPC_CHANNELS\.workspaceListDirectory,\s*input\)/u)
  assert.match(handlers, /ipcMain\.handle\(\s*IPC_CHANNELS\.workspaceListDirectory/u)
  assert.match(handlers, /workspaceEnvironment\.listDirectory/u)
})
