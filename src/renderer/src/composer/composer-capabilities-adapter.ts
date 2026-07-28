import type {
  ApiResult,
  AttachmentSelection,
  CapabilityCatalog,
  CapabilityExecuteInput,
  CapabilityExecuteResult,
  CapabilityListInput,
  CapabilitySessionState,
} from '../../../shared/contracts.ts'

export type ComposerRuntime = 'desktop' | 'preview' | 'disconnected'

export interface ComposerWorkspaceFileIndex {
  readonly files: readonly string[]
  readonly truncated: boolean
}

export interface ComposerCapabilitiesAdapter {
  listCapabilities(input?: CapabilityListInput): Promise<ApiResult<CapabilityCatalog>>
  executeCapability(input: CapabilityExecuteInput): Promise<ApiResult<CapabilityExecuteResult>>
  selectAttachments(): Promise<ApiResult<AttachmentSelection[]>>
  listWorkspaceFiles(workspaceToken: string): Promise<ApiResult<ComposerWorkspaceFileIndex>>
}

// Mention tokens are whitespace-delimited, so only whitespace-free relative
// paths can round-trip through the draft; anything else stays out of the index.
const FILE_INDEX_LIMIT = 400
const FILE_INDEX_MAX_DEPTH = 6
const FILE_INDEX_MAX_DIRECTORY_READS = 64
const FILE_INDEX_SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage', 'electron_publish',
  '.venv', 'venv', '__pycache__', 'target', '.next', '.cache',
])

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\/+/u, '')
}

async function indexWorkspaceFiles(
  listDirectory: (relativePath: string) => Promise<ApiResult<{ entries: readonly { relativePath: string; kind: 'file' | 'directory' }[]; truncated: boolean }>>,
): Promise<ApiResult<ComposerWorkspaceFileIndex>> {
  const files: string[] = []
  const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: '', depth: 0 }]
  let truncated = false
  let reads = 0
  while (queue.length > 0 && files.length < FILE_INDEX_LIMIT) {
    if (reads >= FILE_INDEX_MAX_DIRECTORY_READS) {
      truncated = true
      break
    }
    reads += 1
    const next = queue.shift()!
    const result = await listDirectory(next.relativePath)
    if (!result.ok) {
      // Surface a hard failure only when the workspace root itself is
      // unreadable; nested directories may legitimately disappear mid-scan.
      if (next.relativePath === '' && files.length === 0) return result
      continue
    }
    if (result.value.truncated) truncated = true
    for (const entry of result.value.entries) {
      const relativePath = normalizeRelativePath(entry.relativePath)
      if (!relativePath || /\s/u.test(relativePath)) continue
      const name = relativePath.split('/').at(-1) ?? relativePath
      if (entry.kind === 'directory') {
        if (FILE_INDEX_SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) continue
        if (next.depth + 1 >= FILE_INDEX_MAX_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ relativePath, depth: next.depth + 1 })
      } else {
        if (files.length >= FILE_INDEX_LIMIT) {
          truncated = true
          break
        }
        files.push(relativePath)
      }
    }
  }
  if (queue.length > 0) truncated = true
  return success({ files: files.sort((a, b) => a.localeCompare(b)), truncated })
}

const previewCommands: CapabilityCatalog['commands'] = [
  { id: 'plan', name: '计划模式', description: '先收集上下文并输出执行计划', aliases: ['p'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'goal', name: '目标', description: '设置或查看当前任务的持久目标', aliases: ['objective'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'compact', name: '压缩上下文', description: '总结当前对话并释放上下文空间', aliases: ['summarize'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'memories', name: '记忆', description: '控制记忆读取和生成', aliases: ['memory'], scope: 'builtin', permissions: ['read', 'write'], safe: false, availability: 'requires-approval' },
  { id: 'init', name: '初始化项目', description: '生成 AGENTS.md 项目规则草稿', aliases: ['setup'], scope: 'builtin', permissions: ['read', 'write', 'approval'], safe: false, availability: 'requires-approval' },
  { id: 'review', name: '代码审查', description: '审查当前 Git 改动并按严重度排序', aliases: ['audit'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  { id: 'status', name: '会话状态', description: '查看模型、目标、权限和上下文状态', aliases: ['info'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
]

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function unavailable<T>(message: string): ApiResult<T> {
  return {
    ok: false,
    error: { code: 'not_ready', message, retryable: true },
  }
}

class DesktopComposerCapabilitiesAdapter implements ComposerCapabilitiesAdapter {
  listCapabilities(input?: CapabilityListInput): Promise<ApiResult<CapabilityCatalog>> {
    return window.onekey.capabilities.list(input)
  }

  executeCapability(input: CapabilityExecuteInput): Promise<ApiResult<CapabilityExecuteResult>> {
    return window.onekey.capabilities.execute(input)
  }

  selectAttachments(): Promise<ApiResult<AttachmentSelection[]>> {
    return window.onekey.dialog.selectAttachments()
  }

  listWorkspaceFiles(workspaceToken: string): Promise<ApiResult<ComposerWorkspaceFileIndex>> {
    return indexWorkspaceFiles((relativePath) =>
      window.onekey.workspace.listDirectory({ workspaceToken, relativePath }))
  }
}

class PreviewComposerCapabilitiesAdapter implements ComposerCapabilitiesAdapter {
  #session: CapabilitySessionState = { planMode: false, memoriesEnabled: true }

  async listCapabilities(): Promise<ApiResult<CapabilityCatalog>> {
    return success({
      commands: previewCommands.map((entry) => ({ ...entry, aliases: [...entry.aliases], permissions: [...entry.permissions] })),
      skills: [],
      plugins: [],
      session: this.#cloneSession(),
    })
  }

  async executeCapability(input: CapabilityExecuteInput): Promise<ApiResult<CapabilityExecuteResult>> {
    const args = input.args?.trim()
    if (input.id === 'plan') {
      this.#session = { ...this.#session, planMode: args?.toLowerCase() !== 'off' }
      return success({ id: input.id, status: 'completed', message: this.#session.planMode ? '计划模式已开启。' : '计划模式已关闭。', session: this.#cloneSession() })
    }
    if (input.id === 'goal') {
      if (args) {
        this.#session = { ...this.#session, goal: { text: args, status: 'active' } }
      }
      return success({
        id: input.id,
        status: 'completed',
        message: args ? '目标已更新。' : this.#session.goal?.text || '当前还没有设置任务目标。',
        ...(this.#session.goal ? { goal: { ...this.#session.goal } } : {}),
        session: this.#cloneSession(),
      })
    }
    if (input.id === 'memories') {
      this.#session = { ...this.#session, memoriesEnabled: !this.#session.memoriesEnabled }
      return success({ id: input.id, status: 'completed', message: this.#session.memoriesEnabled ? '记忆已开启。' : '记忆已关闭。', session: this.#cloneSession() })
    }
    if (input.id === 'compact') {
      return success({ id: input.id, status: 'completed', message: '上下文压缩已请求。', session: this.#cloneSession() })
    }
    if (input.id === 'status') {
      return success({ id: input.id, status: 'completed', message: `模式：预览 · 目标：${this.#session.goal ? '已设置' : '未设置'}`, session: this.#cloneSession() })
    }
    if (input.id === 'review') {
      return success({ id: input.id, status: 'not-ready', message: '预览模式不会读取 Git 改动。', session: this.#cloneSession() })
    }
    if (input.id === 'init') {
      return success({ id: input.id, status: 'not-ready', message: '初始化会在桌面客户端确认后生成 AGENTS.md 草稿。', session: this.#cloneSession() })
    }
    return success({ id: input.id, status: 'not-ready', message: '此能力在预览模式不可用。', session: this.#cloneSession() })
  }

  async selectAttachments(): Promise<ApiResult<AttachmentSelection[]>> {
    return success([])
  }

  async listWorkspaceFiles(): Promise<ApiResult<ComposerWorkspaceFileIndex>> {
    return success({
      files: [
        'README.md',
        'docs/guide.md',
        'src/App.tsx',
        'src/components/Composer.tsx',
        'src/main.ts',
      ],
      truncated: false,
    })
  }

  #cloneSession(): CapabilitySessionState {
    return {
      planMode: this.#session.planMode,
      memoriesEnabled: this.#session.memoriesEnabled,
      ...(this.#session.goal ? { goal: { ...this.#session.goal } } : {}),
    }
  }
}

class DisconnectedComposerCapabilitiesAdapter implements ComposerCapabilitiesAdapter {
  async listCapabilities(): Promise<ApiResult<CapabilityCatalog>> {
    return unavailable('请使用桌面客户端加载能力目录。')
  }

  async executeCapability(): Promise<ApiResult<CapabilityExecuteResult>> {
    return unavailable('请使用桌面客户端执行能力。')
  }

  async selectAttachments(): Promise<ApiResult<AttachmentSelection[]>> {
    return unavailable('请使用桌面客户端选择附件。')
  }

  async listWorkspaceFiles(): Promise<ApiResult<ComposerWorkspaceFileIndex>> {
    return unavailable('请使用桌面客户端浏览工作区文件。')
  }
}

export function createComposerCapabilitiesAdapter(runtime: ComposerRuntime): ComposerCapabilitiesAdapter {
  if (runtime === 'desktop') return new DesktopComposerCapabilitiesAdapter()
  if (runtime === 'preview') return new PreviewComposerCapabilitiesAdapter()
  return new DisconnectedComposerCapabilitiesAdapter()
}
