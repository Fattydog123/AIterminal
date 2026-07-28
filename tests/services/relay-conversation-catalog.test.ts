import assert from 'node:assert/strict'
import test from 'node:test'

import type { ModelDescriptor } from '../../src/shared/contracts.ts'
import { ModelCatalogError } from '../../src/main/services/model-catalog.ts'
import { loadRelayConversationCatalog } from '../../src/main/services/relay-conversation-catalog.ts'

function geminiDescriptor(): ModelDescriptor {
  return {
    id: 'gemini-3.6-flash-high',
    label: 'gemini-3.6-flash-high',
    provider: 'gemini-compatible',
    wireMode: 'standard',
    endpointTypes: ['gemini'],
    declaredEndpointTypes: ['gemini'],
    preferredChatEndpoint: 'gemini',
    preferredChatTransport: 'gemini',
    modes: ['chat', 'agent'],
    reasoning: ['light', 'medium', 'high'],
    capabilities: {
      attachments: true,
      imageInput: true,
      imageGeneration: false,
      subagents: true,
      toolUse: true,
      webSearch: false
    },
    declaredCapabilities: { toolUse: true },
    source: 'remote'
  }
}

test('token-backed group discovers models through its exact token when the account group catalog is empty', async () => {
  const credentialSelections: unknown[] = []
  const remoteModel = geminiDescriptor()
  const result = await loadRelayConversationCatalog({
    groupId: 'Gemini cil',
    mode: 'chat',
    relay: {
      getTokenBackedUserGroups: async () => ({ 'Gemini cil': { desc: 'Gemini' } }),
      getUserModels: async () => [],
      getUserModelsForGroup: async () => [],
      getPricing: async () => ({ data: [] }),
      getEligibleModelIdsForGroup: async (_groupId, modelIds) => [...modelIds],
      getSelectedModelAccessCredentials: async (selection) => {
        credentialSelections.push(selection)
        return {
          baseUrl: 'https://relay.example.test/v1',
          apiKey: 'test-key-main-only',
          tokenId: 134
        }
      }
    },
    modelCatalog: {
      list: async () => [remoteModel]
    }
  })

  assert.deepEqual(credentialSelections, [{ groupId: 'Gemini cil' }])
  assert.deepEqual(result.models.map((model) => model.id), ['gemini-3.6-flash-high'])
  assert.equal(result.models[0]?.preferredChatTransport, 'gemini')
})

test('exact token catalog failures remain retryable instead of confirming an empty group', async () => {
  const credentialSelections: unknown[] = []
  const catalogError = new ModelCatalogError(
    'network_error',
    'temporary exact-token catalog failure',
    true
  )

  await assert.rejects(
    loadRelayConversationCatalog({
      groupId: 'Gemini cil',
      mode: 'agent',
      relay: {
        getTokenBackedUserGroups: async () => ({ 'Gemini cil': { desc: 'Gemini' } }),
        getUserModels: async () => [],
        getUserModelsForGroup: async () => [],
        getPricing: async () => ({ data: [] }),
        getEligibleModelIdsForGroup: async (_groupId, modelIds) => [...modelIds],
        getSelectedModelAccessCredentials: async (selection) => {
          credentialSelections.push(selection)
          return {
            baseUrl: 'https://relay.example.test/v1',
            apiKey: 'test-key-main-only',
            tokenId: 134
          }
        }
      },
      modelCatalog: {
        list: async () => { throw catalogError }
      }
    }),
    (error: unknown) => error === catalogError
  )

  assert.deepEqual(credentialSelections, [{ groupId: 'Gemini cil' }])
})
