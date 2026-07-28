import { Buffer } from 'node:buffer'

import { z } from 'zod'

import {
  MODEL_CONVERSATION_ENDPOINT_TYPES,
  modelEndpointTransport,
  type ModelDescriptor,
  type ModelEndpointType,
} from '../../shared/contracts.ts'
import { autoLayoutWorkflowNodes } from '../../studio/core/autoLayout.ts'
import { WorkflowEditor } from '../../studio/core/editor.ts'
import { defaultRegistry } from '../../studio/core/registry.ts'
import { validateWorkflow } from '../../studio/core/workflow.ts'
import {
  studioCopilotOperationSchema,
  studioCopilotPlanSchema,
  studioCopilotPlanRequestSchema,
  type StudioCopilotNodeTarget,
  type StudioCopilotOperation,
  type StudioCopilotPlan,
  type StudioCopilotPlanInput,
} from '../../studio/shared/contracts.ts'
import type { ProviderDescriptor, WorkflowDocument, WorkflowNode } from '../../studio/shared/types.ts'
import type { AnthropicMessagesClient } from '../services/anthropic-messages-client.ts'
import type { OpenAICompatibleChatCompletionsClient } from '../services/chat-completions-client.ts'
import type { GeminiContentClient } from '../services/gemini-content-client.ts'
import { loadRelayConversationCatalog } from '../services/relay-conversation-catalog.ts'
import type {
  RelayGroupsDto,
  RelayModelAccessCredentials,
  RelayPricingDto,
  RelayService,
} from '../services/relay-service.ts'
import type { RemoteModelCatalogService } from '../services/model-catalog.ts'
import type { OpenAICompatibleResponsesClient } from '../services/responses-client.ts'
import { StudioError } from './errors.ts'

const MAX_MODEL_OUTPUT_BYTES = 256 * 1024
const MAX_PROMPT_BYTES = 512 * 1024
const ROUTE_PARAMETERS = new Set(['providerId', 'model'])
const SUPPORTED_ENDPOINTS = new Set<ModelEndpointType>([
  'openai-response',
  'openai',
  'anthropic',
  'gemini',
])

type StudioCopilotRelay = Pick<RelayService,
  | 'getTokenBackedUserGroups'
  | 'getUserModels'
  | 'getUserModelsForGroup'
  | 'getPricing'
  | 'getEligibleModelIdsForGroup'
  | 'getSelectedModelAccessCredentials'>

export interface StudioCopilotCompletionRequest {
  readonly credentials: Readonly<RelayModelAccessCredentials>
  readonly model: ModelDescriptor
  readonly endpointType: Extract<ModelEndpointType, 'openai-response' | 'openai' | 'anthropic' | 'gemini'>
  readonly endpointPath: string
  readonly systemPrompt: string
  readonly userPrompt: string
}

export interface StudioCopilotModelAdapter {
  complete(request: StudioCopilotCompletionRequest): Promise<string>
}

export interface NativeStudioCopilotModelAdapterOptions {
  readonly responses: Pick<OpenAICompatibleResponsesClient, 'stream'>
  readonly chatCompletions: Pick<OpenAICompatibleChatCompletionsClient, 'stream'>
  readonly anthropic: Pick<AnthropicMessagesClient, 'stream'>
  readonly gemini: Pick<GeminiContentClient, 'stream'>
}

/** Uses the same four bounded conversation clients as Chat while preserving the
 * server-declared protocol and route selected by StudioCopilotService. */
export class NativeStudioCopilotModelAdapter implements StudioCopilotModelAdapter {
  readonly #clients: NativeStudioCopilotModelAdapterOptions

  constructor(clients: NativeStudioCopilotModelAdapterOptions) {
    this.#clients = clients
  }

  async complete(request: StudioCopilotCompletionRequest): Promise<string> {
    const messages = [{ role: 'user' as const, content: request.userPrompt }]
    switch (request.endpointType) {
      case 'openai-response': {
        const result = await this.#clients.responses.stream(request.credentials, {
          model: request.model.id,
          messages,
          endpointPath: request.endpointPath,
          instructions: request.systemPrompt,
          wireMode: request.model.wireMode,
          webSearch: false,
          imageGeneration: false,
        })
        return result.outputText
      }
      case 'openai': {
        const result = await this.#clients.chatCompletions.stream(request.credentials, {
          model: request.model.id,
          messages,
          endpointPath: request.endpointPath,
          instructions: request.systemPrompt,
        })
        return result.outputText
      }
      case 'anthropic': {
        const result = await this.#clients.anthropic.stream(request.credentials, {
          model: request.model.id,
          messages,
          endpointPath: request.endpointPath,
          instructions: request.systemPrompt,
        })
        return result.outputText
      }
      case 'gemini': {
        const result = await this.#clients.gemini.stream(request.credentials, {
          model: request.model.id,
          messages,
          endpointPath: request.endpointPath,
          instructions: request.systemPrompt,
        })
        return result.outputText
      }
    }
  }
}

export interface StudioCopilotServiceOptions {
  readonly relay: StudioCopilotRelay
  readonly modelCatalog: Pick<RemoteModelCatalogService, 'list'>
  readonly providers: { descriptor(providerId: string): Promise<ProviderDescriptor> }
  readonly adapter: StudioCopilotModelAdapter
  ensureEndpointConsent(endpoint: string): Promise<void>
}

interface SelectedConversationRoute {
  readonly groupId: string
  readonly model: ModelDescriptor
  readonly endpointType: StudioCopilotCompletionRequest['endpointType']
  readonly endpointPath: string
}

const modelPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  operations: z.array(studioCopilotOperationSchema).min(1).max(64),
}).strict()

export class StudioCopilotService {
  readonly #options: StudioCopilotServiceOptions

  constructor(options: StudioCopilotServiceOptions) {
    this.#options = options
  }

  async plan(input: StudioCopilotPlanInput): Promise<StudioCopilotPlan> {
    const parsedInput = studioCopilotPlanRequestSchema.parse(input)
    const workflow = validateWorkflow(parsedInput.workflow as WorkflowDocument)
    if (workflow.nodes.length > 512 || workflow.edges.length > 2048) {
      throw new StudioError('studio-copilot-workflow-too-large', '当前工作流过大，请先选择并精简要调整的部分')
    }
    if (parsedInput.selectedNodeIds?.some((nodeId) => !workflow.nodes.some((node) => node.id === nodeId))) {
      throw new StudioError('studio-copilot-selection-stale', '所选节点已经变化，请重新选择后生成计划')
    }

    const provider = await this.#options.providers.descriptor(parsedInput.providerId)
    if (provider.managedBy !== 'ai-terminal-account' || !provider.groupId) {
      throw new StudioError('studio-copilot-group-unavailable', '请先在页面顶部选择账户分组')
    }
    const groups = await this.#options.relay.getTokenBackedUserGroups()
    const route = await this.#selectRoute(provider.groupId, groups)
    const credentials = await this.#options.relay.getSelectedModelAccessCredentials({
      groupId: route.groupId,
      modelId: route.model.id,
    })
    const consentUrl = routeUrl(credentials.baseUrl, route.endpointPath, route.model.id)
    await this.#options.ensureEndpointConsent(consentUrl)

    const prompts = buildPrompts(workflow, parsedInput.instruction, parsedInput.selectedNodeIds)
    let output: string
    try {
      output = await this.#options.adapter.complete({
        credentials,
        model: route.model,
        endpointType: route.endpointType,
        endpointPath: route.endpointPath,
        ...prompts,
      })
    } catch (error) {
      throw new StudioError(
        'studio-copilot-request-failed',
        '工作流计划生成失败，请检查当前分组后重试',
        'not_sent',
        error,
      )
    }

    const modelPlan = parseModelPlan(output)
    validateCopilotOperations(workflow, modelPlan.operations)
    return studioCopilotPlanSchema.parse({
      summary: modelPlan.summary,
      groupId: route.groupId,
      model: route.model.id,
      operations: modelPlan.operations,
    })
  }

  async #selectRoute(
    preferredGroupId: string,
    groups: RelayGroupsDto,
  ): Promise<SelectedConversationRoute> {
    const groupIds = [
      ...(Object.hasOwn(groups, preferredGroupId) ? [preferredGroupId] : []),
      ...Object.keys(groups).filter((groupId) => groupId !== preferredGroupId),
    ]
    for (const groupId of groupIds) {
      try {
        const catalog = await loadRelayConversationCatalog({
          relay: this.#options.relay,
          modelCatalog: this.#options.modelCatalog,
          groupId,
          mode: 'chat',
        })
        const selected = selectDeclaredRoute(groupId, catalog.models, catalog.pricing)
        if (selected) return selected
      } catch {
        // A stale or temporarily unavailable group must not prevent trying the
        // next real token-backed group. No model or endpoint is synthesized.
      }
    }
    throw new StudioError(
      'studio-copilot-model-unavailable',
      '当前账户没有同时声明对话协议和可用接口路径的模型',
    )
  }
}

const selectDeclaredRoute = (
  groupId: string,
  models: readonly ModelDescriptor[],
  pricing: RelayPricingDto,
): SelectedConversationRoute | undefined => {
  for (const model of models) {
    const declared = model.declaredEndpointTypes
    if (!declared) continue
    for (const endpointType of declared) {
      if (!SUPPORTED_ENDPOINTS.has(endpointType)
        || !(MODEL_CONVERSATION_ENDPOINT_TYPES as readonly ModelEndpointType[]).includes(endpointType)
        || modelEndpointTransport(endpointType) === 'unsupported') continue
      const route = pricing.supported_endpoint?.[endpointType]
      if (!route || route.method !== 'POST') continue
      return {
        groupId,
        model,
        endpointType: endpointType as SelectedConversationRoute['endpointType'],
        endpointPath: route.path,
      }
    }
  }
  return undefined
}

const routeUrl = (baseUrl: string, path: string, model: string): string => {
  const materialized = path.replaceAll('{model}', encodeURIComponent(model))
  return new URL(materialized, new URL(baseUrl).origin).toString()
}

const buildPrompts = (
  workflow: WorkflowDocument,
  instruction: string,
  selectedNodeIds: readonly string[] | undefined,
): Pick<StudioCopilotCompletionRequest, 'systemPrompt' | 'userPrompt'> => {
  const nodeTypes = defaultRegistry.list().map((definition) => ({
    type: definition.type,
    title: definition.title,
    description: definition.description,
    inputs: Object.values(definition.inputs).map((port) => ({
      id: port.id,
      dataType: port.dataType,
      required: port.required,
      multiple: port.multiple ?? false,
    })),
    outputs: Object.values(definition.outputs).map((port) => ({
      id: port.id,
      dataType: port.dataType,
    })),
    parameters: definition.parameters
      .filter((parameter) => !ROUTE_PARAMETERS.has(parameter.id))
      .map((parameter) => ({
        id: parameter.id,
        kind: parameter.kind,
        required: parameter.required ?? false,
        ...(parameter.options ? { options: parameter.options.map((option) => option.value) } : {}),
        ...(parameter.min === undefined ? {} : { min: parameter.min }),
        ...(parameter.max === undefined ? {} : { max: parameter.max }),
      })),
  }))
  const semanticWorkflow = {
    id: workflow.id,
    name: workflow.name,
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      position: node.position,
      parameters: Object.fromEntries(Object.entries(node.parameters)
        .filter(([key]) => !ROUTE_PARAMETERS.has(key))),
      ...(node.presentation?.annotation ? { annotation: node.presentation.annotation } : {}),
      ...(node.presentation?.bypassed !== undefined ? { bypassed: node.presentation.bypassed } : {}),
      ...(node.presentation?.collapsed !== undefined ? { collapsed: node.presentation.collapsed } : {}),
    })),
    edges: workflow.edges.map((edge) => ({
      sourceNode: edge.sourceNode,
      sourceSocket: edge.sourceSocket,
      targetNode: edge.targetNode,
      targetSocket: edge.targetSocket,
    })),
    selectedNodeIds: selectedNodeIds ?? [],
  }
  const systemPrompt = [
    'You are the workflow planning assistant inside an image workflow editor.',
    'Return one JSON object only, with exactly summary and operations.',
    'Allowed operations are add-node, update-node, remove-node, connect, and auto-layout.',
    'For a newly added node, set a unique ref. Later operations may target it as {"ref":"..."}.',
    'Existing nodes must be targeted as {"nodeId":"..."}.',
    'Never include providerId or model in parameters. The application owns the model route.',
    'Use only node types, ports, node IDs, and parameters present in the supplied catalogs.',
    'Keep the plan minimal and directly aligned with the user instruction.',
    'Schema: {"summary":"...","operations":[{"kind":"add-node","ref":"newNode","nodeType":"text","position":{"x":0,"y":0},"parameters":{"text":"..."}},{"kind":"connect","source":{"ref":"newNode"},"sourceSocket":"text","target":{"nodeId":"existing"},"targetSocket":"prompt"},{"kind":"auto-layout"}]}',
  ].join('\n')
  const userPrompt = JSON.stringify({ instruction, workflow: semanticWorkflow, nodeTypes })
  if (Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(userPrompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new StudioError('studio-copilot-context-too-large', '当前工作流上下文过大，请先精简后再生成计划')
  }
  return { systemPrompt, userPrompt }
}

const parseModelPlan = (raw: string): z.output<typeof modelPlanSchema> => {
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw, 'utf8') > MAX_MODEL_OUTPUT_BYTES) {
    throw new StudioError('studio-copilot-invalid-response', '模型没有返回可用的工作流计划')
  }
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  try {
    return modelPlanSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new StudioError(
      'studio-copilot-invalid-response',
      '模型返回的工作流计划格式不完整，请重试',
      'not_sent',
      error,
    )
  }
}

const resolveTarget = (
  target: StudioCopilotNodeTarget,
  refs: ReadonlyMap<string, string>,
): string => {
  if ('nodeId' in target) return target.nodeId
  const nodeId = refs.get(target.ref)
  if (!nodeId) throw new Error(`新节点引用不存在：${target.ref}`)
  return nodeId
}

const assertParameters = (
  node: WorkflowNode,
  parameters: Readonly<Record<string, unknown>> | undefined,
): void => {
  if (!parameters) return
  const definition = defaultRegistry.get(node.type)
  const byId = new Map(definition.parameters.map((parameter) => [parameter.id, parameter]))
  for (const [key, value] of Object.entries(parameters)) {
    if (ROUTE_PARAMETERS.has(key)) throw new Error('工作流助手不能修改顶部模型路由')
    const parameter = byId.get(key)
    if (!parameter) throw new Error(`节点参数不存在：${node.type}.${key}`)
    if (parameter.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`节点参数类型无效：${node.type}.${key}`)
    }
    if (parameter.kind === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`节点参数类型无效：${node.type}.${key}`)
    }
    if (parameter.kind !== 'number' && parameter.kind !== 'boolean' && typeof value !== 'string') {
      throw new Error(`节点参数类型无效：${node.type}.${key}`)
    }
    if (parameter.options && !parameter.options.some((option) => option.value === value)) {
      throw new Error(`节点参数选项无效：${node.type}.${key}`)
    }
    if (typeof value === 'number' && (
      (parameter.min !== undefined && value < parameter.min)
      || (parameter.max !== undefined && value > parameter.max)
    )) throw new Error(`节点参数范围无效：${node.type}.${key}`)
  }
}

export const validateCopilotOperations = (
  source: WorkflowDocument,
  operations: readonly StudioCopilotOperation[],
): WorkflowDocument => {
  const editor = new WorkflowEditor()
  const refs = new Map<string, string>()
  let workflow = validateWorkflow(structuredClone(source))
  try {
    for (const operation of operations) {
      if (operation.kind === 'add-node') {
        if (refs.has(operation.ref) || operation.nodeType.startsWith('subgraph:')) {
          throw new Error(`新节点引用无效：${operation.ref}`)
        }
        const before = new Set(workflow.nodes.map((node) => node.id))
        workflow = editor.addNode(workflow, operation.nodeType, operation.position)
        const nodeId = workflow.nodes.find((node) => !before.has(node.id))?.id
        if (!nodeId) throw new Error('新节点没有生成有效 ID')
        refs.set(operation.ref, nodeId)
        const added = workflow.nodes.find((node) => node.id === nodeId) as WorkflowNode
        assertParameters(added, operation.parameters)
        if (operation.name !== undefined || operation.parameters !== undefined || operation.annotation !== undefined) {
          workflow = editor.updateNode(workflow, nodeId, (node) => ({
            ...node,
            ...(operation.name === undefined ? {} : { name: operation.name }),
            ...(operation.parameters === undefined ? {} : {
              parameters: { ...node.parameters, ...structuredClone(operation.parameters) },
            }),
            ...(operation.annotation === undefined ? {} : {
              presentation: { ...node.presentation, annotation: operation.annotation },
            }),
          }))
        }
        continue
      }
      if (operation.kind === 'update-node') {
        const nodeId = resolveTarget(operation.target, refs)
        const current = workflow.nodes.find((node) => node.id === nodeId)
        if (!current) throw new Error(`节点不存在：${nodeId}`)
        assertParameters(current, operation.parameters)
        workflow = editor.updateNode(workflow, nodeId, (node) => ({
          ...node,
          ...(operation.name === undefined ? {} : { name: operation.name }),
          ...(operation.parameters === undefined ? {} : {
            parameters: { ...node.parameters, ...structuredClone(operation.parameters) },
          }),
          ...(
            operation.annotation === undefined
            && operation.bypassed === undefined
            && operation.collapsed === undefined
              ? {}
              : {
                  presentation: {
                    ...node.presentation,
                    ...(operation.annotation === undefined ? {} : { annotation: operation.annotation }),
                    ...(operation.bypassed === undefined ? {} : { bypassed: operation.bypassed }),
                    ...(operation.collapsed === undefined ? {} : { collapsed: operation.collapsed }),
                  },
                }
          ),
        }))
        continue
      }
      if (operation.kind === 'remove-node') {
        const nodeId = resolveTarget(operation.target, refs)
        if (!workflow.nodes.some((node) => node.id === nodeId)) throw new Error(`节点不存在：${nodeId}`)
        workflow = editor.removeNodes(workflow, [nodeId])
        continue
      }
      if (operation.kind === 'connect') {
        workflow = editor.connect(workflow, {
          sourceNode: resolveTarget(operation.source, refs),
          sourceSocket: operation.sourceSocket,
          targetNode: resolveTarget(operation.target, refs),
          targetSocket: operation.targetSocket,
        })
        continue
      }
      const nodeIds = operation.nodes?.map((target) => resolveTarget(target, refs))
      workflow = editor.moveNodes(workflow, autoLayoutWorkflowNodes(workflow.nodes, workflow.edges, {
        ...(nodeIds ? { nodeIds } : {}),
      }))
    }
    return validateWorkflow(workflow)
  } catch (error) {
    throw new StudioError(
      'studio-copilot-invalid-operations',
      '模型返回的变更无法应用到当前工作流，请重新生成计划',
      'not_sent',
      error,
    )
  }
}
