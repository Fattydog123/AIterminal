import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  AgentEvent,
  ConversationMessageDto,
  ConversationSnapshot,
  GitSummary,
  TaskSummary,
  WorkspaceDirectoryResult,
  WorkspaceFileResult
} from '../../src/shared/contracts.ts'
import { ConsentStore } from '../../src/main/security/consent-store.ts'
import { AgentApprovalService } from '../../src/main/services/agent-approval-service.ts'
import { ExtensionHost } from '../../src/main/services/extension-host.ts'
import {
  AgentTurnError,
  AgentTurnService,
  type AgentTaskWorktreeAdapter,
  type AgentTurnServiceOptions,
  type AgentTurnStartInput,
  type AgentWorkspaceToolService
} from '../../src/main/services/agent-turn-service.ts'
import type {
  ConversationMessageAppendInput,
  ConversationMessageReceipt
} from '../../src/main/services/conversation-history-service.ts'
import { WorkspaceToolError } from '../../src/main/services/workspace-tool-service.ts'
import {
  OpenAICompatibleResponsesClient,
  ResponsesClientError
} from '../../src/main/services/responses-client.ts'
import {
  AnthropicMessagesClientError,
  type AnthropicMessagesStreamWithToolsRequest
} from '../../src/main/services/anthropic-messages-client.ts'
import {
  GeminiContentClientError,
  type GeminiContentStreamWithToolsRequest
} from '../../src/main/services/gemini-content-client.ts'
import {
  ChatCompletionsClientError,
  type ChatCompletionsRemoteFailure,
  type ChatCompletionsStreamWithToolsRequest
} from '../../src/main/services/chat-completions-client.ts'
import type {
  ResponsesContinuationCapsule,
  ResponsesCredentials,
  ResponsesInputItem,
  ResponsesJsonObject,
  ResponsesRemoteFailure,
  ResponsesStreamOptions,
  ResponsesStreamRequest,
  ResponsesStreamResult
} from '../../src/main/services/responses-client.ts'
import type {
  LocalAccessScope,
  WorkspaceCommandResult,
  WorkspaceGitDiffResult,
  WorkspaceReplaceResult,
  WorkspaceSearchResult
} from '../../src/main/services/workspace-tool-service.ts'
import { redactSensitiveContent } from '../../src/main/security/redaction.ts'

const FIXED_TIME = '2026-07-15T00:00:00.000Z'
const workspaceToken = `ws_${'w'.repeat(43)}`
const workspaceProjectId = `project:workspace:${'p'.repeat(43)}`
const credentials: ResponsesCredentials = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-agent-test-secret-123456'
}

class FakeHistory {
  readonly task: TaskSummary = {
    id: 'task:agent-test',
    projectId: workspaceProjectId,
    title: 'Agent test',
    mode: 'agent',
    updatedAt: FIXED_TIME,
    archivedAt: null,
    status: 'idle'
  }
  readonly messages: ConversationMessageDto[] = []
  readonly appended: ConversationMessageAppendInput[] = []
  persistContent: (content: string) => string = (content) => content
  loadCalls = 0
  #sequence = 0

  async load(taskId: string): Promise<ConversationSnapshot> {
    this.loadCalls += 1
    assert.equal(taskId, this.task.id)
    return {
      task: { ...this.task },
      messages: this.messages.map((message) => ({ ...message })),
      events: []
    }
  }

  async appendMessage(input: ConversationMessageAppendInput): Promise<ConversationMessageReceipt> {
    this.appended.push({ ...input })
    const message: ConversationMessageDto = {
      id: `message:test-${++this.#sequence}`,
      role: input.role,
      content: this.persistContent(input.content),
      status: input.status ?? 'complete',
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME
    }
    this.messages.push(message)
    return { ...message, taskId: input.taskId }
  }

  async updateMessageStatus(input: {
    taskId: string
    messageId: string
    status: ConversationMessageDto['status']
  }): Promise<ConversationMessageReceipt> {
    const message = this.messages.find((candidate) => candidate.id === input.messageId)
    if (!message) throw new Error('fixed missing message')
    message.status = input.status
    return { ...message, taskId: input.taskId }
  }
}

class ManualScheduler {
  readonly pending: Array<() => void> = []
  readonly schedule = (operation: () => void): void => {
    this.pending.push(operation)
  }
  runAll(): void {
    for (const operation of this.pending.splice(0)) operation()
  }
}

class RecordingApprovalService extends AgentApprovalService {
  readonly authorizeRequests: Array<Parameters<AgentApprovalService['authorize']>[0]> = []

  override authorize(
    request: Parameters<AgentApprovalService['authorize']>[0]
  ): ReturnType<AgentApprovalService['authorize']> {
    this.authorizeRequests.push(request)
    return super.authorize(request)
  }
}

interface ResponseCall {
  credentials: ResponsesCredentials
  request: ResponsesStreamRequest
  options: ResponsesStreamOptions
}

class SequencedResponses {
  readonly calls: ResponseCall[] = []
  readonly #results: Array<(options: ResponsesStreamOptions) => Promise<ResponsesStreamResult>>
  readonly #autoContinuation: boolean

  constructor(
    results: Array<(options: ResponsesStreamOptions) => Promise<ResponsesStreamResult>>,
    autoContinuation = true
  ) {
    this.#results = results
    this.#autoContinuation = autoContinuation
  }

  async stream(
    callCredentials: ResponsesCredentials,
    request: ResponsesStreamRequest,
    options: ResponsesStreamOptions = {}
  ): Promise<ResponsesStreamResult> {
    this.calls.push({ credentials: callCredentials, request, options })
    const next = this.#results.shift()
    if (!next) throw new Error('unexpected fake response call')
    const result = await next(options)
    if (this.#autoContinuation) return withTestContinuation(result)
    return result
  }
}

class FakeWorkspaceTools implements AgentWorkspaceToolService {
  listCalls = 0
  readCalls = 0
  gitCalls = 0
  gitDiffCalls = 0
  writeCalls = 0
  searchCalls = 0
  replaceCalls = 0
  commandCalls = 0
  deleteCalls = 0
  readError: unknown = null
  listSignal: AbortSignal | undefined
  searchSignal: AbortSignal | undefined
  replaceSignal: AbortSignal | undefined
  commandSignal: AbortSignal | undefined
  gitDiffSignal: AbortSignal | undefined
  commandStdout: string | undefined
  readonly accessScopeCalls: Array<{
    toolName: string
    accessScope: LocalAccessScope | undefined
  }> = []
  readonly gitDiffInputs: Array<{ workspaceToken: string; ownerWebContentsId: number }> = []
  readonly searchInputs: Array<{
    workspaceToken: string
    relativePath: string
    query: string
    caseSensitive: boolean
  }> = []
  readonly replaceInputs: Array<{
    workspaceToken: string
    relativePath: string
    oldText: string
    newText: string
    expectedRevision: string
  }> = []
  readonly writeInputs: Array<{
    workspaceToken: string
    relativePath: string
    content: string
  }> = []
  readonly commandInputs: Array<{
    workspaceToken: string
    relativePath: string
    argv: readonly string[]
  }> = []
  readonly deleteInputs: Array<{
    workspaceToken: string
    relativePath: string
    recursive: boolean
  }> = []
  readonly directoryResult: WorkspaceDirectoryResult = {
    entries: [
      { relativePath: 'README.md', kind: 'file' },
      { relativePath: 'src', kind: 'directory' }
    ],
    truncated: false
  }
  fileResult: WorkspaceFileResult = {
    relativePath: 'src/main.ts',
    content: 'const apiKey = "sk-file-secret-123456";\nexport const safe = true;\n',
    revision: 'a'.repeat(64),
    truncated: false
  }
  /** Per-path overrides so a test can serve AGENTS.md distinctly from other reads. */
  readonly fileResultsByPath = new Map<string, WorkspaceFileResult>()
  readonly gitResult: GitSummary = {
    branch: 'test',
    additions: 1,
    deletions: 0,
    files: [{ relativePath: 'src/main.ts', additions: 1, deletions: 0, status: 'modified' }]
  }
  readonly gitDiffResult: WorkspaceGitDiffResult = {
    patch: '@@ -1 +1 @@\n-export const safe = false;\n+export const safe = true;\n',
    files: ['src/main.ts'],
    untrackedFiles: ['notes.txt'],
    truncated: false
  }
  readonly searchResult: WorkspaceSearchResult = {
    matches: [{ relativePath: 'src/main.ts', line: 1, column: 1, preview: 'const safe = true;' }],
    truncated: false
  }
  readonly replaceResult: WorkspaceReplaceResult = {
    relativePath: 'src/main.ts',
    revision: 'b'.repeat(64),
    replacements: 1
  }
  readonly commandResult: WorkspaceCommandResult = {
    relativePath: '.',
    exitCode: 0,
    stdout: 'v24.0.0\n',
    stderr: ''
  }

  readonly deleteResult = {
    relativePath: '.',
    kind: 'directory' as const,
    removed: true as const
  }

  async listDirectory(
    _input: { relativePath: string },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceDirectoryResult> {
    this.listCalls += 1
    this.listSignal = options?.signal
    this.accessScopeCalls.push({ toolName: 'list_directory', accessScope: options?.accessScope })
    return this.directoryResult
  }

  async readFile(
    _input: { workspaceToken: string; relativePath: string },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceFileResult> {
    const override = this.fileResultsByPath.get(_input.relativePath)
    if (override) return override
    // Most workspaces have no AGENTS.md. Model-visible read accounting must not
    // count the turn-start project-instruction probe, so answer it before the
    // counters unless a test explicitly supplies the file above.
    if (_input.relativePath === 'AGENTS.md') throw new Error('not found')
    this.readCalls += 1
    this.accessScopeCalls.push({ toolName: 'read_file', accessScope: options?.accessScope })
    if (this.readError) throw this.readError
    return this.fileResult
  }

  async gitSummary(
    _input: { workspaceToken: string },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<GitSummary> {
    this.gitCalls += 1
    this.accessScopeCalls.push({ toolName: 'git_summary', accessScope: options?.accessScope })
    return this.gitResult
  }

  async gitDiff(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceGitDiffResult> {
    this.gitDiffCalls += 1
    this.gitDiffInputs.push({ workspaceToken: input.workspaceToken, ownerWebContentsId })
    this.gitDiffSignal = options?.signal
    this.accessScopeCalls.push({ toolName: 'git_diff', accessScope: options?.accessScope })
    return this.gitDiffResult
  }

  async writeFile(
    input: { workspaceToken: string; relativePath: string; content: string },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceFileResult> {
    this.writeCalls += 1
    this.writeInputs.push({ ...input })
    this.accessScopeCalls.push({ toolName: 'write_file', accessScope: options?.accessScope })
    return {
      relativePath: input.relativePath,
      content: input.content,
      revision: 'b'.repeat(64),
      truncated: false
    }
  }

  async searchFiles(
    input: {
      workspaceToken: string
      relativePath: string
      query: string
      caseSensitive: boolean
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceSearchResult> {
    this.searchCalls += 1
    this.searchInputs.push({ ...input })
    this.searchSignal = options?.signal
    this.accessScopeCalls.push({ toolName: 'search_files', accessScope: options?.accessScope })
    return this.searchResult
  }

  async globFiles(
    input: {
      workspaceToken: string
      relativePath: string
      pattern: string
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<{ files: { relativePath: string; sizeBytes: number; modifiedMs: number }[]; truncated: boolean }> {
    this.accessScopeCalls.push({ toolName: 'glob', accessScope: options?.accessScope })
    return { files: [], truncated: false }
  }

  async replaceInFile(
    input: {
      workspaceToken: string
      relativePath: string
      oldText: string
      newText: string
      expectedRevision: string
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceReplaceResult> {
    this.replaceCalls += 1
    this.replaceInputs.push({ ...input })
    this.replaceSignal = options?.signal
    this.accessScopeCalls.push({ toolName: 'replace_in_file', accessScope: options?.accessScope })
    return this.replaceResult
  }

  async runCommand(
    input: {
      workspaceToken: string
      relativePath: string
      argv: readonly string[]
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<WorkspaceCommandResult> {
    this.commandCalls += 1
    this.commandInputs.push({ ...input, argv: [...input.argv] })
    this.commandSignal = options?.signal
    this.accessScopeCalls.push({ toolName: 'run_command', accessScope: options?.accessScope })
    return this.commandStdout === undefined
      ? this.commandResult
      : { ...this.commandResult, stdout: this.commandStdout }
  }

  async deletePath(
    input: {
      workspaceToken: string
      relativePath: string
      recursive: boolean
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal; accessScope?: LocalAccessScope }
  ): Promise<typeof this.deleteResult> {
    this.deleteCalls += 1
    this.deleteInputs.push({ ...input })
    this.accessScopeCalls.push({ toolName: 'delete_path', accessScope: options?.accessScope })
    return { ...this.deleteResult, relativePath: input.relativePath }
  }
}

function startInput(overrides: Partial<AgentTurnStartInput> = {}): AgentTurnStartInput {
  return {
    taskId: 'task:agent-test',
    prompt: 'Inspect src/main.ts and summarize it.',
    credentials,
    model: 'gpt-agent-test',
    endpointType: 'openai-response',
    wireMode: 'standard',
    modelCapabilities: {
      attachments: true,
      imageInput: true,
      imageGeneration: true,
      subagents: true,
      toolUse: true,
      webSearch: true
    },
    reasoning: 'high',
    webSearch: false,
    imageGeneration: false,
    subagentsEnabled: false,
    attachments: [],
    approvalMode: 'request',
    planMode: false,
    reviewMode: false,
    workspaceToken,
    workspaceProjectId,
    ownerWebContentsId: 7,
    ...overrides
  }
}

function requestItems(request: ResponsesStreamRequest | undefined): readonly ResponsesInputItem[] {
  return request?.messages ?? request?.continuation?.outputs ?? []
}

function withTestContinuation(result: ResponsesStreamResult): ResponsesStreamResult {
  if (result.toolCalls.length === 0 || result.continuation) return result
  return {
    ...result,
    continuation: Object.freeze({}) as ResponsesContinuationCapsule
  }
}

function priorMessages(count: number): ConversationMessageDto[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message:prior-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `encrypted history ${index + 1}`,
    status: 'complete',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME
  }))
}

function createHarness(
  responses: AgentTurnServiceOptions['responses'],
  options: {
    imageResults?: AgentTurnServiceOptions['imageResults']
    chatCompletions?: AgentTurnServiceOptions['chatCompletions']
    anthropic?: AgentTurnServiceOptions['anthropic']
    gemini?: AgentTurnServiceOptions['gemini']
    subagentWorktrees?: AgentTaskWorktreeAdapter
    executionBudget?: AgentTurnServiceOptions['executionBudget']
    onConversationUpdated?: AgentTurnServiceOptions['onConversationUpdated']
    extensions?: AgentTurnServiceOptions['extensions']
    checkpoints?: AgentTurnServiceOptions['checkpoints']
  } = {}
): {
  service: AgentTurnService
  approvals: RecordingApprovalService
  history: FakeHistory
  tools: FakeWorkspaceTools
  scheduler: ManualScheduler
  events: AgentEvent[]
} {
  const history = new FakeHistory()
  const tools = new FakeWorkspaceTools()
  const scheduler = new ManualScheduler()
  const events: AgentEvent[] = []
  const approvals = new RecordingApprovalService({
    consents: new ConsentStore(),
    onEvent: (event) => events.push(event)
  })
  const service = new AgentTurnService({
    history,
    responses,
    chatCompletions: options.chatCompletions ?? {
      streamWithTools: async () => {
        throw new Error('unexpected Chat Completions test call')
      }
    },
    anthropic: options.anthropic ?? {
      streamWithTools: async () => {
        throw new Error('unexpected Anthropic Messages test call')
      }
    },
    gemini: options.gemini ?? {
      streamWithTools: async () => {
        throw new Error('unexpected Gemini GenerateContent test call')
      }
    },
    approvals,
    workspaceTools: tools,
    extensions: options.extensions,
    checkpoints: options.checkpoints,
    subagentWorktrees: options.subagentWorktrees,
    imageResults: options.imageResults,
    executionBudget: options.executionBudget,
    onConversationUpdated: options.onConversationUpdated,
    schedule: scheduler.schedule,
    onEvent: (event) => events.push(event)
  })
  return { service, approvals, history, tools, scheduler, events }
}

test('Agent syncs visible workspace history after each persisted message without coupling turn success to export', async () => {
  const updates: Array<{ taskId: string; roles: string[]; assistantContent: string | undefined }> = []
  let harness!: ReturnType<typeof createHarness>
  harness = createHarness(new SequencedResponses([
    async (options) => await finalResult(options, 'Persisted before export.\n')
]), {
    onConversationUpdated: async (taskId) => {
      updates.push({
        taskId,
        roles: harness.history.messages.map((message) => message.role),
        assistantContent: harness.history.messages.find((message) => message.role === 'assistant')?.content
      })
      throw new Error('fixed export failure')
    }
  })

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent completion after export failure'
  )

  assert.deepEqual(updates, [
    {
      taskId: 'task:agent-test',
      roles: ['user'],
      assistantContent: undefined
    },
    {
      taskId: 'task:agent-test',
      roles: ['user', 'assistant'],
      assistantContent: 'Persisted before export.\n'
    }
  ])
  assert.equal(
    harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    false
  )
})

test('Agent loads Extension Host instructions and tools, dispatches MCP, and finishes the session once', async () => {
  const extensionToolName = 'mcp__docs__lookup'
  const dispatched: Array<{ name: string; arguments: ResponsesJsonObject }> = []
  const finished: string[] = []
  const opened: Array<Record<string, unknown>> = []
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_extension_tool',
      outputText: '',
      toolCalls: [{
        callId: 'call_extension_1',
        name: extensionToolName,
        arguments: { query: 'extension host' }
      }]
    }),
    async (options) => await finalResult(options, 'Extension tool completed.\n')
])
  const harness = createHarness(responses, {
    extensions: {
      openTurn: async (context) => {
        opened.push(context as unknown as Record<string, unknown>)
        return {
          instructions: ['Use the selected extension for documentation lookup.'],
          tools: [{
            type: 'function',
            name: extensionToolName,
            description: 'Look up documentation.',
            strict: false,
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false
            }
          }],
          diagnostics: [],
          dispatch: async (toolCall) => {
            dispatched.push({ name: toolCall.name, arguments: toolCall.arguments })
            return '{"content":[{"type":"text","text":"matched"}]}'
          },
          finish: async (result) => { finished.push(result.status) },
          dispose: async () => { finished.push('disposed') }
        }
      }
    }
  })

  await harness.service.start(startInput({
    workspaceIdentity: {
      absolutePath: 'C:\\workspace',
      device: 'device-extension',
      inode: 'inode-extension'
    }
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Extension Agent completion'
  )

  assert.equal(opened.length, 1)
  assert.equal(opened[0]?.taskId, 'task:agent-test')
  assert.match(responses.calls[0]?.request.instructions ?? '', /selected extension/u)
  assert.equal(responses.calls[0]?.request.tools.some((tool) => tool.name === extensionToolName), true)
  assert.deepEqual(dispatched, [{
    name: extensionToolName,
    arguments: { query: 'extension host' }
  }])
  assert.deepEqual(finished, ['completed'])
  assertNoWorkspaceDispatch(harness.tools)
})

test('real Agent approval gates a real local Extension Host MCP process', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-agent-extension-mcp-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const pluginDirectory = join(workspace, '.codex-plugin')
  const serverPath = join(pluginDirectory, 'approval-mcp.cjs')
  const markerPath = join(workspace, 'approved-marker.txt')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(pluginDirectory, { recursive: true })
  await fs.writeFile(serverPath, String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
const markerPath = process.argv[2]
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let initialized = false
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'approval-fixture', version: '1.0.0' }
      }
    })
    return
  }
  if (message.method === 'notifications/initialized') {
    initialized = true
    return
  }
  if (!initialized) process.exit(80)
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'write_marker',
          description: 'Write the approved local marker.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
          }
        }]
      }
    })
    return
  }
  if (message.method === 'tools/call') {
    fs.writeFileSync(markerPath, String(message.params.arguments.value), 'utf8')
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'marker written' }] }
    })
    return
  }
  if (message.method !== 'notifications/cancelled') process.exit(81)
})
`, 'utf8')
  await fs.writeFile(join(pluginDirectory, 'plugin.json'), JSON.stringify({
    name: 'approval-mcp',
    version: '1.0.0',
    description: 'Local approval integration',
    permissions: ['execute', 'network'],
    mcpServers: {
      local: {
        command: process.execPath,
        args: [serverPath, markerPath],
        requestTimeoutMs: 2_000
      }
    }
  }), 'utf8')

  const stats = await fs.lstat(workspace, { bigint: true })
  const workspaceIdentity = {
    absolutePath: workspace,
    device: String(stats.dev),
    inode: String(stats.ino)
  }
  const extensions = new ExtensionHost({ homeDirectory: home })
  t.after(async () => {
    await extensions.dispose()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  const catalog = await extensions.catalog({
    ownerWebContentsId: 7,
    workspace: workspaceIdentity,
    discover: 'plugins'
  })
  const plugin = catalog.plugins[0]
  assert.ok(plugin)
  const enabled = await extensions.invoke(
    { ownerWebContentsId: 7, workspace: workspaceIdentity },
    { id: plugin.id, grantHandle: plugin.grantHandle },
    { authorizePluginUse: async () => true }
  )
  assert.equal(enabled.status, 'completed')

  const extensionToolName = 'mcp__local__write_marker'
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_real_extension_tool',
      outputText: '',
      toolCalls: [{
        callId: 'call_real_extension_tool',
        name: extensionToolName,
        arguments: { value: 'APPROVED_EXTENSION_MCP' }
      }]
    }),
    async (options) => await finalResult(options, 'Approved extension completed.\n')
])
  const harness = createHarness(responses, { extensions })
  await harness.service.start(startInput({
    approvalMode: 'request',
    workspaceIdentity
  }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'real extension MCP approval request'
  )
  await assert.rejects(fs.access(markerPath))
  assert.equal(harness.approvals.authorizeRequests.length, 1)
  const exactRequest = harness.approvals.authorizeRequests[0]
  assert.equal(exactRequest?.operation, 'execute')
  assert.equal(exactRequest?.toolName, extensionToolName)
  assert.equal(exactRequest?.risk, 'high')
  assert.equal(exactRequest?.mode, 'request')
  assert.deepEqual(exactRequest?.arguments, { value: 'APPROVED_EXTENSION_MCP' })

  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'approved real extension MCP completion'
  )

  assert.equal(await fs.readFile(markerPath, 'utf8'), 'APPROVED_EXTENSION_MCP')
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /marker written/u)
  assertNoWorkspaceDispatch(harness.tools)
})

test('Agent syncs a persisted user message even when the model fails before assistant output', async () => {
  const updates: Array<{ taskId: string; roles: string[] }> = []
  let harness!: ReturnType<typeof createHarness>
  harness = createHarness(new SequencedResponses([
    async () => { throw new ResponsesClientError('network_error') }
  ]), {
    onConversationUpdated: async (taskId) => {
      updates.push({ taskId, roles: harness.history.messages.map((message) => message.role) })
    }
  })

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'Agent failure before assistant output'
  )

  assert.deepEqual(updates, [{ taskId: 'task:agent-test', roles: ['user'] }])
  assert.equal(harness.history.messages.some((message) => message.role === 'assistant'), false)
})

test('Agent reports fixed safe diagnostics for classified endpoint rejections', async () => {
  const cases: ReadonlyArray<readonly [ResponsesRemoteFailure, string]> = [
    ['authorization', 'Agent 请求未获模型 endpoint 授权，请检查 API Key 权限和渠道配置。'],
    ['tool_incompatible', '当前渠道或模型可能不兼容 Agent 工具调用，请改用支持 Responses 工具的模型。'],
    ['responses_unsupported', '当前渠道未提供 Agent 所需的 Responses 接口，请检查中转站兼容性。'],
    ['rate_limited', 'Agent 请求受到频率或额度限制，请稍后重试。'],
    ['server_error', '模型 endpoint 服务暂时异常，请稍后重试 Agent。'],
    ['output_limited', '模型达到输出长度限制，Agent 本轮未完整结束；请缩小任务或重试。'],
    ['content_filtered', 'Agent 请求被模型安全策略拦截，请调整内容后重试。'],
    ['request_rejected', '模型 endpoint 拒绝了 Agent 请求，请检查渠道和模型。']
  ]

  for (const [remoteFailure, expectedMessage] of cases) {
    const rawMarker = `raw-${remoteFailure}-body-secret-D-private-path`
    const error = new ResponsesClientError('remote_rejected', false, remoteFailure) as
      ResponsesClientError & { raw?: string }
    error.raw = rawMarker
    const responses = new SequencedResponses([
      async () => { throw error }
    ])
    const harness = createHarness(responses)

    await harness.service.start(startInput())
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
      `${remoteFailure} Agent diagnostic`
    )

    const failed = harness.events.find(
      (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
        event.type === 'turn-status' && event.status === 'failed'
    )
    assert.equal(failed?.message, expectedMessage)
    const serialized = JSON.stringify({ events: harness.events, appended: harness.history.appended })
    assert.doesNotMatch(serialized, new RegExp(rawMarker))
    assert.doesNotMatch(serialized, /sk-agent-test-secret|example\.test|D-private-path/u)
  }
})

test('Agent diagnostics identify the declared protocol and stream failure category', async () => {
  const responsesCases: ReadonlyArray<readonly ['invalid_response' | 'remote_error', string]> = [
    ['invalid_response', '服务端声明为 Responses，但返回的 Agent 流格式无效。'],
    ['remote_error', '服务端声明为 Responses，但 Agent 流内返回了错误事件。']
  ]
  for (const [code, expectedMessage] of responsesCases) {
    const harness = createHarness(new SequencedResponses([
      async () => { throw new ResponsesClientError(code) }
    ]))
    await harness.service.start(startInput())
    harness.scheduler.runAll()
    await waitFor(() => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'), `${code} Responses diagnostic`)
    const failed = harness.events.find((event): event is Extract<AgentEvent, { type: 'turn-status' }> => event.type === 'turn-status' && event.status === 'failed')
    assert.equal(failed?.message, expectedMessage)
  }

  const chatHarness = createHarness(new SequencedResponses([]), {
    chatCompletions: { streamWithTools: async () => { throw new ChatCompletionsClientError('remote_error') } }
  })
  await chatHarness.service.start(startInput({ endpointType: 'openai', reasoning: 'auto' }))
  chatHarness.scheduler.runAll()
  await waitFor(() => chatHarness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'), 'Chat Completions stream diagnostic')
  const chatFailed = chatHarness.events.find((event): event is Extract<AgentEvent, { type: 'turn-status' }> => event.type === 'turn-status' && event.status === 'failed')
  assert.equal(chatFailed?.message, '服务端声明为 Chat Completions，但 Agent 流内返回了错误事件。')

  const anthropicHarness = createHarness(new SequencedResponses([]), {
    anthropic: { streamWithTools: async () => { throw new AnthropicMessagesClientError('invalid_response') } }
  })
  await anthropicHarness.service.start(startInput({ endpointType: 'anthropic', reasoning: 'auto' }))
  anthropicHarness.scheduler.runAll()
  await waitFor(() => anthropicHarness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'), 'Anthropic stream diagnostic')
  const anthropicFailed = anthropicHarness.events.find((event): event is Extract<AgentEvent, { type: 'turn-status' }> => event.type === 'turn-status' && event.status === 'failed')
  assert.equal(anthropicFailed?.message, '服务端声明为 Anthropic Messages，但返回的 Agent 流格式无效。')

  const geminiHarness = createHarness(new SequencedResponses([]), {
    gemini: { streamWithTools: async () => { throw new GeminiContentClientError('remote_error') } }
  })
  await geminiHarness.service.start(startInput({ endpointType: 'gemini', reasoning: 'auto' }))
  geminiHarness.scheduler.runAll()
  await waitFor(() => geminiHarness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'), 'Gemini stream diagnostic')
  const geminiFailed = geminiHarness.events.find((event): event is Extract<AgentEvent, { type: 'turn-status' }> => event.type === 'turn-status' && event.status === 'failed')
  assert.equal(geminiFailed?.message, '服务端声明为 Gemini GenerateContent，但 Agent 流内返回了错误事件。')
})

test('Agent identifies a Chat Completions SSE response as an unsupported Responses endpoint', async () => {
  const rawMarker = 'raw-chat-completions-upstream-secret-D-private-path'
  const responses = new OpenAICompatibleResponsesClient({
    fetcher: (async () => new Response(
      `data: ${JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion.chunk',
        choices: [{ delta: { content: rawMarker } }]
      })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
    )) as typeof fetch
  })
  const harness = createHarness(responses)

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'Chat Completions compatibility diagnostic'
  )

  const failed = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
      event.type === 'turn-status' && event.status === 'failed'
  )
  assert.equal(failed?.message, '当前渠道未提供 Agent 所需的 Responses 接口，请检查中转站兼容性。')
  const serialized = JSON.stringify({ events: harness.events, appended: harness.history.appended })
  assert.doesNotMatch(serialized, new RegExp(rawMarker))
  assert.doesNotMatch(serialized, /sk-agent-test-secret|example\.test|D-private-path/u)
})

test('Chat Completions Agent reports classified and redacted endpoint rejections', async () => {
  const cases: ReadonlyArray<readonly [ChatCompletionsRemoteFailure, string]> = [
    ['authorization', 'Agent 请求未获模型 endpoint 授权，请检查访问令牌和渠道配置。'],
    ['chat_completions_unsupported', '当前渠道未提供服务端声明的 Chat Completions 接口。'],
    ['rate_limited', 'Agent 请求受到频率或额度限制，请稍后重试。'],
    ['server_error', '模型 endpoint 服务暂时异常，请稍后重试 Agent。'],
    ['request_rejected', '模型 endpoint 拒绝了 Agent 请求，请检查渠道和模型配置。']
  ]

  for (const [remoteFailure, expectedMessage] of cases) {
    const rawMarker = `raw-chat-${remoteFailure}-secret-D-private-path`
    const error = new ChatCompletionsClientError('remote_rejected', false, remoteFailure) as
      ChatCompletionsClientError & { raw?: string }
    error.raw = rawMarker
    const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
      streamWithTools: async () => { throw error }
    }
    const harness = createHarness(new SequencedResponses([]), { chatCompletions })

    await harness.service.start(startInput({ endpointType: 'openai', reasoning: 'auto' }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
      `${remoteFailure} Chat Completions Agent diagnostic`
    )

    const failed = harness.events.find(
      (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
        event.type === 'turn-status' && event.status === 'failed'
    )
    assert.equal(failed?.message, expectedMessage)
    const serialized = JSON.stringify({ events: harness.events, appended: harness.history.appended })
    assert.doesNotMatch(serialized, new RegExp(rawMarker))
    assert.doesNotMatch(serialized, /sk-agent-test-secret|example\.test|D-private-path/u)
  }
})

test('Agent uses the Chat Completions tool loop when the server declares the openai endpoint', async () => {
  const requests: unknown[] = []
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      requests.push(structuredClone(request))
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Online Chat Completions Agent reply.\n'
      })
      return {
        responseId: 'chatcmpl-agent-test',
        outputText: 'Online Chat Completions Agent reply.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const responses = new SequencedResponses([])
  const harness = createHarness(responses, { chatCompletions })

  await harness.service.start(startInput({
    endpointType: 'openai',
    reasoning: 'auto',
    modelCapabilities: {
      attachments: false,
      imageInput: false,
      imageGeneration: false,
      subagents: false,
      toolUse: true,
      webSearch: false
    }
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Chat Completions Agent completion'
  )

  assert.equal(responses.calls.length, 0)
  assert.equal(requests.length, 1)
  assert.match(JSON.stringify(requests[0]), /list_directory/u)
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'Online Chat Completions Agent reply.\n'
  )
})

test('Agent falls back in declared endpoint order before any tool call and discards failed protocol text', async () => {
  let chatCalls = 0
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async (_credentials, _request, options = {}) => {
      chatCalls += 1
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'discarded partial Chat Completions text'
      })
      throw new ChatCompletionsClientError(
        'remote_rejected',
        false,
        'chat_completions_unsupported'
      )
    }
  }
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Responses fallback completed.\n')
])
  const harness = createHarness(responses, { chatCompletions })

  await harness.service.start(startInput({
    endpointType: 'openai',
    endpointPath: '/v1/chat/completions',
    reasoning: 'auto',
    ...({
      endpointCandidates: [
        { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
        { endpointType: 'openai-response', endpointPath: '/v1/responses' }
      ]
    } as unknown as Partial<AgentTurnStartInput>)
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'declared endpoint fallback completion'
  )

  assert.equal(chatCalls, 1)
  assert.equal(responses.calls.length, 1)
  assert.equal(responses.calls[0]?.request.endpointPath, '/v1/responses')
  assertNoWorkspaceDispatch(harness.tools)
  assert.equal(
    harness.events.some((event) => (
      event.type === 'assistant-delta' && event.text.includes('discarded partial')
    )),
    false
  )
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'Responses fallback completed.\n'
  )
})

test('Agent does not retry another declared endpoint for authorization or malformed-stream failures', async () => {
  const failures = [
    new ChatCompletionsClientError('remote_rejected', false, 'authorization'),
    new ChatCompletionsClientError('invalid_response')
  ] as const

  for (const failure of failures) {
    let chatCalls = 0
    const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
      streamWithTools: async () => {
        chatCalls += 1
        throw failure
      }
    }
    const responses = new SequencedResponses([
      async (options) => await finalResult(options, 'must not be retried')
])
    const harness = createHarness(responses, { chatCompletions })

    await harness.service.start(startInput({
      endpointType: 'openai',
      endpointPath: '/v1/chat/completions',
      reasoning: 'auto',
      endpointCandidates: [
        { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
        { endpointType: 'openai-response', endpointPath: '/v1/responses' }
      ]
    }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
      'non-negotiable Agent protocol failure'
    )

    assert.equal(chatCalls, 1)
    assert.equal(responses.calls.length, 0)
  }
})

test('Agent preserves Anthropic reasoning when an OpenAI endpoint falls back before a tool call', async () => {
  const calls: AnthropicMessagesStreamWithToolsRequest[] = []
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async () => {
      throw new ChatCompletionsClientError(
        'remote_rejected',
        false,
        'chat_completions_unsupported'
      )
    }
  }
  const anthropic: AgentTurnServiceOptions['anthropic'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push(structuredClone(request))
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Anthropic fallback completed.\n'
      })
      return {
        responseId: 'msg_anthropic_fallback',
        outputText: 'Anthropic fallback completed.\n',
        assistantContent: [{ type: 'text', text: 'Anthropic fallback completed.\n' }],
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const harness = createHarness(new SequencedResponses([]), { chatCompletions, anthropic })

  await harness.service.start(startInput({
    endpointType: 'openai',
    endpointPath: '/v1/chat/completions',
    reasoning: 'max',
    endpointCandidates: [
      { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
      {
        endpointType: 'anthropic',
        endpointPath: '/v1/messages',
        reasoningProtocol: { type: 'anthropic-adaptive' }
      }
    ]
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && (
      event.status === 'completed' || event.status === 'failed'
    )),
    'Anthropic reasoning fallback terminal state'
  )
  const anthropicTerminal = harness.events.filter((event) => event.type === 'turn-status').at(-1)
  assert.equal(anthropicTerminal?.status, 'completed')

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.reasoning, 'max')
  assert.deepEqual(calls[0]?.reasoningProtocol, { type: 'anthropic-adaptive' })
})

test('Agent preserves Gemini reasoning when an OpenAI endpoint falls back before a tool call', async () => {
  const calls: GeminiContentStreamWithToolsRequest[] = []
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async () => {
      throw new ChatCompletionsClientError(
        'remote_rejected',
        false,
        'chat_completions_unsupported'
      )
    }
  }
  const gemini: AgentTurnServiceOptions['gemini'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push(structuredClone(request))
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Gemini fallback completed.\n'
      })
      return {
        responseId: 'gemini-fallback',
        outputText: 'Gemini fallback completed.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const harness = createHarness(new SequencedResponses([]), { chatCompletions, gemini })

  await harness.service.start(startInput({
    endpointType: 'openai',
    endpointPath: '/v1/chat/completions',
    reasoning: 'high',
    endpointCandidates: [
      { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
      {
        endpointType: 'gemini',
        endpointPath: '/v1beta/models/{model}:streamGenerateContent',
        reasoningProtocol: { type: 'gemini-level', includeThoughts: false }
      }
    ]
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && (
      event.status === 'completed' || event.status === 'failed'
    )),
    'Gemini reasoning fallback terminal state'
  )
  const geminiTerminal = harness.events.filter((event) => event.type === 'turn-status').at(-1)
  assert.equal(geminiTerminal?.status, 'completed')

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.reasoning, 'high')
  assert.deepEqual(calls[0]?.reasoningProtocol, {
    type: 'gemini-level',
    includeThoughts: false
  })
})

test('Agent locks the selected protocol after a tool call and never falls back after dispatch', async () => {
  let chatCalls = 0
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async () => {
      chatCalls += 1
      if (chatCalls === 1) {
        return {
          responseId: 'chatcmpl-lock-tool',
          outputText: '',
          toolCalls: [{
            id: 'call_chat_lock_read',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ relative_path: 'src/main.ts' })
            }
          }],
          hasToolCalls: true
        }
      }
      throw new ChatCompletionsClientError('invalid_response')
    }
  }
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'must not run')
])
  const harness = createHarness(responses, { chatCompletions })

  await harness.service.start(startInput({
    endpointType: 'openai',
    endpointPath: '/v1/chat/completions',
    endpointCandidates: [
      { endpointType: 'openai', endpointPath: '/v1/chat/completions' },
      { endpointType: 'openai-response', endpointPath: '/v1/responses' }
    ],
    approvalMode: 'auto',
    reasoning: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'locked protocol failure'
  )

  assert.equal(chatCalls, 2)
  assert.equal(responses.calls.length, 0)
  assert.equal(harness.tools.readCalls, 1)
  const failed = harness.events.find((event): event is Extract<AgentEvent, { type: 'turn-status' }> => (
    event.type === 'turn-status' && event.status === 'failed'
  ))
  assert.equal(failed?.message, '服务端声明为 Chat Completions，但返回的 Agent 流格式无效。')
})

test('Agent never probes an undeclared fallback for a single-endpoint model', async () => {
  let chatCalls = 0
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async () => {
      chatCalls += 1
      throw new ChatCompletionsClientError('invalid_response')
    }
  }
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'must not run')
])
  const harness = createHarness(responses, { chatCompletions })

  await harness.service.start(startInput({ endpointType: 'openai', reasoning: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'single endpoint failure'
  )

  assert.equal(chatCalls, 1)
  assert.equal(responses.calls.length, 0)
  assertNoWorkspaceDispatch(harness.tools)
})

test('Agent completes a two-round Chat Completions read tool loop with the confirmed route and signal', async () => {
  const calls: Array<{
    request: ChatCompletionsStreamWithToolsRequest
    signal: AbortSignal | undefined
  }> = []
  const nativeToolCall = {
    id: 'call_chat_read',
    type: 'function' as const,
    function: {
      name: 'read_file',
      arguments: JSON.stringify({ relative_path: 'src/main.ts' })
    }
  }
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push({ request: structuredClone(request), signal: options.signal })
      if (calls.length === 1) {
        return {
          responseId: 'chatcmpl-read-tool',
          outputText: '',
          toolCalls: [nativeToolCall],
          hasToolCalls: true
        }
      }
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Chat Completions read completed.\n'
      })
      return {
        responseId: 'chatcmpl-read-final',
        outputText: 'Chat Completions read completed.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const responses = new SequencedResponses([])
  const harness = createHarness(responses, { chatCompletions })

  await harness.service.start(startInput({
    endpointType: 'openai',
    endpointPath: '/v1/chat/completions',
    approvalMode: 'auto',
    reasoning: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'two-round Chat Completions Agent completion'
  )

  assert.equal(responses.calls.length, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.request.endpointPath, '/v1/chat/completions')
  assert.equal(calls[1]?.request.endpointPath, '/v1/chat/completions')
  assert.ok(calls[0]?.signal instanceof AbortSignal)
  assert.equal(calls[1]?.signal, calls[0]?.signal)
  const chatFollowUp = calls[1]?.request.messages.slice(-2)
  assert.deepEqual(chatFollowUp?.[0], {
    role: 'assistant',
    content: '',
    tool_calls: [nativeToolCall]
  })
  assert.ok(chatFollowUp?.[1]?.role === 'tool')
  assert.equal(chatFollowUp[1].tool_call_id, 'call_chat_read')
  assert.match(chatFollowUp[1].content, /Relative workspace file: src\/main\.ts/u)
  assert.match(chatFollowUp[1].content, new RegExp(`Revision: ${'a'.repeat(64)}`))
  assert.match(chatFollowUp[1].content, /const apiKey = "<redacted>";/u)
  assert.doesNotMatch(chatFollowUp[1].content, /sk-file-secret/u)
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'Chat Completions read completed.\n'
  )
})

test('Agent runs a two-round native Anthropic loop with batched tool results and route metadata', async () => {
  const calls: Array<{
    request: AnthropicMessagesStreamWithToolsRequest
    signal: AbortSignal | undefined
  }> = []
  const anthropic: AgentTurnServiceOptions['anthropic'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push({ request: structuredClone(request), signal: options.signal })
      if (calls.length === 1) {
        const assistantContent = [
          {
            type: 'thinking' as const,
            thinking: 'private-anthropic-reasoning',
            signature: 'anthropic-thinking-signature'
          },
          {
            type: 'tool_use' as const,
            id: 'toolu_list_workspace',
            name: 'list_directory',
            input: { relative_path: '.' }
          },
          {
            type: 'redacted_thinking' as const,
            data: 'cmVkYWN0ZWQtdGhpbmtpbmc='
          },
          {
            type: 'tool_use' as const,
            id: 'toolu_git_summary',
            name: 'git_summary',
            input: {}
          }
        ]
        return {
          responseId: 'msg_anthropic_tools',
          outputText: '',
          assistantContent,
          toolCalls: [
            {
              id: 'toolu_list_workspace',
              name: 'list_directory',
              input: { relative_path: '.' }
            },
            {
              id: 'toolu_git_summary',
              name: 'git_summary',
              input: {}
            }
          ],
          hasToolCalls: true
        }
      }
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Native Anthropic Agent completed.\n'
      })
      return {
        responseId: 'msg_anthropic_final',
        outputText: 'Native Anthropic Agent completed.\n',
        assistantContent: [{ type: 'text', text: 'Native Anthropic Agent completed.\n' }],
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const responses = new SequencedResponses([])
  const harness = createHarness(responses, { anthropic })

  await harness.service.start(startInput({
    endpointType: 'anthropic',
    endpointPath: '/v1/messages',
    approvalMode: 'auto',
    reasoning: 'high',
    reasoningProtocol: { type: 'anthropic-adaptive' }
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'native Anthropic Agent completion'
  )

  assert.equal(responses.calls.length, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.request.endpointPath, '/v1/messages')
  assert.equal(calls[1]?.request.endpointPath, '/v1/messages')
  assert.equal(calls[0]?.request.reasoning, 'high')
  assert.deepEqual(calls[0]?.request.reasoningProtocol, { type: 'anthropic-adaptive' })
  assert.ok(calls[0]?.signal instanceof AbortSignal)
  assert.equal(calls[1]?.signal, calls[0]?.signal)
  assert.equal(calls[0]?.request.tools.some((tool) => tool.name === 'list_directory'), true)
  const anthropicFollowUp = calls[1]?.request.messages.slice(-2)
  assert.equal(anthropicFollowUp?.length, 2)
  assert.deepEqual(anthropicFollowUp?.[0], {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'private-anthropic-reasoning',
        signature: 'anthropic-thinking-signature'
      },
      {
        type: 'tool_use',
        id: 'toolu_list_workspace',
        name: 'list_directory',
        input: { relative_path: '.' }
      },
      {
        type: 'redacted_thinking',
        data: 'cmVkYWN0ZWQtdGhpbmtpbmc='
      },
      {
        type: 'tool_use',
        id: 'toolu_git_summary',
        name: 'git_summary',
        input: {}
      }
    ]
  })
  const anthropicToolResults = anthropicFollowUp?.[1]
  assert.ok(
    anthropicToolResults?.role === 'user' &&
    Array.isArray(anthropicToolResults.content)
  )
  assert.equal(anthropicToolResults.content.length, 2)
  assert.deepEqual(
    anthropicToolResults.content.map((part) => (
      'type' in part && part.type === 'tool_result'
        ? { type: part.type, tool_use_id: part.tool_use_id }
        : null
    )),
    [
      { type: 'tool_result', tool_use_id: 'toolu_list_workspace' },
      { type: 'tool_result', tool_use_id: 'toolu_git_summary' }
    ]
  )
  assert.match(JSON.stringify(anthropicToolResults.content), /README\.md/u)
  assert.match(JSON.stringify(anthropicToolResults.content), /src\/main\.ts/u)
  assert.equal(harness.tools.listCalls, 1)
  assert.equal(harness.tools.gitCalls, 1)
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'Native Anthropic Agent completed.\n'
  )
  assert.doesNotMatch(JSON.stringify(harness.events), /private-anthropic-reasoning|anthropic-thinking-signature|cmVkYWN0ZWQtdGhpbmtpbmc=/u)
  assert.doesNotMatch(JSON.stringify(harness.history.appended), /private-anthropic-reasoning|anthropic-thinking-signature|cmVkYWN0ZWQtdGhpbmtpbmc=/u)
})

test('Agent preserves Gemini thought signatures only in native tool history and returns named tool results', async () => {
  const thoughtSignature = Buffer.from('gemini-agent-thought-signature').toString('base64')
  const nativeToolCall = {
    id: 'gemini_call_list',
    type: 'function' as const,
    function: {
      name: 'list_directory',
      arguments: JSON.stringify({ relative_path: 'src' })
    },
    thoughtSignature
  }
  const calls: Array<{
    request: GeminiContentStreamWithToolsRequest
    signal: AbortSignal | undefined
  }> = []
  const gemini: AgentTurnServiceOptions['gemini'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push({ request: structuredClone(request), signal: options.signal })
      if (calls.length === 1) {
        return {
          responseId: 'gemini-tools',
          outputText: '',
          toolCalls: [nativeToolCall],
          hasToolCalls: true,
          assistantContent: [{
            type: 'thought' as const,
            text: 'private Gemini planning',
            thoughtSignature
          }, {
            type: 'function_call' as const,
            toolCall: nativeToolCall
          }]
        }
      }
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Native Gemini Agent completed.\n'
      })
      return {
        responseId: 'gemini-final',
        outputText: 'Native Gemini Agent completed.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const responses = new SequencedResponses([])
  const harness = createHarness(responses, { gemini })

  await harness.service.start(startInput({
    endpointType: 'gemini',
    endpointPath: '/v1beta/models/{model}:streamGenerateContent',
    approvalMode: 'auto',
    reasoning: 'high',
    reasoningProtocol: { type: 'gemini-level', includeThoughts: false }
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'native Gemini Agent completion'
  )

  assert.equal(responses.calls.length, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.request.endpointPath, '/v1beta/models/{model}:streamGenerateContent')
  assert.equal(calls[1]?.request.endpointPath, '/v1beta/models/{model}:streamGenerateContent')
  assert.equal(calls[0]?.request.reasoning, 'high')
  assert.deepEqual(calls[0]?.request.reasoningProtocol, {
    type: 'gemini-level',
    includeThoughts: false
  })
  assert.ok(calls[0]?.signal instanceof AbortSignal)
  assert.equal(calls[1]?.signal, calls[0]?.signal)
  const geminiFollowUp = calls[1]?.request.messages.slice(-2)
  assert.deepEqual(geminiFollowUp?.[0], {
    role: 'assistant',
    content: '',
    tool_calls: [nativeToolCall],
    assistantContent: [{
      type: 'thought',
      text: 'private Gemini planning',
      thoughtSignature
    }, {
      type: 'function_call',
      toolCall: nativeToolCall
    }]
  })
  assert.ok(geminiFollowUp?.[1]?.role === 'tool')
  assert.equal(geminiFollowUp[1].tool_call_id, 'gemini_call_list')
  assert.equal(geminiFollowUp[1].name, 'list_directory')
  assert.match(geminiFollowUp[1].content, /README\.md/u)
  assert.match(geminiFollowUp[1].content, /directory\tsrc/u)
  assert.equal(harness.tools.listCalls, 1)
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'Native Gemini Agent completed.\n'
  )
  assert.doesNotMatch(JSON.stringify(harness.history.appended), new RegExp(thoughtSignature))
})

test('Agent sends current attachments as untrusted multimodal input without persisting their bytes', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Attachment inspected safely.\n')
])
  const harness = createHarness(responses)
  const fileData = Buffer.from('safe attachment bytes').toString('base64')
  await harness.service.start(startInput({
    attachments: [{
      type: 'input_file',
      filename: 'attachment-1.txt',
      file_data: `data:text/plain;base64,${fileData}`
    }]
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent attachment completion'
  )

  const messages = requestItems(responses.calls[0]?.request)
  assert.ok(messages)
  const current = messages.at(-1)
  assert.ok(current && 'role' in current && current.role === 'user' && Array.isArray(current.content))
  assert.equal(current.content[1]?.type, 'input_file')
  assert.doesNotMatch(JSON.stringify(harness.history.appended), new RegExp(fileData))
})

test('Agent contextMessageLimit keeps the current prompt and attachments while excluding older encrypted history', async () => {
  const encryptedHistory = priorMessages(8)
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Limited Agent context handled.\n')
])
  const harness = createHarness(responses)
  harness.history.messages.push(...encryptedHistory)
  const fileData = Buffer.from('current Agent context attachment').toString('base64')

  await harness.service.start(startInput({
    prompt: 'current limited Agent prompt',
    contextMessageLimit: 6,
    attachments: [{
      type: 'input_file',
      filename: 'current-agent.txt',
      file_data: `data:text/plain;base64,${fileData}`
    }]
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'limited Agent context completion'
  )

  const conversationMessages = requestItems(responses.calls[0]?.request).filter(
    (message): message is Extract<typeof message, { role: 'user' | 'assistant' }> =>
      'role' in message && (message.role === 'user' || message.role === 'assistant')
  )
  assert.ok(conversationMessages)
  assert.equal(conversationMessages.length, 6)
  assert.deepEqual(
    conversationMessages.slice(0, -1),
    encryptedHistory.slice(-5).map((message) => ({ role: message.role, content: message.content }))
  )
  assert.deepEqual(conversationMessages.at(-1), {
    role: 'user',
    content: [
      { type: 'input_text', text: 'current limited Agent prompt' },
      {
        type: 'input_file',
        filename: 'current-agent.txt',
        file_data: `data:text/plain;base64,${fileData}`
      }
    ]
  })
  const serializedRequest = JSON.stringify(responses.calls[0]?.request)
  assert.doesNotMatch(serializedRequest, /encrypted history [123](?:\D|$)/u)
  assert.match(serializedRequest, /encrypted history 4/u)
  assert.deepEqual(harness.history.appended[0], {
    taskId: 'task:agent-test',
    role: 'user',
    content: 'current limited Agent prompt',
    status: 'complete'
  })
  assert.doesNotMatch(JSON.stringify(harness.history.appended), new RegExp(fileData))
})

test('full access sends the credential-redacted current prompt from memory while history keeps local paths redacted', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Full access prompt handled.\n')
])
  const harness = createHarness(responses)
  harness.history.persistContent = (content) => redactSensitiveContent(content)
  const targetPath = 'C:\\Users\\example\\Documents\\outside-workspace.txt'
  const prompt = `Target:\n${targetPath}\napi_key=${credentials.apiKey}`

  await harness.service.start(startInput({ prompt, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'full access current prompt completion'
  )

  const current = requestItems(responses.calls[0]?.request).at(-1)
  assert.ok(current && 'role' in current && current.role === 'user' && typeof current.content === 'string')
  assert.equal(current.content, `Target:\n${targetPath}\napi_key=<redacted>`)
  assert.equal(
    harness.history.messages.find((message) => message.role === 'user')?.content,
    'Target:\n<local-path>\napi_key=<redacted>'
  )
  assert.doesNotMatch(JSON.stringify(responses.calls[0]?.request), new RegExp(credentials.apiKey))
})

test('Agent without contextMessageLimit preserves the existing full-history request behavior', async () => {
  const encryptedHistory = priorMessages(8)
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Full Agent context handled.\n')
])
  const harness = createHarness(responses)
  harness.history.messages.push(...encryptedHistory)

  await harness.service.start(startInput({ prompt: 'current default Agent prompt' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'default Agent context completion'
  )

  const conversationMessages = requestItems(responses.calls[0]?.request).filter(
    (message) => 'role' in message && (message.role === 'user' || message.role === 'assistant')
  )
  assert.deepEqual(conversationMessages, [
    ...encryptedHistory.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: 'current default Agent prompt' }
  ])
})

test('Agent rejects invalid contextMessageLimit bounds and non-integers before preflight work', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)

  for (const contextMessageLimit of [1, 25, 6.5]) {
    await assert.rejects(
      harness.service.start(startInput({ contextMessageLimit })),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
  }

  assert.deepEqual(harness.history.appended, [])
  assert.equal(harness.history.loadCalls, 0)
  assert.equal(responses.calls.length, 0)
  assert.equal(harness.scheduler.pending.length, 0)
})

test('Agent rejects malformed or reordered endpoint candidates before preflight work', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)
  const invalidCandidates: unknown[] = [
    [],
    [{ endpointType: 'openai' }],
    [
      { endpointType: 'openai-response' },
      { endpointType: 'openai-response' }
    ],
    [{ endpointType: 'openai-response', unexpected: true }]
  ]

  for (const endpointCandidates of invalidCandidates) {
    await assert.rejects(
      harness.service.start(startInput({
        endpointCandidates: endpointCandidates as AgentTurnStartInput['endpointCandidates']
      })),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
  }

  assert.deepEqual(harness.history.appended, [])
  assert.equal(harness.history.loadCalls, 0)
  assert.equal(responses.calls.length, 0)
  assert.equal(harness.scheduler.pending.length, 0)
})

test('Agent rejects unsupported hosted capabilities and Lite hosted tools before preflight work', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)
  const capabilities = startInput().modelCapabilities
  const invalidInputs: AgentTurnStartInput[] = [
    startInput({
      webSearch: true,
      modelCapabilities: { ...capabilities, webSearch: false }
    }),
    startInput({
      imageGeneration: true,
      modelCapabilities: { ...capabilities, imageGeneration: false }
    }),
    startInput({ wireMode: 'lite', webSearch: true }),
    startInput({ wireMode: 'lite', imageGeneration: true })
  ]

  for (const input of invalidInputs) {
    await assert.rejects(
      harness.service.start(input),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
  }

  assert.equal(harness.history.loadCalls, 0)
  assert.equal(responses.calls.length, 0)
  assert.equal(harness.scheduler.pending.length, 0)
})

test('Agent image-only completion publishes an opaque token without entering tool approval or history bytes', async () => {
  const dataUrl = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_agent_image',
      outputText: '',
      toolCalls: [],
      generatedImages: [{ mimeType: 'image/png', dataUrl }]
    })
  ])
  const issued: unknown[] = []
  const harness = createHarness(responses, {
    imageResults: {
      issueMany(images, ownerWebContentsId) {
        issued.push({ images, ownerWebContentsId })
        return [{
          imageToken: `img_${'a'.repeat(43)}`,
          mimeType: 'image/png',
          byteLength: 8
        }]
      }
    }
  })
  await harness.service.start(startInput({ imageGeneration: true }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent image completion'
  )

  assert.equal(issued.length, 1)
  assert.equal(harness.events.some((event) => event.type === 'image-result'), true)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.match(harness.history.appended.at(-1)?.content ?? '', /图片已生成/)
  assert.doesNotMatch(JSON.stringify(harness.history.appended), /data:image|iVBOR/)
})

test('Agent rejects a tool result without a verified continuation before local dispatch', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_unverified_tool_result',
      outputText: '',
      toolCalls: [{
        callId: 'call_unverified_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' }
      }]
    })
  ], false)
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'unverified continuation rejection'
  )

  assert.equal(harness.tools.readCalls, 0)
  assert.equal(harness.approvals.authorizeRequests.length, 0)
  assert.equal(responses.calls.length, 1)
})

test('credential-bearing writes are denied before approval and never reach the workspace', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_credential_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_write_credential',
        name: 'write_file',
        arguments: {
          relative_path: 'src/secret.ts',
          content: `export const apiKey = "${credentials.apiKey}";`
        }
      }]
    }),
    async (options) => await finalResult(options, 'The local credential policy blocked the write.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'credential write denial'
  )

  assert.equal(harness.tools.writeCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  const toolOutput = requestItems(responses.calls[1]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(toolOutput && 'output' in toolOutput)
  assert.match(toolOutput.output, /credential policy denied/i)
  assert.doesNotMatch(JSON.stringify(harness.events), new RegExp(credentials.apiKey))
})

test('plan mode rejects every write tool before approval or workspace dispatch for all approval modes', async () => {
  const denial = 'Plan mode blocks file writes and command execution. No local operation was performed.'
  for (const approvalMode of ['request', 'auto', 'full'] as const) {
    for (const toolName of ['write_file', 'replace_in_file', 'delete_path'] as const) {
      const toolArguments = toolName === 'write_file'
        ? {
            relative_path: `src/plan-${approvalMode}.ts`,
            content: 'export const planned = true\n'
          }
        : toolName === 'replace_in_file'
          ? {
              relative_path: 'src/main.ts',
              old_text: 'export const safe = true;',
              new_text: 'export const safe = false;',
              expected_revision: 'a'.repeat(64)
            }
          : {
              path: `src/plan-${approvalMode}.tmp`,
              recursive: false
            }
      const responses = new SequencedResponses([
        async () => ({
          responseId: `response_plan_${approvalMode}_${toolName}`,
          outputText: '',
          toolCalls: [{
            callId: `call_plan_${approvalMode}_${toolName}`,
            name: toolName,
            arguments: toolArguments
          }]
        }),
        async (options) => await finalResult(options, 'The plan remains read-only.\n')
])
      const harness = createHarness(responses)

      await harness.service.start(startInput({ approvalMode, planMode: true }))
      harness.scheduler.runAll()
      await waitFor(
        () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
        `${approvalMode} plan-mode ${toolName} denial`
      )

      assert.equal(harness.tools.writeCalls, 0, `${approvalMode} ${toolName} write dispatch`)
      assert.equal(harness.tools.replaceCalls, 0, `${approvalMode} ${toolName} replacement dispatch`)
      assert.equal(harness.tools.deleteCalls, 0, `${approvalMode} ${toolName} delete dispatch`)
      assert.equal(
        harness.events.some((event) => event.type === 'approval-request'),
        false,
        `${approvalMode} ${toolName} approval`
      )
      const toolOutput = requestItems(responses.calls[1]?.request).find(
        (item) => 'type' in item && item.type === 'function_call_output'
      )
      assert.ok(toolOutput && 'output' in toolOutput, `${approvalMode} ${toolName} result`)
      assert.equal(toolOutput.output, denial, `${approvalMode} ${toolName} fixed denial`)
    }
  }
})

test('plan mode still routes read_file through request approval and dispatches it after consent', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'The planned read completed.\n')
])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ planMode: true, approvalMode: 'request' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'plan-mode read approval request'
  )

  assert.equal(harness.tools.readCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'low')
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'plan-mode approved read completion'
  )
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(responses.calls.length, 2)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /function_call_output/)
})

test('non-boolean planMode fails validation before the model is called', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)

  await assert.rejects(
    harness.service.start(startInput({ planMode: 'true' as unknown as boolean })),
    (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
  )
  assert.equal(responses.calls.length, 0)
})

test('Agent rejects a task bound to another workspace before persisting or sampling', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)

  await assert.rejects(
    harness.service.start(startInput({
      workspaceProjectId: `project:workspace:${'q'.repeat(43)}`
    })),
    (error: unknown) => error instanceof AgentTurnError && error.code === 'workspace_mismatch'
  )
  assert.equal(harness.history.loadCalls, 1)
  assert.equal(harness.history.appended.length, 0)
  assert.equal(responses.calls.length, 0)
})

test('review mode advertises only bounded review tools and disables remote and delegated features', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_review_tools',
      outputText: '',
      toolCalls: [{ callId: 'call_review_tools', name: 'git_diff', arguments: {} }]
    })
  ])
  const harness = createHarness(responses)

  const started = await harness.service.start(startInput({
    reviewMode: true,
    webSearch: true,
    imageGeneration: true,
    subagentsEnabled: true,
    approvalMode: 'request'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'review-mode capability advertisement'
  )

  const request = responses.calls[0]?.request
  assert.ok(request)
  assert.deepEqual(
    request.tools?.map((tool) => tool.name).sort(),
    ['git_diff', 'git_summary', 'glob', 'list_directory', 'read_file', 'search_files']
  )
  assert.equal(request.webSearch, false)
  assert.notEqual(request.imageGeneration, true)
  assert.match(request.instructions ?? '', /Code review mode is active/u)
  assert.equal(requestItems(request).some((item) => 'role' in item && item.role === 'developer'), false)
  assert.equal(responses.calls.length, 1)
  assert.equal(harness.approvals.authorizeRequests.length, 1)
  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'review-mode advertisement cancellation'
  )
})

test('review mode cannot complete before an approved Git diff is loaded', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Unsupported review conclusion.\n')
])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ reviewMode: true }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'review mode missing diff failure'
  )
  assert.equal(harness.events.some(
    (event) => event.type === 'turn-status' && event.status === 'completed'
  ), false)
  assert.equal(harness.tools.gitDiffCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'assistant-delta'), false)
  assert.deepEqual(
    harness.history.appended.map((message) => [message.role, message.content]),
    [['user', 'Inspect src/main.ts and summarize it.']]
  )
})

test('review mode excludes prior task history from the model context', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_review_isolated_context',
      outputText: '',
      toolCalls: [{ callId: 'call_review_isolated_context', name: 'git_diff', arguments: {} }]
    })
  ])
  const harness = createHarness(responses)
  harness.history.messages.push(...priorMessages(2))
  harness.history.messages[0]!.content = 'old-workspace-private-context'

  const started = await harness.service.start(startInput({
    reviewMode: true,
    prompt: '/review inspect only the current authorized workspace'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'isolated review context'
  )

  const firstRequest = JSON.stringify(requestItems(responses.calls[0]?.request))
  assert.match(firstRequest, /inspect only the current authorized workspace/u)
  assert.doesNotMatch(firstRequest, /old-workspace-private-context|encrypted history/u)
  assert.equal(harness.service.cancel(started.turnId), true)
})

test('review discards model text emitted before Git diff approval and activation', async () => {
  const forged = 'Forged finding emitted before any diff was loaded.\n'
  const verified = 'Verified finding based on the approved bounded diff.\n'
  const responses = new SequencedResponses([
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: forged })
      return {
        responseId: 'response_review_preface',
        outputText: forged,
        toolCalls: [{ callId: 'call_review_preface', name: 'git_diff', arguments: {} }]
      }
    },
    async (options) => await finalResult(options, verified)
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ reviewMode: true }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'review diff activation approval'
  )
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'review diff activation completion'
  )

  const rendererText = harness.events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta')
    .map((event) => event.text)
    .join('')
  assert.equal(rendererText, verified)
  assert.doesNotMatch(rendererText, /Forged finding/u)
  assert.doesNotMatch(JSON.stringify(requestItems(responses.calls[1]?.request)), /Forged finding/u)
  assert.equal(harness.history.appended.at(-1)?.role, 'assistant')
  assert.equal(harness.history.appended.at(-1)?.content, verified)
})

test('review git_diff follows auto and full approval modes without downgrading full', async () => {
  for (const approvalMode of ['auto', 'full'] as const) {
    const callId = `call_review_diff_${approvalMode}`
    const responses = new SequencedResponses([
      async () => ({
        responseId: `response_review_diff_${approvalMode}`,
        outputText: '',
        toolCalls: [{ callId, name: 'git_diff', arguments: {} }]
      }),
      async (options) => await finalResult(options, 'The bounded diff was reviewed.\n')
])
    const harness = createHarness(responses)

    await harness.service.start(startInput({ reviewMode: true, approvalMode }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'approval-request') ||
        harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} review diff authorization`
    )

    const approvalEvents = harness.events.filter(
      (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
        event.type === 'approval-request'
    )
    assert.equal(approvalEvents.length, 0, `${approvalMode} review diff should auto-approve medium-risk execute in auto mode`)
    assert.equal(harness.approvals.authorizeRequests.length, 1)
    const exactRequest = harness.approvals.authorizeRequests[0]
    assert.ok(exactRequest)
    assert.equal(exactRequest.callId, callId)
    assert.equal(exactRequest.workspaceToken, workspaceToken)
    assert.equal(exactRequest.operation, 'execute')
    assert.equal(exactRequest.toolName, 'git_diff')
    assert.deepEqual(exactRequest.arguments, {})
    assert.equal(exactRequest.risk, 'medium')
    assert.equal(exactRequest.mode, approvalMode)
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} review diff completion`
    )

    assert.equal(
      harness.events.filter((event) => event.type === 'approval-request').length,
      0
    )
    assert.equal(harness.tools.gitDiffCalls, 1)
    assert.deepEqual(harness.tools.gitDiffInputs, [{ workspaceToken, ownerWebContentsId: 7 }])
    assert.ok(harness.tools.gitDiffSignal instanceof AbortSignal)
    assert.equal(harness.tools.listCalls, 0)
    assert.equal(harness.tools.searchCalls, 0)
    assert.equal(harness.tools.readCalls, 0)
    assert.equal(harness.tools.gitCalls, 0)
    assert.equal(harness.tools.writeCalls, 0)
    assert.equal(harness.tools.replaceCalls, 0)
    const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
    assert.match(followUp, /begin untrusted redacted git patch/u)
    assert.match(followUp, /src\/main\.ts/u)
  }
})

test('review mode rejects a forged write before approval and local dispatch', async () => {
  const denial = 'Code review mode blocks file writes, commands, and delegation. No local operation was performed.'
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_review_forged_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_review_forged_write',
        name: 'write_file',
        arguments: {
          relative_path: 'src/review-bypass.ts',
          content: 'export const bypassed = true\n'
        }
      }]
    }),
    async (options) => await finalResult(options, 'The review remained read-only.\n')
])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ reviewMode: true, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'review forged-write rejection'
  )

  assert.equal(harness.approvals.authorizeRequests.length, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assertNoWorkspaceDispatch(harness.tools)
  const toolOutput = requestItems(responses.calls[1]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(toolOutput && 'output' in toolOutput)
  assert.equal(toolOutput.output, denial)
})

test('review mode conflicts and non-boolean values fail closed before history or model access', async () => {
  for (const overrides of [
    { reviewMode: true, planMode: true },
    {
      reviewMode: true,
      attachments: [{
        type: 'input_file' as const,
        filename: 'review-attachment.txt',
        file_data: 'data:text/plain;base64,YQ=='
      }]
    },
    { reviewMode: 'true' as unknown as boolean }
  ]) {
    const responses = new SequencedResponses([])
    const harness = createHarness(responses)
    await assert.rejects(
      harness.service.start(startInput(overrides)),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
    assert.equal(harness.history.loadCalls, 0)
    assert.equal(responses.calls.length, 0)
    assert.equal(harness.approvals.authorizeRequests.length, 0)
    assertNoWorkspaceDispatch(harness.tools)
  }
})

function toolResult(): ResponsesStreamResult {
  return {
    responseId: 'response_tool',
    outputText: '',
    toolCalls: [{
      callId: 'call_read_1',
      name: 'read_file',
      arguments: { relative_path: 'src/main.ts' }
    }]
  }
}

function commandToolResult(
  argumentsValue: ResponsesJsonObject = {
    relative_path: '.',
    argv: ['node', '--version']
  }
): ResponsesStreamResult {
  return {
    responseId: 'response_command_tool',
    outputText: '',
    toolCalls: [{
      callId: 'call_command_1',
      name: 'run_command',
      arguments: argumentsValue
    }]
  }
}

async function finalResult(options: ResponsesStreamOptions, text: string): Promise<ResponsesStreamResult> {
  await options.onEvent?.({ type: 'response.output_text.delta', delta: text })
  return { responseId: 'response_final', outputText: text, toolCalls: [] }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function assertNoWorkspaceDispatch(tools: FakeWorkspaceTools): void {
  assert.equal(tools.listCalls, 0)
  assert.equal(tools.searchCalls, 0)
  assert.equal(tools.readCalls, 0)
  assert.equal(tools.gitCalls, 0)
  assert.equal(tools.gitDiffCalls, 0)
  assert.equal(tools.writeCalls, 0)
  assert.equal(tools.replaceCalls, 0)
  assert.equal(tools.commandCalls, 0)
}

test('full access continues a long useful workspace tool run without repeated approval or a vague hard stop', async () => {
  const usefulToolRounds = 20
  const responses = new SequencedResponses([
    ...Array.from({ length: usefulToolRounds }, (_, index) => async () => ({
      responseId: `response_long_full_${index + 1}`,
      outputText: '',
      toolCalls: [{
        callId: `call_long_full_${index + 1}`,
        name: 'read_file',
        // Distinct paths: a useful long run inspects different files; identical
        // repeats with identical results are the doom-loop guard's territory.
        arguments: { relative_path: `src/module-${index + 1}.ts` },
      }],
    })),
    async (options) => await finalResult(options, 'The long workspace inspection completed.\n'),
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) =>
      event.type === 'turn-status' && ['completed', 'failed'].includes(event.status)),
    'long full-access tool run terminal state',
  )

  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.equal(harness.approvals.authorizeRequests.length, usefulToolRounds)
  assert.equal(harness.tools.readCalls, usefulToolRounds)
  assert.equal(responses.calls.length, usefulToolRounds + 1)
  assert.doesNotMatch(
    JSON.stringify({ events: harness.events, messages: harness.history.appended }),
    /工具循环达到安全上限|已停止本轮/u,
  )
})

test('identical repeated tool calls are skipped and a persistent loop ends as a resumable handoff', async () => {
  const responses = new SequencedResponses([
    ...Array.from({ length: 6 }, (_, index) => async () => ({
      responseId: `response_repeat_${index + 1}`,
      outputText: '',
      toolCalls: [{
        callId: `call_repeat_${index + 1}`,
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' },
      }],
    })),
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) =>
      event.type === 'turn-status' && ['completed', 'failed'].includes(event.status)),
    'repeated tool call terminal state',
  )

  // Three identical executions are allowed; later repeats never reach the tools.
  assert.equal(harness.tools.readCalls, 3)
  assert.equal(responses.calls.length, 6)
  const terminal = harness.events.find((event) =>
    event.type === 'turn-status' && ['completed', 'failed'].includes(event.status))
  assert.equal(terminal?.type === 'turn-status' && terminal.status, 'completed')
  assert.match(
    JSON.stringify(harness.history.appended),
    /反复提出完全相同/u,
  )
})

test('ask_user pauses the turn on a question and feeds the selected option back to the model', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_ask_user',
      outputText: '',
      toolCalls: [{
        callId: 'call_ask_user',
        name: 'ask_user',
        arguments: { question: '该迁移哪个配置文件？', options: ['config.json', 'settings.yaml'] },
      }],
    }),
    async (options) => await finalResult(options, 'Migrating config.json as selected.\n'),
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'ask_user question event',
  )
  const question = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> => event.type === 'approval-request'
  )!
  assert.ok(question.question)
  assert.deepEqual(question.question.options, ['config.json', 'settings.yaml'])
  assert.equal(harness.approvals.resolve(question.approvalId, 'option:0'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'ask_user turn completion',
  )
  assert.match(JSON.stringify(responses.calls[1]?.request), /The user selected option 1: config\.json/u)

  // Malformed questions come back as a fixed tool failure without any event.
  const malformed = new SequencedResponses([
    async () => ({
      responseId: 'response_ask_user_invalid',
      outputText: '',
      toolCalls: [{
        callId: 'call_ask_user_invalid',
        name: 'ask_user',
        arguments: { question: '只有一个选项', options: ['solo'] },
      }],
    }),
    async (options) => await finalResult(options, 'Continuing without a question.\n'),
  ])
  const invalidHarness = createHarness(malformed)
  await invalidHarness.service.start(startInput({ approvalMode: 'full' }))
  invalidHarness.scheduler.runAll()
  await waitFor(
    () => invalidHarness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'invalid ask_user completion',
  )
  assert.equal(invalidHarness.events.some((event) => event.type === 'approval-request'), false)
  assert.match(JSON.stringify(malformed.calls[1]?.request), /tool_failed: ask_user requires/u)
})

test('the first write-class tool of a turn checkpoints once and tolerates checkpoint failure', async () => {
  const checkpointCalls: Array<{ taskId: string; writesAtCall: number }> = []
  let harness!: ReturnType<typeof createHarness>
  harness = createHarness(new SequencedResponses([
    async () => ({
      responseId: 'response_checkpoint_read',
      outputText: '',
      toolCalls: [{
        callId: 'call_checkpoint_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' },
      }],
    }),
    async () => ({
      responseId: 'response_checkpoint_write_1',
      outputText: '',
      toolCalls: [{
        callId: 'call_checkpoint_write_1',
        name: 'write_file',
        arguments: { relative_path: 'src/one.ts', content: 'export const one = 1\n' },
      }],
    }),
    async () => ({
      responseId: 'response_checkpoint_write_2',
      outputText: '',
      toolCalls: [{
        callId: 'call_checkpoint_write_2',
        name: 'write_file',
        arguments: { relative_path: 'src/two.ts', content: 'export const two = 2\n' },
      }],
    }),
    async (options) => await finalResult(options, 'Both files were written.\n'),
  ]), {
    checkpoints: {
      createTurnCheckpoint: async (taskId) => {
        checkpointCalls.push({ taskId, writesAtCall: harness.tools.writeCalls })
        return null
      },
    },
  })

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'checkpointed write turn completion',
  )

  // Exactly one checkpoint, taken before the first write executed.
  assert.equal(checkpointCalls.length, 1)
  assert.equal(checkpointCalls[0]!.writesAtCall, 0)
  assert.equal(harness.tools.writeCalls, 2)

  // A failing checkpoint must never block the write it precedes.
  const failing = createHarness(new SequencedResponses([
    async () => ({
      responseId: 'response_checkpoint_fail_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_checkpoint_fail_write',
        name: 'write_file',
        arguments: { relative_path: 'src/still-written.ts', content: 'still here\n' },
      }],
    }),
    async (options) => await finalResult(options, 'The write survived a checkpoint failure.\n'),
  ]), {
    checkpoints: {
      createTurnCheckpoint: async () => {
        throw new Error('checkpoint storage unavailable')
      },
    },
  })
  await failing.service.start(startInput({ approvalMode: 'full' }))
  failing.scheduler.runAll()
  await waitFor(
    () => failing.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'checkpoint-failure write turn completion',
  )
  assert.equal(failing.tools.writeCalls, 1)
})

test('full access dispatches absolute reads, writes, cwd, and argv with system scope', async () => {
  const outsideDirectory = 'C:\\Users\\example\\outside'
  const outsideReadPath = `${outsideDirectory}\\source.ts`
  const outsideWritePath = `${outsideDirectory}\\generated.ts`
  const outsideScriptPath = `${outsideDirectory}\\inspect.mjs`
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_full_read',
      outputText: '',
      toolCalls: [{
        callId: 'call_full_read',
        name: 'read_file',
        arguments: { relative_path: outsideReadPath },
      }],
    }),
    async () => ({
      responseId: 'response_full_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_full_write',
        name: 'write_file',
        arguments: { relative_path: outsideWritePath, content: 'export const generated = true\n' },
      }],
    }),
    async () => commandToolResult({
      relative_path: outsideDirectory,
      argv: ['C:\\Program Files\\nodejs\\node.exe', outsideScriptPath]
    }),
    async (options) => await finalResult(options, 'The mixed workspace task completed.\n'),
  ])
  const harness = createHarness(responses)
  harness.tools.commandStdout = `${outsideScriptPath}\napi_key=system-tool-secret\n`

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'mixed full-access completion',
  )

  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(harness.tools.writeCalls, 1)
  assert.equal(harness.tools.commandCalls, 1)
  assert.equal(harness.approvals.authorizeRequests.length, 3)
  assert.equal(harness.approvals.authorizeRequests.every((request) => request.mode === 'full'), true)
  assert.match(responses.calls[0]?.request.instructions ?? '', /System Full Access/u)
  assert.match(responses.calls[0]?.request.instructions ?? '', /absolute local paths/u)
  assert.doesNotMatch(responses.calls[0]?.request.instructions ?? '', /Only use workspace-relative paths/u)
  assert.deepEqual(harness.tools.accessScopeCalls, [
    { toolName: 'read_file', accessScope: 'system' },
    { toolName: 'write_file', accessScope: 'system' },
    { toolName: 'run_command', accessScope: 'system' }
  ])
  assert.deepEqual(harness.tools.commandInputs, [{
    workspaceToken,
    relativePath: outsideDirectory,
    argv: ['C:\\Program Files\\nodejs\\node.exe', outsideScriptPath]
  }])
  const commandOutput = requestItems(responses.calls[3]?.request).find(
    (item) => 'type' in item &&
      item.type === 'function_call_output' &&
      item.call_id === 'call_command_1'
  )
  assert.ok(commandOutput && 'output' in commandOutput)
  assert.match(commandOutput.output, /C:\\Users\\example\\outside\\inspect\.mjs/u)
  assert.match(commandOutput.output, /api_key=<redacted>/u)
  assert.doesNotMatch(commandOutput.output, /system-tool-secret|<local-path>/u)
})

test('full access deletes an external history directory without approval or protected-path refusal', async () => {
  const historyDirectory = 'C:\\Users\\example\\.provider-history\\task-123'
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_full_delete_history',
      outputText: '',
      toolCalls: [{
        callId: 'call_full_delete_history',
        name: 'delete_path',
        arguments: { path: historyDirectory, recursive: true },
      }],
    }),
    async (options) => await finalResult(options, 'The requested history directory was deleted.\n'),
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({
    approvalMode: 'full',
    prompt: `Delete the history directory at ${historyDirectory}.`,
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'full-access history deletion completion',
  )

  assert.equal(responses.calls[0]?.request.tools?.some((tool) => tool.name === 'delete_path'), true)
  assert.match(responses.calls[0]?.request.instructions ?? '', /delete files and directories/u)
  assert.match(responses.calls[0]?.request.instructions ?? '', /must not claim.*protected/u)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.equal(harness.approvals.authorizeRequests.length, 1)
  assert.equal(harness.approvals.authorizeRequests[0]?.mode, 'full')
  assert.equal(harness.tools.deleteCalls, 1)
  assert.deepEqual(harness.tools.deleteInputs, [{
    workspaceToken,
    relativePath: historyDirectory,
    recursive: true,
  }])
  assert.deepEqual(harness.tools.accessScopeCalls, [
    { toolName: 'delete_path', accessScope: 'system' },
  ])
  assert.doesNotMatch(
    JSON.stringify({ events: harness.events, messages: harness.history.appended }),
    /protected_path|outside the current workspace|工作区隔离|受保护文件/iu,
  )
})

test('an explicit execution budget completes with a resumable handoff and never replays side effects', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_budget_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_budget_write',
        name: 'write_file',
        arguments: { relative_path: 'src/budget.ts', content: 'export const budget = true\n' },
      }],
    }),
    async () => commandToolResult(),
  ])
  const harness = createHarness(responses, {
    executionBudget: { maxModelRounds: 2, maxToolCalls: 4 },
  })

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) =>
      event.type === 'turn-status' && event.status === 'completed' && event.continuation === 'agent-execution'),
    'explicit execution-budget handoff',
  )

  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.equal(harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'), false)
  assert.equal(responses.calls.length, 2)
  assert.equal(harness.tools.writeCalls, 1)
  assert.equal(harness.tools.commandCalls, 1)
  assert.match(harness.history.appended.at(-1)?.content ?? '', /已完成 2 次工具操作和 2 个模型步骤/u)
  assert.match(harness.history.appended.at(-1)?.content ?? '', /不会自动重放/u)
})

test('a tool-call budget does not partially dispatch or replay an oversized side-effect batch', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_budget_batch',
      outputText: '',
      toolCalls: [
        {
          callId: 'call_budget_batch_write',
          name: 'write_file',
          arguments: { relative_path: 'src/not-written.ts', content: 'not written\n' },
        },
        {
          callId: 'call_budget_batch_command',
          name: 'run_command',
          arguments: { relative_path: '.', argv: ['node', '--version'] },
        },
      ],
    }),
  ])
  const harness = createHarness(responses, { executionBudget: { maxToolCalls: 1 } })

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) =>
      event.type === 'turn-status' && event.status === 'completed' && event.continuation === 'agent-execution'),
    'oversized tool batch handoff',
  )

  assert.equal(responses.calls.length, 1)
  assert.equal(harness.approvals.authorizeRequests.length, 0)
  assert.equal(harness.tools.writeCalls, 0)
  assert.equal(harness.tools.commandCalls, 0)
  assert.match(harness.history.appended.at(-1)?.content ?? '', /2 次后续工具操作尚未执行/u)
})

test('Agent advertises bounded search, command, and replacement tools to Responses', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Ready for a workspace task.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'tool schema completion'
  )

  const advertised = responses.calls[0]?.request.tools
  assert.ok(advertised)
  assert.equal(advertised.every((tool) => tool.strict === false), true)
  const byName = new Map(advertised.map((tool) => [tool.name, tool]))
  assert.ok(byName.has('search_files'))
  assert.ok(byName.has('run_command'))
  assert.ok(byName.has('replace_in_file'))

  const search = byName.get('search_files')
  assert.ok(search)
  assert.equal(search.type, 'function')
  assert.equal(search.strict, false)
  const searchParameters = search.parameters as Record<string, unknown>
  assert.deepEqual(
    Object.keys(searchParameters.properties as Record<string, unknown>).sort(),
    ['case_sensitive', 'query', 'regex', 'relative_path']
  )
  assert.deepEqual(searchParameters.required, ['relative_path', 'query', 'case_sensitive'])
  assert.equal(searchParameters.additionalProperties, false)

  const command = byName.get('run_command')
  assert.ok(command)
  assert.equal(command.type, 'function')
  assert.equal(command.strict, false)
  const commandParameters = command.parameters as Record<string, unknown>
  assert.deepEqual(
    Object.keys(commandParameters.properties as Record<string, unknown>).sort(),
    ['argv', 'relative_path']
  )
  assert.deepEqual(commandParameters.required, ['relative_path', 'argv'])
  assert.equal(commandParameters.additionalProperties, false)
  const commandProperties = commandParameters.properties as Record<string, Record<string, unknown>>
  assert.equal(commandProperties.argv?.minItems, 1)
  assert.equal(commandProperties.argv?.maxItems, 64)

  const replace = byName.get('replace_in_file')
  assert.ok(replace)
  assert.equal(replace.type, 'function')
  assert.equal(replace.strict, false)
  const replaceParameters = replace.parameters as Record<string, unknown>
  assert.deepEqual(
    Object.keys(replaceParameters.properties as Record<string, unknown>).sort(),
    ['expected_revision', 'new_text', 'old_text', 'relative_path']
  )
  assert.deepEqual(
    replaceParameters.required,
    ['relative_path', 'old_text', 'new_text', 'expected_revision']
  )
  assert.equal(replaceParameters.additionalProperties, false)
})

test('request mode approves one exact run_command argv snapshot before dispatch', async () => {
  const responses = new SequencedResponses([
    async () => commandToolResult(),
    async (options) => await finalResult(options, 'The command completed successfully.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'request' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'run_command approval request'
  )
  assert.equal(harness.tools.commandCalls, 0)
  assert.equal(harness.approvals.authorizeRequests.length, 1)
  const exactRequest = harness.approvals.authorizeRequests[0]
  assert.equal(exactRequest?.operation, 'execute')
  assert.equal(exactRequest?.toolName, 'run_command')
  assert.equal(exactRequest?.risk, 'high')
  assert.equal(exactRequest?.mode, 'request')
  assert.deepEqual(exactRequest?.arguments, {
    relative_path: '.',
    argv: ['node', '--version']
  })

  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.match(approval.label, /node --version/u)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'approved run_command completion'
  )
  assert.equal(harness.tools.commandCalls, 1)
  assert.deepEqual(harness.tools.commandInputs, [{
    workspaceToken,
    relativePath: '.',
    argv: ['node', '--version']
  }])
  assert.deepEqual(harness.tools.accessScopeCalls, [
    { toolName: 'run_command', accessScope: 'workspace' }
  ])
  assert.ok(harness.tools.commandSignal)
  const output = JSON.stringify(requestItems(responses.calls[1]?.request))
  assert.match(output, /Exit code: 0/u)
  assert.match(output, /v24\.0\.0/u)
})

test('auto mode asks once for run_command while full mode keeps the exact prompt-free broker grant', async () => {
  for (const approvalMode of ['auto', 'full'] as const) {
    const responses = new SequencedResponses([
      async () => commandToolResult(),
      async (options) => await finalResult(options, 'Command policy handled the request.\n')
])
    const harness = createHarness(responses)
    await harness.service.start(startInput({ approvalMode }))
    harness.scheduler.runAll()
    if (approvalMode === 'auto') {
      await waitFor(
        () => harness.events.some((event) => event.type === 'approval-request'),
        'auto run_command approval request'
      )
      const approval = harness.events.find(
        (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
          event.type === 'approval-request'
      )
      assert.ok(approval)
      assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)
    }
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      approvalMode + ' run_command completion'
    )

    assert.equal(harness.approvals.authorizeRequests.length, 1)
    assert.equal(harness.approvals.authorizeRequests[0]?.operation, 'execute')
    assert.equal(harness.approvals.authorizeRequests[0]?.risk, 'high')
    assert.equal(
      harness.events.filter((event) => event.type === 'approval-request').length,
      approvalMode === 'auto' ? 1 : 0
    )
    assert.equal(harness.tools.commandCalls, 1)
    assert.deepEqual(harness.tools.accessScopeCalls, [{
      toolName: 'run_command',
      accessScope: approvalMode === 'full' ? 'system' : 'workspace'
    }])
    const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
    assert.match(followUp, /Exit code: 0/u)
  }
})

test('plan and review modes reject forged run_command calls before approval or dispatch', async () => {
  for (const mode of ['plan', 'review'] as const) {
    const responses = new SequencedResponses([
      async () => commandToolResult(),
      async (options) => await finalResult(options, 'The command remained blocked.\n')
])
    const harness = createHarness(responses)
    await harness.service.start(startInput({
      planMode: mode === 'plan',
      reviewMode: mode === 'review',
      approvalMode: 'full'
    }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) =>
        event.type === 'turn-status' &&
        (event.status === 'completed' || event.status === 'failed')
      ),
      mode + ' run_command rejection'
    )

    assert.equal(responses.calls[0]?.request.tools?.some((tool) => tool.name === 'run_command'), false)
    assert.equal(harness.approvals.authorizeRequests.length, 0)
    assert.equal(harness.tools.commandCalls, 0)
  }
})

test('request and auto run_command reject shell and escaping argv before approval or workspace dispatch', async () => {
  const cases: readonly ResponsesJsonObject[] = [
    { relative_path: '.', argv: ['cmd.exe', '/c', 'whoami'] },
    { relative_path: '.', argv: ['node', '../outside.mjs'] },
    { relative_path: '.', argv: ['node', 'C:\\outside\\script.mjs'] },
    { relative_path: '.', argv: ['node', 'sk-command-secret-12345678'] }
  ]
  for (const approvalMode of ['request', 'auto'] as const) {
    for (const argumentsValue of cases) {
      const responses = new SequencedResponses([
        async () => commandToolResult(argumentsValue),
        async (options) => await finalResult(options, 'The invalid command was rejected safely.\n')
])
      const harness = createHarness(responses)
      await harness.service.start(startInput({ approvalMode }))
      harness.scheduler.runAll()
      await waitFor(
        () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
        `${approvalMode} invalid run_command recovery`
      )
      assert.equal(harness.approvals.authorizeRequests.length, 0)
      assert.equal(harness.tools.commandCalls, 0)
      assert.deepEqual(harness.tools.accessScopeCalls, [])
      const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
      assert.match(followUp, /tool_failed/u)
      assert.doesNotMatch(JSON.stringify(harness.events), /outside|sk-command-secret/u)
    }
  }
})

test('Agent uses top-level instructions and an opaque continuation capsule across tool rounds', async () => {
  const encryptedContent = 'opaque_agent_reasoning_state_0123456789'
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_reasoning_tool',
      outputText: '',
      toolCalls: [{
        callId: 'call_reasoning_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' }
      }]
    }),
    async (options) => await finalResult(options, 'The reasoning continuation completed.\n')
])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'auto', reasoning: 'high' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'reasoning continuation completion'
  )

  assert.equal(responses.calls.length, 2)
  assert.match(responses.calls[0]?.request.instructions ?? '', /workspace-relative paths/u)
  assert.equal(
    requestItems(responses.calls[0]?.request).some((item) => 'role' in item && item.role === 'developer'),
    false
  )
  const firstRequest = responses.calls[0]?.request
  const continuationRequest = responses.calls[1]?.request
  assert.ok(continuationRequest?.continuation)
  assert.equal(continuationRequest.messages, undefined)
  assert.match(firstRequest?.promptCacheKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(continuationRequest.promptCacheKey, firstRequest?.promptCacheKey)
  assert.deepEqual(continuationRequest.continuation.outputs.map((item) => item.type), [
    'function_call_output'
  ])
  assert.equal(continuationRequest.continuation.outputs[0]?.call_id, 'call_reasoning_read')
  assert.doesNotMatch(JSON.stringify(continuationRequest), new RegExp(encryptedContent))
  assert.doesNotMatch(
    JSON.stringify({ events: harness.events, history: harness.history.appended }),
    new RegExp(encryptedContent)
  )
})

test('Lite Agent keeps wire mode and one cache key across its opaque tool continuation', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_lite_tool',
      outputText: '',
      toolCalls: [{
        callId: 'call_lite_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' }
      }]
    }),
    async (options) => await finalResult(options, 'Lite Agent continuation completed.\n')
])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ wireMode: 'lite', approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Lite Agent continuation completion'
  )

  const first = responses.calls[0]?.request
  const second = responses.calls[1]?.request
  assert.equal(first?.wireMode, 'lite')
  assert.equal(second?.wireMode, 'lite')
  assert.match(first?.promptCacheKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(second?.promptCacheKey, first?.promptCacheKey)
  assert.ok(second?.continuation)
  assert.equal(second?.messages, undefined)
  assert.equal(first?.webSearch, false)
  assert.notEqual(first?.imageGeneration, true)
})

test('Agent freezes a credential copy before asynchronous preflight and uses a fresh key per turn', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'First frozen turn completed.\n'),
    async (options) => await finalResult(options, 'Second frozen turn completed.\n')
])
  const harness = createHarness(responses)
  const mutableCredentials = { ...credentials }

  await harness.service.start(startInput({ credentials: mutableCredentials }))
  mutableCredentials.baseUrl = 'https://mutated.example.test/v1'
  mutableCredentials.apiKey = 'sk-mutated-after-start-123456'
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.filter(
      (event) => event.type === 'turn-status' && event.status === 'completed'
    ).length === 1,
    'first frozen Agent turn'
  )

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.filter(
      (event) => event.type === 'turn-status' && event.status === 'completed'
    ).length === 2,
    'second frozen Agent turn'
  )

  assert.deepEqual(responses.calls[0]?.credentials, credentials)
  assert.equal(Object.isFrozen(responses.calls[0]?.credentials), true)
  const firstKey = responses.calls[0]?.request.promptCacheKey ?? ''
  const secondKey = responses.calls[1]?.request.promptCacheKey ?? ''
  assert.match(firstKey, /^[A-Za-z0-9_-]{43}$/u)
  assert.match(secondKey, /^[A-Za-z0-9_-]{43}$/u)
  assert.notEqual(firstKey, secondKey)
})

test('Agent forwards the confirmed Responses endpoint path to every model round', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Confirmed Agent route completed.\n')
])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ endpointPath: '/custom/v1/responses' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some(
      (event) => event.type === 'turn-status' && event.status === 'completed'
    ),
    'confirmed Agent endpoint path'
  )

  assert.equal(responses.calls[0]?.request.endpointPath, '/custom/v1/responses')
})

test('Agent redacts the current API key across SSE deltas, tool-loop context, and encrypted history', async () => {
  const apiKey = '!~%'
  const firstOutput = `Endpoint echoed [${apiKey}] before requesting a read.\n`
  const finalOutput = `Final answer omitted [${apiKey}] and remained safe.\n`
  const responses = new SequencedResponses([
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: 'Endpoint echoed [!' })
      await options.onEvent?.({ type: 'response.output_text.delta', delta: '~' })
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: '%] before requesting a read.\n'
      })
      return {
        responseId: 'response_explicit_key_tool',
        outputText: firstOutput,
        toolCalls: [{
          callId: 'call_explicit_key_read',
          name: 'read_file',
          arguments: { relative_path: 'src/main.ts' }
        }]
      }
    },
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: 'Final answer omitted [!' })
      await options.onEvent?.({ type: 'response.output_text.delta', delta: '~%] and remained safe.\n' })
      return { responseId: 'response_explicit_key_final', outputText: finalOutput, toolCalls: [] }
    }
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({
    credentials: { baseUrl: credentials.baseUrl, apiKey },
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent explicit API key redaction completion'
  )

  assert.equal(responses.calls.length, 2)
  const toolLoopContext = JSON.stringify(responses.calls[1]?.request)
  const rendererOutput = harness.events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta'
    )
    .map((event) => event.text)
    .join('')
  const persistedHistory = JSON.stringify(harness.history.appended)
  for (const value of [toolLoopContext, rendererOutput, persistedHistory]) {
    assert.equal(value.includes(apiKey), false)
    assert.match(value, /<redacted>/u)
  }
  for (const event of harness.events) {
    if (event.type === 'assistant-delta') assert.doesNotMatch(event.text, /[!~%]/u)
  }
  assert.doesNotMatch(toolLoopContext, /before requesting a read/u)
  assert.match(rendererOutput, /before requesting a read/u)
  assert.match(persistedHistory, /remained safe/u)
})

test('Agent keeps the redaction tail across tool rounds before emitting or persisting text', async () => {
  const apiKey = '!~%'
  const responses = new SequencedResponses([
    async (options) => {
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Cross-round credential [!'
      })
      return {
        responseId: 'response_cross_round_key_tool',
        outputText: 'Cross-round credential [!',
        toolCalls: [{
          callId: 'call_cross_round_key_read',
          name: 'read_file',
          arguments: { relative_path: 'src/main.ts' }
        }]
      }
    },
    async (options) => {
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: '~%] was removed.\n'
      })
      return {
        responseId: 'response_cross_round_key_final',
        outputText: '~%] was removed.\n',
        toolCalls: []
      }
    }
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({
    credentials: { baseUrl: credentials.baseUrl, apiKey },
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'cross-round API key redaction completion'
  )

  const rendererOutput = harness.events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta'
    )
    .map((event) => event.text)
    .join('')
  const persistedHistory = JSON.stringify(harness.history.appended)
  for (const value of [rendererOutput, persistedHistory]) {
    assert.equal(value.includes(apiKey), false)
    assert.match(value, /Cross-round credential \[<redacted>\] was removed/u)
  }
})

test('request mode gates low-risk search_files and dispatches only after approval', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_search_request',
      outputText: '',
      toolCalls: [{
        callId: 'call_search_request',
        name: 'search_files',
        arguments: {
          relative_path: '.',
          query: 'safe',
          case_sensitive: true
        }
      }]
    }),
    async (options) => await finalResult(options, 'The literal search completed.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'Find the safe marker.' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'search approval request'
  )
  assert.equal(harness.tools.searchCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'low')
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'search approval completion'
  )
  assert.equal(harness.tools.searchCalls, 1)
  assert.deepEqual(harness.tools.searchInputs[0], {
    workspaceToken,
    relativePath: '.',
    query: 'safe',
    caseSensitive: true
  })
  assert.ok(harness.tools.searchSignal instanceof AbortSignal)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /src\/main\.ts/u)
})

test('auto mode executes low-risk search_files without a Renderer approval event', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_search_auto',
      outputText: '',
      toolCalls: [{
        callId: 'call_search_auto',
        name: 'search_files',
        arguments: {
          relative_path: 'src',
          query: 'safe',
          case_sensitive: false
        }
      }]
    }),
    async (options) => await finalResult(options, 'Auto search completed.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'auto search completion'
  )

  assert.equal(harness.tools.searchCalls, 1)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.deepEqual(harness.tools.searchInputs[0], {
    workspaceToken,
    relativePath: 'src',
    query: 'safe',
    caseSensitive: false
  })
})

test('replace_in_file is medium risk and dispatches the exact revisioned edit after approval', async () => {
  const expectedRevision = 'a'.repeat(64)
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_replace_request',
      outputText: '',
      toolCalls: [{
        callId: 'call_replace_request',
        name: 'replace_in_file',
        arguments: {
          relative_path: 'src/main.ts',
          old_text: 'export const safe = true;',
          new_text: 'export const safe = false;',
          expected_revision: expectedRevision
        }
      }]
    }),
    async (options) => await finalResult(options, 'The revisioned edit was applied.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'Disable the safe marker.' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'replacement approval request'
  )
  assert.equal(harness.tools.replaceCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'medium')
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'replacement completion'
  )
  assert.equal(harness.tools.replaceCalls, 1)
  assert.deepEqual(harness.tools.replaceInputs[0], {
    workspaceToken,
    relativePath: 'src/main.ts',
    oldText: 'export const safe = true;',
    newText: 'export const safe = false;',
    expectedRevision
  })
  assert.ok(harness.tools.replaceSignal instanceof AbortSignal)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /New revision/u)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /b{64}/u)
})

test('replace_in_file rejects credential-bearing new_text before approval and local dispatch', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_replace_credential',
      outputText: '',
      toolCalls: [{
        callId: 'call_replace_credential',
        name: 'replace_in_file',
        arguments: {
          relative_path: 'src/main.ts',
          old_text: 'export const safe = true;',
          new_text: `export const apiKey = "${credentials.apiKey}";`,
          expected_revision: 'a'.repeat(64)
        }
      }]
    }),
    async (options) => await finalResult(options, 'The local credential policy blocked the replacement.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'credential replacement completion'
  )

  assert.equal(harness.tools.replaceCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  const toolOutput = requestItems(responses.calls[1]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(toolOutput && 'output' in toolOutput)
  assert.match(toolOutput.output, /credential policy denied/i)
  assert.doesNotMatch(JSON.stringify(harness.events), new RegExp(credentials.apiKey))
})

test('invalid replacement revision and extra fields fail before approval or dispatch', async () => {
  const invalidCalls: Array<{ label: string; arguments: ResponsesJsonObject }> = [
    {
      label: 'revision',
      arguments: {
        relative_path: 'src/main.ts',
        old_text: 'safe',
        new_text: 'unsafe',
        expected_revision: 'not-a-sha'
      }
    },
    {
      label: 'extra-field',
      arguments: {
        relative_path: 'src/main.ts',
        old_text: 'safe',
        new_text: 'unsafe',
        expected_revision: 'a'.repeat(64),
        unexpected: true
      }
    }
  ]

  for (const invalidCall of invalidCalls) {
    const responses = new SequencedResponses([
      async () => ({
        responseId: `response_invalid_replace_${invalidCall.label}`,
        outputText: '',
        toolCalls: [{
          callId: `call_invalid_replace_${invalidCall.label}`,
          name: 'replace_in_file',
          arguments: invalidCall.arguments
        }]
      })
    ])
    const harness = createHarness(responses)
    await harness.service.start(startInput())
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
      `invalid replacement ${invalidCall.label}`
    )
    assert.equal(harness.tools.replaceCalls, 0, invalidCall.label)
    assert.equal(harness.events.some((event) => event.type === 'approval-request'), false, invalidCall.label)
  }
})

test('cancelling while search approval is pending revokes the approval and never searches', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_search_cancel',
      outputText: '',
      toolCalls: [{
        callId: 'call_search_cancel',
        name: 'search_files',
        arguments: {
          relative_path: '.',
          query: 'safe',
          case_sensitive: true
        }
      }]
    })
  ])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'search cancellation approval request'
  )

  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'search cancellation completion'
  )
  assert.equal(harness.tools.searchCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), false)
})

test('manual approval gates the exact read and feeds a redacted tool result into the next sampling', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'The file exports a safe boolean.\n')
])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput())
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'approval request'
  )
  assert.equal(harness.tools.readCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'completed turn'
  )
  assert.match(started.turnId, /^turn_[A-Za-z0-9_-]{32}$/)
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(responses.calls.length, 2)
  const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
  assert.match(followUp, /function_call_output/)
  assert.match(followUp, /src\/main\.ts/)
  assert.doesNotMatch(followUp, /sk-agent-test-secret|sk-file-secret/)
  assert.equal(harness.history.appended.at(-1)?.content, 'The file exports a safe boolean.\n')
  assert.equal(harness.history.appended.at(-1)?.status, 'complete')
})

test('denial produces a bounded tool output and never touches the workspace', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'I could not read the file because approval was denied.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'approval request'
  )
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  harness.approvals.resolve(approval.approvalId, 'deny')
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'completed denial turn'
  )
  assert.equal(harness.tools.readCalls, 0)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /denied this exact local tool call/)
})

test('auto mode executes the low-risk read without a Renderer approval event', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'Auto-reviewed read completed.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'auto completed turn'
  )
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
})

test('list_directory uses the exact approval broker and returns only bounded relative entry metadata', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_list',
      outputText: '',
      toolCalls: [{
        callId: 'call_list_1',
        name: 'list_directory',
        arguments: { relative_path: '.' }
      }]
    }),
    async (options) => await finalResult(options, 'The workspace contains README.md and src.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'List the workspace root.' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'directory approval request'
  )
  assert.equal(harness.tools.listCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'low')
  assert.match(approval.label, /本地目录/u)
  harness.approvals.resolve(approval.approvalId, 'allow_once')

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'directory completed turn'
  )
  assert.equal(harness.tools.listCalls, 1)
  assert.ok(harness.tools.listSignal instanceof AbortSignal)
  assert.ok(responses.calls[0]?.request.tools?.some((tool) => tool.name === 'list_directory'))
  const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
  assert.match(followUp, /README\.md/u)
  assert.match(followUp, /directory\\tsrc/u)
  assert.match(followUp, /Truncated: no/u)
  assert.doesNotMatch(followUp, /(?:size|mtime|ctime|birthtime|[A-Za-z]:\\\\)/u)
})

test('list_directory follows auto and full approval policy without Renderer approval prompts', async () => {
  for (const approvalMode of ['auto', 'full'] as const) {
    const responses = new SequencedResponses([
      async () => ({
        responseId: `response_list_${approvalMode}`,
        outputText: '',
        toolCalls: [{
          callId: `call_list_${approvalMode}`,
          name: 'list_directory',
          arguments: { relative_path: 'src' }
        }]
      }),
      async (options) => await finalResult(options, 'Directory inspected.\n')
])
    const harness = createHarness(responses)
    await harness.service.start(startInput({ approvalMode }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} directory completion`
    )
    assert.equal(harness.tools.listCalls, 1)
    assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  }
})

test('invalid list_directory paths fail before approval or workspace enumeration', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_invalid_list',
      outputText: '',
      toolCalls: [{
        callId: 'call_invalid_list',
        name: 'list_directory',
        arguments: { relative_path: './src' }
      }]
    })
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'invalid directory tool failure'
  )
  assert.equal(harness.tools.listCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.doesNotMatch(JSON.stringify(harness.events), /\.\/src/u)
})

test('write_file uses the same exact approval broker and reports the committed revision', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_write_1',
        name: 'write_file',
        arguments: {
          relative_path: 'src/generated.ts',
          content: 'export const generated = true\n'
        }
      }]
    }),
    async (options) => await finalResult(options, 'The workspace file was created.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'Create src/generated.ts.' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'write approval request'
  )
  assert.equal(harness.tools.writeCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'medium')
  harness.approvals.resolve(approval.approvalId, 'allow_once')
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'write completed turn'
  )
  assert.equal(harness.tools.writeCalls, 1)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /New revision/)
})

test('auto mode auto-approves medium-risk write_file within workspace', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_auto_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_write_auto',
        name: 'write_file',
        arguments: { relative_path: 'src/blocked.ts', content: 'blocked\n' }
      }]
    }),
    async (options) => await finalResult(options, 'The write was auto-approved.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'auto approved write completion'
  )
  assert.equal(harness.tools.writeCalls, 1)
  assert.equal(
    harness.events.filter((event) => event.type === 'approval-request').length,
    0,
    'auto mode should not prompt for medium-risk writes'
  )
})

test('Chat Completions Agent recovers from a malformed provider tool call without touching the workspace', async () => {
  const calls: ChatCompletionsStreamWithToolsRequest[] = []
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push(structuredClone(request))
      if (calls.length === 1) {
        return {
          responseId: 'chatcmpl-invalid-tool',
          outputText: '',
          toolCalls: [{
            id: 'call_invalid_tool',
            type: 'function' as const,
            function: {
              name: 'list_files',
              arguments: JSON.stringify({ path: '.' })
            }
          }],
          hasToolCalls: true
        }
      }
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'The provider corrected its tool call and completed safely.\n'
      })
      return {
        responseId: 'chatcmpl-invalid-tool-final',
        outputText: 'The provider corrected its tool call and completed safely.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const harness = createHarness(new SequencedResponses([]), { chatCompletions })

  await harness.service.start(startInput({ endpointType: 'openai', reasoning: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'malformed Chat Completions tool recovery'
  )

  assert.equal(calls.length, 2)
  const followUp = calls[1]?.messages.at(-1)
  assert.ok(followUp?.role === 'tool')
  assert.match(followUp.content, /^tool_failed: The model proposed an invalid local tool call\./u)
  assert.match(followUp.content, /exact argument schema/u)
  assert.equal(harness.tools.listCalls + harness.tools.searchCalls + harness.tools.readCalls, 0)
  assert.equal(harness.approvals.authorizeRequests.length, 0)
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'The provider corrected its tool call and completed safely.\n'
  )
})

test('Chat Completions Agent recovers malformed JSON with only a fixed tool history shape', async () => {
  const calls: ChatCompletionsStreamWithToolsRequest[] = []
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push(structuredClone(request))
      if (calls.length === 1) {
        throw new ChatCompletionsClientError(
          'invalid_response',
          undefined,
          undefined,
          [{ id: 'call_malformed_json', name: 'write_file' }]
        )
      }
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'The malformed call was rejected safely.\n'
      })
      return {
        responseId: 'chatcmpl-malformed-final',
        outputText: 'The malformed call was rejected safely.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const harness = createHarness(new SequencedResponses([]), { chatCompletions })

  await harness.service.start(startInput({ endpointType: 'openai', reasoning: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'malformed JSON Chat Completions recovery'
  )

  assert.equal(calls.length, 2)
  const assistant = calls[1]?.messages.at(-2)
  assert.ok(assistant?.role === 'assistant')
  if (assistant?.role === 'assistant') {
    assert.deepEqual(assistant.tool_calls, [{
      id: 'call_malformed_json',
      type: 'function',
      function: { name: 'write_file', arguments: '{}' }
    }])
  }
  const followUp = calls[1]?.messages.at(-1)
  assert.ok(followUp?.role === 'tool')
  assert.match(followUp.content, /^tool_failed: The model proposed an invalid local tool call\./u)
  assertNoWorkspaceDispatch(harness.tools)
  assert.equal(harness.approvals.authorizeRequests.length, 0)
})

test('request and auto Chat Completions Agents reject targets outside the workspace', async () => {
  const toolFailure = 'tool_failed: The requested target is outside the current workspace. ' +
    'No local operation was performed. Select System Full Access or choose the target workspace, then retry.'
  const cases = [
    {
      label: 'absolute directory path',
      toolName: 'list_directory',
      arguments: { relative_path: 'C:\\Users\\example\\outside' }
    },
    {
      label: 'parent traversal search path',
      toolName: 'search_files',
      arguments: { relative_path: '../outside', query: 'safe', case_sensitive: true }
    },
    {
      label: 'absolute read path',
      toolName: 'read_file',
      arguments: { relative_path: 'C:\\Users\\example\\outside.txt' }
    },
    {
      label: 'parent traversal write path',
      toolName: 'write_file',
      arguments: { relative_path: '../outside.txt', content: 'safe\n' }
    },
    {
      label: 'absolute replacement path',
      toolName: 'replace_in_file',
      arguments: {
        relative_path: 'C:\\Users\\example\\outside.txt',
        old_text: 'safe',
        new_text: 'updated',
        expected_revision: 'a'.repeat(64)
      }
    }
  ] as const

  for (const approvalMode of ['request', 'auto'] as const) {
    for (const invalidCall of cases) {
      const calls: ChatCompletionsStreamWithToolsRequest[] = []
      const nativeToolCall = {
        id: `call_outside_${approvalMode}_${invalidCall.toolName}`,
        type: 'function' as const,
        function: {
          name: invalidCall.toolName,
          arguments: JSON.stringify(invalidCall.arguments)
        }
      }
      const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
        streamWithTools: async (_credentials, request, options = {}) => {
          calls.push(structuredClone(request))
          if (calls.length === 1) {
            return {
              responseId: `chatcmpl_outside_${approvalMode}_${invalidCall.toolName}`,
              outputText: '',
              toolCalls: [nativeToolCall],
              hasToolCalls: true
            }
          }
          await options.onEvent?.({
            type: 'response.output_text.delta',
            delta: '请切换为系统完全访问或选择目标工作区后重试。\n'
          })
          return {
            responseId: `chatcmpl_outside_final_${approvalMode}_${invalidCall.toolName}`,
            outputText: '请切换为系统完全访问或选择目标工作区后重试。\n',
            toolCalls: [],
            hasToolCalls: false
          }
        }
      }
      const harness = createHarness(new SequencedResponses([]), { chatCompletions })

      await harness.service.start(startInput({
        endpointType: 'openai',
        approvalMode,
        reasoning: 'auto'
      }))
      harness.scheduler.runAll()
      await waitFor(
        () => harness.events.some((event) =>
          event.type === 'turn-status' && ['completed', 'failed'].includes(event.status)
        ),
        `${approvalMode} ${invalidCall.label}`
      )

      const terminal = harness.events.find(
        (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
          event.type === 'turn-status' && ['completed', 'failed'].includes(event.status)
      )
      assert.equal(terminal?.status, 'completed', `${approvalMode} ${invalidCall.label}`)
      assert.equal(calls.length, 2, `${approvalMode} ${invalidCall.label}`)
      const followUp = calls[1]?.messages.at(-1)
      assert.ok(followUp?.role === 'tool', `${approvalMode} ${invalidCall.label}`)
      assert.equal(followUp.content, toolFailure, `${approvalMode} ${invalidCall.label}`)
      assertNoWorkspaceDispatch(harness.tools)
      assert.deepEqual(harness.tools.accessScopeCalls, [])
      assert.equal(harness.approvals.authorizeRequests.length, 0, `${approvalMode} ${invalidCall.label}`)
      assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
      const localState = JSON.stringify({ events: harness.events, history: harness.history.appended })
      assert.doesNotMatch(localState, /outside\.txt|\.\.|C:\\Users/u)
    }
  }
})

test('cancelling while approval is pending revokes it and produces one terminal state', async () => {
  const responses = new SequencedResponses([async () => toolResult()])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'approval request'
  )
  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'cancelled turn'
  )
  assert.equal(harness.tools.readCalls, 0)
  const terminal = harness.events.filter(
    (event) => event.type === 'turn-status' && ['completed', 'failed', 'cancelled'].includes(event.status)
  )
  assert.deepEqual(terminal.map((event) => event.type === 'turn-status' ? event.status : ''), ['cancelled'])
})

function delegationResult(
  tasks: readonly Array<{
    id?: string
    task: string
    role?: 'explorer' | 'implementer' | 'reviewer'
    mode?: 'read' | 'worktree-write'
    depends_on?: readonly string[]
    paths?: readonly string[]
  }>,
  callId = 'call_delegate_1'
): ResponsesStreamResult {
  return {
    responseId: 'response_delegate',
    outputText: '',
    toolCalls: [{
      callId,
      name: 'delegate_tasks',
      arguments: {
        tasks: tasks.map((task) => ({
          ...(task.id === undefined ? {} : { id: task.id }),
          task: task.task,
          ...(task.role === undefined ? {} : { role: task.role }),
          ...(task.mode === undefined ? {} : { mode: task.mode }),
          ...(task.depends_on === undefined ? {} : { depends_on: [...task.depends_on] }),
          ...(task.paths === undefined ? {} : { paths: [...task.paths] })
        }))
      }
    }]
  }
}

test('delegate_tasks is absent when disabled and an unadvertised call fails closed', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect the workspace structure.' }])
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: false, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'disabled delegation rejection'
  )

  assert.equal(responses.calls[0]?.request.tools?.some((tool) => tool.name === 'delegate_tasks'), false)
  assert.equal(responses.calls.length, 1)
  assert.equal(harness.tools.listCalls + harness.tools.searchCalls + harness.tools.readCalls, 0)
})

test('Chat Completions delegates through the declared protocol and reports child lifecycle', async () => {
  const calls: ChatCompletionsStreamWithToolsRequest[] = []
  let parentRounds = 0
  const chatCompletions: AgentTurnServiceOptions['chatCompletions'] = {
    streamWithTools: async (_credentials, request, options = {}) => {
      calls.push(structuredClone(request))
      const systemMessage = request.messages[0]
      const isParent = systemMessage?.role === 'system' &&
        typeof systemMessage.content === 'string' &&
        systemMessage.content.includes('user-selected local workspace through a narrow tool broker')
      if (!isParent) {
        await options.onEvent?.({
          type: 'response.output_text.delta',
          delta: 'The workspace root contains src and tests.\n'
        })
        return {
          responseId: 'chatcmpl-delegated-child',
          outputText: 'The workspace root contains src and tests.\n',
          toolCalls: [],
          hasToolCalls: false
        }
      }

      parentRounds += 1
      if (parentRounds === 1) {
        return {
          responseId: 'chatcmpl-delegated-parent-tool',
          outputText: '',
          toolCalls: [{
            id: 'call_delegate_chat',
            type: 'function',
            function: {
              name: 'delegate_tasks',
              arguments: JSON.stringify({
                tasks: [{ task: 'Inspect the workspace root.' }]
              })
            }
          }],
          hasToolCalls: true
        }
      }

      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'The delegated workspace inspection completed.\n'
      })
      return {
        responseId: 'chatcmpl-delegated-parent-final',
        outputText: 'The delegated workspace inspection completed.\n',
        toolCalls: [],
        hasToolCalls: false
      }
    }
  }
  const responses = new SequencedResponses([])
  const harness = createHarness(responses, { chatCompletions })
  const started = await harness.service.start(startInput({
    endpointType: 'openai',
    endpointPath: '/v1/chat/completions',
    reasoning: 'auto',
    subagentsEnabled: true,
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Chat Completions delegated completion'
  )

  assert.equal(responses.calls.length, 0)
  assert.equal(calls.length, 3)
  assert.equal(calls[0]?.tools.some((tool) => tool.function.name === 'delegate_tasks'), true)
  assert.deepEqual(
    calls[1]?.tools.map((tool) => tool.function.name).sort(),
    ['delegate_tasks', 'glob', 'list_directory', 'read_file', 'search_files']
  )
  assert.equal(calls[1]?.endpointPath, '/v1/chat/completions')
  const parentToolResult = calls[2]?.messages.find((message) => (
    message.role === 'tool' && message.tool_call_id === 'call_delegate_chat'
  ))
  assert.ok(parentToolResult?.role === 'tool')
  assert.match(parentToolResult.content, /The workspace root contains src and tests\./u)
  assert.equal(
    harness.history.appended.find((message) => message.role === 'assistant')?.content,
    'The delegated workspace inspection completed.\n'
  )
  const lifecycle = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => (
      event.type === 'subagent-status' && event.agentId === 'subagent:1:1'
    )
  )
  assert.deepEqual(lifecycle.map((event) => event.status), ['queued', 'running', 'completed'])
  assert.equal(lifecycle.every((event) => event.parentAgentId === `root:${started.turnId}`), true)
  assert.equal(lifecycle.every((event) => event.detail === 'Inspect the workspace root.'), true)
})

test('delegate_tasks advertises a bounded non-strict schema and rejects a six-task batch locally', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([
      { task: 'Inspect module one.' },
      { task: 'Inspect module two.' },
      { task: 'Inspect module three.' },
      { task: 'Inspect module four.' },
      { task: 'Inspect module five.' },
      { task: 'Inspect module six.' }
    ])
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'oversized delegation rejection'
  )

  const delegate = responses.calls[0]?.request.tools?.find((tool) => tool.name === 'delegate_tasks')
  assert.ok(delegate)
  assert.equal(delegate.strict, false)
  const properties = delegate.parameters.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.tasks?.minItems, 1)
  assert.equal(properties.tasks?.maxItems, 5)
  assert.equal(responses.calls.length, 1)
})

test('delegate_tasks rejects Windows root-relative paths before starting a child request', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{
      task: 'Inspect `\\Windows\\System32\\config\\SAM` for configuration details.'
    }])
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'Windows root-relative delegation rejection'
  )

  assert.equal(responses.calls.length, 1)
  assert.equal(harness.tools.listCalls + harness.tools.searchCalls + harness.tools.readCalls, 0)
  assert.doesNotMatch(JSON.stringify(harness.events), /Windows|System32|SAM/u)
})

test('full-access subagents accept absolute read paths while remaining read-only', async () => {
  const outsidePath = 'C:\\Users\\example\\outside\\source.ts'
  const responses = new SequencedResponses([
    async () => delegationResult([{
      task: `Inspect ${outsidePath} and report its exported symbols.`,
      paths: [outsidePath]
    }]),
    async () => ({
      responseId: 'response_system_subagent_read',
      outputText: '',
      toolCalls: [{
        callId: 'call_system_subagent_read',
        name: 'read_file',
        arguments: { relative_path: outsidePath }
      }]
    }),
    async (options) => await finalResult(
      options,
      `The external file ${outsidePath} exports one safe symbol; api_key=${credentials.apiKey}.\n`
    ),
    async (options) => await finalResult(
      options,
      `The system read-only investigation completed for ${outsidePath}; api_key=${credentials.apiKey}.\n`
    )
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'system-scope subagent completion'
  )

  assert.equal(harness.tools.readCalls, 1)
  assert.deepEqual(harness.tools.accessScopeCalls, [
    { toolName: 'read_file', accessScope: 'system' }
  ])
  assert.match(responses.calls[1]?.request.instructions ?? '', /System Full Access/u)
  assert.match(responses.calls[1]?.request.instructions ?? '', /read-only/u)
  assert.deepEqual(
    responses.calls[1]?.request.tools?.map((tool) => tool.name).sort(),
    ['delegate_tasks', 'glob', 'list_directory', 'read_file', 'search_files']
  )
  const parentFollowUp = requestItems(responses.calls.at(-1)?.request)
  const batchOutput = parentFollowUp.find(
    (item) => 'type' in item && item.type === 'function_call_output' && item.call_id === 'call_delegate_1'
  )
  assert.ok(batchOutput && 'output' in batchOutput)
  const batchPayload = JSON.parse(batchOutput.output) as { tasks: Array<{ output: string }> }
  assert.match(batchPayload.tasks[0]?.output ?? '', /C:\\Users\\example\\outside\\source\.ts/u)
  assert.equal(batchOutput.output.includes(credentials.apiKey), false)
  assert.match(batchOutput.output, /api_key=<redacted>/u)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  const publicState = JSON.stringify({ events: harness.events, history: harness.history.appended })
  assert.equal(publicState.includes(credentials.apiKey), false)
  assert.match(publicState, /C:\\+Users\\+example\\+outside/u)
  assert.match(publicState, /<redacted>/u)
})

test('subagents expose only read tools and reject a malicious write without local dispatch', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect generated source files.', paths: ['src'] }]),
    async () => ({
      responseId: 'response_subagent_write',
      outputText: '',
      toolCalls: [{
        callId: 'child_write_call',
        name: 'write_file',
        arguments: { relative_path: 'src/blocked.ts', content: 'blocked\n' }
      }]
    }),
    async (options) => await finalResult(options, 'The read-only delegation could not perform a write.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'read-only subagent write rejection'
  )

  assert.deepEqual(
    responses.calls[1]?.request.tools?.map((tool) => tool.name).sort(),
    ['delegate_tasks', 'glob', 'list_directory', 'read_file', 'search_files']
  )
  assert.equal(responses.calls[1]?.request.webSearch, false)
  assert.equal(responses.calls[1]?.request.imageGeneration ?? false, false)
  assert.equal(harness.tools.writeCalls, 0)
  assert.doesNotMatch(JSON.stringify(harness.events), /blocked\.ts|blocked\\n/u)
})

test('delegation returns bounded partial results and redacts child output and raw failures', async () => {
  const apiKey = '!~%'
  const responses = new SequencedResponses([
    async () => delegationResult([
      { task: 'Summarize the first module.', paths: ['src'] },
      { task: 'Summarize the second module.', paths: ['tests'] }
    ], 'call_delegate_partial'),
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: 'Evidence [!' })
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: '~%] referenced C:\\private\\secret.ts but the safe result remained useful.\n'
      })
      return {
        responseId: 'response_subagent_safe',
        outputText: `Evidence [${apiKey}] referenced C:\\private\\secret.ts but the safe result remained useful.\n`,
        toolCalls: []
      }
    },
    async () => {
      throw new Error(`raw child failure ${apiKey} at C:\\private\\failure.log`)
    },
    async (options) => await finalResult(options, 'One investigation completed and one failed safely.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({
    credentials: { baseUrl: credentials.baseUrl, apiKey },
    subagentsEnabled: true,
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'partial delegation completion'
  )

  const parentFollowUp = requestItems(responses.calls.at(-1)?.request)
  const batchOutput = parentFollowUp.find(
    (item) => 'type' in item && item.type === 'function_call_output' && item.call_id === 'call_delegate_partial'
  )
  assert.ok(batchOutput && 'output' in batchOutput)
  assert.match(batchOutput.output, /"ok":false/u)
  assert.match(batchOutput.output, /"code":"completed"/u)
  assert.match(batchOutput.output, /"code":"failed"/u)
  assert.match(batchOutput.output, /<redacted>/u)
  for (const value of [batchOutput.output, JSON.stringify(harness.events), JSON.stringify(harness.history.appended)]) {
    assert.equal(value.includes(apiKey), false)
    assert.doesNotMatch(value, /raw child failure/u)
  }
  const taskStatuses = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> =>
      event.type === 'tool-status' && event.callId.startsWith('subagent:task:')
  )
  assert.deepEqual(taskStatuses, [])
  const batchStatuses = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> =>
      event.type === 'tool-status' && event.callId === 'subagent:batch:1'
  )
  assert.deepEqual(batchStatuses.map((event) => event.status), ['running', 'failed'])
  const subagentTerminal = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => (
      event.type === 'subagent-status' && ['completed', 'failed', 'cancelled'].includes(event.status)
    )
  )
  assert.deepEqual(
    subagentTerminal.map((event) => [event.agentId, event.status]).sort(),
    [['subagent:1:1', 'completed'], ['subagent:1:2', 'failed']]
  )
})

test('subagent cancellation aborts the active child stream and produces one cancelled parent state', async () => {
  let childSignal: AbortSignal | undefined
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect the workspace until cancelled.' }]),
    async (options) => await new Promise<ResponsesStreamResult>((_resolve, reject) => {
      childSignal = options.signal
      if (options.signal?.aborted) {
        reject(new Error('cancelled child stream'))
        return
      }
      options.signal?.addEventListener('abort', () => reject(new Error('cancelled child stream')), {
        once: true
      })
    })
  ])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput({
    subagentsEnabled: true,
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(() => responses.calls.length === 2, 'active child stream')
  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'cancelled delegated turn'
  )

  assert.equal(childSignal?.aborted, true)
  const terminal = harness.events.filter(
    (event) => event.type === 'turn-status' && ['completed', 'failed', 'cancelled'].includes(event.status)
  )
  assert.deepEqual(terminal.map((event) => event.type === 'turn-status' ? event.status : ''), ['cancelled'])
  const childLifecycle = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => (
      event.type === 'subagent-status' && event.agentId === 'subagent:1:1'
    )
  )
  assert.deepEqual(childLifecycle.map((event) => event.status), ['queued', 'running', 'cancelled'])
})

test('request mode serializes subagents while auto mode runs at most three concurrently', async () => {
  for (const [approvalMode, expectedMaximum] of [['request', 1], ['auto', 3]] as const) {
    const calls: ResponseCall[] = []
    let parentCalls = 0
    let activeChildren = 0
    let maximumChildren = 0
    const responses: AgentTurnServiceOptions['responses'] = {
      async stream(callCredentials, request, options = {}) {
        calls.push({ credentials: callCredentials, request, options })
        const isParent = request.instructions.includes('user-selected local workspace through a narrow tool broker')
        if (isParent) {
          parentCalls += 1
          if (parentCalls === 1) {
            return withTestContinuation(delegationResult([
              { task: 'Inspect module one.' },
              { task: 'Inspect module two.' },
              { task: 'Inspect module three.' }
            ]))
          }
          return await finalResult(options, 'Delegated investigations completed.\n')
}
        activeChildren += 1
        maximumChildren = Math.max(maximumChildren, activeChildren)
        await new Promise<void>((resolve) => setTimeout(resolve, 15))
        activeChildren -= 1
        return await finalResult(options, 'Bounded child result.\n')
}
    }
    const harness = createHarness(responses)
    await harness.service.start(startInput({ subagentsEnabled: true, approvalMode }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} delegated concurrency completion`
    )
    assert.equal(maximumChildren, expectedMaximum)
    assert.equal(calls.filter((call) => !call.request.instructions.includes('user-selected local workspace through a narrow tool broker')).length, 3)
  }
})

test('a read subagent can delegate one nested batch and depth-two children cannot delegate again', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ id: 'parent', task: 'Coordinate the investigation.' }]),
    async () => delegationResult([{ id: 'nested', task: 'Inspect the nested concern.' }], 'call_nested'),
    async (options) => await finalResult(options, 'Nested evidence.\n'),
    async (options) => await finalResult(options, 'Parent synthesis.\n'),
    async (options) => await finalResult(options, 'Nested delegation completed.\n')
])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'request' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'nested delegated completion'
  )

  assert.equal(responses.calls.length, 5)
  assert.equal(responses.calls[1]?.request.tools?.some((tool) => tool.name === 'delegate_tasks'), true)
  assert.equal(responses.calls[2]?.request.tools?.some((tool) => tool.name === 'delegate_tasks'), false)
  const nestedLifecycle = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> => (
      event.type === 'subagent-status' && event.agentId === 'subagent:2:nested'
    )
  )
  assert.equal(nestedLifecycle.every((event) => event.parentAgentId === 'subagent:1:parent'), true)
  assert.deepEqual(nestedLifecycle.map((event) => event.status), ['queued', 'running', 'completed'])
})

test('worktree-write uses only the adapter-issued workspace token and remains workspace-scoped in full mode', async () => {
  const childWorkspaceToken = `ws_${'i'.repeat(43)}`
  const childProjectId = `project:workspace:${'q'.repeat(43)}`
  const worktreeRequests: Parameters<AgentTaskWorktreeAdapter['createIsolatedWorkspace']>[0][] = []
  const responses = new SequencedResponses([
    async () => delegationResult([{
      id: 'implementation',
      task: 'Write the isolated result.',
      role: 'implementer',
      mode: 'worktree-write'
    }]),
    async () => ({
      responseId: 'response_worktree_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_worktree_write',
        name: 'write_file',
        arguments: { relative_path: 'result.txt', content: 'isolated\n' }
      }]
    }),
    async (options) => await finalResult(options, 'Isolated write completed.\n'),
    async (options) => await finalResult(options, 'Implementation task completed.\n')
])
  const harness = createHarness(responses, {
    subagentWorktrees: {
      async createIsolatedWorkspace(input) {
        worktreeRequests.push(input)
        return {
          taskId: 'task:isolated-child',
          projectId: childProjectId,
          workspaceToken: childWorkspaceToken,
          worktreeId: 'worktree:test'
        }
      }
    }
  })
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'worktree delegated completion'
  )

  assert.equal(worktreeRequests.length, 1)
  assert.equal(worktreeRequests[0]?.source.workspaceToken, workspaceToken)
  assert.equal(harness.tools.writeCalls, 1)
  assert.equal(harness.tools.writeInputs[0]?.workspaceToken, childWorkspaceToken)
  assert.notEqual(harness.tools.writeInputs[0]?.workspaceToken, workspaceToken)
  assert.deepEqual(harness.tools.accessScopeCalls, [
    { toolName: 'write_file', accessScope: 'workspace' }
  ])
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
})

test('workspace failures are folded into fixed whitelist result codes without raw diagnostics', async () => {
  for (const [workspaceCode, expectedCode] of [
    ['path_not_found', 'not_found'],
    ['file_too_large', 'too_large']
  ] as const) {
    const responses = new SequencedResponses([
      async () => toolResult(),
      async (options) => await finalResult(options, 'The workspace read failed safely.\n')
])
    const harness = createHarness(responses)
    harness.tools.readError = new WorkspaceToolError(workspaceCode)
    await harness.service.start(startInput({ approvalMode: 'auto' }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${workspaceCode} fixed result completion`
    )
    const output = requestItems(responses.calls[1]?.request).find(
      (item) => 'type' in item && item.type === 'function_call_output'
    )
    assert.ok(output && 'output' in output)
    assert.equal(output.output, `{"ok":false,"code":"${expectedCode}"}`)
    assert.doesNotMatch(output.output, /workspace|src\/main|requested|diagnostic/i)
  }
})

test('subagent read failures reuse the same fixed workspace result code', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect the requested source file.', paths: ['src/main.ts'] }]),
    async () => toolResult(),
    async (options) => await finalResult(options, 'The requested read was unavailable.\n'),
    async (options) => await finalResult(options, 'The delegated read failed safely.\n')
])
  const harness = createHarness(responses)
  harness.tools.readError = new WorkspaceToolError('path_not_found')
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'subagent fixed workspace failure completion'
  )

  const childToolOutput = requestItems(responses.calls[2]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(childToolOutput && 'output' in childToolOutput)
  assert.equal(childToolOutput.output, '{"ok":false,"code":"not_found"}')
  const batchOutput = requestItems(responses.calls[3]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(batchOutput && 'output' in batchOutput)
  assert.doesNotMatch(batchOutput.output, /requested workspace file|src\/main\.ts/u)
  const parentKey = responses.calls[0]?.request.promptCacheKey
  const childKey = responses.calls[1]?.request.promptCacheKey
  assert.match(parentKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.match(childKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.notEqual(parentKey, childKey)
  assert.equal(responses.calls[2]?.request.promptCacheKey, childKey)
  assert.equal(responses.calls[3]?.request.promptCacheKey, parentKey)
  assert.ok(responses.calls[2]?.request.continuation)
  assert.ok(responses.calls[3]?.request.continuation)
  assert.equal(responses.calls[2]?.request.messages, undefined)
  assert.equal(responses.calls[3]?.request.messages, undefined)
  const batchStatuses = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> =>
      event.type === 'tool-status' && event.callId === 'subagent:batch:1'
  )
  assert.deepEqual(batchStatuses.map((event) => event.status), ['running', 'failed'])
  const childToolStatuses = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> =>
      event.type === 'tool-status' && event.callId === 'subagent:1:tool:1'
  )
  assert.deepEqual(childToolStatuses.map((event) => event.status), ['running', 'failed'])
  const childLifecycle = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'subagent-status' }> =>
      event.type === 'subagent-status' && event.agentId === 'subagent:1:1'
  )
  assert.deepEqual(childLifecycle.map((event) => event.status), ['queued', 'running', 'failed'])
  assert.equal(
    harness.events.some(
      (event) => event.type === 'tool-status' && event.callId.startsWith('subagent:task:')
    ),
    false
  )
})

test('shutdown waits for an active Agent stream to settle and rejects new turns', async () => {
  let observedSignal: AbortSignal | undefined
  const responses = {
    async stream(
      _credentials: ResponsesCredentials,
      _request: ResponsesStreamRequest,
      options: ResponsesStreamOptions = {}
    ): Promise<ResponsesStreamResult> {
      observedSignal = options.signal
      return await new Promise<ResponsesStreamResult>((_resolve, reject) => {
        const cancel = (): void => reject(new Error('private agent shutdown marker'))
        if (options.signal?.aborted) cancel()
        else options.signal?.addEventListener('abort', cancel, { once: true })
      })
    }
  }
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(() => observedSignal !== undefined, 'active Agent shutdown stream')

  const shutdown = harness.service.shutdown()
  assert.equal(observedSignal?.aborted, true)
  await shutdown
  assert.equal(harness.events.filter(
    (event) => event.type === 'turn-status' && event.status === 'cancelled'
  ).length, 1)
  assert.doesNotMatch(JSON.stringify(harness.events), /private agent shutdown marker/)
  await assert.rejects(
    harness.service.start(startInput()),
    (error: unknown) => error instanceof AgentTurnError && error.code === 'disposed'
  )
})

test('workspace AGENTS.md reaches the model as project instructions, without an approval prompt', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Followed project conventions.\n'),
  ])
  const harness = createHarness(responses)
  harness.tools.fileResultsByPath.set('AGENTS.md', {
    relativePath: 'AGENTS.md',
    content: '# 项目约定\n\n- 使用 pnpm，不要用 npm。\n- 改完必须运行 npm run typecheck。\n',
    revision: 'b'.repeat(64),
    truncated: false,
  })

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'AGENTS.md turn completion',
  )

  const instructions = responses.calls[0]?.request.instructions ?? ''
  assert.match(instructions, /Project instructions from the workspace AGENTS\.md/u)
  assert.match(instructions, /使用 pnpm/u)
  assert.match(instructions, /npm run typecheck/u)
  // The app's own read of the instruction file must never prompt the user.
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.equal(harness.approvals.authorizeRequests.length, 0)
})

test('a missing AGENTS.md leaves instructions unchanged and never fails the turn', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Done.\n'),
  ])
  const harness = createHarness(responses)
  // The stub answers AGENTS.md with a not-found error by default.

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'missing AGENTS.md turn completion',
  )

  const instructions = responses.calls[0]?.request.instructions ?? ''
  assert.doesNotMatch(instructions, /Project instructions from the workspace/u)
  assert.match(instructions, /Only use workspace-relative paths/u)
})

test('review turns stay isolated from project instructions', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Review complete.\n'),
  ])
  const harness = createHarness(responses)
  harness.tools.fileResultsByPath.set('AGENTS.md', {
    relativePath: 'AGENTS.md',
    content: 'PROJECT_MARKER_SHOULD_NOT_APPEAR',
    revision: 'c'.repeat(64),
    truncated: false,
  })

  await harness.service.start(startInput({ reviewMode: true }))
  harness.scheduler.runAll()
  await waitFor(() => responses.calls.length > 0, 'review turn request dispatched')

  const instructions = responses.calls[0]?.request.instructions ?? ''
  assert.doesNotMatch(instructions, /PROJECT_MARKER_SHOULD_NOT_APPEAR/u)
  assert.match(instructions, /Code review mode is active/u)
})

test('environment context tells the model the date, host OS, and that run_command has no shell', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Understood.\n'),
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(() => responses.calls.length > 0, 'environment context dispatched')

  const instructions = responses.calls[0]?.request.instructions ?? ''
  assert.match(instructions, /Current date: \d{4}-\d{2}-\d{2}/u)
  assert.match(instructions, /Host operating system:/u)
  assert.match(instructions, /run_command launches one executable directly with no shell/u)
  // The absolute workspace path must never reach the model.
  assert.equal(instructions.includes('C:\\'), false)
  assert.equal(instructions.includes('/home/'), false)
})
