import { useState } from 'react'
import { Icon } from '../components/Icon.js'
import { ExposureRail, StatusPill } from '../components/Primitives.js'
import { StudioSelect } from '../components/StudioSelect.js'
import { useStudioStore } from '../store/studioStore.js'
import type { ExecutionTimelineEvent } from '@studio/shared/types.js'

const phaseLabels = {
  queue: '排队',
  provider: '模型生成',
  download: '接收结果',
  decode: '处理结果',
  persist: '保存结果',
} as const

const requestStateLabel = (state: string): string => ({
  not_sent: '尚未发送',
  dispatching: '正在发送',
  sent: '已发送',
  billing_unknown: '费用待确认',
  completed: '已完成',
} as Readonly<Record<string, string>>)[state] ?? '状态待确认'

const userFacingMessage = (message: string | undefined): string | undefined => message
  ?.replace(/Provider/gi, '模型服务')
  .replace(/Workflow/gi, '工作流')
  .replace(/main process|主进程/gi, '桌面服务')
  .replace(/preload bridge|预加载桥/gi, '桌面功能')

const statusLabel = (status: 'succeeded' | 'failed' | 'cancelled'): string =>
  status === 'succeeded' ? '成功' : status === 'cancelled' ? '已取消' : '失败'

const statusTone = (status: 'succeeded' | 'failed' | 'cancelled'): string =>
  status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'pending'

const durationText = (milliseconds: number): string =>
  milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(2)} s` : `${Math.round(milliseconds)} ms`

const shortIdentifier = (value: string): string =>
  value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`

const eventDuration = (event: ExecutionTimelineEvent): number => {
  if (event.durationMs !== undefined) return Math.max(0, event.durationMs)
  if (!event.finishedAt) return 0
  return Math.max(0, Date.parse(event.finishedAt) - Date.parse(event.startedAt))
}

const mergedIntervalDuration = (events: readonly ExecutionTimelineEvent[]): number => {
  const intervals = events
    .flatMap((event) => {
      if (!event.finishedAt) return []
      const start = Date.parse(event.startedAt)
      const finish = Date.parse(event.finishedAt)
      return Number.isFinite(start) && Number.isFinite(finish) && finish > start ? [[start, finish] as const] : []
    })
    .sort((left, right) => left[0] - right[0])
  let total = 0
  let activeStart: number | undefined
  let activeFinish: number | undefined
  for (const [start, finish] of intervals) {
    if (activeStart === undefined || activeFinish === undefined) {
      activeStart = start
      activeFinish = finish
    } else if (start <= activeFinish) {
      activeFinish = Math.max(activeFinish, finish)
    } else {
      total += activeFinish - activeStart
      activeStart = start
      activeFinish = finish
    }
  }
  return total + (activeStart === undefined || activeFinish === undefined ? 0 : activeFinish - activeStart)
}

const diagnosticDurations = (events: readonly ExecutionTimelineEvent[]): Record<keyof typeof phaseLabels, number> => {
  const durations = Object.fromEntries(Object.keys(phaseLabels).map((phase) => [
    phase,
    events.filter((event) => event.phase === phase).reduce((total, event) => total + eventDuration(event), 0),
  ])) as Record<keyof typeof phaseLabels, number>
  const nestedProviderDuration = events
    .filter((event) => event.phase === 'provider' && event.finishedAt)
    .reduce((total, provider) => {
      const providerStart = Date.parse(provider.startedAt)
      const providerFinish = Date.parse(provider.finishedAt!)
      if (!Number.isFinite(providerStart) || !Number.isFinite(providerFinish)) return total
      const nested = events.filter((event) => {
        if (event.nodeId !== provider.nodeId || (event.phase !== 'download' && event.phase !== 'decode') || !event.finishedAt) return false
        const start = Date.parse(event.startedAt)
        const finish = Date.parse(event.finishedAt)
        return Number.isFinite(start) && Number.isFinite(finish) && start >= providerStart && finish <= providerFinish
      })
      return total + Math.min(eventDuration(provider), mergedIntervalDuration(nested))
    }, 0)
  durations.provider = Math.max(0, durations.provider - nestedProviderDuration)
  return durations
}

export function RunsPage() {
  const runs = useStudioStore((state) => state.runs)
  const selectedRunId = useStudioStore((state) => state.selectedRunId)
  const selectRun = useStudioStore((state) => state.selectRun)
  const exportDiagnostics = useStudioStore((state) => state.exportDiagnostics)
  const restoreRunSnapshot = useStudioStore((state) => state.restoreRunSnapshot)
  const workflowDirty = useStudioStore((state) => state.workflowDirty)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const filtered = runs.filter((run) => (status === 'all' || run.status === status) && `${run.runId}${run.workflowId}${run.error?.code ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const selected = filtered.find((run) => run.runId === selectedRunId) ?? filtered[0]

  if (runs.length === 0) {
    return (
      <section className="standard-page runs-page">
        <header className="page-header is-compact">
          <div>
            <h1>运行记录</h1>
            <p title="查看每次运行的阶段耗时、事件和诊断信息。">查看每次运行的阶段耗时、事件和诊断信息。</p>
          </div>
        </header>
        <div className="empty-page-state"><Icon name="pulse" size={30} /><h2>还没有运行记录</h2><p>执行一次工作流后，这里会显示真实阶段耗时和脱敏错误。</p></div>
      </section>
    )
  }

  if (!selected) {
    return (
      <section className="standard-page runs-page">
        <header className="page-header is-compact">
          <div>
            <h1>运行记录</h1>
            <p title="查看每次运行的阶段耗时、事件和诊断信息。">查看每次运行的阶段耗时、事件和诊断信息。</p>
          </div>
        </header>
        <div className="empty-page-state"><Icon name="search" size={30} /><h2>没有匹配的运行记录</h2><p>清除搜索词或切换状态筛选。</p><button className="secondary-button" onClick={() => { setQuery(''); setStatus('all') }} type="button">清除筛选</button></div>
      </section>
    )
  }

  const durations = diagnosticDurations(selected.events)
  const totalDuration = Object.values(durations).reduce((total, value) => total + value, 0)
  const largestPhase = (Object.entries(durations) as [keyof typeof phaseLabels, number][]).sort((left, right) => right[1] - left[1])[0]
  const cacheHits = selected.events.filter((event) => event.cacheHit).length
  const dispatchState = selected.dispatchState
    ?? selected.error?.dispatchState
    ?? (selected.error?.billingUnknown ? 'billing_unknown' : selected.events.some((event) => event.phase === 'provider') ? 'sent' : 'not_sent')
  const dispatchStateText = requestStateLabel(dispatchState)
  const phases = Object.keys(phaseLabels) as (keyof typeof phaseLabels)[]
  const errorPhase = selected.events.find((event) => event.errorCode)?.phase
  const lastObservedPhase = selected.events.reduce((latest, event) => Math.max(latest, phases.indexOf(event.phase)), 0)
  const exposureActive = selected.status === 'succeeded'
    ? phases.length - 1
    : Math.max(0, errorPhase ? phases.indexOf(errorPhase) : lastObservedPhase)
  const restoreAsDraft = (): void => {
    if (workflowDirty && !window.confirm('当前工作流有未保存修改。恢复运行快照会替换当前画布，是否继续？')) return
    restoreRunSnapshot(selected.runId)
  }
  const baseline = runs
    .filter((run) => run.workflowId === selected.workflowId
      && run.runId !== selected.runId
      && new Date(run.createdAt).getTime() <= new Date(selected.createdAt).getTime())
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0]
  const baselineDurations = baseline ? diagnosticDurations(baseline.events) : undefined
  const baselineTotal = baselineDurations ? Object.values(baselineDurations).reduce((total, value) => total + value, 0) : 0
  const durationDelta = baseline && baselineTotal > 0 ? Math.round(((totalDuration - baselineTotal) / baselineTotal) * 100) : undefined
  // 已取消的运行不能落进成功绿（statusTone('cancelled') 是 'pending'，过去会渲染
  // 绿勾 +「X是主要耗时」）；费用告警以 dispatchState 为准，error.billingUnknown
  // 为假时 dispatchState 仍可能是 billing_unknown。
  const verdictWarning = selected.status !== 'succeeded' || dispatchState === 'billing_unknown'
  const verdictTitle = selected.status === 'failed' ? '运行失败'
    : selected.status === 'cancelled' ? '运行已取消'
    : `${largestPhase ? phaseLabels[largestPhase[0]] : '暂无'}是主要耗时`
  const verdictBody = [
    selected.status === 'cancelled'
      ? '本次运行已取消；已记录的阶段耗时见下方时间线。'
      : userFacingMessage(selected.error?.message) ?? (largestPhase ? `该阶段共 ${durationText(largestPhase[1])}。` : '暂无阶段记录。'),
    dispatchState === 'billing_unknown' ? '连接中断或取消后无法确认费用，请在模型服务中核对。' : undefined,
  ].filter(Boolean).join('')

  return (
    <section className="standard-page runs-page">
      <header className="page-header is-compact">
        <div>
          <h1>运行记录</h1>
          <p title="查看每次运行的阶段耗时、事件和诊断信息。">查看每次运行的阶段耗时、事件和诊断信息。</p>
        </div>
        <div className="page-header-actions">
          <button className="secondary-button" disabled={!selected.workflowSnapshot} onClick={restoreAsDraft} title={selected.workflowSnapshot ? '加载当时的输入为未保存草稿；不会自动重新运行' : '旧记录没有工作流快照'} type="button"><Icon name="clock" size={14} />从记录恢复草稿</button>
          <button className="secondary-button" onClick={() => void exportDiagnostics(selected.runId)} type="button"><Icon name="download" size={14} />导出诊断包</button>
        </div>
      </header>
      <div className="runs-layout">
        <aside className="run-list"><div className="run-list-toolbar"><label className="search-field"><Icon name="search" size={14} /><input aria-label="搜索运行" onChange={(event) => setQuery(event.target.value)} placeholder="搜索运行编号或工作流" value={query} /></label><label className="compact-filter"><Icon name="filter" size={14} /><StudioSelect ariaLabel="按运行状态筛选" onChange={setStatus} options={[{ value: 'all', label: '全部' }, { value: 'succeeded', label: '成功' }, { value: 'failed', label: '失败' }, { value: 'cancelled', label: '取消' }]} placeholder="全部" value={status} /></label></div>{filtered.map((run) => <button className={selected.runId === run.runId ? 'is-active' : ''} key={run.runId} onClick={() => selectRun(run.runId)} type="button"><span className={`run-status-line status-${statusTone(run.status)}`} /><div><strong>{run.workflowId}</strong><small title={run.runId}>{shortIdentifier(run.runId)} · {new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></div><StatusPill label={statusLabel(run.status)} status={statusTone(run.status)} /></button>)}</aside>
        <main className="run-detail">
          <header>
            <div>
              <span className="eyebrow" title={selected.runId}>运行 {shortIdentifier(selected.runId)}</span>
              <h2>{selected.workflowId}</h2>
              <p>{selected.events.length} 条性能记录 · {dispatchStateText}</p>
            </div>
            <StatusPill label={statusLabel(selected.status)} status={statusTone(selected.status)} />
          </header>
          <section className="diagnostic-panel run-verdict">
            <div className="diagnostic-panel-heading"><div><h3>结论</h3></div></div>
            <div className={`diagnosis-card ${verdictWarning ? 'warning' : ''}`}>
              <Icon name={verdictWarning ? 'warning' : 'check'} size={18} />
              <p><strong>{verdictTitle}</strong><span>{verdictBody}</span></p>
            </div>
          </section>
          <section className="run-overview">
            <div><span>总阶段耗时</span><strong>{durationText(totalDuration)}</strong><small>{selected.status === 'succeeded' ? '已完成' : '已结束'} · {durationDelta === undefined ? '暂无可对比记录' : durationDelta === 0 ? '与上一次持平' : `对比上一次 ${durationDelta > 0 ? '+' : ''}${durationDelta}%`}</small></div>
            <div><span>模型生成</span><strong>{durationText(durations.provider)}</strong><small>{totalDuration ? `${Math.round(durations.provider / totalDuration * 100)}%` : '0%'}</small></div>
            <div><span>接收结果</span><strong>{durationText(durations.download)}</strong><small>已记录</small></div>
            <div><span>缓存</span><strong>{cacheHits}</strong><small>命中次数</small></div>
            <div><span>请求状态</span><strong>{dispatchStateText}</strong><small>{dispatchState === 'billing_unknown' ? '请核对费用' : '状态已记录'}</small></div>
          </section>
          <section className="diagnostic-panel">
            <div className="diagnostic-panel-heading">
              <div><h3>节点性能时间线</h3><p>横向宽度按耗时比例显示。</p></div>
              <ExposureRail active={exposureActive} error={selected.status === 'failed' ? exposureActive : -1} />
            </div>
            <div className="performance-timeline">
              {(Object.keys(phaseLabels) as (keyof typeof phaseLabels)[]).map((phase) => (
                <div key={phase}>
                  <span>{phaseLabels[phase]}</span>
                  <div><i className={selected.status === 'failed' && selected.events.some((event) => event.phase === phase && event.errorCode) ? 'status-error' : 'status-success'} style={{ width: totalDuration ? `${Math.max(2, durations[phase] / totalDuration * 100)}%` : '2%' }} /></div>
                  <strong>{durationText(durations[phase])} · {totalDuration ? Math.round(durations[phase] / totalDuration * 100) : 0}%</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="diagnostic-panel event-stream">
            <div className="diagnostic-panel-heading">
              <div><h3>事件记录</h3><p>账号凭据、图片内容和完整本机路径不会进入记录。</p></div>
            </div>
            <div className="event-table">
              {selected.events.map((event) => (
                <div key={event.id}>
                  <time>{new Date(event.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                  <span className={event.errorCode ? 'level-error' : 'level-info'}>{event.errorCode ? '失败' : '记录'}</span>
                  <code>{phaseLabels[event.phase]}</code>
                  <p>{event.errorCode ? `${event.nodeId} · 运行失败` : `${event.nodeId} · ${durationText(event.durationMs ?? 0)}`}</p>
                </div>
              ))}
            </div>
          </section>
        </main>
        <aside className="run-inspector">
          <header><h2>运行摘要</h2></header>
          <section>
            <h3>与上一次对比</h3>
            {baseline && baselineDurations ? (
              <dl className="metadata-list run-compare" aria-label="与上一次运行的结果对比">
                <div><dt>上一次</dt><dd title={baseline.runId}>{shortIdentifier(baseline.runId)} · {statusLabel(baseline.status)}</dd></div>
                <div><dt>结果变化</dt><dd>{baseline.status === selected.status ? '结果一致' : `${statusLabel(baseline.status)} → ${statusLabel(selected.status)}`}</dd></div>
                <div><dt>总耗时</dt><dd>{durationText(baselineTotal)} → {durationText(totalDuration)}{durationDelta !== undefined && durationDelta !== 0 ? `（${durationDelta > 0 ? '+' : ''}${durationDelta}%）` : ''}</dd></div>
                <div><dt>模型生成</dt><dd>{durationText(baselineDurations.provider)} → {durationText(durations.provider)}</dd></div>
                <div><dt>缓存命中</dt><dd>{baseline.events.filter((event) => event.cacheHit).length} → {cacheHits}</dd></div>
                <div><dt>工作流输入</dt><dd>{baseline.workflowHash && selected.workflowHash ? baseline.workflowHash === selected.workflowHash ? '两次输入一致' : '工作流已修改' : '旧记录缺少快照'}</dd></div>
              </dl>
            ) : <p className="run-compare-empty">这是该工作流的第一次运行，暂无可对比记录。</p>}
          </section>
          <section>
            <h3>请求信息</h3>
            <dl className="metadata-list">
              <div><dt>请求状态</dt><dd>{dispatchStateText}</dd></div>
              <div><dt>费用待确认</dt><dd>{selected.error?.billingUnknown ? '是' : '否'}</dd></div>
            </dl>
          </section>
          <section>
            <h3>本次输入</h3>
            <dl className="metadata-list">
              <div><dt>工作流快照</dt><dd>{selected.workflowHash ? selected.workflowHash.slice(0, 12) : '旧记录未保存'}</dd></div>
              <div><dt>目标节点</dt><dd>{selected.targetNodeIds?.length ?? 0}</dd></div>
              <div><dt>任务数量</dt><dd>{selected.plan ? `${selected.plan.taskCount} 个，其中远程 ${selected.plan.remoteTaskCount} 个` : '旧记录未保存'}</dd></div>
              <div><dt>模型服务 / 模型</dt><dd>{selected.providerBindings?.map((item) => `${item.providerId || '未绑定'} / ${item.model || '默认'}`).join('；') || '无远程节点'}</dd></div>
              {selected.matrix ? <div><dt>批次</dt><dd>{selected.matrix.index}/{selected.matrix.taskCount}</dd></div> : null}
              {selected.remoteJobs?.length ? <div><dt>ComfyUI 任务</dt><dd>{selected.remoteJobs.map((job) => `…${job.promptIdSuffix}`).join('；')}</dd></div> : null}
            </dl>
          </section>
          <section>
            <details className="run-trivia">
              <summary>环境</summary>
              <dl className="metadata-list">
                {Object.entries(selected.environment).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
              </dl>
            </details>
          </section>
          <footer><p><Icon name="shield" size={14} />导出包不包含账号凭据、图片内容或完整本机路径。</p></footer>
        </aside>
      </div>
    </section>
  )
}
