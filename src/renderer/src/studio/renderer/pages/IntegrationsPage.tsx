import { useEffect, useState } from 'react'
import { evaluatePlugin, pluginManifestSchema, pluginPermissions, type PluginManifest } from '@studio/core/plugins.js'
import type { ProjectPluginRecord } from '@studio/shared/types.js'
import { Icon } from '../components/Icon.js'
import { StatusPill, Toggle } from '../components/Primitives.js'
import { useStudioStore } from '../store/studioStore.js'
import type { ProviderItem } from '../types.js'

export function IntegrationsPage() {
  const providers = useStudioStore((state) => state.providers)
  const safeMode = useStudioStore((state) => state.safeMode)
  const connectionState = useStudioStore((state) => state.connectionState)
  const refreshProviders = useStudioStore((state) => state.refreshProviders)
  const toggleSafeMode = useStudioStore((state) => state.toggleSafeMode)
  const plugins = useStudioStore((state) => state.plugins)
  const accountProviders = providers.filter((provider) => provider.managedBy === 'ai-terminal-account')
  const [toolView, setToolView] = useState<'providers' | 'plugins'>('providers')
  const [selectedId, setSelectedId] = useState(accountProviders[0]?.id ?? '')
  const selected = selectedId ? accountProviders.find((item) => item.id === selectedId) : undefined

  useEffect(() => {
    if (!accountProviders.some((item) => item.id === selectedId)) {
      setSelectedId(accountProviders[0]?.id ?? '')
    }
  }, [providers, selectedId])

  return (
    <section className="standard-page integrations-page">
      <header className="page-header">
        <div><span className="eyebrow">GROUPS</span><h1>分组与插件</h1></div>
        <div className="page-header-actions">
          <StatusPill
            label={connectionState === 'ready' ? '已连接' : connectionState === 'loading' ? '读取中' : connectionState === 'error' ? '连接异常' : '未连接'}
            status={connectionState === 'ready' ? 'connected' : connectionState === 'error' ? 'error' : 'pending'}
          />
          <button className="secondary-button" onClick={() => void refreshProviders()} type="button"><Icon name="pulse" size={14} />刷新</button>
        </div>
      </header>
      <div className="integrations-layout">
        <aside className="provider-list"><header><h2>图片分组</h2><small>{accountProviders.length}</small></header>{accountProviders.map((provider) => <button className={toolView === 'providers' && selected?.id === provider.id ? 'is-active' : ''} key={provider.id} onClick={() => { setToolView('providers'); setSelectedId(provider.id) }} type="button"><span className="provider-logo kind-openai-compatible"><Icon name="spark" size={17} /></span><div><strong>{provider.name}</strong><small>{provider.description ?? '可用'}</small></div><span className={`provider-dot status-${provider.status}`} /></button>)}{accountProviders.length === 0 ? <div className="plugin-empty"><Icon name="server" size={21} /><p>暂无可用图片分组。</p></div> : null}<section className="provider-list-group"><p>高级功能</p><button className={toolView === 'plugins' ? 'is-active' : ''} onClick={() => setToolView('plugins')} type="button"><Icon name="code" size={15} /><span>插件配置</span><small>{plugins.length}</small></button><button className={toolView === 'plugins' ? 'is-active' : ''} onClick={() => setToolView('plugins')} type="button"><Icon name="shield" size={15} /><span>访问权限</span><small>{safeMode ? '受限' : '自定义'}</small></button></section></aside>
        <main className="integration-detail">
          {toolView === 'plugins' ? <PluginManager /> : selected ? <><header className="integration-detail-header"><div className="provider-hero-icon kind-openai-compatible"><Icon name="spark" size={24} /></div><div><span className="eyebrow">图片分组</span><h2>{selected.name}</h2><p>{selected.description ?? '可用于图片生成'}</p></div><StatusPill label="可用" status="connected" /></header><AccountProviderPanel provider={selected} /></> : <div className="plugin-empty"><Icon name="server" size={24} /><strong>暂无可用图片分组</strong><p>创建可用令牌后刷新。</p></div>}
        </main>
        <aside className="plugin-security-panel"><header><div><span className="eyebrow">插件权限</span><h2>插件与访问控制</h2></div><Icon name="shield" size={21} /></header><Toggle checked={safeMode} detail="暂停第三方插件，并保留工作流中的对应节点。" label="限制第三方插件" onChange={toggleSafeMode} /><section><h3>插件配置</h3>{plugins.length === 0 ? <div className="plugin-empty"><Icon name="code" size={22} /><strong>尚未添加第三方插件</strong><p>可在中间面板导入高级插件配置。</p></div> : <div className="plugin-summary"><strong>{plugins.length}</strong><span>个插件记录</span><small>{plugins.filter((item) => item.enabled).length} 个已启用</small></div>}</section><section><h3>默认访问范围</h3><dl className="metadata-list"><div><dt>项目外文件</dt><dd>不允许</dd></div><div><dt>额外网络访问</dt><dd>不允许</dd></div><div><dt>启动其他程序</dt><dd>不允许</dd></div><div><dt>自动安装依赖</dt><dd>不提供</dd></div><div><dt>插件运行</dt><dd>暂未开放</dd></div></dl></section></aside>
      </div>
    </section>
  )
}

function AccountProviderPanel({ provider }: { readonly provider: ProviderItem }) {
  const models = provider.models ?? []
  return (
    <section className="provider-contract">
      <header><h3>分组</h3><span>只读</span></header>
      <div>
        <article><Icon name="shield" size={17} /><span><strong>分组</strong><code>{provider.groupId ?? '未指定'}</code></span><StatusPill label="已同步" status="success" /></article>
        <article><Icon name="spark" size={17} /><span><strong>默认模型</strong><code>{provider.model}</code></span><StatusPill label={`${models.length} 个可用`} status="connected" /></article>
      </div>
    </section>
  )
}

function PluginManager() {
  const plugins = useStudioStore((state) => state.plugins)
  const safeMode = useStudioStore((state) => state.safeMode)
  const appVersion = useStudioStore((state) => state.appVersion)
  const savePlugin = useStudioStore((state) => state.savePlugin)
  const deletePlugin = useStudioStore((state) => state.deletePlugin)
  const showToast = useStudioStore((state) => state.showToast)
  const [selectedId, setSelectedId] = useState(plugins[0]?.manifest.id ?? '')
  const selected = plugins.find((item) => item.manifest.id === selectedId)
  const [json, setJson] = useState(selected ? JSON.stringify(selected.manifest, null, 2) : '')
  const [manifest, setManifest] = useState<PluginManifest | undefined>(() => selected ? pluginManifestSchema.parse(selected.manifest) : undefined)
  const [enabled, setEnabled] = useState(selected?.enabled ?? false)
  const [versionLock, setVersionLock] = useState(selected?.versionLock ?? '')
  const [granted, setGranted] = useState<readonly (typeof pluginPermissions)[number][]>(selected?.grantedPermissions ?? [])

  const choose = (record: ProjectPluginRecord): void => {
    setSelectedId(record.manifest.id)
    setJson(JSON.stringify(record.manifest, null, 2))
    setManifest(pluginManifestSchema.parse(record.manifest))
    setEnabled(record.enabled)
    setVersionLock(record.versionLock)
    setGranted(record.grantedPermissions)
  }
  const beginNew = (): void => {
    setSelectedId('')
    setManifest(undefined)
    setEnabled(false)
    setVersionLock('')
    setGranted([])
    setJson(JSON.stringify({
      schemaVersion: 1,
      id: 'vendor.plugin-id',
      name: '插件名称',
      version: '1.0.0',
      hostVersion: '1.0.0',
      description: '仅声明节点与权限；不会自动安装或执行。',
      permissions: ['project-read'],
      nodeTypes: ['vendor.image_node'],
      dependencies: {},
    }, null, 2))
  }
  const parseJson = (): PluginManifest | undefined => {
    try {
      const parsed = pluginManifestSchema.parse(JSON.parse(json) as unknown)
      setManifest(parsed)
      setVersionLock((value) => value || parsed.version)
      setGranted((value) => value.filter((permission) => parsed.permissions.includes(permission)))
      showToast(`插件配置 ${parsed.id}@${parsed.version} 校验通过，尚未保存`)
      return parsed
    } catch (error) {
      showToast(error instanceof Error ? `插件配置无效：${error.message}` : '插件配置格式无效')
      return undefined
    }
  }
  const save = async (): Promise<void> => {
    const parsed = parseJson()
    if (!parsed) return
    const record: ProjectPluginRecord = {
      manifest: {
        schemaVersion: 1,
        id: parsed.id,
        name: parsed.name,
        version: parsed.version,
        hostVersion: parsed.hostVersion,
        permissions: parsed.permissions,
        nodeTypes: parsed.nodeTypes,
        dependencies: parsed.dependencies,
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.entryPoint === undefined ? {} : { entryPoint: parsed.entryPoint }),
      },
      enabled,
      versionLock: versionLock.trim() || parsed.version,
      grantedPermissions: granted.filter((permission) => parsed.permissions.includes(permission)),
    }
    await savePlugin(record)
    setSelectedId(parsed.id)
  }
  const installed = Object.fromEntries(plugins.map((item) => [item.manifest.id, item.manifest.version]))
  const decision = manifest ? evaluatePlugin(manifest, {
    safeMode,
    hostVersion: /^\d+\.\d+\.\d+/.test(appVersion) ? appVersion : manifest.hostVersion,
    enabled,
    versionLock: versionLock || manifest.version,
    grantedPermissions: new Set(granted),
    installedPlugins: installed,
  }) : undefined
  return (
    <div className="plugin-manager">
      <header className="integration-detail-header"><div className="provider-hero-icon kind-plugin"><Icon name="code" size={24} /></div><div><span className="eyebrow">高级插件配置</span><h2>插件配置与访问权限</h2><p>校验、保存并管理第三方插件声明；当前版本不会运行插件代码。</p></div><button className="secondary-button" onClick={beginNew} type="button"><Icon name="plus" size={14} />新建记录</button></header>
      <div className="plugin-manager-layout"><aside><h3>项目插件</h3>{plugins.map((record) => <button className={selectedId === record.manifest.id ? 'is-active' : ''} key={record.manifest.id} onClick={() => choose(record)} type="button"><Icon name="code" size={15} /><span><strong>{record.manifest.name}</strong><small>{record.manifest.id}@{record.manifest.version}</small></span><StatusPill label={record.enabled ? '已启用' : '已停用'} status={record.enabled ? 'pending' : 'success'} /></button>)}{plugins.length === 0 ? <div className="plugin-empty"><Icon name="code" size={21} /><p>当前项目没有插件记录。</p></div> : null}</aside><main><label className="field"><span>插件配置（JSON）</span><textarea className="code-textarea" onChange={(event) => setJson(event.target.value)} placeholder="粘贴插件提供的 JSON 配置" rows={15} spellCheck={false} value={json} /></label><div className="plugin-policy-grid"><label className="field"><span>限定版本</span><input onChange={(event) => setVersionLock(event.target.value)} placeholder="1.0.0" value={versionLock} /></label><label className="plugin-enabled-check"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /><span><strong>标记为启用</strong><small>仍受版本与访问权限约束</small></span></label></div><section className="plugin-permission-editor"><h3>访问权限</h3>{pluginPermissions.map((permission) => { const declared = manifest?.permissions.includes(permission) ?? false; return <label className={!declared ? 'is-disabled' : ''} key={permission}><input checked={declared && granted.includes(permission)} disabled={!declared} onChange={(event) => setGranted(event.target.checked ? [...granted, permission] : granted.filter((item) => item !== permission))} type="checkbox" /><span>{permission}</span><small>{declared ? '插件已申请' : '插件未申请，无法开启'}</small></label> })}</section>{decision ? <div className={`plugin-decision ${decision.allowed ? 'is-allowed' : 'is-blocked'}`}><Icon name={decision.allowed ? 'check' : 'shield'} size={18} /><div><strong>{decision.allowed ? '配置检查通过，但当前版本不会运行插件代码' : '当前配置不允许插件运行'}</strong><p>{decision.reasons.length > 0 ? decision.reasons.join(' · ') : '版本、依赖和访问权限均匹配。'}</p></div></div> : null}<div className="integration-actions"><button className="secondary-button" onClick={() => { void parseJson() }} type="button"><Icon name="check" size={14} />仅校验</button><span>当前版本只保存配置，不会自动安装或运行插件。</span><button className="primary-button" onClick={() => void save()} type="button"><Icon name="save" size={14} />保存配置</button></div>{selected ? <button className="danger-ghost delete-provider" onClick={() => { if (window.confirm(`删除插件配置“${selected.manifest.name}”？`)) void deletePlugin(selected.manifest.id) }} type="button"><Icon name="trash" size={14} />删除插件配置</button> : null}</main></div>
    </div>
  )
}
