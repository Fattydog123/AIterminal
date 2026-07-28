import { useState } from 'react'
import { Icon } from '../components/Icon.js'
import { ExposureRail, StatusPill } from '../components/Primitives.js'
import { StudioSelect } from '../components/StudioSelect.js'
import { useStudioStore } from '../store/studioStore.js'

const requestStateLabel = (state: string | undefined): string => ({
  not_sent: '尚未发送',
  dispatching: '正在发送',
  sent: '已发送',
  billing_unknown: '费用待确认',
  completed: '已完成',
  unknown: '状态待确认',
} as Readonly<Record<string, string>>)[state ?? 'unknown'] ?? '状态待确认'

const recoveryStateLabel = (state: string): string => ({
  paused: '已暂停',
  queued: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
} as Readonly<Record<string, string>>)[state] ?? '状态已更新'

type QueueItem = ReturnType<typeof useStudioStore.getState>['queue'][number]

// 计数与筛选共用同一个谓词：过去「等待」计数排除已暂停任务而筛选不排除，
// 点「等待 1」可能列出 3 行。待恢复在这里成为可筛选状态。
const matchesStatus = (item: QueueItem, value: string): boolean =>
  value === 'all' ? true
    : value === 'paused' ? item.persistentStatus === 'paused'
    : value === 'queued' ? item.status === 'queued' && item.persistentStatus !== 'paused'
    : item.status === value

const statusChips = [
  { value: 'all', label: '全部', tone: '', icon: undefined, caption: undefined },
  { value: 'running', label: '执行中', tone: 'running', icon: 'pulse', caption: '逐项执行' },
  { value: 'queued', label: '等待', tone: 'queued', icon: 'queue', caption: '按创建顺序排列' },
  { value: 'paused', label: '待恢复', tone: 'paused', icon: 'clock', caption: undefined },
  { value: 'success', label: '完成', tone: 'success', icon: 'check', caption: undefined },
  { value: 'error', label: '失败', tone: 'error', icon: 'error', caption: undefined },
  { value: 'billing-unknown', label: '费用待确认', tone: 'cost', icon: 'spark', caption: undefined },
] as const

export function QueuePage() {
  const queue = useStudioStore((state) => state.queue)
  const selectedId = useStudioStore((state) => state.selectedQueueId)
  const select = useStudioStore((state) => state.selectQueue)
  const cancel = useStudioStore((state) => state.cancelTask)
  const resumePersistent = useStudioStore((state) => state.resumePersistentRun)
  const removePersistent = useStudioStore((state) => state.removePersistentRun)
  const navigate = useStudioStore((state) => state.navigate)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const filtered = queue.filter((item) => matchesStatus(item, status) && `${item.id}${item.title}${item.workflow}${item.provider}${item.message}`.toLowerCase().includes(query.toLowerCase()))
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0]
  const selectedDispatch = selected?.dispatchState
  const dispatchLabel = requestStateLabel(selectedDispatch)
  const executionLabel = selected?.persistentStatus === 'paused'
    ? '任务已暂停，等待你的决定'
    : selected?.status === 'queued'
    ? '等待执行'
    : selected?.status === 'running' && selectedDispatch === 'sent'
      ? '请求已发送'
      : selected?.status === 'running'
        ? '正在准备请求'
        : selected?.status === 'billing-unknown'
          ? '费用状态未知'
          : '已结束'
  const countFor = (value: string): number => queue.filter((item) => matchesStatus(item, value)).length
  const running = countFor('running')
  const pending = countFor('queued')
  const completed = countFor('success')
  const settled = queue.filter((item) => item.status === 'success' || item.status === 'error' || item.status === 'billing-unknown').length
  const knownCost = queue.reduce((total, item) => total + (item.cost ?? 0), 0)
  const stopAll = async (): Promise<void> => {
    await Promise.all(queue
      .filter((item) => item.persistentStatus !== 'paused' && (item.status === 'running' || item.status === 'queued'))
      .map((item) => cancel(item.id)))
  }
  return (
    <section className="standard-page queue-page">
      <header className="page-header is-compact">
        <div>
          <h1>任务队列</h1>
          <p title="查看任务进度、停止等待中的任务或取消正在运行的任务。">查看任务进度、停止等待中的任务或取消正在运行的任务。</p>
        </div>
        <div className="page-header-actions">
          <button className="danger-ghost" disabled={!running && !pending} onClick={() => void stopAll()} type="button">
            <Icon name="stop" size={14} />全部停止
          </button>
        </div>
      </header>
      <div className="queue-layout">
        <main className="queue-table-panel">
          <div aria-label="按状态筛选任务" className="queue-status-strip" role="group">
            {statusChips.map((chip) => (
              <button
                aria-pressed={status === chip.value}
                className="queue-status-chip"
                key={chip.value}
                onClick={() => setStatus(status === chip.value ? 'all' : chip.value)}
                type="button"
              >
                {chip.icon ? <span className={`summary-icon ${chip.tone}`}><Icon name={chip.icon} size={13} /></span> : null}
                <small>{chip.label}</small>
                <strong>{countFor(chip.value)}</strong>
                {chip.caption ? <em>{chip.caption}</em> : null}
              </button>
            ))}
            <span className="queue-status-ledger">
              <span><small>成功率</small><strong>{settled > 0 ? `${Math.round(completed / settled * 100)}%` : '—'}</strong><em>{settled > 0 ? '按已结束任务计算' : '暂无已结束任务'}</em></span>
              <span><small>已知费用</small><strong>{knownCost > 0 ? knownCost.toFixed(2) : '—'}</strong><em>单位沿用模型服务返回值</em></span>
            </span>
          </div>
          <div className="table-toolbar">
            <label className="search-field">
              <Icon name="search" size={14} />
              <input aria-label="搜索任务" onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" type="search" value={query} />
            </label>
            <label className="compact-filter">
              <Icon name="filter" size={14} />
              <StudioSelect
                ariaLabel="按任务状态筛选"
                onChange={setStatus}
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'queued', label: '等待' },
                  { value: 'paused', label: '待恢复' },
                  { value: 'running', label: '执行中' },
                  { value: 'success', label: '完成' },
                  { value: 'error', label: '失败' },
                  { value: 'billing-unknown', label: '费用待确认' },
                ]}
                placeholder="全部状态"
                value={status}
              />
            </label>
            <span />
            <small>状态实时更新</small>
          </div>
          <div className="data-table queue-table" role="table">
            <div className="table-row table-head" role="row"><span>状态</span><span>任务</span><span>进度</span><span>创建时间</span><span /></div>
            {filtered.map((item) => (
              <button className={`table-row ${selected?.id === item.id ? 'is-selected' : ''}`} key={item.id} onClick={() => select(item.id)} role="row" type="button">
                <span><StatusPill label={item.persistentStatus === 'paused' ? '待恢复' : item.status === 'running' ? '执行中' : item.status === 'queued' ? '等待' : item.status === 'success' ? '完成' : item.status === 'billing-unknown' ? '费用未知' : '失败'} status={item.status} /></span>
                <span className="task-cell">
                  <strong>{item.title}</strong>
                  <small title={`${item.workflow} · ${item.provider} · 费用 ${item.cost !== undefined ? item.cost.toFixed(2) : '—'}`}>
                    {item.workflow} · {item.provider} · 费用 {item.cost !== undefined ? item.cost.toFixed(2) : '—'}
                  </small>
                </span>
                <span className="progress-cell"><progress max={100} value={item.progress} /><small>{item.progress}%</small></span>
                <time>{item.createdAt}</time>
                <Icon name="chevron" size={13} />
              </button>
            ))}
            {filtered.length === 0 ? <div className="table-empty-state">没有匹配的任务</div> : null}
          </div>
          {selected?.persistentStatus === 'paused' ? (
            <section aria-label="窄窗口任务恢复操作" className="queue-compact-recovery">
              <div><strong>{selected.title}</strong><small>{selected.blockedReason ?? selected.message}</small></div>
              <footer>
                <button aria-label="恢复任务（窄窗口）" className="primary-button" disabled={!selected.canResume} onClick={() => void resumePersistent(selected.id)} type="button"><Icon name="play" size={14} />恢复任务</button>
                <button aria-label="移除恢复项（窄窗口）" className="danger-button" disabled={!selected.canRemove} onClick={() => void removePersistent(selected.id)} type="button"><Icon name="trash" size={14} />移除恢复项</button>
              </footer>
            </section>
          ) : null}
        </main>
        {selected ? (
          <aside className="queue-inspector">
            <header><div><h2>{selected.title}</h2></div></header>
            <section className="task-state-card">
              <StatusPill label={executionLabel} status={selected.status} />
              <strong>{selected.progress}%</strong>
              <progress max={100} value={selected.progress} />
              <p>{selected.message}</p>
            </section>
            <section>
              <h3>任务详情</h3>
              <ExposureRail active={selected.status === 'success' ? 4 : selectedDispatch === 'sent' || selectedDispatch === 'billing_unknown' ? 1 : 0} />
              <dl className="metadata-list">
                <div><dt>任务编号</dt><dd>{selected.id}</dd></div>
                <div><dt>工作流</dt><dd>{selected.workflow}</dd></div>
                <div><dt>模型服务</dt><dd>{selected.provider}</dd></div>
                <div><dt>已知费用</dt><dd>{selected.cost !== undefined ? `${selected.cost.toFixed(2)}（单位同模型服务）` : '模型服务未提供'}</dd></div>
                {selected.persistentStatus ? <div><dt>恢复状态</dt><dd>{recoveryStateLabel(selected.persistentStatus)} · 第 {selected.attempt ?? 0} 次尝试</dd></div> : null}
              </dl>
            </section>
            <section>
              <h3>请求状态</h3>
              <div className={`safety-note ${selectedDispatch === 'billing_unknown' || selected.blockedReason ? 'warning-note' : ''}`}>
                <Icon name={selectedDispatch === 'billing_unknown' || selected.blockedReason ? 'warning' : 'shield'} size={17} />
                <p>
                  <strong>{dispatchLabel}</strong>
                  <span>{selected.blockedReason ?? (selectedDispatch === 'not_sent' ? '请求尚未发送。' : selectedDispatch === 'sent' ? '请求已经发送；取消后模型服务仍可能产生费用。' : selectedDispatch === 'billing_unknown' ? '连接中断或取消后无法确认费用，请在模型服务中核对。' : '这条旧任务没有完整的请求状态记录。')}</span>
                </p>
              </div>
            </section>
            <footer>
              {selected.persistentStatus === 'paused' ? (
                <>
                  <button className="primary-button" disabled={!selected.canResume} onClick={() => void resumePersistent(selected.id)} type="button"><Icon name="play" size={14} />恢复任务</button>
                  <button className="danger-button" disabled={!selected.canRemove} onClick={() => void removePersistent(selected.id)} type="button"><Icon name="trash" size={14} />移除恢复项</button>
                </>
              ) : (
                <button className="danger-button" disabled={selected.status !== 'running' && selected.status !== 'queued'} onClick={() => void cancel(selected.id)} type="button"><Icon name="stop" size={14} />取消任务</button>
              )}
              <button className="secondary-button" onClick={() => navigate('runs')} type="button"><Icon name="terminal" size={14} />查看运行记录</button>
            </footer>
          </aside>
        ) : null}
      </div>
    </section>
  )
}
