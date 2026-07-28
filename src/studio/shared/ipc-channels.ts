export type StudioOperationKind = 'invoke-input' | 'invoke-no-input' | 'event'

interface StudioOperationDefinition {
  readonly channelKey: string
  readonly channel: `studio:${string}`
  readonly kind: StudioOperationKind
}

// This is the only handwritten list of Studio operations. Public bridge methods,
// Electron channels, and invocation shape all meet at this catalog.
export const studioOperationCatalog = {
  bootstrap: { channelKey: 'bootstrap', channel: 'studio:bootstrap', kind: 'invoke-no-input' },
  createProject: { channelKey: 'projectCreate', channel: 'studio:project:create', kind: 'invoke-input' },
  openProject: { channelKey: 'projectOpen', channel: 'studio:project:open', kind: 'invoke-input' },
  listWorkflows: { channelKey: 'projectListWorkflows', channel: 'studio:project:list-workflows', kind: 'invoke-input' },
  loadWorkflow: { channelKey: 'workflowLoad', channel: 'studio:workflow:load', kind: 'invoke-input' },
  saveWorkflow: { channelKey: 'workflowSave', channel: 'studio:workflow:save', kind: 'invoke-input' },
  loadWorkflowDraft: { channelKey: 'workflowDraftLoad', channel: 'studio:workflow:draft:load', kind: 'invoke-input' },
  saveWorkflowDraft: { channelKey: 'workflowDraftSave', channel: 'studio:workflow:draft:save', kind: 'invoke-input' },
  discardWorkflowDraft: { channelKey: 'workflowDraftDiscard', channel: 'studio:workflow:draft:discard', kind: 'invoke-input' },
  listWorkflowVersions: { channelKey: 'workflowVersionList', channel: 'studio:workflow:version:list', kind: 'invoke-input' },
  loadWorkflowVersion: { channelKey: 'workflowVersionLoad', channel: 'studio:workflow:version:load', kind: 'invoke-input' },
  duplicateWorkflow: { channelKey: 'workflowDuplicate', channel: 'studio:workflow:duplicate', kind: 'invoke-input' },
  archiveWorkflow: { channelKey: 'workflowArchive', channel: 'studio:workflow:archive', kind: 'invoke-input' },
  listArchivedWorkflows: { channelKey: 'workflowArchiveList', channel: 'studio:workflow:archive:list', kind: 'invoke-input' },
  restoreArchivedWorkflow: { channelKey: 'workflowArchiveRestore', channel: 'studio:workflow:archive:restore', kind: 'invoke-input' },
  exportWorkflowPackage: { channelKey: 'workflowPackageExport', channel: 'studio:workflow:package:export', kind: 'invoke-input' },
  importWorkflowPackage: { channelKey: 'workflowPackageImport', channel: 'studio:workflow:package:import', kind: 'invoke-input' },
  planWorkflow: { channelKey: 'workflowCopilotPlan', channel: 'studio:workflow:copilot:plan', kind: 'invoke-input' },
  listProviders: { channelKey: 'providerList', channel: 'studio:provider:list', kind: 'invoke-no-input' },
  upsertProvider: { channelKey: 'providerUpsert', channel: 'studio:provider:upsert', kind: 'invoke-input' },
  deleteProvider: { channelKey: 'providerDelete', channel: 'studio:provider:delete', kind: 'invoke-input' },
  probeProvider: { channelKey: 'providerProbe', channel: 'studio:provider:probe', kind: 'invoke-input' },
  listProviderImports: { channelKey: 'providerImportList', channel: 'studio:provider:import:list', kind: 'invoke-no-input' },
  acceptProviderImport: { channelKey: 'providerImportAccept', channel: 'studio:provider:import:accept', kind: 'invoke-input' },
  dismissProviderImport: { channelKey: 'providerImportDismiss', channel: 'studio:provider:import:dismiss', kind: 'invoke-input' },
  prepareRun: { channelKey: 'runPrepare', channel: 'studio:run:prepare', kind: 'invoke-input' },
  startRun: { channelKey: 'runStart', channel: 'studio:run:start', kind: 'invoke-input' },
  cancelRun: { channelKey: 'runCancel', channel: 'studio:run:cancel', kind: 'invoke-input' },
  onRunEvent: { channelKey: 'runEvent', channel: 'studio:run:event', kind: 'event' },
  listAssets: { channelKey: 'assetList', channel: 'studio:asset:list', kind: 'invoke-input' },
  assetUrl: { channelKey: 'assetUrl', channel: 'studio:asset:url', kind: 'invoke-input' },
  updateAsset: { channelKey: 'assetUpdate', channel: 'studio:asset:update', kind: 'invoke-input' },
  exportAssets: { channelKey: 'assetExport', channel: 'studio:asset:export', kind: 'invoke-input' },
  saveAssetMask: { channelKey: 'assetMaskSave', channel: 'studio:asset:mask:save', kind: 'invoke-input' },
  importProjectImage: { channelKey: 'projectImageImport', channel: 'studio:asset:project-image:import', kind: 'invoke-input' },
  listCollections: { channelKey: 'collectionList', channel: 'studio:collection:list', kind: 'invoke-input' },
  upsertBoard: { channelKey: 'boardUpsert', channel: 'studio:collection:board:upsert', kind: 'invoke-input' },
  deleteBoard: { channelKey: 'boardDelete', channel: 'studio:collection:board:delete', kind: 'invoke-input' },
  upsertSmartCollection: { channelKey: 'smartCollectionUpsert', channel: 'studio:collection:smart:upsert', kind: 'invoke-input' },
  deleteSmartCollection: { channelKey: 'smartCollectionDelete', channel: 'studio:collection:smart:delete', kind: 'invoke-input' },
  listPlugins: { channelKey: 'pluginList', channel: 'studio:plugin:list', kind: 'invoke-input' },
  upsertPlugin: { channelKey: 'pluginUpsert', channel: 'studio:plugin:upsert', kind: 'invoke-input' },
  deletePlugin: { channelKey: 'pluginDelete', channel: 'studio:plugin:delete', kind: 'invoke-input' },
  listPresets: { channelKey: 'presetList', channel: 'studio:preset:list', kind: 'invoke-input' },
  upsertPreset: { channelKey: 'presetUpsert', channel: 'studio:preset:upsert', kind: 'invoke-input' },
  deletePreset: { channelKey: 'presetDelete', channel: 'studio:preset:delete', kind: 'invoke-input' },
  importPresets: { channelKey: 'presetImport', channel: 'studio:preset:import', kind: 'invoke-input' },
  exportPresets: { channelKey: 'presetExport', channel: 'studio:preset:export', kind: 'invoke-input' },
  listTasks: { channelKey: 'taskList', channel: 'studio:task:list', kind: 'invoke-input' },
  listRuns: { channelKey: 'runList', channel: 'studio:run:list', kind: 'invoke-input' },
  listPersistentRuns: { channelKey: 'persistentRunList', channel: 'studio:run:persistent:list', kind: 'invoke-input' },
  resumePersistentRun: { channelKey: 'persistentRunResume', channel: 'studio:run:persistent:resume', kind: 'invoke-input' },
  removePersistentRun: { channelKey: 'persistentRunRemove', channel: 'studio:run:persistent:remove', kind: 'invoke-input' },
  exportDiagnostics: { channelKey: 'diagnosticExport', channel: 'studio:diagnostic:export', kind: 'invoke-input' },
  copyText: { channelKey: 'clipboardWrite', channel: 'studio:clipboard:write', kind: 'invoke-input' },
} as const satisfies Record<string, StudioOperationDefinition>

type StudioOperationCatalog = typeof studioOperationCatalog
export type StudioOperationName = keyof StudioOperationCatalog
export type StudioOperationNameByKind<TKind extends StudioOperationKind> = {
  [TName in StudioOperationName]: StudioOperationCatalog[TName]['kind'] extends TKind ? TName : never
}[StudioOperationName]
export type StudioInputInvokeOperationName = StudioOperationNameByKind<'invoke-input'>
export type StudioNoInputInvokeOperationName = StudioOperationNameByKind<'invoke-no-input'>
export type StudioInvokeOperationName = StudioInputInvokeOperationName | StudioNoInputInvokeOperationName
export type StudioEventOperationName = StudioOperationNameByKind<'event'>

export const studioOperationNames = Object.freeze(
  Object.keys(studioOperationCatalog) as StudioOperationName[],
)

export const studioInvokeOperationNames = Object.freeze(
  studioOperationNames.filter((operation): operation is StudioInvokeOperationName =>
    studioOperationCatalog[operation].kind !== 'event'),
)

export const studioEventOperationNames = Object.freeze(
  studioOperationNames.filter((operation): operation is StudioEventOperationName =>
    studioOperationCatalog[operation].kind === 'event'),
)

const definitions = Object.values(studioOperationCatalog)
const uniqueChannels = new Set(definitions.map((definition) => definition.channel))
const uniqueChannelKeys = new Set(definitions.map((definition) => definition.channelKey))
if (uniqueChannels.size !== definitions.length || uniqueChannelKeys.size !== definitions.length) {
  throw new Error('Studio operation catalog contains a duplicate channel or channel key')
}

type StudioChannelDefinition = StudioOperationCatalog[StudioOperationName]
type StudioChannelKey = StudioChannelDefinition['channelKey']
export type StudioChannels = {
  readonly [TKey in StudioChannelKey]: Extract<StudioChannelDefinition, { readonly channelKey: TKey }>['channel']
}

// Compatibility projection for existing event senders and external imports.
// Channel strings are authored only in studioOperationCatalog above.
export const channels = Object.freeze(Object.fromEntries(
  definitions.map((definition) => [definition.channelKey, definition.channel]),
)) as StudioChannels

export interface StudioInvokeRegistrationTracker {
  registerInput(operation: StudioInputInvokeOperationName): string
  registerNoInput(operation: StudioNoInputInvokeOperationName): string
  assertComplete(): void
  registeredChannels(): readonly string[]
}

export const createStudioInvokeRegistrationTracker = (): StudioInvokeRegistrationTracker => {
  const registered = new Set<StudioInvokeOperationName>()

  const register = (
    operation: StudioInvokeOperationName,
    expectedKind: 'invoke-input' | 'invoke-no-input',
  ): string => {
    const definition = studioOperationCatalog[operation]
    if (definition.kind !== expectedKind) {
      throw new Error(`Studio operation ${operation} must register as ${definition.kind}`)
    }
    if (registered.has(operation)) {
      throw new Error(`Studio operation ${operation} was registered more than once`)
    }
    registered.add(operation)
    return definition.channel
  }

  return {
    registerInput: (operation) => register(operation, 'invoke-input'),
    registerNoInput: (operation) => register(operation, 'invoke-no-input'),
    assertComplete: () => {
      const missing = studioInvokeOperationNames.filter((operation) => !registered.has(operation))
      if (missing.length > 0) {
        throw new Error(`Studio IPC registration is incomplete: ${missing.join(', ')}`)
      }
    },
    registeredChannels: () => Object.freeze(
      [...registered].map((operation) => studioOperationCatalog[operation].channel),
    ),
  }
}
