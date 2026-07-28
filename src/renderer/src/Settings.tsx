import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Cloud,
  GitBranch,
  GitFork,
  Globe2,
  Keyboard,
  Link2,
  LoaderCircle,
  Mic,
  Monitor,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Sun,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  ApprovalSessionScopeDto,
  PluginDescriptor,
  WorkspaceOpenerDescriptor,
  WorkspaceOpenerId,
} from '../../shared/contracts'

import './settings.css'

export type SettingsPermission = 'ask' | 'auto' | 'full'

export type SettingsView =
  | 'general'
  | 'appearance'
  | 'voice'
  | 'configuration'
  | 'personalization'
  | 'shortcuts'
  | 'account'
  | 'plugins'
  | 'browser'
  | 'computer'
  | 'hooks'
  | 'connections'
  | 'git'
  | 'environment'
  | 'worktrees'
  | 'archived'

export type SettingsPreferences = {
  defaultOpener: WorkspaceOpenerId | 'none'
  agentEnvironment: 'windows' | 'wsl'
  shell: 'powershell' | 'cmd'
  density: 'compact' | 'comfortable'
  reduceMotion: boolean
  showBottomPanel: boolean
  suggestions: boolean
  customInstructions: string
  responseLanguage: 'zh-CN' | 'auto'
  gitBase: 'current' | 'main'
  worktreeMode: 'ask' | 'always' | 'never'
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferences = {
  defaultOpener: 'vscode',
  agentEnvironment: 'windows',
  shell: 'powershell',
  density: 'comfortable',
  reduceMotion: false,
  showBottomPanel: true,
  suggestions: true,
  customInstructions: '',
  responseLanguage: 'zh-CN',
  gitBase: 'current',
  worktreeMode: 'ask',
}

const SETTINGS_STORAGE_KEY = 'ai-terminal:settings-preferences:v1'

const preferenceValues = {
  defaultOpener: new Set<SettingsPreferences['defaultOpener']>(['none', 'vscode', 'visual-studio', 'cursor', 'github-desktop', 'explorer', 'terminal', 'wsl', 'pycharm']),
  agentEnvironment: new Set<SettingsPreferences['agentEnvironment']>(['windows', 'wsl']),
  shell: new Set<SettingsPreferences['shell']>(['powershell', 'cmd']),
  density: new Set<SettingsPreferences['density']>(['compact', 'comfortable']),
  responseLanguage: new Set<SettingsPreferences['responseLanguage']>(['zh-CN', 'auto']),
  gitBase: new Set<SettingsPreferences['gitBase']>(['current', 'main']),
  worktreeMode: new Set<SettingsPreferences['worktreeMode']>(['ask', 'always', 'never']),
} as const

export function readSettingsPreferences(): SettingsPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as Partial<SettingsPreferences>
    return {
      defaultOpener: preferenceValues.defaultOpener.has(parsed.defaultOpener as SettingsPreferences['defaultOpener']) ? parsed.defaultOpener! : DEFAULT_SETTINGS_PREFERENCES.defaultOpener,
      agentEnvironment: preferenceValues.agentEnvironment.has(parsed.agentEnvironment as SettingsPreferences['agentEnvironment']) ? parsed.agentEnvironment! : DEFAULT_SETTINGS_PREFERENCES.agentEnvironment,
      shell: preferenceValues.shell.has(parsed.shell as SettingsPreferences['shell']) ? parsed.shell! : DEFAULT_SETTINGS_PREFERENCES.shell,
      density: preferenceValues.density.has(parsed.density as SettingsPreferences['density']) ? parsed.density! : DEFAULT_SETTINGS_PREFERENCES.density,
      reduceMotion: typeof parsed.reduceMotion === 'boolean' ? parsed.reduceMotion : DEFAULT_SETTINGS_PREFERENCES.reduceMotion,
      showBottomPanel: typeof parsed.showBottomPanel === 'boolean' ? parsed.showBottomPanel : DEFAULT_SETTINGS_PREFERENCES.showBottomPanel,
      suggestions: typeof parsed.suggestions === 'boolean' ? parsed.suggestions : DEFAULT_SETTINGS_PREFERENCES.suggestions,
      customInstructions: typeof parsed.customInstructions === 'string' ? parsed.customInstructions.slice(0, 16_000) : DEFAULT_SETTINGS_PREFERENCES.customInstructions,
      responseLanguage: preferenceValues.responseLanguage.has(parsed.responseLanguage as SettingsPreferences['responseLanguage']) ? parsed.responseLanguage! : DEFAULT_SETTINGS_PREFERENCES.responseLanguage,
      gitBase: preferenceValues.gitBase.has(parsed.gitBase as SettingsPreferences['gitBase']) ? parsed.gitBase! : DEFAULT_SETTINGS_PREFERENCES.gitBase,
      worktreeMode: preferenceValues.worktreeMode.has(parsed.worktreeMode as SettingsPreferences['worktreeMode']) ? parsed.worktreeMode! : DEFAULT_SETTINGS_PREFERENCES.worktreeMode,
    }
  } catch {
    return DEFAULT_SETTINGS_PREFERENCES
  }
}

export function writeSettingsPreferences(preferences: SettingsPreferences): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // A storage failure must not make the settings surface unusable.
  }
}

const knownWorkspaceOpeners: WorkspaceOpenerDescriptor[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor' },
  { id: 'visual-studio', label: 'Visual Studio', kind: 'editor' },
  { id: 'cursor', label: 'Cursor', kind: 'editor' },
  { id: 'github-desktop', label: 'GitHub Desktop', kind: 'git' },
  { id: 'explorer', label: '文件资源管理器', kind: 'file-manager' },
  { id: 'terminal', label: 'Windows Terminal', kind: 'terminal' },
  { id: 'wsl', label: 'WSL', kind: 'terminal' },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor' },
]

export type SettingsProps = {
  onBack: () => void
  onOpenUserCenter: () => void
  activeView: SettingsView
  onActiveViewChange: (view: SettingsView) => void
  permission: SettingsPermission
  onPermissionChange: (permission: SettingsPermission) => void
  webSearch: boolean
  onWebSearchChange: (enabled: boolean) => void
  webSearchAvailable: boolean
  imageGeneration: boolean
  onImageGenerationChange: (enabled: boolean) => void
  imageGenerationAvailable: boolean
  imageGenerationLocked: boolean
  modelCompatibilityNotice: string
  preferences: SettingsPreferences
  onPreferencesChange: (patch: Partial<SettingsPreferences>) => void
  workspaceOpeners: readonly WorkspaceOpenerDescriptor[]
  workspaceOpenersDetected: boolean
  displayName: string
  endpoint: string
  profileHasKey: boolean
  modelCount: number
  modelCatalogState: 'preview' | 'idle' | 'loading' | 'remote' | 'error'
  modelCatalogMessage: string
  onRefreshModels: () => Promise<{ ok: boolean; message: string }>
  workspaceToken: string
}

type NavigationItem = {
  id: SettingsView
  label: string
  icon: LucideIcon
  keywords: string
}

const navigationGroups: Array<{ id: string; label: string; items: NavigationItem[] }> = [
  {
    id: 'personal',
    label: '个人',
    items: [
      { id: 'general', label: '常规', icon: Settings2, keywords: '权限 审批 文件 终端 语言' },
      { id: 'appearance', label: '外观', icon: Sun, keywords: '主题 密度 动画 面板' },
      { id: 'voice', label: '语音', icon: Mic, keywords: '麦克风 输入 听写' },
      { id: 'configuration', label: '配置', icon: SlidersHorizontal, keywords: '模型 渠道 API key' },
      { id: 'personalization', label: '个性化', icon: Sparkles, keywords: '自定义 指令 回复 语言' },
      { id: 'shortcuts', label: '键盘快捷键', icon: Keyboard, keywords: '快捷键 命令 键盘' },
      { id: 'account', label: '账户', icon: CircleUserRound, keywords: '用户 中转站 余额 令牌' },
    ],
  },
  {
    id: 'integrations',
    label: '集成',
    items: [
      { id: 'plugins', label: '插件', icon: Plug, keywords: 'MCP 扩展 skill' },
      { id: 'browser', label: '浏览器', icon: Globe2, keywords: '联网 搜索 web browser' },
      { id: 'computer', label: '电脑操控', icon: Monitor, keywords: '桌面 控制 屏幕 自动化' },
    ],
  },
  {
    id: 'coding',
    label: '编码',
    items: [
      { id: 'hooks', label: '钩子', icon: Webhook, keywords: 'hook 生命周期 脚本' },
      { id: 'connections', label: '连接', icon: Link2, keywords: 'endpoint server 中转站' },
      { id: 'git', label: 'Git', icon: GitBranch, keywords: '分支 diff 提交' },
      { id: 'environment', label: '环境', icon: SquareTerminal, keywords: 'shell PowerShell Windows WSL' },
      { id: 'worktrees', label: '工作树', icon: GitFork, keywords: 'worktree 分支 隔离' },
    ],
  },
  {
    id: 'archive',
    label: '已归档',
    items: [
      { id: 'archived', label: '已归档任务', icon: Archive, keywords: '历史 任务 恢复' },
    ],
  },
]

type Notice = { tone: 'neutral' | 'success' | 'warning'; text: string }

function SettingsSwitch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={`settings-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

function SettingsSelect({
  label,
  value,
  disabled = false,
  className = '',
  title,
  children,
  onChange,
}: {
  label: string
  value: string
  disabled?: boolean
  className?: string
  title?: string
  children: ReactNode
  onChange: (value: string) => void
}) {
  return (
    <label className={`settings-select${className ? ` ${className}` : ''}`} title={title}>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </label>
  )
}

function SettingsRow({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: ReactNode
}) {
  return (
    <div className="settings-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}

function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-group-card">{children}</div>
    </section>
  )
}

function StatusPill({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning'; children: ReactNode }) {
  return <span className={`settings-status ${tone}`}>{children}</span>
}

function ActionButton({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="settings-action" disabled={disabled} onClick={onClick}>{children}</button>
}

function PageTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="settings-page-title">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  )
}

const sessionScopeOperationLabels: Record<ApprovalSessionScopeDto['operation'], string> = {
  read: '读取文件',
  enumerate: '列举目录',
  search: '搜索内容',
  write: '写入文件',
  open: '打开路径',
  execute: '执行命令',
}

const sessionScopeRiskLabels: Record<ApprovalSessionScopeDto['risk'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
}

/** Grants issued via "本次会话总是允许" in the approval dialog, with revocation. */
function SessionScopeList() {
  const [scopes, setScopes] = useState<ApprovalSessionScopeDto[]>([])
  const [revoking, setRevoking] = useState('')

  const refresh = async (): Promise<void> => {
    if (!('onekey' in window)) return
    try {
      const result = await window.onekey.approval.listSessionScopes()
      setScopes(result.ok ? result.value : [])
    } catch {
      setScopes([])
    }
  }
  useEffect(() => { void refresh() }, [])

  const revoke = async (id: string): Promise<void> => {
    if (!('onekey' in window)) return
    setRevoking(id)
    try {
      await window.onekey.approval.revokeSessionScope({ id })
      await refresh()
    } finally {
      setRevoking('')
    }
  }

  return (
    <div className="session-scope-list">
      <div className="session-scope-heading">
        <strong>已授权的工具</strong>
        <small>通过批准弹窗的“总是允许”授予；按工作区持久保存，可随时在此撤销。</small>
      </div>
      {scopes.length === 0 ? (
        <p className="session-scope-empty">尚未授予“总是允许”的工具授权。</p>
      ) : (
        scopes.map((scope) => (
          <div className="session-scope-row" key={scope.id}>
            <span className="session-scope-name">
              <code>{scope.toolName}</code>
              <small>{sessionScopeOperationLabels[scope.operation]} · {sessionScopeRiskLabels[scope.risk]}</small>
            </span>
            <ActionButton disabled={revoking === scope.id} onClick={() => { void revoke(scope.id) }}>
              {revoking === scope.id ? '正在撤销…' : '撤销'}
            </ActionButton>
          </div>
        ))
      )}
    </div>
  )
}

function PluginCatalogList({ workspaceToken }: { workspaceToken: string }) {
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [notice, setNotice] = useState('')

  const loadKnown = async (): Promise<void> => {
    if (!('onekey' in window)) return
    try {
      const result = await window.onekey.capabilities.list()
      if (result.ok) setPlugins(result.value.plugins)
    } catch {
      // The known catalog is best-effort; discovery below reports real errors.
    }
  }
  useEffect(() => { void loadKnown() }, [workspaceToken])

  const discover = async (): Promise<void> => {
    if (!('onekey' in window)) return
    setDiscovering(true)
    setNotice('')
    try {
      const result = await window.onekey.capabilities.list({
        category: 'plugins',
        ...(workspaceToken ? { workspaceToken } : {}),
      })
      if (result.ok) {
        setPlugins(result.value.plugins)
        setNotice(result.value.plugins.length === 0 ? '未在插件目录中找到插件清单。' : '')
      } else {
        setNotice(result.error.message)
      }
    } catch {
      setNotice('插件目录读取失败，请重试。')
    } finally {
      setDiscovering(false)
    }
  }

  const enable = async (plugin: PluginDescriptor): Promise<void> => {
    if (!('onekey' in window)) return
    setBusyId(plugin.id)
    setNotice('')
    try {
      const result = await window.onekey.capabilities.execute({
        id: plugin.id,
        grantHandle: plugin.grantHandle,
        ...(plugin.scope === 'workspace' && workspaceToken ? { workspaceToken } : {}),
      })
      setNotice(result.ok ? result.value.message : result.error.message)
      await discover()
    } finally {
      setBusyId('')
    }
  }

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length
  return (
    <>
      <SettingsSection title="插件状态" description="插件来自本机与工作区的插件目录；启用前会逐个原生确认，MCP 工具调用仍按当前批准模式逐次授权。">
        <SettingsRow
          title="已启用插件"
          description={`发现 ${plugins.length} 个插件清单`}
          control={<StatusPill tone={enabledCount > 0 ? 'success' : undefined}>{enabledCount}</StatusPill>}
        />
        <SettingsRow
          title="发现插件"
          description="读取 ~/.codex-plugin、~/.codex/plugins、~/.agents/plugins 与当前工作区的插件清单"
          control={(
            <ActionButton disabled={discovering} onClick={() => { void discover() }}>
              {discovering ? '正在发现…' : '发现插件'}
            </ActionButton>
          )}
        />
        {notice ? <p className="session-scope-empty">{notice}</p> : null}
      </SettingsSection>
      {plugins.length > 0 ? (
        <SettingsSection title="插件列表">
          {plugins.map((plugin) => (
            <SettingsRow
              key={plugin.id}
              title={`${plugin.name} · v${plugin.version}`}
              description={`${plugin.description || '无描述'} · 权限：${plugin.permissions.join('、') || '只读'} · ${plugin.scope === 'workspace' ? '当前工作区' : '当前用户'}`}
              control={plugin.enabled
                ? <StatusPill tone="success">已启用</StatusPill>
                : (
                    <ActionButton disabled={busyId === plugin.id} onClick={() => { void enable(plugin) }}>
                      {busyId === plugin.id ? '正在启用…' : '启用'}
                    </ActionButton>
                  )}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  )
}

const permissionOptions: Array<{ id: SettingsPermission; title: string; description: string; note: string }> = [
  {
    id: 'ask',
    title: '每次询问',
    description: '每次在工作区内读取、写入或运行命令前都请求批准。',
    note: '最谨慎',
  },
  {
    id: 'auto',
    title: '自动',
    description: '工作区内的低风险读取直接执行；写入和命令仍会请求一次批准。',
    note: '推荐',
  },
  {
    id: 'full',
    title: '系统完全访问',
    description: '系统文件读写和系统命令直接执行；当前工作区仅作为默认目录。',
    note: '本次会话',
  },
]

export default function SettingsPage({
  onBack,
  onOpenUserCenter,
  activeView,
  onActiveViewChange,
  permission,
  onPermissionChange,
  webSearch,
  onWebSearchChange,
  webSearchAvailable,
  imageGeneration,
  onImageGenerationChange,
  imageGenerationAvailable,
  imageGenerationLocked,
  modelCompatibilityNotice,
  preferences,
  onPreferencesChange,
  workspaceOpeners,
  workspaceOpenersDetected,
  displayName,
  endpoint,
  profileHasKey,
  modelCount,
  modelCatalogState,
  modelCatalogMessage,
  onRefreshModels,
  workspaceToken,
}: SettingsProps) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  const defaultOpenerOptions = useMemo(() => {
    if (!workspaceOpenersDetected) return []
    if (preferences.defaultOpener === 'none' || workspaceOpeners.some((entry) => entry.id === preferences.defaultOpener)) {
      return [...workspaceOpeners]
    }
    const selected = knownWorkspaceOpeners.find((entry) => entry.id === preferences.defaultOpener)
    return selected ? [...workspaceOpeners, { ...selected, label: `${selected.label}（当前不可用）` }] : [...workspaceOpeners]
  }, [preferences.defaultOpener, workspaceOpeners, workspaceOpenersDetected])

  const pendingDefaultOpener = !workspaceOpenersDetected && preferences.defaultOpener !== 'none'
    ? knownWorkspaceOpeners.find((entry) => entry.id === preferences.defaultOpener) ?? null
    : null
  const selectedDefaultOpenerLabel = pendingDefaultOpener
    ? `${pendingDefaultOpener.label}（尚未检测）`
    : preferences.defaultOpener === 'none'
      ? '每次显示菜单'
      : defaultOpenerOptions.find((entry) => entry.id === preferences.defaultOpener)?.label

  const accountConnection = modelCatalogState === 'remote' && profileHasKey
    ? { description: '账户已连接', label: '已连接', tone: 'success' as const }
    : modelCatalogState === 'loading' && profileHasKey
      ? { description: '正在读取可用模型', label: '连接中', tone: 'neutral' as const }
      : modelCatalogState === 'error' && profileHasKey
        ? { description: '暂时无法读取可用模型', label: '需重试', tone: 'warning' as const }
        : profileHasKey
          ? { description: '正在准备可用模型', label: '待就绪', tone: 'neutral' as const }
          : modelCatalogState === 'preview'
            ? { description: '请从桌面客户端连接账户', label: '需客户端', tone: 'warning' as const }
            : { description: '尚未登录账户', label: '未登录', tone: 'warning' as const }
  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return navigationGroups
    return navigationGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(normalized)),
      }))
      .filter((group) => group.items.length > 0)
  }, [query])

  useEffect(() => {
    const visibleItems = filteredGroups.flatMap((group) => group.items)
    const firstVisible = visibleItems[0]
    if (firstVisible && !visibleItems.some((item) => item.id === activeView)) onActiveViewChange(firstVisible.id)
  }, [activeView, filteredGroups, onActiveViewChange])

  useEffect(() => {
    if (!confirmFullAccess) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmFullAccess(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [confirmFullAccess])

  const selectPermission = (next: SettingsPermission) => {
    if (next === 'full' && permission !== 'full') {
      setConfirmFullAccess(true)
      return
    }
    onPermissionChange(next)
    setNotice({ tone: next === 'ask' ? 'success' : 'warning', text: `默认批准模式已切换为“${permissionOptions.find((option) => option.id === next)?.title}”。` })
  }

  const persistedNotice = (label: string) => {
    setNotice({ tone: 'success', text: `${label}已保存，下次打开应用时继续使用。` })
  }

  const refreshModels = async () => {
    try {
      const result = await onRefreshModels()
      setNotice({ tone: result.ok ? 'success' : 'warning', text: result.message })
    } catch {
      setNotice({ tone: 'warning', text: '暂时无法读取可用模型，请重试。' })
    }
  }

  const generalPage = (
    <>
      <PageTitle title="常规" />
      <section className="settings-section permission-section">
        <div className="settings-section-heading"><h2>权限</h2></div>
        <div className="permission-choice-list" role="radiogroup" aria-label="默认批准模式">
          {permissionOptions.map((option) => (
            <button
              type="button"
              role="radio"
              aria-checked={permission === option.id}
              className={`permission-choice ${permission === option.id ? 'selected' : ''}`}
              key={option.id}
              onClick={() => selectPermission(option.id)}
            >
              <span><strong>{option.title}</strong><small>{option.description}</small></span>
              <span className="permission-choice-meta"><em>{option.note}</em><i>{permission === option.id && <Check size={14} />}</i></span>
            </button>
          ))}
        </div>
        <SessionScopeList />
      </section>

      <SettingsSection title="常规" description="用于下一次工作区操作的会话默认值">
        <SettingsRow title="默认文件打开目标" description={workspaceOpenersDetected ? '仅列出这台电脑当前可用的打开方式' : '尚未检测本机应用；展开工作区的打开位置菜单后同步'} control={
          <SettingsSelect className="workspace-opener-select" label="默认文件打开目标" title={selectedDefaultOpenerLabel} value={preferences.defaultOpener} onChange={(value) => { onPreferencesChange({ defaultOpener: value as SettingsPreferences['defaultOpener'] }); persistedNotice('文件打开目标') }}>
            <option value="none">每次显示菜单</option>
            {pendingDefaultOpener && (
              <option value={pendingDefaultOpener.id} disabled>{pendingDefaultOpener.label}（尚未检测）</option>
            )}
            {defaultOpenerOptions.map((opener) => (
              <option
                key={opener.id}
                value={opener.id}
                disabled={workspaceOpenersDetected && !workspaceOpeners.some((entry) => entry.id === opener.id)}
              >
                {opener.label}
              </option>
            ))}
          </SettingsSelect>
        } />
        <SettingsRow title="智能体环境" description="当前文件和命令操作在 Windows 中运行；访问范围由操作权限决定" control={
          <SettingsSelect label="智能体环境" value={preferences.agentEnvironment} onChange={(value) => { onPreferencesChange({ agentEnvironment: value as SettingsPreferences['agentEnvironment'] }); persistedNotice('智能体环境') }}>
            <option value="windows">Windows 原生</option><option value="wsl">WSL（暂不可用）</option>
          </SettingsSelect>
        } />
        <SettingsRow title="Agent 命令环境" description="可调用 Windows 原生命令，并可在系统完全访问时使用显式 PowerShell 或 Command Prompt" control={<StatusPill tone="success">可用</StatusPill>} />
        <SettingsRow title="界面语言" description="英文资源尚未完成，当前固定为简体中文" control={
          <SettingsSelect label="界面语言" value="zh-CN" disabled onChange={() => undefined}><option value="zh-CN">简体中文</option></SettingsSelect>
        } />
        <SettingsRow title="底部面板" description="保留终端、Diff 和文件面板的当前打开状态" control={
          <SettingsSwitch label="底部面板" checked={preferences.showBottomPanel} onChange={(checked) => onPreferencesChange({ showBottomPanel: checked })} />
        } />
        <SettingsRow title="建议提示" description="在空任务和待处理结果中显示下一步建议" control={
          <SettingsSwitch label="建议提示" checked={preferences.suggestions} onChange={(checked) => onPreferencesChange({ suggestions: checked })} />
        } />
      </SettingsSection>

      <SettingsSection title="应用" description="导入、许可与更新状态">
        <SettingsRow title="导入智能体设置" description="导入功能暂不可用，当前没有读取本地设置" control={<ActionButton onClick={() => setNotice({ tone: 'neutral', text: '设置导入暂不可用。' })}>导入设置</ActionButton>} />
        <SettingsRow title="开源许可证" description="查看本应用使用的开源软件许可" control={<ActionButton onClick={() => setNotice({ tone: 'neutral', text: '许可清单正在整理，当前暂不可查看。' })}>查看</ActionButton>} />
        <SettingsRow title="应用更新" description="自动更新暂不可用，应用不会在后台检查更新" control={<ActionButton onClick={() => setNotice({ tone: 'neutral', text: '自动更新暂不可用，未发起网络请求。' })}><RefreshCw size={14} />检查更新</ActionButton>} />
      </SettingsSection>
    </>
  )

  const appearancePage = (
    <>
      <PageTitle title="外观" description="调整当前应用会话的视觉密度和动效。" />
      <SettingsSection title="界面">
        <SettingsRow title="主题" description="当前采用 AI终点站玻璃深色工作台" control={<SettingsSelect label="主题" value="glass-dark" disabled onChange={() => undefined}><option value="glass-dark">玻璃深色</option></SettingsSelect>} />
        <SettingsRow title="界面密度" description="控制设置列表和工具面的行高" control={<SettingsSelect label="界面密度" value={preferences.density} onChange={(value) => onPreferencesChange({ density: value as SettingsPreferences['density'] })}><option value="compact">紧凑</option><option value="comfortable">舒适</option></SettingsSelect>} />
        <SettingsRow title="减少动画" description="停用非必要的过渡和旋转动画" control={<SettingsSwitch label="减少动画" checked={preferences.reduceMotion} onChange={(checked) => onPreferencesChange({ reduceMotion: checked })} />} />
        <SettingsRow title="品牌强调色" description="工作区使用赤陶红，连接和成功状态使用绿色" control={<div className="settings-swatches" aria-label="品牌强调色"><span className="brand" /><span className="success" /><span className="focus" /></div>} />
      </SettingsSection>
    </>
  )

  const voicePage = (
    <>
      <PageTitle title="语音" description="语音输入功能当前不可用。" />
      <SettingsSection title="语音输入">
        <SettingsRow title="启用语音输入" description="暂不可用，应用当前不会访问麦克风" control={<SettingsSwitch label="启用语音输入" checked={false} disabled onChange={() => undefined} />} />
        <SettingsRow title="输入设备" description="语音输入启用后可选择设备" control={<SettingsSelect label="输入设备" value="none" disabled onChange={() => undefined}><option value="none">未配置</option></SettingsSelect>} />
        <SettingsRow title="转写位置" description="转写功能暂不可用，当前不会上传音频" control={<StatusPill tone="warning">尚未开放</StatusPill>} />
      </SettingsSection>
    </>
  )

  const configurationPage = (
    <>
      <PageTitle title="配置" description="查看账户分组、可用模型和连接状态。" />
      <SettingsSection title="模型与渠道">
        <SettingsRow title="当前渠道" description={`${displayName} · ${endpoint}`} control={<ActionButton onClick={onOpenUserCenter}>打开用户中心<ChevronRight size={14} /></ActionButton>} />
        <SettingsRow title="可用模型" description={modelCatalogMessage} control={<div className="settings-inline-actions"><StatusPill tone={modelCatalogState === 'remote' ? 'success' : modelCatalogState === 'error' ? 'warning' : 'neutral'}>{modelCount} 个</StatusPill><ActionButton disabled={modelCatalogState === 'loading' || !profileHasKey} onClick={() => void refreshModels()}>{modelCatalogState === 'loading' ? <LoaderCircle className="settings-spin" size={14} /> : <RefreshCw size={14} />}刷新</ActionButton></div>} />
        <SettingsRow
          title="图片生成"
          description={imageGenerationLocked
            ? '当前模型已固定启用图片生成；参考图或图片编辑请在 Studio 中使用。'
            : imageGenerationAvailable
              ? '作为新任务的默认能力开关'
            : modelCompatibilityNotice || '当前模型未声明图片生成能力，请切换到支持该能力的模型。'}
          control={<SettingsSwitch label="图片生成" checked={imageGeneration} disabled={imageGenerationLocked || !imageGenerationAvailable} onChange={onImageGenerationChange} />}
        />
        <SettingsRow title="账户授权" description="登录信息只在连接模型时使用，不会显示在应用界面中" control={<StatusPill tone={profileHasKey ? 'success' : 'warning'}>{profileHasKey ? '账户可用' : '账户未就绪'}</StatusPill>} />
      </SettingsSection>
      <SettingsSection title="安全连接" description="模型和分组由当前登录账户提供。">
        <SettingsRow title="账户连接" description={`${endpoint} · 按所选分组和模型连接`} control={<StatusPill tone={accountConnection.tone}>{accountConnection.label}</StatusPill>} />
      </SettingsSection>
    </>
  )

  const personalizationPage = (
    <>
      <PageTitle title="个性化" description="自定义内容保存在本机；自定义指令与回答语言会随新回合发送给所选模型。" />
      <SettingsSection title="回答偏好">
        <div className="settings-textarea-row">
          <label htmlFor="custom-instructions"><strong>自定义指令</strong><span>会作为用户偏好附加到后续新回合的请求中</span></label>
          <textarea id="custom-instructions" value={preferences.customInstructions} maxLength={2000} placeholder="例如：默认使用中文回答，修改代码前先说明影响范围" onChange={(event) => onPreferencesChange({ customInstructions: event.target.value })} />
          <div><small>{preferences.customInstructions.length} / 2000</small><ActionButton onClick={() => { persistedNotice('自定义指令'); }}>保存</ActionButton></div>
        </div>
        <SettingsRow title="回答语言" description="新对话的默认回答语言偏好" control={<SettingsSelect label="回答语言" value={preferences.responseLanguage} onChange={(value) => onPreferencesChange({ responseLanguage: value as SettingsPreferences['responseLanguage'] })}><option value="zh-CN">简体中文</option><option value="auto">自动检测</option></SettingsSelect>} />
      </SettingsSection>
    </>
  )

  const shortcutsPage = (
    <>
      <PageTitle title="键盘快捷键" description="应用当前注册的全部快捷键。" />
      <SettingsSection title="任务与导航">
        <SettingsRow title="新建当前模式任务" description="以当前 Chat/Agent 模式新建任务" control={<kbd>Ctrl N</kbd>} />
        <SettingsRow title="新建另一模式任务" description="以另一种模式（Chat↔Agent）新建任务" control={<kbd>Ctrl Shift N</kbd>} />
        <SettingsRow title="打开工作区" description="选择本地工作区目录" control={<kbd>Ctrl O</kbd>} />
        <SettingsRow title="命令面板" description="打开全局命令面板" control={<kbd>Ctrl K</kbd>} />
        <SettingsRow title="返回工作区" description="从设置、Studio 或用户中心返回工作区" control={<kbd>Alt ←</kbd>} />
        <SettingsRow title="打开设置" description="打开设置页面" control={<kbd>Ctrl ,</kbd>} />
        <SettingsRow title="快捷键帮助" description="打开本页面" control={<kbd>Ctrl Shift /</kbd>} />
        <SettingsRow title="退出应用" description="退出 AI终点站" control={<kbd>Ctrl Q</kbd>} />
      </SettingsSection>
      <SettingsSection title="面板与布局">
        <SettingsRow title="切换任务面板" description="显示或隐藏左侧任务列表" control={<kbd>Ctrl B</kbd>} />
        <SettingsRow title="切换环境卡片" description="显示或隐藏右侧环境栏" control={<kbd>Alt Ctrl B</kbd>} />
        <SettingsRow title="打开终端" description="打开底部终端面板" control={<kbd>Ctrl `</kbd>} />
        <SettingsRow title="打开文件面板" description="打开底部文件浏览面板" control={<kbd>Ctrl Shift E</kbd>} />
        <SettingsRow title="关闭底部面板" description="底部面板打开时收起" control={<kbd>Ctrl J</kbd>} />
        <SettingsRow title="专注模式" description="进入或退出专注模式布局" control={<kbd>Ctrl Shift F</kbd>} />
      </SettingsSection>
      <SettingsSection title="输入区">
        <SettingsRow title="发送消息" description="在输入框中提交当前消息；回合运行中会加入排队" control={<kbd>Enter</kbd>} />
        <SettingsRow title="消息换行" description="在不发送的情况下插入新行" control={<kbd>Shift Enter</kbd>} />
        <SettingsRow title="召回输入历史" description="草稿为空时按上下键翻阅最近发送的消息" control={<kbd>↑ / ↓</kbd>} />
        <SettingsRow title="能力面板导航" description="/ $ @ 触发的面板中移动与确认" control={<kbd>↑ ↓ Enter</kbd>} />
        <SettingsRow title="关闭菜单或抽屉" description="关闭当前弹出菜单、任务抽屉或环境抽屉" control={<kbd>Esc</kbd>} />
        <SettingsRow title="执行终端输入" description="终端可用时，在底部终端中提交当前命令" control={<kbd>Enter</kbd>} />
      </SettingsSection>
    </>
  )

  const accountPage = (
    <>
      <PageTitle title="账户" description="账户与中转站功能在用户中心统一管理。" />
      <SettingsSection title="当前账户">
        <SettingsRow title={displayName} description={accountConnection.description} control={<StatusPill tone={accountConnection.tone}>{accountConnection.label}</StatusPill>} />
        <SettingsRow title="账户、用量与令牌" description="查看中转站余额、模型价格、访问令牌和兑换" control={<ActionButton onClick={onOpenUserCenter}>进入用户中心<ChevronRight size={14} /></ActionButton>} />
      </SettingsSection>
    </>
  )

  const pluginsPage = (
    <>
      <PageTitle title="插件" description="发现并启用本机与工作区的插件；启用会经过原生确认，插件的 MCP 工具调用仍逐次经过批准。" />
      <PluginCatalogList workspaceToken={workspaceToken} />
    </>
  )

  const browserPage = (
    <>
      <PageTitle title="浏览器" description="设置新任务是否默认启用联网搜索。" />
      <SettingsSection title="联网能力">
        <SettingsRow
          title="新任务启用 Web 搜索"
          description={webSearchAvailable
            ? '仅作为新任务默认值；是否可用仍由所选模型决定'
            : modelCompatibilityNotice || '当前模型未声明联网搜索能力，请切换到支持该能力的模型。'}
          control={<SettingsSwitch label="新任务启用 Web 搜索" checked={webSearch} disabled={!webSearchAvailable} onChange={onWebSearchChange} />}
        />
        <SettingsRow title="应用直接联网" description="应用界面不会绕过账户连接访问外部服务" control={<StatusPill tone="success">不允许</StatusPill>} />
        <SettingsRow title="外部链接" description="只允许无凭据的 HTTPS，并由系统浏览器确认打开" control={<StatusPill>逐次确认</StatusPill>} />
      </SettingsSection>
    </>
  )

  const computerPage = (
    <>
      <PageTitle title="电脑操控" description="桌面控制属于高风险能力，默认关闭。" />
      <SettingsSection title="本地控制">
        <SettingsRow title="允许电脑操控" description="功能尚未开放，当前不会控制你的电脑" control={<SettingsSwitch label="允许电脑操控" checked={false} disabled onChange={() => undefined} />} />
        <SettingsRow title="屏幕读取" description="当前没有请求或持有屏幕捕获权限" control={<StatusPill tone="success">未授权</StatusPill>} />
      </SettingsSection>
    </>
  )

  const hooksPage = (
    <>
      <PageTitle title="钩子" description="在任务生命周期中运行受限脚本。" />
      <SettingsSection title="任务钩子">
        <SettingsRow title="启动前钩子" description="启动前脚本暂不可用，不会运行本地命令" control={<StatusPill tone="warning">尚未开放</StatusPill>} />
        <SettingsRow title="完成后钩子" description="默认关闭，不会执行本地命令" control={<SettingsSwitch label="完成后钩子" checked={false} disabled onChange={() => undefined} />} />
      </SettingsSection>
    </>
  )

  const connectionsPage = (
    <>
      <PageTitle title="连接" description="管理账户连接；远程地址必须是 HTTPS，并在每次应用会话中确认。" />
      <SettingsSection title="中转站">
        <SettingsRow title={displayName} description={endpoint} control={<StatusPill tone={accountConnection.tone}>{accountConnection.label}</StatusPill>} />
        <SettingsRow title="连接与账户详情" description="在用户中心查看当前安全摘要" control={<ActionButton onClick={onOpenUserCenter}>查看详情<ChevronRight size={14} /></ActionButton>} />
      </SettingsSection>
    </>
  )

  const gitPage = (
    <>
      <PageTitle title="Git" description="配置 Diff 与分支建议；不会自动提交或推送。" />
      <SettingsSection title="版本控制">
        <SettingsRow title="比较基准" description="Diff 面板的默认比较分支" control={<SettingsSelect label="Git 比较基准" value={preferences.gitBase} onChange={(value) => onPreferencesChange({ gitBase: value as SettingsPreferences['gitBase'] })}><option value="current">当前分支</option><option value="main">main</option></SettingsSelect>} />
        <SettingsRow title="提交建议" description="分析完成后显示可选的提交建议，不会自动提交" control={<SettingsSwitch label="提交建议" checked={preferences.suggestions} onChange={(checked) => onPreferencesChange({ suggestions: checked })} />} />
        <SettingsRow title="Git 写操作" description="提交、切换分支和推送仍需明确批准" control={<StatusPill>逐次确认</StatusPill>} />
      </SettingsSection>
    </>
  )

  const environmentPage = (
    <>
      <PageTitle title="环境" description="查看 Agent 使用的本地环境和可用功能。" />
      <SettingsSection title="运行环境">
        <SettingsRow title="智能体环境" description="当前 Windows 设备上的运行位置" control={<SettingsSelect label="环境页智能体环境" value={preferences.agentEnvironment} onChange={(value) => onPreferencesChange({ agentEnvironment: value as SettingsPreferences['agentEnvironment'] })}><option value="windows">Windows 原生</option><option value="wsl">WSL（暂不可用）</option></SettingsSelect>} />
        <SettingsRow title="Agent 命令环境" description="可调用 Windows 原生命令；访问范围由当前操作权限决定" control={<StatusPill tone="success">可用</StatusPill>} />
        <SettingsRow title="Agent 文件工具" description={permission === 'full' ? '可以访问系统文件；当前工作区用于相对路径和 Git 状态' : '可以列出、读取和修改所选工作区内的文件，并查看 Git 状态'} control={<StatusPill tone="success">可用</StatusPill>} />
        <SettingsRow title="命令与终端" description="Agent 命令执行与底部交互式终端（真实 PTY）均可用" control={<StatusPill tone="success">可用</StatusPill>} />
      </SettingsSection>
    </>
  )

  const worktreesPage = (
    <>
      <PageTitle title="工作树" description="为并行 Agent 任务选择 Git worktree 策略。" />
      <SettingsSection title="创建策略">
        <SettingsRow title="新 Agent 任务" description="创建隔离工作树前的默认行为" control={<SettingsSelect label="工作树创建策略" value={preferences.worktreeMode} onChange={(value) => onPreferencesChange({ worktreeMode: value as SettingsPreferences['worktreeMode'] })}><option value="ask">每次询问</option><option value="always">始终创建</option><option value="never">不自动创建</option></SettingsSelect>} />
        <SettingsRow title="本地路径" description="工作区是默认目录；系统完全访问时模型可按任务使用绝对路径" control={<StatusPill tone="success">按权限使用</StatusPill>} />
      </SettingsSection>
    </>
  )

  const archivedPage = (
    <>
      <PageTitle title="已归档任务" description="任务和消息已加密保存在这台电脑上；归档管理暂不可用。" />
      <div className="settings-empty-state"><Archive size={22} /><strong>暂无已归档任务</strong><p>当前没有归档记录；现有对话仍保存在本机加密历史中。</p></div>
    </>
  )

  const pages: Record<SettingsView, ReactNode> = {
    general: generalPage,
    appearance: appearancePage,
    voice: voicePage,
    configuration: configurationPage,
    personalization: personalizationPage,
    shortcuts: shortcutsPage,
    account: accountPage,
    plugins: pluginsPage,
    browser: browserPage,
    computer: computerPage,
    hooks: hooksPage,
    connections: connectionsPage,
    git: gitPage,
    environment: environmentPage,
    worktrees: worktreesPage,
    archived: archivedPage,
  }

  return (
    <div className={`settings-shell density-${preferences.density} ${preferences.reduceMotion ? 'reduce-motion' : ''}`}>
      <aside className="settings-sidebar">
        <button type="button" className="settings-back" onClick={onBack}><ArrowLeft size={16} /><span>返回应用</span></button>
        <div className="settings-all"><SlidersHorizontal size={16} /><span>所有设置</span><ChevronDown size={14} /></div>
        <label className="settings-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置..." aria-label="搜索设置" /></label>
        <nav className="settings-navigation" aria-label="设置导航">
          {filteredGroups.map((group) => (
            <section key={group.id}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <button type="button" key={item.id} title={item.label} aria-current={activeView === item.id ? 'page' : undefined} className={activeView === item.id ? 'active' : ''} onClick={() => { onActiveViewChange(item.id); setNotice(null) }}>
                    <Icon size={16} strokeWidth={1.8} /><span>{item.label}</span>
                  </button>
                )
              })}
            </section>
          ))}
          {filteredGroups.length === 0 && <div className="settings-search-empty">没有匹配的设置</div>}
        </nav>
      </aside>

      <section className="settings-main">
        <div className="settings-main-strip" aria-hidden="true" />
        <main className="settings-scroll" tabIndex={-1}>
          <div className="settings-content">
            {notice && <div className={`settings-notice ${notice.tone}`} role="status">{notice.tone === 'warning' ? <ShieldAlert size={15} /> : notice.tone === 'success' ? <ShieldCheck size={15} /> : <Cloud size={15} />}<span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
            {pages[activeView]}
          </div>
        </main>
      </section>

      {confirmFullAccess && (
        <div className="settings-dialog-layer" role="presentation" onMouseDown={() => setConfirmFullAccess(false)}>
          <div className="settings-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="settings-full-access-title" onMouseDown={(event) => event.stopPropagation()}>
            <span><ShieldAlert size={19} /></span>
            <div><h2 id="settings-full-access-title">将默认批准模式设为系统完全访问？</h2><p>Agent 可直接访问工作区外的系统文件并运行系统命令，不再逐项确认。当前工作区仅作为默认操作目录；切换工作区只会改变默认目录。</p></div>
            <div><button autoFocus type="button" onClick={() => setConfirmFullAccess(false)}>取消</button><button type="button" className="danger" onClick={() => { onPermissionChange('full'); setConfirmFullAccess(false); setNotice({ tone: 'warning', text: '本次打开应用期间，Agent 可直接访问系统文件并运行系统命令。' }) }}>确认系统完全访问</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
