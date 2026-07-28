import { app } from 'electron'

import { API_SCHEMA_VERSION } from '../../shared/contracts'
import type { BootstrapPayload } from '../../shared/contracts'

const MAIN_AGENT_RUNTIME: BootstrapPayload['runtime'] = {
  status: 'ready',
  protocolVersion: 1,
  message: 'Chat、Agent 与本地文件和命令工具已就绪；访问范围按当前操作权限执行。'
}

export function getBootstrapPayload(): BootstrapPayload {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    app: {
      name: 'AI终点站',
      version: app.getVersion(),
      platform: normalizedPlatform(),
      preview: false
    },
    runtime: { ...MAIN_AGENT_RUNTIME },
    security: {
      rendererHasNodeAccess: false,
      rendererNetworkAccess: false,
      secretsExposedToRenderer: false,
      endpointConsentRequired: true,
      localToolConsentRequired: true
    },
    defaults: {
      mode: 'agent',
      approvalMode: 'request',
      reasoning: 'high',
      webSearch: true,
      imageGeneration: false,
      activeProfileHandle: '',
      activeModelId: ''
    },
    profiles: [],
    models: [],
    projects: [],
    activeTaskId: ''
  }
}

function normalizedPlatform(): BootstrapPayload['app']['platform'] {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform
  return 'win32'
}
