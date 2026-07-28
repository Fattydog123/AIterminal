import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createComposerCapabilitiesController,
  type ComposerCapabilitiesEnvironment,
  type ComposerLaunchPreparation,
  type ComposerTurnSubmission,
} from '../../src/renderer/src/composer/composer-capabilities.ts'
import type {
  ComposerCapabilitiesAdapter,
  ComposerWorkspaceFileIndex,
} from '../../src/renderer/src/composer/composer-capabilities-adapter.ts'
import type {
  ApiResult,
  AttachmentSelection,
  CapabilityCatalog,
  CapabilityCommandDescriptor,
  CapabilityExecuteInput,
  CapabilityExecuteResult,
  CapabilityListInput,
  PluginDescriptor,
  SkillDescriptor,
} from '../../src/shared/contracts.ts'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const error = <T>(message: string): ApiResult<T> => ({
  ok: false,
  error: { code: 'runtime_error', message, retryable: true },
})

const commands: CapabilityCommandDescriptor[] = [
  { id: 'plan', name: '计划模式', description: '计划', aliases: ['p'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'goal', name: '目标', description: '目标', aliases: ['objective'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'compact', name: '压缩上下文', description: '压缩', aliases: ['summarize'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'review', name: '代码审查', description: '审查', aliases: ['audit'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'init', name: '初始化项目', description: '初始化', aliases: ['setup'], scope: 'builtin', permissions: ['read', 'write'], safe: false, availability: 'requires-approval' },
]

const skill: SkillDescriptor = {
  id: 'review-helper',
  grantHandle: 'grant:skill:one',
  name: 'Review helper',
  description: 'Review instructions',
  scope: 'workspace',
  relativePath: '.codex/skills/review-helper/SKILL.md',
  permissions: ['read'],
}

const plugin: PluginDescriptor = {
  id: 'notes',
  grantHandle: 'grant:plugin:one',
  name: 'Notes',
  description: 'Notes plugin',
  version: '1.0.0',
  scope: 'workspace',
  relativePath: '.codex/plugins/notes',
  permissions: ['read'],
  enabled: true,
}

const disabledPlugin: PluginDescriptor = {
  ...plugin,
  id: 'disabled-notes',
  grantHandle: 'grant:plugin:disabled',
  name: 'Disabled notes',
  enabled: false,
}

function catalog(overrides: Partial<CapabilityCatalog> = {}): CapabilityCatalog {
  return {
    commands,
    skills: [skill],
    plugins: [plugin, disabledPlugin],
    session: { planMode: false, memoriesEnabled: true },
    ...overrides,
  }
}

class FakeAdapter implements ComposerCapabilitiesAdapter {
  readonly lists: Array<CapabilityListInput | undefined> = []
  readonly executions: CapabilityExecuteInput[] = []
  readonly attachmentCalls: number[] = []
  listImpl: (input?: CapabilityListInput) => Promise<ApiResult<CapabilityCatalog>> = async () => ok(catalog())
  executeImpl: (input: CapabilityExecuteInput) => Promise<ApiResult<CapabilityExecuteResult>> = async (input) => ok({
    id: input.id,
    status: 'completed',
    message: `${input.id} completed`,
    ...(input.grantHandle ? { instructions: 'Use the loaded skill exactly once.' } : {}),
    session: { planMode: false, memoriesEnabled: true },
  })
  attachmentsImpl: () => Promise<ApiResult<AttachmentSelection[]>> = async () => ok([])
  readonly fileLists: string[] = []
  filesImpl: (workspaceToken: string) => Promise<ApiResult<ComposerWorkspaceFileIndex>> =
    async () => ok({ files: [], truncated: false })

  listCapabilities(input?: CapabilityListInput): Promise<ApiResult<CapabilityCatalog>> {
    this.lists.push(input)
    if (input !== undefined && Object.hasOwn(input, 'workspaceToken') && input.category === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'denied',
          message: 'A category-specific capability discovery request is required.',
          retryable: false,
        },
      })
    }
    return this.listImpl(input)
  }

  executeCapability(input: CapabilityExecuteInput): Promise<ApiResult<CapabilityExecuteResult>> {
    this.executions.push(input)
    return this.executeImpl(input)
  }

  selectAttachments(): Promise<ApiResult<AttachmentSelection[]>> {
    this.attachmentCalls.push(this.attachmentCalls.length + 1)
    return this.attachmentsImpl()
  }

  listWorkspaceFiles(workspaceToken: string): Promise<ApiResult<ComposerWorkspaceFileIndex>> {
    this.fileLists.push(workspaceToken)
    return this.filesImpl(workspaceToken)
  }
}

function harness(options: {
  adapter?: FakeAdapter
  launch?: (submission: ComposerTurnSubmission) => Promise<boolean>
  prepare?: (requestedMode?: 'chat' | 'agent') => Promise<ComposerLaunchPreparation>
  contextSummary?: () => string
  compact?: () => Promise<{ message: string }>
  workspaceToken?: string
} = {}) {
  const adapter = options.adapter ?? new FakeAdapter()
  const launches: ComposerTurnSubmission[] = []
  let attachmentId = 0
  const environment: ComposerCapabilitiesEnvironment = {
    createAttachmentId: () => `attachment:${++attachmentId}`,
  }
  const controller = createComposerCapabilitiesController({
    runtime: 'desktop',
    adapter,
    environment,
    initialWorkspaceToken: options.workspaceToken ?? 'workspace:one',
    getContextSummary: options.contextSummary ?? (() => ''),
    prepareLaunch: options.prepare,
    launchTurn: async (submission) => {
      launches.push(submission)
      return options.launch ? options.launch(submission) : true
    },
    compactConversation: options.compact,
  })
  return { adapter, controller, launches }
}

test('palette canonicalizes aliases and keeps disabled plugins unselectable', async () => {
  const { controller } = harness()
  await controller.actions.initialize()

  controller.actions.setDraft('/objective')
  assert.deepEqual(controller.getSnapshot().palette.items.map((item) => item.key), ['command:goal'])
  await controller.actions.choosePaletteItem('command:goal')
  assert.equal(controller.getSnapshot().draft, '/goal ')

  controller.actions.setDraft('/')
  controller.actions.highlightPaletteItem('command:compact')
  assert.equal(controller.getSnapshot().palette.highlightedKey, 'command:compact')

  controller.actions.setDraft('@disabled')
  await controller.actions.discover('@')
  const item = controller.getSnapshot().palette.items.find((entry) => entry.key === 'plugin:disabled-notes')
  assert.equal(item?.disabled, true)
  await controller.actions.choosePaletteItem('plugin:disabled-notes')
  assert.equal(controller.getSnapshot().selectedPlugin, null)
})

test('initial catalog listing is unscoped and only category discovery binds the workspace', async () => {
  const { adapter, controller } = harness({ workspaceToken: 'workspace:catalog' })

  await controller.actions.initialize()
  assert.deepEqual(adapter.lists, [undefined])
  assert.equal(controller.getSnapshot().catalog.commands.length, commands.length)

  await controller.actions.discover('$')
  assert.deepEqual(adapter.lists[1], {
    category: 'skills',
    workspaceToken: 'workspace:catalog',
  })
  assert.equal(controller.getSnapshot().discovery.$.state, 'ready')
})

test('slash commands wait for deferred catalog initialization without launching a paid turn', async () => {
  const adapter = new FakeAdapter()
  const pendingCatalog = deferred<ApiResult<CapabilityCatalog>>()
  adapter.listImpl = async () => pendingCatalog.promise
  let prepareCalls = 0
  const { controller, launches } = harness({
    adapter,
    prepare: async () => {
      prepareCalls += 1
      return { ok: true }
    },
  })

  const initializing = controller.actions.initialize()
  controller.actions.setDraft('/plan')
  assert.equal(controller.getSnapshot().catalogLoading, true)
  assert.equal(controller.getSnapshot().palette.loading, true)
  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().draft, '/plan')
  assert.match(controller.getSnapshot().notice, /能力目录.*加载/u)
  assert.equal(prepareCalls, 0)
  assert.equal(launches.length, 0)

  pendingCatalog.resolve(ok(catalog()))
  await initializing
  assert.equal(controller.getSnapshot().palette.loading, false)
  assert.equal(await controller.actions.submit(), true)
  assert.equal(adapter.executions.at(-1)?.id, 'plan')
  assert.equal(launches.length, 0)
})

test('failed catalog initialization preserves slash drafts and its error without launching', async () => {
  const adapter = new FakeAdapter()
  adapter.listImpl = async () => error('Capability catalog is offline.')
  let prepareCalls = 0
  const { controller, launches } = harness({
    adapter,
    prepare: async () => {
      prepareCalls += 1
      return { ok: true }
    },
  })
  await controller.actions.initialize()
  controller.actions.setDraft('/plan')

  assert.equal(controller.getSnapshot().catalogLoading, false)
  assert.equal(controller.getSnapshot().palette.loading, false)
  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().draft, '/plan')
  assert.equal(controller.getSnapshot().notice, 'Capability catalog is offline.')
  assert.equal(prepareCalls, 0)
  assert.equal(launches.length, 0)
  assert.equal(adapter.executions.length, 0)
})

test('successful one-time skill grants return discovery to idle for a fresh grant', async () => {
  const adapter = new FakeAdapter()
  let discoverySequence = 0
  adapter.listImpl = async (input) => {
    if (input?.category !== 'skills') return ok(catalog())
    discoverySequence += 1
    return ok(catalog({
      skills: [{ ...skill, grantHandle: `grant:skill:success:${discoverySequence}` }],
    }))
  }
  const { controller } = harness({ adapter })
  await controller.actions.initialize()
  await controller.actions.discover('$')
  const first = controller.getSnapshot().catalog.skills[0]!

  await controller.actions.selectSkill(first)
  assert.equal(controller.getSnapshot().discovery.$.state, 'idle')
  await controller.actions.discover('$')
  const second = controller.getSnapshot().catalog.skills[0]!

  assert.notEqual(second.grantHandle, first.grantHandle)
  await controller.actions.selectSkill(second)
  assert.deepEqual(
    adapter.executions.map((entry) => entry.grantHandle),
    ['grant:skill:success:1', 'grant:skill:success:2'],
  )
  assert.equal(controller.getSnapshot().discovery.$.state, 'idle')
})

test('failed and thrown one-time skill grants can rediscover fresh grants and retry', async () => {
  const adapter = new FakeAdapter()
  let discoverySequence = 0
  let executionSequence = 0
  adapter.listImpl = async (input) => {
    if (input?.category !== 'skills') return ok(catalog())
    discoverySequence += 1
    return ok(catalog({
      skills: [{ ...skill, grantHandle: `grant:skill:retry:${discoverySequence}` }],
    }))
  }
  adapter.executeImpl = async (input) => {
    executionSequence += 1
    if (executionSequence === 1) return error('grant rejected')
    if (executionSequence === 2) throw new Error('grant transport failed')
    return ok({
      id: input.id,
      status: 'completed',
      message: 'skill loaded',
      instructions: 'Fresh retry instructions.',
    })
  }
  const { controller } = harness({ adapter })
  await controller.actions.initialize()

  await controller.actions.discover('$')
  await controller.actions.selectSkill(controller.getSnapshot().catalog.skills[0]!)
  assert.equal(controller.getSnapshot().selectedSkill, null)
  assert.equal(controller.getSnapshot().discovery.$.state, 'idle')

  await controller.actions.discover('$')
  await controller.actions.selectSkill(controller.getSnapshot().catalog.skills[0]!)
  assert.equal(controller.getSnapshot().selectedSkill, null)
  assert.equal(controller.getSnapshot().discovery.$.state, 'idle')

  await controller.actions.discover('$')
  await controller.actions.selectSkill(controller.getSnapshot().catalog.skills[0]!)
  assert.equal(controller.getSnapshot().selectedSkill?.instructions, 'Fresh retry instructions.')
  assert.equal(controller.getSnapshot().discovery.$.state, 'idle')
  assert.deepEqual(
    adapter.executions.map((entry) => entry.grantHandle),
    ['grant:skill:retry:1', 'grant:skill:retry:2', 'grant:skill:retry:3'],
  )
})

test('failed and thrown launches preserve the complete editable revision, accepted launch clears it', async () => {
  const adapter = new FakeAdapter()
  adapter.attachmentsImpl = async () => ok([{
    attachmentToken: 'attachment_token_one',
    displayName: 'spec.md',
    mediaKind: 'text',
  }])
  let outcome: 'false' | 'throw' | 'true' = 'false'
  const { controller, launches } = harness({
    adapter,
    contextSummary: () => 'Earlier context',
    launch: async () => {
      if (outcome === 'throw') throw new Error('network')
      return outcome === 'true'
    },
  })
  await controller.actions.initialize()
  controller.actions.setDraft('$review-helper @notes inspect this')
  await controller.actions.selectSkill(skill)
  controller.actions.selectPlugin(plugin)
  await controller.actions.selectAttachments()

  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().draft, '$review-helper @notes inspect this')
  assert.equal(controller.getSnapshot().attachments.length, 1)
  assert.equal(controller.getSnapshot().selectedSkill?.id, skill.id)
  assert.equal(controller.getSnapshot().selectedPlugin?.id, plugin.id)
  assert.match(launches[0]!.transportPrompt, /Previous context summary:\nEarlier context/u)
  assert.match(launches[0]!.transportPrompt, /Selected skill instructions.*\nUse the loaded skill exactly once\./su)
  assert.deepEqual(launches[0]!.attachmentTokens, ['attachment_token_one'])
  assert.equal(launches[0]!.workspaceToken, 'workspace:one')
  assert.equal(launches[0]!.contextMessageLimit, 6)

  outcome = 'throw'
  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().attachments.length, 1)
  assert.match(controller.getSnapshot().notice, /草稿和附件已保留/u)

  outcome = 'true'
  assert.equal(await controller.actions.submit(), true)
  assert.equal(controller.getSnapshot().draft, '')
  assert.equal(controller.getSnapshot().attachments.length, 0)
  assert.equal(controller.getSnapshot().selectedSkill, null)
  assert.equal(controller.getSnapshot().selectedPlugin, null)
})

test('accepted launch removes only submitted attachment ids and preserves edits made while launch waits', async () => {
  const adapter = new FakeAdapter()
  const picks: AttachmentSelection[][] = [
    [{ attachmentToken: 'attachment_old', displayName: 'old.txt', mediaKind: 'text' }],
    [{ attachmentToken: 'attachment_new', displayName: 'new.txt', mediaKind: 'text' }],
  ]
  adapter.attachmentsImpl = async () => ok(picks.shift() ?? [])
  const pending = deferred<boolean>()
  const { controller } = harness({ adapter, launch: () => pending.promise })
  await controller.actions.initialize()
  controller.actions.setDraft('first revision')
  await controller.actions.selectAttachments()

  const submitting = controller.actions.submit()
  assert.equal(controller.getSnapshot().submitting, true)
  controller.actions.setDraft('second revision')
  await controller.actions.selectAttachments()
  pending.resolve(true)

  assert.equal(await submitting, true)
  assert.equal(controller.getSnapshot().draft, 'second revision')
  assert.deepEqual(controller.getSnapshot().attachments.map((entry) => entry.name), ['new.txt'])
})

test('submit is single-flight while preparation or launch is pending', async () => {
  const pending = deferred<boolean>()
  let launchCalls = 0
  const { controller } = harness({ launch: async () => {
    launchCalls += 1
    return pending.promise
  } })
  await controller.actions.initialize()
  controller.actions.setDraft('one request')
  const first = controller.actions.submit()
  assert.equal(await controller.actions.submit(), false)
  assert.equal(launchCalls, 1)
  pending.resolve(true)
  assert.equal(await first, true)
})

test('prepareLaunch changes scope before the final ticket and non-turn commands skip preparation', async () => {
  const adapter = new FakeAdapter()
  let prepareCalls = 0
  const { controller, launches } = harness({
    adapter,
    workspaceToken: 'workspace:old',
    prepare: async () => {
      prepareCalls += 1
      return { ok: true, workspaceToken: 'workspace:new' }
    },
  })
  await controller.actions.initialize()
  controller.actions.setDraft('$review-helper inspect')
  await controller.actions.selectSkill(skill)
  assert.match(controller.getSnapshot().selectedSkill?.instructions ?? '', /loaded skill/u)

  assert.equal(await controller.actions.submit(), true)
  assert.equal(prepareCalls, 1)
  assert.equal(controller.getSnapshot().workspaceToken, 'workspace:new')
  assert.doesNotMatch(launches[0]!.transportPrompt, /loaded skill/u)

  controller.actions.setDraft('/plan')
  adapter.executeImpl = async (input) => ok({
    id: input.id,
    status: 'completed',
    message: 'plan enabled',
    session: { planMode: true, memoriesEnabled: true },
  })
  assert.equal(await controller.actions.submit(), true)
  assert.equal(prepareCalls, 1)
  assert.equal(controller.getSnapshot().session.planMode, true)
})

test('/review binds the post-preparation workspace, excludes attachments, and rearms after any failed launch', async () => {
  const adapter = new FakeAdapter()
  const reviewHandle = `review_${'r'.repeat(43)}`
  adapter.executeImpl = async (input) => ok({
    id: input.id,
    status: 'preview',
    message: 'review armed',
    reviewHandle,
    session: { planMode: false, memoriesEnabled: true },
  })
  adapter.attachmentsImpl = async () => ok([{
    attachmentToken: 'attachment_review',
    displayName: 'ignored.txt',
    mediaKind: 'text',
  }])
  let accepted = false
  const { controller, launches } = harness({
    adapter,
    workspaceToken: 'workspace:old',
    prepare: async (mode) => {
      assert.equal(mode, 'agent')
      return { ok: true, workspaceToken: 'workspace:review' }
    },
    launch: async () => accepted,
  })
  await controller.actions.initialize()
  controller.actions.setDraft('/review')
  await controller.actions.selectAttachments()

  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().draft, '/review')
  assert.equal(controller.getSnapshot().attachments.length, 1)
  assert.equal(adapter.executions.filter((entry) => entry.id === 'review').length, 1)
  assert.equal(adapter.executions.find((entry) => entry.id === 'review')?.workspaceToken, 'workspace:review')
  assert.deepEqual(launches[0], {
    visiblePrompt: '/review',
    transportPrompt: '/review',
    attachmentTokens: [],
    workspaceToken: 'workspace:review',
    requestedMode: 'agent',
    reviewHandle,
  })

  accepted = true
  assert.equal(await controller.actions.submit(), true)
  assert.equal(adapter.executions.filter((entry) => entry.id === 'review').length, 2)
  assert.equal(controller.getSnapshot().draft, '')
  assert.equal(controller.getSnapshot().attachments.length, 0)
})

test('/review rejects malformed handles without clearing the draft or launching', async () => {
  const adapter = new FakeAdapter()
  adapter.executeImpl = async (input) => ok({ id: input.id, status: 'preview', message: 'bad handle', reviewHandle: 'review_invalid' })
  const { controller, launches } = harness({ adapter })
  await controller.actions.initialize()
  controller.actions.setDraft('/review')

  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().draft, '/review')
  assert.equal(launches.length, 0)
  assert.match(controller.getSnapshot().notice, /not issued safely/u)
})

test('scope changes invalidate delayed discovery and skill continuations', async () => {
  const adapter = new FakeAdapter()
  const oldDiscovery = deferred<ApiResult<CapabilityCatalog>>()
  const oldSkill = deferred<ApiResult<CapabilityExecuteResult>>()
  adapter.listImpl = async (input) => {
    if (input?.category === 'skills' && input.workspaceToken === 'workspace:old') return oldDiscovery.promise
    if (input?.category === 'skills') return ok(catalog({ skills: [{ ...skill, id: 'new-skill' }] }))
    return ok(catalog())
  }
  adapter.executeImpl = async (input) => input.grantHandle === skill.grantHandle
    ? oldSkill.promise
    : ok({ id: input.id, status: 'completed', message: 'done', instructions: 'new instructions' })
  const { controller } = harness({ adapter, workspaceToken: 'workspace:old' })
  await controller.actions.initialize()
  controller.actions.setDraft('$old')
  const discovery = controller.actions.discover('$')
  controller.actions.setDraft('$review-helper task')
  const loadingSkill = controller.actions.selectSkill(skill)

  await controller.actions.changeScope('workspace:new')
  await controller.actions.discover('$')
  oldDiscovery.resolve(ok(catalog({ skills: [{ ...skill, id: 'stale-skill', grantHandle: 'grant:stale' }] })))
  oldSkill.resolve(ok({ id: skill.id, status: 'completed', message: 'stale', instructions: 'stale instructions' }))
  await Promise.all([discovery, loadingSkill])

  assert.equal(controller.getSnapshot().workspaceToken, 'workspace:new')
  assert.equal(controller.getSnapshot().selectedSkill, null)
  assert.equal(controller.getSnapshot().catalog.skills.some((entry) => entry.id === 'stale-skill'), false)
  assert.equal(controller.getSnapshot().catalog.skills.some((entry) => entry.id === 'new-skill'), true)
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /stale instructions/u)
})

test('Images-only policy clears attachments and blocks the picker while preserving the six-item bound', async () => {
  const { adapter, controller } = harness()
  await controller.actions.initialize()
  controller.actions.addLocalAttachments(Array.from({ length: 7 }, (_, index) => ({
    name: `${index}.txt`,
    byteLength: 100,
    mediaKind: 'text' as const,
  })))
  assert.equal(controller.getSnapshot().attachments.length, 6)

  controller.actions.setAttachmentsAllowed(false)
  assert.equal(controller.getSnapshot().attachments.length, 0)
  assert.match(controller.getSnapshot().notice, /已移除 Chat 附件/u)
  await controller.actions.selectAttachments()
  assert.equal(adapter.attachmentCalls.length, 0)
  assert.match(controller.getSnapshot().notice, /Images 模型不接收 Chat 附件/u)
})

test('catalog and command failures preserve their input and compact uses the conversation result', async () => {
  const adapter = new FakeAdapter()
  let compactCalls = 0
  const { controller } = harness({
    adapter,
    compact: async () => {
      compactCalls += 1
      return { message: 'Compacted locally.' }
    },
  })
  await controller.actions.initialize()
  adapter.executeImpl = async (input) => ok({
    id: input.id,
    status: 'preview',
    message: 'Context compaction is ready.',
  })
  controller.actions.setDraft('/compact')
  assert.equal(await controller.actions.submit(), true)
  assert.equal(compactCalls, 1)
  assert.equal(controller.getSnapshot().notice, 'Compacted locally.')

  adapter.executeImpl = async () => error('command failed')
  controller.actions.setDraft('/plan')
  assert.equal(await controller.actions.submit(), false)
  assert.equal(controller.getSnapshot().draft, '/plan')
  assert.equal(controller.getSnapshot().notice, 'command failed')

  controller.actions.setNotice('Conversation archived.')
  assert.equal(controller.getSnapshot().notice, 'Conversation archived.')
  controller.actions.clearNotice()
  assert.equal(controller.getSnapshot().notice, '')
})

test('@ palette lists workspace files after plugins and inserts a path mention', async () => {
  const adapter = new FakeAdapter()
  adapter.filesImpl = async () => ok({
    files: ['README.md', 'src/App.tsx', 'src/main.ts'],
    truncated: false,
  })
  const { controller, launches } = harness({ adapter })
  await controller.actions.initialize()

  await controller.actions.discover('@')
  controller.actions.setDraft('@')
  assert.deepEqual(adapter.fileLists, ['workspace:one'])
  const keys = controller.getSnapshot().palette.items.map((item) => item.key)
  assert.equal(keys[0], 'plugin:notes')
  assert.ok(keys.includes('file:src/App.tsx'))

  controller.actions.setDraft('@app')
  const fileItem = controller.getSnapshot().palette.items.find((item) => item.key === 'file:src/App.tsx')
  assert.equal(fileItem?.kind, 'file')
  assert.equal(fileItem?.label, 'App.tsx')
  await controller.actions.choosePaletteItem('file:src/App.tsx')
  assert.equal(controller.getSnapshot().draft, '@src/App.tsx ')

  controller.actions.setDraft('@src/App.tsx 解释这个文件')
  assert.equal(await controller.actions.submit(), true)
  assert.equal(launches.length, 1)
  assert.match(launches[0]!.transportPrompt, /Referenced workspace files/u)
  assert.match(launches[0]!.transportPrompt, /- src\/App\.tsx/u)
})

test('file-only @ mention passes validation while unknown mentions stay blocked', async () => {
  const adapter = new FakeAdapter()
  adapter.filesImpl = async () => ok({ files: ['docs/guide.md'], truncated: false })
  const { controller, launches } = harness({ adapter })
  await controller.actions.initialize()
  await controller.actions.discover('@')
  controller.actions.setDraft('@docs/guide.md')

  assert.equal(await controller.actions.submit(), true)
  assert.equal(launches.length, 1)

  controller.actions.setDraft('@missing/file.md')
  assert.equal(await controller.actions.submit(), false)
  assert.match(controller.getSnapshot().notice, /插件或工作区文件/u)
  assert.equal(launches.length, 1)
})

test('file index failures degrade to a plugin-only palette and scope changes reset the index', async () => {
  const adapter = new FakeAdapter()
  adapter.filesImpl = async () => error('files unavailable')
  const { controller } = harness({ adapter })
  await controller.actions.initialize()
  await controller.actions.discover('@')
  controller.actions.setDraft('@')
  assert.equal(controller.getSnapshot().discovery['@'].state, 'ready')
  assert.equal(controller.getSnapshot().palette.items.some((item) => item.kind === 'file'), false)
  assert.equal(controller.getSnapshot().palette.items.some((item) => item.kind === 'plugin'), true)

  adapter.filesImpl = async () => ok({ files: ['src/new.ts'], truncated: false })
  await controller.actions.changeScope('workspace:two')
  await controller.actions.discover('@')
  controller.actions.setDraft('@')
  assert.deepEqual(adapter.fileLists.at(-1), 'workspace:two')
  assert.equal(controller.getSnapshot().palette.items.some((item) => item.key === 'file:src/new.ts'), true)
})

test('token attachments honor a custom size label and keep the clipboard default', async () => {
  const { controller } = harness()
  await controller.actions.initialize()
  controller.actions.addTokenAttachments([
    { attachmentToken: 'token:1', displayName: 'notes.md', mediaKind: 'text', sizeLabel: '拖入文件' },
    { attachmentToken: 'token:2', displayName: 'shot.png', mediaKind: 'image' },
  ])
  const attachments = controller.getSnapshot().attachments
  assert.equal(attachments[0]?.sizeLabel, '拖入文件')
  assert.equal(attachments[1]?.sizeLabel, '剪贴板图片')
})
