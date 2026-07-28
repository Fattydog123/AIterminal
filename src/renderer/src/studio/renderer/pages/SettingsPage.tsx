import { useRef, useState } from 'react'
import { Icon } from '../components/Icon.js'
import { Toggle } from '../components/Primitives.js'
import { StudioSelect } from '../components/StudioSelect.js'
import { useStudioStore } from '../store/studioStore.js'

type SettingsSection = 'security' | 'canvas' | 'files' | 'about'

export function SettingsPage() {
  const safeMode = useStudioStore((state) => state.safeMode)
  const gridSnap = useStudioStore((state) => state.gridSnap)
  const showMinimap = useStudioStore((state) => state.showMinimap)
  const toggleSafeMode = useStudioStore((state) => state.toggleSafeMode)
  const toggleGridSnap = useStudioStore((state) => state.toggleGridSnap)
  const toggleMinimap = useStudioStore((state) => state.toggleMinimap)
  const showToast = useStudioStore((state) => state.showToast)
  const filename = useStudioStore((state) => state.filenameTemplate)
  const setFilename = useStudioStore((state) => state.setFilenameTemplate)
  const appVersion = useStudioStore((state) => state.appVersion)
  const connectionState = useStudioStore((state) => state.connectionState)
  const projectPath = useStudioStore((state) => state.projectPath)
  const selectedModel = useStudioStore((state) => state.providers.find((provider) => provider.managedBy === 'ai-terminal-account')?.model ?? '')
  const [section, setSection] = useState<SettingsSection>('security')
  const settingsContentRef = useRef<HTMLElement>(null)
  const go = (next: SettingsSection): void => {
    setSection(next)
    settingsContentRef.current?.querySelector(`#settings-${next}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const previewFilename = `${filename.replace(/\{(date|workflow|model|seed|index|operation)\}/g, (_match, key: string) => ({ date: '2026-07-15', workflow: '图像工作流', model: selectedModel || '当前模型', seed: '—', index: '01', operation: 'generate' })[key] ?? '')}.png`
  const validateFilename = (): void => {
    if (!filename.trim()) return showToast('文件名模板不能为空')
    const unknown = [...filename.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).find((token) => !['date', 'workflow', 'model', 'seed', 'index', 'operation'].includes(token ?? ''))
    showToast(unknown ? `未知模板变量：{${unknown}}` : '模板有效；导出时还会移除跨平台保留字符并自动避让重名文件')
  }
  return (
    <section className="standard-page settings-page">
      <header className="page-header"><div><span className="eyebrow">使用偏好</span><h1>设置</h1><p>调整运行方式、画布和文件输出。</p></div></header>
      <div className="settings-layout">
        <nav aria-label="设置分类" className="settings-nav"><button className={section === 'security' ? 'is-active' : ''} onClick={() => go('security')} type="button"><Icon name="shield" size={15} />运行保护</button><button className={section === 'canvas' ? 'is-active' : ''} onClick={() => go('canvas')} type="button"><Icon name="workflow" size={15} />画布</button><button className={section === 'files' ? 'is-active' : ''} onClick={() => go('files')} type="button"><Icon name="folder" size={15} />文件与导出</button><button className={section === 'about' ? 'is-active' : ''} onClick={() => go('about')} type="button"><Icon name="info" size={15} />关于</button></nav>
        <main className="settings-content" ref={settingsContentRef}>
          <section className="settings-card" id="settings-security"><header><div><h2>运行保护</h2><p>管理插件运行方式和远程请求确认。</p></div><span className="settings-card-icon"><Icon name="shield" size={19} /></span></header><Toggle checked={safeMode} detail="暂停第三方插件运行；缺失节点仍会保留参数，便于稍后恢复。" label="插件保护" onChange={toggleSafeMode} /><div className="settings-callout"><Icon name="shield" size={17} /><p><strong>远程运行与诊断记录</strong><span>远程运行会在发送前确认；失败请求不会自动重复发送；诊断记录不包含令牌、图片或完整本地路径。</span></p></div></section>
          <section className="settings-card" id="settings-canvas"><header><div><h2>画布</h2><p>调整工作流编辑器的显示方式。</p></div><span className="settings-card-icon"><Icon name="workflow" size={19} /></span></header><Toggle checked={gridSnap} detail="移动节点时自动对齐到画布网格。" label="网格吸附" onChange={toggleGridSnap} /><Toggle checked={showMinimap} detail="在画布右下角显示工作流总览。" label="显示小地图" onChange={toggleMinimap} /></section>
          <section className="settings-card" id="settings-files"><header><div><h2>文件与导出</h2><p>输出目录和跨平台安全文件名。</p></div><span className="settings-card-icon"><Icon name="folder" size={19} /></span></header><label className="field"><span>安全文件名模板</span><input onChange={(event) => setFilename(event.target.value)} value={filename} /><small>可用：{'{date} {workflow} {model} {seed} {index} {operation}'}</small></label><div className="filename-preview"><span>预览</span><code>{previewFilename}</code><Icon name="check" size={14} /></div><div className="settings-field-row"><span><strong>冲突处理</strong><small>目标文件已存在时</small></span><StudioSelect ariaLabel="文件名冲突处理" disabled onChange={() => undefined} options={[{ value: 'increment', label: '追加安全序号（不覆盖）' }]} placeholder="追加安全序号（不覆盖）" value="increment" /></div><button className="secondary-button align-start" onClick={validateFilename} type="button"><Icon name="check" size={14} />验证模板</button></section>
          <section className="settings-card" id="settings-about"><header><div><h2>关于</h2><p>版本与工作台状态。</p></div><span className="settings-card-icon"><Icon name="info" size={19} /></span></header><dl className="metadata-list"><div><dt>应用版本</dt><dd>{appVersion}</dd></div><div><dt>工作台</dt><dd>{connectionState === 'ready' ? (projectPath ? '项目已打开' : '已就绪') : connectionState === 'loading' ? '正在载入' : connectionState === 'error' ? '连接异常' : '正在连接'}</dd></div><div><dt>图片模型</dt><dd>{selectedModel || '尚未选择'}</dd></div><div><dt>凭据保护</dt><dd>已启用</dd></div><div><dt>自动安装插件</dt><dd>关闭</dd></div></dl></section>
        </main>
      </div>
    </section>
  )
}
