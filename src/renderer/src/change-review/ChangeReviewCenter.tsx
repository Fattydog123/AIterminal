import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Crosshair,
  FileCode2,
  FileDiff,
  FolderOpen,
  GitCompareArrows,
  History,
  LoaderCircle,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GitFileSummary, WorkspaceChangeState, WorkspaceDirectoryEntry } from '../../../shared/contracts'
import { pushToast } from '../ui/toast-store'
import { groupDiffHunks, mergeDiffFiles, parseUnifiedDiff, rebuildHunkText, type DiffHunk } from './change-review'

interface TreeState {
  readonly entries: Readonly<Record<string, readonly WorkspaceDirectoryEntry[]>>
  readonly expanded: ReadonlySet<string>
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function DirectoryTree({
  path,
  tree,
  depth,
  selectedPath,
  onToggle,
  onOpenFile,
}: {
  readonly path: string
  readonly tree: TreeState
  readonly depth: number
  readonly selectedPath: string
  readonly onToggle: (path: string) => void
  readonly onOpenFile: (path: string) => void
}) {
  const entries = tree.entries[path] ?? []
  return (
    <div role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? '工作区文件树' : undefined}>
      {entries.map((entry) => {
        const expanded = tree.expanded.has(entry.relativePath)
        if (entry.kind === 'directory') {
          return (
            <div key={entry.relativePath}>
              <button
                type="button"
                role="treeitem"
                aria-expanded={expanded}
                style={{ paddingLeft: 7 + depth * 14 }}
                onClick={() => onToggle(entry.relativePath)}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FolderOpen size={14} />
                <span title={entry.relativePath}>{fileName(entry.relativePath)}</span>
              </button>
              {expanded && (
                <DirectoryTree
                  path={entry.relativePath}
                  tree={tree}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                />
              )}
            </div>
          )
        }
        return (
          <button
            type="button"
            role="treeitem"
            aria-selected={selectedPath === entry.relativePath}
            className={selectedPath === entry.relativePath ? 'is-active' : ''}
            key={entry.relativePath}
            style={{ paddingLeft: 7 + depth * 14 + 16 }}
            onClick={() => onOpenFile(entry.relativePath)}
          >
            <FileCode2 size={14} />
            <span title={entry.relativePath}>{fileName(entry.relativePath)}</span>
          </button>
        )
      })}
    </div>
  )
}

export default function ChangeReviewCenter({
  workspaceToken,
  taskId = '',
  initialMode = 'changes',
  gitBase = 'current',
}: {
  readonly workspaceToken: string
  readonly taskId?: string
  readonly initialMode?: 'changes' | 'files'
  readonly gitBase?: 'current' | 'main'
}) {
  const [mode, setMode] = useState(initialMode)
  const [files, setFiles] = useState<readonly GitFileSummary[]>([])
  const [patch, setPatch] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [tree, setTree] = useState<TreeState>({ entries: {}, expanded: new Set() })
  const [openedFile, setOpenedFile] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [highlightLine, setHighlightLine] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [reverting, setReverting] = useState('')
  const [error, setError] = useState('')
  const [changeState, setChangeState] = useState<WorkspaceChangeState | null>(null)
  const [checkpointBusy, setCheckpointBusy] = useState(false)
  const codeRef = useRef<HTMLDivElement>(null)

  const loadChanges = useCallback(async (): Promise<void> => {
    if (!workspaceToken || !('onekey' in window)) return setError('发送一项 Agent 任务后即可查看工作区变更。')
    setLoading(true)
    setError('')
    const [summary, diff] = await Promise.all([
      window.onekey.workspace.gitSummary({ workspaceToken, base: gitBase }),
      window.onekey.workspace.gitDiff({ workspaceToken, base: gitBase }),
    ])
    setLoading(false)
    if (!summary.ok) return setError(summary.error.message)
    if (!diff.ok) return setError(diff.error.message)
    setFiles(summary.value.files)
    setPatch(diff.value.patch)
    setSelectedPath((current) => summary.value.files.some((file) => file.relativePath === current)
      ? current
      : summary.value.files[0]?.relativePath || '')
  }, [workspaceToken, gitBase])

  const loadChangeState = useCallback(async (): Promise<void> => {
    if (!taskId || !('onekey' in window)) return
    const result = await window.onekey.workspace.changes({ taskId })
    if (result.ok) setChangeState(result.value)
  }, [taskId])

  const loadDirectory = useCallback(async (path: string): Promise<readonly WorkspaceDirectoryEntry[] | null> => {
    if (!workspaceToken || !('onekey' in window)) {
      setError('发送一项 Agent 任务后即可浏览工作区文件。')
      return null
    }
    const result = await window.onekey.workspace.listDirectory({ workspaceToken, relativePath: path })
    if (!result.ok) {
      setError(result.error.message)
      return null
    }
    setTree((current) => ({ ...current, entries: { ...current.entries, [path]: result.value.entries } }))
    return result.value.entries
  }, [workspaceToken])

  const toggleDirectory = useCallback((path: string): void => {
    setTree((current) => {
      const expanded = new Set(current.expanded)
      if (expanded.has(path)) expanded.delete(path)
      else expanded.add(path)
      return { ...current, expanded }
    })
    setTree((current) => {
      if (current.entries[path]) return current
      void loadDirectory(path)
      return current
    })
  }, [loadDirectory])

  const openFile = useCallback(async (path: string, line: number | null = null): Promise<void> => {
    if (!workspaceToken || !('onekey' in window)) return
    setOpenedFile(path)
    setHighlightLine(line)
    setLoading(true)
    setError('')
    const result = await window.onekey.workspace.readFile({ workspaceToken, relativePath: path })
    setLoading(false)
    if (!result.ok) return setError(result.error.message)
    setFileContent(result.value.content)
  }, [workspaceToken])

  const locateInFile = useCallback((path: string, line: number | null): void => {
    setMode('files')
    void openFile(path, line)
  }, [openFile])

  useEffect(() => {
    if (mode === 'changes') {
      void loadChanges()
      void loadChangeState()
    } else if (!tree.entries['.']) {
      void loadDirectory('.')
    }
  }, [loadChanges, loadChangeState, loadDirectory, mode, tree.entries])

  useEffect(() => {
    if (highlightLine === null || !fileContent) return
    const target = codeRef.current?.querySelector<HTMLElement>(`[data-line="${highlightLine}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [fileContent, highlightLine])

  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch])
  const reviewedFiles = useMemo(() => mergeDiffFiles(files, parsed), [files, parsed])
  const selectedFile = reviewedFiles.find((file) => file.relativePath === selectedPath)
  const selectedHunks = useMemo(
    () => selectedFile?.diff ? groupDiffHunks(selectedFile.diff) : [],
    [selectedFile?.diff],
  )
  const totals = files.reduce((value, file) => ({ additions: value.additions + file.additions, deletions: value.deletions + file.deletions }), { additions: 0, deletions: 0 })
  const fileRevertable = selectedFile !== undefined && selectedFile.status !== 'added' && selectedFile.status !== 'untracked'

  const revertFile = async (relativePath: string): Promise<void> => {
    if (!('onekey' in window) || !workspaceToken) return
    if (!window.confirm(`撤销 ${relativePath} 的全部修改？该操作会把它恢复到最近一次提交。`)) return
    setReverting(relativePath)
    const result = await window.onekey.workspace.gitRevert({ workspaceToken, relativePaths: [relativePath], taskId })
    setReverting('')
    if (!result.ok) {
      pushToast({ kind: 'danger', title: '文件回退失败', detail: result.error.message })
      return
    }
    const failed = result.value.failed[0]
    if (failed) {
      pushToast({ kind: 'warning', title: '未能回退', detail: `${failed.relativePath}：${failed.message}` })
    } else {
      pushToast({ kind: 'success', title: '已撤销文件修改', detail: relativePath })
    }
    await loadChanges()
  }

  const revertHunk = async (relativePath: string, hunk: DiffHunk): Promise<void> => {
    if (!('onekey' in window) || !workspaceToken) return
    if (!window.confirm(`撤销该变更块（+${hunk.additions} / -${hunk.deletions}）？`)) return
    setReverting(hunk.id)
    const result = await window.onekey.workspace.gitRevertHunk({
      workspaceToken,
      relativePath,
      hunkText: rebuildHunkText(hunk),
      taskId,
    })
    setReverting('')
    if (!result.ok) {
      pushToast({ kind: 'danger', title: '变更块回退失败', detail: result.error.message })
      return
    }
    pushToast({ kind: 'success', title: '已撤销变更块', detail: relativePath })
    await loadChanges()
  }

  const createCheckpoint = async (): Promise<void> => {
    if (!taskId || !('onekey' in window)) return
    setCheckpointBusy(true)
    const label = `审查检查点 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    const result = await window.onekey.workspace.checkpoint({ taskId, label })
    setCheckpointBusy(false)
    if (!result.ok) {
      pushToast({ kind: 'danger', title: '创建检查点失败', detail: result.error.message })
      return
    }
    setChangeState(result.value)
    pushToast({ kind: 'success', title: '已创建检查点', detail: label })
  }

  const rewindTo = async (checkpointId: string, label: string): Promise<void> => {
    if (!taskId || !('onekey' in window)) return
    if (!window.confirm(`回退整个工作区到检查点“${label}”？此后的未提交修改都会被替换。`)) return
    setCheckpointBusy(true)
    const result = await window.onekey.workspace.rewind({ taskId, checkpointId })
    setCheckpointBusy(false)
    if (!result.ok) {
      pushToast({ kind: 'danger', title: '回退失败', detail: result.error.message })
      return
    }
    setChangeState(result.value)
    pushToast({ kind: 'success', title: '已回退到检查点', detail: label })
    await loadChanges()
  }

  const latestCheckpoints = changeState ? [...changeState.checkpoints].slice(-3).reverse() : []
  const pendingWorktrees = changeState?.worktrees.filter((worktree) => worktree.status === 'ready') ?? []

  const mutateWorktree = async (worktreeId: string, action: 'apply' | 'discard'): Promise<void> => {
    if (!taskId || !('onekey' in window)) return
    const verb = action === 'apply' ? '应用' : '丢弃'
    if (!window.confirm(`${verb}这个隔离工作树的修改？`)) return
    setCheckpointBusy(true)
    const result = action === 'apply'
      ? await window.onekey.workspace.worktreeApply({ taskId, worktreeId })
      : await window.onekey.workspace.worktreeDiscard({ taskId, worktreeId })
    setCheckpointBusy(false)
    if (!result.ok) {
      pushToast({ kind: 'danger', title: `${verb}工作树失败`, detail: result.error.message })
      return
    }
    setChangeState(result.value)
    pushToast({ kind: 'success', title: `已${verb}工作树修改` })
    await loadChanges()
  }

  return (
    <section className="change-review-center" aria-label="文件与变更审查中心">
      <header className="change-review-toolbar">
        <div role="tablist" aria-label="审查视图">
          <button type="button" role="tab" aria-selected={mode === 'changes'} className={mode === 'changes' ? 'is-active' : ''} onClick={() => setMode('changes')}><FileDiff size={14} />变更</button>
          <button type="button" role="tab" aria-selected={mode === 'files'} className={mode === 'files' ? 'is-active' : ''} onClick={() => setMode('files')}><FolderOpen size={14} />文件</button>
        </div>
        <span>
          {mode === 'changes'
            ? <>{files.length} 个文件 <b>+{totals.additions}</b> <em>-{totals.deletions}</em>{gitBase === 'main' && <span className="change-review-base" title="比较基准为 main 分支（在设置中可改）">对比 main</span>}</>
            : openedFile || '工作区文件'}
        </span>
        {taskId && mode === 'changes' && (
          <button type="button" className="change-review-checkpoint" disabled={checkpointBusy} onClick={() => void createCheckpoint()} title="为当前工作区创建可回退的检查点">
            {checkpointBusy ? <LoaderCircle className="spin" size={13} /> : <History size={13} />}检查点
          </button>
        )}
        <button type="button" aria-label="刷新" onClick={() => {
          if (mode === 'changes') {
            void loadChanges()
            void loadChangeState()
          } else {
            setTree({ entries: {}, expanded: new Set() })
            void loadDirectory('.')
          }
        }}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button>
      </header>
      {taskId && mode === 'changes' && (latestCheckpoints.length > 0 || pendingWorktrees.length > 0) && (
        <div className="change-review-checkpoints" role="group" aria-label="检查点与工作树">
          {latestCheckpoints.map((checkpoint) => (
            <button
              type="button"
              key={checkpoint.id}
              disabled={checkpointBusy}
              onClick={() => void rewindTo(checkpoint.id, checkpoint.label)}
              title={`回退到 ${new Date(checkpoint.createdAt).toLocaleString('zh-CN')}`}
            >
              <Undo2 size={12} />{checkpoint.label}
            </button>
          ))}
          {pendingWorktrees.map((worktree) => (
            <span className="change-review-worktree" key={worktree.id}>
              <GitCompareArrows size={12} />隔离工作树{worktree.changedFiles !== null ? ` · ${worktree.changedFiles} 文件` : ''}
              <button type="button" disabled={checkpointBusy} onClick={() => void mutateWorktree(worktree.id, 'apply')}>应用</button>
              <button type="button" disabled={checkpointBusy} onClick={() => void mutateWorktree(worktree.id, 'discard')}>丢弃</button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="change-review-error"><AlertCircle size={15} />{error}</div>}
      {!error && <div className="change-review-layout">
        <aside className="change-review-files">
          {mode === 'changes' ? reviewedFiles.map((file) => (
            <button type="button" className={selectedPath === file.relativePath ? 'is-active' : ''} key={file.relativePath} onClick={() => setSelectedPath(file.relativePath)}>
              <FileCode2 size={14} /><span title={file.relativePath}>{file.relativePath}</span><small><b>+{file.additions}</b><em>-{file.deletions}</em></small>
            </button>
          )) : (
            <DirectoryTree
              path="."
              tree={tree}
              depth={0}
              selectedPath={openedFile}
              onToggle={toggleDirectory}
              onOpenFile={(path) => void openFile(path)}
            />
          )}
          {!loading && ((mode === 'changes' && files.length === 0) || (mode === 'files' && (tree.entries['.'] ?? []).length === 0)) && <p>这里暂时没有内容</p>}
        </aside>
        <div className="change-review-code" ref={codeRef}>
          {loading && <div className="change-review-empty"><LoaderCircle className="spin" size={20} />正在读取工作区</div>}
          {!loading && mode === 'changes' && selectedFile && (
            <div className="change-review-file-actions">
              <span title={selectedFile.relativePath}>{selectedFile.relativePath}</span>
              <button
                type="button"
                disabled={!fileRevertable || reverting === selectedFile.relativePath}
                title={fileRevertable ? '把该文件恢复到最近一次提交' : '新增文件没有可回退的提交版本'}
                onClick={() => void revertFile(selectedFile.relativePath)}
              >
                {reverting === selectedFile.relativePath ? <LoaderCircle className="spin" size={13} /> : <Undo2 size={13} />}撤销文件修改
              </button>
            </div>
          )}
          {!loading && mode === 'changes' && selectedHunks.map((hunk) => (
            <div className="change-review-hunk" key={hunk.id}>
              <div className="change-review-hunk-head">
                <code>{hunk.header}</code>
                <small><b>+{hunk.additions}</b> <em>-{hunk.deletions}</em></small>
                <button
                  type="button"
                  disabled={reverting === hunk.id}
                  title="只撤销这个变更块"
                  onClick={() => selectedFile && void revertHunk(selectedFile.relativePath, hunk)}
                >
                  {reverting === hunk.id ? <LoaderCircle className="spin" size={12} /> : <Undo2 size={12} />}撤销此块
                </button>
              </div>
              {hunk.lines.map((line) => (
                <div
                  className={`diff-line ${line.kind}${line.kind !== 'meta' ? ' is-locatable' : ''}`}
                  key={line.id}
                  role={line.kind !== 'meta' ? 'button' : undefined}
                  tabIndex={line.kind !== 'meta' ? 0 : undefined}
                  title="点击在文件视图中定位"
                  onClick={() => {
                    if (line.kind === 'meta' || !selectedFile) return
                    locateInFile(selectedFile.relativePath, line.newLine ?? line.oldLine)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || line.kind === 'meta' || !selectedFile) return
                    locateInFile(selectedFile.relativePath, line.newLine ?? line.oldLine)
                  }}
                >
                  <span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span>
                  <code>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}{line.text}</code>
                  {line.kind !== 'meta' && <Crosshair className="diff-line-locate" size={11} aria-hidden="true" />}
                </div>
              ))}
            </div>
          ))}
          {!loading && mode === 'changes' && selectedFile && selectedHunks.length === 0 && <div className="change-review-empty">{selectedFile.status === 'untracked' || selectedFile.status === 'added' ? '新增文件：切换到“文件”视图查看完整内容' : '这个文件暂时没有可显示的补丁'}</div>}
          {!loading && mode === 'changes' && !selectedFile && <div className="change-review-empty">选择左侧文件查看具体变更</div>}
          {!loading && mode === 'files' && openedFile && fileContent && (
            <pre className="change-review-source"><code>
              {fileContent.split('\n').map((line, index) => (
                <div
                  className={`source-line${highlightLine === index + 1 ? ' is-highlight' : ''}`}
                  data-line={index + 1}
                  key={index}
                >
                  <span>{index + 1}</span><em>{line}</em>
                </div>
              ))}
            </code></pre>
          )}
          {!loading && mode === 'files' && (!openedFile || !fileContent) && <div className="change-review-empty">在左侧文件树中选择文件查看内容</div>}
        </div>
      </div>}
    </section>
  )
}
