import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

import type { StudioCopilotOperation } from '../../src/studio/shared/contracts.ts'
import type {
  WorkflowEditorCommand,
  WorkflowEditorSessionSnapshot,
  WorkflowEditorTransition,
} from '../../src/renderer/src/studio/renderer/session/workflow-editor-session.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const {
  applyStudioCopilotOperations,
  describeStudioCopilotOperation,
  describeStudioCopilotOperationDetail,
} = await import(
  '../../src/renderer/src/studio/renderer/session/studio-copilot-operations.ts'
)

test('Studio Copilot maps refs and image routing through typed Workflow Editor commands only', () => {
  const commands: WorkflowEditorCommand[] = []
  const snapshot = {} as WorkflowEditorSessionSnapshot
  const dispatcher = {
    dispatch(command: WorkflowEditorCommand): WorkflowEditorTransition {
      commands.push(command)
      return {
        snapshot,
        documentChanged: true,
        ...(command.kind === 'canvas/add-node'
          ? {
              effect: {
                kind: 'focus-canvas' as const,
                graphId: command.graphId,
                nodeId: 'generated-node',
                purpose: 'inspect' as const,
              },
            }
          : {}),
      }
    },
  }
  const operations: StudioCopilotOperation[] = [{
    kind: 'add-node',
    ref: 'result',
    nodeType: 'image_generation',
    position: { x: 100, y: 120 },
    name: 'Generated result',
    parameters: { size: '1024x1024' },
  }, {
    kind: 'update-node',
    target: { ref: 'result' },
    parameters: { quality: 'high' },
    collapsed: true,
  }, {
    kind: 'connect',
    source: { nodeId: 'prompt' },
    sourceSocket: 'text',
    target: { ref: 'result' },
    targetSocket: 'prompt',
  }, {
    kind: 'auto-layout',
    nodes: [{ nodeId: 'prompt' }, { ref: 'result' }],
  }, {
    kind: 'remove-node',
    target: { ref: 'result' },
  }]

  const result = applyStudioCopilotOperations(dispatcher, {
    operations,
    graphId: 'root',
    context: { graphId: 'root', selectedNodeId: 'prompt' },
    generationBinding: { providerId: 'account:images', model: 'image-model' },
  })

  assert.deepEqual(commands.map((command) => command.kind), [
    'canvas/add-node',
    'canvas/update-nodes',
    'canvas/update-nodes',
    'canvas/connect',
    'canvas/auto-layout',
    'canvas/remove-nodes',
  ])
  assert.deepEqual(commands[0], {
    kind: 'canvas/add-node',
    graphId: 'root',
    nodeType: 'image_generation',
    position: { x: 100, y: 120 },
    generationBinding: { providerId: 'account:images', model: 'image-model' },
    context: { graphId: 'root', selectedNodeId: 'prompt' },
  })
  assert.deepEqual(commands[2], {
    kind: 'canvas/update-nodes',
    graphId: 'root',
    updates: [{
      nodeId: 'generated-node',
      parameters: { quality: 'high' },
      collapsed: true,
    }],
    context: { graphId: 'root', selectedNodeId: 'prompt' },
  })
  assert.deepEqual(commands[3], {
    kind: 'canvas/connect',
    graphId: 'root',
    sourceNode: 'prompt',
    sourceSocket: 'text',
    targetNode: 'generated-node',
    targetSocket: 'prompt',
    context: { graphId: 'root', selectedNodeId: 'prompt' },
  })
  assert.deepEqual(commands[4], {
    kind: 'canvas/auto-layout',
    graphId: 'root',
    nodeIds: ['prompt', 'generated-node'],
    context: { graphId: 'root', selectedNodeId: 'prompt' },
  })
  assert.equal(commands.some((command) => command.kind === 'document/replace'), false)
  assert.deepEqual(result.addedNodeIds, { result: 'generated-node' })
  assert.equal(result.snapshot, snapshot)
  assert.equal(result.selectedNodeId, 'generated-node')
  assert.equal(result.changedOperations, 6)
})

test('Studio Copilot refuses an unresolved ref before dispatching an arbitrary command', () => {
  const commands: WorkflowEditorCommand[] = []
  assert.throws(() => applyStudioCopilotOperations({
    dispatch(command) {
      commands.push(command)
      return { snapshot: {} as WorkflowEditorSessionSnapshot, documentChanged: true }
    },
  }, {
    graphId: 'root',
    operations: [{
      kind: 'remove-node',
      target: { ref: 'missing' },
    }],
  }), (error: unknown) => error instanceof Error)
  assert.deepEqual(commands, [])
})

test('Studio Copilot descriptions do not expose operation or node type identifiers', () => {
  const document = {
    nodes: [{ id: 'prompt', name: 'Prompt' }],
  } as never
  const add = {
    kind: 'add-node',
    ref: 'generated',
    nodeType: 'image_generation',
    position: { x: 0, y: 0 },
  } as const
  const update = {
    kind: 'update-node',
    target: { nodeId: 'prompt' },
    collapsed: true,
  } as const

  assert.equal(describeStudioCopilotOperation(add, document).includes('image_generation'), false)
  assert.equal(describeStudioCopilotOperationDetail(add).includes('image_generation'), false)
  assert.equal(describeStudioCopilotOperationDetail(update).includes('update-node'), false)
})
