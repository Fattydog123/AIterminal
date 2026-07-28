import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from '../../src/shared/contracts.ts'
import { ConsentStore } from '../../src/main/security/consent-store.ts'
import {
  AgentApprovalError,
  AgentApprovalService,
  type AgentToolApprovalRequest
} from '../../src/main/services/agent-approval-service.ts'

const workspaceToken = `ws_${'a'.repeat(43)}`
const turnId = `turn_${'b'.repeat(32)}`

function request(
  signal: AbortSignal,
  overrides: Partial<AgentToolApprovalRequest> = {}
): AgentToolApprovalRequest {
  return {
    turnId,
    callId: 'call_read_1',
    workspaceToken,
    operation: 'read',
    toolName: 'read_file',
    arguments: { relative_path: 'src/main.ts' },
    label: 'Read src/main.ts',
    risk: 'low',
    mode: 'request',
    signal,
    ...overrides
  }
}

function harness(): { service: AgentApprovalService; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const service = new AgentApprovalService({
    consents: new ConsentStore(),
    onEvent: (event) => events.push(event)
  })
  return { service, events }
}

test('manual approval is opaque, exact, single-use and bound before local execution', async () => {
  const { service, events } = harness()
  const controller = new AbortController()
  const pending = service.authorize(request(controller.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))

  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.match(approval.approvalId, /^approval_[A-Za-z0-9_-]{24}$/)
  assert.equal(service.resolve('approval_missing', 'allow_once'), false)
  assert.equal(service.resolve(approval.approvalId, 'allow_once'), true)

  const authorization = await pending
  assert.ok(authorization)
  assert.equal(authorization.decisionSource, 'user')
  assert.equal(service.consume(authorization), true)
  assert.equal(service.consume(authorization), false)
  assert.equal(service.resolve(approval.approvalId, 'allow_once'), false)
})

test('always-allow grants persist across restart, stay workspace-bound, and revoke durably', async () => {
  const storage: { value: string | null; writes: number } = { value: null, writes: 0 }
  const persistence = {
    read: async () => storage.value,
    write: async (value: string) => {
      storage.value = value
      storage.writes += 1
    }
  }
  const identities = new Map<string, { device: string; inode: string }>([
    [workspaceToken, { device: 'dev-a', inode: 'inode-a' }]
  ])
  const resolveWorkspaceIdentity = async (token: string) => identities.get(token) ?? null
  const makeService = () => {
    const events: AgentEvent[] = []
    const service = new AgentApprovalService({
      consents: new ConsentStore(),
      onEvent: (event) => events.push(event),
      persistence,
      resolveWorkspaceIdentity
    })
    return { service, events }
  }

  // Grant "always allow" in workspace A.
  const first = makeService()
  const grantController = new AbortController()
  const granting = first.service.authorize(request(grantController.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const grantEvent = first.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> => event.type === 'approval-request'
  )!
  assert.equal(first.service.resolve(grantEvent.approvalId, 'allow_session'), true)
  assert.ok(await granting)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(storage.value)
  assert.equal(first.service.listSessionScopes().length, 1)
  first.service.dispose()

  // A fresh service over the same storage models an application restart: the
  // same workspace auto-approves without any dialog.
  const second = makeService()
  const silent = await second.service.authorize(request(new AbortController().signal))
  assert.ok(silent)
  assert.equal(silent.decisionSource, 'session')
  assert.equal(second.events.some((event) => event.type === 'approval-request'), false)

  // A different workspace with its own identity still asks.
  const otherToken = `ws_${'d'.repeat(43)}`
  identities.set(otherToken, { device: 'dev-b', inode: 'inode-b' })
  const otherController = new AbortController()
  const otherPending = second.service.authorize(request(otherController.signal, { workspaceToken: otherToken }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const otherEvent = second.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> => event.type === 'approval-request'
  )
  assert.ok(otherEvent)
  assert.equal(second.service.resolve(otherEvent.approvalId, 'deny'), true)
  assert.equal(await otherPending, null)

  // Revocation removes the grant durably: a third restart asks again.
  const scope = second.service.listSessionScopes()[0]!
  assert.equal(second.service.revokeSessionScope(scope.id), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  second.service.dispose()
  const third = makeService()
  const askedAgain = third.service.authorize(request(new AbortController().signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const reaskEvent = third.events.find((event) => event.type === 'approval-request')
  assert.ok(reaskEvent)
  assert.equal(third.service.resolve((reaskEvent as { approvalId: string }).approvalId, 'deny'), true)
  assert.equal(await askedAgain, null)
  third.service.dispose()
})

test('ask_user emits a bounded question, resolves an option, and rejects crossed decisions', async () => {
  const { service, events } = harness()
  const controller = new AbortController()
  const pending = service.askUser({
    turnId,
    question: '该用哪个包管理器？',
    options: ['npm', 'pnpm', 'yarn'],
    signal: controller.signal
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  const questionEvent = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(questionEvent)
  assert.ok(questionEvent.question)
  assert.deepEqual(questionEvent.question.options, ['npm', 'pnpm', 'yarn'])
  assert.equal(questionEvent.risk, 'low')
  assert.equal(questionEvent.allowSessionScope, undefined)

  // Tool-approval decisions must not answer a question, and out-of-range
  // options must not resolve at all.
  assert.equal(service.resolve(questionEvent.approvalId, 'allow_once'), false)
  assert.equal(service.resolve(questionEvent.approvalId, 'allow_session'), false)
  assert.equal(service.resolve(questionEvent.approvalId, 'option:3'), false)
  assert.equal(service.resolve(questionEvent.approvalId, 'option:1'), true)
  assert.equal(await pending, 1)
  assert.equal(service.resolve(questionEvent.approvalId, 'option:1'), false)

  // A declined question resolves to null.
  const declineController = new AbortController()
  const declined = service.askUser({
    turnId,
    question: '保留还是重写？',
    options: ['保留', '重写'],
    signal: declineController.signal
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const declinedEvent = events.filter((event) => event.type === 'approval-request').at(-1)!
  assert.equal(service.resolve((declinedEvent as { approvalId: string }).approvalId, 'deny'), true)
  assert.equal(await declined, null)

  // An option decision must not settle a real tool approval.
  const toolController = new AbortController()
  const toolPending = service.authorize(request(toolController.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const toolEvent = events.filter((event) => event.type === 'approval-request').at(-1)!
  assert.equal(service.resolve((toolEvent as { approvalId: string }).approvalId, 'option:0'), false)
  assert.equal(service.resolve((toolEvent as { approvalId: string }).approvalId, 'deny'), true)
  assert.equal(await toolPending, null)
})

test('ask_user rejects unbounded or malformed questions before emitting anything', async () => {
  const { service, events } = harness()
  const signal = new AbortController().signal
  const invalidRequests = [
    { turnId, question: '', options: ['a', 'b'], signal },
    { turnId, question: 'x'.repeat(1_025), options: ['a', 'b'], signal },
    { turnId, question: '选哪个？', options: ['only-one'], signal },
    { turnId, question: '选哪个？', options: ['a', 'b', 'c', 'd', 'e'], signal },
    { turnId, question: '选哪个？', options: ['a', 'x'.repeat(257)], signal },
    { turnId, question: '选哪个？', options: ['a', 42], signal },
    { turnId: 'bad id', question: '选哪个？', options: ['a', 'b'], signal },
    { turnId, question: '选哪个？', options: ['a', 'b'], signal: null }
  ]
  for (const invalid of invalidRequests) {
    await assert.rejects(
      service.askUser(invalid as never),
      (error: unknown) => error instanceof AgentApprovalError && error.code === 'invalid_request'
    )
  }
  assert.equal(events.some((event) => event.type === 'approval-request'), false)
})

test('manual approval snapshots its exact binding before waiting for the user', async () => {
  const { service, events } = harness()
  const controller = new AbortController()
  const mutableRequest = request(controller.signal)
  const pending = service.authorize(mutableRequest)
  await new Promise<void>((resolve) => setImmediate(resolve))

  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)

  mutableRequest.workspaceToken = `ws_${'c'.repeat(43)}`
  mutableRequest.operation = 'write'
  mutableRequest.toolName = 'write_file'
  ;(mutableRequest.arguments as Record<string, unknown>).relative_path = 'src/changed.ts'

  assert.equal(service.resolve(approval.approvalId, 'allow_once'), true)
  const authorization = await pending
  assert.ok(authorization)
  assert.equal(authorization.workspaceToken, workspaceToken)
  assert.equal(authorization.operation, 'read')
  assert.equal(service.consume(authorization), true)
})

test('rejects coercible objects in every security-sensitive scalar binding', async () => {
  const { service, events } = harness()
  const coercibleValues: Array<[string, unknown]> = [
    ['turnId', { toString: () => turnId }],
    ['callId', { toString: () => 'call_read_1' }],
    ['workspaceToken', { toString: () => workspaceToken }],
    ['operation', { toString: () => 'read' }],
    ['toolName', { toString: () => 'read_file' }],
    ['risk', { toString: () => 'low' }],
    ['mode', { toString: () => 'request' }]
  ]

  for (const [field, value] of coercibleValues) {
    await assert.rejects(
      service.authorize(request(new AbortController().signal, {
        mode: 'full',
        [field]: value
      } as unknown as Partial<AgentToolApprovalRequest>)),
      (error: unknown) =>
        error instanceof AgentApprovalError && error.code === 'invalid_request'
    )
  }
  assert.equal(events.length, 0)
})

test('deny and cancellation never issue a consumable local capability', async () => {
  const deniedHarness = harness()
  const denied = deniedHarness.service.authorize(request(new AbortController().signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = deniedHarness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(deniedHarness.service.resolve(approval.approvalId, 'deny'), true)
  assert.equal(await denied, null)

  const cancelledHarness = harness()
  const controller = new AbortController()
  const cancelled = cancelledHarness.service.authorize(request(controller.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  assert.equal(await cancelled, null)
})

test('auto mode permits low-risk reads and medium-risk writes, while full mode stays prompt-free', async () => {
  const { service, events } = harness()
  const signal = new AbortController().signal

  const autoRead = await service.authorize(request(signal, { mode: 'auto' }))
  assert.ok(autoRead)
  assert.equal(autoRead.decisionSource, 'policy')
  assert.equal(service.consume(autoRead), true)

  const autoWrite = await service.authorize(request(signal, {
    mode: 'auto',
    operation: 'write',
    toolName: 'write_file',
    risk: 'medium'
  }))
  assert.ok(autoWrite)
  assert.equal(autoWrite.decisionSource, 'policy', 'medium-risk writes are auto-approved in auto mode')
  assert.equal(service.consume(autoWrite), true)

  const fullExecute = await service.authorize(request(signal, {
    mode: 'full',
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high'
  }))
  assert.ok(fullExecute)
  assert.equal(fullExecute.decisionSource, 'full')
  assert.equal(service.consume(fullExecute), true)
  assert.equal(events.filter((event) => event.type === 'approval-request').length, 0)
})

test('turn cancellation and disposal revoke pending approval requests', async () => {
  const { service } = harness()
  const first = service.authorize(request(new AbortController().signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  service.cancelTurn(turnId)
  assert.equal(await first, null)

  const second = service.authorize(request(new AbortController().signal, {
    turnId: `turn_${'c'.repeat(32)}`,
    callId: 'call_read_2'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  service.dispose()
  assert.equal(await second, null)
  await assert.rejects(
    service.authorize(request(new AbortController().signal)),
    (error: unknown) => error instanceof AgentApprovalError && error.code === 'disposed'
  )
})

test('invalid bindings fail with fixed errors and emitted labels are redacted', async () => {
  const { service, events } = harness()
  await assert.rejects(
    service.authorize(request(new AbortController().signal, { workspaceToken: 'D:\\private\\workspace' })),
    (error: unknown) => {
      assert.ok(error instanceof AgentApprovalError)
      assert.equal(error.code, 'invalid_request')
      assert.doesNotMatch(error.message, /private|workspace|D:\\/i)
      return true
    }
  )

  const pending = service.authorize(request(new AbortController().signal, {
    label: 'Read D:\\private\\secret.txt with Bearer sk-test-private-marker-redaction-fixture'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const serialized = JSON.stringify(events)
  assert.doesNotMatch(serialized, /D:\\|private|secret\.txt|sk-test-private-marker/i)
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  service.resolve(approval.approvalId, 'deny')
  assert.equal(await pending, null)
})

test('allow_session remembers the tool scope and skips later prompts in the same session', async () => {
  const { service, events } = harness()
  const first = service.authorize(request(new AbortController().signal, {
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high',
    arguments: { relative_path: '.', argv: ['npm', 'test'] },
    label: '运行工作区命令：npm test'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.allowSessionScope, true)
  assert.equal(service.resolve(approval.approvalId, 'allow_session'), true)
  const firstAuthorization = await first
  assert.ok(firstAuthorization)
  assert.equal(firstAuthorization.decisionSource, 'session')
  assert.equal(service.consume(firstAuthorization), true)

  // Same tool + workspace + operation + risk: no second prompt, even with different argv.
  const second = await service.authorize(request(new AbortController().signal, {
    callId: 'call_exec_2',
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high',
    arguments: { relative_path: '.', argv: ['npm', 'run', 'build'] },
    label: '运行工作区命令：npm run build'
  }))
  assert.ok(second)
  assert.equal(second.decisionSource, 'session')
  assert.equal(events.filter((event) => event.type === 'approval-request').length, 1)
  assert.equal(service.consume(second), true)

  // Different workspace: prompts again.
  const otherWorkspace = service.authorize(request(new AbortController().signal, {
    callId: 'call_exec_3',
    workspaceToken: `ws_${'d'.repeat(43)}`,
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high',
    arguments: { relative_path: '.', argv: ['npm', 'test'] },
    label: '运行工作区命令：npm test'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const prompts = events.filter(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.equal(prompts.length, 2)
  assert.equal(service.resolve(prompts[1]!.approvalId, 'deny'), true)
  assert.equal(await otherWorkspace, null)
})

test('delete_path never offers or honors session scope', async () => {
  const { service, events } = harness()
  const pending = service.authorize(request(new AbortController().signal, {
    operation: 'write',
    toolName: 'delete_path',
    risk: 'high',
    arguments: { path: 'dist', recursive: true },
    label: '删除本地路径：dist'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.allowSessionScope, undefined)
  assert.equal(service.resolve(approval.approvalId, 'allow_session'), false)
  assert.equal(service.resolve(approval.approvalId, 'allow_once'), true)
  const authorization = await pending
  assert.ok(authorization)
  assert.equal(authorization.decisionSource, 'user')
})

test('approval detail is redacted, bounded, and forwarded on the approval event', async () => {
  const { service, events } = harness()
  const pending = service.authorize(request(new AbortController().signal, {
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high',
    arguments: { relative_path: '.', argv: ['curl', '-H', 'Authorization: Bearer sk-test-private-marker'] },
    label: '运行工作区命令',
    detail: '$ curl -H "Authorization: Bearer sk-test-private-marker"\n工作目录：（工作区根目录）'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.ok(approval.detail)
  assert.doesNotMatch(approval.detail!, /sk-test-private-marker/)
  assert.match(approval.detail!, /工作目录/)
  service.resolve(approval.approvalId, 'deny')
  assert.equal(await pending, null)
})

test('a multi-line diff preview survives redaction instead of being cut to one short message', async () => {
  const { service, events } = harness()
  // redactSensitiveText caps text at 600 characters, which would leave the user
  // approving a write they cannot read. The detail must keep its full preview.
  const body = Array.from(
    { length: 40 },
    (_, index) => `const value${index} = computeSomething(${index}, "payload-${index}");`
  ).join('\n')
  const detail = `写入 src/app.ts（4200 字节）：\n${body}`
  assert.ok(detail.length > 2_000)
  const pending = service.authorize(request(new AbortController().signal, {
    operation: 'write',
    toolName: 'write_file',
    risk: 'medium',
    arguments: { relative_path: 'src/app.ts', content: body },
    label: '写入工作区文件：src/app.ts',
    detail
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval?.detail)
  // Both the first and the last preview line have to reach the dialog.
  assert.match(approval.detail!, /const value0 = /)
  assert.match(approval.detail!, /const value39 = /)
  assert.ok(approval.detail!.length > 2_000)
  service.resolve(approval.approvalId, 'deny')
  assert.equal(await pending, null)
})

test('session scopes are listable without tokens and revocation restores prompting', async () => {
  const { service, events } = harness()
  const first = service.authorize(request(new AbortController().signal, {
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high',
    arguments: { relative_path: '.', argv: ['npm', 'test'] },
    label: '运行工作区命令：npm test'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  service.resolve(approval.approvalId, 'allow_session')
  assert.ok(await first)

  const scopes = service.listSessionScopes()
  assert.equal(scopes.length, 1)
  assert.deepEqual(
    { toolName: scopes[0]!.toolName, operation: scopes[0]!.operation, risk: scopes[0]!.risk },
    { toolName: 'run_command', operation: 'execute', risk: 'high' }
  )
  // The descriptor must never carry the workspace token or the raw scope key.
  assert.doesNotMatch(JSON.stringify(scopes), /ws_/)
  assert.match(scopes[0]!.id, /^[a-f0-9]{32}$/)

  assert.equal(service.revokeSessionScope('nonexistent'), false)
  assert.equal(service.revokeSessionScope(scopes[0]!.id), true)
  assert.equal(service.listSessionScopes().length, 0)

  // With the scope revoked the same call prompts again.
  const second = service.authorize(request(new AbortController().signal, {
    callId: 'call_exec_after_revoke',
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high',
    arguments: { relative_path: '.', argv: ['npm', 'test'] },
    label: '运行工作区命令：npm test'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const prompts = events.filter((event) => event.type === 'approval-request')
  assert.equal(prompts.length, 2)
  service.resolve((prompts[1] as Extract<AgentEvent, { type: 'approval-request' }>).approvalId, 'deny')
  assert.equal(await second, null)
})
