import { DEFAULT_IMAGE_MODEL } from './imageModels.js'

const maxImportUrlBytes = 32 * 1024
const maxSecretLength = 16_384

export interface ParsedProviderImport {
  readonly name: string
  readonly baseUrl: string
  readonly defaultModel: string
  readonly apiKey: string
}

const oneParameter = (parameters: URLSearchParams, aliases: readonly string[], label: string): string => {
  const values = aliases
    .flatMap((alias) => parameters.getAll(alias))
    .map((value) => value.trim())
    .filter(Boolean)
  const unique = [...new Set(values)]
  if (unique.length > 1) throw new Error(`${label} 包含互相冲突的重复参数`)
  return unique[0] ?? ''
}

export const normalizeOpenAiProviderBaseUrl = (input: string): string => {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('接口地址不是有效 URL')
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('远程接口必须使用 HTTPS；仅本机回环地址允许 HTTP')
  }
  if (parsed.username || parsed.password) throw new Error('接口地址不能包含用户名或密码')
  if (parsed.search) throw new Error('接口地址不能包含查询参数或 API Key')
  if (parsed.hash) throw new Error('接口地址不能包含片段标识')
  parsed.pathname = parsed.pathname.replace(/\/(?:images\/(?:generations|edits|variations)|chat\/completions|responses|models)\/?$/i, '') || '/'
  return parsed.toString().replace(/\/$/, '')
}

export const parseProviderImportUrl = (raw: string): ParsedProviderImport => {
  const value = raw.trim()
  if (!value || new TextEncoder().encode(value).byteLength > maxImportUrlBytes) throw new Error('接口导入链接为空或过长')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('接口导入链接格式无效')
  }
  if (url.protocol.toLowerCase() !== 'aiterminal:' || url.hostname.toLowerCase() !== 'v1'
    || url.pathname.replace(/\/+$/, '').toLowerCase() !== '/import') {
    throw new Error('只支持 aiterminal://v1/import 接口导入链接')
  }
  if (url.hash) throw new Error('接口导入链接不能包含片段标识')
  const resource = oneParameter(url.searchParams, ['resource'], '资源类型').toLowerCase()
  if (resource !== 'provider') throw new Error('此链接不是 Provider 导入请求')
  const target = oneParameter(url.searchParams, ['app', 'target', 'agentId'], '目标客户端').toLowerCase()
  const openAiTargets = new Set(['', 'all', 'codex', 'codex-cli', 'codex-desktop', 'openai'])
  if (!openAiTargets.has(target)) throw new Error('此链接只包含 Claude 渠道，不能作为图像 API Provider 导入')

  const name = oneParameter(url.searchParams, ['name'], '接口名称')
  if (!name) throw new Error('接口导入链接缺少名称')
  if (name.length > 160) throw new Error('接口名称过长')
  const endpoint = oneParameter(url.searchParams, ['endpoint', 'baseUrl', 'baseURL'], '接口地址')
  if (!endpoint) throw new Error('接口导入链接缺少 endpoint/baseUrl')
  const apiKey = oneParameter(url.searchParams, ['apiKey', 'key', 'token'], 'API Key')
  if (!apiKey) throw new Error('接口导入链接缺少 API Key')
  if (apiKey.length > maxSecretLength) throw new Error('API Key 超过安全长度限制')
  const defaultModel = oneParameter(url.searchParams, ['imageModel', 'model', 'codexModel'], '模型') || DEFAULT_IMAGE_MODEL
  if (defaultModel.length > 256) throw new Error('模型 ID 过长')
  return {
    name,
    baseUrl: normalizeOpenAiProviderBaseUrl(endpoint),
    defaultModel,
    apiKey,
  }
}

export const providerImportUrlsFromArgv = (argv: readonly string[]): readonly string[] => {
  const result: string[] = []
  for (const argument of argv) {
    const value = argument.trim()
    if (!/^aiterminal:\/\//i.test(value) || result.includes(value)) continue
    result.push(value)
  }
  return result
}
