import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { CapabilityRegistry, type CapabilityWorkspaceIdentity } from '../../src/main/services/capability-registry.ts'
import {
  ExtensionHost,
  type ExtensionHookInvocation
} from '../../src/main/services/extension-host.ts'
import type {
  McpConnectionConfig,
  McpSession
} from '../../src/main/services/mcp-client.ts'

const OWNER = 47

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(join(process.env.TEMP ?? process.cwd(), 'ai-terminal-extension-host-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function identity(absolutePath: string): Promise<CapabilityWorkspaceIdentity> {
  const stats = await fs.lstat(absolutePath, { bigint: true })
  return {
    absolutePath,
    device: String(stats.dev),
    inode: String(stats.ino)
  }
}

test('selected skills, enabled plugins, MCP tools, and hooks share one turn session', async (t) => {
  const root = await temporaryRoot(t)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await fs.mkdir(join(workspace, '.codex', 'skills', 'focus'), { recursive: true })
  await fs.mkdir(join(workspace, '.codex-plugin'), { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(
    join(workspace, '.codex', 'skills', 'focus', 'SKILL.md'),
    '---\nname: Focus\ndescription: Focus the implementation\n---\nUse the focused workflow.\n',
    'utf8'
  )
  await fs.writeFile(
    join(workspace, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'workspace-tools',
      description: 'Workspace extension tools',
      version: '1.0.0',
      permissions: ['network', 'execute'],
      instructions: ['Prefer the workspace extension when it matches the task.'],
      mcpServers: {
        local: { command: 'node', args: ['server.mjs'], env: { TOKEN: '${EXTENSION_HOST_TEST_TOKEN}' } }
      },
      hooks: {
        beforeTurn: { command: 'node', args: ['before.mjs'] },
        beforeTool: { command: 'node', args: ['before-tool.mjs'] },
        afterTool: { command: 'node', args: ['after-tool.mjs'] },
        afterTurn: { command: 'node', args: ['after.mjs'] }
      }
    }),
    'utf8'
  )

  const configurations: McpConnectionConfig[] = []
  const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = []
  let closeCalls = 0
  const session: McpSession = {
    listTools: async () => [{
      name: 'lookup',
      description: 'Look up an item',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
    }] as never,
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: `found ${String(args.query)}` }], isError: false } as never
    },
    close: async () => { closeCalls += 1 }
  }
  const hooks: ExtensionHookInvocation[] = []
  const host = new ExtensionHost({
    registry: new CapabilityRegistry({ homeDirectory: home }),
    homeDirectory: home,
    connectMcp: async (config) => {
      configurations.push(config)
      return session
    },
    runHook: async (hook) => {
      hooks.push(hook)
      return hook.name === 'beforeTurn' ? 'Hook supplied turn context.' : ''
    }
  })
  t.after(() => host.dispose())
  const workspaceIdentity = await identity(workspace)

  const skillCatalog = await host.catalog({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    discover: 'skills'
  })
  const skill = skillCatalog.skills[0]
  assert.ok(skill)
  const skillResult = await host.invoke(
    { ownerWebContentsId: OWNER, workspace: workspaceIdentity },
    { id: skill.id, grantHandle: skill.grantHandle },
    { authorizeSkillUse: async () => true }
  )
  assert.equal(skillResult.status, 'completed')

  const pluginCatalog = await host.catalog({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    discover: 'plugins'
  })
  const plugin = pluginCatalog.plugins[0]
  assert.ok(plugin)
  assert.equal(plugin.enabled, false)
  const enabled = await host.invoke(
    { ownerWebContentsId: OWNER, workspace: workspaceIdentity },
    { id: plugin.id, grantHandle: plugin.grantHandle },
    { authorizePluginUse: async () => true }
  )
  assert.equal(enabled.status, 'completed')
  const refreshedPlugins = await host.catalog({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    discover: 'plugins'
  })
  assert.equal(refreshedPlugins.plugins[0]?.enabled, true)

  const turn = await host.openTurn({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    taskId: 'task-extension',
    turnId: 'turn-extension',
    approvalMode: 'full'
  })
  assert.equal(turn.instructions.some((value) => value.includes('focused workflow')), true)
  assert.equal(turn.instructions.some((value) => value.includes('workspace extension')), true)
  assert.equal(turn.instructions.some((value) => value.includes('Hook supplied')), true)
  assert.equal(turn.tools.length, 1)
  assert.match(turn.tools[0]!.name, /^mcp__local__lookup/u)
  assert.equal(configurations.length, 1)
  assert.equal(configurations[0]?.transport, 'stdio')

  const output = await turn.dispatch({
    type: 'function_call',
    id: 'call-1',
    callId: 'call-1',
    name: turn.tools[0]!.name,
    arguments: { query: 'alpha' }
  } as never)
  assert.match(output, /found alpha/u)
  assert.deepEqual(calls, [{ name: 'lookup', args: { query: 'alpha' } }])
  await turn.finish({ status: 'completed' })
  assert.equal(closeCalls, 1)
  assert.deepEqual(hooks.map((hook) => hook.name), [
    'beforeTurn',
    'beforeTool',
    'afterTool',
    'afterTurn'
  ])

  const statuses: string[] = []
  const deniedTurn = await host.openTurn({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    taskId: 'task-extension-denied',
    turnId: 'turn-extension-denied',
    approvalMode: 'request',
    authorizeTool: async () => false,
    onToolStatus: (event) => statuses.push(event.status)
  })
  const deniedOutput = await deniedTurn.dispatch({
    callId: 'call-denied',
    name: deniedTurn.tools[0]!.name,
    arguments: { query: 'denied' }
  })
  assert.match(deniedOutput, /denied/u)
  assert.equal(calls.length, 1)
  assert.deepEqual(statuses, ['failed'])
  await deniedTurn.dispose()
})

test('direct MCP servers load outside full mode and keep the per-call approval gate', async (t) => {
  const root = await temporaryRoot(t)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(join(workspace, '.mcp.json'), JSON.stringify({
    mcpServers: {
      local: { command: 'mcp-server', args: [] }
    }
  }), 'utf8')
  const workspaceIdentity = await identity(workspace)
  const approvals: string[] = []
  const host = new ExtensionHost({
    homeDirectory: home,
    connectMcp: async () => ({
      listTools: async () => [{
        name: 'lookup',
        description: 'Look up a value.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
      }],
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => undefined
    })
  })
  t.after(() => host.dispose())

  const turn = await host.openTurn({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    taskId: 'task-request-mode-mcp',
    turnId: 'turn-request-mode-mcp',
    approvalMode: 'request',
    authorizeTool: async (request) => {
      approvals.push(request.name)
      return true
    }
  })
  assert.equal(turn.tools.length, 1)
  assert.match(turn.tools[0]!.name, /^mcp__local__lookup/u)

  const output = await turn.dispatch({
    callId: 'call-request-1',
    name: turn.tools[0]!.name,
    arguments: { query: 'alpha' }
  })
  assert.match(output, /ok/u)
  assert.deepEqual(approvals, [turn.tools[0]!.name])
  await turn.dispose()
})

test('direct MCP failures stay diagnostic and do not prevent an Agent turn', async (t) => {
  const root = await temporaryRoot(t)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(join(workspace, '.mcp.json'), JSON.stringify({
    mcpServers: {
      unavailable: { url: 'https://mcp.example.test/api', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } }
    }
  }), 'utf8')
  const workspaceIdentity = await identity(workspace)
  const host = new ExtensionHost({
    homeDirectory: home,
    connectMcp: async () => { throw new Error('token=private-value connection refused') }
  })
  t.after(() => host.dispose())

  const turn = await host.openTurn({
    ownerWebContentsId: OWNER,
    workspace: workspaceIdentity,
    taskId: 'task-diagnostic',
    approvalMode: 'full'
  })
  assert.deepEqual(turn.tools, [])
  assert.equal(turn.diagnostics.length, 1)
  assert.match(turn.diagnostics[0]!, /暂时不可用/u)
  assert.equal(turn.diagnostics[0]!.includes('private-value'), false)
  await turn.dispose()
})

test('plugin grants are one-shot, owner-bound, and workspace-bound', async (t) => {
  const root = await temporaryRoot(t)
  const home = join(root, 'home')
  const first = join(root, 'first')
  const second = join(root, 'second')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(join(first, '.codex-plugin'), { recursive: true })
  await fs.mkdir(second, { recursive: true })
  await fs.writeFile(join(first, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'bound-plugin', version: '1.0.0', description: 'Bound plugin'
  }), 'utf8')
  const firstIdentity = await identity(first)
  const secondIdentity = await identity(second)
  const host = new ExtensionHost({ homeDirectory: home })
  t.after(() => host.dispose())

  const catalog = await host.catalog({ ownerWebContentsId: OWNER, workspace: firstIdentity, discover: 'plugins' })
  const plugin = catalog.plugins[0]
  assert.ok(plugin)
  const wrongWorkspace = await host.invoke(
    { ownerWebContentsId: OWNER, workspace: secondIdentity },
    { id: plugin.id, grantHandle: plugin.grantHandle },
    { authorizePluginUse: async () => true }
  )
  assert.equal(wrongWorkspace.status, 'not-ready')
  const replay = await host.invoke(
    { ownerWebContentsId: OWNER, workspace: firstIdentity },
    { id: plugin.id, grantHandle: plugin.grantHandle },
    { authorizePluginUse: async () => true }
  )
  assert.equal(replay.status, 'not-ready')
})

test('a plugin manifest changed after discovery cannot be enabled', async (t) => {
  const root = await temporaryRoot(t)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const manifestPath = join(workspace, '.codex-plugin', 'plugin.json')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(join(workspace, '.codex-plugin'), { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify({
    name: 'digest-plugin', version: '1.0.0', description: 'Original plugin'
  }), 'utf8')
  const workspaceIdentity = await identity(workspace)
  const host = new ExtensionHost({ homeDirectory: home })
  t.after(() => host.dispose())
  const catalog = await host.catalog({ ownerWebContentsId: OWNER, workspace: workspaceIdentity, discover: 'plugins' })
  const plugin = catalog.plugins[0]
  assert.ok(plugin)
  await fs.writeFile(manifestPath, JSON.stringify({
    name: 'digest-plugin', version: '1.0.0', description: 'Substituted plugin'
  }), 'utf8')

  const result = await host.invoke(
    { ownerWebContentsId: OWNER, workspace: workspaceIdentity },
    { id: plugin.id, grantHandle: plugin.grantHandle },
    { authorizePluginUse: async () => true }
  )
  assert.equal(result.status, 'not-ready')
})

test('a workspace skill is not injected into a different workspace', async (t) => {
  const root = await temporaryRoot(t)
  const home = join(root, 'home')
  const first = join(root, 'first')
  const second = join(root, 'second')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(join(first, '.codex', 'skills', 'first-only'), { recursive: true })
  await fs.mkdir(second, { recursive: true })
  await fs.writeFile(
    join(first, '.codex', 'skills', 'first-only', 'SKILL.md'),
    '# First only\nFIRST_WORKSPACE_ONLY\n',
    'utf8'
  )
  const firstIdentity = await identity(first)
  const secondIdentity = await identity(second)
  const host = new ExtensionHost({ homeDirectory: home })
  t.after(() => host.dispose())
  const catalog = await host.catalog({ ownerWebContentsId: OWNER, workspace: firstIdentity, discover: 'skills' })
  const skill = catalog.skills.find((item) => item.scope === 'workspace')
  assert.ok(skill)
  assert.equal((await host.invoke(
    { ownerWebContentsId: OWNER, workspace: firstIdentity },
    { id: skill.id, grantHandle: skill.grantHandle },
    { authorizeSkillUse: async () => true }
  )).status, 'completed')

  const secondTurn = await host.openTurn({
    ownerWebContentsId: OWNER,
    workspace: secondIdentity,
    taskId: 'task-second',
    approvalMode: 'full'
  })
  assert.equal(secondTurn.instructions.some((item) => item.includes('FIRST_WORKSPACE_ONLY')), false)
  await secondTurn.dispose()
})
