import type { ProviderItem } from './types.js'

const legacyComfyParameterNames = new Set([
  'comfyPrompt',
  'comfyBindings',
  'comfyPromptNodeId',
  'comfyPromptInput',
])
export const isAiTerminalAccountProvider = (
  provider: Pick<ProviderItem, 'kind' | 'managedBy'>,
): boolean => provider.kind === 'openai-compatible' && provider.managedBy === 'ai-terminal-account'

export const accountProviders = (providers: readonly ProviderItem[]): readonly ProviderItem[] =>
  providers.filter(isAiTerminalAccountProvider)

export const accountGroupLabel = (provider: Pick<ProviderItem, 'groupId' | 'name'>): string => {
  const groupId = provider.groupId?.trim()
  if (groupId) return groupId
  const prefix = '登录账号 · '
  return provider.name.startsWith(prefix) ? provider.name.slice(prefix.length) : provider.name
}

export const providerModelOptions = (provider: Pick<ProviderItem, 'model' | 'models'>): readonly string[] =>
  [...new Set([provider.model, ...(provider.models ?? [])]
    .map((model) => model.trim())
    .filter(Boolean))]

export const isLegacyComfyParameter = (nodeType: string, name: string): boolean =>
  legacyComfyParameterNames.has(name) || (nodeType === 'image_generation' && name === 'maskPath')
