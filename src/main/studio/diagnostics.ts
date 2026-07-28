import type { DiagnosticBundle, ExecutionTimelineEvent } from '../../studio/shared/types.js'
import { StudioError, redactValue } from './errors.js'
import { atomicWriteJson } from './filesystem.js'
import { ProjectStore } from './projects.js'

export const exportDiagnosticBundle = async (
  projects: ProjectStore,
  projectPath: string,
  runId: string,
  destination: string,
  appVersion: string,
): Promise<void> => {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(runId)) throw new StudioError('invalid-run-id', '运行 ID 非法')
  const project = await projects.summary(projectPath)
  const parsed = (await projects.listRuns(projectPath)).find((run) => run.runId === runId)
  if (!parsed) throw new StudioError('run-not-found', `运行记录不存在或已损坏：${runId}`)
  const bundle: DiagnosticBundle = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion,
    projectId: project.id,
    workflowId: parsed.workflowId,
    runId: parsed.runId,
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.dispatchState ? { dispatchState: parsed.dispatchState } : {}),
    ...(parsed.error ? {
      error: {
        code: parsed.error.code,
        message: parsed.error.message,
        billingUnknown: parsed.error.billingUnknown,
        ...(parsed.error.dispatchState ? { dispatchState: parsed.error.dispatchState } : {}),
      },
    } : {}),
    events: parsed.events as readonly ExecutionTimelineEvent[],
    environment: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
    },
  }
  await atomicWriteJson(destination, redactValue(bundle))
}
