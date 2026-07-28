import { workflowDocumentSchema } from '../shared/contracts.js'
import type {
  SubgraphDefinition,
  SubgraphPort,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../shared/types.js'

const LEGACY_WORKFLOW_VERSION = 2
const CURRENT_SCHEMA_VERSION = 3
const EPOCH = '1970-01-01T00:00:00.000Z'

export interface WorkflowMigrationReport {
  readonly sourceVersion: number
  readonly targetVersion: 3
  readonly migrationRequired: boolean
  readonly compatible: boolean
  readonly unknownFields: readonly string[]
  readonly error?: string
}

export interface WorkflowMigrationResult {
  readonly document: WorkflowDocument
  readonly report: WorkflowMigrationReport
}

type UnknownObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is UnknownObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const own = (value: UnknownObject, key: string): unknown => value[key]

const deepClone = <T>(value: T): T => structuredClone(value)

const LEGACY_IMAGE_NODE_TYPES = new Set([
  'image_generation',
  'image_edit',
  'image_inpaint',
  'image_outpaint',
])

const LEGACY_PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  provider_id: 'providerId',
  number_of_images: 'count',
  response_format: 'responseFormat',
  output_format: 'outputFormat',
  output_compression: 'outputCompression',
  input_fidelity: 'inputFidelity',
  mask_path: 'maskPath',
  comfy_prompt: 'comfyPrompt',
  comfy_prompt_node_id: 'comfyPromptNodeId',
  comfy_prompt_input: 'comfyPromptInput',
  candidate_group_id: 'candidateGroupId',
}

const migrateLegacyNodeType = (type: string): string =>
  type === 'project_image_input' ? 'project_image' : type

const migrateLegacyParameterName = (nodeType: string | undefined, name: string): string =>
  nodeType && LEGACY_IMAGE_NODE_TYPES.has(nodeType) ? (LEGACY_PARAMETER_ALIASES[name] ?? name) : name

const migrateLegacyParameters = (value: UnknownObject, nodeType: string): Record<string, unknown> => {
  const parameters = { ...deepClone(value) }
  if (!LEGACY_IMAGE_NODE_TYPES.has(nodeType)) return parameters
  for (const [legacyName, currentName] of Object.entries(LEGACY_PARAMETER_ALIASES)) {
    if (Object.hasOwn(parameters, legacyName)) {
      if (!Object.hasOwn(parameters, currentName)) parameters[currentName] = parameters[legacyName]
      delete parameters[legacyName]
    }
  }
  return parameters
}

const migrateLegacySocketName = (nodeType: string | undefined, name: string): string =>
  nodeType === 'image_generation' && name === 'reference_images' ? 'referenceImages' : name

const unknownFieldNames = (
  value: UnknownObject,
  known: ReadonlySet<string>,
  prefix = '',
): readonly string[] => Object.keys(value)
  .filter((key) => !known.has(key))
  .map((key) => `${prefix}${key}`)

const legacyNode = (value: unknown): WorkflowNode => {
  if (!isObject(value)) throw new Error('旧版工作流节点必须是对象')
  const type = migrateLegacyNodeType(String(own(value, 'type') ?? ''))
  const subgraphValue = own(value, 'subgraph')
  let subgraph: WorkflowNode['subgraph']
  if (subgraphValue !== undefined && subgraphValue !== null) {
    if (!isObject(subgraphValue)) throw new Error('旧版子图实例必须是对象')
    const definitionId = String(own(subgraphValue, 'definitionId') ?? own(subgraphValue, 'definition_id') ?? '')
    const definitionVersion = Number(own(subgraphValue, 'definitionVersion') ?? own(subgraphValue, 'definition_version') ?? 1)
    subgraph = {
      ...deepClone(subgraphValue),
      definitionId,
      definitionVersion,
    }
  }
  return {
    ...deepClone(value),
    id: String(own(value, 'id') ?? ''),
    type,
    name: String(own(value, 'name') ?? own(value, 'type') ?? ''),
    position: isObject(own(value, 'position'))
      ? {
          ...deepClone(own(value, 'position') as UnknownObject),
          x: Number((own(value, 'position') as UnknownObject).x ?? 0),
          y: Number((own(value, 'position') as UnknownObject).y ?? 0),
        }
      : { x: 0, y: 0 },
    parameters: isObject(own(value, 'parameters'))
      ? migrateLegacyParameters(own(value, 'parameters') as UnknownObject, type)
      : {},
    ...(isObject(own(value, 'presentation'))
      ? { presentation: deepClone(own(value, 'presentation') as UnknownObject) }
      : {}),
    ...(subgraph ? { subgraph } : {}),
  }
}

const legacyEdge = (value: unknown, nodeTypes: ReadonlyMap<string, string>): WorkflowEdge => {
  if (!isObject(value)) throw new Error('旧版工作流连线必须是对象')
  const sourceNode = String(own(value, 'sourceNode') ?? own(value, 'source_node') ?? '')
  const targetNode = String(own(value, 'targetNode') ?? own(value, 'target_node') ?? '')
  const sourceSocket = String(own(value, 'sourceSocket') ?? own(value, 'source_socket') ?? '')
  const targetSocket = String(own(value, 'targetSocket') ?? own(value, 'target_socket') ?? '')
  return {
    ...deepClone(value),
    id: String(own(value, 'id') ?? ''),
    sourceNode,
    sourceSocket: migrateLegacySocketName(nodeTypes.get(sourceNode), sourceSocket),
    targetNode,
    targetSocket: migrateLegacySocketName(nodeTypes.get(targetNode), targetSocket),
    ...(isObject(own(value, 'presentation'))
      ? { presentation: deepClone(own(value, 'presentation') as UnknownObject) }
      : {}),
  }
}

const legacyPort = (value: unknown, workflow: WorkflowDocument): SubgraphPort => {
  if (!isObject(value)) throw new Error('旧版子图端口必须是对象')
  const internalNodeId = String(own(value, 'internalNodeId') ?? own(value, 'internal_node_id') ?? '')
  const internalNodeType = workflow.nodes.find((node) => node.id === internalNodeId)?.type
  const internalSocket = String(own(value, 'internalSocket') ?? own(value, 'internal_socket') ?? '')
  return {
    ...deepClone(value),
    id: String(own(value, 'id') ?? ''),
    name: String(own(value, 'name') ?? ''),
    dataType: String(own(value, 'dataType') ?? own(value, 'data_type') ?? '') as SubgraphPort['dataType'],
    internalNodeId,
    internalSocket: migrateLegacySocketName(internalNodeType, internalSocket),
    required: own(value, 'required') !== false,
    ...(typeof own(value, 'multiple') === 'boolean' ? { multiple: own(value, 'multiple') as boolean } : {}),
  }
}

const legacyDefinition = (value: unknown, timestamp: string): SubgraphDefinition => {
  if (!isObject(value)) throw new Error('旧版子图定义必须是对象')
  const body = own(value, 'workflow')
  if (!isObject(body)) throw new Error('旧版子图定义缺少 workflow')
  const migratedBody = migrateWorkflowDocument(body, { timestamp }).document
  const inputs = own(value, 'inputs')
  const outputs = own(value, 'outputs')
  return {
    ...deepClone(value),
    id: String(own(value, 'id') ?? ''),
    name: String(own(value, 'name') ?? ''),
    version: Number(own(value, 'version') ?? 1),
    description: String(own(value, 'description') ?? ''),
    tags: Array.isArray(own(value, 'tags')) ? deepClone(own(value, 'tags') as unknown[]).map(String) : [],
    inputs: Array.isArray(inputs) ? inputs.map((item) => legacyPort(item, migratedBody)) : [],
    outputs: Array.isArray(outputs) ? outputs.map((item) => legacyPort(item, migratedBody)) : [],
    workflow: migratedBody,
  }
}

const migrateLegacyLinearView = (
  presentation: UnknownObject,
  metadata: UnknownObject,
  nodes: readonly WorkflowNode[],
): UnknownObject => {
  if (Object.hasOwn(metadata, 'linearView')) return metadata
  const raw = isObject(own(presentation, 'linear_view'))
    ? own(presentation, 'linear_view') as UnknownObject
    : isObject(own(metadata, 'linear_view'))
      ? own(metadata, 'linear_view') as UnknownObject
      : undefined
  if (!raw) return metadata
  const nodeTypes = new Map(nodes.map((node) => [node.id, node.type]))
  const rawFields = own(raw, 'fields')
  const fields = Array.isArray(rawFields)
    ? rawFields.filter(isObject).map((field) => {
        const nodeId = String(own(field, 'nodeId') ?? own(field, 'node_id') ?? '')
        return {
          id: String(own(field, 'id') ?? ''),
          nodeId,
          parameter: migrateLegacyParameterName(nodeTypes.get(nodeId), String(own(field, 'parameter') ?? '')),
          label: String(own(field, 'label') ?? ''),
          group: String(own(field, 'group') ?? 'General'),
          description: String(own(field, 'description') ?? ''),
          order: Number(own(field, 'order') ?? 0),
        }
      })
    : []
  return {
    ...metadata,
    linearView: {
      id: 'qt-migrated',
      title: String(own(raw, 'title') ?? 'Parameters') || 'Parameters',
      description: '从 Qt Workflow 迁移的 Linear View。',
      fields,
    },
  }
}

const migrateLegacyDebugOverrides = (
  nodes: readonly WorkflowNode[],
  metadata: UnknownObject,
): readonly WorkflowNode[] => {
  const overrides = isObject(own(metadata, 'debug_overrides'))
    ? own(metadata, 'debug_overrides') as UnknownObject
    : undefined
  if (!overrides) return nodes
  return nodes.map((node) => {
    const record = own(overrides, node.id)
    if (!isObject(record) || !isObject(own(record, 'outputs'))) return node
    const presentation = node.presentation ?? {}
    if (presentation.debugOverride !== undefined) return node
    const legacyPresentationAction = (presentation as unknown as UnknownObject).debug_override
    const action = own(record, 'kind') ?? legacyPresentationAction
    if (action !== 'pin' && action !== 'mock') return node
    return {
      ...node,
      presentation: {
        ...presentation,
        debugOverride: { action, value: deepClone(own(record, 'outputs')) },
      },
    }
  })
}

const sourceVersionOf = (value: UnknownObject): number => {
  const version = own(value, 'schemaVersion') ?? own(value, 'version') ?? 1
  return typeof version === 'number' && Number.isInteger(version) ? version : Number.NaN
}

export const inspectWorkflowDocument = (value: unknown): WorkflowMigrationReport => {
  if (!isObject(value)) {
    return {
      sourceVersion: Number.NaN,
      targetVersion: CURRENT_SCHEMA_VERSION,
      migrationRequired: false,
      compatible: false,
      unknownFields: [],
      error: '工作流必须是对象',
    }
  }
  const sourceVersion = sourceVersionOf(value)
  if (!Number.isFinite(sourceVersion) || sourceVersion < 1) {
    return {
      sourceVersion,
      targetVersion: CURRENT_SCHEMA_VERSION,
      migrationRequired: false,
      compatible: false,
      unknownFields: [],
      error: '工作流版本无效',
    }
  }
  if (sourceVersion > CURRENT_SCHEMA_VERSION) {
    return {
      sourceVersion,
      targetVersion: CURRENT_SCHEMA_VERSION,
      migrationRequired: true,
      compatible: false,
      unknownFields: [],
      error: `工作流版本 ${sourceVersion} 高于客户端支持的 ${CURRENT_SCHEMA_VERSION}`,
    }
  }
  const workflowKnown = new Set([
    'version', 'schemaVersion', 'id', 'name', 'revision', 'nodes', 'edges',
    'createdAt', 'updatedAt', 'metadata', 'presentation', 'subgraphs',
  ])
  const nodeKnown = new Set(['id', 'type', 'name', 'position', 'parameters', 'presentation', 'subgraph'])
  const edgeKnown = new Set([
    'id', 'sourceNode', 'sourceSocket', 'targetNode', 'targetSocket',
    'source_node', 'source_socket', 'target_node', 'target_socket', 'presentation',
  ])
  const unknownFields = [...unknownFieldNames(value, workflowKnown)]
  if (Array.isArray(own(value, 'nodes'))) {
    for (const node of own(value, 'nodes') as unknown[]) {
      if (isObject(node)) {
        const nodeId = String(own(node, 'id') ?? '?')
        unknownFields.push(...unknownFieldNames(node, nodeKnown, `nodes[${nodeId}].`))
      }
    }
  }
  if (Array.isArray(own(value, 'edges'))) {
    for (const edge of own(value, 'edges') as unknown[]) {
      if (isObject(edge)) {
        const edgeId = String(own(edge, 'id') ?? '?')
        unknownFields.push(...unknownFieldNames(edge, edgeKnown, `edges[${edgeId}].`))
      }
    }
  }
  return {
    sourceVersion,
    targetVersion: CURRENT_SCHEMA_VERSION,
    migrationRequired: sourceVersion !== CURRENT_SCHEMA_VERSION,
    compatible: true,
    unknownFields,
  }
}

export const migrateWorkflowDocument = (
  value: unknown,
  options: { readonly timestamp?: string } = {},
): WorkflowMigrationResult => {
  const report = inspectWorkflowDocument(value)
  if (!report.compatible || !isObject(value)) throw new Error(report.error ?? '工作流不兼容')
  if (report.sourceVersion === CURRENT_SCHEMA_VERSION && own(value, 'schemaVersion') === CURRENT_SCHEMA_VERSION) {
    const document = workflowDocumentSchema.parse(deepClone(value)) as unknown as WorkflowDocument
    return { document, report }
  }
  if (report.sourceVersion > LEGACY_WORKFLOW_VERSION) throw new Error('工作流版本标记不受支持')
  const timestamp = options.timestamp ?? EPOCH
  const nodes = own(value, 'nodes')
  const edges = own(value, 'edges')
  const subgraphs = own(value, 'subgraphs')
  const legacyNodes = Array.isArray(nodes) ? nodes.map(legacyNode) : []
  const rawMetadata = isObject(own(value, 'metadata')) ? deepClone(own(value, 'metadata') as UnknownObject) : {}
  const rawPresentation = isObject(own(value, 'presentation')) ? deepClone(own(value, 'presentation') as UnknownObject) : {}
  const migratedMetadata = migrateLegacyLinearView(rawPresentation, rawMetadata, legacyNodes)
  const migratedNodes = migrateLegacyDebugOverrides(legacyNodes, migratedMetadata)
  const nodeTypes = new Map(migratedNodes.map((node) => [node.id, node.type]))
  const migrated: WorkflowDocument = {
    ...deepClone(value),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: String(own(value, 'id') ?? ''),
    name: String(own(value, 'name') ?? ''),
    revision: Number(own(value, 'revision') ?? 0),
    nodes: migratedNodes,
    edges: Array.isArray(edges) ? edges.map((edge) => legacyEdge(edge, nodeTypes)) : [],
    createdAt: typeof own(value, 'createdAt') === 'string' ? own(value, 'createdAt') as string : timestamp,
    updatedAt: typeof own(value, 'updatedAt') === 'string' ? own(value, 'updatedAt') as string : timestamp,
    metadata: migratedMetadata,
    presentation: rawPresentation,
    subgraphs: Array.isArray(subgraphs) ? subgraphs.map((item) => legacyDefinition(item, timestamp)) : [],
  }
  // `version` was the legacy discriminator; retaining it would make later
  // loaders disagree about which schema is authoritative.
  const withoutLegacyDiscriminator: Record<string, unknown> = { ...migrated }
  delete withoutLegacyDiscriminator.version
  const document = workflowDocumentSchema.parse(withoutLegacyDiscriminator) as unknown as WorkflowDocument
  return { document, report }
}

export const parseWorkflowDocument = (value: unknown): WorkflowDocument =>
  migrateWorkflowDocument(value).document
