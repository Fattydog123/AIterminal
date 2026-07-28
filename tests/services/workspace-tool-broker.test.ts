import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from '../../src/shared/contracts.ts'
import { ConsentStore } from '../../src/main/security/consent-store.ts'
import { AgentApprovalService } from '../../src/main/services/agent-approval-service.ts'
import {
  WorkspaceToolBroker,
  type AgentWorkspaceToolService,
  type WorkspaceToolBrokerInvocation
} from '../../src/main/services/workspace-tool-broker.ts'
import { WorkspaceToolError } from '../../src/main/services/workspace-tool-service.ts'
import type { ResponsesJsonObject } from '../../src/main/services/responses-client.ts'

const WORKSPACE_TOKEN = `ws_${'a'.repeat(43)}`
const TURN_ID = `turn_${'b'.repeat(32)}`
const OWNER_ID = 41
const FULL_REVISION = 'c'.repeat(64)
const PARTIAL_REVISION = `partial:${FULL_REVISION}`

interface BrokerHarness {
  broker: WorkspaceToolBroker
  events: AgentEvent[]
  calls: { name: string; input: Record<string, unknown> }[]
}

function unexpectedTool(name: string): never {
  throw new Error(`Unexpected workspace tool execution: ${name}`)
}

function harness(overrides: Partial<AgentWorkspaceToolService> = {}): BrokerHarness {
  const events: AgentEvent[] = []
  const calls: BrokerHarness['calls'] = []
  const record = <TInput extends Record<string, unknown>>(name: string, input: TInput): TInput => {
    calls.push({ name, input })
    return input
  }
  const workspaceTools: AgentWorkspaceToolService = {
    listDirectory: async () => unexpectedTool('list_directory'),
    readFile: async () => unexpectedTool('read_file'),
    gitSummary: async () => unexpectedTool('git_summary'),
    gitDiff: async () => unexpectedTool('git_diff'),
    searchFiles: async () => unexpectedTool('search_files'),
    globFiles: async () => unexpectedTool('glob'),
    runCommand: async () => unexpectedTool('run_command'),
    deletePath: async () => unexpectedTool('delete_path'),
    writeFile: async (input) => {
      record('write_file', input)
      return { relativePath: input.relativePath, content: input.content, revision: FULL_REVISION, truncated: false }
    },
    replaceInFile: async (input) => {
      record('replace_in_file', input)
      return { relativePath: input.relativePath, revision: FULL_REVISION, replacements: 1 }
    },
    ...overrides
  }
  const broker = new WorkspaceToolBroker({
    approvals: new AgentApprovalService({
      consents: new ConsentStore(),
      onEvent: (event) => events.push(event)
    }),
    workspaceTools,
    onEvent: (event) => events.push(event)
  })
  return { broker, events, calls }
}

function invocation(
  name: string,
  argumentsValue: ResponsesJsonObject
): WorkspaceToolBrokerInvocation {
  return {
    turnId: TURN_ID,
    toolCall: { callId: 'call_tool_1', name, arguments: argumentsValue },
    workspaceToken: WORKSPACE_TOKEN,
    ownerWebContentsId: OWNER_ID,
    approvalMode: 'full',
    exposure: 'agent',
    reviewDiffLoaded: false,
    signal: new AbortController().signal,
    apiKey: `sk-${'d'.repeat(40)}`,
    invalidToolCall: () => new Error('invalid tool call')
  }
}

test('write_file with a partial revision reaches the service and surfaces the guidance failure code', async () => {
  const { broker, calls } = harness({
    writeFile: async () => {
      calls.push({ name: 'write_file', input: {} })
      throw new WorkspaceToolError('partial_revision')
    }
  })
  const result = await broker.dispatch(invocation('write_file', {
    relative_path: 'src/app.ts',
    content: 'rewritten',
    expected_revision: PARTIAL_REVISION
  }))

  assert.equal(result.ok, false)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(result.output), { ok: false, code: 'partial_read_revision' })
})

test('replace_in_file passes a partial revision through to the service intact', async () => {
  const { broker, calls } = harness()
  const result = await broker.dispatch(invocation('replace_in_file', {
    relative_path: 'src/app.ts',
    old_text: 'const a = 1',
    new_text: 'const a = 2',
    expected_revision: PARTIAL_REVISION
  }))

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.name, 'replace_in_file')
  assert.equal(calls[0]!.input.expectedRevision, PARTIAL_REVISION)
  assert.ok(result.output.includes(`New revision: ${FULL_REVISION}`))
})

test('write_file and replace_in_file still accept a plain full revision', async () => {
  const { broker, calls } = harness()
  const write = await broker.dispatch(invocation('write_file', {
    relative_path: 'src/app.ts',
    content: 'rewritten',
    expected_revision: FULL_REVISION
  }))
  const replace = await broker.dispatch(invocation('replace_in_file', {
    relative_path: 'src/app.ts',
    old_text: 'const a = 1',
    new_text: 'const a = 2',
    expected_revision: FULL_REVISION
  }))

  assert.equal(write.ok, true)
  assert.equal(replace.ok, true)
  assert.deepEqual(calls.map((call) => call.input.expectedRevision), [FULL_REVISION, FULL_REVISION])
})

test('glob proposals parse, dispatch with defaults, and pass the pattern through', async () => {
  const { broker, calls } = harness({
    globFiles: async (input) => {
      calls.push({ name: 'glob', input })
      return {
        files: [{ relativePath: 'src/app.ts', sizeBytes: 10, modifiedMs: 1_700_000_000_000 }],
        truncated: false
      }
    }
  })
  const rootResult = await broker.dispatch(invocation('glob', { pattern: '*.ts' }))
  assert.equal(rootResult.ok, true)
  assert.ok(rootResult.output.includes('src/app.ts'))
  assert.equal(calls[0]!.input.relativePath, '.')
  assert.equal(calls[0]!.input.pattern, '*.ts')

  const scopedResult = await broker.dispatch(invocation('glob', { pattern: '**/*.test.ts', relative_path: 'tests' }))
  assert.equal(scopedResult.ok, true)
  assert.equal(calls[1]!.input.relativePath, 'tests')

  const missingPattern = await broker.dispatch(invocation('glob', { relative_path: 'src' }))
  assert.equal(missingPattern.ok, false)
  assert.ok(missingPattern.output.startsWith('tool_failed:'))
  assert.equal(calls.length, 2)
})

test('search_files passes the regex flag through only when the model sets it', async () => {
  const { broker, calls } = harness({
    searchFiles: async (input) => {
      calls.push({ name: 'search_files', input })
      return { matches: [], truncated: false }
    }
  })
  const literal = await broker.dispatch(invocation('search_files', {
    relative_path: '.',
    query: 'needle',
    case_sensitive: false
  }))
  const regex = await broker.dispatch(invocation('search_files', {
    relative_path: '.',
    query: 'needle[0-9]+',
    case_sensitive: false,
    regex: true
  }))
  assert.equal(literal.ok, true)
  assert.equal(regex.ok, true)
  assert.equal('regex' in calls[0]!.input, false)
  assert.equal(calls[1]!.input.regex, true)

  const badFlag = await broker.dispatch(invocation('search_files', {
    relative_path: '.',
    query: 'needle',
    case_sensitive: false,
    regex: 'yes'
  }))
  assert.equal(badFlag.ok, false)
  assert.equal(calls.length, 2)
})

test('malformed revisions are rejected before any workspace tool executes', async () => {
  const { broker, calls } = harness()
  const malformedRevisions = [
    'partial:',
    `partial:${'z'.repeat(64)}`,
    `partial:${'c'.repeat(63)}`,
    `partial:partial:${FULL_REVISION}`,
    ` ${FULL_REVISION}`,
    FULL_REVISION.toUpperCase()
  ]

  for (const expectedRevision of malformedRevisions) {
    const write = await broker.dispatch(invocation('write_file', {
      relative_path: 'src/app.ts',
      content: 'rewritten',
      expected_revision: expectedRevision
    }))
    const replace = await broker.dispatch(invocation('replace_in_file', {
      relative_path: 'src/app.ts',
      old_text: 'const a = 1',
      new_text: 'const a = 2',
      expected_revision: expectedRevision
    }))
    assert.equal(write.ok, false)
    assert.equal(replace.ok, false)
    assert.ok(write.output.startsWith('tool_failed:'))
    assert.ok(replace.output.startsWith('tool_failed:'))
  }
  assert.equal(calls.length, 0)
})
