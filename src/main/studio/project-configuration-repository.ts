import path from 'node:path'
import { z } from 'zod'
import { parameterPresetSchema, projectPluginRecordSchema } from '../../studio/shared/contracts.js'
import type { ParameterPresetRecord, ProjectPluginRecord } from '../../studio/shared/types.js'
import { StudioError, assertNoSecretFields } from './errors.js'
import { atomicWriteJson, readJson } from './filesystem.js'
import { MutationCoordinator, ProjectLayout } from './project-persistence.js'

export class ProjectConfigurationRepository {
  constructor(
    private readonly layout: ProjectLayout,
    private readonly mutations: MutationCoordinator,
  ) {}

  async listPlugins(root: string): Promise<readonly ProjectPluginRecord[]> {
    await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const raw = await readJson<unknown>(path.join(path.resolve(root), '.studio', 'plugins.json'), [])
    const parsed = z.array(projectPluginRecordSchema).max(256).parse(raw)
    const ids = parsed.map((item) => item.manifest.id)
    if (new Set(ids).size !== ids.length) throw new StudioError('plugin-id-conflict', '插件 Manifest ID 不能重复')
    return parsed as readonly ProjectPluginRecord[]
  }

  async upsertPlugin(root: string, plugin: ProjectPluginRecord): Promise<ProjectPluginRecord> {
    return this.mutations.run(root, 'plugins', async () => {
      const parsed = projectPluginRecordSchema.parse(plugin) as ProjectPluginRecord
      const declaredPermissions = new Set(parsed.manifest.permissions)
      const undeclaredPermissions = parsed.grantedPermissions.filter((permission) => !declaredPermissions.has(permission))
      if (undeclaredPermissions.length > 0) {
        throw new StudioError('plugin-permission-not-declared', `插件权限未在 Manifest 声明：${undeclaredPermissions.join('、')}`)
      }
      if (parsed.versionLock !== parsed.manifest.version) {
        throw new StudioError('plugin-version-lock-mismatch', `插件版本锁 ${parsed.versionLock} 与 Manifest ${parsed.manifest.version} 不一致`)
      }
      const normalized: ProjectPluginRecord = {
        ...parsed,
        manifest: {
          ...parsed.manifest,
          permissions: [...new Set(parsed.manifest.permissions)],
          nodeTypes: [...new Set(parsed.manifest.nodeTypes)],
        },
        grantedPermissions: [...new Set(parsed.grantedPermissions)],
      }
      const plugins = [...(await this.listPlugins(root))]
      const index = plugins.findIndex((item) => item.manifest.id === normalized.manifest.id)
      if (index >= 0) plugins[index] = normalized
      else plugins.push(normalized)
      await atomicWriteJson(
        path.join(path.resolve(root), '.studio', 'plugins.json'),
        z.array(projectPluginRecordSchema).max(256).parse(plugins),
      )
      return normalized
    })
  }

  async deletePlugin(root: string, pluginId: string): Promise<boolean> {
    return this.mutations.run(root, 'plugins', async () => {
      const plugins = await this.listPlugins(root)
      const remaining = plugins.filter((item) => item.manifest.id !== pluginId)
      if (remaining.length === plugins.length) return false
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'plugins.json'), remaining)
      return true
    })
  }

  async listPresets(root: string): Promise<readonly ParameterPresetRecord[]> {
    await this.layout.metadata(root)
    await this.layout.managedDirectory(root, '.studio')
    const raw = await readJson<unknown>(path.join(path.resolve(root), '.studio', 'presets.json'), [])
    assertNoSecretFields(raw)
    const presets = z.array(parameterPresetSchema).max(500).parse(raw)
    const ids = presets.map((item) => item.id)
    if (new Set(ids).size !== ids.length) throw new StudioError('preset-id-conflict', '参数预设 ID 不能重复')
    return presets as readonly ParameterPresetRecord[]
  }

  async upsertPreset(root: string, preset: ParameterPresetRecord): Promise<ParameterPresetRecord> {
    return this.mutations.run(root, 'presets', async () => {
      const parsed = parameterPresetSchema.parse(preset) as ParameterPresetRecord
      assertNoSecretFields(parsed)
      const normalized: ParameterPresetRecord = {
        ...parsed,
        modelPatterns: [...new Set(parsed.modelPatterns)],
        tags: [...new Set(parsed.tags)],
      }
      const presets = [...(await this.listPresets(root))]
      const index = presets.findIndex((item) => item.id === normalized.id)
      if (index >= 0) presets[index] = normalized
      else presets.push(normalized)
      await atomicWriteJson(
        path.join(path.resolve(root), '.studio', 'presets.json'),
        z.array(parameterPresetSchema).max(500).parse(presets),
      )
      return normalized
    })
  }

  async deletePreset(root: string, presetId: string): Promise<boolean> {
    return this.mutations.run(root, 'presets', async () => {
      const presets = await this.listPresets(root)
      const remaining = presets.filter((item) => item.id !== presetId)
      if (remaining.length === presets.length) return false
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'presets.json'), remaining)
      return true
    })
  }

  async importPresets(root: string, raw: unknown): Promise<readonly ParameterPresetRecord[]> {
    return this.mutations.run(root, 'presets', async () => {
      const input = Array.isArray(raw)
        ? raw
        : z.object({ schemaVersion: z.literal(1), presets: z.array(z.unknown()).max(500) }).passthrough().parse(raw).presets
      const imported = z.array(parameterPresetSchema).max(500).parse(input) as readonly ParameterPresetRecord[]
      imported.forEach((preset) => assertNoSecretFields(preset))
      const merged = [...(await this.listPresets(root))]
      for (const preset of imported) {
        const index = merged.findIndex((item) => item.id === preset.id)
        if (index >= 0) merged[index] = preset
        else merged.push(preset)
      }
      const parsed = z.array(parameterPresetSchema).max(500).parse(merged)
      await atomicWriteJson(path.join(path.resolve(root), '.studio', 'presets.json'), parsed)
      return imported
    })
  }
}
