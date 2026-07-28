import {
  AlertCircle,
  Archive,
  ArrowUp,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  CircleUserRound,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  FileDiff,
  FileText,
  Focus,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Globe2,
  HardDrive,
  HelpCircle,
  History,
  ImagePlus,
  Link2,
  ListChecks,
  LoaderCircle,
  Keyboard,
  Maximize2,
  MessageSquare,
  Mic,
  Minus,
  Minimize2,
  Palette,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Pin,
  Plus,
  GitFork,
  RotateCcw,
  ScanSearch,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareTerminal,
  Sparkles,
  PlugZap,
  Target,
  Users,
  WandSparkles,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

import type {
  AgentWorkspaceOrigin,
  AgentWorkspaceSelection,
  BackgroundTaskDto,
  BootstrapPayload,
  ConversationMessageDto,
  TurnStartInput,
  WorkspaceChangeState,
  WorkspaceMode,
  WorkspaceOpenerDescriptor,
  WorkspaceOpenerId,
} from '../../shared/contracts'
import { CONTEXT_COMPACTION_PREFIX } from '../../shared/contracts'
import { WZH_MODEL_BASE_URL, WZH_RELAY_PROFILE_HANDLE } from '../../shared/server-config'
import BackgroundTaskPanel, { type BackgroundTaskPanelProps } from './background-tasks/BackgroundTaskPanel'
import { isBackgroundTaskActive, useBackgroundTasks } from './background-tasks/use-background-tasks'
import CapabilityPalette from './CapabilityPalette'
import ChangeReviewCenter from './change-review/ChangeReviewCenter'
import type {
  ComposerCapabilitiesActions,
  ComposerCapabilitiesSnapshot,
  ComposerLaunchPreparation,
  ComposerTurnSubmission,
} from './composer/composer-capabilities'
import { useComposerCapabilities } from './composer/use-composer-capabilities'
import {
  beginComposerHistorySession,
  recordComposerHistory,
  stepComposerHistory,
  type ComposerHistorySession,
} from './composer/composer-history'
import type {
  AgentExecutionEntry,
  ConversationTask as Task,
  ConversationTaskGroup as TaskGroup,
  ConversationTurnActivity as TurnActivityState,
} from './conversation/conversation-session'
import AgentExecutionSummary from './conversation/AgentExecutionSummary'
import EmptyConversationState from './conversation/EmptyConversationState'
import { useConversationSession } from './conversation/use-conversation-session'
import {
  extractConversationSources,
  summarizeSubagentRun,
} from './environment/conversation-environment'
import { useWorkspaceEnvironment } from './environment/use-workspace-environment'
import ModeSegment, { type AppMode } from './ModeSegment'
import UserCenter from './UserCenter'
import type {
  ModelOption,
  ModelSelectionActions,
  ModelSelectionSnapshot,
  ReasoningOption,
  RelayGroupOption,
} from './model-selection/model-selection'
import { useModelSelection } from './model-selection/use-model-selection'
import SettingsPage, { readSettingsPreferences, writeSettingsPreferences, type SettingsPreferences, type SettingsView } from './Settings'
import TaskHistoryActions from './TaskHistoryActions'
import {
  resolvePermissionPreference,
  resolveWorkspacePermissionPreference,
  writePermissionPreference,
  writeWorkspacePermissionPreference,
  type Permission,
} from './permission-preferences'
import { hasElectronBridge, uiPreviewHarnessEnabled } from './runtime-mode'
import ActivityCenter, { type StudioActivitySnapshot } from './ui/ActivityCenter'
import { dispatchStudioCommand, onStudioActivity, type StudioRunActivityItem } from './ui/activity-bridge'
import { diffBackgroundTransitions, diffStudioRunTransitions, toStatusMap } from './ui/activity-notifications'
import GlobalCommandCenter, { type GlobalCommandItem } from './ui/GlobalCommandCenter'
import ToastHost from './ui/ToastHost'
import { pushToast } from './ui/toast-store'
import { beginPointerResize, resizeFromKeyboard, useWorkspaceLayout } from './ui/use-workspace-layout'

const StudioWorkspace = lazy(() => import('./studio/StudioWorkspace'))

type DockTab = 'terminal' | 'diff' | 'files' | 'preview'
type OpenMenu = 'group' | 'model' | 'reasoning' | 'permission' | 'connection' | null
type AppSurface = 'workspace' | 'studio' | 'user-center' | 'settings'
type DesktopMenuId = 'file' | 'edit' | 'view' | 'help'

const previewWorkspaceOpeners: WorkspaceOpenerDescriptor[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor' },
  { id: 'visual-studio', label: 'Visual Studio', kind: 'editor' },
  { id: 'cursor', label: 'Cursor', kind: 'editor' },
  { id: 'github-desktop', label: 'GitHub Desktop', kind: 'git' },
  { id: 'explorer', label: '文件资源管理器', kind: 'file-manager' },
  { id: 'terminal', label: 'Windows Terminal', kind: 'terminal' },
  { id: 'wsl', label: 'WSL', kind: 'terminal' },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor' },
]

const workspaceOpenerVisuals: Record<WorkspaceOpenerId, { icon: LucideIcon; tone: string }> = {
  vscode: { icon: Code2, tone: 'vscode' },
  'visual-studio': { icon: WandSparkles, tone: 'visual-studio' },
  cursor: { icon: ScanSearch, tone: 'cursor' },
  'github-desktop': { icon: GitBranch, tone: 'github' },
  explorer: { icon: FolderOpen, tone: 'explorer' },
  terminal: { icon: SquareTerminal, tone: 'terminal' },
  wsl: { icon: HardDrive, tone: 'wsl' },
  pycharm: { icon: FileCode2, tone: 'pycharm' },
}

const workspaceOpenerKindLabels: Record<WorkspaceOpenerDescriptor['kind'], string> = {
  editor: '编辑器',
  git: '版本控制',
  'file-manager': '文件',
  terminal: '终端',
}

type WorkspaceOpenerOperation =
  | { kind: 'detecting' }
  | { kind: 'opening'; openerId: WorkspaceOpenerId }

const permissionOptions: Array<{
  id: Permission
  name: string
  detail: string
  icon: LucideIcon
}> = [
  { id: 'ask', name: '每次询问', detail: '工作区操作逐次确认', icon: Shield },
  { id: 'auto', name: '自动', detail: '工作区内读写与命令自动，超出工作区需确认', icon: ShieldCheck },
  { id: 'full', name: '系统完全访问', detail: '系统文件与命令直接访问', icon: ShieldAlert },
]

const previewRuntime: BootstrapPayload['runtime'] = {
  status: 'mock',
  protocolVersion: 1,
  message: '当前预览未连接桌面服务。',
}

const runtimeStatusLabels: Record<BootstrapPayload['runtime']['status'], string> = {
  mock: '本地界面预览',
  starting: '运行时启动中',
  ready: '运行时已就绪',
  degraded: '运行时受限',
  stopped: '运行时已停止',
}

function createBackgroundRequestId(): string {
  return `start:${globalThis.crypto.randomUUID()}`
}

const agentMarkdown = `
工作区已经从“配置表单”重组为连续的工作面：对话是第一层，执行证据和环境状态在需要时展开。

核心实现位于 [App.tsx](#file:src/renderer/src/App.tsx) 和 [styles.css](#file:src/renderer/src/styles.css)。渲染层不接触密钥，也不会获得任意文件或命令接口。

\
\`\`\`tsx
const windowOptions = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
}
\`\`\`

- Chat 已接入 Markdown 对话与联网搜索；附件读取和图片生成仍待接入。
- Agent 已接入审批链、工作区目录浏览、文件读写、Git 摘要与受控命令；交互终端仍待接入。
- 模式、模型与权限变更只影响下一轮，运行快照保持不变。
`

const chatMarkdown = `
可以。我已阅读你附加的工作区规范，并把内容整理成一条清晰的对话流。

Chat 模式已支持 **Markdown 对话和联网搜索**。附件内容读取与图片生成尚未接入；它不会读取工作区、执行命令或修改本地文件，需要文件工具时再切换到 Agent。

当前引用：[electron-workspace-spec.md](#file:design/electron-workspace-spec.md) · [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
`

function IconButton({
  label,
  icon: Icon,
  onClick,
  className = '',
  pressed,
  disabled,
}: {
  label: string
  icon: LucideIcon
  onClick?: () => void
  className?: string
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

function ProductMark() {
  return (
    <span className="product-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

type DesktopMenuItem = {
  label: string
  shortcut?: string
  disabled?: boolean
  separatorBefore?: boolean
  action: () => void
}

function Titlebar({
  title,
  mode,
  running,
  surface,
  onNewTask,
  onSelectWorkspace,
  onOpenSettings,
  onOpenUserCenter,
  onReturnWorkspace,
  onToggleTasks,
  onToggleContext,
  onOpenDock,
  onCloseDock,
  onOpenCommandCenter,
  onToggleActivityCenter,
  onToggleFocusMode,
  onResetLayout,
  dockOpen,
  activityOpen,
  activityCount,
  focusMode,
}: {
  title: string
  mode: WorkspaceMode
  running: boolean
  surface: AppSurface
  onNewTask: (mode: WorkspaceMode) => void
  onSelectWorkspace: () => void
  onOpenSettings: (view: SettingsView) => void
  onOpenUserCenter: () => void
  onReturnWorkspace: () => void
  onToggleTasks: () => void
  onToggleContext: () => void
  onOpenDock: (tab: DockTab) => void
  onCloseDock: () => void
  onOpenCommandCenter: () => void
  onToggleActivityCenter: () => void
  onToggleFocusMode: () => void
  onResetLayout: () => void
  dockOpen: boolean
  activityOpen: boolean
  activityCount: number
  focusMode: boolean
}) {
  const [openMenu, setOpenMenu] = useState<DesktopMenuId | null>(null)
  const menuBarRef = useRef<HTMLElement>(null)
  const triggerRefs = useRef<Record<DesktopMenuId, HTMLButtonElement | null>>({
    file: null,
    edit: null,
    view: null,
    help: null,
  })

  const invokeWindow = (action: 'minimize' | 'toggleMaximize' | 'close' | 'quit') => {
    if (!('onekey' in window)) return
    void window.onekey.window[action]()
  }

  const runEditCommand = (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll') => {
    try {
      document.execCommand(command)
    } catch {
      // The focused control decides whether the local edit command is available.
    }
  }

  useEffect(() => {
    if (!openMenu) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuBarRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const activeMenu = openMenu
      setOpenMenu(null)
      window.requestAnimationFrame(() => triggerRefs.current[activeMenu]?.focus())
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [openMenu])

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.altKey && event.code === 'ArrowLeft' && surface !== 'workspace') {
        event.preventDefault()
        setOpenMenu(null)
        onReturnWorkspace()
        return
      }

      const commandKey = event.ctrlKey || event.metaKey
      if (!commandKey) return
      let action: (() => void) | null = null

      if (event.shiftKey && event.code === 'KeyN') action = () => onNewTask(mode === 'agent' ? 'chat' : 'agent')
      else if (!event.shiftKey && event.code === 'KeyN') action = () => onNewTask(mode)
      else if (!event.shiftKey && event.code === 'KeyO') action = onSelectWorkspace
      else if (!event.shiftKey && event.code === 'Comma') action = () => onOpenSettings('general')
      else if (!event.shiftKey && !event.altKey && event.code === 'KeyB') action = onToggleTasks
      else if (event.altKey && event.code === 'KeyB') action = onToggleContext
      else if (!event.shiftKey && event.code === 'Backquote') action = () => onOpenDock('terminal')
      else if (event.shiftKey && event.code === 'KeyE') action = () => onOpenDock('files')
      else if (!event.shiftKey && event.code === 'KeyJ' && dockOpen) action = onCloseDock
      else if (!event.shiftKey && event.code === 'KeyK') action = onOpenCommandCenter
      else if (event.shiftKey && event.code === 'KeyF') action = onToggleFocusMode
      else if (event.shiftKey && event.code === 'Slash') action = () => onOpenSettings('shortcuts')
      else if (!event.shiftKey && event.code === 'KeyQ') action = () => invokeWindow('quit')

      if (!action) return
      event.preventDefault()
      setOpenMenu(null)
      action()
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [dockOpen, mode, onCloseDock, onNewTask, onOpenCommandCenter, onOpenDock, onOpenSettings, onReturnWorkspace, onSelectWorkspace, onToggleContext, onToggleFocusMode, onToggleTasks, surface])

  const menus: Array<{ id: DesktopMenuId; label: string; items: DesktopMenuItem[] }> = [
    {
      id: 'file',
      label: '文件',
      items: [
        { label: mode === 'agent' ? '新建 Agent' : '新建 Chat', shortcut: 'Ctrl+N', action: () => onNewTask(mode) },
        { label: mode === 'agent' ? '新建 Chat' : '新建 Agent', shortcut: 'Ctrl+Shift+N', action: () => onNewTask(mode === 'agent' ? 'chat' : 'agent') },
        { label: '打开工作区…', shortcut: 'Ctrl+O', action: onSelectWorkspace },
        { label: '返回工作区', shortcut: 'Alt+←', disabled: surface === 'workspace', separatorBefore: true, action: onReturnWorkspace },
        { label: '设置…', shortcut: 'Ctrl+,', action: () => onOpenSettings('general') },
        { label: '退出 AI终点站', shortcut: 'Ctrl+Q', separatorBefore: true, action: () => invokeWindow('quit') },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { label: '撤销', shortcut: 'Ctrl+Z', action: () => runEditCommand('undo') },
        { label: '重做', shortcut: 'Ctrl+Y', action: () => runEditCommand('redo') },
        { label: '剪切', shortcut: 'Ctrl+X', separatorBefore: true, action: () => runEditCommand('cut') },
        { label: '复制', shortcut: 'Ctrl+C', action: () => runEditCommand('copy') },
        { label: '粘贴', shortcut: 'Ctrl+V', action: () => runEditCommand('paste') },
        { label: '删除', action: () => runEditCommand('delete') },
        { label: '全选', shortcut: 'Ctrl+A', separatorBefore: true, action: () => runEditCommand('selectAll') },
      ],
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { label: '切换任务面板', shortcut: 'Ctrl+B', action: onToggleTasks },
        { label: '切换环境卡片', shortcut: 'Alt+Ctrl+B', action: onToggleContext },
        { label: '打开终端', shortcut: 'Ctrl+`', separatorBefore: true, action: () => onOpenDock('terminal') },
        { label: '打开 Diff', action: () => onOpenDock('diff') },
        { label: '打开文件面板', shortcut: 'Ctrl+Shift+E', action: () => onOpenDock('files') },
        { label: '关闭底部面板', shortcut: 'Ctrl+J', disabled: !dockOpen, separatorBefore: true, action: onCloseDock },
        { label: focusMode ? '退出专注模式' : '进入专注模式', shortcut: 'Ctrl+Shift+F', separatorBefore: true, action: onToggleFocusMode },
        { label: '恢复默认布局', action: onResetLayout },
      ],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { label: '键盘快捷键', shortcut: 'Ctrl+Shift+/', action: () => onOpenSettings('shortcuts') },
        { label: '环境与故障排查', action: () => onOpenSettings('environment') },
        { label: '账户与中转站', separatorBefore: true, action: onOpenUserCenter },
      ],
    },
  ]

  const runMenuItem = (item: DesktopMenuItem) => {
    if (item.disabled) return
    setOpenMenu(null)
    item.action()
  }

  return (
    <header className="titlebar" aria-label="应用标题栏">
      <div className="titlebar-brand">
        <ProductMark />
        <span>AI终点站</span>
        <ChevronDown size={13} aria-hidden="true" />
      </div>
      <div className="titlebar-center">
        <nav className="app-menu-bar" role="menubar" aria-label="应用菜单" ref={menuBarRef}>
          {menus.map((menu) => (
            <div className="app-menu-root" key={menu.id}>
              <button
                type="button"
                className={`app-menu-trigger ${openMenu === menu.id ? 'is-open' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openMenu === menu.id}
                ref={(node) => { triggerRefs.current[menu.id] = node }}
                onClick={() => setOpenMenu((current) => current === menu.id ? null : menu.id)}
              >
                {menu.label}
              </button>
              {openMenu === menu.id && (
                <div className="app-menu-popover" data-menu={menu.id} role="menu" aria-label={`${menu.label}菜单`}>
                  {menu.items.map((item) => (
                    <div key={item.label}>
                      {item.separatorBefore && <div className="app-menu-separator" role="separator" />}
                      <button
                        type="button"
                        role="menuitem"
                        disabled={item.disabled}
                        onClick={() => runMenuItem(item)}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="titlebar-task" aria-label="当前任务" title={title}>
          {running && <span className="running-dot" aria-label="正在运行" />}
          <span>{title}</span>
        </div>
        <div className="titlebar-utilities">
          <button type="button" className="titlebar-utility" onClick={onOpenCommandCenter} title="命令与搜索 · Ctrl K">
            <Search size={14} /><span>搜索</span><kbd>Ctrl K</kbd>
          </button>
          <button type="button" className="titlebar-utility" aria-expanded={activityOpen} onClick={onToggleActivityCenter} title="任务中心">
            <Bell size={14} /><span>任务</span>{activityCount > 0 && <span className="titlebar-activity-count">{activityCount}</span>}
          </button>
        </div>
      </div>
      <div className="window-controls" aria-label="窗口控制">
        <IconButton label="最小化" icon={Minus} className="window-button" onClick={() => invokeWindow('minimize')} />
        <IconButton label="最大化" icon={Maximize2} className="window-button" onClick={() => invokeWindow('toggleMaximize')} />
        <IconButton label="关闭" icon={X} className="window-button close-window" onClick={() => invokeWindow('close')} />
      </div>
    </header>
  )
}

function SidebarContents({
  mode,
  groups,
  selectedTask,
  onSelectTask,
  onNewTask,
  onArchiveTask,
  onRenameTask,
  onDeleteTask,
  onOpenSettings,
  onOpenHelp,
  onOpenUserCenter,
  accountName,
  connectionLabel,
  modelConnected,
  currentTaskRunning,
  historyActionTaskId,
  backgroundTaskPanel,
  onModeChange,
  onOpenStudio,
  drawer = false,
  onClose,
}: {
  mode: WorkspaceMode
  groups: readonly TaskGroup[]
  selectedTask: string
  onSelectTask: (task: Task) => void
  onNewTask: (mode: WorkspaceMode) => void
  onArchiveTask: (task: Task, archived: boolean) => void
  onRenameTask: (task: Task, title: string) => void
  onDeleteTask: (task: Task) => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenUserCenter: () => void
  accountName: string
  connectionLabel: string
  modelConnected: boolean
  currentTaskRunning: boolean
  historyActionTaskId: string
  backgroundTaskPanel: BackgroundTaskPanelProps
  onModeChange: (mode: WorkspaceMode) => void
  onOpenStudio: () => void
  drawer?: boolean
  onClose?: () => void
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    terminal: true,
    server: true,
    notes: false,
    'archive:local-history': false,
  })
  const alternateMode: WorkspaceMode = mode === 'agent' ? 'chat' : 'agent'
  const AlternateModeIcon = alternateMode === 'agent' ? Bot : MessageSquare

  const displayGroups = useMemo(() => {
    const activeGroups = groups
      .map((group) => ({
        ...group,
        tasks: group.tasks.filter((task) => !task.archivedAt),
      }))
      .filter((group) => group.tasks.length > 0)
    const archivedTasks = groups.flatMap((group) => group.tasks.filter((task) => Boolean(task.archivedAt)))
    if (archivedTasks.length === 0) return activeGroups
    return [...activeGroups, {
      id: 'archive:local-history',
      name: '已归档',
      path: '保存在此设备',
      tasks: archivedTasks,
    }]
  }, [groups])

  const [searchTaskIds, setSearchTaskIds] = useState<Set<string> | null>(null)

  useEffect(() => {
    const normalized = query.trim()
    if (normalized.length < 2 || !('onekey' in window)) {
      setSearchTaskIds(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.onekey.conversation.search({ query: normalized }).then((result) => {
        if (cancelled) return
        if (result.ok) setSearchTaskIds(new Set(result.value.map((t) => t.id)))
        else setSearchTaskIds(null)
      })
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query])

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return displayGroups
    return displayGroups
      .map((group) => {
        const groupMatches = group.name.toLocaleLowerCase().includes(normalized)
        return {
          ...group,
          tasks: groupMatches
            ? group.tasks
            : group.tasks.filter((task) =>
                task.title.toLocaleLowerCase().includes(normalized) ||
                (searchTaskIds !== null && searchTaskIds.has(task.id))
              ),
        }
      })
      .filter((group) => group.tasks.length > 0 || group.name.toLocaleLowerCase().includes(normalized))
  }, [displayGroups, query, searchTaskIds])

  return (
    <div className="sidebar-contents">
      <div className="sidebar-mode-row">
        <ModeSegment
          active={mode}
          disabled={currentTaskRunning}
          onSelect={(nextMode: AppMode) => {
            if (nextMode === 'studio') onOpenStudio()
            else onModeChange(nextMode)
          }}
        />
      </div>
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">任务空间</span>
          <strong>项目与任务</strong>
        </div>
        {drawer && onClose && <IconButton label="关闭任务面板" icon={X} onClick={onClose} />}
      </div>

      <div className="sidebar-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索任务"
          aria-label="搜索任务"
        />
      </div>

      <div className="new-task-row">
        <button type="button" className="new-task-main" onClick={() => onNewTask(mode)}>
          <Plus size={16} aria-hidden="true" />
          <span>{mode === 'agent' ? '新建 Agent' : '新建 Chat'}</span>
        </button>
        <IconButton
          label={alternateMode === 'agent' ? '新建 Agent' : '新建 Chat'}
          icon={AlternateModeIcon}
          onClick={() => onNewTask(alternateMode)}
        />
      </div>

      <div className="task-tree" role="tree" aria-label="任务树">
        <BackgroundTaskPanel {...backgroundTaskPanel} />
        {filteredGroups.map((group) => {
          const isExpanded = query ? true : expanded[group.id]
          return (
            <section className="task-group" key={group.id}>
              <button
                type="button"
                className="task-group-heading"
                aria-expanded={isExpanded}
                onClick={() => setExpanded((current) => ({ ...current, [group.id]: !current[group.id] }))}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={14} />
                <span>{group.name}</span>
                <span className="task-count">{group.tasks.length}</span>
              </button>
              {isExpanded && (
                <div role="group">
                  {group.tasks.map((task) => {
                    const TaskIcon = task.mode === 'agent' ? Bot : MessageSquare
                    return (
                      <div className="task-row-shell" key={task.id}>
                        <button
                          type="button"
                          role="treeitem"
                          aria-selected={task.id === selectedTask}
                          className={`task-row ${task.id === selectedTask ? 'selected' : ''}`}
                          title={`${task.title}\n${group.path}`}
                          onClick={() => onSelectTask(task)}
                        >
                          <TaskIcon size={14} aria-hidden="true" />
                          <span>{task.title}</span>
                          {task.pinned && <Pin size={12} className="task-pin" aria-label="已固定" />}
                          {task.status === 'running' && <span className="task-status running" aria-label="正在运行" />}
                          {task.status === 'unread' && <span className="task-status unread" aria-label="未读" />}
                          {task.status === 'failed' && <AlertCircle size={13} className="task-failed" aria-label="失败" />}
                        </button>
                        <TaskHistoryActions
                          title={task.title}
                          archived={Boolean(task.archivedAt)}
                          disabled={
                            task.status === 'running'
                            || Boolean(historyActionTaskId)
                            || (currentTaskRunning && selectedTask === task.id)
                          }
                          renameDisabled={task.readOnly === true}
                          deleteLabel={task.readOnly === true ? '从列表移除' : undefined}
                          onArchiveChange={(archived) => onArchiveTask(task, archived)}
                          onRename={(newTitle) => onRenameTask(task, newTitle)}
                          onDelete={() => onDeleteTask(task)}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
        {filteredGroups.length === 0 && <p className="sidebar-empty">没有匹配的任务</p>}
      </div>

      <footer className="sidebar-footer">
        <button type="button" className="sidebar-footer-row" onClick={onOpenSettings}>
          <Settings size={16} aria-hidden="true" />
          <span>设置</span>
        </button>
        <button type="button" className="sidebar-footer-row" onClick={onOpenHelp}>
          <HelpCircle size={16} aria-hidden="true" />
          <span>帮助与反馈</span>
        </button>
        <button type="button" className="account-row" onClick={onOpenUserCenter}>
          <span className="account-avatar">W</span>
          <span className="account-copy">
            <strong>{accountName}</strong>
            <small><span className={`connection-dot ${modelConnected ? '' : 'preview'}`} /> {connectionLabel}</small>
          </span>
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      </footer>
    </div>
  )
}

function TaskSidebar({
  mode,
  groups,
  selectedTask,
  onSelectTask,
  onNewTask,
  onArchiveTask,
  onRenameTask,
  onDeleteTask,
  onOpenDrawer,
  onOpenSettings,
  onOpenHelp,
  onOpenUserCenter,
  accountName,
  connectionLabel,
  modelConnected,
  currentTaskRunning,
  historyActionTaskId,
  backgroundTaskPanel,
  onModeChange,
  onOpenStudio,
}: {
  mode: WorkspaceMode
  groups: readonly TaskGroup[]
  selectedTask: string
  onSelectTask: (task: Task) => void
  onNewTask: (mode: WorkspaceMode) => void
  onArchiveTask: (task: Task, archived: boolean) => void
  onRenameTask: (task: Task, title: string) => void
  onDeleteTask: (task: Task) => void
  onOpenDrawer: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenUserCenter: () => void
  accountName: string
  connectionLabel: string
  modelConnected: boolean
  currentTaskRunning: boolean
  historyActionTaskId: string
  backgroundTaskPanel: BackgroundTaskPanelProps
  onModeChange: (mode: WorkspaceMode) => void
  onOpenStudio: () => void
}) {
  return (
    <aside className="task-sidebar">
      <div className="sidebar-full">
        <SidebarContents
          mode={mode}
          groups={groups}
          selectedTask={selectedTask}
          onSelectTask={onSelectTask}
          onNewTask={onNewTask}
          onArchiveTask={onArchiveTask}
          onRenameTask={onRenameTask}
          onDeleteTask={onDeleteTask}
          onOpenSettings={onOpenSettings}
          onOpenHelp={onOpenHelp}
          onOpenUserCenter={onOpenUserCenter}
          accountName={accountName}
          connectionLabel={connectionLabel}
          modelConnected={modelConnected}
          currentTaskRunning={currentTaskRunning}
          historyActionTaskId={historyActionTaskId}
          backgroundTaskPanel={backgroundTaskPanel}
          onModeChange={onModeChange}
          onOpenStudio={onOpenStudio}
        />
      </div>
      <nav className="sidebar-rail" aria-label="任务栏">
        <button type="button" className="rail-brand" onClick={onOpenDrawer} aria-label="打开任务">
          <ProductMark />
        </button>
        <ModeSegment
          active={mode}
          className="rail-mode-segment"
          disabled={currentTaskRunning}
          onSelect={(nextMode) => {
            if (nextMode === 'studio') onOpenStudio()
            else onModeChange(nextMode)
          }}
        />
        <IconButton label="打开任务" icon={PanelLeftOpen} onClick={onOpenDrawer} />
        <IconButton
          label={mode === 'agent' ? '新建 Agent' : '新建 Chat'}
          icon={Plus}
          onClick={() => onNewTask(mode)}
        />
        <IconButton
          label={mode === 'agent' ? '新建 Chat' : '新建 Agent'}
          icon={mode === 'agent' ? MessageSquare : Bot}
          onClick={() => onNewTask(mode === 'agent' ? 'chat' : 'agent')}
        />
        <IconButton label="搜索任务" icon={Search} onClick={onOpenDrawer} />
        <span className="rail-spacer" />
        <IconButton label="设置" icon={Settings} onClick={onOpenSettings} />
        <IconButton label="用户中心" icon={CircleUserRound} onClick={onOpenUserCenter} />
      </nav>
    </aside>
  )
}

function WorkspaceOpenControl({
  enabled,
  workspaceSelected,
  openers,
  defaultOpener,
  notice,
  onSelectWorkspace,
  onDetectOpeners,
  onOpenWorkspace,
}: {
  enabled: boolean
  workspaceSelected: boolean
  openers: readonly WorkspaceOpenerDescriptor[]
  defaultOpener: SettingsPreferences['defaultOpener']
  notice: string
  onSelectWorkspace: () => void
  onDetectOpeners: () => Promise<WorkspaceOpenerDescriptor[]>
  onOpenWorkspace: (openerId: WorkspaceOpenerId) => Promise<boolean>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [operation, setOperation] = useState<WorkspaceOpenerOperation | null>(null)
  const [visibleOpeners, setVisibleOpeners] = useState<WorkspaceOpenerDescriptor[]>([...openers])
  const [localNotice, setLocalNotice] = useState('')
  const operationRef = useRef<WorkspaceOpenerOperation | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)

  const detecting = operation?.kind === 'detecting'
  const openingId = operation?.kind === 'opening' ? operation.openerId : null
  const busy = operation !== null

  useEffect(() => setVisibleOpeners([...openers]), [openers])

  useEffect(() => {
    if (!menuOpen) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      window.requestAnimationFrame(() => menuTriggerRef.current?.focus())
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    setMenuOpen(false)
    setLocalNotice('')
  }, [enabled, workspaceSelected])

  const beginOperation = (next: WorkspaceOpenerOperation): boolean => {
    if (operationRef.current) return false
    operationRef.current = next
    setOperation(next)
    return true
  }

  const finishOperation = (current: WorkspaceOpenerOperation): void => {
    if (operationRef.current !== current) return
    operationRef.current = null
    setOperation(null)
  }

  const detect = async (focusFirst: boolean): Promise<WorkspaceOpenerDescriptor[] | null> => {
    const current: WorkspaceOpenerOperation = { kind: 'detecting' }
    if (!beginOperation(current)) return null
    setLocalNotice('')
    try {
      const detected = await onDetectOpeners()
      setVisibleOpeners(detected)
      if (detected.length === 0) setLocalNotice('没有检测到可用的本机打开方式。')
      if (focusFirst && detected.length > 0) {
        window.requestAnimationFrame(() => {
          menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
        })
      }
      return detected
    } finally {
      finishOperation(current)
    }
  }

  const showMenu = async (focusFirst = false) => {
    if (!enabled || !workspaceSelected || operationRef.current) return
    setMenuOpen(true)
    await detect(focusFirst)
  }

  const openWith = async (openerId: WorkspaceOpenerId) => {
    const current: WorkspaceOpenerOperation = { kind: 'opening', openerId }
    if (!beginOperation(current)) return
    setLocalNotice('')
    try {
      if (await onOpenWorkspace(openerId)) setMenuOpen(false)
    } finally {
      finishOperation(current)
    }
  }

  const runPrimaryAction = async () => {
    if (!enabled || operationRef.current) return
    if (!workspaceSelected) {
      onSelectWorkspace()
      return
    }
    if (defaultOpener === 'none') {
      await showMenu(true)
      return
    }
    const detected = await detect(false)
    if (!detected) return
    if (detected.length === 0) {
      setMenuOpen(true)
      return
    }
    if (!detected.some((entry) => entry.id === defaultOpener)) {
      setLocalNotice('默认打开方式在当前电脑上不可用，请选择其他目标。')
      setMenuOpen(true)
      return
    }
    await openWith(defaultOpener)
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
    else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    else if (event.key === 'Tab') setMenuOpen(false)
    if (nextIndex === null) return
    event.preventDefault()
    items[nextIndex]?.focus()
  }

  const preferred = defaultOpener === 'none'
    ? null
    : visibleOpeners.find((entry) => entry.id === defaultOpener) ?? null
  const displayNotice = notice || localNotice
  const openingTarget = openingId ? visibleOpeners.find((entry) => entry.id === openingId) : null
  const primaryAriaLabel = !workspaceSelected
    ? '选择工作区'
    : detecting
      ? '正在检测本机打开方式'
      : openingId
        ? `正在使用 ${openingTarget?.label ?? '所选应用'} 打开当前工作区`
        : defaultOpener === 'none'
          ? '打开位置菜单'
          : preferred
            ? `使用 ${preferred.label} 打开当前工作区`
            : '使用默认方式打开当前工作区'
  const primaryLabel = detecting
    ? '正在检测'
    : openingId
      ? '正在打开'
      : workspaceSelected
        ? '打开位置'
        : '选择工作区'
  const PrimaryIcon = busy
    ? LoaderCircle
    : preferred
      ? workspaceOpenerVisuals[preferred.id].icon
      : FolderOpen

  return (
    <div className={`workspace-launcher ${menuOpen ? 'is-open' : ''}`} ref={rootRef}>
      <div className="workspace-launcher-control">
        <button
          type="button"
          className="workspace-launcher-main"
          disabled={!enabled || busy}
          aria-label={primaryAriaLabel}
          aria-haspopup={workspaceSelected && defaultOpener === 'none' ? 'menu' : undefined}
          aria-expanded={workspaceSelected && defaultOpener === 'none' ? menuOpen : undefined}
          onClick={() => { void runPrimaryAction() }}
        >
          <PrimaryIcon className={busy ? 'spin' : ''} size={15} aria-hidden="true" />
          <span>{primaryLabel}</span>
        </button>
        {workspaceSelected && (
          <button
            type="button"
            className="workspace-launcher-menu-trigger"
            aria-label="选择打开位置"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            ref={menuTriggerRef}
            disabled={!enabled || busy}
            onClick={() => {
              if (menuOpen) setMenuOpen(false)
              else void showMenu(false)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return
              event.preventDefault()
              void showMenu(true)
            }}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {menuOpen && (
        <div
          className="workspace-opener-menu"
          role="menu"
          aria-label="打开位置"
          aria-busy={busy}
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="workspace-opener-heading">
            <span>打开当前工作区</span>
            <small>{detecting ? '正在检测' : `本机可用 ${visibleOpeners.length} 项`}</small>
          </div>
          <div className="workspace-opener-list">
            {detecting && visibleOpeners.length === 0 && (
              <div className="workspace-opener-loading"><LoaderCircle className="spin" size={16} />正在检测本机应用</div>
            )}
            {visibleOpeners.map((opener) => {
              const visual = workspaceOpenerVisuals[opener.id]
              const OpenerIcon = visual.icon
              const selected = opener.id === defaultOpener
              return (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-opener-item"
                  key={opener.id}
                  disabled={busy}
                  onClick={() => { void openWith(opener.id) }}
                >
                  <span className={`workspace-opener-icon ${visual.tone}`}><OpenerIcon size={18} aria-hidden="true" /></span>
                  <span className="workspace-opener-copy"><strong>{opener.label}</strong><small>{workspaceOpenerKindLabels[opener.kind]}</small></span>
                  {openingId === opener.id ? <LoaderCircle className="spin" size={14} aria-label="正在打开" /> : selected && <Check size={14} aria-label="默认" />}
                </button>
              )
            })}
          </div>
          {displayNotice && <p className="workspace-opener-notice" role="status">{displayNotice}</p>}
          <div className="workspace-opener-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="workspace-opener-item workspace-opener-change"
            disabled={busy}
            onClick={() => {
              setMenuOpen(false)
              onSelectWorkspace()
            }}
          >
            <span className="workspace-opener-icon change"><FolderOpen size={18} aria-hidden="true" /></span>
            <span className="workspace-opener-copy"><strong>选择其他工作区</strong><small>更改当前本地目录</small></span>
          </button>
        </div>
      )}
    </div>
  )
}

function TaskHeader({
  title,
  mode,
  planMode,
  goal,
  workspaceName,
  workspaceSelected,
  workspaceIdentity,
  workspaceOpeners,
  defaultOpener,
  openerNotice,
  onSelectWorkspace,
  onDetectOpeners,
  onOpenWorkspace,
  onOpenContext,
  onOpenDock,
  onOpenSearch,
}: {
  title: string
  mode: WorkspaceMode
  planMode: boolean
  goal: string
  workspaceName: string
  workspaceSelected: boolean
  workspaceIdentity: string
  workspaceOpeners: readonly WorkspaceOpenerDescriptor[]
  defaultOpener: SettingsPreferences['defaultOpener']
  openerNotice: string
  onSelectWorkspace: () => void
  onDetectOpeners: () => Promise<WorkspaceOpenerDescriptor[]>
  onOpenWorkspace: (openerId: WorkspaceOpenerId) => Promise<boolean>
  onOpenContext: () => void
  onOpenDock: (tab: DockTab) => void
  onOpenSearch: () => void
}) {
  return (
    <header className="task-header">
      <div className="task-breadcrumb">
        <span className="workspace-name" title={workspaceName || title}>
          {mode === 'agent' ? (workspaceName || '自动工作目录') : 'Chat'}
        </span>
        <span className="breadcrumb-divider">/</span>
        <GitBranch size={14} aria-hidden="true" />
        <span>{mode === 'agent' ? 'Agent' : '对话'}</span>
        {mode === 'agent' && <span className="dirty-dot" aria-label="工作区已隔离" />}
      </div>
      <div className="task-state-badges">
        {planMode && <span className="task-mode-badge"><ListChecks size={12} />计划</span>}
        {goal && <span className="task-goal-badge" title={goal}><Target size={12} />目标</span>}
      </div>
      <div className="task-header-actions">
        <WorkspaceOpenControl
          key={workspaceIdentity || mode}
          enabled={mode === 'agent'}
          workspaceSelected={workspaceSelected}
          openers={workspaceOpeners}
          defaultOpener={defaultOpener}
          notice={openerNotice}
          onSelectWorkspace={onSelectWorkspace}
          onDetectOpeners={onDetectOpeners}
          onOpenWorkspace={onOpenWorkspace}
        />
        <IconButton label="在任务中搜索" icon={Search} onClick={onOpenSearch} />
        <IconButton label="打开终端" icon={SquareTerminal} onClick={() => onOpenDock('terminal')} />
        <IconButton label="环境信息" icon={PanelRight} onClick={onOpenContext} />
      </div>
    </header>
  )
}

function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="user-message">
      <div className="message-label">你</div>
      <div className="user-message-body">{children}</div>
    </div>
  )
}

function CodeBlock({
  language,
  code,
  onOpen,
}: {
  language: string
  code: string
  onOpen: () => void
}) {
  const [copied, setCopied] = useState(false)

  const highlighted = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null
    try {
      return hljs.highlight(code, { language }).value
    } catch {
      return null
    }
  }, [code, language])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || 'text'}</span>
        <div>
          <IconButton label={copied ? '已复制' : '复制代码'} icon={copied ? Check : Copy} onClick={copyCode} />
          <IconButton label="在编辑器中打开" icon={Code2} onClick={onOpen} />
        </div>
      </div>
      <pre><code>{highlighted ? <span dangerouslySetInnerHTML={{ __html: highlighted }} /> : code}</code></pre>
    </div>
  )
}

function MarkdownMessage({
  markdown,
  onOpenFile,
}: {
  markdown: string
  onOpenFile: () => void
}) {
  const components: Components = {
    pre({ children }) {
      return <>{children}</>
    },
    code({ className, children }) {
      const code = String(children).replace(/\n$/, '')
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? ''
      const isBlock = Boolean(className) || code.includes('\n')
      return isBlock ? (
        <CodeBlock language={language} code={code} onOpen={onOpenFile} />
      ) : (
        <code className="inline-code">{children}</code>
      )
    },
    a({ href = '', children }) {
      const isFile = href.startsWith('#file:')
      const isExternal = /^https?:\/\//.test(href)
      if (isFile) {
        return (
          <button type="button" className="file-link" onClick={onOpenFile} title={href.slice(6)}>
            <FileCode2 size={13} aria-hidden="true" />
            <span>{children}</span>
          </button>
        )
      }
      return (
        <a
          href={href}
          className="external-link"
          onClick={(event) => {
            if (!isExternal) return
            event.preventDefault()
            if ('onekey' in window) void window.onekey.link.openExternal(href)
          }}
        >
          {children}
          {isExternal && <ExternalLink size={12} aria-hidden="true" />}
        </a>
      )
    },
  }

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

type TrackEvent = {
  id: string
  label: string
  target: string
  status: 'succeeded' | 'running' | 'approval'
  duration: string
  icon: LucideIcon
  detail?: ReactNode
}

const trackEvents: TrackEvent[] = [
  {
    id: 'plan',
    label: '整理实现计划',
    target: 'React 工作区',
    status: 'succeeded',
    duration: '0.8s',
    icon: ListChecks,
  },
  {
    id: 'inspect',
    label: '读取设计规范',
    target: 'design/electron-workspace-spec.md',
    status: 'succeeded',
    duration: '1.2s',
    icon: ScanSearch,
  },
  {
    id: 'subagents',
    label: '并行校验',
    target: '响应式与安全契约',
    status: 'succeeded',
    duration: '18.4s',
    icon: Users,
    detail: (
      <div className="branch-list">
        <div><span className="branch-line" /><CheckCircle2 size={13} />布局校验 <small>4 个视口</small></div>
        <div><span className="branch-line" /><CheckCircle2 size={13} />安全契约 <small>renderer 无密钥</small></div>
        <div><span className="branch-line" /><CheckCircle2 size={13} />交互清单 <small>23 项</small></div>
      </div>
    ),
  },
  {
    id: 'write',
    label: '写入工作区界面',
    target: 'src/renderer',
    status: 'succeeded',
    duration: '12.6s',
    icon: Wrench,
    detail: (
      <div className="event-summary">
        <span>范围</span><code>src/renderer/**</code>
        <span>策略</span><span>按当前操作权限</span>
      </div>
    ),
  },
  {
    id: 'verify',
    label: '验证渲染构建',
    target: '界面检查',
    status: 'succeeded',
    duration: '4.1s',
    icon: CheckCircle2,
  },
]

function ExecutionTrack({ running = false }: { running?: boolean }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ subagents: true })

  return (
    <div className="execution-track" aria-label="执行轨迹">
      <div className="track-spine" aria-hidden="true" />
      {trackEvents.map((event, index) => {
        const Icon = event.icon
        const eventRunning = running && index === trackEvents.length - 1
        return (
          <div className={`track-event ${eventRunning ? 'is-running' : event.status}`} key={event.id}>
            <button
              type="button"
              className="track-node"
              aria-label={`${event.label}，${eventRunning ? '正在运行' : '已完成'}`}
              onClick={() => setExpanded((current) => ({ ...current, [event.id]: !current[event.id] }))}
            >
              <span />
            </button>
            <div className="track-event-content">
              <button
                type="button"
                className="track-event-row"
                aria-expanded={Boolean(expanded[event.id])}
                onClick={() => setExpanded((current) => ({ ...current, [event.id]: !current[event.id] }))}
              >
                <Icon size={14} aria-hidden="true" />
                <strong>{event.label}</strong>
                <code>{event.target}</code>
                <span className={`event-status ${eventRunning ? 'running' : event.status}`}>
                  {eventRunning ? '运行中' : event.status === 'approval' ? '待批准' : '完成'}
                </span>
                <span className="event-duration">{eventRunning ? '2.8s' : event.duration}</span>
                {event.detail ? (expanded[event.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="event-chevron-space" />}
              </button>
              {event.detail && expanded[event.id] && <div className="track-event-detail">{event.detail}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const diffFiles = [
  { path: 'src/renderer/src/App.tsx', add: 684, remove: 0 },
  { path: 'src/renderer/src/styles.css', add: 912, remove: 0 },
  { path: 'src/renderer/src/main.tsx', add: 12, remove: 0 },
  { path: 'src/renderer/index.html', add: 16, remove: 0 },
  { path: 'design/electron-workspace-spec.md', add: 34, remove: 8 },
  { path: '.gitignore', add: 7, remove: 0 },
]

function DiffArtifact({ onOpenDock }: { onOpenDock: (tab: DockTab) => void }) {
  const [showAll, setShowAll] = useState(false)
  const visibleFiles = showAll ? diffFiles : diffFiles.slice(0, 4)

  return (
    <section className="diff-artifact" aria-labelledby="diff-heading">
      <header className="diff-header">
        <div className="diff-title-icon"><FileDiff size={17} aria-hidden="true" /></div>
        <div>
          <strong id="diff-heading">已编辑 {diffFiles.length} 个文件</strong>
          <span><b>+1,665</b> <em>-8</em></span>
        </div>
        <div className="diff-actions">
          <button type="button" className="review-command" onClick={() => onOpenDock('diff')}>
            <ScanSearch size={14} />审查
          </button>
        </div>
      </header>
      <div className="diff-files">
        {visibleFiles.map((file) => (
          <button type="button" className="diff-file-row" key={file.path} onClick={() => onOpenDock('diff')}>
            <FileCode2 size={14} aria-hidden="true" />
            <span title={file.path}>{file.path}</span>
            <span className="file-stats"><b>+{file.add}</b> <em>-{file.remove}</em></span>
          </button>
        ))}
      </div>
      {diffFiles.length > 4 && (
        <button type="button" className="show-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? '收起文件' : `再显示 ${diffFiles.length - 4} 个文件`}
          {showAll ? <ChevronDown className="rotate-180" size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
    </section>
  )
}

/**
 * The model-generated context summary is persisted as a user message so it stays
 * in the transport history, but presenting it as one would read as something the
 * user typed. Render it as a collapsed compaction event instead.
 */
function CompactionEvent({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <article className="conversation-turn compaction-turn">
      <div className="compaction-event">
        <button
          type="button"
          className="compaction-event-header"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <Archive size={13} aria-hidden="true" />
          <span>上下文已压缩，早期消息已由模型摘要替换</span>
          <ChevronDown size={13} aria-hidden="true" className={expanded ? 'is-expanded' : ''} />
        </button>
        {expanded && <div className="compaction-event-body">{summary}</div>}
      </div>
    </article>
  )
}

function MessageActions({ content, model, onContinue, onRegenerate, onFork }: {
  content: string
  model?: string
  onContinue?: () => void
  onRegenerate?: () => void
  onFork?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="message-actions">
      <IconButton
        label={copied ? '已复制' : '复制回答'}
        icon={copied ? Check : Copy}
        onClick={() => { void copy() }}
      />
      {onRegenerate ? <IconButton label="以当前所选模型重新回答" icon={RotateCcw} onClick={onRegenerate} /> : null}
      {onFork ? <IconButton label="从此消息创建分支" icon={GitFork} onClick={onFork} /> : null}
      {onContinue ? <IconButton label="在新任务中继续" icon={ExternalLink} onClick={onContinue} /> : null}
      {model ? <span className="message-model-tag" title={`由 ${model} 生成`}>{model}</span> : null}
    </div>
  )
}

function TurnActivityLine({
  activity,
  elapsedSeconds,
  fallback,
}: {
  activity: TurnActivityState | null
  elapsedSeconds: number
  fallback: string
}) {
  const detail = activity?.detail || fallback
  return (
    <div
      className={`turn-activity phase-${activity?.phase ?? 'thinking'}`}
      role="status"
      aria-label={`${detail}，仍在处理`}
    >
      <span className="turn-activity-breath" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="turn-activity-detail">{detail}</span>
      <span className="turn-activity-separator" aria-hidden="true">·</span>
      <span className="turn-activity-elapsed" aria-hidden="true">已处理 {elapsedSeconds} 秒</span>
    </div>
  )
}

// Chrome's scroll anchoring leaves a few pixels of slack, so "at the bottom"
// needs tolerance or the transcript stops following after one streamed chunk.
const STICK_TO_BOTTOM_THRESHOLD = 48

function Transcript({
  mode,
  running,
  activity,
  elapsedSeconds,
  messages,
  executionTracks,
  generatedImages,
  turnMessage,
  previewExample,
  canContinueAgent,
  onContinueAgent,
  onChooseStarter,
  onOpenDock,
  onRetryMessage,
  onForkFromMessage,
}: {
  mode: WorkspaceMode
  running: boolean
  activity: TurnActivityState | null
  elapsedSeconds: number
  messages: readonly ConversationMessageDto[]
  executionTracks: Readonly<Record<string, readonly AgentExecutionEntry[]>>
  generatedImages: Readonly<Record<string, readonly string[]>>
  turnMessage: string
  previewExample: boolean
  canContinueAgent: boolean
  onContinueAgent: () => void
  onChooseStarter: (prompt: string) => void
  onOpenDock: (tab: DockTab) => void
  onRetryMessage?: (message: ConversationMessageDto) => void
  onForkFromMessage?: (message: ConversationMessageDto) => void
}) {
  const hasConversation = messages.length > 0
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Follow streaming output only while the user is already at the bottom, so
  // scrolling up to re-read something is never yanked back down mid-answer.
  const stickToBottomRef = useRef(true)
  const lastMessage = messages.at(-1)
  const streamedLength = lastMessage?.content.length ?? 0

  const trackScrollPosition = (): void => {
    const element = scrollRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !stickToBottomRef.current) return
    element.scrollTop = element.scrollHeight
  }, [messages.length, streamedLength, lastMessage?.status, activity])

  return (
    <div
      className="transcript"
      role="log"
      aria-live="polite"
      ref={scrollRef}
      onScroll={trackScrollPosition}
    >
      <div className="reading-column">
        {!hasConversation && previewExample && (
          <article className="conversation-turn">
            <UserMessage>
              {mode === 'agent'
                ? '把旧版工作区改成 React 风格，保留任务树、Markdown、Diff、环境面板、终端和可靠的 Agent 权限。'
                : '阅读我附加的工作区规范，告诉我 Chat 模式可以处理哪些内容。'}
            </UserMessage>

            <div className="assistant-message-body">
              {mode === 'agent' ? (
                <>
                <p className="assistant-lead">我先确认现有能力和安全边界，再把界面重组为可持续工作的桌面工作台。</p>
                <ExecutionTrack />
                <MarkdownMessage markdown={agentMarkdown} onOpenFile={() => onOpenDock('files')} />
                <DiffArtifact onOpenDock={onOpenDock} />
                </>
              ) : (
                <>
                <MarkdownMessage markdown={chatMarkdown} onOpenFile={() => onOpenDock('files')} />
                <div className="source-strip">
                  <Link2 size={14} />
                  <span>2 个来源</span>
                </div>
                </>
              )}
              <MessageActions content={mode === 'agent' ? agentMarkdown : chatMarkdown} />
            </div>
          </article>
        )}

        {!hasConversation && !previewExample && (
          <EmptyConversationState mode={mode} onChoose={onChooseStarter} />
        )}

        {messages.map((message) => message.role === 'user' ? (
          message.content.startsWith(CONTEXT_COMPACTION_PREFIX) ? (
            <CompactionEvent
              key={message.id}
              summary={message.content.slice(CONTEXT_COMPACTION_PREFIX.length)}
            />
          ) : (
            <article className="conversation-turn latest-turn" key={message.id}>
              <UserMessage>{message.content}</UserMessage>
            </article>
          )
        ) : (
          <article className="conversation-turn assistant-turn" key={message.id}>
            <div className="assistant-message-body">
              {(executionTracks[message.id]?.length ?? 0) > 0 && (
                <AgentExecutionSummary entries={executionTracks[message.id]!} now={Date.now()} />
              )}
              {message.content && <MarkdownMessage markdown={message.content} onOpenFile={() => onOpenDock('files')} />}
              {(generatedImages[message.id]?.length ?? 0) > 0 && (
                <div className="generated-image-grid">
                  {generatedImages[message.id]!.map((source, index) => (
                    <img
                      key={source}
                      src={source}
                      alt={`生成图片 ${index + 1}`}
                      className="generated-image"
                    />
                  ))}
                </div>
              )}
              {message.status === 'streaming' && (executionTracks[message.id]?.length ?? 0) === 0 && (
                <TurnActivityLine
                  activity={activity}
                  elapsedSeconds={elapsedSeconds}
                  fallback={running ? '正在分析并生成回答' : '正在恢复流式状态'}
                />
              )}
              {message.status === 'cancelled' && <p className="stopped-line"><Circle size={12} />本轮已停止，已接收内容已加密保存。</p>}
              {message.status === 'failed' && <p className="stopped-line error"><AlertCircle size={13} />{turnMessage || '本轮未完成，请重试。'}</p>}
              {(message.status === 'failed' || message.status === 'cancelled') && !running && onRetryMessage && (
                <button type="button" className="text-command" onClick={() => onRetryMessage(message)}>
                  <RotateCcw size={14} />
                  <span>重试此轮（当前模型）</span>
                </button>
              )}
              {message.status === 'complete' && (
                <MessageActions
                  content={message.content}
                  model={message.model}
                  onRegenerate={!running && onRetryMessage && message.id === messages.at(-1)?.id
                    ? () => onRetryMessage(message)
                    : undefined}
                  onFork={!running && onForkFromMessage ? () => onForkFromMessage(message) : undefined}
                />
              )}
              {canContinueAgent && message.id === messages.at(-1)?.id && (
                <button type="button" className="text-command" onClick={onContinueAgent}>
                  <RotateCcw size={14} />
                  <span>继续执行</span>
                </button>
              )}
            </div>
          </article>
        ))}
        {running && messages.at(-1)?.status !== 'streaming' && (
          <div className="standalone-turn-activity">
            <TurnActivityLine
              activity={activity}
              elapsedSeconds={elapsedSeconds}
              fallback="正在安全准备请求"
            />
          </div>
        )}
        {turnMessage && !running && messages.at(-1)?.status !== 'failed' && (
          <p className="stopped-line error standalone"><AlertCircle size={13} />{turnMessage}</p>
        )}
      </div>
    </div>
  )
}

function ContextInspector({
  open,
  compactWhenIdle,
  mode,
  subagentsEnabled,
  messages,
  executionTracks,
  previewExample,
  workspaceToken,
  workspaceName,
  taskId,
  runtime,
  onOpenDock,
  onNotice,
  onOpen,
  onClose,
}: {
  open: boolean
  compactWhenIdle: boolean
  mode: WorkspaceMode
  subagentsEnabled: boolean
  messages: readonly ConversationMessageDto[]
  executionTracks: Readonly<Record<string, readonly AgentExecutionEntry[]>>
  previewExample: boolean
  workspaceToken: string
  workspaceName: string
  taskId: string
  runtime: BootstrapPayload['runtime']
  onOpenDock: (tab: DockTab) => void
  onNotice: (message: string) => void
  onOpen: () => void
  onClose: () => void
}) {
  const latestMessage = messages.at(-1)
  const latestAssistant = latestMessage?.role === 'assistant' ? latestMessage : null
  const latestExecution = latestAssistant ? executionTracks[latestAssistant.id] ?? [] : []
  const subagentRun = useMemo(() => summarizeSubagentRun(latestExecution), [latestExecution])
  const sources = useMemo(
    () => extractConversationSources(latestAssistant?.content ?? ''),
    [latestAssistant?.content],
  )
  const subagentStatus = mode === 'chat'
    ? '不适用'
    : subagentRun.state === 'running'
      ? '运行中'
      : subagentRun.state === 'completed'
        ? '已完成'
        : subagentRun.state === 'partial'
          ? '部分完成'
          : subagentRun.state === 'failed'
            ? '未完成'
             : subagentsEnabled
               ? '模型可自动调用'
               : '当前不可用'
  const subagentDetail = mode === 'chat'
    ? 'Chat 模式不运行本地并行子任务'
    : subagentRun.state === 'none'
      ? subagentsEnabled
         ? '模型会在需要时自动调用并行子任务'
         : '当前模型未提供自动并行子任务'
      : subagentRun.total === 0
        ? subagentRun.state === 'running'
          ? '正在准备并行子任务'
          : subagentRun.state === 'failed'
            ? '本轮并行子任务未能启动'
            : '本轮并行检查已结束'
        : subagentRun.running === 0 && subagentRun.failed === 0
          ? `本轮 ${subagentRun.total} 个子任务已全部完成`
          : `本轮 ${subagentRun.total} 个子任务：${[
              subagentRun.running ? `${subagentRun.running} 个运行中` : '',
              subagentRun.completed ? `${subagentRun.completed} 个已完成` : '',
              subagentRun.failed ? `${subagentRun.failed} 个未完成` : '',
            ].filter(Boolean).join('，')}`
  const environment = useWorkspaceEnvironment({
    workspaceToken,
    // The inspector is permanently visible on wide layouts even when the
    // compact-drawer `open` flag is false, so polling follows the selected
    // workspace rather than that responsive presentation flag.
    enabled: Boolean(workspaceToken) && !previewExample,
  })
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChangeState | null>(null)
  const [workspaceChangeBusy, setWorkspaceChangeBusy] = useState(false)
  const loadWorkspaceChanges = useCallback(async (): Promise<void> => {
    if (!taskId || mode !== 'agent' || previewExample || !('onekey' in window)) {
      setWorkspaceChanges(null)
      return
    }
    const result = await window.onekey.workspace.changes({ taskId })
    if (result.ok) setWorkspaceChanges(result.value)
  }, [mode, previewExample, taskId])
  useEffect(() => {
    void loadWorkspaceChanges()
  }, [loadWorkspaceChanges, workspaceToken])
  const createWorkspaceCheckpoint = async (): Promise<void> => {
    if (!taskId || workspaceChangeBusy) return
    setWorkspaceChangeBusy(true)
    try {
      const result = await window.onekey.workspace.checkpoint({ taskId })
      if (result.ok) {
        setWorkspaceChanges(result.value)
        onNotice('已创建检查点。')
      } else onNotice(result.error.message)
    } finally {
      setWorkspaceChangeBusy(false)
    }
  }
  const rewindWorkspace = async (checkpointId: string, label: string): Promise<void> => {
    if (!taskId || workspaceChangeBusy) return
    setWorkspaceChangeBusy(true)
    try {
      const result = await window.onekey.workspace.rewind({ taskId, checkpointId })
      if (result.ok) {
        setWorkspaceChanges(result.value)
        onNotice(`已回退到“${label}”，回退前状态也已保留。`)
      } else onNotice(result.error.message)
    } finally {
      setWorkspaceChangeBusy(false)
    }
  }
  const mutateWorktree = async (worktreeId: string, action: 'apply' | 'discard'): Promise<void> => {
    if (!taskId || workspaceChangeBusy) return
    setWorkspaceChangeBusy(true)
    try {
      const result = action === 'apply'
        ? await window.onekey.workspace.worktreeApply({ taskId, worktreeId })
        : await window.onekey.workspace.worktreeDiscard({ taskId, worktreeId })
      if (result.ok) {
        setWorkspaceChanges(result.value)
        onNotice(action === 'apply' ? '隔离分支的文件变更已应用。' : '隔离分支已丢弃。')
      } else onNotice(result.error.message)
    } finally {
      setWorkspaceChangeBusy(false)
    }
  }
  const workspaceStatus = !workspaceToken
    ? '将在任务开始时自动准备'
    : environment.state === 'loading' || environment.state === 'idle'
      ? '正在检测工作区'
      : environment.state === 'ready'
        ? environment.clean
          ? '工作区干净'
          : `${environment.changedFiles} 个文件有变更`
        : environment.state === 'not-repository'
          ? '工作区可用，未启用 Git'
          : environment.state === 'unavailable'
            ? '工作区可用，Git 状态暂不可用'
            : '工作区状态读取失败'
  const branchLabel = !workspaceToken
    ? '—'
    : environment.state === 'loading' || environment.state === 'idle'
      ? '正在读取'
      : environment.state === 'ready'
        ? environment.branch || '分离 HEAD'
        : environment.state === 'not-repository'
          ? '非 Git 工作区'
          : environment.state === 'unavailable'
            ? 'Git 状态不可用'
            : '读取失败'
  const environmentDotStatus = runtime.status === 'degraded' || environment.state === 'error'
    ? 'degraded'
    : workspaceToken && (environment.state === 'loading' || environment.state === 'idle')
      ? 'starting'
      : runtime.status
  if (compactWhenIdle && !open) {
    return (
      <aside className="context-inspector is-compact" aria-label="环境信息已收起">
        <button
          type="button"
          className="context-rail-button"
          aria-label="展开环境信息"
          title="环境信息"
          onClick={onOpen}
        >
          <PanelRight size={16} aria-hidden="true" />
          <span className={`environment-status-dot ${environmentDotStatus}`} aria-hidden="true" />
        </button>
      </aside>
    )
  }
  return (
    <aside className={`context-inspector ${open ? 'is-open' : ''} ${compactWhenIdle ? 'was-compact' : ''}`} aria-label="环境信息">
      <div className="inspector-panel">
        <header className="inspector-header">
          <div className="inspector-title">
            <strong>环境信息</strong>
            <span
              className={`environment-status-dot ${environmentDotStatus}`}
              title={environment.message || workspaceStatus}
              aria-label={workspaceStatus}
            />
          </div>
          <div className="inspector-header-actions">
            {previewExample && <IconButton label="添加来源" icon={Plus} onClick={() => onOpenDock('files')} />}
            <IconButton label="关闭环境信息" icon={X} onClick={onClose} className="drawer-close" />
          </div>
        </header>

        <div className="inspector-scroll">
          {previewExample || workspaceToken ? <section className="environment-card-section environment-git-section">
            <div className="change-summary">
              <span><GitCompareArrows size={15} />变更</span>
              {previewExample
                ? <strong><b>+1,665</b> <em>-8</em></strong>
                : !workspaceToken
                  ? <small>未选择工作区</small>
                  : environment.state === 'loading' || environment.state === 'idle'
                    ? <small>正在读取</small>
                    : environment.state === 'ready'
                      ? environment.clean
                        ? <small>无变更</small>
                        : <strong title={`${environment.changedFiles} 个变更文件`}><span>{environment.changedFiles} 个文件</span><b>+{environment.additions}</b><em>-{environment.deletions}</em></strong>
                      : environment.state === 'not-repository'
                        ? <small>非 Git 工作区</small>
                        : environment.state === 'unavailable'
                          ? <small>Git 状态不可用</small>
                          : <small title={environment.message}>读取失败</small>}
            </div>
            <dl className="info-list">
              <div><dt><HardDrive size={14} />位置</dt><dd>{previewExample ? '本地工作区' : workspaceName || '未选择工作区'}</dd></div>
              <div><dt><GitBranch size={14} />分支</dt><dd>{previewExample ? 'codex/react-workspace' : branchLabel}</dd></div>
              <div><dt><CircleDot size={14} />状态</dt><dd title={environment.message || workspaceStatus}>{previewExample ? runtimeStatusLabels[runtime.status] : workspaceStatus}</dd></div>
            </dl>
            {previewExample && <div className="inspector-commands">
              <button type="button" onClick={() => onOpenDock('terminal')}><GitBranch size={14} />提交或推送</button>
              <button type="button" onClick={() => onOpenDock('diff')}><GitCompareArrows size={14} />比较分支</button>
            </div>}
          </section> : <section className="environment-card-section environment-empty-card">
            <span className="environment-empty-icon"><HardDrive size={18} aria-hidden="true" /></span>
            <div>
              <strong>{mode === 'agent' ? '工作目录会自动准备' : '环境信息会随对话更新'}</strong>
              <p>{mode === 'agent'
                ? '发送任务后，这里会显示文件变更、版本记录和子智能体进度。'
                : '联网来源和回复依据会在产生后显示在这里。'}</p>
            </div>
            <span className={`environment-runtime-pill ${runtime.status}`}>
              <i />{runtime.status === 'degraded' ? '桌面服务需要检查' : '桌面服务已就绪'}
            </span>
          </section>}

          {mode === 'agent' && taskId && workspaceToken && !previewExample && <section className="environment-card-section workspace-version-section">
            <div className="environment-section-title">
              <span><GitBranch size={15} />文件版本</span>
              <button
                type="button"
                className="workspace-version-add"
                title="创建检查点"
                aria-label="创建检查点"
                disabled={workspaceChangeBusy || !workspaceToken}
                onClick={() => void createWorkspaceCheckpoint()}
              ><Plus size={14} /></button>
            </div>
            {!workspaceChanges
              ? <p className="compact-empty">正在读取文件版本</p>
              : workspaceChanges.checkpoints.length === 0 && workspaceChanges.worktrees.length === 0
                ? <p className="compact-empty">还没有检查点或隔离分支</p>
                : <div className="workspace-version-list">
                    {workspaceChanges.checkpoints.slice(0, 3).map((checkpoint) => (
                      <div className="workspace-version-row" key={checkpoint.id}>
                        <span><strong>{checkpoint.label}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()}</small></span>
                        <button
                          type="button"
                          title={`回退到 ${checkpoint.label}`}
                          aria-label={`回退到 ${checkpoint.label}`}
                          disabled={workspaceChangeBusy}
                          onClick={() => void rewindWorkspace(checkpoint.id, checkpoint.label)}
                        ><RotateCcw size={13} /></button>
                      </div>
                    ))}
                    {workspaceChanges.worktrees.slice(0, 3).map((worktree) => (
                      <div className="workspace-version-row worktree" key={worktree.id}>
                        <span>
                          <strong>{worktree.kind === 'git-worktree' ? 'Git 隔离分支' : '独立工作副本'}</strong>
                          <small>{worktree.status === 'ready'
                            ? worktree.changedFiles === null ? '可应用' : `${worktree.changedFiles} 个文件变更`
                            : worktree.status === 'applied' ? '已应用' : worktree.status === 'discarded' ? '已丢弃' : '目录不可用'}</small>
                        </span>
                        <div>
                          {worktree.status === 'ready' && <button
                            type="button"
                            title="应用文件变更"
                            aria-label="应用文件变更"
                            disabled={workspaceChangeBusy}
                            onClick={() => void mutateWorktree(worktree.id, 'apply')}
                          ><Check size={13} /></button>}
                          {worktree.status !== 'discarded' && <button
                            type="button"
                            title="丢弃隔离分支"
                            aria-label="丢弃隔离分支"
                            disabled={workspaceChangeBusy}
                            onClick={() => void mutateWorktree(worktree.id, 'discard')}
                          ><X size={13} /></button>}
                        </div>
                      </div>
                    ))}
                  </div>}
          </section>}

          {mode === 'agent' && <section className="environment-card-section">
            <div className="environment-section-title">
              <span><Users size={15} />子智能体</span>
              <small>{subagentStatus}</small>
            </div>
            <p className="compact-empty">{subagentDetail}</p>
          </section>}

          <section className="environment-card-section environment-sources-section">
            <div className="environment-section-title">
              <span><Link2 size={15} />来源</span>
              <small>{previewExample ? '3' : String(sources.length)}</small>
            </div>
            {previewExample ? <div className="source-list">
              <button type="button" onClick={() => onOpenDock('files')}><FileText size={15} /><span><strong>electron-workspace-spec.md</strong><small>界面示例 · 未读取</small></span></button>
              <button type="button" onClick={() => onOpenDock('files')}><FileCode2 size={15} /><span><strong>window_workspace.py</strong><small>界面示例 · 未读取</small></span></button>
              <button type="button" onClick={() => onOpenDock('files')}><Globe2 size={15} /><span><strong>Electron Security</strong><small>链接示例 · 未访问</small></span></button>
            </div> : sources.length > 0 ? <div className="source-list live-source-list">
              {sources.map((source) => (
                <div className="environment-source-row" key={source.url} title={source.url}>
                  <Globe2 size={15} aria-hidden="true" />
                  <span>
                    <strong>{source.title}</strong>
                    <small>{source.title === source.hostname ? '网页来源' : source.hostname}</small>
                  </span>
                </div>
              ))}
            </div> : <p className="compact-empty">{mode === 'chat' ? '联网来源会在回复后显示' : '本轮回复没有可展示的联网来源'}</p>}
            {previewExample && <button type="button" className="view-all-sources" onClick={() => onOpenDock('files')}>
              <Link2 size={14} />
              <span>查看全部</span>
              <ChevronRight size={14} />
            </button>}
          </section>
        </div>
      </div>
    </aside>
  )
}

function TerminalPane({ workspaceToken }: { workspaceToken: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const terminalIdRef = useRef('')

  useEffect(() => {
    if (!containerRef.current || !('onekey' in window)) return
    let disposed = false
    // Teardown steps are registered as the terminal comes up so an unmount that
    // races the asynchronous start still releases everything already created.
    const teardown: Array<() => void> = []
    const release = (): void => {
      while (teardown.length > 0) teardown.pop()!()
    }

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      if (disposed || !containerRef.current) return

      const term = new Terminal({
        fontSize: 13,
        fontFamily: 'var(--font-mono), monospace',
        theme: { background: '#1e2124', foreground: '#d8dde3', cursor: '#61afef' },
        cursorBlink: true,
        scrollback: 5000,
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      fitAddon.fit()
      termRef.current = term

      const result = await window.onekey.terminal.start({
        workspaceToken,
        columns: term.cols,
        rows: term.rows,
      })
      if (!result.ok) {
        if (!disposed) term.write(`\r\n终端启动失败: ${result.error.message}\r\n`)
        return
      }
      const terminalId = result.value.terminalId
      // The PTY is already live in main even though this pane unmounted while
      // the start was in flight; stop it instead of orphaning a shell process.
      if (disposed) {
        void window.onekey.terminal.stop({ terminalId })
        return
      }
      terminalIdRef.current = terminalId

      const unsubscribe = window.onekey.onAgentEvent((event) => {
        if (event.type === 'terminal-output' && event.terminalId === terminalIdRef.current) {
          term.write(event.data)
        }
      })
      teardown.push(unsubscribe)

      term.onData((data) => {
        if (terminalIdRef.current) {
          void window.onekey.terminal.input({ terminalId: terminalIdRef.current, data })
        }
      })

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit()
        if (terminalIdRef.current) {
          void window.onekey.terminal.resize({
            terminalId: terminalIdRef.current,
            columns: term.cols,
            rows: term.rows,
          })
        }
      })
      if (containerRef.current) resizeObserver.observe(containerRef.current)
      teardown.push(() => resizeObserver.disconnect())
    }

    void initTerminal()

    return () => {
      disposed = true
      release()
      if (terminalIdRef.current) {
        void window.onekey?.terminal.stop({ terminalId: terminalIdRef.current })
        terminalIdRef.current = ''
      }
      termRef.current?.dispose()
      termRef.current = null
    }
  }, [workspaceToken])

  return <div ref={containerRef} className="terminal-pane xterm-container" />
}


function PreviewPane() {
  const [url, setUrl] = useState('')
  const [loadedUrl, setLoadedUrl] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState('')

  const loadUrl = (target: string): void => {
    const trimmed = target.trim()
    if (!trimmed) return
    const normalized = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
    try {
      new URL(normalized)
      setLoadedUrl(normalized)
      setError('')
    } catch {
      setError('无效的 URL')
    }
  }

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        <input
          type="text"
          className="preview-url-input"
          placeholder="localhost:3000"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') loadUrl(url) }}
        />
        <button type="button" className="preview-go-btn" onClick={() => loadUrl(url)}>加载</button>
        {loadedUrl && (
          <button type="button" className="preview-reload-btn" onClick={() => setReloadKey((value) => value + 1)} title="刷新">↻</button>
        )}
      </div>
      {error && <div className="preview-error">{error}</div>}
      {loadedUrl ? (
        /* allow-scripts 与 allow-same-origin 同时开启时，被嵌页面可以移除自己
           的沙箱属性，等于没有沙箱。预览面板加载任意 URL，必须二选一。 */
        <iframe
          key={`${loadedUrl}:${reloadKey}`}
          className="preview-iframe"
          src={loadedUrl}
          sandbox="allow-scripts allow-forms allow-popups"
          title="实时预览"
        />
      ) : (
        <div className="dock-empty-state">输入本地开发服务器地址（如 localhost:5173）查看实时预览</div>
      )}
    </div>
  )
}

function WorkbenchDock({
  active,
  previewExample,
  workspaceToken,
  taskId,
  gitBase,
  onChange,
  onClose,
  height,
  onHeightChange,
}: {
  active: DockTab
  previewExample: boolean
  workspaceToken: string
  taskId: string
  gitBase: 'current' | 'main'
  onChange: (tab: DockTab) => void
  onClose: () => void
  height: number
  onHeightChange: (height: number) => void
}) {
  const tabs: Array<{ id: DockTab; label: string; icon: LucideIcon }> = [
    { id: 'terminal', label: '终端', icon: SquareTerminal },
    { id: 'diff', label: '审查', icon: FileDiff },
    { id: 'files', label: '文件', icon: FileCode2 },
    { id: 'preview', label: '预览', icon: Globe2 },
  ]
  // Terminal and preview stay mounted once visited so switching tabs does not
  // kill the live shell or reload the previewed page. They still start lazily,
  // and closing the whole dock (unmounting it) deliberately ends the session.
  const [visitedTerminal, setVisitedTerminal] = useState(active === 'terminal')
  const [visitedPreview, setVisitedPreview] = useState(active === 'preview')
  useEffect(() => {
    if (active === 'terminal') setVisitedTerminal(true)
    if (active === 'preview') setVisitedPreview(true)
  }, [active])
  return (
    <section className="workbench-dock" aria-label="工作台" style={{ '--workspace-dock-height': `${height}px` } as CSSProperties}>
      <div
        className="workspace-resize-handle vertical"
        role="separator"
        aria-label="调整工作台高度"
        aria-orientation="horizontal"
        aria-valuemin={168}
        aria-valuemax={520}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(event) => beginPointerResize({ event, axis: 'vertical', startSize: height, direction: -1, onResize: onHeightChange })}
        onKeyDown={(event) => resizeFromKeyboard({ event, axis: 'vertical', currentSize: height, direction: -1, onResize: onHeightChange })}
      />
      <header className="dock-header">
        <div className="dock-tabs" role="tablist">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active === tab.id}
                className={active === tab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => onChange(tab.id)}
              >
                <Icon size={14} aria-hidden="true" />{tab.label}
              </button>
            )
          })}
        </div>
        <div className="dock-actions">
          <IconButton label="关闭工作台" icon={X} onClick={onClose} />
        </div>
      </header>
      <div className="dock-body">
        {visitedTerminal && (
          <div className="dock-keepalive" hidden={active !== 'terminal'}>
            <TerminalPane workspaceToken={workspaceToken} />
          </div>
        )}
        {(active === 'diff' || active === 'files') && <ChangeReviewCenter initialMode={active === 'diff' ? 'changes' : 'files'} key={active} workspaceToken={workspaceToken} taskId={taskId} gitBase={gitBase} />}
        {visitedPreview && (
          <div className="dock-keepalive" hidden={active !== 'preview'}>
            <PreviewPane />
          </div>
        )}
      </div>
    </section>
  )
}

function GroupMenu({
  selected,
  groups,
  onSelect,
}: {
  selected: string
  groups: readonly RelayGroupOption[]
  onSelect: (groupId: string) => void
}) {
  return (
    <div className="popover group-popover" role="menu" aria-label="接入分组">
      <div className="popover-heading"><span>接入分组</span><small>{groups.length} 个可用</small></div>
      <div className="menu-list group-list">
        {groups.map((group) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={group.id === selected}
            key={group.id}
            onClick={() => onSelect(group.id)}
            className={group.id === selected ? 'selected' : ''}
          >
            <GitBranch size={14} />
            <span>
              <strong>{group.id}</strong>
              <small>{group.description || (group.id === 'auto' ? '自动选择渠道' : '可用接入分组')}</small>
            </span>
            {group.id === selected && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  )
}

function ModelMenu({
  selectedId,
  catalog,
  groupId,
  onSelect,
}: {
  selectedId: string
  catalog: readonly ModelOption[]
  groupId: string
  onSelect: (modelId: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = catalog.filter((model) => `${model.name} ${model.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return (
    <div className="popover model-popover" role="dialog" aria-label="选择模型">
      <div className="popover-search"><Search size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 API 模型" /></div>
      <div className="model-catalog-meta"><span>可用模型</span><small>{groupId || '直连渠道'} · {catalog.length} 个</small></div>
      <div className="menu-list">
        {filtered.map((model) => (
          <button type="button" key={model.id} onClick={() => onSelect(model.id)} className={model.id === selectedId ? 'selected' : ''}>
            <span><strong>{model.name}</strong><small>{model.detail}</small></span>
            {model.id === selectedId && <Check size={15} />}
          </button>
        ))}
      </div>
      {filtered.length === 0 && <p className="popover-empty">没有匹配的模型</p>}
    </div>
  )
}

function ReasoningMenu({
  selected,
  options,
  onSelect,
}: {
  selected: ReasoningOption['effort']
  options: readonly ReasoningOption[]
  onSelect: (reasoning: ReasoningOption['effort']) => void
}) {
  return (
    <div className="popover compact-popover reasoning-popover" role="menu" aria-label="推理强度">
      <div className="popover-heading"><span>推理强度</span><small>用于下一轮</small></div>
      <div className="menu-list dense">
        {options.map((option) => (
          <button type="button" role="menuitemradio" aria-checked={selected === option.effort} key={option.effort} onClick={() => onSelect(option.effort)} className={selected === option.effort ? 'selected' : ''}>
            <span>{option.label}</span>{selected === option.effort && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  )
}

function PermissionMenu({ selected, onSelect }: { selected: Permission; onSelect: (permission: Permission) => void }) {
  return (
    <div className="popover permission-popover" role="menu" aria-label="操作权限">
      <div className="popover-heading"><span>操作权限</span><small>{selected === 'full' ? '系统范围' : '当前工作区'}</small></div>
      <div className="menu-list permission-list">
        {permissionOptions.map((option) => {
          const Icon = option.icon
          return (
            <button type="button" role="menuitemradio" aria-checked={selected === option.id} key={option.id} onClick={() => onSelect(option.id)} className={`${selected === option.id ? 'selected' : ''} ${option.id === 'full' ? 'full-access' : ''}`}>
              <Icon size={16} />
              <span><strong>{option.name}</strong><small>{option.detail}</small></span>
              {selected === option.id && <Check size={14} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface QueuedComposerMessage {
  readonly id: number
  readonly text: string
}

const MAX_QUEUED_MESSAGES = 10

function Composer({
  modelSelection,
  modelSelectionActions,
  composer,
  composerActions,
  permission,
  onPermissionChange,
  endpoint,
  endpointConfirmed,
  readOnlyMessage,
  running,
  disabled,
  onSubmit,
  onStop,
  canContinueInBackground,
  backgrounding,
  onContinueInBackground,
  sessionTokens,
  queuedMessages,
  onQueueMessage,
  onRemoveQueuedMessage,
}: {
  modelSelection: ModelSelectionSnapshot
  modelSelectionActions: ModelSelectionActions
  composer: ComposerCapabilitiesSnapshot
  composerActions: ComposerCapabilitiesActions
  permission: Permission
  onPermissionChange: (permission: Permission) => void
  endpoint: string
  endpointConfirmed: boolean
  readOnlyMessage: string
  running: boolean
  disabled: boolean
  onSubmit: () => Promise<boolean>
  onStop: () => Promise<void>
  canContinueInBackground: boolean
  backgrounding: boolean
  onContinueInBackground: () => Promise<void>
  sessionTokens: number
  queuedMessages: readonly QueuedComposerMessage[]
  onQueueMessage: (text: string) => void
  onRemoveQueuedMessage: (id: number) => void
}) {
  const readOnly = Boolean(readOnlyMessage)
  const mode = modelSelection.mode
  const groupId = modelSelection.groupId
  const groups = modelSelection.groups
  const model = modelSelection.selectedModel?.name ?? ''
  const modelId = modelSelection.selectedModel?.id ?? ''
  const modelCatalog = modelSelection.models
  const reasoning = modelSelection.reasoning
  const web = modelSelection.capabilities.webSearch
  const image = modelSelection.capabilities.imageGeneration
  const imagesOnly = image.locked
  const modelCompatibilityNotice = modelSelection.capabilities.notice
  const draft = composer.draft
  const attachments = composer.attachments
  const preparing = composer.submitting && !running
  const busy = running || composer.submitting || disabled
  const [menu, setMenu] = useState<OpenMenu>(null)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [capabilityPaletteState, setCapabilityPaletteState] = useState<{
    expanded: boolean
    activeDescendant?: string
  }>({ expanded: false })
  const capabilityPaletteId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historySessionRef = useRef<ComposerHistorySession | null>(null)
  const dragDepthRef = useRef(0)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])

  // Auto-grow: the height tracks the content while the CSS min/max clamps do
  // the actual bounding, so long drafts fall back to inner scrolling.
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  const permissionOption = permissionOptions.find((item) => item.id === permission) ?? permissionOptions[0]!
  const PermissionIcon = permissionOption.icon
  const shortGroup = groupId || '接入分组'
  const shortModel = model.replace('GPT-', '').replace('gpt-', '') || '选择模型'

  const recallHistory = (event: KeyboardEvent<HTMLTextAreaElement>, direction: 'older' | 'newer'): boolean => {
    const session = historySessionRef.current
    const navigating = session !== null && draft === session.recalled
    if (!navigating) {
      // ArrowUp starts a recall only from an empty draft, so the arrows keep
      // their caret behavior while the user is editing real text.
      if (direction === 'newer' || draft !== '') {
        historySessionRef.current = null
        return false
      }
      const fresh = beginComposerHistorySession(draft)
      if (!fresh) return false
      historySessionRef.current = fresh
      const step = stepComposerHistory(fresh, 'older')
      if (!step) return false
      event.preventDefault()
      composerActions.setDraft(step.draft)
      return true
    }
    const step = stepComposerHistory(session, direction)
    event.preventDefault()
    if (!step) return true
    composerActions.setDraft(step.draft)
    if (step.done) historySessionRef.current = null
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
      && !capabilityPaletteState.expanded
    ) {
      if (recallHistory(event, event.key === 'ArrowUp' ? 'older' : 'newer')) return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (running && !readOnly && !disabled && !preparing) {
        const text = draft.trim()
        if (!text) return
        onQueueMessage(text)
        composerActions.setDraft('')
        return
      }
      void onSubmit()
    }
  }

  const dataTransferHasFiles = (transfer: globalThis.DataTransfer | null): boolean =>
    Array.from(transfer?.types ?? []).includes('Files')

  const handleDroppedFiles = (transfer: globalThis.DataTransfer | null): void => {
    const files = Array.from(transfer?.files ?? [])
    if (files.length === 0) return
    if (readOnly || busy) {
      composerActions.setNotice('当前不能添加附件，请等待本轮回答结束。')
      return
    }
    if (imagesOnly) {
      composerActions.setNotice('当前图片模型不接收对话附件；参考图或图片编辑请转到 Studio。')
      return
    }
    if ('onekey' in window) {
      void window.onekey.dialog.registerDroppedFiles(files).then((result) => {
        if (!result.ok) {
          composerActions.setNotice(result.error.message)
          return
        }
        if (result.value.length === 0) return
        composerActions.addTokenAttachments(result.value.map((attachment) => ({
          ...attachment,
          sizeLabel: '拖入文件',
        })))
      }).catch(() => {
        composerActions.setNotice('拖入附件未完成，请重试。')
      })
      return
    }
    composerActions.addLocalAttachments(files.map((file) => ({
      name: file.name,
      byteLength: file.size,
      mediaKind: file.type.startsWith('image/') ? 'image' : 'text',
    })))
  }

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    handleDroppedFiles(event.dataTransfer)
  }

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (imagesOnly) {
      event.target.value = ''
      composerActions.setNotice('当前图片模型不接收对话附件；参考图或图片编辑请转到 Studio。')
      return
    }
    composerActions.addLocalAttachments(Array.from(event.target.files ?? []).map((file) => ({
      name: file.name,
      byteLength: file.size,
      mediaKind: file.type.startsWith('image/') ? 'image' : 'text',
    })))
    event.target.value = ''
  }

  const selectAttachments = (): void => {
    if (imagesOnly) {
      composerActions.setNotice('当前图片模型不接收对话附件；参考图或图片编辑请转到 Studio。')
      return
    }
    if (!('onekey' in window)) {
      fileInputRef.current?.click()
      return
    }
    void composerActions.selectAttachments()
  }

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${dragActive ? 'is-dragover' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="composer-input-surface">
          {dragActive && (
            <div className="composer-drop-overlay" aria-hidden="true">
              <Paperclip size={15} />
              <span>松开以添加附件</span>
            </div>
          )}
          {readOnly && (
            <div className="archived-composer-notice" role="status">
              <Archive size={14} aria-hidden="true" />
              <span>{readOnlyMessage}</span>
            </div>
          )}
          {queuedMessages.length > 0 && (
            <div className="queued-message-list" role="list" aria-label="排队消息">
              {queuedMessages.map((message) => (
                <div className="queued-message-row" role="listitem" key={message.id}>
                  <span className="queued-message-icon"><Clock3 size={13} aria-hidden="true" /></span>
                  <span className="queued-message-text" title={message.text}>{message.text}</span>
                  <IconButton
                    label="移除排队消息"
                    icon={X}
                    onClick={() => onRemoveQueuedMessage(message.id)}
                  />
                </div>
              ))}
              <small className="queued-message-hint">当前回合结束后将按顺序自动发送</small>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attachment-list">
              {attachments.map((attachment) => (
                <div className="attachment-row" key={attachment.id}>
                  <span className="attachment-icon">{attachment.image ? <ImagePlus size={16} /> : <FileText size={16} />}</span>
                  <span><strong>{attachment.name}</strong><small>{attachment.image ? '图片' : '本地文件'} · {attachment.sizeLabel}</small></span>
                  <IconButton label={`移除 ${attachment.name}`} icon={X} disabled={busy} onClick={() => composerActions.removeAttachment(attachment.id)} />
                </div>
              ))}
            </div>
          )}

          <div className="composer-input-row">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => composerActions.setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const hasImage = Array.from(event.clipboardData?.items ?? []).some(
                  (item) => item.type.startsWith('image/')
                )
                if (!hasImage || readOnly || busy) return
                event.preventDefault()
                if ('onekey' in window) {
                  void window.onekey.dialog.pasteImage().then((result) => {
                    if (!result.ok || result.value.length === 0) return
                    composerActions.addTokenAttachments(result.value.map((attachment) => ({
                      ...attachment,
                      sizeLabel: '剪贴板图片',
                    })))
                  })
                } else {
                  const files = Array.from(event.clipboardData?.files ?? []).filter(
                    (f) => f.type.startsWith('image/')
                  )
                  if (files.length > 0) {
                    composerActions.addLocalAttachments(files.map((f, i) => ({
                      name: `clipboard-image-${Date.now()}-${i}.png`,
                      byteLength: f.size,
                      mediaKind: 'image' as const,
                    })))
                  }
                }
              }}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              placeholder={readOnly
                ? '只读历史'
                : running
                  ? '回答生成中，输入的消息将排队发送…'
                  : mode === 'agent'
                    ? '描述要在当前工作区完成的任务…'
                    : '发送消息，或添加文件和图片…'}
              rows={1}
              disabled={readOnly || disabled || composer.submitting}
              data-capability-input="true"
              aria-autocomplete="list"
              aria-controls={capabilityPaletteId}
              aria-expanded={capabilityPaletteState.expanded}
              aria-haspopup="listbox"
              aria-activedescendant={capabilityPaletteState.activeDescendant}
              aria-label="消息"
            />
            <CapabilityPalette
              palette={composer.palette}
              listId={capabilityPaletteId}
              onChoose={(key) => { void composerActions.choosePaletteItem(key) }}
              onMove={composerActions.movePalette}
              onHighlight={composerActions.highlightPaletteItem}
              onDismiss={composerActions.dismissPalette}
              onReopen={composerActions.reopenPalette}
              onStateChange={setCapabilityPaletteState}
              disabled={busy || readOnly}
            />
            <div className="composer-run-actions">
              {canContinueInBackground && (
                <button
                  type="button"
                  className="background-turn-button"
                  aria-label="转到后台继续"
                  data-tooltip="转到后台继续"
                  title="转到后台继续"
                  onClick={() => { void onContinueInBackground() }}
                  disabled={backgrounding}
                >
                  {backgrounding ? <LoaderCircle className="spin" size={15} /> : <Minimize2 size={16} />}
                </button>
              )}
              <button
                type="button"
                className={`send-button ${running ? 'is-running' : ''} ${preparing ? 'is-preparing' : ''}`}
                aria-label={running ? '停止生成' : preparing ? '正在准备' : '发送'}
                data-tooltip={running ? '停止生成' : preparing ? '正在准备' : '发送'}
                onClick={running ? () => void onStop() : () => void onSubmit()}
                disabled={readOnly || disabled || preparing || backgrounding || (!running && !draft.trim() && attachments.length === 0)}
              >
                {running
                  ? <Square size={14} fill="currentColor" />
                  : preparing
                    ? <LoaderCircle className="spin" size={16} />
                    : <ArrowUp size={18} />}
              </button>
            </div>
          </div>

        </div>

        {modelCompatibilityNotice && (
          <div className="model-compatibility-notice" role="status">
            <ShieldAlert size={13} aria-hidden="true" />
            <span>{modelCompatibilityNotice}</span>
          </div>
        )}

        <div className="composer-toolbar composer-meta-bar">
          <div className="composer-tools">
            <input ref={fileInputRef} type="file" multiple hidden onChange={addFiles} accept="image/png,image/jpeg,image/webp,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.rs" />
            <IconButton
              label={imagesOnly ? '当前图片模型不接收附件；参考图或编辑请使用 Studio' : '添加文件或图片'}
              icon={Paperclip}
              disabled={readOnly || busy || imagesOnly}
              onClick={selectAttachments}
            />
            <IconButton
              label={web.available
                ? web.enabled ? '关闭联网' : '开启联网'
                : '当前模型不支持联网搜索'}
              icon={Globe2}
              pressed={web.enabled}
              disabled={readOnly || busy || !web.available}
              onClick={() => modelSelectionActions.setCapability('webSearch', !web.enabled)}
            />
            <IconButton
              label={imagesOnly
                ? '当前图片模型固定开启图片生成'
                : image.available
                  ? image.enabled ? '关闭图片生成' : '开启图片生成'
                : '当前模型不支持图片生成'}
              icon={ImagePlus}
              pressed={image.enabled}
              disabled={readOnly || busy || imagesOnly || !image.available}
              onClick={() => modelSelectionActions.setCapability('imageGeneration', !image.enabled)}
            />
            <div className="selector-anchor connection-anchor">
              <IconButton
                label={endpointConfirmed ? '连接正常，查看详情' : '连接尚未就绪，查看详情'}
                icon={endpointConfirmed ? ShieldCheck : ShieldAlert}
                pressed={menu === 'connection'}
                onClick={() => setMenu((current) => current === 'connection' ? null : 'connection')}
              />
              {menu === 'connection' && (
                <div className="popover connection-popover" role="dialog" aria-label="连接详情">
                  <div className="connection-popover-heading">
                    <span className={endpointConfirmed ? 'is-ready' : 'needs-attention'}><Server size={16} aria-hidden="true" /></span>
                    <div>
                      <strong>连接详情</strong>
                      <small>{endpointConfirmed ? '模型服务已就绪' : '发送前会再次检查连接'}</small>
                    </div>
                  </div>
                  <dl className="connection-detail-list">
                    <div><dt>状态</dt><dd>{endpointConfirmed ? '可用' : '尚未就绪'}</dd></div>
                    <div><dt>服务地址</dt><dd title={endpoint}>{endpoint}</dd></div>
                  </dl>
                </div>
              )}
            </div>
          </div>

          <div className="composer-selectors">
            {mode === 'agent' && (
              <div className="selector-anchor permission-anchor">
                <button
                  type="button"
                  className={`selector-button permission-button ${permission === 'full' ? 'warning' : ''}`}
                  onClick={() => setMenu((current) => current === 'permission' ? null : 'permission')}
                  aria-expanded={menu === 'permission'}
                  disabled={busy}
                >
                  <PermissionIcon size={14} />
                  <span>{permissionOption.name}</span>
                  <ChevronDown size={12} />
                </button>
                {menu === 'permission' && (
                  <PermissionMenu
                    selected={permission}
                    onSelect={(value) => {
                      setMenu(null)
                      if (value === 'full') setConfirmFullAccess(true)
                      else onPermissionChange(value)
                    }}
                  />
                )}
              </div>
            )}

            {groups.length > 0 && (
              <div className="selector-anchor group-anchor">
                <button
                  type="button"
                  className="selector-button group-button"
                  onClick={() => setMenu((current) => current === 'group' ? null : 'group')}
                  aria-expanded={menu === 'group'}
                  aria-label={`接入分组：${shortGroup}`}
                  title={`接入分组：${shortGroup}`}
                  disabled={busy}
                >
                  <GitBranch size={14} />
                  <span>{shortGroup}</span>
                  <ChevronDown size={12} />
                </button>
                {menu === 'group' && (
                  <GroupMenu
                    selected={groupId}
                    groups={groups}
                    onSelect={(value) => {
                      if (!busy) void modelSelectionActions.selectGroup(value)
                      setMenu(null)
                    }}
                  />
                )}
              </div>
            )}

            <div className="selector-anchor model-anchor">
              <button type="button" className="selector-button model-button" onClick={() => setMenu((current) => current === 'model' ? null : 'model')} aria-expanded={menu === 'model'} title={model || '选择模型'} disabled={busy}>
                <span>{shortModel}</span><ChevronDown size={12} />
              </button>
              {menu === 'model' && <ModelMenu selectedId={modelId} catalog={modelCatalog} groupId={groupId} onSelect={(value) => { modelSelectionActions.selectModel(value); setMenu(null) }} />}
            </div>

            <div className="selector-anchor reasoning-anchor">
              {reasoning.notice && <span className="degraded-indicator" title={reasoning.notice}>已降级</span>}
              <button type="button" className="selector-button reasoning-button" onClick={() => setMenu((current) => current === 'reasoning' ? null : 'reasoning')} aria-expanded={menu === 'reasoning'} disabled={busy}>
                <WandSparkles size={14} /><span>{reasoning.label}</span><ChevronDown size={12} />
              </button>
              {menu === 'reasoning' && <ReasoningMenu selected={reasoning.effort} options={reasoning.options} onSelect={(value) => { modelSelectionActions.selectReasoning(value); setMenu(null) }} />}
            </div>

            {sessionTokens > 0 && (
              <span className="token-usage-badge" title={`本次会话累计 Token 用量`}>
                {sessionTokens >= 1000 ? `${(sessionTokens / 1000).toFixed(1)}k` : sessionTokens} tokens
              </span>
            )}
          </div>
        </div>

        {confirmFullAccess && createPortal(
          <div className="modal-scrim" role="presentation" onMouseDown={() => setConfirmFullAccess(false)}>
            <div
              className="access-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="full-access-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="access-confirm-icon"><ShieldAlert size={18} /></div>
              <div>
                <strong id="full-access-title">为下一轮开启系统完全访问？</strong>
                <p>Agent 可直接访问工作区外的系统文件并运行系统命令，不再逐项确认。当前工作区仅作为默认操作目录；切换工作区只会改变默认目录。</p>
              </div>
              <div className="access-confirm-actions">
                <button type="button" onClick={() => setConfirmFullAccess(false)}>取消</button>
                <button
                  type="button"
                  className="confirm-full"
                  onClick={() => {
                    onPermissionChange('full')
                    setConfirmFullAccess(false)
                  }}
                >
                  开启系统完全访问
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [electronRenderer] = useState(() => hasElectronBridge())
  const previewRenderer = !electronRenderer && uiPreviewHarnessEnabled
  const conversationRuntime = electronRenderer ? 'desktop' : previewRenderer ? 'preview' : 'disconnected'
  const {
    snapshot: modelSelection,
    actions: modelSelectionActions,
    getCurrentSnapshot: getCurrentModelSelection,
  } = useModelSelection({
    runtime: conversationRuntime,
  })
  const {
    snapshot: conversation,
    actions: conversationActions,
    elapsedSeconds: turnElapsedSeconds,
  } = useConversationSession({
    runtime: conversationRuntime,
    initialMode: modelSelection.mode,
    onModeChange: (nextMode) => { void modelSelectionActions.selectMode(nextMode) },
  })
  const backgroundTasks = useBackgroundTasks(conversationRuntime)
  const workspaceLayout = useWorkspaceLayout()
  const mode = modelSelection.mode
  const selectedRelayGroupId = modelSelection.groupId
  const modelCatalog = modelSelection.models
  const selectedModel = modelSelection.selectedModel
  const relayAccountNameValue = modelSelection.accountName
  const modelCatalogState = modelSelection.catalog.state
  const modelCatalogMessage = modelSelection.catalog.message
  const reasoning = modelSelection.reasoning
  const webSearchSelection = modelSelection.capabilities.webSearch
  const imageGenerationSelection = modelSelection.capabilities.imageGeneration
  const localSubagentsSelection = modelSelection.capabilities.localSubagents
  const taskGroups = conversation.taskGroups
  const selectedTask = conversation.selectedTaskId
  const title = conversation.title
  const running = conversation.running
  const turnActivity = conversation.activity
  const conversationMessages = conversation.messages
  const agentExecutionTracks = conversation.executionTracks
  const generatedImages = conversation.generatedImages
  const turnMessage = conversation.notice
  const pendingApproval = conversation.pendingApproval
  const resolvingApproval = conversation.resolvingApproval
  const historyActionTaskId = conversation.historyActionTaskId
  const historyDeleteError = conversation.historyError
  const selectedTaskArchived = conversation.selectedTaskArchived
  const selectedTaskReadOnly = conversation.selectedTaskReadOnly
  const selectedTaskCanImport = selectedTaskReadOnly && taskGroups
    .flatMap((group) => group.tasks)
    .some((task) => task.id === selectedTask && task.source !== undefined && task.source.provider !== 'other')
  const contextSummary = conversation.contextSummary
  const resumableAgentTurn = conversation.resumableAgentTurn
  const sessionTokens = conversation.sessionTokens
  const [surface, setSurface] = useState<AppSurface>('workspace')
  const [userCenterReturnSurface, setUserCenterReturnSurface] = useState<'workspace' | 'settings' | 'studio'>('workspace')
  const [profileHandle, setProfileHandle] = useState('')
  const [profileHasKey, setProfileHasKey] = useState(false)
  const [relayProfileName, setRelayProfileName] = useState('wzh-server')
  const [relayEndpoint, setRelayEndpoint] = useState<string>(WZH_MODEL_BASE_URL)
  const [runtime, setRuntime] = useState<BootstrapPayload['runtime']>(previewRuntime)
  const [permission, setPermissionState] = useState<Permission>(() => resolvePermissionPreference('ask'))
  const [settingsPreferences, setSettingsPreferences] = useState<SettingsPreferences>(readSettingsPreferences)
  const [settingsView, setSettingsView] = useState<SettingsView>('general')
  const [contextOpen, setContextOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [commandCenterOpen, setCommandCenterOpen] = useState(false)
  const [activityCenterOpen, setActivityCenterOpen] = useState(false)
  const [studioActivity, setStudioActivity] = useState<StudioActivitySnapshot>({
    activeCount: 0,
    totalCount: 0,
    label: '当前没有运行任务',
    status: 'idle',
  })
  const [studioRunItems, setStudioRunItems] = useState<readonly StudioRunActivityItem[]>([])
  const [dock, setDock] = useState<DockTab | null>(null)
  const [workspaceToken, setWorkspaceToken] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceOrigin, setWorkspaceOrigin] = useState<AgentWorkspaceOrigin | null>(null)
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false)
  const [workspaceOpeners, setWorkspaceOpeners] = useState<WorkspaceOpenerDescriptor[]>([])
  const [workspaceOpenersDetected, setWorkspaceOpenersDetected] = useState(false)
  const [workspaceOpenerNotice, setWorkspaceOpenerNotice] = useState('')
  const [chatEndpointConfirmed, setChatEndpointConfirmed] = useState(false)
  const [pendingDeleteTask, setPendingDeleteTask] = useState<Task | null>(null)
  const workspaceOpenerDetectionRef = useRef<Promise<WorkspaceOpenerDescriptor[]> | null>(null)
  const workspaceLaunchTokenRef = useRef<string | null>(null)
  const projectInitReturnFocusRef = useRef<HTMLElement | null>(null)
  const projectInitWasOpenRef = useRef(false)
  const workspaceScopeChangingRef = useRef(false)
  const activeWorkspaceTokenRef = useRef(workspaceToken)
  const workspaceRestoreEpochRef = useRef(0)
  const composerHostRef = useRef<{
    prepareLaunch(requestedMode?: WorkspaceMode): Promise<ComposerLaunchPreparation>
    launchTurn(submission: ComposerTurnSubmission): Promise<boolean>
  }>({
    prepareLaunch: async () => ({ ok: false }),
    launchTurn: async () => false,
  })
  const [queuedMessages, setQueuedMessages] = useState<readonly QueuedComposerMessage[]>([])
  const queuedMessagesRef = useRef<readonly QueuedComposerMessage[]>([])
  const queueSequenceRef = useRef(0)
  const queueDrainingRef = useRef(false)
  const blockedQueueIdsRef = useRef<ReadonlySet<number>>(new Set())
  const previousRunningRef = useRef(false)
  const submitComposerRef = useRef<() => Promise<boolean>>(async () => false)
  const {
    snapshot: composer,
    actions: composerActions,
    getCurrentSnapshot: getCurrentComposerSnapshot,
  } = useComposerCapabilities({
    runtime: conversationRuntime,
    workspaceToken,
    attachmentsAllowed: !modelSelection.capabilities.imageGeneration.locked,
    // Main persists the model-generated compaction message in canonical history;
    // do not prepend a second Renderer-owned summary to later turns.
    contextSummary: '',
    userPreamble: [
      settingsPreferences.responseLanguage === 'zh-CN' ? '默认使用简体中文回答。' : '',
      settingsPreferences.customInstructions.trim().slice(0, 2_000),
    ].filter(Boolean).join('\n'),
    prepareLaunch: (requestedMode) => composerHostRef.current.prepareLaunch(requestedMode),
    launchTurn: (submission) => composerHostRef.current.launchTurn(submission),
    compactConversation: () => conversationActions.compact({
      profileHandle: profileHandle || 'preview',
      groupId: modelSelection.groupId || null,
      modelId: modelSelection.selectedModel?.id ?? '',
      reasoning: modelSelection.reasoning.effort,
    }),
  })
  const planMode = composer.session.planMode
  const taskGoal = composer.session.goal
  const capabilityNotice = composer.notice
  const projectInitPreview = composer.projectInit
  const projectInitCommitting = composer.projectInitCommitting
  const selectedSkillMention = composer.selectedSkill
  const selectedPluginMention = composer.selectedPlugin
  const interactionBusy = running || composer.submitting || workspaceSwitching
  const contextInspectorCompact = !previewRenderer
    && !workspaceToken
    && conversationMessages.length === 0

  useEffect(() => onStudioActivity((detail) => {
    setStudioActivity({
      activeCount: detail.activeCount,
      totalCount: detail.totalCount,
      label: detail.label,
      status: detail.status,
    })
    setStudioRunItems(detail.items)
  }), [])

  const surfaceRef = useRef(surface)
  useEffect(() => { surfaceRef.current = surface }, [surface])
  const backgroundStatusRef = useRef<ReadonlyMap<string, BackgroundTaskDto['status']>>(new Map())
  const studioStatusRef = useRef<ReadonlyMap<string, StudioRunActivityItem['status']>>(new Map())

  useEffect(() => {
    const notifications = diffBackgroundTransitions(backgroundStatusRef.current, backgroundTasks.tasks)
    backgroundStatusRef.current = toStatusMap(backgroundTasks.tasks, (task) => task.status)
    for (const notification of notifications) {
      pushToast({
        key: notification.key,
        kind: notification.kind,
        title: notification.title,
        detail: notification.detail,
        actionLabel: '查看',
        onAction: () => setActivityCenterOpen(true),
      })
    }
  }, [backgroundTasks.tasks])

  useEffect(() => {
    const notifications = surfaceRef.current === 'studio'
      ? []
      : diffStudioRunTransitions(studioStatusRef.current, studioRunItems)
    studioStatusRef.current = toStatusMap(studioRunItems, (item) => item.status)
    for (const notification of notifications) {
      pushToast({
        key: notification.key,
        kind: notification.kind,
        title: notification.title,
        detail: notification.detail,
        actionLabel: '查看',
        onAction: () => jumpToStudioPage('queue'),
      })
    }
  }, [studioRunItems])

  useEffect(() => {
    const handleGlobalShortcut = (event: globalThis.KeyboardEvent): void => {
      // The Titlebar registers the same shortcuts; whichever listener runs
      // first must win or a toggle like focus mode fires twice and nets zero.
      if (event.defaultPrevented) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLocaleLowerCase()
      if (key === 'k' && !event.altKey) {
        event.preventDefault()
        setActivityCenterOpen(false)
        setCommandCenterOpen(true)
      } else if (key === 'f' && event.shiftKey && !event.altKey) {
        event.preventDefault()
        workspaceLayout.actions.toggleFocusMode()
      }
    }
    window.addEventListener('keydown', handleGlobalShortcut)
    return () => window.removeEventListener('keydown', handleGlobalShortcut)
  }, [workspaceLayout.actions.toggleFocusMode])

  const setPermission = (next: Permission): void => {
    setPermissionState(next)
    if (workspaceToken) {
      writeWorkspacePermissionPreference(workspaceToken, next)
    } else {
      writePermissionPreference(next)
    }
  }

  useEffect(() => {
    activeWorkspaceTokenRef.current = workspaceToken
    workspaceLaunchTokenRef.current = null
    workspaceOpenerDetectionRef.current = null
    const wsPermission = resolveWorkspacePermissionPreference(workspaceToken, 'ask')
    setPermissionState(wsPermission)
  }, [workspaceToken])

  useEffect(() => {
    if (!('onekey' in window)) return
    let disposed = false
    void window.onekey.app.getBootstrap().then((result) => {
      if (disposed) return
      if (!result.ok) {
        setRuntime({ ...previewRuntime, status: 'degraded', message: '无法读取桌面服务状态。' })
        void modelSelectionActions.initialize({ error: result.error.message })
        return
      }
      setRuntime(result.value.runtime)
      // Main's bootstrap is the authoritative fallback for a fresh profile;
      // an explicit user selection survives renderer reloads through storage.
      const initialPermission = resolvePermissionPreference(result.value.defaults.approvalMode)
      setPermission(initialPermission)
      setProfileHandle(result.value.defaults.activeProfileHandle)
      const activeProfile = result.value.profiles.find((entry) => entry.credentialHandle === result.value.defaults.activeProfileHandle)
      void modelSelectionActions.initialize({
        models: result.value.models,
        activeModelId: result.value.defaults.activeModelId,
        reasoning: result.value.defaults.reasoning,
        profileHandle: result.value.defaults.activeProfileHandle,
        profileHasKey: activeProfile?.hasKey ?? false,
      })
      void conversationActions.initialize({
        projects: result.value.projects,
        activeTaskId: result.value.activeTaskId,
      })
      if (activeProfile) {
        setRelayProfileName(activeProfile.name)
        setRelayEndpoint(activeProfile.baseUrl)
        setProfileHasKey(activeProfile.hasKey)
        // DesktopAuthBoundary renders App only after the signed-in relay
        // session and its fixed endpoint are confirmed for this process.
        setChatEndpointConfirmed(activeProfile.hasKey)
      } else {
        setChatEndpointConfirmed(false)
      }
    }).catch(() => {
      if (disposed) return
      setRuntime({ ...previewRuntime, status: 'degraded', message: '桌面服务初始化未完成。' })
      void modelSelectionActions.initialize({ error: '安全后端初始化未完成，请重启应用后重试。' })
    })
    return () => { disposed = true }
  }, [conversationActions, modelSelectionActions])

  useEffect(() => {
    if (!('onekey' in window)) return
    let lastAttemptAt = 0
    const syncAccountCatalog = (): void => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return
      const now = Date.now()
      // Chromium fires visibilitychange and focus together when the user
      // returns from the token console. Collapse that pair into one request.
      if (now - lastAttemptAt < 1_000) return
      lastAttemptAt = now
      void modelSelectionActions.syncAccount()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') syncAccountCatalog()
    }
    window.addEventListener('focus', syncAccountCatalog)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    const tokenSyncInterval = window.setInterval(syncAccountCatalog, 10_000)
    return () => {
      window.removeEventListener('focus', syncAccountCatalog)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearInterval(tokenSyncInterval)
    }
  }, [modelSelectionActions])

  const refreshModelCatalog = modelSelectionActions.refreshCatalog
  const relayAccountProfile = profileHandle === WZH_RELAY_PROFILE_HANDLE
  const accountDisplayName = relayAccountProfile
    ? relayAccountNameValue || '已登录用户'
    : relayProfileName
  const modelConnected = modelSelection.catalog.connected
  const connectionLabel = modelSelection.catalog.connectionLabel
  const web = webSearchSelection.enabled
  const webSearchAvailable = webSearchSelection.available
  const imageGenerationEnabled = imageGenerationSelection.enabled
  const imageGenerationAvailable = imageGenerationSelection.available
  const imagesOnlyModel = imageGenerationSelection.locked
  const localSubagents = localSubagentsSelection.enabled
  const modelCompatibilityNotice = modelSelection.capabilities.notice

  const closeDrawers = () => {
    setContextOpen(false)
    setTasksOpen(false)
  }

  const clearWorkspaceView = (refreshCapabilities = true): void => {
    workspaceRestoreEpochRef.current += 1
    activeWorkspaceTokenRef.current = ''
    setWorkspaceToken('')
    setWorkspaceName('')
    setWorkspaceOrigin(null)
    setWorkspaceOpeners([])
    setWorkspaceOpenersDetected(false)
    setWorkspaceOpenerNotice('')
    if (refreshCapabilities) void composerActions.changeScope('')
  }

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawers()
    }
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

  const selectTask = (task: Task) => {
    if (interactionBusy) return
    composerActions.resetConversation()
    clearWorkspaceView()
    setTasksOpen(false)
    void conversationActions.activateTask(task)
  }

  const newTask = (nextMode: WorkspaceMode) => {
    if (composer.submitting) return
    if (!conversationActions.newTask(nextMode)) return
    if (workspaceOrigin === 'projectless') clearWorkspaceView()
    composerActions.resetConversation()
    setTasksOpen(false)
  }

  const changeMode = (nextMode: WorkspaceMode) => {
    if (nextMode === mode || interactionBusy) return
    if (selectedTaskReadOnly && selectedTaskCanImport && conversationActions.switchMode(nextMode)) {
      // A provider row is a read-only source until the first send. Retain it
      // across a Chat/Agent switch so that send can import into the target
      // mode instead of silently discarding the visible transcript.
      if (nextMode === 'chat') clearWorkspaceView()
      composerActions.clearNotice()
      return
    }
    newTask(nextMode)
  }

  function restoreProjectInitFocus(): void {
    const target = projectInitReturnFocusRef.current
    projectInitReturnFocusRef.current = null
    window.setTimeout(() => target?.focus(), 0)
  }

  useEffect(() => {
    if (projectInitPreview) {
      projectInitWasOpenRef.current = true
      return
    }
    if (!projectInitWasOpenRef.current) return
    projectInitWasOpenRef.current = false
    restoreProjectInitFocus()
  }, [projectInitPreview])

  const submitComposerInner = async (): Promise<boolean> => {
    const draft = getCurrentComposerSnapshot().draft.trimStart()
    const slashMatch = /^\/([a-z]+)(?:\s+(.*))?$/iu.exec(draft)
    if (slashMatch && 'onekey' in window) {
      const commandId = slashMatch[1]!.toLowerCase()
      const args = slashMatch[2]?.trim() ?? ''
      if (commandId === 'commit' && workspaceToken) {
        const message = args || 'chore: auto commit'
        composerActions.setDraft('')
        const result = await window.onekey.workspace.gitCommit({ workspaceToken, message })
        conversationActions.setNotice(result.ok ? result.value.output : result.error.message)
        return true
      }
      if (commandId === 'diff' && workspaceToken) {
        composerActions.setDraft('')
        setDock('diff')
        conversationActions.setNotice('已打开 Diff 面板，正在加载工作区变更…')
        return true
      }
      if (commandId === 'checkpoint') {
        const taskId = conversation.backendTaskId
        if (taskId) {
          composerActions.setDraft('')
          const result = await window.onekey.workspace.checkpoint({
            taskId,
            ...(args ? { label: args } : {})
          })
          conversationActions.setNotice(result.ok
            ? `已创建检查点，共保留 ${result.value.checkpoints.length} 个。`
            : result.error.message)
          return true
        }
      }
      if (commandId === 'rewind') {
        const taskId = conversation.backendTaskId
        if (taskId) {
          composerActions.setDraft('')
          const listed = await window.onekey.workspace.changes({ taskId })
          if (!listed.ok) {
            conversationActions.setNotice(listed.error.message)
            return true
          }
          const index = args && /^\d+$/u.test(args) ? Math.max(0, Number(args) - 1) : 0
          const checkpoint = listed.value.checkpoints.find((item) => item.id === args)
            ?? listed.value.checkpoints[index]
          if (!checkpoint) {
            conversationActions.setNotice('当前任务还没有可回退的检查点。')
            return true
          }
          const result = await window.onekey.workspace.rewind({
            taskId,
            checkpointId: checkpoint.id
          })
          conversationActions.setNotice(result.ok
            ? `已回退到“${checkpoint.label}”，并保留了回退前检查点。`
            : result.error.message)
          return true
        }
      }
      if (commandId === 'worktrees') {
        const taskId = conversation.backendTaskId
        if (taskId) {
          composerActions.setDraft('')
          const result = await window.onekey.workspace.changes({ taskId })
          conversationActions.setNotice(result.ok
            ? result.value.worktrees.length === 0
              ? '当前任务没有隔离分支。使用 /fork 创建一个。'
              : `当前任务有 ${result.value.worktrees.length} 个隔离分支，${result.value.worktrees.filter((item) => item.status === 'ready').length} 个可应用。`
            : result.error.message)
          return true
        }
      }
      if (commandId === 'apply' || commandId === 'discard') {
        const taskId = conversation.backendTaskId
        if (taskId) {
          composerActions.setDraft('')
          const listed = await window.onekey.workspace.changes({ taskId })
          if (!listed.ok) {
            conversationActions.setNotice(listed.error.message)
            return true
          }
          const candidates = listed.value.worktrees.filter((item) =>
            commandId === 'apply' ? item.status === 'ready' : item.status !== 'discarded'
          )
          const index = args && /^\d+$/u.test(args) ? Math.max(0, Number(args) - 1) : 0
          const worktree = candidates.find((item) => item.id === args) ?? candidates[index]
          if (!worktree) {
            conversationActions.setNotice(commandId === 'apply'
              ? '当前没有可应用的隔离分支。'
              : '当前没有可丢弃的隔离分支。')
            return true
          }
          const result = commandId === 'apply'
            ? await window.onekey.workspace.worktreeApply({ taskId, worktreeId: worktree.id })
            : await window.onekey.workspace.worktreeDiscard({ taskId, worktreeId: worktree.id })
          conversationActions.setNotice(result.ok
            ? commandId === 'apply' ? '隔离分支的文件变更已应用。' : '隔离分支已丢弃。'
            : result.error.message)
          return true
        }
      }
      if (commandId === 'fork') {
        const taskId = conversation.backendTaskId
        if (taskId && 'onekey' in window) {
          composerActions.setDraft('')
          const result = await window.onekey.conversation.fork({
            taskId,
            ...(workspaceToken ? { workspaceToken } : {}),
            isolateFiles: mode === 'agent' && settingsPreferences.worktreeMode !== 'never'
          })
          if (result.ok) {
            conversationActions.setNotice(`已创建分支：${result.value.title}`)
            void conversationActions.initialize({ projects: [], activeTaskId: result.value.id })
          } else {
            conversationActions.setNotice(result.error.message)
          }
          return true
        }
      }
      const knownCommands = ['plan', 'goal', 'memories', 'init', 'review', 'status', 'diff', 'commit', 'fork']
      if (knownCommands.includes(commandId)) {
        composerActions.setDraft('')
        const result = await window.onekey.capabilities.execute({
          id: commandId,
          args,
          ...(workspaceToken ? { workspaceToken } : {}),
        })
        if (result.ok) {
          conversationActions.setNotice(result.value.message)
        } else {
          conversationActions.setNotice(result.error.message)
        }
        return true
      }
    }
    const initSubmission = /^\/init(?:\s|$)/iu.test(draft)
    if (initSubmission && !projectInitReturnFocusRef.current) {
      projectInitReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    }
    const accepted = await composerActions.submit()
    if (initSubmission && !getCurrentComposerSnapshot().projectInit) {
      projectInitReturnFocusRef.current = null
    }
    return accepted
  }

  const submitComposer = async (): Promise<boolean> => {
    const historyEntry = getCurrentComposerSnapshot().draft.trim()
    const accepted = await submitComposerInner()
    if (accepted && historyEntry) recordComposerHistory(historyEntry)
    return accepted
  }
  submitComposerRef.current = submitComposer

  const queueComposerMessage = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (queuedMessagesRef.current.length >= MAX_QUEUED_MESSAGES) {
      composerActions.setNotice('排队消息已达上限，请等待当前回合结束。')
      return
    }
    queueSequenceRef.current += 1
    const next = [...queuedMessagesRef.current, { id: queueSequenceRef.current, text: trimmed }]
    queuedMessagesRef.current = next
    setQueuedMessages(next)
  }

  const removeQueuedMessage = (id: number): void => {
    const next = queuedMessagesRef.current.filter((message) => message.id !== id)
    queuedMessagesRef.current = next
    setQueuedMessages(next)
    if (blockedQueueIdsRef.current.has(id)) {
      const blocked = new Set(blockedQueueIdsRef.current)
      blocked.delete(id)
      blockedQueueIdsRef.current = blocked
    }
  }

  // Submitting toggles composer.submitting, so a refused queued message would
  // otherwise re-enter the drain immediately and retry in a tight loop. Refused
  // messages stay parked until a finished turn makes admission worth retrying.
  useEffect(() => {
    const wasRunning = previousRunningRef.current
    previousRunningRef.current = running
    if (wasRunning && !running) blockedQueueIdsRef.current = new Set()
  }, [running])

  const queuedCount = queuedMessages.length
  useEffect(() => {
    if (running || composer.submitting || workspaceSwitching || queuedCount === 0) return
    if (queueDrainingRef.current) return
    queueDrainingRef.current = true
    void (async () => {
      try {
        const next = queuedMessagesRef.current.find(
          (message) => !blockedQueueIdsRef.current.has(message.id)
        )
        if (!next) return
        const stashedDraft = getCurrentComposerSnapshot().draft
        composerActions.setDraft(next.text)
        const accepted = await submitComposerRef.current()
        const currentDraft = getCurrentComposerSnapshot().draft
        if (accepted) {
          const remaining = queuedMessagesRef.current.filter((message) => message.id !== next.id)
          queuedMessagesRef.current = remaining
          setQueuedMessages(remaining)
          if (currentDraft === '' && stashedDraft) composerActions.setDraft(stashedDraft)
        } else {
          // Launch was refused: keep the chip so nothing is lost, park it so the
          // drain cannot spin on it, and hand the textarea back to the user's
          // own draft. The submit notice explains why it did not go out.
          blockedQueueIdsRef.current = new Set(blockedQueueIdsRef.current).add(next.id)
          if (currentDraft === next.text) composerActions.setDraft(stashedDraft)
        }
      } finally {
        queueDrainingRef.current = false
      }
    })()
  }, [running, composer.submitting, workspaceSwitching, queuedCount, composerActions, getCurrentComposerSnapshot])

  useEffect(() => {
    // Without these guards Chromium navigates the window when a file lands
    // outside the composer's drop zone.
    const preventWindowDrop = (event: globalThis.DragEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('dragover', preventWindowDrop)
    window.addEventListener('drop', preventWindowDrop)
    return () => {
      window.removeEventListener('dragover', preventWindowDrop)
      window.removeEventListener('drop', preventWindowDrop)
    }
  }, [])

  const commitProjectInit = async (): Promise<void> => {
    await composerActions.commitProjectInit()
  }

  const dismissProjectInit = async (): Promise<void> => {
    await composerActions.dismissProjectInit()
  }

  const selectWorkspace = async (allowDuringPreparation = false): Promise<{ token: string; name: string } | null> => {
    if (conversation.running || (composer.submitting && !allowDuringPreparation)) {
      conversationActions.setNotice('请先停止当前回答，再切换工作区。')
      return null
    }
    if (!('onekey' in window)) {
      const previewSelection = { token: 'preview-workspace', name: 'OneKeyElectron' }
      workspaceScopeChangingRef.current = true
      setWorkspaceSwitching(true)
      activeWorkspaceTokenRef.current = previewSelection.token
      setWorkspaceToken(previewSelection.token)
      setWorkspaceName(previewSelection.name)
      setWorkspaceOrigin('selected')
      setWorkspaceOpenerNotice('')
      try {
        await composerActions.changeScope(previewSelection.token)
      } finally {
        workspaceScopeChangingRef.current = false
        setWorkspaceSwitching(false)
      }
      return previewSelection
    }
    try {
      const result = await window.onekey.dialog.selectWorkspace()
      if (!result.ok) {
        conversationActions.setNotice(result.error.message)
        return null
      }
      if (!result.value) return null
      let restoredCurrentTask = false
      if (selectedTask && mode === 'agent') {
        const remembered = await window.onekey.workspace.remember({
          taskId: selectedTask,
          workspaceToken: result.value.workspaceToken,
        })
        restoredCurrentTask = remembered.ok
      }
      if (result.value.workspaceToken !== activeWorkspaceTokenRef.current) {
        workspaceScopeChangingRef.current = true
        setWorkspaceSwitching(true)
        activeWorkspaceTokenRef.current = result.value.workspaceToken
        setWorkspaceToken(result.value.workspaceToken)
        setWorkspaceName(result.value.displayName)
        setWorkspaceOrigin('selected')
        if (!restoredCurrentTask) conversationActions.resetForWorkspace(getCurrentModelSelection().mode)
        composerActions.setNotice(restoredCurrentTask
          ? '已恢复这个任务原来的工作区。'
          : '工作区已切换，已清除先前选择的能力。')
        try {
          await composerActions.changeScope(result.value.workspaceToken)
        } finally {
          workspaceScopeChangingRef.current = false
          setWorkspaceSwitching(false)
        }
      }
      activeWorkspaceTokenRef.current = result.value.workspaceToken
      setWorkspaceToken(result.value.workspaceToken)
      setWorkspaceName(result.value.displayName)
      setWorkspaceOrigin('selected')
      setWorkspaceOpenerNotice('')
      conversationActions.clearNotice()
      return { token: result.value.workspaceToken, name: result.value.displayName }
    } catch {
      conversationActions.setNotice('工作区选择未完成，请重试。')
      return null
    }
  }

  useEffect(() => {
    if (
      conversationRuntime !== 'desktop' ||
      !selectedTask ||
      mode !== 'agent' ||
      selectedTaskReadOnly ||
      activeWorkspaceTokenRef.current ||
      !('onekey' in window)
    ) return

    const epoch = workspaceRestoreEpochRef.current + 1
    workspaceRestoreEpochRef.current = epoch
    workspaceScopeChangingRef.current = true
    setWorkspaceSwitching(true)
    void window.onekey.workspace.restore({ taskId: selectedTask }).then(async (result) => {
      if (workspaceRestoreEpochRef.current !== epoch) return
      if (!result.ok) {
        conversationActions.setNotice(result.error.message)
        return
      }
      if (!result.value) {
        conversationActions.setNotice('这个历史任务需要重新选择原来的工作区。')
        return
      }
      activeWorkspaceTokenRef.current = result.value.workspaceToken
      setWorkspaceToken(result.value.workspaceToken)
      setWorkspaceName(result.value.displayName)
      setWorkspaceOrigin(result.value.origin)
      setWorkspaceOpenerNotice('')
      await composerActions.changeScope(result.value.workspaceToken)
    }).catch(() => {
      if (workspaceRestoreEpochRef.current === epoch) {
        conversationActions.setNotice('历史任务的工作区恢复未完成，请重试。')
      }
    }).finally(() => {
      if (workspaceRestoreEpochRef.current !== epoch) return
      workspaceScopeChangingRef.current = false
      setWorkspaceSwitching(false)
    })
  }, [composerActions, conversationActions, conversationRuntime, mode, selectedTask, selectedTaskReadOnly])

  const provisionWorkspace = async (): Promise<AgentWorkspaceSelection | null> => {
    if (!('onekey' in window)) {
      const preview: AgentWorkspaceSelection = {
        workspaceToken: 'preview-workspace',
        displayName: 'new-chat',
        origin: 'projectless',
      }
      activeWorkspaceTokenRef.current = preview.workspaceToken
      setWorkspaceToken(preview.workspaceToken)
      setWorkspaceName(preview.displayName)
      setWorkspaceOrigin(preview.origin)
      return preview
    }
    workspaceScopeChangingRef.current = true
    setWorkspaceSwitching(true)
    try {
      const prompt = getCurrentComposerSnapshot().draft.trim()
      const result = await window.onekey.workspace.provision(prompt ? { prompt } : undefined)
      if (!result.ok) {
        conversationActions.setNotice(result.error.message)
        return null
      }
      activeWorkspaceTokenRef.current = result.value.workspaceToken
      setWorkspaceToken(result.value.workspaceToken)
      setWorkspaceName(result.value.displayName)
      setWorkspaceOrigin(result.value.origin)
      setWorkspaceOpenerNotice('')
      await composerActions.changeScope(result.value.workspaceToken)
      return result.value
    } catch {
      conversationActions.setNotice('自动工作区创建未完成，请重试。')
      return null
    } finally {
      workspaceScopeChangingRef.current = false
      setWorkspaceSwitching(false)
    }
  }

  const detectWorkspaceOpeners = async (): Promise<WorkspaceOpenerDescriptor[]> => {
    if (workspaceOpenerDetectionRef.current) return workspaceOpenerDetectionRef.current
    workspaceLaunchTokenRef.current = null
    if (!workspaceToken) {
      setWorkspaceOpenerNotice('请先选择一个本地工作区。')
      return []
    }
    const requestedWorkspaceToken = workspaceToken
    const request = (async (): Promise<WorkspaceOpenerDescriptor[]> => {
      if (!('onekey' in window)) {
        setWorkspaceOpeners(previewWorkspaceOpeners)
        setWorkspaceOpenersDetected(true)
        setWorkspaceOpenerNotice('浏览器预览仅展示菜单，不会打开本机应用。')
        return previewWorkspaceOpeners
      }
      setWorkspaceOpenerNotice('')
      try {
        const result = await window.onekey.workspace.listOpeners({
          workspaceToken: requestedWorkspaceToken,
          confirmation: 'detect',
        })
        if (activeWorkspaceTokenRef.current !== requestedWorkspaceToken) return []
        if (!result.ok) {
          setWorkspaceOpeners([])
          setWorkspaceOpenersDetected(true)
          setWorkspaceOpenerNotice(result.error.message)
          return []
        }
        workspaceLaunchTokenRef.current = result.value.launchToken
        setWorkspaceOpeners(result.value.openers)
        setWorkspaceOpenersDetected(true)
        return result.value.openers
      } catch {
        if (activeWorkspaceTokenRef.current !== requestedWorkspaceToken) return []
        setWorkspaceOpeners([])
        setWorkspaceOpenersDetected(true)
        setWorkspaceOpenerNotice('本机打开方式检测未完成，请重试。')
        return []
      }
    })()
    workspaceOpenerDetectionRef.current = request
    try {
      return await request
    } finally {
      if (workspaceOpenerDetectionRef.current === request) workspaceOpenerDetectionRef.current = null
    }
  }

  const openWorkspaceWith = async (openerId: WorkspaceOpenerId): Promise<boolean> => {
    if (!workspaceToken || mode !== 'agent') {
      workspaceLaunchTokenRef.current = null
      setWorkspaceOpenerNotice('请先选择一个本地工作区。')
      return false
    }
    if (!('onekey' in window)) {
      workspaceLaunchTokenRef.current = null
      const label = previewWorkspaceOpeners.find((entry) => entry.id === openerId)?.label ?? '所选应用'
      setWorkspaceOpenerNotice(`浏览器预览不会启动 ${label}。`)
      return false
    }
    const launchToken = workspaceLaunchTokenRef.current
    workspaceLaunchTokenRef.current = null
    if (!launchToken) {
      setWorkspaceOpenerNotice('打开授权已失效，请重新展开“打开位置”菜单后重试。')
      return false
    }
    setWorkspaceOpenerNotice('')
    try {
      const result = await window.onekey.workspace.open({
        workspaceToken,
        openerId,
        launchToken,
        confirmation: 'open_once',
      })
      if (!result.ok) {
        setWorkspaceOpenerNotice(result.error.message)
        return false
      }
      return true
    } catch {
      setWorkspaceOpenerNotice('未能打开所选本机应用，请重新检测后再试。')
      return false
    }
  }

  const resolveApproval = async (decision: 'allow_once' | 'allow_session' | 'deny' | `option:${0 | 1 | 2 | 3}`): Promise<void> => {
    await conversationActions.resolveApproval(decision)
  }

  const setHistoryTaskArchived = async (task: Task, archived: boolean): Promise<void> => {
    if (composer.submitting) return
    composerActions.clearNotice()
    const wasSelected = selectedTask === task.id
    const result = await conversationActions.setArchived(task, archived)
    if (result.ok && archived && wasSelected) composerActions.resetConversation()
    composerActions.setNotice(result.message)
  }

  const renameHistoryTask = async (task: Task, title: string): Promise<void> => {
    if (composer.submitting || task.readOnly) return
    composerActions.clearNotice()
    const result = await conversationActions.renameTask(task, title)
    composerActions.setNotice(result.message)
  }

  const requestHistoryTaskDelete = (task: Task): void => {
    if (composer.submitting || task.status === 'running' || (running && selectedTask === task.id)) return
    conversationActions.clearHistoryError()
    setPendingDeleteTask(task)
  }

  const confirmHistoryTaskDelete = async (): Promise<void> => {
    const task = pendingDeleteTask
    if (!task || historyActionTaskId || composer.submitting) return
    conversationActions.clearHistoryError()
    const wasSelected = selectedTask === task.id
    const result = await conversationActions.deleteTask(task)
    if (!result.ok) return
    if (wasSelected) composerActions.resetConversation()
    setPendingDeleteTask(null)
    composerActions.setNotice(result.message)
  }

  const prepareComposerLaunch = async (requestedMode?: WorkspaceMode): Promise<ComposerLaunchPreparation> => {
    if (workspaceScopeChangingRef.current) {
      conversationActions.setNotice('工作区正在切换，请稍候再发送。')
      return { ok: false }
    }
    const initialSelection = getCurrentModelSelection()
    const turnMode = requestedMode ?? initialSelection.mode
    if (requestedMode && initialSelection.mode !== requestedMode) {
      await modelSelectionActions.selectMode(requestedMode)
    }
    if (getCurrentModelSelection().mode !== turnMode) {
      conversationActions.setNotice('会话模式在准备期间发生变化，请重新发送。')
      return { ok: false }
    }
    if (turnMode !== 'agent') return { ok: true }
    const currentWorkspaceToken = activeWorkspaceTokenRef.current
    if (currentWorkspaceToken) return { ok: true, workspaceToken: currentWorkspaceToken }
    const provisioned = await provisionWorkspace()
    if (!provisioned) {
      conversationActions.setNotice('Agent 自动工作区暂时不可用，请重试。')
      return { ok: false }
    }
    return { ok: true, workspaceToken: provisioned.workspaceToken }
  }

  const startTurn = async (submission: ComposerTurnSubmission): Promise<boolean> => {
    const selection = getCurrentModelSelection()
    const turnMode = submission.requestedMode ?? selection.mode
    const capabilityIsolatedLaunch = submission.reviewHandle !== undefined

    // Renderer projects current UI intent only. Main owns every admission rule
    // for account, catalog, model, workspace, review grants, and capabilities.
    const accepted = await conversationActions.send({
      visiblePrompt: submission.visiblePrompt,
      transportPrompt: submission.transportPrompt,
      ...(selection.selectedModel?.name ? { modelLabel: selection.selectedModel.name } : {}),
      request: {
        mode: turnMode,
        profileHandle: profileHandle || 'preview',
        groupId: selection.groupId || null,
        modelId: selection.selectedModel?.id ?? '',
        reasoning: selection.reasoning.effort,
        approvalMode: permission === 'ask' ? 'request' : permission,
        ...(turnMode === 'agent' && submission.workspaceToken ? { workspaceToken: submission.workspaceToken } : {}),
        ...(submission.reviewHandle === undefined ? {} : { reviewHandle: submission.reviewHandle }),
        attachmentTokens: [...submission.attachmentTokens],
        webSearch: !capabilityIsolatedLaunch && selection.capabilities.webSearch.enabled,
        imageGeneration: !capabilityIsolatedLaunch && selection.capabilities.imageGeneration.enabled,
        ...(submission.contextMessageLimit ? { contextMessageLimit: submission.contextMessageLimit } : {}),
      },
    })
    if (!accepted) return false
    if (conversationRuntime === 'desktop') setChatEndpointConfirmed(true)
    return true
  }

  const continueAgentExecution = async (): Promise<void> => {
    if (!resumableAgentTurn || running || composer.submitting) return
    const prepared = await prepareComposerLaunch('agent')
    if (!prepared.ok || !prepared.workspaceToken) return
    await startTurn({
      visiblePrompt: '继续执行',
      transportPrompt: '继续执行上一个 Agent 任务。先检查当前工作区状态和最近结果，再完成剩余工作；不要重复执行已经完成的写入或命令。',
      attachmentTokens: [],
      workspaceToken: prepared.workspaceToken,
      requestedMode: 'agent',
    })
  }

  const retryAssistantMessage = async (target: ConversationMessageDto): Promise<void> => {
    if (running || composer.submitting) return
    const list = conversation.messages
    const targetIndex = list.findIndex((message) => message.id === target.id)
    const scope = targetIndex < 0 ? list : list.slice(0, targetIndex)
    // The retried prompt is the latest real user message before the target;
    // compaction summaries are context, not a prompt anyone typed.
    const source = [...scope].reverse().find((message) =>
      message.role === 'user' && !message.content.startsWith(CONTEXT_COMPACTION_PREFIX))
    if (!source) {
      conversationActions.setNotice('找不到可重试的用户消息。')
      return
    }
    const prepared = await prepareComposerLaunch(mode)
    if (!prepared.ok) return
    if (mode === 'agent' && !prepared.workspaceToken) return
    await startTurn({
      visiblePrompt: source.content,
      transportPrompt: source.content,
      attachmentTokens: [],
      ...(prepared.workspaceToken ? { workspaceToken: prepared.workspaceToken } : {}),
    })
  }

  const forkFromMessage = async (target: ConversationMessageDto): Promise<void> => {
    const taskId = conversation.backendTaskId
    if (!taskId || running || !('onekey' in window)) return
    const result = await window.onekey.conversation.fork({
      taskId,
      ...(workspaceToken ? { workspaceToken } : {}),
      isolateFiles: mode === 'agent' && settingsPreferences.worktreeMode !== 'never',
      anchorMessageId: target.id,
    })
    if (result.ok) {
      conversationActions.setNotice(`已从所选消息创建分支：${result.value.title}`)
      void conversationActions.initialize({ projects: [], activeTaskId: result.value.id })
    } else {
      conversationActions.setNotice(result.error.message)
    }
  }

  composerHostRef.current = {
    prepareLaunch: prepareComposerLaunch,
    launchTurn: startTurn,
  }

  const stopTurn = (): Promise<void> => conversationActions.stop()

  const continueTurnInBackground = async (): Promise<void> => {
    if (
      conversationRuntime !== 'desktop' ||
      mode !== 'agent' ||
      conversation.turnState !== 'active' ||
      !conversation.backendTaskId ||
      backgroundTasks.attaching
    ) return
    const attached = await backgroundTasks.attach({
      taskId: conversation.backendTaskId,
      title: conversation.title,
    })
    if (!attached.ok) {
      conversationActions.setNotice(attached.message)
      return
    }
    if (!conversationActions.detachTurn()) {
      conversationActions.setNotice('任务已由后台接管，可在任务面板查看进度。')
      return
    }
    composerActions.resetConversation()
    setTasksOpen(true)
    setContextOpen(false)
  }

  const createBackgroundTurn = async (
    task: BackgroundTaskDto,
    prompt: string,
  ): Promise<TurnStartInput | null> => {
    if (conversationRuntime !== 'desktop' || !('onekey' in window)) return null
    const selection = getCurrentModelSelection()
    if (!selection.selectedModel?.id) {
      conversationActions.setNotice('请先选择一个可用于 Agent 的模型。')
      return null
    }
    let taskWorkspaceToken = task.taskId === conversation.backendTaskId
      ? activeWorkspaceTokenRef.current
      : ''
    if (!taskWorkspaceToken) {
      const restored = await window.onekey.workspace.restore({ taskId: task.taskId })
      if (!restored.ok) {
        conversationActions.setNotice(restored.error.message)
        return null
      }
      if (!restored.value) {
        conversationActions.setNotice('这个后台任务的工作区暂时无法恢复。')
        return null
      }
      taskWorkspaceToken = restored.value.workspaceToken
    }
    const nextPrompt = prompt.trim() || '继续执行上一个 Agent 任务。先检查当前工作区状态和最近结果，再完成剩余工作；不要重复已经完成的操作。'
    return {
      requestId: createBackgroundRequestId(),
      taskId: task.taskId,
      mode: 'agent',
      prompt: nextPrompt,
      profileHandle: profileHandle || 'preview',
      groupId: selection.groupId || null,
      modelId: selection.selectedModel.id,
      reasoning: selection.reasoning.effort,
      approvalMode: permission === 'ask' ? 'request' : permission,
      workspaceToken: taskWorkspaceToken,
      attachmentTokens: [],
      webSearch: selection.capabilities.webSearch.enabled,
      imageGeneration: false,
    }
  }

  const submitBackgroundTurn = async (
    task: BackgroundTaskDto,
    prompt: string,
    operation: 'followUp' | 'resume',
  ): Promise<boolean> => {
    const turn = await createBackgroundTurn(task, prompt)
    if (!turn) return false
    const result = operation === 'followUp'
      ? await backgroundTasks.followUp(task.id, turn)
      : await backgroundTasks.resume(task.id, turn)
    if (!result.ok) {
      conversationActions.setNotice(result.message)
      return false
    }
    return true
  }

  const openBackgroundTask = (task: BackgroundTaskDto): void => {
    if (interactionBusy) return
    selectTask({
      id: task.taskId,
      title: task.title,
      mode: 'agent',
      ...(isBackgroundTaskActive(task.status)
        ? { status: 'running' as const }
        : task.status === 'failed'
          ? { status: 'failed' as const }
          : {}),
    })
  }

  const backgroundTaskPanel: BackgroundTaskPanelProps = {
    tasks: backgroundTasks.tasks,
    loading: backgroundTasks.loading,
    error: backgroundTasks.error,
    busyTaskIds: backgroundTasks.busyTaskIds,
    foregroundBusy: interactionBusy,
    onRefresh: () => { void backgroundTasks.refresh() },
    onOpen: openBackgroundTask,
    onCancel: async (task) => {
      const result = await backgroundTasks.cancel(task.id)
      if (!result.ok) conversationActions.setNotice(result.message)
    },
    onTurn: submitBackgroundTurn,
  }

  const toggleContext = () => {
    setContextOpen((current) => !current)
    setTasksOpen(false)
  }

  const openTasks = () => {
    setTasksOpen(true)
    setContextOpen(false)
  }

  const openUserCenter = () => {
    closeDrawers()
    setUserCenterReturnSurface('workspace')
    setSurface('user-center')
  }

  const openSettings = () => {
    closeDrawers()
    setSurface('settings')
  }

  const openSettingsView = (view: SettingsView) => {
    setSettingsView(view)
    openSettings()
  }

  const openDock = (tab: DockTab) => {
    setDock(tab)
    setSettingsPreferences((current) => current.showBottomPanel ? current : { ...current, showBottomPanel: true })
  }

  const chooseConversationStarter = (prompt: string): void => {
    composerActions.setDraft(prompt)
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[data-capability-input="true"]')
      input?.focus()
      input?.setSelectionRange(prompt.length, prompt.length)
    })
  }

  useEffect(() => {
    if (!settingsPreferences.showBottomPanel) setDock(null)
  }, [settingsPreferences.showBottomPanel])

  useEffect(() => {
    writeSettingsPreferences(settingsPreferences)
    document.documentElement.dataset.density = settingsPreferences.density
    document.documentElement.dataset.reduceMotion = settingsPreferences.reduceMotion ? 'true' : 'false'
  }, [settingsPreferences])

  const runStudioCommand = (command: string): void => {
    dispatchStudioCommand(command)
  }

  const jumpToStudioPage = (page: 'queue' | 'runs' | 'workflow'): void => {
    setActivityCenterOpen(false)
    setSurface('studio')
    // The lazy Studio surface may still be mounting; give its listener a beat.
    window.setTimeout(() => dispatchStudioCommand(`navigate:${page}`), 360)
  }

  const globalCommandItems: GlobalCommandItem[] = [
    {
      id: 'new-current', label: mode === 'agent' ? '新建 Agent' : '新建 Chat', detail: '在当前模式开始一项新任务', section: '开始', shortcut: 'Ctrl N', icon: Plus,
      run: () => { setSurface('workspace'); newTask(mode) },
    },
    {
      id: 'new-alternate', label: mode === 'agent' ? '新建 Chat' : '新建 Agent', detail: '切换模式并开始新任务', section: '开始', shortcut: 'Ctrl Shift N', icon: mode === 'agent' ? MessageSquare : Bot,
      run: () => { setSurface('workspace'); newTask(mode === 'agent' ? 'chat' : 'agent') },
    },
    { id: 'surface-chat', label: '转到 Chat', detail: '打开对话工作区', section: '导航', keywords: '聊天 conversation', icon: MessageSquare, run: () => { setSurface('workspace'); if (mode !== 'chat') changeMode('chat') } },
    { id: 'surface-agent', label: '转到 Agent', detail: '打开任务工作区', section: '导航', keywords: '智能体 coding', icon: Bot, run: () => { setSurface('workspace'); if (mode !== 'agent') changeMode('agent') } },
    { id: 'surface-studio', label: '转到 Studio', detail: '打开图像工作流', section: '导航', keywords: '画布 生图 图片', icon: WandSparkles, disabled: interactionBusy, run: () => setSurface('studio') },
    { id: 'surface-settings', label: '打开设置', detail: '调整通用、Agent 与工作树选项', section: '导航', shortcut: 'Ctrl ,', icon: Settings, run: () => openSettingsView('general') },
    { id: 'task-center', label: '打开任务中心', detail: '查看前台、后台与 Studio 运行', section: '视图', icon: Bell, run: () => setActivityCenterOpen(true) },
    { id: 'focus', label: workspaceLayout.snapshot.focusMode ? '退出专注模式' : '进入专注模式', detail: '隐藏两侧面板，集中查看当前内容', section: '视图', shortcut: 'Ctrl Shift F', icon: Focus, run: workspaceLayout.actions.toggleFocusMode },
    { id: 'reset-layout', label: '恢复默认布局', detail: '重置侧栏、环境栏和工作台尺寸', section: '视图', icon: RotateCcw, run: workspaceLayout.actions.reset },
    { id: 'open-review', label: '审查工作区变更', detail: '按文件查看 Git 变更与行号', section: '工作区', icon: FileDiff, disabled: !workspaceToken, run: () => { setSurface('workspace'); openDock('diff') } },
    { id: 'open-files', label: '浏览工作区文件', detail: '从目录树打开真实文件', section: '工作区', icon: FolderOpen, disabled: !workspaceToken, run: () => { setSurface('workspace'); openDock('files') } },
    { id: 'open-terminal', label: '打开工作区终端', detail: '在当前 Agent 工作目录启动终端', section: '工作区', shortcut: 'Ctrl `', icon: SquareTerminal, disabled: !workspaceToken, run: () => { setSurface('workspace'); openDock('terminal') } },
    {
      id: 'checkpoint-create', label: '创建工作区检查点', detail: '记录当前文件状态，之后可随时回退', section: '工作区', icon: History,
      disabled: !workspaceToken || !conversation.backendTaskId || running,
      run: async () => {
        const backendTaskId = conversation.backendTaskId
        if (!backendTaskId || !('onekey' in window)) return
        const label = `手动检查点 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        const result = await window.onekey.workspace.checkpoint({ taskId: backendTaskId, label })
        if (result.ok) pushToast({ kind: 'success', title: '已创建检查点', detail: label })
        else pushToast({ kind: 'danger', title: '创建检查点失败', detail: result.error.message })
      },
    },
    ...(surface === 'studio' ? [
      { id: 'studio-workflow', label: 'Studio：工作流', detail: '返回画布编辑', section: 'Studio', icon: WandSparkles, run: () => runStudioCommand('navigate:workflow') },
      { id: 'studio-assets', label: 'Studio：作品', detail: '查看生成结果', section: 'Studio', icon: ImagePlus, run: () => runStudioCommand('navigate:assets') },
      { id: 'studio-queue', label: 'Studio：任务', detail: '查看运行队列', section: 'Studio', icon: ListChecks, run: () => runStudioCommand('navigate:queue') },
      { id: 'studio-runs', label: 'Studio：记录', detail: '查看运行详情', section: 'Studio', icon: ScanSearch, run: () => runStudioCommand('navigate:runs') },
      { id: 'studio-layout', label: 'Studio：整理画布', detail: '按依赖关系自动排列节点', section: 'Studio', icon: GitCompareArrows, run: () => runStudioCommand('auto-layout') },
      { id: 'studio-run', label: 'Studio：运行工作流', detail: '运行当前正式工作流', section: 'Studio', shortcut: 'Ctrl Enter', icon: WandSparkles, run: () => runStudioCommand('run') },
    ] satisfies GlobalCommandItem[] : []),
    ...taskGroups.flatMap((group) => group.tasks.filter((task) => !task.archivedAt).slice(0, 12).map((task) => ({
      id: `task:${task.id}`,
      label: task.title,
      detail: group.name,
      section: '最近任务',
      keywords: `${task.mode} ${group.path}`,
      icon: task.mode === 'agent' ? Bot : MessageSquare,
      run: () => { setSurface('workspace'); selectTask(task) },
    } satisfies GlobalCommandItem))),
    ...modelSelection.groups.map((group) => ({
      id: `group:${group.id}`,
      label: `选择分组：${group.id}`,
      detail: group.description || '切换当前模型分组',
      section: '模型',
      keywords: group.id,
      icon: GitBranch,
      run: () => modelSelectionActions.selectGroup(group.id),
    } satisfies GlobalCommandItem)),
    ...modelCatalog.slice(0, 24).map((model) => ({
      id: `model:${model.id}`,
      label: `选择模型：${model.name}`,
      detail: model.id,
      section: '模型',
      keywords: model.id,
      icon: Sparkles,
      run: () => modelSelectionActions.selectModel(model.id),
    } satisfies GlobalCommandItem)),
    ...([
      ['general', '常规设置', Settings, '权限 审批 文件 终端 语言'],
      ['appearance', '外观设置', Palette, '主题 密度 动画 面板'],
      ['voice', '语音设置', Mic, '麦克风 输入 听写'],
      ['configuration', '模型与渠道配置', Wrench, '模型 渠道 API key'],
      ['personalization', '个性化设置', Sparkles, '自定义 指令 回复'],
      ['shortcuts', '键盘快捷键', Keyboard, '快捷键 命令 键盘'],
      ['account', '账户设置', CircleUserRound, '用户 中转站 余额 令牌'],
      ['plugins', '插件设置', PlugZap, 'MCP 扩展 skill'],
    ] as const).map(([view, label, icon, keywords]) => ({
      id: `settings:${view}`,
      label,
      detail: '直接跳到对应设置分区',
      section: '设置',
      keywords,
      icon,
      run: () => openSettingsView(view),
    } satisfies GlobalCommandItem)),
    ...composer.catalog.commands.slice(0, 16).map((command) => ({
      id: `command:${command.id}`,
      label: `/${command.id} ${command.name}`,
      detail: command.description,
      section: '命令',
      keywords: command.aliases.join(' '),
      icon: SquareTerminal,
      run: () => { setSurface('workspace'); chooseConversationStarter(`/${command.id} `) },
    } satisfies GlobalCommandItem)),
    ...composer.catalog.skills.slice(0, 20).map((skill) => ({
      id: `skill:${skill.id}`,
      label: `使用技能：${skill.name}`,
      detail: skill.description || '将技能加载到当前任务',
      section: '技能与插件',
      keywords: `skill $ ${skill.scope}`,
      icon: Sparkles,
      run: () => { setSurface('workspace'); void composerActions.selectSkill(skill) },
    } satisfies GlobalCommandItem)),
    ...composer.catalog.plugins.filter((plugin) => plugin.enabled).slice(0, 20).map((plugin) => ({
      id: `plugin:${plugin.id}`,
      label: `引用插件：${plugin.name}`,
      detail: plugin.description || '在当前输入中引用插件',
      section: '技能与插件',
      keywords: `plugin @ ${plugin.scope}`,
      icon: PlugZap,
      run: () => { setSurface('workspace'); composerActions.selectPlugin(plugin) },
    } satisfies GlobalCommandItem)),
    ...backgroundTasks.tasks
      .filter((task) => isBackgroundTaskActive(task.status))
      .slice(0, 8)
      .map((task) => ({
        id: `bg:${task.id}`,
        label: `后台任务：${task.title}`,
        detail: task.status === 'waiting-approval' ? '等待批准' : task.status === 'running' ? '执行中' : '排队中',
        section: '任务中心',
        keywords: 'background 后台',
        icon: Bell,
        run: () => { setSurface('workspace'); openBackgroundTask(task) },
      } satisfies GlobalCommandItem)),
  ]

  const activeTaskCount = Number(running)
    + backgroundTasks.tasks.filter((task) => isBackgroundTaskActive(task.status)).length
    + studioActivity.activeCount

  const surfaceTitle = surface === 'user-center'
    ? '用户中心'
    : surface === 'settings'
      ? '设置'
      : surface === 'studio'
        ? 'Studio'
        : title

  return (
    <div
      className={`app-shell ${surface === 'settings' ? 'settings-active' : ''} ${workspaceLayout.snapshot.focusMode ? 'focus-mode' : ''}`}
      style={{
        '--workspace-sidebar-width': `${workspaceLayout.snapshot.sidebarWidth}px`,
        '--workspace-inspector-width': `${contextInspectorCompact && !contextOpen ? 52 : workspaceLayout.snapshot.inspectorWidth}px`,
      } as CSSProperties}
    >
      <Titlebar
        title={surfaceTitle}
        mode={mode}
        running={surface === 'workspace' && interactionBusy}
        surface={surface}
        onNewTask={(nextMode) => {
          closeDrawers()
          setSurface('workspace')
          newTask(nextMode)
        }}
        onSelectWorkspace={() => {
          closeDrawers()
          setSurface('workspace')
          void selectWorkspace()
        }}
        onOpenSettings={openSettingsView}
        onOpenUserCenter={() => {
          closeDrawers()
          setUserCenterReturnSurface(
            surface === 'settings' || surface === 'studio' ? surface : 'workspace'
          )
          setSurface('user-center')
        }}
        onReturnWorkspace={() => {
          closeDrawers()
          setSurface('workspace')
        }}
        onToggleTasks={() => {
          setSurface('workspace')
          if (surface === 'workspace' && tasksOpen) setTasksOpen(false)
          else openTasks()
        }}
        onToggleContext={() => {
          setSurface('workspace')
          toggleContext()
        }}
        onOpenDock={(tab) => {
          setSurface('workspace')
          openDock(tab)
        }}
        onCloseDock={() => {
          setSurface('workspace')
          setDock(null)
        }}
        onOpenCommandCenter={() => setCommandCenterOpen(true)}
        onToggleActivityCenter={() => setActivityCenterOpen((open) => !open)}
        onToggleFocusMode={workspaceLayout.actions.toggleFocusMode}
        onResetLayout={workspaceLayout.actions.reset}
        dockOpen={Boolean(dock)}
        activityOpen={activityCenterOpen}
        activityCount={activeTaskCount}
        focusMode={workspaceLayout.snapshot.focusMode}
      />
      {surface === 'user-center' ? (
        <UserCenter
          onBack={() => {
            void modelSelectionActions.reloadAccount()
            setSurface(userCenterReturnSurface)
          }}
          accountDisplayName={accountDisplayName}
          connectionName={relayProfileName}
          endpoint={relayEndpoint}
          onAccountIdentityChange={() => { void modelSelectionActions.reloadAccount() }}
          onTokenCatalogChanged={() => {
            void modelSelectionActions.reloadAccount()
          }}
        />
      ) : surface === 'settings' ? (
        <SettingsPage
          onBack={() => setSurface('workspace')}
          onOpenUserCenter={() => {
            setUserCenterReturnSurface('settings')
            setSurface('user-center')
          }}
          activeView={settingsView}
          onActiveViewChange={setSettingsView}
          permission={permission}
          onPermissionChange={setPermission}
          webSearch={web}
          onWebSearchChange={(enabled) => modelSelectionActions.setCapability('webSearch', enabled)}
          webSearchAvailable={webSearchAvailable}
          imageGeneration={imageGenerationEnabled}
          onImageGenerationChange={(enabled) => modelSelectionActions.setCapability('imageGeneration', enabled)}
          imageGenerationAvailable={imageGenerationAvailable}
          imageGenerationLocked={imagesOnlyModel}
          modelCompatibilityNotice={modelCompatibilityNotice}
          preferences={settingsPreferences}
          onPreferencesChange={(patch) => setSettingsPreferences((current) => ({ ...current, ...patch }))}
          workspaceOpeners={workspaceOpeners}
          workspaceOpenersDetected={workspaceOpenersDetected}
          displayName={relayProfileName}
          endpoint={relayEndpoint}
          profileHasKey={profileHasKey}
          modelCount={modelCatalog.length}
          modelCatalogState={modelCatalogState}
          modelCatalogMessage={modelCatalogMessage}
          onRefreshModels={refreshModelCatalog}
          workspaceToken={workspaceToken}
        />
      ) : surface === 'studio' ? (
        <Suspense fallback={<div className="studio-surface-loading" role="status">正在载入 Studio…</div>}>
          <StudioWorkspace
            onSelectConversationMode={(nextMode) => {
              setSurface('workspace')
              if (nextMode !== mode) newTask(nextMode)
            }}
            accountName={accountDisplayName}
            connectionLabel={connectionLabel}
            modelConnected={modelConnected}
            onOpenUserCenter={() => {
              closeDrawers()
              setUserCenterReturnSurface('studio')
              setSurface('user-center')
            }}
            onOpenGlobalCommand={() => setCommandCenterOpen(true)}
            focusMode={workspaceLayout.snapshot.focusMode}
          />
        </Suspense>
      ) : (
        <>
          <div className={`workspace-grid is-resizable ${contextInspectorCompact ? 'context-compact' : ''} ${contextOpen ? 'context-expanded' : ''}`}>
        <TaskSidebar
          mode={mode}
          groups={taskGroups}
          selectedTask={selectedTask}
          onSelectTask={selectTask}
          onNewTask={newTask}
          onArchiveTask={(task, archived) => { void setHistoryTaskArchived(task, archived) }}
          onRenameTask={(task, title) => { void renameHistoryTask(task, title) }}
          onDeleteTask={requestHistoryTaskDelete}
          onOpenDrawer={openTasks}
          onOpenSettings={openSettings}
          onOpenHelp={() => openSettingsView('shortcuts')}
          onOpenUserCenter={openUserCenter}
          accountName={accountDisplayName}
          connectionLabel={connectionLabel}
          modelConnected={modelConnected}
          currentTaskRunning={interactionBusy}
          historyActionTaskId={historyActionTaskId}
          backgroundTaskPanel={backgroundTaskPanel}
          onModeChange={changeMode}
          onOpenStudio={() => {
            if (interactionBusy) return
            closeDrawers()
            setSurface('studio')
          }}
        />

        <div
          className="workspace-resize-handle horizontal sidebar-handle"
          role="separator"
          aria-label="调整任务栏宽度"
          aria-orientation="vertical"
          aria-valuemin={216}
          aria-valuemax={380}
          aria-valuenow={workspaceLayout.snapshot.sidebarWidth}
          tabIndex={0}
          onPointerDown={(event) => beginPointerResize({
            event,
            axis: 'horizontal',
            startSize: workspaceLayout.snapshot.sidebarWidth,
            onResize: workspaceLayout.actions.resizeSidebar,
          })}
          onKeyDown={(event) => resizeFromKeyboard({
            event,
            axis: 'horizontal',
            currentSize: workspaceLayout.snapshot.sidebarWidth,
            onResize: workspaceLayout.actions.resizeSidebar,
          })}
        />

        <main className="conversation-pane">
          <TaskHeader
            title={title}
            mode={mode}
            planMode={planMode}
            goal={taskGoal}
            workspaceName={workspaceName}
            workspaceSelected={Boolean(workspaceToken)}
            workspaceIdentity={workspaceToken}
            workspaceOpeners={workspaceOpeners}
            defaultOpener={settingsPreferences.defaultOpener}
            openerNotice={workspaceOpenerNotice}
            onSelectWorkspace={() => { void selectWorkspace() }}
            onDetectOpeners={detectWorkspaceOpeners}
            onOpenWorkspace={openWorkspaceWith}
            onOpenContext={toggleContext}
            onOpenDock={openDock}
            onOpenSearch={() => setCommandCenterOpen(true)}
          />
          {(planMode || taskGoal || capabilityNotice || selectedSkillMention || selectedPluginMention || contextSummary) && (
            <div className="capability-status-strip" role="status">
              {planMode && <span className="capability-state-pill plan"><ListChecks size={13} />计划模式</span>}
              {taskGoal && <span className="capability-state-pill goal" title={taskGoal}><Target size={13} />{taskGoal}</span>}
              {selectedSkillMention && <span className="capability-state-pill skill"><Sparkles size={13} />${selectedSkillMention.name}</span>}
              {selectedPluginMention && <span className="capability-state-pill plugin"><PlugZap size={13} />@{selectedPluginMention.name}</span>}
              {contextSummary && <span className="capability-state-pill context"><ScanSearch size={13} />上下文已压缩</span>}
              {capabilityNotice && <span className="capability-state-message">{capabilityNotice}</span>}
            </div>
          )}
          <Transcript
            mode={mode}
            running={running}
            activity={turnActivity}
            elapsedSeconds={turnElapsedSeconds}
            messages={conversationMessages}
            executionTracks={agentExecutionTracks}
            generatedImages={generatedImages}
            turnMessage={turnMessage}
            previewExample={previewRenderer}
            canContinueAgent={resumableAgentTurn}
            onContinueAgent={() => { void continueAgentExecution() }}
            onChooseStarter={chooseConversationStarter}
            onOpenDock={openDock}
            onRetryMessage={(message) => { void retryAssistantMessage(message) }}
            onForkFromMessage={(message) => { void forkFromMessage(message) }}
          />
          {dock && <WorkbenchDock
            active={dock}
            previewExample={previewRenderer}
            workspaceToken={workspaceToken}
            taskId={conversation.backendTaskId ?? ''}
            gitBase={settingsPreferences.gitBase}
            onChange={setDock}
            onClose={() => setDock(null)}
            height={workspaceLayout.snapshot.dockHeight}
            onHeightChange={workspaceLayout.actions.resizeDock}
          />}
          <Composer
            modelSelection={modelSelection}
            modelSelectionActions={modelSelectionActions}
            composer={composer}
            composerActions={composerActions}
            permission={permission}
            onPermissionChange={setPermission}
            endpoint={relayEndpoint}
            endpointConfirmed={chatEndpointConfirmed}
            readOnlyMessage={selectedTaskReadOnly && !selectedTaskCanImport
              ? '这条外部历史暂时不能继续；请新建任务。'
              : selectedTaskArchived
                ? '该会话已归档；移出归档后才能继续发送。'
                : ''}
            running={running}
            disabled={workspaceSwitching}
            onSubmit={submitComposer}
            onStop={stopTurn}
            canContinueInBackground={conversationRuntime === 'desktop'
              && mode === 'agent'
              && conversation.turnState === 'active'
              && Boolean(conversation.backendTaskId)
              && !pendingApproval}
            backgrounding={backgroundTasks.attaching}
            onContinueInBackground={continueTurnInBackground}
            sessionTokens={sessionTokens}
            queuedMessages={queuedMessages}
            onQueueMessage={queueComposerMessage}
            onRemoveQueuedMessage={removeQueuedMessage}
          />
        </main>

        {!contextInspectorCompact && <div
          className="workspace-resize-handle horizontal inspector-handle"
          role="separator"
          aria-label="调整环境栏宽度"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={460}
          aria-valuenow={workspaceLayout.snapshot.inspectorWidth}
          tabIndex={0}
          onPointerDown={(event) => beginPointerResize({
            event,
            axis: 'horizontal',
            startSize: workspaceLayout.snapshot.inspectorWidth,
            direction: -1,
            onResize: workspaceLayout.actions.resizeInspector,
          })}
          onKeyDown={(event) => resizeFromKeyboard({
            event,
            axis: 'horizontal',
            currentSize: workspaceLayout.snapshot.inspectorWidth,
            direction: -1,
            onResize: workspaceLayout.actions.resizeInspector,
          })}
        />}

        <ContextInspector
          open={contextOpen}
          compactWhenIdle={contextInspectorCompact}
          mode={mode}
          subagentsEnabled={localSubagents}
          messages={conversationMessages}
          executionTracks={agentExecutionTracks}
          previewExample={previewRenderer}
          workspaceToken={workspaceToken}
          workspaceName={workspaceName}
          taskId={conversation.backendTaskId}
          runtime={runtime}
          onOpenDock={openDock}
          onNotice={conversationActions.setNotice}
          onOpen={() => setContextOpen(true)}
          onClose={() => setContextOpen(false)}
        />
          </div>

          <div className={`drawer-scrim ${tasksOpen || contextOpen ? 'visible' : ''}`} onClick={closeDrawers} aria-hidden="true" />
          <aside
            aria-hidden={!tasksOpen}
            aria-label="任务面板"
            className={`task-drawer ${tasksOpen ? 'is-open' : ''}`}
            inert={!tasksOpen}
          >
            <SidebarContents
              mode={mode}
              groups={taskGroups}
              selectedTask={selectedTask}
              onSelectTask={selectTask}
              onNewTask={newTask}
              onArchiveTask={(task, archived) => { void setHistoryTaskArchived(task, archived) }}
              onRenameTask={(task, title) => { void renameHistoryTask(task, title) }}
              onDeleteTask={requestHistoryTaskDelete}
              onOpenSettings={openSettings}
              onOpenHelp={() => openSettingsView('shortcuts')}
              onOpenUserCenter={openUserCenter}
              accountName={accountDisplayName}
              connectionLabel={connectionLabel}
              modelConnected={modelConnected}
              currentTaskRunning={interactionBusy}
              historyActionTaskId={historyActionTaskId}
              backgroundTaskPanel={backgroundTaskPanel}
              onModeChange={changeMode}
              onOpenStudio={() => {
                if (interactionBusy) return
                closeDrawers()
                setSurface('studio')
              }}
              drawer
              onClose={() => setTasksOpen(false)}
            />
          </aside>

          {pendingDeleteTask && (
            <div className="modal-scrim" role="presentation">
              <div
                className="access-confirm approval-confirm delete-conversation-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-conversation-title"
                aria-describedby="delete-conversation-description"
                onKeyDown={(event) => {
                  const busy = historyActionTaskId === pendingDeleteTask.id
                  if (event.key === 'Escape' && !busy) {
                    event.preventDefault()
                    setPendingDeleteTask(null)
                    conversationActions.clearHistoryError()
                    return
                  }
                  if (event.key !== 'Tab') return
                  const focusable = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button:not(:disabled)'
                  )]
                  if (focusable.length === 0) return
                  const first = focusable[0]!
                  const last = focusable.at(-1)!
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                  }
                }}
              >
                <div className="access-confirm-icon delete-confirm-icon"><AlertCircle size={18} /></div>
                <div>
                  <strong id="delete-conversation-title">
                    {pendingDeleteTask.readOnly
                      ? '从列表移除该外部会话？'
                      : `删除${pendingDeleteTask.mode === 'agent' ? ' Agent 任务' : ' Chat 对话'}？`}
                  </strong>
                  <p className="delete-conversation-name">{pendingDeleteTask.title}</p>
                  <small id="delete-conversation-description">
                    {pendingDeleteTask.readOnly
                      ? '只会将它从本应用的历史列表隐藏；外部工具中的原始记录不受影响。'
                      : '这会永久删除保存在此设备上的该会话，操作无法恢复。'}
                  </small>
                  {historyDeleteError && <small className="delete-dialog-error" role="alert">{historyDeleteError}</small>}
                </div>
                <div className="access-confirm-actions">
                  <button
                    type="button"
                    autoFocus
                    disabled={historyActionTaskId === pendingDeleteTask.id}
                    onClick={() => {
                      setPendingDeleteTask(null)
                      conversationActions.clearHistoryError()
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="confirm-delete"
                    disabled={
                      historyActionTaskId === pendingDeleteTask.id
                      || (running && selectedTask === pendingDeleteTask.id)
                    }
                    onClick={() => { void confirmHistoryTaskDelete() }}
                  >
                    {historyActionTaskId === pendingDeleteTask.id
                      ? (pendingDeleteTask.readOnly ? '正在移除…' : '正在删除…')
                      : (pendingDeleteTask.readOnly ? '从列表移除' : '删除会话')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {projectInitPreview && (
            <div className="modal-scrim" role="presentation">
              <div
                className="access-confirm init-preview-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="project-init-preview-title"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !projectInitCommitting) {
                    event.preventDefault()
                    void dismissProjectInit()
                    return
                  }
                  if (event.key !== 'Tab') return
                  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), [tabindex="0"]'
                  )]
                  if (focusable.length === 0) return
                  const first = focusable[0]!
                  const last = focusable.at(-1)!
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                  }
                }}
              >
                <header className="init-preview-header">
                  <span className="access-confirm-icon"><FileText size={18} /></span>
                  <div>
                    <strong id="project-init-preview-title">预览 AGENTS.md</strong>
                    <small>{projectInitPreview.target === 'create' ? '新建文件' : '原子替换现有文件'}</small>
                  </div>
                  <button
                    type="button"
                    className="init-preview-close"
                    aria-label="关闭草稿预览"
                    disabled={projectInitCommitting}
                    onClick={() => { void dismissProjectInit() }}
                  >
                    <X size={16} />
                  </button>
                </header>
                <div className="init-preview-meta">
                  <span>AGENTS.md</span>
                  <code>{projectInitPreview.contentSha256.slice(0, 12)}</code>
                </div>
                <pre className="init-preview-content" tabIndex={0} aria-label="AGENTS.md 草稿内容">{projectInitPreview.content}</pre>
                <div className="access-confirm-actions init-preview-actions">
                  <button
                    type="button"
                    autoFocus
                    disabled={projectInitCommitting}
                    onClick={() => { void dismissProjectInit() }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="confirm-approval"
                    disabled={projectInitCommitting}
                    onClick={() => { void commitProjectInit() }}
                  >
                    {projectInitCommitting ? <LoaderCircle className="spin" size={14} /> : <FileText size={14} />}
                    {projectInitCommitting ? '正在确认' : '写入此草稿'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {pendingApproval && (
            <div className="modal-scrim" role="presentation">
              <div
                className="access-confirm approval-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="agent-approval-title"
              >
                <div className="access-confirm-icon"><Shield size={18} /></div>
                {pendingApproval.question ? (
                  <>
                    <div>
                      <strong id="agent-approval-title">Agent 想请你决定</strong>
                      <p>{pendingApproval.label}</p>
                      <small>你的选择只影响本轮的后续步骤；「暂不回答」让模型按自己的判断继续。</small>
                    </div>
                    <div className="access-confirm-actions approval-question-options">
                      <button type="button" disabled={resolvingApproval} onClick={() => { void resolveApproval('deny') }}>暂不回答</button>
                      {pendingApproval.question.options.slice(0, 4).map((option, index) => (
                        <button
                          key={`${index}:${option}`}
                          type="button"
                          className="confirm-approval"
                          disabled={resolvingApproval}
                          onClick={() => { void resolveApproval(`option:${index as 0 | 1 | 2 | 3}`) }}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <strong id="agent-approval-title">批准这一次本地操作？</strong>
                      <p>{pendingApproval.label}</p>
                      {pendingApproval.detail && (
                        <pre className="approval-detail-preview">{pendingApproval.detail}</pre>
                      )}
                      <small>
                        {pendingApproval.allowSessionScope
                          ? '「仅允许这一次」只绑定当前工具调用；「本工作区总是允许」对本工作区同类操作持续生效，可在设置中撤销。'
                          : '授权只绑定当前 Agent 回合、工具调用和已选择工作区，提交后立即失效。'}
                      </small>
                    </div>
                    <div className="access-confirm-actions">
                      <button type="button" disabled={resolvingApproval} onClick={() => { void resolveApproval('deny') }}>拒绝</button>
                      {pendingApproval.allowSessionScope && (
                        <button type="button" disabled={resolvingApproval} onClick={() => { void resolveApproval('allow_session') }}>
                          本工作区总是允许
                        </button>
                      )}
                      <button type="button" className="confirm-approval" disabled={resolvingApproval} onClick={() => { void resolveApproval('allow_once') }}>
                        {resolvingApproval ? '正在提交…' : '仅允许这一次'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
      <ActivityCenter
        open={activityCenterOpen}
        mode={mode}
        foregroundTitle={title}
        foregroundRunning={running}
        foregroundActivity={turnActivity?.detail ?? ''}
        foregroundWaitingApproval={Boolean(pendingApproval)}
        backgroundTasks={backgroundTasks.tasks}
        backgroundTaskPanel={backgroundTaskPanel}
        studio={studioActivity}
        studioItems={studioRunItems}
        onOpenStudioQueue={() => jumpToStudioPage('queue')}
        onClose={() => setActivityCenterOpen(false)}
      />
      <ToastHost />
      <GlobalCommandCenter
        open={commandCenterOpen}
        items={globalCommandItems}
        onClose={() => setCommandCenterOpen(false)}
      />
    </div>
  )
}
